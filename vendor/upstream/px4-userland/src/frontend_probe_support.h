// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_FRONTEND_PROBE_SUPPORT_H
#define PX4_USERLAND_FRONTEND_PROBE_SUPPORT_H

#include "px4/error.h"
#include "q3u4_frontend.h"

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>

namespace px4::userland {

struct FrontendProbeArguments final {
    bool valid = false;
    bool help = false;
    std::string base_serial;
    std::string firmware_path;
    std::uint32_t frequency_khz = 0U;
    std::uint8_t device = 0U;
    std::uint8_t receiver = 0U;
    bool tune_terrestrial = false;
    std::string_view error;
};

FrontendProbeArguments parse_frontend_probe_arguments(
    int argc, const char* const* argv) noexcept;

class CoupledProbePower final : public Q3U4BackendPower {
public:
    CoupledProbePower(Q3U4BackendPower& dev1, Q3U4BackendPower& dev2) noexcept
        : dev1_(dev1), dev2_(dev2)
    {
    }

    Result<void> set_backend_power(bool on, Q3U4Delay& delay) noexcept override;

private:
    Q3U4BackendPower& dev1_;
    Q3U4BackendPower& dev2_;
};

struct ProbeLockPollResult final {
    bool locked = false;
    Error error = Error::OK;
    std::size_t checks = 0U;
    std::uint32_t elapsed_ms = 0U;
};

using ProbeLockCheck = Result<bool> (*) (void* context) noexcept;

ProbeLockPollResult poll_frontend_probe_lock(ProbeLockCheck check,
                                              void* context,
                                              Q3U4FrontendDelay& delay) noexcept;

using ProbeCleanupAction = Result<void> (*)(void* context) noexcept;

class ProbeCleanupGuard final {
public:
    ProbeCleanupGuard(ProbeCleanupAction close, void* close_context,
                      ProbeCleanupAction power_off, void* power_context,
                      Error& error) noexcept
        : close_(close), close_context_(close_context), power_off_(power_off),
          power_context_(power_context), error_(error) {}
    ~ProbeCleanupGuard() noexcept;
    ProbeCleanupGuard(const ProbeCleanupGuard&) = delete;
    ProbeCleanupGuard& operator=(const ProbeCleanupGuard&) = delete;
private:
    ProbeCleanupAction close_;
    void* close_context_;
    ProbeCleanupAction power_off_;
    void* power_context_;
    Error& error_;
};

int frontend_probe_cleanup_status(int primary_status, Error cleanup_error) noexcept;

}  // namespace px4::userland

#endif  // PX4_USERLAND_FRONTEND_PROBE_SUPPORT_H
