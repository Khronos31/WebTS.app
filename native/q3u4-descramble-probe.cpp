// PX-Q3U4 で受信した TS を、内蔵カードを使って実際に復号する。
//
// 13章で TS 受信、14章でカード、15章で B_CAS_CARD がそれぞれ通った。ここは
// それらを同時に動かす。**選局とカードを同時に使う構成はここが初めて**で、
// 電源調停が成立するかどうかもここで分かる。
//
// **機種を問わない。**PX4 系の筐体は px4-enclosure.cpp が機種ごとに組み立て、
// ここは上流の `TunerServiceBackend`（選局・ロック・TS の選択・取り込み・LNB）
// とデータプレーン越しにしか触らない。受信機の番号は上流の番号で、その
// 受信機が地上波と衛星のどちらを受けられるかも backend に聞く（PX-Q3U4 は
// 0/1/4/5 が衛星・2/3/6/7 が地上波、PX-MLT5PE は 0..4 のどれでも両方）。
// どの受信機を使うかも JS ではなくここで決める（claim_receiver）。
//
// 復号は上流 libaribb25 の `arib_std_b25` facade が行う。PAT/PMT の追跡も
// ECM の取り出しも MULTI2 もすべて上流であり、ここには書かない。
//
// 復号した TS の扱いは3通り。既定は何も保持しない。
//   accumulate … 全部溜めて、終わってから利用者の端末へ渡す（保存用）。
//   stream     … 溜めては渡し、渡したぶんは捨てる（live 視聴用）。
// どちらも利用者が自分の受信機で受信した自分の放送を自分で見るための経路で、
// どこへも送信しない。鍵とカード情報はいずれの場合も持ち出さない。
//
// stream では、ドライバ pthread が書き、JS の main thread が読む。唯一の
// 共有状態なので mutex ひとつで守る。読み手が止まったときに無限に伸びるのは
// 困るので上限を設け、超えたら古いほうから捨てて数える。黙って詰まるより
// 捨てたと言うほうがよい。

#include "px4-enclosure.h"
#include "px4-receiver-policy.h"
#include "px4/card.h"
#include "px4/card_service.h"
#include "px4/firmware.h"
#include "px4/ipc.h"
#include "px4/libusb_transport.h"
#include "px4/q3u4_stream.h"
#include "px4/tuner_service.h"

extern "C" {
#include "arib_std_b25.h"
#include "b_cas_card.h"
}

extern "C" void webts_winscard_bind(void* service, std::uint64_t client);
extern "C" void webts_winscard_unbind(void);

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <mutex>
#include <optional>
#include <pthread.h>
#include <thread>
#include <vector>

namespace {

using namespace px4::userland;
using webts::Px4Enclosure;

constexpr const char* kScratchPath = "/tmp/webts-q3u4-descramble-firmware.bin";
constexpr std::size_t kReadBytes = Q3U4StreamDataPlane::kPacketSize * 1024U;

enum ProbeState : int { kIdle = 0, kRunning = 1, kFinished = 2, kFailed = 3 };

enum ProbeWave : int { kWaveTerrestrial = 0, kWaveSatellite = 1 };

enum ProbeStage : int {
    kStageStart = 0,
    kStageImage = 1,
    kStageOpen = 2,
    kStageInit = 3,
    kStageCard = 4,
    kStageB25 = 5,
    kStageFrontendOpen = 6,
    kStageTune = 7,
    kStageLock = 8,
    kStageDataPlane = 9,
    kStageAttach = 10,
    kStageReading = 11,
    kStageFlush = 12,
    kStageCleanup = 13,
    kStageDone = 14,
};

/** 受信機を JS が指定しないとき。ここで空いているものを選ぶ。 */
constexpr int kAnyReceiver = -1;

struct Job final {
    std::vector<std::uint8_t> firmware;
    int receiver = kAnyReceiver;
    /** 0 が地上波、1 が衛星。 */
    int wave = 0;
    int frequency_khz = 0;
    /**
     * 衛星の TS 選択。中継器には複数の TS が載っており、これを指定しないと
     * どれが出るか決まらない。地上波では使わない。
     */
    int tsid = 0;
    /** LNB へ 15V を出してよいか。既定は出さない。 */
    bool allow_15v = false;
    // 0 は「止めるまで」。
    int duration_ms = 5000;
    int collect = 0;

    std::atomic<int> state{kIdle};
    std::atomic<int> stage{kStageStart};
    std::atomic<int> error{0};
    std::atomic<int> b25_error{0};
    std::atomic<int> elapsed_ms{0};
    std::atomic<int> reading_ms{0};
    /** ロック待ちの経過。黙って待っていると止まって見えるので出す。 */
    std::atomic<int> lock_wait_ms{0};
    // 入口（復号前）
    std::atomic<std::uint64_t> in_packets{0U};
    std::atomic<std::uint64_t> in_scrambled{0U};
    // 出口（復号後）
    std::atomic<std::uint64_t> out_packets{0U};
    std::atomic<std::uint64_t> out_scrambled{0U};
    std::atomic<std::uint64_t> out_bad_sync{0U};
    // 上流 libaribb25 の自己申告
    std::atomic<int> program_count{-1};
    std::atomic<std::uint64_t> total_packets{0U};
    std::atomic<std::uint64_t> undecrypted_packets{0U};
    std::atomic<int> ecm_unpurchased{-1};
    std::atomic<int> last_ecm_error{-1};

    std::atomic<bool> stop_requested{false};

    // accumulate では worker だけが書き、終わってから main が読む。
    // stream では両者が触るので mutex で守る。
    std::mutex mutex;
    std::vector<std::uint8_t> output;
    std::size_t consumed = 0U;
    std::atomic<std::uint64_t> output_bytes{0U};
    std::atomic<std::uint64_t> delivered_bytes{0U};
    std::atomic<std::uint64_t> dropped_bytes{0U};
};

enum CollectMode : int { kCollectNone = 0, kCollectAccumulate = 1, kCollectStream = 2 };

// 読み手が 16 MiB ぶん（8秒程度）遅れたら、そこから先は捨てる。
constexpr std::size_t kStreamLimit = 16U * 1024U * 1024U;

/** 復号済み TS を溜める。stream では上限を超えたぶんを古いほうから捨てる。 */
void retain(Job& job, const std::uint8_t* data, std::size_t size) noexcept {
    if (job.collect == kCollectNone || size == 0U) return;
    std::lock_guard<std::mutex> lock(job.mutex);
    job.output.insert(job.output.end(), data, data + size);
    if (job.collect == kCollectStream) {
        const std::size_t pending = job.output.size() - job.consumed;
        if (pending > kStreamLimit) {
            const std::size_t excess = pending - kStreamLimit;
            job.consumed += excess;
            job.dropped_bytes.fetch_add(excess);
        }
        if (job.consumed > 0U && job.consumed >= job.output.size() / 2U) {
            job.output.erase(job.output.begin(),
                             job.output.begin() + static_cast<std::ptrdiff_t>(job.consumed));
            job.consumed = 0U;
        }
    }
    job.output_bytes.store(job.output.size() - job.consumed);
}

Job* g_job = nullptr;
pthread_t g_thread{};
bool g_thread_started = false;

void sleep_ms(std::uint32_t milliseconds) noexcept {
    std::this_thread::sleep_for(std::chrono::milliseconds(milliseconds));
}

int elapsed_since(std::chrono::steady_clock::time_point started) noexcept {
    return static_cast<int>(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - started).count());
}

