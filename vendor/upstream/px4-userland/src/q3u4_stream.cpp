// SPDX-License-Identifier: GPL-2.0-only
#include "px4/q3u4_stream.h"

#include "tagged_ts_demux.h"

#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <limits>
#include <memory>
#include <mutex>
#include <new>
#include <thread>

namespace px4::userland {

namespace {

constexpr std::size_t kBridgeCount = 2U;
constexpr std::size_t kReceiversPerBridge = 4U;
constexpr std::size_t kPidCount = 8192U;

// The demodulator can assert lock before its TS output and the IT930x packet
// sync buffer have reached a clean epoch.  Hardware A/B testing with the
// reference kernel driver observed the last startup continuity disturbance at
// packet 10793.  Hold an entire receiver stream private until it has crossed a
// larger observation window and has also supplied a clean tail after the last
// attributable fault.  Once promoted, this gate is permanently disabled for
// the attachment epoch: every later TEI, continuity gap, and sync loss remains
// visible through the normal counters.
struct StartupStabilizationPolicy final {
    std::size_t minimum_packets = 16384U;
    std::size_t clean_packets = 4096U;
    std::size_t maximum_packets = 131072U;

    bool enabled() const noexcept
    {
        return minimum_packets != 0U || clean_packets != 0U ||
               maximum_packets != 0U;
    }
};

enum class ContinuityObservation : std::uint8_t {
    boundary,
    clean,
    fault,
};

struct Continuity final {
    bool seen = false;
    bool established = false;
    std::uint8_t counter = 0U;
};

// Runtime event handling is single-owner.  A pump either handles events for
// this short interval or waits on its callback condition while a command or
// the other bridge owns the event loop, keeping stop latency bounded.
constexpr std::uint32_t kPumpWaitMs = 1U;

bool same_attachment(const TunerAttachment& left,
                     const TunerAttachment& right) noexcept
{
    return left.owner_client_id == right.owner_client_id &&
           left.lease_id == right.lease_id &&
           left.attachment_id == right.attachment_id &&
           left.receiver == right.receiver && left.system == right.system &&
           left.nonce == right.nonce;
}

StreamTerminal terminal_for_error(Error error) noexcept
{
    return error == Error::DISCONNECTED ? StreamTerminal::disconnected
                                        : StreamTerminal::usb_error;
}

}  // namespace

class Q3U4StreamDataPlane::Impl final {
public:
    struct Session final {
        mutable std::mutex mutex;
        std::condition_variable changed;
        std::unique_ptr<std::uint8_t[]> packets;
        std::size_t capacity = 0U;
        std::size_t head = 0U;
        std::size_t count = 0U;
        bool attached = false;
        bool draining = false;
        TunerAttachment identity{};
        bool final_snapshot_valid = false;
        TunerAttachment final_identity{};
        TunerStreamFinalSnapshot final_snapshot{};
        StreamTerminal terminal = StreamTerminal::none;
        StreamCounters counters{};
        std::array<Continuity, kPidCount> continuity{};
        bool stabilizing = true;
        bool stabilization_ready = false;
        bool stabilization_boundary_established = false;
        bool startup_continuity_established = false;
        std::size_t startup_packets = 0U;
        std::size_t startup_clean_packets = 0U;
        StreamCounters startup_faults{};
    };

    struct Bridge final {
        enum class State : std::uint8_t { stopped, starting, running, stopping, fatal };

        Impl& owner;
        Transport& transport;
        std::size_t receiver_base;
        std::mutex lifecycle;
        std::unique_ptr<std::thread> thread;
        bool stop_requested = false;
        State state = State::stopped;
        bool cleanup_done = false;
        std::size_t attached_count = 0U;
        TaggedTsDemux demux;
        TaggedTsDemux::Counters demux_counters{};
        std::condition_variable state_changed;

        Bridge(Impl& owner_value, Transport& transport_value,
               std::size_t receiver_base_value) noexcept
            : owner(owner_value), transport(transport_value),
              receiver_base(receiver_base_value)
        {
        }

        bool stopping() noexcept
        {
            std::lock_guard<std::mutex> lock(lifecycle);
            return stop_requested || state == State::stopping ||
                   state == State::stopped || state == State::fatal;
        }

        void run() noexcept
        {
            while (!stopping()) {
                const auto event = transport.wait_stream(Timeout{kPumpWaitMs});
                if (!event) {
                    if (event.error() == Error::TIMEOUT) {
                        owner.count_empty(receiver_base);
                        continue;
                    }
                    owner.mark_bridge_terminal(*this, terminal_for_error(event.error()));
                    owner.finish_pump(*this);
                    break;
                }
                if (event.value().size == 0U) {
                    owner.count_empty(receiver_base);
                    continue;
                }
                // short_transfer has no dedicated counter in the wire/API
                // contract.  Its bytes are therefore processed as data;
                // only an actually empty event increments empty_intervals.
                const bool published_before =
                    owner.bridge_has_published_packets(receiver_base);
                const auto pushed = demux.push(
                    ByteView{event.value().data, event.value().size},
                    &Impl::packet_sink, this, &Impl::wire_tag_observer, this);
                const auto current = demux.counters();
                owner.count_sync_deltas(receiver_base, demux_counters, current,
                                        published_before);
                demux_counters = current;
                if (!pushed) {
                    owner.mark_bridge_terminal(*this, pushed.error() == Error::SLOW_CONSUMER
                                                    ? StreamTerminal::sync_error
                                                    : StreamTerminal::bridge_fatal);
                    owner.finish_pump(*this);
                    break;
                }
            }
        }
    };

