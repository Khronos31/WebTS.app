// Modified/ported for px4-userland on 2026-09-03.
//
// Copyright (c) 2018-2021 nns779
// Derived from tsukumijima/px4_drv commit 9eedea8c502875a788697984b93b50032339b9aa.
// Origin paths: driver/px4_device.c, driver/px4_device.h,
// winusb/src/DriverHost_PX4/px4_device.cpp,
// winusb/src/DriverHost_PX4/px4_device.hpp.
// Source snapshot maintained by tsukumijima.
// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_Q3U4_FRONTEND_H
#define PX4_USERLAND_Q3U4_FRONTEND_H

#include "px4/error.h"
#include "px4/it930x.h"
#include "q3u4_power.h"
#include "r850.h"
#include "rt710.h"
#include "tc90522.h"

#include <array>
#include <cstdint>
#include <mutex>

namespace px4::userland {

class Q3U4FrontendDelay : public Q3U4Delay, public R850Delay, public Rt710Delay {
public:
    ~Q3U4FrontendDelay() noexcept override = default;
    void sleep_ms(std::uint32_t milliseconds) noexcept override = 0;
};

class It930xBackendPower final : public Q3U4BackendPower {
public:
    explicit It930xBackendPower(It930xController& controller) noexcept
        : controller_(controller)
    {
    }

    Result<void> set_backend_power(bool on, Q3U4Delay& delay) noexcept override;

private:
    It930xController& controller_;
};

class Q3U4PsbPurger {
public:
    virtual ~Q3U4PsbPurger() noexcept = default;
    virtual Result<void> purge() noexcept = 0;
};

// The reference px4_drv purges the IT930x packet sync buffer immediately
// before enabling the first TS pin on a bridge.  Keeping that operation in
// the frontend bank preserves the first-capture/last-capture serialization.
class It930xPsbPurger final : public Q3U4PsbPurger {
public:
    explicit It930xPsbPurger(It930xController& controller,
                             Timeout timeout = Timeout{2000U}) noexcept
        : controller_(controller), timeout_(timeout)
    {
    }

    Result<void> purge() noexcept override;

private:
    It930xController& controller_;
    Timeout timeout_;
};

class Q3U4ReceiverPowerAuthority {
public:
    virtual ~Q3U4ReceiverPowerAuthority() noexcept = default;
    virtual Result<void> acquire_receiver(std::uint8_t global_receiver,
                                          Q3U4Delay& delay) noexcept = 0;
    virtual Result<void> release_receiver(std::uint8_t global_receiver,
                                          Q3U4Delay& delay) noexcept = 0;
};

// Compatibility-only adapter for the developer probes. Production banks use
// Q3U4CoordinatorReceiverPowerAuthority and never write backend power directly.
class Q3U4DirectReceiverPowerAuthority final : public Q3U4ReceiverPowerAuthority {
public:
    explicit Q3U4DirectReceiverPowerAuthority(Q3U4BackendPower& power) noexcept
        : power_(power)
    {
    }

    Result<void> acquire_receiver(std::uint8_t global_receiver,
                                  Q3U4Delay& delay) noexcept override;
    Result<void> release_receiver(std::uint8_t global_receiver,
                                  Q3U4Delay& delay) noexcept override;
    bool release_pending() const noexcept { return acquired_; }
    Result<void> retry_release(Q3U4Delay& delay) noexcept;

private:
    Q3U4BackendPower& power_;
    bool acquired_ = false;
};

class Q3U4CoordinatorReceiverPowerAuthority final
    : public Q3U4ReceiverPowerAuthority {
public:
    Q3U4CoordinatorReceiverPowerAuthority(Q3U4PowerCoordinator& coordinator,
                                          std::uint8_t global_base) noexcept
        : coordinator_(coordinator), global_base_(global_base)
    {
    }

    Result<void> acquire_receiver(std::uint8_t global_receiver,
                                  Q3U4Delay& delay) noexcept override;
    Result<void> release_receiver(std::uint8_t global_receiver,
                                  Q3U4Delay& delay) noexcept override;

private:
    Q3U4PowerCoordinator& coordinator_;
    std::uint8_t global_base_;
};

enum class Q3U4ReceiverState : std::uint8_t {
    closed = 0,
    open = 1,
    tuned = 2,
    capturing = 3,
};

class Q3U4FrontendBank final {
public:
    enum class DiagnosticStage : std::uint8_t {
        none,
        backend_power_on,
        tuner_initialize_rt710_0,
        tuner_initialize_rt710_1,
        tuner_initialize_r850_0,
        tuner_initialize_r850_1,
        frontend_sleep_rt710_0,
        frontend_sleep_rt710_1,
        frontend_sleep_r850_0,
        frontend_sleep_r850_1,
        selected_tc_init_writes,
        satellite_selected_tc_init_writes,
        ts_pin_disable,
        satellite_ts_pin_disable,
        ts_pin_enable,
        satellite_ts_pin_enable,
        psb_purge,
        cleanup_ts_pin_disable,
        cleanup_satellite_ts_pin_disable,
        demod_wake,
        satellite_demod_wake,
        selected_r850_wake,
        r850_system_set,
        shared_s0,
        shared_t0,
        tune_tc47,
        agc_off,
        tc76,
        r850_set_frequency,
        pll_poll,
        satellite_agc_off,
        satellite_mode_registers,
        satellite_set_params,
        satellite_pll_poll,
        satellite_agc_on,
        satellite_demod_lock,
        satellite_slot_tmcc,
        satellite_slot_set,
        satellite_slot_verify,
        agc_on,
        tc71_72_75,
        cleanup_tuner_terminate,
        cleanup_power_off,
        open,
        tuned,
        closed,
    };

