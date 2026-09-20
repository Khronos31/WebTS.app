// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_LIBUSB_TRANSPORT_H
#define PX4_USERLAND_LIBUSB_TRANSPORT_H

#include "px4/identity.h"
#include "px4/transport.h"

#include <memory>
#include <string_view>
#include <vector>

namespace px4::userland {

// The runtime owns the libusb implementation, session/context, shared state, and both
// transports. References returned here are valid only while this runtime remains alive.
class Q3U4Runtime final {
public:
    static Result<GroupingResult> enumerate_native() noexcept;
    static Result<std::unique_ptr<Q3U4Runtime>> open_native(
        std::string_view base_serial = {}) noexcept;
    // Each supplied descriptor remains caller-owned.  open_fds duplicates it
    // during acquisition; the runtime closes only its private duplicates and
    // never closes the originals supplied by termux-usb or Android UsbManager.
    static Result<std::unique_ptr<Q3U4Runtime>> open_fds(
        const std::vector<int>& fds, std::string_view base_serial = {}) noexcept;

    ~Q3U4Runtime() noexcept;

    Q3U4Runtime(const Q3U4Runtime&) = delete;
    Q3U4Runtime& operator=(const Q3U4Runtime&) = delete;
    Q3U4Runtime(Q3U4Runtime&&) = delete;
    Q3U4Runtime& operator=(Q3U4Runtime&&) = delete;

    Transport& dev1() noexcept;
    Transport& dev2() noexcept;
    const Transport& dev1() const noexcept;
    const Transport& dev2() const noexcept;
    std::string_view base_serial() const noexcept;
    bool quarantined() const noexcept;

private:
    struct Impl;
    explicit Q3U4Runtime(std::unique_ptr<Impl> impl) noexcept;

    friend class RuntimeTestAccess;
    std::unique_ptr<Impl> impl_;
};

}  // namespace px4::userland

#endif  // PX4_USERLAND_LIBUSB_TRANSPORT_H
