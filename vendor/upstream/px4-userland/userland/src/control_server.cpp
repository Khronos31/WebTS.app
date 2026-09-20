// SPDX-License-Identifier: GPL-2.0-only
#include "px4/control_server.h"

#include "control_workers.h"
#if defined(PX4_CONTROL_SERVER_TEST_ACCESS)
#include "control_server_test_access.h"
#endif

#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <climits>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>
#include <memory>
#include <new>
#include <poll.h>
#include <string>
#include <sys/socket.h>
#include <utility>
#include <vector>

namespace px4::userland::ipc::posix {
namespace {

constexpr std::uint32_t kServerCapabilities =
    kCapabilityEvents | kCapabilityCard | kCapabilityStreamStats;
constexpr std::uint32_t kClientWriteTimeoutMs = 250U;
constexpr std::uint32_t kPresencePollIntervalMs = 250U;
constexpr std::size_t kMaxControlConnections = 32U;
constexpr std::size_t kRetiredClientCapacity = 64U;
constexpr std::size_t kMaxStreamConnections = 32U;
constexpr std::size_t kStreamReadBytes = (65536U / 188U) * 188U;
constexpr std::size_t kStreamWriteBudget = 65536U;

#if defined(PX4_CONTROL_SERVER_TEST_ACCESS)
ControlServerTestHooks* test_hooks = nullptr;

void report_stream_count(std::size_t live, std::size_t retired) noexcept
{
    if (test_hooks != nullptr && test_hooks->stream_count_changed != nullptr)
        test_hooks->stream_count_changed(test_hooks->context, live, retired);
}

void report_stream_partial(std::uint64_t connection_id) noexcept
{
    if (test_hooks != nullptr && test_hooks->stream_partial_frame != nullptr)
        test_hooks->stream_partial_frame(test_hooks->context, connection_id);
}

void report_stream_write_blocked(std::uint64_t connection_id) noexcept
{
    if (test_hooks != nullptr && test_hooks->stream_write_blocked != nullptr)
        test_hooks->stream_write_blocked(test_hooks->context, connection_id);
}
#endif

ErrorCode ipc_error(Error error) noexcept
{
    switch (error) {
    case Error::OK: return ErrorCode::OK;
    case Error::INVALID_ARGUMENT: return ErrorCode::INVALID_ARGUMENT;
    case Error::VERSION_MISMATCH: return ErrorCode::VERSION_MISMATCH;
    case Error::NOT_FOUND: return ErrorCode::NOT_FOUND;
    case Error::BUSY: return ErrorCode::BUSY;
    case Error::NOT_READY: return ErrorCode::NOT_READY;
    case Error::TIMEOUT: return ErrorCode::TIMEOUT;
    case Error::USB_IO: return ErrorCode::USB_IO;
    case Error::DISCONNECTED: return ErrorCode::DISCONNECTED;
    case Error::PROTOCOL_ERROR: return ErrorCode::PROTOCOL_ERROR;
    case Error::FIRMWARE_REJECTED: return ErrorCode::FIRMWARE_REJECTED;
    case Error::UNSUPPORTED: return ErrorCode::UNSUPPORTED;
    case Error::NO_CARD: return ErrorCode::NO_CARD;
    case Error::CARD_REMOVED: return ErrorCode::CARD_REMOVED;
    case Error::BUFFER_TOO_SMALL: return ErrorCode::BUFFER_TOO_SMALL;
    case Error::SLOW_CONSUMER: return ErrorCode::SLOW_CONSUMER;
    case Error::INTERNAL: return ErrorCode::INTERNAL;
    }
    return ErrorCode::INTERNAL;
}

std::array<ReceiverRecord, kReceiverCount> receiver_records() noexcept
{
    return std::array<ReceiverRecord, kReceiverCount>{
        ReceiverRecord{0U, 1U, 0U, System::ISDB_S},
        ReceiverRecord{1U, 1U, 1U, System::ISDB_S},
        ReceiverRecord{2U, 1U, 2U, System::ISDB_T},
        ReceiverRecord{3U, 1U, 3U, System::ISDB_T},
        ReceiverRecord{4U, 2U, 0U, System::ISDB_S},
        ReceiverRecord{5U, 2U, 1U, System::ISDB_S},
        ReceiverRecord{6U, 2U, 2U, System::ISDB_T},
        ReceiverRecord{7U, 2U, 3U, System::ISDB_T}};
}

int timeout_to_poll(Timeout timeout) noexcept
{
    return timeout.milliseconds > static_cast<std::uint32_t>(INT_MAX) ?
               INT_MAX : static_cast<int>(timeout.milliseconds);
}

CountersPayload counters_payload(const TunerStreamCounters& counters) noexcept
{
    return CountersPayload{counters.packets, counters.bytes, counters.sync_errors,
                           counters.tei_packets, counters.continuity_errors,
                           counters.queue_drops, counters.usb_errors,
                           counters.empty_intervals};
}

ErrorCode stream_end_error(TunerStreamTerminal terminal) noexcept
{
    switch (terminal) {
    case TunerStreamTerminal::stopped: return ErrorCode::OK;
    case TunerStreamTerminal::slow_consumer: return ErrorCode::SLOW_CONSUMER;
    case TunerStreamTerminal::usb_error: return ErrorCode::USB_IO;
    case TunerStreamTerminal::disconnected: return ErrorCode::DISCONNECTED;
    case TunerStreamTerminal::sync_error: return ErrorCode::PROTOCOL_ERROR;
    case TunerStreamTerminal::bridge_fatal: return ErrorCode::INTERNAL;
    case TunerStreamTerminal::none: break;
    }
    return ErrorCode::INTERNAL;
}

}  // namespace

struct PosixControlServer::Impl final {
    struct LeaseRecord final {
        bool active = false;
        std::uint64_t lease_id = 0U;
        std::uint8_t receiver = 0U;
    };

    struct Outstanding final {
        bool active = false;
        MessageType type = MessageType::STATUS;
        ControlWorkerOperation operation = ControlWorkerOperation::tuner_status;
        std::uint32_t request_id = 0U;
        std::uint8_t receiver = 0U;
        std::uint64_t lease_id = 0U;
    };

    class Client final : public FrameConsumer {
    public:
        Client(Impl& owner, CardClientId id, SocketStream stream) noexcept
            : owner_(owner), id_(id), stream_(std::move(stream)),
              framer_(MutableByteView{framing_storage_.data(), framing_storage_.size()}),
              state_(ConnectionRole::control_server, kServerCapabilities)
        {
        }

        Result<void> on_frame(const FrameView& frame) noexcept override
        {
            return owner_.on_frame(*this, frame);
        }

        template <typename Payload>
        Result<void> send_payload(MessageType type, MessageKind kind,
                                  std::uint32_t request_id,
                                  const Payload& payload) noexcept
        {
            const auto payload_size = encode_payload(
                payload, MutableByteView{payload_buffer_.data(), payload_buffer_.size()});
            if (!payload_size) {
                return Result<void>::failure(payload_size.error());
            }
            return send_encoded(type, kind, request_id, payload_size.value());
        }

        Result<void> send_empty(MessageType type, std::uint32_t request_id) noexcept
        {
            return send_encoded(type, MessageKind::response, request_id, 0U);
        }

        Result<void> send_error(MessageType type, std::uint32_t request_id,
                                Error error) noexcept
        {
            const char* detail = error_string(error);
            return send_payload(
                type, MessageKind::error_response, request_id,
                ErrorResponsePayload{
                    ipc_error(error),
                    ByteView{reinterpret_cast<const std::uint8_t*>(detail),
                             std::strlen(detail)}});
        }

        Result<void> send_event(const DeviceEventPayload& event) noexcept
        {
            return send_payload(MessageType::DEVICE_EVENT, MessageKind::event, 0U, event);
        }

        bool events_enabled() const noexcept
        {
            return state_.phase() == ConnectionPhase::active &&
                   (state_.negotiated_capabilities() & kCapabilityEvents) != 0U;
        }

        Result<std::size_t> read_ready() noexcept
        {
            return stream_.read_frames(
                MutableByteView{read_buffer_.data(), read_buffer_.size()},
                framer_, *this, Timeout{0U});
        }

        CardClientId id() const noexcept { return id_; }
        int fd() const noexcept { return stream_.native_handle(); }
        bool closed() const noexcept
        {
            return state_.closed() || state_.poisoned() || !stream_.valid();
        }
        void close() noexcept { stream_.close(); }

        ConnectionStateMachine& state() noexcept { return state_; }
        const ConnectionStateMachine& state() const noexcept { return state_; }

        bool find_lease(std::uint64_t lease_id, std::uint8_t& receiver) const noexcept
        {
            if (lease_id == 0U) return false;
            for (const LeaseRecord& lease : leases_) {
                if (lease.active && lease.lease_id == lease_id) {
                    receiver = lease.receiver;
                    return true;
                }
            }
            return false;
        }

        bool add_lease(std::uint8_t receiver, std::uint64_t lease_id) noexcept
        {
            if (lease_id == 0U || receiver >= kReceiverCount) return false;
            for (const LeaseRecord& lease : leases_) {
                if (lease.active && lease.lease_id == lease_id) return false;
            }
            for (LeaseRecord& lease : leases_) {
                if (!lease.active) {
                    lease = LeaseRecord{true, lease_id, receiver};
                    return true;
                }
            }
            return false;
        }

        void remove_lease(std::uint64_t lease_id) noexcept
        {
            for (LeaseRecord& lease : leases_) {
                if (lease.active && lease.lease_id == lease_id) {
                    lease = LeaseRecord{};
                    return;
                }
            }
        }

        std::array<LeaseRecord, kReceiverCount>& leases() noexcept { return leases_; }
        std::vector<std::uint64_t>& card_handles() noexcept { return card_handles_; }
        const std::vector<std::uint64_t>& card_handles() const noexcept
        {
            return card_handles_;
        }

        void set_outstanding(MessageType type, ControlWorkerOperation operation,
                             std::uint32_t request_id, std::uint8_t receiver,
                             std::uint64_t lease_id) noexcept
        {
            outstanding_ = Outstanding{true, type, operation, request_id, receiver, lease_id};
        }

        bool matches(const ControlWorkerCompletion& completion) const noexcept
        {
            return outstanding_.active &&
                   outstanding_.request_id == completion.request_id &&
                   outstanding_.type == completion.type &&
                   outstanding_.operation == completion.operation;
        }

        const Outstanding& outstanding() const noexcept { return outstanding_; }
        void clear_outstanding() noexcept { outstanding_ = Outstanding{}; }

