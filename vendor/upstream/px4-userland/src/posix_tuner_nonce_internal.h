// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_POSIX_TUNER_NONCE_INTERNAL_H
#define PX4_USERLAND_POSIX_TUNER_NONCE_INTERNAL_H

#include "px4/posix_tuner_nonce.h"

#include <cstddef>
#include <cstdint>

namespace px4::userland::ipc::posix {

struct EntropyReadResult final {
    std::size_t bytes = 0U;
    bool interrupted = false;
};

// Private I/O seam used by offline tests. It is deliberately absent from the
// installed header so production callers cannot inject entropy transport.
class TunerNonceIo {
public:
    virtual ~TunerNonceIo() noexcept = default;
    virtual Result<int> open_urandom() noexcept = 0;
    virtual Result<EntropyReadResult> read_entropy(
        int descriptor, std::uint8_t* output, std::size_t size) noexcept = 0;
    virtual Result<void> close_entropy(int descriptor) noexcept = 0;
};

class PosixTunerNonceIo final : public TunerNonceIo {
public:
    Result<int> open_urandom() noexcept override;
    Result<EntropyReadResult> read_entropy(
        int descriptor, std::uint8_t* output, std::size_t size) noexcept override;
    Result<void> close_entropy(int descriptor) noexcept override;
};

Result<std::array<std::uint8_t, ipc::kNonceLength>> generate_tuner_nonce(
    TunerNonceIo& io) noexcept;

}  // namespace px4::userland::ipc::posix

#endif  // PX4_USERLAND_POSIX_TUNER_NONCE_INTERNAL_H
