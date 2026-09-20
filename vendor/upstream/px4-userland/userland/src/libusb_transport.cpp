// Modified/ported for px4-userland on 2026-09-03.
//
// Copyright (c) 2018-2021 nns779
// Derived from tsukumijima/px4_drv commit 9eedea8c502875a788697984b93b50032339b9aa.
// Origin paths: driver/itedtv_bus.c, driver/itedtv_bus.h, driver/px4_usb.c,
// driver/px4_usb.h, winusb/src/DriverHost_PX4/itedtv_bus_winusb.c,
// winusb/src/DriverHost_PX4/px4_device.cpp.
// Source snapshot maintained by tsukumijima.
// SPDX-License-Identifier: GPL-2.0-only
#include "libusb_transport_internal.h"

#include <libusb.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstring>
#if defined(__linux__) || defined(__ANDROID__)
#include <fcntl.h>
#include <sys/time.h>
#include <unistd.h>
#endif
#include <iterator>
#include <limits>
#include <new>
#include <mutex>
#include <utility>

#if defined(__FreeBSD__)
#if !defined(LIBUSB_API_VERSION) || LIBUSB_API_VERSION < 0x01000102
#error "libusb-1.0.16 or newer is required on FreeBSD"
#endif
#else
#if !defined(LIBUSB_API_VERSION) || LIBUSB_API_VERSION < 0x01000107
#error "libusb-1.0.23 or newer is required"
#endif
#endif

namespace px4::userland {

namespace {

struct NativeTransfer final {
    libusb_transfer* transfer = nullptr;
    LibusbApi::TransferCallback callback = nullptr;
    void* context = nullptr;
};

class ApiGateLock final {
public:
    explicit ApiGateLock(Q3U4RuntimeState* state) noexcept
        : mutex_(state == nullptr ? nullptr : &state->api_gate)
    {
        if (mutex_ != nullptr) {
            mutex_->lock();
        }
    }

    explicit ApiGateLock(RuntimeApiGate* gate) noexcept : mutex_(gate)
    {
        if (mutex_ != nullptr) {
            mutex_->lock();
        }
    }

    ~ApiGateLock() noexcept
    {
        if (mutex_ != nullptr) {
            mutex_->unlock();
        }
    }

    ApiGateLock(const ApiGateLock&) = delete;
    ApiGateLock& operator=(const ApiGateLock&) = delete;

private:
    RuntimeApiGate* mutex_;
};

class CommandEventGateLock final {
public:
    explicit CommandEventGateLock(Q3U4RuntimeState* state) noexcept
        : gate_(state == nullptr ? nullptr : &state->event_gate)
    {
        if (gate_ != nullptr) gate_->lock_command();
    }

    ~CommandEventGateLock() noexcept
    {
        if (gate_ != nullptr) gate_->unlock();
    }

