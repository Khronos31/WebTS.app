// Modified/ported for px4-userland on 2026-09-03.
//
// Derived from tsukumijima/px4_drv commit 9eedea8c502875a788697984b93b50032339b9aa.
// Origin paths: winusb/src/DriverHost_PX4/card_device.hpp,
// winusb/src/DriverHost_PX4/smart_card.hpp,
// winusb/src/DriverHost_PX4/smart_card.cpp,
// winusb/src/WinSCard_PX4/bcas_atr.hpp.
// Source snapshot maintained by tsukumijima.
// SPDX-License-Identifier: GPL-2.0-only
#include "px4/card.h"

#include <algorithm>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <thread>
#include <vector>

namespace px4::userland {
namespace {

constexpr std::uint32_t kAtrTimeoutMs = 1000U;
constexpr std::uint32_t kPollIntervalMs = 5U;
constexpr std::uint32_t kDefaultBlockTimeoutMs = 500U;
constexpr std::uint32_t kOperationTimeoutMs = 3000U;
constexpr std::uint8_t kT1Nad = 0x00U;
constexpr std::uint8_t kT1IBlock = 0x00U;
constexpr std::uint8_t kT1ISequence = 0x40U;
constexpr std::uint8_t kT1IChain = 0x20U;
constexpr std::uint8_t kT1RBlock = 0x80U;
constexpr std::uint8_t kT1RSequence = 0x10U;
constexpr std::uint8_t kT1SBlock = 0xc0U;
constexpr std::uint8_t kT1SResponse = 0x20U;
constexpr std::uint8_t kT1SResynchronize = 0x00U;
constexpr std::uint8_t kT1SIfs = 0x01U;
constexpr std::uint8_t kT1SWtx = 0x03U;
constexpr std::size_t kCardUartFrameMaxLength = 255U;
constexpr unsigned int kMaxRetries = 3U;
constexpr unsigned int kMaxDiscardChunks = 4U;

std::uint64_t deadline_after(CardTime& time, std::uint32_t milliseconds) noexcept
{
    const std::uint64_t now = time.monotonic_ms();
    const std::uint64_t maximum = std::numeric_limits<std::uint64_t>::max();
    return now > maximum - milliseconds ? maximum : now + milliseconds;
}

bool deadline_expired(CardTime& time, std::uint64_t deadline) noexcept
{
    return time.monotonic_ms() >= deadline;
}

Result<void> wait_data_ready(CardHardware& hardware, CardTime& time,
                             std::uint64_t deadline) noexcept
{
    while (!deadline_expired(time, deadline)) {
        const auto ready = hardware.data_ready();
        if (!ready) {
            return Result<void>::failure(ready.error());
        }
        if (ready.value()) {
            return Result<void>::success();
        }
        time.sleep_ms(kPollIntervalMs);
    }
    return Result<void>::failure(Error::TIMEOUT);
}

Result<CardAtr> read_atr_once(CardHardware& hardware, CardTime& time) noexcept
{
    CardAtr atr;
    const std::uint64_t deadline = deadline_after(time, kAtrTimeoutMs);
    while (!deadline_expired(time, deadline)) {
        const auto ready = wait_data_ready(hardware, time, deadline);
        if (!ready) {
            return Result<CardAtr>::failure(ready.error());
        }

        if (atr.length == atr.bytes.size()) {
            return Result<CardAtr>::failure(Error::PROTOCOL_ERROR);
        }
        const auto read = hardware.read_data(
            MutableByteView{atr.bytes.data() + atr.length, atr.bytes.size() - atr.length});
        if (!read) {
            return Result<CardAtr>::failure(read.error());
        }
        if (read.value() > atr.bytes.size() - atr.length) {
            return Result<CardAtr>::failure(Error::PROTOCOL_ERROR);
        }
        atr.length += read.value();
        if (read.value() != 0U) {
            const auto parsed = parse_card_atr(atr.view());
            if (parsed) {
                return parsed;
            }
            if (parsed.error() != Error::NOT_READY) {
                return Result<CardAtr>::failure(parsed.error());
            }
        }
        time.sleep_ms(kPollIntervalMs);
    }
    return Result<CardAtr>::failure(Error::TIMEOUT);
}

}  // namespace

std::uint64_t SystemCardTime::monotonic_ms() noexcept
{
    const auto elapsed = std::chrono::steady_clock::now().time_since_epoch();
    return static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::milliseconds>(elapsed).count());
}

