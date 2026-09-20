/* Build-only ABI seam for the vendored Siano Rio identity predicate. */
#include <libusb.h>

#include <stddef.h>
#include <stdint.h>
#include <errno.h>
#include <stdio.h>

static int webts_siano_discard_output(FILE *stream, const char *format, ...)
{
    (void)stream;
    (void)format;
    return 0;
}

/* Keep upstream CLI diagnostics out of browser stdout/stderr. */
#define fprintf(...) webts_siano_discard_output(__VA_ARGS__)
#define printf(...) webts_siano_discard_output(stdout, __VA_ARGS__)

/*
 * Keep the upstream predicate as the single source of supported VID/PID
 * truth. The source is included only in this overlay translation unit so its
 * static is_rio_id() remains callable without modifying the vendor snapshot.
 * The CLI entry point is renamed and is never called.
 */
#define main webts_siano_ts_cli_main
#ifdef WEBTS_SIANO_TS_COUNTERS_PATCHED
#include "siano-ts-counters-patched.c"
#else
#include "../vendor/upstream/siano-userland/siano-ts.c"
#endif
#undef main
#undef fprintf
#undef printf

static void LIBUSB_CALL discard_libusb_log(libusb_context *context,
                                            enum libusb_log_level level,
                                            const char *message)
{
    (void)context;
    (void)level;
    (void)message;
}

static uint8_t map_libusb_diagnostic(int error)
{
    if (error == 0)
        return 0U;
    switch (error) {
    case LIBUSB_ERROR_IO: return 1U;
    case LIBUSB_ERROR_INVALID_PARAM: return 2U;
    case LIBUSB_ERROR_ACCESS: return 3U;
    case LIBUSB_ERROR_NO_DEVICE: return 4U;
    case LIBUSB_ERROR_NOT_FOUND: return 5U;
    case LIBUSB_ERROR_BUSY: return 6U;
    case LIBUSB_ERROR_TIMEOUT: return 7U;
    case LIBUSB_ERROR_OVERFLOW: return 8U;
    case LIBUSB_ERROR_PIPE: return 9U;
    case LIBUSB_ERROR_INTERRUPTED: return 10U;
    case LIBUSB_ERROR_NO_MEM: return 11U;
    case LIBUSB_ERROR_NOT_SUPPORTED: return 12U;
    default: return 13U;
    }
}

/* start_streaming mixes pthread/allocator and libusb return conventions. */
static uint8_t map_handshake_start_diagnostic(int error)
{
    (void)error;
    return 13U; /* OTHER: do not reinterpret a negative POSIX errno. */
}

/* get_version() can return a wait_response() errno or a libusb bulk error. */
static uint8_t map_handshake_version_diagnostic(int error)
{
    return error == -ETIMEDOUT ? 7U : 13U;
}

static uint32_t pack_result(uint8_t diagnostic, size_t supported_count)
{
    const uint32_t bounded = supported_count > 255U ? 255U : (uint32_t)supported_count;
    return (uint32_t)diagnostic | (bounded << 8U);
}

/*
 * bits 0..7 = fixed libusb diagnostic enum, bits 8..15 = supported Rio
 * device count (saturated at 255). No serial, log, descriptor, or payload
 * data crosses this boundary. The official backend may temporarily open a
 * device and issue standard descriptor control-IN requests while listing.
 */
uint32_t webts_siano_enumerate_rio(void)
{
    libusb_context *usb = NULL;
    libusb_device **list = NULL;
    ssize_t count;
    size_t supported_count = 0U;
    int result;

    /* Install before libusb_init(), so initialization diagnostics never reach stderr. */
    libusb_set_log_cb(NULL, discard_libusb_log, LIBUSB_LOG_CB_GLOBAL);
    result = libusb_init(&usb);
    if (result != 0 || usb == NULL)
        return pack_result((uint8_t)(result == 0 ? 13 : map_libusb_diagnostic(result)), 0U);

    count = libusb_get_device_list(usb, &list);
    if (count < 0) {
        libusb_exit(usb);
        return pack_result(map_libusb_diagnostic((int)count), 0U);
    }
    for (ssize_t index = 0; index < count; ++index) {
        struct libusb_device_descriptor descriptor;
        result = libusb_get_device_descriptor(list[index], &descriptor);
        if (result == 0 && is_rio_id(descriptor.idVendor, descriptor.idProduct))
            ++supported_count;
    }
    libusb_free_device_list(list, 1);
    libusb_exit(usb);
    return pack_result(0U, supported_count);
}

/*
 * Build-only lifecycle probe: create the upstream libusb/device state and
 * close it again without selecting a device. This exercises the successful
 * init_device_state()/close_device() pair while avoiding open_rio(), whose
 * contract claims an interface and clears both bulk endpoint halts.
 *
 * init_device_state() predates this boundary and does not provide a rollback
 * API for an injected mid-initialization failure. Therefore close_device() is
 * called only after a fully successful init; partial-init failure is reported
 * and the context is released without pretending that cleanup was complete.
 */
