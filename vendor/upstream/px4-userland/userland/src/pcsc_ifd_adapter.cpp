// SPDX-License-Identifier: GPL-2.0-only
#include "px4/pcsc_ifd_adapter.h"

#include "px4/control_client.h"
#include "px4/ipc.h"
#include "px4/posix_ipc.h"

#include <algorithm>
#include <array>
#include <cstring>
#include <string_view>
#include <utility>

namespace px4::userland::pcsc {
namespace {

using namespace ipc;
using namespace ipc::posix;

constexpr std::uint32_t kRequestTimeoutMs = 4000U;
constexpr std::string_view kDevicePrefix = "px4-userland:";

bool valid_serial(std::string_view value) noexcept
{
    if (value.size() != 14U) return false;
    for (const char character : value) {
        if (character < '0' || character > '9') return false;
    }
    return true;
}

bool valid_field_value(std::string_view value) noexcept
{
    if (value.empty()) return false;
    for (const unsigned char character : value) {
        // pcsc-lite's unquoted DEVICENAME token permits ':', so it is the
        // field separator.  Reject it inside values to keep parsing unique.
        if (character < 0x20U || character == 0x7fU || character == ':') {
            return false;
        }
    }
    return true;
}

bool channel_failure(Error error) noexcept
{
    switch (error) {
    case Error::VERSION_MISMATCH:
    case Error::NOT_FOUND:
    case Error::NOT_READY:
    case Error::TIMEOUT:
    case Error::USB_IO:
    case Error::DISCONNECTED:
    case Error::PROTOCOL_ERROR:
    case Error::FIRMWARE_REJECTED:
    case Error::SLOW_CONSUMER:
    case Error::INTERNAL:
        return true;
    case Error::OK:
    case Error::INVALID_ARGUMENT:
    case Error::BUSY:
    case Error::UNSUPPORTED:
    case Error::NO_CARD:
    case Error::CARD_REMOVED:
    case Error::BUFFER_TOO_SMALL:
        return false;
    }
    return true;
}

IfdResult copy_value(ByteView value, MutableByteView output,
                     std::size_t& length) noexcept
{
    const std::size_t capacity = length;
    length = value.size;
    if (value.size == 0U) return IfdResult::success;
    if (value.data == nullptr || output.data == nullptr ||
        capacity < value.size || output.size < value.size) {
        return IfdResult::insufficient_buffer;
    }
    std::memcpy(output.data, value.data, value.size);
    return IfdResult::success;
}

IfdResult copy_u8(std::uint8_t value, MutableByteView output,
                  std::size_t& length) noexcept
{
    return copy_value(ByteView{&value, 1U}, output, length);
}

IfdResult copy_u32(std::uint32_t value, MutableByteView output,
                   std::size_t& length) noexcept
{
    const std::array<std::uint8_t, 4U> bytes{
        static_cast<std::uint8_t>(value & 0xffU),
        static_cast<std::uint8_t>((value >> 8U) & 0xffU),
        static_cast<std::uint8_t>((value >> 16U) & 0xffU),
        static_cast<std::uint8_t>((value >> 24U) & 0xffU)};
    return copy_value(ByteView{bytes.data(), bytes.size()}, output, length);
}

template <typename Payload>
Result<ControlResponse> typed_request(PosixControlClient& client,
                                      MessageType type,
                                      const Payload& payload) noexcept
{
    std::array<std::uint8_t, kMaxControlPayload> encoded{};
    const auto size = encode_payload(
        payload, MutableByteView{encoded.data(), encoded.size()});
    if (!size) return Result<ControlResponse>::failure(size.error());
    return client.request(type, ByteView{encoded.data(), size.value()},
                          Timeout{kRequestTimeoutMs});
}

class PosixIfdCardClient final : public IfdCardClient {
public:
    explicit PosixIfdCardClient(std::unique_ptr<PosixControlClient> client) noexcept
        : client_(std::move(client))
    {
    }

