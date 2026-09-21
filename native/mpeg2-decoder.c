/*
 * MPEG-2 video decoding for WebTS.app.
 *
 * The browser will not do this for us: WebCodecs reports mp2v, mp2v.61,
 * mpeg2video and mp4v.20.9 all unsupported in Chromium 152, while H.264,
 * HEVC and AAC are supported (docs/FINDINGS.md section 7). Audio is fine;
 * video is the gap, and libmpeg2 fills it.
 *
 * This is a thin seam over the upstream state machine. No decoding logic is
 * written here. The whole file exists to (a) keep libmpeg2's pointer-based
 * API on the C side of the WASM boundary and (b) hand JavaScript plane
 * pointers it can wrap without copying more than once.
 *
 * Output stays planar I420. libmpeg2's own convert/ code is not vendored:
 * a VideoFrame built from I420 lets the compositor do colour conversion,
 * which is both faster and more correct than a C RGB path.
 *
 * Ownership: the frame buffers belong to the decoder and are reused. A
 * pointer handed out by webts_mpeg2_frame is only valid until the next
 * webts_mpeg2_step on the same decoder.
 */

#include <stdint.h>
#include <stdlib.h>

#include "mpeg2.h"

enum {
    WEBTS_MPEG2_NEED_DATA = 0,
    WEBTS_MPEG2_FRAME = 1,
    WEBTS_MPEG2_SEQUENCE = 2,
    WEBTS_MPEG2_END = 3,
    WEBTS_MPEG2_INVALID = -1,
    WEBTS_MPEG2_CLOSED = -2,
};

/* Output sizes, in 32-bit words. */
enum {
    WEBTS_MPEG2_SEQUENCE_WORDS = 12,
    WEBTS_MPEG2_FRAME_WORDS = 5,
};

struct WebtsMpeg2Decoder {
    mpeg2dec_t* handle;
    const mpeg2_info_t* info;
    /* A chunk handed over by feed() that step() has not yet passed on. */
    uint8_t* pending;
    int pending_size;
    /* Counted so a caller can tell a stall from a stream that simply ends. */
    uint32_t frames;
};

struct WebtsMpeg2Decoder* webts_mpeg2_open(void)
{
    struct WebtsMpeg2Decoder* decoder = calloc(1U, sizeof(*decoder));
    if (decoder == NULL) return NULL;
    /* Ask for the C paths explicitly. mpeg2_init would otherwise run
     * MPEG2_ACCEL_DETECT, and while no SIMD source is vendored so detection
     * cannot select one, saying so here keeps the intent on the record. */
    mpeg2_accel(0U);
    decoder->handle = mpeg2_init();
    if (decoder->handle == NULL) {
        free(decoder);
        return NULL;
    }
    decoder->info = mpeg2_info(decoder->handle);
    return decoder;
}

void webts_mpeg2_close(struct WebtsMpeg2Decoder* decoder)
{
    if (decoder == NULL) return;
    if (decoder->handle != NULL) mpeg2_close(decoder->handle);
    free(decoder);
}

/*
 * Hand over one chunk. The bytes must stay untouched until step() returns
 * NEED_DATA again: libmpeg2 reads them in place rather than copying.
 */
void webts_mpeg2_feed(struct WebtsMpeg2Decoder* decoder, uint8_t* data, int size)
{
    if (decoder == NULL || data == NULL || size <= 0) return;
    decoder->pending = data;
    decoder->pending_size = size;
}

/*
 * Advance until something worth reporting happens. Call repeatedly; on
 * NEED_DATA, feed() another chunk first.
 */
