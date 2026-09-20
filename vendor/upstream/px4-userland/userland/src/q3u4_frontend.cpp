// Modified/ported for px4-userland on 2026-09-03.
//
// Copyright (c) 2018-2021 nns779
// Derived from tsukumijima/px4_drv commit 9eedea8c502875a788697984b93b50032339b9aa.
// Origin paths: driver/px4_device.c, driver/px4_device.h,
// winusb/src/DriverHost_PX4/px4_device.cpp,
// winusb/src/DriverHost_PX4/px4_device.hpp.
// Source snapshot maintained by tsukumijima.
// SPDX-License-Identifier: GPL-2.0-only

#include "q3u4_frontend.h"

#include <array>
#include <vector>

namespace px4::userland {
namespace {

constexpr std::array<std::array<std::uint8_t, 2U>, 10U> kTcInitTValues{{
    {{0xb0U, 0xa0U}}, {{0xb2U, 0x3dU}}, {{0xb3U, 0x25U}}, {{0xb4U, 0x8bU}},
    {{0xb5U, 0x4bU}}, {{0xb6U, 0x3fU}}, {{0xb7U, 0xffU}}, {{0xb8U, 0xc0U}},
    {{0x1fU, 0x00U}}, {{0x75U, 0x00U}},
}};
constexpr std::array<std::array<std::uint8_t, 2U>, 3U> kTcInitSValues{{
    {{0x15U, 0x00U}}, {{0x1dU, 0x00U}}, {{0x04U, 0x02U}},
}};

constexpr std::array<std::array<std::uint8_t, 2U>, 2U> kSharedS0{{
    {{0x07U, 0x31U}}, {{0x08U, 0x77U}},
}};
constexpr std::array<std::array<std::uint8_t, 2U>, 2U> kSharedT0{{
    {{0x0eU, 0x77U}}, {{0x0fU, 0x13U}},
}};

template <std::size_t N>
Result<void> write_fixed(Tc90522& demod,
                         const std::array<std::array<std::uint8_t, 2U>, N>& values) noexcept
{
    std::vector<Tc90522RegisterWrite> writes;
    writes.reserve(N);
    for (std::size_t i = 0U; i < N; ++i) {
        writes.push_back(Tc90522RegisterWrite{values[i][0], ByteView{&values[i][1], 1U}});
    }
    return demod.write_multiple_regs(writes);
}

Error combine_errors(Error first, const Result<void>& result) noexcept
{
    if (result && first == Error::OK) return Error::OK;
    if (!result && result.error() == Error::DISCONNECTED) return Error::DISCONNECTED;
    return first == Error::OK && !result ? result.error() : first;
}

}  // namespace

Result<void> It930xBackendPower::set_backend_power(bool on, Q3U4Delay& delay) noexcept
{
    return controller_.set_q3u4_backend_power(on, delay);
}

Result<void> It930xPsbPurger::purge() noexcept
{
    return controller_.purge_psb(timeout_);
}

Result<void> Q3U4DirectReceiverPowerAuthority::acquire_receiver(
    std::uint8_t, Q3U4Delay& delay) noexcept
{
    if (acquired_) return Result<void>::failure(Error::BUSY);
    const auto result = power_.set_backend_power(true, delay);
    if (!result) {
        // Keep the developer probe's conservative cleanup behavior: a failed
        // first direct power attempt is followed by one best-effort off write.
        (void)power_.set_backend_power(false, delay);
        return result;
    }
    acquired_ = true;
    return Result<void>::success();
}

Result<void> Q3U4DirectReceiverPowerAuthority::release_receiver(
    std::uint8_t, Q3U4Delay& delay) noexcept
{
    if (!acquired_) return Result<void>::failure(Error::INVALID_ARGUMENT);
    const auto result = power_.set_backend_power(false, delay);
    if (result) acquired_ = false;
    return result;
}

Result<void> Q3U4DirectReceiverPowerAuthority::retry_release(
    Q3U4Delay& delay) noexcept
{
    return release_receiver(0U, delay);
}

Result<void> Q3U4CoordinatorReceiverPowerAuthority::acquire_receiver(
    std::uint8_t global_receiver, Q3U4Delay&) noexcept
{
    if (global_receiver < global_base_ || global_receiver >= global_base_ + 4U)
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    return coordinator_.acquire_receiver(global_receiver);
}

Result<void> Q3U4CoordinatorReceiverPowerAuthority::release_receiver(
    std::uint8_t global_receiver, Q3U4Delay&) noexcept
{
    if (global_receiver < global_base_ || global_receiver >= global_base_ + 4U)
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    return coordinator_.release_receiver(global_receiver);
}

Q3U4FrontendBank::Q3U4FrontendBank(BridgeI2cMaster& bridge,
                                   Q3U4ReceiverPowerAuthority& power,
                                   std::uint8_t global_base,
                                   Q3U4FrontendDelay& delay,
                                   Q3U4PsbPurger* purger) noexcept
    : power_(power), global_base_(global_base), delay_(delay), purger_(purger),
      tc_{Tc90522(bridge, Q3U4ReceiverMapping{0U, 0x11U, false, Tc90522System::isdb_s}),
          Tc90522(bridge, Q3U4ReceiverMapping{1U, 0x13U, true, Tc90522System::isdb_s}),
          Tc90522(bridge, Q3U4ReceiverMapping{2U, 0x10U, false, Tc90522System::isdb_t}),
          Tc90522(bridge, Q3U4ReceiverMapping{3U, 0x12U, true, Tc90522System::isdb_t})},
      rt710_{Rt710(tc_[0], delay), Rt710(tc_[1], delay)},
      r850_{R850(tc_[2], delay, true), R850(tc_[3], delay, false)}
{
    receiver_state_.fill(Q3U4ReceiverState::closed);
}

Q3U4FrontendBank::~Q3U4FrontendBank() noexcept
{
    (void)cleanup();
}

const char* Q3U4FrontendBank::diagnostic_stage() const noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    const auto stage = operation_failed_ ? failure_stage_ : current_stage_;
    switch (stage) {
    case DiagnosticStage::backend_power_on: return "backend_power_on";
    case DiagnosticStage::tuner_initialize_rt710_0: return "tuner_initialize_rt710_0";
    case DiagnosticStage::tuner_initialize_rt710_1: return "tuner_initialize_rt710_1";
    case DiagnosticStage::tuner_initialize_r850_0: return "tuner_initialize_r850_0";
    case DiagnosticStage::tuner_initialize_r850_1: return "tuner_initialize_r850_1";
    case DiagnosticStage::frontend_sleep_rt710_0: return "frontend_sleep_rt710_0";
    case DiagnosticStage::frontend_sleep_rt710_1: return "frontend_sleep_rt710_1";
    case DiagnosticStage::frontend_sleep_r850_0: return "frontend_sleep_r850_0";
    case DiagnosticStage::frontend_sleep_r850_1: return "frontend_sleep_r850_1";
    case DiagnosticStage::selected_tc_init_writes: return "selected_tc_init_writes";
    case DiagnosticStage::satellite_selected_tc_init_writes: return "satellite_selected_tc_init_writes";
    case DiagnosticStage::ts_pin_disable: return "ts_pin_disable";
    case DiagnosticStage::satellite_ts_pin_disable: return "satellite_ts_pin_disable";
    case DiagnosticStage::ts_pin_enable: return "ts_pin_enable";
    case DiagnosticStage::satellite_ts_pin_enable: return "satellite_ts_pin_enable";
    case DiagnosticStage::psb_purge: return "psb_purge";
    case DiagnosticStage::cleanup_ts_pin_disable: return "cleanup_ts_pin_disable";
    case DiagnosticStage::cleanup_satellite_ts_pin_disable: return "cleanup_satellite_ts_pin_disable";
    case DiagnosticStage::demod_wake: return "demod_wake";
    case DiagnosticStage::satellite_demod_wake: return "satellite_demod_wake";
    case DiagnosticStage::selected_r850_wake: return "selected_r850_wake";
    case DiagnosticStage::r850_system_set: return "r850_system_set";
    case DiagnosticStage::shared_s0: return "shared_s0";
    case DiagnosticStage::shared_t0: return "shared_t0";
    case DiagnosticStage::tune_tc47: return "tune_tc47";
    case DiagnosticStage::agc_off: return "agc_off";
    case DiagnosticStage::tc76: return "tc76";
    case DiagnosticStage::r850_set_frequency: return "r850_set_frequency";
    case DiagnosticStage::pll_poll: return "pll_poll";
    case DiagnosticStage::satellite_agc_off: return "satellite_agc_off";
    case DiagnosticStage::satellite_mode_registers: return "satellite_mode_registers";
    case DiagnosticStage::satellite_set_params: return "satellite_set_params";
    case DiagnosticStage::satellite_pll_poll: return "satellite_pll_poll";
    case DiagnosticStage::satellite_agc_on: return "satellite_agc_on";
    case DiagnosticStage::satellite_demod_lock: return "satellite_demod_lock";
    case DiagnosticStage::satellite_slot_tmcc: return "satellite_slot_tmcc";
    case DiagnosticStage::satellite_slot_set: return "satellite_slot_set";
    case DiagnosticStage::satellite_slot_verify: return "satellite_slot_verify";
    case DiagnosticStage::agc_on: return "agc_on";
    case DiagnosticStage::tc71_72_75: return "tc71_72_75";
    case DiagnosticStage::cleanup_tuner_terminate: return "cleanup_tuner_terminate";
    case DiagnosticStage::cleanup_power_off: return "cleanup_power_off";
    case DiagnosticStage::open: return "open";
    case DiagnosticStage::tuned: return "tuned";
    case DiagnosticStage::closed: return "closed";
    case DiagnosticStage::none: return "none";
    }
    return "none";
}

