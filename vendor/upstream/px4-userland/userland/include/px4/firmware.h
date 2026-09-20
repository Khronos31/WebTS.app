// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_FIRMWARE_H
#define PX4_USERLAND_FIRMWARE_H

#include "px4/transport.h"

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace px4::userland {

inline constexpr std::size_t kIt930xFirmwareSize = 2169U;
inline constexpr std::array<std::uint8_t, 32U> kIt930xFirmwareSha256{
    0x52U, 0x13U, 0xa5U, 0xa3U, 0x88U, 0x72U, 0x66U, 0x12U,
    0x77U, 0xa2U, 0xccU, 0x1bU, 0x2dU, 0xfdU, 0xfeU, 0x88U,
    0xfaU, 0xf0U, 0x6fU, 0x41U, 0x20U, 0x5fU, 0x46U, 0x0fU,
    0x3bU, 0x51U, 0x85U, 0x7fU, 0x05U, 0x68U, 0xb4U, 0x84U};

class FirmwareTestAccess;

class FirmwareImage final {
public:
    ByteView bytes() const noexcept { return ByteView{data_.data(), data_.size()}; }
    const std::uint8_t* data() const noexcept { return data_.data(); }
    std::size_t size() const noexcept { return data_.size(); }

private:
    FirmwareImage() noexcept = default;
    explicit FirmwareImage(std::vector<std::uint8_t>&& data) noexcept
        : data_(std::move(data))
    {
    }

    static bool accepted_policy(std::size_t size,
                                const std::array<std::uint8_t, 32U>& digest) noexcept;

    friend class FirmwareProvider;
    friend class FirmwareTestAccess;
    template <typename T>
    friend class Result;

    std::vector<std::uint8_t> data_;
};

class FirmwareProvider final {
public:
    explicit FirmwareProvider(std::string_view path) noexcept : path_(path) {}
    ~FirmwareProvider() noexcept = default;

    FirmwareProvider(const FirmwareProvider&) = default;
    FirmwareProvider& operator=(const FirmwareProvider&) = default;
    FirmwareProvider(FirmwareProvider&&) noexcept = default;
    FirmwareProvider& operator=(FirmwareProvider&&) noexcept = default;

    Result<FirmwareImage> load() const noexcept;
    std::string_view path() const noexcept { return path_; }

private:
    std::string path_;
};

}  // namespace px4::userland

#endif  // PX4_USERLAND_FIRMWARE_H