// ---- 選局 ----
//
// **上流 TunerService::tune と同じ順で行う**（tuner_service.cpp）。機種による
// 違いは backend が答える。
//
//   1. LNB 給電を始める（地上波は 0V の要求だけ）
//   2. 衛星で、機種が「選局の前に TS を選ぶ」なら選ぶ（PX-MLT5PE）
//   3. 選局
//   4. ロックを待つ
//   5. 地上波で、機種が求めればロックの後に待つ（上流 kWaitAfterLockTcTMs）
//   6. 衛星で、まだなら TS を選ぶ（PX-Q3U4 はロックの後）
//   7. 給電を確定する。途中で失敗したら巻き戻す
//
// 以前は PX-Q3U4 の部品を直接呼び、給電の確定・TS の選択・ロック待ちの順
// だった。上流の px4d が両機種で使っている順にそろえた。

/**
 * 1回の選局にかける上限。選局・TS の選択・ロック・ロック後の待ちをまとめて
 * 数える（上流と同じ）。実測のロックは 0.3 秒ほど。信号の無い周波数で
 * 黙って待ち続けないよう、以前のロック待ちの上限（10秒）に選局と TS の
 * 選択のぶんを足した。
 */
constexpr std::uint32_t kTuneTimeoutMs = 12000U;
/** 地上波でロックした後に待つ時間。上流 tuner_service.cpp の kWaitAfterLockTcTMs。 */
constexpr std::uint32_t kWaitAfterTerrestrialLockMs = 340U;
/** 同じ中継器のまま相対 TS だけを替えるときの上限。上流の既定と同じ。 */
constexpr std::uint32_t kSelectSlotTimeoutMs = 1000U;

struct TuneRequest final {
    std::uint8_t receiver = 0U;
    ipc::System system = ipc::System::ISDB_T;
    std::uint32_t frequency_khz = 0U;
    std::uint8_t lnb_voltage = 0U;
    /** 衛星の TS を相対 TS 番号で選ぶ（走査）か、TSID で選ぶ（視聴）か。 */
    bool by_slot = false;
    std::uint8_t slot = 0U;
    std::uint16_t tsid = 0U;
};

/** 選局の進み具合。どちらも無くてよい。 */
struct TuneProgress final {
    std::atomic<int>* stage = nullptr;
    std::atomic<int>* lock_wait_ms = nullptr;
};

/** 成功したら給電は確定済み、失敗したら巻き戻し済み。 */
Error tune_receiver(TunerServiceBackend& tuner, const TuneRequest& request,
                    const TuneProgress& progress) noexcept {
    const auto started = std::chrono::steady_clock::now();
    const auto remaining = [started]() -> std::uint32_t {
        const auto elapsed = static_cast<std::uint32_t>(elapsed_since(started));
        return elapsed >= kTuneTimeoutMs ? 0U : kTuneTimeoutMs - elapsed;
    };
    const std::uint8_t receiver = request.receiver;
    const bool satellite = request.system == ipc::System::ISDB_S;
    if (progress.stage != nullptr) progress.stage->store(kStageTune);

    const auto powered = tuner.begin_tune_power(receiver, request.system, request.lnb_voltage);
    if (!powered) return powered.error();
    const auto fail = [&tuner, receiver](Error error) noexcept {
        (void)tuner.rollback_tune_power(receiver);
        return error;
    };
    const auto select_stream = [&tuner, &request, receiver](std::uint32_t budget) noexcept {
        return request.by_slot ? tuner.select_satellite_slot(receiver, request.slot, budget)
                               : tuner.select_satellite_tsid(receiver, request.tsid, budget);
    };

    const bool select_before_tune = satellite && tuner.selects_satellite_stream_before_tune();
    if (select_before_tune) {
        const std::uint32_t budget = remaining();
        if (budget == 0U) return fail(Error::TIMEOUT);
        const auto selected = select_stream(budget);
        if (!selected) return fail(selected.error());
    }

    const std::uint32_t tune_budget = remaining();
    if (tune_budget == 0U) return fail(Error::TIMEOUT);
    const auto tuned = satellite
        ? tuner.tune_satellite(receiver, request.frequency_khz, tune_budget)
        : tuner.tune_terrestrial(receiver, request.frequency_khz, tune_budget);
    if (!tuned) return fail(tuned.error());

    if (progress.stage != nullptr) progress.stage->store(kStageLock);
    const auto lock_started = std::chrono::steady_clock::now();
    for (;;) {
        const auto locked = tuner.is_locked(receiver, request.system);
        if (progress.lock_wait_ms != nullptr) {
            progress.lock_wait_ms->store(elapsed_since(lock_started));
        }
        if (!locked) return fail(locked.error());
        if (locked.value()) break;
        if (remaining() < 10U) return fail(Error::TIMEOUT);
        sleep_ms(10U);
    }

    if (!satellite && tuner.requires_terrestrial_lock_settle()) {
        const auto since_lock_poll = static_cast<std::uint32_t>(elapsed_since(lock_started));
        if (since_lock_poll < kWaitAfterTerrestrialLockMs) {
            const std::uint32_t settle = kWaitAfterTerrestrialLockMs - since_lock_poll;
            if (remaining() <= settle) return fail(Error::TIMEOUT);
            sleep_ms(settle);
        }
    }

    if (satellite && !select_before_tune) {
        const std::uint32_t budget = remaining();
        if (budget == 0U) return fail(Error::TIMEOUT);
        const auto selected = select_stream(budget);
        if (!selected) return fail(selected.error());
    }

    const auto committed = tuner.commit_tune_power(receiver);
    if (!committed) return fail(committed.error());
    return Error::OK;
}

Result<FirmwareImage> stage_image(const std::vector<std::uint8_t>& firmware) noexcept {
    std::FILE* file = std::fopen(kScratchPath, "wb");
    if (file == nullptr) return Result<FirmwareImage>::failure(Error::INTERNAL);
    const bool written = std::fwrite(firmware.data(), 1U, firmware.size(), file) == firmware.size();
    std::fclose(file);
    Result<FirmwareImage> image = written
        ? FirmwareProvider(kScratchPath).load()
        : Result<FirmwareImage>::failure(Error::INTERNAL);
    if (std::FILE* scrub = std::fopen(kScratchPath, "r+b"); scrub != nullptr) {
        const std::vector<std::uint8_t> zeros(firmware.size(), 0U);
        std::fwrite(zeros.data(), 1U, zeros.size(), scrub);
        std::fclose(scrub);
    }
    std::remove(kScratchPath);
    return image;
}

/** 188 バイト境界の形だけを数える。payload は保持しない。 */
void count_packets(const std::uint8_t* data, std::size_t size,
                   std::atomic<std::uint64_t>& packets,
                   std::atomic<std::uint64_t>& scrambled,
                   std::atomic<std::uint64_t>* bad_sync) noexcept {
    for (std::size_t offset = 0U; offset + 188U <= size; offset += 188U) {
        const std::uint8_t* packet = data + offset;
        if (packet[0] != 0x47U) {
            if (bad_sync != nullptr) bad_sync->fetch_add(1U, std::memory_order_relaxed);
            continue;
        }
        packets.fetch_add(1U, std::memory_order_relaxed);
        if ((packet[3] & 0xc0U) != 0U) scrambled.fetch_add(1U, std::memory_order_relaxed);
    }
}