void Q3U4FrontendBank::begin_operation() noexcept
{
    operation_failed_ = false;
    failure_stage_ = DiagnosticStage::none;
}

void Q3U4FrontendBank::remember_failure(const Result<void>& result) noexcept
{
    if (!result && !operation_failed_) {
        failure_stage_ = current_stage_;
        operation_failed_ = true;
    }
}

void Q3U4FrontendBank::remember_first(Error& first,
                                      const Result<void>& result) noexcept
{
    if (first == Error::OK && !result) first = result.error();
    if (!result && result.error() == Error::DISCONNECTED) first = Error::DISCONNECTED;
}

void Q3U4FrontendBank::record_cleanup_power_off_failure() noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    attempt(DiagnosticStage::cleanup_power_off);
    if (!operation_failed_) {
        failure_stage_ = current_stage_;
        operation_failed_ = true;
    }
}

bool Q3U4FrontendBank::valid_local_receiver(std::uint8_t local_receiver) const noexcept
{
    return local_receiver < 4U;
}

bool Q3U4FrontendBank::any_open_locked() const noexcept
{
    for (const auto state : receiver_state_) {
        if (state != Q3U4ReceiverState::closed) return true;
    }
    return false;
}

bool Q3U4FrontendBank::any_other_open_locked(std::uint8_t local_receiver) const noexcept
{
    for (std::uint8_t index = 0U; index < 4U; ++index) {
        if (index != local_receiver && receiver_state_[index] != Q3U4ReceiverState::closed)
            return true;
    }
    return false;
}

Result<void> Q3U4FrontendBank::acquire_power(std::uint8_t local_receiver) noexcept
{
    return power_.acquire_receiver(
        static_cast<std::uint8_t>(global_base_ + local_receiver), delay_);
}

Result<void> Q3U4FrontendBank::release_power(std::uint8_t local_receiver) noexcept
{
    return power_.release_receiver(
        static_cast<std::uint8_t>(global_base_ + local_receiver), delay_);
}

Result<void> Q3U4FrontendBank::sleep_frontend(std::uint8_t index) noexcept
{
    attempt(static_cast<DiagnosticStage>(static_cast<std::uint8_t>(
        DiagnosticStage::frontend_sleep_rt710_0) + index));
    if (index < 2U) {
        const auto tuner = rt710_[index].sleep();
        if (!tuner) { remember_failure(tuner); return tuner; }
        const auto result = tc_[index].sleep_s(true);
        remember_failure(result);
        return result;
    }
    const auto tuner = r850_[index - 2U].sleep();
    if (!tuner) { remember_failure(tuner); return tuner; }
    const auto result = tc_[index].sleep_t(true);
    remember_failure(result);
    return result;
}

