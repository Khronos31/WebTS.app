/*
 * Deterministic release-first stop policy fixture. This models the narrow
 * ownership boundary around upstream stream-state.c without calling libusb,
 * WebUSB, a device, or the upstream static stop_streaming() function.
 */
#include "stream-state.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

enum {
    WEBTS_SIANO_STOP_OK = 0,
    WEBTS_SIANO_STOP_RELEASE_FAILED = 1,
    WEBTS_SIANO_STOP_PENDING_NOT_SETTLED = 2,
    WEBTS_SIANO_STOP_INVALID_ARGUMENT = 3,
    WEBTS_SIANO_STOP_INTERNAL = 4,
};

enum mock_phase {
    MOCK_STREAMING = 0,
    MOCK_STOPPED = 1,
    MOCK_FAILED = 2,
    MOCK_CLOSED = 3,
};

struct mock_session {
    struct siano_stream_state state;
    enum mock_phase phase;
    int active_transfers;
    bool interface_claimed;
    bool handle_open;
    bool release_succeeds;
    bool transfers_settle;
    unsigned release_calls;
    unsigned cancel_calls;
    unsigned close_calls;
    unsigned sequence;
    unsigned release_sequence;
    unsigned cancel_sequence;
    unsigned close_sequence;
};

static void mock_cancel_transfers(struct mock_session *session)
{
    session->cancel_sequence = ++session->sequence;
    session->cancel_calls += (unsigned)session->active_transfers;
    if (session->transfers_settle)
        session->active_transfers = 0;
}

static bool mock_release_interface(struct mock_session *session)
{
    session->release_sequence = ++session->sequence;
    session->release_calls++;
    if (!session->release_succeeds)
        return false;
    session->interface_claimed = false;
    return true;
}

static void mock_close_handle(struct mock_session *session)
{
    session->close_sequence = ++session->sequence;
    session->close_calls++;
    session->handle_open = false;
}

/*
 * Release is deliberately attempted before transfer cancellation. Chromium's
 * releaseInterface may settle WebUSB transfers, but this fixture does not
 * claim that behavior is guaranteed; the pending-not-settled branch refuses
 * to close/free the still-live handle.
 */
static uint32_t mock_stop(struct mock_session *session)
{
    if (session->phase == MOCK_CLOSED || session->phase == MOCK_STOPPED)
        return WEBTS_SIANO_STOP_OK;
    if (session->phase != MOCK_STREAMING)
        return WEBTS_SIANO_STOP_INVALID_ARGUMENT;

    siano_stream_state_stop(&session->state);
    if (session->interface_claimed && !mock_release_interface(session)) {
        session->phase = MOCK_FAILED;
        return WEBTS_SIANO_STOP_RELEASE_FAILED;
    }
    mock_cancel_transfers(session);
    if (session->active_transfers != 0) {
        session->phase = MOCK_FAILED;
        return WEBTS_SIANO_STOP_PENDING_NOT_SETTLED;
    }
    if (session->handle_open)
        mock_close_handle(session);
    session->phase = MOCK_CLOSED;
    return WEBTS_SIANO_STOP_OK;
}

/* scenario 0=settled success, 1=release failure, 2=pending not settled,
 * 3=repeat stop is idempotent. Only a fixed diagnostic crosses the ABI. */
int32_t webts_siano_release_first_stop_mock(uint32_t scenario)
{
    struct mock_session session = {0};
    int result;

    if (scenario > 3U)
        return WEBTS_SIANO_STOP_INVALID_ARGUMENT;
    if (siano_stream_state_init(&session.state) != 0)
        return WEBTS_SIANO_STOP_INTERNAL;
    session.phase = MOCK_STREAMING;
    session.active_transfers = 2;
    session.interface_claimed = true;
    session.handle_open = true;
    session.release_succeeds = scenario != 1U;
    session.transfers_settle = scenario != 2U;

    result = (int)mock_stop(&session);
    if (scenario == 0U) {
        if (result != WEBTS_SIANO_STOP_OK || session.release_calls != 1U ||
            session.cancel_calls != 2U || session.close_calls != 1U ||
            session.release_sequence >= session.cancel_sequence ||
            session.cancel_sequence >= session.close_sequence)
            result = WEBTS_SIANO_STOP_INTERNAL;
    } else if (scenario == 1U) {
        if (result != WEBTS_SIANO_STOP_RELEASE_FAILED || session.release_calls != 1U ||
            session.close_calls != 0U)
            result = WEBTS_SIANO_STOP_INTERNAL;
    } else if (scenario == 2U) {
        if (result != WEBTS_SIANO_STOP_PENDING_NOT_SETTLED || session.release_calls != 1U ||
            session.cancel_calls != 2U || session.close_calls != 0U)
            result = WEBTS_SIANO_STOP_INTERNAL;
    } else {
        if (result != WEBTS_SIANO_STOP_OK || mock_stop(&session) != WEBTS_SIANO_STOP_OK ||
            session.release_calls != 1U || session.cancel_calls != 2U || session.close_calls != 1U)
            result = WEBTS_SIANO_STOP_INTERNAL;
    }
    siano_stream_state_destroy(&session.state);
    return result;
}
