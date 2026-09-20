// Modified/ported for px4-userland on 2026-09-02.
//
// Copyright (c) 2018-2021 nns779
// Derived from tsukumijima/px4_drv commit 9eedea8c502875a788697984b93b50032339b9aa.
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
    explicit It930xBridgeI2cMaster(It930xController& controller) noexcept
        : controller_(controller)
    {
    }

    Result<void> request(BridgeI2cRequest* requests,
                         std::size_t count) noexcept override;

    BridgeI2cFailureDetail failure_detail() const noexcept;

private:
    It930xController& controller_;
    mutable std::mutex mutex_;
    BridgeI2cFailureDetail failure_detail_{};
};

}  // namespace px4::userland

#endif  // PX4_USERLAND_BRIDGE_I2C_H