    Impl(Transport& dev1, Transport& dev2, std::size_t queue_packets,
         StartupStabilizationPolicy stabilization) noexcept
        : queue_packets_(queue_packets), stabilization_(stabilization),
          bridges_{Bridge(*this, dev1, 0U), Bridge(*this, dev2, 4U)}
    {
    }

    ~Impl() noexcept
    {
        (void)shutdown();
    }

    static Result<std::unique_ptr<Impl>> create(Transport& dev1, Transport& dev2,
                                                 std::size_t queue_packets,
                                                 StartupStabilizationPolicy stabilization) noexcept
    {
        if (queue_packets < Q3U4StreamDataPlane::kMinQueuePackets ||
            queue_packets > Q3U4StreamDataPlane::kMaxQueuePackets ||
            queue_packets > std::numeric_limits<std::size_t>::max() / kPacketSize)
            return Result<std::unique_ptr<Impl>>::failure(Error::INVALID_ARGUMENT);
        if (stabilization.enabled() &&
            (stabilization.minimum_packets == 0U ||
             stabilization.clean_packets == 0U ||
             stabilization.maximum_packets < stabilization.minimum_packets ||
             stabilization.maximum_packets < stabilization.clean_packets))
            return Result<std::unique_ptr<Impl>>::failure(Error::INVALID_ARGUMENT);
        std::unique_ptr<Impl> value(
            new (std::nothrow) Impl(dev1, dev2, queue_packets, stabilization));
        if (!value) return Result<std::unique_ptr<Impl>>::failure(Error::INTERNAL);
        return Result<std::unique_ptr<Impl>>::success(std::move(value));
    }

    static Result<void> packet_sink(void* context, std::size_t local_receiver,
                                    ByteView packet) noexcept
    {
        auto* bridge = static_cast<Bridge*>(context);
        if (local_receiver >= kReceiversPerBridge || packet.size != kPacketSize)
            return Result<void>::failure(Error::INVALID_ARGUMENT);
        return bridge->owner.enqueue(bridge->receiver_base + local_receiver, packet);
    }

    static void wire_tag_observer(void* context, std::uint8_t wire_sync) noexcept
    {
        auto* bridge = static_cast<Bridge*>(context);
        if ((wire_sync & 0x80U) == 0U) return;
        const std::size_t wire_tag = (wire_sync >> 4U) & 0x07U;
        if (wire_tag == 0U || wire_tag > kReceiversPerBridge) return;
        bridge->owner.count_wire_tei(bridge->receiver_base + wire_tag - 1U);
    }

    static bool valid_receiver(std::size_t receiver) noexcept
    {
        return receiver < ipc::kReceiverCount;
    }

    static std::size_t bridge_index(std::size_t receiver) noexcept
    {
        return receiver < 4U ? 0U : 1U;
    }

    // Lock order: bridge.lifecycle -> session.mutex.  Reader methods acquire
    // only session.mutex.  No code takes lifecycle while holding a session
    // mutex, which keeps pump terminalization and cleanup free of inversion.
    Result<void> start_bridge_locked(Bridge& bridge) noexcept
    {
        if (bridge.state != Bridge::State::stopped)
            return Result<void>::failure(Error::BUSY);
        bridge.state = Bridge::State::starting;
        bridge.cleanup_done = false;
        const auto started = bridge.transport.start_stream(
            StreamConfig{kTsInEndpoint, 188U * 816U, 6U});
        if (!started) {
            bridge.state = Bridge::State::stopped;
            bridge.state_changed.notify_all();
            return started;
        }
        bridge.demux.reset();
        bridge.demux_counters = bridge.demux.counters();
        bridge.stop_requested = false;
        // This repository builds with exceptions disabled.  The standard
        // thread constructor follows that existing policy: allocation is
        // nothrow, while an OS thread-start failure is process-fatal under
        // the C++ standard library rather than recoverable as a Result.
        bridge.thread.reset(new (std::nothrow) std::thread([&bridge]() noexcept {
            bridge.run();
        }));
        if (!bridge.thread) {
            bridge.state = Bridge::State::stopping;
            bridge.stop_requested = true;
            // There is no worker to join, but transport still needs the same
            // finite cancel/drain cleanup as a normal last detach.
            const auto cancelled = bridge.transport.cancel_stream();
            const auto stopped = bridge.transport.stop_stream();
            bridge.state = (!cancelled || !stopped) ? Bridge::State::fatal
                                                    : Bridge::State::stopped;
            bridge.cleanup_done = true;
            bridge.state_changed.notify_all();
            if (!cancelled || !stopped) {
                enclosure_fatal_.store(true);
                mark_all_terminal(StreamTerminal::bridge_fatal);
            }
            if (!cancelled) return cancelled;
            if (!stopped) return stopped;
            return Result<void>::failure(Error::INTERNAL);
        }
        bridge.state = Bridge::State::running;
        bridge.state_changed.notify_all();
        return Result<void>::success();
    }

