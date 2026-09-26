// Modified/ported for px4-userland on 2026-09-02; MLT5 support added on 2026-09-24.
//
// Copyright (c) 2018-2021 nns779
// Derived from tsukumijima/px4_drv commit d748866f0da1cb3656106a520de4e9d7f073aacd (v0.6.1).
// Origin paths: driver/i2c_comm.h, driver/it930x.c, driver/tc90522.c.
// Source snapshot maintained by tsukumijima.
// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_BRIDGE_I2C_H
#define PX4_USERLAND_BRIDGE_I2C_H

#include "px4/error.h"
#include "px4/it930x.h"
#include "px4/transport.h"

#include <cstddef>
#include <cstdint>
#include <array>
#include <mutex>

namespace px4::userland {

enum class BridgeI2cRequestType : std::uint8_t {
    undefined = 0,
    read = 1,
    write = 2,
};

struct BridgeI2cRequest final {
    BridgeI2cRequestType type;
    std::uint8_t address;
    ByteView write_data;
    MutableByteView read_data;
};

struct BridgeI2cFailureDetail final {
    bool valid = false;
    std::size_t request_index = 0U;
    BridgeI2cRequestType type = BridgeI2cRequestType::undefined;
    std::uint8_t address = 0U;
    std::size_t write_length = 0U;
    std::size_t read_length = 0U;
    std::array<std::uint8_t, 4U> write_data{};
    std::size_t captured_byte_count = 0U;
};

class BridgeI2cMaster {
public:
    virtual ~BridgeI2cMaster() noexcept = default;

    // A request call is one ordered, indivisible transaction at this layer.
    virtual Result<void> request(BridgeI2cRequest* requests,
                                 std::size_t count) noexcept = 0;
};

class It930xBridgeI2cMaster final : public BridgeI2cMaster {
public:
    // Q3U4 wires all demodulators to bridge I2C bus 2; the MLT5 family uses
    // buses 1 and 3, one master per bus.
    explicit It930xBridgeI2cMaster(It930xController& controller,
                                   std::uint8_t bus = 2U) noexcept
        : controller_(controller), bus_(bus)
    {
    }

    Result<void> request(BridgeI2cRequest* requests,
                         std::size_t count) noexcept override;

    BridgeI2cFailureDetail failure_detail() const noexcept;

private:
    It930xController& controller_;
    std::uint8_t bus_;
    mutable std::mutex mutex_;
    BridgeI2cFailureDetail failure_detail_{};
};

}  // namespace px4::userland

#endif  // PX4_USERLAND_BRIDGE_I2C_H