Result<void> Q3U4FrontendBank::terminate_initialized() noexcept
{
    Error first = Error::OK;
    for (int index = 3; index >= 0; --index) {
        const auto i = static_cast<std::size_t>(index);
        if (!tuner_initialized_[i]) continue;
        attempt(DiagnosticStage::cleanup_tuner_terminate);
        const auto result = index < 2 ? rt710_[i].terminate()
                                      : r850_[i - 2U].terminate();
        remember_first(first, result);
        remember_failure(result);
        tuner_initialized_[i] = false;
    }
    return first == Error::OK ? Result<void>::success() : Result<void>::failure(first);
}

Result<void> Q3U4FrontendBank::wake_frontend(std::uint8_t local_receiver,
                                             Tc90522System system) noexcept
{
    auto& demod = tc_[local_receiver];
    Result<void> result = Result<void>::success();
    if (system == Tc90522System::isdb_t) {
        attempt(DiagnosticStage::selected_tc_init_writes);
        result = write_fixed(demod, kTcInitTValues);
        if (!result) remember_failure(result);
        if (result) {
            attempt(DiagnosticStage::ts_pin_disable);
            result = demod.enable_ts_pins_t(false);
            if (!result) remember_failure(result);
        }
        if (result) {
            attempt(DiagnosticStage::demod_wake);
            result = demod.sleep_t(false);
            if (!result) remember_failure(result);
        }
        if (result) {
            attempt(DiagnosticStage::selected_r850_wake);
            result = r850_[local_receiver - 2U].wakeup();
            if (!result) remember_failure(result);
        }
        if (result) {
            attempt(DiagnosticStage::r850_system_set);
            result = r850_[local_receiver - 2U].set_system(
                R850SystemConfig{R850System::isdb_t, R850Bandwidth::mhz_6, 4063U});
            if (!result) remember_failure(result);
        }
    } else {
        attempt(DiagnosticStage::satellite_selected_tc_init_writes);
        result = write_fixed(demod, kTcInitSValues);
        if (!result) remember_failure(result);
        if (result) {
            attempt(DiagnosticStage::satellite_ts_pin_disable);
            result = demod.enable_ts_pins_s(false);
            if (!result) remember_failure(result);
        }
        if (result) {
            attempt(DiagnosticStage::satellite_demod_wake);
            result = demod.sleep_s(false);
            if (!result) remember_failure(result);
        }
    }
    return result;
}

Result<void> Q3U4FrontendBank::write_shared_initialization() noexcept
{
    attempt(DiagnosticStage::shared_s0);
    auto result = write_fixed(tc_[0], kSharedS0);
    if (!result) remember_failure(result);
    if (result) {
        attempt(DiagnosticStage::shared_t0);
        result = write_fixed(tc_[2], kSharedT0);
        if (!result) remember_failure(result);
    }
    return result;
}

Result<void> Q3U4FrontendBank::disable_capture(std::uint8_t local_receiver,
                                               Tc90522System system) noexcept
{
    attempt(system == Tc90522System::isdb_s
                ? DiagnosticStage::cleanup_satellite_ts_pin_disable
                : DiagnosticStage::cleanup_ts_pin_disable);
    const auto result = system == Tc90522System::isdb_s
        ? tc_[local_receiver].enable_ts_pins_s(false)
        : tc_[local_receiver].enable_ts_pins_t(false);
    if (!result) remember_failure(result);
    if (result) receiver_state_[local_receiver] = Q3U4ReceiverState::tuned;
    return result;
}

Result<void> Q3U4FrontendBank::cleanup_open_failure(
    std::uint8_t local_receiver, bool first_open, Error primary) noexcept
{
    Error final_error = primary;
    if (first_open) {
        final_error = combine_errors(final_error, terminate_initialized());
    } else {
        final_error = combine_errors(final_error,
                                     sleep_frontend(local_receiver));
    }
    const auto release = release_power(local_receiver);
    // Preserve the original open failure for the developer-probe contract;
    // the power authority still records and reports its terminal state. A
    // release error is returned when there is no earlier failure to report.
    if (final_error == Error::OK && !release) final_error = release.error();
    receiver_state_[local_receiver] = Q3U4ReceiverState::closed;
    satellite_selected_[local_receiver] = false;
    selected_tsid_[local_receiver] = 0U;
    return Result<void>::failure(final_error);
}

Result<void> Q3U4FrontendBank::open_receiver(std::uint8_t local_receiver,
                                              Tc90522System system) noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    begin_operation();
    if (!valid_local_receiver(local_receiver))
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    const auto expected_system = local_receiver < 2U ? Tc90522System::isdb_s
                                                     : Tc90522System::isdb_t;
    if (system != expected_system)
        return Result<void>::failure(Error::UNSUPPORTED);
    if (receiver_state_[local_receiver] != Q3U4ReceiverState::closed)
        return Result<void>::failure(Error::BUSY);

    const bool first_open = !any_open_locked();
    const auto power = acquire_power(local_receiver);
    if (!power) {
        remember_failure(power);
        return power;
    }

    if (first_open) {
        Error failure = Error::OK;
        for (std::uint8_t index = 0U; index < 4U; ++index) {
            attempt(static_cast<DiagnosticStage>(static_cast<std::uint8_t>(
                DiagnosticStage::tuner_initialize_rt710_0) + index));
            const auto result = index < 2U ? rt710_[index].initialize()
                                           : r850_[index - 2U].initialize();
            if (!result) {
                remember_failure(result);
                failure = result.error();
                break;
            }
            tuner_initialized_[index] = true;
        }
        if (failure != Error::OK)
            return cleanup_open_failure(local_receiver, true, failure);

        // This is the accepted first-open order: initialize all devices, then
        // sleep only the three local receivers not being opened.
        for (std::uint8_t index = 0U; index < 4U; ++index) {
            if (index == local_receiver) continue;
            const auto result = sleep_frontend(index);
            if (!result)
                return cleanup_open_failure(local_receiver, true, result.error());
        }
    }

    const auto wake = wake_frontend(local_receiver, system);
    if (!wake)
        return cleanup_open_failure(local_receiver, first_open, wake.error());
    if (first_open) {
        const auto shared = write_shared_initialization();
        if (!shared)
            return cleanup_open_failure(local_receiver, true, shared.error());
    }

    receiver_state_[local_receiver] = Q3U4ReceiverState::open;
    satellite_selected_[local_receiver] = false;
    selected_tsid_[local_receiver] = 0U;
    current_stage_ = DiagnosticStage::open;
    return Result<void>::success();
}

