// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_IDENTITY_H
#define PX4_USERLAND_IDENTITY_H

#include "px4/error.h"

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace px4::userland {

inline constexpr std::uint16_t kQ3U4VendorId = 0x0511U;
inline constexpr std::uint16_t kQ3U4ProductId = 0x084aU;

enum class UsbSpeed : std::uint8_t {
    unknown = 0,
    low = 1,
    full = 2,
    high = 3,
    super = 4,
    super_plus = 5,
    super_plus_x2 = 6,
};

enum class EndpointType : std::uint8_t {
    other = 0,
    bulk = 2,
};

struct UsbEndpointObservation final {
    std::uint8_t address = 0U;
    EndpointType type = EndpointType::other;
    std::uint16_t max_packet_size = 0U;
};

struct UsbInterfaceObservation final {
    std::uint8_t number = 0U;
    std::uint8_t alternate_setting = 0U;
    std::vector<UsbEndpointObservation> endpoints;
};

struct UsbTopologyObservation final {
    std::vector<UsbInterfaceObservation> interfaces;
};

struct UsbLocation final {
    bool has_bus = false;
    bool has_address = false;
    std::uint8_t bus = 0U;
    std::uint8_t address = 0U;
    std::array<std::uint8_t, 8U> port_path{};
    std::uint8_t port_count = 0U;
};

struct DeviceObservation final {
    std::uint16_t vendor_id = 0U;
    std::uint16_t product_id = 0U;
    std::string serial;
    UsbSpeed speed = UsbSpeed::unknown;
    UsbLocation location;
    UsbTopologyObservation topology;
};

struct ParsedQ3U4Serial final {
    std::string base_serial;
    std::uint8_t dev_id = 0U;
};

enum class ObservationStatus : std::uint8_t {
    usable = 0,
    unsupported = 1,
    invalid_serial = 2,
    insufficient_speed = 3,
    invalid_topology = 4,
    open_failed = 5,
};

Result<ParsedQ3U4Serial> parse_q3u4_serial(std::string_view serial) noexcept;
ObservationStatus validate_q3u4_observation(const DeviceObservation& observation) noexcept;
Error observation_status_error(ObservationStatus status) noexcept;
bool q3u4_topology_is_usable(const UsbTopologyObservation& topology) noexcept;
bool q3u4_speed_is_usable(UsbSpeed speed) noexcept;

enum class GroupStatus : std::uint8_t {
    ready = 0,
    incomplete = 1,
    duplicate = 2,
    invalid_observation = 3,
};

struct RejectedObservation final {
    ObservationStatus status = ObservationStatus::unsupported;
    DeviceObservation observation;
};

struct Q3U4Group final {
    std::string base_serial;
    std::array<std::optional<DeviceObservation>, 2U> devices;
    GroupStatus status = GroupStatus::incomplete;
};

struct GroupingResult final {
    std::vector<Q3U4Group> groups;
    std::vector<RejectedObservation> rejected;
};

Result<GroupingResult> group_q3u4_devices(const std::vector<DeviceObservation>& observations) noexcept;
Result<std::size_t> select_ready_q3u4_group(const GroupingResult& grouping,
                                            std::string_view base_serial) noexcept;
const char* observation_status_string(ObservationStatus status) noexcept;
const char* group_status_string(GroupStatus status) noexcept;

}  // namespace px4::userland

#endif  // PX4_USERLAND_IDENTITY_H