    private:
        Result<void> send_encoded(MessageType type, MessageKind kind,
                                  std::uint32_t request_id,
                                  std::size_t payload_size) noexcept
        {
            const FrameHeader header{
                kProtocolMajor, kProtocolMinor, type, kind, request_id,
                static_cast<std::uint32_t>(payload_size)};
            const auto frame_size = encode_frame(
                header, ByteView{payload_buffer_.data(), payload_size},
                MutableByteView{frame_buffer_.data(), frame_buffer_.size()});
            if (!frame_size) return Result<void>::failure(frame_size.error());
            const auto decoded = decode_frame(
                ByteView{frame_buffer_.data(), frame_size.value()});
            if (!decoded) return Result<void>::failure(decoded.error());
            const auto accepted = state_.process_outbound(decoded.value());
            if (!accepted) return Result<void>::failure(accepted.error());
            return stream_.write_frame(
                ByteView{frame_buffer_.data(), frame_size.value()},
                Timeout{kClientWriteTimeoutMs});
        }

        Impl& owner_;
        CardClientId id_;
        SocketStream stream_;
        std::array<std::uint8_t, kFrameHeaderSize + kMaxControlPayload> framing_storage_{};
        std::array<std::uint8_t, 8192U> read_buffer_{};
        std::array<std::uint8_t, kMaxControlPayload> payload_buffer_{};
        std::array<std::uint8_t, kFrameHeaderSize + kMaxControlPayload> frame_buffer_{};
        StreamFramer framer_;
        ConnectionStateMachine state_;
        std::array<LeaseRecord, kReceiverCount> leases_{};
        std::vector<std::uint64_t> card_handles_;
        Outstanding outstanding_{};
    };

    class StreamClient final : public FrameConsumer {
    public:
        enum class Phase : std::uint8_t { attaching, active, ending };

        StreamClient(Impl& owner, std::uint64_t id, SocketStream stream) noexcept
            : owner_(owner), id_(id), stream_(std::move(stream)),
              framer_(MutableByteView{framing_storage_.data(), framing_storage_.size()}),
              state_(ConnectionRole::stream_server), phase_(Phase::attaching)
        {
        }

        Result<void> on_frame(const FrameView& frame) noexcept override;

        std::uint64_t id() const noexcept { return id_; }
        int fd() const noexcept { return stream_.native_handle(); }
        void close() noexcept { stream_.close(); }
        bool valid() const noexcept { return stream_.valid(); }
        bool remove_requested() const noexcept { return remove_requested_; }
        bool tx_pending() const noexcept { return tx_offset_ < tx_size_; }
        bool ack_pending() const noexcept { return ack_pending_; }
        MutableByteView read_buffer() noexcept
        {
            return MutableByteView{read_buffer_.data(), read_buffer_.size()};
        }
        bool can_read() const noexcept
        {
            if (phase_ == Phase::ending || close_after_flush_ || ack_pending_)
                return false;
            return phase_ == Phase::attaching ? !attach_submitted_ : true;
        }
        bool is_attaching() const noexcept { return phase_ == Phase::attaching; }
        bool is_active() const noexcept { return phase_ == Phase::active; }
        void request_remove() noexcept { remove_requested_ = true; }
        Phase phase() const noexcept { return phase_; }
        void set_phase(Phase phase) noexcept { phase_ = phase; }

        Result<std::size_t> read_ready() noexcept
        {
            return stream_.read_frames(
                MutableByteView{read_buffer_.data(), read_buffer_.size()},
                framer_, *this, Timeout{0U});
        }

        Result<bool> flush(std::size_t budget) noexcept
        {
            while (tx_offset_ < tx_size_ && budget != 0U) {
                const std::size_t remaining = tx_size_ - tx_offset_;
                const std::size_t amount = std::min(remaining, budget);
#if defined(MSG_NOSIGNAL)
                constexpr int flags = MSG_NOSIGNAL;
#else
                constexpr int flags = 0;
#endif
                const ssize_t written = ::send(
                    stream_.native_handle(), tx_buffer_.data() + tx_offset_, amount, flags);
                if (written > 0) {
                    tx_offset_ += static_cast<std::size_t>(written);
                    budget -= static_cast<std::size_t>(written);
                    continue;
                }
                if (written == 0) {
                    return Result<bool>::failure(Error::DISCONNECTED);
                }
                if (errno == EINTR) continue;
                if (errno == EAGAIN || errno == EWOULDBLOCK) {
#if defined(PX4_CONTROL_SERVER_TEST_ACCESS)
                    report_stream_write_blocked(id_);
#endif
                    return Result<bool>::success(false);
                }
                return Result<bool>::failure(
                    errno == EPIPE || errno == ECONNRESET ? Error::DISCONNECTED
                                                          : Error::INTERNAL);
            }
            if (tx_offset_ == tx_size_) {
                tx_offset_ = 0U;
                tx_size_ = 0U;
                if (ack_pending_) ack_pending_ = false;
                if (close_after_flush_) remove_requested_ = true;
                return Result<bool>::success(true);
            }
            return Result<bool>::success(false);
        }

        Result<void> queue_empty_response(std::uint32_t request_id) noexcept
        {
            return queue_encoded(MessageType::ATTACH_STREAM, MessageKind::response,
                                 request_id, EmptyPayload{});
        }

        Result<void> queue_error(std::uint32_t request_id, Error error) noexcept
        {
            const char* detail = error_string(error);
            const auto result = queue_encoded(
                MessageType::ATTACH_STREAM, MessageKind::error_response, request_id,
                ErrorResponsePayload{
                    ipc_error(error),
                    ByteView{reinterpret_cast<const std::uint8_t*>(detail),
                             std::strlen(detail)}});
            close_after_flush_ = true;
            return result;
        }

        Result<void> queue_data(std::uint64_t sequence, std::uint64_t drop_count,
                                ByteView bytes) noexcept
        {
            return queue_encoded(
                MessageType::TS_DATA, MessageKind::event, 0U,
                TsDataEventPayload{sequence, drop_count, bytes});
        }

        Result<void> queue_end(const StreamEndEventPayload& payload) noexcept
        {
            const auto result = queue_encoded(
                MessageType::STREAM_END, MessageKind::event, 0U, payload);
            close_after_flush_ = true;
            return result;
        }

        Result<void> queue_encoded(MessageType type, MessageKind kind,
                                   std::uint32_t request_id,
                                   const EmptyPayload&) noexcept
        {
            if (tx_pending()) return Result<void>::failure(Error::BUSY);
            const FrameHeader header{kProtocolMajor, kProtocolMinor, type, kind,
                                     request_id, 0U};
            const auto frame_size = encode_frame(
                header, ByteView{nullptr, 0U},
                MutableByteView{tx_buffer_.data(), tx_buffer_.size()});
            if (!frame_size) return Result<void>::failure(frame_size.error());
            const auto decoded = decode_frame(
                ByteView{tx_buffer_.data(), frame_size.value()});
            if (!decoded) return Result<void>::failure(decoded.error());
            const auto accepted = state_.process_outbound(decoded.value());
            if (!accepted) return Result<void>::failure(accepted.error());
            tx_size_ = frame_size.value();
            tx_offset_ = 0U;
            ack_pending_ = type == MessageType::ATTACH_STREAM &&
                           kind == MessageKind::response;
            return Result<void>::success();
        }

        template <typename Payload>
        Result<void> queue_encoded(MessageType type, MessageKind kind,
                                   std::uint32_t request_id,
                                   const Payload& payload) noexcept
        {
            if (tx_pending()) return Result<void>::failure(Error::BUSY);
            const auto payload_size = encode_payload(
                payload, MutableByteView{tx_buffer_.data() + kFrameHeaderSize,
                                         tx_buffer_.size() - kFrameHeaderSize});
            if (!payload_size) return Result<void>::failure(payload_size.error());
            const FrameHeader header{kProtocolMajor, kProtocolMinor, type, kind,
                                     request_id,
                                     static_cast<std::uint32_t>(payload_size.value())};
            const auto frame_size = encode_frame(
                header,
                ByteView{tx_buffer_.data() + kFrameHeaderSize, payload_size.value()},
                MutableByteView{tx_buffer_.data(), tx_buffer_.size()});
            if (!frame_size) return Result<void>::failure(frame_size.error());
            const auto decoded = decode_frame(
                ByteView{tx_buffer_.data(), frame_size.value()});
            if (!decoded) return Result<void>::failure(decoded.error());
            const auto accepted = state_.process_outbound(decoded.value());
            if (!accepted) return Result<void>::failure(accepted.error());
            tx_size_ = frame_size.value();
            tx_offset_ = 0U;
            ack_pending_ = type == MessageType::ATTACH_STREAM &&
                           kind == MessageKind::response;
            return Result<void>::success();
        }

        Impl& owner() noexcept { return owner_; }
        ConnectionStateMachine& state() noexcept { return state_; }
        std::uint32_t request_id = 0U;
        std::uint64_t owner_client_id = 0U;
        std::uint64_t lease_id = 0U;
        std::uint8_t receiver = 0U;
        std::array<std::uint8_t, kNonceLength> nonce{};
        TunerAttachment attachment{};
        bool attachment_valid = false;
        bool cleanup_pending = false;
        bool cleanup_queued = false;
        bool cleanup_complete = false;
        bool final_snapshot_valid = false;
        TunerStreamFinalSnapshot final_snapshot{};
        std::uint64_t sequence = 0U;
        bool end_queued = false;
        bool data_eof = false;
        bool attach_completion_seen = false;

        void mark_attach_submitted() noexcept { attach_submitted_ = true; }
        bool attach_was_submitted() const noexcept { return attach_submitted_; }
        void mark_attach_completion_seen() noexcept { attach_completion_seen = true; }

    private:
        Impl& owner_;
        std::uint64_t id_;
        SocketStream stream_;
        std::array<std::uint8_t, kFrameHeaderSize + kMaxControlPayload> framing_storage_{};
        std::array<std::uint8_t, kStreamReadBytes> read_buffer_{};
        std::array<std::uint8_t, kMaxFrameSize> tx_buffer_{};
        StreamFramer framer_;
        ConnectionStateMachine state_;
        Phase phase_;
        std::size_t tx_size_ = 0U;
        std::size_t tx_offset_ = 0U;
        bool ack_pending_ = false;
        bool attach_submitted_ = false;
        bool close_after_flush_ = false;
        bool remove_requested_ = false;
    };

    struct RetiredStream final {
        bool active = false;
        bool waiting_attach = false;
        bool cleanup_queued = false;
        bool cleanup_complete = false;
        std::uint64_t connection_id = 0U;
        std::uint64_t owner_client_id = 0U;
        std::uint64_t lease_id = 0U;
        std::uint8_t receiver = 0U;
        TunerAttachment attachment{};
        bool attachment_valid = false;
    };

    struct RetiredLease final {
        bool active = false;
        bool queued = false;
        std::uint64_t lease_id = 0U;
        std::uint8_t receiver = 0U;
    };

    struct RetiredClient final {
        bool active = false;
        std::uint64_t client_id = 0U;
        // Keep this record until every in-flight client request has been
        // classified, not only an ACQUIRE.
        bool waiting_request = false;
        bool card_pending = false;
        bool card_queued = false;
        std::array<RetiredLease, kReceiverCount> leases{};
    };

