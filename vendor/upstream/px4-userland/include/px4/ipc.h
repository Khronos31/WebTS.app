// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_IPC_H
#define PX4_USERLAND_IPC_H

#include "px4/error.h"
#include "px4/transport.h"

#include <array>
#include <cstddef>
#include <cstdint>

namespace px4::userland::ipc {

inline constexpr std::size_t kFrameHeaderSize = 20U;
inline constexpr std::uint16_t kProtocolMajor = 1U;
inline constexpr std::uint16_t kProtocolMinor = 0U;
inline constexpr std::size_t kMaxControlPayload = 65536U;
inline constexpr std::size_t kMaxTsBytes = 1048576U;
inline constexpr std::size_t kMaxTsDataPayload = 1048596U;
inline constexpr std::size_t kMaxFrameSize = kFrameHeaderSize + kMaxTsDataPayload;
inline constexpr std::size_t kMaxCardPayload = 4096U;
inline constexpr std::size_t kMaxAtrLength = 33U;
inline constexpr std::size_t kReceiverCount = 8U;
inline constexpr std::size_t kNonceLength = 16U;

enum class MessageType : std::uint16_t {
    HELLO = 0x0001U,
    LIST = 0x0010U,
    STATUS = 0x0011U,
    ACQUIRE = 0x0020U,
    RELEASE = 0x0021U,
    TUNE = 0x0022U,
    START_STREAM = 0x0023U,
    STOP_STREAM = 0x0024U,
    STATS = 0x0025U,
    CARD_STATUS = 0x0030U,
    CARD_CONNECT = 0x0031U,
    CARD_RECONNECT = 0x0032U,
    CARD_DISCONNECT = 0x0033U,
    CARD_RESET = 0x0034U,
    CARD_TRANSMIT = 0x0035U,
    BEGIN_TRANSACTION = 0x0036U,
    END_TRANSACTION = 0x0037U,
    ATTACH_STREAM = 0x0040U,
    TS_DATA = 0x8040U,
    DEVICE_EVENT = 0x80f0U,
    STREAM_END = 0x80ffU,
};

enum class MessageKind : std::uint8_t {
    request,
    response,
    error_response,
    event,
};

enum class ErrorCode : std::uint32_t {
    OK = 0U,
    INVALID_ARGUMENT = 1U,
    VERSION_MISMATCH = 2U,
    NOT_FOUND = 3U,
    BUSY = 4U,
    NOT_READY = 5U,
    TIMEOUT = 6U,
    USB_IO = 7U,
    DISCONNECTED = 8U,
    PROTOCOL_ERROR = 9U,
    FIRMWARE_REJECTED = 10U,
    UNSUPPORTED = 11U,
    NO_CARD = 12U,
    CARD_REMOVED = 13U,
    BUFFER_TOO_SMALL = 14U,
    SLOW_CONSUMER = 15U,
    INTERNAL = 255U,
};

enum class System : std::uint8_t {
    ISDB_T = 1U,
    ISDB_S = 2U,
};

enum class ReceiverState : std::uint8_t {
    free = 0U,
    leased = 1U,
    tuned = 2U,
    streaming = 3U,
    error = 4U,
};

enum class ShareMode : std::uint8_t {
    shared = 1U,
    exclusive = 2U,
};

enum class Disposition : std::uint8_t {
    leave = 0U,
    reset = 1U,
};

enum class DeviceEventKind : std::uint8_t {
    attached = 1U,
    detached = 2U,
    card_inserted = 3U,
    card_removed = 4U,
    state_changed = 5U,
};

enum class EventTargetType : std::uint8_t {
    device = 1U,
    receiver = 2U,
    card = 3U,
};

struct FrameHeader final {
    std::uint16_t major = kProtocolMajor;
    std::uint16_t minor = kProtocolMinor;
    MessageType type = MessageType::HELLO;
    MessageKind kind = MessageKind::request;
    std::uint32_t request_id = 0U;
    std::uint32_t payload_length = 0U;
};

// payload aliases the input supplied to decode_frame. It remains valid only
// while that input storage remains valid and unchanged.
struct FrameView final {
    FrameHeader header;
    ByteView payload;
};

struct EmptyPayload final {};

struct HelloRequestPayload final {
    std::uint16_t min_major;
    std::uint16_t min_minor;
    std::uint16_t max_major;
    std::uint16_t max_minor;
    std::uint32_t requested_capabilities;
};

struct HelloResponsePayload final {
    std::uint16_t major;
    std::uint16_t minor;
    std::uint32_t capabilities;
};

struct ReceiverRecord final {
    std::uint8_t global_id;
    std::uint8_t dev_id;
    std::uint8_t local_id;
    System system;
};

struct ListResponsePayload final {
    std::uint64_t generation;
    ByteView serial_utf8;
    std::uint8_t ready;
    std::uint8_t usb_present_mask;
    std::array<ReceiverRecord, kReceiverCount> receivers;
};

struct StatusResponsePayload final {
    std::uint64_t generation;
    std::uint8_t ready;
    std::uint8_t usb_present_mask;
    std::uint8_t card_present;
    std::uint8_t card_initialized;
    std::array<ReceiverState, kReceiverCount> receiver_states;
    std::uint64_t usb_errors;
    std::uint64_t protocol_errors;
};

struct AcquireRequestPayload final {
    std::uint8_t receiver_id;
};

struct AcquireResponsePayload final {
    std::uint64_t lease_id;
    std::array<std::uint8_t, kNonceLength> nonce;
};

// Used by RELEASE, START_STREAM, STOP_STREAM, and STATS requests.
struct LeaseRequestPayload final {
    std::uint64_t lease_id;
};

// Used by CARD_RESET and BEGIN_TRANSACTION requests.
struct CardHandleRequestPayload final {
    std::uint64_t card_handle;
};

struct TuneRequestPayload final {
    std::uint64_t lease_id;
    System system;
    std::uint64_t frequency_khz;
    std::uint16_t stream_id;
    std::uint16_t slot;
    std::uint32_t bandwidth_hz;
    std::uint8_t lnb_voltage;
    std::uint32_t timeout_ms;
};

struct TuneResponsePayload final {
    std::uint8_t locked;
    std::int32_t cnr_mdb;
};

// Used by STOP_STREAM and STATS success payloads and embedded in STREAM_END.
struct CountersPayload final {
    std::uint64_t packets;
    std::uint64_t bytes;
    std::uint64_t sync_errors;
    std::uint64_t tei_packets;
    std::uint64_t continuity_errors;
    std::uint64_t queue_drops;
    std::uint64_t usb_errors;
    std::uint64_t empty_intervals;
};

struct CardStatusResponsePayload final {
    std::uint8_t present;
    std::uint8_t initialized;
    std::uint64_t reader_generation;
    ByteView atr;
};

struct CardConnectRequestPayload final {
    ShareMode share_mode;
};

struct CardConnectResponsePayload final {
    std::uint64_t card_handle;
    ByteView atr;
};

struct CardReconnectRequestPayload final {
    std::uint64_t card_handle;
    ShareMode share_mode;
    Disposition disposition;
};

// Used by CARD_RECONNECT and CARD_RESET success payloads.
struct AtrPayload final {
    ByteView atr;
};

// Used by CARD_DISCONNECT and END_TRANSACTION requests.
struct CardDispositionRequestPayload final {
    std::uint64_t card_handle;
    Disposition disposition;
};

struct CardTransmitRequestPayload final {
    std::uint64_t card_handle;
    ByteView apdu;
};

struct CardTransmitResponsePayload final {
    ByteView response;
};

struct AttachStreamRequestPayload final {
    std::uint64_t lease_id;
    std::array<std::uint8_t, kNonceLength> nonce;
};

struct TsDataEventPayload final {
    std::uint64_t sequence;
    std::uint64_t cumulative_drop_count;
    ByteView bytes;
};

struct DeviceEventPayload final {
    std::uint64_t generation;
    DeviceEventKind kind;
    EventTargetType target_type;
    std::uint8_t target_id;
};

struct StreamEndEventPayload final {
    CountersPayload counters;
    ErrorCode error_code;
};

struct ErrorResponsePayload final {
    ErrorCode error_code;
    ByteView detail_utf8;
};

// Every ByteView returned by a typed decoder aliases that decoder's input and
// has the same lifetime as the input bytes. Typed encoders never allocate and
// return BUFFER_TOO_SMALL when the caller-provided output is insufficient.
Result<std::size_t> encode_empty_payload(MutableByteView output) noexcept;
Result<EmptyPayload> decode_empty_payload(ByteView input) noexcept;

#define PX4_DECLARE_PAYLOAD_CODEC(Type, Name)                                                \
    Result<std::size_t> encode_payload(const Type& value, MutableByteView output) noexcept; \
    Result<Type> decode_##Name##_payload(ByteView input) noexcept

PX4_DECLARE_PAYLOAD_CODEC(HelloRequestPayload, hello_request);
PX4_DECLARE_PAYLOAD_CODEC(HelloResponsePayload, hello_response);
PX4_DECLARE_PAYLOAD_CODEC(ListResponsePayload, list_response);
PX4_DECLARE_PAYLOAD_CODEC(StatusResponsePayload, status_response);
PX4_DECLARE_PAYLOAD_CODEC(AcquireRequestPayload, acquire_request);
PX4_DECLARE_PAYLOAD_CODEC(AcquireResponsePayload, acquire_response);
PX4_DECLARE_PAYLOAD_CODEC(LeaseRequestPayload, lease_request);
PX4_DECLARE_PAYLOAD_CODEC(CardHandleRequestPayload, card_handle_request);
PX4_DECLARE_PAYLOAD_CODEC(TuneRequestPayload, tune_request);
PX4_DECLARE_PAYLOAD_CODEC(TuneResponsePayload, tune_response);
PX4_DECLARE_PAYLOAD_CODEC(CountersPayload, counters);
PX4_DECLARE_PAYLOAD_CODEC(CardStatusResponsePayload, card_status_response);
PX4_DECLARE_PAYLOAD_CODEC(CardConnectRequestPayload, card_connect_request);
PX4_DECLARE_PAYLOAD_CODEC(CardConnectResponsePayload, card_connect_response);
PX4_DECLARE_PAYLOAD_CODEC(CardReconnectRequestPayload, card_reconnect_request);
PX4_DECLARE_PAYLOAD_CODEC(AtrPayload, atr);
PX4_DECLARE_PAYLOAD_CODEC(CardDispositionRequestPayload, card_disposition_request);
PX4_DECLARE_PAYLOAD_CODEC(CardTransmitRequestPayload, card_transmit_request);
PX4_DECLARE_PAYLOAD_CODEC(CardTransmitResponsePayload, card_transmit_response);
PX4_DECLARE_PAYLOAD_CODEC(AttachStreamRequestPayload, attach_stream_request);
PX4_DECLARE_PAYLOAD_CODEC(TsDataEventPayload, ts_data_event);
PX4_DECLARE_PAYLOAD_CODEC(DeviceEventPayload, device_event);
PX4_DECLARE_PAYLOAD_CODEC(StreamEndEventPayload, stream_end_event);
PX4_DECLARE_PAYLOAD_CODEC(ErrorResponsePayload, error_response);

#undef PX4_DECLARE_PAYLOAD_CODEC

bool is_known_message_type(MessageType type) noexcept;
bool is_event_message(MessageType type) noexcept;
bool is_known_error_code(ErrorCode code) noexcept;
std::size_t payload_limit(MessageType type) noexcept;

// Uses the typed decoders above as the single payload-validation source.
Result<void> validate_payload(MessageType type, MessageKind kind,
                              ByteView payload) noexcept;
Result<void> validate_frame_view(const FrameView& frame) noexcept;
Result<void> validate_response_to_request(const FrameHeader& request,
                                          const FrameHeader& response) noexcept;

// Header-only decode for byte-stream transports. It requires exactly 20 bytes
// and validates magic, v1 header version, type, flags, event/request invariants,
// and the declared payload limit without reading or allocating the body.
Result<FrameHeader> decode_frame_header(ByteView header) noexcept;

Result<std::size_t> encode_frame(const FrameHeader& header, ByteView payload,
                                 MutableByteView output) noexcept;
Result<FrameView> decode_frame(ByteView frame) noexcept;

class FrameConsumer {
public:
    virtual ~FrameConsumer() noexcept = default;

