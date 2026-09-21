/*
 * A winscard.h that is not PC/SC.
 *
 * libaribb25's b_cas_card.c is written against PC/SC. Everything valuable in
 * that file is the ARIB STD-B25 Part 3 response parsing, and none of it is
 * PC/SC-specific; the PC/SC surface it actually touches is six functions and
 * a handful of constants. So the file is vendored unmodified and this header,
 * plus native/winscard-q3u4.cpp, supplies that surface over the PX-Q3U4's
 * internal card reader.
 *
 * This is emphatically not a general PC/SC implementation. It supports what
 * b_cas_card.c does and nothing else: one reader, one card, T=1 only,
 * no SCardStatus, no SCardGetStatusChange, no attribute access, no T=0.
 * Anything else that included <winscard.h> and linked against this would be
 * making a mistake.
 *
 * The call sequence b_cas_card.c uses, which is what this supports:
 *   SCardEstablishContext -> SCardListReaders (for length, then for names)
 *   -> SCardConnect -> SCardTransmit * n -> SCardDisconnect
 *   -> SCardReleaseContext
 */

#ifndef WEBTS_WINSCARD_H
#define WEBTS_WINSCARD_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef long WEBTS_SCARD_LONG;
typedef unsigned long WEBTS_SCARD_DWORD;

#define LONG WEBTS_SCARD_LONG
#define DWORD WEBTS_SCARD_DWORD

typedef uintptr_t SCARDCONTEXT;
typedef uintptr_t SCARDHANDLE;

typedef struct {
    unsigned long dwProtocol;
    unsigned long cbPciLength;
} SCARD_IO_REQUEST;

extern const SCARD_IO_REQUEST webts_scard_pci_t1;
#define SCARD_PCI_T1 (&webts_scard_pci_t1)

#define SCARD_S_SUCCESS 0L
/* One failure code is enough: b_cas_card.c only ever compares against
 * SCARD_S_SUCCESS and turns anything else into its own error. */
#define SCARD_F_INTERNAL_ERROR ((LONG)0x80100001L)

#define SCARD_SCOPE_USER 0U
#define SCARD_SHARE_SHARED 2U
#define SCARD_PROTOCOL_T1 2U
#define SCARD_LEAVE_CARD 0U
#define SCARD_RESET_CARD 1U

LONG SCardEstablishContext(DWORD scope, const void* reserved1,
                           const void* reserved2, SCARDCONTEXT* context);
LONG SCardReleaseContext(SCARDCONTEXT context);
LONG SCardListReaders(SCARDCONTEXT context, const char* groups,
                      char* readers, DWORD* readers_length);
LONG SCardConnect(SCARDCONTEXT context, const char* reader, DWORD share_mode,
                  DWORD preferred_protocols, SCARDHANDLE* card,
                  DWORD* active_protocol);
LONG SCardDisconnect(SCARDHANDLE card, DWORD disposition);
LONG SCardTransmit(SCARDHANDLE card, const SCARD_IO_REQUEST* send_pci,
                   const uint8_t* send_buffer, DWORD send_length,
                   SCARD_IO_REQUEST* receive_pci, uint8_t* receive_buffer,
                   DWORD* receive_length);

#ifdef __cplusplus
}
#endif

#endif /* WEBTS_WINSCARD_H */