Result<void> Q3U4FrontendBank::open_terrestrial(
    std::uint8_t local_receiver) noexcept
{
    return open_receiver(local_receiver, Tc90522System::isdb_t);
}

Result<void> Q3U4FrontendBank::open_satellite(
    std::uint8_t local_receiver) noexcept
{
    return open_receiver(local_receiver, Tc90522System::isdb_s);
}

Result<void> Q3U4FrontendBank::tune_receiver(std::uint8_t local_receiver,
                                              std::uint32_t frequency_khz,
                                              Tc90522System system,
                                              std::uint32_t timeout_ms) noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    begin_operation();
    if (!valid_local_receiver(local_receiver))
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    if (local_receiver < 2U ? system != Tc90522System::isdb_s
                            : system != Tc90522System::isdb_t)
        return Result<void>::failure(Error::UNSUPPORTED);
    const auto state = receiver_state_[local_receiver];
    if (state == Q3U4ReceiverState::closed)
        return Result<void>::failure(Error::NOT_READY);
    if (state == Q3U4ReceiverState::capturing)
        return Result<void>::failure(Error::BUSY);

    if (system == Tc90522System::isdb_t) {
        auto& demod = tc_[local_receiver];
        auto& tuner = r850_[local_receiver - 2U];

        attempt(DiagnosticStage::tune_tc47);
        auto result = demod.write_reg(0x47U, 0x30U);
        if (!result) remember_failure(result);
        if (result) {
            attempt(DiagnosticStage::agc_off);
            result = demod.set_agc_t(false);
            if (!result) remember_failure(result);
        }
        if (result) {
            attempt(DiagnosticStage::tc76);
            result = demod.write_reg(0x76U, 0x0cU);
            if (!result) remember_failure(result);
        }
        if (result) {
            attempt(DiagnosticStage::r850_set_frequency);
            result = tuner.set_frequency(frequency_khz);
            if (!result) remember_failure(result);
        }
        if (!result) return result;

        attempt(DiagnosticStage::pll_poll);
        bool locked = false;
        Error final_error = Error::OK;
        std::uint32_t elapsed_ms = 0U;
        const std::size_t max_polls =
            static_cast<std::size_t>((timeout_ms + 9U) / 10U);
        for (std::size_t count = 0U; count < max_polls; ++count) {
            const auto status = tuner.is_pll_locked();
            if (!status) final_error = status.error();
            else if (status.value()) { locked = true; break; }
            else final_error = Error::OK;
            if (elapsed_ms > timeout_ms || timeout_ms - elapsed_ms < 10U) break;
            delay_.sleep_ms(10U);
            elapsed_ms += 10U;
        }
        if (!locked) {
            const auto failed = Result<void>::failure(
                final_error == Error::OK ? Error::TIMEOUT : final_error);
            remember_failure(failed);
            return failed;
        }
        attempt(DiagnosticStage::agc_on);
        result = demod.set_agc_t(true);
        if (!result) remember_failure(result);
        if (result) {
            attempt(DiagnosticStage::tc71_72_75);
            result = demod.write_reg(0x71U, 0x21U);
            if (!result) remember_failure(result);
        }
        if (result) result = demod.write_reg(0x72U, 0x25U);
        if (!result) remember_failure(result);
        if (result) result = demod.write_reg(0x75U, 0x08U);
        if (!result) remember_failure(result);
        if (result) {
            receiver_state_[local_receiver] = Q3U4ReceiverState::tuned;
            current_stage_ = DiagnosticStage::tuned;
        }
        return result;
    }

    auto& demod = tc_[local_receiver];
    auto& tuner = rt710_[local_receiver];
    attempt(DiagnosticStage::satellite_agc_off);
    auto result = demod.set_agc_s(false);
    if (!result) remember_failure(result);
    if (result) {
        attempt(DiagnosticStage::satellite_mode_registers);
        result = demod.write_reg(0x8eU, 0x06U);
        if (!result) remember_failure(result);
    }
    if (result) result = demod.write_reg(0xa3U, 0xf7U);
    if (!result) remember_failure(result);
    if (result) {
        attempt(DiagnosticStage::satellite_set_params);
        result = tuner.set_params(frequency_khz, 28860U, 4U);
        if (!result) remember_failure(result);
    }
    if (!result) return result;

    attempt(DiagnosticStage::satellite_pll_poll);
    bool locked = false;
    Error last_error = Error::OK;
    std::uint32_t elapsed_ms = 0U;
    const std::size_t max_polls =
        static_cast<std::size_t>((timeout_ms + 9U) / 10U);
    for (std::size_t count = 0U; count < max_polls; ++count) {
        const auto status = tuner.is_pll_locked();
        if (status && status.value()) { locked = true; break; }
        last_error = status ? Error::OK : status.error();
        if (elapsed_ms > timeout_ms || timeout_ms - elapsed_ms < 10U) break;
        delay_.sleep_ms(10U);
        elapsed_ms += 10U;
    }
    if (!locked) {
        const auto failed = Result<void>::failure(
            last_error == Error::OK ? Error::TIMEOUT : last_error);
        remember_failure(failed);
        return failed;
    }
    attempt(DiagnosticStage::satellite_agc_on);
    result = demod.set_agc_s(true);
    if (!result) remember_failure(result);
    if (result) {
        receiver_state_[local_receiver] = Q3U4ReceiverState::tuned;
        current_stage_ = DiagnosticStage::tuned;
    }
    return result;
}

Result<void> Q3U4FrontendBank::tune_terrestrial(
    std::uint8_t local_receiver, std::uint32_t frequency_khz) noexcept
{
    return tune_terrestrial_with_timeout(local_receiver, frequency_khz, 500U);
}

Result<void> Q3U4FrontendBank::tune_terrestrial_with_timeout(
    std::uint8_t local_receiver, std::uint32_t frequency_khz,
    std::uint32_t timeout_ms) noexcept
{
    return tune_receiver(local_receiver, frequency_khz, Tc90522System::isdb_t,
                         timeout_ms);
}

Result<void> Q3U4FrontendBank::tune_satellite(
    std::uint8_t local_receiver, std::uint32_t frequency_khz) noexcept
{
    return tune_satellite_with_timeout(local_receiver, frequency_khz, 500U);
}

Result<void> Q3U4FrontendBank::tune_satellite_with_timeout(
    std::uint8_t local_receiver, std::uint32_t frequency_khz,
    std::uint32_t timeout_ms) noexcept
{
    return tune_receiver(local_receiver, frequency_khz, Tc90522System::isdb_s,
                         timeout_ms);
}

