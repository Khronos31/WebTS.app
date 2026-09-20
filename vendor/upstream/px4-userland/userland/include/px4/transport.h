// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_TRANSPORT_H
#define PX4_USERLAND_TRANSPORT_H

#include "px4/error.h"

#include <cstddef>
#include <cstdint>

namespace px4::userland {

inline constexpr std::size_t kMaxCommandTransfer = 65535U;
inline constexpr std::size_t kMaxStreamTransfer = 1048576U;
inline constexpr std::uint8_t kCommandInEndpoint = 0x81U;
inline constexpr std::uint8_t kCommandOutEndpoint = 0x02U;
inline constexpr std::uint8_t kTsInEndpoint = 0x84U;
inline constexpr std::uint8_t kObservedTsInEndpoint = 0x85U;

struct ByteView final {
    const std::uint8_t* data;
    std::size_t size;
};

struct MutableByteView final {
    std::uint8_t* data;
    std::size_t size;
};

struct Timeout final {
    std::uint32_t milliseconds;
};

struct StreamConfig final {
    std::uint8_t endpoint;
    std::size_t transfer_size;
    std::size_t transfer_count;
};

enum class StreamEventKind : std::uint8_t {
    data = 0,
    short_transfer = 1,
};

struct StreamEvent final {
    StreamEventKind kind;
    const std::uint8_t* data;
    std::size_t size;
};

struct BulkReadObservation final {
    Error completion_error = Error::OK;
    std::size_t transferred = 0U;
};

class Transport {
public:
    virtual ~Transport() noexcept = default;

    virtual Result<std::size_t> bulk_read(std::uint8_t endpoint,
                                          MutableByteView output,
                                          Timeout timeout,
                                          BulkReadObservation* observation = nullptr) noexcept = 0;
    virtual Result<std::size_t> bulk_write(std::uint8_t endpoint,
                                           ByteView input,
                                           Timeout timeout) noexcept = 0;

    virtual Result<void> start_stream(const StreamConfig& config) noexcept = 0;
    // 返却されたデータは、次のストリーム操作まで有効です。
    virtual Result<StreamEvent> wait_stream(Timeout timeout) noexcept = 0;
    virtual Result<void> cancel_stream() noexcept = 0;
    virtual Result<void> stop_stream() noexcept = 0;
    virtual bool stream_active() const noexcept = 0;
};

}  // namespace px4::userland

#endif  // PX4_USERLAND_TRANSPORT_H
