// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_PX4D_ARGS_H
#define PX4_USERLAND_PX4D_ARGS_H

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>

namespace px4::userland {

enum class Px4dOpenMode : std::uint8_t {
    native,
    file_descriptors,
};

struct Px4dArguments final {
    bool valid = false;
    bool help = false;
    bool group = false;
    bool allow_lnb_power = false;
    std::string device;
    std::string firmware;
    std::string runtime_directory;
    std::array<int, 2U> file_descriptors{{-1, -1}};
    std::size_t file_descriptor_count = 0U;
    std::string_view error;
};

Px4dArguments parse_px4d_arguments(int argc,
                                   const char* const* argv) noexcept;
Px4dOpenMode px4d_open_mode(const Px4dArguments& arguments) noexcept;
bool valid_px4d_base_serial(std::string_view value) noexcept;

}  // namespace px4::userland

#endif  // PX4_USERLAND_PX4D_ARGS_H