uint32_t webts_siano_lifecycle_create_close(void)
{
    libusb_context *usb = NULL;
    struct siano_device device;
    int result;

    libusb_set_log_cb(NULL, discard_libusb_log, LIBUSB_LOG_CB_GLOBAL);
    result = libusb_init(&usb);
    if (result != 0 || usb == NULL)
        return pack_result((uint8_t)(result == 0 ? 13 : map_libusb_diagnostic(result)), 0U);

    result = init_device_state(&device, usb, false);
    if (result != 0) {
        /* The upstream partial-init path has no safe public rollback seam. */
        libusb_exit(usb);
        return pack_result(13U, 0U);
    }
    close_device(&device);
    libusb_exit(usb);
    return pack_result(0U, 0U);
}

/*
 * Link-only reference to the upstream open/close path. Calling open_rio()
 * would claim an interface and clear endpoint halts, so this export records
 * symbol retention without performing any device-affecting operation.
 */
uint32_t webts_siano_lifecycle_open_link_smoke(void)
{
    typedef int (*open_fn)(struct siano_device *, int);
    typedef void (*close_fn)(struct siano_device *);
    volatile open_fn open_entry = open_rio;
    volatile close_fn close_entry = close_device;
    return (open_entry != NULL && close_entry != NULL) ? pack_result(0U, 0U)
                                                        : pack_result(13U, 0U);
}

enum {
    WEBTS_SIANO_OPT_IN_MAGIC = 0x53494f31U,
    WEBTS_SIANO_MAX_INDEX = 63,
    WEBTS_SIANO_MAX_FIRMWARE_SIZE = 16U * 1024U * 1024U
};

static struct siano_device webts_siano_session_device;
static libusb_context *webts_siano_session_usb;
static uint32_t webts_siano_session_generation;
enum webts_siano_session_state {
    WEBTS_SIANO_IDLE = 0,
    WEBTS_SIANO_OPENING = 1,
    WEBTS_SIANO_OPEN = 2,
    WEBTS_SIANO_CLOSING = 3,
    WEBTS_SIANO_POISONED = 4,
    WEBTS_SIANO_STARTING = 5,
    WEBTS_SIANO_STREAMING = 6,
    WEBTS_SIANO_VERSIONED = 7
};
static enum webts_siano_session_state webts_siano_session_state;

/*
 * Real open/close ABI. The magic is an accidental-call gate, not a security
 * boundary; future UI wiring still requires explicit user gesture and target
 * confirmation. This export is intentionally not wired to the current UI.
 */
uint32_t webts_siano_lifecycle_open(uint32_t magic, int requested_index)
{
    int result;

    if (magic != WEBTS_SIANO_OPT_IN_MAGIC || requested_index < 0 ||
        requested_index > WEBTS_SIANO_MAX_INDEX)
        return pack_result(2U, 0U);
    if (webts_siano_session_state == WEBTS_SIANO_POISONED)
        return pack_result(13U, 0U);
    if (webts_siano_session_state != WEBTS_SIANO_IDLE)
        return pack_result(6U, 0U);
    webts_siano_session_state = WEBTS_SIANO_OPENING;

    webts_siano_session_usb = NULL;
    libusb_set_log_cb(NULL, discard_libusb_log, LIBUSB_LOG_CB_GLOBAL);
    result = libusb_init(&webts_siano_session_usb);
    if (result != 0 || webts_siano_session_usb == NULL) {
        webts_siano_session_usb = NULL;
        webts_siano_session_state = WEBTS_SIANO_IDLE;
        return pack_result((uint8_t)(result == 0 ? 13 : map_libusb_diagnostic(result)), 0U);
    }

    result = init_device_state(&webts_siano_session_device,
                               webts_siano_session_usb, false);
    if (result != 0) {
        /* Upstream has no rollback API for partial init: module disposal is terminal. */
        libusb_exit(webts_siano_session_usb);
        webts_siano_session_usb = NULL;
        webts_siano_session_state = WEBTS_SIANO_POISONED;
        return pack_result(13U, 0U);
    }
    /* close_device() releases an interface only when this is non-negative. */
    webts_siano_session_device.interface_number = -1;
    result = open_rio(&webts_siano_session_device, requested_index);
    if (result != 0) {
        /* open_rio() may have opened a handle before inspect/claim failed. */
        webts_siano_session_device.interface_number = -1;
        close_device(&webts_siano_session_device);
        libusb_exit(webts_siano_session_usb);
        webts_siano_session_usb = NULL;
        webts_siano_session_state = WEBTS_SIANO_IDLE;
        return pack_result(map_libusb_diagnostic(result), 0U);
    }
    webts_siano_session_state = WEBTS_SIANO_OPEN;
    if (webts_siano_session_generation != UINT32_MAX)
        webts_siano_session_generation++;
    return pack_result(0U, 0U);
}

