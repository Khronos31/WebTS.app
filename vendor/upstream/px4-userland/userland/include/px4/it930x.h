// Modified/ported for px4-userland on 2026-09-03.
//
// Copyright (c) 2018-2021 nns779
// Derived from tsukumijima/px4_drv commit 9eedea8c502875a788697984b93b50032339b9aa.
// Origin paths: driver/it930x.c, driver/it930x.h, driver/itedtv_bus.c,
// driver/px4_device.c, winusb/src/DriverHost_PX4/px4_device.cpp.
// Source snapshot maintained by tsukumijima.
// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_IT930X_H
#define PX4_USERLAND_IT930X_H

#include "px4/error.h"
#include "px4/firmware.h"
#include "px4/transport.h"

#include <cstddef>
#include <cstdint>
#include <mutex>
#include <vector>

namespace px4::userland {

// Internal power-operation seam. The concrete delay type lives in the private
// q3u4_power.h header; this public controller header only needs a reference.
class Q3U4Delay;

struct FirmwareLoadResult final {
    bool already_loaded;
    std::uint32_t firmware_version;
    bool verified;
};

enum class CommandPacingMode : std::uint8_t {
    no_delay = 0,
    linux_reference_1ms = 1,
};

struct CommandPacingOptions final {
    CommandPacingMode mode = CommandPacingMode::linux_reference_1ms;
};

struct PsbPurgeObservation final {
    bool read_attempted = false;
    Error completion_error = Error::OK;
    std::size_t transferred = 0U;
};

enum class InitializationPolicy : std::uint8_t {
    accept_cold_or_warm = 0,
    require_cold = 1,
};

enum class It930xCardBaudRate : std::uint8_t {
    baud_9600 = 0,
    baud_19200 = 1,
    baud_38400 = 2,
};

class It930xCardDelay {
public:
    virtual ~It930xCardDelay() noexcept = default;
    virtual void sleep_ms(std::uint32_t milliseconds) noexcept = 0;
};

class It930xController final {
public:
    explicit It930xController(
        Transport& transport,
        CommandPacingOptions pacing = CommandPacingOptions{}) noexcept
        : transport_(transport), pacing_(pacing)
    {
    }
    ~It930xController() noexcept = default;

    It930xController(const It930xController&) = delete;
    It930xController& operator=(const It930xController&) = delete;
    It930xController(It930xController&&) = delete;
    It930xController& operator=(It930xController&&) = delete;

    Result<std::uint32_t> firmware_version() noexcept;
    Result<std::uint8_t> read_register(std::uint32_t reg) noexcept;
    Result<std::vector<std::uint8_t>> read_registers(std::uint32_t reg,
                                                     std::size_t length) noexcept;
    Result<void> write_register(std::uint32_t reg, std::uint8_t value) noexcept;
    Result<void> write_registers(std::uint32_t reg, ByteView values) noexcept;
    Result<std::vector<std::uint8_t>> i2c_read(std::uint8_t bus, std::uint8_t address,
                                               std::size_t length) noexcept;
    Result<void> i2c_write(std::uint8_t bus, std::uint8_t address, ByteView values) noexcept;
    // Purge the bridge's packet staging buffer with one synchronous TS read.
    // A normal USB completion is accepted at any length; a timeout is accepted
    // only when the bridge returned one complete 512-byte transfer. Register
    // cleanup is always attempted.
    Result<void> purge_psb(Timeout timeout,
                           PsbPurgeObservation* observation = nullptr) noexcept;
    // Internal Q3U4 backend power operation.  It deliberately addresses only
    // GPIO 7 and GPIO 2; GPIO 11 belongs to the LNB path.
    Result<void> set_q3u4_backend_power(bool on, Q3U4Delay& delay) noexcept;
    // Narrow Q3U4 LNB operation. GPIO 11 is the only register this authority
    // may change: low is 0 V/off and high is 15 V/on.
    Result<void> set_q3u4_lnb_power(bool on) noexcept;
    // Q3U4 exposes its internal card reader on device 1 only. Device 1 backend
    // power must already be enabled by the caller before using these bridge APIs.
    Result<void> initialize_card_uart() noexcept;
    Result<bool> detect_card() noexcept;
    Result<void> reset_card(It930xCardDelay& delay) noexcept;
    Result<void> set_card_baud_rate(It930xCardBaudRate baud_rate) noexcept;
    Result<bool> card_data_ready() noexcept;
    // The IT930x firmware accepts complete card frames up to 255 bytes. Reads
    // and writes are internally split into firmware-safe 32/48-byte chunks.
    Result<std::size_t> read_card_data(MutableByteView output) noexcept;
    Result<void> write_card_data(ByteView input) noexcept;
    // Initialize one IT9305E in the fixed PX-Q3U4 state and leave its GPIOs idle.
    Result<FirmwareLoadResult> initialize_q3u4(
        const FirmwareImage& image,
        InitializationPolicy policy = InitializationPolicy::accept_cold_or_warm) noexcept;

private:
    enum class Q3U4BackendPowerState : std::uint8_t {
        unknown,
        off,
        on,
        disconnected,
    };

    Result<std::vector<std::uint8_t>> transact(std::uint16_t command,
                                               ByteView payload) noexcept;
    Result<std::vector<std::uint8_t>> transact_locked(std::uint16_t command,
                                                      ByteView payload) noexcept;
    Result<std::uint32_t> firmware_version_locked() noexcept;
    Result<std::vector<std::uint8_t>> read_registers_locked(std::uint32_t reg,
                                                            std::size_t length) noexcept;
    Result<void> write_registers_locked(std::uint32_t reg, ByteView values) noexcept;
    Result<void> write_q3u4_register_locked(std::uint32_t reg, std::uint8_t value) noexcept;
    Result<void> write_q3u4_registers_locked(std::uint32_t reg, ByteView values) noexcept;
    Result<void> modify_q3u4_register_locked(std::uint32_t reg, std::uint8_t value,
                                             std::uint8_t mask) noexcept;
    Result<void> set_card_baud_rate_locked(It930xCardBaudRate baud_rate) noexcept;
    Result<void> warm_initialize_q3u4_locked() noexcept;
    Result<void> configure_q3u4_stream_output_locked() noexcept;
    Result<FirmwareLoadResult> load_firmware_image_locked(const FirmwareImage& image) noexcept;
    Result<void> verify_q3u4_state_locked() noexcept;
    void pace_after_control_transfer() const noexcept;
    bool valid_pacing_mode() const noexcept;

    Transport& transport_;
    CommandPacingOptions pacing_;
    std::mutex transaction_mutex_;
    std::uint8_t sequence_ = 0U;
    // A failed transaction makes the physical state unknown unless cleanup
    // completed every required write. Unknown deliberately retries the full
    // requested sequence on the next call; this is the conservative policy.
    Q3U4BackendPowerState q3u4_backend_power_state_ = Q3U4BackendPowerState::unknown;
    bool q3u4_lnb_disconnected_ = false;
};

}  // namespace px4::userland

#endif  // PX4_USERLAND_IT930X_H
