// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_TS_PROBE_SUPPORT_H
#define PX4_USERLAND_TS_PROBE_SUPPORT_H

#include "px4/error.h"
#include "px4/transport.h"
#include "tagged_ts_demux.h"

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>

namespace px4::userland {

enum class TsProbeOpenMode : std::uint8_t {
    native,
    file_descriptors,
};

struct TsProbeArguments final {
    bool valid = false;
    bool help = false;
    std::string base_serial;
    std::string firmware_path;
    std::string output_path;
    std::uint32_t frequency_khz = 0U;
    std::uint32_t seconds = 0U;
    std::uint8_t device = 0U;
    std::uint8_t receiver = 0U;
    std::uint8_t slot = 0U;
    std::uint32_t symbol_rate = 0U;
    std::uint32_t rolloff = 0U;
    std::uint32_t lnb_voltage = 0U;
    std::array<int, 2U> file_descriptors{{-1, -1}};
    std::size_t file_descriptor_count = 0U;
    bool tune_terrestrial = false;
    bool tune_satellite = false;
    std::string_view error;
};

TsProbeArguments parse_ts_probe_arguments(int argc,
                                          const char* const* argv) noexcept;

TsProbeOpenMode ts_probe_open_mode(const TsProbeArguments& arguments) noexcept;

using TsProbeWrite = std::size_t (*)(void* context, const void* data,
                                     std::size_t size) noexcept;

inline constexpr std::size_t kTsProbeSelectedReceiverIndex = 2U;

struct TsProbeSinkCounters final {
    std::array<std::size_t, 4U> observed_packets{};
    std::size_t selected_packets = 0U;
    std::size_t selected_bytes = 0U;
    // Bytes reported by the write seam, including a partial failed write.
    std::size_t output_bytes = 0U;
};

struct TsProbeSink final {
    TsProbeWrite write = nullptr;
    void* write_context = nullptr;
    TsProbeSinkCounters counters;
    std::size_t selected_receiver = kTsProbeSelectedReceiverIndex;
};

// This is a TaggedTsDemux::PacketSink-compatible seam. Every valid packet is
// observed before selected filtering. A selected packet is counted only after
// an exact 188-byte write succeeds; non-selected packets are then ignored.
Result<void> write_ts_probe_packet(void* context, std::size_t receiver_index,
                                   ByteView packet) noexcept;

enum class TsProbeAcceptanceFailure : std::uint8_t {
    insufficient_selected_packets,
    invalid_tag_packets,
    unexpected_receiver_packets,
    selected_observed_packets_mismatch,
    selected_bytes_mismatch,
    output_bytes_mismatch,
    output_not_packet_aligned,
    demux_buffered_bytes,
};

struct TsProbeAcceptanceResult final {
    bool accepted = false;
    std::size_t required_packets = 0U;
    std::array<TsProbeAcceptanceFailure, 8U> failures{};
    std::size_t failure_count = 0U;
};

TsProbeAcceptanceResult evaluate_ts_probe_acceptance(
    std::uint32_t seconds, const TsProbeSinkCounters& sink,
    const TaggedTsDemux::Counters& demux,
    std::size_t selected_receiver = kTsProbeSelectedReceiverIndex) noexcept;

const char* ts_probe_acceptance_failure_string(TsProbeAcceptanceFailure failure) noexcept;

enum class TsProbeWaitDisposition : std::uint8_t {
    retry,
    deadline,
    fatal,
};

TsProbeWaitDisposition classify_ts_probe_wait(Error error,
                                              bool before_deadline) noexcept;

int ts_probe_cleanup_status(int primary_status, Error cleanup_error) noexcept;

}  // namespace px4::userland

#endif  // PX4_USERLAND_TS_PROBE_SUPPORT_H
