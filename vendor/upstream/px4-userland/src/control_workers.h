// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_CONTROL_WORKERS_H
#define PX4_USERLAND_CONTROL_WORKERS_H

#include "px4/card_service.h"
#include "px4/tuner_service.h"

#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>

namespace px4::userland::ipc::posix {

inline constexpr std::size_t kControlWorkerQueueCapacity = 64U;

#if defined(PX4_CONTROL_WORKERS_TEST_ACCESS)
// Private construction seam used only by offline tests to exercise startup
// rollback. Production callers use create(), with no failure injection.
struct ControlWorkerStartupOptions final {
    bool fail_wake_pipe = false;
    int fail_lane = -1;
    bool fail_tuner_attach_submit = false;
    void (*before_tuner_attach_completion)(void*) noexcept = nullptr;
    void* before_tuner_attach_completion_context = nullptr;
};
#endif

enum class ControlWorkerLane : std::uint8_t {
    tuner_dev1,
    tuner_dev2,
    card,
};

enum class ControlWorkerOperation : std::uint8_t {
    tuner_acquire,
    tuner_release,
    tuner_tune,
    tuner_start_stream,
    tuner_stop_stream,
    tuner_stats,
    tuner_attach_stream,
    tuner_detach_stream,
    tuner_status,
    tuner_shutdown,
    card_status,
    card_status_combined,
    card_presence,
    card_connect,
    card_reconnect,
    card_disconnect,
    card_reset,
    card_transmit,
    card_begin_transaction,
    card_end_transaction,
    card_release_connection,
    card_shutdown,
};

// Internal routing/ownership classification. This is separate from
// request_id because zero is a valid wire request ID.
enum class ControlWorkerTaskKind : std::uint8_t {
    client_request,
    cleanup,
    background,
};

// All task fields own their data. In particular, no task contains a Client,
// socket, or view into a StreamFramer buffer.
struct ControlWorkerTask final {
    MessageType type = MessageType::STATUS;
    ControlWorkerTaskKind kind = ControlWorkerTaskKind::client_request;
    ControlWorkerOperation operation = ControlWorkerOperation::tuner_status;
    std::uint64_t client_id = 0U;
    // Stable poll-thread connection identity. For stream clients this is
    // distinct from the control owner in client_id.
    std::uint64_t connection_id = 0U;
    std::uint32_t request_id = 0U;
    std::uint8_t receiver = 0U;
    std::uint64_t lease_id = 0U;
    std::uint64_t card_handle = 0U;
    ShareMode share_mode = ShareMode::shared;
    Disposition disposition = Disposition::leave;
    TuneRequestPayload tune{};
    std::array<std::uint8_t, kMaxCardPayload> apdu{};
    std::size_t apdu_size = 0U;
    std::array<std::uint8_t, kNonceLength> nonce{};
    TunerAttachment attachment{};
    bool attachment_valid = false;
};

struct ControlWorkerCompletion final {
    MessageType type = MessageType::STATUS;
    ControlWorkerTaskKind kind = ControlWorkerTaskKind::client_request;
    ControlWorkerOperation operation = ControlWorkerOperation::tuner_status;
    std::uint64_t client_id = 0U;
    std::uint64_t connection_id = 0U;
    std::uint32_t request_id = 0U;
    std::uint8_t receiver = 0U;
    std::uint64_t lease_id = 0U;
    std::uint64_t card_handle = 0U;
    Error error = Error::OK;
    TunerAcquireResult tuner_acquire{};
    TunerStatus tuner_status{};
    bool tuner_status_valid = false;
    TuneResponsePayload tune_response{};
    TunerStreamCounters stream_counters{};
    TunerStreamFinalSnapshot stream_final_snapshot{};
    bool stream_snapshot_valid = false;
    TunerAttachment tuner_attachment{};
    bool tuner_attachment_valid = false;
    CardServiceStatus card_status{};
    CardPresenceChange card_presence{};
    CardServiceConnectResult card_connect{};
    CardAtr atr{};
    std::array<std::uint8_t, kMaxCardPayload> card_response{};
    std::size_t card_response_size = 0U;
};

class ControlWorkerLanes final {
public:
    static Result<std::unique_ptr<ControlWorkerLanes>> create(
        CardService& card_service, TunerService& tuner_service) noexcept;
#if defined(PX4_CONTROL_WORKERS_TEST_ACCESS)
    static Result<std::unique_ptr<ControlWorkerLanes>> create_for_test(
        CardService& card_service, TunerService& tuner_service,
        const ControlWorkerStartupOptions& options) noexcept;
    static void set_test_startup_options(
        ControlWorkerStartupOptions* options) noexcept;
#endif
    ~ControlWorkerLanes() noexcept;

    ControlWorkerLanes(const ControlWorkerLanes&) = delete;
    ControlWorkerLanes& operator=(const ControlWorkerLanes&) = delete;

    Result<void> submit(ControlWorkerLane lane,
                        const ControlWorkerTask& task) noexcept;
    bool try_pop(ControlWorkerLane lane, ControlWorkerCompletion& completion) noexcept;
#if defined(PX4_CONTROL_WORKERS_TEST_ACCESS)
    std::size_t pending_completions_for_test(ControlWorkerLane lane) const noexcept;
#endif

    int wake_fd() const noexcept;
    void drain_wake() noexcept;
    Error error() const noexcept;
    bool idle() const noexcept;
    std::size_t live_thread_count() const noexcept;
    Result<void> request_stop() noexcept;
    // request_stop() drains accepted tasks but does not consume completions.
    // Callers using join() must drain every completion first. This high-level
    // shutdown helper safely drains/discards completions before joining.
    Result<void> stop_and_join() noexcept;
    Result<void> join() noexcept;

private:
    struct Impl;
    explicit ControlWorkerLanes(std::unique_ptr<Impl> impl) noexcept;
    std::unique_ptr<Impl> impl_;
};

}  // namespace px4::userland::ipc::posix

#endif  // PX4_USERLAND_CONTROL_WORKERS_H
