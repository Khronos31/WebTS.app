// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_PCSC_IFD_ADAPTER_H
#define PX4_USERLAND_PCSC_IFD_ADAPTER_H

#include "px4/error.h"
#include "px4/transport.h"

#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>

namespace px4::userland::pcsc {

inline constexpr std::size_t kIfdAtrMaxLength = 33U;
inline constexpr std::size_t kIfdApduMaxLength = 4096U;
inline constexpr std::size_t kIfdDeviceNameMaxLength = 1023U;
// IFDHSetProtocolParameters uses the PC/SC protocol bit mask, while the
// SCARD_IO_HEADER used by IFDHTransmitToICC carries the protocol number.
inline constexpr std::uint32_t kIfdSetProtocolT1 = 0x0002U;
inline constexpr std::uint32_t kIfdTransmitProtocolT1 = 1U;
inline constexpr std::uint8_t kIfdNegotiatePts1 = 0x01U;

// Values are private adapter semantics, not the platform ABI constants.
enum class IfdResult : std::uint8_t {
    success,
    error_tag,
    error_set_failure,
    error_value_read_only,
    error_pts_failure,
    protocol_not_supported,
    error_power_action,
    communication_error,
    response_timeout,
    not_supported,
    icc_present,
    icc_not_present,
    no_such_device,
    insufficient_buffer,
};

enum class IfdOperation : std::uint8_t {
    channel,
    status,
    power,
    transmit,
};

enum class IfdPowerAction : std::uint8_t {
    power_up,
    power_down,
    reset,
};

// Capability identifiers mirror the PC/SC values but stay independent of
// platform headers so the state core remains directly mock-testable.
inline constexpr std::uint32_t kTagIfdAtr = 0x0303U;
inline constexpr std::uint32_t kTagIfdSlotNumber = 0x0180U;
inline constexpr std::uint32_t kTagIfdSlotThreadSafe = 0x0facU;
inline constexpr std::uint32_t kTagIfdThreadSafe = 0x0fadU;
inline constexpr std::uint32_t kTagIfdSlotsNumber = 0x0faeU;
inline constexpr std::uint32_t kTagIfdSimultaneousAccess = 0x0fafU;
inline constexpr std::uint32_t kAttrVendorName = 0x00010100U;
inline constexpr std::uint32_t kAttrVendorIfdType = 0x00010101U;
inline constexpr std::uint32_t kAttrVendorIfdVersion = 0x00010102U;
inline constexpr std::uint32_t kAttrVendorIfdSerial = 0x00010103U;
inline constexpr std::uint32_t kAttrAsyncProtocolTypes = 0x00030120U;
inline constexpr std::uint32_t kAttrDefaultDataRate = 0x00030123U;
inline constexpr std::uint32_t kAttrMaxDataRate = 0x00030124U;
inline constexpr std::uint32_t kAttrMaxIfsd = 0x00030125U;
inline constexpr std::uint32_t kAttrCurrentProtocolType = 0x00080201U;
inline constexpr std::uint32_t kAttrIccPresence = 0x00090300U;
inline constexpr std::uint32_t kAttrIccInterfaceStatus = 0x00090301U;
inline constexpr std::uint32_t kAttrAtrString = 0x00090303U;
inline constexpr std::uint32_t kAttrMaxInput = 0x0007a007U;

struct IfdEndpoint final {
    std::string runtime_directory;
    std::string device_instance;
    bool group_access = false;
};

struct IfdCardStatus final {
    bool present = false;
    bool initialized = false;
    std::uint64_t reader_generation = 0U;
    std::array<std::uint8_t, kIfdAtrMaxLength> atr{};
    std::size_t atr_length = 0U;
};

struct IfdCardConnectResult final {
    std::uint64_t handle = 0U;
    std::array<std::uint8_t, kIfdAtrMaxLength> atr{};
    std::size_t atr_length = 0U;
};

// Grammar: px4-userland[:key=value]+.  ':' is chosen because pcsc-lite accepts
// it in unquoted DEVICENAME tokens; values therefore cannot contain ':'.
Result<IfdEndpoint> parse_ifd_device_name(const char* device_name) noexcept;
IfdResult map_ifd_error(Error error, IfdOperation operation) noexcept;

class IfdCardClient {
public:
    virtual ~IfdCardClient() noexcept = default;
    virtual Result<IfdCardStatus> status() noexcept = 0;
    virtual Result<IfdCardConnectResult> connect_shared() noexcept = 0;
    virtual Result<void> disconnect(std::uint64_t handle) noexcept = 0;
    virtual Result<IfdCardConnectResult> reset(std::uint64_t handle) noexcept = 0;
    virtual Result<std::size_t> transmit(std::uint64_t handle, ByteView apdu,
                                         MutableByteView response) noexcept = 0;
    virtual void close() noexcept = 0;
};

class IfdCardClientFactory {
public:
    virtual ~IfdCardClientFactory() noexcept = default;
    virtual Result<std::unique_ptr<IfdCardClient>> connect(
        const IfdEndpoint& endpoint) noexcept = 0;
};

class PosixIfdCardClientFactory final : public IfdCardClientFactory {
public:
    Result<std::unique_ptr<IfdCardClient>> connect(
        const IfdEndpoint& endpoint) noexcept override;
};

// One loaded IFD instance exposes exactly LUN 0 / slot 0. pcscd owns
// SCardBeginTransaction serialization above this ABI; this class serializes
// every IFD entry point and deliberately does not create nested IPC
// transactions around individual APDUs.
class IfdAdapter final {
public:
    explicit IfdAdapter(IfdCardClientFactory& factory) noexcept : factory_(factory) {}

