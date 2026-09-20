// Modified/ported for px4-userland on 2026-09-02.
//
// Copyright (c) 2018-2021 nns779
// Derived from tsukumijima/px4_drv commit 9eedea8c502875a788697984b93b50032339b9aa.
// Origin path: driver/it930x.c.
// Source snapshot maintained by tsukumijima.
// SPDX-License-Identifier: GPL-2.0-only
#pragma once

#include "px4/error.h"
#include "px4/transport.h"

#include <cstddef>

namespace px4::userland {

struct ScatterBlock final {
    std::size_t offset;
    std::size_t size;
};

Result<ScatterBlock> parse_scatter_block(ByteView image, std::size_t offset) noexcept;
Result<void> validate_scatter_image(ByteView image) noexcept;

}  // namespace px4::userland
