/* SPDX-License-Identifier: GPL-2.0-or-later */
#ifndef SIANO_OS_H
#define SIANO_OS_H

/*
 * POSIX shims for native Windows (MSVC). Unix keeps the libc headers in
 * siano-ts.c. USBDriverKit or other Darwin APIs can follow the same split.
 */

#ifdef _WIN32

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef _CRT_SECURE_NO_WARNINGS
#define _CRT_SECURE_NO_WARNINGS
#endif

/* libusb's public event APIs use struct timeval.  WinSock2 is the
 * Windows SDK definition of that type and must precede windows.h. */
#include <winsock2.h>
#include <windows.h>
#include <io.h>
#include <fcntl.h>
#include <process.h>
#include <direct.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <BaseTsd.h>
#include "siano-clock.h"

typedef SSIZE_T ssize_t;

#ifndef STDOUT_FILENO
#define STDOUT_FILENO 1
#endif
#ifndef R_OK
#define R_OK 4
#endif
#ifndef ETIMEDOUT
#define ETIMEDOUT 138
#endif
#ifndef CLOCK_MONOTONIC
#define CLOCK_MONOTONIC 1
#endif
#ifndef CLOCK_REALTIME
#define CLOCK_REALTIME 0
#endif
#ifndef SIANO_COND_CLOCK
#define SIANO_COND_CLOCK CLOCK_MONOTONIC
#endif

#define access _access
#define strdup _strdup
#define open _open
#define close _close
#define write _write
#define fileno _fileno

#ifndef no_argument
#define no_argument 0
#define required_argument 1
#define optional_argument 2
#endif

struct option {
    const char *name;
    int has_arg;
    int *flag;
    int val;
};

extern char *optarg;
extern int optind;

typedef HANDLE pthread_t;
typedef CRITICAL_SECTION pthread_mutex_t;
typedef CONDITION_VARIABLE pthread_cond_t;
typedef int pthread_condattr_t;

static inline int siano_clock_gettime(int clock_id, struct timespec *ts)
{
    if (clock_id == CLOCK_MONOTONIC) {
        static LARGE_INTEGER freq;
        LARGE_INTEGER now;

        if (freq.QuadPart == 0)
            QueryPerformanceFrequency(&freq);
        QueryPerformanceCounter(&now);
        siano_qpc_to_timespec((uint64_t)now.QuadPart,
                              (uint64_t)freq.QuadPart, ts);
        return 0;
    }
    {
        FILETIME ft;
        unsigned long long t;

        GetSystemTimeAsFileTime(&ft);
        t = ((unsigned long long)ft.dwHighDateTime << 32) | ft.dwLowDateTime;
        t -= 116444736000000000ULL;
        ts->tv_sec = (time_t)(t / 10000000ULL);
        ts->tv_nsec = (long)((t % 10000000ULL) * 100);
        return 0;
    }
}
#define clock_gettime siano_clock_gettime

static inline int nanosleep(const struct timespec *req, struct timespec *rem)
{
    DWORD ms;

    (void)rem;
    ms = (DWORD)(req->tv_sec * 1000L + (req->tv_nsec + 999999L) / 1000000L);
    Sleep(ms);
    return 0;
}

static inline int pthread_mutex_init(pthread_mutex_t *m, void *attr)
{
    (void)attr;
    InitializeCriticalSection(m);
    return 0;
}

static inline int pthread_mutex_destroy(pthread_mutex_t *m)
{
    DeleteCriticalSection(m);
    return 0;
}

static inline int pthread_mutex_lock(pthread_mutex_t *m)
{
    EnterCriticalSection(m);
    return 0;
}

static inline int pthread_mutex_unlock(pthread_mutex_t *m)
{
    LeaveCriticalSection(m);
    return 0;
}

static inline int pthread_cond_init(pthread_cond_t *c, pthread_condattr_t *a)
{
    (void)a;
    InitializeConditionVariable(c);
    return 0;
}

static inline int pthread_cond_destroy(pthread_cond_t *c)
{
    (void)c;
    return 0;
}