    IfdResult create_channel_by_name(std::uint64_t lun,
                                     const char* device_name) noexcept;
    IfdResult create_channel(std::uint64_t lun, std::uint64_t channel) noexcept;
    IfdResult close_channel(std::uint64_t lun) noexcept;
    IfdResult get_capability(std::uint64_t lun, std::uint32_t tag,
                             MutableByteView output,
                             std::size_t& length) noexcept;
    IfdResult set_capability(std::uint64_t lun, std::uint32_t tag,
                             ByteView value) noexcept;
    IfdResult set_protocol(std::uint64_t lun, std::uint32_t protocol,
                           std::uint8_t flags, std::uint8_t pts1,
                           std::uint8_t pts2, std::uint8_t pts3) noexcept;
    IfdResult power(std::uint64_t lun, IfdPowerAction action,
                    MutableByteView atr, std::size_t& atr_length) noexcept;
    IfdResult transmit(std::uint64_t lun, std::uint32_t protocol,
                       ByteView apdu, MutableByteView response,
                       std::size_t& response_length) noexcept;
    IfdResult control(std::uint64_t lun, std::uint32_t control_code,
                      ByteView input, MutableByteView output,
                      std::size_t& returned) noexcept;
    IfdResult presence(std::uint64_t lun) noexcept;

private:
    bool valid_lun(std::uint64_t lun) const noexcept { return lun == 0U; }
    bool channel_open() const noexcept { return client_ != nullptr; }
    void clear_card_state() noexcept;
    void invalidate_channel() noexcept;
    IfdResult fail(Error error, IfdOperation operation) noexcept;
    Result<IfdCardStatus> refresh_status() noexcept;
    Result<IfdCardConnectResult> power_or_reset(bool force_reset) noexcept;
    IfdResult copy_atr(MutableByteView output, std::size_t& length) noexcept;

    IfdCardClientFactory& factory_;
    std::mutex mutex_;
    std::unique_ptr<IfdCardClient> client_;
    IfdEndpoint endpoint_{};
    std::uint64_t card_handle_ = 0U;
    std::uint64_t reader_generation_ = 0U;
    std::array<std::uint8_t, kIfdAtrMaxLength> atr_{};
    std::size_t atr_length_ = 0U;
    bool present_ = false;
    bool powered_ = false;
};

}  // namespace px4::userland::pcsc

#endif  // PX4_USERLAND_PCSC_IFD_ADAPTER_H
