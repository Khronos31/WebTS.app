// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_POSIX_TUNER_NONCE_H
#define PX4_USERLAND_POSIX_TUNER_NONCE_H

#include "px4/tuner_service.h"

#include <array>
#include <cstdint>

namespace px4::userland::ipc::posix {

class PosixTunerNonceSource final : public TunerNonceSource {
public:
    PosixTunerNonceSource() noexcept = default;

    Result<std::array<std::uint8_t, ipc::kNonceLength>> generate() noexcept override;
};

}  // namespace px4::userland::ipc::posix

#endif  // PX4_USERLAND_POSIX_TUNER_NONCE_H