    Result<IfdCardStatus> status() noexcept override
    {
        const auto response = client_->request(
            MessageType::CARD_STATUS, ByteView{nullptr, 0U},
            Timeout{kRequestTimeoutMs});
        if (!response) return Result<IfdCardStatus>::failure(response.error());
        const auto decoded = decode_card_status_response_payload(
            ByteView{response.value().payload.data(), response.value().payload.size()});
        if (!decoded) return Result<IfdCardStatus>::failure(decoded.error());
        IfdCardStatus result{};
        result.present = decoded.value().present != 0U;
        result.initialized = decoded.value().initialized != 0U;
        result.reader_generation = decoded.value().reader_generation;
        result.atr_length = decoded.value().atr.size;
        if (result.atr_length != 0U) {
            std::memcpy(result.atr.data(), decoded.value().atr.data,
                        result.atr_length);
        }
        return Result<IfdCardStatus>::success(result);
    }

    Result<IfdCardConnectResult> connect_shared() noexcept override
    {
        const auto response = typed_request(
            *client_, MessageType::CARD_CONNECT,
            CardConnectRequestPayload{ShareMode::shared});
        if (!response) {
            return Result<IfdCardConnectResult>::failure(response.error());
        }
        const auto decoded = decode_card_connect_response_payload(
            ByteView{response.value().payload.data(), response.value().payload.size()});
        if (!decoded) {
            return Result<IfdCardConnectResult>::failure(decoded.error());
        }
        IfdCardConnectResult result{};
        result.handle = decoded.value().card_handle;
        result.atr_length = decoded.value().atr.size;
        if (result.atr_length != 0U) {
            std::memcpy(result.atr.data(), decoded.value().atr.data,
                        result.atr_length);
        }
        return Result<IfdCardConnectResult>::success(result);
    }

    Result<void> disconnect(std::uint64_t handle) noexcept override
    {
        const auto response = typed_request(
            *client_, MessageType::CARD_DISCONNECT,
            CardDispositionRequestPayload{handle, Disposition::leave});
        return response ? Result<void>::success() :
                          Result<void>::failure(response.error());
    }

    Result<IfdCardConnectResult> reset(std::uint64_t handle) noexcept override
    {
        const auto response = typed_request(
            *client_, MessageType::CARD_RESET,
            CardHandleRequestPayload{handle});
        if (!response) {
            return Result<IfdCardConnectResult>::failure(response.error());
        }
        const auto decoded = decode_atr_payload(
            ByteView{response.value().payload.data(), response.value().payload.size()});
        if (!decoded) {
            return Result<IfdCardConnectResult>::failure(decoded.error());
        }
        IfdCardConnectResult result{};
        result.handle = handle;
        result.atr_length = decoded.value().atr.size;
        if (result.atr_length != 0U) {
            std::memcpy(result.atr.data(), decoded.value().atr.data,
                        result.atr_length);
        }
        return Result<IfdCardConnectResult>::success(result);
    }

    Result<std::size_t> transmit(std::uint64_t handle, ByteView apdu,
                                 MutableByteView response) noexcept override
    {
        const auto reply = typed_request(
            *client_, MessageType::CARD_TRANSMIT,
            CardTransmitRequestPayload{handle, apdu});
        if (!reply) return Result<std::size_t>::failure(reply.error());
        const auto decoded = decode_card_transmit_response_payload(
            ByteView{reply.value().payload.data(), reply.value().payload.size()});
        if (!decoded) return Result<std::size_t>::failure(decoded.error());
        if (decoded.value().response.size > response.size ||
            (decoded.value().response.size != 0U && response.data == nullptr)) {
            return Result<std::size_t>::failure(Error::BUFFER_TOO_SMALL);
        }
        if (decoded.value().response.size != 0U) {
            std::memcpy(response.data, decoded.value().response.data,
                        decoded.value().response.size);
        }
        return Result<std::size_t>::success(decoded.value().response.size);
    }

