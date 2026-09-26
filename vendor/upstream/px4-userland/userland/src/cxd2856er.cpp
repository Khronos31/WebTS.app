// Modified/ported for px4-userland on 2026-09-24.
//
// Copyright (c) 2018-2021 nns779
// Derived from tsukumijima/px4_drv commit d748866f0da1cb3656106a520de4e9d7f073aacd (v0.6.1).
// Origin paths: driver/cxd2856er.c, driver/cxd2856er.h, driver/i2c_comm.h,
// driver/pxmlt_device.c.
// Source snapshot maintained by tsukumijima.
// SPDX-License-Identifier: GPL-2.0-only
#include "cxd2856er.h"

#include <algorithm>
#include <array>

namespace px4::userland {
namespace {

constexpr std::size_t kMaxWriteLength = 254U;

constexpr Cxd2856erTarget kX = Cxd2856erTarget::slvx;
constexpr Cxd2856erTarget kT = Cxd2856erTarget::slvt;

}  // namespace

Result<void> Cxd2856er::read_regs(Cxd2856erTarget target, std::uint8_t reg,
                                  MutableByteView output) noexcept
{
    if (output.data == nullptr || output.size == 0U || output.size > 255U) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    const std::uint8_t address = target == kT ? slvt_address_ : slvx_address_;
    std::array<std::uint8_t, 1U> pointer{reg};
    std::array<BridgeI2cRequest, 2U> requests{
        BridgeI2cRequest{BridgeI2cRequestType::write, address,
                         ByteView{pointer.data(), pointer.size()},
                         MutableByteView{nullptr, 0U}},
        BridgeI2cRequest{BridgeI2cRequestType::read, address, ByteView{nullptr, 0U},
                         output}};
    return bridge_.request(requests.data(), requests.size());
}

Result<void> Cxd2856er::write_regs(Cxd2856erTarget target, std::uint8_t reg,
                                   ByteView values) noexcept
{
    if (values.data == nullptr || values.size == 0U || values.size > kMaxWriteLength) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    std::array<std::uint8_t, kMaxWriteLength + 1U> data{};
    data[0] = reg;
    std::copy(values.data, values.data + values.size, data.begin() + 1U);
    BridgeI2cRequest request{BridgeI2cRequestType::write,
                             target == kT ? slvt_address_ : slvx_address_,
                             ByteView{data.data(), values.size + 1U},
                             MutableByteView{nullptr, 0U}};
    return bridge_.request(&request, 1U);
}

Result<void> Cxd2856er::write_reg(Cxd2856erTarget target, std::uint8_t reg,
                                  std::uint8_t value) noexcept
{
    return write_regs(target, reg, ByteView{&value, 1U});
}

Result<void> Cxd2856er::write_reg_mask(Cxd2856erTarget target, std::uint8_t reg,
                                       std::uint8_t value, std::uint8_t mask) noexcept
{
    if (mask == 0U) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    std::uint8_t current = value;
    if (mask != 0xffU) {
        const auto read = read_regs(target, reg, MutableByteView{&current, 1U});
        if (!read) {
            return read;
        }
        current = static_cast<std::uint8_t>((current & static_cast<std::uint8_t>(~mask)) |
                                            (value & mask));
    }
    return write_reg(target, reg, current);
}

Result<void> Cxd2856er::apply(const Step* steps, std::size_t count) noexcept
{
    for (std::size_t index = 0U; index < count; ++index) {
        const Step& step = steps[index];
        const auto result = write_reg_mask(step.target, step.reg, step.value, step.mask);
        if (!result) {
            return result;
        }
    }
    return Result<void>::success();
}

Result<void> Cxd2856er::set_tuner_gate(bool open) noexcept
{
    return write_reg(kX, 0x08U, open ? 0x01U : 0x00U);
}

Result<void> Cxd2856er::tuner_request(BridgeI2cRequest* requests,
                                      std::size_t count) noexcept
{
    return bridge_.request(requests, count);
}

Result<void> Cxd2856er::initialize() noexcept
{
    state_ = State::unknown;
    system_ = Cxd2856erSystem::unspecified;

    // 24 MHz crystal.
    constexpr Step reset[] = {
        {kX, 0x00U, 0x00U, 0xffU}, {kX, 0x10U, 0x01U, 0xffU}, {kX, 0x18U, 0x01U, 0xffU},
        {kX, 0x28U, 0x13U, 0xffU}, {kX, 0x17U, 0x01U, 0xffU}, {kX, 0x1dU, 0x00U, 0xffU},
        {kX, 0x14U, 0x01U, 0xffU}, {kX, 0x1cU, 0x03U, 0xffU},
    };
    if (const auto result = apply(reset); !result) return result;
    delay_.sleep_ms(4U);
    if (const auto result = write_reg(kX, 0x50U, 0x00U); !result) return result;
    delay_.sleep_ms(1U);
    if (const auto result = write_reg(kX, 0x10U, 0x00U); !result) return result;
    delay_.sleep_ms(1U);

    state_ = State::sleep;

    // The tuner is reached through this demodulator's I2C gate.
    constexpr Step tuner_i2c[] = {{kX, 0x00U, 0x00U, 0xffU}, {kX, 0x1aU, 0x01U, 0xffU}};
    return apply(tuner_i2c);
}

void Cxd2856er::terminate() noexcept
{
    (void)sleep();
}

Result<void> Cxd2856er::set_ts_clock(Cxd2856erSystem system) noexcept
{
    if (system != Cxd2856erSystem::isdb_t && system != Cxd2856erSystem::isdb_s) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    if (const auto result = write_reg(kT, 0x00U, 0x00U); !result) return result;
    // The reference driver reads 0xc4 here and discards the value.
    std::uint8_t unused = 0U;
    if (const auto result = read_regs(kT, 0xc4U, MutableByteView{&unused, 1U}); !result)
        return result;
    const Step steps[] = {
        {kT, 0xd3U, 0x01U, 0x01U}, {kT, 0xdeU, 0x00U, 0x01U}, {kT, 0xdaU, 0x00U, 0x01U},
        {kT, 0xc4U, 0x00U, 0x03U}, {kT, 0xd1U, 0x02U, 0x03U}, {kT, 0xd9U, 0x10U, 0xffU},
        {kT, 0x32U, 0x00U, 0x01U},
        {kT, 0x33U, system == Cxd2856erSystem::isdb_t ? std::uint8_t{0x02U} : std::uint8_t{0x00U},
         0x03U},
        {kT, 0x32U, 0x01U, 0x01U}, {kT, 0x00U, 0x10U, 0xffU}, {kT, 0x66U, 0x01U, 0x01U},
        {kT, 0x00U, 0x40U, 0xffU}, {kT, 0x66U, 0x01U, 0x01U},
    };
    return apply(steps);
}

Result<void> Cxd2856er::set_ts_pin_state(bool enabled) noexcept
{
    if (const auto result = write_reg(kT, 0x00U, 0x00U); !result) return result;
    std::uint8_t config = 0U;
    if (const auto result = read_regs(kT, 0xc4U, MutableByteView{&config, 1U}); !result)
        return result;
    std::uint8_t mask = 0xffU;
    if ((config & 0x88U) == 0x80U) {
        mask = 0x01U;
    } else if ((config & 0x88U) == 0x88U) {
        mask = 0x80U;
    }
    if (const auto result = write_reg(kT, 0x00U, 0x00U); !result) return result;
    return write_reg_mask(kT, 0x81U, enabled ? 0x00U : 0xffU, mask);
}

Result<void> Cxd2856er::sleep_isdbt() noexcept
{
    constexpr Step disable[] = {
        {kT, 0x00U, 0x00U, 0xffU}, {kT, 0xc3U, 0x01U, 0xffU}, {kT, 0x80U, 0x1fU, 0x1fU},
    };
    if (const auto result = apply(disable); !result) return result;
    if (const auto result = set_ts_pin_state(false); !result) return result;
    constexpr Step bank10[] = {
        {kT, 0x00U, 0x10U, 0xffU}, {kT, 0x69U, 0x05U, 0xffU}, {kT, 0x6bU, 0x07U, 0xffU},
        {kT, 0x9dU, 0x14U, 0xffU}, {kT, 0xd3U, 0x00U, 0xffU}, {kT, 0xedU, 0x01U, 0xffU},
        {kT, 0xe2U, 0x4eU, 0xffU}, {kT, 0xf2U, 0x03U, 0xffU}, {kT, 0xdeU, 0x32U, 0xffU},
        {kT, 0x00U, 0x15U, 0xffU}, {kT, 0xdeU, 0x03U, 0xffU}, {kT, 0x00U, 0x17U, 0xffU},
    };
    if (const auto result = apply(bank10); !result) return result;
    constexpr std::array<std::uint8_t, 2U> bank17{0x01U, 0x00U};
    if (const auto result = write_regs(kT, 0x38U, ByteView{bank17.data(), bank17.size()});
        !result)
        return result;
    constexpr Step power_down[] = {
        {kT, 0x00U, 0x1eU, 0xffU}, {kT, 0x73U, 0x00U, 0xffU}, {kT, 0x00U, 0x63U, 0xffU},
        {kT, 0x81U, 0x01U, 0xffU}, {kX, 0x00U, 0x00U, 0xffU}, {kX, 0x18U, 0x01U, 0xffU},
        {kT, 0x00U, 0x00U, 0xffU}, {kT, 0x49U, 0x33U, 0xffU}, {kT, 0x4bU, 0x21U, 0xffU},
        {kT, 0xfeU, 0x01U, 0xffU}, {kT, 0x2cU, 0x00U, 0xffU}, {kT, 0xa9U, 0x00U, 0xffU},
        {kX, 0x17U, 0x01U, 0xffU},
    };
    return apply(power_down);
}

Result<void> Cxd2856er::sleep_isdbs() noexcept
{
    constexpr Step disable[] = {
        {kT, 0x00U, 0x00U, 0xffU}, {kT, 0xc3U, 0x01U, 0xffU}, {kT, 0x80U, 0x1fU, 0x1fU},
    };
    if (const auto result = apply(disable); !result) return result;
    if (const auto result = set_ts_pin_state(false); !result) return result;
    constexpr Step power_down[] = {
        {kX, 0x00U, 0x00U, 0xffU}, {kX, 0x18U, 0x01U, 0xffU}, {kT, 0x00U, 0x00U, 0xffU},
        {kT, 0x6aU, 0x11U, 0xffU}, {kT, 0x4bU, 0x21U, 0xffU}, {kX, 0x28U, 0x13U, 0xffU},
        {kT, 0xfeU, 0x01U, 0xffU}, {kT, 0x2cU, 0x00U, 0xffU}, {kT, 0xa9U, 0x00U, 0xffU},
        {kT, 0x2dU, 0x00U, 0xffU}, {kX, 0x17U, 0x01U, 0xffU}, {kT, 0x00U, 0xa0U, 0xffU},
        {kT, 0xd7U, 0x00U, 0xffU},
    };
    return apply(power_down);
}

Result<void> Cxd2856er::sleep() noexcept
{
    if (state_ == State::sleep) {
        return Result<void>::success();
    }
    Result<void> result = Result<void>::success();
    if (system_ == Cxd2856erSystem::isdb_t) {
        result = sleep_isdbt();
    } else if (system_ == Cxd2856erSystem::isdb_s) {
        result = sleep_isdbs();
    }
    // The reference driver records sleep even when the sequence failed; the
    // next wakeup starts from the full wakeup sequence either way.
    state_ = State::sleep;
    system_ = Cxd2856erSystem::unspecified;
    return result;
}

Result<void> Cxd2856er::set_bandwidth_isdbt() noexcept
{
    if (const auto result = write_reg(kT, 0x00U, 0x10U); !result) return result;
    constexpr std::array<std::uint8_t, 5U> itb{0x17U, 0xa0U, 0x80U, 0x00U, 0x00U};
    if (const auto result = write_regs(kT, 0x9fU, ByteView{itb.data(), itb.size()}); !result)
        return result;
    constexpr std::array<std::uint8_t, 14U> filter{0x31U, 0xa8U, 0x29U, 0x9bU, 0x27U,
                                                   0x9cU, 0x28U, 0x9eU, 0x29U, 0xa4U,
                                                   0x29U, 0xa2U, 0x29U, 0xa8U};
    if (const auto result = write_regs(kT, 0xa6U, ByteView{filter.data(), filter.size()});
        !result)
        return result;
    constexpr std::array<std::uint8_t, 3U> cl{0x12U, 0xeeU, 0xefU};
    if (const auto result = write_regs(kT, 0xb6U, ByteView{cl.data(), cl.size()}); !result)
        return result;
    if (const auto result = write_reg(kT, 0xd7U, 0x04U); !result) return result;
    constexpr std::array<std::uint8_t, 2U> notch{0x1fU, 0x79U};
    if (const auto result = write_regs(kT, 0xd9U, ByteView{notch.data(), notch.size()});
        !result)
        return result;
    constexpr Step tail[] = {
        {kT, 0x00U, 0x12U, 0xffU}, {kT, 0x71U, 0x07U, 0xffU},
        {kT, 0x00U, 0x15U, 0xffU}, {kT, 0xbeU, 0x02U, 0xffU},
    };
    return apply(tail);
}

Result<void> Cxd2856er::wakeup_isdbt() noexcept
{
    if (const auto result = set_ts_clock(Cxd2856erSystem::isdb_t); !result) return result;
    constexpr Step enable[] = {
        {kX, 0x00U, 0x00U, 0xffU}, {kX, 0x17U, 0x06U, 0xffU}, {kT, 0x00U, 0x00U, 0xffU},
        {kT, 0xa9U, 0x00U, 0xffU}, {kT, 0x2cU, 0x01U, 0xffU}, {kT, 0x4bU, 0x74U, 0xffU},
        {kT, 0x49U, 0x00U, 0xffU}, {kX, 0x18U, 0x00U, 0xffU}, {kT, 0x00U, 0x11U, 0xffU},
        {kT, 0x6aU, 0x50U, 0xffU}, {kT, 0x00U, 0x10U, 0xffU}, {kT, 0xa5U, 0x01U, 0xffU},
        {kT, 0x00U, 0x00U, 0xffU},
    };
    if (const auto result = apply(enable); !result) return result;
    constexpr std::array<std::uint8_t, 2U> zero{0x00U, 0x00U};
    if (const auto result = write_regs(kT, 0xceU, ByteView{zero.data(), zero.size()}); !result)
        return result;
    constexpr Step bank10[] = {
        {kT, 0x00U, 0x10U, 0xffU}, {kT, 0x69U, 0x04U, 0xffU}, {kT, 0x6bU, 0x03U, 0xffU},
        {kT, 0x9dU, 0x50U, 0xffU}, {kT, 0xd3U, 0x06U, 0xffU}, {kT, 0xedU, 0x00U, 0xffU},
        {kT, 0xe2U, 0xceU, 0xffU}, {kT, 0xf2U, 0x13U, 0xffU}, {kT, 0xdeU, 0x2eU, 0xffU},
        {kT, 0x00U, 0x15U, 0xffU}, {kT, 0xdeU, 0x02U, 0xffU}, {kT, 0x00U, 0x17U, 0xffU},
    };
    if (const auto result = apply(bank10); !result) return result;
    constexpr std::array<std::uint8_t, 2U> bank17{0x00U, 0x03U};
    if (const auto result = write_regs(kT, 0x38U, ByteView{bank17.data(), bank17.size()});
        !result)
        return result;
    constexpr Step bank1e[] = {
        {kT, 0x00U, 0x1eU, 0xffU}, {kT, 0x73U, 0x68U, 0xffU}, {kT, 0x00U, 0x63U, 0xffU},
        {kT, 0x81U, 0x00U, 0xffU}, {kT, 0x00U, 0x11U, 0xffU},
    };
    if (const auto result = apply(bank1e); !result) return result;
    constexpr std::array<std::uint8_t, 3U> bank11{0x00U, 0x03U, 0x3bU};
    if (const auto result = write_regs(kT, 0x33U, ByteView{bank11.data(), bank11.size()});
        !result)
        return result;
    if (const auto result = write_reg(kT, 0x00U, 0x60U); !result) return result;
    constexpr std::array<std::uint8_t, 2U> bank60{0xb7U, 0x1bU};
    if (const auto result = write_regs(kT, 0xa8U, ByteView{bank60.data(), bank60.size()});
        !result)
        return result;
    if (const auto result = set_bandwidth_isdbt(); !result) return result;
    constexpr Step output[] = {{kT, 0x00U, 0x00U, 0xffU}, {kT, 0x80U, 0x08U, 0x1fU}};
    if (const auto result = apply(output); !result) return result;
    return set_ts_pin_state(true);
}

Result<void> Cxd2856er::wakeup_isdbs() noexcept
{
    if (const auto result = set_ts_clock(Cxd2856erSystem::isdb_s); !result) return result;
    constexpr Step enable[] = {
        {kX, 0x00U, 0x00U, 0xffU}, {kX, 0x17U, 0x0cU, 0xffU}, {kT, 0x00U, 0x00U, 0xffU},
        {kT, 0x2dU, 0x00U, 0xffU}, {kT, 0xa9U, 0x00U, 0xffU}, {kT, 0x2cU, 0x01U, 0xffU},
        {kX, 0x28U, 0x31U, 0xffU}, {kT, 0x4bU, 0x31U, 0xffU}, {kT, 0x6aU, 0x00U, 0xffU},
        {kX, 0x18U, 0x00U, 0xffU}, {kT, 0x00U, 0x00U, 0xffU}, {kT, 0x20U, 0x01U, 0xffU},
    };
    if (const auto result = apply(enable); !result) return result;
    constexpr std::array<std::uint8_t, 2U> zero{0x00U, 0x00U};
    if (const auto result = write_regs(kT, 0xceU, ByteView{zero.data(), zero.size()}); !result)
        return result;
    if (const auto result = write_reg(kT, 0x00U, 0xaeU); !result) return result;
    constexpr std::array<std::uint8_t, 3U> bankae{0x07U, 0x37U, 0x0aU};
    if (const auto result = write_regs(kT, 0x20U, ByteView{bankae.data(), bankae.size()});
        !result)
        return result;
    constexpr Step output[] = {
        {kT, 0x00U, 0xa0U, 0xffU}, {kT, 0xd7U, 0x00U, 0xffU},
        {kT, 0x00U, 0x00U, 0xffU}, {kT, 0x80U, 0x10U, 0x1fU},
    };
    if (const auto result = apply(output); !result) return result;
    return set_ts_pin_state(true);
}

Result<void> Cxd2856er::reset_isdbt() noexcept
{
    constexpr Step reset[] = {{kT, 0x00U, 0x00U, 0xffU}, {kT, 0xc3U, 0x01U, 0xffU}};
    if (const auto result = apply(reset); !result) return result;
    return set_bandwidth_isdbt();
}

Result<void> Cxd2856er::reset_isdbs() noexcept
{
    constexpr Step reset[] = {{kT, 0x00U, 0x00U, 0xffU}, {kT, 0xc3U, 0x01U, 0xffU}};
    return apply(reset);
}

Result<void> Cxd2856er::wakeup(Cxd2856erSystem system) noexcept
{
    if (system != Cxd2856erSystem::isdb_t && system != Cxd2856erSystem::isdb_s) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    if (state_ == State::active) {
        if (system_ == system) {
            return system == Cxd2856erSystem::isdb_t ? reset_isdbt() : reset_isdbs();
        }
        (void)sleep();
    }
    const auto result = system == Cxd2856erSystem::isdb_t ? wakeup_isdbt() : wakeup_isdbs();
    if (result) {
        system_ = system;
        state_ = State::active;
    }
    return result;
}

Result<void> Cxd2856er::post_tune() noexcept
{
    constexpr Step steps[] = {
        {kT, 0x00U, 0x00U, 0xffU}, {kT, 0xfeU, 0x01U, 0xffU}, {kT, 0xc3U, 0x00U, 0xffU},
    };
    return apply(steps);
}

Result<void> Cxd2856er::set_slot_isdbs(std::uint8_t slot) noexcept
{
    if (slot >= 8U) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    if (const auto result = write_reg(kT, 0x00U, 0xc0U); !result) return result;
    const std::array<std::uint8_t, 3U> data{0x00U, slot, 0x01U};
    return write_regs(kT, 0xe9U, ByteView{data.data(), data.size()});
}

Result<void> Cxd2856er::set_tsid_isdbs(std::uint16_t tsid) noexcept
{
    if (const auto result = write_reg(kT, 0x00U, 0xc0U); !result) return result;
    const std::array<std::uint8_t, 3U> data{static_cast<std::uint8_t>(tsid >> 8U),
                                            static_cast<std::uint8_t>(tsid), 0x00U};
    return write_regs(kT, 0xe9U, ByteView{data.data(), data.size()});
}

Result<Cxd2856erTerrestrialLock> Cxd2856er::is_ts_locked_isdbt() noexcept
{
    if (const auto result = write_reg(kT, 0x00U, 0x60U); !result)
        return Result<Cxd2856erTerrestrialLock>::failure(result.error());
    std::uint8_t status = 0U;
    if (const auto result = read_regs(kT, 0x10U, MutableByteView{&status, 1U}); !result)
        return Result<Cxd2856erTerrestrialLock>::failure(result.error());
    Cxd2856erTerrestrialLock lock;
    lock.locked = (status & 0x01U) != 0U;
    lock.unlocked = (status & 0x10U) != 0U;
    return Result<Cxd2856erTerrestrialLock>::success(lock);
}

Result<bool> Cxd2856er::is_ts_locked_isdbs() noexcept
{
    if (const auto result = write_reg(kT, 0x00U, 0xa0U); !result)
        return Result<bool>::failure(result.error());
    std::uint8_t status = 0U;
    if (const auto result = read_regs(kT, 0x12U, MutableByteView{&status, 1U}); !result)
        return Result<bool>::failure(result.error());
    return Result<bool>::success((status & 0x40U) != 0U);
}

Result<void> Cxd2856er::configure_ts_output() noexcept
{
    constexpr Step steps[] = {
        {kT, 0x00U, 0x00U, 0xffU}, {kT, 0xc4U, 0x80U, 0x88U}, {kT, 0xc5U, 0x01U, 0x01U},
        {kT, 0xc6U, 0x03U, 0x1fU}, {kT, 0x00U, 0x60U, 0xffU}, {kT, 0x52U, 0x03U, 0x1fU},
        {kT, 0x00U, 0x00U, 0xffU}, {kT, 0xc8U, 0x03U, 0x1fU}, {kT, 0xc9U, 0x03U, 0x1fU},
        {kT, 0x00U, 0xa0U, 0xffU}, {kT, 0xb9U, 0x01U, 0x01U},
    };
    return apply(steps);
}

}  // namespace px4::userland