    Q3U4FrontendBank(BridgeI2cMaster& bridge,
                     Q3U4ReceiverPowerAuthority& power,
                     std::uint8_t global_base,
                     Q3U4FrontendDelay& delay,
                     Q3U4PsbPurger* purger = nullptr) noexcept;
    ~Q3U4FrontendBank() noexcept;

    Q3U4FrontendBank(const Q3U4FrontendBank&) = delete;
    Q3U4FrontendBank& operator=(const Q3U4FrontendBank&) = delete;

    Result<void> open_terrestrial(std::uint8_t local_receiver) noexcept;
    Result<void> open_satellite(std::uint8_t local_receiver) noexcept;
    Result<void> tune_terrestrial(std::uint8_t local_receiver,
                                  std::uint32_t frequency_khz) noexcept;
    Result<void> tune_terrestrial_with_timeout(
        std::uint8_t local_receiver, std::uint32_t frequency_khz,
        std::uint32_t timeout_ms) noexcept;
    Result<void> tune_satellite(std::uint8_t local_receiver,
                                std::uint32_t frequency_khz) noexcept;
    Result<void> tune_satellite_with_timeout(
        std::uint8_t local_receiver, std::uint32_t frequency_khz,
        std::uint32_t timeout_ms) noexcept;
    Result<void> select_satellite_slot(std::uint8_t local_receiver,
                                       std::uint8_t slot) noexcept;
    Result<void> select_satellite_slot_with_timeout(
        std::uint8_t local_receiver, std::uint8_t slot,
        std::uint32_t timeout_ms) noexcept;
    Result<void> select_satellite_tsid(std::uint8_t local_receiver,
                                       std::uint16_t tsid) noexcept;
    Result<void> select_satellite_tsid_with_timeout(
        std::uint8_t local_receiver, std::uint16_t tsid,
        std::uint32_t timeout_ms) noexcept;
    Result<void> start_terrestrial_capture(std::uint8_t local_receiver) noexcept;
    Result<void> start_satellite_capture(std::uint8_t local_receiver) noexcept;
    Result<void> stop_terrestrial_capture(std::uint8_t local_receiver) noexcept;
    Result<void> stop_satellite_capture(std::uint8_t local_receiver) noexcept;
    Result<bool> is_terrestrial_locked(std::uint8_t local_receiver) noexcept;
    Result<bool> is_satellite_locked(std::uint8_t local_receiver) noexcept;
    Result<void> close_receiver(std::uint8_t local_receiver) noexcept;

