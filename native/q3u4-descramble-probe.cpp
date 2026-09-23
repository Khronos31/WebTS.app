// PX-Q3U4 で受信した TS を、内蔵カードを使って実際に復号する。
//
// 13章で TS 受信、14章でカード、15章で B_CAS_CARD がそれぞれ通った。ここは
// それらを同時に動かす。**選局とカードを同時に使う構成はここが初めて**で、
// 電源調停が成立するかどうかもここで分かる。
//
// 受信機の番号は上流の global 番号（0..7）である。`map_receiver` によれば
// local = global % 4、bridge = global < 4 ? dev1 : dev2、local < 2 が ISDB-S。
// 地上波は global 2, 3（dev1）と 6, 7（dev2）。データプレーンも同じ global
// 番号でセッションを引く。
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

#include "frontend_probe_support.h"
#include "q3u4_card_backend.h"
#include "q3u4_frontend.h"
#include "q3u4_lnb_power.h"
#include "px4/card.h"
#include "px4/card_service.h"
#include "px4/firmware.h"
#include "px4/ipc.h"
#include "px4/it930x.h"
#include "px4/libusb_transport.h"
#include "px4/q3u4_stream.h"

extern "C" {
#include "arib_std_b25.h"
#include "b_cas_card.h"
}

extern "C" void webts_winscard_bind(void* service, std::uint64_t client);
extern "C" void webts_winscard_unbind(void);

#include <atomic>
#include <chrono>
#include <algorithm>
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

struct Job final {
    std::vector<std::uint8_t> firmware;
    int receiver = 2;
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

class BlockingDelay final : public Q3U4FrontendDelay {
public:
    void sleep_ms(std::uint32_t milliseconds) noexcept override {
        std::this_thread::sleep_for(std::chrono::milliseconds(milliseconds));
    }
};

/**
 * ロック待ちの上限。上流の `poll_frontend_probe_lock` は 300 回固定で、
 * 1回ごとの I2C がこの経路では遅く、信号の無い周波数だと 2 分以上黙ったまま
 * 待つことになる。実測のロックは 0.3 秒なので、それより桁で余裕のある
 * ところで打ち切る。コールバックが誤りを返せば上流の走査は止まる。
 */
constexpr int kLockBudgetMs = 10000;

struct LockContext final {
    Q3U4FrontendEnclosure* enclosure;
    std::uint8_t receiver;
    std::chrono::steady_clock::time_point started;
    std::atomic<int>* elapsed_ms;
    bool satellite = false;
};

Result<bool> demod_lock(void* context) noexcept {
    auto* lock = static_cast<LockContext*>(context);
    const auto waited = static_cast<int>(
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - lock->started).count());
    lock->elapsed_ms->store(waited);
    if (waited > kLockBudgetMs) return Result<bool>::failure(Error::TIMEOUT);
    return lock->satellite ? lock->enclosure->is_satellite_locked(lock->receiver)
                           : lock->enclosure->is_terrestrial_locked(lock->receiver);
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
    BlockingDelay delay;
    bool allow_15v = false;

    std::unique_ptr<Q3U4Runtime> runtime;
    std::optional<It930xController> dev1;
    std::optional<It930xController> dev2;
    std::optional<It930xBackendPower> dev1_power;
    std::optional<It930xBackendPower> dev2_power;
    std::optional<It930xBridgeI2cMaster> bridge1;
    std::optional<It930xBridgeI2cMaster> bridge2;
    std::optional<Q3U4FrontendEnclosure> enclosure;
    std::optional<It930xLnbPower> lnb1;
    std::optional<It930xLnbPower> lnb2;
    std::optional<Q3U4LnbPowerCoordinator> lnb;
    std::unique_ptr<Q3U4StreamDataPlane> plane;

    // カード経路。復号する仕事だけが使う。カードは1枚なので使えるのも1つ。
    std::optional<Q3U4CardBackend> card_backend;
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

    stage.store(kStageOpen);
    Result<std::unique_ptr<Q3U4Runtime>> runtime = Q3U4Runtime::open_native();
    if (!runtime) return runtime.error();
    session->runtime = std::move(runtime.value());

