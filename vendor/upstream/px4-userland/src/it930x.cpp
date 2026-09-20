// Modified/ported for px4-userland on 2026-09-03.
//
// Copyright (c) 2018-2021 nns779
// Derived from tsukumijima/px4_drv commit 9eedea8c502875a788697984b93b50032339b9aa.
// Origin paths: driver/it930x.c, driver/it930x.h, driver/itedtv_bus.c,
// driver/px4_device.c, winusb/src/DriverHost_PX4/px4_device.cpp.
// Source snapshot maintained by tsukumijima.
// SPDX-License-Identifier: GPL-2.0-only
#include "px4/it930x.h"

#include "it930x_protocol.h"
#include "q3u4_power.h"

#include <array>
#include <algorithm>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <mutex>
#include <thread>
#include <utility>
#include <vector>

namespace px4::userland {

namespace {

constexpr std::size_t kFrameOverhead = 6U;
constexpr std::size_t kResponseOverhead = 5U;
constexpr std::size_t kMaxCommandPayload = 250U;
constexpr std::size_t kMaxResponsePayload = 251U;
constexpr Timeout kCommandTimeout{3000U};
constexpr std::uint16_t kRegRead = 0x00U;
constexpr std::uint16_t kRegWrite = 0x01U;
constexpr std::uint16_t kQueryInfo = 0x22U;
constexpr std::uint16_t kBoot = 0x23U;
constexpr std::uint16_t kFirmwareScatterWrite = 0x29U;
constexpr std::uint16_t kI2cRead = 0x2aU;
constexpr std::uint16_t kI2cWrite = 0x2bU;
constexpr std::uint16_t kUartRead = 0x33U;
constexpr std::uint16_t kUartWrite = 0x34U;
constexpr std::uint16_t kUartSetBaudRate = 0x35U;
constexpr std::uint16_t kUartSetMode = 0x37U;
constexpr std::uint32_t kUartRealSend = 0x4965U;
constexpr std::uint32_t kUartRxReady = 0x496aU;
constexpr std::uint32_t kUartRxLength = 0x496bU;
constexpr std::size_t kCardFrameMaxLength = 255U;
constexpr std::size_t kCardReadChunkMaxLength = 32U;
constexpr std::size_t kCardWriteChunkMaxLength = 48U;
constexpr std::size_t kQ3U4TransferSize = 188U * 816U;
constexpr std::size_t kPsbPurgeTransferSize = 1024U;
constexpr std::size_t kPsbPartialTimeoutTransferSize = 512U;
constexpr std::size_t kQ3U4MaxBulkPacket = 512U;
constexpr std::uint16_t kQ3U4TransferThreshold =
    static_cast<std::uint16_t>(kQ3U4TransferSize / 4U);
constexpr std::uint8_t kQ3U4MaxBulkPacketRegister =
    static_cast<std::uint8_t>(kQ3U4MaxBulkPacket / 4U);

static_assert(kQ3U4TransferThreshold == 0x95d0U);
static_assert(kQ3U4MaxBulkPacketRegister == 0x80U);

enum Q3U4Register : std::uint32_t {
    eeprom_control = 0x4976U,
    eeprom_status = 0x4bfbU,
    eeprom_command = 0x4978U,
    eeprom_address = 0x4977U,
    ignore_sync = 0xda1aU,
    dvbt_interrupt = 0xf41fU,
    mpeg_full_speed = 0xda10U,
    dvbt_mode = 0xf41aU,
    stream_gate = 0xda1dU,
    endpoint4_enable = 0xdd11U,
    endpoint4_nak = 0xdd13U,
    transfer_threshold = 0xdd88U,
    max_bulk_packet = 0xdd0cU,
    stream_output_a = 0xda05U,
    stream_output_b = 0xda06U,
    stream_reverse = 0xd920U,
    power_control_a = 0xd833U,
    power_control_b = 0xd830U,
    power_control_c = 0xd831U,
    power_control_d = 0xd832U,
    i2c_speed_aux = 0xf6a7U,
    i2c_speed = 0xf103U,
    i2c_addr_slave0 = 0x4975U,
    i2c_bus_slave0 = 0x4971U,
    i2c_addr_slave1 = 0x4974U,
    i2c_bus_slave1 = 0x4970U,
    i2c_addr_slave2 = 0x4973U,
    i2c_bus_slave2 = 0x496fU,
    i2c_addr_slave3 = 0x4972U,
    i2c_bus_slave3 = 0x496eU,
    stream_disable_port0 = 0xda4cU,
    stream_serial_port1 = 0xda59U,
    stream_aggregate_port1 = 0xda74U,
    stream_aggregate_port2 = 0xda75U,
    stream_aggregate_port3 = 0xda76U,
    stream_aggregate_port4 = 0xda77U,
    stream_sync_port1 = 0xda79U,
    stream_sync_port2 = 0xda7aU,
    stream_sync_port3 = 0xda7bU,
    stream_sync_port4 = 0xda7cU,
    stream_enable_port1 = 0xda4dU,
    stream_enable_port2 = 0xda4eU,
    stream_enable_port3 = 0xda4fU,
    stream_enable_port4 = 0xda50U,
    gpio7_mode = 0xd8c4U,
    gpio7_enable = 0xd8c5U,
    gpio7_output = 0xd8c3U,
    gpio2_mode = 0xd8b8U,
    gpio2_enable = 0xd8b9U,
    gpio2_output = 0xd8b7U,
    gpio11_mode = 0xd8d4U,
    gpio11_enable = 0xd8d5U,
    gpio11_output = 0xd8d3U,
    gpio6_mode = 0xd8c8U,
    gpio6_enable = 0xd8c9U,
    gpio6_input = 0xd8c6U,
    gpio14_mode = 0xd8e4U,
    gpio14_enable = 0xd8e5U,
    gpio14_output = 0xd8e3U,
};

std::uint8_t register_length(std::uint32_t reg) noexcept
{
    if ((reg & 0xff000000U) != 0U) {
        return 4U;
    }
    if ((reg & 0x00ff0000U) != 0U) {
        return 3U;
    }
    if ((reg & 0x0000ff00U) != 0U) {
        return 2U;
    }
    return 1U;
}

std::uint16_t checksum(const std::uint8_t* data, std::size_t size) noexcept
{
    std::uint16_t sum = 0U;
    std::size_t index = 0U;
    while (index + 1U < size) {
        sum = static_cast<std::uint16_t>(
            sum + static_cast<std::uint16_t>((static_cast<std::uint16_t>(data[index]) << 8U) |
                                              data[index + 1U]));
        index += 2U;
    }
    if (index < size) {
        sum = static_cast<std::uint16_t>(
            sum + static_cast<std::uint16_t>(static_cast<std::uint16_t>(data[index]) << 8U));
    }
    return static_cast<std::uint16_t>(~sum);
}

void put_u32_be(std::uint8_t* output, std::uint32_t value) noexcept
{
    output[0] = static_cast<std::uint8_t>(value >> 24U);
    output[1] = static_cast<std::uint8_t>(value >> 16U);
    output[2] = static_cast<std::uint8_t>(value >> 8U);
    output[3] = static_cast<std::uint8_t>(value);
}

std::uint32_t get_u32_be(const std::uint8_t* input) noexcept
{
    return (static_cast<std::uint32_t>(input[0]) << 24U) |
           (static_cast<std::uint32_t>(input[1]) << 16U) |
           (static_cast<std::uint32_t>(input[2]) << 8U) |
           static_cast<std::uint32_t>(input[3]);
}

}  // namespace

Result<std::vector<std::uint8_t>> It930xController::transact(
    std::uint16_t command, ByteView payload) noexcept
{
    std::lock_guard<std::mutex> lock(transaction_mutex_);
    return transact_locked(command, payload);
}

Result<std::vector<std::uint8_t>> It930xController::transact_locked(
    std::uint16_t command, ByteView payload) noexcept
{
    if (!valid_pacing_mode()) {
        return Result<std::vector<std::uint8_t>>::failure(Error::INVALID_ARGUMENT);
    }
    if (payload.size > kMaxCommandPayload || (payload.size != 0U && payload.data == nullptr)) {
        return Result<std::vector<std::uint8_t>>::failure(Error::INVALID_ARGUMENT);
    }

    std::array<std::uint8_t, kMaxCommandPayload + kFrameOverhead> request{};
    const std::size_t request_size = payload.size + kFrameOverhead;
    request[0] = static_cast<std::uint8_t>(request_size - 1U);
    request[1] = static_cast<std::uint8_t>(command >> 8U);
    request[2] = static_cast<std::uint8_t>(command);
    request[3] = sequence_++;
    for (std::size_t index = 0U; index < payload.size; ++index) {
        request[4U + index] = payload.data[index];
    }
    const std::uint16_t request_checksum = checksum(request.data() + 1U, request_size - 3U);
    request[request_size - 2U] = static_cast<std::uint8_t>(request_checksum >> 8U);
    request[request_size - 1U] = static_cast<std::uint8_t>(request_checksum);

    const auto write = transport_.bulk_write(kCommandOutEndpoint,
                                              ByteView{request.data(), request_size},
                                              kCommandTimeout);
    pace_after_control_transfer();
    if (!write) {
        return Result<std::vector<std::uint8_t>>::failure(write.error());
    }
    if (write.value() != request_size) {
        return Result<std::vector<std::uint8_t>>::failure(Error::USB_IO);
    }

    std::array<std::uint8_t, kMaxCommandPayload + kFrameOverhead> response{};
    const auto read = transport_.bulk_read(kCommandInEndpoint,
                                            MutableByteView{response.data(), response.size()},
                                            kCommandTimeout);
    pace_after_control_transfer();
    if (!read) {
        return Result<std::vector<std::uint8_t>>::failure(read.error());
    }
    const std::size_t response_size = read.value();
    if (response_size < kResponseOverhead || response[0] == 0U) {
        return Result<std::vector<std::uint8_t>>::failure(Error::PROTOCOL_ERROR);
    }
    const std::size_t declared_response_size = static_cast<std::size_t>(response[0]) + 1U;
    if (response_size < declared_response_size) {
        return Result<std::vector<std::uint8_t>>::failure(Error::USB_IO);
    }
    if (response_size != declared_response_size) {
        return Result<std::vector<std::uint8_t>>::failure(Error::PROTOCOL_ERROR);
    }
    const std::uint16_t response_checksum = checksum(response.data() + 1U, response_size - 3U);
    const std::uint16_t received_checksum =
        static_cast<std::uint16_t>((static_cast<std::uint16_t>(response[response_size - 2U]) << 8U) |
                                    response[response_size - 1U]);
    if (response_checksum != received_checksum || response[1] != request[3]) {
        return Result<std::vector<std::uint8_t>>::failure(Error::PROTOCOL_ERROR);
    }
    if (response[2] != 0U) {
        return Result<std::vector<std::uint8_t>>::failure(Error::USB_IO);
    }

    std::vector<std::uint8_t> result;
    const std::size_t payload_size = response_size - kResponseOverhead;
    result.assign(response.data() + 3U, response.data() + 3U + payload_size);
    return Result<std::vector<std::uint8_t>>::success(std::move(result));
}

Result<std::uint32_t> It930xController::firmware_version_locked() noexcept
{
    constexpr std::array<std::uint8_t, 1U> query_payload{1U};
    const auto response = transact_locked(kQueryInfo,
                                           ByteView{query_payload.data(), query_payload.size()});
    if (!response) {
        return Result<std::uint32_t>::failure(response.error());
    }
    if (response.value().size() != 4U) {
        return Result<std::uint32_t>::failure(Error::PROTOCOL_ERROR);
    }
    return Result<std::uint32_t>::success(get_u32_be(response.value().data()));
}

Result<std::uint32_t> It930xController::firmware_version() noexcept
{
    std::lock_guard<std::mutex> lock(transaction_mutex_);
    return firmware_version_locked();
}

Result<std::vector<std::uint8_t>> It930xController::read_registers_locked(
    std::uint32_t reg, std::size_t length) noexcept
{
    if (length == 0U || length > kMaxResponsePayload) {
        return Result<std::vector<std::uint8_t>>::failure(Error::INVALID_ARGUMENT);
    }
    std::array<std::uint8_t, 6U> payload{};
    payload[0] = static_cast<std::uint8_t>(length);
    payload[1] = register_length(reg);
    put_u32_be(payload.data() + 2U, reg);
    const auto response = transact_locked(kRegRead, ByteView{payload.data(), payload.size()});
    if (!response) {
        return Result<std::vector<std::uint8_t>>::failure(response.error());
    }
    if (response.value().size() != length) {
        return Result<std::vector<std::uint8_t>>::failure(Error::PROTOCOL_ERROR);
    }
    return Result<std::vector<std::uint8_t>>::success(response.value());
}

Result<std::vector<std::uint8_t>> It930xController::read_registers(
    std::uint32_t reg, std::size_t length) noexcept
{
    std::lock_guard<std::mutex> lock(transaction_mutex_);
    return read_registers_locked(reg, length);
}

Result<std::uint8_t> It930xController::read_register(std::uint32_t reg) noexcept
{
    const auto response = read_registers(reg, 1U);
    if (!response) {
        return Result<std::uint8_t>::failure(response.error());
    }
    return Result<std::uint8_t>::success(response.value()[0]);
}

Result<void> It930xController::write_registers_locked(std::uint32_t reg,
                                                       ByteView values) noexcept
{
    if (values.size == 0U || values.size > (kMaxCommandPayload - 6U) ||
        (values.size != 0U && values.data == nullptr)) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    std::array<std::uint8_t, kMaxCommandPayload> payload{};
    payload[0] = static_cast<std::uint8_t>(values.size);
    payload[1] = register_length(reg);
    put_u32_be(payload.data() + 2U, reg);
    for (std::size_t index = 0U; index < values.size; ++index) {
        payload[6U + index] = values.data[index];
    }
    const auto response = transact_locked(kRegWrite,
                                           ByteView{payload.data(), 6U + values.size});
    if (!response) {
        return Result<void>::failure(response.error());
    }
    if (!response.value().empty()) {
        return Result<void>::failure(Error::PROTOCOL_ERROR);
    }
    return Result<void>::success();
}

Result<void> It930xController::write_registers(std::uint32_t reg, ByteView values) noexcept
{
    std::lock_guard<std::mutex> lock(transaction_mutex_);
    return write_registers_locked(reg, values);
}

Result<void> It930xController::write_q3u4_register_locked(std::uint32_t reg,
                                                           std::uint8_t value) noexcept
{
    return write_registers_locked(static_cast<std::uint32_t>(reg), ByteView{&value, 1U});
}

Result<void> It930xController::write_q3u4_registers_locked(std::uint32_t reg,
                                                            ByteView values) noexcept
{
    return write_registers_locked(static_cast<std::uint32_t>(reg), values);
}

Result<void> It930xController::modify_q3u4_register_locked(std::uint32_t reg,
                                                            std::uint8_t value,
                                                            std::uint8_t mask) noexcept
{
    if (mask == 0U) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    if (mask == 0xffU) {
        return write_q3u4_register_locked(reg, value);
    }
    const auto current = read_registers_locked(static_cast<std::uint32_t>(reg), 1U);
    if (!current) {
        return Result<void>::failure(current.error());
    }
    const std::uint8_t modified = static_cast<std::uint8_t>(
        (current.value()[0] & static_cast<std::uint8_t>(~mask)) | (value & mask));
    return write_q3u4_register_locked(reg, modified);
}

Result<void> It930xController::configure_q3u4_stream_output_locked() noexcept
{
    const auto gate = modify_q3u4_register_locked(Q3U4Register::stream_gate, 0x01U, 0x01U);
    if (!gate) {
        return Result<void>::failure(gate.error());
    }

    Error first_error = Error::OK;
    const auto fail = [&first_error](const Result<void>& result) noexcept {
        if (first_error == Error::OK && !result) {
            first_error = result.error();
        }
    };

    fail(modify_q3u4_register_locked(Q3U4Register::endpoint4_enable, 0x00U, 0x20U));
    if (first_error == Error::OK) {
        fail(modify_q3u4_register_locked(Q3U4Register::endpoint4_nak, 0x00U, 0x20U));
    }
    if (first_error == Error::OK) {
        fail(modify_q3u4_register_locked(Q3U4Register::endpoint4_enable, 0x20U, 0x20U));
    }
    if (first_error == Error::OK) {
        constexpr std::array<std::uint8_t, 2U> threshold{
            static_cast<std::uint8_t>(kQ3U4TransferThreshold),
            static_cast<std::uint8_t>(kQ3U4TransferThreshold >> 8U)};
        fail(write_q3u4_registers_locked(Q3U4Register::transfer_threshold,
                                         ByteView{threshold.data(), threshold.size()}));
    }
    if (first_error == Error::OK) {
        // The legacy USB path divides the high-speed 512-byte max packet by four.
        fail(write_q3u4_register_locked(Q3U4Register::max_bulk_packet,
                                        kQ3U4MaxBulkPacketRegister));
    }
    if (first_error == Error::OK) {
        fail(modify_q3u4_register_locked(Q3U4Register::stream_output_a, 0x00U, 0x01U));
    }
    if (first_error == Error::OK) {
        fail(modify_q3u4_register_locked(Q3U4Register::stream_output_b, 0x00U, 0x01U));
    }

    // da1d is a temporary gate. Cleanup is attempted even after a forward failure;
    // d920 is the legacy USB reverse-mode cleanup and follows the same rule.
    const auto gate_cleanup = modify_q3u4_register_locked(Q3U4Register::stream_gate,
                                                           0x00U, 0x01U);
    fail(gate_cleanup);
    const auto reverse_cleanup = write_q3u4_register_locked(Q3U4Register::stream_reverse, 0U);
    fail(reverse_cleanup);
    return first_error == Error::OK ? Result<void>::success()
                                    : Result<void>::failure(first_error);
}

Result<void> It930xController::warm_initialize_q3u4_locked() noexcept
{
    // PX-Q3U4のIT9305E warm初期化は、既存ドライバの固定順序と値を保つ。
    // 任意レジスタ列を受け取る設計にすると、機種差と失敗位置を呼び出し側へ漏らす。
    const auto write = [this](std::uint32_t reg, std::uint8_t value) noexcept {
        return write_q3u4_register_locked(reg, value);
    };
    const auto modify = [this](std::uint32_t reg, std::uint8_t value,
                               std::uint8_t mask) noexcept {
        return modify_q3u4_register_locked(reg, value, mask);
    };

    const auto eeprom_control = write(Q3U4Register::eeprom_control, 0U);
    if (!eeprom_control) {
        return eeprom_control;
    }
    const auto eeprom_status = write(Q3U4Register::eeprom_status, 0U);
    if (!eeprom_status) {
        return eeprom_status;
    }
    const auto eeprom_command = write(Q3U4Register::eeprom_command, 0U);
    if (!eeprom_command) {
        return eeprom_command;
    }
    const auto eeprom_address = write(Q3U4Register::eeprom_address, 0U);
    if (!eeprom_address) {
        return eeprom_address;
    }
    const auto ignore_sync = write(Q3U4Register::ignore_sync, 0U);
    if (!ignore_sync) {
        return ignore_sync;
    }
    const auto dvbt_interrupt = modify(Q3U4Register::dvbt_interrupt, 0x04U, 0x04U);
    if (!dvbt_interrupt) {
        return dvbt_interrupt;
    }
    const auto mpeg_full_speed = modify(Q3U4Register::mpeg_full_speed, 0x00U, 0x01U);
    if (!mpeg_full_speed) {
        return mpeg_full_speed;
    }
    const auto dvbt_mode = modify(Q3U4Register::dvbt_mode, 0x01U, 0x01U);
    if (!dvbt_mode) {
        return dvbt_mode;
    }

    const auto stream_output = configure_q3u4_stream_output_locked();
    if (!stream_output) {
        return stream_output;
    }

    const auto power_a = write(Q3U4Register::power_control_a, 1U);
    if (!power_a) {
        return power_a;
    }
    const auto power_b = write(Q3U4Register::power_control_b, 0U);
    if (!power_b) {
        return power_b;
    }
    const auto power_c = write(Q3U4Register::power_control_c, 1U);
    if (!power_c) {
        return power_c;
    }
    const auto power_d = write(Q3U4Register::power_control_d, 0U);
    if (!power_d) {
        return power_d;
    }

    const auto i2c_speed_aux = write(Q3U4Register::i2c_speed_aux, 0x07U);
    if (!i2c_speed_aux) {
        return i2c_speed_aux;
    }
    const auto i2c_speed = write(Q3U4Register::i2c_speed, 0x07U);
    if (!i2c_speed) {
        return i2c_speed;
    }

    // 4入力のslave番号とI2CアドレスはQ3U4基板の配線に対応する固定対応表。
    constexpr std::array<Q3U4Register, 4U> i2c_address_registers{
        Q3U4Register::i2c_addr_slave0, Q3U4Register::i2c_addr_slave1,
        Q3U4Register::i2c_addr_slave2, Q3U4Register::i2c_addr_slave3};
    constexpr std::array<Q3U4Register, 4U> i2c_bus_registers{
        Q3U4Register::i2c_bus_slave0, Q3U4Register::i2c_bus_slave1,
        Q3U4Register::i2c_bus_slave2, Q3U4Register::i2c_bus_slave3};
    constexpr std::array<std::uint8_t, 4U> i2c_addresses{0x22U, 0x26U, 0x20U, 0x24U};
    for (std::size_t index = 0U; index < i2c_address_registers.size(); ++index) {
        const auto address = write(i2c_address_registers[index], i2c_addresses[index]);
        if (!address) {
            return address;
        }
        const auto bus = write(i2c_bus_registers[index], 2U);
        if (!bus) {
            return bus;
        }
    }

    const auto serial_mode = write(Q3U4Register::stream_serial_port1, 0U);
    if (!serial_mode) {
        return serial_mode;
    }
    constexpr std::array<Q3U4Register, 4U> aggregation_registers{
        Q3U4Register::stream_aggregate_port1, Q3U4Register::stream_aggregate_port2,
        Q3U4Register::stream_aggregate_port3, Q3U4Register::stream_aggregate_port4};
    constexpr std::array<Q3U4Register, 4U> sync_registers{
        Q3U4Register::stream_sync_port1, Q3U4Register::stream_sync_port2,
        Q3U4Register::stream_sync_port3, Q3U4Register::stream_sync_port4};
    constexpr std::array<Q3U4Register, 4U> enable_registers{
        Q3U4Register::stream_enable_port1, Q3U4Register::stream_enable_port2,
        Q3U4Register::stream_enable_port3, Q3U4Register::stream_enable_port4};
    constexpr std::array<std::uint8_t, 4U> sync_bytes{0x17U, 0x27U, 0x37U, 0x47U};
    for (std::size_t index = 0U; index < aggregation_registers.size(); ++index) {
        const auto aggregation = write(aggregation_registers[index], 1U);
        if (!aggregation) {
            return aggregation;
        }
        const auto sync = write(sync_registers[index], sync_bytes[index]);
        if (!sync) {
            return sync;
        }
        const auto enable = write(enable_registers[index], 1U);
        if (!enable) {
            return enable;
        }
    }
    const auto disable_port0 = write(Q3U4Register::stream_disable_port0, 0U);
    if (!disable_port0) {
        return disable_port0;
    }

    // warm初期化直後は電源参照を扱わず、次の利用者へ安全なアイドル状態だけを渡す。
    const auto gpio7_mode = write(Q3U4Register::gpio7_mode, 1U);
    if (!gpio7_mode) {
        return gpio7_mode;
    }
    const auto gpio7_enable = write(Q3U4Register::gpio7_enable, 1U);
    if (!gpio7_enable) {
        return gpio7_enable;
    }
    const auto gpio2_mode = write(Q3U4Register::gpio2_mode, 1U);
    if (!gpio2_mode) {
        return gpio2_mode;
    }
    const auto gpio2_enable = write(Q3U4Register::gpio2_enable, 1U);
    if (!gpio2_enable) {
        return gpio2_enable;
    }
    const auto backend_idle = write(Q3U4Register::gpio2_output, 0U);
    if (!backend_idle) {
        return backend_idle;
    }
    const auto reset_idle = write(Q3U4Register::gpio7_output, 1U);
    if (!reset_idle) {
        return reset_idle;
    }
    const auto gpio11_mode = write(Q3U4Register::gpio11_mode, 1U);
    if (!gpio11_mode) {
        return gpio11_mode;
    }
    const auto gpio11_enable = write(Q3U4Register::gpio11_enable, 1U);
    if (!gpio11_enable) {
        return gpio11_enable;
    }
    return write(Q3U4Register::gpio11_output, 0U);
}

Result<void> It930xController::write_register(std::uint32_t reg, std::uint8_t value) noexcept
{
    return write_registers(reg, ByteView{&value, 1U});
}

Result<void> It930xController::set_q3u4_lnb_power(bool on) noexcept
{
    std::lock_guard<std::mutex> lock(transaction_mutex_);
    if (q3u4_lnb_disconnected_) {
        return Result<void>::failure(Error::DISCONNECTED);
    }
    const auto result = write_q3u4_register_locked(
        static_cast<std::uint32_t>(Q3U4Register::gpio11_output), on ? 1U : 0U);
    if (!result && result.error() == Error::DISCONNECTED) {
        q3u4_lnb_disconnected_ = true;
    }
    return result;
}

Result<void> It930xController::initialize_card_uart() noexcept
{
    std::lock_guard<std::mutex> lock(transaction_mutex_);
    constexpr std::uint8_t mode = 1U;
    const auto mode_result = transact_locked(kUartSetMode, ByteView{&mode, 1U});
    if (!mode_result) {
        return Result<void>::failure(mode_result.error());
    }
    if (!mode_result.value().empty()) {
        return Result<void>::failure(Error::PROTOCOL_ERROR);
    }

    constexpr std::uint8_t input = 0U;
    const auto gpio_mode = write_registers_locked(
        Q3U4Register::gpio6_mode, ByteView{&input, 1U});
    if (!gpio_mode) {
        return gpio_mode;
    }
    constexpr std::uint8_t enabled = 1U;
    return write_registers_locked(Q3U4Register::gpio6_enable,
                                  ByteView{&enabled, 1U});
}

Result<bool> It930xController::detect_card() noexcept
{
    std::lock_guard<std::mutex> lock(transaction_mutex_);
    const auto level = read_registers_locked(Q3U4Register::gpio6_input, 1U);
    if (!level) {
        return Result<bool>::failure(level.error());
    }
    // GPIO H6 is connected to the card-detect switch and is active low.
    return Result<bool>::success(level.value()[0] == 0U);
}

Result<void> It930xController::set_card_baud_rate_locked(
    It930xCardBaudRate baud_rate) noexcept
{
    std::uint8_t encoded = 0U;
    switch (baud_rate) {
    case It930xCardBaudRate::baud_9600:
        encoded = 0U;
        break;
    case It930xCardBaudRate::baud_19200:
        encoded = 1U;
        break;
    case It930xCardBaudRate::baud_38400:
        // UART mode 1 maps the nominal value 2 back to 9600 baud. Use the
        // firmware's generic-UART reload value for a real 38400 baud rate.
        encoded = 0xefU;
        break;
    default:
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }

    const auto response = transact_locked(kUartSetBaudRate,
                                           ByteView{&encoded, 1U});
    if (!response) {
        return Result<void>::failure(response.error());
    }
    return response.value().empty() ? Result<void>::success()
                                    : Result<void>::failure(Error::PROTOCOL_ERROR);
}

Result<void> It930xController::set_card_baud_rate(It930xCardBaudRate baud_rate) noexcept
{
    std::lock_guard<std::mutex> lock(transaction_mutex_);
    return set_card_baud_rate_locked(baud_rate);
}

Result<void> It930xController::reset_card(It930xCardDelay& delay) noexcept
{
    std::lock_guard<std::mutex> lock(transaction_mutex_);
    constexpr std::uint8_t output = 1U;
    const auto gpio_mode = write_registers_locked(
        Q3U4Register::gpio14_mode, ByteView{&output, 1U});
    if (!gpio_mode) {
        return gpio_mode;
    }
    constexpr std::uint8_t enabled = 1U;
    const auto gpio_enable = write_registers_locked(
        Q3U4Register::gpio14_enable, ByteView{&enabled, 1U});
    if (!gpio_enable) {
        return gpio_enable;
    }
    constexpr std::uint8_t low = 0U;
    const auto assert_reset = write_registers_locked(
        Q3U4Register::gpio14_output, ByteView{&low, 1U});
    if (!assert_reset) {
        return assert_reset;
    }
    constexpr std::uint8_t reset_uart_receive = 2U;
    const auto reset_uart = write_registers_locked(
        0x7904U, ByteView{&reset_uart_receive, 1U});
    if (!reset_uart) {
        return reset_uart;
    }
    const auto baud = set_card_baud_rate_locked(It930xCardBaudRate::baud_9600);
    if (!baud) {
        return baud;
    }
    delay.sleep_ms(5U);
    constexpr std::uint8_t high = 1U;
    return write_registers_locked(Q3U4Register::gpio14_output,
                                  ByteView{&high, 1U});
}

Result<bool> It930xController::card_data_ready() noexcept
{
    std::lock_guard<std::mutex> lock(transaction_mutex_);
    const auto ready = read_registers_locked(kUartRxReady, 1U);
    if (!ready) {
        return Result<bool>::failure(ready.error());
    }
    return Result<bool>::success(ready.value()[0] != 0U);
}

Result<std::size_t> It930xController::read_card_data(MutableByteView output) noexcept
{
    if (output.data == nullptr || output.size == 0U ||
        output.size > kCardFrameMaxLength) {
        return Result<std::size_t>::failure(Error::INVALID_ARGUMENT);
    }

    std::lock_guard<std::mutex> lock(transaction_mutex_);
    std::size_t total = 0U;
    while (total < output.size) {
        const auto available = read_registers_locked(kUartRxLength, 1U);
        if (!available) {
            return Result<std::size_t>::failure(available.error());
        }
        if (available.value()[0] == 0U) {
            break;
        }

        const std::size_t chunk_size = std::min<std::size_t>(
            std::min<std::size_t>(available.value()[0], kCardReadChunkMaxLength),
            output.size - total);
        const std::uint8_t requested = static_cast<std::uint8_t>(chunk_size);
        const auto response = transact_locked(
            kUartRead, ByteView{&requested, 1U});
        if (!response) {
            return Result<std::size_t>::failure(response.error());
        }
        if (response.value().size() != chunk_size) {
            return Result<std::size_t>::failure(Error::PROTOCOL_ERROR);
        }
        std::copy(response.value().begin(), response.value().end(), output.data + total);
        total += chunk_size;
    }
    return Result<std::size_t>::success(total);
}

Result<void> It930xController::write_card_data(ByteView input) noexcept
{
    if (input.data == nullptr || input.size == 0U || input.size > kCardFrameMaxLength) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }

