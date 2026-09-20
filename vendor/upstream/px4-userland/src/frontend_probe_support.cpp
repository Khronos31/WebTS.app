// SPDX-License-Identifier: GPL-2.0-only
#include "frontend_probe_support.h"

#include <charconv>
#include <limits>

namespace px4::userland {
namespace {

FrontendProbeArguments invalid(std::string_view message) noexcept
{
    FrontendProbeArguments result;
    result.error = message;
    return result;
}

bool parse_u32(std::string_view value, std::uint32_t& output) noexcept
{
    if (value.empty()) return false;
    const auto parsed = std::from_chars(value.data(), value.data() + value.size(), output);
    return parsed.ec == std::errc{} && parsed.ptr == value.data() + value.size();
}

}  // namespace

FrontendProbeArguments parse_frontend_probe_arguments(
    int argc, const char* const* argv) noexcept
{
    if (argc < 1 || argv == nullptr) return invalid("invalid argument vector");
    FrontendProbeArguments result;
    bool have_base = false;
    bool have_firmware = false;
    bool have_device = false;
    bool have_receiver = false;
    bool have_frequency = false;
    bool have_tune = false;
    for (int index = 1; index < argc; ++index) {
        if (argv[index] == nullptr) return invalid("null argument");
        const std::string_view option(argv[index]);
        if (option == "--help") {
            if (argc != 2) return invalid("--help cannot be combined with other arguments");
            result.valid = true;
            result.help = true;
            return result;
        }
        if (option == "--tune-terrestrial") {
            if (have_tune) return invalid("duplicate --tune-terrestrial");
            have_tune = true;
            result.tune_terrestrial = true;
            continue;
        }
        if (index + 1 >= argc || argv[index + 1] == nullptr)
            return invalid("option requires one value");
        const std::string_view value(argv[++index]);
        if (option == "--base") {
            if (have_base) return invalid("duplicate --base");
            have_base = true;
            result.base_serial = value;
        } else if (option == "--firmware") {
            if (have_firmware) return invalid("duplicate --firmware");
            have_firmware = true;
            result.firmware_path = value;
        } else if (option == "--device") {
            if (have_device) return invalid("duplicate --device");
            have_device = true;
            std::uint32_t parsed = 0U;
            if (!parse_u32(value, parsed) || parsed != 1U)
                return invalid("--device must be 1");
            result.device = 1U;
        } else if (option == "--receiver") {
            if (have_receiver) return invalid("duplicate --receiver");
            have_receiver = true;
            std::uint32_t parsed = 0U;
            if (!parse_u32(value, parsed) || parsed != 2U)
                return invalid("--receiver must be 2");
            result.receiver = 2U;
        } else if (option == "--frequency-khz") {
            if (have_frequency) return invalid("duplicate --frequency-khz");
            have_frequency = true;
            if (!parse_u32(value, result.frequency_khz) ||
                result.frequency_khz < 40000U || result.frequency_khz > 1002000U)
                return invalid("--frequency-khz is outside 40000..1002000");
        } else {
            return invalid("unknown argument");
        }
    }
    if (!have_base || result.base_serial.empty()) return invalid("--base is required");
    if (!have_firmware || result.firmware_path.empty()) return invalid("--firmware is required");
    if (!have_device || !have_receiver || !have_frequency || !have_tune)
        return invalid("all probe options are required");
    result.valid = true;
    return result;
}

Result<void> CoupledProbePower::set_backend_power(bool on, Q3U4Delay& delay) noexcept
{
    if (!on) {
        const auto first = dev1_.set_backend_power(false, delay);
        const auto second = dev2_.set_backend_power(false, delay);
        return first ? second : first;
    }
    const auto first = dev1_.set_backend_power(true, delay);
    if (!first) return first;
    const auto second = dev2_.set_backend_power(true, delay);
    if (second) return second;
    (void)dev1_.set_backend_power(false, delay);
    return second;
}

ProbeLockPollResult poll_frontend_probe_lock(ProbeLockCheck check, void* context,
                                              Q3U4FrontendDelay& delay) noexcept
{
    ProbeLockPollResult result;
    if (check == nullptr) {
        result.error = Error::INVALID_ARGUMENT;
        return result;
    }
    constexpr std::uint32_t kStabilizationMs = 350U;
    for (std::size_t attempt = 0U; attempt < 300U; ++attempt) {
        const auto status = check(context);
        ++result.checks;
        if (status && status.value()) {
            result.locked = true;
            result.elapsed_ms = static_cast<std::uint32_t>(attempt * 10U);
            if (result.elapsed_ms < kStabilizationMs) {
                delay.sleep_ms(kStabilizationMs - result.elapsed_ms);
                result.elapsed_ms = kStabilizationMs;
            }
            return result;
        }
        if (!status) result.error = status.error();
        else result.error = Error::OK;
        delay.sleep_ms(10U);
        result.elapsed_ms = static_cast<std::uint32_t>((attempt + 1U) * 10U);
    }
    if (result.error == Error::OK) result.error = Error::TIMEOUT;
    return result;
}

ProbeCleanupGuard::~ProbeCleanupGuard() noexcept
{
    if (close_ != nullptr) {
        const auto result = close_(close_context_);
        if (!result && error_ == Error::OK) error_ = result.error();
    }
    if (power_off_ != nullptr) {
        const auto result = power_off_(power_context_);
        if (!result && error_ == Error::OK) error_ = result.error();
    }
}

int frontend_probe_cleanup_status(int primary_status, Error cleanup_error) noexcept
{
    if (primary_status != 0) return primary_status;
    return cleanup_error == Error::OK ? 0 : 6;
}

}  // namespace px4::userland