    session->dev1.emplace(session->runtime->dev1(),
                          CommandPacingOptions{CommandPacingMode::no_delay});
    session->dev2.emplace(session->runtime->dev2(),
                          CommandPacingOptions{CommandPacingMode::no_delay});
    session->dev1_power.emplace(*session->dev1);
    session->dev2_power.emplace(*session->dev2);
    session->bridge1.emplace(*session->dev1);
    session->bridge2.emplace(*session->dev2);
    session->enclosure.emplace(*session->bridge1, *session->bridge2,
                               *session->dev1_power, *session->dev2_power, session->delay);
    // LNB は GPIO 11 を握る唯一の権限で、ブリッジ上の2受信機を参照計数する。
    // 地上波でも作っておく。作るだけでは給電しない。
    session->lnb1.emplace(*session->dev1);
    session->lnb2.emplace(*session->dev2);
    session->lnb.emplace(*session->lnb1, *session->lnb2, allow_15v);

    stage.store(kStageInit);
    const auto init1 = session->dev1->initialize_q3u4(image.value());
    if (!init1) return init1.error();
    const auto init2 = session->dev2->initialize_q3u4(image.value());
    if (!init2) return init2.error();

    // **データプレーンはセッションが持つ。**受信機ごとの attachment を束ねる
    // 側なので、仕事ごとに作り直すと同時に使えない。
    stage.store(kStageDataPlane);
    Result<std::unique_ptr<Q3U4StreamDataPlane>> plane =
        Q3U4StreamDataPlane::create(session->runtime->dev1(), session->runtime->dev2());
    if (!plane) return plane.error();
    session->plane = std::move(plane.value());

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

    if (g_session->plane) {
        // 保留中の bulk 転送のキャンセルを伴う停止。
        g_session->plane->shutdown();
        g_session->plane.reset();
    }
    if (g_session->service.has_value()) g_session->service->shutdown();
    if (g_session->lnb.has_value()) g_session->lnb->shutdown();
    delete g_session;
    g_session = nullptr;
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
    Q3U4FrontendEnclosure& enclosure = *session.enclosure;
    Q3U4LnbPowerCoordinator& lnb = *session.lnb;