Result<void> Q3U4FrontendBank::select_satellite_tsid_locked(
    std::uint8_t local_receiver, std::uint16_t tsid,
    std::uint32_t timeout_ms) noexcept
{
    auto& demod = tc_[local_receiver];
    attempt(DiagnosticStage::satellite_slot_set);
    auto result = demod.set_tsid_s(tsid);
    if (!result) { remember_failure(result); return result; }
    attempt(DiagnosticStage::satellite_slot_verify);
    bool verified = false;
    Error last_error = Error::OK;
    const std::size_t max_polls =
        static_cast<std::size_t>(timeout_ms / 10U) + 1U;
    for (std::size_t count = 0U; count < max_polls; ++count) {
        const auto value = demod.get_tsid_s();
        if (value && value.value() == tsid) { verified = true; break; }
        last_error = value ? Error::OK : value.error();
        if ((count + 1U) * 10U <= timeout_ms) delay_.sleep_ms(10U);
    }
    if (!verified) {
        const auto failed = Result<void>::failure(
            last_error == Error::OK ? Error::TIMEOUT : last_error);
        remember_failure(failed);
        return failed;
    }
    selected_tsid_[local_receiver] = tsid;
    satellite_selected_[local_receiver] = true;
    current_stage_ = DiagnosticStage::satellite_demod_lock;
    return Result<void>::success();
}

Result<void> Q3U4FrontendBank::select_satellite_slot(
    std::uint8_t local_receiver, std::uint8_t slot) noexcept
{
    return select_satellite_slot_with_timeout(local_receiver, slot, 1000U);
}

Result<void> Q3U4FrontendBank::select_satellite_slot_with_timeout(
    std::uint8_t local_receiver, std::uint8_t slot,
    std::uint32_t timeout_ms) noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    begin_operation();
    if (!valid_local_receiver(local_receiver) || local_receiver >= 2U)
        return Result<void>::failure(Error::UNSUPPORTED);
    if (slot >= 12U) return Result<void>::failure(Error::INVALID_ARGUMENT);
    if (receiver_state_[local_receiver] != Q3U4ReceiverState::tuned)
        return Result<void>::failure(Error::NOT_READY);

    auto& demod = tc_[local_receiver];
    attempt(DiagnosticStage::satellite_slot_tmcc);
    std::uint16_t tsid = 0U;
    Error last_error = Error::OK;
    bool found = false;
    std::uint32_t elapsed_ms = 0U;
    const std::size_t max_polls =
        static_cast<std::size_t>(timeout_ms / 10U) + 1U;
    for (std::size_t count = 0U; count < max_polls; ++count) {
        const auto value = demod.tmcc_get_tsid_s(slot);
        if (value && value.value() != 0U) { tsid = value.value(); found = true; break; }
        last_error = value ? Error::OK : value.error();
        if ((count + 1U) * 10U <= timeout_ms) {
            delay_.sleep_ms(10U);
            elapsed_ms += 10U;
        }
    }
    if (!found) {
        const auto failed = Result<void>::failure(
            last_error == Error::OK ? Error::TIMEOUT : last_error);
        remember_failure(failed);
        return failed;
    }
    if (elapsed_ms >= timeout_ms) {
        const auto failed = Result<void>::failure(Error::TIMEOUT);
        remember_failure(failed);
        return failed;
    }
    return select_satellite_tsid_locked(local_receiver, tsid,
                                         timeout_ms - elapsed_ms);
}

Result<void> Q3U4FrontendBank::select_satellite_tsid(
    std::uint8_t local_receiver, std::uint16_t tsid) noexcept
{
    return select_satellite_tsid_with_timeout(local_receiver, tsid, 1000U);
}

Result<void> Q3U4FrontendBank::select_satellite_tsid_with_timeout(
    std::uint8_t local_receiver, std::uint16_t tsid,
    std::uint32_t timeout_ms) noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    begin_operation();
    if (!valid_local_receiver(local_receiver) || local_receiver >= 2U)
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    if (receiver_state_[local_receiver] != Q3U4ReceiverState::tuned)
        return Result<void>::failure(Error::NOT_READY);
    return select_satellite_tsid_locked(local_receiver, tsid, timeout_ms);
}

Result<void> Q3U4FrontendBank::start_capture(std::uint8_t local_receiver,
                                              Tc90522System system) noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    begin_operation();
    if (!valid_local_receiver(local_receiver))
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    if (local_receiver < 2U ? system != Tc90522System::isdb_s
                            : system != Tc90522System::isdb_t)
        return Result<void>::failure(Error::UNSUPPORTED);
    if (receiver_state_[local_receiver] != Q3U4ReceiverState::tuned)
        return Result<void>::failure(Error::NOT_READY);
    if (system == Tc90522System::isdb_s && !satellite_selected_[local_receiver])
        return Result<void>::failure(Error::NOT_READY);

    if (!any_capturing_locked() && purger_ != nullptr) {
        attempt(DiagnosticStage::psb_purge);
        const auto purged = purger_->purge();
        if (!purged) {
            remember_failure(purged);
            return purged;
        }
    }

    attempt(system == Tc90522System::isdb_s
                ? DiagnosticStage::satellite_ts_pin_enable
                : DiagnosticStage::ts_pin_enable);
    if (system == Tc90522System::isdb_s) {
        // The satellite path preserves the accepted partial-write cleanup
        // contract by treating a failed pin write as capture-pending.
        receiver_state_[local_receiver] = Q3U4ReceiverState::capturing;
        const auto result = tc_[local_receiver].enable_ts_pins_s(true);
        if (!result) remember_failure(result);
        return result;
    }
    const auto result = tc_[local_receiver].enable_ts_pins_t(true);
    if (!result) remember_failure(result);
    if (result) receiver_state_[local_receiver] = Q3U4ReceiverState::capturing;
    return result;
}

bool Q3U4FrontendBank::any_capturing_locked() const noexcept
{
    for (const Q3U4ReceiverState state : receiver_state_) {
        if (state == Q3U4ReceiverState::capturing) return true;
    }
    return false;
}

Result<void> Q3U4FrontendBank::start_terrestrial_capture(
    std::uint8_t local_receiver) noexcept
{
    return start_capture(local_receiver, Tc90522System::isdb_t);
}