    void close() noexcept override
    {
        if (client_) client_->close();
    }

private:
    std::unique_ptr<PosixControlClient> client_;
};

}  // namespace

Result<IfdEndpoint> parse_ifd_device_name(const char* device_name) noexcept
{
    if (device_name == nullptr) {
        return Result<IfdEndpoint>::failure(Error::INVALID_ARGUMENT);
    }
    std::size_t length = 0U;
    while (length <= kIfdDeviceNameMaxLength && device_name[length] != '\0') {
        ++length;
    }
    if (length == 0U || length > kIfdDeviceNameMaxLength) {
        return Result<IfdEndpoint>::failure(Error::INVALID_ARGUMENT);
    }
    const std::string_view input(device_name, length);
    if (input.size() <= kDevicePrefix.size() ||
        input.substr(0U, kDevicePrefix.size()) != kDevicePrefix) {
        return Result<IfdEndpoint>::failure(Error::INVALID_ARGUMENT);
    }

    IfdEndpoint endpoint{};
    bool have_runtime = false;
    bool have_device = false;
    bool have_access = false;
    std::size_t offset = kDevicePrefix.size();
    while (offset < input.size()) {
        const std::size_t separator = input.find(':', offset);
        const std::size_t end = separator == std::string_view::npos ?
                                    input.size() : separator;
        const std::string_view field = input.substr(offset, end - offset);
        const std::size_t equals = field.find('=');
        if (field.empty() || equals == std::string_view::npos || equals == 0U ||
            equals + 1U == field.size()) {
            return Result<IfdEndpoint>::failure(Error::INVALID_ARGUMENT);
        }
        const std::string_view key = field.substr(0U, equals);
        const std::string_view value = field.substr(equals + 1U);
        if (!valid_field_value(value)) {
            return Result<IfdEndpoint>::failure(Error::INVALID_ARGUMENT);
        }
        if (key == "runtime") {
            if (have_runtime || value.front() != '/') {
                return Result<IfdEndpoint>::failure(Error::INVALID_ARGUMENT);
            }
            have_runtime = true;
            endpoint.runtime_directory.assign(value.data(), value.size());
        } else if (key == "device") {
            if (have_device || !valid_serial(value)) {
                return Result<IfdEndpoint>::failure(Error::INVALID_ARGUMENT);
            }
            have_device = true;
            endpoint.device_instance.assign(value.data(), value.size());
        } else if (key == "access") {
            if (have_access || (value != "user" && value != "group")) {
                return Result<IfdEndpoint>::failure(Error::INVALID_ARGUMENT);
            }
            have_access = true;
            endpoint.group_access = value == "group";
        } else {
            return Result<IfdEndpoint>::failure(Error::INVALID_ARGUMENT);
        }
        if (separator == std::string_view::npos) break;
        offset = separator + 1U;
        if (offset == input.size()) {
            return Result<IfdEndpoint>::failure(Error::INVALID_ARGUMENT);
        }
    }
    if (!have_device) {
        return Result<IfdEndpoint>::failure(Error::INVALID_ARGUMENT);
    }
    return Result<IfdEndpoint>::success(std::move(endpoint));
}

IfdResult map_ifd_error(Error error, IfdOperation operation) noexcept
{
    switch (error) {
    case Error::OK: return IfdResult::success;
    case Error::TIMEOUT: return IfdResult::response_timeout;
    case Error::NOT_FOUND:
    case Error::NOT_READY:
    case Error::DISCONNECTED:
    case Error::FIRMWARE_REJECTED:
        return IfdResult::no_such_device;
    case Error::NO_CARD:
    case Error::CARD_REMOVED:
        return operation == IfdOperation::power ? IfdResult::error_power_action :
               IfdResult::icc_not_present;
    case Error::BUFFER_TOO_SMALL: return IfdResult::insufficient_buffer;
    case Error::UNSUPPORTED: return IfdResult::not_supported;
    case Error::INVALID_ARGUMENT:
    case Error::VERSION_MISMATCH:
    case Error::BUSY:
    case Error::USB_IO:
    case Error::PROTOCOL_ERROR:
    case Error::SLOW_CONSUMER:
    case Error::INTERNAL:
        return IfdResult::communication_error;
    }
    return IfdResult::communication_error;
}

Result<std::unique_ptr<IfdCardClient>> PosixIfdCardClientFactory::connect(
    const IfdEndpoint& endpoint) noexcept
{
    const char* runtime = endpoint.runtime_directory.empty() ?
                              nullptr : endpoint.runtime_directory.c_str();
    const EndpointConfig config{
        runtime, endpoint.device_instance.c_str(), kControlEndpointName,
        endpoint.group_access ? EndpointAccess::shared_group :
                                EndpointAccess::private_user};
    auto client = PosixControlClient::connect(
        config, kCapabilityCard, Timeout{kRequestTimeoutMs});
    if (!client) {
        return Result<std::unique_ptr<IfdCardClient>>::failure(client.error());
    }
    return Result<std::unique_ptr<IfdCardClient>>::success(
        std::unique_ptr<IfdCardClient>(
            new PosixIfdCardClient(std::move(client.value()))));
}

void IfdAdapter::clear_card_state() noexcept
{
    atr_.fill(0U);
    atr_length_ = 0U;
    present_ = false;
    powered_ = false;
}

void IfdAdapter::invalidate_channel() noexcept
{
    if (client_) client_->close();
    client_.reset();
    card_handle_ = 0U;
    reader_generation_ = 0U;
    clear_card_state();
}

IfdResult IfdAdapter::fail(Error error, IfdOperation operation) noexcept
{
    if (error == Error::NO_CARD || error == Error::CARD_REMOVED) {
        clear_card_state();
    } else if (channel_failure(error)) {
        invalidate_channel();
    }
    return map_ifd_error(error, operation);
}

Result<IfdCardStatus> IfdAdapter::refresh_status() noexcept
{
    if (!client_) return Result<IfdCardStatus>::failure(Error::NOT_READY);
    const auto status = client_->status();
    if (!status) return status;
    const bool generation_changed =
        reader_generation_ != 0U &&
        reader_generation_ != status.value().reader_generation;
    reader_generation_ = status.value().reader_generation;
    present_ = status.value().present;
    if (!present_ || (generation_changed && !status.value().initialized)) {
        atr_.fill(0U);
        atr_length_ = 0U;
        powered_ = false;
    }
    if (status.value().present && status.value().initialized) {
        atr_ = status.value().atr;
        atr_length_ = status.value().atr_length;
        powered_ = true;
    }
    return status;
}

Result<IfdCardConnectResult> IfdAdapter::power_or_reset(bool force_reset) noexcept
{
    if (!client_) {
        return Result<IfdCardConnectResult>::failure(Error::NOT_READY);
    }
    Result<IfdCardConnectResult> result =
        Result<IfdCardConnectResult>::failure(Error::INTERNAL);
    if (card_handle_ == 0U) {
        result = client_->connect_shared();
    } else if (force_reset || !powered_) {
        result = client_->reset(card_handle_);
    } else {
        IfdCardConnectResult cached{};
        cached.handle = card_handle_;
        cached.atr = atr_;
        cached.atr_length = atr_length_;
        return Result<IfdCardConnectResult>::success(cached);
    }
    if (!result) return result;
    card_handle_ = result.value().handle;
    atr_ = result.value().atr;
    atr_length_ = result.value().atr_length;
    present_ = true;
    powered_ = true;
    return result;
}

IfdResult IfdAdapter::create_channel_by_name(std::uint64_t lun,
                                             const char* device_name) noexcept
{
    const auto parsed = parse_ifd_device_name(device_name);
    if (!parsed) return IfdResult::communication_error;
    std::lock_guard<std::mutex> lock(mutex_);
    if (!valid_lun(lun)) return IfdResult::no_such_device;
    if (channel_open()) return IfdResult::communication_error;
    auto client = factory_.connect(parsed.value());
    if (!client) return map_ifd_error(client.error(), IfdOperation::channel);
    endpoint_ = parsed.value();
    client_ = std::move(client.value());
    const auto status = refresh_status();
    if (!status) return fail(status.error(), IfdOperation::channel);
    return IfdResult::success;
}

IfdResult IfdAdapter::create_channel(std::uint64_t lun,
                                     std::uint64_t channel) noexcept
{
    (void)channel;
    std::lock_guard<std::mutex> lock(mutex_);
    return valid_lun(lun) ? IfdResult::not_supported :
                            IfdResult::no_such_device;
}

IfdResult IfdAdapter::close_channel(std::uint64_t lun) noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    if (!valid_lun(lun) || !channel_open()) return IfdResult::no_such_device;
    Error error = Error::OK;
    if (card_handle_ != 0U) {
        const auto disconnected = client_->disconnect(card_handle_);
        if (!disconnected) error = disconnected.error();
    }
    invalidate_channel();
    return error == Error::OK ? IfdResult::success :
                                map_ifd_error(error, IfdOperation::channel);
}

