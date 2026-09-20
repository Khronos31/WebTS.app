// SPDX-License-Identifier: GPL-2.0-only
#include "px4/pcsc_ifd_adapter.h"

extern "C" {
#include <ifdhandler.h>
}

#include <cstddef>
#include <cstdint>
#include <limits>

namespace {

using namespace px4::userland;
using namespace px4::userland::pcsc;

#if defined(__GNUC__) || defined(__clang__)
#define PX4_IFD_EXPORT extern "C" __attribute__((visibility("default")))
#else
#define PX4_IFD_EXPORT extern "C"
#endif

static_assert(TAG_IFD_ATR == kTagIfdAtr);
static_assert(TAG_IFD_SLOTNUM == kTagIfdSlotNumber);
static_assert(TAG_IFD_SLOT_THREAD_SAFE == kTagIfdSlotThreadSafe);
static_assert(TAG_IFD_THREAD_SAFE == kTagIfdThreadSafe);
static_assert(TAG_IFD_SLOTS_NUMBER == kTagIfdSlotsNumber);
static_assert(TAG_IFD_SIMULTANEOUS_ACCESS == kTagIfdSimultaneousAccess);
static_assert(SCARD_PROTOCOL_T1 == kIfdSetProtocolT1);
static_assert(kIfdTransmitProtocolT1 == 1U);
static_assert(IFD_NEGOTIATE_PTS1 == kIfdNegotiatePts1);
static_assert(MAX_ATR_SIZE == kIfdAtrMaxLength);

struct GlobalAdapter final {
    PosixIfdCardClientFactory factory;
    IfdAdapter adapter;

    GlobalAdapter() noexcept : adapter(factory) {}
};

GlobalAdapter& global_adapter() noexcept
{
    static GlobalAdapter value;
    return value;
}

RESPONSECODE response_code(IfdResult result) noexcept
{
    switch (result) {
    case IfdResult::success: return IFD_SUCCESS;
    case IfdResult::error_tag: return IFD_ERROR_TAG;
    case IfdResult::error_set_failure: return IFD_ERROR_SET_FAILURE;
    case IfdResult::error_value_read_only: return IFD_ERROR_VALUE_READ_ONLY;
    case IfdResult::error_pts_failure: return IFD_ERROR_PTS_FAILURE;
    case IfdResult::protocol_not_supported: return IFD_PROTOCOL_NOT_SUPPORTED;
    case IfdResult::error_power_action: return IFD_ERROR_POWER_ACTION;
    case IfdResult::communication_error: return IFD_COMMUNICATION_ERROR;
    case IfdResult::response_timeout: return IFD_RESPONSE_TIMEOUT;
    case IfdResult::not_supported: return IFD_NOT_SUPPORTED;
    case IfdResult::icc_present: return IFD_ICC_PRESENT;
    case IfdResult::icc_not_present: return IFD_ICC_NOT_PRESENT;
    case IfdResult::no_such_device: return IFD_NO_SUCH_DEVICE;
    case IfdResult::insufficient_buffer: return IFD_ERROR_INSUFFICIENT_BUFFER;
    }
    return IFD_COMMUNICATION_ERROR;
}

bool to_size(DWORD value, std::size_t& output) noexcept
{
    if (static_cast<std::uintmax_t>(value) >
        static_cast<std::uintmax_t>(std::numeric_limits<std::size_t>::max())) {
        return false;
    }
    output = static_cast<std::size_t>(value);
    return true;
}

bool to_dword(std::size_t value, DWORD& output) noexcept
{
    if (static_cast<std::uintmax_t>(value) >
        static_cast<std::uintmax_t>(std::numeric_limits<DWORD>::max())) {
        return false;
    }
    output = static_cast<DWORD>(value);
    return true;
}

}  // namespace

PX4_IFD_EXPORT RESPONSECODE IFDHCreateChannel(DWORD Lun, DWORD Channel)
{
    return response_code(global_adapter().adapter.create_channel(Lun, Channel));
}

PX4_IFD_EXPORT RESPONSECODE IFDHCreateChannelByName(DWORD Lun, LPSTR DeviceName)
{
    return response_code(
        global_adapter().adapter.create_channel_by_name(Lun, DeviceName));
}

PX4_IFD_EXPORT RESPONSECODE IFDHCloseChannel(DWORD Lun)
{
    return response_code(global_adapter().adapter.close_channel(Lun));
}

PX4_IFD_EXPORT RESPONSECODE IFDHGetCapabilities(DWORD Lun, DWORD Tag,
                                                PDWORD Length, PUCHAR Value)
{
    if (Length == nullptr) return IFD_COMMUNICATION_ERROR;
    std::size_t length = 0U;
    if (!to_size(*Length, length)) {
        *Length = 0U;
        return IFD_COMMUNICATION_ERROR;
    }
    const std::size_t capacity = length;
    const IfdResult result = global_adapter().adapter.get_capability(
        Lun, static_cast<std::uint32_t>(Tag),
        MutableByteView{Value, capacity}, length);
    if (!to_dword(length, *Length)) {
        *Length = 0U;
        return IFD_COMMUNICATION_ERROR;
    }
    return response_code(result);
}