void SystemCardTime::sleep_ms(std::uint32_t milliseconds) noexcept
{
    std::this_thread::sleep_for(std::chrono::milliseconds(milliseconds));
}

Result<bool> It930xCardHardware::detect_card() noexcept
{
    return controller_.detect_card();
}

Result<void> It930xCardHardware::reset_card(It930xCardDelay& delay) noexcept
{
    return controller_.reset_card(delay);
}

Result<bool> It930xCardHardware::data_ready() noexcept
{
    return controller_.card_data_ready();
}

Result<std::size_t> It930xCardHardware::read_data(MutableByteView output) noexcept
{
    return controller_.read_card_data(output);
}

Result<void> It930xCardHardware::write_data(ByteView input) noexcept
{
    return controller_.write_card_data(input);
}

Result<void> It930xCardHardware::set_baud_rate(It930xCardBaudRate baud_rate) noexcept
{
    return controller_.set_card_baud_rate(baud_rate);
}

Result<CardAtr> parse_card_atr(ByteView bytes) noexcept
{
    if ((bytes.size != 0U && bytes.data == nullptr)) {
        return Result<CardAtr>::failure(Error::INVALID_ARGUMENT);
    }
    if (bytes.size > kCardAtrMaxLength) {
        return Result<CardAtr>::failure(Error::PROTOCOL_ERROR);
    }
    if (bytes.size < 2U) {
        return Result<CardAtr>::failure(Error::NOT_READY);
    }
    if (bytes.data[0] != 0x3bU && bytes.data[0] != 0x3fU) {
        return Result<CardAtr>::failure(Error::PROTOCOL_ERROR);
    }

    CardAtr result;
    std::uint8_t interfaces = static_cast<std::uint8_t>(bytes.data[1] >> 4U);
    const std::size_t historical_length = bytes.data[1] & 0x0fU;
    std::size_t offset = 2U;
    unsigned int group = 1U;
    bool has_non_t0_protocol = false;
    bool t1_group = false;

    while (interfaces != 0U) {
        std::uint8_t ta = 0U;
        std::uint8_t tb = 0U;
        std::uint8_t tc = 0U;
        bool has_ta = false;
        bool has_tb = false;
        bool has_tc = false;

        if ((interfaces & 0x01U) != 0U) {
            if (offset >= bytes.size) {
                return Result<CardAtr>::failure(Error::NOT_READY);
            }
            ta = bytes.data[offset++];
            has_ta = true;
        }
        if ((interfaces & 0x02U) != 0U) {
            if (offset >= bytes.size) {
                return Result<CardAtr>::failure(Error::NOT_READY);
            }
            tb = bytes.data[offset++];
            has_tb = true;
        }
        if ((interfaces & 0x04U) != 0U) {
            if (offset >= bytes.size) {
                return Result<CardAtr>::failure(Error::NOT_READY);
            }
            tc = bytes.data[offset++];
            has_tc = true;
        }

        if (group == 1U && has_ta) {
            switch (ta) {
            case 0x11U:
                result.baud_rate = It930xCardBaudRate::baud_9600;
                break;
            case 0x12U:
                result.baud_rate = It930xCardBaudRate::baud_19200;
                break;
            case 0x13U:
                result.baud_rate = It930xCardBaudRate::baud_38400;
                break;
            default:
                return Result<CardAtr>::failure(Error::UNSUPPORTED);
            }
        }

        if (t1_group && group >= 3U) {
            if (has_ta && ta >= 1U && ta <= 254U) {
                result.ifsc = ta;
            }
            if (has_tb) {
                const unsigned int bwi = tb >> 4U;
                const unsigned int waiting = bwi < 5U ? (100U << bwi)
                                                       : kOperationTimeoutMs;
                result.block_timeout_ms = std::min<std::uint32_t>(
                    kOperationTimeoutMs,
                    std::max<std::uint32_t>(kDefaultBlockTimeoutMs, waiting));
            }
            if (has_tc) {
                result.edc = (tc & 0x01U) != 0U ? CardEdc::crc : CardEdc::lrc;
            }
        }

        if ((interfaces & 0x08U) != 0U) {
            if (offset >= bytes.size) {
                return Result<CardAtr>::failure(Error::NOT_READY);
            }
            const std::uint8_t td = bytes.data[offset++];
            const std::uint8_t protocol = td & 0x0fU;
            has_non_t0_protocol = has_non_t0_protocol || protocol != 0U;
            t1_group = protocol == 1U;
            interfaces = static_cast<std::uint8_t>(td >> 4U);
            ++group;
        } else {
            interfaces = 0U;
        }
    }

    const std::size_t expected_length =
        offset + historical_length + (has_non_t0_protocol ? 1U : 0U);
    if (expected_length > kCardAtrMaxLength) {
        return Result<CardAtr>::failure(Error::PROTOCOL_ERROR);
    }
    if (bytes.size < expected_length) {
        return Result<CardAtr>::failure(Error::NOT_READY);
    }
    if (bytes.size > expected_length) {
        return Result<CardAtr>::failure(Error::PROTOCOL_ERROR);
    }

    if (has_non_t0_protocol) {
        std::uint8_t checksum = 0U;
        for (std::size_t index = 1U; index < bytes.size; ++index) {
            checksum = static_cast<std::uint8_t>(checksum ^ bytes.data[index]);
        }
        if (checksum != 0U) {
            return Result<CardAtr>::failure(Error::PROTOCOL_ERROR);
        }
    }

    std::copy(bytes.data, bytes.data + bytes.size, result.bytes.begin());
    result.length = bytes.size;
    return Result<CardAtr>::success(result);
}

