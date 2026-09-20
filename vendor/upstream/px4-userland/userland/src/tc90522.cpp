// Modified/ported for px4-userland on 2026-09-02.
//
// Copyright (c) 2018-2021 nns779
// Derived from tsukumijima/px4_drv commit 9eedea8c502875a788697984b93b50032339b9aa.
// Origin paths: driver/tc90522.c, driver/tc90522.h, driver/i2c_comm.h.
// Source snapshot maintained by tsukumijima.
// SPDX-License-Identifier: GPL-2.0-only

#include "tc90522.h"

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <initializer_list>
#include <limits>
#include <utility>

namespace px4::userland {
namespace {

constexpr std::uint8_t kRepeaterRegister = 0xfeU;
constexpr std::size_t kLegacyReadMax = 255U;
constexpr std::size_t kLegacyWriteMax = 254U;
constexpr std::size_t kDownstreamWriteMax = 253U;

Result<void> validate_demod_read(std::uint8_t reg, MutableByteView data) noexcept
{
    (void)reg;
    if (data.data == nullptr || data.size == 0U || data.size > kLegacyReadMax) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    return Result<void>::success();
}

Result<void> validate_demod_write(std::uint8_t reg, ByteView data) noexcept
{
    (void)reg;
    if (data.data == nullptr || data.size == 0U || data.size > kLegacyWriteMax) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    return Result<void>::success();
}

Result<void> write_values(
    Tc90522& demod,
    std::initializer_list<std::pair<std::uint8_t, std::uint8_t>> values) noexcept
{
    std::vector<Tc90522RegisterWrite> registers;
    registers.reserve(values.size());
    std::vector<std::array<std::uint8_t, 1U>> bytes;
    bytes.reserve(values.size());
    for (const auto& value : values) {
        bytes.push_back(std::array<std::uint8_t, 1U>{value.second});
        registers.push_back(Tc90522RegisterWrite{
            value.first, ByteView{bytes.back().data(), bytes.back().size()}});
    }
    return demod.write_multiple_regs(registers);
}

Result<std::uint16_t> decode_u16(const std::vector<std::uint8_t>& bytes) noexcept
{
    if (bytes.size() != 2U) {
        return Result<std::uint16_t>::failure(Error::PROTOCOL_ERROR);
    }
    return Result<std::uint16_t>::success(
        static_cast<std::uint16_t>((static_cast<std::uint16_t>(bytes[0]) << 8U) |
                                    static_cast<std::uint16_t>(bytes[1])));
}

Result<std::uint32_t> decode_u24(const std::vector<std::uint8_t>& bytes) noexcept
{
    if (bytes.size() != 3U) {
        return Result<std::uint32_t>::failure(Error::PROTOCOL_ERROR);
    }
    return Result<std::uint32_t>::success(
        (static_cast<std::uint32_t>(bytes[0]) << 16U) |
        (static_cast<std::uint32_t>(bytes[1]) << 8U) |
        static_cast<std::uint32_t>(bytes[2]));
}

}  // namespace

Result<std::vector<std::uint8_t>> Tc90522::read_regs_unlocked(
    std::uint8_t reg, std::size_t length) noexcept
{
    std::vector<std::uint8_t> result(length);
    const auto valid = validate_demod_read(
        reg, MutableByteView{result.data(), result.size()});
    if (!valid) {
        return Result<std::vector<std::uint8_t>>::failure(valid.error());
    }

    std::array<std::uint8_t, 1U> pointer{reg};
    std::array<BridgeI2cRequest, 2U> requests{
        BridgeI2cRequest{BridgeI2cRequestType::write,
                         mapping_.demod_address,
                         ByteView{pointer.data(), pointer.size()},
                         MutableByteView{nullptr, 0U}},
        BridgeI2cRequest{BridgeI2cRequestType::read,
                         mapping_.demod_address,
                         ByteView{nullptr, 0U},
                         MutableByteView{result.data(), result.size()}}};
    const auto submitted = bridge_.request(requests.data(), requests.size());
    if (!submitted) {
        return Result<std::vector<std::uint8_t>>::failure(submitted.error());
    }
    return Result<std::vector<std::uint8_t>>::success(std::move(result));
}

Result<std::vector<std::uint8_t>> Tc90522::read_regs(
    std::uint8_t reg, std::size_t length) noexcept
{
    if (length == 0U || length > kLegacyReadMax) {
        return Result<std::vector<std::uint8_t>>::failure(Error::INVALID_ARGUMENT);
    }
    return read_regs_unlocked(reg, length);
}

Result<void> Tc90522::read_multiple_regs(
    std::vector<Tc90522RegisterRead>& registers) noexcept
{
    if (registers.empty()) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }

