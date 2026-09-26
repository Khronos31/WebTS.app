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
inline constexpr std::uint16_t kW3U4ProductId = 0x083fU;
inline constexpr std::uint16_t kPxMlt5PeProductId = 0x024eU;
inline constexpr std::uint16_t kDtv02a5TsPProductId = 0x924eU;
inline constexpr std::uint16_t kPxW3Pe4ProductId = 0x023fU;
inline constexpr std::uint16_t kPxW3Pe5ProductId = 0x073fU;
inline constexpr std::uint16_t kPxQ3Pe4ProductId = 0x024aU;
inline constexpr std::uint16_t kPxQ3Pe5ProductId = 0x074aU;
inline constexpr std::uint16_t kPxMlt8Pe3ProductId = 0x0252U;
inline constexpr std::uint16_t kPxMlt8Pe5ProductId = 0x0253U;
inline constexpr std::uint16_t kDtv02a4TsPProductId = 0x0254U;
inline constexpr std::uint16_t kPxM1UrProductId = 0x0854U;
inline constexpr std::uint16_t kPxS1UrProductId = 0x0855U;
inline constexpr std::uint16_t kDtv03a1TuProductId = 0x0052U;
inline constexpr std::uint16_t kDtv021T1SuProductId = 0x004bU;
inline constexpr std::uint16_t kDtv02a1T1SuProductId = 0x084bU;

enum class DeviceModel : std::uint8_t {
    px_q3u4 = 0,
    px_mlt5pe = 1,
    dtv02a_5ts_p = 2,
    px_w3u4 = 3,
    px_w3pe4 = 4,
    px_w3pe5 = 5,
    px_q3pe4 = 6,
    px_q3pe5 = 7,
    px_mlt8pe3 = 8,
    px_mlt8pe5 = 9,
    dtv02a_4ts_p = 10,
    px_m1ur = 11,
    px_s1ur = 12,
    dtv03a_1tu = 13,
    dtv02_1t1s_u = 14,
    dtv02a_1t1s_u = 15,
};

// Fixed per-model enclosure shape and receiver capability. dual_system means
// every receiver selects ISDB-T or ISDB-S independently for each tune.
struct DeviceProfile final {
    DeviceModel model;
    std::uint16_t product_id;
    const char* name;
    std::uint8_t bridge_count;
    std::uint8_t receiver_count;
    bool dual_system;
};

const DeviceProfile* device_profile_for_usb_id(std::uint16_t vendor_id,
                                               std::uint16_t product_id) noexcept;
const DeviceProfile& device_profile(DeviceModel model) noexcept;
// Accepts the instance identifier of any supported model: a 14-digit Q3U4
// base serial, or a 15-digit W3U4 or MLT5-family USB serial.
bool valid_device_instance(std::string_view value) noexcept;

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

// One physical enclosure of any supported model.  base_serial is the model's
// instance identifier; a single-bridge model uses devices[0] only.
struct Q3U4Group final {
    std::string base_serial;
    std::array<std::optional<DeviceObservation>, 2U> devices;
    GroupStatus status = GroupStatus::incomplete;
    DeviceModel model = DeviceModel::px_q3u4;
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
