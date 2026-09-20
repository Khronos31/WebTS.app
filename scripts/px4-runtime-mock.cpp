/* Build-only source-backed PX4 runtime lifecycle fixture. */
#include "libusb_transport_internal.h"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <memory>
#include <new>
#include <string>

namespace {

using px4::userland::DeviceObservation;
using px4::userland::LibusbApi;
using Device = LibusbApi::Device;

// The fake API is deliberately private to this translation unit.  It provides
// two synthetic Q3U4 devices to the unmodified upstream RuntimeTestAccess
// path; no libusb object, descriptor, serial, or payload crosses the ABI.
class SyntheticLibusbApi final : public px4::userland::LibusbApi {
public:
    struct Stats final {
        std::uint32_t init = 0U;
        std::uint32_t list = 0U;
        std::uint32_t info = 0U;
        std::uint32_t topology = 0U;
        std::uint32_t open = 0U;
        std::uint32_t claim = 0U;
        std::uint32_t release = 0U;
        std::uint32_t close = 0U;
        std::uint32_t exit = 0U;
    };

    ~SyntheticLibusbApi() noexcept override { last_stats() = stats_; }

    int init(Context* context, bool no_device_discovery) noexcept override
    {
        if (context == nullptr) return -1;
        (void)no_device_discovery;
        ++stats_.init;
        *context = this;
        return 0;
    }

    void exit(Context context) noexcept override
    {
        if (context == this) ++stats_.exit;
    }

    int get_device_list(Context context, void** list, std::size_t* count) noexcept override
    {
        if (context != this || list == nullptr || count == nullptr) return -1;
        ++stats_.list;
        *list = this;
        *count = 2U;
        return 0;
    }

    Device list_device(void* list, std::size_t index) noexcept override
    {
        if (list != this || index >= 2U) return nullptr;
        return device(index);
    }

    void free_device_list(void* list) noexcept override { (void)list; }

    int get_device_info(Device value, DeviceObservation* observation,
                        std::uint8_t* serial_index) noexcept override
    {
        const std::size_t index = device_index(value);
        if (index >= 2U || observation == nullptr || serial_index == nullptr) return -1;
        ++stats_.info;
        observation->vendor_id = px4::userland::kQ3U4VendorId;
        observation->product_id = px4::userland::kQ3U4ProductId;
        observation->speed = px4::userland::UsbSpeed::high;
        observation->location.has_bus = true;
        observation->location.has_address = true;
        observation->location.bus = 1U;
        observation->location.address = static_cast<std::uint8_t>(index + 1U);
        *serial_index = 1U;
        return 0;
    }

    int get_config_descriptor(Device value, unsigned int configuration,
                              ConfigDescriptor* descriptor) noexcept override
    {
        if (device_index(value) >= 2U || configuration != 0U || descriptor == nullptr) {
            return -1;
        }
        *descriptor = value;
        return 0;
    }

    int describe_config_descriptor(ConfigDescriptor descriptor,
                                   px4::userland::UsbTopologyObservation* topology) noexcept override
    {
        if (device_index(descriptor) >= 2U || topology == nullptr) return -1;
        ++stats_.topology;
        topology->interfaces.clear();
        topology->interfaces.push_back(px4::userland::UsbInterfaceObservation{
            0U,
            0U,
            {
                {0x81U, px4::userland::EndpointType::bulk, 512U},
                {0x02U, px4::userland::EndpointType::bulk, 512U},
                {0x84U, px4::userland::EndpointType::bulk, 512U},
                {0x85U, px4::userland::EndpointType::bulk, 512U},
            },
        });
        return 0;
    }

    void free_config_descriptor(ConfigDescriptor descriptor) noexcept override { (void)descriptor; }

    int get_device_from_handle(Handle handle, Device* value) noexcept override
    {
        const std::size_t index = handle_index(handle);
        if (index >= 2U || value == nullptr) return -1;
        *value = device(index);
        return 0;
    }