    Q3U4ReceiverState receiver_state(std::uint8_t local_receiver) const noexcept;
    bool capture_active(std::uint8_t local_receiver) const noexcept;
    std::uint16_t selected_tsid(std::uint8_t local_receiver) const noexcept;
    Result<bool> terrestrial_loop_through(std::uint8_t local_receiver) const noexcept;
    const char* diagnostic_stage() const noexcept;
    void record_cleanup_power_off_failure() noexcept;

private:
    Result<void> open_receiver(std::uint8_t local_receiver,
                               Tc90522System system) noexcept;
    Result<void> tune_receiver(std::uint8_t local_receiver,
                               std::uint32_t frequency_khz,
                               Tc90522System system,
                               std::uint32_t timeout_ms) noexcept;
    Result<void> start_capture(std::uint8_t local_receiver,
                               Tc90522System system) noexcept;
    Result<void> stop_capture(std::uint8_t local_receiver,
                              Tc90522System system) noexcept;
    Result<bool> is_locked(std::uint8_t local_receiver,
                           Tc90522System system) noexcept;
    Result<void> cleanup() noexcept;
    Result<void> cleanup_open_failure(std::uint8_t local_receiver,
                                      bool first_open,
                                      Error primary) noexcept;
    Result<void> sleep_frontend(std::uint8_t index) noexcept;
    Result<void> terminate_initialized() noexcept;
    Result<void> wake_frontend(std::uint8_t local_receiver,
                               Tc90522System system) noexcept;
    Result<void> write_shared_initialization() noexcept;
    Result<void> disable_capture(std::uint8_t local_receiver,
                                 Tc90522System system) noexcept;
    Result<void> select_satellite_tsid_locked(std::uint8_t local_receiver,
                                              std::uint16_t tsid,
                                              std::uint32_t timeout_ms) noexcept;
    void remember_first(Error& first, const Result<void>& result) noexcept;
    void begin_operation() noexcept;
    void attempt(DiagnosticStage stage) noexcept { current_stage_ = stage; }
    void remember_failure(const Result<void>& result) noexcept;
    bool valid_local_receiver(std::uint8_t local_receiver) const noexcept;
    bool any_open_locked() const noexcept;
    bool any_other_open_locked(std::uint8_t local_receiver) const noexcept;
    bool any_capturing_locked() const noexcept;
    Result<void> acquire_power(std::uint8_t local_receiver) noexcept;
    Result<void> release_power(std::uint8_t local_receiver) noexcept;

    Q3U4ReceiverPowerAuthority& power_;
    std::uint8_t global_base_;
    Q3U4FrontendDelay& delay_;
    Q3U4PsbPurger* purger_;
    std::array<Tc90522, 4U> tc_;
    std::array<Rt710, 2U> rt710_;
    std::array<R850, 2U> r850_;
    std::array<bool, 4U> tuner_initialized_{};
    std::array<Q3U4ReceiverState, 4U> receiver_state_{};
    std::array<bool, 4U> satellite_selected_{};
    std::array<std::uint16_t, 4U> selected_tsid_{};
    DiagnosticStage current_stage_ = DiagnosticStage::none;
    DiagnosticStage failure_stage_ = DiagnosticStage::none;
    bool operation_failed_ = false;
    mutable std::mutex mutex_;
};

class Q3U4FrontendEnclosure final {
public:
    struct ReceiverMapping final {
        std::uint8_t global_receiver;
        Q3U4Bridge bridge;
        std::uint8_t local_receiver;
        Tc90522System system;
    };

    Q3U4FrontendEnclosure(BridgeI2cMaster& dev1_bridge,
                          BridgeI2cMaster& dev2_bridge,
                          Q3U4BackendPower& dev1_power,
                          Q3U4BackendPower& dev2_power,
                          Q3U4FrontendDelay& delay,
                          Q3U4PsbPurger* dev1_purger = nullptr,
                          Q3U4PsbPurger* dev2_purger = nullptr) noexcept;
    ~Q3U4FrontendEnclosure() noexcept;

    Q3U4FrontendEnclosure(const Q3U4FrontendEnclosure&) = delete;
    Q3U4FrontendEnclosure& operator=(const Q3U4FrontendEnclosure&) = delete;

    static Result<ReceiverMapping> map_receiver(
        std::uint8_t global_receiver) noexcept;

