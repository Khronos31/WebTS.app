// PX-Q3U4 の識別を、同梱した上流 (px4/identity.h, identity.cpp) にそのまま
// 行わせるための境界。ブラウザ側は上流の判定ロジックを書き写さない。
//
// ABI は固定の数値だけを返す。serial は入力としてのみ受け取り、出力には
// 一切含めない。base_serial も返さない。

#include "px4/identity.h"

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace {

using namespace px4::userland;

// 入力バッファ（リトルエンディアン）:
//   u32 deviceCount
//   per device:
//     u16 vendorId, u16 productId, u8 speed, u8 serialLength, bytes serial
//     u8 interfaceCount
//       per interface: u8 number, u8 alternateSetting, u8 endpointCount
//         per endpoint: u8 address, u8 type, u16 maxPacketSize
class Reader final {
public:
    Reader(const std::uint8_t* data, std::size_t size) noexcept : data_(data), size_(size) {}

    bool ok() const noexcept { return ok_; }

    std::uint8_t u8() noexcept {
        if (offset_ + 1U > size_) { ok_ = false; return 0U; }
        return data_[offset_++];
    }

    std::uint16_t u16() noexcept {
        const std::uint8_t low = u8();
        const std::uint8_t high = u8();
        return static_cast<std::uint16_t>(low | (high << 8));
    }

    std::uint32_t u32() noexcept {
        const std::uint16_t low = u16();
        const std::uint16_t high = u16();
        return static_cast<std::uint32_t>(low) | (static_cast<std::uint32_t>(high) << 16);
    }

    std::string bytes(std::size_t count) {
        if (offset_ + count > size_) { ok_ = false; return {}; }
        std::string out(reinterpret_cast<const char*>(data_ + offset_), count);
        offset_ += count;
        return out;
    }

private:
    const std::uint8_t* data_;
    std::size_t size_;
    std::size_t offset_ = 0U;
    bool ok_ = true;
};

constexpr int kOutputWords = 10;

enum OutputWord : int {
    kWordError = 0,
    kWordGroupCount = 1,
    kWordReadyGroups = 2,
    kWordIncompleteGroups = 3,
    kWordRejectedCount = 4,
    kWordFirstRejectedStatus = 5,
    kWordGroup0Status = 6,
    kWordGroup0Slot1Present = 7,
    kWordGroup0Slot2Present = 8,
    kWordUsableObservations = 9,
};

bool decode(Reader& reader, std::vector<DeviceObservation>& out) {
    const std::uint32_t count = reader.u32();
    if (!reader.ok() || count > 64U) return false;
    out.reserve(count);
    for (std::uint32_t index = 0U; index < count; ++index) {
        DeviceObservation observation;
        observation.vendor_id = reader.u16();
        observation.product_id = reader.u16();
        const std::uint8_t speed = reader.u8();
        if (speed > static_cast<std::uint8_t>(UsbSpeed::super_plus_x2)) return false;
        observation.speed = static_cast<UsbSpeed>(speed);
        const std::uint8_t serial_length = reader.u8();
        observation.serial = reader.bytes(serial_length);
        const std::uint8_t interface_count = reader.u8();
        if (!reader.ok() || interface_count > 32U) return false;
        for (std::uint8_t i = 0U; i < interface_count; ++i) {
            UsbInterfaceObservation interface;
            interface.number = reader.u8();
            interface.alternate_setting = reader.u8();
            const std::uint8_t endpoint_count = reader.u8();
            if (!reader.ok() || endpoint_count > 32U) return false;
            for (std::uint8_t e = 0U; e < endpoint_count; ++e) {
                UsbEndpointObservation endpoint;
                endpoint.address = reader.u8();
                const std::uint8_t type = reader.u8();
                endpoint.type = type == static_cast<std::uint8_t>(EndpointType::bulk)
                    ? EndpointType::bulk : EndpointType::other;
                endpoint.max_packet_size = reader.u16();
                interface.endpoints.push_back(endpoint);
            }
            observation.topology.interfaces.push_back(std::move(interface));
        }
        // location は埋めない。observation_less の最終タイブレークにしか使われず、
        // 有効な1グループ内では dev_id が 1 と 2 に分かれるため結果を左右しない。
        // WebUSB は bus/address/port path を公開していない。
        if (!reader.ok()) return false;
        out.push_back(std::move(observation));
    }
    return reader.ok();
}

}  // namespace

extern "C" {

std::uint32_t webts_px4_q3u4_vendor_id(void) {
    return kQ3U4VendorId;
}

std::uint32_t webts_px4_q3u4_product_id(void) {
    return kQ3U4ProductId;
}

int webts_px4_identity_output_words(void) {
    return kOutputWords;
}

/**
 * 観測列を上流の group_q3u4_devices() へ渡し、固定の集計だけを返す。
 * 戻り値は Error の数値。serial と base_serial は出力に含めない。
 */
int webts_px4_group_q3u4(const std::uint8_t* input, int input_size,
                         std::int32_t* output, int output_words) {
    if (output == nullptr || output_words != kOutputWords) {
        return static_cast<int>(Error::INVALID_ARGUMENT);
    }
    for (int i = 0; i < kOutputWords; ++i) output[i] = -1;
    if (input == nullptr || input_size <= 0) {
        output[kWordError] = static_cast<std::int32_t>(Error::INVALID_ARGUMENT);
        return static_cast<int>(Error::INVALID_ARGUMENT);
    }

    std::vector<DeviceObservation> observations;
    Reader reader(input, static_cast<std::size_t>(input_size));
    if (!decode(reader, observations)) {
        output[kWordError] = static_cast<std::int32_t>(Error::INVALID_ARGUMENT);
        return static_cast<int>(Error::INVALID_ARGUMENT);
    }

    std::int32_t usable = 0;
    for (const DeviceObservation& observation : observations) {
        if (validate_q3u4_observation(observation) == ObservationStatus::usable) usable++;
    }

    const Result<GroupingResult> grouped = group_q3u4_devices(observations);
    if (!grouped) {
        output[kWordError] = static_cast<std::int32_t>(grouped.error());
        return static_cast<int>(grouped.error());
    }
    const GroupingResult& result = grouped.value();

    std::int32_t ready = 0;
    std::int32_t incomplete = 0;
    for (const Q3U4Group& group : result.groups) {
        if (group.status == GroupStatus::ready) ready++;
        else if (group.status == GroupStatus::incomplete) incomplete++;
    }

    output[kWordError] = static_cast<std::int32_t>(Error::OK);
    output[kWordGroupCount] = static_cast<std::int32_t>(result.groups.size());
    output[kWordReadyGroups] = ready;
    output[kWordIncompleteGroups] = incomplete;
    output[kWordRejectedCount] = static_cast<std::int32_t>(result.rejected.size());
    output[kWordFirstRejectedStatus] = result.rejected.empty()
        ? -1 : static_cast<std::int32_t>(result.rejected.front().status);
    output[kWordUsableObservations] = usable;
    if (!result.groups.empty()) {
        const Q3U4Group& first = result.groups.front();
        output[kWordGroup0Status] = static_cast<std::int32_t>(first.status);
        output[kWordGroup0Slot1Present] = first.devices[0].has_value() ? 1 : 0;
        output[kWordGroup0Slot2Present] = first.devices[1].has_value() ? 1 : 0;
    }
    return static_cast<int>(Error::OK);
}

}  // extern "C"
