/* SPDX-License-Identifier: GPL-2.0-or-later */
#include "stream-state.h"

#include <libusb.h>

int siano_stream_state_init(struct siano_stream_state *state)
{
    state->stopping = false;
    state->error = 0;
    return pthread_mutex_init(&state->mutex, NULL) == 0 ? 0 : -1;
}

void siano_stream_state_destroy(struct siano_stream_state *state)
{
    pthread_mutex_destroy(&state->mutex);
}

void siano_stream_state_stop(struct siano_stream_state *state)
{
    pthread_mutex_lock(&state->mutex);
    state->stopping = true;
    pthread_mutex_unlock(&state->mutex);
}

bool siano_stream_state_fail(struct siano_stream_state *state, int error)
{
    bool transitioned = false;

    pthread_mutex_lock(&state->mutex);
    if (!state->stopping) {
        state->stopping = true;
        state->error = error;
        transitioned = true;
    }
    pthread_mutex_unlock(&state->mutex);
    return transitioned;
}

bool siano_stream_state_is_stopping(struct siano_stream_state *state)
{
    bool stopping;

    pthread_mutex_lock(&state->mutex);
    stopping = state->stopping;
    pthread_mutex_unlock(&state->mutex);
    return stopping;
}

int siano_stream_state_error(struct siano_stream_state *state)
{
    int error;

    pthread_mutex_lock(&state->mutex);
    error = state->error;
    pthread_mutex_unlock(&state->mutex);
    return error;
}

int siano_stream_state_stream_result(struct siano_stream_state *state,
                                     int queue_result)
{
    int error = siano_stream_state_error(state);

    return error < 0 ? error : queue_result;
}

enum siano_transfer_action siano_transfer_classify_status(int status,
                                                          bool stopping)
{
    switch (status) {
    case LIBUSB_TRANSFER_COMPLETED:
        return SIANO_TRANSFER_COMPLETE;
    case LIBUSB_TRANSFER_TIMED_OUT:
        return SIANO_TRANSFER_RETRY;
    case LIBUSB_TRANSFER_CANCELLED:
        return stopping ? SIANO_TRANSFER_DRAIN : SIANO_TRANSFER_FATAL;
    default:
        return SIANO_TRANSFER_FATAL;
    }
}

int siano_transfer_status_error(int status)
{
    switch (status) {
    case LIBUSB_TRANSFER_NO_DEVICE:
        return LIBUSB_ERROR_NO_DEVICE;
    case LIBUSB_TRANSFER_ERROR:
        return LIBUSB_ERROR_IO;
    case LIBUSB_TRANSFER_STALL:
        return LIBUSB_ERROR_PIPE;
    case LIBUSB_TRANSFER_OVERFLOW:
        return LIBUSB_ERROR_OVERFLOW;
    case LIBUSB_TRANSFER_CANCELLED:
        return LIBUSB_ERROR_INTERRUPTED;
    default:
        return LIBUSB_ERROR_OTHER;
    }
}
