// PX-Q3U4 のセッションを一度だけ開き、選局を繰り返せるようにする。
//
// 先に書いた q3u4-tune-probe は、選局のたびに Q3U4Runtime を作り直し、
// 終了ごとに backend power を落としていた。それを走査ループで連打した結果、
// 実機の片方の USB デバイスが列挙から消えた（抜き差しで復帰した）。
// 上流の probe は「起動につき1回」の想定であり、ループへ流用したのが誤りだった。
//
// ここでは open と初期化を1回だけ行い、以後は選局だけを繰り返す。実運用でも
// チャンネル切替のたびに USB を開き直すことはないので、こちらが正しい形である。
//
// TS 受信はまだ行わない。capture は開始しない。

#include "frontend_probe_support.h"
#include "q3u4_frontend.h"
#include "px4/firmware.h"
#include "px4/it930x.h"
#include "px4/libusb_transport.h"

#include <emscripten.h>

#include <cstdint>
#include <cstdio>
#include <memory>
#include <vector>

namespace {

using namespace px4::userland;

constexpr const char* kScratchPath = "/tmp/webts-q3u4-session-firmware.bin";

/** イベントループを止めない待機。Emscripten の main thread で sleep_for は使えない。 */
class AsyncifyDelay final : public Q3U4FrontendDelay {
public:
    void sleep_ms(std::uint32_t milliseconds) noexcept override {
        emscripten_sleep(milliseconds);
    }
};

Result<bool> demod_lock(void* context) noexcept {
    return static_cast<Q3U4Frontend*>(context)->is_terrestrial_locked();
}

/** 開いている間ずっと生きる資源。順序が効くので宣言順のまま破棄させる。 */
struct Session final {
    AsyncifyDelay delay;
    std::unique_ptr<Q3U4Runtime> runtime;
    std::unique_ptr<It930xController> dev1;
    std::unique_ptr<It930xController> dev2;
    std::unique_ptr<It930xBackendPower> dev1_power;
    std::unique_ptr<It930xBackendPower> dev2_power;
    std::unique_ptr<CoupledProbePower> power;
    std::unique_ptr<It930xBridgeI2cMaster> bridge;
    std::unique_ptr<Q3U4Frontend> frontend;
    std::uint32_t dev1_version = 0U;
    std::uint32_t dev2_version = 0U;
    int open_receiver = -1;
};

Session* g_session = nullptr;

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

/**
 * セッションを開く。列挙・grouping・open・claim・ファームウェア初期化・
 * 地上波受信機の open まで行い、以後の選局に備える。
 * receiver は 2 または 3（0/1 は ISDB-S）。
 * 戻り値は Error の数値。
 */
int webts_q3u4_session_open(const std::uint8_t* firmware, int firmware_size, int receiver) {
    if (g_session != nullptr) return static_cast<int>(Error::BUSY);
    if (firmware == nullptr || firmware_size <= 0 || receiver < 2 || receiver > 3) {
        return static_cast<int>(Error::INVALID_ARGUMENT);
    }

    const Result<FirmwareImage> image = stage_image(firmware, firmware_size);
    if (!image) return static_cast<int>(image.error());

    Result<std::unique_ptr<Q3U4Runtime>> runtime = Q3U4Runtime::open_native();
    if (!runtime) return static_cast<int>(runtime.error());

    auto session = std::make_unique<Session>();
    session->runtime = std::move(runtime.value());
    session->dev1 = std::make_unique<It930xController>(
        session->runtime->dev1(), CommandPacingOptions{CommandPacingMode::no_delay});
    session->dev2 = std::make_unique<It930xController>(
        session->runtime->dev2(), CommandPacingOptions{CommandPacingMode::no_delay});
    session->dev1_power = std::make_unique<It930xBackendPower>(*session->dev1);
    session->dev2_power = std::make_unique<It930xBackendPower>(*session->dev2);
    session->power = std::make_unique<CoupledProbePower>(*session->dev1_power,
                                                         *session->dev2_power);
    session->bridge = std::make_unique<It930xBridgeI2cMaster>(*session->dev1);
    session->frontend = std::make_unique<Q3U4Frontend>(*session->bridge, *session->power,
                                                       session->delay);

    const auto init1 = session->dev1->initialize_q3u4(image.value());
    if (!init1) return static_cast<int>(init1.error());
    session->dev1_version = init1.value().firmware_version;
    const auto init2 = session->dev2->initialize_q3u4(image.value());
    if (!init2) return static_cast<int>(init2.error());
    session->dev2_version = init2.value().firmware_version;

    const auto opened = session->frontend->open_terrestrial(static_cast<std::uint8_t>(receiver));
    if (!opened) return static_cast<int>(opened.error());
    session->open_receiver = receiver;

    g_session = session.release();
    return static_cast<int>(Error::OK);
}

std::uint32_t webts_q3u4_session_dev1_version(void) {
    return g_session == nullptr ? 0U : g_session->dev1_version;
}

std::uint32_t webts_q3u4_session_dev2_version(void) {
    return g_session == nullptr ? 0U : g_session->dev2_version;
}

/**
 * 開いているセッションで選局し、復調ロックを待つ。
 * output: [error, locked, checks, elapsed_ms, tsid]
 */
int webts_q3u4_session_tune(int frequency_khz, std::int32_t* output, int output_words) {
    if (output == nullptr || output_words != 5) return static_cast<int>(Error::INVALID_ARGUMENT);
    for (int i = 0; i < output_words; ++i) output[i] = -1;
    if (g_session == nullptr) {
        output[0] = static_cast<std::int32_t>(Error::NOT_READY);
        return static_cast<int>(Error::NOT_READY);
    }
    if (frequency_khz <= 0) {
        output[0] = static_cast<std::int32_t>(Error::INVALID_ARGUMENT);
        return static_cast<int>(Error::INVALID_ARGUMENT);
    }

    const auto tuned =
        g_session->frontend->tune_terrestrial(static_cast<std::uint32_t>(frequency_khz));
    if (!tuned) {
        output[0] = static_cast<std::int32_t>(tuned.error());
        return static_cast<int>(tuned.error());
    }
    const ProbeLockPollResult lock =
        poll_frontend_probe_lock(demod_lock, g_session->frontend.get(), g_session->delay);
    output[0] = static_cast<std::int32_t>(lock.locked ? Error::OK : lock.error);
    output[1] = lock.locked ? 1 : 0;
    output[2] = static_cast<std::int32_t>(lock.checks);
    output[3] = static_cast<std::int32_t>(lock.elapsed_ms);
    output[4] = static_cast<std::int32_t>(g_session->frontend->selected_tsid());
    return static_cast<int>(Error::OK);
}

/** 閉じる。close と backend power off を必ず試み、資源を解放する。 */
int webts_q3u4_session_close(void) {
    if (g_session == nullptr) return static_cast<int>(Error::OK);
    Error result = Error::OK;
    if (g_session->frontend->open_state()) {
        const auto closed = g_session->frontend->close();
        if (!closed) result = closed.error();
    }
    const auto powered_off = g_session->power->set_backend_power(false, g_session->delay);
    if (!powered_off && result == Error::OK) result = powered_off.error();
    delete g_session;
    g_session = nullptr;
    return static_cast<int>(result);
}

int webts_q3u4_session_is_open(void) {
    return g_session == nullptr ? 0 : 1;
}

}  // extern "C"
