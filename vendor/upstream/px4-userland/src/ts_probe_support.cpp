// SPDX-License-Identifier: GPL-2.0-only
#include "ts_probe_support.h"

#include <charconv>
#include <limits>

namespace px4::userland {
namespace {

TsProbeArguments invalid(std::string_view message) noexcept
{
    TsProbeArguments result;
    result.error = message;
    return result;
}

bool parse_u32(std::string_view value, std::uint32_t& output) noexcept
{
    if (value.empty()) return false;
    const auto parsed = std::from_chars(value.data(), value.data() + value.size(), output);
    return parsed.ec == std::errc{} && parsed.ptr == value.data() + value.size();
}

bool take_value(int& index, int argc, const char* const* argv,
                std::string_view& value) noexcept
{
    if (index + 1 >= argc || argv[index + 1] == nullptr) return false;
    value = std::string_view(argv[++index]);
    return !value.empty() && value.rfind("--", 0U) != 0U;
}

}  // namespace

TsProbeArguments parse_ts_probe_arguments(int argc,
                                          const char* const* argv) noexcept
{
    if (argc < 1 || argv == nullptr || argv[0] == nullptr) {
        return invalid("invalid argument vector");
    }

    TsProbeArguments result;
    bool have_base = false;
    bool have_firmware = false;
    bool have_device = false;
    bool have_receiver = false;
    bool have_frequency = false;
    bool have_seconds = false;
    bool have_output = false;
    bool have_tune = false;
    bool have_slot = false;
    bool have_symbol_rate = false;
    bool have_rolloff = false;
    bool have_lnb_voltage = false;

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
        if (option == "--tune-satellite") {
            if (have_tune) return invalid("tune modes are mutually exclusive");
            have_tune = true;
            result.tune_satellite = true;
            continue;
        }

        const bool valued = option == "--base" || option == "--firmware" ||
                            option == "--fd" ||
                            option == "--device" || option == "--receiver" ||
                            option == "--frequency-khz" || option == "--seconds" ||
                            option == "--output" || option == "--slot" ||
                            option == "--symbol-rate" || option == "--rolloff" ||
                            option == "--lnb-voltage";
        if (!valued) return invalid("unknown argument");

        std::string_view value;
        if (option == "--base") {
            if (have_base) return invalid("duplicate --base");
            if (!take_value(index, argc, argv, value)) return invalid("--base requires a value");
            have_base = true;
            result.base_serial = value;
        } else if (option == "--fd") {
            if (result.file_descriptor_count >= result.file_descriptors.size())
                return invalid("exactly two --fd values are supported");
            if (!take_value(index, argc, argv, value)) return invalid("--fd requires a value");
            std::uint32_t parsed = 0U;
            if (!parse_u32(value, parsed) ||
                parsed > static_cast<std::uint32_t>(std::numeric_limits<int>::max()))
                return invalid("--fd is invalid");
            const int fd = static_cast<int>(parsed);
            for (std::size_t fd_index = 0U;
                 fd_index < result.file_descriptor_count; ++fd_index) {
                if (result.file_descriptors[fd_index] == fd)
                    return invalid("--fd values must be distinct");
            }
            result.file_descriptors[result.file_descriptor_count++] = fd;
        } else if (option == "--firmware") {
            if (have_firmware) return invalid("duplicate --firmware");
            if (!take_value(index, argc, argv, value)) return invalid("--firmware requires a value");
            have_firmware = true;
            result.firmware_path = value;
        } else if (option == "--device") {
            if (have_device) return invalid("duplicate --device");
            if (!take_value(index, argc, argv, value)) return invalid("--device requires a value");
            std::uint32_t parsed = 0U;
            if (!parse_u32(value, parsed) || parsed != 1U)
                return invalid("--device must be 1");
            have_device = true;
            result.device = 1U;
        } else if (option == "--receiver") {
            if (have_receiver) return invalid("duplicate --receiver");
            if (!take_value(index, argc, argv, value)) return invalid("--receiver requires a value");
            std::uint32_t parsed = 0U;
            if (!parse_u32(value, parsed) || parsed > 3U)
                return invalid("--receiver must be 0..3");
            have_receiver = true;
            result.receiver = static_cast<std::uint8_t>(parsed);
        } else if (option == "--frequency-khz") {
            if (have_frequency) return invalid("duplicate --frequency-khz");
            if (!take_value(index, argc, argv, value)) return invalid("--frequency-khz requires a value");
            std::uint32_t parsed = 0U;
            if (!parse_u32(value, parsed)) return invalid("--frequency-khz is invalid");
            have_frequency = true;
            result.frequency_khz = parsed;
        } else if (option == "--seconds") {
            if (have_seconds) return invalid("duplicate --seconds");
            if (!take_value(index, argc, argv, value)) return invalid("--seconds requires a value");
            std::uint32_t parsed = 0U;
            if (!parse_u32(value, parsed) || parsed < 1U || parsed > 30U)
                return invalid("--seconds is outside 1..30");
            have_seconds = true;
            result.seconds = parsed;
        } else if (option == "--output") {
            if (have_output) return invalid("duplicate --output");
            if (!take_value(index, argc, argv, value)) return invalid("--output requires a value");
            have_output = true;
            result.output_path = value;
        } else if (option == "--slot") {
            if (have_slot) return invalid("duplicate --slot");
            if (!take_value(index, argc, argv, value)) return invalid("--slot requires a value");
            std::uint32_t parsed = 0U;
            if (!parse_u32(value, parsed) || parsed >= 12U) return invalid("--slot must be 0..11");
            have_slot = true;
            result.slot = static_cast<std::uint8_t>(parsed);
        } else if (option == "--symbol-rate") {
            if (have_symbol_rate) return invalid("duplicate --symbol-rate");
            if (!take_value(index, argc, argv, value)) return invalid("--symbol-rate requires a value");
            std::uint32_t parsed = 0U;
            if (!parse_u32(value, parsed)) return invalid("--symbol-rate is invalid");
            have_symbol_rate = true;
            result.symbol_rate = parsed;
        } else if (option == "--rolloff") {
            if (have_rolloff) return invalid("duplicate --rolloff");
            if (!take_value(index, argc, argv, value)) return invalid("--rolloff requires a value");
            std::uint32_t parsed = 0U;
            if (!parse_u32(value, parsed)) return invalid("--rolloff is invalid");
            have_rolloff = true;
            result.rolloff = parsed;
        } else if (option == "--lnb-voltage") {
            if (have_lnb_voltage) return invalid("duplicate --lnb-voltage");
            if (!take_value(index, argc, argv, value)) return invalid("--lnb-voltage requires a value");
            std::uint32_t parsed = 0U;
            if (!parse_u32(value, parsed)) return invalid("--lnb-voltage is invalid");
            have_lnb_voltage = true;
            result.lnb_voltage = parsed;
        } else {
            return invalid("unknown argument");
        }
    }