/* Idempotent close for the one active session; a later open may reuse it. */
uint32_t webts_siano_lifecycle_close(uint32_t magic)
{
    if (magic != WEBTS_SIANO_OPT_IN_MAGIC)
        return pack_result(2U, 0U);
    if (webts_siano_session_state == WEBTS_SIANO_IDLE)
        return pack_result(0U, 0U);
    if (webts_siano_session_state == WEBTS_SIANO_POISONED)
        return pack_result(13U, 0U);
    if (webts_siano_session_state != WEBTS_SIANO_OPEN &&
        webts_siano_session_state != WEBTS_SIANO_STREAMING &&
        webts_siano_session_state != WEBTS_SIANO_VERSIONED)
        return pack_result(6U, 0U);

    webts_siano_session_state = WEBTS_SIANO_CLOSING;
    close_device(&webts_siano_session_device);
    libusb_exit(webts_siano_session_usb);
    webts_siano_session_usb = NULL;
    webts_siano_session_state = WEBTS_SIANO_IDLE;
    return pack_result(0U, 0U);
}

/*
 * Build-only opt-in bridge for the upstream stream/version handshake. This
 * deliberately follows open() and precedes firmware mode selection. The
 * start_streaming() path submits bulk-IN transfers and get_version() sends a
 * bulk-OUT request, so this export is not wired to the browser UI yet.
 * close() remains valid after every start/get_version outcome and owns the
 * partial-submit cleanup through upstream close_device().
 *
 * low byte = start diagnostic, high byte = get_version diagnostic.
 */
uint32_t webts_siano_lifecycle_start_version(uint32_t magic)
{
    int start_result;
    int version_result = 0;

    if (magic != WEBTS_SIANO_OPT_IN_MAGIC)
        return pack_result(2U, 2U);
    if (webts_siano_session_state == WEBTS_SIANO_POISONED)
        return pack_result(13U, 13U);
    if (webts_siano_session_state != WEBTS_SIANO_OPEN)
        return pack_result(6U, 6U);

    webts_siano_session_state = WEBTS_SIANO_STARTING;
    start_result = start_streaming(&webts_siano_session_device);
    /* close_device() must be allowed to observe event_thread_started after a
     * partial allocation/submit failure, so retain a cleanup-capable state. */
    webts_siano_session_state = WEBTS_SIANO_STREAMING;
    if (start_result != 0)
        return pack_result(map_handshake_start_diagnostic(start_result), 13U);

    version_result = get_version(&webts_siano_session_device);
    if (version_result != 0)
        return pack_result(0U, map_handshake_version_diagnostic(version_result));

    webts_siano_session_state = WEBTS_SIANO_VERSIONED;
    return pack_result(0U, 0U);
}

/* One-shot native boundary: low byte=open diagnostic, next byte=close diagnostic. */
uint32_t webts_siano_lifecycle_open_close_probe(uint32_t magic, int requested_index)
{
    const uint32_t open_result = webts_siano_lifecycle_open(magic, requested_index);
    const uint32_t close_result = webts_siano_lifecycle_close(magic);
    return (open_result & 0xffU) | ((close_result & 0xffU) << 8U);
}

enum {
    WEBTS_SIANO_TS_QUEUE_OK = 0U,
    WEBTS_SIANO_TS_QUEUE_REJECTED = 1U,
    WEBTS_SIANO_TS_QUEUE_INVALID_ARGUMENT = 2U,
    WEBTS_SIANO_TS_QUEUE_INTERNAL = 255U,
    WEBTS_SIANO_TS_QUEUE_WORDS = 7U
};

/*
 * Source-backed, USB-free ts_queue fixture. Output words are diagnostic,
 * accepted bytes, dequeued bytes, dropped chunks, queued chunks, lifecycle
 * flags, and accepted chunks. No queue bytes or payload leave this ABI.
 * scenario 0=FIFO/drain/reinit, 1=capacity drop, 2=close/drop, 3=truncate,
 * 4=reinitialize; all other scenarios are invalid.
 */
