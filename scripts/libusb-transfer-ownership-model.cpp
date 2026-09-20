/*
 * USB-free model of the ownership boundary needed by an experimental WebUSB
 * transfer-cancel patch.  This is deliberately not linked to libusb core or
 * emscripten_webusb.cpp: it proves only shared-state/once semantics.
 */
#include <array>
#include <cstdint>
#include <functional>
#include <memory>
#include <utility>
#include <vector>

namespace {

enum class Phase : std::uint8_t { pending, cancel_requested, settled, detached };

struct TransferState final {
    Phase phase = Phase::pending;
    std::uint32_t callback_count = 0U;
    std::uint32_t late_ignored = 0U;
    std::uint32_t late_after_user_free = 0U;
    std::uint32_t cancel_count = 0U;
    std::uint32_t duplicate_cancel_count = 0U;
    bool user_freed = false;
    std::function<void()> user_callback;

    void request_cancel() noexcept
    {
        if (phase == Phase::pending) {
            phase = Phase::cancel_requested;
            ++cancel_count;
        } else {
            ++duplicate_cancel_count;
        }
    }

    void detach() noexcept
    {
        if (phase != Phase::settled) phase = Phase::detached;
    }

    void complete_core_callback() noexcept
    {
        if (phase == Phase::settled || phase == Phase::detached || callback_count != 0U) {
            ++late_ignored;
            if (user_freed) ++late_after_user_free;
            return;
        }
        phase = Phase::settled;
        ++callback_count;
        auto callback = user_callback;
        if (callback) callback();
    }

    void settle() noexcept
    {
        if (phase == Phase::settled || phase == Phase::detached || callback_count != 0U) {
            ++late_ignored;
            if (user_freed) ++late_after_user_free;
            return;
        }
        if (phase == Phase::cancel_requested) {
            ++late_ignored;
            if (user_freed) ++late_after_user_free;
            return;
        }
        phase = Phase::settled;
        ++callback_count;
        auto callback = user_callback;
        if (callback) callback();
    }
};

struct TransferToken final {
    std::shared_ptr<TransferState> state;

    explicit TransferToken(std::shared_ptr<TransferState> value) noexcept
        : state(std::move(value))
    {
    }

    void free() noexcept
    {
        if (state) {
            state->user_freed = true;
            state.reset();
        }
    }
};

// The deferred promise retains only the stable state, never a raw transfer token.
struct DeferredPromise final {
    std::shared_ptr<TransferState> state;

    void resolve() noexcept
    {
        if (state) state->settle();
    }

    void reject() noexcept
    {
        if (state) state->settle();
    }
};

struct DeviceRefs final {
    std::uint32_t handles = 0U;
    std::uint32_t physical_closes = 0U;
    bool close_failed = false;

    void open() noexcept { ++handles; }

