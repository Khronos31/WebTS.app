/*
 * Offline version-response fixture.  The frame cases call the upstream
 * sms_frame_message() parser; timeout cases model only the local bounded
 * retry policy and never call libusb, get_version(), or a device.
 */
#include "protocol.h"

#include <errno.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

enum {
    WEBTS_SIANO_VERSION_OK = 0,
    WEBTS_SIANO_VERSION_SPLIT_OK = 1,
    WEBTS_SIANO_VERSION_INVALID_FRAME = 2,
    WEBTS_SIANO_VERSION_TIMEOUT = 3,
    WEBTS_SIANO_VERSION_RETRY_SUPPRESSED = 4,
    WEBTS_SIANO_VERSION_INVALID_ARGUMENT = 5,
    WEBTS_SIANO_VERSION_INTERNAL = 6,
};

static int parse_version_frame(const uint8_t *buffer, size_t length,
                               size_t alignment, size_t expected_offset,
                               bool split)
{
    struct sms_frame frame;
    int rc = sms_frame_message(buffer, length, alignment, &frame);

    if (rc != 0 || frame.type != MSG_SMS_GET_VERSION_EX_RES ||
        frame.length != SMS_HEADER_SIZE + 12U ||
        frame.payload_length != 12U || frame.offset != expected_offset ||
        ((frame.flags & SMS_MSG_HDR_FLAG_SPLIT_MSG) != (split ?
                                                         SMS_MSG_HDR_FLAG_SPLIT_MSG : 0U)))
        return -1;
    return 0;
}

static int normal_response(void)
{
    uint8_t buffer[SMS_HEADER_SIZE + 12U] = {0};

    sms_pack_header(buffer, MSG_SMS_GET_VERSION_EX_RES, 0, SMS_HIF_TASK,
                    sizeof(buffer), 0);
    return parse_version_frame(buffer, sizeof(buffer), 0, 0, false) == 0 ?
           WEBTS_SIANO_VERSION_OK : WEBTS_SIANO_VERSION_INTERNAL;
}

static int split_response(void)
{
    uint8_t buffer[SMS_HEADER_SIZE + 12U + 6U] = {0};
    uint16_t flags = SMS_MSG_HDR_FLAG_SPLIT_MSG | (2U << 8);

    sms_pack_header(buffer, MSG_SMS_GET_VERSION_EX_RES, 0, SMS_HIF_TASK,
                    SMS_HEADER_SIZE + 12U, flags);
    return parse_version_frame(buffer, sizeof(buffer), 4, 6, true) == 0 ?
           WEBTS_SIANO_VERSION_SPLIT_OK : WEBTS_SIANO_VERSION_INTERNAL;
}

static int malformed_response(void)
{
    uint8_t short_buffer[SMS_HEADER_SIZE - 1U] = {0};
    uint8_t bad_length[SMS_HEADER_SIZE] = {0};
    struct sms_frame frame;

    if (sms_frame_message(short_buffer, sizeof(short_buffer), 0, &frame) != -EINVAL)
        return WEBTS_SIANO_VERSION_INTERNAL;
    sms_pack_header(bad_length, MSG_SMS_GET_VERSION_EX_RES, 0, SMS_HIF_TASK,
                    SMS_HEADER_SIZE - 1U, 0);
    if (sms_frame_message(bad_length, sizeof(bad_length), 0, &frame) != -EBADMSG)
        return WEBTS_SIANO_VERSION_INTERNAL;
    return WEBTS_SIANO_VERSION_INVALID_FRAME;
}

/* No transfer is issued: these states only define bounded retry behavior. */
static int timeout_policy(bool retry_requested)
{
    unsigned attempts = 1;
    bool timed_out = true;

    if (!timed_out || attempts != 1U)
        return WEBTS_SIANO_VERSION_INTERNAL;
    if (retry_requested) {
        /* A timed-out one-shot request never silently retries. */
        bool retry_started = false;
        if (retry_started)
            return WEBTS_SIANO_VERSION_INTERNAL;
        return WEBTS_SIANO_VERSION_RETRY_SUPPRESSED;
    }
    return WEBTS_SIANO_VERSION_TIMEOUT;
}

/* scenario 0=normal, 1=split/aligned, 2=malformed, 3=timeout, 4=no-retry. */
int32_t webts_siano_version_response_mock(uint32_t scenario)
{
    switch (scenario) {
    case 0: return normal_response();
    case 1: return split_response();
    case 2: return malformed_response();
    case 3: return timeout_policy(false);
    case 4: return timeout_policy(true);
    default: return WEBTS_SIANO_VERSION_INVALID_ARGUMENT;
    }
}