    CommandEventGateLock(const CommandEventGateLock&) = delete;
    CommandEventGateLock& operator=(const CommandEventGateLock&) = delete;

private:
    RuntimeEventGate* gate_;
};

LibusbApi::TransferStatus transfer_status(libusb_transfer_status status) noexcept
{
    switch (status) {
    case LIBUSB_TRANSFER_COMPLETED:
        return LibusbApi::TransferStatus::completed;
    case LIBUSB_TRANSFER_TIMED_OUT:
        return LibusbApi::TransferStatus::timed_out;
    case LIBUSB_TRANSFER_CANCELLED:
        return LibusbApi::TransferStatus::cancelled;
    case LIBUSB_TRANSFER_STALL:
        return LibusbApi::TransferStatus::stall;
    case LIBUSB_TRANSFER_NO_DEVICE:
        return LibusbApi::TransferStatus::no_device;
    case LIBUSB_TRANSFER_OVERFLOW:
        return LibusbApi::TransferStatus::overflow;
    case LIBUSB_TRANSFER_ERROR:
        return LibusbApi::TransferStatus::error;
    }
    return LibusbApi::TransferStatus::error;
}

void LIBUSB_CALL native_transfer_callback(libusb_transfer* transfer) noexcept
{
    auto* native = static_cast<NativeTransfer*>(transfer->user_data);
    if (native != nullptr && native->callback != nullptr) {
        native->callback(static_cast<LibusbApi::Transfer>(native),
                         transfer_status(transfer->status), transfer->actual_length,
                         native->context);
    }
}

UsbSpeed usb_speed(int speed) noexcept
{
    switch (speed) {
    case LIBUSB_SPEED_LOW:
        return UsbSpeed::low;
    case LIBUSB_SPEED_FULL:
        return UsbSpeed::full;
    case LIBUSB_SPEED_HIGH:
        return UsbSpeed::high;
    case LIBUSB_SPEED_SUPER:
        return UsbSpeed::super;
    case 5:
        return UsbSpeed::super_plus;
    case 6:
        return UsbSpeed::super_plus_x2;
    default:
        return UsbSpeed::unknown;
    }
}

int get_device_info_native(libusb_device* device, DeviceObservation* observation,
                            std::uint8_t* serial_index) noexcept
{
    if (device == nullptr || observation == nullptr || serial_index == nullptr) {
        return LIBUSB_ERROR_INVALID_PARAM;
    }
    libusb_device_descriptor descriptor{};
    int result = libusb_get_device_descriptor(device, &descriptor);
    if (result != 0) {
        return result;
    }
    observation->vendor_id = descriptor.idVendor;
    observation->product_id = descriptor.idProduct;
    observation->speed = usb_speed(libusb_get_device_speed(device));
    observation->location.has_bus = true;
    observation->location.has_address = true;
    observation->location.bus = libusb_get_bus_number(device);
    observation->location.address = libusb_get_device_address(device);
    *serial_index = descriptor.iSerialNumber;

    std::array<std::uint8_t, 8U> ports{};
    const int port_count = libusb_get_port_numbers(device, ports.data(),
                                                   static_cast<int>(ports.size()));
    if (port_count >= 0) {
        observation->location.port_count = static_cast<std::uint8_t>(
            std::min(port_count, static_cast<int>(ports.size())));
        std::copy_n(ports.begin(), observation->location.port_count,
                    observation->location.port_path.begin());
    }

    observation->topology.interfaces.clear();
    return 0;
}

int read_serial(LibusbApi& api, LibusbApi::Handle handle, std::uint8_t index,
                std::string* serial) noexcept
{
    if (serial == nullptr) {
        return LIBUSB_ERROR_INVALID_PARAM;
    }
    std::array<char, 256U> buffer{};
    std::size_t length = 0U;
    const int result = api.get_serial_descriptor(handle, index, buffer.data(), buffer.size(), &length);
    if (result != 0) {
        return result;
    }
    if (length >= buffer.size()) {
        return LIBUSB_ERROR_OVERFLOW;
    }
    serial->assign(buffer.data(), length);
    return 0;
}

Result<UsbTopologyObservation> observe_topology(LibusbApi& api,
                                                LibusbApi::Device device) noexcept;

#if defined(__linux__) || defined(__ANDROID__)
Result<DeviceObservation> observe_wrapped_handle(LibusbApi& api, LibusbApi::Handle handle) noexcept
{
    LibusbApi::Device device = nullptr;
    int result = api.get_device_from_handle(handle, &device);
    if (result != 0 || device == nullptr) {
        return Result<DeviceObservation>::failure(result == 0 ? Error::INTERNAL
                                                               : map_libusb_error(result));
    }
    DeviceObservation observation;
    std::uint8_t serial_index = 0U;
    result = api.get_device_info(device, &observation, &serial_index);
    if (result != 0) {
        return Result<DeviceObservation>::failure(map_libusb_error(result));
    }
    if (serial_index == 0U) {
        return Result<DeviceObservation>::failure(Error::INVALID_ARGUMENT);
    }
    result = read_serial(api, handle, serial_index, &observation.serial);
    if (result != 0) {
        return Result<DeviceObservation>::failure(map_libusb_error(result));
    }
    const auto topology = observe_topology(api, device);
    if (!topology) {
        return Result<DeviceObservation>::failure(topology.error());
    }
    observation.topology = topology.value();
    return Result<DeviceObservation>::success(std::move(observation));
}
#endif

bool endpoint_is_in(std::uint8_t endpoint) noexcept
{
    return endpoint != 0U && (endpoint & 0x80U) != 0U;
}

bool endpoint_is_out(std::uint8_t endpoint) noexcept
{
    return endpoint != 0U && (endpoint & 0x80U) == 0U;
}

int describe_config_descriptor_native(libusb_config_descriptor* config,
                                      UsbTopologyObservation* topology) noexcept
{
    if (config == nullptr || topology == nullptr) {
        return LIBUSB_ERROR_INVALID_PARAM;
    }
    topology->interfaces.clear();
    for (int interface_index = 0; interface_index < config->bNumInterfaces; ++interface_index) {
        const libusb_interface& interface = config->interface[interface_index];
        for (int alt_index = 0; alt_index < interface.num_altsetting; ++alt_index) {
            const libusb_interface_descriptor& alt = interface.altsetting[alt_index];
            UsbInterfaceObservation interface_observation;
            interface_observation.number = alt.bInterfaceNumber;
            interface_observation.alternate_setting = alt.bAlternateSetting;
            for (int endpoint_index = 0; endpoint_index < alt.bNumEndpoints; ++endpoint_index) {
                const libusb_endpoint_descriptor& endpoint = alt.endpoint[endpoint_index];
                interface_observation.endpoints.push_back(UsbEndpointObservation{
                    endpoint.bEndpointAddress,
                    static_cast<EndpointType>(endpoint.bmAttributes & LIBUSB_TRANSFER_TYPE_MASK),
                    static_cast<std::uint16_t>(endpoint.wMaxPacketSize & 0x07ffU)});
            }
            topology->interfaces.push_back(std::move(interface_observation));
        }
    }
    return 0;
}

Result<UsbTopologyObservation> observe_topology(LibusbApi& api,
                                                LibusbApi::Device device) noexcept
{
    LibusbApi::ConfigDescriptor descriptor = nullptr;
    const int get_result = api.get_config_descriptor(device, 0U, &descriptor);
    if (get_result != 0) {
        if (descriptor != nullptr) {
            api.free_config_descriptor(descriptor);
        }
        return Result<UsbTopologyObservation>::failure(map_libusb_error(get_result));
    }
    if (descriptor == nullptr) {
        return Result<UsbTopologyObservation>::failure(Error::INTERNAL);
    }
    UsbTopologyObservation topology;
    const int describe_result = api.describe_config_descriptor(descriptor, &topology);
    api.free_config_descriptor(descriptor);
    if (describe_result != 0) {
        return Result<UsbTopologyObservation>::failure(map_libusb_error(describe_result));
    }
    return Result<UsbTopologyObservation>::success(std::move(topology));
}

}  // namespace

Error map_libusb_error(int error) noexcept
{
    switch (error) {
    case 0:
        return Error::OK;
    case LIBUSB_ERROR_TIMEOUT:
        return Error::TIMEOUT;
    case LIBUSB_ERROR_NO_DEVICE:
        return Error::DISCONNECTED;
    case LIBUSB_ERROR_BUSY:
        return Error::BUSY;
    case LIBUSB_ERROR_NOT_FOUND:
        return Error::NOT_FOUND;
    case LIBUSB_ERROR_NOT_SUPPORTED:
        return Error::UNSUPPORTED;
    case LIBUSB_ERROR_INVALID_PARAM:
        return Error::INVALID_ARGUMENT;
    case LIBUSB_ERROR_NO_MEM:
        return Error::INTERNAL;
    case LIBUSB_ERROR_OVERFLOW:
        return Error::USB_IO;
    default:
        return Error::USB_IO;
    }
}

int NativeLibusbApi::init(Context* context, bool no_device_discovery) noexcept
{
    if (context == nullptr) {
        return LIBUSB_ERROR_INVALID_PARAM;
    }
#if defined(__APPLE__)
    (void)no_device_discovery;

    // libusb 1.0.30 and earlier can deadlock in libusb_exit() while Darwin's
    // hotplug thread is handling a detach.  Upstream PR #1780
    // (https://github.com/libusb/libusb/pull/1780, merged 2026-07-02) fixes
    // that shutdown ordering; the current supported libusb baseline predates
    // that fix.  Keep one native context alive for the process so runtime
    // destruction never enters that path.
    static std::mutex context_mutex;
    static libusb_context* process_context = nullptr;
    const std::lock_guard<std::mutex> lock(context_mutex);
    if (process_context != nullptr) {
        *reinterpret_cast<libusb_context**>(context) = process_context;
        return 0;
    }
    libusb_context* created_context = nullptr;
    const int result = libusb_init(&created_context);
    if (result == 0) process_context = created_context;
    *reinterpret_cast<libusb_context**>(context) = created_context;
    return result;
#elif defined(__FreeBSD__)
    auto** native_context = reinterpret_cast<libusb_context**>(context);
    if (no_device_discovery) {
        // FreeBSD's base libusb has no option API.  Native Q3U4 operation
        // requires enumeration; fd-wrapping is a Linux/Android path.
        return LIBUSB_ERROR_NOT_SUPPORTED;
    }
    return libusb_init(native_context);
#else
    auto** native_context = reinterpret_cast<libusb_context**>(context);
    if (!no_device_discovery) {
        return libusb_init(native_context);
    }
#if LIBUSB_API_VERSION >= 0x0100010A
    libusb_init_option option{};
    option.option = LIBUSB_OPTION_NO_DEVICE_DISCOVERY;
    option.value.ival = 1;
    return libusb_init_context(native_context, &option, 1);
#else
    // 1.0.23ではoptionを使える一方でinit_contextがないため、init前にoptionを設定する。
    const int option_result = libusb_set_option(nullptr, LIBUSB_OPTION_NO_DEVICE_DISCOVERY);
    if (option_result != 0) {
        return option_result;
    }
    return libusb_init(native_context);
#endif
#endif
}

void NativeLibusbApi::exit(Context context) noexcept
{
#if defined(__APPLE__)
    // process_context in init() is deliberately process-lifetime state.  Do
    // not call libusb_exit() here; that is the vulnerable Darwin operation.
    (void)context;
#else
    libusb_exit(static_cast<libusb_context*>(context));
#endif
}

int NativeLibusbApi::get_device_list(Context context, void** list, std::size_t* count) noexcept
{
    if (list == nullptr || count == nullptr) {
        return LIBUSB_ERROR_INVALID_PARAM;
    }
    libusb_device** native_list = nullptr;
    const ssize_t native_count = libusb_get_device_list(static_cast<libusb_context*>(context),
                                                        &native_list);
    if (native_count < 0) {
        return static_cast<int>(native_count);
    }
    *list = native_list;
    *count = static_cast<std::size_t>(native_count);
    return 0;
}

LibusbApi::Device NativeLibusbApi::list_device(void* list, std::size_t index) noexcept
{
    if (list == nullptr) {
        return nullptr;
    }
    return static_cast<libusb_device**>(list)[index];
}

void NativeLibusbApi::free_device_list(void* list) noexcept
{
    libusb_free_device_list(static_cast<libusb_device**>(list), 1);
}

int NativeLibusbApi::get_device_info(Device device, DeviceObservation* observation,
                                     std::uint8_t* serial_index) noexcept
{
    return get_device_info_native(static_cast<libusb_device*>(device), observation, serial_index);
}

int NativeLibusbApi::get_config_descriptor(Device device, unsigned int configuration,
                                           ConfigDescriptor* descriptor) noexcept
{
    if (device == nullptr || descriptor == nullptr) {
        return LIBUSB_ERROR_INVALID_PARAM;
    }
    libusb_config_descriptor* native_descriptor = nullptr;
    const int result = libusb_get_config_descriptor(
        static_cast<libusb_device*>(device), static_cast<std::uint8_t>(configuration),
        &native_descriptor);
    *descriptor = native_descriptor;
    return result;
}

int NativeLibusbApi::describe_config_descriptor(ConfigDescriptor descriptor,
                                                UsbTopologyObservation* topology) noexcept
{
    return describe_config_descriptor_native(
        static_cast<libusb_config_descriptor*>(descriptor), topology);
}

void NativeLibusbApi::free_config_descriptor(ConfigDescriptor descriptor) noexcept
{
    libusb_free_config_descriptor(static_cast<libusb_config_descriptor*>(descriptor));
}

int NativeLibusbApi::get_device_from_handle(Handle handle, Device* device) noexcept
{
    if (handle == nullptr || device == nullptr) {
        return LIBUSB_ERROR_INVALID_PARAM;
    }
    *device = libusb_get_device(static_cast<libusb_device_handle*>(handle));
    return *device == nullptr ? LIBUSB_ERROR_NO_DEVICE : 0;
}

int NativeLibusbApi::get_serial_descriptor(Handle handle, std::uint8_t index,
                                           char* output, std::size_t output_size,
                                           std::size_t* length) noexcept
{
    if (handle == nullptr || output == nullptr || output_size == 0U || length == nullptr ||
        output_size > static_cast<std::size_t>(std::numeric_limits<int>::max())) {
        return LIBUSB_ERROR_INVALID_PARAM;
    }
    const int result = libusb_get_string_descriptor_ascii(
        static_cast<libusb_device_handle*>(handle), index,
        reinterpret_cast<unsigned char*>(output), static_cast<int>(output_size));
    if (result >= 0) {
        *length = static_cast<std::size_t>(result);
    }
    return result < 0 ? result : 0;
}

int NativeLibusbApi::open(Device device, Handle* handle) noexcept
{
    if (device == nullptr || handle == nullptr) {
        return LIBUSB_ERROR_INVALID_PARAM;
    }
    libusb_device_handle* native_handle = nullptr;
    const int result = libusb_open(static_cast<libusb_device*>(device), &native_handle);
    *handle = native_handle;
    return result;
}

int NativeLibusbApi::wrap_sys_device(Context context, std::intptr_t fd, Handle* handle) noexcept
{
    if (handle == nullptr) {
        return LIBUSB_ERROR_INVALID_PARAM;
    }
    libusb_device_handle* native_handle = nullptr;
    const int result = libusb_wrap_sys_device(static_cast<libusb_context*>(context), fd,
                                              &native_handle);
    *handle = native_handle;
    return result;
}

int NativeLibusbApi::claim_interface(Handle handle, int interface_number) noexcept
{
    return libusb_claim_interface(static_cast<libusb_device_handle*>(handle), interface_number);
}

int NativeLibusbApi::release_interface(Handle handle, int interface_number) noexcept
{
    return libusb_release_interface(static_cast<libusb_device_handle*>(handle), interface_number);
}

void NativeLibusbApi::close(Handle handle) noexcept
{
    libusb_close(static_cast<libusb_device_handle*>(handle));
}

int NativeLibusbApi::bulk_transfer(Handle handle, std::uint8_t endpoint,
                                   std::uint8_t* buffer, int length, int* transferred,
                                   unsigned int timeout_ms) noexcept
{
    return libusb_bulk_transfer(static_cast<libusb_device_handle*>(handle), endpoint, buffer,
                                length, transferred, timeout_ms);
}

LibusbApi::Transfer NativeLibusbApi::alloc_transfer() noexcept
{
    auto* native = new (std::nothrow) NativeTransfer;
    if (native == nullptr) {
        return nullptr;
    }
    native->transfer = libusb_alloc_transfer(0);
    if (native->transfer == nullptr) {
        delete native;
        return nullptr;
    }
    return native;
}

void NativeLibusbApi::fill_bulk_transfer(Transfer transfer, Handle handle,
                                         std::uint8_t endpoint, std::uint8_t* buffer,
                                         int length, TransferCallback callback, void* context,
                                         unsigned int timeout_ms) noexcept
{
    auto* native = static_cast<NativeTransfer*>(transfer);
    if (native == nullptr || native->transfer == nullptr) {
        return;
    }
    native->callback = callback;
    native->context = context;
    libusb_fill_bulk_transfer(native->transfer, static_cast<libusb_device_handle*>(handle),
                              endpoint, buffer, length, native_transfer_callback, native,
                              static_cast<unsigned int>(timeout_ms));
}

int NativeLibusbApi::submit_transfer(Transfer transfer) noexcept
{
    auto* native = static_cast<NativeTransfer*>(transfer);
    return native == nullptr || native->transfer == nullptr
               ? LIBUSB_ERROR_INVALID_PARAM
               : libusb_submit_transfer(native->transfer);
}

int NativeLibusbApi::cancel_transfer(Transfer transfer) noexcept
{
    auto* native = static_cast<NativeTransfer*>(transfer);
    return native == nullptr || native->transfer == nullptr
               ? LIBUSB_ERROR_INVALID_PARAM
               : libusb_cancel_transfer(native->transfer);
}

void NativeLibusbApi::free_transfer(Transfer transfer) noexcept
{
    auto* native = static_cast<NativeTransfer*>(transfer);
    if (native != nullptr) {
        libusb_free_transfer(native->transfer);
        delete native;
    }
}

int NativeLibusbApi::handle_events(Context context, unsigned int timeout_ms) noexcept
{
    timeval timeout{};
    timeout.tv_sec = static_cast<long>(timeout_ms / 1000U);
    timeout.tv_usec = static_cast<long>((timeout_ms % 1000U) * 1000U);
    return libusb_handle_events_timeout(static_cast<libusb_context*>(context), &timeout);
}

LibusbSession::LibusbSession(LibusbApi& api, LibusbApi::Context context) noexcept
    : api_(&api), context_(context)
{
}

Result<std::unique_ptr<LibusbSession>> LibusbSession::create(LibusbApi& api,
                                                              bool no_device_discovery) noexcept
{
    LibusbApi::Context context = nullptr;
    const int result = api.init(&context, no_device_discovery);
    if (result != 0) {
        return Result<std::unique_ptr<LibusbSession>>::failure(map_libusb_error(result));
    }
    std::unique_ptr<LibusbSession> session(new (std::nothrow) LibusbSession(api, context));
    if (!session) {
        api.exit(context);
        return Result<std::unique_ptr<LibusbSession>>::failure(Error::INTERNAL);
    }
    return Result<std::unique_ptr<LibusbSession>>::success(std::move(session));
}

LibusbSession::~LibusbSession() noexcept
{
    if (api_ != nullptr && context_ != nullptr) {
        api_->exit(context_);
    }
}

void DeviceDiscovery::clear() noexcept
{
    candidates_.clear();
    if (api_ != nullptr && list_ != nullptr) {
        api_->free_device_list(list_);
    }
    api_ = nullptr;
    list_ = nullptr;
}

DeviceDiscovery::~DeviceDiscovery() noexcept
{
    clear();
}

Result<void> NativeEnumerator::discover(DeviceDiscovery& discovery) noexcept
{
    discovery.clear();
    void* list = nullptr;
    std::size_t count = 0U;
    const int list_result = api_.get_device_list(context_, &list, &count);
    if (list_result != 0) {
        return Result<void>::failure(map_libusb_error(list_result));
    }
    discovery.api_ = &api_;
    discovery.list_ = list;
    for (std::size_t index = 0U; index < count; ++index) {
        const LibusbApi::Device device = api_.list_device(list, index);
        DeviceObservation observation;
        std::uint8_t serial_index = 0U;
        const int info_result = api_.get_device_info(device, &observation, &serial_index);
        if (info_result != 0) {
            continue;
        }
        if (observation.vendor_id != kQ3U4VendorId || observation.product_id != kQ3U4ProductId) {
            continue;
        }
        DeviceCandidate candidate;
        candidate.device = device;
        candidate.observation = std::move(observation);
        if (serial_index == 0U) {
            candidate.discovery_error = Error::INVALID_ARGUMENT;
            candidate.status = ObservationStatus::invalid_serial;
            discovery.candidates_.push_back(std::move(candidate));
            continue;
        }
        const auto topology = observe_topology(api_, device);
        if (!topology) {
            candidate.discovery_error = topology.error();
            candidate.status = ObservationStatus::open_failed;
            discovery.candidates_.push_back(std::move(candidate));
            continue;
        }
        candidate.observation.topology = topology.value();
        LibusbApi::Handle handle = nullptr;
    const int open_result = api_.open(device, &handle);
    if (open_result != 0 || handle == nullptr) {
        if (handle != nullptr) {
            api_.close(handle);
        }
        candidate.discovery_error = open_result == 0 ? Error::INTERNAL : map_libusb_error(open_result);
            candidate.status = ObservationStatus::open_failed;
        } else {
            // serial descriptorは列挙中だけ読み、interfaceの所有開始はopen_and_claimへ分離する。
            const int serial_result = read_serial(api_, handle, serial_index,
                                                  &candidate.observation.serial);
            api_.close(handle);
            if (serial_result != 0) {
                candidate.discovery_error = map_libusb_error(serial_result);
                candidate.status = ObservationStatus::invalid_serial;
            } else {
                candidate.status = validate_q3u4_observation(candidate.observation);
            }
        }
        discovery.candidates_.push_back(std::move(candidate));
    }
    return Result<void>::success();
}

Result<std::unique_ptr<LibusbTransport>> NativeEnumerator::open_and_claim(
    const DeviceCandidate& candidate) noexcept
{
    if (candidate.status != ObservationStatus::usable) {
        return Result<std::unique_ptr<LibusbTransport>>::failure(
            candidate.discovery_error != Error::OK ? candidate.discovery_error
                                                    : observation_status_error(candidate.status));
    }
    LibusbApi::Handle handle = nullptr;
    const int open_result = api_.open(candidate.device, &handle);
    if (open_result != 0 || handle == nullptr) {
        if (handle != nullptr) {
            api_.close(handle);
        }
        return Result<std::unique_ptr<LibusbTransport>>::failure(
            open_result == 0 ? Error::INTERNAL : map_libusb_error(open_result));
    }
    const int claim_result = api_.claim_interface(handle, 0);
    if (claim_result != 0) {
        api_.close(handle);
        return Result<std::unique_ptr<LibusbTransport>>::failure(map_libusb_error(claim_result));
    }
    std::unique_ptr<LibusbTransport> transport(new (std::nothrow)
                                                    LibusbTransport(api_, context_, handle, -1));
    if (!transport) {
        api_.release_interface(handle, 0);
        api_.close(handle);
        return Result<std::unique_ptr<LibusbTransport>>::failure(Error::INTERNAL);
    }
    transport->claimed_ = true;
    return Result<std::unique_ptr<LibusbTransport>>::success(std::move(transport));
}

struct LibusbTransport::StreamState final {
    enum class SlotStatus : std::uint8_t { allocated, submitted, completed };
    struct ReadyBlock final {
        std::unique_ptr<std::uint8_t[]> buffer;
        bool ready = false;
        Error error = Error::OK;
        int actual_length = 0;
        std::uint64_t submission_order = 0U;
    };
    struct Slot final {
        StreamState* state = nullptr;
        LibusbApi::Transfer transfer = nullptr;
        std::unique_ptr<std::uint8_t[]> buffer;
        SlotStatus status = SlotStatus::allocated;
        Error error = Error::OK;
        int actual_length = 0;
        std::uint64_t submission_order = 0U;
    };

