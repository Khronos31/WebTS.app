// SPDX-License-Identifier: GPL-2.0-only
#include "px4/tuner_service.h"

#include <algorithm>
#include <cstddef>
#include <limits>

namespace px4::userland {
namespace {

// px4_drv/driver/ptx_chrdev.c:356-359, enabled by
// px4_drv/driver/px4_device.c:1258 (PTX_CHRDEV_WAIT_AFTER_LOCK_TC_T).
// The terrestrial lock path settles for 340 ms from check_lock start.
constexpr std::uint32_t kWaitAfterLockTcTMs = 340U;

}  // namespace

TunerService::TunerService(TunerServiceBackend& backend,
                           TunerNonceSource& nonce_source,
                           TunerServiceTime& time,
                           TunerLeaseIdSource* lease_id_source,
                           TunerAttachmentIdSource* attachment_id_source,
                           TunerStreamControl* stream_control) noexcept
    : backend_(backend), nonce_source_(nonce_source), time_(time),
      lease_id_source_(lease_id_source),
      attachment_id_source_(attachment_id_source), stream_control_(stream_control)
{
    states_.fill(ipc::ReceiverState::free);
}

TunerService::~TunerService() noexcept
{
    (void)shutdown();
}

bool TunerService::valid_client(std::uint64_t client_id) noexcept
{
    return client_id != 0U;
}

bool TunerService::valid_receiver(std::uint8_t receiver) noexcept
{
    return receiver < ipc::kReceiverCount;
}

ipc::System TunerService::receiver_system(std::uint8_t receiver) noexcept
{
    return (receiver == 0U || receiver == 1U || receiver == 4U || receiver == 5U)
        ? ipc::System::ISDB_S
        : ipc::System::ISDB_T;
}

bool TunerService::valid_tune(const ipc::TuneRequestPayload& request) noexcept
{
    if (request.frequency_khz > std::numeric_limits<std::uint32_t>::max())
        return false;
    if (request.timeout_ms < 100U || request.timeout_ms > 30000U) return false;

    if (request.system == ipc::System::ISDB_T) {
        return request.frequency_khz >= 40000U &&
               request.frequency_khz <= 1002000U &&
               request.stream_id == 0xffffU && request.slot == 0xffffU &&
               request.bandwidth_hz == 6000000U && request.lnb_voltage == 0U;
    }
    if (request.system != ipc::System::ISDB_S || request.frequency_khz < 146875U ||
        request.frequency_khz > 2350000U || request.bandwidth_hz != 0U)
        return false;
    if (request.lnb_voltage != 0U && request.lnb_voltage != 15U) return false;
    const bool has_stream_id = request.stream_id != 0xffffU;
    const bool has_slot = request.slot != 0xffffU;
    return has_stream_id != has_slot && (!has_slot || request.slot < 12U);
}

int TunerService::find_lease_locked(std::uint64_t client_id,
                                    std::uint64_t lease_id) const noexcept
{
    if (!valid_client(client_id) || lease_id == 0U) return -1;
    for (std::size_t index = 0U; index < leases_.size(); ++index) {
        const Lease& lease = leases_[index];
        if (lease.active && lease.client_id == client_id &&
            lease.lease_id == lease_id)
            return static_cast<int>(index);
    }
    return -1;
}

bool TunerService::lease_id_in_use_locked(std::uint64_t lease_id) const noexcept
{
    if (lease_id == 0U) return true;
    for (const Lease& lease : leases_) {
        if (lease.active && lease.lease_id == lease_id) return true;
    }
    for (const std::uint64_t reserved : reserved_lease_ids_) {
        if (reserved == lease_id) return true;
    }
    return false;
}

bool TunerService::attachment_id_in_use_locked(
    std::uint64_t attachment_id) const noexcept
{
    if (attachment_id == 0U) return true;
    for (const Lease& lease : leases_) {
        if (lease.active && lease.attachment_id == attachment_id) return true;
    }
    for (const std::uint64_t reserved : reserved_attachment_ids_) {
        if (reserved == attachment_id) return true;
    }
    return false;
}

Result<std::uint64_t> TunerService::allocate_lease_id_locked(
    std::uint8_t receiver) noexcept
{
    constexpr std::size_t kMaxAttempts = ipc::kReceiverCount + 8U;
    for (std::size_t attempt = 0U; attempt < kMaxAttempts; ++attempt) {
        std::uint64_t candidate = 0U;
        if (lease_id_source_ != nullptr) {
            const auto next = lease_id_source_->next();
            if (!next) return Result<std::uint64_t>::failure(next.error());
            candidate = next.value();
        } else {
            candidate = next_lease_id_;
            next_lease_id_ = candidate == std::numeric_limits<std::uint64_t>::max()
                ? 1U
                : candidate + 1U;
        }
        if (candidate == 0U) {
            return Result<std::uint64_t>::failure(Error::INVALID_ARGUMENT);
        }
        if (!lease_id_in_use_locked(candidate)) {
            reserved_lease_ids_[receiver] = candidate;
            return Result<std::uint64_t>::success(candidate);
        }
    }
    return Result<std::uint64_t>::failure(Error::BUSY);
}

Result<std::uint64_t> TunerService::allocate_attachment_id_locked(
    std::uint8_t receiver) noexcept
{
    constexpr std::size_t kMaxAttempts = ipc::kReceiverCount + 8U;
    for (std::size_t attempt = 0U; attempt < kMaxAttempts; ++attempt) {
        std::uint64_t candidate = 0U;
        if (attachment_id_source_ != nullptr) {
            const auto next = attachment_id_source_->next();
            if (!next) return Result<std::uint64_t>::failure(next.error());
            candidate = next.value();
        } else {
            candidate = next_attachment_id_;
            next_attachment_id_ = candidate == std::numeric_limits<std::uint64_t>::max()
                ? 0U
                : candidate + 1U;
        }
        if (candidate == 0U) {
            return Result<std::uint64_t>::failure(Error::BUSY);
        }
        // Attachment identities are never reused during this service
        // lifetime.  This remains true even when a deterministic test source
        // offers a stale numeric value after the old stream detached.
        if (candidate > last_attachment_id_ &&
            !attachment_id_in_use_locked(candidate)) {
            reserved_attachment_ids_[receiver] = candidate;
            last_attachment_id_ = candidate;
            return Result<std::uint64_t>::success(candidate);
        }
    }
    return Result<std::uint64_t>::failure(Error::BUSY);
}

void TunerService::set_state_locked(std::uint8_t receiver,
                                    ipc::ReceiverState state) noexcept
{
    if (states_[receiver] != state) {
        states_[receiver] = state;
        ++generation_;
    }
}

Result<TunerAcquireResult> TunerService::acquire(std::uint64_t client_id,
                                                 std::uint8_t receiver) noexcept
{
    if (!valid_client(client_id) || !valid_receiver(receiver))
        return Result<TunerAcquireResult>::failure(Error::INVALID_ARGUMENT);
    std::unique_lock<std::mutex> receiver_lock(receiver_mutexes_[receiver]);
    std::array<std::uint8_t, ipc::kNonceLength> nonce_value{};
    std::uint64_t lease_id_value = 0U;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (leases_[receiver].active)
            return Result<TunerAcquireResult>::failure(Error::BUSY);
        if (states_[receiver] == ipc::ReceiverState::error)
            return Result<TunerAcquireResult>::failure(Error::NOT_READY);

        const auto nonce = nonce_source_.generate();
        if (!nonce) return Result<TunerAcquireResult>::failure(nonce.error());
        const auto lease_id = allocate_lease_id_locked(receiver);
        if (!lease_id)
            return Result<TunerAcquireResult>::failure(lease_id.error());
        nonce_value = nonce.value();
        lease_id_value = lease_id.value();
    }

