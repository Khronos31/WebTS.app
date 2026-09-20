/* Build-only entry point for the upstream PX4 Transport seam. */
#include "libusb_transport_internal.h"
#include "px4/identity.h"
#include "px4/libusb_transport.h"

static_assert(px4::userland::kCommandInEndpoint == 0x81U);
static_assert(px4::userland::kTsInEndpoint == 0x84U);

// This is deliberately a pure, no-I/O ABI seam. Calling it proves that the
// vendored identity implementation and the libusb transport's error mapping
// are both retained by the linker. It does not construct Q3U4Runtime, open a
// device, claim an interface, or issue a USB transfer.
extern "C" int webts_px4_portable_link_smoke() noexcept
{
    const auto parsed = px4::userland::parse_q3u4_serial("000000000000001");
    if (!parsed || parsed.value().dev_id != 1U || parsed.value().base_serial.size() != 14U) {
        return 1;
    }
    if (px4::userland::map_libusb_error(0) != px4::userland::Error::OK) {
        return 2;
    }
    return px4::userland::kCommandOutEndpoint == 0x02U ? 0 : 3;
}