uint32_t webts_siano_ts_queue_mock(uint32_t scenario, uint32_t output_ptr,
                                   uint32_t output_words)
{
    uint32_t *output = (uint32_t *)(uintptr_t)output_ptr;
    struct ts_queue *queue;
    uint8_t small_a[3] = {1U, 2U, 3U};
    uint8_t small_b[2] = {4U, 5U};
    uint8_t popped[USB_TRANSFER_SIZE];
    uint8_t large[USB_TRANSFER_SIZE + 9U];
    size_t accepted_bytes = 0U;
    size_t dequeued_bytes = 0U;
    size_t accepted_chunks = 0U;
    size_t popped_length;
    size_t before_count;
    uint32_t diagnostic = WEBTS_SIANO_TS_QUEUE_OK;
    uint32_t flags = 0U;
    int queue_ready = 1;
    int rc;

    if (output == NULL || output_words < WEBTS_SIANO_TS_QUEUE_WORDS || scenario > 4U)
        return WEBTS_SIANO_TS_QUEUE_INVALID_ARGUMENT;
    for (uint32_t i = 0U; i < WEBTS_SIANO_TS_QUEUE_WORDS; ++i)
        output[i] = 0U;

    /* ts_queue is about 4 MiB (256 x 16 KiB); never place it on the stack. */
    queue = calloc(1U, sizeof(*queue));
    if (queue == NULL)
        return WEBTS_SIANO_TS_QUEUE_INTERNAL;
    if (ts_queue_init(queue) != 0) {
        free(queue);
        return WEBTS_SIANO_TS_QUEUE_INTERNAL;
    }

    switch (scenario) {
    case 0U:
        before_count = queue->count;
        ts_enqueue(queue, small_a, sizeof(small_a));
        if (queue->count != before_count) {
            accepted_bytes += sizeof(small_a);
            accepted_chunks++;
        }
        before_count = queue->count;
        ts_enqueue(queue, small_b, sizeof(small_b));
        if (queue->count != before_count) {
            accepted_bytes += sizeof(small_b);
            accepted_chunks++;
        }
        popped_length = 0U;
        rc = ts_pop(queue, popped, &popped_length);
        if (rc != 0 || popped_length != sizeof(small_a) ||
            memcmp(popped, small_a, sizeof(small_a)) != 0) {
            diagnostic = WEBTS_SIANO_TS_QUEUE_INTERNAL;
            break;
        }
        dequeued_bytes += popped_length;
        popped_length = 0U;
        rc = ts_pop(queue, popped, &popped_length);
        if (rc != 0 || popped_length != sizeof(small_b) ||
            memcmp(popped, small_b, sizeof(small_b)) != 0) {
            diagnostic = WEBTS_SIANO_TS_QUEUE_INTERNAL;
            break;
        }
        dequeued_bytes += popped_length;
        flags |= 1U << 1U; /* FIFO verified without exposing payload. */
        ts_queue_close(queue);
        ts_queue_destroy(queue);
        memset(queue, 0, sizeof(*queue));
        if (ts_queue_init(queue) != 0) {
            diagnostic = WEBTS_SIANO_TS_QUEUE_INTERNAL;
            queue_ready = 0;
            break;
        }
        flags |= 1U << 2U; /* reinitialization completed. */
        break;
    case 1U:
        for (size_t index = 0U; index < TS_QUEUE_SLOTS + 1U; ++index) {
            before_count = queue->count;
            ts_enqueue(queue, small_a, 1U);
            if (queue->count != before_count) {
                accepted_bytes++;
                accepted_chunks++;
            }
        }
        break;
    case 2U:
        before_count = queue->count;
        ts_enqueue(queue, small_a, 1U);
        if (queue->count != before_count) {
            accepted_bytes++;
            accepted_chunks++;
        }
        ts_queue_close(queue);
        flags |= 1U;
        before_count = queue->count;
        ts_enqueue(queue, small_b, sizeof(small_b));
        if (queue->count != before_count)
            diagnostic = WEBTS_SIANO_TS_QUEUE_INTERNAL;
        popped_length = 0U;
        rc = ts_pop(queue, popped, &popped_length);
        if (rc != 0 || popped_length != 1U)
            diagnostic = WEBTS_SIANO_TS_QUEUE_INTERNAL;
        else
            dequeued_bytes++;
        popped_length = 0U;
        if (ts_pop(queue, popped, &popped_length) == 0)
            diagnostic = WEBTS_SIANO_TS_QUEUE_INTERNAL;
        break;
    case 3U:
        memset(large, 0xa5, sizeof(large));
        before_count = queue->count;
        ts_enqueue(queue, large, sizeof(large));
        if (queue->count != before_count) {
            accepted_bytes += USB_TRANSFER_SIZE;
            accepted_chunks++;
        }
        popped_length = 0U;
        rc = ts_pop(queue, popped, &popped_length);
        if (rc != 0 || popped_length != USB_TRANSFER_SIZE)
            diagnostic = WEBTS_SIANO_TS_QUEUE_INTERNAL;
        else
            dequeued_bytes += popped_length;
        break;
    case 4U:
        ts_queue_close(queue);
        flags |= 1U;
        ts_queue_destroy(queue);
        memset(queue, 0, sizeof(*queue));
        if (ts_queue_init(queue) != 0) {
            diagnostic = WEBTS_SIANO_TS_QUEUE_INTERNAL;
            queue_ready = 0;
            break;
        }
        flags |= 1U << 2U;
        before_count = queue->count;
        ts_enqueue(queue, small_b, sizeof(small_b));
        if (queue->count != before_count) {
            accepted_bytes += sizeof(small_b);
            accepted_chunks++;
        }
        break;
    default:
        diagnostic = WEBTS_SIANO_TS_QUEUE_INVALID_ARGUMENT;
        break;
    }

    if (!queue_ready) {
        output[0] = WEBTS_SIANO_TS_QUEUE_INTERNAL;
        free(queue);
        return WEBTS_SIANO_TS_QUEUE_INTERNAL;
    }
    output[0] = diagnostic;
    output[1] = accepted_bytes > UINT32_MAX ? UINT32_MAX : (uint32_t)accepted_bytes;
    output[2] = dequeued_bytes > UINT32_MAX ? UINT32_MAX : (uint32_t)dequeued_bytes;
    output[3] = queue->drops > UINT32_MAX ? UINT32_MAX : (uint32_t)queue->drops;
    output[4] = queue->count > UINT32_MAX ? UINT32_MAX : (uint32_t)queue->count;
    output[5] = flags;
    output[6] = accepted_chunks > UINT32_MAX ? UINT32_MAX : (uint32_t)accepted_chunks;
    ts_queue_close(queue);
    ts_queue_destroy(queue);
    free(queue);
    return diagnostic;
}