    // カードはセッションに1組だけ持つ。復号する仕事だけが使う。
    if (!session.service.has_value()) {
        session.card_backend.emplace(*session.dev1, enclosure);
        session.hardware.emplace(*session.dev1);
        session.card.emplace(*session.hardware, session.card_time);
        session.protocol.emplace(*session.card);
        session.service.emplace(*session.card_backend, *session.protocol);
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

    const auto receiver = static_cast<std::uint8_t>(job.receiver);
    LockContext lock_context{&enclosure, receiver, std::chrono::steady_clock::now(),
                             &job.lock_wait_ms};
    Error result = Error::OK;
    bool frontend_open = false;
    bool capture_started = false;
    TunerAttachment attachment{};
    bool attached = false;

    const auto finish = [&]() {
        job.stage.store(kStageCleanup);
        // **データプレーンは畳まない。**セッションの持ち物で、ほかの受信機が
        // 使っている。外すのは自分の attachment だけ。
        if (attached) {
            const auto detached = session.plane->detach(attachment);
            if (!detached && result == Error::OK) result = detached.error();
            session.plane->release_final(attachment);
        }
        if (capture_started) {
            const auto stopped = job.wave == kWaveSatellite
                ? enclosure.stop_satellite_capture(receiver)
                : enclosure.stop_terrestrial_capture(receiver);
            if (!stopped && result == Error::OK) result = stopped.error();
        }
        if (frontend_open) {
            const auto closed = enclosure.close_receiver(receiver);
            if (!closed && result == Error::OK) result = closed.error();
        }
        b25->release(b25);
        bcas->release(bcas);
        if (job.wave == kWaveSatellite) lnb.release_receiver(receiver);
        webts_winscard_unbind();
        job.error.store(static_cast<int>(result));
        job.elapsed_ms.store(elapsed());
        job.stage.store(kStageDone);
        job.state.store(result == Error::OK ? kFinished : kFailed);
        release_session(&session);
    };

    const bool satellite = job.wave == kWaveSatellite;
    lock_context.satellite = satellite;

    job.stage.store(kStageFrontendOpen);
    const auto opened = satellite ? enclosure.open_satellite(receiver)
                                  : enclosure.open_terrestrial(receiver);
    if (!opened) { result = opened.error(); finish(); return nullptr; }
    frontend_open = true;

    job.stage.store(kStageTune);
    if (satellite) {
        // 給電は許可されたときだけ。別の機器が給電している線へ重ねない。
        const auto begun = lnb.begin_tune(
            receiver, static_cast<std::uint8_t>(job.allow_15v ? 15U : 0U));
        if (!begun) { result = begun.error(); finish(); return nullptr; }
    }
    const auto tuned = satellite
        ? enclosure.tune_satellite(receiver, static_cast<std::uint32_t>(job.frequency_khz))
        : enclosure.tune_terrestrial(receiver, static_cast<std::uint32_t>(job.frequency_khz));
    if (!tuned) {
        if (satellite) lnb.rollback_tune(receiver);
        result = tuned.error();
        finish();
        return nullptr;
    }
    if (satellite) {
        lnb.commit_tune(receiver);
        // **中継器の中から TS を選ぶ。**走査で控えた TSID をそのまま指定する。
        // スロット番号ではなく TSID で指すのは、編成が変わるとスロットが
        // 動くためである。
        const auto selected = enclosure.select_satellite_tsid(
            receiver, static_cast<std::uint16_t>(job.tsid));
        if (!selected) { result = selected.error(); finish(); return nullptr; }
    }

    job.stage.store(kStageLock);
    lock_context.started = std::chrono::steady_clock::now();
    const ProbeLockPollResult lock =
        poll_frontend_probe_lock(demod_lock, &lock_context, session.delay);
    if (!lock.locked) { result = lock.error; finish(); return nullptr; }

    attachment.owner_client_id = 1U;
    attachment.lease_id = 1U;
    attachment.attachment_id = session.next_attachment.fetch_add(1U);
    attachment.receiver = receiver;
    attachment.system = satellite ? ipc::System::ISDB_S : ipc::System::ISDB_T;

    job.stage.store(kStageAttach);
    const auto capture = satellite ? enclosure.start_satellite_capture(receiver)
                                   : enclosure.start_terrestrial_capture(receiver);
    if (!capture) { result = capture.error(); finish(); return nullptr; }
    capture_started = true;
    const auto attach = session.plane->attach(attachment);
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
        const auto read = session.plane->read(
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
/** JS が渡せる上限。番組表でも1中継器に何分も留まらせない。 */
constexpr int kScanEntryTimeoutMaxMs = 300000;
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

ScanJob* g_scan = nullptr;
pthread_t g_scan_threads[kMaxScanWorkers]{};
int g_scan_thread_count = 0;

void scan_retain(ScanWorker& worker, const std::uint8_t* data, std::size_t size) noexcept {
    std::lock_guard<std::mutex> guard(worker.mutex);
    if (worker.consumed > 0U && worker.consumed == worker.output.size()) {
        worker.output.clear();
        worker.consumed = 0U;
    }
    worker.output.insert(worker.output.end(), data, data + size);
    if (worker.output.size() - worker.consumed > kScanStreamLimit) {
        // 読み手が遅れている。古いほうから捨てる。走査は止めない。
        const std::size_t keep = kScanStreamLimit / 2U;
        const std::size_t from = worker.output.size() - keep;
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
    Q3U4FrontendEnclosure& enclosure = *session.enclosure;
    Q3U4LnbPowerCoordinator& lnb = *session.lnb;

    const bool satellite = job.wave == kWaveSatellite;
    const auto receiver = static_cast<std::uint8_t>(worker.receiver.load());
    const auto lnb_voltage = static_cast<std::uint8_t>(
        satellite && job.allow_15v ? 15U : 0U);

    Error result = Error::OK;
    bool frontend_open = false;

    const auto opened = satellite ? enclosure.open_satellite(receiver)
                                  : enclosure.open_terrestrial(receiver);
    if (!opened) {
        result = opened.error();
    } else {
        frontend_open = true;
    }

    std::vector<std::uint8_t> buffer(kReadBytes);
    TunerAttachment attachment{};
    attachment.owner_client_id = 1U;
    attachment.lease_id = 1U;
    attachment.receiver = receiver;
    attachment.system = satellite ? ipc::System::ISDB_S : ipc::System::ISDB_T;

    // 直前に合わせた周波数。同じ中継器のあいだは選局し直さない。
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

        if (frequency != tuned_khz) {
            tuned_khz = frequency;
            tuned_locked = false;
            if (satellite) {
                const auto begun = lnb.begin_tune(receiver, lnb_voltage);
                if (!begun) { job.locked[i].store(0); continue; }
            }
            const auto tuned = satellite
                ? enclosure.tune_satellite(receiver, static_cast<std::uint32_t>(frequency))
                : enclosure.tune_terrestrial(receiver, static_cast<std::uint32_t>(frequency));
            if (!tuned) {
                if (satellite) lnb.rollback_tune(receiver);
                job.locked[i].store(0);
                scan_await_acknowledge(job, worker, i);
                continue;
            }
            if (satellite) lnb.commit_tune(receiver);

            LockContext lock_context{&enclosure, receiver,
                                     std::chrono::steady_clock::now(), nullptr, satellite};
            std::atomic<int> discard_elapsed{0};
            lock_context.elapsed_ms = &discard_elapsed;
            const ProbeLockPollResult lock =
                poll_frontend_probe_lock(demod_lock, &lock_context, session.delay);
            tuned_locked = lock.locked;
        }

        if (!tuned_locked) {
            job.locked[i].store(0);
            scan_await_acknowledge(job, worker, i);
            continue;
        }

        if (satellite) {
            const auto selected =
                enclosure.select_satellite_slot(receiver, static_cast<std::uint8_t>(slot));
            if (!selected) {
                job.locked[i].store(0);
                scan_await_acknowledge(job, worker, i);
                continue;
            }
            // **空きスロットでも選択自体は通る。**エンクロージャからは
            // TMCC の TSID を読めないので、ここでは弾けない。中身が無い
            // ことは「データが来ない」ことで分かるので、下の読み出しで
            // 打ち切る。TS 識別子は SDT から取る（放送側の申告が正）。
        }
        job.locked[i].store(1);

        const auto capture = satellite ? enclosure.start_satellite_capture(receiver)
                                       : enclosure.start_terrestrial_capture(receiver);
        if (!capture) { result = capture.error(); break; }
        attachment.attachment_id = session.next_attachment.fetch_add(1U);
        const auto attach = session.plane->attach(attachment);
        if (!attach) {
            if (satellite) enclosure.stop_satellite_capture(receiver);
            else enclosure.stop_terrestrial_capture(receiver);
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
            const auto read = session.plane->read(
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

        session.plane->detach(attachment);
        // 保持されている最終値を返しておく。溜め続けない。
        session.plane->release_final(attachment);
        const auto stopped = satellite ? enclosure.stop_satellite_capture(receiver)
                                       : enclosure.stop_terrestrial_capture(receiver);
        if (!stopped && result == Error::OK) result = stopped.error();
        scan_await_acknowledge(job, worker, i);
    }

    if (frontend_open) {
        if (satellite) lnb.release_receiver(receiver);
        const auto closed = enclosure.close_receiver(receiver);
        if (!closed && result == Error::OK) result = closed.error();
    }
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
    // global 受信機は dev1 が 0..3、dev2 が 4..7。各ブリッジの下2つが
    // ISDB-S、上2つが ISDB-T。
    const bool terrestrial = (receiver >= 2 && receiver < 4) || receiver >= 6;
    const bool matches_wave = wave == kWaveSatellite ? !terrestrial : terrestrial;
    if (firmware == nullptr || firmware_size <= 0 || receiver < 0 || receiver > 7 ||
        !matches_wave || frequency_khz < 0 || duration_ms < 0 || duration_ms > 14400000 ||
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
    if (g_scan != nullptr && g_scan->state.load() == kRunning) {
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
    for (int w = 0; w < receiver_count; ++w) {
        const int receiver = receivers[w];
        if (receiver < 0 || receiver > 7) return static_cast<int>(Error::INVALID_ARGUMENT);
        // global 受信機は dev1 が 0..3、dev2 が 4..7。各ブリッジの下2つが
        // ISDB-S、上2つが ISDB-T。
        const bool terrestrial = (receiver >= 2 && receiver < 4) || receiver >= 6;
        if (satellite ? terrestrial : !terrestrial) {
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

    for (int w = 0; w < g_scan_thread_count; ++w) pthread_join(g_scan_threads[w], nullptr);
    g_scan_thread_count = 0;
    delete g_scan;
    g_scan = new ScanJob();
    g_scan->firmware.assign(firmware, firmware + firmware_size);
    g_scan->allow_15v = allow_15v != 0;
    g_scan->wave = wave;
    g_scan->dwell_ms = dwell_ms > 0 ? dwell_ms : kScanEntryTimeoutMs;
    g_scan->frequencies_khz.assign(frequencies, frequencies + count);
    if (satellite) g_scan->slots.assign(slots, slots + count);
    else g_scan->slots.assign(static_cast<std::size_t>(count), -1);
    g_scan->receivers.assign(receivers, receivers + receiver_count);
    for (int i = 0; i < kMaxScanEntries; ++i) g_scan->locked[i].store(-1);
    for (int w = 0; w < receiver_count; ++w) {
        g_scan->workers[w].receiver.store(receivers[w]);
        g_scan->workers[w].output.reserve(kScanStreamLimit / 4U);
    }
    g_scan->running.store(receiver_count);
    g_scan->state.store(kRunning);

    for (int w = 0; w < receiver_count; ++w) {
        auto* argument = new (std::nothrow) ScanWorkerArgument{g_scan, w};
        if (argument == nullptr ||
            pthread_create(&g_scan_threads[w], nullptr, scan_worker_main, argument) != 0) {
            delete argument;
            // 立てられなかったぶんは数から引く。残りは走り続ける。
            if (g_scan->running.fetch_sub(1) == 1) {
                g_scan->error.store(static_cast<int>(Error::INTERNAL));
                g_scan->state.store(kFailed);
                return static_cast<int>(Error::INTERNAL);
            }
            continue;
        }
        g_scan_threads[g_scan_thread_count] = g_scan_threads[w];
        g_scan_thread_count += 1;
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
int webts_q3u4_scan_poll(std::int32_t* output, int output_words) {
    if (output == nullptr || output_words < 6) return static_cast<int>(Error::INVALID_ARGUMENT);
    if (g_scan == nullptr) { output[0] = kIdle; return 0; }
    const ScanJob& job = *g_scan;
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
int webts_q3u4_scan_drain(int worker, std::uint8_t* output, int capacity) {
    if (g_scan == nullptr || output == nullptr || capacity <= 0) return 0;
    if (worker < 0 || worker >= kMaxScanWorkers) return 0;
    ScanWorker& slot = g_scan->workers[worker];
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
void webts_q3u4_scan_advance(int worker) {
    if (g_scan == nullptr || worker < 0 || worker >= kMaxScanWorkers) return;
    g_scan->workers[worker].advance.store(true);
}

/** その作業者に、この添字を見終えたと伝える。返すまで次へ進まない。 */
void webts_q3u4_scan_acknowledge(int worker, int index) {
    if (g_scan == nullptr || worker < 0 || worker >= kMaxScanWorkers) return;
    g_scan->workers[worker].acknowledged.store(index);
}

void webts_q3u4_scan_stop(void) {
    if (g_scan != nullptr) g_scan->stop_requested.store(true);
}

int webts_q3u4_scan_join(void) {
    for (int w = 0; w < g_scan_thread_count; ++w) pthread_join(g_scan_threads[w], nullptr);
    g_scan_thread_count = 0;
    return g_scan == nullptr ? 0 : g_scan->error.load();
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
