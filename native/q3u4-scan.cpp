// チャンネルスキャン。物理チャンネルを順に選局し、そのたびに TS を少しだけ
// 流して JS に SDT/NIT を読ませる。
//
// **セッションは開いたまま巡回する。**選局のたびに Q3U4Runtime を作り直して
// backend power を落とす形を走査ループで連打した結果、実機の片方の USB デバイスが
// 列挙から消えたことがある（docs/FINDINGS.md 12章）。open と初期化は1回だけ行い、
// 以後は選局と capture の開始・停止だけを繰り返す。
//
// **カードも B25 も使わない。**SDT と NIT はスクランブルされていないので、
// スキャンに復号は要らない。使わない経路を持ち込むぶんだけ失敗の種が減る。
//
// 進み方は JS が決める。1チャンネルぶんの TS を流したら、JS が
// 「もう十分」と言うまで待つ。必要な section が揃った時点で次へ行けるので、
// 固定時間を待つより速く、取りこぼしも少ない。
//
// 流した TS はここでは保存しない。JS へ渡したぶんは捨てる。

#include "frontend_probe_support.h"
#include "q3u4_frontend.h"
#include "px4/firmware.h"
#include "px4/it930x.h"
#include "px4/libusb_transport.h"
#include "px4/q3u4_stream.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <mutex>
#include <pthread.h>
#include <thread>
#include <vector>

namespace {

using namespace px4::userland;

constexpr const char* kScratchPath = "/tmp/webts-q3u4-scan-firmware.bin";
constexpr std::size_t kReadBytes = Q3U4StreamDataPlane::kPacketSize * 1024U;
constexpr int kMaxChannels = 64;
/** 1チャンネルあたりの上限。これを過ぎたら諦めて次へ行く。 */
constexpr int kChannelTimeoutMs = 8000;
/** 読み手が遅れたときの上限。超えたら古いほうから捨てる。 */
constexpr std::size_t kStreamLimit = 8U * 1024U * 1024U;

enum ScanState : int { kIdle = 0, kRunning = 1, kFinished = 2, kFailed = 3 };

enum ScanStage : int {
    kStageStart = 0,
    kStageImage = 1,
    kStageOpen = 2,
    kStageInit = 3,
    kStageFrontendOpen = 4,
    kStageTune = 5,
    kStageLock = 6,
    kStageDataPlane = 7,
    kStageReading = 8,
    kStageCleanup = 9,
    kStageDone = 10,
};

struct Job final {
    std::vector<std::uint8_t> firmware;
    int receiver = 2;
    std::vector<int> frequencies_khz;

    std::atomic<int> state{kIdle};
    std::atomic<int> stage{kStageStart};
    std::atomic<int> error{0};
    std::atomic<int> index{0};
    std::atomic<int> elapsed_ms{0};
    std::atomic<bool> stop_requested{false};
    /** JS が「このチャンネルはもう十分」と言ったら立つ。 */
    std::atomic<bool> advance{false};
    /** 各チャンネルのロック結果。-1 未処理、0 ロックせず、1 ロック。 */
    std::atomic<int> locked[kMaxChannels];