    Impl(SocketListener listener_value, SocketListener stream_listener_value,
         CardService& service,
         TunerService& tuner, std::unique_ptr<ControlWorkerLanes> workers_value,
         TunerStreamControl* stream_control_value, std::string_view serial,
         bool ready_value, std::uint8_t usb_mask) noexcept
        : listener(std::move(listener_value)), stream_listener(std::move(stream_listener_value)),
          card_service(service),
          tuner_service(tuner), workers(std::move(workers_value)),
          stream_control(stream_control_value), base_serial(serial),
          ready(ready_value), usb_present_mask(usb_mask),
          next_presence_poll(std::chrono::steady_clock::now())
    {
        known_receiver_states.fill(ReceiverState::free);
    }

    void observe_tuner(const TunerStatus& status) noexcept
    {
        for (std::size_t index = 0U; index < kReceiverCount; ++index) {
            if (known_receiver_states[index] == status.receiver_states[index]) continue;
            ++generation;
            known_receiver_states[index] = status.receiver_states[index];
            pending_events.push_back(DeviceEventPayload{
                generation, DeviceEventKind::state_changed, EventTargetType::receiver,
                static_cast<std::uint8_t>(index)});
        }
    }

    void observe_card_presence(bool present) noexcept
    {
        if (!card_presence_known) {
            card_presence_known = true;
            known_card_present = present;
            return;
        }
        if (known_card_present == present) return;
        known_card_present = present;
        ++generation;
        pending_events.push_back(DeviceEventPayload{
            generation,
            present ? DeviceEventKind::card_inserted : DeviceEventKind::card_removed,
            EventTargetType::card, 0U});
    }

    void observe_card_change(const CardPresenceChange& change) noexcept
    {
        if (change.changed) observe_card_presence(change.present);
    }

    void record_error(Error error) noexcept
    {
        if (error != Error::OK && cleanup_error == Error::OK) cleanup_error = error;
    }

    void schedule_remove(CardClientId id) noexcept
    {
        if (std::find(pending_removals.begin(), pending_removals.end(), id) ==
            pending_removals.end()) {
            pending_removals.push_back(id);
        }
    }

    Result<void> flush_events() noexcept
    {
        for (const DeviceEventPayload& event : pending_events) {
            for (const auto& client : clients) {
                if (client->events_enabled() && !client->send_event(event)) {
                    schedule_remove(client->id());
                }
            }
        }
        pending_events.clear();
        return Result<void>::success();
    }

    Result<void> send_error(Client& client, MessageType type,
                            std::uint32_t request_id, Error error) noexcept
    {
        const auto sent = client.send_error(type, request_id, error);
        if (!sent) schedule_remove(client.id());
        return sent;
    }

    Result<void> on_stream_frame(StreamClient& client,
                                 const FrameView& frame) noexcept;
    Result<void> accept_stream_ready() noexcept;
    void process_stream_clients(const std::vector<pollfd>& descriptors,
                                std::size_t descriptor_base,
                                std::size_t count) noexcept;
    void remove_stream_clients() noexcept;
    void remove_stream_client(std::size_t index) noexcept;
    void schedule_stream_remove(std::uint64_t connection_id) noexcept;
#if defined(PX4_CONTROL_SERVER_TEST_ACCESS)
    void report_stream_capacity() noexcept;
#endif
    bool stream_retired_capacity_available() const noexcept;
    void retry_stream_cleanup() noexcept;
    void handle_stream_completion(const ControlWorkerCompletion& completion) noexcept;
    void handle_stream_cleanup_completion(
        const ControlWorkerCompletion& completion) noexcept;
    void notify_stream_detached(std::uint64_t owner_client_id,
                                std::uint64_t lease_id,
                                const TunerStreamFinalSnapshot& snapshot) noexcept;
    void notify_stream_detached_by_identity(std::uint64_t owner_client_id,
                                            std::uint64_t lease_id) noexcept;
    void begin_stream_cleanup(StreamClient& client) noexcept;
    void begin_stream_end(StreamClient& client,
                          const TunerStreamFinalSnapshot& snapshot) noexcept;
    RetiredStream* allocate_retired_stream(std::uint64_t connection_id) noexcept;
    RetiredStream* find_retired_stream(std::uint64_t connection_id) noexcept;
    const RetiredStream* find_retired_stream(std::uint64_t connection_id) const noexcept;
    bool retired_stream_cleanup_done(const RetiredStream& stream) const noexcept;
    bool all_retired_stream_cleanup_done() const noexcept;
    void reap_retired_streams() noexcept;
    void queue_live_stream_cleanup(StreamClient& client) noexcept;

    Result<void> send_empty(Client& client, const FrameView& request) noexcept
    {
        const auto sent = client.send_empty(request.header.type, request.header.request_id);
        if (!sent) schedule_remove(client.id());
        return sent;
    }

    template <typename Payload>
    Result<void> send_success(Client& client, const FrameView& request,
                              const Payload& payload) noexcept
    {
        const auto sent = client.send_payload(request.header.type, MessageKind::response,
                                               request.header.request_id, payload);
        if (!sent) schedule_remove(client.id());
        return sent;
    }

    Result<void> submit(Client& client, const FrameView& request,
                        ControlWorkerTask task) noexcept
    {
        if ((task.operation == ControlWorkerOperation::tuner_acquire ||
             task.operation == ControlWorkerOperation::tuner_release ||
             task.operation == ControlWorkerOperation::tuner_tune ||
             task.operation == ControlWorkerOperation::tuner_start_stream ||
             task.operation == ControlWorkerOperation::tuner_stop_stream ||
             task.operation == ControlWorkerOperation::tuner_stats) &&
            task.receiver >= kReceiverCount) {
            return send_error(client, request.header.type, request.header.request_id,
                              Error::INVALID_ARGUMENT);
        }
        task.client_id = client.id();
        task.request_id = request.header.request_id;
        task.type = request.header.type;
        task.kind = ControlWorkerTaskKind::client_request;
        client.set_outstanding(request.header.type, task.operation, task.request_id,
                               task.receiver, task.lease_id);
        const ControlWorkerLane lane = lane_for(task);
        const auto submitted = workers->submit(lane, task);
        if (submitted) return Result<void>::success();
        client.clear_outstanding();
        return send_error(client, request.header.type, request.header.request_id,
                          submitted.error());
    }

    static ControlWorkerLane lane_for(const ControlWorkerTask& task) noexcept
    {
        if (task.operation == ControlWorkerOperation::card_status ||
            task.operation == ControlWorkerOperation::card_status_combined ||
            task.operation == ControlWorkerOperation::card_presence ||
            task.operation == ControlWorkerOperation::card_connect ||
            task.operation == ControlWorkerOperation::card_reconnect ||
            task.operation == ControlWorkerOperation::card_disconnect ||
            task.operation == ControlWorkerOperation::card_reset ||
            task.operation == ControlWorkerOperation::card_transmit ||
            task.operation == ControlWorkerOperation::card_begin_transaction ||
            task.operation == ControlWorkerOperation::card_end_transaction ||
            task.operation == ControlWorkerOperation::card_release_connection ||
            task.operation == ControlWorkerOperation::card_shutdown) {
            return ControlWorkerLane::card;
        }
        return task.operation == ControlWorkerOperation::tuner_status ||
                       task.operation == ControlWorkerOperation::tuner_shutdown ||
                       task.receiver < 4U ? ControlWorkerLane::tuner_dev1 :
                                            ControlWorkerLane::tuner_dev2;
    }

    Result<void> dispatch(Client& client, const FrameView& request) noexcept
    {
        switch (request.header.type) {
        case MessageType::LIST: {
            if (!decode_empty_payload(request.payload))
                return Result<void>::failure(Error::PROTOCOL_ERROR);
            return send_success(
                client, request,
                ListResponsePayload{
                    generation,
                    ByteView{reinterpret_cast<const std::uint8_t*>(base_serial.data()),
                             base_serial.size()},
                    static_cast<std::uint8_t>(ready ? 1U : 0U), usb_present_mask,
                    receiver_records()});
        }
        case MessageType::STATUS: {
            if (!decode_empty_payload(request.payload))
                return Result<void>::failure(Error::PROTOCOL_ERROR);
            ControlWorkerTask task{};
            task.operation = ControlWorkerOperation::card_status_combined;
            return submit(client, request, task);
        }
        case MessageType::CARD_STATUS: {
            if (!decode_empty_payload(request.payload))
                return Result<void>::failure(Error::PROTOCOL_ERROR);
            ControlWorkerTask task{};
            task.operation = ControlWorkerOperation::card_status;
            return submit(client, request, task);
        }
        case MessageType::CARD_CONNECT: {
            const auto decoded = decode_card_connect_request_payload(request.payload);
            if (!decoded) return Result<void>::failure(Error::PROTOCOL_ERROR);
            ControlWorkerTask task{};
            task.operation = ControlWorkerOperation::card_connect;
            task.share_mode = decoded.value().share_mode;
            return submit(client, request, task);
        }
        case MessageType::CARD_RECONNECT: {
            const auto decoded = decode_card_reconnect_request_payload(request.payload);
            if (!decoded) return Result<void>::failure(Error::PROTOCOL_ERROR);
            ControlWorkerTask task{};
            task.operation = ControlWorkerOperation::card_reconnect;
            task.card_handle = decoded.value().card_handle;
            task.share_mode = decoded.value().share_mode;
            task.disposition = decoded.value().disposition;
            return submit(client, request, task);
        }
        case MessageType::CARD_DISCONNECT: {
            const auto decoded = decode_card_disposition_request_payload(request.payload);
            if (!decoded) return Result<void>::failure(Error::PROTOCOL_ERROR);
            ControlWorkerTask task{};
            task.operation = ControlWorkerOperation::card_disconnect;
            task.card_handle = decoded.value().card_handle;
            task.disposition = decoded.value().disposition;
            return submit(client, request, task);
        }
        case MessageType::CARD_RESET: {
            const auto decoded = decode_card_handle_request_payload(request.payload);
            if (!decoded) return Result<void>::failure(Error::PROTOCOL_ERROR);
            ControlWorkerTask task{};
            task.operation = ControlWorkerOperation::card_reset;
            task.card_handle = decoded.value().card_handle;
            return submit(client, request, task);
        }
        case MessageType::CARD_TRANSMIT: {
            const auto decoded = decode_card_transmit_request_payload(request.payload);
            if (!decoded || decoded.value().apdu.size > task_apdu_capacity())
                return Result<void>::failure(Error::PROTOCOL_ERROR);
            ControlWorkerTask task{};
            task.operation = ControlWorkerOperation::card_transmit;
            task.card_handle = decoded.value().card_handle;
            task.apdu_size = decoded.value().apdu.size;
            std::memcpy(task.apdu.data(), decoded.value().apdu.data, task.apdu_size);
            return submit(client, request, task);
        }
        case MessageType::BEGIN_TRANSACTION: {
            const auto decoded = decode_card_handle_request_payload(request.payload);
            if (!decoded) return Result<void>::failure(Error::PROTOCOL_ERROR);
            ControlWorkerTask task{};
            task.operation = ControlWorkerOperation::card_begin_transaction;
            task.card_handle = decoded.value().card_handle;
            return submit(client, request, task);
        }
        case MessageType::END_TRANSACTION: {
            const auto decoded = decode_card_disposition_request_payload(request.payload);
            if (!decoded) return Result<void>::failure(Error::PROTOCOL_ERROR);
            ControlWorkerTask task{};
            task.operation = ControlWorkerOperation::card_end_transaction;
            task.card_handle = decoded.value().card_handle;
            task.disposition = decoded.value().disposition;
            return submit(client, request, task);
        }
        case MessageType::ACQUIRE: {
            const auto decoded = decode_acquire_request_payload(request.payload);
            if (!decoded) return Result<void>::failure(Error::PROTOCOL_ERROR);
            ControlWorkerTask task{};
            task.operation = ControlWorkerOperation::tuner_acquire;
            task.receiver = decoded.value().receiver_id;
            return submit(client, request, task);
        }
        case MessageType::RELEASE: {
            const auto decoded = decode_lease_request_payload(request.payload);
            if (!decoded) return Result<void>::failure(Error::PROTOCOL_ERROR);
            std::uint8_t receiver = 0U;
            if (!client.find_lease(decoded.value().lease_id, receiver)) {
                return send_error(client, request.header.type, request.header.request_id,
                                  Error::NOT_FOUND);
            }
            ControlWorkerTask task{};
            task.operation = ControlWorkerOperation::tuner_release;
            task.receiver = receiver;
            task.lease_id = decoded.value().lease_id;
            return submit(client, request, task);
        }
        case MessageType::TUNE: {
            const auto decoded = decode_tune_request_payload(request.payload);
            if (!decoded) return Result<void>::failure(Error::PROTOCOL_ERROR);
            std::uint8_t receiver = 0U;
            if (!client.find_lease(decoded.value().lease_id, receiver)) {
                return send_error(client, request.header.type, request.header.request_id,
                                  Error::NOT_FOUND);
            }
            ControlWorkerTask task{};
            task.operation = ControlWorkerOperation::tuner_tune;
            task.receiver = receiver;
            task.lease_id = decoded.value().lease_id;
            task.tune = decoded.value();
            return submit(client, request, task);
        }
        case MessageType::START_STREAM:
        case MessageType::STOP_STREAM:
        case MessageType::STATS: {
            const auto decoded = decode_lease_request_payload(request.payload);
            if (!decoded) return Result<void>::failure(Error::PROTOCOL_ERROR);
            std::uint8_t receiver = 0U;
            if (!client.find_lease(decoded.value().lease_id, receiver)) {
                return send_error(client, request.header.type, request.header.request_id,
                                  Error::NOT_FOUND);
            }
            ControlWorkerTask task{};
            task.receiver = receiver;
            task.lease_id = decoded.value().lease_id;
            task.operation = request.header.type == MessageType::START_STREAM
                ? ControlWorkerOperation::tuner_start_stream
                : request.header.type == MessageType::STOP_STREAM
                    ? ControlWorkerOperation::tuner_stop_stream
                    : ControlWorkerOperation::tuner_stats;
            return submit(client, request, task);
        }
        case MessageType::HELLO:
        case MessageType::ATTACH_STREAM:
        case MessageType::TS_DATA:
        case MessageType::DEVICE_EVENT:
        case MessageType::STREAM_END:
            return Result<void>::failure(Error::PROTOCOL_ERROR);
        }
        return Result<void>::failure(Error::PROTOCOL_ERROR);
    }

