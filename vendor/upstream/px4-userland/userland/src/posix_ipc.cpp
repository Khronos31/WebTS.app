// SPDX-License-Identifier: GPL-2.0-only
#include "px4/posix_ipc.h"

#if defined(PX4_POSIX_IPC_TEST_ACCESS)
#include "posix_ipc_test_access.h"
#endif

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <climits>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <limits>
#include <poll.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>
#include <utility>

namespace px4::userland::ipc::posix {
namespace {

constexpr mode_t kPrivateDirectoryMode = 0700;
constexpr mode_t kPrivateSocketMode = 0600;
constexpr mode_t kGroupDirectoryMode = 0750;
constexpr mode_t kGroupSocketMode = 0660;
constexpr const char* kProductDirectoryName = "px4-userland";
// Keep credential queries bounded even if a platform reports an unexpectedly
// large supplementary-group count.  This covers the supported POSIX targets;
// an over-limit or allocation failure deliberately fails closed.
constexpr std::size_t kMaxSupplementaryGroups = 65536U;

using Clock = std::chrono::steady_clock;
using Deadline = Clock::time_point;
using GroupQuery = int (*)(int, gid_t*) noexcept;

struct NativeIdentity final {
    std::uint64_t device;
    std::uint64_t inode;
};

struct Layout final {
    std::array<char, kStoredPathCapacity> runtime_directory{};
    std::array<char, kStoredPathCapacity> product_directory{};
    std::array<char, kStoredPathCapacity> instance_directory{};
    std::array<char, kStoredPathCapacity> endpoint_path{};
    mode_t directory_mode = 0;
    mode_t socket_mode = 0;
    bool group_access = false;
};

Error map_errno(int error) noexcept
{
    switch (error) {
    case EINVAL:
    case ENAMETOOLONG:
        return Error::INVALID_ARGUMENT;
    case ENOENT:
        return Error::NOT_FOUND;
    case EADDRINUSE:
    case EALREADY:
        return Error::BUSY;
    case ETIMEDOUT:
        return Error::TIMEOUT;
    case ECONNREFUSED:
        return Error::NOT_READY;
    case ECONNRESET:
    case ENOTCONN:
    case EPIPE:
        return Error::DISCONNECTED;
    default:
        return Error::INTERNAL;
    }
}

void close_fd(int fd) noexcept
{
    if (fd >= 0) {
        // Retrying close after EINTR can close an unrelated reused descriptor on
        // platforms where the first close already consumed it.
        (void)::close(fd);
    }
}

std::size_t bounded_length(const char* text, std::size_t limit) noexcept
{
    if (text == nullptr) {
        return limit;
    }
    std::size_t length = 0U;
    while (length < limit && text[length] != '\0') {
        ++length;
    }
    return length;
}

bool valid_component(const char* value) noexcept
{
    const std::size_t length = bounded_length(value, kStoredPathCapacity);
    if (length == 0U || length == kStoredPathCapacity ||
        (length == 1U && value[0] == '.') ||
        (length == 2U && value[0] == '.' && value[1] == '.')) {
        return false;
    }
    for (std::size_t index = 0U; index < length; ++index) {
        const unsigned char character = static_cast<unsigned char>(value[index]);
        const bool accepted =
            (character >= static_cast<unsigned char>('a') &&
             character <= static_cast<unsigned char>('z')) ||
            (character >= static_cast<unsigned char>('A') &&
             character <= static_cast<unsigned char>('Z')) ||
            (character >= static_cast<unsigned char>('0') &&
             character <= static_cast<unsigned char>('9')) ||
            character == static_cast<unsigned char>('-') ||
            character == static_cast<unsigned char>('_') ||
            character == static_cast<unsigned char>('.');
        if (!accepted) {
            return false;
        }
    }
    return true;
}

bool append_path(std::array<char, kStoredPathCapacity>& output,
                 std::size_t& used, const char* component,
                 std::size_t component_length, bool separator) noexcept
{
    const std::size_t extra = component_length + (separator ? 1U : 0U);
    if (used > output.size() || extra > output.size() - used ||
        used + extra >= output.size()) {
        return false;
    }
    if (separator) {
        output[used++] = '/';
    }
    if (component_length != 0U) {
        std::memcpy(output.data() + used, component, component_length);
        used += component_length;
    }
    output[used] = '\0';
    return true;
}

Result<Layout> make_layout(const EndpointConfig& config) noexcept
{
    const char* runtime = config.runtime_directory;
    if (runtime == nullptr) {
        runtime = std::getenv("XDG_RUNTIME_DIR");
    }
    const std::size_t runtime_length = bounded_length(runtime, kStoredPathCapacity);
    if (runtime_length == 0U || runtime_length == kStoredPathCapacity ||
        runtime[0] != '/' || !valid_component(config.instance) ||
        !valid_component(config.endpoint_name)) {
        return Result<Layout>::failure(Error::INVALID_ARGUMENT);
    }

    std::size_t normalized_runtime_length = runtime_length;
    while (normalized_runtime_length > 1U &&
           runtime[normalized_runtime_length - 1U] == '/') {
        --normalized_runtime_length;
    }

    Layout layout{};
    layout.directory_mode = config.access == EndpointAccess::shared_group ?
                                kGroupDirectoryMode : kPrivateDirectoryMode;
    layout.socket_mode = config.access == EndpointAccess::shared_group ?
                             kGroupSocketMode : kPrivateSocketMode;
    layout.group_access = config.access == EndpointAccess::shared_group;

    std::memcpy(layout.runtime_directory.data(), runtime,
                normalized_runtime_length);
    layout.runtime_directory[normalized_runtime_length] = '\0';

    std::size_t used = 0U;
    if (!append_path(layout.product_directory, used, runtime,
                     normalized_runtime_length, false) ||
        !append_path(layout.product_directory, used, kProductDirectoryName,
                     std::strlen(kProductDirectoryName),
                     normalized_runtime_length != 1U)) {
        return Result<Layout>::failure(Error::INVALID_ARGUMENT);
    }

    const std::size_t product_length = used;
    std::memcpy(layout.instance_directory.data(), layout.product_directory.data(),
                product_length + 1U);
    used = product_length;
    const std::size_t instance_length = std::strlen(config.instance);
    if (!append_path(layout.instance_directory, used, config.instance,
                     instance_length, true)) {
        return Result<Layout>::failure(Error::INVALID_ARGUMENT);
    }

    const std::size_t directory_length = used;
    std::memcpy(layout.endpoint_path.data(), layout.instance_directory.data(),
                directory_length + 1U);
    used = directory_length;
    const std::size_t endpoint_length = std::strlen(config.endpoint_name);
    if (!append_path(layout.endpoint_path, used, config.endpoint_name,
                     endpoint_length, true) ||
        used >= sizeof(sockaddr_un{}.sun_path)) {
        return Result<Layout>::failure(Error::INVALID_ARGUMENT);
    }
    return Result<Layout>::success(std::move(layout));
}

bool same_identity(const struct stat& status, const NativeIdentity& identity) noexcept
{
    return identity.device == static_cast<std::uint64_t>(status.st_dev) &&
           identity.inode == static_cast<std::uint64_t>(status.st_ino);
}

NativeIdentity identity_of(const struct stat& status) noexcept
{
    return NativeIdentity{static_cast<std::uint64_t>(status.st_dev),
                          static_cast<std::uint64_t>(status.st_ino)};
}

int native_getgroups(int size, gid_t* groups) noexcept
{
    return ::getgroups(size, groups);
}

bool supplementary_group_contains(gid_t group, GroupQuery getgroups) noexcept
{
    if (getgroups == nullptr) {
        return false;
    }
    const int group_count = getgroups(0, nullptr);
    if (group_count <= 0 ||
        static_cast<std::size_t>(group_count) > kMaxSupplementaryGroups) {
        return false;
    }

    const std::size_t count = static_cast<std::size_t>(group_count);
    if (count > std::numeric_limits<std::size_t>::max() / sizeof(gid_t)) {
        return false;
    }
    auto* groups = static_cast<gid_t*>(std::malloc(count * sizeof(gid_t)));
    if (groups == nullptr) {
        return false;
    }

    const int actual_count = getgroups(group_count, groups);
    bool found = false;
    if (actual_count == group_count) {
        for (int index = 0; index < actual_count; ++index) {
            if (groups[index] == group) {
                found = true;
                break;
            }
        }
    }
    std::free(groups);
    return found;
}

bool ownership_allowed_for_ids(uid_t owner_uid, gid_t owner_gid,
                               uid_t effective_uid, gid_t effective_gid,
                               bool group_access, GroupQuery getgroups) noexcept
{
    return owner_uid == effective_uid ||
           (group_access && (owner_gid == effective_gid ||
                             supplementary_group_contains(owner_gid, getgroups)));
}

bool ownership_allowed(const struct stat& status, bool group_access) noexcept
{
    return ownership_allowed_for_ids(status.st_uid, status.st_gid, ::geteuid(),
                                     ::getegid(), group_access,
                                     native_getgroups);
}

Result<NativeIdentity> validate_directory(const char* path, mode_t expected_mode,
                                          bool group_access = false) noexcept
{
    struct stat status {};
    if (::lstat(path, &status) != 0) {
        return Result<NativeIdentity>::failure(map_errno(errno));
    }
    if (!S_ISDIR(status.st_mode) || S_ISLNK(status.st_mode) ||
        !ownership_allowed(status, group_access) ||
        (status.st_mode & 07777) != expected_mode) {
        return Result<NativeIdentity>::failure(Error::INVALID_ARGUMENT);
    }
    return Result<NativeIdentity>::success(identity_of(status));
}

Result<NativeIdentity> ensure_directory(const char* path, mode_t mode,
                                        bool& created) noexcept
{
    created = false;
    if (::mkdir(path, mode) == 0) {
        created = true;
        if (::chmod(path, mode) != 0) {
            return Result<NativeIdentity>::failure(map_errno(errno));
        }
    } else if (errno != EEXIST) {
        return Result<NativeIdentity>::failure(map_errno(errno));
    }
    return validate_directory(path, mode);
}

Result<void> configure_socket_fd(int fd) noexcept
{
    const int descriptor_flags = ::fcntl(fd, F_GETFD);
    if (descriptor_flags < 0 ||
        ::fcntl(fd, F_SETFD, descriptor_flags | FD_CLOEXEC) < 0) {
        return Result<void>::failure(map_errno(errno));
    }
    const int status_flags = ::fcntl(fd, F_GETFL);
    if (status_flags < 0 ||
        ::fcntl(fd, F_SETFL, status_flags | O_NONBLOCK) < 0) {
        return Result<void>::failure(map_errno(errno));
    }
#if !defined(MSG_NOSIGNAL)
#if defined(SO_NOSIGPIPE)
    const int enabled = 1;
    if (::setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &enabled,
                     static_cast<socklen_t>(sizeof(enabled))) != 0) {
        return Result<void>::failure(map_errno(errno));
    }
#else
    return Result<void>::failure(Error::UNSUPPORTED);
#endif
#endif
    return Result<void>::success();
}

socklen_t make_address(const char* path, sockaddr_un& address) noexcept
{
    std::memset(&address, 0, sizeof(address));
    address.sun_family = AF_UNIX;
    const std::size_t length = std::strlen(path);
    std::memcpy(address.sun_path, path, length + 1U);
    const std::size_t native_length = offsetof(sockaddr_un, sun_path) + length + 1U;
#if defined(__APPLE__)
    address.sun_len = static_cast<decltype(address.sun_len)>(native_length);
#endif
    return static_cast<socklen_t>(native_length);
}

Deadline deadline_after(Timeout timeout) noexcept
{
    return Clock::now() + std::chrono::milliseconds(timeout.milliseconds);
}

bool deadline_expired(Deadline deadline) noexcept
{
    return Clock::now() >= deadline;
}

int remaining_poll_milliseconds(Deadline deadline) noexcept
{
    const auto now = Clock::now();
    if (now >= deadline) {
        return 0;
    }
    const auto remaining = deadline - now;
    const auto whole = std::chrono::duration_cast<std::chrono::milliseconds>(remaining);
    auto milliseconds = whole.count();
    if (whole < remaining) {
        ++milliseconds;
    }
    if (milliseconds > INT_MAX) {
        return INT_MAX;
    }
    return static_cast<int>(milliseconds);
}

Result<void> wait_fd(int fd, short events, Deadline deadline) noexcept
{
    while (true) {
        const int milliseconds = remaining_poll_milliseconds(deadline);
        if (milliseconds == 0) {
            return Result<void>::failure(Error::TIMEOUT);
        }
        pollfd descriptor{fd, events, 0};
        const int result = ::poll(&descriptor, 1U, milliseconds);
        if (result > 0) {
            if ((descriptor.revents & POLLNVAL) != 0) {
                return Result<void>::failure(Error::INTERNAL);
            }
            return Result<void>::success();
        }
        if (result == 0) {
            return Result<void>::failure(Error::TIMEOUT);
        }
        if (errno != EINTR) {
            return Result<void>::failure(map_errno(errno));
        }
    }
}

Result<NativeIdentity> validate_socket_path(const char* path, mode_t mode,
                                            bool group_access = false) noexcept
{
    struct stat status {};
    if (::lstat(path, &status) != 0) {
        return Result<NativeIdentity>::failure(map_errno(errno));
    }
    if (!S_ISSOCK(status.st_mode) || S_ISLNK(status.st_mode) ||
        !ownership_allowed(status, group_access) ||
        (status.st_mode & 07777) != mode) {
        return Result<NativeIdentity>::failure(Error::INVALID_ARGUMENT);
    }
    return Result<NativeIdentity>::success(identity_of(status));
}

Result<void> remove_stale_socket(const char* path, mode_t mode) noexcept
{
    struct stat initial_status {};
    if (::lstat(path, &initial_status) != 0) {
        return errno == ENOENT ? Result<void>::success() :
                                Result<void>::failure(map_errno(errno));
    }
    if (!S_ISSOCK(initial_status.st_mode) || S_ISLNK(initial_status.st_mode) ||
        initial_status.st_uid != ::geteuid() ||
        (initial_status.st_mode & 07777) != mode) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    const NativeIdentity initial_identity = identity_of(initial_status);

    const int probe_fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
    if (probe_fd < 0) {
        return Result<void>::failure(map_errno(errno));
    }
    const auto configured = configure_socket_fd(probe_fd);
    if (!configured) {
        close_fd(probe_fd);
        return configured;
    }
    sockaddr_un address{};
    const socklen_t address_length = make_address(path, address);
    const int connect_result =
        ::connect(probe_fd, reinterpret_cast<const sockaddr*>(&address), address_length);
    const int connect_error = connect_result == 0 ? 0 : errno;
    close_fd(probe_fd);
    if (connect_result == 0 || connect_error == EINPROGRESS ||
        connect_error == EAGAIN || connect_error == EALREADY) {
        return Result<void>::failure(Error::BUSY);
    }
    if (connect_error != ECONNREFUSED) {
        return Result<void>::failure(map_errno(connect_error));
    }

    struct stat current_status {};
    if (::lstat(path, &current_status) != 0 ||
        !S_ISSOCK(current_status.st_mode) ||
        current_status.st_uid != ::geteuid() ||
        (current_status.st_mode & 07777) != mode ||
        !same_identity(current_status, initial_identity)) {
        return Result<void>::failure(Error::BUSY);
    }
    if (::unlink(path) != 0) {
        return Result<void>::failure(map_errno(errno));
    }
    return Result<void>::success();
}

void remove_owned_socket(const char* path, const NativeIdentity& identity,
                         mode_t mode) noexcept
{
    struct stat status {};
    if (::lstat(path, &status) == 0 && S_ISSOCK(status.st_mode) &&
        status.st_uid == ::geteuid() && (status.st_mode & 07777) == mode &&
        same_identity(status, identity)) {
        (void)::unlink(path);
    }
}

void remove_owned_directory(const char* path, const NativeIdentity& identity,
                            mode_t mode) noexcept
{
    struct stat status {};
    if (::lstat(path, &status) == 0 && S_ISDIR(status.st_mode) &&
        status.st_uid == ::geteuid() && (status.st_mode & 07777) == mode &&
        same_identity(status, identity)) {
        // rmdir is intentionally used: unrelated contents make cleanup fail
        // safely instead of being recursively deleted.
        (void)::rmdir(path);
    }
}

}  // namespace

