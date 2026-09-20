// Modified/ported for px4-userland on 2026-09-02.
//
// Copyright (c) 2018-2021 nns779
// Derived from tsukumijima/px4_drv commit 9eedea8c502875a788697984b93b50032339b9aa.
// Origin paths: driver/px4_device.c, driver/px4_usb.c,
// winusb/src/DriverHost_PX4/px4_device.cpp.
// Source snapshot maintained by tsukumijima.
// SPDX-License-Identifier: GPL-2.0-only
#include "px4/identity.h"

#include <algorithm>
#include <utility>

namespace px4::userland {
namespace {

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
    const auto left_serial = parse_q3u4_serial(left.serial);
    const auto right_serial = parse_q3u4_serial(right.serial);
    if (left_serial.value().base_serial != right_serial.value().base_serial) {
        return left_serial.value().base_serial < right_serial.value().base_serial;
    }
    if (left_serial.value().dev_id != right_serial.value().dev_id) {
        return left_serial.value().dev_id < right_serial.value().dev_id;
    }
    return location_less(left.location, right.location);
}

}  // namespace

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
    if (observation.vendor_id != kQ3U4VendorId || observation.product_id != kQ3U4ProductId) {
        return ObservationStatus::unsupported;
    }
    if (!parse_q3u4_serial(observation.serial)) {
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
    std::vector<DeviceObservation> sorted;
    for (const DeviceObservation& observation : observations) {
        const ObservationStatus status = validate_q3u4_observation(observation);
        if (status == ObservationStatus::unsupported || status == ObservationStatus::invalid_serial) {
            result.rejected.push_back(RejectedObservation{status, observation});
            continue;
        }
        sorted.push_back(observation);
    }
    std::sort(sorted.begin(), sorted.end(), observation_less);

    for (const DeviceObservation& observation : sorted) {
        const auto parsed = parse_q3u4_serial(observation.serial);
        if (!parsed) {
            return Result<GroupingResult>::failure(Error::INTERNAL);
        }
        auto group = std::find_if(result.groups.begin(), result.groups.end(),
                                  [&parsed](const Q3U4Group& candidate) {
                                      return candidate.base_serial == parsed.value().base_serial;
                                  });
        if (group == result.groups.end()) {
            result.groups.push_back(Q3U4Group{});
            group = std::prev(result.groups.end());
            group->base_serial = parsed.value().base_serial;
        }
        const std::size_t slot = static_cast<std::size_t>(parsed.value().dev_id - 1U);
        if (group->devices[slot].has_value()) {
            group->status = GroupStatus::duplicate;
        } else {
            group->devices[slot] = observation;
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
        group.status = group.devices[0U].has_value() && group.devices[1U].has_value()
                           ? GroupStatus::ready
                           : GroupStatus::incomplete;
    }
    std::sort(result.groups.begin(), result.groups.end(),
              [](const Q3U4Group& left, const Q3U4Group& right) {
                  return left.base_serial < right.base_serial;
              });
    return Result<GroupingResult>::success(std::move(result));
}

Result<std::size_t> select_ready_q3u4_group(const GroupingResult& grouping,
                                            std::string_view base_serial) noexcept
{
    if (!base_serial.empty() && base_serial.size() != 14U) {
        return Result<std::size_t>::failure(Error::INVALID_ARGUMENT);
    }
    if (!base_serial.empty()) {
        for (const char character : base_serial) {
            if (character < '0' || character > '9') {
                return Result<std::size_t>::failure(Error::INVALID_ARGUMENT);
            }
        }
    }

    std::size_t ready_count = 0U;
    std::size_t selected = 0U;
    for (std::size_t index = 0U; index < grouping.groups.size(); ++index) {
        const Q3U4Group& group = grouping.groups[index];
        if (group.status != GroupStatus::ready) {
            continue;
        }
        ++ready_count;
        if (base_serial.empty() || group.base_serial == base_serial) {
            selected = index;
        }
    }
    if (!base_serial.empty()) {
        for (const Q3U4Group& group : grouping.groups) {
            if (group.base_serial == base_serial && group.status != GroupStatus::ready) {
                return Result<std::size_t>::failure(Error::INVALID_ARGUMENT);
            }
        }
        for (const Q3U4Group& group : grouping.groups) {
            if (group.base_serial == base_serial && group.status == GroupStatus::ready) {
                return Result<std::size_t>::success(selected);
            }
        }
        return Result<std::size_t>::failure(Error::NOT_FOUND);
    }
    if (ready_count == 0U) {
        return Result<std::size_t>::failure(Error::NOT_FOUND);
    }
    return ready_count == 1U ? Result<std::size_t>::success(selected)
                             : Result<std::size_t>::failure(Error::INVALID_ARGUMENT);
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
