// PX-Q3U4 の IT930x ファームウェアを、ベンダードライバのバイト列から取り出し、
// 同梱した上流にそのまま検証させる境界。
//
// 取り出しは fwtool を書き写さない。fwtool は .sys の CRC32 で fwinfo.tsv の行を
// 引き、code_ofs から code_len バイトを「そのまま」書き出しているだけなので、
// ファームウェアは連続・無加工で埋まっている。したがって、上流が持つ既知の
// SHA-256 に一致する 2169 バイト窓を探せば同じ結果になる。既知オフセットは
// 探索を1回で終わらせるためのヒントにすぎず、正しさはハッシュ一致が保証する。
// ドライバのバージョンが変わってオフセットが動いても壊れない。
//
// 検証は上流の FirmwareProvider::load() に任せる。サイズ、SHA-256、
// IT930x scatter image としての妥当性まで見てくれる。

#include "px4/firmware.h"

#include "firmware_internal.h"

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace {

using namespace px4::userland;

constexpr const char* kScratchPath = "/tmp/webts-px4-firmware-candidate.bin";

bool digest_matches(const std::array<std::uint8_t, 32U>& digest) noexcept {
    return digest == kIt930xFirmwareSha256;
}

}  // namespace

extern "C" {

int webts_px4_firmware_expected_size(void) {
    return static_cast<int>(kIt930xFirmwareSize);
}

/** 上流の期待 SHA-256 を 32 バイトで返す。JS 側で値を書かないため。 */
int webts_px4_firmware_expected_sha256(std::uint8_t* out, int out_size) {
    if (out == nullptr || out_size != 32) return -1;
    std::memcpy(out, kIt930xFirmwareSha256.data(), kIt930xFirmwareSha256.size());
    return 0;
}

/**
 * data の中から、上流の既知 SHA-256 に一致する kIt930xFirmwareSize バイト窓を
 * 探し、その先頭オフセットを返す。見つからなければ -1。
 *
 * hint に既知オフセットを渡すと最初にそこを試す。ヒントが当たれば SHA-256 は
 * 1回で済む。外れた場合だけ全域を走査する。
 */
int webts_px4_firmware_find(const std::uint8_t* data, int size, int hint) {
    const int window = static_cast<int>(kIt930xFirmwareSize);
    if (data == nullptr || size < window) return -1;

    if (hint >= 0 && hint <= size - window) {
        if (digest_matches(sha256_digest(ByteView{data + hint, kIt930xFirmwareSize}))) {
            return hint;
        }
    }
    for (int offset = 0; offset <= size - window; ++offset) {
        if (offset == hint) continue;
        if (digest_matches(sha256_digest(ByteView{data + offset, kIt930xFirmwareSize}))) {
            return offset;
        }
    }
    return -1;
}

/**
 * 候補バイト列を上流の FirmwareProvider::load() へ通し、Error の数値を返す。
 * 上流はパスから読む設計なので、Emscripten の仮想FSへ一度書いてから読ませる。
 * 読み終えたらゼロ埋めして削除する。
 */
int webts_px4_firmware_validate(const std::uint8_t* data, int size) {
    if (data == nullptr || size <= 0) return static_cast<int>(Error::INVALID_ARGUMENT);

    std::FILE* file = std::fopen(kScratchPath, "wb");
    if (file == nullptr) return static_cast<int>(Error::INTERNAL);
    const bool written =
        std::fwrite(data, 1U, static_cast<std::size_t>(size), file) == static_cast<std::size_t>(size);
    std::fclose(file);
    if (!written) {
        std::remove(kScratchPath);
        return static_cast<int>(Error::INTERNAL);
    }

    const FirmwareProvider provider(kScratchPath);
    const Result<FirmwareImage> loaded = provider.load();

    // 残骸を残さない。ゼロ埋めしてから削除する。
    if (std::FILE* scrub = std::fopen(kScratchPath, "r+b"); scrub != nullptr) {
        const std::vector<std::uint8_t> zeros(static_cast<std::size_t>(size), 0U);
        std::fwrite(zeros.data(), 1U, zeros.size(), scrub);
        std::fclose(scrub);
    }
    std::remove(kScratchPath);

    return static_cast<int>(loaded ? Error::OK : loaded.error());
}

}  // extern "C"