    if (result.file_descriptor_count == 0U) {
        if (!have_base || result.base_serial.empty()) return invalid("--base is required");
    } else if (result.file_descriptor_count != result.file_descriptors.size()) {
        return invalid("exactly two --fd values are required");
    }
    if (!have_firmware || result.firmware_path.empty()) return invalid("--firmware is required");
    if (!have_device || !have_receiver) return invalid("--device and --receiver are required");
    if (!have_frequency) return invalid("--frequency-khz is required");
    if (!have_seconds) return invalid("--seconds is required");
    if (!have_output || result.output_path.empty()) return invalid("--output is required");
    if (!have_tune) return invalid("exactly one tune mode is required");
    if (result.tune_terrestrial) {
        if (result.receiver != 2U) return invalid("terrestrial --receiver must be 2");
        if (have_slot || have_symbol_rate || have_rolloff || have_lnb_voltage)
            return invalid("satellite-only options require --tune-satellite");
        if (result.frequency_khz < 40000U || result.frequency_khz > 1002000U)
            return invalid("--frequency-khz is outside 40000..1002000");
    } else {
        if (!have_slot || !have_symbol_rate || !have_rolloff || !have_lnb_voltage)
            return invalid("satellite requires --slot --symbol-rate --rolloff --lnb-voltage");
        if (result.device != 1U || result.receiver != 0U)
            return invalid("satellite requires --device 1 and --receiver 0");
        if (result.frequency_khz < 146875U || result.frequency_khz > 2350000U)
            return invalid("--frequency-khz is outside 146875..2350000");
        if (result.symbol_rate != 28860U) return invalid("--symbol-rate must be 28860");
        if (result.rolloff != 4U) return invalid("--rolloff must be 4");
        if (result.lnb_voltage != 0U) return invalid("--lnb-voltage must be 0");
    }

    result.valid = true;
    return result;
}

TsProbeOpenMode ts_probe_open_mode(const TsProbeArguments& arguments) noexcept
{
    return arguments.file_descriptor_count == arguments.file_descriptors.size()
               ? TsProbeOpenMode::file_descriptors
               : TsProbeOpenMode::native;
}

Result<void> write_ts_probe_packet(void* context, std::size_t receiver_index,
                                   ByteView packet) noexcept
{
    if (context == nullptr || packet.data == nullptr || packet.size != 188U) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    auto& sink = *static_cast<TsProbeSink*>(context);
    if (receiver_index >= sink.counters.observed_packets.size()) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    if (sink.counters.observed_packets[receiver_index] == std::numeric_limits<std::size_t>::max()) {
        return Result<void>::failure(Error::USB_IO);
    }
    ++sink.counters.observed_packets[receiver_index];
    if (receiver_index != sink.selected_receiver) {
        return Result<void>::success();
    }
    if (sink.write == nullptr) return Result<void>::failure(Error::INVALID_ARGUMENT);
    if (sink.counters.selected_packets == std::numeric_limits<std::size_t>::max() ||
        sink.counters.selected_bytes > std::numeric_limits<std::size_t>::max() - packet.size ||
        sink.counters.output_bytes > std::numeric_limits<std::size_t>::max() - packet.size) {
        return Result<void>::failure(Error::USB_IO);
    }

    const std::size_t written = sink.write(sink.write_context, packet.data, packet.size);
    if (written > packet.size ||
        sink.counters.output_bytes > std::numeric_limits<std::size_t>::max() - written) {
        return Result<void>::failure(Error::USB_IO);
    }
    sink.counters.output_bytes += written;
    if (written != packet.size) return Result<void>::failure(Error::USB_IO);

    ++sink.counters.selected_packets;
    sink.counters.selected_bytes += packet.size;
    return Result<void>::success();
}