void publish_program_info(Job& job, ARIB_STD_B25* b25) noexcept {
    const int count = b25->get_program_count(b25);
    if (count < 0) return;
    job.program_count.store(count);
    std::uint64_t total = 0U;
    std::uint64_t undecrypted = 0U;
    for (int index = 0; index < count; ++index) {
        ARIB_STD_B25_PROGRAM_INFO info{};
        if (b25->get_program_info(b25, &info, index) != 0) continue;
        total += static_cast<std::uint64_t>(info.total_packet_count);
        undecrypted += static_cast<std::uint64_t>(info.undecrypted_packet_count);
        job.ecm_unpurchased.store(info.ecm_unpurchased_count);
        job.last_ecm_error.store(info.last_ecm_error_code);
    }
    job.total_packets.store(total);
    job.undecrypted_packets.store(undecrypted);
}

// ---- セッション ----
//
// **デバイスを開いた状態そのものを、仕事より長く生かす。**
//
// 以前はこれらがすべて worker_main のスタックにあり、1つの仕事が終わると
// デバイスごと畳まれていた。受信機は8本（地上波4・衛星4）あるのに同時に
// 動かせるのが1本だけだったのはこれが理由で、ハードウェアにも上流にも
// 制約は無い。上流の `Q3U4StreamDataPlane` は受信機ごとの attachment を取り、
// ブリッジごとに pump スレッドを持ち、ロック順序まで定めてある。
//
// セッションはヒープに置き、複数の仕事が参照する。数えている仕事が 0 になり、
// かつ閉じる要求が出ていれば畳む。
//
// **作るのも畳むのも pthread の上で行う。**どちらも USB に触れる。

struct Session final {
    bool allow_15v = false;

    std::unique_ptr<Q3U4Runtime> runtime;
    /** 機種ごとに組み立てた筐体。ここから先は機種を問わない。 */
    std::unique_ptr<Px4Enclosure> enclosure;

    /** 使っている受信機。claim_receiver / release_receiver だけが触る。 */
    std::mutex claims_mutex;
    std::array<bool, ipc::kReceiverCount> claimed{};

    // カード経路。復号する仕事だけが使う。カードは1枚なので使えるのも1つ。
    std::optional<It930xCardHardware> hardware;
    SystemCardTime card_time;
    std::optional<CardSession> card;
    std::optional<NativeCardProtocolSession> protocol;
    std::optional<CardService> service;

    /** いま走っている仕事の数。0 のときだけ畳める。 */
    std::atomic<int> tasks{0};
    /** attach のたびに新しくする。使い回すと上流が BUSY を返す。 */
    std::atomic<unsigned long long> next_attachment{1U};
};

std::mutex g_session_mutex;
Session* g_session = nullptr;
std::atomic<bool> g_session_close_requested{true};

/**
 * セッションを用意し、仕事を1つ数える。既にあれば数えるだけ。
 * stage には進み具合を書く。呼び出し側の仕事が JS へ見せる。
 */
Error acquire_session(const std::vector<std::uint8_t>& firmware, bool allow_15v,
                      std::atomic<int>& stage, Session** out) noexcept {
    std::lock_guard<std::mutex> guard(g_session_mutex);
    if (g_session != nullptr) {
        g_session->tasks.fetch_add(1);
        *out = g_session;
        return Error::OK;
    }

    stage.store(kStageImage);
    const Result<FirmwareImage> image = stage_image(firmware);
    if (!image) return image.error();

    auto session = std::unique_ptr<Session>(new (std::nothrow) Session());
    if (!session) return Error::INTERNAL;
    session->allow_15v = allow_15v;

    // **上流が知っている機種ならどれでも開く。**許可された USB 機器の中から、
    // 上流の機種の表（identity.cpp）に載っている筐体を1つ選ぶ。
    stage.store(kStageOpen);
    Result<std::unique_ptr<Q3U4Runtime>> runtime = Q3U4Runtime::open_native();
    if (!runtime) return runtime.error();
    session->runtime = std::move(runtime.value());

    // 組み立てと初期化は機種ごと（px4-enclosure.cpp）。**データプレーンも
    // 筐体が持つ。**受信機ごとの attachment を束ねる側なので、仕事ごとに
    // 作り直すと同時に使えない。
    const auto on_step = [](void* context, webts::Px4OpenStep step) noexcept {
        static_cast<std::atomic<int>*>(context)->store(
            step == webts::Px4OpenStep::initialize ? kStageInit : kStageDataPlane);
    };
    auto enclosure = webts::open_px4_enclosure(*session->runtime, image.value(), allow_15v,
                                               on_step, &stage);
    if (!enclosure) return enclosure.error();
    session->enclosure = std::move(enclosure.value());

    g_session = session.release();
    // **数えるのは鍵の中で。**増える前に畳む判定が走ると、使っている最中の
    // セッションが消える。
    g_session->tasks.fetch_add(1);
    *out = g_session;
    return Error::OK;
}

/** 仕事を1つ終える。最後の1つで、かつ閉じる要求が出ていれば畳む。 */
void release_session(Session* session) noexcept {
    if (session != nullptr) session->tasks.fetch_sub(1);
    std::lock_guard<std::mutex> guard(g_session_mutex);
    if (g_session == nullptr) return;
    if (g_session->tasks.load() > 0) return;
    if (!g_session_close_requested.load()) return;

    if (g_session->service.has_value()) g_session->service->shutdown();
    // データプレーン（保留中の bulk 転送のキャンセルを伴う）と LNB を止める。
    if (g_session->enclosure) g_session->enclosure->shutdown();
    delete g_session;
    g_session = nullptr;
}

// ---- 受信機の割り当て ----
//
// **機種を問わない規則で、ここで決める**（px4-receiver-policy.h）。受信機が
// どの波を受けられるかは backend にしか分からないので、JS には番号を
// 持たせない。

using webts::ReceiverUse;

/**
 * 受信機を1本取る。requested が kAnyReceiver なら規則で選ぶ。
 * 取れた番号を返す。取れなければ -1。
 */
int claim_receiver(Session& session, ipc::System system, ReceiverUse use,
                   int requested) noexcept {
    TunerServiceBackend& tuner = session.enclosure->tuner();
    const auto count = static_cast<std::uint8_t>(std::min<std::size_t>(
        tuner.receiver_count(), ipc::kReceiverCount));
    const webts::Wave wave =
        system == ipc::System::ISDB_S ? webts::Wave::satellite : webts::Wave::terrestrial;
    const auto supports = [&tuner](std::uint8_t r, webts::Wave w) noexcept {
        return tuner.receiver_supports(
            r, w == webts::Wave::satellite ? ipc::System::ISDB_S : ipc::System::ISDB_T);
    };
    std::lock_guard<std::mutex> guard(session.claims_mutex);
    if (requested != kAnyReceiver) {
        // 指定されたときは走査の分け方には従わせない（開発用の上書き）。
        if (requested < 0 || requested >= count) return -1;
        const auto r = static_cast<std::uint8_t>(requested);
        if (session.claimed[r] || !supports(r, wave)) return -1;
        session.claimed[r] = true;
        return requested;
    }
    const int chosen = webts::choose_receiver(
        count, wave, use, supports,
        [&session](std::uint8_t r) noexcept { return session.claimed[r]; });
    if (chosen >= 0) session.claimed[static_cast<std::size_t>(chosen)] = true;
    return chosen;
}

void release_receiver(Session& session, int receiver) noexcept {
    if (receiver < 0 || receiver >= static_cast<int>(ipc::kReceiverCount)) return;
    std::lock_guard<std::mutex> guard(session.claims_mutex);
    session.claimed[static_cast<std::size_t>(receiver)] = false;
}