    static constexpr std::size_t task_apdu_capacity() noexcept
    {
        return kMaxCardPayload;
    }

    Result<void> on_frame(Client& client, const FrameView& frame) noexcept
    {
        const auto accepted = client.state().process_inbound(frame);
        if (!accepted) return Result<void>::failure(accepted.error());
        switch (accepted.value().event) {
        case ConnectionEvent::hello_response_required: {
            const auto hello = client.state().pending_hello_response();
            if (!hello) return Result<void>::failure(hello.error());
            return client.send_payload(MessageType::HELLO, MessageKind::response,
                                       frame.header.request_id, hello.value());
        }
        case ConnectionEvent::version_mismatch_response_required:
            return client.send_error(MessageType::HELLO, frame.header.request_id,
                                     Error::VERSION_MISMATCH);
        case ConnectionEvent::request_accepted: {
            const auto dispatched = dispatch(client, frame);
            if (!dispatched) return dispatched;
            // Async completions send their response first and flush related
            // events only after that write. Removal is deferred until this
            // callback has unwound, so Client is never invalidated here.
            return flush_events();
        }
        case ConnectionEvent::response_accepted:
        case ConnectionEvent::event_accepted:
        case ConnectionEvent::attach_response_required:
        case ConnectionEvent::ts_data_accepted:
        case ConnectionEvent::stream_end_accepted:
            return Result<void>::failure(Error::PROTOCOL_ERROR);
        }
        return Result<void>::failure(Error::PROTOCOL_ERROR);
    }

    RetiredClient* find_retired(CardClientId id) noexcept
    {
        for (RetiredClient& retired : retired_clients) {
            if (retired.active && retired.client_id == id) return &retired;
        }
        return nullptr;
    }

    RetiredClient* allocate_retired(CardClientId id) noexcept
    {
        for (RetiredClient& retired : retired_clients) {
            if (!retired.active) {
                retired = RetiredClient{};
                retired.active = true;
                retired.client_id = id;
                return &retired;
            }
        }
        return nullptr;
    }

    bool retired_cleanup_done(const RetiredClient& retired) const noexcept
    {
        if (retired.waiting_request || retired.card_pending) return false;
        for (const RetiredLease& lease : retired.leases) {
            if (lease.active) return false;
        }
        return true;
    }

    bool all_retired_cleanup_done() const noexcept
    {
        for (const RetiredClient& retired : retired_clients) {
            if (retired.active && !retired_cleanup_done(retired)) return false;
        }
        return all_retired_stream_cleanup_done();
    }

    void reap_retired() noexcept
    {
        for (RetiredClient& retired : retired_clients) {
            if (retired.active && retired_cleanup_done(retired)) {
                retired = RetiredClient{};
            }
        }
        reap_retired_streams();
    }

    void queue_cleanup_task(ControlWorkerTask task, bool& queued) noexcept
    {
        if (queued) return;
        const auto submitted = workers->submit(lane_for(task), task);
        if (submitted) {
            queued = true;
        } else if (submitted.error() != Error::BUSY) {
            record_error(submitted.error());
        }
    }

    void retry_retired_cleanup() noexcept
    {
        for (RetiredClient& retired : retired_clients) {
            if (!retired.active) continue;
            for (RetiredLease& lease : retired.leases) {
                if (!lease.active || lease.queued) continue;
                ControlWorkerTask task{};
                task.kind = ControlWorkerTaskKind::cleanup;
                task.operation = ControlWorkerOperation::tuner_release;
                task.client_id = retired.client_id;
                task.request_id = 0U;
                task.receiver = lease.receiver;
                task.lease_id = lease.lease_id;
                queue_cleanup_task(task, lease.queued);
            }
            if (retired.card_pending && !retired.card_queued) {
                ControlWorkerTask task{};
                task.kind = ControlWorkerTaskKind::cleanup;
                task.operation = ControlWorkerOperation::card_release_connection;
                task.client_id = retired.client_id;
                task.request_id = 0U;
                queue_cleanup_task(task, retired.card_queued);
            }
        }
        retry_stream_cleanup();
    }

    void remove_client(std::size_t index) noexcept
    {
        if (index >= clients.size()) return;
        Client& client = *clients[index];
        const CardClientId id = client.id();
        client.close();
        RetiredClient* retired = allocate_retired(id);
        if (retired == nullptr) {
            // Admission reserves a retired slot before accepting a socket;
            // reaching this branch indicates an internal invariant failure.
            record_error(Error::INTERNAL);
        } else {
            retired->waiting_request = client.outstanding().active;
            for (const LeaseRecord& lease : client.leases()) {
                if (lease.active) {
                    for (RetiredLease& target : retired->leases) {
                        if (!target.active) {
                            target = RetiredLease{true, false, lease.lease_id,
                                                  lease.receiver};
                            break;
                        }
                    }
                }
            }
            // Always enqueue this fence. It also catches a card connect that
            // completes after the socket has already been removed.
            retired->card_pending = true;
        }
        clients.erase(clients.begin() + static_cast<std::ptrdiff_t>(index));
        retry_retired_cleanup();
    }

    void remove_pending_clients() noexcept
    {
        for (const CardClientId id : pending_removals) {
            for (std::size_t index = clients.size(); index > 0U; --index) {
                if (clients[index - 1U]->id() == id) {
                    remove_client(index - 1U);
                    break;
                }
            }
        }
        pending_removals.clear();
    }

    Result<void> accept_ready() noexcept
    {
        while (true) {
            auto accepted = listener.accept(Timeout{0U});
            if (!accepted) {
                return accepted.error() == Error::TIMEOUT ? Result<void>::success() :
                                                            Result<void>::failure(accepted.error());
            }
            const bool capacity = clients.size() < kMaxControlConnections &&
                                  retired_slot_available();
            if (!capacity || client_ids_exhausted) {
                accepted.value().close();
                continue;
            }
            const CardClientId id = next_client_id;
            if (next_client_id == std::numeric_limits<CardClientId>::max()) {
                client_ids_exhausted = true;
            } else {
                ++next_client_id;
            }
            std::unique_ptr<Client> client(
                new (std::nothrow) Client(*this, id, std::move(accepted.value())));
            if (!client) {
                accepted.value().close();
                record_error(Error::INTERNAL);
                continue;
            }
            clients.push_back(std::move(client));
        }
    }

    bool retired_slot_available() const noexcept
    {
        std::size_t active = 0U;
        for (const RetiredClient& retired : retired_clients) {
            if (retired.active) ++active;
        }
        return clients.size() + active < kRetiredClientCapacity;
    }

    void handle_cleanup_completion(const ControlWorkerCompletion& completion) noexcept
    {
        RetiredClient* retired = find_retired(completion.client_id);
        if (retired == nullptr) return;
        if (completion.operation == ControlWorkerOperation::tuner_release) {
            notify_stream_detached_by_identity(completion.client_id,
                                               completion.lease_id);
            for (RetiredLease& lease : retired->leases) {
                if (lease.active && lease.lease_id == completion.lease_id) {
                    lease = RetiredLease{};
                    break;
                }
            }
            if (completion.error != Error::OK && completion.error != Error::NOT_FOUND) {
                record_error(completion.error);
            }
        } else if (completion.operation == ControlWorkerOperation::card_release_connection) {
            retired->card_pending = false;
            if (completion.error != Error::OK && completion.error != Error::NOT_FOUND) {
                record_error(completion.error);
            }
        }
    }

