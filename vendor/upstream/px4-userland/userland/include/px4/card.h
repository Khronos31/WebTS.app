// Modified/ported for px4-userland on 2026-09-03.
//
// Derived from tsukumijima/px4_drv commit 9eedea8c502875a788697984b93b50032339b9aa.
// Origin paths: winusb/src/DriverHost_PX4/card_device.hpp,
// winusb/src/DriverHost_PX4/smart_card.hpp,
// winusb/src/DriverHost_PX4/smart_card.cpp,
// winusb/src/WinSCard_PX4/bcas_atr.hpp.
// Source snapshot maintained by tsukumijima.
// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_CARD_H
#define PX4_USERLAND_CARD_H

#include "px4/error.h"
#include "px4/it930x.h"
#include "px4/transport.h"

#include <array>
#include <cstddef>
#include <cstdint>

namespace px4::userland {

inline constexpr std::size_t kCardAtrMaxLength = 33U;

enum class CardEdc : std::uint8_t {
    lrc = 0,
    crc = 1,
};

struct CardAtr final {
    std::array<std::uint8_t, kCardAtrMaxLength> bytes{};
    std::size_t length = 0U;
    It930xCardBaudRate baud_rate = It930xCardBaudRate::baud_9600;
    std::uint8_t ifsc = 32U;
    CardEdc edc = CardEdc::lrc;
    std::uint32_t block_timeout_ms = 500U;

    ByteView view() const noexcept { return ByteView{bytes.data(), length}; }
};

// One timing seam serves both ATR polling and the 5 ms H14 reset pulse used by
// It930xController. monotonic_ms() must never represent wall-clock time.
class CardTime : public It930xCardDelay {
public:
    ~CardTime() noexcept override = default;
    virtual std::uint64_t monotonic_ms() noexcept = 0;
    void sleep_ms(std::uint32_t milliseconds) noexcept override = 0;
};

class SystemCardTime final : public CardTime {
public:
    std::uint64_t monotonic_ms() noexcept override;
    void sleep_ms(std::uint32_t milliseconds) noexcept override;
};

class CardHardware {
public:
    virtual ~CardHardware() noexcept = default;
    virtual Result<bool> detect_card() noexcept = 0;
    virtual Result<void> reset_card(It930xCardDelay& delay) noexcept = 0;
    virtual Result<bool> data_ready() noexcept = 0;
    virtual Result<std::size_t> read_data(MutableByteView output) noexcept = 0;
    virtual Result<void> write_data(ByteView input) noexcept = 0;
    virtual Result<void> set_baud_rate(It930xCardBaudRate baud_rate) noexcept = 0;
};

class It930xCardHardware final : public CardHardware {
public:
    explicit It930xCardHardware(It930xController& controller) noexcept
        : controller_(controller)
    {
    }

    Result<bool> detect_card() noexcept override;
    Result<void> reset_card(It930xCardDelay& delay) noexcept override;
    Result<bool> data_ready() noexcept override;
    Result<std::size_t> read_data(MutableByteView output) noexcept override;
    Result<void> write_data(ByteView input) noexcept override;
    Result<void> set_baud_rate(It930xCardBaudRate baud_rate) noexcept override;

private:
    It930xController& controller_;
};

// Returns NOT_READY only when the supplied bytes are a valid but incomplete
// ATR prefix. Malformed ATR data returns PROTOCOL_ERROR.
Result<CardAtr> parse_card_atr(ByteView bytes) noexcept;

// Stateless card reset and ATR acquisition. Only a malformed ATR is retried,
// once, from a fresh hardware reset. No T=1 block is sent by this API.
Result<CardAtr> reset_and_read_card_atr(CardHardware& hardware, CardTime& time) noexcept;

class CardSession final {
public:
    CardSession(CardHardware& hardware, CardTime& time) noexcept
        : hardware_(hardware), time_(time)
    {
    }

    CardSession(const CardSession&) = delete;
    CardSession& operator=(const CardSession&) = delete;
    CardSession(CardSession&&) = delete;
    CardSession& operator=(CardSession&&) = delete;

    Result<void> initialize() noexcept;
    Result<std::size_t> transmit(ByteView apdu, MutableByteView response) noexcept;
    bool initialized() const noexcept { return initialized_; }
    const CardAtr& atr() const noexcept { return atr_; }
    void invalidate() noexcept;

private:
    struct Block final {
        std::uint8_t pcb = 0U;
        std::array<std::uint8_t, 254U> data{};
        std::size_t length = 0U;
    };

    Result<void> initialize_t1(bool resynchronize, std::uint8_t ifsd) noexcept;
    Result<void> send_block(std::uint8_t pcb, ByteView data) noexcept;
    Result<Block> receive_block(std::uint64_t deadline) noexcept;
    Result<Block> exchange_block(std::uint8_t pcb, ByteView data,
                                 std::uint64_t deadline,
                                 unsigned int max_retries = 3U) noexcept;
    Result<void> discard_pending_data() noexcept;
    Result<std::size_t> transmit_initialized(ByteView apdu,
                                             MutableByteView response,
                                             std::uint64_t deadline) noexcept;
    std::uint16_t calculate_crc(const std::uint8_t* data,
                                std::size_t length) const noexcept;

    CardHardware& hardware_;
    CardTime& time_;
    CardAtr atr_{};
    bool initialized_ = false;
    bool use_crc_ = false;
    std::uint8_t card_ifsc_ = 32U;
    std::uint32_t block_timeout_ms_ = 500U;
    std::uint8_t send_sequence_ = 0U;
    std::uint8_t receive_sequence_ = 0U;
};

}  // namespace px4::userland

#endif  // PX4_USERLAND_CARD_H