enum {
    WEBTS_SIANO_STATS_OK = 0U,
    WEBTS_SIANO_STATS_STALE = 1U,
    WEBTS_SIANO_STATS_INVALID_ARGUMENT = 2U,
    WEBTS_SIANO_STATS_BUSY = 3U,
    WEBTS_SIANO_STATS_POISONED = 4U,
    WEBTS_SIANO_STATS_INTERNAL = 255U,
    WEBTS_SIANO_STATS_WORDS = 18U,
    WEBTS_SIANO_STATS_QUEUE_MEASURED = 1U << 0U,
    WEBTS_SIANO_STATS_DROPS_MEASURED = 1U << 1U,
    WEBTS_SIANO_STATS_TRANSFERS_MEASURED = 1U << 2U,
    WEBTS_SIANO_STATS_ERROR_MEASURED = 1U << 3U,
    WEBTS_SIANO_STATS_QUEUE_CLOSED = 1U << 4U,
    WEBTS_SIANO_STATS_ACCEPTED_BYTES_UNMEASURED = 1U << 5U,
    WEBTS_SIANO_STATS_DEQUEUED_BYTES_UNMEASURED = 1U << 6U,
    WEBTS_SIANO_STATS_TRANSFER_ERRORS_UNMEASURED = 1U << 7U,
    WEBTS_SIANO_STATS_STALE_SESSION = 1U << 8U,
    WEBTS_SIANO_STATS_COUNTERS_SATURATED = 1U << 9U
};

static void webts_siano_write_u64(uint32_t *output, uint32_t index, uint64_t value)
{
    output[index] = (uint32_t)value;
    output[index + 1U] = (uint32_t)(value >> 32U);
}

enum webts_siano_stats_state {
    WEBTS_SIANO_STATS_STATE_IDLE = 0U,
    WEBTS_SIANO_STATS_STATE_OPEN = 1U,
    WEBTS_SIANO_STATS_STATE_STREAMING = 2U,
    WEBTS_SIANO_STATS_STATE_VERSIONED = 3U,
    WEBTS_SIANO_STATS_STATE_POISONED = 4U,
    WEBTS_SIANO_STATS_STATE_OPENING = 5U,
    WEBTS_SIANO_STATS_STATE_CLOSING = 6U,
    WEBTS_SIANO_STATS_STATE_STARTING = 7U
};

enum webts_siano_stats_error {
    WEBTS_SIANO_STATS_ERROR_NONE = 0U,
    WEBTS_SIANO_STATS_ERROR_IO = 1U,
    WEBTS_SIANO_STATS_ERROR_NO_DEVICE = 2U,
    WEBTS_SIANO_STATS_ERROR_INTERRUPTED = 3U,
    WEBTS_SIANO_STATS_ERROR_TIMEOUT = 4U,
    WEBTS_SIANO_STATS_ERROR_OTHER = 5U
};

static uint32_t webts_siano_map_stream_error(int error)
{
    if (error == 0)
        return WEBTS_SIANO_STATS_ERROR_NONE;
    if (error == LIBUSB_ERROR_IO)
        return WEBTS_SIANO_STATS_ERROR_IO;
    if (error == LIBUSB_ERROR_NO_DEVICE)
        return WEBTS_SIANO_STATS_ERROR_NO_DEVICE;
    if (error == LIBUSB_ERROR_INTERRUPTED)
        return WEBTS_SIANO_STATS_ERROR_INTERRUPTED;
    if (error == LIBUSB_ERROR_TIMEOUT)
        return WEBTS_SIANO_STATS_ERROR_TIMEOUT;
    return WEBTS_SIANO_STATS_ERROR_OTHER;
}