    void add_orphan_lease(RetiredClient& retired, std::uint8_t receiver,
                          std::uint64_t lease_id) noexcept
    {
        for (RetiredLease& lease : retired.leases) {
            if (!lease.active) {
                lease = RetiredLease{true, false, lease_id, receiver};
                return;
            }
        }
        record_error(Error::INTERNAL);
    }

    void handle_orphan_completion(const ControlWorkerCompletion& completion,
                                  RetiredClient& retired) noexcept
    {
        // The record covers every client request, not just ACQUIRE. Classify
        // the completion before allowing the retired record to be reaped.
        retired.waiting_request = false;
        if (completion.operation == ControlWorkerOperation::tuner_acquire) {
            if (completion.error == Error::OK) {
                add_orphan_lease(retired, completion.receiver,
                                 completion.tuner_acquire.lease_id);
            }
        }
        handle_cleanup_completion(completion);
    }

    Result<void> send_completion(Client& client,
                                 const ControlWorkerCompletion& completion) noexcept
    {
        const Outstanding outstanding = client.outstanding();
        Result<void> sent = Result<void>::failure(Error::INTERNAL);
        if (completion.error != Error::OK) {
            // TunerService removes a valid release logically before reporting
            // a backend close error. CardService has the same consume-on-error
            // rule except for an unknown handle; keep the poll-thread registry
            // aligned with those ownership contracts.
            if (completion.operation == ControlWorkerOperation::tuner_release) {
                client.remove_lease(outstanding.lease_id);
            } else if (completion.operation == ControlWorkerOperation::card_disconnect &&
                       completion.error != Error::NOT_FOUND &&
                       completion.error != Error::BUSY &&
                       completion.error != Error::INVALID_ARGUMENT) {
                const auto it = std::find(client.card_handles().begin(),
                                          client.card_handles().end(),
                                          completion.card_handle);
                if (it != client.card_handles().end()) client.card_handles().erase(it);
            }
            sent = send_error(client, outstanding.type, completion.request_id,
                              completion.error);
        } else {
            switch (completion.operation) {
            case ControlWorkerOperation::tuner_acquire:
                if (!client.add_lease(completion.receiver,
                                      completion.tuner_acquire.lease_id)) {
                    sent = send_error(client, outstanding.type, completion.request_id,
                                      Error::INTERNAL);
                    ControlWorkerTask cleanup{};
                    cleanup.operation = ControlWorkerOperation::tuner_release;
                    cleanup.client_id = client.id();
                    cleanup.receiver = completion.receiver;
                    cleanup.lease_id = completion.tuner_acquire.lease_id;
                    auto retired = allocate_retired(client.id());
                    if (retired != nullptr) add_orphan_lease(*retired, cleanup.receiver,
                                                             cleanup.lease_id);
                    retry_retired_cleanup();
                } else {
                    sent = client.send_payload(
                        outstanding.type, MessageKind::response, completion.request_id,
                        AcquireResponsePayload{completion.tuner_acquire.lease_id,
                                               completion.tuner_acquire.nonce});
                }
                break;
            case ControlWorkerOperation::tuner_release:
                client.remove_lease(outstanding.lease_id);
                sent = client.send_empty(outstanding.type, completion.request_id);
                break;
            case ControlWorkerOperation::tuner_tune:
                sent = client.send_payload(outstanding.type, MessageKind::response,
                                           completion.request_id,
                                           completion.tune_response);
                break;
            case ControlWorkerOperation::tuner_start_stream:
                sent = client.send_empty(outstanding.type, completion.request_id);
                break;
            case ControlWorkerOperation::tuner_stop_stream:
                if (!completion.stream_snapshot_valid) {
                    sent = send_error(client, outstanding.type, completion.request_id,
                                      Error::INTERNAL);
                } else {
                    sent = client.send_payload(
                        outstanding.type, MessageKind::response, completion.request_id,
                        counters_payload(completion.stream_final_snapshot.counters));
                }
                break;
            case ControlWorkerOperation::tuner_stats:
                sent = client.send_payload(
                    outstanding.type, MessageKind::response, completion.request_id,
                    counters_payload(completion.stream_counters));
                break;
            case ControlWorkerOperation::card_status: {
                observe_card_presence(completion.card_status.present);
                sent = client.send_payload(
                    outstanding.type, MessageKind::response, completion.request_id,
                    CardStatusResponsePayload{
                        static_cast<std::uint8_t>(completion.card_status.present ? 1U : 0U),
                        static_cast<std::uint8_t>(completion.card_status.initialized ? 1U : 0U),
                        completion.card_status.reader_generation,
                        completion.card_status.atr.view()});
                break;
            }
            case ControlWorkerOperation::card_status_combined:
                observe_card_presence(completion.card_status.present);
                if (completion.tuner_status_valid) observe_tuner(completion.tuner_status);
                sent = client.send_payload(
                    outstanding.type, MessageKind::response, completion.request_id,
                    StatusResponsePayload{
                        generation, static_cast<std::uint8_t>(ready ? 1U : 0U),
                        usb_present_mask,
                        static_cast<std::uint8_t>(completion.card_status.present ? 1U : 0U),
                        static_cast<std::uint8_t>(completion.card_status.initialized ? 1U : 0U),
                        completion.tuner_status.receiver_states, 0U, 0U});
                break;
            case ControlWorkerOperation::card_connect:
                client.card_handles().push_back(completion.card_connect.handle);
                sent = client.send_payload(
                    outstanding.type, MessageKind::response, completion.request_id,
                    CardConnectResponsePayload{completion.card_connect.handle,
                                               completion.card_connect.atr.view()});
                break;
            case ControlWorkerOperation::card_reconnect:
                sent = client.send_payload(outstanding.type, MessageKind::response,
                                           completion.request_id,
                                           AtrPayload{completion.atr.view()});
                break;
            case ControlWorkerOperation::card_disconnect: {
                const auto it = std::find(client.card_handles().begin(),
                                          client.card_handles().end(),
                                          completion.card_handle);
                if (it != client.card_handles().end()) client.card_handles().erase(it);
                sent = client.send_empty(outstanding.type, completion.request_id);
                break;
            }
            case ControlWorkerOperation::card_reset:
                sent = client.send_payload(outstanding.type, MessageKind::response,
                                           completion.request_id,
                                           AtrPayload{completion.atr.view()});
                break;
            case ControlWorkerOperation::card_transmit:
                sent = client.send_payload(
                    outstanding.type, MessageKind::response, completion.request_id,
                    CardTransmitResponsePayload{
                        ByteView{completion.card_response.data(),
                                 completion.card_response_size}});
                break;
            case ControlWorkerOperation::card_begin_transaction:
            case ControlWorkerOperation::card_end_transaction:
                sent = client.send_empty(outstanding.type, completion.request_id);
                break;
            default:
                sent = Result<void>::failure(Error::INTERNAL);
                break;
            }
        }
        client.clear_outstanding();
        if (!sent) schedule_remove(client.id());
        // This is deliberately after the response write: related receiver or
        // card transitions must never precede their command response.
        (void)flush_events();
        return Result<void>::success();
    }

    void handle_completion(const ControlWorkerCompletion& completion) noexcept
    {
        if (completion.kind == ControlWorkerTaskKind::background &&
            completion.operation == ControlWorkerOperation::card_presence) {
            presence_poll_pending = false;
            if (completion.error == Error::OK) {
                observe_card_change(completion.card_presence);
            } else {
                record_error(completion.error);
            }
            next_presence_poll = std::chrono::steady_clock::now() +
                                 std::chrono::milliseconds(kPresencePollIntervalMs);
            return;
        }
        if (completion.kind == ControlWorkerTaskKind::background &&
            completion.operation == ControlWorkerOperation::tuner_shutdown) {
            tuner_shutdown_pending = false;
            tuner_shutdown_complete = true;
            if (completion.error != Error::OK) record_error(completion.error);
            return;
        }
        if (completion.kind == ControlWorkerTaskKind::background &&
            completion.operation == ControlWorkerOperation::card_shutdown) {
            card_shutdown_pending = false;
            card_shutdown_complete = true;
            if (completion.error != Error::OK) record_error(completion.error);
            return;
        }
        if (completion.operation == ControlWorkerOperation::tuner_attach_stream) {
            handle_stream_completion(completion);
            return;
        }
        if (completion.kind == ControlWorkerTaskKind::cleanup) {
            if (completion.operation == ControlWorkerOperation::tuner_detach_stream) {
                handle_stream_cleanup_completion(completion);
            } else if (completion.operation == ControlWorkerOperation::tuner_release ||
                completion.operation == ControlWorkerOperation::card_release_connection) {
                handle_cleanup_completion(completion);
                if (completion.tuner_status_valid) observe_tuner(completion.tuner_status);
            }
            return;
        }

        RetiredClient* retired = find_retired(completion.client_id);
        if (retired != nullptr) {
            handle_orphan_completion(completion, *retired);
            retry_retired_cleanup();
            if (completion.tuner_status_valid) observe_tuner(completion.tuner_status);
            return;
        }

        for (const auto& client : clients) {
            if (client->id() != completion.client_id) continue;
            if (!client->matches(completion)) return;
            if (completion.tuner_status_valid) observe_tuner(completion.tuner_status);
            (void)send_completion(*client, completion);
            if (completion.operation == ControlWorkerOperation::tuner_release) {
                notify_stream_detached_by_identity(completion.client_id,
                                                   completion.lease_id);
            } else if (completion.operation == ControlWorkerOperation::tuner_stop_stream) {
                if (completion.stream_snapshot_valid)
                    notify_stream_detached(completion.client_id, completion.lease_id,
                                           completion.stream_final_snapshot);
                else
                    notify_stream_detached_by_identity(completion.client_id,
                                                       completion.lease_id);
            }
            return;
        }
        // A stale successful ACQUIRE must not leak a newly created lease. In
        // normal operation a removed client has a retired record; this guard
        // only records an invariant failure if that record was lost.
        if (completion.operation == ControlWorkerOperation::tuner_acquire &&
            completion.error == Error::OK) {
            record_error(Error::INTERNAL);
        }
    }

    void process_completions() noexcept
    {
        workers->drain_wake();
        for (const ControlWorkerLane lane : {ControlWorkerLane::tuner_dev1,
                                             ControlWorkerLane::tuner_dev2,
                                             ControlWorkerLane::card}) {
            ControlWorkerCompletion completion{};
            while (workers->try_pop(lane, completion)) handle_completion(completion);
        }
        retry_retired_cleanup();
        reap_retired();
    }

    void schedule_presence_if_due(std::chrono::steady_clock::time_point now) noexcept
    {
        if (!any_card_handles() || presence_poll_pending || now < next_presence_poll ||
            shutting_down) return;
        ControlWorkerTask task{};
        task.kind = ControlWorkerTaskKind::background;
        task.operation = ControlWorkerOperation::card_presence;
        const auto submitted = workers->submit(ControlWorkerLane::card, task);
        if (submitted) {
            presence_poll_pending = true;
        } else if (submitted.error() != Error::BUSY) {
            record_error(submitted.error());
            next_presence_poll = now + std::chrono::milliseconds(kPresencePollIntervalMs);
        }
    }

