// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_CONTROL_SERVER_H
#define PX4_USERLAND_CONTROL_SERVER_H

#include "px4/card_service.h"
#include "px4/posix_ipc.h"
#include "px4/tuner_service.h"

#include <memory>
#include <string_view>

namespace px4::userland::ipc::posix {

// POSIX control-plane engine used by px4d and socket integration tests. The
// poll thread owns sockets, protocol state, responses, events, and leases;
// finite CardService/TunerService calls run on private topology-specific
// worker lanes. Same-bridge tuner operations remain serialized by the bank.
class PosixControlServer final {
public:
    static Result<std::unique_ptr<PosixControlServer>> create(
        const EndpointConfig& endpoint, CardService& card_service,
        TunerService& tuner_service,
        std::string_view base_serial, bool ready = true,
        std::uint8_t usb_present_mask = 0x03U,
        TunerStreamControl* stream_control = nullptr) noexcept;

    ~PosixControlServer() noexcept;
    PosixControlServer(const PosixControlServer&) = delete;
    PosixControlServer& operator=(const PosixControlServer&) = delete;

    // Processes accept/read/dispatch/event work for at most timeout. Repeated
    // calls form the foreground daemon loop and give signal state a bounded
    // observation interval.
    Result<void> poll_once(Timeout timeout) noexcept;
    Result<void> shutdown() noexcept;
    const char* endpoint_path() const noexcept;
    const char* stream_endpoint_path() const noexcept;
    std::size_t connection_count() const noexcept;

private:
    struct Impl;
    explicit PosixControlServer(std::unique_ptr<Impl> impl) noexcept;
    std::unique_ptr<Impl> impl_;
};

}  // namespace px4::userland::ipc::posix

#endif  // PX4_USERLAND_CONTROL_SERVER_H