#if defined(PX4_POSIX_IPC_TEST_ACCESS)
bool PosixIpcTestAccess::ownership_allowed(uid_t owner_uid, gid_t owner_gid,
                                            uid_t effective_uid,
                                            gid_t effective_gid,
                                            bool group_access,
                                            PosixIpcGetGroups getgroups) noexcept
{
    return ownership_allowed_for_ids(owner_uid, owner_gid, effective_uid,
                                     effective_gid, group_access, getgroups);
}
#endif

SocketStream::~SocketStream() noexcept
{
    close();
}

SocketStream::SocketStream(SocketStream&& other) noexcept : fd_(other.fd_)
{
    other.fd_ = -1;
}

SocketStream& SocketStream::operator=(SocketStream&& other) noexcept
{
    if (this != &other) {
        close();
        fd_ = other.fd_;
        other.fd_ = -1;
    }
    return *this;
}

Result<SocketStream> SocketStream::connect(const EndpointConfig& config,
                                           Timeout timeout) noexcept
{
    const auto layout_result = make_layout(config);
    if (!layout_result) {
        return Result<SocketStream>::failure(layout_result.error());
    }
    const Layout& layout = layout_result.value();

    // Every traversed project-owned directory and the endpoint itself must
    // already satisfy the selected ownership/mode contract.
    const auto runtime = validate_directory(layout.runtime_directory.data(),
                                            layout.directory_mode,
                                            layout.group_access);
    const auto product = validate_directory(layout.product_directory.data(),
                                            layout.directory_mode,
                                            layout.group_access);
    const auto instance = validate_directory(layout.instance_directory.data(),
                                             layout.directory_mode,
                                             layout.group_access);
    const auto endpoint = validate_socket_path(layout.endpoint_path.data(),
                                               layout.socket_mode,
                                               layout.group_access);
    if (!runtime || !product || !instance || !endpoint) {
        const Error error = !runtime ? runtime.error() :
                            (!product ? product.error() :
                             (!instance ? instance.error() : endpoint.error()));
        return Result<SocketStream>::failure(error);
    }

    int fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) {
        return Result<SocketStream>::failure(map_errno(errno));
    }
    const auto configured = configure_socket_fd(fd);
    if (!configured) {
        close_fd(fd);
        return Result<SocketStream>::failure(configured.error());
    }

    sockaddr_un address{};
    const socklen_t address_length = make_address(layout.endpoint_path.data(), address);
    const Deadline deadline = deadline_after(timeout);
    const int result =
        ::connect(fd, reinterpret_cast<const sockaddr*>(&address), address_length);
    if (result != 0) {
        const int initial_error = errno;
        if (initial_error != EINPROGRESS && initial_error != EAGAIN &&
            initial_error != EALREADY && initial_error != EINTR) {
            close_fd(fd);
            return Result<SocketStream>::failure(map_errno(initial_error));
        }
        const auto ready = wait_fd(fd, POLLOUT, deadline);
        if (!ready) {
            close_fd(fd);
            return Result<SocketStream>::failure(ready.error());
        }
        int socket_error = 0;
        socklen_t socket_error_size = static_cast<socklen_t>(sizeof(socket_error));
        if (::getsockopt(fd, SOL_SOCKET, SO_ERROR, &socket_error,
                         &socket_error_size) != 0) {
            const Error error = map_errno(errno);
            close_fd(fd);
            return Result<SocketStream>::failure(error);
        }
        if (socket_error != 0) {
            close_fd(fd);
            return Result<SocketStream>::failure(map_errno(socket_error));
        }
    }
    return Result<SocketStream>::success(SocketStream(fd));
}

