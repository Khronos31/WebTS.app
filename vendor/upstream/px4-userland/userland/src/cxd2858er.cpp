// Modified/ported for px4-userland on 2026-09-24.
//
// Copyright (c) 2018-2021 nns779
// Derived from tsukumijima/px4_drv commit d748866f0da1cb3656106a520de4e9d7f073aacd (v0.6.1).
// Origin paths: driver/cxd2858er.c, driver/cxd2858er.h, driver/pxmlt_device.c.
// Source snapshot maintained by tsukumijima.
// SPDX-License-Identifier: GPL-2.0-only
#include "cxd2858er.h"

#include <algorithm>
#include <array>

namespace px4::userland {
namespace {

constexpr std::size_t kMaxWriteLength = 254U;
// pxmlt_device.c: xtal 16000 kHz, config.ter.lna and config.sat.lna enabled.
constexpr std::uint8_t kXtalPowerOn = 0x10U;
constexpr std::uint8_t kXtalTune = 0x02U;
constexpr std::uint8_t kTerrestrialLna = 0x05U | 0x02U;
constexpr std::uint8_t kSatelliteLna = 0xfeU | 0x01U;
// ISDB-T accepts a 20-bit kHz frequency; ISDB-S a 20-bit quarter-MHz value.
constexpr std::uint32_t kMaxFrequencyField = 0xfffffU;

}  // namespace

Result<void> Cxd2858er::read_regs(std::uint8_t reg, MutableByteView output) noexcept
{
    if (output.data == nullptr || output.size == 0U || output.size > 255U) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    std::array<std::uint8_t, 1U> pointer{reg};
    std::array<BridgeI2cRequest, 2U> requests{
        BridgeI2cRequest{BridgeI2cRequestType::write, kAddress,
                         ByteView{pointer.data(), pointer.size()},
                         MutableByteView{nullptr, 0U}},
        BridgeI2cRequest{BridgeI2cRequestType::read, kAddress, ByteView{nullptr, 0U},
                         output}};
    return demod_.tuner_request(requests.data(), requests.size());
}

Result<void> Cxd2858er::write_regs(std::uint8_t reg, ByteView values) noexcept
{
    if (values.data == nullptr || values.size == 0U || values.size > kMaxWriteLength) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    std::array<std::uint8_t, kMaxWriteLength + 1U> data{};
    data[0] = reg;
    std::copy(values.data, values.data + values.size, data.begin() + 1U);
    BridgeI2cRequest request{BridgeI2cRequestType::write, kAddress,
                             ByteView{data.data(), values.size + 1U},
                             MutableByteView{nullptr, 0U}};
    return demod_.tuner_request(&request, 1U);
}

Result<void> Cxd2858er::write_reg(std::uint8_t reg, std::uint8_t value) noexcept
{
    return write_regs(reg, ByteView{&value, 1U});
}

Result<void> Cxd2858er::write_reg_mask(std::uint8_t reg, std::uint8_t value,
                                       std::uint8_t mask) noexcept
{
    if (mask == 0U) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    std::uint8_t current = value;
    if (mask != 0xffU) {
        const auto read = read_regs(reg, MutableByteView{&current, 1U});
        if (!read) {
            return read;
        }
        current = static_cast<std::uint8_t>((current & static_cast<std::uint8_t>(~mask)) |
                                            (value & mask));
    }
    return write_reg(reg, current);
}

Result<void> Cxd2858er::power_on() noexcept
{
    // T mode.
    constexpr Step mode[] = {
        {0x01U, 0x00U, 0xffU}, {0x67U, 0x00U, 0xffU}, {0x43U, kTerrestrialLna, 0xffU},
    };
    if (const auto result = apply(mode); !result) return result;
    constexpr std::array<std::uint8_t, 3U> agc{0x15U, 0x00U, 0x00U};
    if (const auto result = write_regs(0x5eU, ByteView{agc.data(), agc.size()}); !result)
        return result;
    if (const auto result = write_reg(0x0cU, 0x14U); !result) return result;
    constexpr std::array<std::uint8_t, 2U> clock{0x7aU, 0x01U};
    if (const auto result = write_regs(0x99U, ByteView{clock.data(), clock.size()}); !result)
        return result;
    constexpr std::array<std::uint8_t, 20U> init{
        kXtalPowerOn, 0x80U | (0x04U & 0x1fU), 0x80U | 0x26U, 0x00U, 0x00U,
        0x00U, 0xc4U, 0x40U, 0x10U, 0x00U, 0x45U, 0x75U, 0x07U, 0x1cU,
        0x3fU, 0x02U, 0x10U, 0x20U, 0x0aU, 0x00U};
    if (const auto result = write_regs(0x81U, ByteView{init.data(), init.size()}); !result)
        return result;
    if (const auto result = write_reg(0x9bU, 0x00U); !result) return result;
    delay_.sleep_ms(10U);

    std::uint8_t status = 0U;
    if (const auto result = read_regs(0x1aU, MutableByteView{&status, 1U}); !result)
        return result;
    if (status != 0x00U) {
        // cxd2858er_power_on returns -EIO when the crystal does not settle.
        return Result<void>::failure(Error::PROTOCOL_ERROR);
    }

    constexpr std::array<std::uint8_t, 2U> calibration{0x90U, 0x06U};
    if (const auto result =
            write_regs(0x17U, ByteView{calibration.data(), calibration.size()});
        !result)
        return result;
    delay_.sleep_ms(1U);
    std::uint8_t trim = 0U;
    if (const auto result = read_regs(0x19U, MutableByteView{&trim, 1U}); !result)
        return result;
    const Step finish[] = {
        {0x95U, static_cast<std::uint8_t>((trim & 0xf0U) >> 4U), 0xffU},
        {0x74U, 0x02U, 0xffU}, {0x88U, 0x00U, 0xffU}, {0x87U, 0xc0U, 0xffU},
        {0x80U, 0x01U, 0xffU},
    };
    if (const auto result = apply(finish); !result) return result;
    constexpr std::array<std::uint8_t, 2U> sleep{0x07U, 0x00U};
    return write_regs(0x41U, ByteView{sleep.data(), sleep.size()});
}

Result<void> Cxd2858er::initialize() noexcept
{
    system_ = Cxd2858erSystem::unspecified;
    return gated([this]() noexcept { return power_on(); });
}

void Cxd2858er::terminate() noexcept
{
    if (system_ == Cxd2858erSystem::unspecified) {
        return;
    }
    const auto opened = demod_.set_tuner_gate(true);
    if (!opened) {
        system_ = Cxd2858erSystem::unspecified;
        return;
    }
    (void)(system_ == Cxd2858erSystem::isdb_t ? stop_t() : stop_s());
    (void)demod_.set_tuner_gate(false);
}

Result<void> Cxd2858er::stop_t() noexcept
{
    if (system_ != Cxd2858erSystem::isdb_t) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    constexpr Step mode[] = {{0x74U, 0x02U, 0xffU}, {0x67U, 0x00U, 0xfeU}};
    if (const auto result = apply(mode); !result) return result;
    constexpr std::array<std::uint8_t, 3U> agc{0x15U, 0x00U, 0x00U};
    if (const auto result = write_regs(0x5eU, ByteView{agc.data(), agc.size()}); !result)
        return result;
    constexpr Step finish[] = {{0x88U, 0x00U, 0xffU}, {0x87U, 0xc0U, 0xffU}};
    if (const auto result = apply(finish); !result) return result;
    system_ = Cxd2858erSystem::unspecified;
    return Result<void>::success();
}

Result<void> Cxd2858er::stop_s() noexcept
{
    if (system_ != Cxd2858erSystem::isdb_s) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    constexpr Step mode[] = {{0x15U, 0x02U, 0xffU}, {0x43U, kTerrestrialLna, 0xffU}};
    if (const auto result = apply(mode); !result) return result;
    constexpr std::array<std::uint8_t, 3U> agc{0x14U, 0x00U, 0x00U};
    if (const auto result = write_regs(0x0cU, ByteView{agc.data(), agc.size()}); !result)
        return result;
    constexpr Step finish[] = {
        {0x01U, 0x00U, 0xffU}, {0x05U, 0x00U, 0xffU}, {0x04U, 0xc0U, 0xffU},
    };
    if (const auto result = apply(finish); !result) return result;
    system_ = Cxd2858erSystem::unspecified;
    return Result<void>::success();
}

Result<void> Cxd2858er::set_params_t(std::uint32_t frequency_khz) noexcept
{
    if (frequency_khz == 0U || frequency_khz > kMaxFrequencyField) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    return gated([this, frequency_khz]() noexcept { return set_params_t_gated(frequency_khz); });
}

Result<void> Cxd2858er::set_params_t_gated(std::uint32_t frequency_khz) noexcept
{
    if (system_ == Cxd2858erSystem::isdb_s) {
        if (const auto result = stop_s(); !result) return result;
    }
    // T mode.
    constexpr Step mode[] = {{0x01U, 0x00U, 0xffU}, {0x74U, 0x02U, 0xffU}};
    if (const auto result = apply(mode); !result) return result;
    constexpr std::array<std::uint8_t, 2U> reg87{0xc4U, 0x40U};
    if (const auto result = write_regs(0x87U, ByteView{reg87.data(), reg87.size()}); !result)
        return result;
    constexpr std::array<std::uint8_t, 2U> reg91{0x10U, 0x20U};
    if (const auto result = write_regs(0x91U, ByteView{reg91.data(), reg91.size()}); !result)
        return result;
    constexpr std::array<std::uint8_t, 2U> reg9c{0x00U, 0x00U};
    if (const auto result = write_regs(0x9cU, ByteView{reg9c.data(), reg9c.size()}); !result)
        return result;
    constexpr std::array<std::uint8_t, 9U> reg5e{0xeeU, 0x02U, 0x1eU, 0x67U, kXtalTune,
                                                 0xb4U, 0x78U, 0x08U, 0x30U};
    if (const auto result = write_regs(0x5eU, ByteView{reg5e.data(), reg5e.size()}); !result)
        return result;
    if (const auto result = write_reg_mask(0x67U, 0x00U, 0x02U); !result) return result;
    const std::array<std::uint8_t, 17U> tune{
        0x00U, 0x88U, 0x00U, 0x0bU, 0x22U, 0x00U, 0x17U, 0x1bU,
        static_cast<std::uint8_t>(frequency_khz & 0xffU),
        static_cast<std::uint8_t>((frequency_khz >> 8U) & 0xffU),
        static_cast<std::uint8_t>((frequency_khz >> 16U) & 0x0fU),
        0xffU, 0x01U, 0x99U, 0x00U, 0x24U, 0x87U};
    if (const auto result = write_regs(0x68U, ByteView{tune.data(), tune.size()}); !result)
        return result;
    delay_.sleep_ms(50U);
    constexpr Step finish[] = {{0x88U, 0x00U, 0xffU}, {0x87U, 0xc0U, 0xffU}};
    if (const auto result = apply(finish); !result) return result;
    system_ = Cxd2858erSystem::isdb_t;
    return Result<void>::success();
}

Result<void> Cxd2858er::set_params_s(std::uint32_t frequency_khz) noexcept
{
    if (frequency_khz == 0U || (frequency_khz + 2U) / 4U > kMaxFrequencyField) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    return gated([this, frequency_khz]() noexcept { return set_params_s_gated(frequency_khz); });
}

Result<void> Cxd2858er::set_params_s_gated(std::uint32_t frequency_khz) noexcept
{
    if (system_ == Cxd2858erSystem::isdb_t) {
        if (const auto result = stop_t(); !result) return result;
    }
    constexpr Step lna[] = {{0x15U, 0x02U, 0xffU}, {0x43U, 0x06U, 0xffU}};
    if (const auto result = apply(lna); !result) return result;
    constexpr std::array<std::uint8_t, 2U> reg6a{0x00U, 0x00U};
    if (const auto result = write_regs(0x6aU, ByteView{reg6a.data(), reg6a.size()}); !result)
        return result;
    // S mode.
    constexpr Step mode[] = {
        {0x75U, 0x99U, 0xffU}, {0x9dU, 0x00U, 0xffU}, {0x61U, 0x07U, 0xffU},
        {0x01U, 0x01U, 0xffU},
    };
    if (const auto result = apply(mode); !result) return result;
    const std::uint32_t field = (frequency_khz + 2U) / 4U;
    const std::array<std::uint8_t, 18U> tune{
        0xc4U, 0x40U, kXtalTune, 0x00U, 0xb4U, 0x78U, 0x08U, 0x30U, kSatelliteLna,
        0x02U, 0x1eU, 0x16U,
        static_cast<std::uint8_t>(field & 0xffU),
        static_cast<std::uint8_t>((field >> 8U) & 0xffU),
        static_cast<std::uint8_t>((field >> 16U) & 0x0fU),
        0xffU, 0x00U, 0x01U};
    if (const auto result = write_regs(0x04U, ByteView{tune.data(), tune.size()}); !result)
        return result;
    delay_.sleep_ms(10U);
    constexpr Step finish[] = {{0x05U, 0x00U, 0xffU}, {0x04U, 0xc0U, 0xffU}};
    if (const auto result = apply(finish); !result) return result;
    system_ = Cxd2858erSystem::isdb_s;
    return Result<void>::success();
}

}  // namespace px4::userland