/* Read only the fields guarded by upstream's own mutexes. */
static void webts_siano_snapshot_device(const struct siano_device *device,
                                        uint32_t *output)
{
    int active_transfers;
    int stream_error;
    size_t queue_count;
    uint64_t drops;
    uint64_t accepted_bytes;
    uint64_t dequeued_bytes;
    uint64_t dropped_bytes;
    uint64_t truncated_bytes;
    uint64_t transfer_error_events;
    bool queue_closed;
    bool counters_saturated;

    pthread_mutex_lock((pthread_mutex_t *)&device->state.mutex);
    active_transfers = device->active_transfers;
    stream_error = device->state.error;
    transfer_error_events = device->transfer_error_events;
    counters_saturated = device->counters_saturated;
    pthread_mutex_unlock((pthread_mutex_t *)&device->state.mutex);

    pthread_mutex_lock((pthread_mutex_t *)&device->ts.mutex);
    queue_count = device->ts.count;
    drops = device->ts.drops;
    accepted_bytes = device->ts.accepted_bytes;
    dequeued_bytes = device->ts.dequeued_bytes;
    dropped_bytes = device->ts.dropped_bytes;
    truncated_bytes = device->ts.truncated_bytes;
    counters_saturated = counters_saturated || device->ts.counters_saturated;
    queue_closed = device->ts.closed;
    pthread_mutex_unlock((pthread_mutex_t *)&device->ts.mutex);

    output[3] = WEBTS_SIANO_STATS_QUEUE_MEASURED |
                WEBTS_SIANO_STATS_DROPS_MEASURED |
                WEBTS_SIANO_STATS_TRANSFERS_MEASURED |
                WEBTS_SIANO_STATS_ERROR_MEASURED;
    if (queue_closed)
        output[3] |= WEBTS_SIANO_STATS_QUEUE_CLOSED;
    if (counters_saturated)
        output[3] |= WEBTS_SIANO_STATS_COUNTERS_SATURATED;
    output[4] = queue_count > UINT32_MAX ? UINT32_MAX : (uint32_t)queue_count;
    output[5] = drops > UINT32_MAX ? UINT32_MAX : (uint32_t)drops;
    output[6] = active_transfers < 0 ? 0U : (uint32_t)active_transfers;
    output[7] = webts_siano_map_stream_error(stream_error);
    webts_siano_write_u64(output, 8U, accepted_bytes);
    webts_siano_write_u64(output, 10U, dequeued_bytes);
    webts_siano_write_u64(output, 12U, dropped_bytes);
    webts_siano_write_u64(output, 14U, truncated_bytes);
    webts_siano_write_u64(output, 16U, transfer_error_events);
}

static void webts_siano_write_unmeasured_stats(uint32_t *output)
{
    output[3] = WEBTS_SIANO_STATS_ACCEPTED_BYTES_UNMEASURED |
                WEBTS_SIANO_STATS_DEQUEUED_BYTES_UNMEASURED |
                WEBTS_SIANO_STATS_TRANSFER_ERRORS_UNMEASURED;
}

static uint32_t webts_siano_stats_snapshot_state(
    uint32_t state, uint32_t generation,
    uint32_t expected_generation, const struct siano_device *device,
    uint32_t *output)
{
    output[1] = (uint32_t)state;
    output[2] = generation;
    webts_siano_write_unmeasured_stats(output);
    if (expected_generation != 0U && expected_generation != generation) {
        output[3] |= WEBTS_SIANO_STATS_STALE_SESSION;
        return WEBTS_SIANO_STATS_STALE;
    }
    if (state == WEBTS_SIANO_STATS_STATE_POISONED)
        return WEBTS_SIANO_STATS_POISONED;
    if (state == WEBTS_SIANO_STATS_STATE_IDLE)
        return WEBTS_SIANO_STATS_OK;
    if (state != WEBTS_SIANO_STATS_STATE_OPEN &&
        state != WEBTS_SIANO_STATS_STATE_STREAMING &&
        state != WEBTS_SIANO_STATS_STATE_VERSIONED)
        return WEBTS_SIANO_STATS_BUSY;
    if (device == NULL)
        return WEBTS_SIANO_STATS_INTERNAL;
    webts_siano_snapshot_device(device, output);
    return WEBTS_SIANO_STATS_OK;
}

static uint32_t webts_siano_map_session_state(enum webts_siano_session_state state)
{
    switch (state) {
    case WEBTS_SIANO_IDLE: return WEBTS_SIANO_STATS_STATE_IDLE;
    case WEBTS_SIANO_OPEN: return WEBTS_SIANO_STATS_STATE_OPEN;
    case WEBTS_SIANO_STREAMING: return WEBTS_SIANO_STATS_STATE_STREAMING;
    case WEBTS_SIANO_VERSIONED: return WEBTS_SIANO_STATS_STATE_VERSIONED;
    case WEBTS_SIANO_POISONED: return WEBTS_SIANO_STATS_STATE_POISONED;
    case WEBTS_SIANO_OPENING: return WEBTS_SIANO_STATS_STATE_OPENING;
    case WEBTS_SIANO_CLOSING: return WEBTS_SIANO_STATS_STATE_CLOSING;
    case WEBTS_SIANO_STARTING: return WEBTS_SIANO_STATS_STATE_STARTING;
    default: return WEBTS_SIANO_STATS_STATE_POISONED;
    }
}

