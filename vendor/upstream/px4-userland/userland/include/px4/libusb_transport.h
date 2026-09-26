// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_LIBUSB_TRANSPORT_H
#define PX4_USERLAND_LIBUSB_TRANSPORT_H

#include "px4/identity.h"
#include "px4/transport.h"

#include <cstddef>
#include <memory>
#include <string_view>
#include <vector>

namespace px4::userland {

// The runtime owns the libusb implementation, session/context, shared state, and the
// enclosure's transports (two for PX-Q3U4, one for the MLT5 family). References returned here are valid only while this runtime remains alive.
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
    // Only valid when bridge_count() == 2 (PX-Q3U4).
    Transport& dev2() noexcept;
    const Transport& dev1() const noexcept;
    const Transport& dev2() const noexcept;
    // The selected enclosure's instance identifier (see identity.h).
    std::string_view base_serial() const noexcept;
    DeviceModel model() const noexcept;
    std::size_t bridge_count() const noexcept;
    bool quarantined() const noexcept;

private:
    struct Impl;
    explicit Q3U4Runtime(std::unique_ptr<Impl> impl) noexcept;

    friend class RuntimeTestAccess;
    std::unique_ptr<Impl> impl_;
};

}  // namespace px4::userland

#endif  // PX4_USERLAND_LIBUSB_TRANSPORT_H