TsProbeAcceptanceResult evaluate_ts_probe_acceptance(
    std::uint32_t seconds, const TsProbeSinkCounters& sink,
    const TaggedTsDemux::Counters& demux, std::size_t selected_receiver) noexcept
{
    TsProbeAcceptanceResult result;
    const std::size_t max = std::numeric_limits<std::size_t>::max();
    const std::size_t seconds_size = static_cast<std::size_t>(seconds);
    result.required_packets = seconds_size > max / 1000U ? max : seconds_size * 1000U;
    const auto fail = [&result](TsProbeAcceptanceFailure reason) noexcept {
        if (result.failure_count < result.failures.size()) {
            result.failures[result.failure_count++] = reason;
        }
    };

    if (sink.selected_packets < result.required_packets) {
        fail(TsProbeAcceptanceFailure::insufficient_selected_packets);
    }
    if (demux.invalid_tag_packets != 0U) {
        fail(TsProbeAcceptanceFailure::invalid_tag_packets);
    }
    for (std::size_t index = 0U; index < sink.observed_packets.size(); ++index) {
        if (index != selected_receiver && sink.observed_packets[index] != 0U) {
            fail(TsProbeAcceptanceFailure::unexpected_receiver_packets);
            break;
        }
    }
    if (selected_receiver >= sink.observed_packets.size()) {
        fail(TsProbeAcceptanceFailure::unexpected_receiver_packets);
    }
    if (selected_receiver < sink.observed_packets.size() &&
        sink.observed_packets[selected_receiver] != sink.selected_packets) {
        fail(TsProbeAcceptanceFailure::selected_observed_packets_mismatch);
    }

    const bool expected_bytes_valid = sink.selected_packets <= max / 188U;
    const std::size_t expected_bytes = expected_bytes_valid ? sink.selected_packets * 188U : 0U;
    if (!expected_bytes_valid || sink.selected_bytes != expected_bytes) {
        fail(TsProbeAcceptanceFailure::selected_bytes_mismatch);
    }
    if (!expected_bytes_valid || sink.output_bytes != expected_bytes) {
        fail(TsProbeAcceptanceFailure::output_bytes_mismatch);
    }
    if (sink.output_bytes % 188U != 0U) {
        fail(TsProbeAcceptanceFailure::output_not_packet_aligned);
    }
    if (demux.buffered_bytes >= 4U * 188U) {
        fail(TsProbeAcceptanceFailure::demux_buffered_bytes);
    }
    result.accepted = result.failure_count == 0U;
    return result;
}

const char* ts_probe_acceptance_failure_string(TsProbeAcceptanceFailure failure) noexcept
{
    switch (failure) {
    case TsProbeAcceptanceFailure::insufficient_selected_packets:
        return "selected packet floor not met";
    case TsProbeAcceptanceFailure::invalid_tag_packets:
        return "invalid tagged packets observed";
    case TsProbeAcceptanceFailure::unexpected_receiver_packets:
        return "packets observed on an unselected receiver";
    case TsProbeAcceptanceFailure::selected_observed_packets_mismatch:
        return "selected observed packet count mismatch";
    case TsProbeAcceptanceFailure::selected_bytes_mismatch:
        return "selected byte count mismatch";
    case TsProbeAcceptanceFailure::output_bytes_mismatch:
        return "output byte count mismatch";
    case TsProbeAcceptanceFailure::output_not_packet_aligned:
        return "output size is not a multiple of 188";
    case TsProbeAcceptanceFailure::demux_buffered_bytes:
        return "demux retained too many buffered bytes";
    }
    return "unknown acceptance failure";
}

TsProbeWaitDisposition classify_ts_probe_wait(Error error,
                                              bool before_deadline) noexcept
{
    if (error == Error::TIMEOUT) {
        return before_deadline ? TsProbeWaitDisposition::retry
                               : TsProbeWaitDisposition::deadline;
    }
    return TsProbeWaitDisposition::fatal;
}

int ts_probe_cleanup_status(int primary_status, Error cleanup_error) noexcept
{
    if (primary_status != 0) return primary_status;
    return cleanup_error == Error::OK ? 0 : 6;
}

}  // namespace px4::userland
