// SPDX-License-Identifier: GPL-2.0-only
#pragma once

#include "it930x_protocol.h"
#include "px4/firmware.h"
#include "px4/it930x.h"

#include <array>
#include <cstddef>
#include <cstdint>

namespace px4::userland {

class FirmwareTestAccess final {
public:
    static bool accepts_policy(std::size_t size,
                               const std::array<std::uint8_t, 32U>& digest) noexcept;
    static std::array<std::uint8_t, 32U> sha256(ByteView bytes) noexcept;
    static FirmwareImage make_image(ByteView bytes) noexcept;
};

class It930xTestAccess final {
public:
    static Result<ScatterBlock> parse_scatter_block(ByteView image,
                                                    std::size_t offset) noexcept;
    static Result<void> validate_scatter_image(ByteView image) noexcept;
};

}  // namespace px4::userland