void* worker_main(void* argument) noexcept {
    Job& job = *static_cast<Job*>(argument);
    const auto started = std::chrono::steady_clock::now();
    const auto elapsed = [started]() {
        return static_cast<int>(std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - started).count());
    };
    const auto fail = [&job, &elapsed](ProbeStage stage, Error error) {
        job.stage.store(stage);
        job.error.store(static_cast<int>(error));
        job.elapsed_ms.store(elapsed());
        job.state.store(kFailed);
    };

    Session* session_ptr = nullptr;
    const Error acquired =
        acquire_session(job.firmware, job.allow_15v, job.stage, &session_ptr);
    if (acquired != Error::OK || session_ptr == nullptr) {
        fail(static_cast<ProbeStage>(job.stage.load()), acquired);
        release_session(nullptr);
        return nullptr;
    }
    Session& session = *session_ptr;
    TunerServiceBackend& tuner = session.enclosure->tuner();
    Q3U4StreamDataPlane& plane = session.enclosure->plane();

    // カードはセッションに1組だけ持つ。復号する仕事だけが使う。
    if (!session.service.has_value()) {
        session.hardware.emplace(session.enclosure->card_bridge());
        session.card.emplace(*session.hardware, session.card_time);
        session.protocol.emplace(*session.card);
        session.service.emplace(session.enclosure->card_backend(), *session.protocol);
    }

    job.stage.store(kStageCard);
    webts_winscard_bind(&*session.service, 1U);
    B_CAS_CARD* bcas = create_b_cas_card();
    if (bcas == nullptr) {
        webts_winscard_unbind();
        fail(kStageCard, Error::INTERNAL);
        release_session(&session);
        return nullptr;
    }
    const int card_initialized = bcas->init(bcas);
    if (card_initialized != 0) {
        job.b25_error.store(card_initialized);
        bcas->release(bcas);
        webts_winscard_unbind();
        fail(kStageCard, Error::PROTOCOL_ERROR);
        release_session(&session);
        return nullptr;
    }

    job.stage.store(kStageB25);
    ARIB_STD_B25* b25 = create_arib_std_b25();
    if (b25 == nullptr) {
        bcas->release(bcas);
        webts_winscard_unbind();
        fail(kStageB25, Error::INTERNAL);
        release_session(&session);
        return nullptr;
    }
    // EMM 処理は行わない。受信のみの用途では不要で、カードへの書き込みを
    // 伴うため、明示的に切る。
    b25->set_emm_proc(b25, 0);
    b25->set_multi2_round(b25, 4);
    b25->set_strip(b25, 0);
    b25->set_unit_size(b25, 188);
    if (b25->set_b_cas_card(b25, bcas) != 0) {
        b25->release(b25);
        bcas->release(bcas);
        webts_winscard_unbind();
        fail(kStageB25, Error::INTERNAL);
        release_session(&session);
        return nullptr;
    }

    const bool satellite = job.wave == kWaveSatellite;
    const ipc::System system = satellite ? ipc::System::ISDB_S : ipc::System::ISDB_T;
    Error result = Error::OK;
    bool frontend_open = false;
    bool capture_started = false;
    TunerAttachment attachment{};
    bool attached = false;
    int claimed = -1;

    const auto finish = [&]() {
        job.stage.store(kStageCleanup);
        // **データプレーンは畳まない。**セッションの持ち物で、ほかの受信機が
        // 使っている。外すのは自分の attachment だけ。
        if (attached) {
            const auto detached = plane.detach(attachment);
            if (!detached && result == Error::OK) result = detached.error();
            plane.release_final(attachment);
        }
        const auto receiver = static_cast<std::uint8_t>(claimed);
        if (capture_started) {
            const auto stopped = tuner.stop_capture(receiver, system);
            if (!stopped && result == Error::OK) result = stopped.error();
        }
        // 閉じれば LNB の要求も backend が落とす。
        if (frontend_open) {
            const auto closed = tuner.close_receiver(receiver);
            if (!closed && result == Error::OK) result = closed.error();
        }
        release_receiver(session, claimed);
        b25->release(b25);
        bcas->release(bcas);
        webts_winscard_unbind();
        job.error.store(static_cast<int>(result));
        job.elapsed_ms.store(elapsed());
        job.stage.store(kStageDone);
        job.state.store(result == Error::OK ? kFinished : kFailed);
        release_session(&session);
    };

    // 受信機を選ぶ。指定が無ければ、その波を受けられる空いた受信機のうち
    // 最も若い番号（視聴用に走査が空けているもの）。
    claimed = claim_receiver(session, system, ReceiverUse::viewing, job.receiver);
    if (claimed < 0) { result = Error::BUSY; finish(); return nullptr; }
    const auto receiver = static_cast<std::uint8_t>(claimed);
    job.receiver = claimed;

    job.stage.store(kStageFrontendOpen);
    const auto opened = tuner.open_receiver(receiver);
    if (!opened) { result = opened.error(); finish(); return nullptr; }
    frontend_open = true;

    // 給電は許可されたときだけ。別の機器が給電している線へ重ねない。
    // **中継器の中から TS を選ぶのは TSID で。**走査で控えた TSID をそのまま
    // 指定する。スロット番号で指さないのは、編成が変わるとスロットが動くため。
    TuneRequest request;
    request.receiver = receiver;
    request.system = system;
    request.frequency_khz = static_cast<std::uint32_t>(job.frequency_khz);
    request.lnb_voltage = static_cast<std::uint8_t>(satellite && job.allow_15v ? 15U : 0U);
    request.tsid = static_cast<std::uint16_t>(job.tsid);
    result = tune_receiver(tuner, request, TuneProgress{&job.stage, &job.lock_wait_ms});
    if (result != Error::OK) { finish(); return nullptr; }

    attachment.owner_client_id = 1U;
    attachment.lease_id = 1U;
    attachment.attachment_id = session.next_attachment.fetch_add(1U);
    attachment.receiver = receiver;
    attachment.system = system;

    job.stage.store(kStageAttach);
    const auto capture = tuner.start_capture(receiver, system);
    if (!capture) { result = capture.error(); finish(); return nullptr; }
    capture_started = true;
    const auto attach = plane.attach(attachment);
    if (!attach) { result = attach.error(); finish(); return nullptr; }
    attached = true;

    job.stage.store(kStageReading);
    std::vector<std::uint8_t> buffer(kReadBytes);
    const auto reading_started = std::chrono::steady_clock::now();
    const auto reading_elapsed = [reading_started]() {
        return static_cast<int>(std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - reading_started).count());
    };
    const bool bounded = job.duration_ms > 0;
    const auto deadline = reading_started + std::chrono::milliseconds(job.duration_ms);
    while (!job.stop_requested.load()
           && (!bounded || std::chrono::steady_clock::now() < deadline)) {
        const auto read = plane.read(
            attachment, MutableByteView{buffer.data(), buffer.size()}, Timeout{500U});
        if (!read) { result = read.error(); break; }
        const TunerStreamReadResult& chunk = read.value();
        if (chunk.bytes > 0U) {
            count_packets(buffer.data(), chunk.bytes, job.in_packets, job.in_scrambled,
                          nullptr);
            ARIB_STD_B25_BUFFER input{buffer.data(), static_cast<std::int32_t>(chunk.bytes)};
            // **負だけが異常。正は警告で、処理は続く。**libaribb25 の約束で
            // あり、ライブラリ自身も未契約 ECM を異常扱いしていない
            // (`r > 0 && r != WARN_UNPURCHASED_ECM` のときだけ捨てる)。
            //
            // 非0を全部落としていたため、未契約の ECM が1つ来た時点で
            // セッションごと終わっていた。契約の無い局で「一瞬映って止まる」
            // のはこれである。一時的な section の壊れ (WARN 2, 3) でも同じ
            // ことが起きるので、契約に関係なく直す必要がある。
            const int put = b25->put(b25, &input);
            if (put < 0) { job.b25_error.store(put); result = Error::PROTOCOL_ERROR; break; }
            if (put > 0) job.b25_error.store(put);
            ARIB_STD_B25_BUFFER output{nullptr, 0};
            const int got = b25->get(b25, &output);
            if (got < 0) { job.b25_error.store(got); result = Error::PROTOCOL_ERROR; break; }
            if (got > 0) job.b25_error.store(got);
            if (output.data != nullptr && output.size > 0) {
                count_packets(output.data, static_cast<std::size_t>(output.size),
                              job.out_packets, job.out_scrambled, &job.out_bad_sync);
                retain(job, output.data, static_cast<std::size_t>(output.size));
            }
            publish_program_info(job, b25);
        }
        job.reading_ms.store(reading_elapsed());
        job.elapsed_ms.store(elapsed());
        if (chunk.terminal != TunerStreamTerminal::none || chunk.eof) break;
    }
    job.reading_ms.store(reading_elapsed());

    if (result == Error::OK) {
        job.stage.store(kStageFlush);
        if (b25->flush(b25) == 0) {
            // 1回の get で出し切れる保証はないので、空が返るまで繰り返す。
            for (;;) {
                ARIB_STD_B25_BUFFER output{nullptr, 0};
                if (b25->get(b25, &output) != 0) break;
                if (output.data == nullptr || output.size <= 0) break;
                count_packets(output.data, static_cast<std::size_t>(output.size),
                              job.out_packets, job.out_scrambled, &job.out_bad_sync);
                retain(job, output.data, static_cast<std::size_t>(output.size));
            }
        }
        publish_program_info(job, b25);
    }

    finish();
    return nullptr;
}

