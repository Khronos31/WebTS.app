// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_TUNER_SERVICE_H
#define PX4_USERLAND_TUNER_SERVICE_H

#include "px4/error.h"
#include "px4/ipc.h"

#include <array>
#include <cstdint>
#include <mutex>

namespace px4::userland {

// Portable seam for the physical receiver implementation.  It deliberately
// contains no transport, operating-system, or frontend implementation types.
class TunerServiceBackend {
public:
    virtual ~TunerServiceBackend() noexcept = default;
    virtual Result<void> open_receiver(std::uint8_t receiver) noexcept = 0;
    virtual Result<void> tune_terrestrial(std::uint8_t receiver,
                                          std::uint32_t frequency_khz,
                                          std::uint32_t timeout_ms) noexcept = 0;
    virtual Result<void> tune_satellite(std::uint8_t receiver,
                                        std::uint32_t frequency_khz,
                                        std::uint32_t timeout_ms) noexcept = 0;
    virtual Result<bool> is_locked(std::uint8_t receiver,
                                   ipc::System system) noexcept = 0;
    // The post-lock settle is a Q3U4/px4_drv device policy, not a generic
    // tuner-service requirement. Production Q3U4 enables it explicitly;
    // compatibility/test backends retain their existing timing contract.
    virtual bool requires_terrestrial_lock_settle() const noexcept
    {
        return false;
    }
    virtual Result<void> select_satellite_slot(std::uint8_t receiver,
                                               std::uint8_t slot,
                                               std::uint32_t timeout_ms) noexcept = 0;
    virtual Result<void> select_satellite_tsid(std::uint8_t receiver,
                                               std::uint16_t tsid,
                                               std::uint32_t timeout_ms) noexcept = 0;
    virtual Result<void> close_receiver(std::uint8_t receiver) noexcept = 0;
    // Transactional LNB seam. begin_tune_power() runs before any frontend
    // tune operation. A later failure is paired with rollback_tune_power();
    // only a fully successful tune is paired with commit_tune_power(). The
    // default keeps non-Q3U4/test backends at 0 V and rejects 15 V safely.
    virtual Result<void> begin_tune_power(std::uint8_t receiver,
                                          ipc::System system,
                                          std::uint8_t lnb_voltage) noexcept
    {
        (void)receiver;
        (void)system;
        return lnb_voltage == 0U ? Result<void>::success()
                                 : Result<void>::failure(Error::UNSUPPORTED);
    }
    virtual Result<void> commit_tune_power(std::uint8_t receiver) noexcept
    {
        (void)receiver;
        return Result<void>::success();
    }
    virtual Result<void> rollback_tune_power(std::uint8_t receiver) noexcept
    {
        (void)receiver;
        return Result<void>::success();
    }
    // Metadata-only transport-loss notification. It must not perform USB or
    // frontend I/O. Production uses it to make per-bridge power authorities
    // terminal before any later rollback/shutdown path can issue a write.
    virtual void mark_receiver_disconnected(std::uint8_t receiver) noexcept
    {
        (void)receiver;
    }
    // Called after all logical leases have been released. Production uses it
    // to retry any ambiguous zero-reference LNB shutdown before transports
    // are destroyed.
    virtual Result<void> shutdown() noexcept { return Result<void>::success(); }
    // Capture is deliberately a per-receiver lifecycle seam.  The stream
    // transport is owned by a later increment; these calls only control the
    // frontend TS pin.
    virtual Result<void> start_capture(std::uint8_t receiver,
                                       ipc::System system) noexcept
    {
        (void)receiver;
        (void)system;
        return Result<void>::failure(Error::UNSUPPORTED);
    }
    virtual Result<void> stop_capture(std::uint8_t receiver,
                                      ipc::System system) noexcept
    {
        (void)receiver;
        (void)system;
        return Result<void>::failure(Error::UNSUPPORTED);
    }
};

class TunerNonceSource {
public:
    virtual ~TunerNonceSource() noexcept = default;
    virtual Result<std::array<std::uint8_t, ipc::kNonceLength>> generate()
        noexcept = 0;
};

// The service uses its internal nonzero sequence by default.  This optional
// source is for deterministic platform policy and collision/wrap tests.
class TunerLeaseIdSource {
public:
    virtual ~TunerLeaseIdSource() noexcept = default;
    virtual Result<std::uint64_t> next() noexcept = 0;
};

class TunerAttachmentIdSource {
public:
    virtual ~TunerAttachmentIdSource() noexcept = default;
    virtual Result<std::uint64_t> next() noexcept = 0;
};

class TunerServiceTime {
public:
    virtual ~TunerServiceTime() noexcept = default;
    virtual std::uint64_t monotonic_ms() noexcept = 0;
    virtual void sleep_ms(std::uint32_t milliseconds) noexcept = 0;
};

struct TunerAcquireResult final {
    std::uint64_t lease_id = 0U;
    std::array<std::uint8_t, ipc::kNonceLength> nonce{};
};

struct TunerAttachment final {
    std::uint64_t owner_client_id = 0U;
    std::uint64_t lease_id = 0U;
    std::uint64_t attachment_id = 0U;
    std::uint8_t receiver = 0U;
    ipc::System system = ipc::System::ISDB_T;
    std::array<std::uint8_t, ipc::kNonceLength> nonce{};
};

// Transport-independent final stream accounting.  A stream implementation
// may retain one snapshot per stale-safe attachment identity after detach;
// this keeps the final STATS/STREAM_END value independent of a stats-before-
// detach race in a later control increment.
struct TunerStreamCounters final {
    std::uint64_t packets = 0U;
    std::uint64_t bytes = 0U;
    std::uint64_t sync_errors = 0U;
    std::uint64_t tei_packets = 0U;
    std::uint64_t continuity_errors = 0U;
    std::uint64_t queue_drops = 0U;
    std::uint64_t usb_errors = 0U;
    std::uint64_t empty_intervals = 0U;
};

struct TunerStreamFinalSnapshot final {
    TunerStreamCounters counters{};
    std::uint8_t terminal = 0U;
};

enum class TunerStreamTerminal : std::uint8_t {
    none = 0,
    slow_consumer = 1,
    usb_error = 2,
    sync_error = 3,
    bridge_fatal = 4,
    stopped = 5,
    disconnected = 6,
};

struct TunerStreamReadResult final {
    std::size_t bytes = 0U;
    bool eof = false;
    bool timed_out = false;
    TunerStreamTerminal terminal = TunerStreamTerminal::none;
};

struct TunerStatus final {
    std::uint64_t generation = 1U;
    std::array<ipc::ReceiverState, ipc::kReceiverCount> receiver_states{};
};

// Optional data-plane seam.  It is called while the receiver-local service
// lock is held, so registration and frontend pin lifetime are one operation.
// Implementations must logically invalidate the identity and wake readers
// before detach returns, even when physical cleanup returns an error.  They
// may retain the final counters by this exact identity for a later
// final_snapshot() query; callers must not reconstruct them with a
// stats-before-detach sequence.
class TunerStreamControl {
public:
    virtual ~TunerStreamControl() noexcept = default;
    virtual Result<void> attach(const TunerAttachment& attachment) noexcept = 0;
    virtual Result<void> detach(const TunerAttachment& attachment) noexcept = 0;
    // For an attached identity this is the live counter snapshot.  A stream
    // implementation must retain the exact final snapshot at its detach
    // linearization point; the service never emulates STOP with a
    // stats-before-detach query.
    // A stream control that returns UNSUPPORTED does not provide the required
    // final snapshot and therefore cannot complete STOP successfully.
    virtual Result<TunerStreamCounters> stats(
        const TunerAttachment& attachment) const noexcept
    {
        (void)attachment;
        return Result<TunerStreamCounters>::failure(Error::UNSUPPORTED);
    }
    virtual Result<TunerStreamFinalSnapshot> final_snapshot(
        const TunerAttachment& attachment) const noexcept
    {
        (void)attachment;
        return Result<TunerStreamFinalSnapshot>::failure(Error::UNSUPPORTED);
    }
    // Releases the retained post-detach queue/session after the data endpoint
    // has flushed STREAM_END.  It never performs hardware I/O.
    virtual Result<void> release_final(const TunerAttachment& attachment) noexcept
    {
        (void)attachment;
        return Result<void>::failure(Error::UNSUPPORTED);
    }
    virtual Result<TunerStreamReadResult> read(
        const TunerAttachment& attachment, MutableByteView output,
        Timeout timeout) noexcept
    {
        (void)attachment;
        (void)output;
        (void)timeout;
        return Result<TunerStreamReadResult>::failure(Error::UNSUPPORTED);
    }
    virtual Result<TunerStreamTerminal> terminal(
        const TunerAttachment& attachment) const noexcept
    {
        (void)attachment;
        return Result<TunerStreamTerminal>::failure(Error::UNSUPPORTED);
    }
};

class TunerService final {
public:
    TunerService(TunerServiceBackend& backend, TunerNonceSource& nonce_source,
                 TunerServiceTime& time,
                 TunerLeaseIdSource* lease_id_source = nullptr,
                 TunerAttachmentIdSource* attachment_id_source = nullptr,
                 TunerStreamControl* stream_control = nullptr) noexcept;
    ~TunerService() noexcept;