Result<void> Q3U4FrontendBank::start_satellite_capture(
    std::uint8_t local_receiver) noexcept
{
    return start_capture(local_receiver, Tc90522System::isdb_s);
}

Result<void> Q3U4FrontendBank::stop_capture(std::uint8_t local_receiver,
                                             Tc90522System system) noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    begin_operation();
    if (!valid_local_receiver(local_receiver))
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    if (local_receiver < 2U ? system != Tc90522System::isdb_s
                            : system != Tc90522System::isdb_t)
        return Result<void>::failure(Error::UNSUPPORTED);
    if (receiver_state_[local_receiver] != Q3U4ReceiverState::capturing)
        return Result<void>::failure(Error::NOT_READY);
    return disable_capture(local_receiver, system);
}

Result<void> Q3U4FrontendBank::stop_terrestrial_capture(
    std::uint8_t local_receiver) noexcept
{
    return stop_capture(local_receiver, Tc90522System::isdb_t);
}

Result<void> Q3U4FrontendBank::stop_satellite_capture(
    std::uint8_t local_receiver) noexcept
{
    return stop_capture(local_receiver, Tc90522System::isdb_s);
}

Result<bool> Q3U4FrontendBank::is_locked(std::uint8_t local_receiver,
                                          Tc90522System system) noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    if (!valid_local_receiver(local_receiver))
        return Result<bool>::failure(Error::INVALID_ARGUMENT);
    if (local_receiver < 2U ? system != Tc90522System::isdb_s
                            : system != Tc90522System::isdb_t)
        return Result<bool>::failure(Error::UNSUPPORTED);
    if (receiver_state_[local_receiver] == Q3U4ReceiverState::closed)
        return Result<bool>::failure(Error::NOT_READY);
    if (system == Tc90522System::isdb_s) {
        attempt(DiagnosticStage::satellite_demod_lock);
        return tc_[local_receiver].is_signal_locked_s();
    }
    return tc_[local_receiver].is_signal_locked_t();
}

Result<bool> Q3U4FrontendBank::is_terrestrial_locked(
    std::uint8_t local_receiver) noexcept
{
    return is_locked(local_receiver, Tc90522System::isdb_t);
}

Result<bool> Q3U4FrontendBank::is_satellite_locked(
    std::uint8_t local_receiver) noexcept
{
    return is_locked(local_receiver, Tc90522System::isdb_s);
}

Result<void> Q3U4FrontendBank::close_receiver(
    std::uint8_t local_receiver) noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    begin_operation();
    if (!valid_local_receiver(local_receiver))
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    if (receiver_state_[local_receiver] == Q3U4ReceiverState::closed)
        return Result<void>::failure(Error::INVALID_ARGUMENT);

    const auto system = local_receiver < 2U ? Tc90522System::isdb_s
                                            : Tc90522System::isdb_t;
    Error first = Error::OK;
    if (receiver_state_[local_receiver] == Q3U4ReceiverState::capturing) {
        remember_first(first, disable_capture(local_receiver, system));
    }

    const bool last_close = !any_other_open_locked(local_receiver);
    if (last_close) {
        remember_first(first, terminate_initialized());
    } else {
        remember_first(first, sleep_frontend(local_receiver));
    }

    // Logical ownership is removed even if physical cleanup failed. The
    // coordinator performs the coupled transition and retains retryable state.
    receiver_state_[local_receiver] = Q3U4ReceiverState::closed;
    satellite_selected_[local_receiver] = false;
    selected_tsid_[local_receiver] = 0U;
    attempt(DiagnosticStage::cleanup_power_off);
    const auto release = release_power(local_receiver);
    remember_first(first, release);
    remember_failure(release);
    if (first == Error::OK) current_stage_ = DiagnosticStage::closed;
    return first == Error::OK ? Result<void>::success()
                              : Result<void>::failure(first);
}

Result<void> Q3U4FrontendBank::cleanup() noexcept
{
    Error first = Error::OK;
    for (std::uint8_t local = 0U; local < 4U; ++local) {
        if (receiver_state(local) == Q3U4ReceiverState::closed) continue;
        const auto result = close_receiver(local);
        remember_first(first, result);
    }
    return first == Error::OK ? Result<void>::success()
                              : Result<void>::failure(first);
}

Q3U4ReceiverState Q3U4FrontendBank::receiver_state(
    std::uint8_t local_receiver) const noexcept
{
    if (!valid_local_receiver(local_receiver)) return Q3U4ReceiverState::closed;
    std::lock_guard<std::mutex> lock(mutex_);
    return receiver_state_[local_receiver];
}

bool Q3U4FrontendBank::capture_active(std::uint8_t local_receiver) const noexcept
{
    return receiver_state(local_receiver) == Q3U4ReceiverState::capturing;
}

std::uint16_t Q3U4FrontendBank::selected_tsid(
    std::uint8_t local_receiver) const noexcept
{
    if (!valid_local_receiver(local_receiver)) return 0U;
    std::lock_guard<std::mutex> lock(mutex_);
    return selected_tsid_[local_receiver];
}

Result<bool> Q3U4FrontendBank::terrestrial_loop_through(
    std::uint8_t local_receiver) const noexcept
{
    if (!valid_local_receiver(local_receiver) || local_receiver < 2U)
        return Result<bool>::failure(Error::INVALID_ARGUMENT);
    std::lock_guard<std::mutex> lock(mutex_);
    return Result<bool>::success(r850_[local_receiver - 2U].loop_through());
}

Q3U4FrontendEnclosure::Q3U4FrontendEnclosure(
    BridgeI2cMaster& dev1_bridge, BridgeI2cMaster& dev2_bridge,
    Q3U4BackendPower& dev1_power, Q3U4BackendPower& dev2_power,
    Q3U4FrontendDelay& delay, Q3U4PsbPurger* dev1_purger,
    Q3U4PsbPurger* dev2_purger) noexcept
    : coordinator_(dev1_power, dev2_power, delay),
      dev1_power_(coordinator_, 0U), dev2_power_(coordinator_, 4U),
      dev1_bank_(dev1_bridge, dev1_power_, 0U, delay, dev1_purger),
      dev2_bank_(dev2_bridge, dev2_power_, 4U, delay, dev2_purger)
{
}

Q3U4FrontendEnclosure::~Q3U4FrontendEnclosure() noexcept = default;

