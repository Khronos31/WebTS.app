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
// 復号した TS は、利用者が明示的に求めたときだけ、利用者自身の端末へ
// 渡すために保持する。これは利用者が自分の受信機で受信した自分の放送を
// 自分で見るための経路であり、どこへも送信しない。既定では保持しない。
// 鍵とカード情報はどちらの場合も持ち出さない。

#include "frontend_probe_support.h"
#include "q3u4_card_backend.h"
#include "q3u4_frontend.h"
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
#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <pthread.h>
#include <thread>
#include <vector>

namespace {

using namespace px4::userland;

constexpr const char* kScratchPath = "/tmp/webts-q3u4-descramble-firmware.bin";
constexpr std::size_t kReadBytes = Q3U4StreamDataPlane::kPacketSize * 1024U;

enum ProbeState : int { kIdle = 0, kRunning = 1, kFinished = 2, kFailed = 3 };

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
    int frequency_khz = 0;
    int duration_ms = 5000;
    // 復号済み TS を手元へ渡すために溜めるかどうか。既定は溜めない。
    bool collect = false;

    std::atomic<int> state{kIdle};
    std::atomic<int> stage{kStageStart};
    std::atomic<int> error{0};
    std::atomic<int> b25_error{0};
    std::atomic<int> elapsed_ms{0};
    std::atomic<int> reading_ms{0};
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

    // worker だけが書き、state が実行中でなくなってから main が読む。
    std::vector<std::uint8_t> output;
    std::atomic<std::uint64_t> output_bytes{0U};
};

Job* g_job = nullptr;
pthread_t g_thread{};
bool g_thread_started = false;

class BlockingDelay final : public Q3U4FrontendDelay {
public:
    void sleep_ms(std::uint32_t milliseconds) noexcept override {
        std::this_thread::sleep_for(std::chrono::milliseconds(milliseconds));
    }
};

struct LockContext final {
    Q3U4FrontendEnclosure* enclosure;
    std::uint8_t receiver;
};

