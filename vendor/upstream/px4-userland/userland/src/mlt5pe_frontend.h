// Modified/ported for px4-userland on 2026-09-24.
//
// Copyright (c) 2018-2021 nns779
// Derived from tsukumijima/px4_drv commit d748866f0da1cb3656106a520de4e9d7f073aacd (v0.6.1).
// Origin paths: driver/pxmlt_device.c, driver/pxmlt_device.h,
// winusb/src/DriverHost_PX4/pxmlt_device.cpp.
// Source snapshot maintained by tsukumijima.
// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_MLT5PE_FRONTEND_H
#define PX4_USERLAND_MLT5PE_FRONTEND_H

#include "cxd2856er.h"
#include "cxd2858er.h"
#include "px4/identity.h"
#include "mlt5pe_power.h"
#include "q3u4_frontend.h"

#include <array>
#include <cstdint>
#include <mutex>

namespace px4::userland {

class Mlt5PeDelay : public Q3U4Delay, public Cxd285xDelay {
public:
    ~Mlt5PeDelay() noexcept override = default;
    void sleep_ms(std::uint32_t milliseconds) noexcept override = 0;
};

enum class Mlt5PeReceiverState : std::uint8_t {
    closed = 0,
    open = 1,
    tuned = 2,
    capturing = 3,
};

struct MltReceiverInput final {
    std::uint8_t i2c_address;
    std::uint8_t i2c_bus;
    std::uint8_t port_number;
};

struct MltModelLayout final {
    std::uint8_t receiver_count;
    std::array<MltReceiverInput, kMlt5PeReceiverCount> receivers;
};

constexpr MltModelLayout mlt_model_layout(DeviceModel model) noexcept
{
    constexpr MltReceiverInput unused{0U, 1U, 0U};
    switch (model) {
    case DeviceModel::px_mlt8pe3:
        return {3U, {{{0x65U, 3U, 0U}, {0x6cU, 3U, 3U}, {0x64U, 3U, 4U}, unused, unused}}};
    case DeviceModel::px_mlt8pe5:
        return {5U, {{{0x65U, 1U, 0U}, {0x64U, 1U, 1U}, {0x6cU, 1U, 2U},
                      {0x6cU, 3U, 3U}, {0x64U, 3U, 4U}}}};
    case DeviceModel::dtv02a_4ts_p:
        return {4U, {{{0x65U, 3U, 0U}, {0x6cU, 1U, 1U}, {0x64U, 1U, 2U},
                      {0x64U, 3U, 4U}, unused}}};
    default:
        return {5U, {{{0x65U, 3U, 0U}, {0x6cU, 1U, 1U}, {0x64U, 1U, 2U},
                      {0x6cU, 3U, 3U}, {0x64U, 3U, 4U}}}};
    }
}

// Up to five CXD2856ER/CXD2858ER receivers of one MLT-family enclosure.
// Every configured receiver can tune ISDB-T or ISDB-S. I2C sequences on
// the same bridge bus are serialized, which also serializes each tuner gate
// open/access/close because all tuners on a bus share address 0x60.
class Mlt5PeFrontend final {
public:
    Mlt5PeFrontend(BridgeI2cMaster& bus1, BridgeI2cMaster& bus3,
                  Q3U4BackendPower& power, Mlt5PeDelay& delay,
                  Q3U4PsbPurger* purger = nullptr,
                  std::uint8_t receiver_count = kMlt5PeReceiverCount,
                  DeviceModel model = DeviceModel::px_mlt5pe) noexcept;
    ~Mlt5PeFrontend() noexcept;

    Mlt5PeFrontend(const Mlt5PeFrontend&) = delete;
    Mlt5PeFrontend& operator=(const Mlt5PeFrontend&) = delete;

    Result<void> open_receiver(std::uint8_t receiver) noexcept;
    Result<void> close_receiver(std::uint8_t receiver) noexcept;
    Result<void> tune(std::uint8_t receiver, Cxd2856erSystem system,
                      std::uint32_t frequency_khz) noexcept;
    // px4_drv selects the ISDB-S stream before tuning on this board.
    Result<void> select_satellite_slot(std::uint8_t receiver, std::uint8_t slot) noexcept;
    Result<void> select_satellite_tsid(std::uint8_t receiver, std::uint16_t tsid) noexcept;
    // An ISDB-T "unlocked" report is returned as TIMEOUT: the demodulator
    // has decided that no signal can be acquired on this frequency.
    Result<bool> is_terrestrial_locked(std::uint8_t receiver) noexcept;
    Result<bool> is_satellite_locked(std::uint8_t receiver) noexcept;
    Result<void> start_capture(std::uint8_t receiver) noexcept;
    Result<void> stop_capture(std::uint8_t receiver) noexcept;

    Result<void> acquire_card() noexcept;
    Result<void> release_card() noexcept;
    Result<void> reconcile_power() noexcept;

    Mlt5PeReceiverState receiver_state(std::uint8_t receiver) const noexcept;
    Mlt5PePowerSnapshot power_snapshot() const noexcept { return power_.snapshot(); }

private:
    struct Receiver final {
        Receiver(BridgeI2cMaster& bus, std::uint8_t address, Cxd285xDelay& delay,
                 std::uint8_t bus_index_value) noexcept
            : demod(bus, address, delay), tuner(demod, delay), bus_index(bus_index_value)
        {
        }

        Cxd2856er demod;
        Cxd2858er tuner;
        std::uint8_t bus_index;
        Mlt5PeReceiverState state = Mlt5PeReceiverState::closed;
        Cxd2856erSystem system = Cxd2856erSystem::unspecified;
    };

    bool valid_receiver(std::uint8_t receiver) const noexcept
    {
        return receiver < receiver_count_;
    }
    std::mutex& bus_mutex(std::uint8_t receiver) noexcept;
    void terminate_receiver(Receiver& receiver) noexcept;

    Mlt5PePowerCoordinator power_;
    Q3U4PsbPurger* purger_;
    std::array<Receiver, kMlt5PeReceiverCount> receivers_;
    std::uint8_t receiver_count_;
    std::array<std::mutex, 2U> bus_mutexes_{};
    // Guards receiver state and serializes the first-capture PSB purge.
    mutable std::mutex state_mutex_;
};

}  // namespace px4::userland

#endif  // PX4_USERLAND_MLT5PE_FRONTEND_H