void SocketStream::close() noexcept
{
    const int fd = fd_;
    fd_ = -1;
    close_fd(fd);
}

Result<std::size_t> SocketStream::read_some(MutableByteView output,
                                            Timeout timeout) noexcept
{
    if (!valid() || output.data == nullptr || output.size == 0U) {
        return Result<std::size_t>::failure(Error::INVALID_ARGUMENT);
    }
    const Deadline deadline = deadline_after(timeout);
    const std::size_t maximum = static_cast<std::size_t>(
        std::numeric_limits<ssize_t>::max());
    const std::size_t size = std::min(output.size, maximum);
    while (true) {
        const ssize_t received = ::recv(fd_, output.data, size, 0);
        if (received > 0) {
            return Result<std::size_t>::success(static_cast<std::size_t>(received));
        }
        if (received == 0) {
            return Result<std::size_t>::failure(Error::DISCONNECTED);
        }
        const int error = errno;
        if (error == EINTR) {
            if (deadline_expired(deadline)) {
                return Result<std::size_t>::failure(Error::TIMEOUT);
            }
            continue;
        }
        if (error != EAGAIN && error != EWOULDBLOCK) {
            return Result<std::size_t>::failure(map_errno(error));
        }
        const auto ready = wait_fd(fd_, POLLIN, deadline);
        if (!ready) {
            return Result<std::size_t>::failure(ready.error());
        }
    }
}