Result<CardAtr> reset_and_read_card_atr(CardHardware& hardware, CardTime& time) noexcept
{
    const auto detected = hardware.detect_card();
    if (!detected) {
        return Result<CardAtr>::failure(detected.error());
    }
    if (!detected.value()) {
        return Result<CardAtr>::failure(Error::NO_CARD);
    }

    for (unsigned int attempt = 0U; attempt < 2U; ++attempt) {
        const auto reset = hardware.reset_card(time);
        if (!reset) {
            return Result<CardAtr>::failure(reset.error());
        }
        const auto atr = read_atr_once(hardware, time);
        if (atr) {
            const auto baud = hardware.set_baud_rate(atr.value().baud_rate);
            if (!baud) {
                return Result<CardAtr>::failure(baud.error());
            }
            return atr;
        }
        if (atr.error() != Error::PROTOCOL_ERROR || attempt != 0U) {
            return Result<CardAtr>::failure(atr.error());
        }
    }
    return Result<CardAtr>::failure(Error::INTERNAL);
}

void CardSession::invalidate() noexcept
{
    initialized_ = false;
    use_crc_ = false;
    card_ifsc_ = 32U;
    block_timeout_ms_ = kDefaultBlockTimeoutMs;
    send_sequence_ = 0U;
    receive_sequence_ = 0U;
    atr_ = CardAtr{};
}

Result<void> CardSession::initialize() noexcept
{
    invalidate();
    const auto atr = reset_and_read_card_atr(hardware_, time_);
    if (!atr) {
        return Result<void>::failure(atr.error());
    }

    atr_ = atr.value();
    use_crc_ = atr_.edc == CardEdc::crc;
    card_ifsc_ = atr_.ifsc;
    block_timeout_ms_ = atr_.block_timeout_ms;
    const bool is_acas = atr_.baud_rate == It930xCardBaudRate::baud_38400;
    const std::uint8_t ifsd = is_acas ? 254U : (use_crc_ ? 250U : 251U);
    const auto initialized = initialize_t1(!is_acas, ifsd);
    if (!initialized) {
        const Error error = initialized.error();
        invalidate();
        return Result<void>::failure(error);
    }
    initialized_ = true;
    return Result<void>::success();
}

