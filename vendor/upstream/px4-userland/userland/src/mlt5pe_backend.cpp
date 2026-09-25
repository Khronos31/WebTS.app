// SPDX-License-Identifier: GPL-2.0-only
#include "mlt5pe_backend.h"

namespace px4::userland {

bool Mlt5PeTunerBackend::receiver_supports(std::uint8_t receiver,
                                           ipc::System system) const noexcept
{
    return receiver < kMlt5PeReceiverCount &&
           (system == ipc::System::ISDB_T || system == ipc::System::ISDB_S);
}

Result<void> Mlt5PeTunerBackend::open_receiver(std::uint8_t receiver) noexcept
{
    return frontend_.open_receiver(receiver);
}

Result<void> Mlt5PeTunerBackend::tune_terrestrial(std::uint8_t receiver,
                                                  std::uint32_t frequency_khz,
                                                  std::uint32_t timeout_ms) noexcept
{
    // The frontend sequence is bounded by its fixed I2C and sleep steps.
    (void)timeout_ms;
    return frontend_.tune(receiver, Cxd2856erSystem::isdb_t, frequency_khz);
}

Result<void> Mlt5PeTunerBackend::tune_satellite(std::uint8_t receiver,
                                                std::uint32_t frequency_khz,
                                                std::uint32_t timeout_ms) noexcept
{
    (void)timeout_ms;
    return frontend_.tune(receiver, Cxd2856erSystem::isdb_s, frequency_khz);
}

Result<bool> Mlt5PeTunerBackend::is_locked(std::uint8_t receiver, ipc::System system) noexcept
{
    if (system == ipc::System::ISDB_T) return frontend_.is_terrestrial_locked(receiver);
    if (system == ipc::System::ISDB_S) return frontend_.is_satellite_locked(receiver);
    return Result<bool>::failure(Error::INVALID_ARGUMENT);
}

Result<void> Mlt5PeTunerBackend::select_satellite_slot(std::uint8_t receiver,
                                                       std::uint8_t slot,
                                                       std::uint32_t timeout_ms) noexcept
{
    (void)timeout_ms;
    return frontend_.select_satellite_slot(receiver, slot);
}

Result<void> Mlt5PeTunerBackend::select_satellite_tsid(std::uint8_t receiver,
                                                       std::uint16_t tsid,
                                                       std::uint32_t timeout_ms) noexcept
{
    (void)timeout_ms;
    return frontend_.select_satellite_tsid(receiver, tsid);
}

Result<void> Mlt5PeTunerBackend::close_receiver(std::uint8_t receiver) noexcept
{
    // pxmlt_chrdev_release drops the LNB request before terminating the
    // frontend.  A transport loss makes further writes pointless.
    Error first = Error::OK;
    const auto released = lnb_power_.release_receiver(receiver);
    if (!released) first = released.error();
    if (released.error() == Error::DISCONNECTED) return Result<void>::failure(first);
    const auto closed = frontend_.close_receiver(receiver);
    if (!closed && first == Error::OK) first = closed.error();
    return first == Error::OK ? Result<void>::success() : Result<void>::failure(first);
}

Result<void> Mlt5PeTunerBackend::start_capture(std::uint8_t receiver,
                                               ipc::System system) noexcept
{
    (void)system;
    return frontend_.start_capture(receiver);
}

Result<void> Mlt5PeTunerBackend::stop_capture(std::uint8_t receiver,
                                              ipc::System system) noexcept
{
    (void)system;
    return frontend_.stop_capture(receiver);
}

Result<void> Mlt5PeTunerBackend::begin_tune_power(std::uint8_t receiver, ipc::System system,
                                                  std::uint8_t lnb_voltage) noexcept
{
    if (!receiver_supports(receiver, system) ||
        (system == ipc::System::ISDB_T && lnb_voltage != 0U))
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    // An ISDB-T tune commits a 0 V request, dropping any earlier ISDB-S
    // reference held by this receiver.
    return lnb_power_.begin_tune(receiver, lnb_voltage);
}

Result<void> Mlt5PeTunerBackend::commit_tune_power(std::uint8_t receiver) noexcept
{
    return lnb_power_.commit_tune(receiver);
}

Result<void> Mlt5PeTunerBackend::rollback_tune_power(std::uint8_t receiver) noexcept
{
    return lnb_power_.rollback_tune(receiver);
}

void Mlt5PeTunerBackend::mark_receiver_disconnected(std::uint8_t receiver) noexcept
{
    if (receiver < kMlt5PeReceiverCount) lnb_power_.disconnect();
}

Result<void> Mlt5PeTunerBackend::shutdown() noexcept
{
    return lnb_power_.shutdown();
}

Result<void> Mlt5PeCardBackend::set_power(bool on) noexcept
{
    if (on) {
        if (card_power_acquired_) return Result<void>::success();
        const auto acquired = frontend_.acquire_card();
        if (acquired) card_power_acquired_ = true;
        return acquired;
    }
    if (!card_power_acquired_) {
        // Best-effort cleanup after a failed acquire must not mask it.
        return frontend_.reconcile_power();
    }
    // release_card drops the logical reference even when the OFF write fails.
    card_power_acquired_ = false;
    return frontend_.release_card();
}

Result<void> Mlt5PeCardBackend::initialize_uart() noexcept
{
    return controller_.initialize_card_uart();
}

Result<bool> Mlt5PeCardBackend::detect_card() noexcept
{
    return controller_.detect_card();
}

}  // namespace px4::userland
