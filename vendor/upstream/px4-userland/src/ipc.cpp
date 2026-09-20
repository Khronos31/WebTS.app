// SPDX-License-Identifier: GPL-2.0-only
#include "px4/ipc.h"

#include <algorithm>
#include <array>
#include <cstring>
#include <limits>

namespace px4::userland::ipc {
namespace {

constexpr std::array<std::uint8_t, 4U> kMagic{'P', 'X', '4', 'U'};
constexpr std::uint16_t kResponseFlag = 0x0001U;
constexpr std::uint16_t kErrorFlag = 0x0002U;
constexpr std::uint16_t kKnownFlags = kResponseFlag | kErrorFlag;
constexpr std::uint8_t kCardReaderCount = 1U;
constexpr std::uint8_t kUsbPresentMask = 0x03U;
constexpr std::size_t kCountersPayloadSize = 8U * sizeof(std::uint64_t);

bool valid_view(ByteView view) noexcept
{
    return view.size == 0U || view.data != nullptr;
}

bool valid_view(MutableByteView view) noexcept
{
    return view.size == 0U || view.data != nullptr;
}

bool valid_boolean(std::uint8_t value) noexcept
{
    return value <= 1U;
}

bool valid_system(System value) noexcept
{
    return value == System::ISDB_T || value == System::ISDB_S;
}

bool valid_receiver_state(ReceiverState value) noexcept
{
    return static_cast<std::uint8_t>(value) <=
           static_cast<std::uint8_t>(ReceiverState::error);
}

bool valid_share_mode(ShareMode value) noexcept
{
    return value == ShareMode::shared || value == ShareMode::exclusive;
}

bool valid_disposition(Disposition value) noexcept
{
    return value == Disposition::leave || value == Disposition::reset;
}

bool valid_device_event_kind(DeviceEventKind value) noexcept
{
    const auto raw = static_cast<std::uint8_t>(value);
    return raw >= static_cast<std::uint8_t>(DeviceEventKind::attached) &&
           raw <= static_cast<std::uint8_t>(DeviceEventKind::state_changed);
}

bool valid_event_target(EventTargetType type, std::uint8_t id) noexcept
{
    switch (type) {
    case EventTargetType::device:
        return id == 1U || id == 2U;
    case EventTargetType::receiver:
        return id < kReceiverCount;
    case EventTargetType::card:
        return id == 0U;
    }
    return false;
}

bool valid_utf8(ByteView text) noexcept
{
    if (!valid_view(text)) {
        return false;
    }
    std::size_t offset = 0U;
    while (offset < text.size) {
        const std::uint8_t first = text.data[offset++];
        if (first == 0U) {
            return false;
        }
        if (first <= 0x7fU) {
            continue;
        }

        std::size_t continuation_count = 0U;
        std::uint8_t second_min = 0x80U;
        std::uint8_t second_max = 0xbfU;
        if (first >= 0xc2U && first <= 0xdfU) {
            continuation_count = 1U;
        } else if (first >= 0xe0U && first <= 0xefU) {
            continuation_count = 2U;
            if (first == 0xe0U) {
                second_min = 0xa0U;
            } else if (first == 0xedU) {
                second_max = 0x9fU;
            }
        } else if (first >= 0xf0U && first <= 0xf4U) {
            continuation_count = 3U;
            if (first == 0xf0U) {
                second_min = 0x90U;
            } else if (first == 0xf4U) {
                second_max = 0x8fU;
            }
        } else {
            return false;
        }
        if (continuation_count > text.size - offset) {
            return false;
        }
        const std::uint8_t second = text.data[offset];
        if (second < second_min || second > second_max) {
            return false;
        }
        for (std::size_t index = 1U; index < continuation_count; ++index) {
            const std::uint8_t value = text.data[offset + index];
            if (value < 0x80U || value > 0xbfU) {
                return false;
            }
        }
        offset += continuation_count;
    }
    return true;
}

class Reader final {
public:
    explicit Reader(ByteView input) noexcept : input_(input) {}

    bool u8(std::uint8_t& value) noexcept
    {
        if (remaining() < 1U) {
            return false;
        }
        value = input_.data[offset_++];
        return true;
    }

    bool u16(std::uint16_t& value) noexcept
    {
        if (remaining() < 2U) {
            return false;
        }
        value = static_cast<std::uint16_t>(input_.data[offset_]) |
                static_cast<std::uint16_t>(
                    static_cast<std::uint16_t>(input_.data[offset_ + 1U]) << 8U);
        offset_ += 2U;
        return true;
    }

    bool u32(std::uint32_t& value) noexcept
    {
        if (remaining() < 4U) {
            return false;
        }
        value = static_cast<std::uint32_t>(input_.data[offset_]) |
                (static_cast<std::uint32_t>(input_.data[offset_ + 1U]) << 8U) |
                (static_cast<std::uint32_t>(input_.data[offset_ + 2U]) << 16U) |
                (static_cast<std::uint32_t>(input_.data[offset_ + 3U]) << 24U);
        offset_ += 4U;
        return true;
    }

    bool i32(std::int32_t& value) noexcept
    {
        std::uint32_t raw = 0U;
        if (!u32(raw)) {
            return false;
        }
        if (raw <= static_cast<std::uint32_t>(std::numeric_limits<std::int32_t>::max())) {
            value = static_cast<std::int32_t>(raw);
        } else {
            const std::uint32_t magnitude = (~raw) + 1U;
            value = static_cast<std::int32_t>(-static_cast<std::int64_t>(magnitude));
        }
        return true;
    }

    bool u64(std::uint64_t& value) noexcept
    {
        std::uint32_t low = 0U;
        std::uint32_t high = 0U;
        if (!u32(low) || !u32(high)) {
            return false;
        }
        value = static_cast<std::uint64_t>(low) |
                (static_cast<std::uint64_t>(high) << 32U);
        return true;
    }

    bool bytes(std::size_t length, ByteView& value) noexcept
    {
        if (length > remaining()) {
            return false;
        }
        value = ByteView{input_.data + offset_, length};
        offset_ += length;
        return true;
    }

    bool fixed_bytes(std::uint8_t* output, std::size_t length) noexcept
    {
        ByteView value{nullptr, 0U};
        if (!bytes(length, value)) {
            return false;
        }
        if (length != 0U) {
            std::memcpy(output, value.data, length);
        }
        return true;
    }

    bool finished() const noexcept { return offset_ == input_.size; }
    std::size_t remaining() const noexcept { return input_.size - offset_; }

private:
    ByteView input_;
    std::size_t offset_ = 0U;
};

class Writer final {
public:
    explicit Writer(MutableByteView output) noexcept : output_(output) {}

    void u8(std::uint8_t value) noexcept { output_.data[offset_++] = value; }

    void u16(std::uint16_t value) noexcept
    {
        output_.data[offset_++] = static_cast<std::uint8_t>(value);
        output_.data[offset_++] = static_cast<std::uint8_t>(value >> 8U);
    }

    void u32(std::uint32_t value) noexcept
    {
        output_.data[offset_++] = static_cast<std::uint8_t>(value);
        output_.data[offset_++] = static_cast<std::uint8_t>(value >> 8U);
        output_.data[offset_++] = static_cast<std::uint8_t>(value >> 16U);
        output_.data[offset_++] = static_cast<std::uint8_t>(value >> 24U);
    }

    void i32(std::int32_t value) noexcept
    {
        const std::uint32_t raw = value >= 0 ? static_cast<std::uint32_t>(value) :
            0U - static_cast<std::uint32_t>(-static_cast<std::int64_t>(value));
        u32(raw);
    }

    void u64(std::uint64_t value) noexcept
    {
        u32(static_cast<std::uint32_t>(value));
        u32(static_cast<std::uint32_t>(value >> 32U));
    }

    void bytes(ByteView value) noexcept
    {
        if (value.size != 0U) {
            // encode_frame permits an in-place payload staging buffer.  Keep
            // that documented-safe by handling overlapping source/output
            // ranges here.
            std::memmove(output_.data + offset_, value.data, value.size);
            offset_ += value.size;
        }
    }

    void fixed_bytes(const std::uint8_t* value, std::size_t length) noexcept
    {
        bytes(ByteView{value, length});
    }