    Result<void> stop_bridge(Bridge& bridge, bool owns_stopping = false) noexcept
    {
        std::unique_ptr<std::thread> thread;
        bool cleanup_needed = false;
        std::unique_lock<std::mutex> lifecycle(bridge.lifecycle);
        if (!owns_stopping) {
            while (bridge.state == Bridge::State::starting ||
                   bridge.state == Bridge::State::stopping)
                bridge.state_changed.wait(lifecycle);
        }
        const bool join_needed = bridge.thread != nullptr;
        cleanup_needed = !bridge.cleanup_done &&
                         (bridge.state == Bridge::State::running ||
                          (owns_stopping && bridge.state == Bridge::State::stopping));
        if (!join_needed && !cleanup_needed) return Result<void>::success();
        // Claim the join object while holding the lifecycle lock.  A second
        // cleanup caller waits for this epoch and then observes cleanup_done;
        // it must never inspect or reset the same std::thread concurrently.
        thread = std::move(bridge.thread);
        bridge.stop_requested = true;
        if (cleanup_needed) bridge.state = Bridge::State::stopping;
        lifecycle.unlock();

        Error first = Error::OK;
        if (cleanup_needed) {
            const auto cancelled = bridge.transport.cancel_stream();
            if (!cancelled) first = cancelled.error();
        }
        if (thread != nullptr && thread->joinable()) {
            thread->join();
        }
        if (cleanup_needed) {
            const auto stopped = bridge.transport.stop_stream();
            if (!stopped && first == Error::OK) first = stopped.error();
        }

        lifecycle.lock();
        bridge.cleanup_done = true;
        bridge.state = first == Error::OK ? Bridge::State::stopped : Bridge::State::fatal;
        bridge.state_changed.notify_all();
        lifecycle.unlock();
        if (first != Error::OK) {
            enclosure_fatal_.store(true);
            mark_all_terminal(StreamTerminal::bridge_fatal);
            return Result<void>::failure(first);
        }
        return Result<void>::success();
    }

    void finish_pump(Bridge& bridge) noexcept
    {
        std::unique_lock<std::mutex> lifecycle(bridge.lifecycle);
        if (bridge.state != Bridge::State::running || bridge.cleanup_done)
            return;
        bridge.state = Bridge::State::stopping;
        bridge.stop_requested = true;
        lifecycle.unlock();

        Error first = Error::OK;
        const auto cancelled = bridge.transport.cancel_stream();
        if (!cancelled) first = cancelled.error();
        const auto stopped = bridge.transport.stop_stream();
        if (!stopped && first == Error::OK) first = stopped.error();

        lifecycle.lock();
        bridge.cleanup_done = true;
        // A bulk/demux failure ends this pump's epoch.  It is not an
        // enclosure-fatal condition unless finite cancel/stop cleanup fails.
        bridge.state = Bridge::State::fatal;
        // finish_pump runs on the pump thread itself.  Release the thread
        // object here so a later detach/shutdown cannot attempt to join
        // itself or destroy a still-joinable std::thread.  The finite
        // transport cleanup above is the only cleanup for this epoch.
        if (bridge.thread != nullptr && bridge.thread->joinable() &&
            bridge.thread->get_id() == std::this_thread::get_id()) {
            bridge.thread->detach();
            bridge.thread.reset();
        }
        bridge.state_changed.notify_all();
        lifecycle.unlock();
        if (first != Error::OK) {
            enclosure_fatal_.store(true);
            mark_all_terminal(StreamTerminal::bridge_fatal);
        }
    }

    Result<void> attach(const TunerAttachment& attachment) noexcept
    {
        if (attachment.owner_client_id == 0U || attachment.lease_id == 0U ||
            attachment.attachment_id == 0U || !valid_receiver(attachment.receiver))
            return Result<void>::failure(Error::INVALID_ARGUMENT);
        if ((attachment.receiver < 2U ||
             (attachment.receiver >= 4U && attachment.receiver < 6U)) &&
            attachment.system != ipc::System::ISDB_S)
            return Result<void>::failure(Error::INVALID_ARGUMENT);
        if ((attachment.receiver >= 2U && attachment.receiver < 4U) ||
            attachment.receiver >= 6U) {
            if (attachment.system != ipc::System::ISDB_T)
                return Result<void>::failure(Error::INVALID_ARGUMENT);
        }

        Bridge& bridge = bridges_[bridge_index(attachment.receiver)];
        std::unique_lock<std::mutex> lifecycle(bridge.lifecycle);
        while (bridge.state == Bridge::State::starting ||
               bridge.state == Bridge::State::stopping)
            bridge.state_changed.wait(lifecycle);
        if (shutting_down_.load() || enclosure_fatal_.load() ||
            bridge.state == Bridge::State::fatal)
            return Result<void>::failure(Error::DISCONNECTED);
        if (bridge.state == Bridge::State::stopped && bridge.attached_count != 0U)
            return Result<void>::failure(Error::INTERNAL);
        Session& session = sessions_[attachment.receiver];
        static_assert(Q3U4StreamDataPlane::kMaxQueuePackets <=
                      std::numeric_limits<std::size_t>::max() / kPacketSize);
        {
            std::lock_guard<std::mutex> lock(session.mutex);
            if (session.attached || session.draining)
                return Result<void>::failure(Error::BUSY);
            if (session.packets == nullptr) {
                if (queue_packets_ > std::numeric_limits<std::size_t>::max() /
                                    kPacketSize)
                    return Result<void>::failure(Error::INTERNAL);
                session.packets.reset(new (std::nothrow)
                                         std::uint8_t[queue_packets_ * kPacketSize]);
                if (!session.packets)
                    return Result<void>::failure(Error::INTERNAL);
                session.capacity = queue_packets_;
            }
            session.head = 0U;
            session.count = 0U;
            session.attached = true;
            session.draining = false;
            session.identity = attachment;
            session.final_snapshot_valid = false;
            session.final_identity = TunerAttachment{};
            session.final_snapshot = TunerStreamFinalSnapshot{};
            session.terminal = StreamTerminal::none;
            session.counters = StreamCounters{};
            session.continuity.fill(Continuity{});
            session.stabilizing = stabilization_.enabled();
            session.stabilization_ready = false;
            session.stabilization_boundary_established = false;
            session.startup_continuity_established = false;
            session.startup_packets = 0U;
            session.startup_clean_packets = 0U;
            session.startup_faults = StreamCounters{};
        }
        if (bridge.attached_count == 0U) {
            const auto started = start_bridge_locked(bridge);
            if (!started) {
                std::lock_guard<std::mutex> lock(session.mutex);
                session.attached = false;
                session.terminal = StreamTerminal::stopped;
                session.count = 0U;
                session.changed.notify_all();
                return started;
            }
        }
        ++bridge.attached_count;
        return Result<void>::success();
    }