// ---- 走査タスク ----
//
// 中継器を順に選局し、そのたびに TS を少しだけ流して JS に SDT/NIT/EIT を
// 読ませる。**カードも B25 も使わない。**SI はスクランブルされていない。
//
// **受信機の数だけ並列に走る。**割り当ては JS が決め、各作業者が共通の
// カーソルから次の添字を取る。地上波4本なら4倍速く終わる。同じセッションの
// 上で動くので、視聴と同時に走らせてもよい（別の受信機であること）。
//
// **次へ進む前に、JS がその中継器を見たという応答を待つ。**待たずに進むと、
// ブラウザにタイマーを絞られたときに中継器を丸ごと取りこぼす
// （docs/FINDINGS.md 18章）。応答は作業者ごとに返る。

constexpr int kMaxScanEntries = 256;
constexpr int kMaxScanWorkers = 4;
/**
 * 1中継器あたりの上限の既定。これを過ぎたら諦めて次へ行く。
 * 番組表（EIT[schedule]）を取るときは JS が長い値を渡す。
 */
constexpr int kScanEntryTimeoutMs = 8000;
/**
 * JS が渡せる上限。Mirakurun の番組表取得の上限 (epgRetrievalTime) と同じ10分。
 * 実測で、BS の1つの TS から全局の番組表が揃うのに5分では足りなかった
 * （NHK BS の5〜8日目の表が最後まで残った）。
 */
constexpr int kScanEntryTimeoutMaxMs = 600000;
/** JS の応答を待つ上限。応答が来なくても走査は止めない。 */
constexpr int kScanAcknowledgeTimeoutMs = 30000;
/** 1バイトも来ないまま過ぎたら見切る時間。衛星の空きスロット対策。 */
constexpr int kScanSilenceMs = 2000;
/** 読み手が遅れたときの上限。超えたら古いほうから捨てる。 */
constexpr std::size_t kScanStreamLimit = 4U * 1024U * 1024U;
/** TMCC の相対 TS 番号の上限。 */
constexpr int kMaxSlots = 12;

struct ScanWorker final {
    std::atomic<int> index{-1};
    std::atomic<int> waiting{0};
    std::atomic<int> acknowledged{-1};
    std::atomic<bool> advance{false};
    std::atomic<int> receiver{-1};
    std::mutex mutex;
    std::vector<std::uint8_t> output;
    std::size_t consumed = 0U;
    std::atomic<unsigned long long> pending{0U};
};

struct ScanJob final {
    std::vector<std::uint8_t> firmware;
    bool allow_15v = false;
    int wave = 0;
    int dwell_ms = kScanEntryTimeoutMs;
    std::vector<int> frequencies_khz;
    std::vector<int> slots;
    std::vector<int> receivers;

    std::atomic<int> state{kIdle};
    std::atomic<int> stage{kStageStart};
    std::atomic<int> error{0};
    std::atomic<int> cursor{0};
    std::atomic<int> running{0};
    std::atomic<bool> stop_requested{false};

    std::atomic<int> locked[kMaxScanEntries];
    ScanWorker workers[kMaxScanWorkers];
};

/**
 * 走査のジョブ。**地上波と衛星で1つずつ持つ。**受信機が別なので同時に
 * 回せる。以前は全体で1つしか持てず、番組表の取得で地上波が終わるまで
 * 衛星を始められなかった（8本中3本しか使わない）。
 */
struct ScanSlot final {
    ScanJob* job = nullptr;
    pthread_t threads[kMaxScanWorkers]{};
    int thread_count = 0;
};

ScanSlot g_scans[2];

ScanSlot* scan_slot(int wave) noexcept {
    if (wave != kWaveTerrestrial && wave != kWaveSatellite) return nullptr;
    return &g_scans[wave];
}

ScanJob* scan_job(int wave) noexcept {
    ScanSlot* slot = scan_slot(wave);
    return slot == nullptr ? nullptr : slot->job;
}

void scan_retain(ScanWorker& worker, const std::uint8_t* data, std::size_t size) noexcept {
    std::lock_guard<std::mutex> guard(worker.mutex);
    if (worker.consumed > 0U && worker.consumed == worker.output.size()) {
        worker.output.clear();
        worker.consumed = 0U;
    }
    worker.output.insert(worker.output.end(), data, data + size);
    if (worker.output.size() - worker.consumed > kScanStreamLimit) {
        // 読み手が遅れている。古いほうから捨てる。走査は止めない。
        //
        // **パケットの頭で切る。**以前は 2 MiB ちょうどを残していたので、
        // 捨てたあとの先頭がパケットの途中になり、区切りを取り直さない
        // 読み手には以降が全部読めなくなっていた（FINDINGS 33章）。1回に
        // 読める量は 188 の倍数とは限らないので、位置で割らずに同期バイトを
        // 探す。次の 188 バイト先も 0x47 であることまで見る。
        constexpr std::size_t kPacket = 188U;
        std::size_t from = worker.output.size() - kScanStreamLimit / 2U;
        const std::size_t limit = std::min(worker.output.size(), from + 2U * kPacket);
        while (from + kPacket < limit
               && !(worker.output[from] == 0x47U && worker.output[from + kPacket] == 0x47U)) {
            ++from;
        }
        worker.output.erase(worker.output.begin(),
                            worker.output.begin() + static_cast<std::ptrdiff_t>(from));
        worker.consumed = 0U;
    }
    worker.pending.store(worker.output.size() - worker.consumed);
}

void scan_discard(ScanWorker& worker) noexcept {
    std::lock_guard<std::mutex> guard(worker.mutex);
    worker.output.clear();
    worker.consumed = 0U;
    worker.pending.store(0U);
}