    std::unique_ptr<Slot[]> slots;
    std::unique_ptr<ReadyBlock[]> ready;
    std::recursive_mutex* gate = nullptr;
    std::condition_variable_any* changed = nullptr;
    LibusbApi* api = nullptr;
    Q3U4RuntimeState* runtime_state = nullptr;
    LibusbApi::Handle handle = nullptr;
    std::uint8_t endpoint = 0U;
    std::size_t count = 0U;
    std::size_t transfer_size = 0U;
    std::size_t outstanding = 0U;
    Slot* delivered = nullptr;
    ReadyBlock* delivered_ready = nullptr;
    std::uint64_t next_submission_order = 0U;
    std::uint64_t next_delivery_order = 0U;
    bool deferred_error_valid = false;
    Error deferred_error = Error::OK;
    std::uint64_t deferred_error_order = 0U;
    bool resubmit_failed = false;
    bool stopping = false;
};

LibusbTransport::RetainedFd::~RetainedFd() noexcept
{
#if defined(__linux__) || defined(__ANDROID__)
    if (fd_ >= 0) {
        (void)::close(fd_);
    }
#endif
    fd_ = -1;
}

LibusbTransport::RetainedFd::RetainedFd(RetainedFd&& other) noexcept : fd_(other.fd_)
{
    other.fd_ = -1;
}

LibusbTransport::RetainedFd& LibusbTransport::RetainedFd::operator=(RetainedFd&& other) noexcept
{
    if (this != &other) {
        if (fd_ >= 0) {
#if defined(__linux__) || defined(__ANDROID__)
            (void)::close(fd_);
#endif
        }
        fd_ = other.fd_;
        other.fd_ = -1;
    }
    return *this;
}

LibusbTransport::LibusbTransport(LibusbApi& api, LibusbApi::Context context,
                                 LibusbApi::Handle handle, int retained_fd,
                                 Q3U4RuntimeState* runtime_state) noexcept
    : api_(&api), context_(context), handle_(handle), runtime_state_(runtime_state),
      retained_fd_(retained_fd), claimed_(true), stream_active_(false), abandoned_(false)
{
}

void LibusbTransport::on_transfer(LibusbApi::Transfer transfer,
                                  LibusbApi::TransferStatus status,
                                  int actual_length, void* context) noexcept
{
    auto* slot = static_cast<StreamState::Slot*>(context);
    if (slot == nullptr || slot->state == nullptr || slot->state->gate == nullptr) {
        return;
    }
    StreamState& state = *slot->state;
    const std::lock_guard<std::recursive_mutex> lock(*state.gate);
    if (slot->status != StreamState::SlotStatus::submitted) {
        return;
    }
    if (slot->transfer != transfer || state.outstanding == 0U) {
        if (state.outstanding != 0U) {
            --state.outstanding;
        }
        slot->error = Error::INTERNAL;
    } else {
        --state.outstanding;
        if (status == LibusbApi::TransferStatus::completed) {
            if (actual_length < 0 || static_cast<std::size_t>(actual_length) > state.transfer_size) {
                slot->error = Error::INTERNAL;
            } else {
                slot->error = Error::OK;
                slot->actual_length = actual_length;
            }
        } else if (status == LibusbApi::TransferStatus::timed_out) {
            slot->error = Error::TIMEOUT;
        } else if (status == LibusbApi::TransferStatus::no_device) {
            slot->error = Error::DISCONNECTED;
        } else if (status == LibusbApi::TransferStatus::cancelled && state.stopping) {
            slot->error = Error::OK;
        } else {
            slot->error = Error::USB_IO;
        }
    }
    if (state.stopping) {
        slot->status = StreamState::SlotStatus::allocated;
        state.changed->notify_all();
        return;
    }
    slot->status = StreamState::SlotStatus::completed;
    if (slot->error != Error::OK) {
        state.resubmit_failed = true;
        state.changed->notify_all();
        return;
    }

    StreamState::ReadyBlock* ready = nullptr;
    if (!state.resubmit_failed) {
        for (std::size_t index = 0U; index < state.count; ++index) {
            if (!state.ready[index].ready && state.delivered_ready != &state.ready[index]) {
                ready = &state.ready[index];
                break;
            }
        }
    }
    if (ready == nullptr) {
        // The bounded callback backlog is full.  Preserve this completion in
        // its transfer slot and let wait_stream resubmit it after delivery.
        state.changed->notify_all();
        return;
    }

    ready->buffer.swap(slot->buffer);
    ready->ready = true;
    ready->error = slot->error;
    ready->actual_length = slot->actual_length;
    ready->submission_order = slot->submission_order;
    state.api->fill_bulk_transfer(slot->transfer, state.handle, state.endpoint,
                                  slot->buffer.get(),
                                  static_cast<int>(state.transfer_size),
                                  on_transfer, slot, 0U);
    slot->status = StreamState::SlotStatus::submitted;
    slot->submission_order = state.next_submission_order++;
    ++state.outstanding;
    const int submit_result = state.api->submit_transfer(slot->transfer);
    if (submit_result != 0) {
        --state.outstanding;
        slot->status = StreamState::SlotStatus::allocated;
        state.resubmit_failed = true;
        state.deferred_error_valid = true;
        state.deferred_error = map_libusb_error(submit_result);
        state.deferred_error_order = slot->submission_order;
    }
    state.changed->notify_all();
}

LibusbTransport::~LibusbTransport() noexcept
{
    // Command-gate before stream-gate is the only operation taking both.
    // Callbacks take only stream-gate, so a synchronous command may dispatch
    // one without creating a lock cycle.
    ApiGateLock lock(runtime_state_);
    std::unique_lock<std::recursive_mutex> stream_lock(stream_gate_);
    if (stream_active_) {
        (void)cancel_and_drain_locked(stream_lock);
    }
    if (stream_ != nullptr && !abandoned_.load()) {
        destroy_stream_locked();
    }
    if (abandoned_.load()) {
        return;
    }
    if (claimed_ && handle_ != nullptr) {
        (void)api_->release_interface(handle_, 0);
    }
    if (handle_ != nullptr) {
        api_->close(handle_);
        handle_ = nullptr;
    }
}

bool LibusbTransport::stream_active() const noexcept
{
    const std::lock_guard<std::recursive_mutex> lock(stream_gate_);
    return stream_active_;
}

Result<std::size_t> LibusbTransport::bulk_read(std::uint8_t endpoint, MutableByteView output,
                                               Timeout timeout,
                                               BulkReadObservation* observation) noexcept
{
    if (observation != nullptr) {
        *observation = BulkReadObservation{};
    }
    const auto failure = [observation](Error error) noexcept {
        if (observation != nullptr) {
            *observation = BulkReadObservation{error, 0U};
        }
        return Result<std::size_t>::failure(error);
    };
    if (!endpoint_is_in(endpoint)) {
        return failure(Error::INVALID_ARGUMENT);
    }
    if (output.size > kMaxCommandTransfer) {
        return failure(Error::BUFFER_TOO_SMALL);
    }
    if (output.size != 0U && output.data == nullptr) {
        return failure(Error::INVALID_ARGUMENT);
    }
    if (output.size > static_cast<std::size_t>(std::numeric_limits<int>::max())) {
        return failure(Error::BUFFER_TOO_SMALL);
    }
    ApiGateLock lock(runtime_state_);
    if (abandoned_.load() ||
        (runtime_state_ != nullptr && runtime_state_->abandoned.load())) {
        return failure(Error::USB_IO);
    }
    int transferred = 0;
    const CommandEventGateLock event_lock(runtime_state_);
    const int result = api_->bulk_transfer(handle_, endpoint, output.data,
                                           static_cast<int>(output.size), &transferred,
                                           timeout.milliseconds);
    if (transferred < 0 || static_cast<std::size_t>(transferred) > output.size) {
        return failure(Error::INTERNAL);
    }
    const std::size_t transfer = static_cast<std::size_t>(transferred);
    const Error error = result == 0 ? Error::OK : map_libusb_error(result);
    if (observation != nullptr) {
        *observation = BulkReadObservation{error, transfer};
    }
    if (result != 0) {
        if (result == LIBUSB_ERROR_TIMEOUT && transferred > 0) {
            return Result<std::size_t>::success(transfer);
        }
        return Result<std::size_t>::failure(error);
    }
    return Result<std::size_t>::success(transfer);
}

Result<std::size_t> LibusbTransport::bulk_write(std::uint8_t endpoint, ByteView input,
                                                Timeout timeout) noexcept
{
    if (!endpoint_is_out(endpoint)) {
        return Result<std::size_t>::failure(Error::INVALID_ARGUMENT);
    }
    if (input.size > kMaxCommandTransfer) {
        return Result<std::size_t>::failure(Error::BUFFER_TOO_SMALL);
    }
    if (input.size != 0U && input.data == nullptr) {
        return Result<std::size_t>::failure(Error::INVALID_ARGUMENT);
    }
    if (input.size > static_cast<std::size_t>(std::numeric_limits<int>::max())) {
        return Result<std::size_t>::failure(Error::BUFFER_TOO_SMALL);
    }
    ApiGateLock lock(runtime_state_);
    if (abandoned_.load() ||
        (runtime_state_ != nullptr && runtime_state_->abandoned.load())) {
        return Result<std::size_t>::failure(Error::USB_IO);
    }
    int transferred = 0;
    const CommandEventGateLock event_lock(runtime_state_);
    const int result = api_->bulk_transfer(handle_, endpoint,
                                           const_cast<std::uint8_t*>(input.data),
                                           static_cast<int>(input.size), &transferred,
                                           timeout.milliseconds);
    if (result != 0) {
        return Result<std::size_t>::failure(map_libusb_error(result));
    }
    if (transferred < 0 || static_cast<std::size_t>(transferred) > input.size) {
        return Result<std::size_t>::failure(Error::INTERNAL);
    }
    return Result<std::size_t>::success(static_cast<std::size_t>(transferred));
}

Result<void> LibusbTransport::start_stream(const StreamConfig& config) noexcept
{
    constexpr std::size_t kMaxStreamTransfers = 64U;
    if (config.endpoint != kTsInEndpoint || config.transfer_size == 0U ||
        config.transfer_size > kMaxStreamTransfer || config.transfer_count == 0U ||
        config.transfer_count > kMaxStreamTransfers ||
        config.transfer_count > std::numeric_limits<std::size_t>::max() / sizeof(StreamState::Slot)) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    std::unique_lock<std::recursive_mutex> lock(stream_gate_);
    if (abandoned_.load() ||
        (runtime_state_ != nullptr && runtime_state_->abandoned.load())) {
        return Result<void>::failure(Error::USB_IO);
    }
    if (stream_active_) {
        return Result<void>::failure(Error::BUSY);
    }
    std::unique_ptr<StreamState> state(new (std::nothrow) StreamState);
    if (!state) {
        return Result<void>::failure(Error::INTERNAL);
    }
    state->slots.reset(new (std::nothrow) StreamState::Slot[config.transfer_count]);
    state->ready.reset(new (std::nothrow) StreamState::ReadyBlock[config.transfer_count]);
    if (!state->slots || !state->ready) {
        return Result<void>::failure(Error::INTERNAL);
    }
    state->count = config.transfer_count;
    state->transfer_size = config.transfer_size;
    state->gate = &stream_gate_;
    state->changed = &stream_changed_;
    state->api = api_;
    state->runtime_state = runtime_state_;
    state->handle = handle_;
    state->endpoint = config.endpoint;
    stream_ = std::move(state);
    stream_active_ = true;

    for (std::size_t index = 0U; index < config.transfer_count; ++index) {
        stream_->ready[index].buffer.reset(
            new (std::nothrow) std::uint8_t[config.transfer_size]);
        if (!stream_->ready[index].buffer) {
            (void)cancel_and_drain_locked(lock);
            return Result<void>::failure(Error::INTERNAL);
        }
    }

    for (std::size_t index = 0U; index < config.transfer_count; ++index) {
        StreamState::Slot& slot = stream_->slots[index];
        slot.state = stream_.get();
        slot.buffer.reset(new (std::nothrow) std::uint8_t[config.transfer_size]);
        slot.transfer = api_->alloc_transfer();
        if (!slot.buffer || slot.transfer == nullptr) {
            (void)cancel_and_drain_locked(lock);
            return Result<void>::failure(Error::INTERNAL);
        }
        api_->fill_bulk_transfer(slot.transfer, handle_, config.endpoint, slot.buffer.get(),
                                 static_cast<int>(config.transfer_size), on_transfer, &slot, 0U);
        // Publish the slot before submit: a fake or real libusb backend may dispatch
        // completion synchronously from submit_transfer.
        slot.status = StreamState::SlotStatus::submitted;
        slot.submission_order = stream_->next_submission_order++;
        ++stream_->outstanding;
        int submit_result = 0;
        {
            const ApiGateLock api_lock(runtime_state_ == nullptr
                                           ? nullptr
                                           : &runtime_state_->stream_api_gate);
            submit_result = api_->submit_transfer(slot.transfer);
        }
        if (submit_result != 0) {
            --stream_->outstanding;
            slot.status = StreamState::SlotStatus::allocated;
            (void)cancel_and_drain_locked(lock);
            return Result<void>::failure(map_libusb_error(submit_result));
        }
    }
    return Result<void>::success();
}

Result<StreamEvent> LibusbTransport::wait_stream(Timeout timeout) noexcept
{
    std::unique_lock<std::recursive_mutex> lock(stream_gate_);
    if (!stream_active_ || stream_ == nullptr) {
        return Result<StreamEvent>::failure(Error::NOT_READY);
    }
    if (stream_->stopping) {
        return Result<StreamEvent>::failure(Error::NOT_READY);
    }
    if (stream_->delivered != nullptr) {
        // StreamEventの契約に合わせ、次の操作まで返却済みbufferへ再受信しない。
        StreamState::Slot& slot = *stream_->delivered;
        if (slot.status != StreamState::SlotStatus::completed || stream_->stopping) {
            return Result<StreamEvent>::failure(Error::INTERNAL);
        }
        slot.status = StreamState::SlotStatus::submitted;
        slot.submission_order = stream_->next_submission_order++;
        ++stream_->outstanding;
        int submit_result = 0;
        {
            const ApiGateLock api_lock(runtime_state_ == nullptr
                                           ? nullptr
                                           : &runtime_state_->stream_api_gate);
            submit_result = api_->submit_transfer(slot.transfer);
        }
        if (submit_result != 0) {
            --stream_->outstanding;
            slot.status = StreamState::SlotStatus::completed;
            slot.error = map_libusb_error(submit_result);
            stream_->delivered = nullptr;
            return Result<StreamEvent>::failure(slot.error);
        }
        stream_->delivered = nullptr;
    }
    if (stream_->delivered_ready != nullptr) {
        stream_->delivered_ready->ready = false;
        stream_->delivered_ready = nullptr;
    }

    auto completed = [this]() noexcept -> Result<StreamEvent> {
        for (std::size_t index = 0U; index < stream_->count; ++index) {
            StreamState::Slot& slot = stream_->slots[index];
            if (slot.status != StreamState::SlotStatus::completed ||
                slot.submission_order != stream_->next_delivery_order)
                continue;
            ++stream_->next_delivery_order;
            if (slot.error != Error::OK)
                return Result<StreamEvent>::failure(slot.error);
            stream_->delivered = &slot;
            const StreamEventKind kind = static_cast<std::size_t>(slot.actual_length) <
                                                 stream_->transfer_size
                                             ? StreamEventKind::short_transfer
                                             : StreamEventKind::data;
            return Result<StreamEvent>::success(StreamEvent{
                kind, slot.buffer.get(), static_cast<std::size_t>(slot.actual_length)});
        }
        for (std::size_t index = 0U; index < stream_->count; ++index) {
            StreamState::ReadyBlock& ready = stream_->ready[index];
            if (!ready.ready || ready.submission_order != stream_->next_delivery_order)
                continue;
            ++stream_->next_delivery_order;
            if (ready.error != Error::OK)
                return Result<StreamEvent>::failure(ready.error);
            stream_->delivered_ready = &ready;
            const StreamEventKind kind = static_cast<std::size_t>(ready.actual_length) <
                                                 stream_->transfer_size
                                             ? StreamEventKind::short_transfer
                                             : StreamEventKind::data;
            return Result<StreamEvent>::success(StreamEvent{
                kind, ready.buffer.get(), static_cast<std::size_t>(ready.actual_length)});
        }
        if (stream_->deferred_error_valid &&
            stream_->deferred_error_order == stream_->next_delivery_order) {
            stream_->deferred_error_valid = false;
            ++stream_->next_delivery_order;
            return Result<StreamEvent>::failure(stream_->deferred_error);
        }
        return Result<StreamEvent>::failure(Error::NOT_FOUND);
    };

    const auto completion_available = [this]() noexcept {
        if (!stream_active_ || stream_ == nullptr || stream_->stopping) return true;
        for (std::size_t index = 0U; index < stream_->count; ++index) {
            if ((stream_->slots[index].status == StreamState::SlotStatus::completed &&
                 stream_->slots[index].submission_order == stream_->next_delivery_order) ||
                (stream_->ready[index].ready &&
                 stream_->ready[index].submission_order == stream_->next_delivery_order))
                return true;
        }
        return stream_->deferred_error_valid &&
               stream_->deferred_error_order == stream_->next_delivery_order;
    };

    Result<StreamEvent> result = completed();
    if (result || result.error() != Error::NOT_FOUND) {
        return result;
    }
    // Never hold stream state while entering libusb's event handler.  A
    // synchronous card/control transfer may currently be the sole event
    // handler and dispatch this stream's callback.  Runtime transports then
    // wait on the callback condition instead of becoming opaque libusb event
    // waiters, so each bridge pump wakes as soon as its own URB completes.
    lock.unlock();
    int event_result = 0;
    if (runtime_state_ == nullptr || runtime_state_->event_gate.try_lock_stream()) {
        event_result = api_->handle_events(context_, timeout.milliseconds);
        if (runtime_state_ != nullptr) runtime_state_->event_gate.unlock();
        lock.lock();
    } else {
        lock.lock();
        (void)stream_changed_.wait_for(
            lock, std::chrono::milliseconds(timeout.milliseconds),
            completion_available);
    }
    if (event_result != 0) {
        return Result<StreamEvent>::failure(map_libusb_error(event_result));
    }
    if (!stream_active_ || stream_ == nullptr || stream_->stopping) {
        return Result<StreamEvent>::failure(Error::NOT_READY);
    }
    result = completed();
    if (result.error() == Error::NOT_FOUND) {
        return Result<StreamEvent>::failure(Error::TIMEOUT);
    }
    return result;
}

Result<void> LibusbTransport::cancel_and_drain() noexcept
{
    std::unique_lock<std::recursive_mutex> lock(stream_gate_);
    return cancel_and_drain_locked(lock);
}

Result<void> LibusbTransport::cancel_and_drain_locked(
    std::unique_lock<std::recursive_mutex>& lock) noexcept
{
    if (stream_ == nullptr) {
        stream_active_ = false;
        return Result<void>::success();
    }
    stream_->stopping = true;
    Error first_error = Error::OK;
    for (std::size_t index = 0U; index < stream_->count; ++index) {
        StreamState::Slot& slot = stream_->slots[index];
        if (slot.status == StreamState::SlotStatus::submitted) {
            const ApiGateLock api_lock(runtime_state_ == nullptr
                                           ? nullptr
                                           : &runtime_state_->stream_api_gate);
            const int result = api_->cancel_transfer(slot.transfer);
            if (result != 0 && result != LIBUSB_ERROR_NOT_FOUND && first_error == Error::OK) {
                first_error = map_libusb_error(result);
            }
        }
    }

    constexpr std::size_t kMaxDrainEventCalls = 8U;
    std::size_t drain_event_calls = 0U;
    while (stream_->outstanding != 0U && drain_event_calls < kMaxDrainEventCalls) {
        // cancel callbackをevent処理で回収する前にfreeするとUAFになるため、outstandingを0まで待つ。
        lock.unlock();
        int result = 0;
        {
            const CommandEventGateLock event_lock(runtime_state_);
            result = api_->handle_events(context_, 1000U);
        }
        lock.lock();
        ++drain_event_calls;
        if (result != 0 && first_error == Error::OK) {
            first_error = map_libusb_error(result);
        }
    }
    if (stream_->outstanding != 0U) {
        // 本番ではcallbackの停止を確認できない状態は回復不能であり、プロセス終了まで
        // transfer、buffer、handle、fdを意図的にリークして隔離する。外部のquiescence所有者が
        // 到達を保証できる場合を除き、後から解放するとlibusb callbackがこれらを参照してUAFになる。
        stream_.release();
        stream_active_ = false;
        abandoned_.store(true);
        if (runtime_state_ != nullptr) {
            runtime_state_->abandoned.store(true);
        }
        retained_fd_.release_without_close();
        if (first_error == Error::OK) {
            first_error = Error::USB_IO;
        }
        return Result<void>::failure(first_error);
    }
    destroy_stream_locked();
    stream_active_ = false;
    return first_error == Error::OK ? Result<void>::success() : Result<void>::failure(first_error);
}

void LibusbTransport::destroy_stream() noexcept
{
    ApiGateLock lock(runtime_state_);
    destroy_stream_locked();
}

void LibusbTransport::destroy_stream_locked() noexcept
{
    if (stream_ == nullptr) {
        return;
    }
    for (std::size_t index = 0U; index < stream_->count; ++index) {
        if (stream_->slots[index].transfer != nullptr) {
            const ApiGateLock api_lock(runtime_state_ == nullptr
                                           ? nullptr
                                           : &runtime_state_->stream_api_gate);
            api_->free_transfer(stream_->slots[index].transfer);
            stream_->slots[index].transfer = nullptr;
        }
    }
    stream_.reset();
}

Result<void> LibusbTransport::cancel_stream() noexcept
{
    std::unique_lock<std::recursive_mutex> lock(stream_gate_);
    if (!stream_active_) {
        return Result<void>::success();
    }
    return cancel_and_drain_locked(lock);
}

Result<void> LibusbTransport::stop_stream() noexcept
{
    std::unique_lock<std::recursive_mutex> lock(stream_gate_);
    if (!stream_active_) {
        return Result<void>::success();
    }
    return cancel_and_drain_locked(lock);
}

bool NativeFdSyscalls::valid(int fd) noexcept
{
#if !defined(__linux__) && !defined(__ANDROID__)
    (void)fd;
    return false;
#else
    return fd >= 0 && fcntl(fd, F_GETFD) >= 0;
#endif
}

int NativeFdSyscalls::duplicate(int fd) noexcept
{
#if !defined(__linux__) && !defined(__ANDROID__)
    (void)fd;
    return -1;
#else
#if defined(F_DUPFD_CLOEXEC)
    const int cloexec_fd = fcntl(fd, F_DUPFD_CLOEXEC, 0);
    if (cloexec_fd >= 0) {
        return cloexec_fd;
    }
#endif
    const int duplicate_fd = ::dup(fd);
    if (duplicate_fd < 0) {
        return -1;
    }
#if defined(FD_CLOEXEC)
    const int flags = fcntl(duplicate_fd, F_GETFD);
    if (flags >= 0) {
        (void)fcntl(duplicate_fd, F_SETFD, flags | FD_CLOEXEC);
    }
#endif
    return duplicate_fd;
#endif
}

#if defined(__linux__) || defined(__ANDROID__)
Result<std::unique_ptr<LibusbTransport>> FdTransportFactory::wrap_and_claim(int fd) noexcept
{
    if (fd < 0 || !syscalls_.valid(fd)) {
        return Result<std::unique_ptr<LibusbTransport>>::failure(Error::INVALID_ARGUMENT);
    }
    // libusbがhandleを保持する期間もduplicateを開いたままにし、元のfdは所有者へ返す。
    const int retained_fd = syscalls_.duplicate(fd);
    if (retained_fd < 0) {
        return Result<std::unique_ptr<LibusbTransport>>::failure(Error::USB_IO);
    }

    LibusbApi::Handle handle = nullptr;
    const int wrap_result = api_.wrap_sys_device(context_, static_cast<std::intptr_t>(retained_fd),
                                                 &handle);
    if (wrap_result != 0 || handle == nullptr) {
        if (handle != nullptr) {
            api_.close(handle);
        }
        LibusbTransport::RetainedFd cleanup(retained_fd);
        return Result<std::unique_ptr<LibusbTransport>>::failure(
            wrap_result == 0 ? Error::INTERNAL : map_libusb_error(wrap_result));
    }
    const auto observation = observe_wrapped_handle(api_, handle);
    if (!observation) {
        api_.close(handle);
        LibusbTransport::RetainedFd cleanup(retained_fd);
        return Result<std::unique_ptr<LibusbTransport>>::failure(observation.error());
    }
    const ObservationStatus observation_status = validate_q3u4_observation(observation.value());
    if (observation_status != ObservationStatus::usable) {
        api_.close(handle);
        LibusbTransport::RetainedFd cleanup(retained_fd);
        return Result<std::unique_ptr<LibusbTransport>>::failure(
            observation_status_error(observation_status));
    }
    const int claim_result = api_.claim_interface(handle, 0);
    if (claim_result != 0) {
        api_.close(handle);
        LibusbTransport::RetainedFd cleanup(retained_fd);
        return Result<std::unique_ptr<LibusbTransport>>::failure(
            map_libusb_error(claim_result));
    }
    std::unique_ptr<LibusbTransport> transport(new (std::nothrow)
                                                    LibusbTransport(api_, context_, handle,
                                                                    retained_fd));
    if (!transport) {
        (void)api_.release_interface(handle, 0);
        api_.close(handle);
        LibusbTransport::RetainedFd cleanup(retained_fd);
        return Result<std::unique_ptr<LibusbTransport>>::failure(Error::INTERNAL);
    }
    return Result<std::unique_ptr<LibusbTransport>>::success(std::move(transport));
}

Result<std::unique_ptr<Q3U4Enclosure>> FdTransportFactory::wrap_and_claim_enclosure(
    const std::vector<int>& fds, std::string_view base_serial) noexcept
{
    if (fds.empty()) {
        return Result<std::unique_ptr<Q3U4Enclosure>>::failure(Error::INVALID_ARGUMENT);
    }
    for (std::size_t left = 0U; left < fds.size(); ++left) {
        if (fds[left] < 0) {
            return Result<std::unique_ptr<Q3U4Enclosure>>::failure(Error::INVALID_ARGUMENT);
        }
        for (std::size_t right = left + 1U; right < fds.size(); ++right) {
            if (fds[left] == fds[right]) {
                return Result<std::unique_ptr<Q3U4Enclosure>>::failure(Error::INVALID_ARGUMENT);
            }
        }
    }
    for (const int fd : fds) {
        if (!syscalls_.valid(fd)) {
            return Result<std::unique_ptr<Q3U4Enclosure>>::failure(Error::INVALID_ARGUMENT);
        }
    }

    struct Pending final {
        LibusbTransport::RetainedFd retained;
        LibusbApi::Handle handle = nullptr;
        DeviceObservation observation;
        bool claimed = false;
    };
    std::vector<Pending> pending;
    pending.resize(fds.size());
    auto cleanup = [&pending, this]() noexcept {
        for (auto iterator = pending.rbegin(); iterator != pending.rend(); ++iterator) {
            if (iterator->claimed && iterator->handle != nullptr) {
                (void)api_.release_interface(iterator->handle, 0);
                iterator->claimed = false;
            }
            if (iterator->handle != nullptr) {
                api_.close(iterator->handle);
                iterator->handle = nullptr;
            }
        }
    };

    for (std::size_t index = 0U; index < fds.size(); ++index) {
        const int retained_fd = syscalls_.duplicate(fds[index]);
        if (retained_fd < 0) {
            cleanup();
            return Result<std::unique_ptr<Q3U4Enclosure>>::failure(Error::USB_IO);
        }
        pending[index].retained = LibusbTransport::RetainedFd(retained_fd);

        LibusbApi::Handle handle = nullptr;
        const int wrap_result = api_.wrap_sys_device(
            context_, static_cast<std::intptr_t>(retained_fd), &handle);
        pending[index].handle = handle;
        if (wrap_result != 0 || handle == nullptr) {
            cleanup();
            return Result<std::unique_ptr<Q3U4Enclosure>>::failure(
                wrap_result == 0 ? Error::INTERNAL : map_libusb_error(wrap_result));
        }

        const auto observation = observe_wrapped_handle(api_, handle);
        if (!observation) {
            cleanup();
            return Result<std::unique_ptr<Q3U4Enclosure>>::failure(observation.error());
        }
        const ObservationStatus status = validate_q3u4_observation(observation.value());
        if (status != ObservationStatus::usable) {
            cleanup();
            return Result<std::unique_ptr<Q3U4Enclosure>>::failure(observation_status_error(status));
        }
        pending[index].observation = observation.value();
    }

    std::vector<DeviceObservation> observations;
    observations.reserve(pending.size());
    for (const Pending& member : pending) {
        observations.push_back(member.observation);
    }
    const auto grouping = group_q3u4_devices(observations);
    if (!grouping) {
        cleanup();
        return Result<std::unique_ptr<Q3U4Enclosure>>::failure(grouping.error());
    }
    const auto selected = select_ready_q3u4_group(grouping.value(), base_serial);
    if (!selected) {
        cleanup();
        return Result<std::unique_ptr<Q3U4Enclosure>>::failure(selected.error());
    }
    const Q3U4Group& group = grouping.value().groups[selected.value()];
    std::array<std::size_t, 2U> selected_indices{
        std::numeric_limits<std::size_t>::max(), std::numeric_limits<std::size_t>::max()};
    for (std::size_t index = 0U; index < pending.size(); ++index) {
        const auto parsed = parse_q3u4_serial(pending[index].observation.serial);
        if (!parsed || parsed.value().base_serial != group.base_serial) {
            continue;
        }
        selected_indices[static_cast<std::size_t>(parsed.value().dev_id - 1U)] = index;
    }
    if (selected_indices[0U] == std::numeric_limits<std::size_t>::max() ||
        selected_indices[1U] == std::numeric_limits<std::size_t>::max()) {
        cleanup();
        return Result<std::unique_ptr<Q3U4Enclosure>>::failure(Error::INTERNAL);
    }

    for (const std::size_t index : selected_indices) {
        const int claim_result = api_.claim_interface(pending[index].handle, 0);
        if (claim_result != 0) {
            cleanup();
            return Result<std::unique_ptr<Q3U4Enclosure>>::failure(map_libusb_error(claim_result));
        }
        pending[index].claimed = true;
    }

    std::unique_ptr<Q3U4Enclosure> enclosure(new (std::nothrow) Q3U4Enclosure);
    if (!enclosure) {
        cleanup();
        return Result<std::unique_ptr<Q3U4Enclosure>>::failure(Error::INTERNAL);
    }
    enclosure->base_serial = group.base_serial;
    for (std::size_t slot = 0U; slot < selected_indices.size(); ++slot) {
        Pending& member = pending[selected_indices[slot]];
        enclosure->transports[slot].reset(new (std::nothrow) LibusbTransport(
            api_, context_, member.handle, member.retained.fd()));
        if (!enclosure->transports[slot]) {
            cleanup();
            return Result<std::unique_ptr<Q3U4Enclosure>>::failure(Error::INTERNAL);
        }
        member.handle = nullptr;
        member.claimed = false;
        member.retained.release();
    }
    cleanup();
    return Result<std::unique_ptr<Q3U4Enclosure>>::success(std::move(enclosure));
}
#endif

Result<GroupingResult> Q3U4Runtime::enumerate_native() noexcept
{
    std::unique_ptr<LibusbApi> api(new (std::nothrow) NativeLibusbApi);
    if (!api) {
        return Result<GroupingResult>::failure(Error::INTERNAL);
    }
    auto session = LibusbSession::create(*api, false);
    if (!session) {
        return Result<GroupingResult>::failure(session.error());
    }
    DeviceDiscovery discovery;
    NativeEnumerator enumerator(*api, session.value()->context());
    const auto discovered = enumerator.discover(discovery);
    if (!discovered) {
        return Result<GroupingResult>::failure(discovered.error());
    }
    std::vector<DeviceObservation> observations;
    observations.reserve(discovery.candidates().size());
    for (const DeviceCandidate& candidate : discovery.candidates()) {
        observations.push_back(candidate.observation);
    }
    return group_q3u4_devices(observations);
}

Q3U4Runtime::Q3U4Runtime(std::unique_ptr<Impl> impl) noexcept : impl_(std::move(impl))
{
}

Transport& Q3U4Runtime::dev1() noexcept
{
    return *impl_->transports_[0U];
}

Transport& Q3U4Runtime::dev2() noexcept
{
    return *impl_->transports_[1U];
}

const Transport& Q3U4Runtime::dev1() const noexcept
{
    return *impl_->transports_[0U];
}

const Transport& Q3U4Runtime::dev2() const noexcept
{
    return *impl_->transports_[1U];
}

std::string_view Q3U4Runtime::base_serial() const noexcept
{
    return impl_->base_serial_;
}

bool Q3U4Runtime::quarantined() const noexcept
{
    if (impl_ == nullptr || impl_->state_ == nullptr) {
        return false;
    }
    return impl_->state_->abandoned.load();
}

Result<std::unique_ptr<Q3U4Runtime::Impl>> Q3U4Runtime::Impl::create(
    std::unique_ptr<LibusbApi> api, std::unique_ptr<FdSyscalls> syscalls,
    bool no_device_discovery, std::string_view base_serial,
    const std::vector<int>* fds) noexcept
{
    if (!api || (fds != nullptr && !syscalls)) {
        return Result<std::unique_ptr<Impl>>::failure(Error::INVALID_ARGUMENT);
    }
    auto session = LibusbSession::create(*api, no_device_discovery);
    if (!session) {
        return Result<std::unique_ptr<Impl>>::failure(session.error());
    }
    std::unique_ptr<Q3U4RuntimeState> state(new (std::nothrow) Q3U4RuntimeState);
    if (!state) {
        return Result<std::unique_ptr<Impl>>::failure(Error::INTERNAL);
    }
    std::unique_ptr<Impl> runtime(new (std::nothrow) Impl);
    if (!runtime) {
        return Result<std::unique_ptr<Impl>>::failure(Error::INTERNAL);
    }
    runtime->api_ = std::move(api);
    runtime->session_ = std::move(session.value());
    runtime->state_ = std::move(state);
    runtime->syscalls_ = std::move(syscalls);
    const Result<void> acquired = fds == nullptr ? runtime->acquire_native(base_serial)
                                                  : runtime->acquire_fds(*fds, base_serial);
    if (!acquired) {
        return Result<std::unique_ptr<Impl>>::failure(acquired.error());
    }
    return Result<std::unique_ptr<Impl>>::success(std::move(runtime));
}

Result<std::unique_ptr<Q3U4Runtime>> Q3U4Runtime::open_native(
    std::string_view base_serial) noexcept
{
    std::unique_ptr<LibusbApi> api(new (std::nothrow) NativeLibusbApi);
    if (!api) {
        return Result<std::unique_ptr<Q3U4Runtime>>::failure(Error::INTERNAL);
    }
    auto impl = Impl::create(std::move(api), nullptr, false, base_serial, nullptr);
    if (!impl) {
        return Result<std::unique_ptr<Q3U4Runtime>>::failure(impl.error());
    }
    std::unique_ptr<Q3U4Runtime> runtime(new (std::nothrow) Q3U4Runtime(std::move(impl.value())));
    if (!runtime) {
        return Result<std::unique_ptr<Q3U4Runtime>>::failure(Error::INTERNAL);
    }
    return Result<std::unique_ptr<Q3U4Runtime>>::success(std::move(runtime));
}

Result<std::unique_ptr<Q3U4Runtime>> Q3U4Runtime::open_fds(
    const std::vector<int>& fds, std::string_view base_serial) noexcept
{
#if !defined(__linux__) && !defined(__ANDROID__)
    (void)fds;
    (void)base_serial;
    return Result<std::unique_ptr<Q3U4Runtime>>::failure(Error::UNSUPPORTED);
#else
    std::unique_ptr<LibusbApi> api(new (std::nothrow) NativeLibusbApi);
    std::unique_ptr<FdSyscalls> syscalls(new (std::nothrow) NativeFdSyscalls);
    if (!api || !syscalls) {
        return Result<std::unique_ptr<Q3U4Runtime>>::failure(Error::INTERNAL);
    }
    auto impl = Impl::create(std::move(api), std::move(syscalls), true, base_serial, &fds);
    if (!impl) {
        return Result<std::unique_ptr<Q3U4Runtime>>::failure(impl.error());
    }
    std::unique_ptr<Q3U4Runtime> runtime(new (std::nothrow) Q3U4Runtime(std::move(impl.value())));
    if (!runtime) {
        return Result<std::unique_ptr<Q3U4Runtime>>::failure(Error::INTERNAL);
    }
    return Result<std::unique_ptr<Q3U4Runtime>>::success(std::move(runtime));
#endif
}

Q3U4Runtime::Impl::~Impl() noexcept
{
    // Members are declared in dependency order, but explicit reset makes the
    // transport-before-session/API invariant auditable and deterministic.
    transports_[1U].reset();
    transports_[0U].reset();
    if (state_ != nullptr && state_->abandoned.load()) {
        // A pending callback may still reach the leaked transfer state. Keep only the
        // API/context/gate graph alive; acquisition-time FdSyscalls is never callback-owned.
        state_.release();
        session_.release();
        api_.release();
    }
}

Q3U4Runtime::~Q3U4Runtime() noexcept = default;

Result<void> Q3U4Runtime::Impl::acquire_native(std::string_view base_serial) noexcept
{
    // Validate caller input before discovery errors are considered.  A malformed
    // requested base serial must remain an argument error even when USB
    // discovery also encounters an operational failure.
    if (!base_serial.empty() && base_serial.size() != 14U) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    for (const char character : base_serial) {
        if (character < '0' || character > '9') {
            return Result<void>::failure(Error::INVALID_ARGUMENT);
        }
    }

    DeviceDiscovery discovery;
    NativeEnumerator enumerator(*api_, session_->context());
    const auto discovered = enumerator.discover(discovery);
    if (!discovered) {
        return discovered;
    }
    std::vector<DeviceObservation> observations;
    observations.reserve(discovery.candidates().size());
    for (const DeviceCandidate& candidate : discovery.candidates()) {
        observations.push_back(candidate.observation);
    }
    const auto grouping = group_q3u4_devices(observations);
    if (!grouping) {
        return Result<void>::failure(grouping.error());
    }
    const auto selected = select_ready_q3u4_group(grouping.value(), base_serial);
    if (!selected) {
        // An operational discovery error is not an incomplete grouping.  In
        // particular, libusb may open the device but fail while reading its
        // serial descriptor; that candidate is marked invalid_serial rather
        // than open_failed.  Preserve such errors instead of collapsing them
        // into NOT_FOUND.  INVALID_ARGUMENT is intentionally excluded here:
        // serial_index == 0 and malformed serial data are validation failures,
        // not USB access failures.
        for (const DeviceCandidate& candidate : discovery.candidates()) {
            if ((candidate.status == ObservationStatus::open_failed ||
                 candidate.status == ObservationStatus::invalid_serial) &&
                candidate.discovery_error != Error::OK &&
                candidate.discovery_error != Error::INVALID_ARGUMENT) {
                return Result<void>::failure(candidate.discovery_error);
            }
        }
        return Result<void>::failure(selected.error());
    }
    const Q3U4Group& group = grouping.value().groups[selected.value()];
    std::array<const DeviceCandidate*, 2U> candidates{nullptr, nullptr};
    for (const DeviceCandidate& candidate : discovery.candidates()) {
        for (std::size_t slot = 0U; slot < candidates.size(); ++slot) {
            if (group.devices[slot].has_value() &&
                candidate.observation.serial == group.devices[slot]->serial) {
                candidates[slot] = &candidate;
            }
        }
    }
    if (candidates[0U] == nullptr || candidates[1U] == nullptr) {
        return Result<void>::failure(Error::INTERNAL);
    }
    for (const DeviceCandidate* candidate : candidates) {
        if (candidate->status != ObservationStatus::usable) {
            if (candidate->discovery_error != Error::OK) {
                return Result<void>::failure(candidate->discovery_error);
            }
            return Result<void>::failure(observation_status_error(candidate->status));
        }
    }

    struct Pending final {
        LibusbApi::Handle handle = nullptr;
        bool claimed = false;
    };
    std::array<Pending, 2U> pending{};
    auto cleanup = [&pending, this]() noexcept {
        for (std::size_t index = pending.size(); index-- > 0U;) {
            if (pending[index].claimed && pending[index].handle != nullptr) {
                (void)api_->release_interface(pending[index].handle, 0);
                pending[index].claimed = false;
            }
            if (pending[index].handle != nullptr) {
                api_->close(pending[index].handle);
                pending[index].handle = nullptr;
            }
        }
    };

    for (std::size_t slot = 0U; slot < pending.size(); ++slot) {
        const int result = api_->open(candidates[slot]->device, &pending[slot].handle);
        if (result != 0 || pending[slot].handle == nullptr) {
            cleanup();
            return Result<void>::failure(result == 0 ? Error::INTERNAL : map_libusb_error(result));
        }
    }
    for (std::size_t slot = 0U; slot < pending.size(); ++slot) {
        const int result = api_->claim_interface(pending[slot].handle, 0);
        if (result != 0) {
            cleanup();
            return Result<void>::failure(map_libusb_error(result));
        }
        pending[slot].claimed = true;
    }

    std::array<std::unique_ptr<LibusbTransport>, 2U> transports;
    for (std::size_t slot = 0U; slot < transports.size(); ++slot) {
        transports[slot].reset(new (std::nothrow) LibusbTransport(
            *api_, session_->context(), pending[slot].handle, -1, state_.get()));
        if (!transports[slot]) {
            cleanup();
            return Result<void>::failure(Error::INTERNAL);
        }
        pending[slot].handle = nullptr;
        pending[slot].claimed = false;
    }
    base_serial_ = group.base_serial;
    transports_[0U] = std::move(transports[0U]);
    transports_[1U] = std::move(transports[1U]);
    cleanup();
    return Result<void>::success();
}

Result<void> Q3U4Runtime::Impl::acquire_fds(const std::vector<int>& fds,
                                            std::string_view base_serial) noexcept
{
#if !defined(__linux__) && !defined(__ANDROID__)
    (void)fds;
    (void)base_serial;
    return Result<void>::failure(Error::UNSUPPORTED);
#else
    if (fds.empty() || syscalls_ == nullptr) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    // Validate all caller inputs before any duplicate, wrap, or claim side effect.
    for (std::size_t left = 0U; left < fds.size(); ++left) {
        if (fds[left] < 0 || !syscalls_->valid(fds[left])) {
            return Result<void>::failure(Error::INVALID_ARGUMENT);
        }
        for (std::size_t right = left + 1U; right < fds.size(); ++right) {
            if (fds[left] == fds[right]) {
                return Result<void>::failure(Error::INVALID_ARGUMENT);
            }
        }
    }

    struct Pending final {
        LibusbTransport::RetainedFd retained;
        LibusbApi::Handle handle = nullptr;
        DeviceObservation observation;
        bool claimed = false;
    };
    std::vector<Pending> pending;
    pending.resize(fds.size());
    auto cleanup = [&pending, this]() noexcept {
        for (std::size_t index = pending.size(); index-- > 0U;) {
            if (pending[index].claimed && pending[index].handle != nullptr) {
                (void)api_->release_interface(pending[index].handle, 0);
                pending[index].claimed = false;
            }
            if (pending[index].handle != nullptr) {
                api_->close(pending[index].handle);
                pending[index].handle = nullptr;
            }
        }
    };

    for (std::size_t index = 0U; index < fds.size(); ++index) {
        const int duplicate = syscalls_->duplicate(fds[index]);
        if (duplicate < 0) {
            cleanup();
            return Result<void>::failure(Error::USB_IO);
        }
        pending[index].retained = LibusbTransport::RetainedFd(duplicate);
        const int wrap = api_->wrap_sys_device(session_->context(), duplicate,
                                               &pending[index].handle);
        if (wrap != 0 || pending[index].handle == nullptr) {
            cleanup();
            return Result<void>::failure(wrap == 0 ? Error::INTERNAL : map_libusb_error(wrap));
        }
        const auto observation = observe_wrapped_handle(*api_, pending[index].handle);
        if (!observation) {
            cleanup();
            return Result<void>::failure(observation.error());
        }
        const ObservationStatus status = validate_q3u4_observation(observation.value());
        if (status != ObservationStatus::usable) {
            cleanup();
            return Result<void>::failure(observation_status_error(status));
        }
        pending[index].observation = observation.value();
    }

    std::vector<DeviceObservation> observations;
    observations.reserve(pending.size());
    for (const Pending& member : pending) {
        observations.push_back(member.observation);
    }
    const auto grouping = group_q3u4_devices(observations);
    if (!grouping) {
        cleanup();
        return Result<void>::failure(grouping.error());
    }
    const auto selected = select_ready_q3u4_group(grouping.value(), base_serial);
    if (!selected) {
        cleanup();
        return Result<void>::failure(selected.error());
    }
    const Q3U4Group& group = grouping.value().groups[selected.value()];
    std::array<std::size_t, 2U> selected_indices{
        std::numeric_limits<std::size_t>::max(), std::numeric_limits<std::size_t>::max()};
    for (std::size_t index = 0U; index < pending.size(); ++index) {
        for (std::size_t slot = 0U; slot < group.devices.size(); ++slot) {
            if (group.devices[slot].has_value() &&
                pending[index].observation.serial == group.devices[slot]->serial) {
                selected_indices[slot] = index;
            }
        }
    }
    if (selected_indices[0U] == std::numeric_limits<std::size_t>::max() ||
        selected_indices[1U] == std::numeric_limits<std::size_t>::max()) {
        cleanup();
        return Result<void>::failure(Error::INTERNAL);
    }
    for (const std::size_t index : selected_indices) {
        const int result = api_->claim_interface(pending[index].handle, 0);
        if (result != 0) {
            cleanup();
            return Result<void>::failure(map_libusb_error(result));
        }
        pending[index].claimed = true;
    }

    std::array<std::unique_ptr<LibusbTransport>, 2U> transports;
    for (std::size_t slot = 0U; slot < transports.size(); ++slot) {
        Pending& member = pending[selected_indices[slot]];
        transports[slot].reset(new (std::nothrow) LibusbTransport(
            *api_, session_->context(), member.handle, member.retained.fd(), state_.get()));
        if (!transports[slot]) {
            cleanup();
            return Result<void>::failure(Error::INTERNAL);
        }
        member.handle = nullptr;
        member.claimed = false;
        member.retained.release();
    }
    base_serial_ = group.base_serial;
    transports_[0U] = std::move(transports[0U]);
    transports_[1U] = std::move(transports[1U]);
    cleanup();
    return Result<void>::success();
#endif
}

}  // namespace px4::userland
