// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_POSIX_IPC_H
#define PX4_USERLAND_POSIX_IPC_H

#include "px4/ipc.h"

#include <array>
#include <cstddef>
#include <cstdint>

namespace px4::userland::ipc::posix {

inline constexpr const char* kControlEndpointName = "control.sock";
inline constexpr const char* kStreamEndpointName = "stream.sock";
inline constexpr std::size_t kStoredPathCapacity = 512U;

enum class EndpointAccess : std::uint8_t {
    private_user,
    shared_group,
};

// A null runtime_directory selects $XDG_RUNTIME_DIR. instance and endpoint_name
// are single path components. The resulting endpoint is:
//   <runtime_directory>/px4-userland/<instance>/<endpoint_name>
// This adapter selects permissions only. Group identity selection/chown remains
// the responsibility of the process launcher.
struct EndpointConfig final {
    const char* runtime_directory;
    const char* instance;
    const char* endpoint_name;
    EndpointAccess access = EndpointAccess::private_user;
};

class SocketListener;

// Move-only ownership of one connected nonblocking AF_UNIX SOCK_STREAM fd.
class SocketStream final {
public:
    SocketStream() noexcept = default;
    ~SocketStream() noexcept;

    SocketStream(SocketStream&& other) noexcept;
    SocketStream& operator=(SocketStream&& other) noexcept;
    SocketStream(const SocketStream&) = delete;
    SocketStream& operator=(const SocketStream&) = delete;

    static Result<SocketStream> connect(const EndpointConfig& config,
                                        Timeout timeout) noexcept;

    bool valid() const noexcept { return fd_ >= 0; }
    // Borrowed descriptor for integration with an outer event loop. The
    // caller must not close it or transfer ownership.
    int native_handle() const noexcept { return fd_; }
    void close() noexcept;

    // A successful read always returns at least one byte. EOF and reset are
    // reported as DISCONNECTED; no native errno escapes this boundary.
    Result<std::size_t> read_some(MutableByteView output, Timeout timeout) noexcept;

    // Reads one transport chunk into caller-owned storage and passes it to the
    // allocation-free StreamFramer. The returned count is the number of frames
    // delivered by this read; zero is valid for a partial frame.
    Result<std::size_t> read_frames(MutableByteView read_buffer,
                                    StreamFramer& framer,
                                    FrameConsumer& consumer,
                                    Timeout timeout) noexcept;

    // Validates that frame is one complete IPC frame, then sends every byte
    // within one monotonic absolute deadline.
    Result<void> write_frame(ByteView frame, Timeout timeout) noexcept;

private:
    explicit SocketStream(int fd) noexcept : fd_(fd) {}
    friend class SocketListener;

    int fd_ = -1;
};

// Move-only listener ownership. Destruction closes the fd and unlinks only the
// socket inode created by this instance. Newly-created empty endpoint
// directories are removed only when their inode still matches.
class SocketListener final {
public:
    SocketListener() noexcept = default;
    ~SocketListener() noexcept;

    SocketListener(SocketListener&& other) noexcept;
    SocketListener& operator=(SocketListener&& other) noexcept;
    SocketListener(const SocketListener&) = delete;
    SocketListener& operator=(const SocketListener&) = delete;

    static Result<SocketListener> listen(const EndpointConfig& config,
                                         int backlog = 16) noexcept;

    bool valid() const noexcept { return fd_ >= 0; }
    // Borrowed descriptor for integration with an outer event loop. The
    // caller must not close it or transfer ownership.
    int native_handle() const noexcept { return fd_; }
    const char* endpoint_path() const noexcept { return endpoint_path_.data(); }
    Result<SocketStream> accept(Timeout timeout) noexcept;
    void close() noexcept;

private:
    struct FileIdentity final {
        std::uint64_t device = 0U;
        std::uint64_t inode = 0U;
        bool valid = false;
    };

    void move_from(SocketListener& other) noexcept;
    void cleanup_paths() noexcept;

    int fd_ = -1;
    std::array<char, kStoredPathCapacity> product_directory_{};
    std::array<char, kStoredPathCapacity> instance_directory_{};
    std::array<char, kStoredPathCapacity> endpoint_path_{};
    FileIdentity product_identity_{};
    FileIdentity instance_identity_{};
    FileIdentity endpoint_identity_{};
    std::uint16_t directory_mode_ = 0U;
    std::uint16_t socket_mode_ = 0U;
    bool created_product_directory_ = false;
    bool created_instance_directory_ = false;
    bool created_endpoint_ = false;
};

}  // namespace px4::userland::ipc::posix

#endif  // PX4_USERLAND_POSIX_IPC_H