Result<bool> demod_lock(void* context) noexcept {
    auto* lock = static_cast<LockContext*>(context);
    return lock->enclosure->is_terrestrial_locked(lock->receiver);
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

    job.stage.store(kStageImage);
    const Result<FirmwareImage> image = stage_image(job.firmware);
    if (!image) { fail(kStageImage, image.error()); return nullptr; }

    job.stage.store(kStageOpen);
    Result<std::unique_ptr<Q3U4Runtime>> runtime = Q3U4Runtime::open_native();
    if (!runtime) { fail(kStageOpen, runtime.error()); return nullptr; }

    BlockingDelay delay;
    It930xController dev1(runtime.value()->dev1(),
                          CommandPacingOptions{CommandPacingMode::no_delay});
    It930xController dev2(runtime.value()->dev2(),
                          CommandPacingOptions{CommandPacingMode::no_delay});
    It930xBackendPower dev1_power(dev1);
    It930xBackendPower dev2_power(dev2);
    It930xBridgeI2cMaster bridge1(dev1);
    It930xBridgeI2cMaster bridge2(dev2);
    Q3U4FrontendEnclosure enclosure(bridge1, bridge2, dev1_power, dev2_power, delay);

    job.stage.store(kStageInit);
    const auto init1 = dev1.initialize_q3u4(image.value());
    if (!init1) { fail(kStageInit, init1.error()); return nullptr; }
    const auto init2 = dev2.initialize_q3u4(image.value());
    if (!init2) { fail(kStageInit, init2.error()); return nullptr; }

    Q3U4CardBackend card_backend(dev1, enclosure);
    It930xCardHardware hardware(dev1);
    SystemCardTime time;
    CardSession card(hardware, time);
    NativeCardProtocolSession protocol(card);
    CardService service(card_backend, protocol);

    job.stage.store(kStageCard);
    webts_winscard_bind(&service, 1U);
    B_CAS_CARD* bcas = create_b_cas_card();
    if (bcas == nullptr) {
        webts_winscard_unbind();
        fail(kStageCard, Error::INTERNAL);
        return nullptr;
    }
    const int card_initialized = bcas->init(bcas);
    if (card_initialized != 0) {
        job.b25_error.store(card_initialized);
        bcas->release(bcas);
        webts_winscard_unbind();
        service.shutdown();
        fail(kStageCard, Error::PROTOCOL_ERROR);
        return nullptr;
    }

    job.stage.store(kStageB25);
    ARIB_STD_B25* b25 = create_arib_std_b25();
    if (b25 == nullptr) {
        bcas->release(bcas);
        webts_winscard_unbind();
        service.shutdown();
        fail(kStageB25, Error::INTERNAL);
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
        service.shutdown();
        fail(kStageB25, Error::INTERNAL);
        return nullptr;
    }

    const auto receiver = static_cast<std::uint8_t>(job.receiver);
    LockContext lock_context{&enclosure, receiver};
    Error result = Error::OK;
    bool frontend_open = false;
    bool capture_started = false;
    std::unique_ptr<Q3U4StreamDataPlane> plane;
    TunerAttachment attachment{};
    bool attached = false;

    const auto finish = [&]() {
        job.stage.store(kStageCleanup);
        if (plane && attached) {
            const auto detached = plane->detach(attachment);
            if (!detached && result == Error::OK) result = detached.error();
        }
        if (capture_started) {
            const auto stopped = enclosure.stop_terrestrial_capture(receiver);
            if (!stopped && result == Error::OK) result = stopped.error();
        }
        if (plane) {
            // 保留中の bulk 転送のキャンセルを伴う停止。
            const auto shutdown = plane->shutdown();
            if (!shutdown && result == Error::OK) result = shutdown.error();
            plane.reset();
        }
        if (frontend_open) {
            const auto closed = enclosure.close_receiver(receiver);
            if (!closed && result == Error::OK) result = closed.error();
        }
        b25->release(b25);
        bcas->release(bcas);
        webts_winscard_unbind();
        const auto card_down = service.shutdown();
        if (!card_down && result == Error::OK) result = card_down.error();
        job.error.store(static_cast<int>(result));
        job.elapsed_ms.store(elapsed());
        job.stage.store(kStageDone);
        job.state.store(result == Error::OK ? kFinished : kFailed);
    };

    job.stage.store(kStageFrontendOpen);
    const auto opened = enclosure.open_terrestrial(receiver);
    if (!opened) { result = opened.error(); finish(); return nullptr; }
    frontend_open = true;

    job.stage.store(kStageTune);
    const auto tuned = enclosure.tune_terrestrial(
        receiver, static_cast<std::uint32_t>(job.frequency_khz));
    if (!tuned) { result = tuned.error(); finish(); return nullptr; }

    job.stage.store(kStageLock);
    const ProbeLockPollResult lock =
        poll_frontend_probe_lock(demod_lock, &lock_context, delay);
    if (!lock.locked) { result = lock.error; finish(); return nullptr; }

    job.stage.store(kStageDataPlane);
    Result<std::unique_ptr<Q3U4StreamDataPlane>> created =
        Q3U4StreamDataPlane::create(runtime.value()->dev1(), runtime.value()->dev2());
    if (!created) { result = created.error(); finish(); return nullptr; }
    plane = std::move(created.value());

    attachment.owner_client_id = 1U;
    attachment.lease_id = 1U;
    attachment.attachment_id = 1U;
    attachment.receiver = receiver;
    attachment.system = ipc::System::ISDB_T;

    job.stage.store(kStageAttach);
    const auto capture = enclosure.start_terrestrial_capture(receiver);
    if (!capture) { result = capture.error(); finish(); return nullptr; }
    capture_started = true;
    const auto attach = plane->attach(attachment);
    if (!attach) { result = attach.error(); finish(); return nullptr; }
    attached = true;

    job.stage.store(kStageReading);
    std::vector<std::uint8_t> buffer(kReadBytes);
    const auto reading_started = std::chrono::steady_clock::now();
    const auto reading_elapsed = [reading_started]() {
        return static_cast<int>(std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - reading_started).count());
    };
    const auto deadline = reading_started + std::chrono::milliseconds(job.duration_ms);
    while (std::chrono::steady_clock::now() < deadline) {
        const auto read = plane->read(
            attachment, MutableByteView{buffer.data(), buffer.size()}, Timeout{500U});
        if (!read) { result = read.error(); break; }
        const TunerStreamReadResult& chunk = read.value();
        if (chunk.bytes > 0U) {
            count_packets(buffer.data(), chunk.bytes, job.in_packets, job.in_scrambled,
                          nullptr);
            ARIB_STD_B25_BUFFER input{buffer.data(), static_cast<std::int32_t>(chunk.bytes)};
            const int put = b25->put(b25, &input);
            if (put != 0) { job.b25_error.store(put); result = Error::PROTOCOL_ERROR; break; }
            ARIB_STD_B25_BUFFER output{nullptr, 0};
            const int got = b25->get(b25, &output);
            if (got != 0) { job.b25_error.store(got); result = Error::PROTOCOL_ERROR; break; }
            if (output.data != nullptr && output.size > 0) {
                count_packets(output.data, static_cast<std::size_t>(output.size),
                              job.out_packets, job.out_scrambled, &job.out_bad_sync);
                if (job.collect) {
                    job.output.insert(job.output.end(), output.data,
                                      output.data + output.size);
                    job.output_bytes.store(job.output.size());
                }
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
                if (job.collect) {
                    job.output.insert(job.output.end(), output.data,
                                      output.data + output.size);
                    job.output_bytes.store(job.output.size());
                }
            }
        }
        publish_program_info(job, b25);
    }

    finish();
    return nullptr;
}

}  // namespace