    const auto opened = backend_.open_receiver(receiver);
    if (!opened) {
        observe_disconnect(receiver, opened.error());
        std::lock_guard<std::mutex> lock(mutex_);
        reserved_lease_ids_[receiver] = 0U;
        return Result<TunerAcquireResult>::failure(opened.error());
    }

    std::lock_guard<std::mutex> lock(mutex_);
    // receiver_lock prevents another operation from changing this slot while
    // the backend open is in flight.
    Lease& lease = leases_[receiver];
    reserved_lease_ids_[receiver] = 0U;
    lease.active = true;
    lease.client_id = client_id;
    lease.lease_id = lease_id_value;
    lease.receiver = receiver;
    lease.system = receiver_system(receiver);
    lease.nonce = nonce_value;
    set_state_locked(receiver, ipc::ReceiverState::leased);
    return Result<TunerAcquireResult>::success(
        TunerAcquireResult{lease.lease_id, lease.nonce});
}

void TunerService::observe_disconnect(std::uint8_t receiver, Error error) noexcept
{
    if (error == Error::DISCONNECTED) {
        backend_.mark_receiver_disconnected(receiver);
    }
}

Result<void> TunerService::close_lease(const Lease& lease) noexcept
{
    const auto result = backend_.close_receiver(lease.receiver);
    observe_disconnect(lease.receiver, result.error());
    return result;
}

Result<void> TunerService::stop_capture_if_needed(const Lease& lease) noexcept
{
    if (lease.backend_disconnected)
        return Result<void>::failure(Error::DISCONNECTED);
    if (!lease.capture_maybe_active) return Result<void>::success();
    const auto result = backend_.stop_capture(lease.receiver, lease.system);
    observe_disconnect(lease.receiver, result.error());
    return result;
}

Result<void> TunerService::detach_data_plane_if_needed(const Lease& lease) noexcept
{
    if (!lease.stream_maybe_attached || stream_control_ == nullptr)
        return Result<void>::success();
    const auto result = stream_control_->detach(TunerAttachment{
        lease.client_id, lease.lease_id, lease.attachment_id, lease.receiver,
        lease.system, lease.nonce});
    observe_disconnect(lease.receiver, result.error());
    return result;
}

