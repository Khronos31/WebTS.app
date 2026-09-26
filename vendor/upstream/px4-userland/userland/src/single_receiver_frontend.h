// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_SINGLE_RECEIVER_FRONTEND_H
#define PX4_USERLAND_SINGLE_RECEIVER_FRONTEND_H

#include "px4/card_service.h"
#include "px4/identity.h"
#include "px4/tuner_service.h"
#include "q3u4_frontend.h"

#include <mutex>

namespace px4::userland {

// Dedicated TC90522/R850/RT710 path for the one-receiver USB enclosures.
class SingleReceiverFrontend final : public TunerServiceBackend,
                                     public CardServiceBackend {
public:
    SingleReceiverFrontend(BridgeI2cMaster& bridge, It930xController& controller,
                           Q3U4BackendPower& power, Q3U4FrontendDelay& delay,
                           DeviceModel model, bool allow_lnb_power = false) noexcept;
    ~SingleReceiverFrontend() noexcept override;
    std::uint8_t receiver_count() const noexcept override { return 1U; }
    bool receiver_supports(std::uint8_t receiver, ipc::System system) const noexcept override;
    Result<void> open_receiver(std::uint8_t receiver) noexcept override;
    Result<void> tune_terrestrial(std::uint8_t receiver, std::uint32_t frequency_khz,
                                  std::uint32_t timeout_ms) noexcept override;
    Result<void> tune_satellite(std::uint8_t receiver, std::uint32_t frequency_khz,
                                std::uint32_t timeout_ms) noexcept override;
    Result<bool> is_locked(std::uint8_t receiver, ipc::System system) noexcept override;
    Result<void> select_satellite_slot(std::uint8_t receiver, std::uint8_t slot,
                                       std::uint32_t timeout_ms) noexcept override;
    Result<void> select_satellite_tsid(std::uint8_t receiver, std::uint16_t tsid,
                                       std::uint32_t timeout_ms) noexcept override;
    Result<void> close_receiver(std::uint8_t receiver) noexcept override;
    Result<void> start_capture(std::uint8_t receiver, ipc::System system) noexcept override;
    Result<void> stop_capture(std::uint8_t receiver, ipc::System system) noexcept override;
    Result<void> begin_tune_power(std::uint8_t receiver, ipc::System system,
                                  std::uint8_t lnb_voltage) noexcept override;
    Result<void> commit_tune_power(std::uint8_t receiver) noexcept override;
    Result<void> rollback_tune_power(std::uint8_t receiver) noexcept override;
    void mark_receiver_disconnected(std::uint8_t receiver) noexcept override;
    Result<void> shutdown() noexcept override;
    Result<void> set_power(bool on) noexcept override;
    Result<void> initialize_uart() noexcept override;
    Result<bool> detect_card() noexcept override;
private:
    Result<void> acquire_power() noexcept;
    Result<void> release_power() noexcept;
    Result<void> initialize_frontend() noexcept;
    It930xController& controller_;
    Q3U4BackendPower& power_;
    Q3U4FrontendDelay& delay_;
    DeviceModel model_;
    bool allow_lnb_power_;
    bool lnb_on_ = false;
    bool pending_lnb_ = false;
    bool prior_lnb_on_ = false;
    Tc90522 tc_t_;
    Tc90522 tc_s_;
    Tc90522 tc_s0_;
    R850 r850_;
    Rt710 rt710_;
    bool opened_ = false;
    bool capturing_ = false;
    bool card_powered_ = false;
    bool powered_ = false;
    bool satellite_ = false;
    bool disconnected_ = false;
    std::uint8_t references_ = 0U;
    std::mutex power_mutex_;
};

}  // namespace px4::userland
#endif