    std::lock_guard<std::mutex> lock(transaction_mutex_);
    std::size_t offset = 0U;
    while (offset < input.size) {
        const std::size_t chunk_size = std::min<std::size_t>(
            kCardWriteChunkMaxLength, input.size - offset);
        if (offset + chunk_size == input.size) {
            constexpr std::uint8_t send = 1U;
            const auto real_send = write_registers_locked(
                kUartRealSend, ByteView{&send, 1U});
            if (!real_send) {
                return real_send;
            }
        }

        std::array<std::uint8_t, kCardWriteChunkMaxLength + 1U> payload{};
        payload[0] = static_cast<std::uint8_t>(chunk_size);
        std::copy(input.data + offset, input.data + offset + chunk_size,
                  payload.data() + 1U);
        const auto response = transact_locked(
            kUartWrite, ByteView{payload.data(), chunk_size + 1U});
        if (!response) {
            return Result<void>::failure(response.error());
        }
        if (!response.value().empty()) {
            return Result<void>::failure(Error::PROTOCOL_ERROR);
        }
        offset += chunk_size;
    }
    return Result<void>::success();
}

Result<void> It930xController::purge_psb(Timeout timeout,
                                          PsbPurgeObservation* observation) noexcept
{
    std::lock_guard<std::mutex> lock(transaction_mutex_);

    if (observation != nullptr) {
        *observation = PsbPurgeObservation{};
    }

    Error first_error = Error::OK;
    const auto remember = [&first_error](const Result<void>& result) noexcept {
        if (first_error == Error::OK && !result) {
            first_error = result.error();
        }
    };

    const auto set_gate = modify_q3u4_register_locked(Q3U4Register::stream_gate,
                                                       0x01U, 0x01U);
    remember(set_gate);

    if (set_gate) {
        std::array<std::uint8_t, kPsbPurgeTransferSize> discard{};
        BulkReadObservation read_observation;
        if (observation != nullptr) {
            observation->read_attempted = true;
        }
        const auto read = transport_.bulk_read(
            kTsInEndpoint, MutableByteView{discard.data(), discard.size()}, timeout,
            &read_observation);
        if (observation != nullptr) {
            observation->completion_error = read_observation.completion_error;
            observation->transferred = read_observation.transferred;
        }
        if (!read) {
            if (first_error == Error::OK) {
                first_error = read.error();
            }
        } else if (read_observation.completion_error == Error::TIMEOUT) {
            if (read_observation.transferred != kPsbPartialTimeoutTransferSize &&
                first_error == Error::OK) {
                first_error = read_observation.transferred == 0U
                                  ? Error::TIMEOUT
                                  : Error::PROTOCOL_ERROR;
            }
        } else if (read_observation.completion_error != Error::OK &&
                   first_error == Error::OK) {
            first_error = read_observation.completion_error;
        }
    }

    // The gate is temporary. Even a failed set/read may have reached the
    // bridge, so always make the best-effort clear and preserve the first error.
    const auto clear_gate = modify_q3u4_register_locked(Q3U4Register::stream_gate,
                                                         0x00U, 0x01U);
    remember(clear_gate);

    return first_error == Error::OK ? Result<void>::success()
                                    : Result<void>::failure(first_error);
}

