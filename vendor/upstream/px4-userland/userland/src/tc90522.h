// Modified/ported for px4-userland on 2026-09-02.
//
// Copyright (c) 2018-2021 nns779
// Derived from tsukumijima/px4_drv commit 9eedea8c502875a788697984b93b50032339b9aa.
// Origin paths: driver/tc90522.c, driver/tc90522.h, driver/i2c_comm.h.
// Source snapshot maintained by tsukumijima.
// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_TC90522_H
#define PX4_USERLAND_TC90522_H

#include "bridge_i2c.h"

#include <cstddef>
#include <cstdint>
#include <vector>

namespace px4::userland {

enum class Tc90522System : std::uint8_t {
    isdb_t = 0,
    isdb_s = 1,
};

struct Q3U4ReceiverMapping final {
    std::uint8_t local_receiver;
    std::uint8_t demod_address;
    bool secondary;
    Tc90522System system;
};

Result<Q3U4ReceiverMapping> q3u4_receiver_mapping(
    std::uint8_t local_receiver) noexcept;

struct Tc90522RegisterRead final {
    std::uint8_t reg;
    MutableByteView data;
};

struct Tc90522RegisterWrite final {
    std::uint8_t reg;
    ByteView data;
};

enum class Tc90522RequestType : std::uint8_t {
    undefined = 0,
    read = 1,
    write = 2,
};

struct Tc90522I2cRequest final {
    Tc90522RequestType type;
    std::uint16_t address;
    ByteView write_data;
    MutableByteView read_data;
};

class Tc90522 final {
public:
    Tc90522(BridgeI2cMaster& bridge, Q3U4ReceiverMapping mapping) noexcept
        : bridge_(bridge), mapping_(mapping)
    {
    }

    const Q3U4ReceiverMapping& mapping() const noexcept { return mapping_; }

    Result<std::vector<std::uint8_t>> read_regs(std::uint8_t reg,
                                                 std::size_t length) noexcept;
    Result<void> read_multiple_regs(std::vector<Tc90522RegisterRead>& registers) noexcept;
    Result<void> write_regs(std::uint8_t reg, ByteView values) noexcept;
    Result<void> write_reg(std::uint8_t reg, std::uint8_t value) noexcept;
    Result<void> write_multiple_regs(
        const std::vector<Tc90522RegisterWrite>& registers) noexcept;

    // Converts legacy downstream requests into TC90522 repeater requests and submits
    // the complete converted sequence as one bridge transaction.
    Result<void> downstream_request(Tc90522I2cRequest* requests,
                                    std::size_t count) noexcept;

    Result<void> sleep_s(bool sleep) noexcept;
    Result<void> set_agc_s(bool on) noexcept;
    Result<std::uint16_t> tmcc_get_tsid_s(std::uint8_t index) noexcept;
    Result<std::uint16_t> get_tsid_s() noexcept;
    Result<void> set_tsid_s(std::uint16_t tsid) noexcept;
    Result<std::uint16_t> get_cn_s() noexcept;
    Result<void> enable_ts_pins_s(bool enable) noexcept;
    Result<bool> is_signal_locked_s() noexcept;

    Result<void> sleep_t(bool sleep) noexcept;
    Result<void> set_agc_t(bool on) noexcept;
    Result<std::uint32_t> get_cndat_t() noexcept;
    Result<void> enable_ts_pins_t(bool enable) noexcept;
    Result<bool> is_signal_locked_t() noexcept;

private:
    Result<std::vector<std::uint8_t>> read_regs_unlocked(
        std::uint8_t reg, std::size_t length) noexcept;

    BridgeI2cMaster& bridge_;
    Q3U4ReceiverMapping mapping_;
};

}  // namespace px4::userland

#endif  // PX4_USERLAND_TC90522_H
