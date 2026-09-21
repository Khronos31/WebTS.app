// PX-Q3U4 の IT930x ファームウェアバージョンを読むだけの探針。
//
// 本番経路をそのまま通す。Q3U4Runtime::open_native() が同梱 libusb 経由で
// 列挙・grouping・open・claim を行い、It930xController が両デバイスの
// firmware_version を読む。
//
// 書き込みは行わない。ファームウェア送信、初期化、選局、TS 受信はしない。
// firmware_version が 0 ならコールド（未ロード）、0 以外ならウォーム。
//
// pacing は no_delay を使う。linux_reference_1ms は制御転送ごとに
// std::this_thread::sleep_for を呼ぶが、Emscripten の main runtime thread では
// イベントループを止めてしまう。WebUSB の往復自体に十分な間隔がある。

#include "px4/it930x.h"
#include "px4/libusb_transport.h"

#include <cstdint>

namespace {

using namespace px4::userland;

constexpr int kOutputWords = 8;

enum OutputWord : int {
    kWordError = 0,
    kWordQuarantined = 1,
    kWordDev1Error = 2,
    kWordDev1Version = 3,
    kWordDev2Error = 4,
    kWordDev2Version = 5,
    kWordDev1Cold = 6,
    kWordDev2Cold = 7,
};

void read_device(Transport& transport, std::int32_t* error_word,
                 std::int32_t* version_word, std::int32_t* cold_word) noexcept {
    It930xController controller(transport, CommandPacingOptions{CommandPacingMode::no_delay});
    const Result<std::uint32_t> version = controller.firmware_version();
    if (!version) {
        *error_word = static_cast<std::int32_t>(version.error());
        return;
    }
    *error_word = static_cast<std::int32_t>(Error::OK);
    *version_word = static_cast<std::int32_t>(version.value());
    *cold_word = version.value() == 0U ? 1 : 0;
}

}  // namespace

extern "C" {

int webts_q3u4_version_probe_words(void) {
    return kOutputWords;
}

/** 戻り値は Error の数値。デバイスごとの結果は output に入る。 */
int webts_q3u4_version_probe(std::int32_t* output, int output_words) {
    if (output == nullptr || output_words != kOutputWords) {
        return static_cast<int>(Error::INVALID_ARGUMENT);
    }
    for (int i = 0; i < kOutputWords; ++i) output[i] = -1;

    Result<std::unique_ptr<Q3U4Runtime>> runtime = Q3U4Runtime::open_native();
    if (!runtime) {
        output[kWordError] = static_cast<std::int32_t>(runtime.error());
        return static_cast<int>(runtime.error());
    }
    Q3U4Runtime& q3u4 = *runtime.value();
    output[kWordError] = static_cast<std::int32_t>(Error::OK);
    output[kWordQuarantined] = q3u4.quarantined() ? 1 : 0;

    read_device(q3u4.dev1(), &output[kWordDev1Error], &output[kWordDev1Version],
                &output[kWordDev1Cold]);
    read_device(q3u4.dev2(), &output[kWordDev2Error], &output[kWordDev2Version],
                &output[kWordDev2Cold]);

    // runtime のデストラクタが release と close を行う。
    return static_cast<int>(Error::OK);
}

}  // extern "C"