Result<void> It930xController::set_q3u4_backend_power(bool on, Q3U4Delay& delay) noexcept
{
    std::lock_guard<std::mutex> lock(transaction_mutex_);
    const auto requested_state = on ? Q3U4BackendPowerState::on : Q3U4BackendPowerState::off;
    const auto terminal_disconnect = [this](const Result<void>& result) noexcept {
        if (!result && result.error() == Error::DISCONNECTED) {
            q3u4_backend_power_state_ = Q3U4BackendPowerState::disconnected;
            return true;
        }
        return false;
    };
    if (q3u4_backend_power_state_ == Q3U4BackendPowerState::disconnected) {
        return Result<void>::failure(Error::DISCONNECTED);
    }
    if (q3u4_backend_power_state_ == requested_state) {
        return Result<void>::success();
    }

    if (on) {
        const auto reset = write_q3u4_register_locked(Q3U4Register::gpio7_output, 0U);
        if (!reset) {
            if (terminal_disconnect(reset)) {
                return Result<void>::failure(Error::DISCONNECTED);
            }
            // A failed transaction may have reached the device before its
            // response failed, so restore both lines even for this first step.
            const auto cleanup_backend =
                write_q3u4_register_locked(Q3U4Register::gpio2_output, 0U);
            if (terminal_disconnect(cleanup_backend)) {
                return Result<void>::failure(Error::DISCONNECTED);
            }
            const auto cleanup_reset =
                write_q3u4_register_locked(Q3U4Register::gpio7_output, 1U);
            if (terminal_disconnect(cleanup_reset)) {
                return Result<void>::failure(Error::DISCONNECTED);
            }
            q3u4_backend_power_state_ =
                cleanup_backend && cleanup_reset ? Q3U4BackendPowerState::off
                                                  : Q3U4BackendPowerState::unknown;
            return reset;
        }
        delay.sleep_ms(80U);

        const auto backend = write_q3u4_register_locked(Q3U4Register::gpio2_output, 1U);
        if (!backend) {
            if (terminal_disconnect(backend)) {
                return Result<void>::failure(Error::DISCONNECTED);
            }
            const auto cleanup_backend =
                write_q3u4_register_locked(Q3U4Register::gpio2_output, 0U);
            if (terminal_disconnect(cleanup_backend)) {
                return Result<void>::failure(Error::DISCONNECTED);
            }
            const auto cleanup_reset =
                write_q3u4_register_locked(Q3U4Register::gpio7_output, 1U);
            if (terminal_disconnect(cleanup_reset)) {
                return Result<void>::failure(Error::DISCONNECTED);
            }
            q3u4_backend_power_state_ =
                cleanup_backend && cleanup_reset ? Q3U4BackendPowerState::off
                                                  : Q3U4BackendPowerState::unknown;
            return backend;
        }
        delay.sleep_ms(20U);
        q3u4_backend_power_state_ = Q3U4BackendPowerState::on;
        return Result<void>::success();
    }

    Error first_error = Error::OK;
    const auto backend = write_q3u4_register_locked(Q3U4Register::gpio2_output, 0U);
    if (!backend) {
        if (terminal_disconnect(backend)) {
            return Result<void>::failure(Error::DISCONNECTED);
        }
        first_error = backend.error();
    }
    // GPIO 7 is the reset/standby line and is always restored, even if GPIO 2
    // failed.  GPIO 11 is intentionally not part of backend power control.
    const auto reset = write_q3u4_register_locked(Q3U4Register::gpio7_output, 1U);
    if (terminal_disconnect(reset)) {
        return Result<void>::failure(Error::DISCONNECTED);
    }
    if (first_error == Error::OK && !reset) {
        first_error = reset.error();
    }
    q3u4_backend_power_state_ = first_error == Error::OK
                                     ? Q3U4BackendPowerState::off
                                     : (first_error == Error::DISCONNECTED
                                            ? Q3U4BackendPowerState::disconnected
                                            : Q3U4BackendPowerState::unknown);
    return first_error == Error::OK ? Result<void>::success()
                                    : Result<void>::failure(first_error);
}

