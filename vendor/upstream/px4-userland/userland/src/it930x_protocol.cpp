// Modified/ported for px4-userland on 2026-09-02.
//
// Copyright (c) 2018-2021 nns779
// Derived from tsukumijima/px4_drv commit 9eedea8c502875a788697984b93b50032339b9aa.
// Origin path: driver/it930x.c.
// Source snapshot maintained by tsukumijima.
// SPDX-License-Identifier: GPL-2.0-only
#include "it930x_protocol.h"

#include <cstddef>
#include <cstdint>
#include <limits>

namespace px4::userland {

namespace {

constexpr std::size_t kScatterHeaderSize = 4U;
constexpr std::size_t kScatterSegmentSize = 3U;
constexpr std::size_t kMaxCommandPayload = 250U;

}  // namespace

Result<ScatterBlock> parse_scatter_block(ByteView image, std::size_t offset) noexcept
{
    if (offset > image.size || image.data == nullptr ||
        image.size - offset < kScatterHeaderSize) {
        return Result<ScatterBlock>::failure(Error::FIRMWARE_REJECTED);
    }
    const std::uint8_t* block = image.data + offset;
    if (block[0] != 0x03U) {
        return Result<ScatterBlock>::failure(Error::FIRMWARE_REJECTED);
    }

    const std::size_t segment_count = block[3];
    if (segment_count > (std::numeric_limits<std::size_t>::max() - kScatterHeaderSize) /
                            kScatterSegmentSize) {
        return Result<ScatterBlock>::failure(Error::FIRMWARE_REJECTED);
    }
    const std::size_t metadata_size = kScatterHeaderSize +
                                      (segment_count * kScatterSegmentSize);
    if (metadata_size > image.size - offset) {
        return Result<ScatterBlock>::failure(Error::FIRMWARE_REJECTED);
    }

    std::size_t data_size = 0U;
    for (std::size_t index = 0U; index < segment_count; ++index) {
        const std::size_t length_offset = kScatterHeaderSize +
                                          (index * kScatterSegmentSize) + 2U;
        const std::size_t length = block[length_offset];
        if (data_size > std::numeric_limits<std::size_t>::max() - length) {
            return Result<ScatterBlock>::failure(Error::FIRMWARE_REJECTED);
        }
        data_size += length;
    }
    if (data_size == 0U || metadata_size > std::numeric_limits<std::size_t>::max() - data_size) {
        return Result<ScatterBlock>::failure(Error::FIRMWARE_REJECTED);
    }
    const std::size_t block_size = metadata_size + data_size;
    if (block_size > kMaxCommandPayload || block_size > image.size - offset) {
        return Result<ScatterBlock>::failure(Error::FIRMWARE_REJECTED);
    }
    return Result<ScatterBlock>::success(ScatterBlock{offset, block_size});
}

Result<void> validate_scatter_image(ByteView image) noexcept
{
    if (image.data == nullptr || image.size == 0U) {
        return Result<void>::failure(Error::FIRMWARE_REJECTED);
    }
    std::size_t offset = 0U;
    while (offset < image.size) {
        const auto block = parse_scatter_block(image, offset);
        if (!block) {
            return Result<void>::failure(block.error());
        }
        if (block.value().size == 0U || block.value().size > image.size - offset) {
            return Result<void>::failure(Error::FIRMWARE_REJECTED);
        }
        offset += block.value().size;
    }
    return Result<void>::success();
}

}  // namespace px4::userland