Result<std::size_t> SocketStream::read_frames(MutableByteView read_buffer,
                                              StreamFramer& framer,
                                              FrameConsumer& consumer,
                                              Timeout timeout) noexcept
{
    const auto received = read_some(read_buffer, timeout);
    if (!received) {
        return Result<std::size_t>::failure(received.error());
    }
    return framer.feed(ByteView{read_buffer.data, received.value()}, consumer);
}

Result<void> SocketStream::write_frame(ByteView frame, Timeout timeout) noexcept
{
    if (!valid()) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    const auto decoded = decode_frame(frame);
    if (!decoded) {
        return Result<void>::failure(decoded.error());
    }
    const Deadline deadline = deadline_after(timeout);
    std::size_t offset = 0U;
    const std::size_t maximum = static_cast<std::size_t>(
        std::numeric_limits<ssize_t>::max());
    while (offset < frame.size) {
        const std::size_t amount = std::min(frame.size - offset, maximum);
#if defined(MSG_NOSIGNAL)
        constexpr int send_flags = MSG_NOSIGNAL;
#else
        constexpr int send_flags = 0;
#endif
        const ssize_t sent = ::send(fd_, frame.data + offset, amount, send_flags);
        if (sent > 0) {
            offset += static_cast<std::size_t>(sent);
            if (offset < frame.size && deadline_expired(deadline)) {
                return Result<void>::failure(Error::TIMEOUT);
            }
            continue;
        }
        if (sent == 0) {
            return Result<void>::failure(Error::DISCONNECTED);
        }
        const int error = errno;
        if (error == EINTR) {
            if (deadline_expired(deadline)) {
                return Result<void>::failure(Error::TIMEOUT);
            }
            continue;
        }
        if (error != EAGAIN && error != EWOULDBLOCK) {
            return Result<void>::failure(map_errno(error));
        }
        const auto ready = wait_fd(fd_, POLLOUT, deadline);
        if (!ready) {
            return ready;
        }
    }
    return Result<void>::success();
}

