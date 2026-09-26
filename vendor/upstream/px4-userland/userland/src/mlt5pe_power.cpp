// SPDX-License-Identifier: GPL-2.0-only
#include "mlt5pe_power.h"

namespace px4::userland {

Result<void> Mlt5PePowerCoordinator::apply_locked() noexcept
{
    Q3U4PowerState& current = state_.backend_state;
    const bool on = state_.receiver_mask != 0U || state_.card_acquired;
    if (current == Q3U4PowerState::disconnected) {
        return on ? Result<void>::failure(Error::DISCONNECTED) : Result<void>::success();
    }
    if ((on && current == Q3U4PowerState::on) || (!on && current == Q3U4PowerState::off)) {
        return Result<void>::success();
    }
    const auto result = power_.set_backend_power(on, delay_);
    if (result) {
        current = on ? Q3U4PowerState::on : Q3U4PowerState::off;
    } else {
        current = result.error() == Error::DISCONNECTED ? Q3U4PowerState::disconnected
                                                        : Q3U4PowerState::unknown;
    }
    return result;
}

Result<void> Mlt5PePowerCoordinator::acquire_receiver(std::uint8_t receiver) noexcept
{
    if (receiver >= kMlt5PeReceiverCount) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    std::lock_guard<std::mutex> lock(mutex_);
    if (state_.backend_state == Q3U4PowerState::disconnected) {
        return Result<void>::failure(Error::DISCONNECTED);
    }
    const auto bit = static_cast<std::uint8_t>(1U << receiver);
    if ((state_.receiver_mask & bit) != 0U) {
        return Result<void>::failure(Error::BUSY);
    }
    state_.receiver_mask = static_cast<std::uint8_t>(state_.receiver_mask | bit);
    const auto result = apply_locked();
    if (!result) {
        // Best effort: an unknown state retries on the next transition.
        state_.receiver_mask = static_cast<std::uint8_t>(state_.receiver_mask & ~bit);
        (void)apply_locked();
    }
    return result;
}

Result<void> Mlt5PePowerCoordinator::release_receiver(std::uint8_t receiver) noexcept
{
    if (receiver >= kMlt5PeReceiverCount) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    std::lock_guard<std::mutex> lock(mutex_);
    const auto bit = static_cast<std::uint8_t>(1U << receiver);
    if ((state_.receiver_mask & bit) == 0U) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    state_.receiver_mask = static_cast<std::uint8_t>(state_.receiver_mask & ~bit);
    return apply_locked();
}

Result<void> Mlt5PePowerCoordinator::acquire_card() noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    if (state_.backend_state == Q3U4PowerState::disconnected) {
        return Result<void>::failure(Error::DISCONNECTED);
    }
    if (state_.card_acquired) {
        return Result<void>::failure(Error::BUSY);
    }
    state_.card_acquired = true;
    const auto result = apply_locked();
    if (!result) {
        state_.card_acquired = false;
        (void)apply_locked();
    }
    return result;
}

Result<void> Mlt5PePowerCoordinator::release_card() noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    if (!state_.card_acquired) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    state_.card_acquired = false;
    return apply_locked();
}

Result<void> Mlt5PePowerCoordinator::reconcile() noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    if (state_.backend_state == Q3U4PowerState::disconnected) {
        return Result<void>::failure(Error::DISCONNECTED);
    }
    return apply_locked();
}

void Mlt5PePowerCoordinator::disconnect() noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    state_ = Mlt5PePowerSnapshot{0U, false, Q3U4PowerState::disconnected};
}

Mlt5PePowerSnapshot Mlt5PePowerCoordinator::snapshot() const noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    return state_;
}

std::uint8_t Mlt5PeLnbPowerCoordinator::ref_count_locked() const noexcept
{
    std::uint8_t count = 0U;
    for (const ReceiverRequest& request : receivers_) {
        if (request.pending ? request.pending_15v : request.committed_15v) ++count;
    }
    return count;
}