static inline int pthread_cond_signal(pthread_cond_t *c)
{
    WakeConditionVariable(c);
    return 0;
}

static inline int pthread_cond_broadcast(pthread_cond_t *c)
{
    WakeAllConditionVariable(c);
    return 0;
}

static inline int pthread_cond_timedwait(pthread_cond_t *c, pthread_mutex_t *m,
                                         const struct timespec *deadline)
{
    struct timespec now;
    long long ms;

    clock_gettime(SIANO_COND_CLOCK, &now);
    ms = (long long)(deadline->tv_sec - now.tv_sec) * 1000LL +
         (deadline->tv_nsec - now.tv_nsec) / 1000000LL;
    if (ms < 0)
        ms = 0;
    if (ms > 0x7fffffffLL)
        ms = 0x7fffffffLL;
    if (!SleepConditionVariableCS(c, m, (DWORD)ms)) {
        if (GetLastError() == ERROR_TIMEOUT)
            return ETIMEDOUT;
        return -1;
    }
    return 0;
}

struct siano_win_thread {
    void *(*fn)(void *);
    void *arg;
};

static DWORD WINAPI siano_win_thread_start(void *param)
{
    struct siano_win_thread *pack = param;
    void *(*fn)(void *) = pack->fn;
    void *arg = pack->arg;

    free(pack);
    fn(arg);
    return 0;
}

static inline int pthread_create(pthread_t *thread, void *attr,
                                 void *(*fn)(void *), void *arg)
{
    struct siano_win_thread *pack;
    HANDLE handle;

    (void)attr;
    pack = malloc(sizeof(*pack));
    if (!pack)
        return -1;
    pack->fn = fn;
    pack->arg = arg;
    handle = CreateThread(NULL, 0, siano_win_thread_start, pack, 0, NULL);
    if (!handle) {
        free(pack);
        return -1;
    }
    *thread = handle;
    return 0;
}

static inline int pthread_join(pthread_t thread, void **retval)
{
    (void)retval;
    WaitForSingleObject(thread, INFINITE);
    CloseHandle(thread);
    return 0;
}

static inline pthread_t pthread_self(void)
{
    return GetCurrentThread();
}

static inline int pthread_condattr_init(pthread_condattr_t *a)
{
    (void)a;
    return 0;
}

static inline int pthread_condattr_destroy(pthread_condattr_t *a)
{
    (void)a;
    return 0;
}

static char *optarg;
static int optind = 1;

static inline int getopt_long(int argc, char *const argv[], const char *optstring,
                              const struct option *longopts, int *longindex)
{
    const char *arg;
    size_t i;

    (void)optstring;
    if (longindex)
        *longindex = 0;
    if (optind >= argc)
        return -1;
    arg = argv[optind];
    if (arg[0] != '-' || arg[1] == '\0')
        return -1;
    if (arg[1] != '-') {
        char shortopt = arg[1];

        optind++;
        for (i = 0; longopts[i].name; i++) {
            if (longopts[i].val != shortopt)
                continue;
            if (longopts[i].has_arg == required_argument) {
                if (arg[2] != '\0')
                    optarg = (char *)arg + 2;
                else if (optind < argc)
                    optarg = argv[optind++];
                else
                    return '?';
            } else {
                optarg = NULL;
            }
            return shortopt;
        }
        return '?';
    }
    {
        const char *name = arg + 2;
        const char *eq = strchr(name, '=');
        size_t namelen = eq ? (size_t)(eq - name) : strlen(name);

        optind++;
        for (i = 0; longopts[i].name; i++) {
            if (strncmp(longopts[i].name, name, namelen) != 0 ||
                longopts[i].name[namelen] != '\0')
                continue;
            if (longopts[i].has_arg == required_argument) {
                if (eq)
                    optarg = (char *)eq + 1;
                else if (optind < argc)
                    optarg = argv[optind++];
                else
                    return '?';
            } else {
                optarg = NULL;
            }
            return longopts[i].val;
        }
        return '?';
    }
}

#endif /* _WIN32 */
#endif /* SIANO_OS_H */
