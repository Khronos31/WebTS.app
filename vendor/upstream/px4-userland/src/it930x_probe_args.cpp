// SPDX-License-Identifier: GPL-2.0-only
#include "it930x_probe_args.h"

#include <cstddef>

namespace px4::userland {

namespace {

It930xProbeArguments invalid_arguments(std::string_view error) noexcept
{
    It930xProbeArguments result;
    result.error = error;
    return result;
}

bool valid_base_serial(std::string_view base_serial) noexcept
{
    if (base_serial.size() != 14U) {
        return false;
    }
    for (const char character : base_serial) {
        if (character < '0' || character > '9') {
            return false;
        }
    }
    return true;
}

}  // namespace

It930xProbeArguments parse_it930x_probe_arguments(int argc,
                                                   const char* const* argv) noexcept
{
    if (argc < 1 || argv == nullptr) {
        return invalid_arguments("invalid argument vector");
    }
    It930xProbeArguments result;
    for (int index = 1; index < argc; ++index) {
        if (argv[index] == nullptr) {
            return invalid_arguments("null argument");
        }
        const std::string_view argument(argv[index]);
        if (argument == "--help") {
            if (argc != 2) {
                return invalid_arguments("--help cannot be combined with other arguments");
            }
            result.valid = true;
            result.help = true;
            return result;
        }
        if (argument == "--initialize") {
            if (result.initialize) {
                return invalid_arguments("duplicate --initialize");
            }
            result.initialize = true;
            continue;
        }
        if (argument == "--require-cold") {
            if (result.require_cold) {
                return invalid_arguments("duplicate --require-cold");
            }
            result.require_cold = true;
            continue;
        }
        if (argument == "--command-delay-ms") {
            if (result.pacing_specified ||
                index + 1 >= argc || argv[index + 1] == nullptr) {
                return invalid_arguments("--command-delay-ms requires exactly one value (0 or 1)");
            }
            const std::string_view value(argv[++index]);
            if (value == "0") {
                result.pacing_mode = CommandPacingMode::no_delay;
            } else if (value == "1") {
                result.pacing_mode = CommandPacingMode::linux_reference_1ms;
                // A separate sentinel is needed to distinguish an explicit 1 from the default.
                // The duplicate check below handles both values.
            } else {
                return invalid_arguments("--command-delay-ms must be 0 or 1");
            }
            result.pacing_specified = true;
            continue;
        }
        if (argument == "--base") {
            if (result.base_serial.size() != 0U || index + 1 >= argc ||
                argv[index + 1] == nullptr) {
                return invalid_arguments("--base requires exactly one base serial");
            }
            result.base_serial = argv[++index];
            continue;
        }
        if (argument == "--device") {
            if (result.device != 0U || index + 1 >= argc || argv[index + 1] == nullptr) {
                return invalid_arguments("--device requires exactly one value (1 or 2)");
            }
            const std::string_view value(argv[++index]);
            if (value == "1") {
                result.device = 1U;
            } else if (value == "2") {
                result.device = 2U;
            } else {
                return invalid_arguments("--device must be 1 or 2");
            }
            continue;
        }
        if (argument == "--firmware") {
            if (result.firmware_path.size() != 0U || index + 1 >= argc ||
                argv[index + 1] == nullptr) {
                return invalid_arguments("--firmware requires exactly one path");
            }
            result.firmware_path = argv[++index];
            continue;
        }
        return invalid_arguments("unknown argument");
    }

    if (result.base_serial.empty()) {
        return invalid_arguments("--base is required");
    }
    if (!valid_base_serial(result.base_serial)) {
        return invalid_arguments("--base must be a 14-digit base serial");
    }
    if (result.device == 0U) {
        return invalid_arguments("--device is required");
    }
    if (result.initialize != !result.firmware_path.empty()) {
        return invalid_arguments("--initialize and --firmware must be supplied together");
    }
    if (result.require_cold && !result.initialize) {
        return invalid_arguments("--require-cold requires --initialize");
    }
    result.valid = true;
    return result;
}

}  // namespace px4::userland
