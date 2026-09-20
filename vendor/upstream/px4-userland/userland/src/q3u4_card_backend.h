// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_Q3U4_CARD_BACKEND_H
#define PX4_USERLAND_Q3U4_CARD_BACKEND_H

#include "px4/card_service.h"
#include "q3u4_frontend.h"

namespace px4::userland {

// Private production adapter. CardService owns the protocol session; this
// class owns only the one logical card-power reference and device-1 UART seam.
class Q3U4CardBackend final : public CardServiceBackend {
public:
    Q3U4CardBackend(It930xController& controller,
                    Q3U4FrontendEnclosure& enclosure) noexcept
        : controller_(controller), enclosure_(enclosure)
    {
    }

    Result<void> set_power(bool on) noexcept override;
    Result<void> initialize_uart() noexcept override;
    Result<bool> detect_card() noexcept override;

private:
    It930xController& controller_;
    Q3U4FrontendEnclosure& enclosure_;
    bool card_power_acquired_ = false;
};

}  // namespace px4::userland

#endif  // PX4_USERLAND_Q3U4_CARD_BACKEND_H