Result<void> TunerService::release_lease(std::uint64_t client_id,
                                         std::uint64_t lease_id) noexcept
{
    std::uint8_t receiver = 0U;
    if (!valid_client(client_id) || lease_id == 0U)
        return Result<void>::failure(Error::NOT_FOUND);
    {
        std::lock_guard<std::mutex> lock(mutex_);
        const int index = find_lease_locked(client_id, lease_id);
        if (index < 0) return Result<void>::failure(Error::NOT_FOUND);
        receiver = leases_[static_cast<std::size_t>(index)].receiver;
        // Linearize cleanup with ATTACH before waiting for the receiver
        // operation.  ATTACH will compensate if its finite start is already
        // in progress.
        const StreamState stream = leases_[receiver].stream_state;
        if (stream == StreamState::armed || stream == StreamState::attaching ||
            stream == StreamState::active)
            leases_[receiver].stream_state = StreamState::revoked;
    }

    std::unique_lock<std::mutex> receiver_lock(receiver_mutexes_[receiver]);
    Lease lease;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        const int index = find_lease_locked(client_id, lease_id);
        if (index < 0) return Result<void>::failure(Error::NOT_FOUND);
        lease = leases_[static_cast<std::size_t>(index)];
        leases_[static_cast<std::size_t>(index)] = Lease{};
        set_state_locked(receiver, ipc::ReceiverState::free);
    }

    Error first = Error::OK;
    const auto detached = detach_data_plane_if_needed(lease);
    const bool detach_clean = detached || detached.error() == Error::NOT_FOUND;
    if (!detach_clean) first = detached.error();
    const bool disconnected = lease.backend_disconnected ||
                              detached.error() == Error::DISCONNECTED;
    const auto stopped = disconnected
        ? Result<void>::failure(Error::DISCONNECTED)
        : stop_capture_if_needed(lease);
    if (!stopped && first == Error::OK) first = stopped.error();
    // A disconnected transport is terminal for this cleanup path; do not
    // issue a later close write to the same device.
    if (!disconnected &&
        stopped.error() != Error::DISCONNECTED) {
        const auto closed = close_lease(lease);
        if (!closed && first == Error::OK) first = closed.error();
    }
    if (!detach_clean || !stopped || disconnected) {
        std::lock_guard<std::mutex> lock(mutex_);
        set_state_locked(receiver, ipc::ReceiverState::error);
    }
    return first == Error::OK ? Result<void>::success()
                              : Result<void>::failure(first);
}

Result<void> TunerService::release(std::uint64_t client_id,
                                   std::uint64_t lease_id) noexcept
{
    return release_lease(client_id, lease_id);
}

Result<bool> TunerService::poll_lock(std::uint8_t receiver,
                                     ipc::System system,
                                     std::uint64_t start_ms,
                                     std::uint32_t timeout_ms) noexcept
{
    const std::size_t max_polls = static_cast<std::size_t>(timeout_ms / 10U) + 1U;
    for (std::size_t count = 0U; count < max_polls; ++count) {
        const std::uint64_t before = time_.monotonic_ms();
        if (before - start_ms >= timeout_ms) break;
        const auto locked = backend_.is_locked(receiver, system);
        if (!locked) {
            observe_disconnect(receiver, locked.error());
            return Result<bool>::failure(locked.error());
        }
        if (locked.value()) return Result<bool>::success(true);

        const std::uint64_t now = time_.monotonic_ms();
        const std::uint64_t elapsed = now - start_ms;
        if (elapsed >= timeout_ms || count + 1U == max_polls)
            break;
        const std::uint64_t remaining = timeout_ms - elapsed;
        if (remaining < 10U) break;
        time_.sleep_ms(10U);
    }
    return Result<bool>::success(false);
}