    std::vector<std::array<std::uint8_t, 1U>> pointers;
    pointers.reserve(registers.size());
    std::vector<BridgeI2cRequest> requests;
    requests.reserve(registers.size() * 2U);
    for (const auto& register_read : registers) {
        const auto valid = validate_demod_read(register_read.reg, register_read.data);
        if (!valid) {
            return valid;
        }
        pointers.push_back(std::array<std::uint8_t, 1U>{register_read.reg});
        requests.push_back(BridgeI2cRequest{
            BridgeI2cRequestType::write, mapping_.demod_address,
            ByteView{pointers.back().data(), pointers.back().size()},
            MutableByteView{nullptr, 0U}});
        requests.push_back(BridgeI2cRequest{
            BridgeI2cRequestType::read, mapping_.demod_address,
            ByteView{nullptr, 0U}, register_read.data});
    }
    return bridge_.request(requests.data(), requests.size());
}

Result<void> Tc90522::write_regs(std::uint8_t reg, ByteView values) noexcept
{
    const auto valid = validate_demod_write(reg, values);
    if (!valid) {
        return valid;
    }
    if (values.size > std::numeric_limits<std::uint8_t>::max()) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }

    std::array<std::uint8_t, kLegacyWriteMax + 1U> request_data{};
    request_data[0] = reg;
    std::copy(values.data, values.data + values.size, request_data.begin() + 1U);
    BridgeI2cRequest request{
        BridgeI2cRequestType::write, mapping_.demod_address,
        ByteView{request_data.data(), values.size + 1U},
        MutableByteView{nullptr, 0U}};
    return bridge_.request(&request, 1U);
}

Result<void> Tc90522::write_reg(std::uint8_t reg, std::uint8_t value) noexcept
{
    const std::array<std::uint8_t, 1U> data{value};
    return write_regs(reg, ByteView{data.data(), data.size()});
}

Result<void> Tc90522::write_multiple_regs(
    const std::vector<Tc90522RegisterWrite>& registers) noexcept
{
    if (registers.empty()) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }

    std::vector<std::array<std::uint8_t, kLegacyWriteMax + 1U>> storage;
    storage.resize(registers.size());
    std::vector<BridgeI2cRequest> requests;
    requests.reserve(registers.size());
    for (std::size_t index = 0U; index < registers.size(); ++index) {
        const auto& register_write = registers[index];
        const auto valid = validate_demod_write(register_write.reg,
                                                 register_write.data);
        if (!valid) {
            return valid;
        }
        storage[index][0] = register_write.reg;
        std::copy(register_write.data.data,
                  register_write.data.data + register_write.data.size,
                  storage[index].begin() + 1U);
        requests.push_back(BridgeI2cRequest{
            BridgeI2cRequestType::write, mapping_.demod_address,
            ByteView{storage[index].data(), register_write.data.size + 1U},
            MutableByteView{nullptr, 0U}});
    }
    return bridge_.request(requests.data(), requests.size());
}

Result<void> Tc90522::downstream_request(Tc90522I2cRequest* requests,
                                          std::size_t count) noexcept
{
    if (requests == nullptr || count == 0U || count > (std::numeric_limits<std::size_t>::max() / 2U)) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }

    const std::size_t converted_count = count * 2U;
    std::vector<std::array<std::uint8_t, kDownstreamWriteMax + 2U>> write_storage;
    write_storage.resize(converted_count);
    std::vector<BridgeI2cRequest> converted;
    converted.reserve(converted_count);

    // These branches intentionally retain the two legacy fast paths: one write
    // becomes one upstream write, and write+read becomes upstream write/write/read.
    // The general path below has the same translation for every other sequence.
    for (std::size_t index = 0U; index < count; ++index) {
        const auto& request = requests[index];
        if (request.address > 0x7fU) {
            return Result<void>::failure(Error::INVALID_ARGUMENT);
        }
        if (request.type == Tc90522RequestType::write) {
            if (request.write_data.data == nullptr || request.write_data.size == 0U ||
                request.write_data.size > kDownstreamWriteMax) {
                return Result<void>::failure(Error::INVALID_ARGUMENT);
            }
            const std::size_t output = converted.size();
            write_storage[output][0] = kRepeaterRegister;
            write_storage[output][1] = static_cast<std::uint8_t>(request.address << 1U);
            std::copy(request.write_data.data,
                      request.write_data.data + request.write_data.size,
                      write_storage[output].begin() + 2U);
            converted.push_back(BridgeI2cRequest{
                BridgeI2cRequestType::write, mapping_.demod_address,
                ByteView{write_storage[output].data(), request.write_data.size + 2U},
                MutableByteView{nullptr, 0U}});
        } else if (request.type == Tc90522RequestType::read) {
            if (request.read_data.data == nullptr || request.read_data.size == 0U ||
                request.read_data.size > kLegacyReadMax) {
                return Result<void>::failure(Error::INVALID_ARGUMENT);
            }
            const std::size_t output = converted.size();
            write_storage[output][0] = kRepeaterRegister;
            write_storage[output][1] = static_cast<std::uint8_t>((request.address << 1U) | 1U);
            converted.push_back(BridgeI2cRequest{
                BridgeI2cRequestType::write, mapping_.demod_address,
                ByteView{write_storage[output].data(), 2U},
                MutableByteView{nullptr, 0U}});
            converted.push_back(BridgeI2cRequest{
                BridgeI2cRequestType::read, mapping_.demod_address,
                ByteView{nullptr, 0U}, request.read_data});
        } else {
            return Result<void>::failure(Error::INVALID_ARGUMENT);
        }
    }
    return bridge_.request(converted.data(), converted.size());
}