    // frame and all nested typed views alias StreamFramer's storage and are
    // valid only until this callback returns.
    virtual Result<void> on_frame(const FrameView& frame) noexcept = 0;
};

// Allocation-free byte-stream framing over caller-owned storage. feed accepts
// arbitrary fragments and coalesced frames. A framing error poisons the
// instance until reset(), matching the connection-close contract while making
// deterministic recovery testable.
class StreamFramer final {
public:
    explicit StreamFramer(MutableByteView storage) noexcept;

    // Returns the number of complete frames delivered during this call.
    Result<std::size_t> feed(ByteView input, FrameConsumer& consumer) noexcept;
    void reset() noexcept;
    bool failed() const noexcept { return failed_; }
    Error failure() const noexcept { return failure_; }
    std::size_t buffered_size() const noexcept { return buffered_; }

    StreamFramer(const StreamFramer&) = delete;
    StreamFramer& operator=(const StreamFramer&) = delete;

private:
    Result<void> fail(Error error) noexcept;

    MutableByteView storage_;
    std::size_t buffered_ = 0U;
    std::size_t expected_ = 0U;
    bool failed_ = false;
    Error failure_ = Error::OK;
};

inline constexpr std::uint32_t kCapabilityEvents = 1U << 0U;
inline constexpr std::uint32_t kCapabilityCard = 1U << 1U;
inline constexpr std::uint32_t kCapabilityStreamStats = 1U << 2U;
inline constexpr std::uint32_t kKnownCapabilities =
    kCapabilityEvents | kCapabilityCard | kCapabilityStreamStats;

enum class ConnectionRole : std::uint8_t {
    control_client,
    control_server,
    stream_client,
    stream_server,
};

enum class ConnectionPhase : std::uint8_t {
    initial,
    handshake,
    active,
    closed,
    poisoned,
};

enum class ConnectionEvent : std::uint8_t {
    request_accepted,
    response_accepted,
    event_accepted,
    hello_response_required,
    version_mismatch_response_required,
    attach_response_required,
    ts_data_accepted,
    stream_end_accepted,
};

struct ConnectionResult final {
    ConnectionEvent event;
    MessageType type;
    std::uint32_t negotiated_capabilities;
};

// Portable connection-level ordering and correlation state. Input frames must
// be complete validated FrameViews (normally from decode_frame/StreamFramer).
// The class owns no payload memory and performs no transport or allocation.
class ConnectionStateMachine final {
public:
    explicit ConnectionStateMachine(ConnectionRole role,
                                    std::uint32_t server_supported_capabilities = 0U) noexcept;

