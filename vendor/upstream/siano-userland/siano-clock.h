/* SPDX-License-Identifier: GPL-2.0-or-later */
#ifndef SIANO_CLOCK_H
#define SIANO_CLOCK_H

#include <stdint.h>
#include <time.h>

/*
 * Convert a non-negative QueryPerformanceCounter value without forming
 * counter * 1000000000.  QPC values are positive signed 64-bit integers on
 * Windows, so the intermediate arithmetic below remains within uint64_t.
 */
static inline int siano_qpc_to_timespec(uint64_t counter, uint64_t frequency,
                                        struct timespec *ts)
{
    uint64_t seconds;
    uint64_t remainder;
    uint64_t nanoseconds = 0;
    unsigned int digit_index;

    if (frequency == 0)
        return -1;

    seconds = counter / frequency;
    remainder = counter % frequency;

    /* Long division computes floor(remainder * 10^9 / frequency). */
    for (digit_index = 0; digit_index < 9; digit_index++) {
        uint64_t frequency_div10 = frequency / 10;
        uint64_t frequency_mod10 = frequency % 10;
        unsigned int digit = 0;

        /* Find floor(10 * remainder / frequency) without 10*remainder. */
        while (digit < 9) {
            uint64_t candidate = (uint64_t)digit + 1;
            uint64_t threshold = candidate * frequency_div10 +
                                 (candidate * frequency_mod10 + 9) / 10;

            if (remainder < threshold)
                break;
            digit++;
        }

        nanoseconds = nanoseconds * 10 + digit;

        /* This rearrangement also avoids overflowing 10*remainder. */
        remainder = (remainder - (uint64_t)digit * frequency_div10) * 10 -
                    (uint64_t)digit * frequency_mod10;
    }

    ts->tv_sec = (time_t)seconds;
    ts->tv_nsec = (long)nanoseconds;
    return 0;
}

#endif
