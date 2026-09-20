/*
 * Offline source-backed IT930x scatter-image fixture.  It calls the upstream
 * parse_scatter_block()/validate_scatter_image() functions directly and
 * returns only fixed diagnostics.  It is not a command encoder, CRC checker,
 * firmware loader, or USB transport.
 */
#include "it930x_protocol.h"

#include <array>
#include <cstdint>

namespace {

enum : std::uint32_t {
    kOk = 0U,
    kRejected = 1U,
    kInvalidArgument = 2U,
    kInternal = 255U,
};

using px4::userland::ByteView;
using px4::userland::Error;

std::uint32_t valid_single_block() noexcept
{
    constexpr std::array<std::uint8_t, 9> image{
        0x03U, 0x00U, 0x00U, 0x01U, 0x00U, 0x00U, 0x02U, 0xaaU, 0x55U,
    };
    const auto block = px4::userland::parse_scatter_block(
        ByteView{image.data(), image.size()}, 0U);
    if (!block || block.value().offset != 0U || block.value().size != image.size())
        return kInternal;
    const auto complete = px4::userland::validate_scatter_image(
        ByteView{image.data(), image.size()});
    return complete ? kOk : kInternal;
}

std::uint32_t valid_two_blocks() noexcept
{
    constexpr std::array<std::uint8_t, 16> image{
        0x03U, 0x00U, 0x00U, 0x01U, 0x00U, 0x00U, 0x01U, 0x42U,
        0x03U, 0x00U, 0x00U, 0x01U, 0x00U, 0x00U, 0x01U, 0x24U,
    };
    const auto complete = px4::userland::validate_scatter_image(
        ByteView{image.data(), image.size()});
    return complete ? kOk : kInternal;
}

std::uint32_t rejected_image(std::uint32_t scenario) noexcept
{
    std::array<std::uint8_t, 260> image{};
    std::size_t size = 0U;
    switch (scenario) {
    case 2: // invalid magic
        image[3] = 1U;
        image[6] = 1U;
        image[7] = 0x11U;
        size = 8U;
        break;
    case 3: // truncated segment metadata
        image[0] = 0x03U;
        image[3] = 1U;
        size = 6U;
        break;
    case 4: // zero segment payload
        image[0] = 0x03U;
        image[3] = 1U;
        size = 7U;
        break;
    case 5: // block exceeds upstream command payload bound
        image[0] = 0x03U;
        image[3] = 1U;
        image[6] = 250U;
        size = image.size();
        break;
    case 6: // null/empty input
        return px4::userland::validate_scatter_image(ByteView{nullptr, 0U})
                   ? kInternal
                   : kRejected;
    default:
        return kInvalidArgument;
    }
    const auto result = px4::userland::validate_scatter_image(ByteView{image.data(), size});
    return result ? kInternal : (result.error() == Error::FIRMWARE_REJECTED ? kRejected : kInternal);
}

}  // namespace

/* scenario 0/1=valid images, 2..6=length/metadata rejection cases. */
extern "C" std::uint32_t webts_px4_it930x_protocol_mock(std::uint32_t scenario) noexcept
{
    switch (scenario) {
    case 0: return valid_single_block();
    case 1: return valid_two_blocks();
    case 2:
    case 3:
    case 4:
    case 5:
    case 6: return rejected_image(scenario);
    default: return kInvalidArgument;
    }
}