    void close(bool fail) noexcept
    {
        if (handles == 0U) return;
        --handles;
        if (handles == 0U) {
            ++physical_closes;
            close_failed = fail;
        }
    }
};

struct ModelResult final {
    bool ok = true;
    std::uint32_t callbacks = 0U;
    std::uint32_t late_ignored = 0U;
    std::uint32_t duplicate_cancels = 0U;
    bool user_freed = false;
    std::uint32_t late_after_user_free = 0U;
};

ModelResult cancel_then_late() noexcept
{
    auto state = std::make_shared<TransferState>();
    TransferToken token(state);
    DeferredPromise promise{state};
    state->user_callback = [&token]() noexcept { token.free(); };
    state->request_cancel();
    state->request_cancel();
    state->complete_core_callback();
    promise.resolve();
    promise.reject();
    state->detach();
    return ModelResult{state->callback_count == 1U && state->late_ignored == 2U &&
                           state->duplicate_cancel_count == 1U && state->user_freed &&
                           state->late_after_user_free == 2U,
                       state->callback_count, state->late_ignored,
                       state->duplicate_cancel_count, state->user_freed,
                       state->late_after_user_free};
}

ModelResult natural_then_late() noexcept
{
    auto state = std::make_shared<TransferState>();
    TransferToken token(state);
    DeferredPromise promise{state};
    state->user_callback = [&token]() noexcept { token.free(); };
    promise.resolve();
    promise.reject();
    return ModelResult{state->callback_count == 1U && state->late_ignored == 1U &&
                           state->user_freed && state->late_after_user_free == 1U,
                       state->callback_count, state->late_ignored,
                       state->duplicate_cancel_count, state->user_freed,
                       state->late_after_user_free};
}

ModelResult disconnect_then_late() noexcept
{
    auto state = std::make_shared<TransferState>();
    TransferToken token(state);
    DeferredPromise promise{state};
    std::uint32_t user_callbacks = 0U;
    state->user_callback = [&token, &user_callbacks]() noexcept {
        ++user_callbacks;
        token.free();
    };
    state->complete_core_callback();
    state->detach();
    promise.reject();
    promise.resolve();
    return ModelResult{state->callback_count == 1U && user_callbacks == 1U &&
                           state->late_ignored == 2U &&
                           state->late_after_user_free == 2U,
                       state->callback_count, state->late_ignored,
                       state->duplicate_cancel_count, state->user_freed,
                       state->late_after_user_free};
}

bool multiple_pending_and_handles() noexcept
{
    DeviceRefs device;
    device.open();
    device.open();
    std::vector<std::shared_ptr<TransferState>> states;
    std::vector<DeferredPromise> promises;
    for (std::size_t index = 0U; index < 3U; ++index) {
        auto state = std::make_shared<TransferState>();
        states.push_back(state);
        promises.push_back(DeferredPromise{state});
    }
    device.close(false);
    if (device.physical_closes != 0U || device.handles != 1U) return false;
    states[0]->request_cancel();
    states[1]->request_cancel();
    states[0]->complete_core_callback();
    states[1]->complete_core_callback();
    promises[0].resolve();
    promises[1].reject();
    device.close(true);
    promises[2].resolve();
    return device.physical_closes == 1U && device.close_failed && device.handles == 0U &&
           states[0]->callback_count == 1U && states[1]->callback_count == 1U &&
           states[2]->callback_count == 1U;
}

}  // namespace

extern "C" std::uint32_t webts_libusb_transfer_ownership_model(
    std::uint32_t output_ptr, std::uint32_t output_words) noexcept
{
    constexpr std::uint32_t kWords = 13U;
    constexpr std::uint32_t kInvalidArgument = 2U;
    constexpr std::uint32_t kInternal = 255U;
    if (output_ptr == 0U || output_words < kWords) return kInvalidArgument;
    auto* output = reinterpret_cast<std::uint32_t*>(static_cast<std::uintptr_t>(output_ptr));
    for (std::uint32_t index = 0U; index < kWords; ++index) output[index] = 0U;

    const auto cancel = cancel_then_late();
    const auto natural = natural_then_late();
    const auto disconnected = disconnect_then_late();
    const bool multi = multiple_pending_and_handles();
    std::uint32_t naive_callback_count = 0U;
    const auto naive_callback = [&naive_callback_count]() noexcept { ++naive_callback_count; };
    naive_callback(); // cancel path
    naive_callback(); // late Promise path
    const bool naive_regression = naive_callback_count == 2U;
    const bool all_ok = cancel.ok && natural.ok && disconnected.ok && multi &&
                        naive_regression;
    output[0U] = all_ok ? 0U : kInternal;
    output[1U] = 7U;  // cancel, natural, double-cancel, disconnect, late, multi, close-fail
    output[2U] = cancel.callbacks + natural.callbacks + disconnected.callbacks;
    output[3U] = cancel.late_ignored + natural.late_ignored + disconnected.late_ignored;
    output[4U] = cancel.duplicate_cancels;
    output[5U] = cancel.user_freed && natural.user_freed ? 1U : 0U;
    output[6U] = cancel.late_after_user_free + natural.late_after_user_free +
                     disconnected.late_after_user_free;
    output[7U] = multi ? 1U : 0U;
    output[8U] = cancel.callbacks == 1U && cancel.late_ignored == 2U ? 1U : 0U;
    output[9U] = disconnected.callbacks == 1U && disconnected.late_ignored == 2U ? 1U : 0U;
    // Regression baseline: a naive cancel callback plus late Promise callback
    // would invoke the user callback twice. The fixed model above rejects it.
    output[10U] = naive_regression ? 1U : 0U;
    output[11U] = 0U; // physical WebUSB abort is intentionally not modeled/proven.
    output[12U] = all_ok ? 1U : 0U;
    return output[0U] == 0U ? 0U : kInternal;
}