Result<std::vector<std::uint8_t>> It930xController::i2c_read(
    std::uint8_t bus, std::uint8_t address, std::size_t length) noexcept
{
    if (bus < 1U || bus > 3U || address > 0x7fU || length == 0U ||
        length > kMaxResponsePayload) {
        return Result<std::vector<std::uint8_t>>::failure(Error::INVALID_ARGUMENT);
    }
    std::lock_guard<std::mutex> lock(transaction_mutex_);
    const std::array<std::uint8_t, 3U> payload{
        static_cast<std::uint8_t>(length), bus, static_cast<std::uint8_t>(address << 1U)};
    const auto response = transact_locked(kI2cRead,
                                           ByteView{payload.data(), payload.size()});
    if (!response) {
        return Result<std::vector<std::uint8_t>>::failure(response.error());
    }
    if (response.value().size() != length) {
        return Result<std::vector<std::uint8_t>>::failure(Error::PROTOCOL_ERROR);
    }
    return Result<std::vector<std::uint8_t>>::success(response.value());
}

Result<void> It930xController::i2c_write(std::uint8_t bus, std::uint8_t address,
                                         ByteView values) noexcept
{
    if (bus < 1U || bus > 3U || address > 0x7fU || values.size == 0U ||
        values.size > (kMaxCommandPayload - 3U) ||
        (values.size != 0U && values.data == nullptr)) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    std::lock_guard<std::mutex> lock(transaction_mutex_);
    std::array<std::uint8_t, kMaxCommandPayload> payload{};
    payload[0] = static_cast<std::uint8_t>(values.size);
    payload[1] = bus;
    payload[2] = static_cast<std::uint8_t>(address << 1U);
    for (std::size_t index = 0U; index < values.size; ++index) {
        payload[3U + index] = values.data[index];
    }
    const auto response = transact_locked(kI2cWrite,
                                           ByteView{payload.data(), 3U + values.size});
    if (!response) {
        return Result<void>::failure(response.error());
    }
    if (!response.value().empty()) {
        return Result<void>::failure(Error::PROTOCOL_ERROR);
    }
    return Result<void>::success();
}

