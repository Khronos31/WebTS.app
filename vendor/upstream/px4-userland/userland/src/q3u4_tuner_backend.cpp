// SPDX-License-Identifier: GPL-2.0-only
#include "q3u4_tuner_backend.h"

namespace px4::userland {

namespace {

bool valid_receiver(std::uint8_t receiver) noexcept
{
    return receiver < 8U;
}

bool is_satellite(std::uint8_t receiver) noexcept
{
    return receiver == 0U || receiver == 1U || receiver == 4U || receiver == 5U;
}

}  // namespace

Result<void> Q3U4FrontendTunerBackend::open_receiver(
    std::uint8_t receiver) noexcept
{
    if (!valid_receiver(receiver)) return Result<void>::failure(Error::INVALID_ARGUMENT);
    return is_satellite(receiver) ? enclosure_.open_satellite(receiver)
                                   : enclosure_.open_terrestrial(receiver);
}

Result<void> Q3U4FrontendTunerBackend::tune_terrestrial(
    std::uint8_t receiver, std::uint32_t frequency_khz,
    std::uint32_t timeout_ms) noexcept
{
    return enclosure_.tune_terrestrial_with_timeout(receiver, frequency_khz,
                                                    timeout_ms);
}

Result<void> Q3U4FrontendTunerBackend::tune_satellite(
    std::uint8_t receiver, std::uint32_t frequency_khz,
    std::uint32_t timeout_ms) noexcept
{
    return enclosure_.tune_satellite_with_timeout(receiver, frequency_khz,
                                                  timeout_ms);
}

Result<bool> Q3U4FrontendTunerBackend::is_locked(
    std::uint8_t receiver, ipc::System system) noexcept
{
    if (!valid_receiver(receiver)) return Result<bool>::failure(Error::INVALID_ARGUMENT);
    if (system == ipc::System::ISDB_T)
        return enclosure_.is_terrestrial_locked(receiver);
    if (system == ipc::System::ISDB_S)
        return enclosure_.is_satellite_locked(receiver);
    return Result<bool>::failure(Error::INVALID_ARGUMENT);
}

Result<void> Q3U4FrontendTunerBackend::select_satellite_slot(
    std::uint8_t receiver, std::uint8_t slot,
    std::uint32_t timeout_ms) noexcept
{
    return enclosure_.select_satellite_slot_with_timeout(receiver, slot, timeout_ms);
}

Result<void> Q3U4FrontendTunerBackend::select_satellite_tsid(
    std::uint8_t receiver, std::uint16_t tsid,
    std::uint32_t timeout_ms) noexcept
{
    return enclosure_.select_satellite_tsid_with_timeout(receiver, tsid, timeout_ms);
}

Result<void> Q3U4FrontendTunerBackend::close_receiver(
    std::uint8_t receiver) noexcept
{
    Error first = Error::OK;
    if (is_satellite(receiver)) {
        const auto released = lnb_power_.release_receiver(receiver);
        if (!released) first = released.error();
        if (released.error() == Error::DISCONNECTED)
            return Result<void>::failure(first);
    }
    const auto closed = enclosure_.close_receiver(receiver);
    if (!closed && first == Error::OK) first = closed.error();
    return first == Error::OK ? Result<void>::success()
                              : Result<void>::failure(first);
}

Result<void> Q3U4FrontendTunerBackend::begin_tune_power(
    std::uint8_t receiver, ipc::System system,
    std::uint8_t lnb_voltage) noexcept
{
    if (!valid_receiver(receiver) || system !=
            (is_satellite(receiver) ? ipc::System::ISDB_S : ipc::System::ISDB_T)) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    if (system == ipc::System::ISDB_T) {
        return lnb_voltage == 0U ? Result<void>::success()
                                 : Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    return lnb_power_.begin_tune(receiver, lnb_voltage);
}

Result<void> Q3U4FrontendTunerBackend::commit_tune_power(
    std::uint8_t receiver) noexcept
{
    return is_satellite(receiver) ? lnb_power_.commit_tune(receiver)
                                  : Result<void>::success();
}

Result<void> Q3U4FrontendTunerBackend::rollback_tune_power(
    std::uint8_t receiver) noexcept
{
    return is_satellite(receiver) ? lnb_power_.rollback_tune(receiver)
                                  : Result<void>::success();
}

void Q3U4FrontendTunerBackend::mark_receiver_disconnected(
    std::uint8_t receiver) noexcept
{
    if (!valid_receiver(receiver)) return;
    (void)lnb_power_.disconnect(receiver < 4U ? Q3U4Bridge::dev1
                                             : Q3U4Bridge::dev2);
}

Result<void> Q3U4FrontendTunerBackend::shutdown() noexcept
{
    return lnb_power_.shutdown();
}

Result<void> Q3U4FrontendTunerBackend::start_capture(
    std::uint8_t receiver, ipc::System system) noexcept
{
    if (!valid_receiver(receiver))
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    if (system == ipc::System::ISDB_T)
        return enclosure_.start_terrestrial_capture(receiver);
    if (system == ipc::System::ISDB_S)
        return enclosure_.start_satellite_capture(receiver);
    return Result<void>::failure(Error::INVALID_ARGUMENT);
}

Result<void> Q3U4FrontendTunerBackend::stop_capture(
    std::uint8_t receiver, ipc::System system) noexcept
{
    if (!valid_receiver(receiver))
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    if (system == ipc::System::ISDB_T)
        return enclosure_.stop_terrestrial_capture(receiver);
    if (system == ipc::System::ISDB_S)
        return enclosure_.stop_satellite_capture(receiver);
    return Result<void>::failure(Error::INVALID_ARGUMENT);
}

}  // namespace px4::userland
