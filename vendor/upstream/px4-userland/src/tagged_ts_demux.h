// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_TAGGED_TS_DEMUX_H
#define PX4_USERLAND_TAGGED_TS_DEMUX_H

#include "px4/error.h"
#include "px4/transport.h"

#include <cstddef>
#include <cstdint>
#include <memory>

namespace px4::userland {

// Demultiplexes the 188-byte TS packets emitted by a Q3U4/PX4 aggregation
// stream. The packet view passed to PacketSink is valid only during the call.
class TaggedTsDemux final {
public:
    static constexpr std::size_t kPacketSize = 188U;
    static constexpr std::size_t kSyncPacketCount = 4U;
    // Four complete packets are needed to acquire sync. Retaining the first
    // 4*188-1 bytes is sufficient to preserve every possible future start.
    static constexpr std::size_t kPendingCapacity =
        kMaxStreamTransfer + (kSyncPacketCount * kPacketSize);

    using PacketSink = Result<void> (*)(void*, std::size_t receiver_index,
                                        ByteView packet) noexcept;
    using InvalidTagObserver = void (*)(void*, std::uint8_t wire_sync) noexcept;

    struct Counters final {
        std::size_t input_bytes_accepted;
        std::size_t emitted_packets;
        std::size_t discarded_sync_search_bytes;
        std::size_t invalid_tag_packets;
        std::size_t sync_loss_events;
        std::size_t buffered_bytes;
    };

    TaggedTsDemux() noexcept;
    ~TaggedTsDemux() noexcept = default;

    TaggedTsDemux(const TaggedTsDemux&) = delete;
    TaggedTsDemux& operator=(const TaggedTsDemux&) = delete;
    TaggedTsDemux(TaggedTsDemux&&) = delete;
    TaggedTsDemux& operator=(TaggedTsDemux&&) = delete;

    // The input is copied into bounded internal storage before any sink call.
    // Consequently, the caller may release or alter input when this method
    // returns. If the sink fails, its exact error is returned and the failed
    // packet, together with every later copied byte, remains buffered. A
    // subsequent push with an empty ByteView retries that packet. Emitted
    // counts advance only after a successful sink call. Non-empty input that
    // would exceed kPendingCapacity is rejected with SLOW_CONSUMER and is not
    // copied; this also protects a failed/backlogged stream from overflow.
    // PacketSink must be non-null, including for an empty retry push.  The
    // optional observer receives aligned wire packets with the high-bit TEI
    // marker before those packets are discarded; it never changes the sink
    // failure/retry contract.
    Result<void> push(ByteView input, PacketSink sink, void* context,
                      InvalidTagObserver observer = nullptr,
                      void* observer_context = nullptr) noexcept;

    // Discards parser state and all buffered bytes, and resets every counter.
    void reset() noexcept;

    Counters counters() const noexcept;

private:
    // A wire sync byte identifies packet alignment even when its high bit is
    // the receiver-local TEI marker.  Only the four ordinary tags are
    // emitted; TEI and unknown tags are consumed as whole packets.
    static bool is_packet_boundary(std::uint8_t value) noexcept;
    void compact_pending() noexcept;
    bool acquire_sync() noexcept;
    void discard_bytes(std::size_t count) noexcept;
    void consume_packet() noexcept;

    std::unique_ptr<std::uint8_t[]> pending_;
    std::size_t pending_offset_ = 0U;
    std::size_t pending_size_ = 0U;
    bool synchronized_ = false;
    std::size_t input_bytes_accepted_ = 0U;
    std::size_t emitted_packets_ = 0U;
    std::size_t discarded_sync_search_bytes_ = 0U;
    std::size_t invalid_tag_packets_ = 0U;
    std::size_t sync_loss_events_ = 0U;
};

}  // namespace px4::userland

#endif  // PX4_USERLAND_TAGGED_TS_DEMUX_H
