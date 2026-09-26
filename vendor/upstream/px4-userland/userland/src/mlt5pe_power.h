// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_MLT5PE_POWER_H
#define PX4_USERLAND_MLT5PE_POWER_H

#include "px4/error.h"
#include "q3u4_lnb_power.h"
#include "q3u4_power.h"

#include <array>
#include <cstdint>
#include <mutex>

namespace px4::userland {

inline constexpr std::uint8_t kMlt5PeReceiverCount = 5U;

struct Mlt5PePowerSnapshot final {
    std::uint8_t receiver_mask = 0U;
    bool card_acquired = false;
    Q3U4PowerState backend_state = Q3U4PowerState::off;
};

// Logical backend-power authority for the single IT930x of an MLT5-family
// board.  Any open receiver or the card keeps GPIO 7/2 backend power on; the
// last release turns it off.  The unknown/disconnected rules match
// Q3U4PowerCoordinator for one bridge.
class Mlt5PePowerCoordinator final {
public:
    Mlt5PePowerCoordinator(Q3U4BackendPower& power, Q3U4Delay& delay) noexcept
        : power_(power), delay_(delay)
    {
    }

    Mlt5PePowerCoordinator(const Mlt5PePowerCoordinator&) = delete;
    Mlt5PePowerCoordinator& operator=(const Mlt5PePowerCoordinator&) = delete;

    Result<void> acquire_receiver(std::uint8_t receiver) noexcept;
    Result<void> release_receiver(std::uint8_t receiver) noexcept;
    Result<void> acquire_card() noexcept;
    Result<void> release_card() noexcept;
    Result<void> reconcile() noexcept;
    // Transport loss is terminal; this performs no hardware operation.
    void disconnect() noexcept;
    Mlt5PePowerSnapshot snapshot() const noexcept;

private:
    Result<void> apply_locked() noexcept;

    Q3U4BackendPower& power_;
    Q3U4Delay& delay_;
    mutable std::mutex mutex_;
    Mlt5PePowerSnapshot state_{};
};

struct Mlt5PeLnbPowerSnapshot final {
    std::uint8_t ref_count = 0U;
    Q3U4LnbPhysicalState physical_state = Q3U4LnbPhysicalState::off;
    bool cleanup_debt = false;
};

// Transactional GPIO 11 authority for an MLT5-family board.  Every receiver
// can tune ISDB-S, so each keeps its last committed request; an ISDB-T tune
// commits a 0 V request and therefore drops that receiver's reference.
class Mlt5PeLnbPowerCoordinator final {
public:
    // Construct only after initialize_mlt5pe() has verified GPIO 11 low.
    Mlt5PeLnbPowerCoordinator(Q3U4LnbPower& power, bool allow_15v) noexcept
        : power_(power), allow_15v_(allow_15v)
    {
    }

    Mlt5PeLnbPowerCoordinator(const Mlt5PeLnbPowerCoordinator&) = delete;
    Mlt5PeLnbPowerCoordinator& operator=(const Mlt5PeLnbPowerCoordinator&) = delete;

    Result<void> begin_tune(std::uint8_t receiver, std::uint8_t voltage) noexcept;
    Result<void> commit_tune(std::uint8_t receiver) noexcept;
    Result<void> rollback_tune(std::uint8_t receiver) noexcept;
    Result<void> release_receiver(std::uint8_t receiver) noexcept;
    Result<void> shutdown() noexcept;
    void disconnect() noexcept;
    Mlt5PeLnbPowerSnapshot snapshot() const noexcept;

private:
    struct ReceiverRequest final {
        bool committed_15v = false;
        bool pending = false;
        bool pending_15v = false;
    };

    std::uint8_t ref_count_locked() const noexcept;
    Result<void> apply_locked() noexcept;

    Q3U4LnbPower& power_;
    bool allow_15v_;
    mutable std::mutex mutex_;
    std::array<ReceiverRequest, kMlt5PeReceiverCount> receivers_{};
    Q3U4LnbPhysicalState physical_state_ = Q3U4LnbPhysicalState::off;
    bool cleanup_debt_ = false;
};

}  // namespace px4::userland

#endif  // PX4_USERLAND_MLT5PE_POWER_H
