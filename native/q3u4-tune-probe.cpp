// PX-Q3U4 で地上デジタルを選局し、復調ロックまで到達するかを見る。
//
// 組み立てと手順は上流の frontend_probe と同じで、ロジックは一切書き写さない。
// Q3U4Runtime → It930xController ×2 → It930xBackendPower ×2 →
// CoupledProbePower → It930xBridgeI2cMaster → Q3U4Frontend の順。
// 電源は dev1/dev2 連動でなければならない。
//
// 上流の probe と1点だけ違う。RealDelay は std::this_thread::sleep_for を使うが、
// Emscripten の main runtime thread でそれを呼ぶとイベントループが止まり、
// WebUSB の Promise が永久に解決しない。Asyncify の emscripten_sleep() に
// 置き換える。これは環境の違いによる必然で、手順の変更ではない。
//
// TS の受信はここでは行わない。capture は開始しない。

#include "frontend_probe_support.h"
#include "q3u4_frontend.h"
#include "px4/firmware.h"
#include "px4/it930x.h"
#include "px4/libusb_transport.h"

#include <emscripten.h>

#include <cstdint>
#include <cstdio>
#include <vector>

namespace {

using namespace px4::userland;

constexpr const char* kScratchPath = "/tmp/webts-q3u4-tune-firmware.bin";
constexpr int kOutputWords = 10;

enum OutputWord : int {
    kWordError = 0,
    kWordStage = 1,        // 失敗した段階（下の ProbeStage）
    kWordLocked = 2,
    kWordLockChecks = 3,
    kWordLockElapsedMs = 4,
    kWordTsid = 5,
    kWordDev1Version = 6,
    kWordDev2Version = 7,
    kWordFrequencyKhz = 8,
    kWordReceiver = 9,
};

enum ProbeStage : int {
    kStageStart = 0,
    kStageImage = 1,
    kStageOpenRuntime = 2,
    kStageInitDev1 = 3,
    kStageInitDev2 = 4,
    kStageFrontendOpen = 5,
    kStageTune = 6,
    kStageLock = 7,
    kStageDone = 8,
};

/** イベントループを止めない待機。Asyncify が呼び出し全体を巻き戻す。 */
class AsyncifyDelay final : public Q3U4FrontendDelay {
public:
    void sleep_ms(std::uint32_t milliseconds) noexcept override {
        emscripten_sleep(milliseconds);
    }
};

Result<bool> demod_lock(void* context) noexcept {
    return static_cast<Q3U4Frontend*>(context)->is_terrestrial_locked();
}

Result<FirmwareImage> stage_image(const std::uint8_t* firmware, int size) noexcept {
    std::FILE* file = std::fopen(kScratchPath, "wb");
    if (file == nullptr) return Result<FirmwareImage>::failure(Error::INTERNAL);
    const bool written = std::fwrite(firmware, 1U, static_cast<std::size_t>(size), file)
        == static_cast<std::size_t>(size);
    std::fclose(file);
    Result<FirmwareImage> image = written
        ? FirmwareProvider(kScratchPath).load()
        : Result<FirmwareImage>::failure(Error::INTERNAL);
    if (std::FILE* scrub = std::fopen(kScratchPath, "r+b"); scrub != nullptr) {
        const std::vector<std::uint8_t> zeros(static_cast<std::size_t>(size), 0U);
        std::fwrite(zeros.data(), 1U, zeros.size(), scrub);
        std::fclose(scrub);
    }
    std::remove(kScratchPath);
    return image;
}

}  // namespace