    int get_serial_descriptor(Handle handle, std::uint8_t index, char* output,
                              std::size_t output_size, std::size_t* length) noexcept override
    {
        const std::size_t device_number = handle_index(handle);
        if (device_number >= 2U || index != 1U || output == nullptr || length == nullptr) {
            return -1;
        }
        constexpr const char* serials[] = {"123456789012341", "123456789012342"};
        const std::size_t serial_length = std::strlen(serials[device_number]);
        if (output_size <= serial_length) return -1;
        std::memcpy(output, serials[device_number], serial_length);
        *length = serial_length;
        return 0;
    }

    int open(Device value, Handle* handle) noexcept override
    {
        const std::size_t index = device_index(value);
        if (index >= 2U || handle == nullptr) return -1;
        ++stats_.open;
        *handle = handle_for(index);
        return 0;
    }

    int wrap_sys_device(Context context, std::intptr_t fd, Handle* handle) noexcept override
    {
        (void)context;
        (void)fd;
        (void)handle;
        return -1;
    }

    int claim_interface(Handle handle, int interface_number) noexcept override
    {
        if (handle_index(handle) >= 2U || interface_number != 0) return -1;
        ++stats_.claim;
        return 0;
    }

    int release_interface(Handle handle, int interface_number) noexcept override
    {
        if (handle_index(handle) >= 2U || interface_number != 0) return -1;
        ++stats_.release;
        return 0;
    }

    void close(Handle handle) noexcept override
    {
        if (handle_index(handle) < 2U) ++stats_.close;
    }

    int bulk_transfer(Handle, std::uint8_t, std::uint8_t*, int, int*,
                      unsigned int) noexcept override
    {
        return -1;
    }

    Transfer alloc_transfer() noexcept override { return nullptr; }

    void fill_bulk_transfer(Transfer, Handle, std::uint8_t, std::uint8_t*, int,
                            TransferCallback, void*, unsigned int) noexcept override
    {
    }

    int submit_transfer(Transfer) noexcept override { return -1; }
    int cancel_transfer(Transfer) noexcept override { return -1; }
    void free_transfer(Transfer) noexcept override {}
    int handle_events(Context, unsigned int) noexcept override { return 0; }

    static Stats& last_stats() noexcept
    {
        static Stats stats;
        return stats;
    }

private:
    static Device device(std::size_t index) noexcept
    {
        return reinterpret_cast<Device>(static_cast<std::uintptr_t>(index + 1U));
    }

    static Handle handle_for(std::size_t index) noexcept
    {
        return reinterpret_cast<Handle>(static_cast<std::uintptr_t>(0x100U + index));
    }

    static std::size_t device_index(Device value) noexcept
    {
        const std::uintptr_t raw = reinterpret_cast<std::uintptr_t>(value);
        return raw == 0U ? 2U : static_cast<std::size_t>(raw - 1U);
    }

    static std::size_t handle_index(Handle value) noexcept
    {
        const std::uintptr_t raw = reinterpret_cast<std::uintptr_t>(value);
        return raw < 0x100U ? 2U : static_cast<std::size_t>(raw - 0x100U);
    }

    Stats stats_;
};

}  // namespace

// Calls the vendored RuntimeTestAccess::open_native() with two synthetic
// devices, then lets the real Q3U4Runtime destructor release both interfaces
// and handles.  Only a fixed Error code crosses the ABI.  The internal fake
// serials and topology are never returned, logged, or persisted.
extern "C" std::uint32_t webts_px4_runtime_mock_open_close() noexcept
{
    auto api = std::unique_ptr<px4::userland::LibusbApi>(new (std::nothrow) SyntheticLibusbApi);
    if (!api) return static_cast<std::uint32_t>(px4::userland::Error::INTERNAL);

    auto runtime = px4::userland::RuntimeTestAccess::open_native(std::move(api));
    if (!runtime) return static_cast<std::uint32_t>(runtime.error());
    runtime.value().reset();

    const SyntheticLibusbApi::Stats& stats = SyntheticLibusbApi::last_stats();
    if (stats.init != 1U || stats.list != 1U || stats.info != 2U || stats.topology != 2U ||
        stats.open != 4U || stats.claim != 2U || stats.release != 2U || stats.close != 4U ||
        stats.exit != 1U) {
        return static_cast<std::uint32_t>(px4::userland::Error::INTERNAL);
    }
    return static_cast<std::uint32_t>(px4::userland::Error::OK);
}