static uint32_t webts_siano_stats_prepare_output(uint32_t output_ptr,
                                                 uint32_t output_words,
                                                 uint32_t **output)
{
    if (output == NULL || output_ptr == 0U || output_words < WEBTS_SIANO_STATS_WORDS)
        return WEBTS_SIANO_STATS_INVALID_ARGUMENT;
    *output = (uint32_t *)(uintptr_t)output_ptr;
    for (uint32_t index = 0U; index < WEBTS_SIANO_STATS_WORDS; ++index)
        (*output)[index] = 0U;
    return WEBTS_SIANO_STATS_OK;
}

static uint32_t webts_siano_map_session_state(enum webts_siano_session_state state);

/* Snapshot current session state; no queue lock is touched for unsafe states. */
uint32_t webts_siano_live_stats_snapshot(uint32_t expected_generation,
                                         uint32_t output_ptr, uint32_t output_words)
{
    uint32_t *output = NULL;
    const uint32_t validation = webts_siano_stats_prepare_output(output_ptr, output_words, &output);
    uint32_t result;
    if (validation != WEBTS_SIANO_STATS_OK)
        return validation;
    result = webts_siano_stats_snapshot_state(
        webts_siano_map_session_state(webts_siano_session_state),
        webts_siano_session_generation, expected_generation,
        &webts_siano_session_device, output);
    output[0] = result;
    return result;
}

/* USB-free fixture for snapshot locking, overflow, and closed-queue boundaries.
 * Do not add pthread_join here: this export is callable from a browser main
 * thread, where blocking joins can deadlock the event loop. */
uint32_t webts_siano_live_stats_mock(uint32_t scenario, uint32_t output_ptr,
                                     uint32_t output_words)
{
    uint32_t *output = NULL;
    struct siano_device *device = NULL;
    uint8_t sample = 0x33U;
    uint8_t large_sample[USB_TRANSFER_SIZE + 9U];
    uint8_t popped[USB_TRANSFER_SIZE];
    size_t popped_length = 0U;
    uint32_t validation = webts_siano_stats_prepare_output(output_ptr, output_words, &output);
    uint32_t result;

    if (validation != WEBTS_SIANO_STATS_OK || scenario > 3U)
        return WEBTS_SIANO_STATS_INVALID_ARGUMENT;
    if (scenario == 0U) {
        output[0] = WEBTS_SIANO_STATS_OK;
        result = webts_siano_stats_snapshot_state(WEBTS_SIANO_STATS_STATE_IDLE, 0U, 0U,
                                                   NULL, output);
        output[0] = result;
        return result;
    }

    device = calloc(1U, sizeof(*device));
    if (device == NULL)
        return WEBTS_SIANO_STATS_INTERNAL;
    if (init_device_state(device, NULL, false) != 0) {
        /* The upstream initializer has no partial rollback contract. */
        free(device);
        return WEBTS_SIANO_STATS_INTERNAL;
    }
    device->active_transfers = 0;
    memset(large_sample, 0x44, sizeof(large_sample));
    switch (scenario) {
    case 1U:
        ts_enqueue(&device->ts, &sample, sizeof(sample));
        ts_enqueue(&device->ts, &sample, sizeof(sample));
        result = webts_siano_stats_snapshot_state(WEBTS_SIANO_STATS_STATE_OPEN, 1U, 0U,
                                                   device, output);
        break;
    case 2U:
        for (size_t index = 0U; index < TS_QUEUE_SLOTS + 1U; ++index)
            ts_enqueue(&device->ts, &sample, sizeof(sample));
        result = webts_siano_stats_snapshot_state(WEBTS_SIANO_STATS_STATE_STREAMING, 1U, 0U,
                                                   device, output);
        break;
    case 3U:
        ts_enqueue(&device->ts, large_sample, sizeof(large_sample));
        ts_enqueue(&device->ts, &sample, sizeof(sample));
        ts_queue_close(&device->ts);
        ts_enqueue(&device->ts, large_sample, 2U);
        (void)ts_pop(&device->ts, popped, &popped_length);
        (void)ts_pop(&device->ts, popped, &popped_length);
        fail_streaming(device, LIBUSB_ERROR_IO);
        result = webts_siano_stats_snapshot_state(WEBTS_SIANO_STATS_STATE_STREAMING, 1U, 0U,
                                                   device, output);
        break;
    default:
        result = WEBTS_SIANO_STATS_INVALID_ARGUMENT;
        break;
    }
    output[0] = result;
    close_device(device);
    free(device);
    return result;
}

enum webts_siano_firmware_diagnostic {
    WEBTS_SIANO_FIRMWARE_OK = 0,
    WEBTS_SIANO_FIRMWARE_TOO_LARGE = 1,
    WEBTS_SIANO_FIRMWARE_INVALID_INPUT = 2,
    WEBTS_SIANO_FIRMWARE_HEADER_INVALID = 3,
    WEBTS_SIANO_FIRMWARE_STAGE_FAILED = 4
};

#define WEBTS_SIANO_FIRMWARE_STAGE_PATH "/tmp/webts-siano-firmware.bin"

static void webts_siano_zero_header(struct sms_firmware_header *header)
{
    volatile uint8_t *bytes = (volatile uint8_t *)header;
    for (size_t index = 0; index < sizeof(*header); ++index)
        bytes[index] = 0U;
}

