// Modified/ported for px4-userland on 2026-09-02.
//
// Copyright (c) 2018-2021 nns779
// Derived from tsukumijima/px4_drv commit 9eedea8c502875a788697984b93b50032339b9aa.
// Origin paths: driver/i2c_comm.h, driver/it930x.c, driver/tc90522.c.
// Source snapshot maintained by tsukumijima.
// SPDX-License-Identifier: GPL-2.0-only

#include "bridge_i2c.h"

#include <cstring>
#include <algorithm>
#include <mutex>
#include <utility>

namespace px4::userland {
namespace {

constexpr std::uint8_t kQ3U4I2cBus = 2U;

Result<void> validate_request(const BridgeI2cRequest& request) noexcept
{
    if (request.address > 0x7fU) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    switch (request.type) {
    case BridgeI2cRequestType::read:
        if (request.read_data.size == 0U || request.read_data.data == nullptr) {
            return Result<void>::failure(Error::INVALID_ARGUMENT);
        }
        return Result<void>::success();
    case BridgeI2cRequestType::write:
        if (request.write_data.size == 0U || request.write_data.data == nullptr) {
            return Result<void>::failure(Error::INVALID_ARGUMENT);
        }
        return Result<void>::success();
    case BridgeI2cRequestType::undefined:
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    return Result<void>::failure(Error::INVALID_ARGUMENT);
}

}  // namespace

void capture_failure(BridgeI2cFailureDetail& detail, std::size_t index,
                     const BridgeI2cRequest& request) noexcept
{
    detail.valid = true;
    detail.request_index = index;
    detail.type = request.type;
    detail.address = request.address;
    detail.write_length = request.write_data.size;
    detail.read_length = request.read_data.size;
    detail.captured_byte_count = 0U;
    if (request.write_data.data != nullptr) {
        detail.captured_byte_count = std::min(request.write_data.size,
                                              detail.write_data.size());
        std::memcpy(detail.write_data.data(), request.write_data.data,
                    detail.captured_byte_count);
    }
}

Result<void> It930xBridgeI2cMaster::request(BridgeI2cRequest* requests,
                                            std::size_t count) noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    failure_detail_ = BridgeI2cFailureDetail{};
    if (requests == nullptr || count == 0U) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }

    // The lock deliberately covers validation, every bridge command, and every
    // response copy.  A TC90522 read is therefore never interleaved with another
    // frontend's repeater select or demod access.
    for (std::size_t index = 0U; index < count; ++index) {
        const auto valid = validate_request(requests[index]);
        if (!valid) {
            return valid;
        }
    }
    for (std::size_t index = 0U; index < count; ++index) {

        BridgeI2cRequest& request = requests[index];
        if (request.type == BridgeI2cRequestType::write) {
            const auto result = controller_.i2c_write(
                kQ3U4I2cBus, request.address, request.write_data);
            if (!result) {
                capture_failure(failure_detail_, index, request);
                return result;
            }
            continue;
        }

        const auto result = controller_.i2c_read(
            kQ3U4I2cBus, request.address, request.read_data.size);
        if (!result) {
            capture_failure(failure_detail_, index, request);
            return Result<void>::failure(result.error());
        }
        if (result.value().size() != request.read_data.size) {
            capture_failure(failure_detail_, index, request);
            return Result<void>::failure(Error::PROTOCOL_ERROR);
        }
        std::memcpy(request.read_data.data, result.value().data(),
                    request.read_data.size);
    }
    return Result<void>::success();
}

BridgeI2cFailureDetail It930xBridgeI2cMaster::failure_detail() const noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    return failure_detail_;
}

}  // namespace px4::userland