    Result<void> open_terrestrial(std::uint8_t global_receiver) noexcept;
    Result<void> open_satellite(std::uint8_t global_receiver) noexcept;
    Result<void> tune_terrestrial(std::uint8_t global_receiver,
                                  std::uint32_t frequency_khz) noexcept;
    Result<void> tune_terrestrial_with_timeout(
        std::uint8_t global_receiver, std::uint32_t frequency_khz,
        std::uint32_t timeout_ms) noexcept;
    Result<void> tune_satellite(std::uint8_t global_receiver,
                                std::uint32_t frequency_khz) noexcept;
    Result<void> tune_satellite_with_timeout(
        std::uint8_t global_receiver, std::uint32_t frequency_khz,
        std::uint32_t timeout_ms) noexcept;
    Result<void> select_satellite_slot(std::uint8_t global_receiver,
                                       std::uint8_t slot) noexcept;
    Result<void> select_satellite_slot_with_timeout(
        std::uint8_t global_receiver, std::uint8_t slot,
        std::uint32_t timeout_ms) noexcept;
    Result<void> select_satellite_tsid(std::uint8_t global_receiver,
                                       std::uint16_t tsid) noexcept;
    Result<void> select_satellite_tsid_with_timeout(
        std::uint8_t global_receiver, std::uint16_t tsid,
        std::uint32_t timeout_ms) noexcept;
    Result<void> start_terrestrial_capture(std::uint8_t global_receiver) noexcept;
    Result<void> start_satellite_capture(std::uint8_t global_receiver) noexcept;
    Result<void> stop_terrestrial_capture(std::uint8_t global_receiver) noexcept;
    Result<void> stop_satellite_capture(std::uint8_t global_receiver) noexcept;
    Result<bool> is_terrestrial_locked(std::uint8_t global_receiver) noexcept;
    Result<bool> is_satellite_locked(std::uint8_t global_receiver) noexcept;
    Result<void> close_receiver(std::uint8_t global_receiver) noexcept;

    // Shared card power authority for the device-1 reader. Card protocol
    // initialization remains owned by CardService/px4d.
    Result<void> acquire_card() noexcept;
    Result<void> release_card() noexcept;
    Result<void> reconcile_power() noexcept;

    Q3U4ReceiverState receiver_state(std::uint8_t global_receiver) const noexcept;
    Q3U4PowerSnapshot power_snapshot() const noexcept;
    Q3U4FrontendBank& bank(Q3U4Bridge bridge) noexcept;

private:
    Result<Q3U4FrontendBank*> select_bank(
        std::uint8_t global_receiver) noexcept;
    Result<const Q3U4FrontendBank*> select_bank(
        std::uint8_t global_receiver) const noexcept;

    Q3U4PowerCoordinator coordinator_;
    Q3U4CoordinatorReceiverPowerAuthority dev1_power_;
    Q3U4CoordinatorReceiverPowerAuthority dev2_power_;
    Q3U4FrontendBank dev1_bank_;
    Q3U4FrontendBank dev2_bank_;
};


class Q3U4Frontend final {
public:
    using DiagnosticStage = Q3U4FrontendBank::DiagnosticStage;

    Q3U4Frontend(BridgeI2cMaster& bridge, Q3U4BackendPower& power,
                 Q3U4FrontendDelay& delay) noexcept;
    ~Q3U4Frontend() noexcept;

    Q3U4Frontend(const Q3U4Frontend&) = delete;
    Q3U4Frontend& operator=(const Q3U4Frontend&) = delete;

    Result<void> open_terrestrial(std::uint8_t local_receiver) noexcept;
    Result<void> open_satellite(std::uint8_t local_receiver) noexcept;
    Result<void> tune_terrestrial(std::uint32_t frequency_khz) noexcept;
    Result<void> tune_satellite(std::uint32_t frequency_khz) noexcept;
    Result<void> select_satellite_slot(std::uint8_t slot) noexcept;
    Result<void> start_terrestrial_capture() noexcept;
    Result<void> start_satellite_capture() noexcept;
    Result<void> stop_terrestrial_capture() noexcept;
    Result<void> stop_satellite_capture() noexcept;
    bool capture_active() const noexcept;
    Result<bool> is_terrestrial_locked() noexcept;
    Result<bool> is_satellite_locked() noexcept;
    std::uint16_t selected_tsid() const noexcept;
    Result<void> close() noexcept;
    Result<void> terminate() noexcept;

    bool open_state() const noexcept { return open_receiver_ >= 0; }
    std::int8_t open_receiver() const noexcept { return open_receiver_; }
    const char* diagnostic_stage() const noexcept;
    void record_cleanup_power_off_failure() noexcept;
    Result<bool> terrestrial_loop_through(std::uint8_t local_receiver) const noexcept;

private:
    Q3U4DirectReceiverPowerAuthority power_authority_;
    Q3U4FrontendBank bank_;
    Q3U4FrontendDelay& delay_;
    std::int8_t open_receiver_ = -1;
};

}  // namespace px4::userland

#endif  // PX4_USERLAND_Q3U4_FRONTEND_H