PX4_IFD_EXPORT RESPONSECODE IFDHSetCapabilities(DWORD Lun, DWORD Tag,
                                                DWORD Length, PUCHAR Value)
{
    std::size_t length = 0U;
    if (!to_size(Length, length) || (length != 0U && Value == nullptr)) {
        return IFD_ERROR_SET_FAILURE;
    }
    return response_code(global_adapter().adapter.set_capability(
        Lun, static_cast<std::uint32_t>(Tag), ByteView{Value, length}));
}

PX4_IFD_EXPORT RESPONSECODE IFDHSetProtocolParameters(
    DWORD Lun, DWORD Protocol, UCHAR Flags, UCHAR PTS1, UCHAR PTS2, UCHAR PTS3)
{
    return response_code(global_adapter().adapter.set_protocol(
        Lun, static_cast<std::uint32_t>(Protocol), Flags, PTS1, PTS2, PTS3));
}

PX4_IFD_EXPORT RESPONSECODE IFDHPowerICC(DWORD Lun, DWORD Action, PUCHAR Atr,
                                         PDWORD AtrLength)
{
    if (AtrLength == nullptr) return IFD_COMMUNICATION_ERROR;
    std::size_t length = 0U;
    if (!to_size(*AtrLength, length)) {
        *AtrLength = 0U;
        return IFD_COMMUNICATION_ERROR;
    }
    IfdPowerAction action = IfdPowerAction::power_up;
    if (Action == IFD_POWER_UP) action = IfdPowerAction::power_up;
    else if (Action == IFD_POWER_DOWN) action = IfdPowerAction::power_down;
    else if (Action == IFD_RESET) action = IfdPowerAction::reset;
    else {
        *AtrLength = 0U;
        return IFD_NOT_SUPPORTED;
    }
    const std::size_t capacity = action == IfdPowerAction::power_down ?
                                     length : MAX_ATR_SIZE;
    if (action != IfdPowerAction::power_down) length = capacity;
    const IfdResult result = global_adapter().adapter.power(
        Lun, action, MutableByteView{Atr, capacity}, length);
    if (result != IfdResult::success) {
        *AtrLength = 0U;
        return response_code(result);
    }
    if (!to_dword(length, *AtrLength)) {
        *AtrLength = 0U;
        return IFD_COMMUNICATION_ERROR;
    }
    return response_code(result);
}

PX4_IFD_EXPORT RESPONSECODE IFDHTransmitToICC(
    DWORD Lun, SCARD_IO_HEADER SendPci, PUCHAR TxBuffer, DWORD TxLength,
    PUCHAR RxBuffer, PDWORD RxLength, PSCARD_IO_HEADER RecvPci)
{
    if (RxLength == nullptr || RecvPci == nullptr) {
        if (RxLength != nullptr) *RxLength = 0U;
        return IFD_COMMUNICATION_ERROR;
    }
    std::size_t tx_length = 0U;
    std::size_t rx_capacity = 0U;
    if (!to_size(TxLength, tx_length) || !to_size(*RxLength, rx_capacity) ||
        (tx_length != 0U && TxBuffer == nullptr) ||
        (rx_capacity != 0U && RxBuffer == nullptr)) {
        *RxLength = 0U;
        return IFD_COMMUNICATION_ERROR;
    }
    std::size_t response_length = 0U;
    const IfdResult result = global_adapter().adapter.transmit(
        Lun, static_cast<std::uint32_t>(SendPci.Protocol),
        ByteView{TxBuffer, tx_length}, MutableByteView{RxBuffer, rx_capacity},
        response_length);
    if (result != IfdResult::success) {
        *RxLength = 0U;
        return response_code(result);
    }
    if (!to_dword(response_length, *RxLength)) {
        *RxLength = 0U;
        return IFD_COMMUNICATION_ERROR;
    }
    RecvPci->Protocol = kIfdTransmitProtocolT1;
    RecvPci->Length = sizeof(SCARD_IO_HEADER);
    return IFD_SUCCESS;
}

PX4_IFD_EXPORT RESPONSECODE IFDHControl(
    DWORD Lun, DWORD dwControlCode, PUCHAR TxBuffer, DWORD TxLength,
    PUCHAR RxBuffer, DWORD RxLength, LPDWORD pdwBytesReturned)
{
    if (pdwBytesReturned == nullptr) return IFD_COMMUNICATION_ERROR;
    *pdwBytesReturned = 0U;
    std::size_t tx_length = 0U;
    std::size_t rx_length = 0U;
    if (!to_size(TxLength, tx_length) || !to_size(RxLength, rx_length) ||
        (tx_length != 0U && TxBuffer == nullptr) ||
        (rx_length != 0U && RxBuffer == nullptr)) {
        return IFD_COMMUNICATION_ERROR;
    }
    std::size_t returned = 0U;
    const IfdResult result = global_adapter().adapter.control(
        Lun, static_cast<std::uint32_t>(dwControlCode),
        ByteView{TxBuffer, tx_length}, MutableByteView{RxBuffer, rx_length},
        returned);
    if (!to_dword(returned, *pdwBytesReturned)) {
        *pdwBytesReturned = 0U;
        return IFD_COMMUNICATION_ERROR;
    }
    return response_code(result);
}

PX4_IFD_EXPORT RESPONSECODE IFDHICCPresence(DWORD Lun)
{
    return response_code(global_adapter().adapter.presence(Lun));
}
