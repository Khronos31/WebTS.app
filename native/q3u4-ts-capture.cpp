// PX-Q3U4 から実際の TS を受信する。
//
// すべて専用 pthread で動く（docs/FINDINGS.md 12章）。上流の
// Q3U4StreamDataPlane が bulk ストリームを回し、tagged TS を受信機ごとに
// 分離してキューへ入れる。ここはそれを read するだけで、demux もストリーム
// 制御も書かない。
//
// 開始/停止の順序は上流 TunerService::attach_stream に従う:
//   start_terrestrial_capture() → attach()  ...  detach() → stop_capture()
// 逆順にすると、まだ誰も読まないキューへ復調器が吐き続ける、あるいは止めた
// あとのポンプが空読みする。
//
// ここは libusb の所有権修正が実際に効く場所でもある。shutdown() は保留中の
// bulk 転送をキャンセルするので、論理 callback が有界に1回だけ届く必要がある
// （docs/FINDINGS.md 1章）。
//
// 受信した TS はここでは保存しない。同期バイトの一致、PID の出現、
// スクランブル制御ビットといった形の集計だけを返す。放送内容は持ち出さない。

#include "frontend_probe_support.h"
#include "q3u4_frontend.h"
#include "px4/firmware.h"
#include "px4/it930x.h"
#include "px4/libusb_transport.h"
#include "px4/q3u4_stream.h"

#include <atomic>
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

constexpr const char* kScratchPath = "/tmp/webts-q3u4-capture-firmware.bin";
constexpr std::size_t kReadBytes = Q3U4StreamDataPlane::kPacketSize * 1024U;
constexpr std::size_t kPidCount = 8192U;

enum CaptureState : int { kIdle = 0, kRunning = 1, kFinished = 2, kFailed = 3 };

enum CaptureStage : int {
    kStageStart = 0,
    kStageImage = 1,
    kStageOpen = 2,
    kStageInit = 3,
    kStageFrontendOpen = 4,
    kStageTune = 5,
    kStageLock = 6,
    kStageDataPlane = 7,
    kStageStartCapture = 8,
    kStageAttach = 9,
    kStageReading = 10,
    kStageCleanup = 11,
    kStageDone = 12,
};

struct Job final {
    std::vector<std::uint8_t> firmware;
    int receiver = 2;
    int frequency_khz = 0;
    int duration_ms = 3000;

    std::atomic<int> state{kIdle};
    std::atomic<int> stage{kStageStart};
    std::atomic<int> error{0};
    std::atomic<int> terminal{0};
    std::atomic<int> elapsed_ms{0};
    // read ループだけの実時間。スループットの分母はこれでなければならない。
    // elapsed_ms には列挙・ファームウェア投入・選局・ロック待ちが含まれる。
    std::atomic<int> reading_ms{0};
    std::atomic<int> tsid{-1};
    std::atomic<int> reads{0};
    std::atomic<int> timeouts{0};
    // 配送されたバイト列を自分で見た結果
    std::atomic<std::uint64_t> bytes{0U};
    std::atomic<std::uint64_t> aligned_packets{0U};
    std::atomic<std::uint64_t> misaligned{0U};
    std::atomic<std::uint64_t> scrambled{0U};
    std::atomic<int> distinct_pids{0};
    // 上流 stats() の値。出どころが違うので突き合わせる意味がある。
    std::atomic<std::uint64_t> up_packets{0U};
    std::atomic<std::uint64_t> up_sync_errors{0U};
    std::atomic<std::uint64_t> up_continuity_errors{0U};
    std::atomic<std::uint64_t> up_queue_drops{0U};
    std::atomic<std::uint64_t> up_usb_errors{0U};
    std::atomic<std::uint64_t> up_tei_packets{0U};
};

Job* g_job = nullptr;
pthread_t g_thread{};
bool g_thread_started = false;

/** 上流のブロッキング待機をそのまま使う。pthread 上なので問題ない。 */
class BlockingDelay final : public Q3U4FrontendDelay {
public:
    void sleep_ms(std::uint32_t milliseconds) noexcept override {
        std::this_thread::sleep_for(std::chrono::milliseconds(milliseconds));
    }
};