Result<Q3U4FrontendEnclosure::ReceiverMapping>
Q3U4FrontendEnclosure::map_receiver(std::uint8_t global_receiver) noexcept
{
    if (global_receiver >= 8U)
        return Result<ReceiverMapping>::failure(Error::INVALID_ARGUMENT);
    const auto local = static_cast<std::uint8_t>(global_receiver % 4U);
    return Result<ReceiverMapping>::success(ReceiverMapping{
        global_receiver,
        global_receiver < 4U ? Q3U4Bridge::dev1 : Q3U4Bridge::dev2,
        local,
        local < 2U ? Tc90522System::isdb_s : Tc90522System::isdb_t});
}

Result<Q3U4FrontendBank*> Q3U4FrontendEnclosure::select_bank(
    std::uint8_t global_receiver) noexcept
{
    const auto mapping = map_receiver(global_receiver);
    if (!mapping) return Result<Q3U4FrontendBank*>::failure(mapping.error());
    return Result<Q3U4FrontendBank*>::success(
        mapping.value().bridge == Q3U4Bridge::dev1 ? &dev1_bank_ : &dev2_bank_);
}

Result<const Q3U4FrontendBank*> Q3U4FrontendEnclosure::select_bank(
    std::uint8_t global_receiver) const noexcept
{
    const auto mapping = map_receiver(global_receiver);
    if (!mapping) return Result<const Q3U4FrontendBank*>::failure(mapping.error());
    return Result<const Q3U4FrontendBank*>::success(
        mapping.value().bridge == Q3U4Bridge::dev1 ? &dev1_bank_ : &dev2_bank_);
}

#define Q3U4_ENC_ROUTE_VOID(name, args, call_args)                              \
    Result<void> Q3U4FrontendEnclosure::name args noexcept                       \
    {                                                                             \
        const auto mapping = map_receiver(global_receiver);                      \
        if (!mapping) return Result<void>::failure(mapping.error());              \
        const auto selected = select_bank(global_receiver);                      \
        if (!selected) return Result<void>::failure(selected.error());            \
        return selected.value()->call_args;                                      \
    }

Q3U4_ENC_ROUTE_VOID(open_terrestrial, (std::uint8_t global_receiver),
                    open_terrestrial(mapping.value().local_receiver))
Q3U4_ENC_ROUTE_VOID(open_satellite, (std::uint8_t global_receiver),
                    open_satellite(mapping.value().local_receiver))
Q3U4_ENC_ROUTE_VOID(tune_terrestrial,
                    (std::uint8_t global_receiver, std::uint32_t frequency_khz),
                    tune_terrestrial(mapping.value().local_receiver, frequency_khz))
Q3U4_ENC_ROUTE_VOID(tune_terrestrial_with_timeout,
                    (std::uint8_t global_receiver, std::uint32_t frequency_khz,
                     std::uint32_t timeout_ms),
                    tune_terrestrial_with_timeout(mapping.value().local_receiver,
                                                  frequency_khz, timeout_ms))
Q3U4_ENC_ROUTE_VOID(tune_satellite,
                    (std::uint8_t global_receiver, std::uint32_t frequency_khz),
                    tune_satellite(mapping.value().local_receiver, frequency_khz))
Q3U4_ENC_ROUTE_VOID(tune_satellite_with_timeout,
                    (std::uint8_t global_receiver, std::uint32_t frequency_khz,
                     std::uint32_t timeout_ms),
                    tune_satellite_with_timeout(mapping.value().local_receiver,
                                                frequency_khz, timeout_ms))
Q3U4_ENC_ROUTE_VOID(select_satellite_slot,
                    (std::uint8_t global_receiver, std::uint8_t slot),
                    select_satellite_slot(mapping.value().local_receiver, slot))
Q3U4_ENC_ROUTE_VOID(select_satellite_slot_with_timeout,
                    (std::uint8_t global_receiver, std::uint8_t slot,
                     std::uint32_t timeout_ms),
                    select_satellite_slot_with_timeout(
                        mapping.value().local_receiver, slot, timeout_ms))
Q3U4_ENC_ROUTE_VOID(select_satellite_tsid,
                    (std::uint8_t global_receiver, std::uint16_t tsid),
                    select_satellite_tsid(mapping.value().local_receiver, tsid))
Q3U4_ENC_ROUTE_VOID(select_satellite_tsid_with_timeout,
                    (std::uint8_t global_receiver, std::uint16_t tsid,
                     std::uint32_t timeout_ms),
                    select_satellite_tsid_with_timeout(
                        mapping.value().local_receiver, tsid, timeout_ms))
Q3U4_ENC_ROUTE_VOID(start_terrestrial_capture, (std::uint8_t global_receiver),
                    start_terrestrial_capture(mapping.value().local_receiver))
Q3U4_ENC_ROUTE_VOID(start_satellite_capture, (std::uint8_t global_receiver),
                    start_satellite_capture(mapping.value().local_receiver))
Q3U4_ENC_ROUTE_VOID(stop_terrestrial_capture, (std::uint8_t global_receiver),
                    stop_terrestrial_capture(mapping.value().local_receiver))
Q3U4_ENC_ROUTE_VOID(stop_satellite_capture, (std::uint8_t global_receiver),
                    stop_satellite_capture(mapping.value().local_receiver))
Q3U4_ENC_ROUTE_VOID(close_receiver, (std::uint8_t global_receiver),
                    close_receiver(mapping.value().local_receiver))

#undef Q3U4_ENC_ROUTE_VOID

Result<bool> Q3U4FrontendEnclosure::is_terrestrial_locked(
    std::uint8_t global_receiver) noexcept
{
    const auto mapping = map_receiver(global_receiver);
    if (!mapping) return Result<bool>::failure(mapping.error());
    const auto selected = select_bank(global_receiver);
    if (!selected) return Result<bool>::failure(selected.error());
    return selected.value()->is_terrestrial_locked(mapping.value().local_receiver);
}

Result<bool> Q3U4FrontendEnclosure::is_satellite_locked(
    std::uint8_t global_receiver) noexcept
{
    const auto mapping = map_receiver(global_receiver);
    if (!mapping) return Result<bool>::failure(mapping.error());
    const auto selected = select_bank(global_receiver);
    if (!selected) return Result<bool>::failure(selected.error());
    return selected.value()->is_satellite_locked(mapping.value().local_receiver);
}