SocketListener::~SocketListener() noexcept
{
    close();
}

SocketListener::SocketListener(SocketListener&& other) noexcept
{
    move_from(other);
}

SocketListener& SocketListener::operator=(SocketListener&& other) noexcept
{
    if (this != &other) {
        close();
        move_from(other);
    }
    return *this;
}

void SocketListener::move_from(SocketListener& other) noexcept
{
    fd_ = other.fd_;
    product_directory_ = other.product_directory_;
    instance_directory_ = other.instance_directory_;
    endpoint_path_ = other.endpoint_path_;
    product_identity_ = other.product_identity_;
    instance_identity_ = other.instance_identity_;
    endpoint_identity_ = other.endpoint_identity_;
    directory_mode_ = other.directory_mode_;
    socket_mode_ = other.socket_mode_;
    created_product_directory_ = other.created_product_directory_;
    created_instance_directory_ = other.created_instance_directory_;
    created_endpoint_ = other.created_endpoint_;

    other.fd_ = -1;
    other.created_product_directory_ = false;
    other.created_instance_directory_ = false;
    other.created_endpoint_ = false;
}

Result<SocketListener> SocketListener::listen(const EndpointConfig& config,
                                              int backlog) noexcept
{
    if (backlog <= 0) {
        return Result<SocketListener>::failure(Error::INVALID_ARGUMENT);
    }
    const auto layout_result = make_layout(config);
    if (!layout_result) {
        return Result<SocketListener>::failure(layout_result.error());
    }
    const Layout& layout = layout_result.value();

    SocketListener listener;
    listener.product_directory_ = layout.product_directory;
    listener.instance_directory_ = layout.instance_directory;
    listener.endpoint_path_ = layout.endpoint_path;
    listener.directory_mode_ = static_cast<std::uint16_t>(layout.directory_mode);
    listener.socket_mode_ = static_cast<std::uint16_t>(layout.socket_mode);

    // XDG_RUNTIME_DIR (or the explicit replacement) is supplied by the caller
    // and must already be a safe directory. The adapter owns only descendants.
    const auto runtime_check = validate_directory(layout.runtime_directory.data(),
                                                  layout.directory_mode);
    if (!runtime_check) {
        return Result<SocketListener>::failure(runtime_check.error());
    }

    bool created = false;
    const auto product = ensure_directory(listener.product_directory_.data(),
                                          layout.directory_mode, created);
    listener.created_product_directory_ = created;
    if (!product) {
        return Result<SocketListener>::failure(product.error());
    }
    listener.product_identity_ = FileIdentity{
        product.value().device, product.value().inode, true};

    const auto instance = ensure_directory(listener.instance_directory_.data(),
                                           layout.directory_mode, created);
    listener.created_instance_directory_ = created;
    if (!instance) {
        return Result<SocketListener>::failure(instance.error());
    }
    listener.instance_identity_ = FileIdentity{
        instance.value().device, instance.value().inode, true};

    const auto stale = remove_stale_socket(listener.endpoint_path_.data(),
                                           layout.socket_mode);
    if (!stale) {
        return Result<SocketListener>::failure(stale.error());
    }

    listener.fd_ = ::socket(AF_UNIX, SOCK_STREAM, 0);
    if (listener.fd_ < 0) {
        return Result<SocketListener>::failure(map_errno(errno));
    }
    const auto configured = configure_socket_fd(listener.fd_);
    if (!configured) {
        return Result<SocketListener>::failure(configured.error());
    }

    sockaddr_un address{};
    const socklen_t address_length = make_address(listener.endpoint_path_.data(), address);
    if (::bind(listener.fd_, reinterpret_cast<const sockaddr*>(&address),
               address_length) != 0) {
        return Result<SocketListener>::failure(map_errno(errno));
    }
    struct stat endpoint_status {};
    if (::lstat(listener.endpoint_path_.data(), &endpoint_status) != 0 ||
        !S_ISSOCK(endpoint_status.st_mode) ||
        endpoint_status.st_uid != ::geteuid()) {
        return Result<SocketListener>::failure(Error::INTERNAL);
    }
    listener.endpoint_identity_ = FileIdentity{
        static_cast<std::uint64_t>(endpoint_status.st_dev),
        static_cast<std::uint64_t>(endpoint_status.st_ino), true};
    listener.created_endpoint_ = true;

    if (::chmod(listener.endpoint_path_.data(), layout.socket_mode) != 0) {
        return Result<SocketListener>::failure(map_errno(errno));
    }
    const auto endpoint = validate_socket_path(listener.endpoint_path_.data(),
                                               layout.socket_mode);
    if (!endpoint || endpoint.value().device != listener.endpoint_identity_.device ||
        endpoint.value().inode != listener.endpoint_identity_.inode) {
        return Result<SocketListener>::failure(
            endpoint ? Error::BUSY : endpoint.error());
    }
    if (::listen(listener.fd_, backlog) != 0) {
        return Result<SocketListener>::failure(map_errno(errno));
    }
    return Result<SocketListener>::success(std::move(listener));
}

