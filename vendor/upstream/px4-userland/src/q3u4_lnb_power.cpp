// SPDX-License-Identifier: GPL-2.0-only
#include "q3u4_lnb_power.h"

#include <cstddef>

namespace px4::userland {

Result<void> It930xLnbPower::set_lnb_power(bool on) noexcept
{
    return controller_.set_q3u4_lnb_power(on);
}

Q3U4LnbPowerCoordinator::Q3U4LnbPowerCoordinator(
    Q3U4LnbPower& dev1, Q3U4LnbPower& dev2, bool allow_15v) noexcept
    : dev1_(dev1), dev2_(dev2), allow_15v_(allow_15v)
{
}

bool Q3U4LnbPowerCoordinator::valid_satellite_receiver(
    std::uint8_t receiver) noexcept
{
    return receiver == 0U || receiver == 1U || receiver == 4U || receiver == 5U;
}

std::size_t Q3U4LnbPowerCoordinator::bridge_index_for_receiver(
    std::uint8_t receiver) noexcept
{
    return receiver < 4U ? 0U : 1U;
}

std::size_t Q3U4LnbPowerCoordinator::bridge_index(Q3U4Bridge bridge) noexcept
{
    return static_cast<std::size_t>(static_cast<std::uint8_t>(bridge));
}

Q3U4LnbPower& Q3U4LnbPowerCoordinator::backend(std::size_t bridge) const noexcept
{
    return bridge == 0U ? dev1_ : dev2_;
}

std::uint8_t Q3U4LnbPowerCoordinator::ref_count_locked(
    std::size_t bridge) const noexcept
{
    std::uint8_t count = 0U;
    const std::size_t first = bridge == 0U ? 0U : 4U;
    for (std::size_t local = 0U; local < 2U; ++local) {
        const ReceiverRequest& request = receivers_[first + local];
        const bool enabled = request.pending
            ? request.pending_15v
            : request.committed && request.committed_15v;
        if (enabled) ++count;
    }
    return count;
}

Result<void> Q3U4LnbPowerCoordinator::apply_bridge_locked(
    std::size_t bridge) noexcept
{
    Q3U4LnbPhysicalState& state = physical_state_[bridge];
    const bool desired_on = ref_count_locked(bridge) != 0U;
    if (state == Q3U4LnbPhysicalState::disconnected) {
        return Result<void>::failure(Error::DISCONNECTED);
    }
    if ((desired_on && state == Q3U4LnbPhysicalState::on) ||
        (!desired_on && state == Q3U4LnbPhysicalState::off &&
         !cleanup_debt_[bridge])) {
        return Result<void>::success();
    }

    const auto result = backend(bridge).set_lnb_power(desired_on);
    if (result) {
        state = desired_on ? Q3U4LnbPhysicalState::on
                           : Q3U4LnbPhysicalState::off;
        cleanup_debt_[bridge] = false;
        return Result<void>::success();
    }
    if (result.error() == Error::DISCONNECTED) {
        state = Q3U4LnbPhysicalState::disconnected;
        cleanup_debt_[bridge] = false;
    } else {
        state = Q3U4LnbPhysicalState::unknown;
        cleanup_debt_[bridge] = true;
    }
    return result;
}

Result<void> Q3U4LnbPowerCoordinator::apply_both_locked() noexcept
{
    Error first = Error::OK;
    for (std::size_t bridge = 0U; bridge < 2U; ++bridge) {
        const auto result = apply_bridge_locked(bridge);
        if (!result && first == Error::OK) first = result.error();
    }
    return first == Error::OK ? Result<void>::success()
                              : Result<void>::failure(first);
}

Result<void> Q3U4LnbPowerCoordinator::begin_tune(
    std::uint8_t global_receiver, std::uint8_t voltage) noexcept
{
    if (!valid_satellite_receiver(global_receiver) ||
        (voltage != 0U && voltage != 15U)) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    std::lock_guard<std::mutex> lock(mutex_);
    if (voltage == 15U && !allow_15v_) {
        // This safety boundary is deliberately before any state change or
        // GPIO call.
        return Result<void>::failure(Error::UNSUPPORTED);
    }
    if (physical_state_[0U] == Q3U4LnbPhysicalState::disconnected ||
        physical_state_[1U] == Q3U4LnbPhysicalState::disconnected) {
        return Result<void>::failure(Error::DISCONNECTED);
    }

    ReceiverRequest& request = receivers_[global_receiver];
    if (request.pending) return Result<void>::failure(Error::BUSY);
    request.pending = true;
    request.pending_15v = voltage == 15U;
    const std::size_t bridge = bridge_index_for_receiver(global_receiver);
    const auto applied = apply_bridge_locked(bridge);
    if (applied) return Result<void>::success();

    // The requested transition did not complete with a success response.
    // Restore the prior logical request and make one conservative attempt to
    // restore its physical aggregate state. The original error remains the
    // tune result unless terminal disconnect is learned during cleanup.
    request.pending = false;
    const auto restored = apply_bridge_locked(bridge);
    if (!restored && restored.error() == Error::DISCONNECTED) {
        return Result<void>::failure(Error::DISCONNECTED);
    }
    return applied;
}

Result<void> Q3U4LnbPowerCoordinator::commit_tune(
    std::uint8_t global_receiver) noexcept
{
    if (!valid_satellite_receiver(global_receiver))
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    std::lock_guard<std::mutex> lock(mutex_);
    ReceiverRequest& request = receivers_[global_receiver];
    if (!request.pending) return Result<void>::failure(Error::INVALID_ARGUMENT);
    request.committed = true;
    request.committed_15v = request.pending_15v;
    request.pending = false;
    return Result<void>::success();
}

Result<void> Q3U4LnbPowerCoordinator::rollback_tune(
    std::uint8_t global_receiver) noexcept
{
    if (!valid_satellite_receiver(global_receiver))
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    std::lock_guard<std::mutex> lock(mutex_);
    ReceiverRequest& request = receivers_[global_receiver];
    if (!request.pending) return Result<void>::failure(Error::INVALID_ARGUMENT);
    request.pending = false;
    return apply_bridge_locked(bridge_index_for_receiver(global_receiver));
}

Result<void> Q3U4LnbPowerCoordinator::release_receiver(
    std::uint8_t global_receiver) noexcept
{
    if (!valid_satellite_receiver(global_receiver))
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    std::lock_guard<std::mutex> lock(mutex_);
    receivers_[global_receiver] = ReceiverRequest{};
    return apply_bridge_locked(bridge_index_for_receiver(global_receiver));
}

Result<void> Q3U4LnbPowerCoordinator::reconcile() noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    return apply_both_locked();
}

Result<void> Q3U4LnbPowerCoordinator::shutdown() noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    receivers_.fill(ReceiverRequest{});
    // Both bridges are always attempted. In particular a terminally lost
    // bridge must not prevent GPIO 11 low on its still-connected sibling.
    return apply_both_locked();
}

Result<void> Q3U4LnbPowerCoordinator::disconnect(Q3U4Bridge bridge) noexcept
{
    if (static_cast<std::uint8_t>(bridge) > 1U)
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    std::lock_guard<std::mutex> lock(mutex_);
    const std::size_t index = bridge_index(bridge);
    physical_state_[index] = Q3U4LnbPhysicalState::disconnected;
    cleanup_debt_[index] = false;
    const std::size_t first = index == 0U ? 0U : 4U;
    receivers_[first] = ReceiverRequest{};
    receivers_[first + 1U] = ReceiverRequest{};
    return Result<void>::success();
}

Q3U4LnbPowerSnapshot Q3U4LnbPowerCoordinator::snapshot() const noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    return Q3U4LnbPowerSnapshot{
        {ref_count_locked(0U), ref_count_locked(1U)}, physical_state_,
        cleanup_debt_};
}

}  // namespace px4::userland
