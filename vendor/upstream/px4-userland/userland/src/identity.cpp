// Modified/ported for px4-userland on 2026-09-02; MLT5 support added on 2026-09-24.
//
// Copyright (c) 2018-2021 nns779
// Derived from tsukumijima/px4_drv commit d748866f0da1cb3656106a520de4e9d7f073aacd (v0.6.1).
// Origin paths: driver/px4_device.c, driver/px4_usb.c, driver/px4_usb.h,
// winusb/src/DriverHost_PX4/px4_device.cpp.
// Source snapshot maintained by tsukumijima.
// SPDX-License-Identifier: GPL-2.0-only
#include "px4/identity.h"

#include <algorithm>
#include <charconv>
#include <utility>

namespace px4::userland {
namespace {

constexpr std::array<DeviceProfile, 16U> kDeviceProfiles{{
    {DeviceModel::px_q3u4, kQ3U4ProductId, "PX-Q3U4", 2U, 8U, false, true},
    {DeviceModel::px_w3u4, kW3U4ProductId, "PX-W3U4", 1U, 4U, false, true},
    {DeviceModel::px_mlt5pe, kPxMlt5PeProductId, "PX-MLT5PE", 1U, 5U, true, true},
    {DeviceModel::dtv02a_5ts_p, kDtv02a5TsPProductId, "DTV02A-5TS-P", 1U, 5U, true, true},
    {DeviceModel::px_w3pe4, kPxW3Pe4ProductId, "PX-W3PE4", 1U, 4U, false, true},
    {DeviceModel::px_w3pe5, kPxW3Pe5ProductId, "PX-W3PE5", 1U, 4U, false, true},
    {DeviceModel::px_q3pe4, kPxQ3Pe4ProductId, "PX-Q3PE4", 2U, 8U, false, true},
    {DeviceModel::px_q3pe5, kPxQ3Pe5ProductId, "PX-Q3PE5", 2U, 8U, false, true},
    {DeviceModel::px_mlt8pe3, kPxMlt8Pe3ProductId, "PX-MLT8PE3", 1U, 3U, true, true},
    {DeviceModel::px_mlt8pe5, kPxMlt8Pe5ProductId, "PX-MLT8PE5", 1U, 5U, true, true},
    {DeviceModel::dtv02a_4ts_p, kDtv02a4TsPProductId, "DTV02A-4TS-P", 1U, 4U, true, true},
    {DeviceModel::px_m1ur, kPxM1UrProductId, "PX-M1UR", 1U, 1U, true, false},
    {DeviceModel::px_s1ur, kPxS1UrProductId, "PX-S1UR", 1U, 1U, false, false},
    {DeviceModel::dtv03a_1tu, kDtv03a1TuProductId, "DTV03A-1TU", 1U, 1U, false, false},
    {DeviceModel::dtv02_1t1s_u, kDtv021T1SuProductId, "DTV02-1T1S-U", 1U, 1U, true, false},
    {DeviceModel::dtv02a_1t1s_u, kDtv02a1T1SuProductId, "DTV02A-1T1S-U", 1U, 1U, true, false},
}};

constexpr std::size_t kQ3U4BaseSerialLength = 14U;
constexpr std::size_t kUsbSerialLength = 15U;

bool all_digits(std::string_view value) noexcept
{
    for (const char character : value) {
        if (character < '0' || character > '9') {
            return false;
        }
    }
    return true;
}

// Enclosure identity of one observed USB device: the instance identifier and
// the bridge slot inside that enclosure.
struct GroupKey final {
    std::string base_serial;
    std::size_t slot = 0U;
    DeviceModel model = DeviceModel::px_q3u4;
};

Result<GroupKey> group_key(const DeviceObservation& observation) noexcept
{
    const DeviceProfile* profile =
        device_profile_for_usb_id(observation.vendor_id, observation.product_id);
    if (profile == nullptr) {
        return Result<GroupKey>::failure(Error::UNSUPPORTED);
    }
    GroupKey key;
    key.model = profile->model;
    if (profile->bridge_count == 2U) {
        const auto parsed = parse_q3u4_serial(observation.serial);
        if (!parsed) {
            return Result<GroupKey>::failure(parsed.error());
        }
        key.base_serial = parsed.value().base_serial;
        key.slot = static_cast<std::size_t>(parsed.value().dev_id - 1U);
        return Result<GroupKey>::success(std::move(key));
    }
    // The single-bridge serial is the whole identifier; its last digit is
    // not a bridge number.
    if (observation.serial.size() != kUsbSerialLength || !all_digits(observation.serial)) {
        return Result<GroupKey>::failure(Error::INVALID_ARGUMENT);
    }
    key.base_serial = observation.serial;
    return Result<GroupKey>::success(std::move(key));
}

bool endpoint_matches(const UsbInterfaceObservation& interface,
                      std::uint8_t address) noexcept
{
    std::size_t matches = 0U;
    for (const UsbEndpointObservation& endpoint : interface.endpoints) {
        if (endpoint.address == address) {
            if (endpoint.type != EndpointType::bulk || endpoint.max_packet_size != 512U) {
                return false;
            }
            ++matches;
        }
    }
    return matches == 1U;
}

const UsbInterfaceObservation* interface_zero_alt_zero(
    const UsbTopologyObservation& topology) noexcept
{
    const UsbInterfaceObservation* found = nullptr;
    for (const UsbInterfaceObservation& interface : topology.interfaces) {
        if (interface.number == 0U && interface.alternate_setting == 0U) {
            if (found != nullptr) {
                return nullptr;
            }
            found = &interface;
        }
    }
    return found;
}

bool location_less(const UsbLocation& left, const UsbLocation& right) noexcept
{
    const auto left_key = std::array<std::uint16_t, 3U>{
        static_cast<std::uint16_t>(left.has_bus ? left.bus : 0U),
        static_cast<std::uint16_t>(left.has_address ? left.address : 0U),
        static_cast<std::uint16_t>(left.port_count)};
    const auto right_key = std::array<std::uint16_t, 3U>{
        static_cast<std::uint16_t>(right.has_bus ? right.bus : 0U),
        static_cast<std::uint16_t>(right.has_address ? right.address : 0U),
        static_cast<std::uint16_t>(right.port_count)};
    if (left_key != right_key) {
        return left_key < right_key;
    }
    return left.port_path < right.port_path;
}

bool observation_less(const DeviceObservation& left, const DeviceObservation& right) noexcept
{
    const auto left_key = group_key(left);
    const auto right_key = group_key(right);
    if (left_key.value().base_serial != right_key.value().base_serial) {
        return left_key.value().base_serial < right_key.value().base_serial;
    }
    if (left_key.value().model != right_key.value().model) {
        return left_key.value().model < right_key.value().model;
    }
    if (left_key.value().slot != right_key.value().slot) {
        return left_key.value().slot < right_key.value().slot;
    }
    return location_less(left.location, right.location);
}

struct ParsedUsbPath final {
    std::uint8_t bus = 0U;
    std::uint8_t address = 0U;
    bool by_address = false;
    std::array<std::uint8_t, 8U> ports{};
    std::size_t port_count = 0U;
};

Result<ParsedUsbPath> parse_usb_path(std::string_view text) noexcept
{
    ParsedUsbPath path;
    const std::size_t separator = text.find_first_of(":-");
    if (separator == std::string_view::npos || separator == 0U ||
        separator + 1U >= text.size())
        return Result<ParsedUsbPath>::failure(Error::INVALID_ARGUMENT);
    auto parse_byte = [](std::string_view part, std::uint8_t& output) noexcept {
        if (part.empty()) return false;
        unsigned int number = 0U;
        const auto parsed = std::from_chars(part.data(), part.data() + part.size(), number);
        if (parsed.ec != std::errc{} || parsed.ptr != part.data() + part.size() ||
            number == 0U || number > 255U) return false;
        output = static_cast<std::uint8_t>(number);
        return true;
    };
    if (!parse_byte(text.substr(0U, separator), path.bus))
        return Result<ParsedUsbPath>::failure(Error::INVALID_ARGUMENT);
    path.by_address = text[separator] == ':';
    if (path.by_address) {
        if (!parse_byte(text.substr(separator + 1U), path.address))
            return Result<ParsedUsbPath>::failure(Error::INVALID_ARGUMENT);
        return Result<ParsedUsbPath>::success(path);
    }
    std::size_t begin = separator + 1U;
    while (begin < text.size()) {
        const std::size_t end = text.find('.', begin);
        if (path.port_count == path.ports.size() ||
            !parse_byte(text.substr(begin, end == std::string_view::npos ? end : end - begin),
                        path.ports[path.port_count]))
            return Result<ParsedUsbPath>::failure(Error::INVALID_ARGUMENT);
        ++path.port_count;
        if (end == std::string_view::npos)
            return Result<ParsedUsbPath>::success(path);
        begin = end + 1U;
    }
    return Result<ParsedUsbPath>::failure(Error::INVALID_ARGUMENT);
}

bool path_matches(const ParsedUsbPath& path, const UsbLocation& location) noexcept
{
    if (!location.has_bus || location.bus != path.bus) return false;
    if (path.by_address)
        return location.has_address && location.address == path.address;
    return location.port_count == path.port_count && path.port_count != 0U &&
           std::equal(path.ports.begin(), path.ports.begin() + path.port_count,
                      location.port_path.begin());
}

}  // namespace

const DeviceProfile* device_profile_for_usb_id(std::uint16_t vendor_id,
                                               std::uint16_t product_id) noexcept
{
    if (vendor_id != kQ3U4VendorId) {
        return nullptr;
    }
    for (const DeviceProfile& profile : kDeviceProfiles) {
        if (profile.product_id == product_id) {
            return &profile;
        }
    }
    return nullptr;
}

const DeviceProfile& device_profile(DeviceModel model) noexcept
{
    for (const DeviceProfile& profile : kDeviceProfiles) {
        if (profile.model == model) {
            return profile;
        }
    }
    return kDeviceProfiles[0];
}

bool valid_device_instance(std::string_view value) noexcept
{
    return (value.size() == kQ3U4BaseSerialLength || value.size() == kUsbSerialLength) &&
           all_digits(value);
}

bool valid_runtime_instance(std::string_view value) noexcept
{
    if (value.empty() || value.size() > 80U || value == "." || value == "..") return false;
    for (const unsigned char character : value) {
        const bool accepted = (character >= '0' && character <= '9') ||
                              (character >= 'a' && character <= 'z') ||
                              (character >= 'A' && character <= 'Z') ||
                              character == '_' || character == '-' || character == '.';
        if (!accepted) return false;
    }
    return true;
}

Result<ParsedQ3U4Serial> parse_q3u4_serial(std::string_view serial) noexcept
{
    if (serial.size() != 15U) {
        return Result<ParsedQ3U4Serial>::failure(Error::INVALID_ARGUMENT);
    }
    for (const char character : serial) {
        if (character < '0' || character > '9') {
            return Result<ParsedQ3U4Serial>::failure(Error::INVALID_ARGUMENT);
        }
    }
    if (serial.back() != '1' && serial.back() != '2') {
        return Result<ParsedQ3U4Serial>::failure(Error::INVALID_ARGUMENT);
    }

    ParsedQ3U4Serial parsed;
    parsed.base_serial.assign(serial.data(), serial.size() - 1U);
    parsed.dev_id = static_cast<std::uint8_t>(serial.back() - '0');
    return Result<ParsedQ3U4Serial>::success(std::move(parsed));
}

bool q3u4_speed_is_usable(UsbSpeed speed) noexcept
{
    return speed == UsbSpeed::high || speed == UsbSpeed::super ||
           speed == UsbSpeed::super_plus || speed == UsbSpeed::super_plus_x2;
}

bool q3u4_topology_is_usable(const UsbTopologyObservation& topology) noexcept
{
    const UsbInterfaceObservation* interface = interface_zero_alt_zero(topology);
    if (interface == nullptr || interface->endpoints.size() != 4U) {
        return false;
    }
    // 0x85は観測したbulk IN endpointとして検証するが、プロトコル経路では使用しない。
    constexpr std::array<std::uint8_t, 4U> required_endpoints{0x81U, 0x02U, 0x84U, 0x85U};
    for (const std::uint8_t endpoint : required_endpoints) {
        if (!endpoint_matches(*interface, endpoint)) {
            return false;
        }
    }
    return true;
}

ObservationStatus validate_q3u4_observation(const DeviceObservation& observation) noexcept
{
    if (device_profile_for_usb_id(observation.vendor_id, observation.product_id) == nullptr) {
        return ObservationStatus::unsupported;
    }
    if (!group_key(observation)) {
        return ObservationStatus::invalid_serial;
    }
    if (!q3u4_speed_is_usable(observation.speed)) {
        return ObservationStatus::insufficient_speed;
    }
    if (!q3u4_topology_is_usable(observation.topology)) {
        return ObservationStatus::invalid_topology;
    }
    return ObservationStatus::usable;
}

Error observation_status_error(ObservationStatus status) noexcept
{
    switch (status) {
    case ObservationStatus::usable:
        return Error::OK;
    case ObservationStatus::unsupported:
    case ObservationStatus::insufficient_speed:
        return Error::UNSUPPORTED;
    case ObservationStatus::invalid_serial:
    case ObservationStatus::invalid_topology:
        return Error::INVALID_ARGUMENT;
    case ObservationStatus::open_failed:
        return Error::USB_IO;
    }
    return Error::INTERNAL;
}

Result<GroupingResult> group_q3u4_devices(const std::vector<DeviceObservation>& observations) noexcept
{
    GroupingResult result;
    std::vector<std::size_t> sorted;
    for (std::size_t index = 0U; index < observations.size(); ++index) {
        const DeviceObservation& observation = observations[index];
        const ObservationStatus status = validate_q3u4_observation(observation);
        if (status == ObservationStatus::unsupported || status == ObservationStatus::invalid_serial) {
            result.rejected.push_back(RejectedObservation{status, observation});
            continue;
        }
        sorted.push_back(index);
    }
    std::sort(sorted.begin(), sorted.end(), [&observations](std::size_t left,
                                                              std::size_t right) {
        return observation_less(observations[left], observations[right]);
    });

    for (const std::size_t index : sorted) {
        const DeviceObservation& observation = observations[index];
        const auto key = group_key(observation);
        if (!key) {
            return Result<GroupingResult>::failure(Error::INTERNAL);
        }
        const DeviceProfile& profile = device_profile(key.value().model);
        auto group = profile.bridge_count == 1U ? result.groups.end() :
            std::find_if(result.groups.begin(), result.groups.end(),
                         [&key](const Q3U4Group& candidate) {
                             return candidate.base_serial == key.value().base_serial &&
                                    candidate.model == key.value().model;
                         });
        if (group == result.groups.end()) {
            result.groups.push_back(Q3U4Group{});
            group = std::prev(result.groups.end());
            group->base_serial = key.value().base_serial;
            group->model = key.value().model;
        }
        const std::size_t slot = key.value().slot;
        group->candidates.push_back(Q3U4Group::Candidate{
            index, static_cast<std::uint8_t>(slot + 1U), observation});
        if (group->devices[slot].has_value()) {
            group->status = GroupStatus::duplicate;
        } else {
            group->devices[slot] = observation;
            group->candidate_indices[slot] = index;
        }
        if (validate_q3u4_observation(observation) != ObservationStatus::usable &&
            group->status != GroupStatus::duplicate) {
            group->status = GroupStatus::invalid_observation;
        }
    }

    for (Q3U4Group& group : result.groups) {
        if (group.status == GroupStatus::duplicate ||
            group.status == GroupStatus::invalid_observation) {
            continue;
        }
        bool complete = true;
        for (std::size_t slot = 0U; slot < device_profile(group.model).bridge_count; ++slot) {
            complete = complete && group.devices[slot].has_value();
        }
        group.status = complete ? GroupStatus::ready : GroupStatus::incomplete;
    }
    std::sort(result.groups.begin(), result.groups.end(),
              [](const Q3U4Group& left, const Q3U4Group& right) {
                  if (left.base_serial != right.base_serial)
                      return left.base_serial < right.base_serial;
                  if (left.model != right.model) return left.model < right.model;
                  if (left.candidates.empty() || right.candidates.empty()) return false;
                  return location_less(left.candidates.front().observation.location,
                                       right.candidates.front().observation.location);
              });
    return Result<GroupingResult>::success(std::move(result));
}

Result<std::size_t> select_ready_q3u4_group(const GroupingResult& grouping,
                                            std::string_view base_serial) noexcept
{
    if (!base_serial.empty() && !valid_device_instance(base_serial)) {
        return Result<std::size_t>::failure(Error::INVALID_ARGUMENT);
    }

    std::size_t ready_count = 0U;
    std::size_t matching_count = 0U;
    std::size_t matching_ready_count = 0U;
    std::size_t selected = 0U;
    for (std::size_t index = 0U; index < grouping.groups.size(); ++index) {
        const Q3U4Group& group = grouping.groups[index];
        if (!base_serial.empty() && group.base_serial == base_serial) {
            ++matching_count;
            if (group.status == GroupStatus::ready) ++matching_ready_count;
        }
        if (group.status != GroupStatus::ready) {
            continue;
        }
        ++ready_count;
        if (base_serial.empty() || group.base_serial == base_serial) {
            selected = index;
        }
    }
    if (!base_serial.empty())
        return matching_count == 0U ? Result<std::size_t>::failure(Error::NOT_FOUND) :
               matching_count == 1U && matching_ready_count == 1U ?
                   Result<std::size_t>::success(selected) :
                   Result<std::size_t>::failure(Error::INVALID_ARGUMENT);
    if (ready_count == 0U) {
        return Result<std::size_t>::failure(Error::NOT_FOUND);
    }
    return ready_count == 1U ? Result<std::size_t>::success(selected)
                             : Result<std::size_t>::failure(Error::INVALID_ARGUMENT);
}

Result<SelectedQ3U4Group> select_q3u4_group_by_usb_paths(
    const GroupingResult& grouping, std::string_view base_serial,
    const std::vector<std::string>& usb_paths) noexcept
{
    if ((!base_serial.empty() && !valid_device_instance(base_serial)) ||
        usb_paths.empty() || usb_paths.size() > 2U)
        return Result<SelectedQ3U4Group>::failure(Error::INVALID_ARGUMENT);

    std::array<ParsedUsbPath, 2U> parsed{};
    std::array<std::size_t, 2U> groups{};
    std::array<std::size_t, 2U> candidate_positions{};
    for (std::size_t path_index = 0U; path_index < usb_paths.size(); ++path_index) {
        const auto path = parse_usb_path(usb_paths[path_index]);
        if (!path) return Result<SelectedQ3U4Group>::failure(path.error());
        parsed[path_index] = path.value();
        std::size_t matches = 0U;
        for (std::size_t group_index = 0U; group_index < grouping.groups.size(); ++group_index) {
            const Q3U4Group& group = grouping.groups[group_index];
            for (std::size_t candidate_index = 0U; candidate_index < group.candidates.size();
                 ++candidate_index) {
                if (path_matches(parsed[path_index],
                                 group.candidates[candidate_index].observation.location)) {
                    groups[path_index] = group_index;
                    candidate_positions[path_index] = candidate_index;
                    ++matches;
                }
            }
        }
        if (matches != 1U) return Result<SelectedQ3U4Group>::failure(Error::INVALID_ARGUMENT);
    }
    if (usb_paths.size() == 2U &&
        groups[0U] != groups[1U])
        return Result<SelectedQ3U4Group>::failure(Error::INVALID_ARGUMENT);
    const Q3U4Group& group = grouping.groups[groups[0U]];
    const DeviceProfile& profile = device_profile(group.model);
    if (profile.bridge_count != usb_paths.size() ||
        (!base_serial.empty() && group.base_serial != base_serial))
        return Result<SelectedQ3U4Group>::failure(Error::INVALID_ARGUMENT);

    SelectedQ3U4Group selected;
    selected.group_index = groups[0U];
    std::array<bool, 2U> occupied{{false, false}};
    for (std::size_t index = 0U; index < usb_paths.size(); ++index) {
        const Q3U4Group::Candidate& candidate = group.candidates[candidate_positions[index]];
        const std::size_t slot = candidate.device - 1U;
        if (slot >= profile.bridge_count || occupied[slot] ||
            validate_q3u4_observation(candidate.observation) != ObservationStatus::usable)
            return Result<SelectedQ3U4Group>::failure(Error::INVALID_ARGUMENT);
        occupied[slot] = true;
        selected.candidate_indices[slot] = candidate.observation_index;
    }
    return Result<SelectedQ3U4Group>::success(selected);
}

const char* observation_status_string(ObservationStatus status) noexcept
{
    switch (status) {
    case ObservationStatus::usable:
        return "usable";
    case ObservationStatus::unsupported:
        return "unsupported";
    case ObservationStatus::invalid_serial:
        return "invalid_serial";
    case ObservationStatus::insufficient_speed:
        return "insufficient_speed";
    case ObservationStatus::invalid_topology:
        return "invalid_topology";
    case ObservationStatus::open_failed:
        return "open_failed";
    }
    return "unknown";
}

const char* group_status_string(GroupStatus status) noexcept
{
    switch (status) {
    case GroupStatus::ready:
        return "ready";
    case GroupStatus::incomplete:
        return "incomplete";
    case GroupStatus::duplicate:
        return "duplicate";
    case GroupStatus::invalid_observation:
        return "invalid_observation";
    }
    return "unknown";
}

}  // namespace px4::userland
