// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_MLT5PE_BACKEND_H
#define PX4_USERLAND_MLT5PE_BACKEND_H

#include "px4/card_service.h"
#include "px4/tuner_service.h"
#include "mlt5pe_frontend.h"
#include "mlt5pe_power.h"

namespace px4::userland {

// Production bridge from the portable tuner seam to a PX-MLT5PE or
// DTV02A-5TS-P.  Every receiver accepts both systems.
class Mlt5PeTunerBackend final : public TunerServiceBackend {
public:
    Mlt5PeTunerBackend(Mlt5PeFrontend& frontend, Mlt5PeLnbPowerCoordinator& lnb_power) noexcept
        : frontend_(frontend), lnb_power_(lnb_power)
    {
    }

    std::uint8_t receiver_count() const noexcept override { return kMlt5PeReceiverCount; }
    bool receiver_supports(std::uint8_t receiver, ipc::System system) const noexcept override;
    bool selects_satellite_stream_before_tune() const noexcept override { return true; }
    // pxmlt_device.c enables PTX_CHRDEV_WAIT_AFTER_LOCK_TC_T.
    bool requires_terrestrial_lock_settle() const noexcept override { return true; }

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

private:
    Mlt5PeFrontend& frontend_;
    Mlt5PeLnbPowerCoordinator& lnb_power_;
};

// CardService owns the protocol session; this class owns only the logical
// card-power reference and the bridge UART seam.
class Mlt5PeCardBackend final : public CardServiceBackend {
public:
    Mlt5PeCardBackend(It930xController& controller, Mlt5PeFrontend& frontend) noexcept
        : controller_(controller), frontend_(frontend)
    {
    }

    Result<void> set_power(bool on) noexcept override;
    Result<void> initialize_uart() noexcept override;
    Result<bool> detect_card() noexcept override;

private:
    It930xController& controller_;
    Mlt5PeFrontend& frontend_;
    bool card_power_acquired_ = false;
};

}  // namespace px4::userland

#endif  // PX4_USERLAND_MLT5PE_BACKEND_H
