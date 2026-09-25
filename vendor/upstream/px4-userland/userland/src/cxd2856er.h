// Modified/ported for px4-userland on 2026-09-24.
//
// Copyright (c) 2018-2021 nns779
// Derived from tsukumijima/px4_drv commit d748866f0da1cb3656106a520de4e9d7f073aacd (v0.6.1).
// Origin paths: driver/cxd2856er.c, driver/cxd2856er.h, driver/i2c_comm.h,
// driver/pxmlt_device.c.
// Source snapshot maintained by tsukumijima.
// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_CXD2856ER_H
#define PX4_USERLAND_CXD2856ER_H

#include "bridge_i2c.h"

#include <cstddef>
#include <cstdint>

namespace px4::userland {

class Cxd285xDelay {
public:
    virtual ~Cxd285xDelay() noexcept = default;
    virtual void sleep_ms(std::uint32_t milliseconds) noexcept = 0;
};

enum class Cxd2856erSystem : std::uint8_t {
    unspecified = 0,
    isdb_t = 1,
    isdb_s = 2,
};

enum class Cxd2856erTarget : std::uint8_t {
    slvx = 0,
    slvt = 1,
};

struct Cxd2856erTerrestrialLock final {
    bool locked = false;
    // The demodulator reports that no ISDB-T signal can be acquired.
    bool unlocked = false;
};

// Sony CXD2856ER demodulator behind an IT930x bridge I2C bus.  The system
// block (SLVX) is at slvt_address + 2.  All methods perform bounded I2C
// transactions only; callers serialize access to one instance.
class Cxd2856er final {
public:
    Cxd2856er(BridgeI2cMaster& bridge, std::uint8_t slvt_address,
              Cxd285xDelay& delay) noexcept
        : bridge_(bridge), slvt_address_(slvt_address),
          slvx_address_(static_cast<std::uint8_t>(slvt_address + 2U)), delay_(delay)
    {
    }

    Result<void> read_regs(Cxd2856erTarget target, std::uint8_t reg,
                           MutableByteView output) noexcept;
    Result<void> write_regs(Cxd2856erTarget target, std::uint8_t reg,
                            ByteView values) noexcept;
    Result<void> write_reg(Cxd2856erTarget target, std::uint8_t reg,
                           std::uint8_t value) noexcept;
    Result<void> write_reg_mask(Cxd2856erTarget target, std::uint8_t reg,
                                std::uint8_t value, std::uint8_t mask) noexcept;

    // Downstream tuner access through the demodulator's I2C gate.  Requests
    // pass through to the same bridge bus while the gate is open.
    Result<void> set_tuner_gate(bool open) noexcept;
    Result<void> tuner_request(BridgeI2cRequest* requests, std::size_t count) noexcept;

    // cxd2856er_init with the 24 MHz crystal and tuner I2C enabled.
    Result<void> initialize() noexcept;
    // cxd2856er_term: best-effort sleep of the active system.
    void terminate() noexcept;
    Result<void> sleep() noexcept;
    // ISDB-T is always 6 MHz on the supported boards.
    Result<void> wakeup(Cxd2856erSystem system) noexcept;
    Result<void> post_tune() noexcept;
    Result<void> set_slot_isdbs(std::uint8_t slot) noexcept;
    Result<void> set_tsid_isdbs(std::uint16_t tsid) noexcept;
    Result<Cxd2856erTerrestrialLock> is_ts_locked_isdbt() noexcept;
    Result<bool> is_ts_locked_isdbs() noexcept;
    // The serial TS output setup performed by pxmlt_chrdev_open after the
    // demodulator and tuner are initialized.
    Result<void> configure_ts_output() noexcept;

    Cxd2856erSystem system() const noexcept { return system_; }
    bool active() const noexcept { return state_ == State::active; }

private:
    enum class State : std::uint8_t {
        unknown = 0,
        sleep = 1,
        active = 2,
    };

    struct Step final {
        Cxd2856erTarget target;
        std::uint8_t reg;
        std::uint8_t value;
        std::uint8_t mask;
    };

    Result<void> apply(const Step* steps, std::size_t count) noexcept;
    template <std::size_t N>
    Result<void> apply(const Step (&steps)[N]) noexcept
    {
        return apply(steps, N);
    }
    Result<void> set_ts_clock(Cxd2856erSystem system) noexcept;
    Result<void> set_ts_pin_state(bool enabled) noexcept;
    Result<void> sleep_isdbt() noexcept;
    Result<void> sleep_isdbs() noexcept;
    Result<void> set_bandwidth_isdbt() noexcept;
    Result<void> wakeup_isdbt() noexcept;
    Result<void> wakeup_isdbs() noexcept;
    Result<void> reset_isdbt() noexcept;
    Result<void> reset_isdbs() noexcept;

    BridgeI2cMaster& bridge_;
    std::uint8_t slvt_address_;
    std::uint8_t slvx_address_;
    Cxd285xDelay& delay_;
    State state_ = State::unknown;
    Cxd2856erSystem system_ = Cxd2856erSystem::unspecified;
};

}  // namespace px4::userland

#endif  // PX4_USERLAND_CXD2856ER_H