Result<void> CardSession::initialize_t1(bool resynchronize, std::uint8_t ifsd) noexcept
{
    send_sequence_ = 0U;
    receive_sequence_ = 0U;
    const std::uint64_t deadline = deadline_after(time_, kOperationTimeoutMs);

    if (resynchronize) {
        const auto response = exchange_block(
            static_cast<std::uint8_t>(kT1SBlock | kT1SResynchronize),
            ByteView{nullptr, 0U}, deadline);
        if (!response) {
            return Result<void>::failure(response.error());
        }
        if (response.value().pcb !=
                static_cast<std::uint8_t>(kT1SBlock | kT1SResponse |
                                          kT1SResynchronize) ||
            response.value().length != 0U) {
            return Result<void>::failure(Error::PROTOCOL_ERROR);
        }
    }

    auto response = exchange_block(
        static_cast<std::uint8_t>(kT1SBlock | kT1SIfs),
        ByteView{&ifsd, 1U}, deadline, resynchronize ? kMaxRetries : 1U);
    if (!resynchronize && !response &&
        (response.error() == Error::TIMEOUT ||
         response.error() == Error::PROTOCOL_ERROR)) {
        response = exchange_block(
            static_cast<std::uint8_t>(kT1SBlock | kT1SResynchronize),
            ByteView{nullptr, 0U}, deadline, 1U);
        if (!response) {
            return Result<void>::failure(response.error());
        }
        if (response.value().pcb !=
                static_cast<std::uint8_t>(kT1SBlock | kT1SResponse |
                                          kT1SResynchronize) ||
            response.value().length != 0U) {
            return Result<void>::failure(Error::PROTOCOL_ERROR);
        }
        response = exchange_block(
            static_cast<std::uint8_t>(kT1SBlock | kT1SIfs),
            ByteView{&ifsd, 1U}, deadline);
    }
    if (!response) {
        return Result<void>::failure(response.error());
    }
    if (response.value().pcb !=
            static_cast<std::uint8_t>(kT1SBlock | kT1SResponse | kT1SIfs) ||
        response.value().length != 1U || response.value().data[0] != ifsd) {
        return Result<void>::failure(Error::PROTOCOL_ERROR);
    }
    return Result<void>::success();
}

Result<void> CardSession::send_block(std::uint8_t pcb, ByteView data) noexcept
{
    if (data.size > 254U || (data.size != 0U && data.data == nullptr)) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }

    std::array<std::uint8_t, kCardUartFrameMaxLength> frame{};
    const std::size_t edc_length = use_crc_ ? 2U : 1U;
    const std::size_t frame_length = 3U + data.size + edc_length;
    if (frame_length > frame.size()) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    frame[0] = kT1Nad;
    frame[1] = pcb;
    frame[2] = static_cast<std::uint8_t>(data.size);
    if (data.size != 0U) {
        std::copy(data.data, data.data + data.size, frame.begin() + 3U);
    }

    if (use_crc_) {
        const std::uint16_t crc = calculate_crc(frame.data(), 3U + data.size);
        frame[3U + data.size] = static_cast<std::uint8_t>(crc >> 8U);
        frame[4U + data.size] = static_cast<std::uint8_t>(crc);
    } else {
        std::uint8_t lrc = 0U;
        for (std::size_t index = 0U; index < 3U + data.size; ++index) {
            lrc = static_cast<std::uint8_t>(lrc ^ frame[index]);
        }
        frame[3U + data.size] = lrc;
    }
    return hardware_.write_data(ByteView{frame.data(), frame_length});
}