    TunerService(const TunerService&) = delete;
    TunerService& operator=(const TunerService&) = delete;

    Result<TunerAcquireResult> acquire(std::uint64_t client_id,
                                      std::uint8_t receiver) noexcept;
    Result<void> release(std::uint64_t client_id, std::uint64_t lease_id) noexcept;
    Result<ipc::TuneResponsePayload> tune(
        std::uint64_t client_id, const ipc::TuneRequestPayload& request) noexcept;
    Result<void> start_stream(std::uint64_t client_id,
                              std::uint64_t lease_id) noexcept;
    Result<TunerAttachment> attach_stream(
        std::uint64_t lease_id,
        const std::array<std::uint8_t, ipc::kNonceLength>& nonce) noexcept;
    Result<TunerStreamFinalSnapshot> stop_stream(
        std::uint64_t client_id, std::uint64_t lease_id) noexcept;
    Result<TunerStreamCounters> stats(std::uint64_t client_id,
                                      std::uint64_t lease_id) const noexcept;
    Result<void> detach_stream(const TunerAttachment& attachment) noexcept;
    // This operation is metadata-only and never waits for receiver I/O.
    Result<void> revoke_stream(std::uint64_t client_id,
                               std::uint64_t lease_id) noexcept;
    // Data-endpoint cleanup variant.  The nonce is checked while the same
    // registry mutex is held, so an invalid ATTACH cannot revoke a valid
    // credential for the lease it guessed.
    Result<void> revoke_stream(
        std::uint64_t client_id, std::uint64_t lease_id,
        const std::array<std::uint8_t, ipc::kNonceLength>& nonce) noexcept;
    Result<TunerStatus> status() const noexcept;
    Result<void> disconnect_client(std::uint64_t client_id) noexcept;
    Result<void> shutdown() noexcept;

private:
    enum class StreamState : std::uint8_t {
        none,
        armed,
        attaching,
        active,
        revoked,
        consumed,
    };