Result<ipc::TuneResponsePayload> TunerService::tune(
    std::uint64_t client_id, const ipc::TuneRequestPayload& request) noexcept
{
    std::uint8_t receiver = 0U;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        const int index = find_lease_locked(client_id, request.lease_id);
        if (index < 0)
            return Result<ipc::TuneResponsePayload>::failure(Error::NOT_FOUND);
        receiver = leases_[static_cast<std::size_t>(index)].receiver;
    }
    std::unique_lock<std::mutex> receiver_lock(receiver_mutexes_[receiver]);
    Lease lease;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        const int index = find_lease_locked(client_id, request.lease_id);
        if (index < 0)
            return Result<ipc::TuneResponsePayload>::failure(Error::NOT_FOUND);
        lease = leases_[static_cast<std::size_t>(index)];
        if (states_[lease.receiver] == ipc::ReceiverState::error)
            return Result<ipc::TuneResponsePayload>::failure(Error::NOT_READY);
    }
    if (lease.stream_state == StreamState::armed ||
        lease.stream_state == StreamState::attaching ||
        lease.stream_state == StreamState::active ||
        lease.stream_state == StreamState::revoked)
        return Result<ipc::TuneResponsePayload>::failure(Error::BUSY);
    if (request.system != lease.system)
        return Result<ipc::TuneResponsePayload>::failure(Error::INVALID_ARGUMENT);
    if (!valid_tune(request))
        return Result<ipc::TuneResponsePayload>::failure(Error::INVALID_ARGUMENT);

    {
        std::lock_guard<std::mutex> lock(mutex_);
        set_state_locked(receiver, ipc::ReceiverState::leased);
    }
    const auto power_prepared = backend_.begin_tune_power(
        receiver, request.system, request.lnb_voltage);
    if (!power_prepared) {
        observe_disconnect(receiver, power_prepared.error());
        return Result<ipc::TuneResponsePayload>::failure(power_prepared.error());
    }
    const auto fail_after_power = [&](Error primary) noexcept {
        // A transport-loss result is terminal before rollback: rollback may
        // update logical references but must not write GPIO on that bridge.
        observe_disconnect(receiver, primary);
        const auto rollback = backend_.rollback_tune_power(receiver);
        observe_disconnect(receiver, rollback.error());
        if (!rollback) {
            std::lock_guard<std::mutex> lock(mutex_);
            set_state_locked(receiver, ipc::ReceiverState::error);
        }
        return Result<ipc::TuneResponsePayload>::failure(primary);
    };
    const std::uint64_t start_ms = time_.monotonic_ms();
    const auto remaining_before_tune = [&]() noexcept -> std::uint32_t {
        const std::uint64_t elapsed = time_.monotonic_ms() - start_ms;
        return elapsed >= request.timeout_ms
            ? 0U
            : static_cast<std::uint32_t>(request.timeout_ms - elapsed);
    };
    const std::uint32_t tune_timeout = remaining_before_tune();
    if (tune_timeout == 0U)
        return fail_after_power(Error::TIMEOUT);
    const auto tuned = request.system == ipc::System::ISDB_T
        ? backend_.tune_terrestrial(
              receiver, static_cast<std::uint32_t>(request.frequency_khz), tune_timeout)
        : backend_.tune_satellite(
              receiver, static_cast<std::uint32_t>(request.frequency_khz), tune_timeout);
    if (!tuned)
        return fail_after_power(tuned.error());

    // Keep this origin separate from start_ms: the reference driver's
    // PTX_CHRDEV_WAIT_AFTER_LOCK_TC_T interval starts when check_lock begins,
    // after the frontend tune operation has completed.
    const std::uint64_t lock_poll_start_ms = time_.monotonic_ms();
    const auto locked = poll_lock(receiver, request.system, start_ms,
                                  request.timeout_ms);
    if (!locked) return fail_after_power(locked.error());
    if (!locked.value())
        return fail_after_power(Error::TIMEOUT);

    if (request.system == ipc::System::ISDB_T &&
        backend_.requires_terrestrial_lock_settle()) {
        const std::uint64_t now = time_.monotonic_ms();
        const std::uint64_t elapsed_total = now - start_ms;
        if (elapsed_total >= request.timeout_ms)
            return fail_after_power(Error::TIMEOUT);

        const std::uint64_t lock_poll_elapsed = now - lock_poll_start_ms;
        if (lock_poll_elapsed < kWaitAfterLockTcTMs) {
            const std::uint32_t settle_ms = static_cast<std::uint32_t>(
                kWaitAfterLockTcTMs - lock_poll_elapsed);
            const std::uint32_t remaining = static_cast<std::uint32_t>(
                request.timeout_ms - elapsed_total);
            if (remaining <= settle_ms)
                return fail_after_power(Error::TIMEOUT);
            time_.sleep_ms(settle_ms);
        }
    }

    if (request.system == ipc::System::ISDB_S) {
        const std::uint64_t elapsed = time_.monotonic_ms() - start_ms;
        if (elapsed >= request.timeout_ms)
            return fail_after_power(Error::TIMEOUT);
        const auto remaining = static_cast<std::uint32_t>(
            request.timeout_ms - elapsed);
        const auto selected = request.slot != 0xffffU
            ? backend_.select_satellite_slot(
                  receiver, static_cast<std::uint8_t>(request.slot), remaining)
            : backend_.select_satellite_tsid(receiver, request.stream_id, remaining);
        if (!selected)
            return fail_after_power(selected.error());
        if (time_.monotonic_ms() - start_ms >= request.timeout_ms)
            return fail_after_power(Error::TIMEOUT);
    }

    const auto committed = backend_.commit_tune_power(receiver);
    if (!committed) return fail_after_power(committed.error());

    {
        std::lock_guard<std::mutex> lock(mutex_);
        set_state_locked(receiver, ipc::ReceiverState::tuned);
    }
    return Result<ipc::TuneResponsePayload>::success(
        ipc::TuneResponsePayload{1U, std::numeric_limits<std::int32_t>::min()});
}

Result<void> TunerService::start_stream(std::uint64_t client_id,
                                        std::uint64_t lease_id) noexcept
{
    if (!valid_client(client_id) || lease_id == 0U)
        return Result<void>::failure(Error::NOT_FOUND);
    std::lock_guard<std::mutex> lock(mutex_);
    const int index = find_lease_locked(client_id, lease_id);
    if (index < 0) return Result<void>::failure(Error::NOT_FOUND);
    Lease& lease = leases_[static_cast<std::size_t>(index)];
    if (states_[lease.receiver] != ipc::ReceiverState::tuned)
        return Result<void>::failure(Error::NOT_READY);
    if (lease.stream_state != StreamState::none)
        return Result<void>::failure(Error::BUSY);
    lease.attach_started_ms = time_.monotonic_ms();
    lease.stream_state = StreamState::armed;
    return Result<void>::success();
}