IfdResult IfdAdapter::copy_atr(MutableByteView output,
                               std::size_t& length) noexcept
{
    return copy_value(ByteView{atr_.data(), atr_length_}, output, length);
}

IfdResult IfdAdapter::get_capability(std::uint64_t lun, std::uint32_t tag,
                                     MutableByteView output,
                                     std::size_t& length) noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    if (!valid_lun(lun) || !channel_open()) return IfdResult::no_such_device;
    static constexpr char vendor[] = "Khronos31";
    static constexpr char type[] = "PX-Q3U4 via px4d";
    switch (tag) {
    case kTagIfdAtr:
    case kAttrAtrString:
        return copy_atr(output, length);
    case kTagIfdSlotNumber: return copy_u8(0U, output, length);
    case kTagIfdSlotThreadSafe: return copy_u8(0U, output, length);
    case kTagIfdThreadSafe: return copy_u8(1U, output, length);
    case kTagIfdSlotsNumber: return copy_u8(1U, output, length);
    case kTagIfdSimultaneousAccess: return copy_u8(1U, output, length);
    case kAttrVendorName:
        return copy_value(
            ByteView{reinterpret_cast<const std::uint8_t*>(vendor),
                     sizeof(vendor) - 1U}, output, length);
    case kAttrVendorIfdType:
        return copy_value(
            ByteView{reinterpret_cast<const std::uint8_t*>(type),
                     sizeof(type) - 1U}, output, length);
    case kAttrVendorIfdVersion: return copy_u32(0x00010000U, output, length);
    case kAttrVendorIfdSerial:
        return copy_value(
            ByteView{reinterpret_cast<const std::uint8_t*>(
                         endpoint_.device_instance.data()),
                     endpoint_.device_instance.size()}, output, length);
    case kAttrAsyncProtocolTypes:
    case kAttrCurrentProtocolType:
        return copy_u32(kIfdSetProtocolT1, output, length);
    case kAttrDefaultDataRate: return copy_u32(9600U, output, length);
    case kAttrMaxDataRate: return copy_u32(38400U, output, length);
    case kAttrMaxIfsd: return copy_u32(251U, output, length);
    case kAttrMaxInput: return copy_u32(kIfdApduMaxLength, output, length);
    case kAttrIccPresence: {
        const auto status = refresh_status();
        if (!status) return fail(status.error(), IfdOperation::status);
        return copy_u8(status.value().present ? 1U : 0U, output, length);
    }
    case kAttrIccInterfaceStatus: {
        const auto status = refresh_status();
        if (!status) return fail(status.error(), IfdOperation::status);
        return copy_u8(powered_ ? 1U : 0U, output, length);
    }
    default: return IfdResult::error_tag;
    }
}

