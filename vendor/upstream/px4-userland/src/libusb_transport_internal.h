// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_LIBUSB_TRANSPORT_INTERNAL_H
#define PX4_USERLAND_LIBUSB_TRANSPORT_INTERNAL_H

#include "px4/libusb_transport.h"

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <array>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <vector>

namespace px4::userland {

Error map_libusb_error(int error) noexcept;

class LibusbApi {
public:
    using Context = void*;
    using Device = void*;
    using Handle = void*;
    using Transfer = void*;
    using ConfigDescriptor = void*;

    enum class TransferStatus : std::uint8_t {
        completed,
        error,
        timed_out,
        cancelled,
        stall,
        no_device,
        overflow,
    };

    using TransferCallback = void (*)(Transfer transfer,
                                      TransferStatus status,
                                      int actual_length,
                                      void* context) noexcept;

    virtual ~LibusbApi() noexcept = default;
    virtual int init(Context* context, bool no_device_discovery) noexcept = 0;
    virtual void exit(Context context) noexcept = 0;
    virtual int get_device_list(Context context, void** list, std::size_t* count) noexcept = 0;
    virtual Device list_device(void* list, std::size_t index) noexcept = 0;
    virtual void free_device_list(void* list) noexcept = 0;
    virtual int get_device_info(Device device, DeviceObservation* observation,
                                std::uint8_t* serial_index) noexcept = 0;
    virtual int get_config_descriptor(Device device, unsigned int configuration,
                                      ConfigDescriptor* descriptor) noexcept = 0;
    virtual int describe_config_descriptor(ConfigDescriptor descriptor,
                                           UsbTopologyObservation* topology) noexcept = 0;
    virtual void free_config_descriptor(ConfigDescriptor descriptor) noexcept = 0;
    virtual int get_device_from_handle(Handle handle, Device* device) noexcept = 0;
    virtual int get_serial_descriptor(Handle handle, std::uint8_t index,
                                      char* output, std::size_t output_size,
                                      std::size_t* length) noexcept = 0;
    virtual int open(Device device, Handle* handle) noexcept = 0;
    virtual int wrap_sys_device(Context context, std::intptr_t fd, Handle* handle) noexcept = 0;
    virtual int claim_interface(Handle handle, int interface_number) noexcept = 0;
    virtual int release_interface(Handle handle, int interface_number) noexcept = 0;
    virtual void close(Handle handle) noexcept = 0;
    virtual int bulk_transfer(Handle handle, std::uint8_t endpoint,
                              std::uint8_t* buffer, int length, int* transferred,
                              unsigned int timeout_ms) noexcept = 0;
    virtual Transfer alloc_transfer() noexcept = 0;
    virtual void fill_bulk_transfer(Transfer transfer, Handle handle, std::uint8_t endpoint,
                                    std::uint8_t* buffer, int length,
                                    TransferCallback callback, void* context,
                                    unsigned int timeout_ms) noexcept = 0;
    virtual int submit_transfer(Transfer transfer) noexcept = 0;
    virtual int cancel_transfer(Transfer transfer) noexcept = 0;
    virtual void free_transfer(Transfer transfer) noexcept = 0;
    virtual int handle_events(Context context, unsigned int timeout_ms) noexcept = 0;
};

class NativeLibusbApi final : public LibusbApi {
public:
    NativeLibusbApi() noexcept = default;
    ~NativeLibusbApi() noexcept override = default;