Result<TunerAttachment> TunerService::attach_stream(
    std::uint64_t lease_id,
    const std::array<std::uint8_t, ipc::kNonceLength>& nonce) noexcept
{
    if (lease_id == 0U)
        return Result<TunerAttachment>::failure(Error::NOT_FOUND);

    std::uint8_t receiver = 0U;
    Lease pending;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        int index = -1;
        for (std::size_t candidate = 0U; candidate < leases_.size(); ++candidate) {
            const Lease& lease = leases_[candidate];
            if (lease.active && lease.lease_id == lease_id && lease.nonce == nonce) {
                index = static_cast<int>(candidate);
                break;
            }
        }
        if (index < 0) return Result<TunerAttachment>::failure(Error::NOT_FOUND);
        Lease& lease = leases_[static_cast<std::size_t>(index)];
        receiver = lease.receiver;
    }

    std::unique_lock<std::mutex> receiver_lock(receiver_mutexes_[receiver]);
    std::uint64_t attachment_id = 0U;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        int index = -1;
        for (std::size_t candidate = 0U; candidate < leases_.size(); ++candidate) {
            const Lease& lease = leases_[candidate];
            if (lease.active && lease.lease_id == lease_id && lease.nonce == nonce) {
                index = static_cast<int>(candidate);
                break;
            }
        }
        if (index < 0) return Result<TunerAttachment>::failure(Error::NOT_FOUND);
        Lease& lease = leases_[static_cast<std::size_t>(index)];
        if (lease.receiver != receiver || lease.stream_state != StreamState::armed)
            return Result<TunerAttachment>::failure(
                lease.stream_state == StreamState::none
                    ? Error::NOT_READY : Error::NOT_FOUND);
        // Unsigned subtraction is defined modulo 2^64 and therefore remains
        // correct when a monotonic counter wraps during the five-second arm.
        if (time_.monotonic_ms() - lease.attach_started_ms >= 5000U) {
            lease.stream_state = StreamState::consumed;
            return Result<TunerAttachment>::failure(Error::TIMEOUT);
        }
        const auto allocated = allocate_attachment_id_locked(receiver);
        if (!allocated)
            return Result<TunerAttachment>::failure(allocated.error());
        attachment_id = allocated.value();
        lease.stream_state = StreamState::attaching;
        pending = lease;
    }
    const TunerAttachment pending_attachment{
        pending.client_id, pending.lease_id, attachment_id, pending.receiver,
        pending.system, pending.nonce};
    const auto started = backend_.start_capture(receiver, pending.system);
    observe_disconnect(receiver, started.error());
    bool data_attached = false;
    Error data_error = Error::OK;
    if (started && stream_control_ != nullptr) {
        const auto attached = stream_control_->attach(pending_attachment);
        observe_disconnect(receiver, attached.error());
        if (!attached) {
            data_error = attached.error();
        } else {
            data_attached = true;
        }
    }
    if (!started || data_error != Error::OK) {
        Error result_error = !started ? started.error() : data_error;
        bool data_maybe_attached = false;
        pending.capture_maybe_active = static_cast<bool>(started);
        pending.backend_disconnected = started.error() == Error::DISCONNECTED ||
                                       data_error == Error::DISCONNECTED;
        if (data_attached || (started && stream_control_ != nullptr)) {
            const auto detached = stream_control_->detach(pending_attachment);
            observe_disconnect(receiver, detached.error());
            data_maybe_attached = !detached && detached.error() != Error::NOT_FOUND;
            if (detached.error() == Error::DISCONNECTED)
                pending.backend_disconnected = true;
        }
        if (!pending.backend_disconnected) {
            const auto stopped = backend_.stop_capture(receiver, pending.system);
            observe_disconnect(receiver, stopped.error());
            pending.backend_disconnected = stopped.error() == Error::DISCONNECTED;
            pending.capture_maybe_active = !stopped;
        }
        std::lock_guard<std::mutex> lock(mutex_);
        reserved_attachment_ids_[receiver] = 0U;
        const int index = find_lease_locked(pending.client_id, pending.lease_id);
        if (index >= 0) {
            Lease& lease = leases_[static_cast<std::size_t>(index)];
            lease.stream_state = StreamState::consumed;
            // Keep the identity when compensating detach failed.  The
            // subsequent lease release must retry that exact data session.
            lease.attachment_id = data_maybe_attached ? attachment_id : 0U;
            lease.capture_maybe_active = pending.capture_maybe_active;
            lease.stream_maybe_attached = data_maybe_attached;
            lease.backend_disconnected = pending.backend_disconnected;
            if (pending.capture_maybe_active || data_maybe_attached ||
                pending.backend_disconnected)
                set_state_locked(receiver, ipc::ReceiverState::error);
        }
        return Result<TunerAttachment>::failure(result_error);
    }

    bool attach_accepted = false;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        const int index = find_lease_locked(pending.client_id, pending.lease_id);
        if (index >= 0) {
            Lease& lease = leases_[static_cast<std::size_t>(index)];
            if (lease.stream_state == StreamState::attaching) {
                lease.stream_state = StreamState::active;
                lease.attachment_id = attachment_id;
                lease.capture_maybe_active = true;
                lease.stream_maybe_attached = data_attached;
                set_state_locked(receiver, ipc::ReceiverState::streaming);
                attach_accepted = true;
            }
        }
    }
    if (attach_accepted) {
        std::lock_guard<std::mutex> lock(mutex_);
        reserved_attachment_ids_[receiver] = 0U;
        const Lease& lease = leases_[receiver];
        return Result<TunerAttachment>::success(
            TunerAttachment{lease.client_id, lease.lease_id, lease.attachment_id,
                            lease.receiver, lease.system, lease.nonce});
    }

    // revoke_stream() won the race while start_capture was in flight.  The
    // physical start must be compensated before ATTACH can complete.
    Error result_error = Error::NOT_FOUND;
    const auto detached = data_attached && stream_control_ != nullptr
        ? stream_control_->detach(pending_attachment)
        : Result<void>::success();
    observe_disconnect(receiver, detached.error());
    const bool data_maybe_attached =
        !detached && detached.error() != Error::NOT_FOUND;
    if (!detached && detached.error() != Error::NOT_FOUND)
        result_error = detached.error();
    Result<void> stopped = Result<void>::failure(Error::DISCONNECTED);
    if (detached.error() != Error::DISCONNECTED) {
        stopped = backend_.stop_capture(receiver, pending.system);
        observe_disconnect(receiver, stopped.error());
    }
    if (!stopped && result_error == Error::NOT_FOUND) result_error = stopped.error();
    if (stopped.error() == Error::DISCONNECTED) result_error = Error::DISCONNECTED;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        reserved_attachment_ids_[receiver] = 0U;
        const int index = find_lease_locked(pending.client_id, pending.lease_id);
        if (index >= 0) {
            Lease& lease = leases_[static_cast<std::size_t>(index)];
            lease.stream_state = StreamState::consumed;
            lease.attachment_id = data_maybe_attached ? attachment_id : 0U;
            lease.capture_maybe_active = !stopped;
            lease.stream_maybe_attached = data_maybe_attached;
            lease.backend_disconnected = stopped.error() == Error::DISCONNECTED;
            set_state_locked(receiver, stopped && !data_maybe_attached
                                               ? ipc::ReceiverState::tuned
                                               : ipc::ReceiverState::error);
        }
    }
    return Result<TunerAttachment>::failure(result_error);
}

