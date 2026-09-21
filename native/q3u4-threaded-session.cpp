// PX-Q3U4 のドライバスタックを専用 pthread で動かす。
//
// これまでは main runtime thread で Asyncify を使っていた。上流はブロッキング
// 前提（sleep_for、300回のポーリングループ）で書かれているため、呼び出しごとに
// 深いスタックを巻き戻して復元することになり、無信号チャンネルの選局1回で
// イベントループが通常の1/10まで落ちた（docs/FINDINGS.md 12章）。
//
// 非メインスレッドでは事情が変わる。libusb の events_posix.c は
// emscripten_atomic_wait_u32 による同期待ちを使い、WebUSB backend は
// proxySync でメインスレッドへ委譲して呼び出し側スレッドをブロックする。
// つまり上流のコードがそのまま自然に動き、Asyncify は要らない。
//
// したがって:
//   - JS から呼ぶ関数は pthread を起こして即座に戻る。USB には触れない。
//   - ドライバ作業はすべてその pthread で行う。
//   - main runtime thread は proxy キューと WebUSB の処理に専念する。塞がない。
//   - 進捗と結果は atomic 経由で読む。

#include "frontend_probe_support.h"
#include "q3u4_frontend.h"
#include "px4/firmware.h"
#include "px4/it930x.h"
#include "px4/libusb_transport.h"

#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <pthread.h>
#include <thread>
#include <vector>

namespace {

using namespace px4::userland;

constexpr const char* kScratchPath = "/tmp/webts-q3u4-threaded-firmware.bin";
constexpr int kMaxChannels = 64;

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

enum ScanState : int {
    kIdle = 0,
    kRunning = 1,
    kFinished = 2,
    kFailed = 3,
};

struct Job final {
    // 入力
    std::vector<std::uint8_t> firmware;
    int receiver = 2;
    std::vector<int> frequencies_khz;

    // 出力（main thread から atomic で読む）
    std::atomic<int> state{kIdle};
    std::atomic<int> error{0};
    std::atomic<int> stage{0};
    std::atomic<int> completed{0};
    std::atomic<int> elapsed_ms{0};
    std::atomic<std::uint32_t> dev1_version{0U};
    std::atomic<std::uint32_t> dev2_version{0U};
    // 各チャンネルの結果。書き込みは worker のみ、読みは main のみ。
    std::atomic<int> locked[kMaxChannels];
    std::atomic<int> lock_ms[kMaxChannels];
    std::atomic<int> channel_error[kMaxChannels];
};

Job* g_job = nullptr;
pthread_t g_thread{};
bool g_thread_started = false;

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

enum Stage : int {
    kStageStart = 0,
    kStageImage = 1,
    kStageOpen = 2,
    kStageInit = 3,
    kStageFrontendOpen = 4,
    kStageTuning = 5,
    kStageCleanup = 6,
    kStageDone = 7,
};

void* worker_main(void* argument) noexcept {
    Job& job = *static_cast<Job*>(argument);
    const auto started = std::chrono::steady_clock::now();
    const auto mark_elapsed = [&job, started]() {
        job.elapsed_ms.store(static_cast<int>(
            std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - started).count()));
    };
    const auto fail = [&job, &mark_elapsed](Stage stage, Error error) {
        job.stage.store(stage);
        job.error.store(static_cast<int>(error));
        mark_elapsed();
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
    job.dev1_version.store(init1.value().firmware_version);
    const auto init2 = dev2.initialize_q3u4(image.value());
    if (!init2) { fail(kStageInit, init2.error()); return nullptr; }
    job.dev2_version.store(init2.value().firmware_version);

    job.stage.store(kStageFrontendOpen);
    const auto opened = frontend.open_terrestrial(static_cast<std::uint8_t>(job.receiver));
    if (!opened) { fail(kStageFrontendOpen, opened.error()); return nullptr; }

    job.stage.store(kStageTuning);
    for (std::size_t index = 0U; index < job.frequencies_khz.size(); ++index) {
        const auto tuned =
            frontend.tune_terrestrial(static_cast<std::uint32_t>(job.frequencies_khz[index]));
        if (!tuned) {
            job.channel_error[index].store(static_cast<int>(tuned.error()));
            job.locked[index].store(0);
        } else {
            const ProbeLockPollResult lock =
                poll_frontend_probe_lock(demod_lock, &frontend, delay);
            job.locked[index].store(lock.locked ? 1 : 0);
            job.lock_ms[index].store(static_cast<int>(lock.elapsed_ms));
            job.channel_error[index].store(
                static_cast<int>(lock.locked ? Error::OK : lock.error));
        }
        job.completed.store(static_cast<int>(index + 1U));
        mark_elapsed();
    }

    job.stage.store(kStageCleanup);
    Error cleanup = Error::OK;
    if (frontend.open_state()) {
        const auto closed = frontend.close();
        if (!closed) cleanup = closed.error();
    }
    const auto powered_off = power.set_backend_power(false, delay);
    if (!powered_off && cleanup == Error::OK) cleanup = powered_off.error();

    job.error.store(static_cast<int>(cleanup));
    job.stage.store(kStageDone);
    mark_elapsed();
    job.state.store(kFinished);
    return nullptr;
}

}  // namespace