    int init(Context* context, bool no_device_discovery) noexcept override;
    void exit(Context context) noexcept override;
    int get_device_list(Context context, void** list, std::size_t* count) noexcept override;
    Device list_device(void* list, std::size_t index) noexcept override;
    void free_device_list(void* list) noexcept override;
    int get_device_info(Device device, DeviceObservation* observation,
                        std::uint8_t* serial_index) noexcept override;
    int get_config_descriptor(Device device, unsigned int configuration,
                              ConfigDescriptor* descriptor) noexcept override;
    int describe_config_descriptor(ConfigDescriptor descriptor,
                                   UsbTopologyObservation* topology) noexcept override;
    void free_config_descriptor(ConfigDescriptor descriptor) noexcept override;
    int get_device_from_handle(Handle handle, Device* device) noexcept override;
    int get_serial_descriptor(Handle handle, std::uint8_t index,
                              char* output, std::size_t output_size,
                              std::size_t* length) noexcept override;
    int open(Device device, Handle* handle) noexcept override;
    int wrap_sys_device(Context context, std::intptr_t fd, Handle* handle) noexcept override;
    int claim_interface(Handle handle, int interface_number) noexcept override;
    int release_interface(Handle handle, int interface_number) noexcept override;
    void close(Handle handle) noexcept override;
    int bulk_transfer(Handle handle, std::uint8_t endpoint,
                      std::uint8_t* buffer, int length, int* transferred,
                      unsigned int timeout_ms) noexcept override;
    Transfer alloc_transfer() noexcept override;
    void fill_bulk_transfer(Transfer transfer, Handle handle, std::uint8_t endpoint,
                            std::uint8_t* buffer, int length,
                            TransferCallback callback, void* context,
                            unsigned int timeout_ms) noexcept override;
    int submit_transfer(Transfer transfer) noexcept override;
    int cancel_transfer(Transfer transfer) noexcept override;
    void free_transfer(Transfer transfer) noexcept override;
    int handle_events(Context context, unsigned int timeout_ms) noexcept override;
};

class LibusbSession final {
public:
    static Result<std::unique_ptr<LibusbSession>> create(LibusbApi& api,
                                                          bool no_device_discovery) noexcept;
    ~LibusbSession() noexcept;

    LibusbSession(const LibusbSession&) = delete;
    LibusbSession& operator=(const LibusbSession&) = delete;

    LibusbApi::Context context() const noexcept { return context_; }

private:
    LibusbSession(LibusbApi& api, LibusbApi::Context context) noexcept;
    LibusbApi* api_;
    LibusbApi::Context context_;
};

struct DeviceCandidate final {
    LibusbApi::Device device = nullptr;
    DeviceObservation observation;
    ObservationStatus status = ObservationStatus::unsupported;
    Error discovery_error = Error::OK;
};

class DeviceDiscovery final {
public:
    DeviceDiscovery() noexcept = default;
    ~DeviceDiscovery() noexcept;
    DeviceDiscovery(const DeviceDiscovery&) = delete;
    DeviceDiscovery& operator=(const DeviceDiscovery&) = delete;
    const std::vector<DeviceCandidate>& candidates() const noexcept { return candidates_; }

private:
    friend class NativeEnumerator;
    void clear() noexcept;
    LibusbApi* api_ = nullptr;
    void* list_ = nullptr;
    std::vector<DeviceCandidate> candidates_;
};

// Serialize synchronous command transactions across the two Q3U4 bridges.
// Stream submission and event handling deliberately do not take this gate:
// libusb's wrapped event APIs arbitrate concurrent event handlers, while a
// synchronous transfer is itself implemented through that event machinery.
// Holding this application gate around stream replenishment would therefore
// let a card command reap all stream URBs while preventing their resubmission.
// The ticket policy keeps command callers fair.  At most a small,
// process-bounded number of callers can be outstanding, so uint64_t ticket
// ambiguity cannot occur in practice.
class RuntimeApiGate final {
public:
    void lock() noexcept
    {
        std::unique_lock<std::mutex> lock(mutex_);
        const std::uint64_t ticket = next_ticket_++;
        state_changed_.notify_all();
        turn_.wait(lock, [this, ticket] { return serving_ticket_ == ticket; });
    }

    void unlock() noexcept
    {
        {
            const std::lock_guard<std::mutex> lock(mutex_);
            ++serving_ticket_;
        }
        turn_.notify_all();
        state_changed_.notify_all();
    }

