/* Build-only ABI seam for the upstream PX4 native enumeration implementation. */
#include "px4/libusb_transport.h"
#include <libusb.h>

#include <cstdint>
#include <array>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace {

constexpr std::uint32_t kByteMask = 0xffU;

void LIBUSB_CALL discard_libusb_log(libusb_context*, enum libusb_log_level, const char*)
{
    // Keep raw backend diagnostics inside the build-only seam. The exported
    // result contains only the fixed error enum and aggregate counters.
}

std::uint32_t saturate_byte(std::size_t value) noexcept
{
    return value > kByteMask ? kByteMask : static_cast<std::uint32_t>(value);
}

std::uint32_t pack_summary(px4::userland::Error error, std::size_t candidates,
                           std::size_t ready, std::size_t incomplete) noexcept
{
    return static_cast<std::uint32_t>(error) |
           (saturate_byte(candidates) << 8U) |
           (saturate_byte(ready) << 16U) |
           (saturate_byte(incomplete) << 24U);
}

px4::userland::DeviceObservation mock_observation(std::string serial,
                                                   std::uint8_t address) noexcept
{
    px4::userland::DeviceObservation observation;
    observation.vendor_id = px4::userland::kQ3U4VendorId;
    observation.product_id = px4::userland::kQ3U4ProductId;
    observation.serial = std::move(serial);
    observation.speed = px4::userland::UsbSpeed::high;
    observation.location.has_bus = true;
    observation.location.has_address = true;
    observation.location.bus = 1U;
    observation.location.address = address;
    observation.topology.interfaces.push_back(px4::userland::UsbInterfaceObservation{
        0U,
        0U,
        {
            {0x81U, px4::userland::EndpointType::bulk, 512U},
            {0x02U, px4::userland::EndpointType::bulk, 512U},
            {0x84U, px4::userland::EndpointType::bulk, 512U},
            {0x85U, px4::userland::EndpointType::bulk, 512U},
        },
    });
    return observation;
}

}  // namespace

// The packed result contains only fixed Error and bounded aggregate counters:
// bits 0..7=Error, 8..15=candidates, 16..23=ready groups, 24..31=incomplete
// groups. No serial, topology, path, or payload data crosses this seam. The
// callback below suppresses raw libusb logs before upstream initialization.
//
// This function is exported for a future Asyncify/ccall integration test only.
// It is not called by the current UI and is deliberately not a USB-safe
// operation: upstream enumeration may temporarily open devices and read
// standard descriptors. A JS caller must use Module.ccall(..., {async:true}).
extern "C" std::uint32_t webts_px4_enumerate_native_summary() noexcept
{
    // enumerate_native() creates libusb context/session internally, so the
    // global callback must be installed before entering the upstream code.
    libusb_set_log_cb(nullptr, discard_libusb_log, LIBUSB_LOG_CB_GLOBAL);
    const auto result = px4::userland::Q3U4Runtime::enumerate_native();
    if (!result) {
        return pack_summary(result.error(), 0U, 0U, 0U);
    }

    const auto& grouping = result.value();
    std::size_t candidates = grouping.rejected.size();
    std::size_t ready = 0U;
    std::size_t incomplete = 0U;
    for (const auto& group : grouping.groups) {
        for (const std::optional<px4::userland::DeviceObservation>& device : group.devices) {
            if (device.has_value()) {
                ++candidates;
            }
        }
        switch (group.status) {
        case px4::userland::GroupStatus::ready:
            ++ready;
            break;
        case px4::userland::GroupStatus::incomplete:
            ++incomplete;
            break;
        case px4::userland::GroupStatus::duplicate:
        case px4::userland::GroupStatus::invalid_observation:
            break;
        }
    }
    return pack_summary(px4::userland::Error::OK, candidates, ready, incomplete);
}

/*
 * Pure identity/grouping seam. The observations are synthetic and are passed
 * through the vendored group_q3u4_devices() implementation; no libusb,
 * serial descriptor, interface claim, command, firmware, or TS path runs.
 * scenario 0=one ready pair, 1=one incomplete group, 2=duplicate slot,
 * 3=two independent ready groups. Other values return INVALID_ARGUMENT.
 * The packed result is the same fixed aggregate shape as the native summary.
 */
extern "C" std::uint32_t webts_px4_grouping_mock_summary(std::uint32_t scenario) noexcept
{
    std::vector<px4::userland::DeviceObservation> observations;
    switch (scenario) {
    case 0U:
        observations.emplace_back(mock_observation("123456789012341", 1U));
        observations.emplace_back(mock_observation("123456789012342", 2U));
        break;
    case 1U:
        observations.emplace_back(mock_observation("123456789012341", 1U));
        break;
    case 2U:
        observations.emplace_back(mock_observation("123456789012341", 1U));
        observations.emplace_back(mock_observation("123456789012341", 3U));
        observations.emplace_back(mock_observation("123456789012342", 2U));
        break;
    case 3U:
        observations.emplace_back(mock_observation("123456789012341", 1U));
        observations.emplace_back(mock_observation("123456789012342", 2U));
        observations.emplace_back(mock_observation("987654321098761", 3U));
        observations.emplace_back(mock_observation("987654321098762", 4U));
        break;
    default:
        return pack_summary(px4::userland::Error::INVALID_ARGUMENT, 0U, 0U, 0U);
    }

    const auto grouping = px4::userland::group_q3u4_devices(observations);
    if (!grouping)
        return pack_summary(grouping.error(), 0U, 0U, 0U);

    std::size_t ready = 0U;
    std::size_t incomplete = 0U;
    for (const auto& group : grouping.value().groups) {
        if (group.status == px4::userland::GroupStatus::ready)
            ++ready;
        else if (group.status == px4::userland::GroupStatus::incomplete)
            ++incomplete;
    }
    return pack_summary(px4::userland::Error::OK, observations.size(), ready, incomplete);
}