    std::mutex mutex;
    std::vector<std::uint8_t> output;
    std::size_t consumed = 0U;
    std::atomic<std::uint64_t> pending{0U};
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

void retain(Job& job, const std::uint8_t* data, std::size_t size) noexcept {
    if (size == 0U) return;
    std::lock_guard<std::mutex> lock(job.mutex);
    job.output.insert(job.output.end(), data, data + size);
    const std::size_t waiting = job.output.size() - job.consumed;
    if (waiting > kStreamLimit) {
        job.consumed += waiting - kStreamLimit;
    }
    if (job.consumed > 0U && job.consumed >= job.output.size() / 2U) {
        job.output.erase(job.output.begin(),
                         job.output.begin() + static_cast<std::ptrdiff_t>(job.consumed));
        job.consumed = 0U;
    }
    job.pending.store(job.output.size() - job.consumed);
}

/** 前のチャンネルのぶんを残したまま次へ行かない。取り違えの元になる。 */
void discard(Job& job) noexcept {
    std::lock_guard<std::mutex> lock(job.mutex);
    job.output.clear();
    job.consumed = 0U;
    job.pending.store(0U);
}

void* worker_main(void* argument) noexcept {
    Job& job = *static_cast<Job*>(argument);
    const auto started = std::chrono::steady_clock::now();
    const auto elapsed = [started]() {
        return static_cast<int>(std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - started).count());
    };
    const auto fail = [&job, &elapsed](ScanStage stage, Error error) {
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

    job.stage.store(kStageDataPlane);
    Result<std::unique_ptr<Q3U4StreamDataPlane>> created =
        Q3U4StreamDataPlane::create(runtime.value()->dev1(), runtime.value()->dev2());
    if (!created) { fail(kStageDataPlane, created.error()); return nullptr; }
    std::unique_ptr<Q3U4StreamDataPlane> plane = std::move(created.value());

    // attachment_id は attach のたびに新しくする。上流は detach したあとも
    // 直前の識別子ぶんの最終値を保持しており、同じ id で attach し直すと
    // BUSY を返す（上流 TunerService も毎回新しい id を採番している）。
    TunerAttachment attachment{};
    attachment.owner_client_id = 1U;
    attachment.lease_id = 1U;
    attachment.receiver = static_cast<std::uint8_t>(job.receiver);
    attachment.system = ipc::System::ISDB_T;
    std::uint64_t next_attachment_id = 1U;

    Error result = Error::OK;
    std::vector<std::uint8_t> buffer(kReadBytes);

    for (std::size_t i = 0U; i < job.frequencies_khz.size(); ++i) {
        if (job.stop_requested.load()) break;
        job.index.store(static_cast<int>(i));
        job.advance.store(false);
        discard(job);

        job.stage.store(kStageTune);
        const auto tuned =
            frontend.tune_terrestrial(static_cast<std::uint32_t>(job.frequencies_khz[i]));
        if (!tuned) { job.locked[i].store(0); continue; }

        job.stage.store(kStageLock);
        const ProbeLockPollResult lock = poll_frontend_probe_lock(demod_lock, &frontend, delay);
        job.locked[i].store(lock.locked ? 1 : 0);
        job.elapsed_ms.store(elapsed());
        if (!lock.locked) continue;

        const auto capture = frontend.start_terrestrial_capture();
        if (!capture) { result = capture.error(); break; }
        attachment.attachment_id = next_attachment_id;
        next_attachment_id += 1U;
        const auto attach = plane->attach(attachment);
        if (!attach) { frontend.stop_terrestrial_capture(); result = attach.error(); break; }

        job.stage.store(kStageReading);
        const auto deadline =
            std::chrono::steady_clock::now() + std::chrono::milliseconds(kChannelTimeoutMs);
        while (!job.advance.load() && !job.stop_requested.load()
               && std::chrono::steady_clock::now() < deadline) {
            const auto read = plane->read(
                attachment, MutableByteView{buffer.data(), buffer.size()}, Timeout{500U});
            if (!read) break;
            if (read.value().bytes > 0U) retain(job, buffer.data(), read.value().bytes);
            if (read.value().terminal != TunerStreamTerminal::none || read.value().eof) break;
            job.elapsed_ms.store(elapsed());
        }

        plane->detach(attachment);
        // 保持されている最終値を返しておく。溜め続けない。
        plane->release_final(attachment);
        const auto stopped = frontend.stop_terrestrial_capture();
        if (!stopped && result == Error::OK) result = stopped.error();
    }

    job.stage.store(kStageCleanup);
    const auto shutdown = plane->shutdown();
    if (!shutdown && result == Error::OK) result = shutdown.error();
    plane.reset();
    if (frontend.open_state()) {
        const auto closed = frontend.close();
        if (!closed && result == Error::OK) result = closed.error();
    }
    const auto powered_off = power.set_backend_power(false, delay);
    if (!powered_off && result == Error::OK) result = powered_off.error();

    job.error.store(static_cast<int>(result));
    job.elapsed_ms.store(elapsed());
    job.stage.store(kStageDone);
    job.state.store(result == Error::OK ? kFinished : kFailed);
    return nullptr;
}

}  // namespace

extern "C" {

/** 走査を pthread で開始し、即座に戻る。この関数は USB に触れない。 */
int webts_q3u4_scan_start(const std::uint8_t* firmware, int firmware_size, int receiver,
                          const std::int32_t* frequencies, int frequency_count) {
    if (g_job != nullptr && g_job->state.load() == kRunning) return static_cast<int>(Error::BUSY);
    if (firmware == nullptr || firmware_size <= 0 || receiver < 2 || receiver > 3 ||
        frequencies == nullptr || frequency_count <= 0 || frequency_count > kMaxChannels) {
        return static_cast<int>(Error::INVALID_ARGUMENT);
    }
    if (g_thread_started) { pthread_join(g_thread, nullptr); g_thread_started = false; }
    delete g_job;
    g_job = new Job();
    g_job->firmware.assign(firmware, firmware + firmware_size);
    g_job->receiver = receiver;
    g_job->frequencies_khz.assign(frequencies, frequencies + frequency_count);
    g_job->output.reserve(kStreamLimit);
    for (int i = 0; i < kMaxChannels; ++i) g_job->locked[i].store(-1);
    g_job->state.store(kRunning);
    if (pthread_create(&g_thread, nullptr, worker_main, g_job) != 0) {
        g_job->state.store(kFailed);
        g_job->error.store(static_cast<int>(Error::INTERNAL));
        return static_cast<int>(Error::INTERNAL);
    }
    g_thread_started = true;
    return 0;
}

/** いまのチャンネルの TS を取り出す。戻り値は写したバイト数。 */
int webts_q3u4_scan_drain(std::uint8_t* output, int capacity) {
    if (g_job == nullptr || output == nullptr || capacity <= 0) return 0;
    Job& job = *g_job;
    std::lock_guard<std::mutex> lock(job.mutex);
    const std::size_t waiting = job.output.size() - job.consumed;
    const std::size_t take = std::min(waiting, static_cast<std::size_t>(capacity));
    if (take == 0U) return 0;
    std::memcpy(output, job.output.data() + job.consumed, take);
    job.consumed += take;
    if (job.consumed >= job.output.size()) {
        job.output.clear();
        job.consumed = 0U;
    }
    job.pending.store(job.output.size() - job.consumed);
    return static_cast<int>(take);
}

/** このチャンネルはもう十分。次へ進ませる。 */
void webts_q3u4_scan_advance(void) {
    if (g_job != nullptr) g_job->advance.store(true);
}

void webts_q3u4_scan_stop(void) {
    if (g_job != nullptr) {
        g_job->stop_requested.store(true);
        g_job->advance.store(true);
    }
}

/** 進捗を読む。ブロックしない。output は 6 語 + チャンネル数。 */
int webts_q3u4_scan_poll(std::int32_t* output, int output_words) {
    if (output == nullptr || output_words < 6) return static_cast<int>(Error::INVALID_ARGUMENT);
    if (g_job == nullptr) { output[0] = kIdle; return 0; }
    output[0] = g_job->state.load();
    output[1] = g_job->stage.load();
    output[2] = g_job->error.load();
    output[3] = g_job->index.load();
    output[4] = g_job->elapsed_ms.load();
    output[5] = static_cast<std::int32_t>(g_job->pending.load());
    const int channels = output_words - 6;
    for (int i = 0; i < channels && i < kMaxChannels; ++i) {
        output[6 + i] = g_job->locked[i].load();
    }
    return 0;
}

const char* webts_q3u4_scan_error_name(int error) {
    if (error < 0 || error > 0xff) return "unknown";
    return error_string(static_cast<Error>(error));
}

int webts_q3u4_scan_join(void) {
    if (g_job == nullptr) return 0;
    if (g_job->state.load() == kRunning) return static_cast<int>(Error::BUSY);
    if (g_thread_started) { pthread_join(g_thread, nullptr); g_thread_started = false; }
    return 0;
}

}  // extern "C"
