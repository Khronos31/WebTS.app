// SPDX-License-Identifier: GPL-2.0-only
#include "it930x_test_access.h"

#include "firmware_internal.h"

#include <vector>

namespace px4::userland {

bool FirmwareTestAccess::accepts_policy(
    std::size_t size, const std::array<std::uint8_t, 32U>& digest) noexcept
{
    return FirmwareImage::accepted_policy(size, digest);
}

std::array<std::uint8_t, 32U> FirmwareTestAccess::sha256(ByteView bytes) noexcept
{
    return sha256_digest(bytes);
}

FirmwareImage FirmwareTestAccess::make_image(ByteView bytes) noexcept
{
    std::vector<std::uint8_t> copy;
    if (bytes.size != 0U && bytes.data != nullptr) {
        copy.assign(bytes.data, bytes.data + bytes.size);
    }
    return FirmwareImage(std::move(copy));
}

Result<ScatterBlock> It930xTestAccess::parse_scatter_block(ByteView image,
                                                           std::size_t offset) noexcept
{
    return px4::userland::parse_scatter_block(image, offset);
}

Result<void> It930xTestAccess::validate_scatter_image(ByteView image) noexcept
{
    return px4::userland::validate_scatter_image(image);
}

}  // namespace px4::userland