    Result<ConnectionResult> process_outbound(const FrameView& frame) noexcept;
    Result<ConnectionResult> process_inbound(const FrameView& frame) noexcept;
    Result<HelloResponsePayload> pending_hello_response() const noexcept;
    void reset() noexcept;

    ConnectionRole role() const noexcept { return role_; }
    ConnectionPhase phase() const noexcept { return phase_; }
    bool poisoned() const noexcept { return phase_ == ConnectionPhase::poisoned; }
    bool closed() const noexcept { return phase_ == ConnectionPhase::closed; }
    bool has_outstanding_request() const noexcept { return pending_; }
    std::uint32_t negotiated_capabilities() const noexcept
    {
        return negotiated_capabilities_;
    }

    ConnectionStateMachine(const ConnectionStateMachine&) = delete;
    ConnectionStateMachine& operator=(const ConnectionStateMachine&) = delete;

private:
    Result<ConnectionResult> process_control_client(const FrameView& frame,
                                                    bool outbound) noexcept;
    Result<ConnectionResult> process_control_server(const FrameView& frame,
                                                    bool outbound) noexcept;
    Result<ConnectionResult> process_stream_client(const FrameView& frame,
                                                   bool outbound) noexcept;
    Result<ConnectionResult> process_stream_server(const FrameView& frame,
                                                   bool outbound) noexcept;
    Result<ConnectionResult> process_ts_event(const FrameView& frame) noexcept;
    Result<ConnectionResult> violation(Error error = Error::PROTOCOL_ERROR) noexcept;
    ConnectionResult accepted(ConnectionEvent event, MessageType type) const noexcept;
    void set_pending(const FrameHeader& header) noexcept;
    void clear_pending() noexcept;

    ConnectionRole role_;
    ConnectionPhase phase_ = ConnectionPhase::initial;
    std::uint32_t server_supported_capabilities_ = 0U;
    std::uint32_t requested_capabilities_ = 0U;
    std::uint32_t negotiated_capabilities_ = 0U;
    FrameHeader pending_header_{};
    bool pending_ = false;
    bool hello_compatible_ = false;
    bool ts_sequence_seen_ = false;
    std::uint64_t last_ts_sequence_ = 0U;
};

}  // namespace px4::userland::ipc

#endif  // PX4_USERLAND_IPC_H
