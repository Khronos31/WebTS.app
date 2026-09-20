/*
 * USB-free, Node-only lifecycle fixture for the upstream Q3U4 data plane.
 * The fake transport is synchronized; Q3U4StreamDataPlane remains the
 * source-backed implementation under test.  This translation unit is never
 * connected to the browser UI or a real transport.
 */
#include "px4/q3u4_stream.h"

#include <array>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <utility>

namespace {

using namespace px4::userland;

constexpr std::size_t kPacketSize = Q3U4StreamDataPlane::kPacketSize;
constexpr std::size_t kPacketCount = 12U;
constexpr std::uint32_t kOk = 0U;
constexpr std::uint32_t kInvalidArgument = 2U;
constexpr std::uint32_t kInternal = 255U;
constexpr std::uint32_t kWords = 10U;

class SynchronizedTransport final : public Transport {
public:
    SynchronizedTransport() noexcept
    {
        constexpr std::array<std::uint8_t, 4U> tags{0x17U, 0x27U, 0x37U, 0x47U};
        for (std::size_t group = 0U; group < 3U; ++group) {
            for (std::size_t receiver = 0U; receiver < tags.size(); ++receiver) {
                const std::size_t packet = group * tags.size() + receiver;
                auto* destination = events_.data() + packet * kPacketSize;
                destination[0U] = tags[receiver];
                destination[1U] = 0U;
                destination[2U] = 1U;
                destination[3U] = static_cast<std::uint8_t>(0x10U | group);
                for (std::size_t offset = 4U; offset < kPacketSize; ++offset)
                    destination[offset] = static_cast<std::uint8_t>(packet + offset);
            }
        }
    }

    Result<std::size_t> bulk_read(std::uint8_t, MutableByteView, Timeout,
                                  BulkReadObservation* observation) noexcept override
    {
        if (observation != nullptr) *observation = BulkReadObservation{};
        return Result<std::size_t>::failure(Error::UNSUPPORTED);
    }

    Result<std::size_t> bulk_write(std::uint8_t, ByteView, Timeout) noexcept override
    {
        return Result<std::size_t>::failure(Error::UNSUPPORTED);
    }

    Result<void> start_stream(const StreamConfig& config) noexcept override
    {
        if (config.endpoint != kTsInEndpoint || config.transfer_size == 0U ||
            config.transfer_count == 0U)
            return Result<void>::failure(Error::INVALID_ARGUMENT);
        std::lock_guard<std::mutex> lock(mutex_);
        if (active_) return Result<void>::failure(Error::BUSY);
        active_ = true;
        event_sent_ = false;
        return Result<void>::success();
    }

    Result<StreamEvent> wait_stream(Timeout) noexcept override
    {
        std::unique_lock<std::mutex> lock(mutex_);
        if (!active_) return Result<StreamEvent>::failure(Error::DISCONNECTED);
        if (!event_sent_) {
            changed_.wait(lock, [this]() noexcept { return event_released_ || !active_; });
            if (!active_) return Result<StreamEvent>::failure(Error::DISCONNECTED);
            event_sent_ = true;
            return Result<StreamEvent>::success(
                StreamEvent{StreamEventKind::data, events_.data(), events_.size()});
        }
        changed_.wait(lock, [this]() noexcept { return !active_; });
        return Result<StreamEvent>::failure(Error::DISCONNECTED);
    }

    void release_event() noexcept
    {
        std::lock_guard<std::mutex> lock(mutex_);
        event_released_ = true;
        changed_.notify_all();
    }

    Result<void> cancel_stream() noexcept override
    {
        std::lock_guard<std::mutex> lock(mutex_);
        active_ = false;
        changed_.notify_all();
        return Result<void>::success();
    }

    Result<void> stop_stream() noexcept override
    {
        std::lock_guard<std::mutex> lock(mutex_);
        active_ = false;
        changed_.notify_all();
        return Result<void>::success();
    }

