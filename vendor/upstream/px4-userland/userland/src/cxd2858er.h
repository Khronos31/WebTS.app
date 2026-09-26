// Modified/ported for px4-userland on 2026-09-24.
//
// Copyright (c) 2018-2021 nns779
// Derived from tsukumijima/px4_drv commit d748866f0da1cb3656106a520de4e9d7f073aacd (v0.6.1).
// Origin paths: driver/cxd2858er.c, driver/cxd2858er.h, driver/pxmlt_device.c.
// Source snapshot maintained by tsukumijima.
// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_CXD2858ER_H
#define PX4_USERLAND_CXD2858ER_H

#include "cxd2856er.h"

#include <cstddef>
#include <cstdint>

namespace px4::userland {

enum class Cxd2858erSystem : std::uint8_t {
    unspecified = 0,
    isdb_t = 1,
    isdb_s = 2,
};

// Sony CXD2858ER tuner reached through a CXD2856ER I2C gate.  Every public
// operation opens the gate, runs its complete sequence, and closes the gate.
// All tuners on one bridge bus share address 0x60, so the caller must hold a
// per-bus lock across each call.  The supported boards use a 16 MHz crystal
// with both LNAs enabled.
class Cxd2858er final {
public:
    static constexpr std::uint8_t kAddress = 0x60U;

    Cxd2858er(Cxd2856er& demod, Cxd285xDelay& delay) noexcept
        : demod_(demod), delay_(delay)
    {
    }

    Result<void> initialize() noexcept;
    // cxd2858er_term: best-effort stop of the active system.
    void terminate() noexcept;
    // ISDB-T is always 6 MHz; frequencies are in kHz.
    Result<void> set_params_t(std::uint32_t frequency_khz) noexcept;
    Result<void> set_params_s(std::uint32_t frequency_khz) noexcept;

    Cxd2858erSystem system() const noexcept { return system_; }

private:
    struct Step final {
        std::uint8_t reg;
        std::uint8_t value;
        std::uint8_t mask;
    };

    Result<void> read_regs(std::uint8_t reg, MutableByteView output) noexcept;
    Result<void> write_regs(std::uint8_t reg, ByteView values) noexcept;
    Result<void> write_reg(std::uint8_t reg, std::uint8_t value) noexcept;
    Result<void> write_reg_mask(std::uint8_t reg, std::uint8_t value,
                                std::uint8_t mask) noexcept;
    template <std::size_t N>
    Result<void> apply(const Step (&steps)[N]) noexcept
    {
        for (const Step& step : steps) {
            const auto result = write_reg_mask(step.reg, step.value, step.mask);
            if (!result) return result;
        }
        return Result<void>::success();
    }
    Result<void> power_on() noexcept;
    Result<void> stop_t() noexcept;
    Result<void> stop_s() noexcept;
    Result<void> set_params_t_gated(std::uint32_t frequency_khz) noexcept;
    Result<void> set_params_s_gated(std::uint32_t frequency_khz) noexcept;
    // Runs one gated sequence and always attempts to close the gate.
    template <typename Operation>
    Result<void> gated(Operation operation) noexcept
    {
        const auto opened = demod_.set_tuner_gate(true);
        if (!opened) return opened;
        const Result<void> result = operation();
        const auto closed = demod_.set_tuner_gate(false);
        return result ? closed : result;
    }

    Cxd2856er& demod_;
    Cxd285xDelay& delay_;
    Cxd2858erSystem system_ = Cxd2858erSystem::unspecified;
};

}  // namespace px4::userland

#endif  // PX4_USERLAND_CXD2858ER_H