    // Internal observability used by the deterministic runtime serialization
    // test.  This header is private and is not part of the installed API.
    void wait_until_queued(std::size_t count) noexcept
    {
        std::unique_lock<std::mutex> lock(mutex_);
        state_changed_.wait(lock, [this, count] {
            return static_cast<std::uint64_t>(next_ticket_ - serving_ticket_) > count;
        });
    }

private:
    std::mutex mutex_;
    std::condition_variable turn_;
    std::condition_variable state_changed_;
    std::uint64_t next_ticket_ = 0U;
    std::uint64_t serving_ticket_ = 0U;
};

// Exactly one thread may drive libusb's event loop for the shared context.
// Synchronous transfers take this gate for their whole call because they
// drive events internally.  Stream pumps only try-lock it; if a command or
// the other pump is handling events, they wait on their transport callback
// condition instead.  A queued command is given priority over a new pump
// turn, bounding command latency without blocking URB consumption.
class RuntimeEventGate final {
public:
    void lock_command() noexcept
    {
        command_waiters_.fetch_add(1U);
        mutex_.lock();
        command_waiters_.fetch_sub(1U);
    }

    bool try_lock_stream() noexcept
    {
        if (command_waiters_.load() != 0U) return false;
        if (!mutex_.try_lock()) return false;
        if (command_waiters_.load() == 0U) return true;
        mutex_.unlock();
        return false;
    }

    void unlock() noexcept { mutex_.unlock(); }

private:
    std::mutex mutex_;
    std::atomic<unsigned int> command_waiters_{0U};
};

struct Q3U4RuntimeState final {
    RuntimeApiGate api_gate;
    RuntimeApiGate stream_api_gate;
    RuntimeEventGate event_gate;
    std::atomic<bool> abandoned{false};
};

class LibusbTransport final : public Transport {
public:
    ~LibusbTransport() noexcept override;
    LibusbTransport(const LibusbTransport&) = delete;
    LibusbTransport& operator=(const LibusbTransport&) = delete;
    Result<std::size_t> bulk_read(std::uint8_t endpoint, MutableByteView output,
                                  Timeout timeout,
                                  BulkReadObservation* observation = nullptr) noexcept override;
    Result<std::size_t> bulk_write(std::uint8_t endpoint, ByteView input,
                                   Timeout timeout) noexcept override;
    Result<void> start_stream(const StreamConfig& config) noexcept override;
    Result<StreamEvent> wait_stream(Timeout timeout) noexcept override;
    Result<void> cancel_stream() noexcept override;
    Result<void> stop_stream() noexcept override;
    bool stream_active() const noexcept override;

private:
    friend class NativeEnumerator;
    friend class FdTransportFactory;
    friend class Q3U4Runtime;

public:
    struct StreamState;
    class RetainedFd final {
    public:
        explicit RetainedFd(int fd = -1) noexcept : fd_(fd) {}
        ~RetainedFd() noexcept;
        RetainedFd(const RetainedFd&) = delete;
        RetainedFd& operator=(const RetainedFd&) = delete;
        RetainedFd(RetainedFd&& other) noexcept;
        RetainedFd& operator=(RetainedFd&& other) noexcept;

    public:
        friend class LibusbTransport;
        friend class FdTransportFactory;
        void release_without_close() noexcept { fd_ = -1; }
        int fd() const noexcept { return fd_; }
        void release() noexcept { fd_ = -1; }
        int fd_;
    };

    LibusbTransport(LibusbApi& api, LibusbApi::Context context,
                    LibusbApi::Handle handle, int retained_fd,
                    Q3U4RuntimeState* runtime_state = nullptr) noexcept;

private:
    Result<void> cancel_and_drain() noexcept;
    Result<void> cancel_and_drain_locked(
        std::unique_lock<std::recursive_mutex>& lock) noexcept;
    void destroy_stream() noexcept;
    void destroy_stream_locked() noexcept;
    static void on_transfer(LibusbApi::Transfer transfer,
                            LibusbApi::TransferStatus status,
                            int actual_length, void* context) noexcept;

