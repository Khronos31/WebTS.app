// PX-Q3U4 の IT930x へファームウェアを実際に書き込む。
//
// 本番経路をそのまま通す。Q3U4Runtime::open_native() が同梱 libusb 経由で
// 列挙・grouping・open・claim を行い、It930xController::initialize_q3u4() が
// 上流の手順どおりに送信する。ここには送信ロジックを書かない。
//
// initialize_q3u4 は冪等である。firmware_version が 0 以外なら送信せず
// ウォーム初期化だけを行い already_loaded を返す。コールドなら scatter block
// を順に送り、kBoot の後でバージョンを読み直して 0 なら失敗にする。
// 失敗時は入口で backend power の論理状態を unknown にしてあるため、次回は
// フル初期化を再試行する。ファームウェアは RAM へ載るもので、フラッシュを
// 書き換えない。
//
// 選局、TS 受信、カード操作は行わない。

#include "px4/firmware.h"
#include "px4/it930x.h"
#include "px4/libusb_transport.h"

#include <cstdint>
#include <cstdio>
#include <vector>

namespace {

using namespace px4::userland;

constexpr const char* kScratchPath = "/tmp/webts-q3u4-firmware.bin";
constexpr int kOutputWords = 12;

enum OutputWord : int {
    kWordError = 0,
    kWordQuarantined = 1,
    kWordDev1Error = 2,
    kWordDev1AlreadyLoaded = 3,
    kWordDev1Version = 4,
    kWordDev1Verified = 5,
    kWordDev2Error = 6,
    kWordDev2AlreadyLoaded = 7,
    kWordDev2Version = 8,
    kWordDev2Verified = 9,
    kWordImageError = 10,
    kWordImageSize = 11,
};

void initialize_device(Transport& transport, const FirmwareImage& image,
                       std::int32_t* words) noexcept {
    It930xController controller(transport, CommandPacingOptions{CommandPacingMode::no_delay});
    const Result<FirmwareLoadResult> loaded =
        controller.initialize_q3u4(image, InitializationPolicy::accept_cold_or_warm);
    if (!loaded) {
        words[0] = static_cast<std::int32_t>(loaded.error());
        return;
    }
    words[0] = static_cast<std::int32_t>(Error::OK);
    words[1] = loaded.value().already_loaded ? 1 : 0;
    words[2] = static_cast<std::int32_t>(loaded.value().firmware_version);
    words[3] = loaded.value().verified ? 1 : 0;
}

}  // namespace

extern "C" {

int webts_q3u4_firmware_probe_words(void) {
    return kOutputWords;
}

/**
 * 渡されたファームウェアバイト列で両デバイスを初期化する。
 * 上流はパスから読む設計なので、仮想FSへ一度書いてから FirmwareProvider に
 * 読ませる。読み終えたらゼロ埋めして削除する。
 */
int webts_q3u4_firmware_probe(const std::uint8_t* firmware, int firmware_size,
                              std::int32_t* output, int output_words) {
    if (output == nullptr || output_words != kOutputWords) {
        return static_cast<int>(Error::INVALID_ARGUMENT);
    }
    for (int i = 0; i < kOutputWords; ++i) output[i] = -1;
    if (firmware == nullptr || firmware_size <= 0) {
        output[kWordError] = static_cast<std::int32_t>(Error::INVALID_ARGUMENT);
        return static_cast<int>(Error::INVALID_ARGUMENT);
    }
    output[kWordImageSize] = firmware_size;

    std::FILE* file = std::fopen(kScratchPath, "wb");
    if (file == nullptr) {
        output[kWordError] = static_cast<std::int32_t>(Error::INTERNAL);
        return static_cast<int>(Error::INTERNAL);
    }
    const bool written = std::fwrite(firmware, 1U, static_cast<std::size_t>(firmware_size), file)
        == static_cast<std::size_t>(firmware_size);
    std::fclose(file);

    Result<FirmwareImage> image = written
        ? FirmwareProvider(kScratchPath).load()
        : Result<FirmwareImage>::failure(Error::INTERNAL);

    if (std::FILE* scrub = std::fopen(kScratchPath, "r+b"); scrub != nullptr) {
        const std::vector<std::uint8_t> zeros(static_cast<std::size_t>(firmware_size), 0U);
        std::fwrite(zeros.data(), 1U, zeros.size(), scrub);
        std::fclose(scrub);
    }
    std::remove(kScratchPath);

    if (!image) {
        output[kWordImageError] = static_cast<std::int32_t>(image.error());
        output[kWordError] = static_cast<std::int32_t>(image.error());
        return static_cast<int>(image.error());
    }
    output[kWordImageError] = static_cast<std::int32_t>(Error::OK);

    Result<std::unique_ptr<Q3U4Runtime>> runtime = Q3U4Runtime::open_native();
    if (!runtime) {
        output[kWordError] = static_cast<std::int32_t>(runtime.error());
        return static_cast<int>(runtime.error());
    }
    Q3U4Runtime& q3u4 = *runtime.value();
    output[kWordError] = static_cast<std::int32_t>(Error::OK);
    output[kWordQuarantined] = q3u4.quarantined() ? 1 : 0;

    initialize_device(q3u4.dev1(), image.value(), &output[kWordDev1Error]);
    initialize_device(q3u4.dev2(), image.value(), &output[kWordDev2Error]);

    return static_cast<int>(Error::OK);
}

}  // extern "C"