Result<void> CardSession::discard_pending_data() noexcept
{
    for (unsigned int count = 0U; count < kMaxDiscardChunks; ++count) {
        const auto ready = hardware_.data_ready();
        if (!ready) {
            return Result<void>::failure(ready.error());
        }
        if (!ready.value()) {
            return Result<void>::success();
        }
        std::array<std::uint8_t, kCardUartFrameMaxLength> discard{};
        const auto read = hardware_.read_data(
            MutableByteView{discard.data(), discard.size()});
        if (!read) {
            return Result<void>::failure(read.error());
        }
        if (read.value() > discard.size()) {
            return Result<void>::failure(Error::PROTOCOL_ERROR);
        }
        if (read.value() == 0U) {
            return Result<void>::success();
        }
    }
    return Result<void>::failure(Error::PROTOCOL_ERROR);
}

Result<CardSession::Block> CardSession::receive_block(std::uint64_t deadline) noexcept
{
    std::vector<std::uint8_t> frame;
    frame.reserve(kCardUartFrameMaxLength);
    std::size_t expected_length = 0U;
    bool read_filled_chunk = false;

    while (!deadline_expired(time_, deadline)) {
        const auto ready = wait_data_ready(hardware_, time_, deadline);
        if (!ready) {
            return Result<Block>::failure(ready.error());
        }

        std::array<std::uint8_t, kCardUartFrameMaxLength> chunk{};
        const auto read = hardware_.read_data(MutableByteView{chunk.data(), chunk.size()});
        if (!read) {
            return Result<Block>::failure(read.error());
        }
        if (read.value() > chunk.size()) {
            return Result<Block>::failure(Error::PROTOCOL_ERROR);
        }
        if (read.value() != 0U) {
            read_filled_chunk = read.value() == chunk.size();
            frame.insert(frame.end(), chunk.begin(), chunk.begin() + read.value());
            if (frame.size() >= 3U) {
                expected_length = 3U + frame[2] + (use_crc_ ? 2U : 1U);
                if (expected_length > kCardUartFrameMaxLength) {
                    return Result<Block>::failure(Error::PROTOCOL_ERROR);
                }
            }
            if (expected_length != 0U && frame.size() >= expected_length) {
                break;
            }
            // RX_READY denotes a complete UART response. A short read which
            // cannot satisfy its own LEN field is therefore malformed, not a
            // partial frame that may be extended by a later notification.
            if (expected_length != 0U && read.value() < chunk.size()) {
                return Result<Block>::failure(Error::PROTOCOL_ERROR);
            }
        }
        time_.sleep_ms(kPollIntervalMs);
    }

    if (expected_length == 0U || frame.size() < expected_length) {
        return Result<Block>::failure(Error::TIMEOUT);
    }
    if (frame.size() > expected_length || read_filled_chunk) {
        frame.resize(expected_length);
        const auto discarded = discard_pending_data();
        if (!discarded) {
            return Result<Block>::failure(discarded.error());
        }
    }
    if (frame[0] != kT1Nad) {
        return Result<Block>::failure(Error::PROTOCOL_ERROR);
    }

    if (use_crc_) {
        const std::uint16_t expected_crc = calculate_crc(frame.data(), frame.size() - 2U);
        const std::uint16_t received_crc = static_cast<std::uint16_t>(
            (static_cast<std::uint16_t>(frame[frame.size() - 2U]) << 8U) |
            frame.back());
        if (expected_crc != received_crc) {
            return Result<Block>::failure(Error::PROTOCOL_ERROR);
        }
    } else {
        std::uint8_t lrc = 0U;
        for (const std::uint8_t value : frame) {
            lrc = static_cast<std::uint8_t>(lrc ^ value);
        }
        if (lrc != 0U) {
            return Result<Block>::failure(Error::PROTOCOL_ERROR);
        }
    }

    Block block;
    block.pcb = frame[1];
    block.length = frame[2];
    if (block.length > block.data.size()) {
        return Result<Block>::failure(Error::PROTOCOL_ERROR);
    }
    std::copy(frame.begin() + 3U, frame.begin() + 3U + block.length,
              block.data.begin());
    return Result<Block>::success(block);
}

