// libaribb25 の B_CAS_CARD を PX-Q3U4 内蔵リーダの上で動かす。
//
// 14章でカードとの APDU 往復は通った。ここで確かめるのは、上流 libaribb25 が
// 期待する vtable がその上に載るかどうか。
//
// 上流 b_cas_card.c は PC/SC 向けに書かれているが、価値があるのは ARIB
// STD-B25 Part 3 の応答解析であって PC/SC ではない。実際に使っている PC/SC の
// 面は6関数と定数数個だけなので、**b_cas_card.c は改変せず同梱し**、
// native/winscard/ がその面を内蔵リーダの上に用意する。解析を書き直すより
// シムを書くほうが小さく、間違いにくい。
//
// **カードの内容は一切外へ出さない。**カード ID、システム鍵、CBC 初期値は
// 読み出した構造体の中にあるが、報告するのはゼロでないかどうかだけで、
// 値そのものは持ち出さず、使い終わった構造体はゼロ埋めする。

#include "q3u4_card_backend.h"
#include "q3u4_frontend.h"
#include "px4/card.h"
#include "px4/card_service.h"
#include "px4/firmware.h"
#include "px4/ipc.h"
#include "px4/it930x.h"
#include "px4/libusb_transport.h"

extern "C" {
#include "b_cas_card.h"
#include "b_cas_card_error_code.h"
}

extern "C" void webts_winscard_bind(void* service, std::uint64_t client);
extern "C" void webts_winscard_unbind(void);

#include <array>
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

constexpr const char* kScratchPath = "/tmp/webts-q3u4-b25-firmware.bin";

enum ProbeState : int { kIdle = 0, kRunning = 1, kFinished = 2, kFailed = 3 };

enum ProbeStage : int {
    kStageStart = 0,
    kStageImage = 1,
    kStageOpen = 2,
    kStageInit = 3,
    kStageCreate = 4,
    kStageCardInit = 5,
    kStageInitStatus = 6,
    kStageGetId = 7,
    kStagePowerOnControl = 8,
    kStageRelease = 9,
    kStageShutdown = 10,
    kStageDone = 11,
};

struct Job final {
    std::vector<std::uint8_t> firmware;

    std::atomic<int> state{kIdle};
    std::atomic<int> stage{kStageStart};
    std::atomic<int> error{0};
    std::atomic<int> elapsed_ms{0};
    // 形だけ。カードの識別につながる値は入れない。
    std::atomic<int> card_init{-1};
    std::atomic<int> ca_system_id{-1};
    std::atomic<int> card_status{-1};
    std::atomic<int> system_key_present{-1};
    std::atomic<int> init_cbc_present{-1};
    std::atomic<int> card_id_present{-1};
    std::atomic<int> id_count{-1};
    std::atomic<int> power_on_control_count{-1};
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

    // シムに service を渡してから B_CAS_CARD を作る。SCardConnect が
    // CardService::connect を呼ぶので、電源投入も UART 初期化もその中で起きる。
    webts_winscard_bind(&service, 1U);
    Error result = Error::OK;

    job.stage.store(kStageCreate);
    B_CAS_CARD* bcas = create_b_cas_card();
    if (bcas == nullptr) {
        webts_winscard_unbind();
        fail(kStageCreate, Error::INTERNAL);
        return nullptr;
    }

    job.stage.store(kStageCardInit);
    const int initialized = bcas->init(bcas);
    job.card_init.store(initialized);
    if (initialized == 0) {
        job.stage.store(kStageInitStatus);
        B_CAS_INIT_STATUS init_status{};
        if (bcas->get_init_status(bcas, &init_status) == 0) {
            // 出すのは「あるかどうか」だけ。鍵も CBC 初期値もカード ID も
            // 値としては持ち出さない。ca_system_id と card_status は
            // カード個体ではなく規格上の分類である。
            job.ca_system_id.store(init_status.ca_system_id);
            job.card_status.store(init_status.card_status);
            bool key = false;
            for (const std::uint8_t byte : init_status.system_key) key = key || byte != 0U;
            bool cbc = false;
            for (const std::uint8_t byte : init_status.init_cbc) cbc = cbc || byte != 0U;
            job.system_key_present.store(key ? 1 : 0);
            job.init_cbc_present.store(cbc ? 1 : 0);
            job.card_id_present.store(init_status.bcas_card_id != 0 ? 1 : 0);
        }
        // 構造体ごと消す。スタックに鍵を残さない。
        std::memset(&init_status, 0, sizeof(init_status));

        job.stage.store(kStageGetId);
        B_CAS_ID id{};
        if (bcas->get_id(bcas, &id) == 0) job.id_count.store(id.count);

        job.stage.store(kStagePowerOnControl);
        B_CAS_PWR_ON_CTRL_INFO power_on{};
        if (bcas->get_pwr_on_ctrl(bcas, &power_on) == 0) {
            job.power_on_control_count.store(power_on.count);
        }
    } else {
        result = Error::PROTOCOL_ERROR;
    }

    job.stage.store(kStageRelease);
    bcas->release(bcas);
    webts_winscard_unbind();

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

/** B_CAS_CARD を pthread で試す。即座に戻る。この関数は USB に触れない。 */
int webts_q3u4_b25_start(const std::uint8_t* firmware, int firmware_size) {
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

/** 進捗と結果を読む。ブロックしない。output は 12 語。 */
int webts_q3u4_b25_poll(std::int32_t* output, int output_words) {
    if (output == nullptr || output_words < 12) return static_cast<int>(Error::INVALID_ARGUMENT);
    if (g_job == nullptr) { output[0] = kIdle; return 0; }
    const Job& job = *g_job;
    output[0] = job.state.load();
    output[1] = job.stage.load();
    output[2] = job.error.load();
    output[3] = job.elapsed_ms.load();
    output[4] = job.card_init.load();
    output[5] = job.ca_system_id.load();
    output[6] = job.card_status.load();
    output[7] = job.system_key_present.load();
    output[8] = job.init_cbc_present.load();
    output[9] = job.card_id_present.load();
    output[10] = job.id_count.load();
    output[11] = job.power_on_control_count.load();
    return 0;
}

const char* webts_q3u4_b25_error_name(int error) {
    if (error < 0 || error > 0xff) return "unknown";
    return error_string(static_cast<Error>(error));
}

int webts_q3u4_b25_join(void) {
    if (g_job == nullptr) return 0;
    if (g_job->state.load() == kRunning) return static_cast<int>(Error::BUSY);
    if (g_thread_started) { pthread_join(g_thread, nullptr); g_thread_started = false; }
    return 0;
}

}  // extern "C"
