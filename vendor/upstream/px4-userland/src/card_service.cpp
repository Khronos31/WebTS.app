// SPDX-License-Identifier: GPL-2.0-only
#include "px4/card_service.h"

#include <cstddef>
#include <cstdint>
#include <limits>

namespace px4::userland {

CardService::~CardService() noexcept
{
    (void)shutdown();
}

void CardService::invalidate_session() noexcept
{
    session_.invalidate();
    cached_atr_ = CardAtr{};
    transaction_handle_ = 0U;
}

void CardService::abandon_disconnected_hardware() noexcept
{
    // Once the USB device reports removal, SPEC 5.2 forbids issuing a
    // speculative power-off transfer. Drop only daemon-side state; Q3U4Runtime
    // owns the detached USB resources and tears them down separately.
    powered_ = false;
    uart_initialized_ = false;
    invalidate_session();
}

Result<void> CardService::power_up() noexcept
{
    if (powered_) {
        return Result<void>::success();
    }
    const auto power = backend_.set_power(true);
    if (!power) {
        if (power.error() == Error::DISCONNECTED) {
            abandon_disconnected_hardware();
            return power;
        }
        // A failed control transfer may still have reached device 1.
        const auto off = backend_.set_power(false);
        return off ? power : off;
    }
    powered_ = true;
    const auto uart = backend_.initialize_uart();
    if (!uart) {
        if (uart.error() == Error::DISCONNECTED) {
            abandon_disconnected_hardware();
            return uart;
        }
        const auto off = backend_.set_power(false);
        powered_ = false;
        uart_initialized_ = false;
        return off ? uart : off;
    }
    uart_initialized_ = true;
    return Result<void>::success();
}

Result<void> CardService::power_down() noexcept
{
    invalidate_session();
    uart_initialized_ = false;
    if (!powered_) {
        return Result<void>::success();
    }
    // Clear the logical state before I/O so a failed OFF is never mistaken for
    // a reusable powered card session.
    powered_ = false;
    return backend_.set_power(false);
}

Result<bool> CardService::detect_and_record(bool report_initial_change,
                                            CardPresenceChange* change) noexcept
{
    if (!powered_ || !uart_initialized_) {
        return Result<bool>::failure(Error::NOT_READY);
    }
    const auto detected = backend_.detect_card();
    if (!detected) {
        if (detected.error() == Error::DISCONNECTED) {
            abandon_disconnected_hardware();
        } else {
            invalidate_session();
        }
        return Result<bool>::failure(detected.error());
    }

    const bool was_known = presence_known_;
    const bool previous = present_;
    presence_known_ = true;
    present_ = detected.value();
    const bool changed = was_known ? previous != present_ : report_initial_change;
    if (changed) {
        ++reader_generation_;
        pending_presence_change_ =
            CardPresenceChange{true, present_, reader_generation_};
        presence_change_pending_ = true;
        if (!present_) {
            invalidate_session();
        }
    }
    if (change != nullptr) {
        *change = CardPresenceChange{changed, present_, reader_generation_};
    }
    return Result<bool>::success(present_);
}

Result<void> CardService::ensure_session() noexcept
{
    const auto power = power_up();
    if (!power) {
        return power;
    }
    if (session_.initialized()) {
        const auto detected = detect_and_record(false, nullptr);
        if (!detected) {
            return Result<void>::failure(detected.error());
        }
        if (!detected.value()) {
            return Result<void>::failure(Error::CARD_REMOVED);
        }
        return Result<void>::success();
    }
    const auto initialized = session_.initialize();
    if (!initialized) {
        if (initialized.error() == Error::DISCONNECTED) {
            abandon_disconnected_hardware();
        } else {
            invalidate_session();
        }
        return initialized;
    }
    if (presence_known_ && !present_) {
        ++reader_generation_;
        pending_presence_change_ =
            CardPresenceChange{true, true, reader_generation_};
        presence_change_pending_ = true;
    }
    presence_known_ = true;
    present_ = true;
    cached_atr_ = session_.atr();
    return Result<void>::success();
}

Result<CardAtr> CardService::reset_session(bool preserve_transaction) noexcept
{
    const std::uint64_t transaction = preserve_transaction ? transaction_handle_ : 0U;
    invalidate_session();
    const auto initialized = ensure_session();
    if (!initialized) {
        return Result<CardAtr>::failure(initialized.error());
    }
    transaction_handle_ = transaction;
    return Result<CardAtr>::success(cached_atr_);
}

Result<CardServiceStatus> CardService::status() noexcept
{
    const bool temporary_power = !powered_;
    const auto power = power_up();
    if (!power) {
        return Result<CardServiceStatus>::failure(power.error());
    }
    const auto detected = detect_and_record(false, nullptr);
    Error error = detected ? Error::OK : detected.error();
    CardServiceStatus result{
        detected ? detected.value() : false,
        detected && detected.value() && session_.initialized(),
        reader_generation_,
        detected && detected.value() && session_.initialized() ? cached_atr_ : CardAtr{}};
    if (temporary_power) {
        const auto off = power_down();
        if (!off) {
            error = off.error();
        }
        result.initialized = false;
        result.atr = CardAtr{};
    }
    return error == Error::OK ? Result<CardServiceStatus>::success(result) :
                               Result<CardServiceStatus>::failure(error);
}

Result<CardPresenceChange> CardService::poll_presence() noexcept
{
    if (!powered_ || handles_.empty()) {
        if (presence_change_pending_) {
            presence_change_pending_ = false;
            return Result<CardPresenceChange>::success(pending_presence_change_);
        }
        return Result<CardPresenceChange>::success(
            CardPresenceChange{false, present_, reader_generation_});
    }
    CardPresenceChange change{};
    const auto detected = detect_and_record(false, &change);
    if (!detected) {
        return Result<CardPresenceChange>::failure(detected.error());
    }
    if (presence_change_pending_) {
        presence_change_pending_ = false;
        return Result<CardPresenceChange>::success(pending_presence_change_);
    }
    return Result<CardPresenceChange>::success(change);
}

bool CardService::sharing_allowed(ipc::ShareMode requested,
                                  std::size_t excluded_index) const noexcept
{
    if (requested != ipc::ShareMode::shared &&
        requested != ipc::ShareMode::exclusive) {
        return false;
    }
    for (std::size_t index = 0U; index < handles_.size(); ++index) {
        if (index == excluded_index) {
            continue;
        }
        if (requested == ipc::ShareMode::exclusive ||
            handles_[index].share_mode == ipc::ShareMode::exclusive) {
            return false;
        }
    }
    return true;
}

std::uint64_t CardService::allocate_handle() noexcept
{
    while (true) {
        const std::uint64_t candidate = next_handle_++;
        if (next_handle_ == 0U) {
            next_handle_ = 1U;
        }
        if (candidate == 0U) {
            continue;
        }
        bool used = false;
        for (const HandleRecord& record : handles_) {
            used = used || record.handle == candidate;
        }
        if (!used) {
            return candidate;
        }
    }
}

Result<CardServiceConnectResult> CardService::connect(
    CardClientId client, ipc::ShareMode share_mode) noexcept
{
    if (client == 0U ||
        (share_mode != ipc::ShareMode::shared &&
         share_mode != ipc::ShareMode::exclusive)) {
        return Result<CardServiceConnectResult>::failure(Error::INVALID_ARGUMENT);
    }
    if (!sharing_allowed(share_mode, std::numeric_limits<std::size_t>::max())) {
        return Result<CardServiceConnectResult>::failure(
            Error::BUSY);
    }
    const bool first_handle = handles_.empty();
    const auto initialized = ensure_session();
    if (!initialized) {
        if (first_handle) {
            const auto off = power_down();
            if (!off) {
                return Result<CardServiceConnectResult>::failure(off.error());
            }
        }
        return Result<CardServiceConnectResult>::failure(initialized.error());
    }
    const std::uint64_t handle = allocate_handle();
    handles_.push_back(HandleRecord{handle, client, share_mode});
    return Result<CardServiceConnectResult>::success(
        CardServiceConnectResult{handle, cached_atr_});
}

Result<std::size_t> CardService::find_handle(CardClientId client,
                                             std::uint64_t handle) const noexcept
{
    if (client == 0U || handle == 0U) {
        return Result<std::size_t>::failure(Error::INVALID_ARGUMENT);
    }
    for (std::size_t index = 0U; index < handles_.size(); ++index) {
        if (handles_[index].handle == handle) {
            return handles_[index].client == client ?
                       Result<std::size_t>::success(index) :
                       Result<std::size_t>::failure(Error::NOT_FOUND);
        }
    }
    return Result<std::size_t>::failure(Error::NOT_FOUND);
}

bool CardService::transaction_allows(std::uint64_t handle) const noexcept
{
    return transaction_handle_ == 0U || transaction_handle_ == handle;
}

Result<void> CardService::apply_disposition(ipc::Disposition disposition) noexcept
{
    if (disposition == ipc::Disposition::leave) {
        return Result<void>::success();
    }
    if (disposition != ipc::Disposition::reset) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    const auto reset = reset_session();
    return reset ? Result<void>::success() : Result<void>::failure(reset.error());
}

Result<CardAtr> CardService::reconnect(CardClientId client, std::uint64_t handle,
                                       ipc::ShareMode share_mode,
                                       ipc::Disposition disposition) noexcept
{
    if ((share_mode != ipc::ShareMode::shared &&
         share_mode != ipc::ShareMode::exclusive) ||
        (disposition != ipc::Disposition::leave &&
         disposition != ipc::Disposition::reset)) {
        return Result<CardAtr>::failure(Error::INVALID_ARGUMENT);
    }
    const auto found = find_handle(client, handle);
    if (!found) {
        return Result<CardAtr>::failure(found.error());
    }
    if (!transaction_allows(handle)) {
        return Result<CardAtr>::failure(Error::BUSY);
    }
    if (!sharing_allowed(share_mode, found.value())) {
        return Result<CardAtr>::failure(Error::BUSY);
    }
    Result<void> ready = Result<void>::success();
    if (disposition == ipc::Disposition::reset) {
        const auto reset = reset_session(transaction_handle_ == handle);
        ready = reset ? Result<void>::success() :
                        Result<void>::failure(reset.error());
    } else {
        ready = ensure_session();
    }
    if (!ready) {
        return Result<CardAtr>::failure(ready.error());
    }
    handles_[found.value()].share_mode = share_mode;
    return Result<CardAtr>::success(cached_atr_);
}

Result<void> CardService::release_handle(std::size_t index) noexcept
{
    if (index >= handles_.size()) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    if (transaction_handle_ == handles_[index].handle) {
        transaction_handle_ = 0U;
    }
    handles_.erase(handles_.begin() + static_cast<std::ptrdiff_t>(index));
    return handles_.empty() ? power_down() : Result<void>::success();
}

Result<void> CardService::disconnect(CardClientId client, std::uint64_t handle,
                                     ipc::Disposition disposition) noexcept
{
    if (disposition != ipc::Disposition::leave &&
        disposition != ipc::Disposition::reset) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    const auto found = find_handle(client, handle);
    if (!found) {
        return Result<void>::failure(found.error());
    }
    if (disposition == ipc::Disposition::reset &&
        !transaction_allows(handle)) {
        return Result<void>::failure(Error::BUSY);
    }
    Error first = Error::OK;
    const auto applied = apply_disposition(disposition);
    if (!applied) {
        first = applied.error();
    }
    const auto released = release_handle(found.value());
    if (!released) {
        first = released.error();
    }
    return first == Error::OK ? Result<void>::success() : Result<void>::failure(first);
}

Result<CardAtr> CardService::reset(CardClientId client,
                                   std::uint64_t handle) noexcept
{
    const auto found = find_handle(client, handle);
    if (!found) {
        return Result<CardAtr>::failure(found.error());
    }
    if (!transaction_allows(handle)) {
        return Result<CardAtr>::failure(Error::BUSY);
    }
    return reset_session(transaction_handle_ == handle);
}

Result<std::size_t> CardService::transmit(CardClientId client,
                                          std::uint64_t handle, ByteView apdu,
                                          MutableByteView response) noexcept
{
    if (apdu.data == nullptr || apdu.size == 0U ||
        apdu.size > ipc::kMaxCardPayload || response.data == nullptr ||
        response.size == 0U) {
        return Result<std::size_t>::failure(Error::INVALID_ARGUMENT);
    }
    const auto found = find_handle(client, handle);
    if (!found) {
        return Result<std::size_t>::failure(found.error());
    }
    if (!transaction_allows(handle)) {
        return Result<std::size_t>::failure(Error::BUSY);
    }
    const auto initialized = ensure_session();
    if (!initialized) {
        transaction_handle_ = 0U;
        return Result<std::size_t>::failure(initialized.error());
    }
    const auto result = session_.transmit(apdu, response);
    if (!result) {
        if (result.error() == Error::DISCONNECTED) {
            abandon_disconnected_hardware();
        } else {
            invalidate_session();
        }
        return Result<std::size_t>::failure(result.error());
    }
    return result;
}

Result<void> CardService::begin_transaction(CardClientId client,
                                            std::uint64_t handle) noexcept
{
    const auto found = find_handle(client, handle);
    if (!found) {
        return Result<void>::failure(found.error());
    }
    if (transaction_handle_ != 0U) {
        return Result<void>::failure(Error::BUSY);
    }
    const auto initialized = ensure_session();
    if (!initialized) {
        return initialized;
    }
    transaction_handle_ = handle;
    return Result<void>::success();
}

Result<void> CardService::end_transaction(CardClientId client,
                                          std::uint64_t handle,
                                          ipc::Disposition disposition) noexcept
{
    const auto found = find_handle(client, handle);
    if (!found) {
        return Result<void>::failure(found.error());
    }
    if (transaction_handle_ != handle) {
        return Result<void>::failure(Error::BUSY);
    }
    transaction_handle_ = 0U;
    return apply_disposition(disposition);
}

Result<void> CardService::release_connection(CardClientId client) noexcept
{
    if (client == 0U) {
        return Result<void>::failure(Error::INVALID_ARGUMENT);
    }
    for (std::size_t index = handles_.size(); index > 0U; --index) {
        if (handles_[index - 1U].client == client) {
            if (transaction_handle_ == handles_[index - 1U].handle) {
                transaction_handle_ = 0U;
            }
            handles_.erase(handles_.begin() +
                           static_cast<std::ptrdiff_t>(index - 1U));
        }
    }
    return handles_.empty() ? power_down() : Result<void>::success();
}

Result<void> CardService::shutdown() noexcept
{
    handles_.clear();
    transaction_handle_ = 0U;
    return power_down();
}

}  // namespace px4::userland
