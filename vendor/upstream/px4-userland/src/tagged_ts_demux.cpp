// Modified/ported for px4-userland on 2026-09-02.
//
// Copyright (c) 2018-2021 nns779
// Derived from tsukumijima/px4_drv commit 9eedea8c502875a788697984b93b50032339b9aa.
// Origin paths: driver/px4_device.c, driver/ts_sync.h,
// winusb/src/DriverHost_PX4/px4_device.cpp,
// winusb/tests/ts_sync_condition_test.cpp.
// Source snapshot maintained by tsukumijima.
// SPDX-License-Identifier: GPL-2.0-only

#include "tagged_ts_demux.h"

#include <cstring>
#include <new>

namespace px4::userland {

TaggedTsDemux::TaggedTsDemux() noexcept
    : pending_(new (std::nothrow) std::uint8_t[kPendingCapacity])
{
}

bool TaggedTsDemux::is_packet_boundary(std::uint8_t value) noexcept
{
    return (value & 0x0fU) == 0x07U;
}

void TaggedTsDemux::compact_pending() noexcept
{
    if (pending_offset_ == 0U) {
        return;
    }
    if (pending_size_ != 0U) {
        std::memmove(pending_.get(), pending_.get() + pending_offset_, pending_size_);
    }
    pending_offset_ = 0U;
}

void TaggedTsDemux::discard_bytes(std::size_t count) noexcept
{
    if (count == 0U) {
        return;
    }
    pending_offset_ += count;
    pending_size_ -= count;
    discarded_sync_search_bytes_ += count;
}

void TaggedTsDemux::consume_packet() noexcept
{
    pending_offset_ += kPacketSize;
    pending_size_ -= kPacketSize;
}

bool TaggedTsDemux::acquire_sync() noexcept
{
    const std::size_t required = kSyncPacketCount * kPacketSize;
    if (pending_size_ < required) {
        return false;
    }

    const std::size_t last_start = pending_size_ - required;
    for (std::size_t start = 0U; start <= last_start; ++start) {
        bool valid = true;
        for (std::size_t packet = 0U; packet < kSyncPacketCount; ++packet) {
            if (!is_packet_boundary(
                    pending_[pending_offset_ + start + (packet * kPacketSize)])) {
                valid = false;
                break;
            }
        }
        if (valid) {
            discard_bytes(start);
            return true;
        }
    }

    // Keep enough trailing bytes for a four-packet sequence whose first byte
    // arrives in the next push. This is also what prevents unbounded growth
    // when the input is a long run of garbage.
    discard_bytes(pending_size_ - (required - 1U));
    return false;
}

Result<void> TaggedTsDemux::push(ByteView input, PacketSink sink, void* context,
                                 InvalidTagObserver observer,
                                 void* observer_context) noexcept
{
    if (sink == nullptr || (input.size != 0U && input.data == nullptr) ||
        input.size > kMaxStreamTransfer) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    if (pending_ == nullptr) {
        return Result<void>::failure(Error::INTERNAL);
    }
    if (pending_size_ > kPendingCapacity ||
        input.size > kPendingCapacity - pending_size_) {
        return Result<void>::failure(Error::SLOW_CONSUMER);
    }

    if (input.size != 0U) {
        const std::size_t available_tail =
            kPendingCapacity - pending_offset_ - pending_size_;
        if (input.size > available_tail) {
            compact_pending();
        }
        std::memcpy(pending_.get() + pending_offset_ + pending_size_, input.data,
                    input.size);
        pending_size_ += input.size;
        input_bytes_accepted_ += input.size;
    }

    while (true) {
        if (!synchronized_) {
            if (!acquire_sync()) {
                return Result<void>::success();
            }
            synchronized_ = true;
        }

        if (pending_size_ < kPacketSize) {
            return Result<void>::success();
        }

        if (!is_packet_boundary(pending_[pending_offset_])) {
            synchronized_ = false;
            ++sync_loss_events_;
            discard_bytes(1U);
            continue;
        }

        const std::uint8_t wire_sync = pending_[pending_offset_];
        const std::uint8_t tag =
            static_cast<std::uint8_t>((wire_sync >> 4U) & 0x07U);
        if (tag == 0U || tag > 4U || (wire_sync & 0x80U) != 0U) {
            ++invalid_tag_packets_;
            if ((wire_sync & 0x80U) != 0U && observer != nullptr)
                observer(observer_context, wire_sync);
            consume_packet();
            continue;
        }

        std::uint8_t packet[kPacketSize];
        std::memcpy(packet, pending_.get() + pending_offset_, kPacketSize);
        packet[0U] = 0x47U;
        const Result<void> result =
            sink(context, static_cast<std::size_t>(tag - 1U), ByteView{packet, kPacketSize});
        if (!result) {
            return result;
        }
        ++emitted_packets_;
        consume_packet();
    }
}

void TaggedTsDemux::reset() noexcept
{
    pending_offset_ = 0U;
    pending_size_ = 0U;
    synchronized_ = false;
    input_bytes_accepted_ = 0U;
    emitted_packets_ = 0U;
    discarded_sync_search_bytes_ = 0U;
    invalid_tag_packets_ = 0U;
    sync_loss_events_ = 0U;
}

TaggedTsDemux::Counters TaggedTsDemux::counters() const noexcept
{
    return Counters{input_bytes_accepted_, emitted_packets_, discarded_sync_search_bytes_,
                    invalid_tag_packets_, sync_loss_events_, pending_size_};
}

}  // namespace px4::userland
