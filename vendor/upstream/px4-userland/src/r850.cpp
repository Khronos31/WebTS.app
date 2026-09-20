// Modified/ported for px4-userland on 2026-09-02.
//
// Copyright (c) 2018-2021 nns779
// Derived from tsukumijima/px4_drv commit 9eedea8c502875a788697984b93b50032339b9aa.
// Origin paths: driver/r850.c, driver/r850.h.
// Source snapshot maintained by tsukumijima.
// SPDX-License-Identifier: GPL-2.0-only

#include "r850.h"

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <utility>

namespace px4::userland {
namespace {

constexpr std::uint8_t kR850Address = 0x7cU;
constexpr std::size_t kRegisterCount = 0x30U;
constexpr std::size_t kRegisterWriteMax = kRegisterCount;

struct R850LpfParameters final {
    std::uint8_t code;
    std::uint8_t bandwidth;
    std::uint8_t lsb;
};

struct R850SystemParameters final {
    R850Bandwidth bandwidth;
    std::uint32_t if_frequency;
    std::uint32_t filter_cal_if_unused;
    std::uint8_t filter_bandwidth_unused;
    std::uint8_t filter_ext_enable;
    std::uint8_t hpf_notch;
    std::uint8_t hpf_correction;
    std::uint8_t filter_compensation;
    std::uint8_t image_gain;
    std::uint8_t agc_clock;
    R850LpfParameters lpf;
};

struct R850FrequencyParameters final {
    std::uint32_t if_frequency;
    std::uint32_t rf_minimum;
    std::uint32_t rf_maximum;
    std::uint8_t lna_top;
    std::uint8_t lna_vtl_high;
    std::uint8_t lna_nrb_detector;
    std::uint8_t lna_rf_disable_mode;
    std::uint8_t lna_rf_charge_current;
    std::uint8_t lna_rf_disable_current;
    std::uint8_t lna_disable_slow_fast;
    std::uint8_t rf_top;
    std::uint8_t rf_vtl_high;
    std::uint8_t rf_gain_limit;
    std::uint8_t rf_disable_slow_fast;
    std::uint8_t rf_lte_psg;
    std::uint8_t nrb_top;
    std::uint8_t nrb_bandwidth_hpf;
    std::uint8_t nrb_bandwidth_lpf;
    std::uint8_t mixer_top;
    std::uint8_t mixer_vth;
    std::uint8_t mixer_vtl;
    std::uint8_t mixer_amp_lpf;
    std::uint8_t mixer_gain_limit;
    std::uint8_t mixer_detector_bandwidth_lpf;
    std::uint8_t mixer_filter_disable;
    std::uint8_t filter_top;
    std::uint8_t filter_vth;
    std::uint8_t filter_vtl;
    std::uint8_t filter_third_lpf_current;
    std::uint8_t filter_third_lpf_gain;
    std::uint8_t baseband_disable_current;
    std::uint8_t baseband_detector_mode;
    std::uint8_t na_power_detector;
    std::uint8_t enable_poly_gain;
    std::uint8_t image_nrb_adder;
    std::uint8_t hpf_compensation;
    std::uint8_t first_feedback_resistor;
};

constexpr std::array<std::uint8_t, kRegisterCount> kInitRegisters{
    0x00U, 0x00U, 0x00U, 0x00U, 0x00U, 0x00U, 0x00U, 0x00U,
    0xcaU, 0xc0U, 0x72U, 0x50U, 0x00U, 0xe0U, 0x00U, 0x30U,
    0x86U, 0xbbU, 0xf8U, 0xb0U, 0xd2U, 0x81U, 0xcdU, 0x46U,
    0x37U, 0x40U, 0x89U, 0x8cU, 0x55U, 0x95U, 0x07U, 0x23U,
    0x21U, 0xf1U, 0x4cU, 0x5fU, 0xc4U, 0x20U, 0xa9U, 0x6cU,
    0x53U, 0xabU, 0x5bU, 0x46U, 0xb3U, 0x93U, 0x6eU, 0x41U};

// The two rows are the complete isdb_t_params[2][3] legacy table.  The
// calibration fields are retained as data only; Q3U4 fixes both calibration
// flags off, so no calibration machinery is part of this slice.
constexpr std::array<std::array<R850SystemParameters, 3U>, 2U>
    kIsdbTSystemParameters{
        std::array<R850SystemParameters, 3U>{{
        {R850Bandwidth::mhz_6, 4063U, 7070U, 1U, 0U, 0U, 0x08U, 1U, 0U,
         0U, R850LpfParameters{0x02U, 3U, 1U}},
        {R850Bandwidth::mhz_6, 4570U, 7400U, 1U, 0U, 0U, 0x05U, 1U, 0U,
         0U, R850LpfParameters{0x08U, 2U, 0U}},
        {R850Bandwidth::mhz_6, 5000U, 7780U, 1U, 1U, 0U, 0x03U, 1U, 0U,
         0U, R850LpfParameters{0x05U, 2U, 0U}},
        }},
        std::array<R850SystemParameters, 3U>{{
        {R850Bandwidth::mhz_6, 4063U, 7070U, 1U, 0U, 0U, 0x0aU, 1U, 3U,
         1U, R850LpfParameters{0x02U, 3U, 1U}},
        {R850Bandwidth::mhz_6, 4570U, 7400U, 1U, 0U, 0U, 0x08U, 1U, 3U,
         1U, R850LpfParameters{0x08U, 2U, 0U}},
        {R850Bandwidth::mhz_6, 5000U, 7780U, 1U, 0U, 0U, 0x03U, 1U, 3U,
         1U, R850LpfParameters{0x05U, 2U, 0U}},
        }}};

// This is the complete ten-entry ISDB-T table.  Entries 0..4 are the
// 4063-kHz rows; entries 5..9 are the legacy generic rows.  Selection is
// deliberately first-match, including the wildcard min/max rows.
constexpr std::array<R850FrequencyParameters, 10U> kIsdbTFrequencyParameters{{
    {4063U, 0U, 340000U, 5U, 0x6bU, 0U, 1U, 1U, 1U, 0x05U,
     5U, 0x4aU, 0U, 0x05U, 1U, 12U, 0U, 2U, 15U, 0x09U, 0x04U, 7U,
     3U, 0U, 0U, 12U, 0x09U, 0x04U, 1U, 0U, 1U, 0U, 1U, 0U, 2U, 2U, 1U},
    {4063U, 470000U, 487999U, 6U, 0x8cU, 0U, 1U, 1U, 1U, 0x05U,
     5U, 0x6bU, 0U, 0x05U, 1U, 3U, 0U, 2U, 14U, 0x09U, 0x04U, 7U,
     3U, 0U, 0U, 12U, 0x09U, 0x04U, 1U, 3U, 1U, 0U, 1U, 1U, 3U, 2U, 1U},
    {4063U, 680000U, 691999U, 5U, 0x5aU, 0U, 2U, 1U, 1U, 0x07U,
     6U, 0x6bU, 0U, 0x04U, 1U, 3U, 0U, 2U, 14U, 0x09U, 0x05U, 7U,
     3U, 0U, 0U, 12U, 0x09U, 0x04U, 1U, 3U, 1U, 0U, 0U, 1U, 3U, 2U, 1U},
    {4063U, 692000U, 697999U, 5U, 0x5bU, 0U, 2U, 1U, 1U, 0x07U,
     6U, 0x6bU, 0U, 0x04U, 1U, 10U, 0U, 3U, 12U, 0x09U, 0x05U, 7U,
     3U, 0U, 0U, 12U, 0x09U, 0x04U, 1U, 3U, 1U, 0U, 0U, 1U, 2U, 2U, 1U},
    {4063U, 0U, 0U, 5U, 0x5aU, 0U, 1U, 1U, 1U, 0x05U,
     6U, 0x6bU, 0U, 0x05U, 1U, 3U, 0U, 2U, 14U, 0x09U, 0x04U, 7U,
     3U, 0U, 0U, 12U, 0x09U, 0x04U, 1U, 3U, 1U, 0U, 1U, 1U, 3U, 2U, 1U},
    {0U, 0U, 340000U, 5U, 0x6bU, 0U, 1U, 1U, 1U, 0x05U,
     5U, 0x4aU, 0U, 0x05U, 1U, 12U, 0U, 2U, 15U, 0x0bU, 0x06U, 7U,
     3U, 0U, 0U, 12U, 0x09U, 0x04U, 1U, 0U, 1U, 0U, 1U, 0U, 2U, 2U, 1U},
    {0U, 470000U, 487999U, 5U, 0x5aU, 0U, 2U, 1U, 1U, 0x07U,
     6U, 0x6bU, 0U, 0x04U, 1U, 3U, 0U, 2U, 14U, 0x09U, 0x05U, 7U,
     3U, 0U, 0U, 12U, 0x09U, 0x04U, 1U, 3U, 1U, 0U, 0U, 1U, 3U, 2U, 1U},
    {0U, 680000U, 691999U, 5U, 0x5bU, 0U, 2U, 1U, 1U, 0x07U,
     6U, 0x6bU, 0U, 0x04U, 1U, 10U, 0U, 3U, 12U, 0x09U, 0x05U, 7U,
     3U, 0U, 0U, 12U, 0x09U, 0x04U, 1U, 3U, 1U, 0U, 0U, 1U, 2U, 2U, 1U},
    {0U, 692000U, 697999U, 5U, 0x5aU, 0U, 1U, 1U, 1U, 0x05U,
     6U, 0x6bU, 0U, 0x05U, 1U, 3U, 0U, 2U, 14U, 0x09U, 0x04U, 7U,
     3U, 0U, 0U, 12U, 0x09U, 0x04U, 1U, 3U, 1U, 0U, 1U, 1U, 3U, 2U, 1U},
    {0U, 0U, 0U, 5U, 0x5aU, 0U, 1U, 1U, 1U, 0x05U,
     6U, 0x6bU, 0U, 0x05U, 1U, 3U, 0U, 2U, 14U, 0x09U, 0x04U, 7U,
     3U, 0U, 0U, 12U, 0x09U, 0x04U, 1U, 3U, 1U, 0U, 1U, 1U, 3U, 2U, 1U},
}};

std::uint8_t reverse_bits(std::uint8_t value) noexcept
{
    value = static_cast<std::uint8_t>(((value & 0x55U) << 1U) |
                                      ((value & 0xaaU) >> 1U));
    value = static_cast<std::uint8_t>(((value & 0x33U) << 2U) |
                                      ((value & 0xccU) >> 2U));
    return static_cast<std::uint8_t>((value << 4U) | (value >> 4U));
}

const R850FrequencyParameters* find_frequency_parameters(
    std::uint32_t if_frequency_khz, std::uint32_t rf_frequency_khz,
    std::uint8_t* row_index) noexcept
{
    for (std::size_t index = 0U; index < kIsdbTFrequencyParameters.size(); ++index) {
        const auto& parameters = kIsdbTFrequencyParameters[index];
        if ((parameters.if_frequency == 0U ||
             parameters.if_frequency == if_frequency_khz) &&
            (parameters.rf_minimum == 0U ||
             parameters.rf_minimum <= rf_frequency_khz) &&
            (parameters.rf_maximum == 0U ||
             parameters.rf_maximum >= rf_frequency_khz)) {
            if (row_index != nullptr) {
                *row_index = static_cast<std::uint8_t>(index);
            }
            return &parameters;
        }
    }
    return nullptr;
}

}  // namespace

Result<R850FrequencySelection> r850_select_isdb_t_frequency(
    std::uint32_t if_frequency_khz, std::uint32_t rf_frequency_khz) noexcept
{
    std::uint8_t row_index = 0U;
    if (find_frequency_parameters(if_frequency_khz, rf_frequency_khz, &row_index) == nullptr) {
        return Result<R850FrequencySelection>::failure(Error::INVALID_ARGUMENT);
    }
    return Result<R850FrequencySelection>::success(R850FrequencySelection{row_index});
}

Result<std::vector<std::uint8_t>> R850::read_regs(
    std::uint8_t reg, std::size_t length) noexcept
{
    if (length == 0U || reg >= kRegisterCount || length > (kRegisterCount - reg)) {
        return Result<std::vector<std::uint8_t>>::failure(Error::INVALID_ARGUMENT);
    }
    std::vector<std::uint8_t> raw(reg + length, 0U);
    const std::array<std::uint8_t, 1U> pointer{0x00U};
    Tc90522I2cRequest requests[2]{
        Tc90522I2cRequest{Tc90522RequestType::write, kR850Address,
                          ByteView{pointer.data(), pointer.size()},
                          MutableByteView{nullptr, 0U}},
        Tc90522I2cRequest{Tc90522RequestType::read, kR850Address,
                          ByteView{nullptr, 0U},
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

Result<void> R850::write_regs(std::uint8_t reg, ByteView values) noexcept
{
    if (values.data == nullptr || values.size == 0U || reg >= kRegisterCount ||
        values.size > (kRegisterCount - reg) || values.size > kRegisterWriteMax) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    std::array<std::uint8_t, kRegisterCount + 1U> output{};
    output[0] = reg;
    std::copy(values.data, values.data + values.size, output.begin() + 1U);
    Tc90522I2cRequest request{
        Tc90522RequestType::write, kR850Address,
        ByteView{output.data(), values.size + 1U}, MutableByteView{nullptr, 0U}};
    return demod_.downstream_request(&request, 1U);
}

Result<void> R850::check_xtal_power() noexcept
{
    registers_ = kInitRegisters;
    registers_[0x2fU] &= chip_variant_ ? 0xfdU : 0xfcU;
    registers_[0x1bU] = static_cast<std::uint8_t>((registers_[0x1bU] & 0x80U) | 0x12U);
    registers_[0x1eU] = static_cast<std::uint8_t>((registers_[0x1eU] & 0xe0U) | 0x08U);
    registers_[0x22U] &= 0x27U;
    registers_[0x1dU] &= 0x0fU;
    registers_[0x21U] |= 0xf8U;
    registers_[0x22U] = static_cast<std::uint8_t>((registers_[0x22U] & 0x77U) | 0x80U);
    registers_[0x1fU] = static_cast<std::uint8_t>((registers_[0x1fU] & 0x80U) | 0x40U);
    registers_[0x1fU] &= 0xbfU;

    const auto initial_write = write_regs(
        0x08U, ByteView{registers_.data() + 0x08U, kRegisterCount - 0x08U});
    if (!initial_write) {
        return initial_write;
    }

    std::uint8_t selected_power = 3U;
    for (std::uint8_t index = 0U; index <= 3U; ++index) {
        registers_[0x22U] = static_cast<std::uint8_t>(
            (registers_[0x22U] & 0xcfU) | (index << 4U));
        const auto write = write_regs(
            0x22U, ByteView{registers_.data() + 0x22U, 1U});
        if (!write) {
            return write;
        }
        const auto value = read_regs(0x02U, 1U);
        if (!value) {
            return Result<void>::failure(value.error());
        }
        const std::uint8_t sample = value.value()[0];
        if ((sample & 0x40U) != 0U &&
            (static_cast<int>(sample & 0x3fU) - (55 - 6)) <= 12) {
            selected_power = index;
            break;
        }
    }
    if (selected_power < 3U) {
        ++selected_power;
    }
    xtal_power_ = selected_power;
    return Result<void>::success();
}

Result<void> R850::initialize() noexcept
{
    initialized_ = false;
    system_set_ = false;
    current_valid_ = false;
    chip_variant_ = false;
    xtal_power_ = 3U;
    registers_.fill(0U);

    Result<std::vector<std::uint8_t>> probe =
        Result<std::vector<std::uint8_t>>::failure(Error::INTERNAL);
    for (std::size_t attempt = 0U; attempt < 4U; ++attempt) {
        probe = read_regs(0x00U, 1U);
        if (!probe) {
            continue;
        }
        if ((probe.value()[0] & 0x98U) != 0U) {
            chip_variant_ = true;
            break;
        }
    }
    if (!probe) {
        return Result<void>::failure(probe.error());
    }

    const auto saved = read_regs(0x08U, kRegisterCount - 0x08U);
    if (!saved) {
        return Result<void>::failure(saved.error());
    }
    const auto xtal = check_xtal_power();
    if (!xtal) {
        return xtal;
    }
    const auto restore = write_regs(
        0x08U, ByteView{saved.value().data(), saved.value().size()});
    if (!restore) {
        return restore;
    }
    registers_ = kInitRegisters;
    initialized_ = true;
    return Result<void>::success();
}

Result<void> R850::terminate() noexcept
{
    initialized_ = false;
    system_set_ = false;
    current_valid_ = false;
    chip_variant_ = false;
    xtal_power_ = 3U;
    registers_.fill(0U);
    return Result<void>::success();
}

Result<void> R850::sleep() noexcept
{
    // Both legacy bodies are under #if 0.  They are intentionally observable
    // no-ops for the fixed Q3U4 path.
    return initialized_ ? Result<void>::success()
                        : Result<void>::failure(Error::NOT_READY);
}

Result<void> R850::wakeup() noexcept
{
    return initialized_ ? Result<void>::success()
                        : Result<void>::failure(Error::NOT_READY);
}

Result<void> R850::set_system(const R850SystemConfig& system) noexcept
{
    if (!initialized_ || system.system != R850System::isdb_t ||
        system.bandwidth != R850Bandwidth::mhz_6 ||
        system.if_frequency_khz != 4063U) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    system_ = system;
    system_set_ = true;
    current_valid_ = false;
    return Result<void>::success();
}

Result<void> R850::set_system_params() noexcept
{
    if (!system_set_) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    if (current_valid_ && current_.system == system_.system &&
        current_.bandwidth == system_.bandwidth &&
        current_.if_frequency_khz == system_.if_frequency_khz) {
        return Result<void>::success();
    }

    const R850SystemParameters* selected = nullptr;
    const auto& system_parameters =
        kIsdbTSystemParameters[chip_variant_ ? 1U : 0U];
    for (const auto& parameters : system_parameters) {
        if (parameters.bandwidth == system_.bandwidth &&
            parameters.if_frequency == system_.if_frequency_khz) {
            selected = &parameters;
            break;
        }
    }
    if (selected == nullptr) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }

    registers_ = kInitRegisters;
    registers_[0x17U] = static_cast<std::uint8_t>(
        (selected->lpf.lsb & 0x01U) |
        ((selected->lpf.code << 1U) & 0x1eU) |
        ((selected->lpf.bandwidth << 5U) & 0x60U) |
        ((selected->hpf_notch << 7U) & 0x80U));
    registers_[0x18U] = static_cast<std::uint8_t>(
        (registers_[0x18U] & 0x0fU) |
        ((selected->hpf_correction << 4U) & 0xf0U));
    registers_[0x12U] = static_cast<std::uint8_t>(
        (registers_[0x12U] & 0xbfU) |
        ((selected->filter_ext_enable << 6U) & 0x40U));
    registers_[0x18U] = static_cast<std::uint8_t>(
        (registers_[0x18U] & 0xf3U) |
        ((selected->filter_compensation << 2U) & 0x0cU));
    registers_[0x2fU] = static_cast<std::uint8_t>(
        (registers_[0x2fU] & 0xf3U) |
        ((selected->agc_clock << 2U) & 0x0cU));
    if (chip_variant_) {
        registers_[0x2cU] = static_cast<std::uint8_t>(
            (registers_[0x2cU] & 0xfeU) | ((selected->image_gain >> 1U) & 0x01U));
    }
    registers_[0x2eU] = static_cast<std::uint8_t>(
        (registers_[0x2eU] & 0xefU) | ((selected->image_gain << 4U) & 0x10U));
    current_ = system_;
    current_valid_ = true;
    return Result<void>::success();
}

Result<void> R850::set_system_frequency(std::uint32_t rf_frequency_khz) noexcept
{
    std::uint8_t row_index = 0U;
    const auto* selected = find_frequency_parameters(
        current_.if_frequency_khz, rf_frequency_khz, &row_index);
    (void)row_index;
    if (selected == nullptr) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }

    auto parameters = *selected;
    if (chip_variant_) {
        parameters.filter_top = 6U;
    }
    const std::uint32_t lo_frequency_khz =
        rf_frequency_khz - current_.if_frequency_khz;

    registers_[0x13U] &= 0xefU;
    registers_[0x13U] |= 0x10U;
    registers_[0x0aU] = static_cast<std::uint8_t>(
        (registers_[0x0aU] & 0xbfU) | ((parameters.na_power_detector << 6U) & 0x40U));
    registers_[0x10U] = static_cast<std::uint8_t>(
        (registers_[0x10U] & 0xdfU) | (kInitRegisters[0x0cU] & 0x20U));
    registers_[0x0bU] = static_cast<std::uint8_t>(
        (registers_[0x0bU] & 0x7fU) | ((parameters.lna_nrb_detector << 7U) & 0x80U));
    registers_[0x26U] = static_cast<std::uint8_t>(
        (registers_[0x26U] & 0xf8U) | ((7U - parameters.lna_top) & 0x07U));
    registers_[0x27U] = parameters.lna_vtl_high;
    registers_[0x11U] = static_cast<std::uint8_t>(
        (registers_[0x11U] & 0xefU) | ((parameters.rf_lte_psg << 4U) & 0x10U));
    registers_[0x26U] = static_cast<std::uint8_t>(
        (registers_[0x26U] & 0x8fU) | (((7U - parameters.rf_top) << 4U) & 0x70U));
    registers_[0x2aU] = parameters.rf_vtl_high;
    if (parameters.rf_gain_limit <= 3U) {
        if (parameters.rf_gain_limit < 2U) {
            registers_[0x12U] &= 0xfbU;
        } else {
            registers_[0x12U] |= 0x02U;
        }
        if ((parameters.rf_gain_limit % 2U) != 0U) {
            registers_[0x10U] |= 0x40U;
        } else {
            registers_[0x10U] &= 0xbfU;
        }
    }
    registers_[0x13U] = static_cast<std::uint8_t>(
        (registers_[0x13U] & 0xf8U) | (parameters.mixer_amp_lpf & 0x07U));
    registers_[0x28U] = static_cast<std::uint8_t>(
        (registers_[0x28U] & 0xf0U) | ((15U - parameters.mixer_top) & 0x0fU));
    if (chip_variant_) {
        registers_[0x2cU] = static_cast<std::uint8_t>(
            (registers_[0x2cU] & 0xf1U) |
            (((7U - parameters.filter_top) << 1U) & 0x0eU));
    } else {
        registers_[0x2cU] = static_cast<std::uint8_t>(
            (registers_[0x2cU] & 0xf0U) |
            ((15U - parameters.filter_top) & 0x0fU));
    }
    registers_[0x0aU] = static_cast<std::uint8_t>(
        (registers_[0x0aU] & 0xefU) | ((parameters.filter_third_lpf_current << 4U) & 0x10U));
    registers_[0x18U] = static_cast<std::uint8_t>(
        (registers_[0x18U] & 0xfcU) | (parameters.filter_third_lpf_gain & 0x03U));
    registers_[0x29U] = static_cast<std::uint8_t>(
        ((parameters.filter_vth << 4U) & 0xf0U) | (parameters.mixer_vth & 0x0fU));
    registers_[0x2bU] = static_cast<std::uint8_t>(
        ((parameters.filter_vtl << 4U) & 0xf0U) | (parameters.mixer_vtl & 0x0fU));
    registers_[0x16U] = static_cast<std::uint8_t>(
        (registers_[0x16U] & 0x3fU) | ((parameters.mixer_gain_limit << 6U) & 0xc0U));
    registers_[0x2eU] = static_cast<std::uint8_t>(
        (registers_[0x2eU] & 0x7fU) |
        ((parameters.mixer_detector_bandwidth_lpf << 7U) & 0x80U));
    switch (parameters.lna_rf_disable_mode) {
    case 1U:
        registers_[0x2dU] |= 0x03U;
        registers_[0x1fU] |= 0x01U;
        registers_[0x20U] |= 0x20U;
        break;
    case 2U:
        registers_[0x2dU] |= 0x03U;
        registers_[0x1fU] &= 0xfeU;
        registers_[0x20U] &= 0xdfU;
        break;
    case 3U:
        registers_[0x2dU] |= 0x03U;
        registers_[0x1fU] |= 0x01U;
        registers_[0x20U] &= 0xdfU;
        break;
    case 4U:
        registers_[0x2dU] |= 0x03U;
        registers_[0x1fU] &= 0xfeU;
        registers_[0x20U] |= 0x20U;
        break;
    default:
        registers_[0x2dU] &= 0xfcU;
        registers_[0x1fU] |= 0x01U;
        registers_[0x20U] |= 0x20U;
        break;
    }
    registers_[0x1fU] = static_cast<std::uint8_t>(
        (registers_[0x1fU] & 0xfdU) |
        ((parameters.lna_rf_charge_current << 1U) & 0x02U));
    registers_[0x0dU] = static_cast<std::uint8_t>(
        (registers_[0x0dU] & 0xdfU) |
        ((parameters.lna_rf_disable_current << 5U) & 0x20U));
    registers_[0x2dU] = static_cast<std::uint8_t>(
        (registers_[0x2dU] & 0x0fU) |
        ((parameters.rf_disable_slow_fast << 4U) & 0xf0U));
    registers_[0x2cU] = static_cast<std::uint8_t>(
        (registers_[0x2cU] & 0x0fU) |
        ((parameters.lna_disable_slow_fast << 4U) & 0xf0U));
    registers_[0x19U] = static_cast<std::uint8_t>(
        (registers_[0x19U] & 0xbfU) |
        ((parameters.baseband_disable_current << 6U) & 0x40U));
    registers_[0x25U] = static_cast<std::uint8_t>(
        (registers_[0x25U] & 0x3bU) |
        ((parameters.mixer_filter_disable << 6U) & 0xc0U) |
        ((parameters.baseband_detector_mode << 2U) & 0x04U));
    registers_[0x19U] = static_cast<std::uint8_t>(
        (registers_[0x19U] & 0xfdU) |
        ((parameters.enable_poly_gain << 1U) & 0x02U));
    registers_[0x28U] = static_cast<std::uint8_t>(
        (registers_[0x28U] & 0x0fU) |
        (((15U - parameters.nrb_top) << 4U) & 0xf0U));
    registers_[0x1aU] = static_cast<std::uint8_t>(
        (registers_[0x1aU] & 0x33U) |
        ((parameters.nrb_bandwidth_lpf << 6U) & 0xc0U) |
        ((parameters.nrb_bandwidth_hpf << 2U) & 0x0cU));
    registers_[0x2eU] = static_cast<std::uint8_t>(
        (registers_[0x2eU] & 0xf3U) |
        ((parameters.image_nrb_adder << 2U) & 0x0cU));
    registers_[0x0dU] = static_cast<std::uint8_t>(
        (registers_[0x0dU] & 0xf9U) |
        ((parameters.hpf_compensation << 1U) & 0x06U));
    registers_[0x15U] = static_cast<std::uint8_t>(
        (registers_[0x15U] & 0xefU) |
        ((parameters.first_feedback_resistor << 4U) & 0x10U));
    if ((rf_frequency_khz - 478000U) <= 3999U) {
        registers_[0x2fU] &= 0xf3U;
    }
    registers_[0x19U] &= 0xdfU;
    if (loop_through_) {
        registers_[0x08U] |= 0xc0U;
        registers_[0x0aU] |= 0x02U;
    } else {
        registers_[0x08U] = static_cast<std::uint8_t>(
            (registers_[0x08U] & 0x3fU) | 0x40U);
        registers_[0x0aU] &= 0xfdU;
    }
    registers_[0x22U] |= 0x04U;

    const auto mux = set_mux(rf_frequency_khz, lo_frequency_khz);
    if (!mux) {
        return mux;
    }
    return set_pll(lo_frequency_khz, current_.if_frequency_khz);
}

Result<void> R850::set_mux(std::uint32_t rf_frequency_khz,
                            std::uint32_t lo_frequency_khz) noexcept
{
    (void)rf_frequency_khz;
    const std::uint8_t diplexer = lo_frequency_khz < 330000U ? 2U : 0U;
    const std::uint8_t bpf = lo_frequency_khz < 580000U ? 7U :
                             lo_frequency_khz < 660000U ? 1U :
                             lo_frequency_khz < 780000U ? 6U :
                             lo_frequency_khz < 900000U ? 4U : 0U;
    const std::uint8_t rf_poly = lo_frequency_khz < 133000U ? 2U :
                                 lo_frequency_khz < 221000U ? 1U :
                                 lo_frequency_khz < 760000U ? 0U : 3U;
    const std::uint8_t cnr = lo_frequency_khz < 480000U ? 3U :
                             lo_frequency_khz < 550000U ? 2U :
                             lo_frequency_khz < 700000U ? 1U : 0U;
    const std::uint8_t lpf_notch = lo_frequency_khz < 73000U ? 10U :
                                   lo_frequency_khz < 81000U ? 4U :
                                   lo_frequency_khz < 89000U ? 3U :
                                   lo_frequency_khz < 121000U ? 1U : 0U;
    const std::uint8_t lpf_cap = lo_frequency_khz < 73000U ? 8U :
                                 lo_frequency_khz < 81000U ? 8U :
                                 lo_frequency_khz < 89000U ? 8U :
                                 lo_frequency_khz < 121000U ? 6U :
                                 lo_frequency_khz < 145000U ? 4U :
                                 lo_frequency_khz < 153000U ? 3U :
                                 lo_frequency_khz < 177000U ? 2U :
                                 lo_frequency_khz < 201000U ? 1U : 0U;

    registers_[0x0eU] = static_cast<std::uint8_t>(
        (registers_[0x0eU] & 0x03U) | ((diplexer << 2U) & 0x0cU) |
        ((lpf_cap << 4U) & 0xf0U));
    registers_[0x0fU] = static_cast<std::uint8_t>(
        (registers_[0x0fU] & 0xf0U) | (lpf_notch & 0x0fU));
    registers_[0x10U] = static_cast<std::uint8_t>(
        (registers_[0x10U] & 0xe0U) | ((cnr << 3U) & 0x18U) | (bpf & 0x07U));
    registers_[0x12U] = static_cast<std::uint8_t>(
        (registers_[0x12U] & 0xfcU) | (rf_poly & 0x03U));
    registers_[0x14U] = static_cast<std::uint8_t>(
        (registers_[0x14U] & 0xd0U) | 0x02U);
    registers_[0x15U] &= 0x10U;
    return Result<void>::success();
}

Result<void> R850::set_pll(std::uint32_t lo_frequency_khz,
                           std::uint32_t if_frequency_khz) noexcept
{
    std::uint32_t xtal = 24000U;
    const std::uint32_t vco_min = chip_variant_ ? 2200000U : 2270000U;
    const std::uint32_t vco_max = vco_min * 2U;
    std::uint32_t vco_frequency = lo_frequency_khz * 2U;
    std::uint16_t nsdm = 2U;
    std::uint16_t sdm = 0U;
    std::uint8_t mix_div = 2U;
    std::uint8_t divider = 0U;
    std::uint8_t xtal_div = 0U;

    registers_[0x20U] &= 0xfcU;
    registers_[0x2eU] |= 0x40U;
    registers_[0x0cU] &= 0x3cU;
    registers_[0x09U] &= 0xf9U;
    registers_[0x22U] &= 0x3fU;
    registers_[0x0bU] = static_cast<std::uint8_t>((registers_[0x0bU] & 0xc3U) | 0x10U);
    registers_[0x25U] = static_cast<std::uint8_t>((registers_[0x25U] & 0xefU) | 0x20U);

    std::uint8_t xtal_power = 0U;
    if (lo_frequency_khz < 100000U) {
        xtal_power = xtal_power_ > 1U ? static_cast<std::uint8_t>(3U - xtal_power_) : 2U;
    } else if (lo_frequency_khz < 130000U) {
        xtal_power = xtal_power_ > 2U ? static_cast<std::uint8_t>(3U - xtal_power_) : 1U;
    }
    registers_[0x22U] = static_cast<std::uint8_t>(
        (registers_[0x22U] & 0xcfU) | ((xtal_power << 4U) & 0x30U));

    const std::uint8_t cap = 0x27U;
    const std::uint8_t cap_value = static_cast<std::uint8_t>(cap - 10U);
    registers_[0x21U] = static_cast<std::uint8_t>(
        (registers_[0x21U] & 0x07U) | ((cap_value << 2U) & 0x78U) | 0x80U);
    registers_[0x22U] = static_cast<std::uint8_t>(
        (registers_[0x22U] & 0xf7U) | ((cap_value << 3U) & 0x08U));

    const std::uint16_t divider_judge = static_cast<std::uint16_t>(
        (lo_frequency_khz + if_frequency_khz) / 1000U / 12U);
    registers_[0x1eU] &= 0x1fU;
    registers_[0x25U] &= 0xfdU;
    if (divider_judge == 4U || divider_judge == 10U || divider_judge == 22U ||
        divider_judge == 24U || divider_judge == 28U) {
        registers_[0x25U] |= 0x02U;
    }
    registers_[0x2fU] &= chip_variant_ ? 0xfdU : 0xfcU;
    while (divider < 6U && !(vco_min <= vco_frequency && vco_frequency < vco_max)) {
        mix_div = static_cast<std::uint8_t>(mix_div * 2U);
        vco_frequency = lo_frequency_khz * mix_div;
        ++divider;
    }

    if (lo_frequency_khz < 380500U && (divider_judge & 1U) == 0U) {
        xtal /= 2U;
        registers_[0x22U] = static_cast<std::uint8_t>((registers_[0x22U] & 0xfcU) | 0x02U);
        xtal_div = 1U;
    } else if ((lo_frequency_khz + if_frequency_khz - 478000U) < 4000U) {
        xtal /= 4U;
        registers_[0x22U] = static_cast<std::uint8_t>((registers_[0x22U] & 0xfcU) | 0x03U);
        xtal_div = 3U;
    } else {
        registers_[0x22U] &= 0xfcU;
    }
    registers_[0x0bU] &= 0xfeU;
    registers_[0x2dU] &= 0xf3U;
    if (mix_div == 8U) {
        registers_[0x2dU] |= 0x04U;
    } else if (mix_div == 16U) {
        registers_[0x2dU] |= 0x08U;
    } else if (mix_div >= 32U) {
        registers_[0x2dU] |= 0x0cU;
    }
    registers_[0x2eU] &= 0xfcU;
    registers_[0x20U] &= 0xecU;
    if (mix_div == 2U || mix_div == 4U) {
        registers_[0x2eU] |= 0x01U;
    } else {
        registers_[0x2eU] |= 0x02U;
        registers_[0x20U] |= 0x01U;
    }
    registers_[0x11U] &= 0x7fU;
    if (mix_div == 8U) {
        registers_[0x11U] |= 0x80U;
    }
    registers_[0x1eU] = static_cast<std::uint8_t>(
        (registers_[0x1eU] & 0xe3U) | ((divider << 2U) & 0x1cU));

    std::uint16_t nint = static_cast<std::uint16_t>((vco_frequency / 2U) / xtal);
    std::uint16_t vco_fraction = static_cast<std::uint16_t>(
        vco_frequency - (xtal * 2U * nint));
    if (vco_fraction < (xtal / 64U)) {
        vco_fraction = 0U;
    } else if (vco_fraction > (xtal * 127U / 64U)) {
        vco_fraction = 0U;
        ++nint;
    } else if (vco_fraction > (xtal * 127U / 128U) && xtal > vco_fraction) {
        vco_fraction = static_cast<std::uint16_t>(xtal * 127U / 128U);
    } else if (xtal < vco_fraction && vco_fraction < (xtal * 129U / 128U)) {
        vco_fraction = static_cast<std::uint16_t>(xtal * 129U / 128U);
    }
    const std::uint8_t ni = static_cast<std::uint8_t>((nint - 13U) / 4U);
    const std::uint8_t si = static_cast<std::uint8_t>(nint - 13U - ni * 4U);
    registers_[0x1bU] = static_cast<std::uint8_t>((registers_[0x1bU] & 0x80U) | (ni & 0x7fU));
    registers_[0x1eU] = static_cast<std::uint8_t>((registers_[0x1eU] & 0xfcU) | (si & 0x03U));
    registers_[0x20U] &= 0x3fU;
    while (vco_fraction > 1U) {
        if ((xtal * 2U / nsdm) < vco_fraction) {
            vco_fraction = static_cast<std::uint16_t>(vco_fraction - (xtal * 2U / nsdm));
            sdm = static_cast<std::uint16_t>(sdm + 0x8000U / (nsdm / 2U));
            if ((nsdm & 0x8000U) != 0U) {
                break;
            }
        }
        nsdm = static_cast<std::uint16_t>(nsdm + nsdm);
    }
    registers_[0x1cU] = static_cast<std::uint8_t>(sdm & 0xffU);
    registers_[0x1dU] = static_cast<std::uint8_t>(sdm >> 8U);

    const auto write = write_regs(
        0x08U, ByteView{registers_.data() + 0x08U, 0x28U});
    if (!write) {
        return write;
    }
    delay_.sleep_ms(xtal_div == 0U ? 10U : (xtal_div <= 2U ? 20U : 40U));
    if (!chip_variant_) {
        registers_[0x2fU] &= 0xfcU;
    }
    registers_[0x2fU] |= 0x02U;
    return write_regs(0x2fU, ByteView{registers_.data() + 0x2fU, 1U});
}

Result<void> R850::set_frequency(std::uint32_t frequency_khz) noexcept
{
    if (!initialized_ || frequency_khz < 40000U || frequency_khz > 1002000U) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    const auto system = set_system_params();
    if (!system) {
        return system;
    }
    return set_system_frequency(frequency_khz);
}

Result<bool> R850::is_pll_locked() noexcept
{
    if (!initialized_) {
        return Result<bool>::failure(Error::NOT_READY);
    }
    const auto value = read_regs(0x02U, 1U);
    if (!value) {
        return Result<bool>::failure(value.error());
    }
    return Result<bool>::success((value.value()[0] & 0x40U) != 0U);
}

}  // namespace px4::userland
