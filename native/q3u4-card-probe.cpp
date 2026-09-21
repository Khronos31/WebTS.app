// PX-Q3U4 内蔵カードリーダに実際のカードで話しかける。
//
// M2（B25 復号）の前提を1つずつ潰すための段階。ここでやるのは
// 電源投入・UART 初期化・リセット・ATR 取得・T=1 セッション確立・APDU 往復
// までで、復号には触れない。
//
// 組み立ては上流の CardService が要求する形に従う。プロトコルも T=1 の
// ブロック処理も上流が持っており、ここには一切書かない。
//
//   Q3U4FrontendEnclosure        … カード電源の権限を持つのはこちら。
//                                  単一受信機の Q3U4Frontend では acquire_card
//                                  が無いので、ここでは使えない。
//   Q3U4CardBackend(dev1, enclosure)
//   It930xCardHardware(dev1) + SystemCardTime → CardSession
//   NativeCardProtocolSession → CardService
//
// **カードの応答バイトは一切外へ出さない。**返すのは SW1SW2、応答長、
// ATR の長さとプロトコル引数（ボーレート・IFSC・EDC）だけで、カード ID、
// 鍵、CBC 初期値、ATR のバイト列そのものは読み出しても保持しない。

#include "q3u4_card_backend.h"
#include "q3u4_frontend.h"
#include "px4/card.h"
#include "px4/card_service.h"
#include "px4/firmware.h"
#include "px4/ipc.h"
#include "px4/it930x.h"
#include "px4/libusb_transport.h"

#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <pthread.h>
#include <thread>
#include <vector>

namespace {

using namespace px4::userland;

constexpr const char* kScratchPath = "/tmp/webts-q3u4-card-firmware.bin";

// ARIB STD-B25 Part 3 の「初期設定条件コマンド」。CLA=0x90 INS=0x30。
// これはカードが応答するかを見るためだけに送る。応答の中身は読まない。
constexpr std::array<std::uint8_t, 5U> kInitialSettingConditions{
    0x90U, 0x30U, 0x00U, 0x00U, 0x00U};

enum ProbeState : int { kIdle = 0, kRunning = 1, kFinished = 2, kFailed = 3 };

enum ProbeStage : int {
    kStageStart = 0,
    kStageImage = 1,
    kStageOpen = 2,
    kStageInit = 3,
    kStageStatus = 4,
    kStageConnect = 5,
    kStageTransmit = 6,
    kStageDisconnect = 7,
    kStageShutdown = 8,
    kStageDone = 9,
};

struct Job final {
    std::vector<std::uint8_t> firmware;

    std::atomic<int> state{kIdle};
    std::atomic<int> stage{kStageStart};
    std::atomic<int> error{0};
    std::atomic<int> elapsed_ms{0};
    // 形だけ。カードの識別につながる値は入れない。
    std::atomic<int> present{-1};
    std::atomic<int> atr_length{-1};
    std::atomic<int> atr_baud_rate{-1};
    std::atomic<int> atr_ifsc{-1};
    std::atomic<int> atr_edc{-1};
    std::atomic<int> atr_block_timeout_ms{-1};
    std::atomic<int> session_initialized{-1};
    std::atomic<int> response_length{-1};
    std::atomic<int> status_word{-1};
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
    // カード電源の権限を持つのは enclosure であり、単一受信機の wrapper ではない。
    Q3U4FrontendEnclosure enclosure(bridge1, bridge2, dev1_power, dev2_power, delay);

    job.stage.store(kStageInit);
    const auto init1 = dev1.initialize_q3u4(image.value());
    if (!init1) { fail(kStageInit, init1.error()); return nullptr; }
    const auto init2 = dev2.initialize_q3u4(image.value());
    if (!init2) { fail(kStageInit, init2.error()); return nullptr; }

    Q3U4CardBackend backend(dev1, enclosure);
    It930xCardHardware hardware(dev1);
    SystemCardTime time;
    CardSession card(hardware, time);
    NativeCardProtocolSession protocol(card);
    CardService service(backend, protocol);

    job.stage.store(kStageStatus);
    const auto status = service.status();
    if (!status) { fail(kStageStatus, status.error()); return nullptr; }
    job.present.store(status.value().present ? 1 : 0);