Result<void> Tc90522::sleep_s(bool sleep) noexcept
{
    return write_values(*this, {{0x13U, sleep ? 0x80U : 0x00U},
                                {0x17U, sleep ? 0xffU : 0x00U}});
}

Result<void> Tc90522::set_agc_s(bool on) noexcept
{
    const std::uint8_t mixer = static_cast<std::uint8_t>(
        (mapping_.secondary ? 0x30U : 0xb0U) | (on ? 0x02U : 0x00U));
    return write_values(*this, {{0x0aU, on ? 0xffU : 0x00U},
                                {0x10U, mixer},
                                {0x11U, on ? 0x00U : 0x02U},
                                {0x03U, 0x01U}});
}

Result<std::uint16_t> Tc90522::tmcc_get_tsid_s(std::uint8_t index) noexcept
{
    if (index >= 12U) {
        return Result<std::uint16_t>::failure(Error::INVALID_ARGUMENT);
    }
    const auto bytes = read_regs(static_cast<std::uint8_t>(0xceU + index * 2U), 2U);
    if (!bytes) {
        return Result<std::uint16_t>::failure(bytes.error());
    }
    return decode_u16(bytes.value());
}

Result<std::uint16_t> Tc90522::get_tsid_s() noexcept
{
    const auto bytes = read_regs(0xe6U, 2U);
    if (!bytes) {
        return Result<std::uint16_t>::failure(bytes.error());
    }
    return decode_u16(bytes.value());
}

Result<void> Tc90522::set_tsid_s(std::uint16_t tsid) noexcept
{
    const std::array<std::uint8_t, 2U> bytes{
        static_cast<std::uint8_t>(tsid >> 8U), static_cast<std::uint8_t>(tsid)};
    return write_regs(0x8fU, ByteView{bytes.data(), bytes.size()});
}

Result<std::uint16_t> Tc90522::get_cn_s() noexcept
{
    const auto bytes = read_regs(0xbcU, 2U);
    if (!bytes) {
        return Result<std::uint16_t>::failure(bytes.error());
    }
    return decode_u16(bytes.value());
}

Result<void> Tc90522::enable_ts_pins_s(bool enable) noexcept
{
    return write_values(*this, {{0x1cU, enable ? 0x00U : 0x80U},
                                {0x1fU, enable ? 0x00U : 0x22U}});
}

Result<bool> Tc90522::is_signal_locked_s() noexcept
{
    const auto bytes = read_regs(0xc3U, 1U);
    if (!bytes) {
        return Result<bool>::failure(bytes.error());
    }
    return Result<bool>::success((bytes.value()[0] & 0x10U) == 0U);
}

Result<void> Tc90522::sleep_t(bool sleep) noexcept
{
    return write_reg(0x03U, sleep ? 0xf0U : 0x00U);
}

Result<void> Tc90522::set_agc_t(bool on) noexcept
{
    return write_values(*this, {{0x25U, 0x00U},
                                {0x20U, 0x00U},
                                {0x23U, on ? 0x4cU : 0x4dU},
                                {0x01U, 0x50U}});
}

Result<std::uint32_t> Tc90522::get_cndat_t() noexcept
{
    const auto bytes = read_regs(0x8bU, 3U);
    if (!bytes) {
        return Result<std::uint32_t>::failure(bytes.error());
    }
    return decode_u24(bytes.value());
}

Result<void> Tc90522::enable_ts_pins_t(bool enable) noexcept
{
    return write_reg(0x1dU, enable ? 0x00U : 0xa8U);
}

Result<bool> Tc90522::is_signal_locked_t() noexcept
{
    // The kernel function returned success even when either read failed, which
    // made an I2C failure indistinguishable from an unlocked receiver.  Result
    // preserves the false lock value while exposing that transport failure.
    const auto status = read_regs(0x80U, 1U);
    if (!status) {
        return Result<bool>::failure(status.error());
    }
    if ((status.value()[0] & 0x28U) != 0U) {
        return Result<bool>::success(false);
    }
    const auto quality = read_regs(0xb0U, 1U);
    if (!quality) {
        return Result<bool>::failure(quality.error());
    }
    return Result<bool>::success((quality.value()[0] & 0x0fU) >= 8U);
}

Result<Q3U4ReceiverMapping> q3u4_receiver_mapping(
    std::uint8_t local_receiver) noexcept
{
    if (local_receiver >= 4U) {
        return Result<Q3U4ReceiverMapping>::failure(Error::INVALID_ARGUMENT);
    }
    constexpr std::array<std::uint8_t, 4U> addresses{0x11U, 0x13U, 0x10U, 0x12U};
    return Result<Q3U4ReceiverMapping>::success(Q3U4ReceiverMapping{
        local_receiver, addresses[local_receiver],
        (local_receiver & 1U) != 0U,
        local_receiver < 2U ? Tc90522System::isdb_s : Tc90522System::isdb_t});
}

}  // namespace px4::userland