extern "C" {

/**
 * ドライバ作業を pthread で開始し、即座に戻る。この関数は USB に触れない。
 * frequencies は kHz の配列。戻り値 0 で開始、それ以外は Error の数値。
 */
int webts_q3u4_scan_start(const std::uint8_t* firmware, int firmware_size, int receiver,
                          const std::int32_t* frequencies, int frequency_count) {
    if (g_job != nullptr && g_job->state.load() == kRunning) {
        return static_cast<int>(Error::BUSY);
    }
    if (firmware == nullptr || firmware_size <= 0 || receiver < 2 || receiver > 3 ||
        frequencies == nullptr || frequency_count <= 0 || frequency_count > kMaxChannels) {
        return static_cast<int>(Error::INVALID_ARGUMENT);
    }
    if (g_thread_started) {
        pthread_join(g_thread, nullptr);
        g_thread_started = false;
    }
    delete g_job;
    g_job = new Job();
    g_job->firmware.assign(firmware, firmware + firmware_size);
    g_job->receiver = receiver;
    g_job->frequencies_khz.assign(frequencies, frequencies + frequency_count);
    for (int i = 0; i < kMaxChannels; ++i) {
        g_job->locked[i].store(-1);
        g_job->lock_ms[i].store(-1);
        g_job->channel_error[i].store(-1);
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

/** 進捗を読む。main thread から呼ぶ。ブロックしない。 */
int webts_q3u4_scan_poll(std::int32_t* output, int output_words) {
    if (output == nullptr || output_words < 7) return static_cast<int>(Error::INVALID_ARGUMENT);
    if (g_job == nullptr) { output[0] = kIdle; return 0; }
    output[0] = g_job->state.load();
    output[1] = g_job->stage.load();
    output[2] = g_job->error.load();
    output[3] = g_job->completed.load();
    output[4] = g_job->elapsed_ms.load();
    output[5] = static_cast<std::int32_t>(g_job->dev1_version.load());
    output[6] = static_cast<std::int32_t>(g_job->dev2_version.load());
    const int channels = output_words - 7;
    for (int i = 0; i < channels && i < kMaxChannels; ++i) {
        output[7 + i] = g_job->locked[i].load();
    }
    return 0;
}

/** 終了したスレッドを回収する。実行中は BUSY。 */
int webts_q3u4_scan_join(void) {
    if (g_job == nullptr) return 0;
    if (g_job->state.load() == kRunning) return static_cast<int>(Error::BUSY);
    if (g_thread_started) {
        pthread_join(g_thread, nullptr);
        g_thread_started = false;
    }
    return 0;
}

}  // extern "C"