    LibusbApi* api_;
    LibusbApi::Context context_;
    LibusbApi::Handle handle_;
    Q3U4RuntimeState* runtime_state_;
    RetainedFd retained_fd_;
    bool claimed_;
    mutable std::recursive_mutex stream_gate_;
    std::condition_variable_any stream_changed_;
    bool stream_active_;
    std::atomic<bool> abandoned_;
    std::unique_ptr<StreamState> stream_;
};

struct Q3U4Enclosure final {
    std::string base_serial;
    std::array<std::unique_ptr<LibusbTransport>, 2U> transports;
};

class NativeEnumerator final {
public:
    NativeEnumerator(LibusbApi& api, LibusbApi::Context context) noexcept
        : api_(api), context_(context) {}
    Result<void> discover(DeviceDiscovery& discovery) noexcept;
    Result<std::unique_ptr<LibusbTransport>> open_and_claim(
        const DeviceCandidate& candidate) noexcept;

private:
    LibusbApi& api_;
    LibusbApi::Context context_;
};

class FdSyscalls {
public:
    virtual ~FdSyscalls() noexcept = default;
    virtual bool valid(int fd) noexcept = 0;
    virtual int duplicate(int fd) noexcept = 0;
};

class NativeFdSyscalls final : public FdSyscalls {
public:
    bool valid(int fd) noexcept override;
    int duplicate(int fd) noexcept override;
};

#if defined(__linux__) || defined(__ANDROID__)
class FdTransportFactory final {
public:
    FdTransportFactory(LibusbApi& api, LibusbApi::Context context,
                       FdSyscalls& syscalls) noexcept
        : api_(api), context_(context), syscalls_(syscalls) {}
    Result<std::unique_ptr<LibusbTransport>> wrap_and_claim(int fd) noexcept;
    Result<std::unique_ptr<Q3U4Enclosure>> wrap_and_claim_enclosure(
        const std::vector<int>& fds, std::string_view base_serial = {}) noexcept;

private:
    LibusbApi& api_;
    LibusbApi::Context context_;
    FdSyscalls& syscalls_;
};
#endif

struct Q3U4Runtime::Impl final {
    static Result<std::unique_ptr<Impl>> create(
        std::unique_ptr<LibusbApi> api, std::unique_ptr<FdSyscalls> syscalls,
        bool no_device_discovery, std::string_view base_serial,
        const std::vector<int>* fds) noexcept;
    ~Impl() noexcept;

    Result<void> acquire_native(std::string_view base_serial) noexcept;
    Result<void> acquire_fds(const std::vector<int>& fds,
                             std::string_view base_serial) noexcept;

    std::unique_ptr<LibusbApi> api_;
    std::unique_ptr<LibusbSession> session_;
    std::unique_ptr<Q3U4RuntimeState> state_;
    std::unique_ptr<FdSyscalls> syscalls_;
    std::array<std::unique_ptr<LibusbTransport>, 2U> transports_;
    std::string base_serial_;
};

class RuntimeTestAccess final {
public:
    static Result<GroupingResult> enumerate_native(std::unique_ptr<LibusbApi> api) noexcept;
    static Result<std::unique_ptr<Q3U4Runtime>> open_native(
        std::unique_ptr<LibusbApi> api, std::string_view base_serial = {}) noexcept;
    static Result<std::unique_ptr<Q3U4Runtime>> open_fds(
        std::unique_ptr<LibusbApi> api, std::unique_ptr<FdSyscalls> syscalls,
        const std::vector<int>& fds, std::string_view base_serial = {}) noexcept;
    static Result<std::unique_ptr<Q3U4Runtime>> create_shutdown_fixture(
        std::unique_ptr<LibusbApi> api,
        const std::array<LibusbApi::Handle, 2U>& handles) noexcept;
};

}  // namespace px4::userland

#endif  // PX4_USERLAND_LIBUSB_TRANSPORT_INTERNAL_H
