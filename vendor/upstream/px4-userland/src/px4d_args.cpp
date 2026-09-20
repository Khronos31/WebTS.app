// SPDX-License-Identifier: GPL-2.0-only
#include "px4d_args.h"

#include <charconv>
#include <cstdint>
#include <limits>

namespace px4::userland {
namespace {

Px4dArguments invalid(std::string_view message) noexcept
{
    Px4dArguments result;
    result.error = message;
    return result;
}

bool take_value(int& index, int argc, const char* const* argv,
                std::string_view& value) noexcept
{
    if (index + 1 >= argc || argv[index + 1] == nullptr) return false;
    value = std::string_view(argv[++index]);
    return !value.empty() && value.rfind("--", 0U) != 0U;
}

bool parse_fd(std::string_view value, int& output) noexcept
{
    if (value.empty()) return false;
    std::uint64_t parsed = 0U;
    const auto result =
        std::from_chars(value.data(), value.data() + value.size(), parsed, 10);
    if (result.ec != std::errc{} || result.ptr != value.data() + value.size() ||
        parsed > static_cast<std::uint64_t>(std::numeric_limits<int>::max())) {
        return false;
    }
    output = static_cast<int>(parsed);
    return true;
}

}  // namespace

bool valid_px4d_base_serial(std::string_view value) noexcept
{
    if (value.size() != 14U) return false;
    for (const char character : value) {
        if (character < '0' || character > '9') return false;
    }
    return true;
}

Px4dArguments parse_px4d_arguments(int argc,
                                   const char* const* argv) noexcept
{
    if (argc < 1 || argv == nullptr || argv[0] == nullptr) {
        return invalid("invalid argument vector");
    }

    Px4dArguments result;
    bool have_device = false;
    bool have_firmware = false;
    bool have_runtime = false;
    bool have_allow_lnb_power = false;
    for (int index = 1; index < argc; ++index) {
        if (argv[index] == nullptr) return invalid("null argument");
        const std::string_view option(argv[index]);
        if (option == "--help") {
            if (argc != 2) return invalid("--help cannot be combined");
            result.valid = true;
            result.help = true;
            return result;
        }
        if (option == "--group") {
            if (result.group) return invalid("duplicate --group");
            result.group = true;
            continue;
        }
        if (option == "--allow-lnb-power") {
            if (have_allow_lnb_power)
                return invalid("duplicate --allow-lnb-power");
            have_allow_lnb_power = true;
            result.allow_lnb_power = true;
            continue;
        }
        if (option != "--device" && option != "--firmware" &&
            option != "--runtime-dir" && option != "--fd") {
            return invalid("unknown argument");
        }

        std::string_view value;
        if (!take_value(index, argc, argv, value)) {
            return invalid("option requires a value");
        }
        if (option == "--device") {
            if (have_device) return invalid("duplicate --device");
            have_device = true;
            result.device = value;
        } else if (option == "--firmware") {
            if (have_firmware) return invalid("duplicate --firmware");
            have_firmware = true;
            result.firmware = value;
        } else if (option == "--runtime-dir") {
            if (have_runtime) return invalid("duplicate --runtime-dir");
            have_runtime = true;
            result.runtime_directory = value;
        } else {
            if (result.file_descriptor_count >= result.file_descriptors.size()) {
                return invalid("exactly two --fd values are supported");
            }
            int fd = -1;
            if (!parse_fd(value, fd)) return invalid("--fd is invalid");
            for (std::size_t fd_index = 0U;
                 fd_index < result.file_descriptor_count; ++fd_index) {
                if (result.file_descriptors[fd_index] == fd) {
                    return invalid("--fd values must be distinct");
                }
            }
            result.file_descriptors[result.file_descriptor_count++] = fd;
        }
    }

    if (result.file_descriptor_count != 0U &&
        result.file_descriptor_count != result.file_descriptors.size()) {
        return invalid("exactly two --fd values are required");
    }
    if (result.file_descriptor_count == 0U && !have_device) {
        return invalid("native mode requires --device");
    }
    if (have_device && !valid_px4d_base_serial(result.device)) {
        return invalid("--device requires a 14-digit base serial");
    }
    if (!have_firmware || result.firmware.empty()) {
        return invalid("--firmware is required");
    }
    if (have_runtime && result.runtime_directory.empty()) {
        return invalid("--runtime-dir must not be empty");
    }
    result.valid = true;
    return result;
}

Px4dOpenMode px4d_open_mode(const Px4dArguments& arguments) noexcept
{
    return arguments.file_descriptor_count == arguments.file_descriptors.size()
               ? Px4dOpenMode::file_descriptors
               : Px4dOpenMode::native;
}

}  // namespace px4::userland