Result<FirmwareLoadResult> It930xController::load_firmware_image_locked(
    const FirmwareImage& image) noexcept
{
    constexpr std::array<std::uint8_t, 1U> speed{0x07U};
    const auto speed_write = write_registers_locked(0xf103U,
                                                    ByteView{speed.data(), speed.size()});
    if (!speed_write) {
        return Result<FirmwareLoadResult>::failure(speed_write.error());
    }

    std::size_t offset = 0U;
    while (offset < image.size()) {
        const auto block = parse_scatter_block(image.bytes(), offset);
        if (!block) {
            return Result<FirmwareLoadResult>::failure(block.error());
        }
        const auto write = transact_locked(
            kFirmwareScatterWrite,
            ByteView{image.data() + block.value().offset, block.value().size});
        if (!write) {
            return Result<FirmwareLoadResult>::failure(write.error());
        }
        if (!write.value().empty()) {
            return Result<FirmwareLoadResult>::failure(Error::PROTOCOL_ERROR);
        }
        offset += block.value().size;
    }

    const auto boot = transact_locked(kBoot, ByteView{nullptr, 0U});
    if (!boot) {
        return Result<FirmwareLoadResult>::failure(boot.error());
    }
    if (!boot.value().empty()) {
        return Result<FirmwareLoadResult>::failure(Error::PROTOCOL_ERROR);
    }

    const auto version = firmware_version_locked();
    if (!version) {
        return Result<FirmwareLoadResult>::failure(version.error());
    }
    if (version.value() == 0U) {
        return Result<FirmwareLoadResult>::failure(Error::PROTOCOL_ERROR);
    }
    return Result<FirmwareLoadResult>::success(FirmwareLoadResult{false, version.value(), false});
}