    bool any_card_handles() const noexcept
    {
        for (const auto& client : clients) {
            if (!client->card_handles().empty()) return true;
        }
        return false;
    }

    Result<void> poll_once(Timeout timeout) noexcept
    {
        if (shutdown_complete) return Result<void>::failure(Error::NOT_READY);
        process_completions();
        if (cleanup_error != Error::OK) {
            const Error error = cleanup_error;
            cleanup_error = Error::OK;
            return Result<void>::failure(error);
        }
        schedule_presence_if_due(std::chrono::steady_clock::now());

        const std::size_t control_count = clients.size();
        const std::size_t stream_count = stream_client_count;
        std::vector<pollfd> descriptors;
        descriptors.reserve(control_count + stream_count + 3U);
        descriptors.push_back(pollfd{listener.native_handle(), POLLIN, 0});
        descriptors.push_back(pollfd{stream_listener.native_handle(), POLLIN, 0});
        descriptors.push_back(pollfd{workers->wake_fd(), POLLIN, 0});
        for (std::size_t index = 0U; index < control_count; ++index) {
            const auto& client = clients[index];
            descriptors.push_back(pollfd{client->fd(), POLLIN, 0});
        }
        for (std::size_t index = 0U; index < stream_count; ++index) {
            const auto& client = stream_clients[index];
            short events = POLLIN;
            if (client->tx_pending()) events = static_cast<short>(events | POLLOUT);
            descriptors.push_back(pollfd{client->fd(), events, 0});
        }

        std::uint32_t wait_ms = timeout.milliseconds;
        if (any_card_handles()) {
            const auto now = std::chrono::steady_clock::now();
            if (now >= next_presence_poll && !presence_poll_pending) {
                wait_ms = 0U;
            } else if (now < next_presence_poll) {
                const auto until_poll = std::chrono::duration_cast<std::chrono::milliseconds>(
                    next_presence_poll - now).count();
                wait_ms = std::min<std::uint32_t>(
                    wait_ms, static_cast<std::uint32_t>(std::max<std::int64_t>(0, until_poll)));
            }
        }
        const int result = ::poll(descriptors.data(), descriptors.size(),
                                  timeout_to_poll(Timeout{wait_ms}));
        if (result < 0) {
            return errno == EINTR ? Result<void>::success() :
                                    Result<void>::failure(Error::INTERNAL);
        }

        // Drain completions before socket callbacks as well as after them.
        // This keeps the poll thread as the only Client owner while making a
        // worker wake immediately visible without a second poll cycle.
        if (descriptors[2].revents != 0) process_completions();
        if ((descriptors[0].revents & POLLIN) != 0) {
            const auto accepted = accept_ready();
            if (!accepted) return accepted;
        }
        if ((descriptors[1].revents & POLLIN) != 0) {
            const auto accepted = accept_stream_ready();
            if (!accepted) return accepted;
        }
        for (std::size_t index = control_count; index > 0U; --index) {
            const std::size_t client_index = index - 1U;
            const std::size_t descriptor_index = 3U + client_index;
            const short events = descriptors[descriptor_index].revents;
            if (client_index >= clients.size() || events == 0) continue;
            bool remove = (events & POLLNVAL) != 0;
            if (!remove && (events & (POLLIN | POLLHUP | POLLERR)) != 0) {
                const auto read = clients[client_index]->read_ready();
                remove = !read || clients[client_index]->closed();
            }
            if (remove) {
                clients[client_index]->close();
                schedule_remove(clients[client_index]->id());
            }
        }
        process_stream_clients(descriptors, 3U + control_count, stream_count);
        remove_pending_clients();
        remove_stream_clients();
        process_completions();
        schedule_presence_if_due(std::chrono::steady_clock::now());
        (void)flush_events();
        if (cleanup_error != Error::OK) {
            const Error error = cleanup_error;
            cleanup_error = Error::OK;
            return Result<void>::failure(error);
        }
        return Result<void>::success();
    }

    Result<void> shutdown() noexcept
    {
        if (shutdown_complete) return Result<void>::success();
        shutting_down = true;
        stream_listener.close();
        // The control listener is the first listener to create the shared
        // product/instance directories.  Close the stream endpoint first so
        // its socket cannot prevent the owning listener from removing those
        // now-empty directories.
        listener.close();
        for (std::size_t index = clients.size(); index > 0U; --index) {
            remove_client(index - 1U);
        }
        for (std::size_t index = stream_client_count; index > 0U; --index) {
            remove_stream_client(index - 1U);
        }

        // Backend operations are finite by contract (tuner tune <=30 s,
        // card APDU <=3 s, and finite USB primitive timeouts). Arbitrarily
        // hung backend code is outside this contract; it cannot be safely
        // recovered with pthread cancellation.
        while (!all_retired_cleanup_done() || !tuner_shutdown_complete ||
               !card_shutdown_complete || stream_client_count != 0U) {
            process_completions();
            retry_retired_cleanup();
            // remove_stream_client() deliberately retains a client if no
            // retired slot can be reserved.  Retry after completions have
            // had a chance to reap an older record; never drop its cleanup
            // ownership merely to make shutdown progress.
            for (std::size_t index = stream_client_count; index > 0U; --index) {
                remove_stream_client(index - 1U);
            }
            if (all_retired_cleanup_done() && workers->idle()) {
                if (!tuner_shutdown_complete && !tuner_shutdown_pending) {
                    ControlWorkerTask task{};
                    task.kind = ControlWorkerTaskKind::background;
                    task.operation = ControlWorkerOperation::tuner_shutdown;
                    const auto submitted = workers->submit(ControlWorkerLane::tuner_dev1,
                                                           task);
                    if (submitted) tuner_shutdown_pending = true;
                    else record_error(submitted.error());
                }
                if (!card_shutdown_complete && !card_shutdown_pending) {
                    ControlWorkerTask task{};
                    task.kind = ControlWorkerTaskKind::background;
                    task.operation = ControlWorkerOperation::card_shutdown;
                    const auto submitted = workers->submit(ControlWorkerLane::card, task);
                    if (submitted) card_shutdown_pending = true;
                    else record_error(submitted.error());
                }
            }
            if (workers->live_thread_count() == 0U) break;
            pollfd descriptor{workers->wake_fd(), POLLIN, 0};
            const int result = ::poll(&descriptor, 1U, 10);
            if (result < 0 && errno != EINTR) record_error(Error::INTERNAL);
        }
        const auto joined = workers->stop_and_join();
        if (!joined && cleanup_error == Error::OK) cleanup_error = joined.error();
        reap_retired();
        shutdown_complete = true;
        if (cleanup_error != Error::OK) {
            const Error error = cleanup_error;
            cleanup_error = Error::OK;
            return Result<void>::failure(error);
        }
        return Result<void>::success();
    }

