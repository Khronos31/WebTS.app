// SPDX-License-Identifier: GPL-2.0-only
#pragma once

#include "px4/transport.h"

#include <array>
#include <cstdint>

namespace px4::userland {

std::array<std::uint8_t, 32U> sha256_digest(ByteView bytes) noexcept;

}  // namespace px4::userland
