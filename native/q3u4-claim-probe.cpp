// PX-Q3U4 を本番経路で open / claim / release / close する最小の往復。
//
// fake は使わない。同梱した公式 libusb の Emscripten/WebUSB backend が、
// ページに与えられた実際の WebUSB 権限を通して実機を開く。
//
// ここで行うのは interface 0 の claim と即時 release だけ。転送、clear halt、
// set configuration、reset、firmware、選局、TS 受信は一切行わない。
// 識別子は上流 px4/identity.h から取る。

#include "px4/identity.h"

#include <libusb.h>

#include <cstdint>

namespace {

constexpr int kOutputWords = 20;
constexpr int kMaxDevices = 4;

// 0: 全体の診断 / 1: libusb が列挙した総数 / 2: VID:PID 一致数 / 3: 実際に試した数
// 4 以降、デバイスごとに open, claim, release, close の戻り値を 4 語ずつ。
enum Diagnostic : int {
    kOk = 0,
    kInitFailed = 1,
    kEnumerateFailed = 2,
    kInvalidOutput = 3,
    kNoMatchingDevice = 4,
};

void discard_log(libusb_context*, enum libusb_log_level, const char*) {}

}  // namespace

extern "C" {

int webts_q3u4_claim_probe_words(void) {
    return kOutputWords;
}

/**
 * 一致する各デバイスについて open → claim(0) → release(0) → close を試し、
 * 各段の libusb 戻り値をそのまま返す。失敗しても後段の後始末は必ず行う。
 */
int webts_q3u4_claim_probe(std::int32_t* output, int output_words) {
    if (output == nullptr || output_words != kOutputWords) return kInvalidOutput;
    for (int i = 0; i < kOutputWords; ++i) output[i] = 0;

    libusb_context* context = nullptr;
    libusb_set_log_cb(nullptr, discard_log, LIBUSB_LOG_CB_GLOBAL);
    if (libusb_init(&context) != LIBUSB_SUCCESS || context == nullptr) {
        output[0] = kInitFailed;
        return kInitFailed;
    }

    libusb_device** devices = nullptr;
    const ssize_t count = libusb_get_device_list(context, &devices);
    if (count < 0 || devices == nullptr) {
        output[0] = kEnumerateFailed;
        libusb_exit(context);
        return kEnumerateFailed;
    }
    output[1] = static_cast<std::int32_t>(count);

    int matching = 0;
    int attempted = 0;
    for (ssize_t index = 0; index < count; ++index) {
        libusb_device_descriptor descriptor{};
        if (libusb_get_device_descriptor(devices[index], &descriptor) != LIBUSB_SUCCESS) continue;
        if (descriptor.idVendor != px4::userland::kQ3U4VendorId ||
            descriptor.idProduct != px4::userland::kQ3U4ProductId) {
            continue;
        }
        matching++;
        if (attempted >= kMaxDevices) continue;

        std::int32_t* slot = output + 4 + attempted * 4;
        libusb_device_handle* handle = nullptr;
        const int opened = libusb_open(devices[index], &handle);
        slot[0] = opened;
        if (opened != LIBUSB_SUCCESS || handle == nullptr) { attempted++; continue; }

        const int claimed = libusb_claim_interface(handle, 0);
        slot[1] = claimed;
        // claim に失敗しても release は呼ばず、close だけは必ず行う。
        slot[2] = claimed == LIBUSB_SUCCESS ? libusb_release_interface(handle, 0) : 0;
        libusb_close(handle);
        slot[3] = 1;  // close は戻り値を持たない。呼んだことだけを記録する。
        attempted++;
    }

    output[2] = matching;
    output[3] = attempted;
    output[0] = matching > 0 ? kOk : kNoMatchingDevice;

    libusb_free_device_list(devices, 1);
    libusb_exit(context);
    return output[0];
}

}  // extern "C"
