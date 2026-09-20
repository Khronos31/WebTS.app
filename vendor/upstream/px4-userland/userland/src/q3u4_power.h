// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_Q3U4_POWER_H
#define PX4_USERLAND_Q3U4_POWER_H

#include "px4/error.h"

#include <array>
#include <cstdint>
#include <mutex>

namespace px4::userland {

// Portable timing seam for the narrow Q3U4 backend power sequence.
class Q3U4Delay {
public:
    virtual ~Q3U4Delay() noexcept = default;
    virtual void sleep_ms(std::uint32_t milliseconds) noexcept = 0;
};

// Deliberately narrower than the controller API: a power coordinator may
// request only the shared backend state, never an arbitrary GPIO.
class Q3U4BackendPower {
public:
    virtual ~Q3U4BackendPower() noexcept = default;
    virtual Result<void> set_backend_power(bool on, Q3U4Delay& delay) noexcept = 0;
};

enum class Q3U4Bridge : std::uint8_t {
    dev1 = 0,
    dev2 = 1,
};

enum class Q3U4PowerState : std::uint8_t {
    unknown = 0,
    off = 1,
    on = 2,
    disconnected = 3,
};

struct Q3U4PowerSnapshot final {
    std::uint8_t receiver_mask = 0U;
    bool card_acquired = false;
    std::array<Q3U4PowerState, 2U> backend_state{
        Q3U4PowerState::off, Q3U4PowerState::off};
};

// Owns the logical power authority for a complete Q3U4 enclosure. Frontend
// receiver and device-1 card consumers acquire references through this one
// coordinator; no consumer may write backend power around it.
class Q3U4PowerCoordinator final {
public:
    Q3U4PowerCoordinator(Q3U4BackendPower& dev1, Q3U4BackendPower& dev2,
                         Q3U4Delay& delay) noexcept;
    ~Q3U4PowerCoordinator() noexcept = default;

    Q3U4PowerCoordinator(const Q3U4PowerCoordinator&) = delete;
    Q3U4PowerCoordinator& operator=(const Q3U4PowerCoordinator&) = delete;

    Result<void> acquire_receiver(std::uint8_t global_receiver_id) noexcept;
    Result<void> release_receiver(std::uint8_t global_receiver_id) noexcept;
    Result<void> acquire_card() noexcept;
    Result<void> release_card() noexcept;
    Result<void> reconcile() noexcept;

    // Transport loss is terminal for the selected bridge.  This path only
    // changes coordinator state; it never calls a backend.
    Result<void> disconnect(Q3U4Bridge bridge) noexcept;

    Q3U4PowerSnapshot snapshot() const noexcept;

private:
    Result<void> apply_desired_locked(Q3U4Bridge first_bridge = Q3U4Bridge::dev1) noexcept;
    Result<void> set_bridge_locked(Q3U4Bridge bridge, bool on) noexcept;
    void rollback_logical_locked(
        const Q3U4PowerSnapshot& prior,
        Q3U4Bridge first_bridge = Q3U4Bridge::dev1) noexcept;
    bool desired_power_locked(Q3U4Bridge bridge) const noexcept;
    bool enclosure_disconnected_locked() const noexcept;
    Q3U4BackendPower& backend(Q3U4Bridge bridge) const noexcept;
    static std::size_t bridge_index(Q3U4Bridge bridge) noexcept;

    Q3U4BackendPower& dev1_;
    Q3U4BackendPower& dev2_;
    Q3U4Delay& delay_;
    mutable std::mutex mutex_;
    Q3U4PowerSnapshot state_{};
};

}  // namespace px4::userland

#endif  // PX4_USERLAND_Q3U4_POWER_H