Result<void> It930xController::verify_q3u4_state_locked() noexcept
{
    const auto verify_mask = [this](std::uint32_t reg, std::uint8_t mask,
                                    std::uint8_t expected) noexcept {
        const auto value = read_registers_locked(reg, 1U);
        if (!value) {
            return Result<void>::failure(value.error());
        }
        return (value.value()[0] & mask) == expected
                   ? Result<void>::success()
                   : Result<void>::failure(Error::PROTOCOL_ERROR);
    };
    const auto verify_exact = [this](std::uint32_t reg, ByteView expected) noexcept {
        const auto value = read_registers_locked(reg, expected.size);
        if (!value) {
            return Result<void>::failure(value.error());
        }
        if (value.value().size() != expected.size ||
            (expected.size != 0U &&
             std::equal(value.value().begin(), value.value().end(), expected.data) == false)) {
            return Result<void>::failure(Error::PROTOCOL_ERROR);
        }
        return Result<void>::success();
    };

    if (const auto result = verify_mask(static_cast<std::uint32_t>(Q3U4Register::stream_gate),
                                        0x01U, 0x00U);
        !result) {
        return result;
    }
    if (const auto result = verify_mask(
            static_cast<std::uint32_t>(Q3U4Register::endpoint4_enable), 0x20U, 0x20U);
        !result) {
        return result;
    }
    if (const auto result = verify_mask(
            static_cast<std::uint32_t>(Q3U4Register::endpoint4_nak), 0x20U, 0x00U);
        !result) {
        return result;
    }
    constexpr std::array<std::uint8_t, 2U> threshold{
        static_cast<std::uint8_t>(kQ3U4TransferThreshold),
        static_cast<std::uint8_t>(kQ3U4TransferThreshold >> 8U)};
    if (const auto result = verify_exact(
            static_cast<std::uint32_t>(Q3U4Register::transfer_threshold),
            ByteView{threshold.data(), threshold.size()});
        !result) {
        return result;
    }
    constexpr std::array<std::uint8_t, 1U> max_bulk{ kQ3U4MaxBulkPacketRegister };
    if (const auto result = verify_exact(
            static_cast<std::uint32_t>(Q3U4Register::max_bulk_packet),
            ByteView{max_bulk.data(), max_bulk.size()});
        !result) {
        return result;
    }
    if (const auto result = verify_mask(
            static_cast<std::uint32_t>(Q3U4Register::stream_output_a), 0x01U, 0x00U);
        !result) {
        return result;
    }
    if (const auto result = verify_mask(
            static_cast<std::uint32_t>(Q3U4Register::stream_output_b), 0x01U, 0x00U);
        !result) {
        return result;
    }
    constexpr std::array<std::uint8_t, 1U> zero{0U};
    if (const auto result = verify_exact(
            static_cast<std::uint32_t>(Q3U4Register::stream_reverse),
            ByteView{zero.data(), zero.size()});
        !result) {
        return result;
    }
    if (const auto result = verify_exact(
            static_cast<std::uint32_t>(Q3U4Register::gpio2_output),
            ByteView{zero.data(), zero.size()});
        !result) {
        return result;
    }
    constexpr std::array<std::uint8_t, 1U> one{1U};
    if (const auto result = verify_exact(
            static_cast<std::uint32_t>(Q3U4Register::gpio7_output),
            ByteView{one.data(), one.size()});
        !result) {
        return result;
    }
    return verify_exact(static_cast<std::uint32_t>(Q3U4Register::gpio11_output),
                        ByteView{zero.data(), zero.size()});
}

