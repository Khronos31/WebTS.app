// The winscard surface b_cas_card.c needs, over the PX-Q3U4 internal reader.
//
// See native/winscard/winscard.h for why this exists and what it deliberately
// does not support.
//
// There is exactly one reader and one card, so there is exactly one binding.
// The caller installs a CardService before creating the B_CAS_CARD and removes
// it afterwards; nothing here owns the service or outlives it.
//
// Threading: like CardService itself, this is not internally serialized. It is
// used from the one driver pthread that owns the device, which is the same
// constraint upstream states for CardService.
//
// **No card response is logged or retained here.** Bytes pass through the
// caller's buffer and this file keeps none of them.

#include "winscard.h"

#include "px4/card_service.h"

#include <cstring>

using namespace px4::userland;

namespace {

struct Binding final {
    CardService* service = nullptr;
    CardClientId client = 0U;
    std::uint64_t handle = 0U;
    bool connected = false;
};

Binding g_binding;

// b_cas_card.c walks a multi-string of reader names, so the terminator must be
// a second NUL. The name is cosmetic: nothing dispatches on it.
constexpr char kReaderList[] = "PX-Q3U4\0";
constexpr std::size_t kReaderListLength = sizeof(kReaderList);

// Non-zero handles, so b_cas_card.c's `prv->card != 0` checks mean what they
// look like they mean.
constexpr SCARDCONTEXT kContext = 1U;
constexpr SCARDHANDLE kCard = 1U;

}  // namespace

extern "C" {

const SCARD_IO_REQUEST webts_scard_pci_t1 = {SCARD_PROTOCOL_T1,
                                             sizeof(SCARD_IO_REQUEST)};

/** Install the service the shim talks to. Call before create_b_cas_card(). */
void webts_winscard_bind(void* service, std::uint64_t client) {
    g_binding.service = static_cast<CardService*>(service);
    g_binding.client = client;
    g_binding.handle = 0U;
    g_binding.connected = false;
}

/** Remove the binding. The service is not touched; the caller owns it. */
void webts_winscard_unbind(void) {
    g_binding = Binding{};
}

LONG SCardEstablishContext(DWORD, const void*, const void*, SCARDCONTEXT* context) {
    if (context == nullptr) return SCARD_F_INTERNAL_ERROR;
    if (g_binding.service == nullptr) return SCARD_F_INTERNAL_ERROR;
    *context = kContext;
    return SCARD_S_SUCCESS;
}

LONG SCardReleaseContext(SCARDCONTEXT context) {
    return context == kContext ? SCARD_S_SUCCESS : SCARD_F_INTERNAL_ERROR;
}

/**
 * Two-call pattern: a null buffer asks for the length, then the same length is
 * passed back with a buffer. b_cas_card.c adds 256 slack to the length it got,
 * so writing only what fits is the safe reading of the contract.
 */
LONG SCardListReaders(SCARDCONTEXT context, const char*, char* readers,
                      DWORD* readers_length) {
    if (context != kContext || readers_length == nullptr) return SCARD_F_INTERNAL_ERROR;
    if (readers == nullptr) {
        *readers_length = static_cast<DWORD>(kReaderListLength);
        return SCARD_S_SUCCESS;
    }
    if (*readers_length < kReaderListLength) return SCARD_F_INTERNAL_ERROR;
    std::memcpy(readers, kReaderList, kReaderListLength);
    *readers_length = static_cast<DWORD>(kReaderListLength);
    return SCARD_S_SUCCESS;
}

LONG SCardConnect(SCARDCONTEXT context, const char*, DWORD,
                  DWORD preferred_protocols, SCARDHANDLE* card,
                  DWORD* active_protocol) {
    if (context != kContext || card == nullptr) return SCARD_F_INTERNAL_ERROR;
    if (g_binding.service == nullptr) return SCARD_F_INTERNAL_ERROR;
    // T=1 only. The card is T=1 and CardSession speaks nothing else.
    if ((preferred_protocols & SCARD_PROTOCOL_T1) == 0U) return SCARD_F_INTERNAL_ERROR;
    if (g_binding.connected) return SCARD_F_INTERNAL_ERROR;

    const auto connected =
        g_binding.service->connect(g_binding.client, ipc::ShareMode::exclusive);
    if (!connected) return SCARD_F_INTERNAL_ERROR;
    g_binding.handle = connected.value().handle;
    g_binding.connected = true;
    *card = kCard;
    if (active_protocol != nullptr) *active_protocol = SCARD_PROTOCOL_T1;
    return SCARD_S_SUCCESS;
}

LONG SCardDisconnect(SCARDHANDLE card, DWORD disposition) {
    if (card != kCard) return SCARD_F_INTERNAL_ERROR;
    if (g_binding.service == nullptr || !g_binding.connected) return SCARD_F_INTERNAL_ERROR;
    const auto disconnected = g_binding.service->disconnect(
        g_binding.client, g_binding.handle,
        disposition == SCARD_RESET_CARD ? ipc::Disposition::reset
                                        : ipc::Disposition::leave);
    g_binding.connected = false;
    g_binding.handle = 0U;
    return disconnected ? SCARD_S_SUCCESS : SCARD_F_INTERNAL_ERROR;
}

LONG SCardTransmit(SCARDHANDLE card, const SCARD_IO_REQUEST*,
                   const uint8_t* send_buffer, DWORD send_length,
                   SCARD_IO_REQUEST*, uint8_t* receive_buffer,
                   DWORD* receive_length) {
    if (card != kCard || send_buffer == nullptr || receive_buffer == nullptr ||
        receive_length == nullptr) {
        return SCARD_F_INTERNAL_ERROR;
    }
    if (g_binding.service == nullptr || !g_binding.connected) return SCARD_F_INTERNAL_ERROR;

    const auto transmitted = g_binding.service->transmit(
        g_binding.client, g_binding.handle,
        ByteView{send_buffer, static_cast<std::size_t>(send_length)},
        MutableByteView{receive_buffer, static_cast<std::size_t>(*receive_length)});
    if (!transmitted) return SCARD_F_INTERNAL_ERROR;
    *receive_length = static_cast<DWORD>(transmitted.value());
    return SCARD_S_SUCCESS;
}

}  // extern "C"
