// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_Q3U4_LNB_POWER_H
#define PX4_USERLAND_Q3U4_LNB_POWER_H

#include "px4/error.h"
#include "px4/it930x.h"
#include "q3u4_power.h"

#include <array>
#include <cstdint>
#include <mutex>

namespace px4::userland {

// Deliberately narrower than register/GPIO access. Implementations may only
// request the bridge's Q3U4 LNB supply state.
class Q3U4LnbPower {
public:
    virtual ~Q3U4LnbPower() noexcept = default;
    virtual Result<void> set_lnb_power(bool on) noexcept = 0;
};

class It930xLnbPower final : public Q3U4LnbPower {
public:
    explicit It930xLnbPower(It930xController& controller) noexcept
        : controller_(controller)
    {
    }

    Result<void> set_lnb_power(bool on) noexcept override;

private:
    It930xController& controller_;
};

enum class Q3U4LnbPhysicalState : std::uint8_t {
    unknown = 0,
    off = 1,
    on = 2,
    disconnected = 3,
};

struct Q3U4LnbPowerSnapshot final {
    std::array<std::uint8_t, 2U> ref_count{{0U, 0U}};
    std::array<Q3U4LnbPhysicalState, 2U> physical_state{
        Q3U4LnbPhysicalState::off, Q3U4LnbPhysicalState::off};
    std::array<bool, 2U> cleanup_debt{{false, false}};
};

// Transactional bridge-local LNB authority. A tune first installs a pending
// effective request, then either commits it as the receiver's last successful
// request or rolls back to that previous request. GPIO operations are finite
// and serialized under this one mutex.
class Q3U4LnbPowerCoordinator final {
public:
    // Construct only after initialize_q3u4() has verified GPIO 11 low on both
    // bridges; that verified boundary is the initial known-off state below.
    Q3U4LnbPowerCoordinator(Q3U4LnbPower& dev1, Q3U4LnbPower& dev2,
                            bool allow_15v) noexcept;
    ~Q3U4LnbPowerCoordinator() noexcept = default;

    Q3U4LnbPowerCoordinator(const Q3U4LnbPowerCoordinator&) = delete;
    Q3U4LnbPowerCoordinator& operator=(const Q3U4LnbPowerCoordinator&) = delete;

    Result<void> begin_tune(std::uint8_t global_receiver,
                            std::uint8_t voltage) noexcept;
    Result<void> commit_tune(std::uint8_t global_receiver) noexcept;
    Result<void> rollback_tune(std::uint8_t global_receiver) noexcept;
    Result<void> release_receiver(std::uint8_t global_receiver) noexcept;
    Result<void> reconcile() noexcept;
    Result<void> shutdown() noexcept;
    Result<void> disconnect(Q3U4Bridge bridge) noexcept;
    Q3U4LnbPowerSnapshot snapshot() const noexcept;

private:
    struct ReceiverRequest final {
        bool committed = false;
        bool committed_15v = false;
        bool pending = false;
        bool pending_15v = false;
    };

    static bool valid_satellite_receiver(std::uint8_t receiver) noexcept;
    static std::size_t bridge_index_for_receiver(std::uint8_t receiver) noexcept;
    static std::size_t bridge_index(Q3U4Bridge bridge) noexcept;
    std::uint8_t ref_count_locked(std::size_t bridge) const noexcept;
    Result<void> apply_bridge_locked(std::size_t bridge) noexcept;
    Result<void> apply_both_locked() noexcept;
    Q3U4LnbPower& backend(std::size_t bridge) const noexcept;

    Q3U4LnbPower& dev1_;
    Q3U4LnbPower& dev2_;
    bool allow_15v_;
    mutable std::mutex mutex_;
    std::array<ReceiverRequest, 8U> receivers_{};
    std::array<Q3U4LnbPhysicalState, 2U> physical_state_{
        Q3U4LnbPhysicalState::off, Q3U4LnbPhysicalState::off};
    std::array<bool, 2U> cleanup_debt_{{false, false}};
};

}  // namespace px4::userland

#endif  // PX4_USERLAND_Q3U4_LNB_POWER_H