Result<TunerStreamFinalSnapshot> TunerService::stop_stream(
    std::uint64_t client_id, std::uint64_t lease_id) noexcept
{
    if (!valid_client(client_id) || lease_id == 0U)
        return Result<TunerStreamFinalSnapshot>::failure(Error::NOT_FOUND);
    std::uint8_t receiver = 0U;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        const int index = find_lease_locked(client_id, lease_id);
        if (index < 0)
            return Result<TunerStreamFinalSnapshot>::failure(Error::NOT_FOUND);
        receiver = leases_[static_cast<std::size_t>(index)].receiver;
    }
    std::unique_lock<std::mutex> receiver_lock(receiver_mutexes_[receiver]);
    Lease pending;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        const int index = find_lease_locked(client_id, lease_id);
        if (index < 0)
            return Result<TunerStreamFinalSnapshot>::failure(Error::NOT_FOUND);
        pending = leases_[static_cast<std::size_t>(index)];
        if (pending.receiver != receiver ||
            (pending.stream_state != StreamState::active &&
             pending.stream_state != StreamState::revoked) ||
            !pending.capture_maybe_active)
            return Result<TunerStreamFinalSnapshot>::failure(Error::NOT_READY);
    }
    const TunerAttachment attachment{
        pending.client_id, pending.lease_id, pending.attachment_id,
        pending.receiver, pending.system, pending.nonce};
    const auto detached = detach_data_plane_if_needed(pending);
    const bool detach_clean = detached || detached.error() == Error::NOT_FOUND;
    Error first = Error::OK;
    if (!detach_clean) first = detached.error();
    Result<void> stopped = Result<void>::failure(Error::DISCONNECTED);
    if (detached.error() != Error::DISCONNECTED) {
        stopped = backend_.stop_capture(receiver, pending.system);
        observe_disconnect(receiver, stopped.error());
    }
    if (!stopped && first == Error::OK) first = stopped.error();
    TunerStreamFinalSnapshot final_snapshot{};
    bool snapshot_disconnected = false;
    if (detach_clean && stream_control_ != nullptr &&
        pending.stream_maybe_attached) {
        const auto snapshot = stream_control_->final_snapshot(attachment);
        if (snapshot) {
            final_snapshot = snapshot.value();
            snapshot_disconnected = final_snapshot.terminal ==
                static_cast<std::uint8_t>(TunerStreamTerminal::disconnected);
            if (snapshot_disconnected)
                observe_disconnect(receiver, Error::DISCONNECTED);
        } else {
            snapshot_disconnected = snapshot.error() == Error::DISCONNECTED;
            observe_disconnect(receiver, snapshot.error());
            if (first == Error::OK) first = snapshot.error();
        }
    }
    {
        std::lock_guard<std::mutex> lock(mutex_);
        const int index = find_lease_locked(client_id, lease_id);
        if (index >= 0) {
            Lease& lease = leases_[static_cast<std::size_t>(index)];
            lease.stream_state = StreamState::consumed;
            lease.attachment_id = detach_clean ? 0U : pending.attachment_id;
            lease.capture_maybe_active = !stopped;
            lease.stream_maybe_attached = !detach_clean;
            lease.backend_disconnected = detached.error() == Error::DISCONNECTED ||
                                         stopped.error() == Error::DISCONNECTED ||
                                         snapshot_disconnected;
            set_state_locked(receiver, stopped && detach_clean
                                                && !snapshot_disconnected
                                                ? ipc::ReceiverState::tuned
                                                : ipc::ReceiverState::error);
        }
    }
    return first == Error::OK
        ? Result<TunerStreamFinalSnapshot>::success(final_snapshot)
        : Result<TunerStreamFinalSnapshot>::failure(first);
}