    SocketListener listener;
    SocketListener stream_listener;
    CardService& card_service;
    TunerService& tuner_service;
    std::unique_ptr<ControlWorkerLanes> workers;
    TunerStreamControl* stream_control;
    std::string base_serial;
    std::vector<std::unique_ptr<Client>> clients;
    // Data clients are fixed-capacity so an accepted socket never depends on
    // an exception-throwing vector growth while the daemon runs.
    std::array<std::unique_ptr<StreamClient>, kMaxStreamConnections> stream_clients{};
    std::size_t stream_client_count = 0U;
    std::vector<DeviceEventPayload> pending_events;
    std::vector<CardClientId> pending_removals;
    std::array<std::uint64_t, kMaxStreamConnections> pending_stream_removals{};
    std::size_t pending_stream_removal_count = 0U;
    std::array<RetiredClient, kRetiredClientCapacity> retired_clients{};
    std::array<RetiredStream, kRetiredClientCapacity> retired_streams{};
    std::array<ReceiverState, kReceiverCount> known_receiver_states{};
    CardClientId next_client_id = 1U;
    bool client_ids_exhausted = false;
    bool ready;
    std::uint8_t usb_present_mask;
    bool card_presence_known = false;
    bool known_card_present = false;
    bool presence_poll_pending = false;
    bool shutting_down = false;
    bool shutdown_complete = false;
    bool tuner_shutdown_pending = false;
    bool tuner_shutdown_complete = false;
    bool card_shutdown_pending = false;
    bool card_shutdown_complete = false;
    Error cleanup_error = Error::OK;
    std::chrono::steady_clock::time_point next_presence_poll;
    std::uint64_t generation = 1U;
};

Result<void> PosixControlServer::Impl::StreamClient::on_frame(
    const FrameView& frame) noexcept
{
    const auto accepted = state_.process_inbound(frame);
    if (!accepted) return Result<void>::failure(accepted.error());
    if (accepted.value().event != ConnectionEvent::attach_response_required)
        return Result<void>::failure(Error::PROTOCOL_ERROR);
    const auto request = decode_attach_stream_request_payload(frame.payload);
    if (!request) return Result<void>::failure(Error::PROTOCOL_ERROR);
    return owner_.on_stream_frame(*this, frame);
}

PosixControlServer::Impl::RetiredStream*
PosixControlServer::Impl::allocate_retired_stream(
    std::uint64_t connection_id) noexcept
{
    for (RetiredStream& stream : retired_streams) {
        if (!stream.active) {
            stream = RetiredStream{};
            stream.active = true;
            stream.connection_id = connection_id;
            return &stream;
        }
    }
    return nullptr;
}

PosixControlServer::Impl::RetiredStream*
PosixControlServer::Impl::find_retired_stream(
    std::uint64_t connection_id) noexcept
{
    for (RetiredStream& stream : retired_streams) {
        if (stream.active && stream.connection_id == connection_id) return &stream;
    }
    return nullptr;
}

const PosixControlServer::Impl::RetiredStream*
PosixControlServer::Impl::find_retired_stream(
    std::uint64_t connection_id) const noexcept
{
    for (const RetiredStream& stream : retired_streams) {
        if (stream.active && stream.connection_id == connection_id) return &stream;
    }
    return nullptr;
}

bool PosixControlServer::Impl::retired_stream_cleanup_done(
    const PosixControlServer::Impl::RetiredStream& stream) const noexcept
{
    return !stream.waiting_attach &&
           (!stream.attachment_valid || stream.cleanup_complete);
}

bool PosixControlServer::Impl::all_retired_stream_cleanup_done() const noexcept
{
    for (const RetiredStream& stream : retired_streams) {
        if (stream.active && !retired_stream_cleanup_done(stream)) return false;
    }
    return true;
}

void PosixControlServer::Impl::reap_retired_streams() noexcept
{
#if defined(PX4_CONTROL_SERVER_TEST_ACCESS)
    bool changed = false;
#endif
    for (RetiredStream& stream : retired_streams) {
        if (stream.active && retired_stream_cleanup_done(stream)) {
            stream = RetiredStream{};
#if defined(PX4_CONTROL_SERVER_TEST_ACCESS)
            changed = true;
#endif
        }
    }
#if defined(PX4_CONTROL_SERVER_TEST_ACCESS)
    if (changed) report_stream_capacity();
#endif
}

Result<void> PosixControlServer::Impl::on_stream_frame(
    StreamClient& client, const FrameView& frame) noexcept
{
    const auto request = decode_attach_stream_request_payload(frame.payload);
    if (!request) return Result<void>::failure(Error::PROTOCOL_ERROR);
    client.request_id = frame.header.request_id;
    client.lease_id = request.value().lease_id;
    client.nonce = request.value().nonce;
    if (stream_control == nullptr) {
        client.mark_attach_completion_seen();
        const auto queued = client.queue_error(client.request_id, Error::UNSUPPORTED);
        if (!queued) client.request_remove();
        return Result<void>::success();
    }

    std::uint8_t receiver = 0U;
    std::uint64_t owner_client_id = 0U;
    bool found = false;
    for (const auto& control : clients) {
        if (control->find_lease(client.lease_id, receiver)) {
            owner_client_id = control->id();
            found = true;
            break;
        }
    }
    if (!found) {
        client.mark_attach_completion_seen();
        const auto queued = client.queue_error(client.request_id, Error::NOT_FOUND);
        if (!queued) client.request_remove();
        return Result<void>::success();
    }
    client.owner_client_id = owner_client_id;
    client.receiver = receiver;
    ControlWorkerTask task{};
    task.type = MessageType::ATTACH_STREAM;
    task.kind = ControlWorkerTaskKind::client_request;
    task.operation = ControlWorkerOperation::tuner_attach_stream;
    task.client_id = client.id();
    task.connection_id = client.id();
    task.request_id = client.request_id;
    task.receiver = receiver;
    task.lease_id = client.lease_id;
    task.nonce = client.nonce;
    const auto submitted = workers->submit(lane_for(task), task);
    if (submitted) {
        // A failed submission has no completion to classify.  Marking the
        // request submitted before this point would leave a retired stream
        // waiting forever for an impossible completion.
        client.mark_attach_submitted();
    } else {
        client.mark_attach_completion_seen();
        const auto queued = client.queue_error(client.request_id, submitted.error());
        if (!queued) client.request_remove();
    }
    return Result<void>::success();
}

void PosixControlServer::Impl::begin_stream_end(
    StreamClient& client, const TunerStreamFinalSnapshot& snapshot) noexcept
{
    if (client.end_queued || client.remove_requested()) return;
    client.final_snapshot = snapshot;
    client.final_snapshot_valid = true;
    client.data_eof = false;
    client.set_phase(StreamClient::Phase::ending);
}

void PosixControlServer::Impl::notify_stream_detached(
    std::uint64_t owner_client_id, std::uint64_t lease_id,
    const TunerStreamFinalSnapshot& snapshot) noexcept
{
    for (std::size_t index = 0U; index < stream_client_count; ++index) {
        StreamClient& stream = *stream_clients[index];
        if (stream.attachment_valid &&
            stream.attachment.owner_client_id == owner_client_id &&
            stream.attachment.lease_id == lease_id) {
            begin_stream_end(stream, snapshot);
        }
    }
}

void PosixControlServer::Impl::notify_stream_detached_by_identity(
    std::uint64_t owner_client_id, std::uint64_t lease_id) noexcept
{
    for (std::size_t index = 0U; index < stream_client_count; ++index) {
        StreamClient& stream = *stream_clients[index];
        if (!stream.attachment_valid ||
            stream.attachment.owner_client_id != owner_client_id ||
            stream.attachment.lease_id != lease_id)
            continue;
        if (stream_control == nullptr) {
            record_error(Error::INTERNAL);
            stream.request_remove();
            continue;
        }
        const auto snapshot = stream_control->final_snapshot(stream.attachment);
        if (snapshot) {
            begin_stream_end(stream, snapshot.value());
        } else {
            record_error(snapshot.error());
            stream.request_remove();
        }
    }
}

void PosixControlServer::Impl::handle_stream_completion(
    const ControlWorkerCompletion& completion) noexcept
{
    if (completion.tuner_status_valid) observe_tuner(completion.tuner_status);
    StreamClient* live = nullptr;
    for (std::size_t index = 0U; index < stream_client_count; ++index) {
        if (stream_clients[index]->id() == completion.connection_id) {
            live = stream_clients[index].get();
            break;
        }
    }
    if (completion.operation != ControlWorkerOperation::tuner_attach_stream)
        return;
    if (live != nullptr && live->is_attaching() &&
        live->request_id == completion.request_id) {
        live->mark_attach_completion_seen();
        if (completion.error == Error::OK && completion.tuner_attachment_valid) {
            live->attachment = completion.tuner_attachment;
            live->attachment_valid = true;
            live->owner_client_id = live->attachment.owner_client_id;
            live->receiver = live->attachment.receiver;
            const auto queued = live->queue_empty_response(live->request_id);
            if (!queued) {
                live->request_remove();
                (void)tuner_service.revoke_stream(live->owner_client_id,
                                                   live->attachment.lease_id);
            } else {
                live->set_phase(StreamClient::Phase::active);
            }
        } else {
            const auto queued = live->queue_error(
                live->request_id,
                completion.error == Error::OK ? Error::INTERNAL : completion.error);
            if (!queued) live->request_remove();
        }
        return;
    }

    RetiredStream* retired = find_retired_stream(completion.connection_id);
    if (retired == nullptr) {
        if (completion.error == Error::OK && completion.tuner_attachment_valid)
            record_error(Error::INTERNAL);
        return;
    }
    retired->waiting_attach = false;
    if (completion.error == Error::OK && completion.tuner_attachment_valid) {
        retired->attachment = completion.tuner_attachment;
        retired->attachment_valid = true;
        ControlWorkerTask task{};
        task.kind = ControlWorkerTaskKind::cleanup;
        task.operation = ControlWorkerOperation::tuner_detach_stream;
        task.client_id = retired->attachment.owner_client_id;
        task.connection_id = retired->connection_id;
        task.receiver = retired->attachment.receiver;
        task.attachment = retired->attachment;
        queue_cleanup_task(task, retired->cleanup_queued);
    } else {
        retired->active = false;
#if defined(PX4_CONTROL_SERVER_TEST_ACCESS)
        report_stream_capacity();
#endif
    }
}

void PosixControlServer::Impl::handle_stream_cleanup_completion(
    const ControlWorkerCompletion& completion) noexcept
{
    StreamClient* live = nullptr;
    for (std::size_t index = 0U; index < stream_client_count; ++index) {
        if (stream_clients[index]->id() == completion.connection_id) {
            live = stream_clients[index].get();
            break;
        }
    }
    if (completion.error != Error::OK && completion.error != Error::NOT_FOUND)
        record_error(completion.error);
    if (live != nullptr) {
        live->cleanup_queued = false;
        live->cleanup_pending = false;
        live->cleanup_complete = true;
        if (stream_control == nullptr) {
            live->request_remove();
            return;
        }
        const auto snapshot = stream_control->final_snapshot(live->attachment);
        if (snapshot) begin_stream_end(*live, snapshot.value());
        else {
            record_error(snapshot.error());
            live->request_remove();
        }
        return;
    }
    RetiredStream* retired = find_retired_stream(completion.connection_id);
    if (retired == nullptr) return;
    if (retired->attachment_valid && stream_control != nullptr) {
        const auto released = stream_control->release_final(retired->attachment);
        if (!released && released.error() != Error::UNSUPPORTED &&
            released.error() != Error::NOT_FOUND)
            record_error(released.error());
    }
    retired->cleanup_queued = false;
    retired->cleanup_complete = true;
    retired->active = false;
#if defined(PX4_CONTROL_SERVER_TEST_ACCESS)
    report_stream_capacity();
#endif
}

void PosixControlServer::Impl::retry_stream_cleanup() noexcept
{
    for (RetiredStream& retired : retired_streams) {
        if (!retired.active || retired.waiting_attach ||
            retired.cleanup_queued || !retired.attachment_valid)
            continue;
        ControlWorkerTask task{};
        task.kind = ControlWorkerTaskKind::cleanup;
        task.operation = ControlWorkerOperation::tuner_detach_stream;
        task.client_id = retired.attachment.owner_client_id;
        task.connection_id = retired.connection_id;
        task.receiver = retired.attachment.receiver;
        task.attachment = retired.attachment;
        queue_cleanup_task(task, retired.cleanup_queued);
    }
    for (std::size_t index = 0U; index < stream_client_count; ++index) {
        StreamClient& stream = *stream_clients[index];
        if (!stream.cleanup_pending || stream.cleanup_queued ||
            !stream.attachment_valid)
            continue;
        ControlWorkerTask task{};
        task.kind = ControlWorkerTaskKind::cleanup;
        task.operation = ControlWorkerOperation::tuner_detach_stream;
        task.client_id = stream.attachment.owner_client_id;
        task.connection_id = stream.id();
        task.receiver = stream.attachment.receiver;
        task.attachment = stream.attachment;
        queue_cleanup_task(task, stream.cleanup_queued);
    }
}

void PosixControlServer::Impl::queue_live_stream_cleanup(StreamClient& client) noexcept
{
    if (client.cleanup_complete || client.cleanup_pending) return;
    if (client.owner_client_id != 0U && client.lease_id != 0U) {
        const auto revoked = tuner_service.revoke_stream(
            client.owner_client_id, client.lease_id, client.nonce);
        if (!revoked && revoked.error() != Error::NOT_FOUND)
            record_error(revoked.error());
    }
    client.cleanup_pending = true;
    if (!client.attachment_valid) {
        client.cleanup_complete = true;
        return;
    }
    ControlWorkerTask task{};
    task.kind = ControlWorkerTaskKind::cleanup;
    task.operation = ControlWorkerOperation::tuner_detach_stream;
    task.client_id = client.attachment.owner_client_id;
    task.connection_id = client.id();
    task.receiver = client.attachment.receiver;
    task.attachment = client.attachment;
    queue_cleanup_task(task, client.cleanup_queued);
}

void PosixControlServer::Impl::begin_stream_cleanup(StreamClient& client) noexcept
{
    if (client.cleanup_complete || client.cleanup_pending) return;
    if (client.owner_client_id != 0U && client.lease_id != 0U) {
        const auto revoked = tuner_service.revoke_stream(
            client.owner_client_id, client.lease_id, client.nonce);
        if (!revoked && revoked.error() != Error::NOT_FOUND)
            record_error(revoked.error());
    }
    // An attached or in-flight client must not be removed until its retired
    // cleanup record has been reserved.  Admission maintains this invariant;
    // keep the defensive check here so a future capacity change cannot orphan
    // physical stream ownership.
    if (!stream_retired_capacity_available()) {
        record_error(Error::INTERNAL);
        return;
    }
    RetiredStream* retired = allocate_retired_stream(client.id());
    if (retired == nullptr) {
        record_error(Error::INTERNAL);
        return;
    }
    retired->owner_client_id = client.owner_client_id;
    retired->lease_id = client.lease_id;
    retired->receiver = client.receiver;
    retired->waiting_attach = client.attach_was_submitted() &&
                              !client.attach_completion_seen;
    retired->attachment_valid = client.attachment_valid;
    retired->attachment = client.attachment;
    retired->cleanup_complete = !retired->attachment_valid;
    if (retired->attachment_valid) {
        ControlWorkerTask task{};
        task.kind = ControlWorkerTaskKind::cleanup;
        task.operation = ControlWorkerOperation::tuner_detach_stream;
        task.client_id = client.attachment.owner_client_id;
        task.connection_id = client.id();
        task.receiver = client.attachment.receiver;
        task.attachment = client.attachment;
        queue_cleanup_task(task, retired->cleanup_queued);
    }
}

void PosixControlServer::Impl::schedule_stream_remove(
    std::uint64_t connection_id) noexcept
{
    for (std::size_t index = 0U; index < pending_stream_removal_count; ++index) {
        if (pending_stream_removals[index] == connection_id) return;
    }
    if (pending_stream_removal_count < pending_stream_removals.size()) {
        pending_stream_removals[pending_stream_removal_count++] = connection_id;
    } else {
        record_error(Error::INTERNAL);
    }
}

bool PosixControlServer::Impl::stream_retired_capacity_available() const noexcept
{
    std::size_t retired_count = 0U;
    for (const RetiredStream& stream : retired_streams) {
        if (stream.active) ++retired_count;
    }
    return stream_client_count + retired_count < retired_streams.size();
}

#if defined(PX4_CONTROL_SERVER_TEST_ACCESS)
void PosixControlServer::Impl::report_stream_capacity() noexcept
{
    std::size_t retired_count = 0U;
    for (const RetiredStream& stream : retired_streams) {
        if (stream.active) ++retired_count;
    }
    report_stream_count(stream_client_count, retired_count);
}
#endif

void PosixControlServer::Impl::remove_stream_client(std::size_t index) noexcept
{
    if (index >= stream_client_count) return;
    StreamClient& client = *stream_clients[index];
    client.close();
    if (client.cleanup_complete && client.attachment_valid && stream_control != nullptr) {
        const auto released = stream_control->release_final(client.attachment);
        if (!released && released.error() != Error::UNSUPPORTED &&
            released.error() != Error::NOT_FOUND)
            record_error(released.error());
    }
    if (!client.cleanup_complete &&
        (client.attachment_valid || client.is_attaching()))
        begin_stream_cleanup(client);
    for (std::size_t current = index; current + 1U < stream_client_count; ++current)
        stream_clients[current] = std::move(stream_clients[current + 1U]);
    stream_clients[stream_client_count - 1U].reset();
    --stream_client_count;
#if defined(PX4_CONTROL_SERVER_TEST_ACCESS)
    report_stream_capacity();
#endif
    retry_stream_cleanup();
}

void PosixControlServer::Impl::remove_stream_clients() noexcept
{
    for (std::size_t pending = 0U; pending < pending_stream_removal_count; ++pending) {
        const std::uint64_t id = pending_stream_removals[pending];
        for (std::size_t index = stream_client_count; index > 0U; --index) {
            if (stream_clients[index - 1U]->id() == id) {
                remove_stream_client(index - 1U);
                break;
            }
        }
    }
    pending_stream_removal_count = 0U;
}

Result<void> PosixControlServer::Impl::accept_stream_ready() noexcept
{
    while (true) {
        auto accepted = stream_listener.accept(Timeout{0U});
        if (!accepted) {
            return accepted.error() == Error::TIMEOUT
                ? Result<void>::success() : Result<void>::failure(accepted.error());
        }
        if (stream_client_count >= kMaxStreamConnections ||
            !stream_retired_capacity_available() || client_ids_exhausted) {
            accepted.value().close();
            continue;
        }
        const std::uint64_t id = next_client_id;
        if (next_client_id == std::numeric_limits<std::uint64_t>::max())
            client_ids_exhausted = true;
        else
            ++next_client_id;
        std::unique_ptr<StreamClient> client(
            new (std::nothrow) StreamClient(*this, id, std::move(accepted.value())));
        if (!client) {
            accepted.value().close();
            record_error(Error::INTERNAL);
            continue;
        }
        stream_clients[stream_client_count++] = std::move(client);
#if defined(PX4_CONTROL_SERVER_TEST_ACCESS)
        report_stream_capacity();
#endif
    }
}

void PosixControlServer::Impl::process_stream_clients(
    const std::vector<pollfd>& descriptors, std::size_t descriptor_base,
    std::size_t count) noexcept
{
    for (std::size_t index = 0U; index < count && index < stream_client_count; ++index) {
        StreamClient& client = *stream_clients[index];
        const short events = descriptors[descriptor_base + index].revents;
        if ((events & (POLLHUP | POLLERR | POLLNVAL)) != 0) {
            client.request_remove();
        } else {
            // At most one bounded write attempt is made for this client in a
            // poll cycle.  In particular, do not spend a second budget after
            // queueing TS_DATA or STREAM_END; POLLOUT schedules the next
            // bounded flush on the following cycle.
            if (client.tx_pending()) {
                const auto flushed = client.flush(kStreamWriteBudget);
                if (!flushed) client.request_remove();
            }
            if (!client.remove_requested() && client.can_read() &&
                (events & POLLIN) != 0) {
                const auto read = client.read_ready();
#if defined(PX4_CONTROL_SERVER_TEST_ACCESS)
                if (read && read.value() == 0U)
                    report_stream_partial(client.id());
#endif
                if (!read && read.error() != Error::TIMEOUT) {
                    client.request_remove();
                }
            }
            if (!client.remove_requested() &&
                (client.is_active() || (client.phase() == StreamClient::Phase::ending &&
                                        client.final_snapshot_valid)) &&
                !client.tx_pending() && !client.ack_pending()) {
                if (stream_control == nullptr) {
                    client.request_remove();
                } else {
                    const auto read = stream_control->read(
                        client.attachment, client.read_buffer(), Timeout{0U});
                    if (read) {
                        if (read.value().bytes != 0U) {
                            const auto queued = client.queue_data(
                                client.sequence, 0U,
                                ByteView{client.read_buffer().data,
                                         read.value().bytes});
                            if (!queued) {
                                client.request_remove();
                            }
                            else ++client.sequence;
                        } else if (read.value().eof ||
                                   read.value().terminal != TunerStreamTerminal::none) {
                            if (client.is_active()) {
                                client.set_phase(StreamClient::Phase::ending);
                                queue_live_stream_cleanup(client);
                            } else {
                                client.data_eof = true;
                            }
                        }
                    } else if (read.error() == Error::NOT_FOUND) {
                        if (client.phase() == StreamClient::Phase::ending) {
                            client.data_eof = true;
                        } else {
                            notify_stream_detached_by_identity(
                                client.attachment.owner_client_id,
                                client.attachment.lease_id);
                        }
                    } else if (read.error() != Error::TIMEOUT) {
                        record_error(read.error());
                        client.request_remove();
                    }
                }
            }
            if (!client.remove_requested() && client.phase() == StreamClient::Phase::ending &&
                client.final_snapshot_valid && client.data_eof && !client.end_queued &&
                !client.tx_pending()) {
                const StreamEndEventPayload end{
                    counters_payload(client.final_snapshot.counters),
                    stream_end_error(static_cast<TunerStreamTerminal>(
                        client.final_snapshot.terminal))};
                const auto queued = client.queue_end(end);
                if (!queued) client.request_remove();
                else client.end_queued = true;
            }
        }
        if (client.remove_requested()) schedule_stream_remove(client.id());
    }
}

Result<std::unique_ptr<PosixControlServer>> PosixControlServer::create(
    const EndpointConfig& endpoint, CardService& card_service,
    TunerService& tuner_service, std::string_view base_serial, bool ready,
    std::uint8_t usb_present_mask, TunerStreamControl* stream_control) noexcept
{
    if (base_serial.empty() || base_serial.size() > 0xffffU ||
        (usb_present_mask & 0xfcU) != 0U) {
        return Result<std::unique_ptr<PosixControlServer>>::failure(
            Error::INVALID_ARGUMENT);
    }
    auto listener = SocketListener::listen(endpoint);
    if (!listener) {
        return Result<std::unique_ptr<PosixControlServer>>::failure(listener.error());
    }
    const EndpointConfig stream_endpoint{
        endpoint.runtime_directory, endpoint.instance, kStreamEndpointName,
        endpoint.access};
    auto stream_listener = SocketListener::listen(stream_endpoint);
    if (!stream_listener) {
        return Result<std::unique_ptr<PosixControlServer>>::failure(
            stream_listener.error());
    }
    auto workers = ControlWorkerLanes::create(card_service, tuner_service);
    if (!workers) {
        // listener remains owned here and therefore closes/unlinks the endpoint
        // transactionally before returning the worker startup error.
        return Result<std::unique_ptr<PosixControlServer>>::failure(workers.error());
    }
    std::unique_ptr<Impl> impl(new (std::nothrow) Impl(
        std::move(listener.value()), std::move(stream_listener.value()), card_service,
        tuner_service, std::move(workers.value()), stream_control, base_serial, ready,
        usb_present_mask));
    if (!impl) return Result<std::unique_ptr<PosixControlServer>>::failure(Error::INTERNAL);
    std::unique_ptr<PosixControlServer> server(
        new (std::nothrow) PosixControlServer(std::move(impl)));
    if (!server) return Result<std::unique_ptr<PosixControlServer>>::failure(Error::INTERNAL);
    return Result<std::unique_ptr<PosixControlServer>>::success(std::move(server));
}

PosixControlServer::PosixControlServer(std::unique_ptr<Impl> impl) noexcept
    : impl_(std::move(impl))
{
}

PosixControlServer::~PosixControlServer() noexcept
{
    (void)shutdown();
}

Result<void> PosixControlServer::poll_once(Timeout timeout) noexcept
{
    if (!impl_) return Result<void>::failure(Error::NOT_READY);
    return impl_->poll_once(timeout);
}

Result<void> PosixControlServer::shutdown() noexcept
{
    if (!impl_) return Result<void>::success();
    return impl_->shutdown();
}

const char* PosixControlServer::endpoint_path() const noexcept
{
    return impl_ ? impl_->listener.endpoint_path() : "";
}

const char* PosixControlServer::stream_endpoint_path() const noexcept
{
    return impl_ ? impl_->stream_listener.endpoint_path() : "";
}

std::size_t PosixControlServer::connection_count() const noexcept
{
    return impl_ ? impl_->clients.size() : 0U;
}

#if defined(PX4_CONTROL_SERVER_TEST_ACCESS)
void set_control_server_test_hooks(ControlServerTestHooks* hooks) noexcept
{
    test_hooks = hooks;
}
#endif

}  // namespace px4::userland::ipc::posix
