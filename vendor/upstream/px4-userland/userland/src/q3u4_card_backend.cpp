// SPDX-License-Identifier: GPL-2.0-only
#include "q3u4_card_backend.h"

namespace px4::userland {

Result<void> Q3U4CardBackend::set_power(bool on) noexcept
{
    if (on) {
        if (card_power_acquired_) return Result<void>::success();
        const auto acquired = enclosure_.acquire_card();
        if (acquired) card_power_acquired_ = true;
        return acquired;
    }
    if (!card_power_acquired_) {
        // CardService performs best-effort false cleanup after a failed true
        // operation. Reconcile known state without a write, retry unknown
        // state, and do not manufacture INVALID_ARGUMENT to mask the original
        // acquire failure.
        return enclosure_.reconcile_power();
    }
    // release_card removes the logical reference even when its OFF write fails,
    // so the adapter must forget the reference regardless of the result.
    card_power_acquired_ = false;
    return enclosure_.release_card();
}

Result<void> Q3U4CardBackend::initialize_uart() noexcept
{
    return controller_.initialize_card_uart();
}

Result<bool> Q3U4CardBackend::detect_card() noexcept
{
    return controller_.detect_card();
}

}  // namespace px4::userland