/** JS がこの添字を見終えるまで待つ。返らなくても上限で打ち切る。 */
void scan_await_acknowledge(ScanJob& job, ScanWorker& worker, int index) noexcept {
    worker.waiting.store(1);
    const auto deadline = std::chrono::steady_clock::now()
        + std::chrono::milliseconds(kScanAcknowledgeTimeoutMs);
    while (worker.acknowledged.load() < index && !job.stop_requested.load()
           && std::chrono::steady_clock::now() < deadline) {
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    worker.waiting.store(0);
}

struct ScanWorkerArgument final {
    ScanJob* job;
    int slot;
};

void* scan_worker_main(void* argument) noexcept {
    const ScanWorkerArgument arg = *static_cast<ScanWorkerArgument*>(argument);
    delete static_cast<ScanWorkerArgument*>(argument);
    ScanJob& job = *arg.job;
    ScanWorker& worker = job.workers[arg.slot];

    Session* session_ptr = nullptr;
    const Error acquired =
        acquire_session(job.firmware, job.allow_15v, job.stage, &session_ptr);
    if (acquired != Error::OK || session_ptr == nullptr) {
        job.error.store(static_cast<int>(acquired));
        job.state.store(kFailed);
        release_session(nullptr);
        if (job.running.fetch_sub(1) == 1) job.state.store(kFailed);
        return nullptr;
    }
    Session& session = *session_ptr;
    TunerServiceBackend& tuner = session.enclosure->tuner();
    Q3U4StreamDataPlane& plane = session.enclosure->plane();

    const bool satellite = job.wave == kWaveSatellite;
    const ipc::System system = satellite ? ipc::System::ISDB_S : ipc::System::ISDB_T;
    const auto lnb_voltage = static_cast<std::uint8_t>(
        satellite && job.allow_15v ? 15U : 0U);

    Error result = Error::OK;
    bool frontend_open = false;

    // 受信機を選ぶ。**取れなければこの作業者は何もせずに終わる。**その波の
    // 走査に回せる受信機が、頼んだ作業者の数より少ない機種がある。残りの
    // 作業者が全部の中継器を回す。
    const int claimed =
        claim_receiver(session, system, ReceiverUse::scan, worker.receiver.load());
    const auto receiver = static_cast<std::uint8_t>(claimed < 0 ? 0 : claimed);
    if (claimed >= 0) {
        worker.receiver.store(claimed);
        const auto opened = tuner.open_receiver(receiver);
        if (!opened) {
            result = opened.error();
        } else {
            frontend_open = true;
        }
    }

    std::vector<std::uint8_t> buffer(kReadBytes);
    TunerAttachment attachment{};
    attachment.owner_client_id = 1U;
    attachment.lease_id = 1U;
    attachment.receiver = receiver;
    attachment.system = system;

    // 直前に合わせた周波数。同じ中継器のあいだは選局し直さない。
    // **ただし、選局の前に TS を選ぶ機種では毎回選局する**（PX-MLT5PE）。
    // その機種では、選局の後から相対 TS だけを替える手順が上流に無い。
    const bool retune_per_slot = satellite && tuner.selects_satellite_stream_before_tune();
    int tuned_khz = -1;
    bool tuned_locked = false;

    while (frontend_open && result == Error::OK && !job.stop_requested.load()) {
        const int i = job.cursor.fetch_add(1);
        if (i >= static_cast<int>(job.frequencies_khz.size())) break;

        worker.index.store(i);
        worker.advance.store(false);
        scan_discard(worker);

        const int frequency = job.frequencies_khz[static_cast<std::size_t>(i)];
        const int slot = satellite ? job.slots[static_cast<std::size_t>(i)] : -1;

        bool selected = false;
        if (frequency != tuned_khz || retune_per_slot) {
            tuned_khz = frequency;
            TuneRequest request;
            request.receiver = receiver;
            request.system = system;
            request.frequency_khz = static_cast<std::uint32_t>(frequency);
            request.lnb_voltage = lnb_voltage;
            request.by_slot = true;
            request.slot = static_cast<std::uint8_t>(slot < 0 ? 0 : slot);
            tuned_locked = tune_receiver(tuner, request, TuneProgress{}) == Error::OK;
            // 衛星なら、選局の中で相対 TS も選んである。
            selected = tuned_locked;
        } else if (tuned_locked && satellite) {
            // 同じ中継器のまま、相対 TS だけを替える（ロックの後に選ぶ機種）。
            selected = static_cast<bool>(tuner.select_satellite_slot(
                receiver, static_cast<std::uint8_t>(slot), kSelectSlotTimeoutMs));
        } else {
            selected = tuned_locked;
        }

        if (!tuned_locked || !selected) {
            job.locked[i].store(0);
            scan_await_acknowledge(job, worker, i);
            continue;
        }
        // **空きスロットでも選択自体は通る。**筐体からは TMCC の TSID を
        // 読めないので、ここでは弾けない。中身が無いことは「データが来ない」
        // ことで分かるので、下の読み出しで打ち切る。TS 識別子は SDT から
        // 取る（放送側の申告が正）。
        job.locked[i].store(1);

        const auto capture = tuner.start_capture(receiver, system);
        if (!capture) { result = capture.error(); break; }
        attachment.attachment_id = session.next_attachment.fetch_add(1U);
        const auto attach = plane.attach(attachment);
        if (!attach) {
            (void)tuner.stop_capture(receiver, system);
            result = attach.error();
            break;
        }

        const auto entry_started = std::chrono::steady_clock::now();
        const auto deadline = entry_started + std::chrono::milliseconds(job.dwell_ms);
        // **何も来ないものは早く見切る。**衛星の空きスロットは選択が通って
        // しまい、TS が1バイトも流れない。上限まで待つと1本あたり数秒を
        // 無駄にする。
        const auto silent_deadline =
            entry_started + std::chrono::milliseconds(kScanSilenceMs);
        bool any_bytes = false;
        while (!worker.advance.load() && !job.stop_requested.load()
               && std::chrono::steady_clock::now() < deadline) {
            const auto read = plane.read(
                attachment, MutableByteView{buffer.data(), buffer.size()}, Timeout{500U});
            if (!read) break;
            if (read.value().bytes > 0U) {
                any_bytes = true;
                scan_retain(worker, buffer.data(), read.value().bytes);
            } else if (!any_bytes
                       && std::chrono::steady_clock::now() > silent_deadline) {
                break;
            }
            if (read.value().terminal != TunerStreamTerminal::none || read.value().eof) break;
        }
        if (!any_bytes) job.locked[i].store(0);

        plane.detach(attachment);
        // 保持されている最終値を返しておく。溜め続けない。
        plane.release_final(attachment);
        const auto stopped = tuner.stop_capture(receiver, system);
        if (!stopped && result == Error::OK) result = stopped.error();
        scan_await_acknowledge(job, worker, i);
    }

    // 閉じれば LNB の要求も backend が落とす。
    if (frontend_open) {
        const auto closed = tuner.close_receiver(receiver);
        if (!closed && result == Error::OK) result = closed.error();
    }
    release_receiver(session, claimed);
    if (result != Error::OK && job.error.load() == 0) {
        job.error.store(static_cast<int>(result));
    }
    release_session(&session);

    if (job.running.fetch_sub(1) == 1) {
        job.stage.store(kStageDone);
        job.state.store(job.error.load() == 0 ? kFinished : kFailed);
    }
    return nullptr;
}

}  // namespace

