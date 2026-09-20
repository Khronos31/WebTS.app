// Modified/ported for px4-userland on 2026-09-02.
//
// Copyright (c) 2018-2021 nns779
// Derived from tsukumijima/px4_drv commit 9eedea8c502875a788697984b93b50032339b9aa.
// Origin paths: driver/rt710.c, driver/rt710.h.
// Source snapshot maintained by tsukumijima.
// SPDX-License-Identifier: GPL-2.0-only

#include "rt710.h"

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <utility>
#include <vector>

namespace px4::userland {
namespace {

constexpr std::uint8_t kTunerAddress = 0x7aU;
constexpr std::size_t kRegisterCount = 0x10U;
constexpr std::uint32_t kXtalKHz = 24000U;
constexpr std::array<std::uint8_t, kRegisterCount> kRt710Init{
    0x40U, 0x1dU, 0x20U, 0x10U, 0x41U, 0x50U, 0xedU, 0x25U,
    0x07U, 0x58U, 0x39U, 0x64U, 0x38U, 0xe7U, 0x90U, 0x35U};
constexpr std::array<std::uint8_t, kRegisterCount> kRt720Init{
    0x00U, 0x1cU, 0x00U, 0x10U, 0x41U, 0x48U, 0xdaU, 0x4bU,
    0x07U, 0x58U, 0x38U, 0x40U, 0x37U, 0xe7U, 0x4cU, 0x59U};
constexpr std::array<std::uint8_t, kRegisterCount> kSleep{
    0xffU, 0x5cU, 0x88U, 0x30U, 0x41U, 0xc8U, 0xedU, 0x25U,
    0x47U, 0xfcU, 0x48U, 0xa2U, 0x08U, 0x0fU, 0xf3U, 0x59U};

struct Bandwidth final { std::uint32_t limit; std::uint8_t coarse; std::uint8_t fine; };
constexpr std::array<Bandwidth, 26U> kBandwidth{{
    {50000U, 0U, 0U}, {73000U, 0U, 1U}, {96000U, 1U, 0U},
    {104000U, 1U, 1U}, {116000U, 2U, 0U}, {126000U, 2U, 1U},
    {134000U, 3U, 0U}, {146000U, 3U, 1U}, {158000U, 4U, 0U},
    {170000U, 4U, 1U}, {178000U, 5U, 0U}, {190000U, 5U, 1U},
    {202000U, 6U, 0U}, {212000U, 6U, 1U}, {218000U, 7U, 0U},
    {234000U, 7U, 1U}, {244000U, 9U, 1U}, {246000U, 10U, 0U},
    {262000U, 10U, 1U}, {266000U, 11U, 0U}, {282000U, 11U, 1U},
    {298000U, 12U, 1U}, {318000U, 13U, 1U}, {340000U, 14U, 1U},
    {358000U, 15U, 1U}, {379999U, 16U, 1U}}};
constexpr std::array<std::uint16_t, 19U> kRt710Gain{
    0U, 26U, 42U, 74U, 103U, 129U, 158U, 181U, 188U, 200U,
    220U, 248U, 280U, 312U, 341U, 352U, 366U, 389U, 409U};
constexpr std::array<std::uint16_t, 32U> kRt720Gain{
    0U, 27U, 53U, 81U, 109U, 134U, 156U, 176U, 194U, 202U, 211U,
    221U, 232U, 245U, 258U, 271U, 285U, 307U, 326U, 341U, 357U,
    374U, 393U, 410U, 428U, 439U, 445U, 470U, 476U, 479U, 495U, 507U};

struct BandwidthSelection final {
    std::uint8_t coarse;
    std::uint8_t fine;
};

std::uint8_t reverse_bits(std::uint8_t value) noexcept
{
    value = static_cast<std::uint8_t>(((value & 0x55U) << 1U) |
                                      ((value & 0xaaU) >> 1U));
    value = static_cast<std::uint8_t>(((value & 0x33U) << 2U) |
                                      ((value & 0xccU) >> 2U));
    return static_cast<std::uint8_t>((value << 4U) | (value >> 4U));
}

}  // namespace

Result<void> Rt710::validate_params(std::uint32_t frequency_khz,
                                    std::uint32_t symbol_rate,
                                    std::uint32_t rolloff) const noexcept
{
    if (frequency_khz < 146875U || frequency_khz > 2350000U ||
        symbol_rate == 0U || rolloff > 5U) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    // The fixed Q3U4 PLL uses 24 MHz and a /2, /4, /8, or /16 mixer
    // divider.  Validate the complete divider/fraction domain before the
    // initial register image is sent.
    std::uint8_t mix_div = 2U;
    std::uint32_t vco_frequency = frequency_khz * mix_div;
    while (mix_div <= 16U && !(vco_frequency >= 2350000U && vco_frequency <= 4700000U)) {
        mix_div = static_cast<std::uint8_t>(mix_div * 2U);
        if (mix_div <= 16U) vco_frequency = frequency_khz * mix_div;
    }
    if (mix_div > 16U || vco_frequency < 2350000U || vco_frequency > 4700000U) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    const std::uint32_t nint = (vco_frequency / 2U) / kXtalKHz;
    if (nint < 13U || nint > 268U) return Result<void>::failure(Error::INVALID_ARGUMENT);

    std::uint32_t effective_symbol_rate = symbol_rate;
    std::uint32_t s = 0U;
    if (chip_ == Rt710Chip::rt720 && effective_symbol_rate >= 15000U) {
        if (effective_symbol_rate > std::numeric_limits<std::uint32_t>::max() - 6000U)
            return Result<void>::failure(Error::INVALID_ARGUMENT);
        effective_symbol_rate += 6000U;
    }
    const std::uint32_t multiplier = 115U + rolloff * 5U;
    if (effective_symbol_rate > std::numeric_limits<std::uint32_t>::max() / multiplier)
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    // Legacy rt710_set_params computes bandwidth here, before the RT720
    // manual-scan compensation below.  Keep that order even though the RT720
    // coarse calculation intentionally uses s instead of bandwidth.
    const std::uint32_t bandwidth = (effective_symbol_rate * multiplier) / 10U;
    if (bandwidth == 0U) return Result<void>::failure(Error::INVALID_ARGUMENT);

    if (chip_ == Rt710Chip::rt720) {
        if (effective_symbol_rate > std::numeric_limits<std::uint32_t>::max() / 12U)
            return Result<void>::failure(Error::INVALID_ARGUMENT);
        s = effective_symbol_rate * 12U;
        if (effective_symbol_rate <= 15000U) {
            if (effective_symbol_rate > std::numeric_limits<std::uint32_t>::max() - 3000U)
                return Result<void>::failure(Error::INVALID_ARGUMENT);
            effective_symbol_rate += 3000U;
        } else if (effective_symbol_rate <= 20000U) {
            if (effective_symbol_rate > std::numeric_limits<std::uint32_t>::max() - 2000U)
                return Result<void>::failure(Error::INVALID_ARGUMENT);
            effective_symbol_rate += 2000U;
        } else if (effective_symbol_rate <= 30000U) {
            if (effective_symbol_rate > std::numeric_limits<std::uint32_t>::max() - 1000U)
                return Result<void>::failure(Error::INVALID_ARGUMENT);
            effective_symbol_rate += 1000U;
        }
    }

    std::uint32_t coarse = 0U;
    if (chip_ == Rt710Chip::rt710) {
        if (bandwidth >= 380000U) {
            const std::uint32_t remainder = bandwidth - 380000U;
            coarse = 16U + remainder / 17400U + (remainder % 17400U != 0U);
        } else {
            bool found = false;
            for (const auto& entry : kBandwidth) {
                if (bandwidth <= entry.limit) { coarse = entry.coarse; found = true; break; }
            }
            if (!found) return Result<void>::failure(Error::INVALID_ARGUMENT);
        }
    } else {
        const std::uint32_t range = (rolloff > 1U) ? 20000U : 0U;
        if (s <= 88000U + range) coarse = 0U;
        else if (s <= 368000U + range) {
            const std::uint32_t delta = s - 88000U - range;
            coarse = delta / 20000U + (delta % 20000U != 0U);
            if (coarse > 6U) ++coarse;
        } else if (s <= 764000U + range) {
            const std::uint32_t delta = s - 368000U - range;
            coarse = delta / 20000U + 15U;
            if (s > std::numeric_limits<std::uint32_t>::max() - 25216U + range)
                return Result<void>::failure(Error::INVALID_ARGUMENT);
            if ((s + 25216U - range) % 20000U != 0U) ++coarse;
            if (coarse >= 33U) coarse += 3U;
            else if (coarse >= 29U) coarse += 2U;
            else if (coarse >= 27U) coarse += 3U;
            else if (coarse >= 24U) coarse += 2U;
            else if (coarse >= 19U) ++coarse;
        } else coarse = 42U;
    }
    if (coarse > 63U) return Result<void>::failure(Error::INVALID_ARGUMENT);
    return Result<void>::success();
}

Result<std::vector<std::uint8_t>> Rt710::read_regs(std::uint8_t reg,
                                                     std::size_t length) noexcept
{
    if (length == 0U || reg >= kRegisterCount || length > kRegisterCount - reg) {
        return Result<std::vector<std::uint8_t>>::failure(Error::INVALID_ARGUMENT);
    }
    std::vector<std::uint8_t> raw(reg + length, 0U);
    const std::array<std::uint8_t, 1U> pointer{0U};
    Tc90522I2cRequest requests[2]{
        {Tc90522RequestType::write, kTunerAddress,
         ByteView{pointer.data(), pointer.size()}, MutableByteView{nullptr, 0U}},
        {Tc90522RequestType::read, kTunerAddress, ByteView{nullptr, 0U},
         MutableByteView{raw.data(), raw.size()}}};
    const auto result = demod_.downstream_request(requests, 2U);
    if (!result) {
        return Result<std::vector<std::uint8_t>>::failure(result.error());
    }
    std::vector<std::uint8_t> output(length, 0U);
    for (std::size_t index = 0U; index < length; ++index) {
        output[index] = reverse_bits(raw[reg + index]);
    }
    return Result<std::vector<std::uint8_t>>::success(std::move(output));
}

Result<void> Rt710::write_regs(std::uint8_t reg, ByteView values) noexcept
{
    if (values.data == nullptr || values.size == 0U || reg >= kRegisterCount ||
        values.size > kRegisterCount - reg) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    std::array<std::uint8_t, kRegisterCount + 1U> data{};
    data[0] = reg;
    std::copy(values.data, values.data + values.size, data.begin() + 1U);
    Tc90522I2cRequest request{Tc90522RequestType::write, kTunerAddress,
                              ByteView{data.data(), values.size + 1U},
                              MutableByteView{nullptr, 0U}};
    return demod_.downstream_request(&request, 1U);
}

Result<void> Rt710::initialize() noexcept
{
    initialized_ = false;
    chip_ = Rt710Chip::unknown;
    frequency_khz_ = 0U;
    const auto value = read_regs(0x03U, 1U);
    if (!value) {
        return Result<void>::failure(value.error());
    }
    chip_ = ((value.value()[0] & 0xf0U) == 0x70U) ? Rt710Chip::rt710
                                                   : Rt710Chip::rt720;
    initialized_ = true;
    return Result<void>::success();
}

Result<void> Rt710::terminate() noexcept
{
    initialized_ = false;
    chip_ = Rt710Chip::unknown;
    frequency_khz_ = 0U;
    return Result<void>::success();
}

Result<void> Rt710::sleep() noexcept
{
    if (!initialized_) {
        return Result<void>::failure(Error::NOT_READY);
    }
    auto regs = kSleep;
    if (chip_ == Rt710Chip::rt720) {
        regs[0x01U] = 0x5eU;
        regs[0x03U] = static_cast<std::uint8_t>(regs[0x03U] | 0x20U);
    }
    return write_regs(0U, ByteView{regs.data(), regs.size()});
}

Result<void> Rt710::set_pll(std::array<std::uint8_t, kRegisterCount>& regs,
                            std::uint32_t frequency_khz) noexcept
{
    // Matches rt710_set_pll: once PLL programming is entered, the previous
    // frequency is invalidated even if a later I2C write fails.
    frequency_khz_ = 0U;
    // The kernel implementation lets an invalid frequency fall through with
    // an unsupported divider (and can wrap its arithmetic).  The portable
    // API rejects that state before any register write; all Q3U4 BS/CS
    // frequencies are inside this validated PLL domain.
    if (frequency_khz == 0U) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    constexpr std::uint32_t vco_min = 2350000U;
    constexpr std::uint32_t vco_max = 4700000U;
    std::uint8_t mix_div = 2U;
    std::uint32_t vco_frequency = frequency_khz * mix_div;
    while (mix_div <= 16U && !(vco_frequency >= vco_min && vco_frequency <= vco_max)) {
        mix_div = static_cast<std::uint8_t>(mix_div * 2U);
        if (mix_div <= 16U) {
            vco_frequency = frequency_khz * mix_div;
        }
    }
    if (mix_div > 16U || vco_frequency < vco_min || vco_frequency > vco_max) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    const std::uint8_t divider = mix_div == 2U ? 1U : mix_div == 4U ? 0U :
                                 mix_div == 8U ? 2U : 3U;
    regs[0x04U] = static_cast<std::uint8_t>((regs[0x04U] & 0xfeU) | (divider & 1U));
    auto result = write_regs(0x04U, ByteView{&regs[0x04U], 1U});
    if (!result) return result;

    if (chip_ == Rt710Chip::rt720) {
        regs[0x08U] = static_cast<std::uint8_t>((regs[0x08U] & 0xefU) |
                                                 ((divider << 3U) & 0x10U));
        result = write_regs(0x08U, ByteView{&regs[0x08U], 1U});
        if (!result) return result;
        regs[0x04U] &= 0x3fU;
        if (divider <= 1U) {
            regs[0x04U] |= 0x40U;
            regs[0x0cU] |= 0x10U;
        } else {
            regs[0x04U] |= 0x80U;
            regs[0x0cU] &= 0xefU;
        }
        result = write_regs(0x04U, ByteView{&regs[0x04U], 1U});
        if (!result) return result;
        result = write_regs(0x0cU, ByteView{&regs[0x0cU], 1U});
        if (!result) return result;
    }

    const std::uint32_t twice_xtal = kXtalKHz * 2U;
    const std::uint32_t nint = (vco_frequency / 2U) / kXtalKHz;
    if (nint < 13U || nint > 268U) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    std::uint32_t fraction = vco_frequency - (twice_xtal * nint);
    if (fraction < kXtalKHz / 64U) {
        fraction = 0U;
    } else if (fraction > kXtalKHz * 127U / 64U) {
        fraction = 0U;
        // The legacy code increments nint here.  The Q3U4 range cannot overflow
        // this validated divider, and the resulting value remains representable.
        if (nint == 268U) return Result<void>::failure(Error::INVALID_ARGUMENT);
        const std::uint32_t incremented = nint + 1U;
        regs[0x05U] = static_cast<std::uint8_t>(((incremented - 13U) / 4U) & 0x3fU);
        regs[0x05U] |= static_cast<std::uint8_t>(((incremented - 13U) % 4U) << 6U);
    }
    std::uint32_t effective_nint = nint;
    if (fraction == 0U && vco_frequency - (twice_xtal * nint) >
                           kXtalKHz * 127U / 64U) {
        effective_nint = nint + 1U;
    }
    if (fraction > kXtalKHz * 127U / 128U && fraction < kXtalKHz) {
        fraction = kXtalKHz * 127U / 128U;
    } else if (fraction > kXtalKHz &&
               fraction < kXtalKHz * 129U / 128U) {
        fraction = kXtalKHz * 129U / 128U;
    }
    const std::uint8_t ni = static_cast<std::uint8_t>((effective_nint - 13U) / 4U);
    const std::uint8_t si = static_cast<std::uint8_t>(effective_nint - ni * 4U - 13U);
    regs[0x05U] = static_cast<std::uint8_t>((ni & 0x3fU) | ((si << 6U) & 0xc0U));
    result = write_regs(0x05U, ByteView{&regs[0x05U], 1U});
    if (!result) return result;
    if (fraction == 0U) regs[0x04U] |= 0x02U;
    result = write_regs(0x04U, ByteView{&regs[0x04U], 1U});
    if (!result) return result;

    std::uint16_t nsdm = 2U;
    std::uint16_t sdm = 0U;
    while (fraction > 1U) {
        const std::uint32_t threshold = (kXtalKHz * 2U) / nsdm;
        if (fraction > threshold) {
            sdm = static_cast<std::uint16_t>(sdm + (0x8000U / (nsdm / 2U)));
            fraction -= threshold;
            if (nsdm >= 0x8000U) break;
        }
        nsdm = static_cast<std::uint16_t>(nsdm * 2U);
    }
    regs[0x07U] = static_cast<std::uint8_t>(sdm >> 8U);
    regs[0x06U] = static_cast<std::uint8_t>(sdm);
    result = write_regs(0x07U, ByteView{&regs[0x07U], 1U});
    if (!result) return result;
    result = write_regs(0x06U, ByteView{&regs[0x06U], 1U});
    if (!result) return result;
    frequency_khz_ = frequency_khz;
    return Result<void>::success();
}

Result<void> Rt710::set_params(std::uint32_t frequency_khz,
                               std::uint32_t symbol_rate,
                               std::uint32_t rolloff) noexcept
{
    if (!initialized_) return Result<void>::failure(Error::NOT_READY);
    const auto valid = validate_params(frequency_khz, symbol_rate, rolloff);
    if (!valid) return valid;
    auto regs = chip_ == Rt710Chip::rt710 ? kRt710Init : kRt720Init;
    // Q3U4: no loop-through, no clock output, differential output, positive
    // AGC, VGA attenuation off, fine gain 3 dB, manual scan.
    regs[0x01U] |= 0x04U;
    regs[0x03U] |= 0x10U;
    regs[0x0bU] &= 0xefU;
    regs[0x0dU] |= 0x10U;
    regs[0x0bU] &= 0xf7U;
    if (chip_ == Rt710Chip::rt710) {
        regs[0x0eU] &= 0xfcU;
    } else {
        regs[0x0eU] &= 0xfeU;
        regs[0x03U] &= 0xf0U;
    }
    auto result = write_regs(0U, ByteView{regs.data(), regs.size()});
    if (!result) return result;
    result = set_pll(regs, frequency_khz);
    if (!result) return result;
    delay_.sleep_ms(10U);

    std::uint32_t effective_symbol_rate = symbol_rate;
    std::uint32_t s = 0U;
    std::uint8_t coarse = 0U;
    std::uint8_t fine = 0U;
    if (chip_ == Rt710Chip::rt710) {
        if (static_cast<std::uint32_t>(frequency_khz - 1600000U) >= 350000U) {
            regs[0x02U] &= 0xbfU;
            regs[0x08U] &= 0x7fU;
            if (frequency_khz >= 1950000U) regs[0x0aU] = 0x38U;
        } else {
            regs[0x02U] |= 0x40U;
            regs[0x08U] |= 0x80U;
        }
        result = write_regs(0x0aU, ByteView{&regs[0x0aU], 1U}); if (!result) return result;
        result = write_regs(0x02U, ByteView{&regs[0x02U], 1U}); if (!result) return result;
        result = write_regs(0x08U, ByteView{&regs[0x08U], 1U}); if (!result) return result;
        regs[0x0eU] &= 0xf3U;
        if (frequency_khz >= 2000000U) regs[0x0eU] |= 0x08U;
        result = write_regs(0x0eU, ByteView{&regs[0x0eU], 1U}); if (!result) return result;
    } else {
        // Q3U4 uses the RT720 manual-scan path.
        regs[0x0bU] &= 0xfcU;
        if (effective_symbol_rate >= 15000U) effective_symbol_rate += 6000U;
        result = write_regs(0x0bU, ByteView{&regs[0x0bU], 1U}); if (!result) return result;
        s = effective_symbol_rate * 12U;
    }
    const std::uint32_t multiplier = 115U + rolloff * 5U;
    // Keep the legacy order: bandwidth is derived after the initial RT720
    // +6000 manual-scan adjustment, but before its later compensation.
    const std::uint32_t bandwidth = (effective_symbol_rate * multiplier) / 10U;
    if (chip_ == Rt710Chip::rt720) {
        if (effective_symbol_rate <= 15000U) effective_symbol_rate += 3000U;
        else if (effective_symbol_rate <= 20000U) effective_symbol_rate += 2000U;
        else if (effective_symbol_rate <= 30000U) effective_symbol_rate += 1000U;
    }
    if (chip_ == Rt710Chip::rt710) {
        if (bandwidth >= 380000U) {
            const std::uint32_t remainder = bandwidth - 380000U;
            coarse = static_cast<std::uint8_t>(0U + (remainder % 17400U != 0U));
            coarse = static_cast<std::uint8_t>(coarse + ((remainder / 17400U) & 0xffU) + 0x10U);
            fine = 1U;
        } else {
            for (const auto& entry : kBandwidth) {
                if (bandwidth <= entry.limit) { coarse = entry.coarse; fine = entry.fine; break; }
            }
        }
    } else {
        fine = rolloff > 1U ? 1U : 0U;
        const std::uint32_t range = fine * 20000U;
        // Preserve the legacy order: s is intentionally based on the pre-adjustment rate.
        if (s <= 88000U + range) coarse = 0U;
        else if (s <= 368000U + range) {
            const std::uint32_t delta = s - 88000U - range;
            coarse = static_cast<std::uint8_t>(delta / 20000U + (delta % 20000U != 0U));
            if (coarse > 6U) ++coarse;
        } else if (s <= 764000U + range) {
            const std::uint32_t delta = s - 368000U - range;
            coarse = static_cast<std::uint8_t>(delta / 20000U + 15U);
            if (s > std::numeric_limits<std::uint32_t>::max() - 25216U + range)
                return Result<void>::failure(Error::INVALID_ARGUMENT);
            if ((s + 25216U - range) % 20000U != 0U) ++coarse;
            if (coarse >= 33U) coarse = static_cast<std::uint8_t>(coarse + 3U);
            else if (coarse >= 29U) coarse = static_cast<std::uint8_t>(coarse + 2U);
            else if (coarse >= 27U) coarse = static_cast<std::uint8_t>(coarse + 3U);
            else if (coarse >= 24U) coarse = static_cast<std::uint8_t>(coarse + 2U);
            else if (coarse >= 19U) ++coarse;
        } else coarse = 42U;
    }
    regs[0x0fU] = static_cast<std::uint8_t>((coarse << 2U) | (fine & 3U));
    return write_regs(0x0fU, ByteView{&regs[0x0fU], 1U});
}

Result<bool> Rt710::is_pll_locked() noexcept
{
    if (!initialized_) return Result<bool>::failure(Error::NOT_READY);
    const auto value = read_regs(0x02U, 1U);
    if (!value) return Result<bool>::failure(value.error());
    return Result<bool>::success((value.value()[0] & 0x80U) != 0U);
}

Result<std::uint8_t> Rt710::get_rf_gain() noexcept
{
    if (!initialized_) return Result<std::uint8_t>::failure(Error::NOT_READY);
    const auto value = read_regs(0x01U, 1U);
    if (!value) return Result<std::uint8_t>::failure(value.error());
    const std::uint8_t raw = static_cast<std::uint8_t>(((value.value()[0] & 0xf0U) >> 4U) |
                                                       ((value.value()[0] & 1U) << 4U));
    if (chip_ == Rt710Chip::rt710) {
        return Result<std::uint8_t>::success(raw <= 2U ? 0U : raw <= 9U ?
                                             static_cast<std::uint8_t>(raw - 2U) :
                                             raw <= 12U ? 7U : raw <= 22U ?
                                             static_cast<std::uint8_t>(raw - 5U) : 18U);
    }
    // rt710.c leaves the RT720 output unassigned.  RT720 exposes a bounded
    // five-bit gain code, so returning that code is the deterministic portable
    // replacement; malformed values still fail rather than indexing blindly.
    if (raw >= kRt720Gain.size()) return Result<std::uint8_t>::failure(Error::PROTOCOL_ERROR);
    return Result<std::uint8_t>::success(raw);
}

Result<std::int32_t> Rt710::get_rf_signal_strength() noexcept
{
    const auto gain = get_rf_gain();
    if (!gain) return Result<std::int32_t>::failure(gain.error());
    std::int32_t base = 70;
    std::uint16_t correction = 0U;
    if (chip_ == Rt710Chip::rt710) {
        base = frequency_khz_ < 1200000U ? 190 : frequency_khz_ < 1800000U ? 170 : 140;
        if (gain.value() >= kRt710Gain.size()) return Result<std::int32_t>::failure(Error::PROTOCOL_ERROR);
        correction = kRt710Gain[gain.value()];
    } else {
        if (gain.value() >= kRt720Gain.size()) return Result<std::int32_t>::failure(Error::PROTOCOL_ERROR);
        correction = kRt720Gain[gain.value()];
    }
    return Result<std::int32_t>::success((base + correction) * -100);
}

}  // namespace px4::userland