    Result<void> detach(const TunerAttachment& attachment) noexcept
    {
        if (!valid_receiver(attachment.receiver))
            return Result<void>::failure(Error::NOT_FOUND);
        Bridge& bridge = bridges_[bridge_index(attachment.receiver)];
        std::unique_lock<std::mutex> lifecycle(bridge.lifecycle);
        while (bridge.state == Bridge::State::starting ||
               bridge.state == Bridge::State::stopping)
            bridge.state_changed.wait(lifecycle);
        Session& session = sessions_[attachment.receiver];
        TunerStreamFinalSnapshot snapshot{};
        {
            std::lock_guard<std::mutex> lock(session.mutex);
            if (!session.attached || !same_attachment(session.identity, attachment))
                return Result<void>::failure(Error::NOT_FOUND);
            const StreamTerminal final_terminal =
                session.terminal == StreamTerminal::none
                    ? StreamTerminal::stopped : session.terminal;
            snapshot.counters = session.counters;
            snapshot.terminal = static_cast<std::uint8_t>(final_terminal);
            session.final_identity = session.identity;
            session.final_snapshot = snapshot;
            session.final_snapshot_valid = true;
            session.attached = false;
            session.terminal = final_terminal;
            // Keep already queued packets readable by the data endpoint.  A
            // later release_final() or the final EOF read retires this
            // drain-only session before the receiver can be reopened.
            session.draining = session.count != 0U;
            session.changed.notify_all();
        }
        if (bridge.attached_count != 0U) --bridge.attached_count;
        if (bridge.attached_count == 0U) {
            const bool owns_stopping = bridge.state == Bridge::State::running;
            if (owns_stopping) {
                bridge.state = Bridge::State::stopping;
                bridge.stop_requested = true;
            }
            lifecycle.unlock();
            const auto stopped = stop_bridge(bridge, owns_stopping);
            if (!stopped) {
                // The logical session was already invalidated above.  Keep
                // its retained final snapshot honest when physical bridge
                // cleanup fails after that linearization point.
                std::lock_guard<std::mutex> lock(session.mutex);
                if (session.final_snapshot_valid &&
                    same_attachment(session.final_identity, attachment)) {
                    session.final_snapshot.terminal = static_cast<std::uint8_t>(
                        StreamTerminal::bridge_fatal);
                }
            } else {
                std::lock_guard<std::mutex> lock(bridge.lifecycle);
                if (bridge.state == Bridge::State::fatal &&
                    bridge.attached_count == 0U)
                    bridge.state = Bridge::State::stopped;
                bridge.state_changed.notify_all();
            }
            return stopped;
        }
        return Result<void>::success();
    }

    Result<StreamReadResult> read(const TunerAttachment& attachment,
                                  MutableByteView output, Timeout timeout) noexcept
    {
        if (!valid_receiver(attachment.receiver) ||
            (output.size != 0U && output.data == nullptr) ||
            output.size == 0U || (output.size % kPacketSize) != 0U ||
            output.size > kMaxReadBytes)
            return Result<StreamReadResult>::failure(Error::INVALID_ARGUMENT);
        Session& session = sessions_[attachment.receiver];
        std::unique_lock<std::mutex> lock(session.mutex);
        const bool identity_active = session.attached &&
                                     same_attachment(session.identity, attachment);
        const bool identity_draining = session.draining &&
                                       same_attachment(session.final_identity, attachment);
        if (!identity_active && !identity_draining)
            return Result<StreamReadResult>::failure(Error::NOT_FOUND);
        if (session.count == 0U && session.terminal == StreamTerminal::none &&
            timeout.milliseconds != 0U) {
#if defined(PX4_Q3U4_STREAM_TEST_ACCESS)
            if (read_wait_observer != nullptr)
                read_wait_observer(read_wait_observer_context, attachment.receiver);
#endif
            (void)session.changed.wait_for(
                lock, std::chrono::milliseconds(timeout.milliseconds), [&]() noexcept {
                    return session.count != 0U || session.terminal != StreamTerminal::none;
                });
        }
        if (session.count == 0U) {
            if (session.terminal != StreamTerminal::none)
            {
                const StreamTerminal terminal = session.terminal;
                session.draining = false;
                session.changed.notify_all();
                return Result<StreamReadResult>::success(
                    StreamReadResult{0U, true, false, terminal});
            }
            return Result<StreamReadResult>::success(
                StreamReadResult{0U, false, true, StreamTerminal::none});
        }
        std::size_t packets = output.size / kPacketSize;
        packets = packets > session.count ? session.count : packets;
        const std::size_t first = session.head;
        const std::size_t first_count =
            packets > session.capacity - first ? session.capacity - first : packets;
        if (first_count != 0U)
            std::memcpy(output.data, session.packets.get() + first * kPacketSize,
                        first_count * kPacketSize);
        if (packets > first_count)
            std::memcpy(output.data + first_count * kPacketSize, session.packets.get(),
                        (packets - first_count) * kPacketSize);
        session.head = (session.head + packets) % session.capacity;
        session.count -= packets;
        return Result<StreamReadResult>::success(
            StreamReadResult{packets * kPacketSize, false, false,
                             StreamTerminal::none});
    }