extern "C" {

/** 選局・受信・復号を pthread で行う。即座に戻る。この関数は USB に触れない。 */
int webts_q3u4_descramble_start(const std::uint8_t* firmware, int firmware_size,
                                int receiver, int frequency_khz, int duration_ms,
                                int collect, int wave, int tsid, int allow_15v) {
    if (g_job != nullptr && g_job->state.load() == kRunning) return static_cast<int>(Error::BUSY);
    if (wave != kWaveTerrestrial && wave != kWaveSatellite) {
        return static_cast<int>(Error::INVALID_ARGUMENT);
    }
    // 受信機は -1（ここで選ぶ）か上流の番号。その受信機がこの波を受けられる
    // かは機種による。開いてから backend に聞く（claim_receiver）。
    const bool receiver_ok = receiver == kAnyReceiver
        || (receiver >= 0 && receiver < static_cast<int>(ipc::kReceiverCount));
    if (firmware == nullptr || firmware_size <= 0 || !receiver_ok ||
        frequency_khz < 0 || duration_ms < 0 || duration_ms > 14400000 ||
        collect < 0 || collect > 2) {
        return static_cast<int>(Error::INVALID_ARGUMENT);
    }
    // 衛星は TSID を指定しないと、中継器のどの TS が出るか決まらない。
    if (wave == kWaveSatellite && (tsid <= 0 || tsid > 0xFFFF)) {
        return static_cast<int>(Error::INVALID_ARGUMENT);
    }
    if (g_thread_started) { pthread_join(g_thread, nullptr); g_thread_started = false; }
    delete g_job;
    g_job = new Job();
    g_job->firmware.assign(firmware, firmware + firmware_size);
    g_job->receiver = receiver;
    g_job->wave = wave;
    g_job->tsid = tsid;
    g_job->allow_15v = allow_15v != 0;
    g_job->frequency_khz = frequency_khz;
    g_job->duration_ms = duration_ms;
    g_job->collect = collect;
    if (collect == kCollectAccumulate && duration_ms > 0) {
        // 15 Mbps 前後なので、あらかじめそのぶん確保して再確保を避ける。
        g_job->output.reserve(static_cast<std::size_t>(duration_ms) * 2048U);
    } else if (collect == kCollectStream) {
        g_job->output.reserve(kStreamLimit);
    }
    g_job->state.store(kRunning);
    if (pthread_create(&g_thread, nullptr, worker_main, g_job) != 0) {
        g_job->state.store(kFailed);
        g_job->error.store(static_cast<int>(Error::INTERNAL));
        return static_cast<int>(Error::INTERNAL);
    }
    g_thread_started = true;
    return 0;
}

/** 進捗と集計を読む。ブロックしない。output は 16 語（17 語目は任意）。 */
int webts_q3u4_descramble_poll(std::int32_t* output, int output_words) {
    if (output == nullptr || output_words < 16) return static_cast<int>(Error::INVALID_ARGUMENT);
    if (g_job == nullptr) { output[0] = kIdle; return 0; }
    const Job& job = *g_job;
    output[0] = job.state.load();
    output[1] = job.stage.load();
    output[2] = job.error.load();
    output[3] = job.b25_error.load();
    output[4] = job.elapsed_ms.load();
    output[5] = job.reading_ms.load();
    output[6] = static_cast<std::int32_t>(job.in_packets.load());
    output[7] = static_cast<std::int32_t>(job.in_scrambled.load());
    output[8] = static_cast<std::int32_t>(job.out_packets.load());
    output[9] = static_cast<std::int32_t>(job.out_scrambled.load());
    output[10] = static_cast<std::int32_t>(job.out_bad_sync.load());
    output[11] = job.program_count.load();
    output[12] = static_cast<std::int32_t>(job.total_packets.load());
    output[13] = static_cast<std::int32_t>(job.undecrypted_packets.load());
    output[14] = job.ecm_unpurchased.load();
    output[15] = job.last_ecm_error.load();
    if (output_words >= 17) output[16] = job.lock_wait_ms.load();
    return 0;
}

/** 実行中のジョブに停止を要求する。戻るのを待たない。 */
/**
 * セッションを閉じる要求。仕事が残っていれば、最後の1つが終わった時点で畳む。
 * 0 を渡すと開いたままにする（視聴と走査を続けて行うとき）。
 */
void webts_q3u4_session_keep_open(int keep) {
    g_session_close_requested.store(keep == 0);
}

void webts_q3u4_descramble_stop(void) {
    if (g_job != nullptr) g_job->stop_requested.store(true);
}

/**
 * stream で溜まったぶんを output へ写し、写したぶんを捨てる。実行中に
 * 呼んでよい唯一の取り出し口で、戻り値は写したバイト数。
 */
int webts_q3u4_descramble_drain(std::uint8_t* output, int capacity) {
    if (g_job == nullptr || output == nullptr || capacity <= 0) return 0;
    Job& job = *g_job;
    std::lock_guard<std::mutex> lock(job.mutex);
    const std::size_t pending = job.output.size() - job.consumed;
    const std::size_t take = std::min(pending, static_cast<std::size_t>(capacity));
    if (take == 0U) return 0;
    std::memcpy(output, job.output.data() + job.consumed, take);
    job.consumed += take;
    job.delivered_bytes.fetch_add(take);
    if (job.consumed >= job.output.size()) {
        job.output.clear();
        job.consumed = 0U;
    }
    job.output_bytes.store(job.output.size() - job.consumed);
    return static_cast<int>(take);
}

/** まだ渡していないバイト数と、詰まって捨てたバイト数。 */
int webts_q3u4_descramble_pending(void) {
    return g_job == nullptr ? 0 : static_cast<int>(g_job->output_bytes.load());
}

int webts_q3u4_descramble_dropped(void) {
    return g_job == nullptr ? 0 : static_cast<int>(g_job->dropped_bytes.load());
}

/**
 * 溜めた復号済み TS の先頭。実行中は 0 を返す。返るポインタは次の start か
 * discard まで有効。
 */
std::uint8_t* webts_q3u4_descramble_output(void) {
    if (g_job == nullptr || g_job->state.load() == kRunning) return nullptr;
    return g_job->output.empty() ? nullptr : g_job->output.data();
}

int webts_q3u4_descramble_output_size(void) {
    if (g_job == nullptr) return 0;
    return static_cast<int>(g_job->output_bytes.load());
}

/** 溜めた TS を捨てる。呼び出し側が取り出したら必ず呼ぶ。 */
void webts_q3u4_descramble_discard(void) {
    if (g_job == nullptr || g_job->state.load() == kRunning) return;
    std::fill(g_job->output.begin(), g_job->output.end(), std::uint8_t{0});
    g_job->output.clear();
    g_job->output.shrink_to_fit();
    g_job->output_bytes.store(0U);
}


/**
 * 走査を始める。受信機は JS が割り当てる。
 *
 * **視聴と同時に呼んでよい。**同じセッションを共有するので、別の受信機を
 * 渡すかぎり衝突しない。同じ受信機を渡した場合は上流が弾く。
 */
int webts_q3u4_scan_start(const std::uint8_t* firmware, int firmware_size, int wave,
                          const std::int32_t* frequencies, const std::int32_t* slots,
                          int count, const std::int32_t* receivers, int receiver_count,
                          int allow_15v, int dwell_ms) {
    ScanSlot* const scan = scan_slot(wave);
    if (scan == nullptr) return static_cast<int>(Error::INVALID_ARGUMENT);
    if (scan->job != nullptr && scan->job->state.load() == kRunning) {
        return static_cast<int>(Error::BUSY);
    }
    if (firmware == nullptr || firmware_size <= 0 || frequencies == nullptr ||
        count <= 0 || count > kMaxScanEntries || receivers == nullptr ||
        receiver_count <= 0 || receiver_count > kMaxScanWorkers) {
        return static_cast<int>(Error::INVALID_ARGUMENT);
    }
    if (wave != kWaveTerrestrial && wave != kWaveSatellite) {
        return static_cast<int>(Error::INVALID_ARGUMENT);
    }
    if (dwell_ms < 0 || dwell_ms > kScanEntryTimeoutMaxMs) {
        return static_cast<int>(Error::INVALID_ARGUMENT);
    }
    const bool satellite = wave == kWaveSatellite;
    // 受信機は作業者ごとに -1（ここで選ぶ）か上流の番号（開発用の上書き）。
    // その受信機がこの波を受けられるかは、開いてから backend に聞く。
    for (int w = 0; w < receiver_count; ++w) {
        const int receiver = receivers[w];
        if (receiver == kAnyReceiver) continue;
        if (receiver < 0 || receiver >= static_cast<int>(ipc::kReceiverCount)) {
            return static_cast<int>(Error::INVALID_ARGUMENT);
        }
        for (int o = 0; o < w; ++o) {
            if (receivers[o] == receiver) return static_cast<int>(Error::INVALID_ARGUMENT);
        }
    }
    // 衛星は相対 TS 番号が要る。周波数だけで合わせると、中継器に載っている
    // どの TS が出るか決まらない。
    if (satellite) {
        if (slots == nullptr) return static_cast<int>(Error::INVALID_ARGUMENT);
        for (int i = 0; i < count; ++i) {
            if (slots[i] < 0 || slots[i] >= kMaxSlots) {
                return static_cast<int>(Error::INVALID_ARGUMENT);
            }
        }
    }

    for (int w = 0; w < scan->thread_count; ++w) pthread_join(scan->threads[w], nullptr);
    scan->thread_count = 0;
    delete scan->job;
    scan->job = new ScanJob();
    ScanJob& job = *scan->job;
    job.firmware.assign(firmware, firmware + firmware_size);
    job.allow_15v = allow_15v != 0;
    job.wave = wave;
    job.dwell_ms = dwell_ms > 0 ? dwell_ms : kScanEntryTimeoutMs;
    job.frequencies_khz.assign(frequencies, frequencies + count);
    if (satellite) job.slots.assign(slots, slots + count);
    else job.slots.assign(static_cast<std::size_t>(count), -1);
    job.receivers.assign(receivers, receivers + receiver_count);
    for (int i = 0; i < kMaxScanEntries; ++i) job.locked[i].store(-1);
    for (int w = 0; w < receiver_count; ++w) {
        job.workers[w].receiver.store(receivers[w]);
        job.workers[w].output.reserve(kScanStreamLimit / 4U);
    }
    job.running.store(receiver_count);
    job.state.store(kRunning);

    for (int w = 0; w < receiver_count; ++w) {
        auto* argument = new (std::nothrow) ScanWorkerArgument{&job, w};
        pthread_t thread{};
        if (argument == nullptr ||
            pthread_create(&thread, nullptr, scan_worker_main, argument) != 0) {
            delete argument;
            // 立てられなかったぶんは数から引く。残りは走り続ける。
            if (job.running.fetch_sub(1) == 1) {
                job.error.store(static_cast<int>(Error::INTERNAL));
                job.state.store(kFailed);
                return static_cast<int>(Error::INTERNAL);
            }
            continue;
        }
        scan->threads[scan->thread_count] = thread;
        scan->thread_count += 1;
    }
    return 0;
}

/**
 * 進み具合を読む。ブロックしない。
 *
 *   0 state, 1 stage, 2 error, 3 cursor, 4 workers, 5 entries
 *   6..     作業者ごとに index, waiting, pending
 *   その後  entries ぶんの locked[]
 */
int webts_q3u4_scan_poll(int wave, std::int32_t* output, int output_words) {
    if (output == nullptr || output_words < 6) return static_cast<int>(Error::INVALID_ARGUMENT);
    const ScanJob* const current = scan_job(wave);
    if (current == nullptr) { output[0] = kIdle; return 0; }
    const ScanJob& job = *current;
    const int workers = static_cast<int>(job.receivers.size());
    const int entries = static_cast<int>(job.frequencies_khz.size());
    output[0] = job.state.load();
    output[1] = job.stage.load();
    output[2] = job.error.load();
    output[3] = job.cursor.load();
    output[4] = workers;
    output[5] = entries;
    int at = 6;
    for (int w = 0; w < workers && at + 3 <= output_words; ++w) {
        output[at++] = job.workers[w].index.load();
        output[at++] = job.workers[w].waiting.load();
        output[at++] = static_cast<std::int32_t>(job.workers[w].pending.load());
    }
    for (int i = 0; i < entries && at < output_words; ++i) output[at++] = job.locked[i].load();
    return 0;
}

/** その作業者が溜めたぶんを取り出す。戻り値は写したバイト数。 */
int webts_q3u4_scan_drain(int wave, int worker, std::uint8_t* output, int capacity) {
    ScanJob* const job = scan_job(wave);
    if (job == nullptr || output == nullptr || capacity <= 0) return 0;
    if (worker < 0 || worker >= kMaxScanWorkers) return 0;
    ScanWorker& slot = job->workers[worker];
    std::lock_guard<std::mutex> guard(slot.mutex);
    const std::size_t available = slot.output.size() - slot.consumed;
    if (available == 0U) return 0;
    const std::size_t copied = std::min(available, static_cast<std::size_t>(capacity));
    std::memcpy(output, slot.output.data() + slot.consumed, copied);
    slot.consumed += copied;
    slot.pending.store(slot.output.size() - slot.consumed);
    return static_cast<int>(copied);
}

/** その作業者に「この中継器はもう十分」と伝える。 */
void webts_q3u4_scan_advance(int wave, int worker) {
    ScanJob* const job = scan_job(wave);
    if (job == nullptr || worker < 0 || worker >= kMaxScanWorkers) return;
    job->workers[worker].advance.store(true);
}

/** その作業者に、この添字を見終えたと伝える。返すまで次へ進まない。 */
void webts_q3u4_scan_acknowledge(int wave, int worker, int index) {
    ScanJob* const job = scan_job(wave);
    if (job == nullptr || worker < 0 || worker >= kMaxScanWorkers) return;
    job->workers[worker].acknowledged.store(index);
}

void webts_q3u4_scan_stop(int wave) {
    ScanJob* const job = scan_job(wave);
    if (job != nullptr) job->stop_requested.store(true);
}

int webts_q3u4_scan_join(int wave) {
    ScanSlot* const scan = scan_slot(wave);
    if (scan == nullptr) return static_cast<int>(Error::INVALID_ARGUMENT);
    for (int w = 0; w < scan->thread_count; ++w) pthread_join(scan->threads[w], nullptr);
    scan->thread_count = 0;
    return scan->job == nullptr ? 0 : scan->job->error.load();
}

const char* webts_q3u4_descramble_error_name(int error) {
    if (error < 0 || error > 0xff) return "unknown";
    return error_string(static_cast<Error>(error));
}

/**
 * 走査の失敗を名前にする。中身は上と同じで、呼ぶ側が別なので名前を分ける。
 * **失敗したときにしか呼ばれない。**統合のときに移植し忘れており、成功する
 * かぎり誰も気づかなかった。
 */
const char* webts_q3u4_scan_error_name(int error) {
    return webts_q3u4_descramble_error_name(error);
}

int webts_q3u4_descramble_join(void) {
    if (g_job == nullptr) return 0;
    if (g_job->state.load() == kRunning) return static_cast<int>(Error::BUSY);
    if (g_thread_started) { pthread_join(g_thread, nullptr); g_thread_started = false; }
    return 0;
}

}  // extern "C"