Q3U4ReceiverState Q3U4FrontendEnclosure::receiver_state(
    std::uint8_t global_receiver) const noexcept
{
    const auto mapping = map_receiver(global_receiver);
    if (!mapping) return Q3U4ReceiverState::closed;
    const auto selected = select_bank(global_receiver);
    if (!selected) return Q3U4ReceiverState::closed;
    return selected.value()->receiver_state(mapping.value().local_receiver);
}

Result<void> Q3U4FrontendEnclosure::acquire_card() noexcept
{
    return coordinator_.acquire_card();
}

Result<void> Q3U4FrontendEnclosure::release_card() noexcept
{
    return coordinator_.release_card();
}

Result<void> Q3U4FrontendEnclosure::reconcile_power() noexcept
{
    return coordinator_.reconcile();
}

Q3U4PowerSnapshot Q3U4FrontendEnclosure::power_snapshot() const noexcept
{
    return coordinator_.snapshot();
}

Q3U4FrontendBank& Q3U4FrontendEnclosure::bank(Q3U4Bridge bridge) noexcept
{
    return bridge == Q3U4Bridge::dev1 ? dev1_bank_ : dev2_bank_;
}

Q3U4Frontend::Q3U4Frontend(BridgeI2cMaster& bridge,
                           Q3U4BackendPower& power,
                           Q3U4FrontendDelay& delay) noexcept
    : power_authority_(power), bank_(bridge, power_authority_, 0U, delay), delay_(delay)
{
}

Q3U4Frontend::~Q3U4Frontend() noexcept = default;

Result<void> Q3U4Frontend::open_terrestrial(
    std::uint8_t local_receiver) noexcept
{
    if (power_authority_.release_pending())
        return Result<void>::failure(Error::BUSY);
    if (open_receiver_ >= 0) return Result<void>::failure(Error::BUSY);
    const auto result = bank_.open_terrestrial(local_receiver);
    if (result) open_receiver_ = static_cast<std::int8_t>(local_receiver);
    return result;
}

Result<void> Q3U4Frontend::open_satellite(
    std::uint8_t local_receiver) noexcept
{
    if (power_authority_.release_pending())
        return Result<void>::failure(Error::BUSY);
    if (open_receiver_ >= 0) return Result<void>::failure(Error::BUSY);
    const auto result = bank_.open_satellite(local_receiver);
    if (result) open_receiver_ = static_cast<std::int8_t>(local_receiver);
    return result;
}

Result<void> Q3U4Frontend::tune_terrestrial(
    std::uint32_t frequency_khz) noexcept
{
    if (open_receiver_ < 0) return Result<void>::failure(Error::NOT_READY);
    return bank_.tune_terrestrial(static_cast<std::uint8_t>(open_receiver_),
                                  frequency_khz);
}

Result<void> Q3U4Frontend::tune_satellite(
    std::uint32_t frequency_khz) noexcept
{
    if (open_receiver_ < 0) return Result<void>::failure(Error::NOT_READY);
    return bank_.tune_satellite(static_cast<std::uint8_t>(open_receiver_),
                                frequency_khz);
}

Result<void> Q3U4Frontend::select_satellite_slot(std::uint8_t slot) noexcept
{
    if (open_receiver_ < 0) return Result<void>::failure(Error::NOT_READY);
    return bank_.select_satellite_slot(static_cast<std::uint8_t>(open_receiver_), slot);
}

Result<void> Q3U4Frontend::start_terrestrial_capture() noexcept
{
    if (open_receiver_ < 0) return Result<void>::failure(Error::NOT_READY);
    if (capture_active()) return Result<void>::failure(Error::BUSY);
    return bank_.start_terrestrial_capture(static_cast<std::uint8_t>(open_receiver_));
}

Result<void> Q3U4Frontend::start_satellite_capture() noexcept
{
    if (open_receiver_ < 0) return Result<void>::failure(Error::NOT_READY);
    if (capture_active()) return Result<void>::failure(Error::BUSY);
    return bank_.start_satellite_capture(static_cast<std::uint8_t>(open_receiver_));
}

bool Q3U4Frontend::capture_active() const noexcept
{
    return open_receiver_ >= 0 &&
           bank_.capture_active(static_cast<std::uint8_t>(open_receiver_));
}

Result<void> Q3U4Frontend::stop_terrestrial_capture() noexcept
{
    if (open_receiver_ < 0 || !capture_active()) return Result<void>::success();
    return bank_.stop_terrestrial_capture(static_cast<std::uint8_t>(open_receiver_));
}

Result<void> Q3U4Frontend::stop_satellite_capture() noexcept
{
    if (open_receiver_ < 0 || !capture_active()) return Result<void>::success();
    return bank_.stop_satellite_capture(static_cast<std::uint8_t>(open_receiver_));
}

Result<bool> Q3U4Frontend::is_terrestrial_locked() noexcept
{
    if (open_receiver_ < 0) return Result<bool>::failure(Error::NOT_READY);
    return bank_.is_terrestrial_locked(static_cast<std::uint8_t>(open_receiver_));
}

Result<bool> Q3U4Frontend::is_satellite_locked() noexcept
{
    if (open_receiver_ < 0) return Result<bool>::failure(Error::NOT_READY);
    return bank_.is_satellite_locked(static_cast<std::uint8_t>(open_receiver_));
}

std::uint16_t Q3U4Frontend::selected_tsid() const noexcept
{
    return open_receiver_ < 0 ? 0U
                              : bank_.selected_tsid(static_cast<std::uint8_t>(open_receiver_));
}

Result<void> Q3U4Frontend::close() noexcept
{
    if (open_receiver_ < 0) {
        return power_authority_.release_pending()
            ? power_authority_.retry_release(delay_)
            : Result<void>::success();
    }
    const auto result = bank_.close_receiver(static_cast<std::uint8_t>(open_receiver_));
    open_receiver_ = -1;
    return result;
}

Result<void> Q3U4Frontend::terminate() noexcept
{
    return close();
}

const char* Q3U4Frontend::diagnostic_stage() const noexcept
{
    return bank_.diagnostic_stage();
}

void Q3U4Frontend::record_cleanup_power_off_failure() noexcept
{
    bank_.record_cleanup_power_off_failure();
}

Result<bool> Q3U4Frontend::terrestrial_loop_through(
    std::uint8_t local_receiver) const noexcept
{
    return bank_.terrestrial_loop_through(local_receiver);
}

}  // namespace px4::userland