Result<TunerStreamCounters> TunerService::stats(
    std::uint64_t client_id, std::uint64_t lease_id) const noexcept
{
    if (!valid_client(client_id) || lease_id == 0U)
        return Result<TunerStreamCounters>::failure(Error::NOT_FOUND);
    std::uint8_t receiver = 0U;
    Lease lease;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        const int index = find_lease_locked(client_id, lease_id);
        if (index < 0)
            return Result<TunerStreamCounters>::failure(Error::NOT_FOUND);
        lease = leases_[static_cast<std::size_t>(index)];
        receiver = lease.receiver;
    }
    std::unique_lock<std::mutex> receiver_lock(receiver_mutexes_[receiver]);
    {
        std::lock_guard<std::mutex> lock(mutex_);
        const int index = find_lease_locked(client_id, lease_id);
        if (index < 0)
            return Result<TunerStreamCounters>::failure(Error::NOT_FOUND);
        lease = leases_[static_cast<std::size_t>(index)];
        if (lease.receiver != receiver || lease.stream_state != StreamState::active ||
            !lease.capture_maybe_active)
            return Result<TunerStreamCounters>::failure(Error::NOT_READY);
        if (stream_control_ == nullptr || !lease.stream_maybe_attached)
            return Result<TunerStreamCounters>::failure(Error::UNSUPPORTED);
    }
    const TunerAttachment attachment{
        lease.client_id, lease.lease_id, lease.attachment_id, lease.receiver,
        lease.system, lease.nonce};
    return stream_control_->stats(attachment);
}

Result<void> TunerService::detach_stream(
    const TunerAttachment& attachment) noexcept
{
    if (attachment.owner_client_id == 0U || attachment.lease_id == 0U ||
        attachment.attachment_id == 0U ||
        attachment.receiver >= ipc::kReceiverCount)
        return Result<void>::failure(Error::NOT_FOUND);
    std::uint8_t receiver = attachment.receiver;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        const Lease& lease = leases_[receiver];
        if (!lease.active || lease.client_id != attachment.owner_client_id ||
            lease.lease_id != attachment.lease_id ||
            lease.attachment_id != attachment.attachment_id ||
            lease.system != attachment.system || lease.nonce != attachment.nonce ||
            (lease.stream_state != StreamState::active &&
             lease.stream_state != StreamState::revoked))
            return Result<void>::failure(Error::NOT_FOUND);
        leases_[receiver].stream_state = StreamState::revoked;
    }
    std::unique_lock<std::mutex> receiver_lock(receiver_mutexes_[receiver]);
    Lease pending;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        const Lease& lease = leases_[receiver];
        if (!lease.active || lease.client_id != attachment.owner_client_id ||
            lease.lease_id != attachment.lease_id ||
            lease.attachment_id != attachment.attachment_id ||
            lease.system != attachment.system || lease.nonce != attachment.nonce ||
            (lease.stream_state != StreamState::active &&
             lease.stream_state != StreamState::revoked))
            return Result<void>::failure(Error::NOT_FOUND);
        pending = lease;
    }
    const auto detached = detach_data_plane_if_needed(pending);
    const bool detach_clean = detached || detached.error() == Error::NOT_FOUND;
    Error first = Error::OK;
    if (!detach_clean) first = detached.error();
    Result<void> stopped = Result<void>::failure(Error::DISCONNECTED);
    if (detached.error() != Error::DISCONNECTED) {
        stopped = backend_.stop_capture(receiver, pending.system);
        observe_disconnect(receiver, stopped.error());
    }
    if (!stopped && first == Error::OK) first = stopped.error();
    {
        std::lock_guard<std::mutex> lock(mutex_);
        const int index = find_lease_locked(attachment.owner_client_id,
                                            attachment.lease_id);
        if (index >= 0 && leases_[static_cast<std::size_t>(index)].attachment_id ==
                              attachment.attachment_id) {
            Lease& lease = leases_[static_cast<std::size_t>(index)];
            lease.stream_state = StreamState::consumed;
            lease.attachment_id = detach_clean ? 0U : attachment.attachment_id;
            lease.capture_maybe_active = !stopped;
            lease.stream_maybe_attached = !detach_clean;
            lease.backend_disconnected = detached.error() == Error::DISCONNECTED ||
                                         stopped.error() == Error::DISCONNECTED;
            set_state_locked(receiver, stopped && detach_clean
                                                ? ipc::ReceiverState::tuned
                                               : ipc::ReceiverState::error);
        }
    }
    return first == Error::OK ? Result<void>::success()
                              : Result<void>::failure(first);
}