int webts_mpeg2_step(struct WebtsMpeg2Decoder* decoder)
{
    if (decoder == NULL || decoder->handle == NULL) return WEBTS_MPEG2_CLOSED;
    for (;;) {
        const mpeg2_state_t state = mpeg2_parse(decoder->handle);
        switch (state) {
        case STATE_BUFFER:
            if (decoder->pending == NULL) return WEBTS_MPEG2_NEED_DATA;
            mpeg2_buffer(decoder->handle, decoder->pending,
                         decoder->pending + decoder->pending_size);
            decoder->pending = NULL;
            decoder->pending_size = 0;
            break;
        case STATE_SEQUENCE:
        case STATE_SEQUENCE_MODIFIED:
            return WEBTS_MPEG2_SEQUENCE;
        case STATE_SLICE:
        case STATE_END:
        case STATE_INVALID_END:
            /* A displayable frame is available only when libmpeg2 says so;
             * on the first pictures of a stream it legitimately does not. */
            if (decoder->info != NULL && decoder->info->display_fbuf != NULL) {
                decoder->frames += 1U;
                return state == STATE_INVALID_END ? WEBTS_MPEG2_INVALID
                                                  : WEBTS_MPEG2_FRAME;
            }
            if (state == STATE_END) return WEBTS_MPEG2_END;
            if (state == STATE_INVALID_END) return WEBTS_MPEG2_INVALID;
            break;
        case STATE_INVALID:
            return WEBTS_MPEG2_INVALID;
        default:
            /* SEQUENCE_REPEATED, GOP, PICTURE, PICTURE_2ND, SLICE_1ST:
             * progress, nothing for the caller to do. */
            break;
        }
    }
}

int webts_mpeg2_sequence_words(void)
{
    return WEBTS_MPEG2_SEQUENCE_WORDS;
}

int webts_mpeg2_frame_words(void)
{
    return WEBTS_MPEG2_FRAME_WORDS;
}

/*
 * Describe the current sequence. Available from the first SEQUENCE step, which
 * arrives before any frame does, so this is deliberately separate from
 * webts_mpeg2_frame: the two have different lifetimes. A sequence holds until
 * SEQUENCE is reported again.
 */
int webts_mpeg2_sequence(const struct WebtsMpeg2Decoder* decoder, int32_t* output, int words)
{
    if (decoder == NULL || output == NULL || words < WEBTS_MPEG2_SEQUENCE_WORDS) return -1;
    if (decoder->info == NULL || decoder->info->sequence == NULL) return -1;
    const mpeg2_sequence_t* sequence = decoder->info->sequence;

    /* libmpeg2 allocates each plane at the padded macroblock size, so these
     * are the plane strides and heights, not what should be shown. */
    output[0] = (int32_t)sequence->width;
    output[1] = (int32_t)sequence->height;
    output[2] = (int32_t)sequence->chroma_width;
    output[3] = (int32_t)sequence->chroma_height;
    /* What should be shown, which for 1440x1088 coding is 1440x1080. */
    output[4] = (int32_t)sequence->picture_width;
    output[5] = (int32_t)sequence->picture_height;
    output[6] = (int32_t)sequence->display_width;
    output[7] = (int32_t)sequence->display_height;
    /* Sample aspect, which turns anamorphic 1440x1080 into 16:9. */
    output[8] = (int32_t)sequence->pixel_width;
    output[9] = (int32_t)sequence->pixel_height;
    /* Period of one frame in units of 1/27000000 s, upstream's clock. */
    output[10] = (int32_t)sequence->frame_period;
    output[11] = (int32_t)sequence->flags;
    return 0;
}

/*
 * Point at the planes of the frame the last step() reported. The pointers are
 * into decoder-owned buffers and stay valid only until the next step() on this
 * decoder. Plane strides come from webts_mpeg2_sequence.
 */
int webts_mpeg2_frame(const struct WebtsMpeg2Decoder* decoder, int32_t* output, int words)
{
    if (decoder == NULL || output == NULL || words < WEBTS_MPEG2_FRAME_WORDS) return -1;
    if (decoder->info == NULL || decoder->info->display_fbuf == NULL) return -1;
    const mpeg2_fbuf_t* fbuf = decoder->info->display_fbuf;
    const mpeg2_picture_t* picture = decoder->info->display_picture;

    output[0] = (int32_t)(intptr_t)fbuf->buf[0];
    output[1] = (int32_t)(intptr_t)fbuf->buf[1];
    output[2] = (int32_t)(intptr_t)fbuf->buf[2];
    /* PIC_FLAG_TOP_FIELD_FIRST, PIC_FLAG_PROGRESSIVE_FRAME and the coding
     * type live here; deinterlacing and presentation need them. */
    output[3] = picture != NULL ? (int32_t)picture->flags : 0;
    output[4] = picture != NULL ? (int32_t)picture->nb_fields : 0;
    return 0;
}

uint32_t webts_mpeg2_frames(const struct WebtsMpeg2Decoder* decoder)
{
    return decoder == NULL ? 0U : decoder->frames;
}
