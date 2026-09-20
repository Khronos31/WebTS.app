// SPDX-License-Identifier: GPL-2.0-only
#include "posix_tuner_nonce_internal.h"

#include <cerrno>
#include <fcntl.h>
#include <unistd.h>

namespace px4::userland::ipc::posix {

Result<int> PosixTunerNonceIo::open_urandom() noexcept
{
    const int descriptor = ::open("/dev/urandom", O_RDONLY | O_CLOEXEC);
    if (descriptor < 0) return Result<int>::failure(Error::INTERNAL);
    return Result<int>::success(descriptor);
}

Result<EntropyReadResult> PosixTunerNonceIo::read_entropy(
    int descriptor, std::uint8_t* output, std::size_t size) noexcept
{
    if (descriptor < 0 || output == nullptr || size == 0U) {
        return Result<EntropyReadResult>::failure(Error::INVALID_ARGUMENT);
    }
    const ssize_t result = ::read(descriptor, output, size);
    if (result < 0) {
        if (errno == EINTR) {
            return Result<EntropyReadResult>::success(EntropyReadResult{0U, true});
        }
        return Result<EntropyReadResult>::failure(Error::INTERNAL);
    }
    return Result<EntropyReadResult>::success(
        EntropyReadResult{static_cast<std::size_t>(result), false});
}

Result<void> PosixTunerNonceIo::close_entropy(int descriptor) noexcept
{
    if (descriptor < 0 || ::close(descriptor) != 0) {
        return Result<void>::failure(Error::INTERNAL);
    }
    return Result<void>::success();
}

Result<std::array<std::uint8_t, ipc::kNonceLength>> generate_tuner_nonce(
    TunerNonceIo& io) noexcept
{
    std::array<std::uint8_t, ipc::kNonceLength> nonce{};
    const auto opened = io.open_urandom();
    if (!opened) return Result<decltype(nonce)>::failure(opened.error());

    const int descriptor = opened.value();
    std::size_t offset = 0U;
    Error read_error = Error::OK;
    while (offset < nonce.size()) {
        const auto read = io.read_entropy(
            descriptor, nonce.data() + offset, nonce.size() - offset);
        if (!read) {
            read_error = read.error();
            break;
        }
        if (read.value().interrupted) continue;
        if (read.value().bytes == 0U ||
            read.value().bytes > nonce.size() - offset) {
            read_error = Error::INTERNAL;
            break;
        }
        offset += read.value().bytes;
    }

    const auto closed = io.close_entropy(descriptor);
    if (read_error != Error::OK) return Result<decltype(nonce)>::failure(read_error);
    if (!closed) return Result<decltype(nonce)>::failure(closed.error());
    return Result<decltype(nonce)>::success(nonce);
}

Result<std::array<std::uint8_t, ipc::kNonceLength>> PosixTunerNonceSource::generate() noexcept
{
    PosixTunerNonceIo io;
    return generate_tuner_nonce(io);
}

}  // namespace px4::userland::ipc::posix
