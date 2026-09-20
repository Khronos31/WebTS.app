// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_CONTROL_CLIENT_H
#define PX4_USERLAND_CONTROL_CLIENT_H

#include "px4/posix_ipc.h"

#include <cstdint>
#include <memory>
#include <vector>

namespace px4::userland::ipc::posix {

struct ControlResponse final {
    FrameHeader header{};
    std::vector<std::uint8_t> payload;
};

class ControlEventSink {
public:
    virtual ~ControlEventSink() noexcept = default;
    virtual void on_device_event(const DeviceEventPayload& event) noexcept = 0;
};

// Synchronous one-outstanding-request client. It owns framing and 8B state;
// callers encode/decode only typed payloads and never parse wire offsets.
class PosixControlClient final {
public:
    static Result<std::unique_ptr<PosixControlClient>> connect(
        const EndpointConfig& endpoint, std::uint32_t requested_capabilities,
        Timeout timeout) noexcept;

    ~PosixControlClient() noexcept;
    PosixControlClient(const PosixControlClient&) = delete;
    PosixControlClient& operator=(const PosixControlClient&) = delete;

    Result<ControlResponse> request(MessageType type, ByteView encoded_payload,
                                    Timeout timeout,
                                    ControlEventSink* events = nullptr) noexcept;
    std::uint32_t negotiated_capabilities() const noexcept;
    void close() noexcept;

private:
    struct Impl;
    explicit PosixControlClient(std::unique_ptr<Impl> impl) noexcept;
    std::unique_ptr<Impl> impl_;
};

}  // namespace px4::userland::ipc::posix

#endif  // PX4_USERLAND_CONTROL_CLIENT_H