    Result<StreamCounters> stats(const TunerAttachment& attachment) const noexcept
    {
        if (!valid_receiver(attachment.receiver))
            return Result<StreamCounters>::failure(Error::NOT_FOUND);
        const Session& session = sessions_[attachment.receiver];
        std::lock_guard<std::mutex> lock(session.mutex);
        if (!session.attached || !same_attachment(session.identity, attachment))
            return Result<StreamCounters>::failure(Error::NOT_FOUND);
        return Result<StreamCounters>::success(session.counters);
    }

    Result<TunerStreamFinalSnapshot> final_snapshot(
        const TunerAttachment& attachment) const noexcept
    {
        if (!valid_receiver(attachment.receiver))
            return Result<TunerStreamFinalSnapshot>::failure(Error::NOT_FOUND);
        const Session& session = sessions_[attachment.receiver];
        std::lock_guard<std::mutex> lock(session.mutex);
        if (!session.final_snapshot_valid ||
            !same_attachment(session.final_identity, attachment))
            return Result<TunerStreamFinalSnapshot>::failure(Error::NOT_FOUND);
        return Result<TunerStreamFinalSnapshot>::success(session.final_snapshot);
    }

    Result<void> release_final(const TunerAttachment& attachment) noexcept
    {
        if (!valid_receiver(attachment.receiver))
            return Result<void>::failure(Error::NOT_FOUND);
        Session& session = sessions_[attachment.receiver];
        std::lock_guard<std::mutex> lock(session.mutex);
        if (!session.final_snapshot_valid ||
            !same_attachment(session.final_identity, attachment))
            return Result<void>::failure(Error::NOT_FOUND);
        session.draining = false;
        session.count = 0U;
        session.changed.notify_all();
        return Result<void>::success();
    }

#if defined(PX4_Q3U4_STREAM_TEST_ACCESS)
    void set_read_wait_observer(Q3U4StreamDataPlane::ReadWaitObserver observer,
                                void* context) noexcept
    {
        read_wait_observer = observer;
        read_wait_observer_context = context;
    }

    void set_packet_enqueue_observer(
        Q3U4StreamDataPlane::PacketEnqueueObserver observer,
        void* context) noexcept
    {
        packet_enqueue_observer = observer;
        packet_enqueue_observer_context = context;
    }
#endif

    Result<StreamTerminal> terminal(const TunerAttachment& attachment) const noexcept
    {
        if (!valid_receiver(attachment.receiver))
            return Result<StreamTerminal>::failure(Error::NOT_FOUND);
        const Session& session = sessions_[attachment.receiver];
        std::lock_guard<std::mutex> lock(session.mutex);
        if (!session.attached || !same_attachment(session.identity, attachment))
            return Result<StreamTerminal>::failure(Error::NOT_FOUND);
        return Result<StreamTerminal>::success(session.terminal);
    }

    void count_empty(std::size_t base) noexcept
    {
        for (std::size_t offset = 0U; offset < kReceiversPerBridge; ++offset) {
            Session& session = sessions_[base + offset];
            std::lock_guard<std::mutex> lock(session.mutex);
            if (session.attached && session.terminal == StreamTerminal::none)
                ++session.counters.empty_intervals;
        }
    }

    bool bridge_has_published_packets(std::size_t base) const noexcept
    {
        for (std::size_t offset = 0U; offset < kReceiversPerBridge; ++offset) {
            const Session& session = sessions_[base + offset];
            std::lock_guard<std::mutex> lock(session.mutex);
            if (session.attached && session.counters.packets != 0U) return true;
        }
        return false;
    }

    void count_sync_deltas(std::size_t base, TaggedTsDemux::Counters before,
                           TaggedTsDemux::Counters after,
                           bool published_before) noexcept
    {
        const std::size_t losses = after.sync_loss_events - before.sync_loss_events;
        if (losses != 0U) {
            bridge_sync_errors_[base < 4U ? 0U : 1U].fetch_add(losses);
            // A loss occurs before a valid local tag is available.  Mirror
            // each bridge-wide observation into the receivers active at the
            // observation point so their lease-level counters are useful;
            // this is intentionally replicated attribution, never a byte sum.
            for (std::size_t offset = 0U; offset < kReceiversPerBridge; ++offset) {
                Session& session = sessions_[base + offset];
                std::lock_guard<std::mutex> lock(session.mutex);
                if (!session.attached || session.terminal != StreamTerminal::none)
                    continue;
                if (session.stabilizing) {
                    session.startup_faults.sync_errors += losses;
                    session.startup_clean_packets = 0U;
                    session.stabilization_ready = false;
                } else if (session.stabilization_boundary_established ||
                           published_before) {
                    session.counters.sync_errors += losses;
                }
            }
        }
        // Promotion is deliberately deferred until the complete USB event has
        // been demultiplexed and its bridge-wide sync observations applied.
        // Otherwise an early clean run and a later resync in the same event
        // could publish a false clean boundary.
        promote_ready_sessions(base);
    }

    void count_wire_tei(std::size_t receiver) noexcept
    {
        Session& session = sessions_[receiver];
        std::lock_guard<std::mutex> lock(session.mutex);
        if (!session.attached || session.terminal != StreamTerminal::none) return;
        if (session.stabilizing) {
            ++session.startup_packets;
            ++session.startup_faults.tei_packets;
            session.startup_clean_packets = 0U;
            session.stabilization_ready = false;
            finish_startup_packet_locked(session);
        } else {
            ++session.counters.tei_packets;
        }
    }