static void webts_siano_zero_bytes(void *memory, size_t size)
{
    volatile uint8_t *bytes = (volatile uint8_t *)memory;

    if (bytes == NULL)
        return;
    for (size_t index = 0; index < size; ++index)
        bytes[index] = 0U;
}

/* Best-effort zeroization for the private MEMFS staging file. */
static int webts_siano_wipe_stage_file(size_t size)
{
    FILE *file = fopen(WEBTS_SIANO_FIRMWARE_STAGE_PATH, "r+b");
    uint8_t zeros[4096] = {0};
    size_t remaining = size;
    int result = 0;

    if (file == NULL) {
        result = -1;
    } else {
        while (remaining > 0U) {
            size_t chunk = remaining < sizeof(zeros) ? remaining : sizeof(zeros);
            if (fwrite(zeros, 1U, chunk, file) != chunk) {
                result = -1;
                break;
            }
            remaining -= chunk;
        }
        if (fflush(file) != 0)
            result = -1;
        if (fclose(file) != 0)
            result = -1;
    }
    if (remove(WEBTS_SIANO_FIRMWARE_STAGE_PATH) != 0)
        result = -1;
    webts_siano_zero_bytes(zeros, sizeof(zeros));
    return result;
}

/*
 * Validate and transiently stage caller-owned bytes without invoking USB or
 * set_device_mode(). sms_parse_firmware_header() is the upstream source of
 * truth; it checks only the 12-byte header shape and declared length, not
 * checksum/authenticity. The fixed private path is MEMFS-backed in
 * Emscripten, and is read through the same path-bearing helper used by
 * load_family2_firmware(), then wiped and unlinked. The caller-owned WASM
 * heap remains the caller's responsibility to wipe.
 */
uint32_t webts_siano_firmware_validate_stage(const uint8_t *bytes, size_t size)
{
    struct sms_firmware_header header;
    struct sms_firmware_header reloaded_header;
    uint8_t *reloaded = NULL;
    size_t reloaded_size = 0U;
    FILE *staged = NULL;
    int result;
    int cleanup_result;

    if (bytes == NULL || size == 0U)
        return WEBTS_SIANO_FIRMWARE_INVALID_INPUT;
    if (size > WEBTS_SIANO_MAX_FIRMWARE_SIZE)
        return WEBTS_SIANO_FIRMWARE_TOO_LARGE;
    result = sms_parse_firmware_header(bytes, size, &header);
    if (result < 0) {
        webts_siano_zero_header(&header);
        return WEBTS_SIANO_FIRMWARE_HEADER_INVALID;
    }

    /* Do not leave a prior interrupted stage available to a later call. */
    if (remove(WEBTS_SIANO_FIRMWARE_STAGE_PATH) != 0 && errno != ENOENT) {
        webts_siano_zero_header(&header);
        return WEBTS_SIANO_FIRMWARE_STAGE_FAILED;
    }
    staged = fopen(WEBTS_SIANO_FIRMWARE_STAGE_PATH, "wb");
    if (staged == NULL) {
        webts_siano_zero_header(&header);
        return WEBTS_SIANO_FIRMWARE_STAGE_FAILED;
    }
    if (fwrite(bytes, 1U, size, staged) != size || fflush(staged) != 0) {
        (void)fclose(staged);
        (void)webts_siano_wipe_stage_file(size);
        webts_siano_zero_header(&header);
        return WEBTS_SIANO_FIRMWARE_STAGE_FAILED;
    }
    if (fclose(staged) != 0) {
        (void)webts_siano_wipe_stage_file(size);
        webts_siano_zero_header(&header);
        return WEBTS_SIANO_FIRMWARE_STAGE_FAILED;
    }

    /* This is the exact path-bearing helper used before set_device_mode(). */
    result = read_file(WEBTS_SIANO_FIRMWARE_STAGE_PATH, &reloaded,
                       &reloaded_size);
    if (result < 0 || reloaded_size != size ||
        memcmp(reloaded, bytes, size) != 0 ||
        sms_parse_firmware_header(reloaded, reloaded_size, &reloaded_header) < 0) {
        if (reloaded != NULL) {
            webts_siano_zero_bytes(reloaded, reloaded_size);
            free(reloaded);
        }
        (void)webts_siano_wipe_stage_file(size);
        webts_siano_zero_header(&header);
        webts_siano_zero_header(&reloaded_header);
        return WEBTS_SIANO_FIRMWARE_STAGE_FAILED;
    }
    webts_siano_zero_bytes(reloaded, reloaded_size);
    free(reloaded);
    cleanup_result = webts_siano_wipe_stage_file(size);
    webts_siano_zero_header(&header);
    webts_siano_zero_header(&reloaded_header);
    if (cleanup_result != 0)
        return WEBTS_SIANO_FIRMWARE_STAGE_FAILED;
    return WEBTS_SIANO_FIRMWARE_OK;
}
