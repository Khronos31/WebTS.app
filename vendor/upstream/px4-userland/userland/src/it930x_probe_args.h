// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_IT930X_PROBE_ARGS_H
#define PX4_USERLAND_IT930X_PROBE_ARGS_H

#include "px4/it930x.h"

#include <cstdint>
#include <string>
#include <string_view>

namespace px4::userland {

struct It930xProbeArguments final {
    bool valid = false;
    bool help = false;
    bool initialize = false;
    bool require_cold = false;
    bool pacing_specified = false;
    std::uint8_t device = 0U;
    CommandPacingMode pacing_mode = CommandPacingMode::linux_reference_1ms;
    std::string base_serial;
    std::string firmware_path;
    std::string_view error;
};

It930xProbeArguments parse_it930x_probe_arguments(int argc,
                                                   const char* const* argv) noexcept;

}  // namespace px4::userland

#endif  // PX4_USERLAND_IT930X_PROBE_ARGS_H