    Result<void> enqueue(std::size_t receiver, ByteView packet) noexcept
    {
        Session& session = sessions_[receiver];
        {
            std::lock_guard<std::mutex> lock(session.mutex);
            if (!session.attached || session.terminal != StreamTerminal::none)
                return Result<void>::success();
            if (session.stabilizing) {
                ++session.startup_packets;
                if ((packet.data[1U] & 0x80U) != 0U) {
                    ++session.startup_faults.tei_packets;
                    session.startup_clean_packets = 0U;
                    session.stabilization_ready = false;
                    finish_startup_packet_locked(session);
                    return Result<void>::success();
                }
                const ContinuityObservation observation =
                    observe_continuity(session, packet);
                if (observation == ContinuityObservation::fault) {
                    ++session.startup_faults.continuity_errors;
                    session.startup_clean_packets = 0U;
                    session.stabilization_ready = false;
                } else {
                    ++session.startup_clean_packets;
                }
                finish_startup_packet_locked(session);
                return Result<void>::success();
            }
            if ((packet.data[1U] & 0x80U) != 0U)
                ++session.counters.tei_packets;
            const ContinuityObservation observation =
                observe_continuity(session, packet);
            if (observation == ContinuityObservation::boundary)
                return Result<void>::success();
            if (observation == ContinuityObservation::fault)
                ++session.counters.continuity_errors;
            ++session.counters.packets;
            session.counters.bytes += kPacketSize;
            if (session.count == session.capacity) {
                ++session.counters.queue_drops;
                session.terminal = StreamTerminal::slow_consumer;
                session.changed.notify_all();
                return Result<void>::success();
            }
            const std::size_t tail = (session.head + session.count) % session.capacity;
            std::memcpy(session.packets.get() + tail * kPacketSize, packet.data, kPacketSize);
            ++session.count;
            session.changed.notify_all();
        }
#if defined(PX4_Q3U4_STREAM_TEST_ACCESS)
        if (packet_enqueue_observer != nullptr)
            packet_enqueue_observer(packet_enqueue_observer_context,
                                    static_cast<std::uint8_t>(receiver));
#endif
        return Result<void>::success();
    }

    static ContinuityObservation observe_continuity(Session& session,
                                                     ByteView packet) noexcept
    {
        const std::size_t pid =
            (static_cast<std::size_t>(packet.data[1U] & 0x1fU) << 8U) | packet.data[2U];
        // ISO/IEC 13818-1 does not require continuity checking for the null
        // packet PID.  Real ISDB-T multiplexes commonly emit an arbitrary or
        // fixed CC there; treating it as a media-PID gap produces a false
        // terminal integrity failure for an otherwise clean capture.
        if (pid == 0x1fffU) return ContinuityObservation::clean;
        const std::uint8_t adaptation = static_cast<std::uint8_t>((packet.data[3U] >> 4U) & 3U);
        const std::uint8_t counter = static_cast<std::uint8_t>(packet.data[3U] & 0x0fU);
        if (adaptation == 0U || adaptation == 2U)
            return ContinuityObservation::clean;
        const bool has_adaptation = adaptation == 3U;
        bool discontinuity = false;
        if (has_adaptation) {
            const std::size_t length = packet.data[4U];
            if (length != 0U && length + 5U <= kPacketSize)
                discontinuity = (packet.data[5U] & 0x80U) != 0U;
        }
        Continuity& state = session.continuity[pid];
        if (discontinuity) {
            // The marker resets the previous expectation, and its own CC is
            // the baseline for the following payload packet.
            state.seen = true;
            state.established = true;
            state.counter = counter;
            session.startup_continuity_established = true;
            return ContinuityObservation::clean;
        }
        if (!state.seen) {
            // The IT930x PSB can expose one stale packet when a capture pin is
            // enabled, then switch to the live multiplex.  A session boundary
            // has no prior CC continuity contract, so require one consecutive
            // transition before publishing this PID.  This discards the
            // unverified boundary packet rather than hiding an error in the
            // delivered TS.  Once established, every gap remains observable.
            state.seen = true;
            state.counter = counter;
            return ContinuityObservation::boundary;
        }
        const std::uint8_t expected =
            static_cast<std::uint8_t>((state.counter + 1U) & 0x0fU);
        if (!state.established) {
            state.counter = counter;
            if (counter != expected) return ContinuityObservation::boundary;
            state.established = true;
            session.startup_continuity_established = true;
            return ContinuityObservation::clean;
        }
        const bool fault = counter != expected;
        state.counter = counter;
        return fault ? ContinuityObservation::fault : ContinuityObservation::clean;
    }

    void finish_startup_packet_locked(Session& session) noexcept
    {
        if (!session.stabilizing || session.terminal != StreamTerminal::none) return;
        session.stabilization_ready =
            session.startup_continuity_established &&
            session.startup_packets >= stabilization_.minimum_packets &&
            session.startup_clean_packets >= stabilization_.clean_packets;
        if (session.startup_packets < stabilization_.maximum_packets ||
            session.stabilization_ready)
            return;

        // Never wait forever on a persistently damaged startup epoch.  The
        // terminal snapshot reports the observed startup fault classes.  A
        // stream that never established continuity receives one sync error so
        // it cannot be mistaken for a clean empty capture.
        session.counters.sync_errors = session.startup_faults.sync_errors;
        session.counters.tei_packets = session.startup_faults.tei_packets;
        session.counters.continuity_errors =
            session.startup_faults.continuity_errors;
        if (session.counters.sync_errors == 0U &&
            session.counters.tei_packets == 0U &&
            session.counters.continuity_errors == 0U)
            session.counters.sync_errors = 1U;
        session.terminal = StreamTerminal::sync_error;
        session.changed.notify_all();
    }

