// Modified/ported for px4-userland on 2026-09-02.
//
// Copyright (c) 2018-2021 nns779
// Derived from tsukumijima/px4_drv commit 9eedea8c502875a788697984b93b50032339b9aa.
// Origin paths: driver/r850.c, driver/r850.h.
// Source snapshot maintained by tsukumijima.
// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_R850_H
#define PX4_USERLAND_R850_H

#include "tc90522.h"

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace px4::userland {

class R850Delay {
public:
    virtual ~R850Delay() noexcept = default;
    virtual void sleep_ms(std::uint32_t milliseconds) noexcept = 0;
};

enum class R850System : std::uint8_t {
    isdb_t = 0,
};

enum class R850Bandwidth : std::uint8_t {
    mhz_6 = 0,
};

struct R850SystemConfig final {
    R850System system;
    R850Bandwidth bandwidth;
    std::uint32_t if_frequency_khz;
};

struct R850FrequencySelection final {
    std::uint8_t row_index;
};

Result<R850FrequencySelection> r850_select_isdb_t_frequency(
    std::uint32_t if_frequency_khz, std::uint32_t rf_frequency_khz) noexcept;

class R850 final {
public:
    R850(Tc90522& demod, R850Delay& delay, bool loop_through) noexcept
        : demod_(demod), delay_(delay), loop_through_(loop_through)
    {
    }

    Result<void> initialize() noexcept;
    Result<void> terminate() noexcept;
    Result<void> sleep() noexcept;
    Result<void> wakeup() noexcept;
    Result<void> set_system(const R850SystemConfig& system) noexcept;
    Result<void> set_frequency(std::uint32_t frequency_khz) noexcept;
    Result<bool> is_pll_locked() noexcept;

    bool initialized() const noexcept { return initialized_; }
    bool chip_variant() const noexcept { return chip_variant_; }
    bool loop_through() const noexcept { return loop_through_; }
    std::uint8_t xtal_power() const noexcept { return xtal_power_; }

private:
    Result<std::vector<std::uint8_t>> read_regs(
        std::uint8_t reg, std::size_t length) noexcept;
    Result<void> write_regs(std::uint8_t reg, ByteView values) noexcept;
    Result<void> check_xtal_power() noexcept;
    Result<void> set_system_params() noexcept;
    Result<void> set_system_frequency(std::uint32_t rf_frequency_khz) noexcept;
    Result<void> set_mux(std::uint32_t rf_frequency_khz,
                         std::uint32_t lo_frequency_khz) noexcept;
    Result<void> set_pll(std::uint32_t lo_frequency_khz,
                         std::uint32_t if_frequency_khz) noexcept;

    Tc90522& demod_;
    R850Delay& delay_;
    bool loop_through_;
    bool initialized_ = false;
    bool chip_variant_ = false;
    std::uint8_t xtal_power_ = 3U;
    std::array<std::uint8_t, 0x30U> registers_{};
    R850SystemConfig system_{R850System::isdb_t, R850Bandwidth::mhz_6, 0U};
    R850SystemConfig current_{R850System::isdb_t, R850Bandwidth::mhz_6, 0U};
    bool system_set_ = false;
    bool current_valid_ = false;
};

}  // namespace px4::userland

#endif  // PX4_USERLAND_R850_H
