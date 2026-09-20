// SPDX-License-Identifier: GPL-2.0-only
#include "q3u4_power.h"

#include <cstddef>

namespace px4::userland {

namespace {

bool valid_bridge(Q3U4Bridge bridge) noexcept
{
    return static_cast<std::uint8_t>(bridge) < 2U;
}

}  // namespace

Q3U4PowerCoordinator::Q3U4PowerCoordinator(Q3U4BackendPower& dev1,
                                           Q3U4BackendPower& dev2,
                                           Q3U4Delay& delay) noexcept
    : dev1_(dev1), dev2_(dev2), delay_(delay)
{
}

std::size_t Q3U4PowerCoordinator::bridge_index(Q3U4Bridge bridge) noexcept
{
    return static_cast<std::size_t>(static_cast<std::uint8_t>(bridge));
}

Q3U4BackendPower& Q3U4PowerCoordinator::backend(Q3U4Bridge bridge) const noexcept
{
    return bridge == Q3U4Bridge::dev1 ? dev1_ : dev2_;
}

bool Q3U4PowerCoordinator::desired_power_locked(Q3U4Bridge bridge) const noexcept
{
    if (state_.receiver_mask != 0U) {
        return true;
    }
    return bridge == Q3U4Bridge::dev1 && state_.card_acquired;
}

bool Q3U4PowerCoordinator::enclosure_disconnected_locked() const noexcept
{
    return state_.backend_state[0] == Q3U4PowerState::disconnected ||
           state_.backend_state[1] == Q3U4PowerState::disconnected;
}

Result<void> Q3U4PowerCoordinator::set_bridge_locked(Q3U4Bridge bridge, bool on) noexcept
{
    const std::size_t index = bridge_index(bridge);
    Q3U4PowerState& current = state_.backend_state[index];

    if (current == Q3U4PowerState::disconnected) {
        // Turning off a terminally disconnected bridge is already represented
        // by the logical state. Turning it on cannot be satisfied.
        return on ? Result<void>::failure(Error::DISCONNECTED) : Result<void>::success();
    }
    if ((on && current == Q3U4PowerState::on) ||
        (!on && current == Q3U4PowerState::off)) {
        return Result<void>::success();
    }

    const auto result = backend(bridge).set_backend_power(on, delay_);
    if (result) {
        current = on ? Q3U4PowerState::on : Q3U4PowerState::off;
        return Result<void>::success();
    }

    if (result.error() == Error::DISCONNECTED) {
        // No cleanup write is attempted here or by any later release. The
        // bridge is terminal until a new coordinator is constructed.
        current = Q3U4PowerState::disconnected;
    } else {
        current = Q3U4PowerState::unknown;
    }
    return result;
}

Result<void> Q3U4PowerCoordinator::apply_desired_locked(Q3U4Bridge first_bridge) noexcept
{
    const Q3U4Bridge second_bridge = first_bridge == Q3U4Bridge::dev1
                                         ? Q3U4Bridge::dev2
                                         : Q3U4Bridge::dev1;
    const auto first_result = set_bridge_locked(first_bridge,
                                                desired_power_locked(first_bridge));
    if (!first_result) {
        return first_result;
    }
    return set_bridge_locked(second_bridge, desired_power_locked(second_bridge));
}

void Q3U4PowerCoordinator::rollback_logical_locked(
    const Q3U4PowerSnapshot& prior, Q3U4Bridge first_bridge) noexcept
{
    state_.receiver_mask = prior.receiver_mask;
    state_.card_acquired = prior.card_acquired;

    // Best effort is intentional. A failed rollback leaves unknown state for
    // a subsequent retry; a DISCONNECTED result has already made that bridge
    // terminal and set_bridge_locked will not issue another write.
    (void)apply_desired_locked(first_bridge);
}

Result<void> Q3U4PowerCoordinator::acquire_receiver(
    std::uint8_t global_receiver_id) noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    if (enclosure_disconnected_locked()) {
        return Result<void>::failure(Error::DISCONNECTED);
    }
    if (global_receiver_id > 7U) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    const std::uint8_t bit = static_cast<std::uint8_t>(1U << global_receiver_id);
    if ((state_.receiver_mask & bit) != 0U) {
        return Result<void>::failure(Error::BUSY);
    }

    const Q3U4PowerSnapshot prior = state_;
    const Q3U4Bridge requesting_bridge =
        global_receiver_id < 4U ? Q3U4Bridge::dev1 : Q3U4Bridge::dev2;
    state_.receiver_mask = static_cast<std::uint8_t>(state_.receiver_mask | bit);
    const auto result = apply_desired_locked(requesting_bridge);
    if (!result) {
        rollback_logical_locked(prior, requesting_bridge);
    }
    return result;
}

Result<void> Q3U4PowerCoordinator::release_receiver(
    std::uint8_t global_receiver_id) noexcept
{
    if (global_receiver_id > 7U) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }

    std::lock_guard<std::mutex> lock(mutex_);
    const std::uint8_t bit = static_cast<std::uint8_t>(1U << global_receiver_id);
    if ((state_.receiver_mask & bit) == 0U) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }

    state_.receiver_mask = static_cast<std::uint8_t>(state_.receiver_mask & ~bit);
    return apply_desired_locked(global_receiver_id < 4U
                                    ? Q3U4Bridge::dev1
                                    : Q3U4Bridge::dev2);
}

Result<void> Q3U4PowerCoordinator::acquire_card() noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    if (enclosure_disconnected_locked()) {
        return Result<void>::failure(Error::DISCONNECTED);
    }
    if (state_.card_acquired) {
        return Result<void>::failure(Error::BUSY);
    }

    const Q3U4PowerSnapshot prior = state_;
    state_.card_acquired = true;
    const auto result = apply_desired_locked();
    if (!result) {
        rollback_logical_locked(prior);
    }
    return result;
}

Result<void> Q3U4PowerCoordinator::release_card() noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    if (!state_.card_acquired) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }

    state_.card_acquired = false;
    return apply_desired_locked();
}

Result<void> Q3U4PowerCoordinator::reconcile() noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    if (enclosure_disconnected_locked()) {
        return Result<void>::failure(Error::DISCONNECTED);
    }
    return apply_desired_locked();
}

Result<void> Q3U4PowerCoordinator::disconnect(Q3U4Bridge bridge) noexcept
{
    if (!valid_bridge(bridge)) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }

    std::lock_guard<std::mutex> lock(mutex_);
    state_.backend_state[bridge_index(bridge)] = Q3U4PowerState::disconnected;
    state_.receiver_mask = 0U;
    state_.card_acquired = false;

    // There is no safe release ordering after a transport loss. Preserve a
    // known-off surviving bridge, but make an on surviving bridge unknown;
    // this path deliberately performs no hardware operation at all.
    const Q3U4Bridge other = bridge == Q3U4Bridge::dev1 ? Q3U4Bridge::dev2
                                                         : Q3U4Bridge::dev1;
    Q3U4PowerState& other_state = state_.backend_state[bridge_index(other)];
    if (other_state == Q3U4PowerState::on) {
        other_state = Q3U4PowerState::unknown;
    }
    return Result<void>::success();
}

Q3U4PowerSnapshot Q3U4PowerCoordinator::snapshot() const noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    return state_;
}

}  // namespace px4::userland