    std::size_t size() const noexcept { return offset_; }

private:
    MutableByteView output_;
    std::size_t offset_ = 0U;
};

Result<void> prepare_output(MutableByteView output, std::size_t required) noexcept
{
    if (!valid_view(output)) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    if (output.size < required) {
        return Result<void>::failure(Error::BUFFER_TOO_SMALL);
    }
    return Result<void>::success();
}

template <typename T>
Result<T> malformed() noexcept
{
    return Result<T>::failure(Error::PROTOCOL_ERROR);
}

Result<std::size_t> invalid() noexcept
{
    return Result<std::size_t>::failure(Error::INVALID_ARGUMENT);
}

Result<std::size_t> output_error(const Result<void>& result) noexcept
{
    return Result<std::size_t>::failure(result.error());
}

bool valid_atr(ByteView atr) noexcept
{
    return valid_view(atr) && atr.size <= kMaxAtrLength;
}

bool valid_tune(const TuneRequestPayload& value) noexcept
{
    if (!valid_system(value.system) ||
        (value.lnb_voltage != 0U && value.lnb_voltage != 15U) ||
        value.timeout_ms < 100U || value.timeout_ms > 30000U) {
        return false;
    }
    if (value.system == System::ISDB_T) {
        return value.stream_id == 0xffffU && value.slot == 0xffffU &&
               value.bandwidth_hz == 6000000U;
    }
    return (value.stream_id == 0xffffU) != (value.slot == 0xffffU);
}

bool valid_receiver_record(const ReceiverRecord& value, std::size_t global) noexcept
{
    const auto expected_dev = static_cast<std::uint8_t>((global / 4U) + 1U);
    const auto expected_local = static_cast<std::uint8_t>(global % 4U);
    const System expected_system = expected_local < 2U ? System::ISDB_S : System::ISDB_T;
    return value.global_id == global && value.dev_id == expected_dev &&
           value.local_id == expected_local && value.system == expected_system;
}

void write_counters(Writer& writer, const CountersPayload& value) noexcept
{
    writer.u64(value.packets);
    writer.u64(value.bytes);
    writer.u64(value.sync_errors);
    writer.u64(value.tei_packets);
    writer.u64(value.continuity_errors);
    writer.u64(value.queue_drops);
    writer.u64(value.usb_errors);
    writer.u64(value.empty_intervals);
}

bool read_counters(Reader& reader, CountersPayload& value) noexcept
{
    return reader.u64(value.packets) && reader.u64(value.bytes) &&
           reader.u64(value.sync_errors) && reader.u64(value.tei_packets) &&
           reader.u64(value.continuity_errors) && reader.u64(value.queue_drops) &&
           reader.u64(value.usb_errors) && reader.u64(value.empty_intervals);
}

Result<void> validate_header_fields(const FrameHeader& header, Error error) noexcept
{
    if (!is_known_message_type(header.type) || header.major != kProtocolMajor ||
        header.minor != kProtocolMinor || header.payload_length > payload_limit(header.type)) {
        return Result<void>::failure(error);
    }
    if (is_event_message(header.type)) {
        if (header.kind != MessageKind::event || header.request_id != 0U) {
            return Result<void>::failure(error);
        }
    } else if (header.kind != MessageKind::request &&
               header.kind != MessageKind::response &&
               header.kind != MessageKind::error_response) {
        return Result<void>::failure(error);
    }
    return Result<void>::success();
}

bool version_at_most(std::uint16_t left_major, std::uint16_t left_minor,
                     std::uint16_t right_major, std::uint16_t right_minor) noexcept
{
    return left_major < right_major ||
           (left_major == right_major && left_minor <= right_minor);
}

bool includes_protocol_v1(const HelloRequestPayload& value) noexcept
{
    return version_at_most(value.min_major, value.min_minor, kProtocolMajor,
                           kProtocolMinor) &&
           version_at_most(kProtocolMajor, kProtocolMinor, value.max_major,
                           value.max_minor);
}

bool is_control_request(MessageType type) noexcept
{
    switch (type) {
    case MessageType::LIST:
    case MessageType::STATUS:
    case MessageType::ACQUIRE:
    case MessageType::RELEASE:
    case MessageType::TUNE:
    case MessageType::START_STREAM:
    case MessageType::STOP_STREAM:
    case MessageType::STATS:
    case MessageType::CARD_STATUS:
    case MessageType::CARD_CONNECT:
    case MessageType::CARD_RECONNECT:
    case MessageType::CARD_DISCONNECT:
    case MessageType::CARD_RESET:
    case MessageType::CARD_TRANSMIT:
    case MessageType::BEGIN_TRANSACTION:
    case MessageType::END_TRANSACTION:
        return true;
    case MessageType::HELLO:
    case MessageType::ATTACH_STREAM:
    case MessageType::TS_DATA:
    case MessageType::DEVICE_EVENT:
    case MessageType::STREAM_END:
        return false;
    }
    return false;
}

std::uint32_t required_capability(MessageType type) noexcept
{
    switch (type) {
    case MessageType::CARD_STATUS:
    case MessageType::CARD_CONNECT:
    case MessageType::CARD_RECONNECT:
    case MessageType::CARD_DISCONNECT:
    case MessageType::CARD_RESET:
    case MessageType::CARD_TRANSMIT:
    case MessageType::BEGIN_TRANSACTION:
    case MessageType::END_TRANSACTION:
        return kCapabilityCard;
    case MessageType::STATS:
        return kCapabilityStreamStats;
    default:
        return 0U;
    }
}

}  // namespace

Result<std::size_t> encode_empty_payload(MutableByteView output) noexcept
{
    const auto prepared = prepare_output(output, 0U);
    if (!prepared) {
        return output_error(prepared);
    }
    return Result<std::size_t>::success(0U);
}

Result<EmptyPayload> decode_empty_payload(ByteView input) noexcept
{
    if (!valid_view(input) || input.size != 0U) {
        return malformed<EmptyPayload>();
    }
    return Result<EmptyPayload>::success(EmptyPayload{});
}

Result<std::size_t> encode_payload(const HelloRequestPayload& value,
                                   MutableByteView output) noexcept
{
    if (!(value.min_major < value.max_major ||
          (value.min_major == value.max_major && value.min_minor <= value.max_minor))) {
        return invalid();
    }
    const auto prepared = prepare_output(output, 12U);
    if (!prepared) {
        return output_error(prepared);
    }
    Writer writer(output);
    writer.u16(value.min_major);
    writer.u16(value.min_minor);
    writer.u16(value.max_major);
    writer.u16(value.max_minor);
    writer.u32(value.requested_capabilities);
    return Result<std::size_t>::success(writer.size());
}

Result<HelloRequestPayload> decode_hello_request_payload(ByteView input) noexcept
{
    Reader reader(input);
    HelloRequestPayload value{};
    if (!valid_view(input) || !reader.u16(value.min_major) || !reader.u16(value.min_minor) ||
        !reader.u16(value.max_major) || !reader.u16(value.max_minor) ||
        !reader.u32(value.requested_capabilities) || !reader.finished() ||
        !(value.min_major < value.max_major ||
          (value.min_major == value.max_major && value.min_minor <= value.max_minor))) {
        return malformed<HelloRequestPayload>();
    }
    return Result<HelloRequestPayload>::success(value);
}

Result<std::size_t> encode_payload(const HelloResponsePayload& value,
                                   MutableByteView output) noexcept
{
    if (value.major != kProtocolMajor || value.minor != kProtocolMinor) {
        return invalid();
    }
    const auto prepared = prepare_output(output, 8U);
    if (!prepared) {
        return output_error(prepared);
    }
    Writer writer(output);
    writer.u16(value.major);
    writer.u16(value.minor);
    writer.u32(value.capabilities);
    return Result<std::size_t>::success(writer.size());
}

Result<HelloResponsePayload> decode_hello_response_payload(ByteView input) noexcept
{
    Reader reader(input);
    HelloResponsePayload value{};
    if (!valid_view(input) || !reader.u16(value.major) || !reader.u16(value.minor) ||
        !reader.u32(value.capabilities) || !reader.finished() ||
        value.major != kProtocolMajor || value.minor != kProtocolMinor) {
        return malformed<HelloResponsePayload>();
    }
    return Result<HelloResponsePayload>::success(value);
}

Result<std::size_t> encode_payload(const ListResponsePayload& value,
                                   MutableByteView output) noexcept
{
    if (!valid_utf8(value.serial_utf8) ||
        value.serial_utf8.size > std::numeric_limits<std::uint16_t>::max() ||
        !valid_boolean(value.ready) || (value.usb_present_mask & ~kUsbPresentMask) != 0U) {
        return invalid();
    }
    for (std::size_t index = 0U; index < value.receivers.size(); ++index) {
        if (!valid_receiver_record(value.receivers[index], index)) {
            return invalid();
        }
    }
    const std::size_t required = 46U + value.serial_utf8.size;
    if (required > kMaxControlPayload) {
        return invalid();
    }
    const auto prepared = prepare_output(output, required);
    if (!prepared) {
        return output_error(prepared);
    }
    Writer writer(output);
    writer.u64(value.generation);
    writer.u16(static_cast<std::uint16_t>(value.serial_utf8.size));
    writer.bytes(value.serial_utf8);
    writer.u8(value.ready);
    writer.u8(value.usb_present_mask);
    writer.u8(static_cast<std::uint8_t>(kReceiverCount));
    writer.u8(kCardReaderCount);
    for (const ReceiverRecord& receiver : value.receivers) {
        writer.u8(receiver.global_id);
        writer.u8(receiver.dev_id);
        writer.u8(receiver.local_id);
        writer.u8(static_cast<std::uint8_t>(receiver.system));
    }
    return Result<std::size_t>::success(writer.size());
}

Result<ListResponsePayload> decode_list_response_payload(ByteView input) noexcept
{
    Reader reader(input);
    ListResponsePayload value{};
    std::uint16_t serial_length = 0U;
    std::uint8_t receiver_count = 0U;
    std::uint8_t card_count = 0U;
    if (!valid_view(input) || input.size > kMaxControlPayload ||
        !reader.u64(value.generation) || !reader.u16(serial_length) ||
        !reader.bytes(serial_length, value.serial_utf8) || !valid_utf8(value.serial_utf8) ||
        !reader.u8(value.ready) || !reader.u8(value.usb_present_mask) ||
        !reader.u8(receiver_count) || !reader.u8(card_count) ||
        !valid_boolean(value.ready) || (value.usb_present_mask & ~kUsbPresentMask) != 0U ||
        receiver_count != kReceiverCount || card_count != kCardReaderCount) {
        return malformed<ListResponsePayload>();
    }
    for (std::size_t index = 0U; index < value.receivers.size(); ++index) {
        std::uint8_t system = 0U;
        ReceiverRecord& receiver = value.receivers[index];
        if (!reader.u8(receiver.global_id) || !reader.u8(receiver.dev_id) ||
            !reader.u8(receiver.local_id) || !reader.u8(system)) {
            return malformed<ListResponsePayload>();
        }
        receiver.system = static_cast<System>(system);
        if (!valid_receiver_record(receiver, index)) {
            return malformed<ListResponsePayload>();
        }
    }
    if (!reader.finished()) {
        return malformed<ListResponsePayload>();
    }
    return Result<ListResponsePayload>::success(value);
}

Result<std::size_t> encode_payload(const StatusResponsePayload& value,
                                   MutableByteView output) noexcept
{
    if (!valid_boolean(value.ready) || !valid_boolean(value.card_present) ||
        !valid_boolean(value.card_initialized) ||
        (value.usb_present_mask & ~kUsbPresentMask) != 0U) {
        return invalid();
    }
    for (const ReceiverState state : value.receiver_states) {
        if (!valid_receiver_state(state)) {
            return invalid();
        }
    }
    const auto prepared = prepare_output(output, 36U);
    if (!prepared) {
        return output_error(prepared);
    }
    Writer writer(output);
    writer.u64(value.generation);
    writer.u8(value.ready);
    writer.u8(value.usb_present_mask);
    writer.u8(value.card_present);
    writer.u8(value.card_initialized);
    for (const ReceiverState state : value.receiver_states) {
        writer.u8(static_cast<std::uint8_t>(state));
    }
    writer.u64(value.usb_errors);
    writer.u64(value.protocol_errors);
    return Result<std::size_t>::success(writer.size());
}

Result<StatusResponsePayload> decode_status_response_payload(ByteView input) noexcept
{
    Reader reader(input);
    StatusResponsePayload value{};
    if (!valid_view(input) || !reader.u64(value.generation) || !reader.u8(value.ready) ||
        !reader.u8(value.usb_present_mask) || !reader.u8(value.card_present) ||
        !reader.u8(value.card_initialized) || !valid_boolean(value.ready) ||
        !valid_boolean(value.card_present) || !valid_boolean(value.card_initialized) ||
        (value.usb_present_mask & ~kUsbPresentMask) != 0U) {
        return malformed<StatusResponsePayload>();
    }
    for (ReceiverState& state : value.receiver_states) {
        std::uint8_t raw = 0U;
        if (!reader.u8(raw)) {
            return malformed<StatusResponsePayload>();
        }
        state = static_cast<ReceiverState>(raw);
        if (!valid_receiver_state(state)) {
            return malformed<StatusResponsePayload>();
        }
    }
    if (!reader.u64(value.usb_errors) || !reader.u64(value.protocol_errors) ||
        !reader.finished()) {
        return malformed<StatusResponsePayload>();
    }
    return Result<StatusResponsePayload>::success(value);
}

Result<std::size_t> encode_payload(const AcquireRequestPayload& value,
                                   MutableByteView output) noexcept
{
    if (value.receiver_id >= kReceiverCount) {
        return invalid();
    }
    const auto prepared = prepare_output(output, 1U);
    if (!prepared) {
        return output_error(prepared);
    }
    output.data[0] = value.receiver_id;
    return Result<std::size_t>::success(1U);
}

Result<AcquireRequestPayload> decode_acquire_request_payload(ByteView input) noexcept
{
    Reader reader(input);
    AcquireRequestPayload value{};
    if (!valid_view(input) || !reader.u8(value.receiver_id) || !reader.finished() ||
        value.receiver_id >= kReceiverCount) {
        return malformed<AcquireRequestPayload>();
    }
    return Result<AcquireRequestPayload>::success(value);
}

Result<std::size_t> encode_payload(const AcquireResponsePayload& value,
                                   MutableByteView output) noexcept
{
    const auto prepared = prepare_output(output, 24U);
    if (!prepared) {
        return output_error(prepared);
    }
    Writer writer(output);
    writer.u64(value.lease_id);
    writer.fixed_bytes(value.nonce.data(), value.nonce.size());
    return Result<std::size_t>::success(writer.size());
}

Result<AcquireResponsePayload> decode_acquire_response_payload(ByteView input) noexcept
{
    Reader reader(input);
    AcquireResponsePayload value{};
    if (!valid_view(input) || !reader.u64(value.lease_id) ||
        !reader.fixed_bytes(value.nonce.data(), value.nonce.size()) || !reader.finished()) {
        return malformed<AcquireResponsePayload>();
    }
    return Result<AcquireResponsePayload>::success(value);
}

Result<std::size_t> encode_payload(const LeaseRequestPayload& value,
                                   MutableByteView output) noexcept
{
    const auto prepared = prepare_output(output, 8U);
    if (!prepared) {
        return output_error(prepared);
    }
    Writer writer(output);
    writer.u64(value.lease_id);
    return Result<std::size_t>::success(writer.size());
}

Result<LeaseRequestPayload> decode_lease_request_payload(ByteView input) noexcept
{
    Reader reader(input);
    LeaseRequestPayload value{};
    if (!valid_view(input) || !reader.u64(value.lease_id) || !reader.finished()) {
        return malformed<LeaseRequestPayload>();
    }
    return Result<LeaseRequestPayload>::success(value);
}

Result<std::size_t> encode_payload(const CardHandleRequestPayload& value,
                                   MutableByteView output) noexcept
{
    const auto prepared = prepare_output(output, 8U);
    if (!prepared) {
        return output_error(prepared);
    }
    Writer writer(output);
    writer.u64(value.card_handle);
    return Result<std::size_t>::success(writer.size());
}

Result<CardHandleRequestPayload> decode_card_handle_request_payload(ByteView input) noexcept
{
    Reader reader(input);
    CardHandleRequestPayload value{};
    if (!valid_view(input) || !reader.u64(value.card_handle) || !reader.finished()) {
        return malformed<CardHandleRequestPayload>();
    }
    return Result<CardHandleRequestPayload>::success(value);
}

Result<std::size_t> encode_payload(const TuneRequestPayload& value,
                                   MutableByteView output) noexcept
{
    if (!valid_tune(value)) {
        return invalid();
    }
    const auto prepared = prepare_output(output, 30U);
    if (!prepared) {
        return output_error(prepared);
    }
    Writer writer(output);
    writer.u64(value.lease_id);
    writer.u8(static_cast<std::uint8_t>(value.system));
    writer.u64(value.frequency_khz);
    writer.u16(value.stream_id);
    writer.u16(value.slot);
    writer.u32(value.bandwidth_hz);
    writer.u8(value.lnb_voltage);
    writer.u32(value.timeout_ms);
    return Result<std::size_t>::success(writer.size());
}

Result<TuneRequestPayload> decode_tune_request_payload(ByteView input) noexcept
{
    Reader reader(input);
    TuneRequestPayload value{};
    std::uint8_t system = 0U;
    if (!valid_view(input) || !reader.u64(value.lease_id) || !reader.u8(system) ||
        !reader.u64(value.frequency_khz) || !reader.u16(value.stream_id) ||
        !reader.u16(value.slot) || !reader.u32(value.bandwidth_hz) ||
        !reader.u8(value.lnb_voltage) || !reader.u32(value.timeout_ms) ||
        !reader.finished()) {
        return malformed<TuneRequestPayload>();
    }
    value.system = static_cast<System>(system);
    // Wire decoding separates structural/protocol validity from semantic
    // tune validation.  The control service owns the latter so a well-formed
    // request with an out-of-range timeout or parameter combination can
    // receive INVALID_ARGUMENT without poisoning the connection.
    if (!valid_system(value.system) ||
        (value.lnb_voltage != 0U && value.lnb_voltage != 15U)) {
        return malformed<TuneRequestPayload>();
    }
    return Result<TuneRequestPayload>::success(value);
}

Result<std::size_t> encode_payload(const TuneResponsePayload& value,
                                   MutableByteView output) noexcept
{
    if (!valid_boolean(value.locked)) {
        return invalid();
    }
    const auto prepared = prepare_output(output, 5U);
    if (!prepared) {
        return output_error(prepared);
    }
    Writer writer(output);
    writer.u8(value.locked);
    writer.i32(value.cnr_mdb);
    return Result<std::size_t>::success(writer.size());
}

Result<TuneResponsePayload> decode_tune_response_payload(ByteView input) noexcept
{
    Reader reader(input);
    TuneResponsePayload value{};
    if (!valid_view(input) || !reader.u8(value.locked) || !reader.i32(value.cnr_mdb) ||
        !reader.finished() || !valid_boolean(value.locked)) {
        return malformed<TuneResponsePayload>();
    }
    return Result<TuneResponsePayload>::success(value);
}

Result<std::size_t> encode_payload(const CountersPayload& value,
                                   MutableByteView output) noexcept
{
    const auto prepared = prepare_output(output, kCountersPayloadSize);
    if (!prepared) {
        return output_error(prepared);
    }
    Writer writer(output);
    write_counters(writer, value);
    return Result<std::size_t>::success(writer.size());
}

Result<CountersPayload> decode_counters_payload(ByteView input) noexcept
{
    Reader reader(input);
    CountersPayload value{};
    if (!valid_view(input) || !read_counters(reader, value) || !reader.finished()) {
        return malformed<CountersPayload>();
    }
    return Result<CountersPayload>::success(value);
}

Result<std::size_t> encode_payload(const CardStatusResponsePayload& value,
                                   MutableByteView output) noexcept
{
    if (!valid_boolean(value.present) || !valid_boolean(value.initialized) ||
        !valid_atr(value.atr) || (value.initialized == 0U && value.atr.size != 0U) ||
        (value.initialized != 0U && (value.present == 0U || value.atr.size == 0U))) {
        return invalid();
    }
    const std::size_t required = 11U + value.atr.size;
    const auto prepared = prepare_output(output, required);
    if (!prepared) {
        return output_error(prepared);
    }
    Writer writer(output);
    writer.u8(value.present);
    writer.u8(value.initialized);
    writer.u64(value.reader_generation);
    writer.u8(static_cast<std::uint8_t>(value.atr.size));
    writer.bytes(value.atr);
    return Result<std::size_t>::success(writer.size());
}

Result<CardStatusResponsePayload> decode_card_status_response_payload(ByteView input) noexcept
{
    Reader reader(input);
    CardStatusResponsePayload value{};
    std::uint8_t atr_length = 0U;
    if (!valid_view(input) || !reader.u8(value.present) || !reader.u8(value.initialized) ||
        !reader.u64(value.reader_generation) || !reader.u8(atr_length) ||
        atr_length > kMaxAtrLength || !reader.bytes(atr_length, value.atr) ||
        !reader.finished() || !valid_boolean(value.present) ||
        !valid_boolean(value.initialized) ||
        (value.initialized == 0U && value.atr.size != 0U) ||
        (value.initialized != 0U && (value.present == 0U || value.atr.size == 0U))) {
        return malformed<CardStatusResponsePayload>();
    }
    return Result<CardStatusResponsePayload>::success(value);
}

Result<std::size_t> encode_payload(const CardConnectRequestPayload& value,
                                   MutableByteView output) noexcept
{
    if (!valid_share_mode(value.share_mode)) {
        return invalid();
    }
    const auto prepared = prepare_output(output, 1U);
    if (!prepared) {
        return output_error(prepared);
    }
    output.data[0] = static_cast<std::uint8_t>(value.share_mode);
    return Result<std::size_t>::success(1U);
}

Result<CardConnectRequestPayload> decode_card_connect_request_payload(ByteView input) noexcept
{
    Reader reader(input);
    CardConnectRequestPayload value{};
    std::uint8_t raw = 0U;
    if (!valid_view(input) || !reader.u8(raw) || !reader.finished()) {
        return malformed<CardConnectRequestPayload>();
    }
    value.share_mode = static_cast<ShareMode>(raw);
    if (!valid_share_mode(value.share_mode)) {
        return malformed<CardConnectRequestPayload>();
    }
    return Result<CardConnectRequestPayload>::success(value);
}

Result<std::size_t> encode_payload(const CardConnectResponsePayload& value,
                                   MutableByteView output) noexcept
{
    if (!valid_atr(value.atr)) {
        return invalid();
    }
    const std::size_t required = 9U + value.atr.size;
    const auto prepared = prepare_output(output, required);
    if (!prepared) {
        return output_error(prepared);
    }
    Writer writer(output);
    writer.u64(value.card_handle);
    writer.u8(static_cast<std::uint8_t>(value.atr.size));
    writer.bytes(value.atr);
    return Result<std::size_t>::success(writer.size());
}

Result<CardConnectResponsePayload> decode_card_connect_response_payload(ByteView input) noexcept
{
    Reader reader(input);
    CardConnectResponsePayload value{};
    std::uint8_t atr_length = 0U;
    if (!valid_view(input) || !reader.u64(value.card_handle) || !reader.u8(atr_length) ||
        atr_length > kMaxAtrLength || !reader.bytes(atr_length, value.atr) ||
        !reader.finished()) {
        return malformed<CardConnectResponsePayload>();
    }
    return Result<CardConnectResponsePayload>::success(value);
}

Result<std::size_t> encode_payload(const CardReconnectRequestPayload& value,
                                   MutableByteView output) noexcept
{
    if (!valid_share_mode(value.share_mode) || !valid_disposition(value.disposition)) {
        return invalid();
    }
    const auto prepared = prepare_output(output, 10U);
    if (!prepared) {
        return output_error(prepared);
    }
    Writer writer(output);
    writer.u64(value.card_handle);
    writer.u8(static_cast<std::uint8_t>(value.share_mode));
    writer.u8(static_cast<std::uint8_t>(value.disposition));
    return Result<std::size_t>::success(writer.size());
}

Result<CardReconnectRequestPayload> decode_card_reconnect_request_payload(ByteView input) noexcept
{
    Reader reader(input);
    CardReconnectRequestPayload value{};
    std::uint8_t share_mode = 0U;
    std::uint8_t disposition = 0U;
    if (!valid_view(input) || !reader.u64(value.card_handle) || !reader.u8(share_mode) ||
        !reader.u8(disposition) || !reader.finished()) {
        return malformed<CardReconnectRequestPayload>();
    }
    value.share_mode = static_cast<ShareMode>(share_mode);
    value.disposition = static_cast<Disposition>(disposition);
    if (!valid_share_mode(value.share_mode) || !valid_disposition(value.disposition)) {
        return malformed<CardReconnectRequestPayload>();
    }
    return Result<CardReconnectRequestPayload>::success(value);
}

Result<std::size_t> encode_payload(const AtrPayload& value, MutableByteView output) noexcept
{
    if (!valid_atr(value.atr)) {
        return invalid();
    }
    const std::size_t required = 1U + value.atr.size;
    const auto prepared = prepare_output(output, required);
    if (!prepared) {
        return output_error(prepared);
    }
    Writer writer(output);
    writer.u8(static_cast<std::uint8_t>(value.atr.size));
    writer.bytes(value.atr);
    return Result<std::size_t>::success(writer.size());
}

Result<AtrPayload> decode_atr_payload(ByteView input) noexcept
{
    Reader reader(input);
    AtrPayload value{};
    std::uint8_t length = 0U;
    if (!valid_view(input) || !reader.u8(length) || length > kMaxAtrLength ||
        !reader.bytes(length, value.atr) || !reader.finished()) {
        return malformed<AtrPayload>();
    }
    return Result<AtrPayload>::success(value);
}

Result<std::size_t> encode_payload(const CardDispositionRequestPayload& value,
                                   MutableByteView output) noexcept
{
    if (!valid_disposition(value.disposition)) {
        return invalid();
    }
    const auto prepared = prepare_output(output, 9U);
    if (!prepared) {
        return output_error(prepared);
    }
    Writer writer(output);
    writer.u64(value.card_handle);
    writer.u8(static_cast<std::uint8_t>(value.disposition));
    return Result<std::size_t>::success(writer.size());
}

Result<CardDispositionRequestPayload> decode_card_disposition_request_payload(
    ByteView input) noexcept
{
    Reader reader(input);
    CardDispositionRequestPayload value{};
    std::uint8_t disposition = 0U;
    if (!valid_view(input) || !reader.u64(value.card_handle) ||
        !reader.u8(disposition) || !reader.finished()) {
        return malformed<CardDispositionRequestPayload>();
    }
    value.disposition = static_cast<Disposition>(disposition);
    if (!valid_disposition(value.disposition)) {
        return malformed<CardDispositionRequestPayload>();
    }
    return Result<CardDispositionRequestPayload>::success(value);
}

Result<std::size_t> encode_payload(const CardTransmitRequestPayload& value,
                                   MutableByteView output) noexcept
{
    if (!valid_view(value.apdu) || value.apdu.size > kMaxCardPayload) {
        return invalid();
    }
    const std::size_t required = 12U + value.apdu.size;
    const auto prepared = prepare_output(output, required);
    if (!prepared) {
        return output_error(prepared);
    }
    Writer writer(output);
    writer.u64(value.card_handle);
    writer.u32(static_cast<std::uint32_t>(value.apdu.size));
    writer.bytes(value.apdu);
    return Result<std::size_t>::success(writer.size());
}

Result<CardTransmitRequestPayload> decode_card_transmit_request_payload(ByteView input) noexcept
{
    Reader reader(input);
    CardTransmitRequestPayload value{};
    std::uint32_t length = 0U;
    if (!valid_view(input) || !reader.u64(value.card_handle) || !reader.u32(length) ||
        length > kMaxCardPayload || !reader.bytes(length, value.apdu) || !reader.finished()) {
        return malformed<CardTransmitRequestPayload>();
    }
    return Result<CardTransmitRequestPayload>::success(value);
}

Result<std::size_t> encode_payload(const CardTransmitResponsePayload& value,
                                   MutableByteView output) noexcept
{
    if (!valid_view(value.response) || value.response.size > kMaxCardPayload) {
        return invalid();
    }
    const std::size_t required = 4U + value.response.size;
    const auto prepared = prepare_output(output, required);
    if (!prepared) {
        return output_error(prepared);
    }
    Writer writer(output);
    writer.u32(static_cast<std::uint32_t>(value.response.size));
    writer.bytes(value.response);
    return Result<std::size_t>::success(writer.size());
}

Result<CardTransmitResponsePayload> decode_card_transmit_response_payload(ByteView input) noexcept
{
    Reader reader(input);
    CardTransmitResponsePayload value{};
    std::uint32_t length = 0U;
    if (!valid_view(input) || !reader.u32(length) || length > kMaxCardPayload ||
        !reader.bytes(length, value.response) || !reader.finished()) {
        return malformed<CardTransmitResponsePayload>();
    }
    return Result<CardTransmitResponsePayload>::success(value);
}

Result<std::size_t> encode_payload(const AttachStreamRequestPayload& value,
                                   MutableByteView output) noexcept
{
    const auto prepared = prepare_output(output, 24U);
    if (!prepared) {
        return output_error(prepared);
    }
    Writer writer(output);
    writer.u64(value.lease_id);
    writer.fixed_bytes(value.nonce.data(), value.nonce.size());
    return Result<std::size_t>::success(writer.size());
}

Result<AttachStreamRequestPayload> decode_attach_stream_request_payload(ByteView input) noexcept
{
    Reader reader(input);
    AttachStreamRequestPayload value{};
    if (!valid_view(input) || !reader.u64(value.lease_id) ||
        !reader.fixed_bytes(value.nonce.data(), value.nonce.size()) || !reader.finished()) {
        return malformed<AttachStreamRequestPayload>();
    }
    return Result<AttachStreamRequestPayload>::success(value);
}

Result<std::size_t> encode_payload(const TsDataEventPayload& value,
                                   MutableByteView output) noexcept
{
    if (!valid_view(value.bytes) || value.bytes.size > kMaxTsBytes ||
        value.bytes.size % 188U != 0U) {
        return invalid();
    }
    const std::size_t required = 20U + value.bytes.size;
    const auto prepared = prepare_output(output, required);
    if (!prepared) {
        return output_error(prepared);
    }
    Writer writer(output);
    writer.u64(value.sequence);
    writer.u64(value.cumulative_drop_count);
    writer.u32(static_cast<std::uint32_t>(value.bytes.size));
    writer.bytes(value.bytes);
    return Result<std::size_t>::success(writer.size());
}

Result<TsDataEventPayload> decode_ts_data_event_payload(ByteView input) noexcept
{
    Reader reader(input);
    TsDataEventPayload value{};
    std::uint32_t length = 0U;
    if (!valid_view(input) || !reader.u64(value.sequence) ||
        !reader.u64(value.cumulative_drop_count) || !reader.u32(length) ||
        length > kMaxTsBytes || length % 188U != 0U ||
        !reader.bytes(length, value.bytes) || !reader.finished()) {
        return malformed<TsDataEventPayload>();
    }
    return Result<TsDataEventPayload>::success(value);
}

Result<std::size_t> encode_payload(const DeviceEventPayload& value,
                                   MutableByteView output) noexcept
{
    if (!valid_device_event_kind(value.kind) ||
        !valid_event_target(value.target_type, value.target_id)) {
        return invalid();
    }
    const auto prepared = prepare_output(output, 11U);
    if (!prepared) {
        return output_error(prepared);
    }
    Writer writer(output);
    writer.u64(value.generation);
    writer.u8(static_cast<std::uint8_t>(value.kind));
    writer.u8(static_cast<std::uint8_t>(value.target_type));
    writer.u8(value.target_id);
    return Result<std::size_t>::success(writer.size());
}

Result<DeviceEventPayload> decode_device_event_payload(ByteView input) noexcept
{
    Reader reader(input);
    DeviceEventPayload value{};
    std::uint8_t kind = 0U;
    std::uint8_t target_type = 0U;
    if (!valid_view(input) || !reader.u64(value.generation) || !reader.u8(kind) ||
        !reader.u8(target_type) || !reader.u8(value.target_id) || !reader.finished()) {
        return malformed<DeviceEventPayload>();
    }
    value.kind = static_cast<DeviceEventKind>(kind);
    value.target_type = static_cast<EventTargetType>(target_type);
    if (!valid_device_event_kind(value.kind) ||
        !valid_event_target(value.target_type, value.target_id)) {
        return malformed<DeviceEventPayload>();
    }
    return Result<DeviceEventPayload>::success(value);
}

Result<std::size_t> encode_payload(const StreamEndEventPayload& value,
                                   MutableByteView output) noexcept
{
    if (!is_known_error_code(value.error_code)) {
        return invalid();
    }
    const auto prepared = prepare_output(output, 68U);
    if (!prepared) {
        return output_error(prepared);
    }
    Writer writer(output);
    write_counters(writer, value.counters);
    writer.u32(static_cast<std::uint32_t>(value.error_code));
    return Result<std::size_t>::success(writer.size());
}

Result<StreamEndEventPayload> decode_stream_end_event_payload(ByteView input) noexcept
{
    Reader reader(input);
    StreamEndEventPayload value{};
    std::uint32_t error_code = 0U;
    if (!valid_view(input) || !read_counters(reader, value.counters) ||
        !reader.u32(error_code) || !reader.finished()) {
        return malformed<StreamEndEventPayload>();
    }
    value.error_code = static_cast<ErrorCode>(error_code);
    if (!is_known_error_code(value.error_code)) {
        return malformed<StreamEndEventPayload>();
    }
    return Result<StreamEndEventPayload>::success(value);
}

Result<std::size_t> encode_payload(const ErrorResponsePayload& value,
                                   MutableByteView output) noexcept
{
    if (value.error_code == ErrorCode::OK || !is_known_error_code(value.error_code) ||
        !valid_utf8(value.detail_utf8) ||
        value.detail_utf8.size > std::numeric_limits<std::uint16_t>::max() ||
        value.detail_utf8.size > kMaxControlPayload - 6U) {
        return invalid();
    }
    const std::size_t required = 6U + value.detail_utf8.size;
    const auto prepared = prepare_output(output, required);
    if (!prepared) {
        return output_error(prepared);
    }
    Writer writer(output);
    writer.u32(static_cast<std::uint32_t>(value.error_code));
    writer.u16(static_cast<std::uint16_t>(value.detail_utf8.size));
    writer.bytes(value.detail_utf8);
    return Result<std::size_t>::success(writer.size());
}

Result<ErrorResponsePayload> decode_error_response_payload(ByteView input) noexcept
{
    Reader reader(input);
    ErrorResponsePayload value{};
    std::uint32_t error_code = 0U;
    std::uint16_t detail_length = 0U;
    if (!valid_view(input) || input.size > kMaxControlPayload || !reader.u32(error_code) ||
        !reader.u16(detail_length) || !reader.bytes(detail_length, value.detail_utf8) ||
        !reader.finished() || !valid_utf8(value.detail_utf8)) {
        return malformed<ErrorResponsePayload>();
    }
    value.error_code = static_cast<ErrorCode>(error_code);
    if (value.error_code == ErrorCode::OK || !is_known_error_code(value.error_code)) {
        return malformed<ErrorResponsePayload>();
    }
    return Result<ErrorResponsePayload>::success(value);
}

bool is_known_message_type(MessageType type) noexcept
{
    switch (type) {
    case MessageType::HELLO:
    case MessageType::LIST:
    case MessageType::STATUS:
    case MessageType::ACQUIRE:
    case MessageType::RELEASE:
    case MessageType::TUNE:
    case MessageType::START_STREAM:
    case MessageType::STOP_STREAM:
    case MessageType::STATS:
    case MessageType::CARD_STATUS:
    case MessageType::CARD_CONNECT:
    case MessageType::CARD_RECONNECT:
    case MessageType::CARD_DISCONNECT:
    case MessageType::CARD_RESET:
    case MessageType::CARD_TRANSMIT:
    case MessageType::BEGIN_TRANSACTION:
    case MessageType::END_TRANSACTION:
    case MessageType::ATTACH_STREAM:
    case MessageType::TS_DATA:
    case MessageType::DEVICE_EVENT:
    case MessageType::STREAM_END:
        return true;
    }
    return false;
}

bool is_event_message(MessageType type) noexcept
{
    return type == MessageType::TS_DATA || type == MessageType::DEVICE_EVENT ||
           type == MessageType::STREAM_END;
}

bool is_known_error_code(ErrorCode code) noexcept
{
    const std::uint32_t value = static_cast<std::uint32_t>(code);
    return value <= static_cast<std::uint32_t>(ErrorCode::SLOW_CONSUMER) ||
           code == ErrorCode::INTERNAL;
}

std::size_t payload_limit(MessageType type) noexcept
{
    return type == MessageType::TS_DATA ? kMaxTsDataPayload : kMaxControlPayload;
}

Result<void> validate_payload(MessageType type, MessageKind kind, ByteView payload) noexcept
{
    if (!valid_view(payload) || !is_known_message_type(type) ||
        payload.size > payload_limit(type)) {
        return Result<void>::failure(Error::PROTOCOL_ERROR);
    }
    if (kind == MessageKind::error_response) {
        if (is_event_message(type) || !decode_error_response_payload(payload)) {
            return Result<void>::failure(Error::PROTOCOL_ERROR);
        }
        return Result<void>::success();
    }
    if (is_event_message(type)) {
        if (kind != MessageKind::event) {
            return Result<void>::failure(Error::PROTOCOL_ERROR);
        }
    } else if (kind != MessageKind::request && kind != MessageKind::response) {
        return Result<void>::failure(Error::PROTOCOL_ERROR);
    }

    bool valid = false;
    switch (type) {
    case MessageType::HELLO:
        valid = kind == MessageKind::request ?
                    static_cast<bool>(decode_hello_request_payload(payload)) :
                    static_cast<bool>(decode_hello_response_payload(payload));
        break;
    case MessageType::LIST:
        valid = kind == MessageKind::request ? static_cast<bool>(decode_empty_payload(payload)) :
                                               static_cast<bool>(decode_list_response_payload(payload));
        break;
    case MessageType::STATUS:
        valid = kind == MessageKind::request ? static_cast<bool>(decode_empty_payload(payload)) :
                    static_cast<bool>(decode_status_response_payload(payload));
        break;
    case MessageType::ACQUIRE:
        valid = kind == MessageKind::request ?
                    static_cast<bool>(decode_acquire_request_payload(payload)) :
                    static_cast<bool>(decode_acquire_response_payload(payload));
        break;
    case MessageType::RELEASE:
    case MessageType::START_STREAM:
        valid = kind == MessageKind::request ? static_cast<bool>(decode_lease_request_payload(payload)) :
                                               static_cast<bool>(decode_empty_payload(payload));
        break;
    case MessageType::BEGIN_TRANSACTION:
        valid = kind == MessageKind::request ?
                    static_cast<bool>(decode_card_handle_request_payload(payload)) :
                    static_cast<bool>(decode_empty_payload(payload));
        break;
    case MessageType::TUNE:
        valid = kind == MessageKind::request ? static_cast<bool>(decode_tune_request_payload(payload)) :
                                               static_cast<bool>(decode_tune_response_payload(payload));
        break;
    case MessageType::STOP_STREAM:
    case MessageType::STATS:
        valid = kind == MessageKind::request ? static_cast<bool>(decode_lease_request_payload(payload)) :
                                               static_cast<bool>(decode_counters_payload(payload));
        break;
    case MessageType::CARD_STATUS:
        valid = kind == MessageKind::request ? static_cast<bool>(decode_empty_payload(payload)) :
                    static_cast<bool>(decode_card_status_response_payload(payload));
        break;
    case MessageType::CARD_CONNECT:
        valid = kind == MessageKind::request ?
                    static_cast<bool>(decode_card_connect_request_payload(payload)) :
                    static_cast<bool>(decode_card_connect_response_payload(payload));
        break;
    case MessageType::CARD_RECONNECT:
        valid = kind == MessageKind::request ?
                    static_cast<bool>(decode_card_reconnect_request_payload(payload)) :
                    static_cast<bool>(decode_atr_payload(payload));
        break;
    case MessageType::CARD_DISCONNECT:
    case MessageType::END_TRANSACTION:
        valid = kind == MessageKind::request ?
                    static_cast<bool>(decode_card_disposition_request_payload(payload)) :
                    static_cast<bool>(decode_empty_payload(payload));
        break;
    case MessageType::CARD_RESET:
        valid = kind == MessageKind::request ?
                    static_cast<bool>(decode_card_handle_request_payload(payload)) :
                    static_cast<bool>(decode_atr_payload(payload));
        break;
    case MessageType::CARD_TRANSMIT:
        valid = kind == MessageKind::request ?
                    static_cast<bool>(decode_card_transmit_request_payload(payload)) :
                    static_cast<bool>(decode_card_transmit_response_payload(payload));
        break;
    case MessageType::ATTACH_STREAM:
        valid = kind == MessageKind::request ?
                    static_cast<bool>(decode_attach_stream_request_payload(payload)) :
                    static_cast<bool>(decode_empty_payload(payload));
        break;
    case MessageType::TS_DATA:
        valid = static_cast<bool>(decode_ts_data_event_payload(payload));
        break;
    case MessageType::DEVICE_EVENT:
        valid = static_cast<bool>(decode_device_event_payload(payload));
        break;
    case MessageType::STREAM_END:
        valid = static_cast<bool>(decode_stream_end_event_payload(payload));
        break;
    }
    return valid ? Result<void>::success() : Result<void>::failure(Error::PROTOCOL_ERROR);
}

Result<void> validate_frame_view(const FrameView& frame) noexcept
{
    if (!valid_view(frame.payload) || frame.header.payload_length != frame.payload.size) {
        return Result<void>::failure(Error::PROTOCOL_ERROR);
    }
    const auto header = validate_header_fields(frame.header, Error::PROTOCOL_ERROR);
    if (!header || !validate_payload(frame.header.type, frame.header.kind, frame.payload)) {
        return Result<void>::failure(Error::PROTOCOL_ERROR);
    }
    return Result<void>::success();
}

Result<void> validate_response_to_request(const FrameHeader& request,
                                          const FrameHeader& response) noexcept
{
    if (is_event_message(request.type) || request.kind != MessageKind::request ||
        (response.kind != MessageKind::response &&
         response.kind != MessageKind::error_response) ||
        request.major != response.major || request.minor != response.minor ||
        request.type != response.type || request.request_id != response.request_id) {
        return Result<void>::failure(Error::PROTOCOL_ERROR);
    }
    return Result<void>::success();
}

Result<FrameHeader> decode_frame_header(ByteView input) noexcept
{
    if (!valid_view(input) || input.size != kFrameHeaderSize) {
        return malformed<FrameHeader>();
    }
    if (std::memcmp(input.data, kMagic.data(), kMagic.size()) != 0) {
        return malformed<FrameHeader>();
    }
    Reader reader(ByteView{input.data + 4U, input.size - 4U});
    FrameHeader header{};
    std::uint16_t type = 0U;
    std::uint16_t flags = 0U;
    if (!reader.u16(header.major) || !reader.u16(header.minor) || !reader.u16(type) ||
        !reader.u16(flags) || !reader.u32(header.request_id) ||
        !reader.u32(header.payload_length) || !reader.finished()) {
        return malformed<FrameHeader>();
    }
    if (header.major != kProtocolMajor || header.minor != kProtocolMinor) {
        return Result<FrameHeader>::failure(Error::VERSION_MISMATCH);
    }
    header.type = static_cast<MessageType>(type);
    if (!is_known_message_type(header.type) || (flags & ~kKnownFlags) != 0U ||
        flags == kErrorFlag) {
        return malformed<FrameHeader>();
    }
    if (flags == (kResponseFlag | kErrorFlag)) {
        header.kind = MessageKind::error_response;
    } else if (flags == kResponseFlag) {
        header.kind = MessageKind::response;
    } else if (is_event_message(header.type)) {
        header.kind = MessageKind::event;
    } else {
        header.kind = MessageKind::request;
    }
    const auto validated = validate_header_fields(header, Error::PROTOCOL_ERROR);
    if (!validated) {
        return Result<FrameHeader>::failure(validated.error());
    }
    return Result<FrameHeader>::success(header);
}

Result<std::size_t> encode_frame(const FrameHeader& header, ByteView payload,
                                 MutableByteView output) noexcept
{
    if (!valid_view(payload) || header.payload_length != payload.size) {
        return invalid();
    }
    const auto header_result = validate_header_fields(header, Error::INVALID_ARGUMENT);
    if (!header_result || !validate_payload(header.type, header.kind, payload)) {
        return invalid();
    }
    const std::size_t required = kFrameHeaderSize + payload.size;
    const auto prepared = prepare_output(output, required);
    if (!prepared) {
        return output_error(prepared);
    }
    Writer writer(output);
    writer.fixed_bytes(kMagic.data(), kMagic.size());
    writer.u16(header.major);
    writer.u16(header.minor);
    writer.u16(static_cast<std::uint16_t>(header.type));
    std::uint16_t flags = 0U;
    if (header.kind == MessageKind::response) {
        flags = kResponseFlag;
    } else if (header.kind == MessageKind::error_response) {
        flags = kResponseFlag | kErrorFlag;
    }
    writer.u16(flags);
    writer.u32(header.request_id);
    writer.u32(header.payload_length);
    writer.bytes(payload);
    return Result<std::size_t>::success(writer.size());
}

Result<FrameView> decode_frame(ByteView frame) noexcept
{
    if (!valid_view(frame) || frame.size < kFrameHeaderSize) {
        return malformed<FrameView>();
    }
    const auto decoded_header = decode_frame_header(ByteView{frame.data, kFrameHeaderSize});
    if (!decoded_header) {
        return Result<FrameView>::failure(decoded_header.error());
    }
    const FrameHeader& header = decoded_header.value();
    if (frame.size - kFrameHeaderSize != header.payload_length) {
        return malformed<FrameView>();
    }
    const ByteView payload{frame.data + kFrameHeaderSize, header.payload_length};
    if (!validate_payload(header.type, header.kind, payload)) {
        return malformed<FrameView>();
    }
    return Result<FrameView>::success(FrameView{header, payload});
}

StreamFramer::StreamFramer(MutableByteView storage) noexcept : storage_(storage) {}

Result<void> StreamFramer::fail(Error error) noexcept
{
    failed_ = true;
    failure_ = error;
    return Result<void>::failure(error);
}

Result<std::size_t> StreamFramer::feed(ByteView input, FrameConsumer& consumer) noexcept
{
    if (failed_) {
        return Result<std::size_t>::failure(failure_);
    }
    if (!valid_view(input) || !valid_view(storage_) || storage_.size < kFrameHeaderSize) {
        return Result<std::size_t>::failure(Error::INVALID_ARGUMENT);
    }

    std::size_t input_offset = 0U;
    std::size_t completed = 0U;
    while (input_offset < input.size) {
        if (buffered_ < kFrameHeaderSize) {
            const std::size_t amount =
                std::min(kFrameHeaderSize - buffered_, input.size - input_offset);
            std::memcpy(storage_.data + buffered_, input.data + input_offset, amount);
            buffered_ += amount;
            input_offset += amount;
            if (buffered_ < kFrameHeaderSize) {
                continue;
            }
            const auto header =
                decode_frame_header(ByteView{storage_.data, kFrameHeaderSize});
            if (!header) {
                (void)fail(header.error());
                return Result<std::size_t>::failure(header.error());
            }
            expected_ = kFrameHeaderSize + header.value().payload_length;
            if (expected_ > storage_.size) {
                (void)fail(Error::BUFFER_TOO_SMALL);
                return Result<std::size_t>::failure(Error::BUFFER_TOO_SMALL);
            }
        }

        if (buffered_ < expected_) {
            const std::size_t amount =
                std::min(expected_ - buffered_, input.size - input_offset);
            std::memcpy(storage_.data + buffered_, input.data + input_offset, amount);
            buffered_ += amount;
            input_offset += amount;
            if (buffered_ < expected_) {
                continue;
            }
        }

        const auto frame = decode_frame(ByteView{storage_.data, expected_});
        if (!frame) {
            (void)fail(frame.error());
            return Result<std::size_t>::failure(frame.error());
        }
        const auto consumed = consumer.on_frame(frame.value());
        if (!consumed) {
            (void)fail(consumed.error());
            return Result<std::size_t>::failure(consumed.error());
        }
        buffered_ = 0U;
        expected_ = 0U;
        ++completed;
    }
    return Result<std::size_t>::success(completed);
}

void StreamFramer::reset() noexcept
{
    buffered_ = 0U;
    expected_ = 0U;
    failed_ = false;
    failure_ = Error::OK;
}

ConnectionStateMachine::ConnectionStateMachine(
    ConnectionRole role, std::uint32_t server_supported_capabilities) noexcept
    : role_(role),
      server_supported_capabilities_(server_supported_capabilities & kKnownCapabilities)
{
}

ConnectionResult ConnectionStateMachine::accepted(ConnectionEvent event,
                                                   MessageType type) const noexcept
{
    return ConnectionResult{event, type, negotiated_capabilities_};
}

void ConnectionStateMachine::set_pending(const FrameHeader& header) noexcept
{
    pending_header_ = header;
    pending_ = true;
}

void ConnectionStateMachine::clear_pending() noexcept
{
    pending_header_ = FrameHeader{};
    pending_ = false;
}

Result<ConnectionResult> ConnectionStateMachine::violation(Error error) noexcept
{
    phase_ = ConnectionPhase::poisoned;
    clear_pending();
    return Result<ConnectionResult>::failure(error);
}

Result<HelloResponsePayload> ConnectionStateMachine::pending_hello_response() const noexcept
{
    if (role_ != ConnectionRole::control_server || phase_ != ConnectionPhase::handshake ||
        !pending_ || pending_header_.type != MessageType::HELLO || !hello_compatible_) {
        return Result<HelloResponsePayload>::failure(Error::NOT_READY);
    }
    return Result<HelloResponsePayload>::success(
        HelloResponsePayload{kProtocolMajor, kProtocolMinor, negotiated_capabilities_});
}

Result<ConnectionResult> ConnectionStateMachine::process_outbound(
    const FrameView& frame) noexcept
{
    if (phase_ == ConnectionPhase::poisoned) {
        return Result<ConnectionResult>::failure(Error::PROTOCOL_ERROR);
    }
    if (phase_ == ConnectionPhase::closed) {
        return Result<ConnectionResult>::failure(Error::DISCONNECTED);
    }
    if (!validate_frame_view(frame)) {
        return violation();
    }
    switch (role_) {
    case ConnectionRole::control_client:
        return process_control_client(frame, true);
    case ConnectionRole::control_server:
        return process_control_server(frame, true);
    case ConnectionRole::stream_client:
        return process_stream_client(frame, true);
    case ConnectionRole::stream_server:
        return process_stream_server(frame, true);
    }
    return violation();
}

Result<ConnectionResult> ConnectionStateMachine::process_inbound(
    const FrameView& frame) noexcept
{
    if (phase_ == ConnectionPhase::poisoned) {
        return Result<ConnectionResult>::failure(Error::PROTOCOL_ERROR);
    }
    if (phase_ == ConnectionPhase::closed) {
        return Result<ConnectionResult>::failure(Error::DISCONNECTED);
    }
    if (!validate_frame_view(frame)) {
        return violation();
    }
    switch (role_) {
    case ConnectionRole::control_client:
        return process_control_client(frame, false);
    case ConnectionRole::control_server:
        return process_control_server(frame, false);
    case ConnectionRole::stream_client:
        return process_stream_client(frame, false);
    case ConnectionRole::stream_server:
        return process_stream_server(frame, false);
    }
    return violation();
}

Result<ConnectionResult> ConnectionStateMachine::process_control_client(
    const FrameView& frame, bool outbound) noexcept
{
    if (phase_ == ConnectionPhase::initial) {
        if (!outbound || frame.header.kind != MessageKind::request ||
            frame.header.type != MessageType::HELLO) {
            return violation();
        }
        const auto hello = decode_hello_request_payload(frame.payload);
        if (!hello) {
            return violation();
        }
        requested_capabilities_ = hello.value().requested_capabilities;
        set_pending(frame.header);
        phase_ = ConnectionPhase::handshake;
        return Result<ConnectionResult>::success(
            accepted(ConnectionEvent::request_accepted, frame.header.type));
    }

    if (phase_ == ConnectionPhase::handshake) {
        if (outbound || !pending_ ||
            (frame.header.kind != MessageKind::response &&
             frame.header.kind != MessageKind::error_response) ||
            !validate_response_to_request(pending_header_, frame.header)) {
            return violation();
        }
        if (frame.header.kind == MessageKind::error_response) {
            clear_pending();
            phase_ = ConnectionPhase::closed;
            return Result<ConnectionResult>::success(
                accepted(ConnectionEvent::response_accepted, frame.header.type));
        }
        const auto hello = decode_hello_response_payload(frame.payload);
        if (!hello) {
            return violation();
        }
        const std::uint32_t known_response = hello.value().capabilities & kKnownCapabilities;
        const std::uint32_t known_requested = requested_capabilities_ & kKnownCapabilities;
        if ((known_response & ~known_requested) != 0U) {
            return violation();
        }
        negotiated_capabilities_ = known_response;
        clear_pending();
        phase_ = ConnectionPhase::active;
        return Result<ConnectionResult>::success(
            accepted(ConnectionEvent::response_accepted, frame.header.type));
    }

    if (outbound) {
        if (pending_ || frame.header.kind != MessageKind::request ||
            !is_control_request(frame.header.type)) {
            return violation();
        }
        const std::uint32_t capability = required_capability(frame.header.type);
        if (capability != 0U && (negotiated_capabilities_ & capability) == 0U) {
            return violation();
        }
        set_pending(frame.header);
        return Result<ConnectionResult>::success(
            accepted(ConnectionEvent::request_accepted, frame.header.type));
    }

    if (frame.header.kind == MessageKind::event &&
        frame.header.type == MessageType::DEVICE_EVENT) {
        if ((negotiated_capabilities_ & kCapabilityEvents) == 0U) {
            return violation();
        }
        return Result<ConnectionResult>::success(
            accepted(ConnectionEvent::event_accepted, frame.header.type));
    }
    if (!pending_ ||
        (frame.header.kind != MessageKind::response &&
         frame.header.kind != MessageKind::error_response) ||
        !validate_response_to_request(pending_header_, frame.header)) {
        return violation();
    }
    clear_pending();
    return Result<ConnectionResult>::success(
        accepted(ConnectionEvent::response_accepted, frame.header.type));
}

Result<ConnectionResult> ConnectionStateMachine::process_control_server(
    const FrameView& frame, bool outbound) noexcept
{
    if (phase_ == ConnectionPhase::initial) {
        if (outbound || frame.header.kind != MessageKind::request ||
            frame.header.type != MessageType::HELLO) {
            return violation();
        }
        const auto hello = decode_hello_request_payload(frame.payload);
        if (!hello) {
            return violation();
        }
        requested_capabilities_ = hello.value().requested_capabilities;
        hello_compatible_ = includes_protocol_v1(hello.value());
        negotiated_capabilities_ =
            (requested_capabilities_ & kKnownCapabilities) & server_supported_capabilities_;
        set_pending(frame.header);
        phase_ = ConnectionPhase::handshake;
        const ConnectionEvent event = hello_compatible_ ?
            ConnectionEvent::hello_response_required :
            ConnectionEvent::version_mismatch_response_required;
        return Result<ConnectionResult>::success(accepted(event, frame.header.type));
    }

    if (phase_ == ConnectionPhase::handshake) {
        if (!outbound || !pending_ ||
            (frame.header.kind != MessageKind::response &&
             frame.header.kind != MessageKind::error_response) ||
            !validate_response_to_request(pending_header_, frame.header)) {
            return violation();
        }
        if (hello_compatible_) {
            if (frame.header.kind != MessageKind::response) {
                return violation();
            }
            const auto hello = decode_hello_response_payload(frame.payload);
            if (!hello || hello.value().major != kProtocolMajor ||
                hello.value().minor != kProtocolMinor ||
                hello.value().capabilities != negotiated_capabilities_) {
                return violation();
            }
            clear_pending();
            phase_ = ConnectionPhase::active;
        } else {
            if (frame.header.kind != MessageKind::error_response) {
                return violation();
            }
            const auto error = decode_error_response_payload(frame.payload);
            if (!error || error.value().error_code != ErrorCode::VERSION_MISMATCH) {
                return violation();
            }
            clear_pending();
            phase_ = ConnectionPhase::closed;
        }
        return Result<ConnectionResult>::success(
            accepted(ConnectionEvent::response_accepted, frame.header.type));
    }

    if (!outbound) {
        if (pending_ || frame.header.kind != MessageKind::request ||
            !is_control_request(frame.header.type)) {
            return violation();
        }
        const std::uint32_t capability = required_capability(frame.header.type);
        if (capability != 0U && (negotiated_capabilities_ & capability) == 0U) {
            return violation();
        }
        set_pending(frame.header);
        return Result<ConnectionResult>::success(
            accepted(ConnectionEvent::request_accepted, frame.header.type));
    }

    if (frame.header.kind == MessageKind::event &&
        frame.header.type == MessageType::DEVICE_EVENT) {
        if ((negotiated_capabilities_ & kCapabilityEvents) == 0U) {
            return violation();
        }
        return Result<ConnectionResult>::success(
            accepted(ConnectionEvent::event_accepted, frame.header.type));
    }
    if (!pending_ ||
        (frame.header.kind != MessageKind::response &&
         frame.header.kind != MessageKind::error_response) ||
        !validate_response_to_request(pending_header_, frame.header)) {
        return violation();
    }
    clear_pending();
    return Result<ConnectionResult>::success(
        accepted(ConnectionEvent::response_accepted, frame.header.type));
}

Result<ConnectionResult> ConnectionStateMachine::process_stream_client(
    const FrameView& frame, bool outbound) noexcept
{
    if (phase_ == ConnectionPhase::initial) {
        if (!outbound || frame.header.kind != MessageKind::request ||
            frame.header.type != MessageType::ATTACH_STREAM) {
            return violation();
        }
        set_pending(frame.header);
        phase_ = ConnectionPhase::handshake;
        return Result<ConnectionResult>::success(
            accepted(ConnectionEvent::request_accepted, frame.header.type));
    }
    if (phase_ == ConnectionPhase::handshake) {
        if (outbound || !pending_ ||
            (frame.header.kind != MessageKind::response &&
             frame.header.kind != MessageKind::error_response) ||
            !validate_response_to_request(pending_header_, frame.header)) {
            return violation();
        }
        clear_pending();
        phase_ = frame.header.kind == MessageKind::response ? ConnectionPhase::active :
                                                             ConnectionPhase::closed;
        return Result<ConnectionResult>::success(
            accepted(ConnectionEvent::response_accepted, frame.header.type));
    }
    if (outbound || frame.header.kind != MessageKind::event ||
        (frame.header.type != MessageType::TS_DATA &&
         frame.header.type != MessageType::STREAM_END)) {
        return violation();
    }
    return process_ts_event(frame);
}

Result<ConnectionResult> ConnectionStateMachine::process_stream_server(
    const FrameView& frame, bool outbound) noexcept
{
    if (phase_ == ConnectionPhase::initial) {
        if (outbound || frame.header.kind != MessageKind::request ||
            frame.header.type != MessageType::ATTACH_STREAM) {
            return violation();
        }
        set_pending(frame.header);
        phase_ = ConnectionPhase::handshake;
        return Result<ConnectionResult>::success(
            accepted(ConnectionEvent::attach_response_required, frame.header.type));
    }
    if (phase_ == ConnectionPhase::handshake) {
        if (!outbound || !pending_ ||
            (frame.header.kind != MessageKind::response &&
             frame.header.kind != MessageKind::error_response) ||
            !validate_response_to_request(pending_header_, frame.header)) {
            return violation();
        }
        clear_pending();
        phase_ = frame.header.kind == MessageKind::response ? ConnectionPhase::active :
                                                             ConnectionPhase::closed;
        return Result<ConnectionResult>::success(
            accepted(ConnectionEvent::response_accepted, frame.header.type));
    }
    if (!outbound || frame.header.kind != MessageKind::event ||
        (frame.header.type != MessageType::TS_DATA &&
         frame.header.type != MessageType::STREAM_END)) {
        return violation();
    }
    return process_ts_event(frame);
}

Result<ConnectionResult> ConnectionStateMachine::process_ts_event(
    const FrameView& frame) noexcept
{
    if (frame.header.type == MessageType::STREAM_END) {
        phase_ = ConnectionPhase::closed;
        return Result<ConnectionResult>::success(
            accepted(ConnectionEvent::stream_end_accepted, frame.header.type));
    }
    const auto data = decode_ts_data_event_payload(frame.payload);
    if (!data || data.value().cumulative_drop_count != 0U) {
        return violation();
    }
    if (ts_sequence_seen_) {
        if (last_ts_sequence_ == std::numeric_limits<std::uint64_t>::max() ||
            data.value().sequence != last_ts_sequence_ + 1U) {
            return violation();
        }
    }
    last_ts_sequence_ = data.value().sequence;
    ts_sequence_seen_ = true;
    return Result<ConnectionResult>::success(
        accepted(ConnectionEvent::ts_data_accepted, frame.header.type));
}

void ConnectionStateMachine::reset() noexcept
{
    phase_ = ConnectionPhase::initial;
    requested_capabilities_ = 0U;
    negotiated_capabilities_ = 0U;
    clear_pending();
    hello_compatible_ = false;
    ts_sequence_seen_ = false;
    last_ts_sequence_ = 0U;
}

}  // namespace px4::userland::ipc