Result<CardSession::Block> CardSession::exchange_block(
    std::uint8_t pcb, ByteView data, std::uint64_t deadline,
    unsigned int max_retries) noexcept
{
    for (unsigned int retry = 0U; retry < max_retries; ++retry) {
        if (deadline_expired(time_, deadline)) {
            return Result<Block>::failure(Error::TIMEOUT);
        }
        const auto sent = send_block(pcb, data);
        if (!sent) {
            return Result<Block>::failure(sent.error());
        }

        const std::uint64_t block_deadline = std::min<std::uint64_t>(
            deadline, deadline_after(time_, block_timeout_ms_));
        auto response = receive_block(block_deadline);
        if (response) {
            while (response.value().pcb ==
                   static_cast<std::uint8_t>(kT1SBlock | kT1SWtx)) {
                if (response.value().length != 1U || response.value().data[0] == 0U) {
                    return Result<Block>::failure(Error::PROTOCOL_ERROR);
                }
                const std::uint8_t multiplier = response.value().data[0];
                const auto wtx = send_block(
                    static_cast<std::uint8_t>(kT1SBlock | kT1SResponse | kT1SWtx),
                    ByteView{&multiplier, 1U});
                if (!wtx) {
                    return Result<Block>::failure(wtx.error());
                }
                response = receive_block(deadline);
                if (!response) {
                    break;
                }
            }
            if (response) {
                return response;
            }
        }
        if (response.error() != Error::TIMEOUT &&
            response.error() != Error::PROTOCOL_ERROR) {
            return Result<Block>::failure(response.error());
        }
    }
    return deadline_expired(time_, deadline)
               ? Result<Block>::failure(Error::TIMEOUT)
               : Result<Block>::failure(Error::PROTOCOL_ERROR);
}

Result<std::size_t> CardSession::transmit(ByteView apdu,
                                          MutableByteView response) noexcept
{
    const bool was_initialized = initialized_;
    const auto detected = hardware_.detect_card();
    if (!detected) {
        invalidate();
        return Result<std::size_t>::failure(detected.error());
    }
    if (!detected.value()) {
        invalidate();
        return Result<std::size_t>::failure(was_initialized ? Error::CARD_REMOVED
                                                             : Error::NO_CARD);
    }
    if (!initialized_) {
        const auto initialized = initialize();
        if (!initialized) {
            return Result<std::size_t>::failure(initialized.error());
        }
    }

    const std::uint64_t deadline = deadline_after(time_, kOperationTimeoutMs);
    const auto transmitted = transmit_initialized(apdu, response, deadline);
    if (!transmitted) {
        const Error error = transmitted.error();
        invalidate();
        return Result<std::size_t>::failure(error);
    }
    return transmitted;
}