    void promote_ready_sessions(std::size_t base) noexcept
    {
        for (std::size_t offset = 0U; offset < kReceiversPerBridge; ++offset) {
            Session& session = sessions_[base + offset];
            std::lock_guard<std::mutex> lock(session.mutex);
            if (!session.attached || session.terminal != StreamTerminal::none ||
                !session.stabilizing || !session.stabilization_ready)
                continue;
            session.stabilizing = false;
            session.stabilization_ready = false;
            session.stabilization_boundary_established = true;
            // No startup packet entered the public ring.  Reset PID state at
            // this exact publication boundary so the existing one-transition
            // session-boundary validation still applies.  From the next USB
            // event onward no integrity observation is suppressed.
            session.continuity.fill(Continuity{});
            session.changed.notify_all();
        }
    }

    void mark_bridge_terminal(Bridge& bridge, StreamTerminal reason) noexcept
    {
        for (std::size_t offset = 0U; offset < kReceiversPerBridge; ++offset) {
            Session& session = sessions_[bridge.receiver_base + offset];
            std::lock_guard<std::mutex> lock(session.mutex);
            if (session.attached && session.terminal == StreamTerminal::none) {
                if (reason == StreamTerminal::usb_error ||
                    reason == StreamTerminal::disconnected)
                    ++session.counters.usb_errors;
                session.terminal = reason;
                session.changed.notify_all();
            }
        }
    }

    void mark_all_terminal(StreamTerminal reason) noexcept
    {
        for (Session& session : sessions_) {
            std::lock_guard<std::mutex> lock(session.mutex);
            if (session.attached && session.terminal == StreamTerminal::none) {
                session.terminal = reason;
                session.changed.notify_all();
            }
        }
    }

    Result<void> shutdown() noexcept
    {
        shutting_down_.store(true);
        Error first = Error::OK;
        // Linearize the metadata transition with attach/detach.  The
        // lifecycle lock is deliberately held while taking each session lock
        // (the documented lifecycle -> session order); no new attach can
        // observe a detached session with an old attached_count.
        for (Bridge& bridge : bridges_) {
            bool owns_stopping = false;
            {
                std::unique_lock<std::mutex> lifecycle(bridge.lifecycle);
                while (bridge.state == Bridge::State::starting ||
                       bridge.state == Bridge::State::stopping)
                    bridge.state_changed.wait(lifecycle);
                for (std::size_t offset = 0U; offset < kReceiversPerBridge;
                     ++offset) {
                    Session& session = sessions_[bridge.receiver_base + offset];
                    std::lock_guard<std::mutex> session_lock(session.mutex);
                    if (session.attached) {
                        const StreamTerminal final_terminal =
                            session.terminal == StreamTerminal::none
                                ? StreamTerminal::stopped : session.terminal;
                        session.final_identity = session.identity;
                        session.final_snapshot.counters = session.counters;
                        session.final_snapshot.terminal = static_cast<std::uint8_t>(
                            final_terminal);
                        session.final_snapshot_valid = true;
                        session.attached = false;
                        session.terminal = final_terminal;
                        session.draining = false;
                        session.count = 0U;
                        session.changed.notify_all();
                    }
                }
                bridge.attached_count = 0U;
                if (bridge.state == Bridge::State::running) {
                    bridge.state = Bridge::State::stopping;
                    bridge.stop_requested = true;
                    owns_stopping = true;
                }
            }
            const auto stopped = stop_bridge(bridge, owns_stopping);
            if (!stopped) {
                if (first == Error::OK) first = stopped.error();
                // Sessions were logically detached before cleanup.  Preserve
                // their terminal reason unless physical epoch cleanup itself
                // failed, in which case STREAM_END must expose bridge_fatal.
                std::lock_guard<std::mutex> lifecycle(bridge.lifecycle);
                if (bridge.state == Bridge::State::fatal) {
                    for (std::size_t offset = 0U; offset < kReceiversPerBridge;
                         ++offset) {
                        Session& session = sessions_[bridge.receiver_base + offset];
                        std::lock_guard<std::mutex> session_lock(session.mutex);
                        if (session.final_snapshot_valid)
                            session.final_snapshot.terminal = static_cast<std::uint8_t>(
                                StreamTerminal::bridge_fatal);
                    }
                }
            } else {
                std::lock_guard<std::mutex> lifecycle(bridge.lifecycle);
                if (bridge.state == Bridge::State::fatal &&
                    bridge.attached_count == 0U)
                    bridge.state = Bridge::State::stopped;
                bridge.state_changed.notify_all();
            }
        }
        return first == Error::OK ? Result<void>::success()
                                  : Result<void>::failure(first);
    }

