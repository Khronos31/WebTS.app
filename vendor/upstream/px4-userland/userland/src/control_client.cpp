// SPDX-License-Identifier: GPL-2.0-only
#include "px4/control_client.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <memory>
#include <utility>

namespace px4::userland::ipc::posix {
namespace {

Error protocol_error(ErrorCode code) noexcept
{
    switch (code) {
    case ErrorCode::OK: return Error::OK;
    case ErrorCode::INVALID_ARGUMENT: return Error::INVALID_ARGUMENT;
    case ErrorCode::VERSION_MISMATCH: return Error::VERSION_MISMATCH;
    case ErrorCode::NOT_FOUND: return Error::NOT_FOUND;
    case ErrorCode::BUSY: return Error::BUSY;
    case ErrorCode::NOT_READY: return Error::NOT_READY;
    case ErrorCode::TIMEOUT: return Error::TIMEOUT;
    case ErrorCode::USB_IO: return Error::USB_IO;
    case ErrorCode::DISCONNECTED: return Error::DISCONNECTED;
    case ErrorCode::PROTOCOL_ERROR: return Error::PROTOCOL_ERROR;
    case ErrorCode::FIRMWARE_REJECTED: return Error::FIRMWARE_REJECTED;
    case ErrorCode::UNSUPPORTED: return Error::UNSUPPORTED;
    case ErrorCode::NO_CARD: return Error::NO_CARD;
    case ErrorCode::CARD_REMOVED: return Error::CARD_REMOVED;
    case ErrorCode::BUFFER_TOO_SMALL: return Error::BUFFER_TOO_SMALL;
    case ErrorCode::SLOW_CONSUMER: return Error::SLOW_CONSUMER;
    case ErrorCode::INTERNAL: return Error::INTERNAL;
    }
    return Error::PROTOCOL_ERROR;
}

using Clock = std::chrono::steady_clock;

Timeout remaining_timeout(Clock::time_point deadline) noexcept
{
    const auto now = Clock::now();
    if (now >= deadline) return Timeout{0U};
    const auto remaining = deadline - now;
    const auto whole = std::chrono::duration_cast<std::chrono::milliseconds>(remaining);
    std::uint64_t milliseconds = static_cast<std::uint64_t>(whole.count());
    if (whole < remaining) ++milliseconds;
    return Timeout{static_cast<std::uint32_t>(
        std::min<std::uint64_t>(milliseconds, 0xffffffffULL))};
}

}  // namespace

struct PosixControlClient::Impl final : public FrameConsumer {
    explicit Impl(SocketStream stream_value) noexcept
        : stream(std::move(stream_value)),
          framer(MutableByteView{framing_storage.data(), framing_storage.size()}),
          state(ConnectionRole::control_client)
    {
    }

    Result<void> on_frame(const FrameView& frame) noexcept override
    {
        const auto accepted = state.process_inbound(frame);
        if (!accepted) return Result<void>::failure(accepted.error());
        if (accepted.value().event == ConnectionEvent::event_accepted) {
            const auto event = decode_device_event_payload(frame.payload);
            if (!event) return Result<void>::failure(event.error());
            if (event_sink != nullptr) event_sink->on_device_event(event.value());
            return Result<void>::success();
        }
        if (accepted.value().event != ConnectionEvent::response_accepted || response_ready) {
            return Result<void>::failure(Error::PROTOCOL_ERROR);
        }
        response.header = frame.header;
        response.payload.clear();
        if (frame.payload.size != 0U) {
            response.payload.assign(frame.payload.data,
                                    frame.payload.data + frame.payload.size);
        }
        response_ready = true;
        return Result<void>::success();
    }