    bool stream_active() const noexcept override
    {
        std::lock_guard<std::mutex> lock(mutex_);
        return active_;
    }

private:
    mutable std::mutex mutex_;
    std::condition_variable changed_;
    std::array<std::uint8_t, kPacketCount * kPacketSize> events_{};
    bool active_ = false;
    bool event_sent_ = false;
    bool event_released_ = false;
};

struct PacketObservation final {
    std::mutex mutex;
    std::condition_variable changed;
    std::size_t receiver_zero_packets = 0U;
    std::size_t receiver_three_packets = 0U;
};

void observe_packet(void* opaque, std::uint8_t receiver) noexcept
{
    auto* observation = static_cast<PacketObservation*>(opaque);
    if (observation == nullptr || (receiver != 0U && receiver != 3U)) return;
    std::lock_guard<std::mutex> lock(observation->mutex);
    if (receiver == 0U) ++observation->receiver_zero_packets;
    if (receiver == 3U) ++observation->receiver_three_packets;
    observation->changed.notify_all();
}

TunerAttachment fixture_attachment() noexcept
{
    TunerAttachment attachment{};
    attachment.owner_client_id = 1U;
    attachment.lease_id = 2U;
    attachment.attachment_id = 3U;
    attachment.receiver = 0U;
    attachment.system = ipc::System::ISDB_S;
    attachment.nonce.fill(0x5aU);
    return attachment;
}

std::uint32_t run_fixture(std::uint32_t* output) noexcept
{
#define FAIL() do { return kInternal; } while (false)
    SynchronizedTransport dev1;
    SynchronizedTransport dev2;
    PacketObservation observed;
    auto attachment = fixture_attachment();
    std::array<TunerAttachment, 4U> attachments{};
    for (std::size_t receiver = 0U; receiver < attachments.size(); ++receiver) {
        attachments[receiver] = attachment;
        attachments[receiver].receiver = static_cast<std::uint8_t>(receiver);
        attachments[receiver].system = receiver < 2U ? ipc::System::ISDB_S
                                                       : ipc::System::ISDB_T;
        attachments[receiver].attachment_id += receiver;
    }
    auto created = Q3U4StreamDataPlane::create_for_test(
        dev1, dev2, Q3U4StreamDataPlane::kMinQueuePackets,
        Q3U4StreamDataPlane::StartupStabilizationTestConfig{0U, 0U, 0U});
    if (!created) FAIL();
    auto plane = std::move(created.value());
    plane->set_packet_enqueue_observer_for_test(&observe_packet, &observed);
    for (const auto& receiver : attachments)
        if (!plane->attach(receiver)) FAIL();
    dev1.release_event();

    {
        std::unique_lock<std::mutex> lock(observed.mutex);
        if (!observed.changed.wait_for(lock, std::chrono::seconds(2U), [&]() noexcept {
            return observed.receiver_zero_packets >= 2U &&
                       observed.receiver_three_packets >= 2U;
            }))
            FAIL();
    }

    std::array<std::uint8_t, kPacketSize> read_buffer{};
    const auto stats = plane->stats(attachments[0]);
    const auto read = plane->read(attachments[0], MutableByteView{read_buffer.data(), read_buffer.size()},
                                  Timeout{0U});
    if (!stats || !read || read.value().bytes != kPacketSize || stats.value().packets == 0U)
        FAIL();
    for (auto it = attachments.rbegin(); it != attachments.rend(); ++it)
        if (!plane->detach(*it)) FAIL();
    const auto final = plane->final_snapshot(attachments[0]);
    if (!final || final.value().counters.bytes != stats.value().bytes)
        FAIL();
    for (const auto& receiver : attachments)
        if (!plane->release_final(receiver)) FAIL();
    if (!plane->shutdown()) FAIL();

    output[1U] = 1U;
    output[2U] = static_cast<std::uint32_t>(read.value().bytes);
    output[3U] = static_cast<std::uint32_t>(stats.value().packets);
    output[4U] = static_cast<std::uint32_t>(stats.value().bytes);
    output[5U] = static_cast<std::uint32_t>(final.value().terminal);
    output[6U] = 1U;
    output[7U] = 1U;
    output[8U] = 1U;
#undef FAIL
    return kOk;
}

}  // namespace

extern "C" std::uint32_t webts_px4_stream_lifecycle_mock(
    std::uint32_t output_ptr, std::uint32_t output_words) noexcept
{
    if (output_ptr == 0U || output_words < kWords) return kInvalidArgument;
    auto* output = reinterpret_cast<std::uint32_t*>(static_cast<std::uintptr_t>(output_ptr));
    for (std::uint32_t index = 0U; index < kWords; ++index) output[index] = 0U;
    const auto diagnostic = run_fixture(output);
    output[0U] = diagnostic;
    return diagnostic;
}