extern "C" {

/** 選局・受信・復号を pthread で行う。即座に戻る。この関数は USB に触れない。 */
int webts_q3u4_descramble_start(const std::uint8_t* firmware, int firmware_size,
                                int receiver, int frequency_khz, int duration_ms,
                                int collect) {
    if (g_job != nullptr && g_job->state.load() == kRunning) return static_cast<int>(Error::BUSY);
    // 地上波の global 受信機は 2, 3（dev1）と 6, 7（dev2）。
    const bool terrestrial = (receiver >= 2 && receiver < 4) || receiver >= 6;
    if (firmware == nullptr || firmware_size <= 0 || receiver < 0 || receiver > 7 ||
        !terrestrial || frequency_khz <= 0 || duration_ms <= 0 || duration_ms > 120000) {
        return static_cast<int>(Error::INVALID_ARGUMENT);
    }
    if (g_thread_started) { pthread_join(g_thread, nullptr); g_thread_started = false; }
    delete g_job;
    g_job = new Job();
    g_job->firmware.assign(firmware, firmware + firmware_size);
    g_job->receiver = receiver;
    g_job->frequency_khz = frequency_khz;
    g_job->duration_ms = duration_ms;
    g_job->collect = collect != 0;
    if (g_job->collect) {
        // 15 Mbps 前後なので、あらかじめそのぶん確保して再確保を避ける。
        g_job->output.reserve(static_cast<std::size_t>(duration_ms) * 2048U);
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

/** 進捗と集計を読む。ブロックしない。output は 16 語。 */
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
    return 0;
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

const char* webts_q3u4_descramble_error_name(int error) {
    if (error < 0 || error > 0xff) return "unknown";
    return error_string(static_cast<Error>(error));
}

int webts_q3u4_descramble_join(void) {
    if (g_job == nullptr) return 0;
    if (g_job->state.load() == kRunning) return static_cast<int>(Error::BUSY);
    if (g_thread_started) { pthread_join(g_thread, nullptr); g_thread_started = false; }
    return 0;
}

}  // extern "C"