    job.stage.store(kStageConnect);
    const auto connected = service.connect(1U, ipc::ShareMode::exclusive);
    if (!connected) { fail(kStageConnect, connected.error()); return nullptr; }
    const CardAtr& atr = connected.value().atr;
    // 長さとプロトコル引数だけ。バイト列は読み出さない。
    job.atr_length.store(static_cast<int>(atr.length));
    job.atr_baud_rate.store(static_cast<int>(atr.baud_rate));
    job.atr_ifsc.store(static_cast<int>(atr.ifsc));
    job.atr_edc.store(static_cast<int>(atr.edc));
    job.atr_block_timeout_ms.store(static_cast<int>(atr.block_timeout_ms));
    job.session_initialized.store(protocol.initialized() ? 1 : 0);

    Error result = Error::OK;

    job.stage.store(kStageTransmit);
    {
        // 応答はこのスコープを出る前に破棄する。
        std::array<std::uint8_t, 256U> response{};
        const auto transmitted = service.transmit(
            1U, connected.value().handle,
            ByteView{kInitialSettingConditions.data(), kInitialSettingConditions.size()},
            MutableByteView{response.data(), response.size()});
        if (!transmitted) {
            result = transmitted.error();
        } else {
            const std::size_t length = transmitted.value();
            job.response_length.store(static_cast<int>(length));
            // SW1SW2 だけ取り出す。これは成否であって内容ではない。
            if (length >= 2U) {
                job.status_word.store(static_cast<int>(
                    (static_cast<unsigned>(response[length - 2U]) << 8) |
                    response[length - 1U]));
            }
        }
        response.fill(0U);
    }

    job.stage.store(kStageDisconnect);
    const auto disconnected =
        service.disconnect(1U, connected.value().handle, ipc::Disposition::leave);
    if (!disconnected && result == Error::OK) result = disconnected.error();

    job.stage.store(kStageShutdown);
    const auto shutdown = service.shutdown();
    if (!shutdown && result == Error::OK) result = shutdown.error();

    job.error.store(static_cast<int>(result));
    job.elapsed_ms.store(elapsed());
    job.stage.store(kStageDone);
    job.state.store(result == Error::OK ? kFinished : kFailed);
    return nullptr;
}

}  // namespace

extern "C" {

/** カード経路を pthread で試す。即座に戻る。この関数は USB に触れない。 */
int webts_q3u4_card_start(const std::uint8_t* firmware, int firmware_size) {
    if (g_job != nullptr && g_job->state.load() == kRunning) return static_cast<int>(Error::BUSY);
    if (firmware == nullptr || firmware_size <= 0) {
        return static_cast<int>(Error::INVALID_ARGUMENT);
    }
    if (g_thread_started) { pthread_join(g_thread, nullptr); g_thread_started = false; }
    delete g_job;
    g_job = new Job();
    g_job->firmware.assign(firmware, firmware + firmware_size);
    g_job->state.store(kRunning);
    if (pthread_create(&g_thread, nullptr, worker_main, g_job) != 0) {
        g_job->state.store(kFailed);
        g_job->error.store(static_cast<int>(Error::INTERNAL));
        return static_cast<int>(Error::INTERNAL);
    }
    g_thread_started = true;
    return 0;
}

/** 進捗と結果を読む。ブロックしない。output は 13 語。 */
int webts_q3u4_card_poll(std::int32_t* output, int output_words) {
    if (output == nullptr || output_words < 13) return static_cast<int>(Error::INVALID_ARGUMENT);
    if (g_job == nullptr) { output[0] = kIdle; return 0; }
    const Job& job = *g_job;
    output[0] = job.state.load();
    output[1] = job.stage.load();
    output[2] = job.error.load();
    output[3] = job.elapsed_ms.load();
    output[4] = job.present.load();
    output[5] = job.atr_length.load();
    output[6] = job.atr_baud_rate.load();
    output[7] = job.atr_ifsc.load();
    output[8] = job.atr_edc.load();
    output[9] = job.atr_block_timeout_ms.load();
    output[10] = job.session_initialized.load();
    output[11] = job.response_length.load();
    output[12] = job.status_word.load();
    return 0;
}

const char* webts_q3u4_card_error_name(int error) {
    if (error < 0 || error > 0xff) return "unknown";
    return error_string(static_cast<Error>(error));
}

int webts_q3u4_card_join(void) {
    if (g_job == nullptr) return 0;
    if (g_job->state.load() == kRunning) return static_cast<int>(Error::BUSY);
    if (g_thread_started) { pthread_join(g_thread, nullptr); g_thread_started = false; }
    return 0;
}

}  // extern "C"
