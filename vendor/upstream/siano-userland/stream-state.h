/* SPDX-License-Identifier: GPL-2.0-or-later */
#ifndef SIANO_STREAM_STATE_H
#define SIANO_STREAM_STATE_H

#include <stdbool.h>

#ifdef _WIN32
#include "siano-os.h"
#else
#include <pthread.h>
#endif

/* The first failure wins; a later graceful stop must not invent an error. */
struct siano_stream_state {
    pthread_mutex_t mutex;
    bool stopping;
    int error;
};

enum siano_transfer_action {
    SIANO_TRANSFER_COMPLETE,
    SIANO_TRANSFER_RETRY,
    SIANO_TRANSFER_DRAIN,
    SIANO_TRANSFER_FATAL,
};

int siano_stream_state_init(struct siano_stream_state *state);
void siano_stream_state_destroy(struct siano_stream_state *state);
void siano_stream_state_stop(struct siano_stream_state *state);
bool siano_stream_state_fail(struct siano_stream_state *state, int error);
bool siano_stream_state_is_stopping(struct siano_stream_state *state);
int siano_stream_state_error(struct siano_stream_state *state);
int siano_stream_state_stream_result(struct siano_stream_state *state,
                                     int queue_result);
enum siano_transfer_action siano_transfer_classify_status(int status,
                                                          bool stopping);
int siano_transfer_status_error(int status);

#endif