    struct Lease final {
        bool active = false;
        std::uint64_t client_id = 0U;
        std::uint64_t lease_id = 0U;
        std::uint8_t receiver = 0U;
        ipc::System system = ipc::System::ISDB_T;
        std::array<std::uint8_t, ipc::kNonceLength> nonce{};
        std::uint64_t attachment_id = 0U;
        StreamState stream_state = StreamState::none;
        std::uint64_t attach_started_ms = 0U;
        // A failed or revoked start may have partially enabled the pin.  Keep
        // this flag until physical cleanup has been attempted.
        bool capture_maybe_active = false;
        bool stream_maybe_attached = false;
        bool backend_disconnected = false;
    };

    static bool valid_client(std::uint64_t client_id) noexcept;
    static bool valid_receiver(std::uint8_t receiver) noexcept;
    static ipc::System receiver_system(std::uint8_t receiver) noexcept;
    static bool valid_tune(const ipc::TuneRequestPayload& request) noexcept;
    int find_lease_locked(std::uint64_t client_id,
                          std::uint64_t lease_id) const noexcept;
    bool lease_id_in_use_locked(std::uint64_t lease_id) const noexcept;
    bool attachment_id_in_use_locked(std::uint64_t attachment_id) const noexcept;
    Result<std::uint64_t> allocate_lease_id_locked(std::uint8_t receiver) noexcept;
    Result<std::uint64_t> allocate_attachment_id_locked(
        std::uint8_t receiver) noexcept;
    void set_state_locked(std::uint8_t receiver, ipc::ReceiverState state) noexcept;
    Result<void> close_lease(const Lease& lease) noexcept;
    Result<void> stop_capture_if_needed(const Lease& lease) noexcept;
    Result<void> detach_data_plane_if_needed(const Lease& lease) noexcept;
    Result<void> release_lease(std::uint64_t client_id,
                               std::uint64_t lease_id) noexcept;
    Result<void> cleanup_client(std::uint64_t client_id) noexcept;
    Result<void> cleanup_all() noexcept;
    void observe_disconnect(std::uint8_t receiver, Error error) noexcept;
    Result<bool> poll_lock(std::uint8_t receiver, ipc::System system,
                           std::uint64_t start_ms,
                           std::uint32_t timeout_ms) noexcept;

    TunerServiceBackend& backend_;
    TunerNonceSource& nonce_source_;
    TunerServiceTime& time_;
    TunerLeaseIdSource* lease_id_source_;
    TunerAttachmentIdSource* attachment_id_source_;
    TunerStreamControl* stream_control_;
    std::uint64_t next_lease_id_ = 1U;
    std::uint64_t next_attachment_id_ = 1U;
    std::uint64_t last_attachment_id_ = 0U;
    std::uint64_t generation_ = 1U;
    std::array<Lease, ipc::kReceiverCount> leases_{};
    std::array<std::uint64_t, ipc::kReceiverCount> reserved_lease_ids_{};
    std::array<std::uint64_t, ipc::kReceiverCount> reserved_attachment_ids_{};
    std::array<ipc::ReceiverState, ipc::kReceiverCount> states_{};
    mutable std::mutex mutex_;
    mutable std::array<std::mutex, ipc::kReceiverCount> receiver_mutexes_{};
};

}  // namespace px4::userland

#endif  // PX4_USERLAND_TUNER_SERVICE_H