    std::size_t queue_packets_;
    StartupStabilizationPolicy stabilization_;
    std::array<Session, ipc::kReceiverCount> sessions_{};
    std::array<Bridge, kBridgeCount> bridges_;
    std::atomic<bool> enclosure_fatal_{false};
    std::atomic<bool> shutting_down_{false};
    std::atomic<std::uint64_t> bridge_sync_errors_[kBridgeCount]{};
#if defined(PX4_Q3U4_STREAM_TEST_ACCESS)
    Q3U4StreamDataPlane::ReadWaitObserver read_wait_observer = nullptr;
    void* read_wait_observer_context = nullptr;
    Q3U4StreamDataPlane::PacketEnqueueObserver packet_enqueue_observer = nullptr;
    void* packet_enqueue_observer_context = nullptr;
#endif
};

Q3U4StreamDataPlane::Q3U4StreamDataPlane(std::unique_ptr<Impl> impl) noexcept
    : impl_(std::move(impl))
{
}

Result<std::unique_ptr<Q3U4StreamDataPlane>> Q3U4StreamDataPlane::create(
    Transport& dev1, Transport& dev2, std::size_t queue_packets) noexcept
{
    auto impl = Impl::create(dev1, dev2, queue_packets,
                             StartupStabilizationPolicy{});
    if (!impl) return Result<std::unique_ptr<Q3U4StreamDataPlane>>::failure(impl.error());
    std::unique_ptr<Q3U4StreamDataPlane> value(
        new (std::nothrow) Q3U4StreamDataPlane(std::move(impl.value())));
    if (!value) return Result<std::unique_ptr<Q3U4StreamDataPlane>>::failure(Error::INTERNAL);
    return Result<std::unique_ptr<Q3U4StreamDataPlane>>::success(std::move(value));
}

#if defined(PX4_Q3U4_STREAM_TEST_ACCESS)
Result<std::unique_ptr<Q3U4StreamDataPlane>>
Q3U4StreamDataPlane::create_for_test(
    Transport& dev1, Transport& dev2, std::size_t queue_packets,
    StartupStabilizationTestConfig stabilization) noexcept
{
    const StartupStabilizationPolicy policy{
        stabilization.minimum_packets,
        stabilization.clean_packets,
        stabilization.maximum_packets,
    };
    auto impl = Impl::create(dev1, dev2, queue_packets, policy);
    if (!impl)
        return Result<std::unique_ptr<Q3U4StreamDataPlane>>::failure(impl.error());
    std::unique_ptr<Q3U4StreamDataPlane> value(
        new (std::nothrow) Q3U4StreamDataPlane(std::move(impl.value())));
    if (!value)
        return Result<std::unique_ptr<Q3U4StreamDataPlane>>::failure(Error::INTERNAL);
    return Result<std::unique_ptr<Q3U4StreamDataPlane>>::success(std::move(value));
}
#endif

Q3U4StreamDataPlane::~Q3U4StreamDataPlane() noexcept = default;

Result<void> Q3U4StreamDataPlane::attach(const TunerAttachment& attachment) noexcept
{
    return impl_ == nullptr ? Result<void>::failure(Error::INTERNAL)
                            : impl_->attach(attachment);
}

Result<void> Q3U4StreamDataPlane::detach(const TunerAttachment& attachment) noexcept
{
    return impl_ == nullptr ? Result<void>::failure(Error::INTERNAL)
                            : impl_->detach(attachment);
}

Result<TunerStreamFinalSnapshot> Q3U4StreamDataPlane::final_snapshot(
    const TunerAttachment& attachment) const noexcept
{
    return impl_ == nullptr
        ? Result<TunerStreamFinalSnapshot>::failure(Error::INTERNAL)
        : impl_->final_snapshot(attachment);
}

Result<void> Q3U4StreamDataPlane::release_final(
    const TunerAttachment& attachment) noexcept
{
    return impl_ == nullptr ? Result<void>::failure(Error::INTERNAL)
                            : impl_->release_final(attachment);
}

#if defined(PX4_Q3U4_STREAM_TEST_ACCESS)
void Q3U4StreamDataPlane::set_read_wait_observer_for_test(
    ReadWaitObserver observer, void* context) noexcept
{
    if (impl_ != nullptr) impl_->set_read_wait_observer(observer, context);
}

void Q3U4StreamDataPlane::set_packet_enqueue_observer_for_test(
    PacketEnqueueObserver observer, void* context) noexcept
{
    if (impl_ != nullptr) impl_->set_packet_enqueue_observer(observer, context);
}
#endif

Result<StreamReadResult> Q3U4StreamDataPlane::read(
    const TunerAttachment& attachment, MutableByteView output, Timeout timeout) noexcept
{
    return impl_ == nullptr
        ? Result<StreamReadResult>::failure(Error::INTERNAL)
        : impl_->read(attachment, output, timeout);
}

Result<StreamCounters> Q3U4StreamDataPlane::stats(
    const TunerAttachment& attachment) const noexcept
{
    return impl_ == nullptr ? Result<StreamCounters>::failure(Error::INTERNAL)
                            : impl_->stats(attachment);
}

Result<StreamTerminal> Q3U4StreamDataPlane::terminal(
    const TunerAttachment& attachment) const noexcept
{
    return impl_ == nullptr ? Result<StreamTerminal>::failure(Error::INTERNAL)
                            : impl_->terminal(attachment);
}

Result<std::uint64_t> Q3U4StreamDataPlane::bridge_sync_errors(
    std::uint8_t bridge) const noexcept
{
    if (bridge >= kBridgeCount)
        return Result<std::uint64_t>::failure(Error::INVALID_ARGUMENT);
    return Result<std::uint64_t>::success(
        impl_ == nullptr ? 0U : impl_->bridge_sync_errors_[bridge].load());
}

Result<void> Q3U4StreamDataPlane::shutdown() noexcept
{
    return impl_ == nullptr ? Result<void>::failure(Error::INTERNAL)
                            : impl_->shutdown();
}

bool Q3U4StreamDataPlane::enclosure_fatal() const noexcept
{
    return impl_ != nullptr && impl_->enclosure_fatal_.load();
}

}  // namespace px4::userland