    Result<ControlResponse> transact(MessageType type, ByteView payload,
                                     Timeout timeout,
                                     ControlEventSink* sink) noexcept
    {
        if (!stream.valid() || response_ready ||
            (payload.size != 0U && payload.data == nullptr) ||
            payload.size > kMaxControlPayload) {
            return Result<ControlResponse>::failure(Error::INVALID_ARGUMENT);
        }
        const std::uint32_t request_id = next_request_id++;
        if (next_request_id == 0U) next_request_id = 1U;
        const FrameHeader header{kProtocolMajor, kProtocolMinor, type,
                                 MessageKind::request, request_id,
                                 static_cast<std::uint32_t>(payload.size)};
        const auto frame_size = encode_frame(
            header, payload, MutableByteView{frame_buffer.data(), frame_buffer.size()});
        if (!frame_size) return Result<ControlResponse>::failure(frame_size.error());
        const auto decoded = decode_frame(ByteView{frame_buffer.data(), frame_size.value()});
        if (!decoded) return Result<ControlResponse>::failure(decoded.error());
        const auto outbound = state.process_outbound(decoded.value());
        if (!outbound) return Result<ControlResponse>::failure(outbound.error());

        const auto deadline = Clock::now() + std::chrono::milliseconds(timeout.milliseconds);
        const auto written = stream.write_frame(
            ByteView{frame_buffer.data(), frame_size.value()}, remaining_timeout(deadline));
        if (!written) return Result<ControlResponse>::failure(written.error());

        event_sink = sink;
        while (!response_ready) {
            const Timeout remaining = remaining_timeout(deadline);
            if (remaining.milliseconds == 0U) {
                event_sink = nullptr;
                return Result<ControlResponse>::failure(Error::TIMEOUT);
            }
            const auto read = stream.read_frames(
                MutableByteView{read_buffer.data(), read_buffer.size()}, framer, *this,
                remaining);
            if (!read) {
                event_sink = nullptr;
                return Result<ControlResponse>::failure(read.error());
            }
        }
        event_sink = nullptr;
        ControlResponse result = std::move(response);
        response = ControlResponse{};
        response_ready = false;
        if (result.header.kind == MessageKind::error_response) {
            const auto error = decode_error_response_payload(
                ByteView{result.payload.data(), result.payload.size()});
            return Result<ControlResponse>::failure(
                error ? protocol_error(error.value().error_code) : Error::PROTOCOL_ERROR);
        }
        return Result<ControlResponse>::success(std::move(result));
    }

    SocketStream stream;
    std::array<std::uint8_t, kFrameHeaderSize + kMaxControlPayload> framing_storage{};
    std::array<std::uint8_t, 8192U> read_buffer{};
    std::array<std::uint8_t, kFrameHeaderSize + kMaxControlPayload> frame_buffer{};
    StreamFramer framer;
    ConnectionStateMachine state;
    ControlResponse response{};
    ControlEventSink* event_sink = nullptr;
    std::uint32_t next_request_id = 1U;
    bool response_ready = false;
};

Result<std::unique_ptr<PosixControlClient>> PosixControlClient::connect(
    const EndpointConfig& endpoint, std::uint32_t requested_capabilities,
    Timeout timeout) noexcept
{
    auto stream = SocketStream::connect(endpoint, timeout);
    if (!stream) {
        return Result<std::unique_ptr<PosixControlClient>>::failure(stream.error());
    }
    auto impl = std::unique_ptr<Impl>(new Impl(std::move(stream.value())));
    std::array<std::uint8_t, 12U> payload{};
    const auto payload_size = encode_payload(
        HelloRequestPayload{kProtocolMajor, kProtocolMinor, kProtocolMajor,
                            kProtocolMinor, requested_capabilities},
        MutableByteView{payload.data(), payload.size()});
    if (!payload_size) {
        return Result<std::unique_ptr<PosixControlClient>>::failure(payload_size.error());
    }
    const auto hello = impl->transact(
        MessageType::HELLO, ByteView{payload.data(), payload_size.value()}, timeout, nullptr);
    if (!hello) {
        return Result<std::unique_ptr<PosixControlClient>>::failure(hello.error());
    }
    const auto decoded = decode_hello_response_payload(
        ByteView{hello.value().payload.data(), hello.value().payload.size()});
    if (!decoded) {
        return Result<std::unique_ptr<PosixControlClient>>::failure(decoded.error());
    }
    return Result<std::unique_ptr<PosixControlClient>>::success(
        std::unique_ptr<PosixControlClient>(new PosixControlClient(std::move(impl))));
}

PosixControlClient::PosixControlClient(std::unique_ptr<Impl> impl) noexcept
    : impl_(std::move(impl))
{
}

PosixControlClient::~PosixControlClient() noexcept
{
    close();
}

Result<ControlResponse> PosixControlClient::request(
    MessageType type, ByteView encoded_payload, Timeout timeout,
    ControlEventSink* events) noexcept
{
    return impl_ ? impl_->transact(type, encoded_payload, timeout, events) :
                   Result<ControlResponse>::failure(Error::NOT_READY);
}

std::uint32_t PosixControlClient::negotiated_capabilities() const noexcept
{
    return impl_ ? impl_->state.negotiated_capabilities() : 0U;
}

void PosixControlClient::close() noexcept
{
    if (impl_) impl_->stream.close();
}

}  // namespace px4::userland::ipc::posix
