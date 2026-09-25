// Modified/ported for px4-userland on 2026-09-24.
//
// Copyright (c) 2018-2021 nns779
// Derived from tsukumijima/px4_drv commit d748866f0da1cb3656106a520de4e9d7f073aacd (v0.6.1).
// Origin paths: driver/pxmlt_device.c, driver/pxmlt_device.h,
// winusb/src/DriverHost_PX4/pxmlt_device.cpp.
// Source snapshot maintained by tsukumijima.
// SPDX-License-Identifier: GPL-2.0-only
#include "mlt5pe_frontend.h"

namespace px4::userland {

// Lock order: bus mutex -> state mutex.  The state mutex is never held while
// taking a bus mutex.

Mlt5PeFrontend::Mlt5PeFrontend(BridgeI2cMaster& bus1, BridgeI2cMaster& bus3,
                             Q3U4BackendPower& power, Mlt5PeDelay& delay,
                             Q3U4PsbPurger* purger) noexcept
    : power_(power, delay), purger_(purger),
      // pxmlt_device_params[PXMLT5PE_MODEL]; bus index 0 is I2C bus 1 and
      // index 1 is I2C bus 3.
      receivers_{{Receiver(bus3, 0x65U, delay, 1U), Receiver(bus1, 0x6cU, delay, 0U),
                  Receiver(bus1, 0x64U, delay, 0U), Receiver(bus3, 0x6cU, delay, 1U),
                  Receiver(bus3, 0x64U, delay, 1U)}}
{
}

Mlt5PeFrontend::~Mlt5PeFrontend() noexcept
{
    for (std::uint8_t receiver = 0U; receiver < kMlt5PeReceiverCount; ++receiver) {
        (void)close_receiver(receiver);
    }
}

std::mutex& Mlt5PeFrontend::bus_mutex(std::uint8_t receiver) noexcept
{
    return bus_mutexes_[receivers_[receiver].bus_index];
}

void Mlt5PeFrontend::terminate_receiver(Receiver& receiver) noexcept
{
    // pxmlt_chrdev_release ignores both termination results.
    receiver.tuner.terminate();
    receiver.demod.terminate();
}

Result<void> Mlt5PeFrontend::open_receiver(std::uint8_t receiver) noexcept
{
    if (!valid_receiver(receiver)) return Result<void>::failure(Error::INVALID_ARGUMENT);
    {
        std::lock_guard<std::mutex> state_lock(state_mutex_);
        if (receivers_[receiver].state != Mlt5PeReceiverState::closed)
            return Result<void>::failure(Error::BUSY);
    }
    const auto powered = power_.acquire_receiver(receiver);
    if (!powered) return powered;

    Receiver& target = receivers_[receiver];
    Result<void> result = Result<void>::success();
    {
        std::lock_guard<std::mutex> lock(bus_mutex(receiver));
        result = target.demod.initialize();
        if (result) {
            result = target.tuner.initialize();
            if (result) result = target.demod.configure_ts_output();
            if (!result) terminate_receiver(target);
        }
        if (result) {
            std::lock_guard<std::mutex> state_lock(state_mutex_);
            target.state = Mlt5PeReceiverState::open;
            target.system = Cxd2856erSystem::unspecified;
        }
    }
    if (!result) {
        // The original initialization error remains the result.
        (void)power_.release_receiver(receiver);
    }
    return result;
}

Result<void> Mlt5PeFrontend::close_receiver(std::uint8_t receiver) noexcept
{
    if (!valid_receiver(receiver)) return Result<void>::failure(Error::INVALID_ARGUMENT);
    Receiver& target = receivers_[receiver];
    {
        std::lock_guard<std::mutex> lock(bus_mutex(receiver));
        {
            std::lock_guard<std::mutex> state_lock(state_mutex_);
            if (target.state == Mlt5PeReceiverState::closed) return Result<void>::success();
            target.state = Mlt5PeReceiverState::closed;
            target.system = Cxd2856erSystem::unspecified;
        }
        terminate_receiver(target);
    }
    return power_.release_receiver(receiver);
}

Result<void> Mlt5PeFrontend::tune(std::uint8_t receiver, Cxd2856erSystem system,
                                 std::uint32_t frequency_khz) noexcept
{
    if (!valid_receiver(receiver) ||
        (system != Cxd2856erSystem::isdb_t && system != Cxd2856erSystem::isdb_s))
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    Receiver& target = receivers_[receiver];
    std::lock_guard<std::mutex> lock(bus_mutex(receiver));
    {
        std::lock_guard<std::mutex> state_lock(state_mutex_);
        if (target.state == Mlt5PeReceiverState::closed)
            return Result<void>::failure(Error::NOT_READY);
        if (target.state == Mlt5PeReceiverState::capturing)
            return Result<void>::failure(Error::BUSY);
        target.state = Mlt5PeReceiverState::open;
        target.system = Cxd2856erSystem::unspecified;
    }
    auto result = target.demod.wakeup(system);
    if (result) {
        result = system == Cxd2856erSystem::isdb_t ? target.tuner.set_params_t(frequency_khz)
                                                   : target.tuner.set_params_s(frequency_khz);
    }
    if (result) result = target.demod.post_tune();
    if (result) {
        std::lock_guard<std::mutex> state_lock(state_mutex_);
        target.state = Mlt5PeReceiverState::tuned;
        target.system = system;
    }
    return result;
}

Result<void> Mlt5PeFrontend::select_satellite_slot(std::uint8_t receiver,
                                                  std::uint8_t slot) noexcept
{
    if (!valid_receiver(receiver)) return Result<void>::failure(Error::INVALID_ARGUMENT);
    std::lock_guard<std::mutex> lock(bus_mutex(receiver));
    if (receiver_state(receiver) == Mlt5PeReceiverState::closed)
        return Result<void>::failure(Error::NOT_READY);
    return receivers_[receiver].demod.set_slot_isdbs(slot);
}

Result<void> Mlt5PeFrontend::select_satellite_tsid(std::uint8_t receiver,
                                                  std::uint16_t tsid) noexcept
{
    if (!valid_receiver(receiver)) return Result<void>::failure(Error::INVALID_ARGUMENT);
    std::lock_guard<std::mutex> lock(bus_mutex(receiver));
    if (receiver_state(receiver) == Mlt5PeReceiverState::closed)
        return Result<void>::failure(Error::NOT_READY);
    return receivers_[receiver].demod.set_tsid_isdbs(tsid);
}

Result<bool> Mlt5PeFrontend::is_terrestrial_locked(std::uint8_t receiver) noexcept
{
    if (!valid_receiver(receiver)) return Result<bool>::failure(Error::INVALID_ARGUMENT);
    std::lock_guard<std::mutex> lock(bus_mutex(receiver));
    if (receivers_[receiver].demod.system() != Cxd2856erSystem::isdb_t)
        return Result<bool>::failure(Error::NOT_READY);
    const auto lock_state = receivers_[receiver].demod.is_ts_locked_isdbt();
    if (!lock_state) return Result<bool>::failure(lock_state.error());
    // pxmlt_chrdev_check_lock turns this report into -ECANCELED, which ends
    // the reference driver's lock wait immediately.
    if (!lock_state.value().locked && lock_state.value().unlocked)
        return Result<bool>::failure(Error::TIMEOUT);
    return Result<bool>::success(lock_state.value().locked);
}

Result<bool> Mlt5PeFrontend::is_satellite_locked(std::uint8_t receiver) noexcept
{
    if (!valid_receiver(receiver)) return Result<bool>::failure(Error::INVALID_ARGUMENT);
    std::lock_guard<std::mutex> lock(bus_mutex(receiver));
    if (receivers_[receiver].demod.system() != Cxd2856erSystem::isdb_s)
        return Result<bool>::failure(Error::NOT_READY);
    return receivers_[receiver].demod.is_ts_locked_isdbs();
}

Result<void> Mlt5PeFrontend::start_capture(std::uint8_t receiver) noexcept
{
    if (!valid_receiver(receiver)) return Result<void>::failure(Error::INVALID_ARGUMENT);
    std::lock_guard<std::mutex> state_lock(state_mutex_);
    if (receivers_[receiver].state != Mlt5PeReceiverState::tuned)
        return Result<void>::failure(Error::NOT_READY);
    bool any_capturing = false;
    for (const Receiver& other : receivers_) {
        any_capturing = any_capturing || other.state == Mlt5PeReceiverState::capturing;
    }
    // pxmlt_chrdev_start_capture purges the PSB only before the first stream
    // starts.  Holding the state lock keeps a second start from overtaking it.
    if (!any_capturing && purger_ != nullptr) {
        const auto purged = purger_->purge();
        if (!purged) return purged;
    }
    receivers_[receiver].state = Mlt5PeReceiverState::capturing;
    return Result<void>::success();
}

Result<void> Mlt5PeFrontend::stop_capture(std::uint8_t receiver) noexcept
{
    if (!valid_receiver(receiver)) return Result<void>::failure(Error::INVALID_ARGUMENT);
    std::lock_guard<std::mutex> state_lock(state_mutex_);
    // Cleanup may retry after a partially failed start; not capturing is
    // already the requested state.
    if (receivers_[receiver].state != Mlt5PeReceiverState::capturing)
        return Result<void>::success();
    // The demodulator keeps its TS output enabled; the bridge stream itself
    // is stopped by the data plane when its last receiver detaches.
    receivers_[receiver].state = Mlt5PeReceiverState::tuned;
    return Result<void>::success();
}

Result<void> Mlt5PeFrontend::acquire_card() noexcept
{
    return power_.acquire_card();
}

Result<void> Mlt5PeFrontend::release_card() noexcept
{
    return power_.release_card();
}

Result<void> Mlt5PeFrontend::reconcile_power() noexcept
{
    return power_.reconcile();
}

Mlt5PeReceiverState Mlt5PeFrontend::receiver_state(std::uint8_t receiver) const noexcept
{
    if (!valid_receiver(receiver)) return Mlt5PeReceiverState::closed;
    std::lock_guard<std::mutex> state_lock(state_mutex_);
    return receivers_[receiver].state;
}

}  // namespace px4::userland