Result<FirmwareLoadResult> It930xController::initialize_q3u4(
    const FirmwareImage& image, InitializationPolicy policy) noexcept
{
    std::lock_guard<std::mutex> lock(transaction_mutex_);
    // Initialization writes the backend power GPIOs directly. Invalidate the
    // logical cache before any validation or I/O so every failure leaves a
    // conservative unknown state.
    q3u4_backend_power_state_ = Q3U4BackendPowerState::unknown;

    const auto image_validation = validate_scatter_image(image.bytes());
    if (!image_validation) {
        return Result<FirmwareLoadResult>::failure(Error::FIRMWARE_REJECTED);
    }
    if (!valid_pacing_mode() ||
        (policy != InitializationPolicy::accept_cold_or_warm &&
         policy != InitializationPolicy::require_cold)) {
        return Result<FirmwareLoadResult>::failure(Error::INVALID_ARGUMENT);
    }

    const auto version = firmware_version_locked();
    if (!version) {
        return Result<FirmwareLoadResult>::failure(version.error());
    }
    if (version.value() != 0U) {
        if (policy == InitializationPolicy::require_cold) {
            return Result<FirmwareLoadResult>::failure(Error::NOT_READY);
        }
        const auto warm = warm_initialize_q3u4_locked();
        if (!warm) {
            return Result<FirmwareLoadResult>::failure(warm.error());
        }
        const auto verified = verify_q3u4_state_locked();
        if (!verified) {
            return Result<FirmwareLoadResult>::failure(verified.error());
        }
        q3u4_backend_power_state_ = Q3U4BackendPowerState::off;
        q3u4_lnb_disconnected_ = false;
        return Result<FirmwareLoadResult>::success(FirmwareLoadResult{true, version.value(), true});
    }
    const auto loaded = load_firmware_image_locked(image);
    if (!loaded) {
        return Result<FirmwareLoadResult>::failure(loaded.error());
    }
    const auto warm = warm_initialize_q3u4_locked();
    if (!warm) {
        return Result<FirmwareLoadResult>::failure(warm.error());
    }
    const auto verified = verify_q3u4_state_locked();
    if (!verified) {
        return Result<FirmwareLoadResult>::failure(verified.error());
    }
    q3u4_backend_power_state_ = Q3U4BackendPowerState::off;
    q3u4_lnb_disconnected_ = false;
    return Result<FirmwareLoadResult>::success(
        FirmwareLoadResult{loaded.value().already_loaded, loaded.value().firmware_version, true});
}

void It930xController::pace_after_control_transfer() const noexcept
{
    if (pacing_.mode == CommandPacingMode::linux_reference_1ms) {
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
}

bool It930xController::valid_pacing_mode() const noexcept
{
    return pacing_.mode == CommandPacingMode::no_delay ||
           pacing_.mode == CommandPacingMode::linux_reference_1ms;
}

}  // namespace px4::userland