Result<void> Mlt5PeLnbPowerCoordinator::apply_locked() noexcept
{
    const bool desired_on = ref_count_locked() != 0U;
    if (physical_state_ == Q3U4LnbPhysicalState::disconnected) {
        return Result<void>::failure(Error::DISCONNECTED);
    }
    if ((desired_on && physical_state_ == Q3U4LnbPhysicalState::on) ||
        (!desired_on && physical_state_ == Q3U4LnbPhysicalState::off && !cleanup_debt_)) {
        return Result<void>::success();
    }
    const auto result = power_.set_lnb_power(desired_on);
    if (result) {
        physical_state_ = desired_on ? Q3U4LnbPhysicalState::on : Q3U4LnbPhysicalState::off;
        cleanup_debt_ = false;
    } else if (result.error() == Error::DISCONNECTED) {
        physical_state_ = Q3U4LnbPhysicalState::disconnected;
        cleanup_debt_ = false;
    } else {
        // A write without a success response leaves GPIO 11 ambiguous.
        physical_state_ = Q3U4LnbPhysicalState::unknown;
        cleanup_debt_ = true;
    }
    return result;
}

Result<void> Mlt5PeLnbPowerCoordinator::begin_tune(std::uint8_t receiver,
                                                  std::uint8_t voltage) noexcept
{
    if (receiver >= kMlt5PeReceiverCount || (voltage != 0U && voltage != 15U)) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    std::lock_guard<std::mutex> lock(mutex_);
    if (voltage == 15U && !allow_15v_) {
        // Safety boundary before any state change or GPIO call.
        return Result<void>::failure(Error::UNSUPPORTED);
    }
    if (physical_state_ == Q3U4LnbPhysicalState::disconnected) {
        return Result<void>::failure(Error::DISCONNECTED);
    }
    ReceiverRequest& request = receivers_[receiver];
    if (request.pending) return Result<void>::failure(Error::BUSY);
    request.pending = true;
    request.pending_15v = voltage == 15U;
    const auto applied = apply_locked();
    if (applied) return applied;

    // Restore the prior logical request and make one conservative attempt
    // to restore its aggregate state; keep the original error.
    request.pending = false;
    const auto restored = apply_locked();
    if (!restored && restored.error() == Error::DISCONNECTED) {
        return Result<void>::failure(Error::DISCONNECTED);
    }
    return applied;
}

Result<void> Mlt5PeLnbPowerCoordinator::commit_tune(std::uint8_t receiver) noexcept
{
    if (receiver >= kMlt5PeReceiverCount) return Result<void>::failure(Error::INVALID_ARGUMENT);
    std::lock_guard<std::mutex> lock(mutex_);
    ReceiverRequest& request = receivers_[receiver];
    if (!request.pending) return Result<void>::failure(Error::INVALID_ARGUMENT);
    request.committed_15v = request.pending_15v;
    request.pending = false;
    return Result<void>::success();
}

Result<void> Mlt5PeLnbPowerCoordinator::rollback_tune(std::uint8_t receiver) noexcept
{
    if (receiver >= kMlt5PeReceiverCount) return Result<void>::failure(Error::INVALID_ARGUMENT);
    std::lock_guard<std::mutex> lock(mutex_);
    ReceiverRequest& request = receivers_[receiver];
    if (!request.pending) return Result<void>::failure(Error::INVALID_ARGUMENT);
    request.pending = false;
    return apply_locked();
}

Result<void> Mlt5PeLnbPowerCoordinator::release_receiver(std::uint8_t receiver) noexcept
{
    if (receiver >= kMlt5PeReceiverCount) return Result<void>::failure(Error::INVALID_ARGUMENT);
    std::lock_guard<std::mutex> lock(mutex_);
    receivers_[receiver] = ReceiverRequest{};
    return apply_locked();
}

Result<void> Mlt5PeLnbPowerCoordinator::shutdown() noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    receivers_.fill(ReceiverRequest{});
    return apply_locked();
}

void Mlt5PeLnbPowerCoordinator::disconnect() noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    physical_state_ = Q3U4LnbPhysicalState::disconnected;
    cleanup_debt_ = false;
    receivers_.fill(ReceiverRequest{});
}

Mlt5PeLnbPowerSnapshot Mlt5PeLnbPowerCoordinator::snapshot() const noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    return Mlt5PeLnbPowerSnapshot{ref_count_locked(), physical_state_, cleanup_debt_};
}

}  // namespace px4::userland