Result<void> TunerService::revoke_stream(std::uint64_t client_id,
                                         std::uint64_t lease_id) noexcept
{
    if (!valid_client(client_id) || lease_id == 0U)
        return Result<void>::failure(Error::NOT_FOUND);
    std::lock_guard<std::mutex> lock(mutex_);
    const int index = find_lease_locked(client_id, lease_id);
    if (index < 0) return Result<void>::failure(Error::NOT_FOUND);
    Lease& lease = leases_[static_cast<std::size_t>(index)];
    if (lease.stream_state == StreamState::armed ||
        lease.stream_state == StreamState::attaching ||
        lease.stream_state == StreamState::active)
        lease.stream_state = StreamState::revoked;
    return Result<void>::success();
}

Result<void> TunerService::revoke_stream(
    std::uint64_t client_id, std::uint64_t lease_id,
    const std::array<std::uint8_t, ipc::kNonceLength>& nonce) noexcept
{
    if (!valid_client(client_id) || lease_id == 0U)
        return Result<void>::failure(Error::NOT_FOUND);
    std::lock_guard<std::mutex> lock(mutex_);
    const int index = find_lease_locked(client_id, lease_id);
    if (index < 0) return Result<void>::failure(Error::NOT_FOUND);
    Lease& lease = leases_[static_cast<std::size_t>(index)];
    if (lease.nonce != nonce) return Result<void>::failure(Error::NOT_FOUND);
    if (lease.stream_state == StreamState::armed ||
        lease.stream_state == StreamState::attaching ||
        lease.stream_state == StreamState::active)
        lease.stream_state = StreamState::revoked;
    return Result<void>::success();
}

Result<TunerStatus> TunerService::status() const noexcept
{
    std::lock_guard<std::mutex> lock(mutex_);
    return Result<TunerStatus>::success(TunerStatus{generation_, states_});
}

Result<void> TunerService::cleanup_client(std::uint64_t client_id) noexcept
{
    if (!valid_client(client_id)) return Result<void>::failure(Error::INVALID_ARGUMENT);
    std::array<std::uint64_t, ipc::kReceiverCount> lease_ids{};
    // Revoke the complete connection atomically before any receiver I/O.  A
    // slow cleanup on one bridge must not leave another lease attachable.
    {
        std::lock_guard<std::mutex> lock(mutex_);
        for (std::uint8_t receiver = 0U; receiver < ipc::kReceiverCount; ++receiver) {
            Lease& lease = leases_[receiver];
            if (!lease.active || lease.client_id != client_id) continue;
            lease_ids[receiver] = lease.lease_id;
            if (lease.stream_state == StreamState::armed ||
                lease.stream_state == StreamState::attaching ||
                lease.stream_state == StreamState::active)
                lease.stream_state = StreamState::revoked;
        }
    }
    Error first = Error::OK;
    for (std::uint8_t receiver = 0U; receiver < ipc::kReceiverCount; ++receiver) {
        if (lease_ids[receiver] == 0U) continue;
        const auto result = release_lease(client_id, lease_ids[receiver]);
        if (first == Error::OK && !result) first = result.error();
    }
    return first == Error::OK ? Result<void>::success()
                              : Result<void>::failure(first);
}

Result<void> TunerService::disconnect_client(std::uint64_t client_id) noexcept
{
    return cleanup_client(client_id);
}

Result<void> TunerService::cleanup_all() noexcept
{
    std::array<std::uint64_t, ipc::kReceiverCount> client_ids{};
    std::array<std::uint64_t, ipc::kReceiverCount> lease_ids{};
    // Same two-phase rule as connection cleanup: revoke all logical stream
    // credentials before the first potentially blocking backend operation.
    {
        std::lock_guard<std::mutex> lock(mutex_);
        for (std::uint8_t receiver = 0U; receiver < ipc::kReceiverCount; ++receiver) {
            Lease& lease = leases_[receiver];
            if (!lease.active) continue;
            client_ids[receiver] = lease.client_id;
            lease_ids[receiver] = lease.lease_id;
            if (lease.stream_state == StreamState::armed ||
                lease.stream_state == StreamState::attaching ||
                lease.stream_state == StreamState::active)
                lease.stream_state = StreamState::revoked;
        }
    }
    Error first = Error::OK;
    for (std::uint8_t receiver = 0U; receiver < ipc::kReceiverCount; ++receiver) {
        if (client_ids[receiver] == 0U) continue;
        const auto result = release_lease(client_ids[receiver], lease_ids[receiver]);
        if (first == Error::OK && !result) first = result.error();
    }
    const auto backend_shutdown = backend_.shutdown();
    if (first == Error::OK && !backend_shutdown) first = backend_shutdown.error();
    return first == Error::OK ? Result<void>::success()
                              : Result<void>::failure(first);
}

Result<void> TunerService::shutdown() noexcept
{
    return cleanup_all();
}

}  // namespace px4::userland