IfdResult IfdAdapter::set_capability(std::uint64_t lun, std::uint32_t tag,
                                     ByteView value) noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    if (!valid_lun(lun) || !channel_open()) return IfdResult::no_such_device;
    if (tag == kTagIfdSlotNumber) {
        return value.data != nullptr && value.size == 1U && value.data[0] == 0U ?
                   IfdResult::success : IfdResult::error_set_failure;
    }
    switch (tag) {
    case kTagIfdAtr:
    case kTagIfdSlotThreadSafe:
    case kTagIfdThreadSafe:
    case kTagIfdSlotsNumber:
    case kTagIfdSimultaneousAccess:
    case kAttrVendorName:
    case kAttrVendorIfdType:
    case kAttrVendorIfdVersion:
    case kAttrVendorIfdSerial:
    case kAttrAsyncProtocolTypes:
    case kAttrDefaultDataRate:
    case kAttrMaxDataRate:
    case kAttrMaxIfsd:
    case kAttrCurrentProtocolType:
    case kAttrIccPresence:
    case kAttrIccInterfaceStatus:
    case kAttrAtrString:
    case kAttrMaxInput:
        return IfdResult::error_value_read_only;
    default: return IfdResult::error_tag;
    }
}

IfdResult IfdAdapter::set_protocol(std::uint64_t lun, std::uint32_t protocol,
                                   std::uint8_t flags, std::uint8_t pts1,
                                   std::uint8_t pts2, std::uint8_t pts3) noexcept
{
    (void)pts2;
    (void)pts3;
    std::lock_guard<std::mutex> lock(mutex_);
    if (!valid_lun(lun) || !channel_open()) return IfdResult::no_such_device;
    if (protocol != kIfdSetProtocolT1) return IfdResult::protocol_not_supported;
    if (!present_ || !powered_ || atr_length_ < 2U) {
        return IfdResult::error_power_action;
    }
    if ((flags & static_cast<std::uint8_t>(~kIfdNegotiatePts1)) != 0U) {
        return IfdResult::error_pts_failure;
    }
    std::uint8_t atr_ta1 = 0x11U;
    if ((atr_[1] & 0x10U) != 0U) {
        if (atr_length_ < 3U) return IfdResult::error_pts_failure;
        atr_ta1 = atr_[2];
    }
    if ((flags & kIfdNegotiatePts1) != 0U && pts1 != atr_ta1) {
        return IfdResult::error_pts_failure;
    }
    return IfdResult::success;
}