Result<std::size_t> CardSession::transmit_initialized(
    ByteView apdu, MutableByteView response, std::uint64_t deadline) noexcept
{
    if (apdu.data == nullptr || apdu.size == 0U || response.data == nullptr) {
        return Result<std::size_t>::failure(Error::INVALID_ARGUMENT);
    }

    std::size_t response_length = 0U;
    std::size_t send_offset = 0U;
    Block last_block;
    const std::size_t max_inf_length =
        kCardUartFrameMaxLength - 3U - (use_crc_ ? 2U : 1U);

    while (send_offset < apdu.size) {
        const std::size_t chunk_length = std::min<std::size_t>(
            std::min<std::size_t>(card_ifsc_, max_inf_length),
            apdu.size - send_offset);
        const bool has_more = send_offset + chunk_length < apdu.size;
        const std::uint8_t pcb = static_cast<std::uint8_t>(
            kT1IBlock | (send_sequence_ != 0U ? kT1ISequence : 0U) |
            (has_more ? kT1IChain : 0U));
        bool accepted = false;
        for (unsigned int retry = 0U; retry < kMaxRetries; ++retry) {
            const auto exchanged = exchange_block(
                pcb, ByteView{apdu.data + send_offset, chunk_length}, deadline);
            if (!exchanged) {
                return Result<std::size_t>::failure(exchanged.error());
            }
            last_block = exchanged.value();

            if ((last_block.pcb & 0xc0U) == kT1RBlock) {
                const bool requested_sequence =
                    (last_block.pcb & kT1RSequence) != 0U;
                const bool current_sequence = send_sequence_ != 0U;
                if (requested_sequence == current_sequence) {
                    continue;
                }
                accepted = true;
                break;
            }
            if ((last_block.pcb & 0x80U) == kT1IBlock && !has_more) {
                accepted = true;
                break;
            }
            return Result<std::size_t>::failure(Error::PROTOCOL_ERROR);
        }
        if (!accepted) {
            return Result<std::size_t>::failure(Error::PROTOCOL_ERROR);
        }

        if (!has_more && (last_block.pcb & 0xc0U) == kT1RBlock) {
            bool response_received = false;
            for (unsigned int retry = 0U; retry < kMaxRetries; ++retry) {
                const std::uint8_t r_pcb = static_cast<std::uint8_t>(
                    kT1RBlock |
                    (receive_sequence_ != 0U ? kT1RSequence : 0U));
                const auto exchanged = exchange_block(
                    r_pcb, ByteView{nullptr, 0U}, deadline);
                if (!exchanged) {
                    return Result<std::size_t>::failure(exchanged.error());
                }
                last_block = exchanged.value();
                if ((last_block.pcb & 0x80U) == kT1IBlock) {
                    response_received = true;
                    break;
                }
                if ((last_block.pcb & 0xc0U) != kT1RBlock) {
                    return Result<std::size_t>::failure(Error::PROTOCOL_ERROR);
                }
            }
            if (!response_received) {
                return Result<std::size_t>::failure(Error::PROTOCOL_ERROR);
            }
        }

        send_sequence_ ^= 1U;
        send_offset += chunk_length;
    }

    while (true) {
        if (((last_block.pcb & kT1ISequence) != 0U) !=
            (receive_sequence_ != 0U)) {
            return Result<std::size_t>::failure(Error::PROTOCOL_ERROR);
        }
        if (response_length + last_block.length > response.size) {
            return Result<std::size_t>::failure(Error::BUFFER_TOO_SMALL);
        }
        std::copy(last_block.data.begin(),
                  last_block.data.begin() + last_block.length,
                  response.data + response_length);
        response_length += last_block.length;
        receive_sequence_ ^= 1U;

        if ((last_block.pcb & kT1IChain) == 0U) {
            return Result<std::size_t>::success(response_length);
        }

        const std::uint8_t r_pcb = static_cast<std::uint8_t>(
            kT1RBlock | (receive_sequence_ != 0U ? kT1RSequence : 0U));
        const auto exchanged = exchange_block(
            r_pcb, ByteView{nullptr, 0U}, deadline);
        if (!exchanged) {
            return Result<std::size_t>::failure(exchanged.error());
        }
        last_block = exchanged.value();
        if ((last_block.pcb & 0x80U) != kT1IBlock) {
            return Result<std::size_t>::failure(Error::PROTOCOL_ERROR);
        }
    }
}

std::uint16_t CardSession::calculate_crc(const std::uint8_t* data,
                                         std::size_t length) const noexcept
{
    std::uint16_t crc = 0xffffU;
    for (std::size_t index = 0U; index < length; ++index) {
        std::uint16_t value = static_cast<std::uint16_t>(data[index]) << 8U;
        for (unsigned int bit = 0U; bit < 8U; ++bit) {
            if (((crc ^ value) & 0x8000U) != 0U) {
                crc = static_cast<std::uint16_t>((crc << 1U) ^ 0x1021U);
            } else {
                crc = static_cast<std::uint16_t>(crc << 1U);
            }
            value = static_cast<std::uint16_t>(value << 1U);
        }
    }
    return crc;
}

}  // namespace px4::userland