Result<bool> demod_lock(void* context) noexcept {
    return static_cast<Q3U4Frontend*>(context)->is_terrestrial_locked();
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

/**
 * 配送された 188 バイト境界を見るだけの検査。payload は一切保持しない。
 * 上流はタグを剥がした整列済み packet を返すので、read の先頭から固定間隔で
 * 数えてよい。ずれがあれば misaligned として数える。
 */
class TsShapeInspector final {
public:
    TsShapeInspector() noexcept { std::memset(seen_, 0, sizeof(seen_)); }

    void feed(const std::uint8_t* data, std::size_t size, Job& job) noexcept {
        for (std::size_t offset = 0U; offset + 188U <= size; offset += 188U) {
            const std::uint8_t* packet = data + offset;
            if (packet[0] != 0x47U) {
                job.misaligned.fetch_add(1U, std::memory_order_relaxed);
                continue;
            }
            job.aligned_packets.fetch_add(1U, std::memory_order_relaxed);
            const std::uint16_t pid =
                static_cast<std::uint16_t>(((packet[1] & 0x1fU) << 8) | packet[2]);
            if ((packet[3] & 0xc0U) != 0U)
                job.scrambled.fetch_add(1U, std::memory_order_relaxed);
            if (!seen_[pid]) {
                seen_[pid] = true;
                job.distinct_pids.fetch_add(1, std::memory_order_relaxed);
            }
        }
    }

private:
    bool seen_[kPidCount];
};

void publish_stats(Job& job, const StreamCounters& counters) noexcept {
    job.up_packets.store(counters.packets);
    job.up_sync_errors.store(counters.sync_errors);
    job.up_continuity_errors.store(counters.continuity_errors);
    job.up_queue_drops.store(counters.queue_drops);
    job.up_usb_errors.store(counters.usb_errors);
    job.up_tei_packets.store(counters.tei_packets);
}

void* worker_main(void* argument) noexcept {
    Job& job = *static_cast<Job*>(argument);
    const auto started = std::chrono::steady_clock::now();
    const auto elapsed = [started]() {
        return static_cast<int>(std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - started).count());
    };
    const auto fail = [&job, &elapsed](CaptureStage stage, Error error) {
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
    CoupledProbePower power(dev1_power, dev2_power);
    It930xBridgeI2cMaster bridge(dev1);
    Q3U4Frontend frontend(bridge, power, delay);

    job.stage.store(kStageInit);
    const auto init1 = dev1.initialize_q3u4(image.value());
    if (!init1) { fail(kStageInit, init1.error()); return nullptr; }
    const auto init2 = dev2.initialize_q3u4(image.value());
    if (!init2) { fail(kStageInit, init2.error()); return nullptr; }

    job.stage.store(kStageFrontendOpen);
    const auto opened = frontend.open_terrestrial(static_cast<std::uint8_t>(job.receiver));
    if (!opened) { fail(kStageFrontendOpen, opened.error()); return nullptr; }

    job.stage.store(kStageTune);
    const auto tuned =
        frontend.tune_terrestrial(static_cast<std::uint32_t>(job.frequency_khz));
    if (!tuned) { fail(kStageTune, tuned.error()); return nullptr; }

    job.stage.store(kStageLock);
    const ProbeLockPollResult lock = poll_frontend_probe_lock(demod_lock, &frontend, delay);
    if (!lock.locked) { fail(kStageLock, lock.error); return nullptr; }
    job.tsid.store(static_cast<int>(frontend.selected_tsid()));

    job.stage.store(kStageDataPlane);
    Result<std::unique_ptr<Q3U4StreamDataPlane>> plane =
        Q3U4StreamDataPlane::create(runtime.value()->dev1(), runtime.value()->dev2());
    if (!plane) { fail(kStageDataPlane, plane.error()); return nullptr; }

    TunerAttachment attachment{};
    attachment.owner_client_id = 1U;
    attachment.lease_id = 1U;
    attachment.attachment_id = 1U;
    attachment.receiver = static_cast<std::uint8_t>(job.receiver);
    attachment.system = ipc::System::ISDB_T;

    // 上流の順序: 復調器の capture を先に開始し、そのあとで attach する。
    job.stage.store(kStageStartCapture);
    const auto capture_started = frontend.start_terrestrial_capture();
    if (!capture_started) {
        plane.value()->shutdown();
        fail(kStageStartCapture, capture_started.error());
        return nullptr;
    }

    job.stage.store(kStageAttach);
    const auto attached = plane.value()->attach(attachment);
    if (!attached) {
        frontend.stop_terrestrial_capture();
        plane.value()->shutdown();
        fail(kStageAttach, attached.error());
        return nullptr;
    }

    job.stage.store(kStageReading);
    TsShapeInspector inspector;
    std::vector<std::uint8_t> buffer(kReadBytes);
    Error capture_error = Error::OK;
    const auto reading_started = std::chrono::steady_clock::now();
    const auto reading_elapsed = [reading_started]() {
        return static_cast<int>(std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - reading_started).count());
    };
    const auto deadline = reading_started + std::chrono::milliseconds(job.duration_ms);
    while (std::chrono::steady_clock::now() < deadline) {
        const auto read = plane.value()->read(
            attachment, MutableByteView{buffer.data(), buffer.size()}, Timeout{500U});
        job.reads.fetch_add(1);
        if (!read) { capture_error = read.error(); break; }
        const TunerStreamReadResult& result = read.value();
        if (result.bytes > 0U) {
            job.bytes.fetch_add(result.bytes);
            inspector.feed(buffer.data(), result.bytes, job);
        }
        if (result.timed_out) job.timeouts.fetch_add(1);
        if (const auto stats = plane.value()->stats(attachment); stats)
            publish_stats(job, stats.value());
        job.elapsed_ms.store(elapsed());
        job.reading_ms.store(reading_elapsed());
        if (result.terminal != TunerStreamTerminal::none) {
            job.terminal.store(static_cast<int>(result.terminal));
            break;
        }
        if (result.eof) break;
    }

    job.reading_ms.store(reading_elapsed());
    job.stage.store(kStageCleanup);
    if (const auto stats = plane.value()->stats(attachment); stats)
        publish_stats(job, stats.value());
    // 上流の順序: detach してから capture を止める。
    const auto detached = plane.value()->detach(attachment);
    if (!detached && capture_error == Error::OK) capture_error = detached.error();
    const auto capture_stopped = frontend.stop_terrestrial_capture();
    if (!capture_stopped && capture_error == Error::OK) capture_error = capture_stopped.error();
    // 保留中の bulk 転送のキャンセルを伴う停止。所有権修正が効く場所。
    const auto shutdown = plane.value()->shutdown();
    if (!shutdown && capture_error == Error::OK) capture_error = shutdown.error();
    plane.value().reset();
    if (frontend.open_state()) {
        const auto closed = frontend.close();
        if (!closed && capture_error == Error::OK) capture_error = closed.error();
    }
    const auto powered_off = power.set_backend_power(false, delay);
    if (!powered_off && capture_error == Error::OK) capture_error = powered_off.error();

    job.error.store(static_cast<int>(capture_error));
    job.elapsed_ms.store(elapsed());
    job.stage.store(kStageDone);
    job.state.store(capture_error == Error::OK ? kFinished : kFailed);
    return nullptr;
}

}  // namespace