extern "C" {

int webts_q3u4_tune_probe_words(void) {
    return kOutputWords;
}

/**
 * 指定した受信機で指定周波数へ選局し、復調ロックを待つ。
 * 終了時は必ず close と backend power off を試みる。
 */
int webts_q3u4_tune_probe(const std::uint8_t* firmware, int firmware_size,
                          int receiver, int frequency_khz,
                          std::int32_t* output, int output_words) {
    if (output == nullptr || output_words != kOutputWords) {
        return static_cast<int>(Error::INVALID_ARGUMENT);
    }
    for (int i = 0; i < kOutputWords; ++i) output[i] = -1;
    output[kWordStage] = kStageStart;
    output[kWordFrequencyKhz] = frequency_khz;
    output[kWordReceiver] = receiver;
    if (firmware == nullptr || firmware_size <= 0 || receiver < 0 || receiver > 3 ||
        frequency_khz <= 0) {
        output[kWordError] = static_cast<std::int32_t>(Error::INVALID_ARGUMENT);
        return static_cast<int>(Error::INVALID_ARGUMENT);
    }

    const Result<FirmwareImage> image = stage_image(firmware, firmware_size);
    if (!image) {
        output[kWordStage] = kStageImage;
        output[kWordError] = static_cast<std::int32_t>(image.error());
        return static_cast<int>(image.error());
    }

    Result<std::unique_ptr<Q3U4Runtime>> runtime = Q3U4Runtime::open_native();
    if (!runtime) {
        output[kWordStage] = kStageOpenRuntime;
        output[kWordError] = static_cast<std::int32_t>(runtime.error());
        return static_cast<int>(runtime.error());
    }

    AsyncifyDelay delay;
    It930xController dev1(runtime.value()->dev1(),
                          CommandPacingOptions{CommandPacingMode::no_delay});
    It930xController dev2(runtime.value()->dev2(),
                          CommandPacingOptions{CommandPacingMode::no_delay});
    It930xBackendPower dev1_power(dev1);
    It930xBackendPower dev2_power(dev2);
    CoupledProbePower power(dev1_power, dev2_power);
    It930xBridgeI2cMaster bridge(dev1);
    Q3U4Frontend frontend(bridge, power, delay);

    Error result = Error::OK;
    const auto init1 = dev1.initialize_q3u4(image.value());
    if (!init1) {
        output[kWordStage] = kStageInitDev1;
        result = init1.error();
    } else {
        output[kWordDev1Version] = static_cast<std::int32_t>(init1.value().firmware_version);
        const auto init2 = dev2.initialize_q3u4(image.value());
        if (!init2) {
            output[kWordStage] = kStageInitDev2;
            result = init2.error();
        } else {
            output[kWordDev2Version] = static_cast<std::int32_t>(init2.value().firmware_version);
            const auto opened = frontend.open_terrestrial(static_cast<std::uint8_t>(receiver));
            if (!opened) {
                output[kWordStage] = kStageFrontendOpen;
                result = opened.error();
            } else {
                const auto tuned =
                    frontend.tune_terrestrial(static_cast<std::uint32_t>(frequency_khz));
                if (!tuned) {
                    output[kWordStage] = kStageTune;
                    result = tuned.error();
                } else {
                    const ProbeLockPollResult lock =
                        poll_frontend_probe_lock(demod_lock, &frontend, delay);
                    output[kWordLocked] = lock.locked ? 1 : 0;
                    output[kWordLockChecks] = static_cast<std::int32_t>(lock.checks);
                    output[kWordLockElapsedMs] = static_cast<std::int32_t>(lock.elapsed_ms);
                    output[kWordTsid] = static_cast<std::int32_t>(frontend.selected_tsid());
                    output[kWordStage] = lock.locked ? kStageDone : kStageLock;
                    if (!lock.locked) result = lock.error;
                }
            }
        }
    }

    // 成否にかかわらず閉じて電源を落とす。
    if (frontend.open_state()) {
        const auto closed = frontend.close();
        if (!closed && result == Error::OK) result = closed.error();
    }
    const auto powered_off = power.set_backend_power(false, delay);
    if (!powered_off && result == Error::OK) result = powered_off.error();

    output[kWordError] = static_cast<std::int32_t>(result);
    return static_cast<int>(result);
}

/** 失敗位置を人が読める形で返す。上流の診断文字列をそのまま出す。 */
const char* webts_q3u4_tune_probe_stage_name(int stage) {
    switch (stage) {
    case kStageStart: return "start";
    case kStageImage: return "firmware-image";
    case kStageOpenRuntime: return "open-runtime";
    case kStageInitDev1: return "init-dev1";
    case kStageInitDev2: return "init-dev2";
    case kStageFrontendOpen: return "frontend-open";
    case kStageTune: return "tune";
    case kStageLock: return "demod-lock";
    case kStageDone: return "done";
    default: return "unknown";
    }
}

}  // extern "C"
