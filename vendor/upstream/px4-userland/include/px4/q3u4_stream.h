// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_Q3U4_STREAM_H
#define PX4_USERLAND_Q3U4_STREAM_H

#include "px4/transport.h"
#include "px4/tuner_service.h"

#include <cstddef>
#include <cstdint>
#include <memory>

namespace px4::userland {

using StreamCounters = TunerStreamCounters;
using StreamTerminal = TunerStreamTerminal;
using StreamReadResult = TunerStreamReadResult;

// The data plane owns no sockets and never writes to a caller endpoint.  A
// bridge pump only waits for Transport events, demultiplexes tagged packets,
// and enqueues packets into the matching receiver ring.
class Q3U4StreamDataPlane final : public TunerStreamControl {
public:
    static constexpr std::size_t kPacketSize = 188U;
    static constexpr std::size_t kDefaultQueuePackets = 65536U;
    static constexpr std::size_t kMinQueuePackets = 4096U;
    static constexpr std::size_t kMaxQueuePackets = 262144U;
    static constexpr std::size_t kMaxReadBytes =
        (kMaxStreamTransfer / kPacketSize) * kPacketSize;

    static Result<std::unique_ptr<Q3U4StreamDataPlane>> create(
        Transport& dev1, Transport& dev2,
        std::size_t queue_packets = kDefaultQueuePackets) noexcept;
    ~Q3U4StreamDataPlane() noexcept override;

    Q3U4StreamDataPlane(const Q3U4StreamDataPlane&) = delete;
    Q3U4StreamDataPlane& operator=(const Q3U4StreamDataPlane&) = delete;

    Result<void> attach(const TunerAttachment& attachment) noexcept override;
    Result<void> detach(const TunerAttachment& attachment) noexcept override;
    Result<TunerStreamFinalSnapshot> final_snapshot(
        const TunerAttachment& attachment) const noexcept override;
    Result<void> release_final(const TunerAttachment& attachment) noexcept override;
    Result<TunerStreamReadResult> read(
        const TunerAttachment& attachment, MutableByteView output,
        Timeout timeout) noexcept override;
    Result<TunerStreamTerminal> terminal(
        const TunerAttachment& attachment) const noexcept override;
#if defined(PX4_Q3U4_STREAM_TEST_ACCESS)
    struct StartupStabilizationTestConfig final {
        std::size_t minimum_packets;
        std::size_t clean_packets;
        std::size_t maximum_packets;
    };
    // Test-only construction with compact deterministic stabilization
    // thresholds.  A zeroed policy disables the gate for legacy golden tests.
    static Result<std::unique_ptr<Q3U4StreamDataPlane>> create_for_test(
        Transport& dev1, Transport& dev2, std::size_t queue_packets,
        StartupStabilizationTestConfig stabilization) noexcept;
    using ReadWaitObserver = void (*)(void*, std::uint8_t) noexcept;
    // Test-only barrier at the condition-variable wait call.  It is absent
    // from production headers/binaries and must be installed before read().
    void set_read_wait_observer_for_test(ReadWaitObserver observer,
                                         void* context) noexcept;
    using PacketEnqueueObserver = void (*)(void*, std::uint8_t) noexcept;
    // Test-only barrier after a packet has been accounted and queued.  It is
    // absent from production headers/binaries.
    void set_packet_enqueue_observer_for_test(
        PacketEnqueueObserver observer, void* context) noexcept;
#endif
    Result<StreamCounters> stats(const TunerAttachment& attachment) const noexcept override;
    // Sync loss occurs before a receiver tag can be recovered.  The bridge
    // observation is therefore replicated once into each receiver that was
    // active at that instant; bridge_sync_errors exposes the non-replicated
    // aggregate as well.  This is attribution by observation, not a byte sum.
    Result<std::uint64_t> bridge_sync_errors(std::uint8_t bridge) const noexcept;
    Result<void> shutdown() noexcept;
    bool enclosure_fatal() const noexcept;

private:
    class Impl;
    explicit Q3U4StreamDataPlane(std::unique_ptr<Impl> impl) noexcept;
    std::unique_ptr<Impl> impl_;
};

}  // namespace px4::userland

#endif  // PX4_USERLAND_Q3U4_STREAM_H