IfdResult IfdAdapter::power(std::uint64_t lun, IfdPowerAction action,
                            MutableByteView atr, std::size_t& atr_length) noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    if (!valid_lun(lun) || !channel_open()) {
        atr_length = 0U;
        return IfdResult::no_such_device;
    }
    if (action == IfdPowerAction::power_down) {
        if (atr.data != nullptr && atr.size != 0U) {
            std::memset(atr.data, 0, atr.size);
        }
        atr_length = 0U;
        if (card_handle_ == 0U) {
            clear_card_state();
            return IfdResult::success;
        }
        const auto disconnected = client_->disconnect(card_handle_);
        if (!disconnected) return fail(disconnected.error(), IfdOperation::power);
        card_handle_ = 0U;
        clear_card_state();
        return IfdResult::success;
    }
    const bool force_reset = action == IfdPowerAction::reset;
    const auto result = power_or_reset(force_reset);
    if (!result) {
        atr_length = 0U;
        return fail(result.error(), IfdOperation::power);
    }
    return copy_atr(atr, atr_length);
}

IfdResult IfdAdapter::transmit(std::uint64_t lun, std::uint32_t protocol,
                               ByteView apdu, MutableByteView response,
                               std::size_t& response_length) noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    response_length = 0U;
    if (!valid_lun(lun) || !channel_open()) return IfdResult::no_such_device;
    if (protocol != kIfdTransmitProtocolT1) {
        return IfdResult::protocol_not_supported;
    }
    if (!present_ || !powered_ || card_handle_ == 0U) {
        return IfdResult::icc_not_present;
    }
    if (apdu.data == nullptr || apdu.size == 0U ||
        apdu.size > kIfdApduMaxLength || response.data == nullptr ||
        response.size == 0U) {
        return IfdResult::communication_error;
    }
    const auto transmitted = client_->transmit(card_handle_, apdu, response);
    if (!transmitted) return fail(transmitted.error(), IfdOperation::transmit);
    response_length = transmitted.value();
    return IfdResult::success;
}

IfdResult IfdAdapter::control(std::uint64_t lun, std::uint32_t control_code,
                              ByteView input, MutableByteView output,
                              std::size_t& returned) noexcept
{
    (void)control_code;
    (void)input;
    (void)output;
    std::lock_guard<std::mutex> lock(mutex_);
    returned = 0U;
    return valid_lun(lun) && channel_open() ? IfdResult::not_supported :
                                             IfdResult::no_such_device;
}

IfdResult IfdAdapter::presence(std::uint64_t lun) noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    if (!valid_lun(lun) || !channel_open()) return IfdResult::no_such_device;
    const auto status = refresh_status();
    if (!status) return fail(status.error(), IfdOperation::status);
    return status.value().present ? IfdResult::icc_present :
                                    IfdResult::icc_not_present;
}

}  // namespace px4::userland::pcsc
