/*
 * USB-free fixture for the vendored PX4 TaggedTsDemux implementation.
 * The parser and buffering policy remain in upstream C++; this seam only
 * creates synthetic tagged packets and returns bounded aggregate counters.
 * No packet bytes, serials, USB handles, or real TS are exposed.
 */
#include "tagged_ts_demux.h"

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace {

using px4::userland::ByteView;
using px4::userland::Error;
using px4::userland::Result;
using px4::userland::TaggedTsDemux;

enum : std::uint32_t {
    kOk = 0U,
    kRejected = 1U,
    kInvalidArgument = 2U,
    kInternal = 255U,
    kWords = 12U,
};

struct SinkContext final {
    std::array<std::size_t, 4U> receiver_counts{};
    bool fail_once = false;
    bool retry_verified = false;
};

Result<void> count_packet(void* opaque, std::size_t receiver, ByteView packet) noexcept
{
    auto* context = static_cast<SinkContext*>(opaque);
    if (context == nullptr || receiver >= context->receiver_counts.size() ||
        packet.data == nullptr || packet.size != TaggedTsDemux::kPacketSize ||
        packet.data[0U] != 0x47U) {
        return Result<void>::failure(Error::INTERNAL);
    }
    if (context->fail_once) {
        context->fail_once = false;
        return Result<void>::failure(Error::SLOW_CONSUMER);
    }
    ++context->receiver_counts[receiver];
    return Result<void>::success();
}

void make_packet(std::uint8_t* destination, std::uint8_t wire_tag,
                 std::uint8_t marker) noexcept
{
    destination[0U] = wire_tag;
    for (std::size_t index = 1U; index < TaggedTsDemux::kPacketSize; ++index)
        destination[index] = static_cast<std::uint8_t>(marker + index);
}

template <std::size_t N>
void make_valid_packets(std::array<std::uint8_t, N>& bytes,
                        std::size_t first_packet = 0U) noexcept
{
    constexpr std::array<std::uint8_t, 4U> tags{0x17U, 0x27U, 0x37U, 0x47U};
    const std::size_t packet_count = bytes.size() / TaggedTsDemux::kPacketSize;
    for (std::size_t packet = first_packet; packet < packet_count; ++packet) {
        const auto tag = tags[packet % tags.size()];
        make_packet(bytes.data() + packet * TaggedTsDemux::kPacketSize,
                    tag, static_cast<std::uint8_t>(packet));
    }
}

std::uint32_t bounded(std::size_t value) noexcept
{
    return value > UINT32_MAX ? UINT32_MAX : static_cast<std::uint32_t>(value);
}

void write_counters(const TaggedTsDemux::Counters& counters,
                    const SinkContext& sink, std::uint32_t flags,
                    std::uint32_t* output) noexcept
{
    output[1U] = bounded(counters.input_bytes_accepted);
    output[2U] = bounded(counters.emitted_packets);
    output[3U] = bounded(counters.discarded_sync_search_bytes);
    output[4U] = bounded(counters.invalid_tag_packets);
    output[5U] = bounded(counters.sync_loss_events);
    output[6U] = bounded(counters.buffered_bytes);
    for (std::size_t receiver = 0U; receiver < sink.receiver_counts.size(); ++receiver)
        output[7U + receiver] = bounded(sink.receiver_counts[receiver]);
    output[11U] = flags;
}

std::uint32_t run_scenario(std::uint32_t scenario, std::uint32_t* output) noexcept
{
    SinkContext sink;
    TaggedTsDemux demux;
    std::uint32_t flags = 0U;
    bool expected_boundary = true;

    if (scenario == 0U) {
        std::array<std::uint8_t, 4U * TaggedTsDemux::kPacketSize> input{};
        make_valid_packets(input);
        if (!demux.push(ByteView{input.data(), input.size()}, count_packet, &sink))
            return kInternal;
        if (sink.receiver_counts != std::array<std::size_t, 4U>{1U, 1U, 1U, 1U})
            return kInternal;
        flags = 1U << 2U; // all four local receivers observed a packet.
    } else if (scenario == 1U) {
        std::array<std::uint8_t, 4U * TaggedTsDemux::kPacketSize> input{};
        make_valid_packets(input);
        constexpr std::size_t split = 197U;
        if (!demux.push(ByteView{input.data(), split}, count_packet, &sink) ||
            !demux.push(ByteView{input.data() + split, input.size() - split},
                        count_packet, &sink) ||
            sink.receiver_counts != std::array<std::size_t, 4U>{1U, 1U, 1U, 1U})
            return kInternal;
        flags = 1U << 2U;
    } else if (scenario == 2U) {
        std::array<std::uint8_t, 11U * TaggedTsDemux::kPacketSize> input{};
        make_valid_packets(input);
        make_packet(input.data() + 4U * TaggedTsDemux::kPacketSize, 0x57U, 0x51U);
        make_packet(input.data() + 5U * TaggedTsDemux::kPacketSize, 0x97U, 0x61U);
        std::memset(input.data() + 6U * TaggedTsDemux::kPacketSize, 0x00U,
                    TaggedTsDemux::kPacketSize);
        make_valid_packets(input, 7U);
        if (!demux.push(ByteView{input.data(), input.size()}, count_packet, &sink) ||
            demux.counters().invalid_tag_packets != 2U ||
            demux.counters().sync_loss_events != 1U ||
            demux.counters().emitted_packets != 8U)
            return kInternal;
        flags = (1U << 2U) | (1U << 4U) | (1U << 5U);
    } else if (scenario == 3U) {
        std::array<std::uint8_t, 4U * TaggedTsDemux::kPacketSize> input{};
        make_valid_packets(input);
        sink.fail_once = true;
        const auto failed = demux.push(ByteView{input.data(), input.size()}, count_packet, &sink);
        if (failed || demux.counters().emitted_packets != 0U ||
            demux.counters().buffered_bytes != input.size())
            return kInternal;
        const auto retry = demux.push(ByteView{nullptr, 0U}, count_packet, &sink);
        if (!retry || demux.counters().emitted_packets != 4U ||
            demux.counters().buffered_bytes != 0U)
            return kInternal;
        sink.retry_verified = true;
        flags = 1U << 0U;
    } else if (scenario == 4U) {
        std::array<std::uint8_t, 4U * TaggedTsDemux::kPacketSize> input{};
        make_valid_packets(input);
        if (!demux.push(ByteView{input.data(), input.size()}, count_packet, &sink) ||
            demux.counters().emitted_packets != 4U)
            return kInternal;
        demux.reset();
        const auto reset = demux.counters();
        if (reset.input_bytes_accepted != 0U || reset.emitted_packets != 0U ||
            reset.discarded_sync_search_bytes != 0U || reset.invalid_tag_packets != 0U ||
            reset.sync_loss_events != 0U || reset.buffered_bytes != 0U)
            return kInternal;
        flags = 1U << 1U;
    } else if (scenario == 5U) {
        std::uint8_t byte = 0U;
        const auto result = demux.push(ByteView{nullptr, 1U}, count_packet, &sink);
        const auto oversized = demux.push(
            ByteView{&byte, TaggedTsDemux::kPendingCapacity + 1U}, count_packet, &sink);
        expected_boundary = !result && result.error() == Error::INVALID_ARGUMENT &&
                            !oversized && oversized.error() == Error::INVALID_ARGUMENT;
        if (!expected_boundary)
            return kInternal;
        flags = 1U << 3U;
    } else {
        return kInvalidArgument;
    }

    write_counters(demux.counters(), sink, flags, output);
    return kOk;
}

}  // namespace

extern "C" std::uint32_t webts_px4_tagged_ts_demux_mock(
    std::uint32_t scenario, std::uint32_t output_ptr, std::uint32_t output_words) noexcept
{
    if (output_ptr == 0U || output_words < kWords)
        return kInvalidArgument;
    auto* output = reinterpret_cast<std::uint32_t*>(static_cast<std::uintptr_t>(output_ptr));
    for (std::uint32_t index = 0U; index < kWords; ++index)
        output[index] = 0U;
    const auto diagnostic = run_scenario(scenario, output);
    output[0U] = diagnostic;
    return diagnostic;
}