extern "C" {

/** ドライバ作業を pthread で開始し、即座に戻る。この関数は USB に触れない。 */
int webts_q3u4_capture_start(const std::uint8_t* firmware, int firmware_size, int receiver,
                             int frequency_khz, int duration_ms) {
    if (g_job != nullptr && g_job->state.load() == kRunning) return static_cast<int>(Error::BUSY);
    if (firmware == nullptr || firmware_size <= 0 || receiver < 2 || receiver > 3 ||
        frequency_khz <= 0 || duration_ms <= 0 || duration_ms > 120000) {
        return static_cast<int>(Error::INVALID_ARGUMENT);
    }
    if (g_thread_started) { pthread_join(g_thread, nullptr); g_thread_started = false; }
    delete g_job;
    g_job = new Job();
    g_job->firmware.assign(firmware, firmware + firmware_size);
    g_job->receiver = receiver;
    g_job->frequency_khz = frequency_khz;
    g_job->duration_ms = duration_ms;
    g_job->state.store(kRunning);
    if (pthread_create(&g_thread, nullptr, worker_main, g_job) != 0) {
        g_job->state.store(kFailed);
        g_job->error.store(static_cast<int>(Error::INTERNAL));
        return static_cast<int>(Error::INTERNAL);
    }
    g_thread_started = true;
    return 0;
}

/** 進捗と集計を読む。main thread から呼ぶ。ブロックしない。output は 21 語。 */
int webts_q3u4_capture_poll(std::int32_t* output, int output_words) {
    if (output == nullptr || output_words < 21) return static_cast<int>(Error::INVALID_ARGUMENT);
    if (g_job == nullptr) { output[0] = kIdle; return 0; }
    const Job& job = *g_job;
    const std::uint64_t bytes = job.bytes.load();
    output[0] = job.state.load();
    output[1] = job.stage.load();
    output[2] = job.error.load();
    output[3] = job.terminal.load();
    output[4] = job.elapsed_ms.load();
    output[5] = static_cast<std::int32_t>(bytes & 0xffffffffU);
    output[6] = static_cast<std::int32_t>(bytes >> 32);
    output[7] = static_cast<std::int32_t>(job.aligned_packets.load());
    output[8] = static_cast<std::int32_t>(job.misaligned.load());
    output[9] = static_cast<std::int32_t>(job.scrambled.load());
    output[10] = job.distinct_pids.load();
    output[11] = job.reads.load();
    output[12] = job.timeouts.load();
    output[13] = job.tsid.load();
    output[14] = static_cast<std::int32_t>(job.up_packets.load());
    output[15] = static_cast<std::int32_t>(job.up_sync_errors.load());
    output[16] = static_cast<std::int32_t>(job.up_continuity_errors.load());
    output[17] = static_cast<std::int32_t>(job.up_queue_drops.load());
    output[18] = static_cast<std::int32_t>(job.up_usb_errors.load());
    output[19] = static_cast<std::int32_t>(job.up_tei_packets.load());
    output[20] = job.reading_ms.load();
    return 0;
}

/** 上流の診断文字列をそのまま返す。列挙値を TS 側へ書き写さないため。 */
const char* webts_q3u4_capture_error_name(int error) {
    if (error < 0 || error > 0xff) return "unknown";
    return error_string(static_cast<Error>(error));
}

/** 終了したスレッドを回収する。実行中は BUSY。 */
int webts_q3u4_capture_join(void) {
    if (g_job == nullptr) return 0;
    if (g_job->state.load() == kRunning) return static_cast<int>(Error::BUSY);
    if (g_thread_started) { pthread_join(g_thread, nullptr); g_thread_started = false; }
    return 0;
}

}  // extern "C"