Result<SocketStream> SocketListener::accept(Timeout timeout) noexcept
{
    if (!valid()) {
        return Result<SocketStream>::failure(Error::INVALID_ARGUMENT);
    }
    const Deadline deadline = deadline_after(timeout);
    while (true) {
        const int accepted = ::accept(fd_, nullptr, nullptr);
        if (accepted >= 0) {
            const auto configured = configure_socket_fd(accepted);
            if (!configured) {
                close_fd(accepted);
                return Result<SocketStream>::failure(configured.error());
            }
            return Result<SocketStream>::success(SocketStream(accepted));
        }
        const int error = errno;
        if (error == EINTR) {
            if (deadline_expired(deadline)) {
                return Result<SocketStream>::failure(Error::TIMEOUT);
            }
            continue;
        }
        if (error != EAGAIN && error != EWOULDBLOCK) {
            return Result<SocketStream>::failure(map_errno(error));
        }
        const auto ready = wait_fd(fd_, POLLIN, deadline);
        if (!ready) {
            return Result<SocketStream>::failure(ready.error());
        }
    }
}

void SocketListener::cleanup_paths() noexcept
{
    const mode_t directory_mode = static_cast<mode_t>(directory_mode_);
    const mode_t socket_mode = static_cast<mode_t>(socket_mode_);
    if (created_endpoint_ && endpoint_identity_.valid) {
        remove_owned_socket(endpoint_path_.data(),
                            NativeIdentity{endpoint_identity_.device,
                                           endpoint_identity_.inode},
                            socket_mode);
    }
    if (created_instance_directory_ && instance_identity_.valid) {
        remove_owned_directory(instance_directory_.data(),
                               NativeIdentity{instance_identity_.device,
                                              instance_identity_.inode},
                               directory_mode);
    }
    if (created_product_directory_ && product_identity_.valid) {
        remove_owned_directory(product_directory_.data(),
                               NativeIdentity{product_identity_.device,
                                              product_identity_.inode},
                               directory_mode);
    }
    created_endpoint_ = false;
    created_instance_directory_ = false;
    created_product_directory_ = false;
}

void SocketListener::close() noexcept
{
    const int fd = fd_;
    fd_ = -1;
    close_fd(fd);
    cleanup_paths();
}

}  // namespace px4::userland::ipc::posix
