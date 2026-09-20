/*
 * Test-only harness for the unmodified libusb 1.0.30 Emscripten/WebUSB
 * backend.  The fake USBDevice below is intentionally limited to descriptor
 * responses and one deferred transferIn promise; it is not a USB shim for
 * production use.
 */
#include <emscripten.h>

#include <cstdint>
#include <cstring>

#include <libusb.h>

namespace {

EM_JS(void, install_fake_webusb, (), {
  const bytes = (values) => new DataView(Uint8Array.from(values).buffer);
  const deviceDescriptor = bytes([
    18, 1, 0x00, 0x02, 0, 0, 0, 64, 0x75, 0x32, 0x80, 0x00,
    1, 0, 1, 2, 3, 0
  ]);
  const device = {
    configuration: null,
    open: () => Promise.resolve(),
    close: () => Promise.resolve(),
    controlTransferIn: (setup) => {
      const descriptorType = (setup.value >>> 8) & 0xff;
      return Promise.resolve({
        status: 'ok',
        data: deviceDescriptor
      });
    },
    transferIn: () => {
      globalThis.__webtsCancelRegression.transferInCalls++;
      return new Promise((resolve, reject) => {
        globalThis.__webtsCancelRegression.resolveTransferIn = resolve;
        globalThis.__webtsCancelRegression.rejectTransferIn = reject;
      });
    }
  };
  const usb = { getDevices: () => Promise.resolve([device]) };
  if (!globalThis.navigator) {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true, value: {}
    });
  }
  Object.defineProperty(globalThis.navigator, 'usb', {
    configurable: true, value: usb
  });
  globalThis.__webtsCancelRegression = {
    transferInCalls: 0, resolveTransferIn: null, rejectTransferIn: null
  };
});

EM_JS(int, fake_transfer_in_call_count, (), {
  const test = globalThis.__webtsCancelRegression;
  return test ? test.transferInCalls : 0;
});

EM_ASYNC_JS(void, yield_one_task_turn, (), {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

EM_ASYNC_JS(void, settle_fake_transfer, (), {
  const test = globalThis.__webtsCancelRegression;
  if (!test) return;
  const settle = test.resolveTransferIn;
  test.resolveTransferIn = null;
  test.rejectTransferIn = null;
  if (typeof settle !== 'function') return;
  settle({ status: 'ok', data: null });
  await new Promise((resolve) => setTimeout(resolve, 0));
});

EM_JS(void, emit_settle_stage, (int stage), {
  if (typeof globalThis.postMessage === 'function') {
    globalThis.postMessage({ type: 'libusb-cancel-worker-progress', stage });
  }
});

struct CallbackState {
  int callbacks = 0;
  int status = -1;
};

void transfer_callback(libusb_transfer* transfer) {
  auto* state = static_cast<CallbackState*>(transfer->user_data);
  ++state->callbacks;
  state->status = static_cast<int>(transfer->status);
}

struct FreeCallbackState {
  int callbacks = 0;
  int status = -1;
  bool freed = false;
};

void free_transfer_callback(libusb_transfer* transfer) {
  auto* state = static_cast<FreeCallbackState*>(transfer->user_data);
  ++state->callbacks;
  state->status = static_cast<int>(transfer->status);
  // The state lives outside the transfer. The callback is intentionally the
  // only owner that frees this transfer; the caller must not free it again.
  libusb_free_transfer(transfer);
  state->freed = true;
}

void discard_libusb_log(libusb_context*, enum libusb_log_level, const char*) {}

// Packed report: bits 0..7 callbacks before promise settle, 8..15 callbacks
// after settle, 16..23 final transfer status, 24..31 cancel return + 16.
std::uint32_t pack_report(int before, int after, int status, int cancel) {
  return (static_cast<std::uint32_t>(before) & 0xffU) |
         ((static_cast<std::uint32_t>(after) & 0xffU) << 8) |
         ((static_cast<std::uint32_t>(status) & 0xffU) << 16) |
         ((static_cast<std::uint32_t>(cancel + 16) & 0xffU) << 24);
}

std::uint32_t pack_settle_report(int callbacks, int status, int event_result,
                                 int cancel) {
  return (static_cast<std::uint32_t>(callbacks) & 0xffU) |
         ((static_cast<std::uint32_t>(status) & 0xffU) << 8) |
         ((static_cast<std::uint32_t>(event_result + 16) & 0xffU) << 16) |
         ((static_cast<std::uint32_t>(cancel + 16) & 0xffU) << 24);
}

std::uint32_t pack_user_free_report(int callbacks, int status, int event_result,
                                    int cancel, bool freed) {
  const auto cancel_byte = (static_cast<std::uint32_t>(cancel + 16) & 0x7fU) |
    (freed ? 0x80U : 0U);
  return (static_cast<std::uint32_t>(callbacks) & 0xffU) |
         ((static_cast<std::uint32_t>(status) & 0xffU) << 8) |
         ((static_cast<std::uint32_t>(event_result + 16) & 0xffU) << 16) |
         (cancel_byte << 24);
}

std::uint32_t pack_close_report(int callbacks, int status, bool close_returned,
                                int transfer_in_calls) {
  return (static_cast<std::uint32_t>(callbacks) & 0xffU) |
         ((static_cast<std::uint32_t>(status) & 0xffU) << 8) |
         ((close_returned ? 1U : 0U) << 16) |
         ((static_cast<std::uint32_t>(transfer_in_calls) & 0xffU) << 24);
}

}  // namespace

extern "C" std::uint32_t webts_libusb_webusb_cancel_regression() {
  install_fake_webusb();

  libusb_context* context = nullptr;
  if (libusb_init(&context) != LIBUSB_SUCCESS) return 0xffffffffU;

  libusb_device** devices = nullptr;
  const auto count = libusb_get_device_list(context, &devices);
  if (count != 1 || devices == nullptr) {
    libusb_free_device_list(devices, 1);
    libusb_exit(context);
    return 0xffffff01U;
  }

  libusb_device_handle* handle = nullptr;
  if (libusb_open(devices[0], &handle) != LIBUSB_SUCCESS || handle == nullptr) {
    libusb_free_device_list(devices, 1);
    libusb_exit(context);
    return 0xffffff02U;
  }

  CallbackState state;
  auto* transfer = libusb_alloc_transfer(0);
  unsigned char buffer[64] = {};
  if (transfer == nullptr) {
    libusb_close(handle);
    libusb_free_device_list(devices, 1);
    libusb_exit(context);
    return 0xffffff03U;
  }
  libusb_fill_bulk_transfer(transfer, handle, 0x81, buffer, sizeof(buffer),
                            transfer_callback, &state, 0);
  const int submit = libusb_submit_transfer(transfer);
  if (submit != LIBUSB_SUCCESS) {
    libusb_free_transfer(transfer);
    libusb_close(handle);
    libusb_free_device_list(devices, 1);
    libusb_exit(context);
    return 0xffffff04U;
  }
  if (fake_transfer_in_call_count() != 1) {
    // The transfer may already be in-flight; do not free it on this failure
    // path. The isolated runner will terminate without attempting cleanup.
    return 0xffffff05U;
  }

  // The backend's em_cancel_transfer() returns success but does not settle
  // the fake transferIn promise. Yield one bounded JavaScript task turn so
  // this is not merely a same-stack callback observation.
  const int cancel = libusb_cancel_transfer(transfer);
  const int callbacks_before_settle = state.callbacks;
  yield_one_task_turn();
  const int callbacks_after_settle = state.callbacks;
  const int status = state.status;
  if (fake_transfer_in_call_count() != 1) return 0xffffff06U;
  // Do not free/close/exit here: the Promise is intentionally still pending,
  // so libusb's transfer remains in-flight. The runner terminates this
  // isolated child after recording the observation; cleanup would be unsafe.
  return pack_report(callbacks_before_settle, callbacks_after_settle, status,
                     cancel);
}

// Isolated second scenario: settle the same fake Promise after cancellation,
// then let the real libusb event path deliver the callback.  The transfer is
// freed only after exactly one CANCELLED callback; every other path returns a
// fixed failure and intentionally leaks the isolated child state.
extern "C" std::uint32_t webts_libusb_webusb_cancel_settle_regression() {
  emit_settle_stage(1); // entered isolated settle scenario
  install_fake_webusb();

  libusb_context* context = nullptr;
  if (libusb_init(&context) != LIBUSB_SUCCESS) return 0xffffff10U;
  emit_settle_stage(2); // libusb context initialized
  libusb_device** devices = nullptr;
  const auto count = libusb_get_device_list(context, &devices);
  if (count != 1 || devices == nullptr) return 0xffffff11U;
  libusb_device_handle* handle = nullptr;
  if (libusb_open(devices[0], &handle) != LIBUSB_SUCCESS || handle == nullptr) {
    libusb_free_device_list(devices, 1);
    libusb_exit(context);
    return 0xffffff12U;
  }
  emit_settle_stage(3); // fake device opened

  CallbackState state;
  auto* transfer = libusb_alloc_transfer(0);
  unsigned char buffer[64] = {};
  if (transfer == nullptr) return 0xffffff13U;
  libusb_fill_bulk_transfer(transfer, handle, 0x81, buffer, sizeof(buffer),
                            transfer_callback, &state, 0);
  const int submit = libusb_submit_transfer(transfer);
  if (submit != LIBUSB_SUCCESS || fake_transfer_in_call_count() != 1) {
    // The transfer may still be in flight; do not touch it on this failure.
    return 0xffffff14U;
  }
  emit_settle_stage(4); // transferIn submitted and C++ assertion passed

  const int cancel = libusb_cancel_transfer(transfer);
  emit_settle_stage(5); // cancel returned
  settle_fake_transfer();
  emit_settle_stage(6); // fake Promise was resolved and yielded one task turn
  yield_one_task_turn();
  emit_settle_stage(7); // before libusb event processing

  int event_result = LIBUSB_SUCCESS;
  timeval zero_timeout{};
  for (int attempt = 0; attempt < 3 && state.callbacks == 0; ++attempt) {
    event_result = libusb_handle_events_timeout(context, &zero_timeout);
    emit_settle_stage(8 + attempt); // event processing attempt completed
    yield_one_task_turn();
  }
  if (state.callbacks != 1 || state.status != LIBUSB_TRANSFER_CANCELLED ||
      event_result != LIBUSB_SUCCESS || cancel != LIBUSB_SUCCESS) {
    // No free/close/exit: callback or Promise ownership was not proven safe.
    return pack_settle_report(state.callbacks, state.status, event_result, cancel);
  }

  emit_settle_stage(12); // callback verified; cleanup is about to begin
  const auto report = pack_settle_report(state.callbacks, state.status,
                                         event_result, cancel);
  libusb_free_transfer(transfer);
  libusb_close(handle);
  libusb_free_device_list(devices, 1);
  libusb_exit(context);
  emit_settle_stage(13); // cleanup completed
  return report;
}

// Isolated event-loop discriminator. It performs no WebUSB enumeration or
// transfer; it only asks the pristine libusb event path to process a zero
// timeout. A timeout result is a valid no-event observation, not a failure.
// If this call itself remains pending in a Worker, the caller must terminate
// the isolated Worker and must not attempt libusb cleanup from JavaScript.
extern "C" std::uint32_t webts_libusb_event_zero_timeout_smoke() {
  emit_settle_stage(1); // entered event-loop-only scenario
  libusb_context* context = nullptr;
  if (libusb_init(&context) != LIBUSB_SUCCESS || context == nullptr) {
    return 0xffffff20U;
  }
  emit_settle_stage(2); // context initialized
  timeval zero_timeout{};
  emit_settle_stage(3); // immediately before official event API
  const int result = libusb_handle_events_timeout(context, &zero_timeout);
  emit_settle_stage(4); // official event API returned
  const std::uint32_t classification = result == LIBUSB_SUCCESS ? 0U :
    result == LIBUSB_ERROR_TIMEOUT ? 1U : 2U;
  libusb_exit(context);
  emit_settle_stage(5); // cleanup completed
  return classification;
}

// Isolated source-bound scenario: the libusb user callback frees the transfer
// synchronously. Cleanup of the handle/context happens only after the event
// API returns. This does not exercise a late Promise, disconnect, or physical
// WebUSB abort; all failure paths intentionally leave the isolated child for
// its timeout supervisor rather than risking a second free.
extern "C" std::uint32_t webts_libusb_webusb_cancel_user_free_regression() {
  emit_settle_stage(14); // entered user-free scenario
  install_fake_webusb();
  libusb_context* context = nullptr;
  if (libusb_init(&context) != LIBUSB_SUCCESS || context == nullptr) return 0xffffff30U;
  emit_settle_stage(15); // context initialized
  libusb_device** devices = nullptr;
  const auto count = libusb_get_device_list(context, &devices);
  if (count != 1 || devices == nullptr) return 0xffffff31U;
  libusb_device_handle* handle = nullptr;
  if (libusb_open(devices[0], &handle) != LIBUSB_SUCCESS || handle == nullptr) return 0xffffff32U;
  emit_settle_stage(16); // fake device opened

  // Heap-own callback state and buffer so an unresolved failure path can be
  // abandoned safely when the isolated Worker is terminated. Stack-backed
  // state/buffer would become UAF if the fake Promise settled later.
  auto* state = new FreeCallbackState();
  auto* transfer = libusb_alloc_transfer(0);
  auto* buffer = new unsigned char[64]();
  if (transfer == nullptr) {
    delete[] buffer;
    delete state;
    libusb_close(handle);
    libusb_free_device_list(devices, 1);
    libusb_exit(context);
    return 0xffffff33U;
  }
  libusb_fill_bulk_transfer(transfer, handle, 0x81, buffer, 64,
                            free_transfer_callback, state, 0);
  const int submit = libusb_submit_transfer(transfer);
  if (submit != LIBUSB_SUCCESS) {
    libusb_free_transfer(transfer);
    delete[] buffer;
    delete state;
    libusb_close(handle);
    libusb_free_device_list(devices, 1);
    libusb_exit(context);
    return 0xffffff34U;
  }
  if (fake_transfer_in_call_count() != 1) {
    // Transfer-related memory is heap-owned; leave the isolated child parked
    // for its timeout supervisor rather than closing an in-flight handle.
    return 0xffffff35U;
  }
  emit_settle_stage(17); // transfer submitted and assertion passed

  const int cancel = libusb_cancel_transfer(transfer);
  emit_settle_stage(18); // cancel returned
  settle_fake_transfer();
  emit_settle_stage(19); // fake Promise resolved and yielded
  yield_one_task_turn();
  emit_settle_stage(20); // immediately before official event API

  timeval zero_timeout{};
  const int event_result = libusb_handle_events_timeout(context, &zero_timeout);
  emit_settle_stage(21); // event API returned
  const auto report = pack_user_free_report(state->callbacks, state->status,
                                            event_result, cancel, state->freed);
  if (!state->freed) {
    // The callback did not free the transfer, so Promise/transfer ownership is
    // still live. Heap state/buffer remain valid until isolated Worker exit;
    // no handle/context cleanup is attempted here.
    return report;
  }
  if (state->callbacks != 1 || state->status != LIBUSB_TRANSFER_CANCELLED ||
      event_result != LIBUSB_SUCCESS || cancel != LIBUSB_SUCCESS) {
    delete[] buffer;
    delete state;
    libusb_close(handle);
    libusb_free_device_list(devices, 1);
    libusb_exit(context);
    return report;
  }
  libusb_close(handle);
  libusb_free_device_list(devices, 1);
  libusb_exit(context);
  delete[] buffer;
  delete state;
  emit_settle_stage(22); // handle/context cleanup completed
  return report;
}

// Isolated pending-close observation. Core removes the in-flight transfer and
// nulls its dev_handle before invoking the official backend close. Because the
// backend promise still retains raw itransfer, no Promise settlement, transfer
// free, or libusb_exit is attempted after close; the isolated supervisor owns
// termination. The report only says whether libusb_close returned and whether
// the fake transfer remained callback-free/pending at that instant.
extern "C" std::uint32_t webts_libusb_webusb_pending_close_regression() {
  emit_settle_stage(23); // entered pending-close scenario
  libusb_set_log_cb(nullptr, discard_libusb_log, LIBUSB_LOG_CB_GLOBAL);
  install_fake_webusb();
  libusb_context* context = nullptr;
  if (libusb_init(&context) != LIBUSB_SUCCESS || context == nullptr) return 0xffffff40U;
  emit_settle_stage(24); // context initialized
  libusb_device** devices = nullptr;
  const auto count = libusb_get_device_list(context, &devices);
  if (count != 1 || devices == nullptr) return 0xffffff41U;
  libusb_device_handle* handle = nullptr;
  if (libusb_open(devices[0], &handle) != LIBUSB_SUCCESS || handle == nullptr) return 0xffffff42U;
  emit_settle_stage(25); // fake device opened
  auto* state = new CallbackState();
  auto* buffer = new unsigned char[64]();
  auto* transfer = libusb_alloc_transfer(0);
  if (transfer == nullptr) return 0xffffff43U;
  libusb_fill_bulk_transfer(transfer, handle, 0x81, buffer, 64,
                            transfer_callback, state, 0);
  const int submit = libusb_submit_transfer(transfer);
  if (submit != LIBUSB_SUCCESS || fake_transfer_in_call_count() != 1) {
    // Do not attempt cleanup if submit may have entered the in-flight path.
    return 0xffffff44U;
  }
  emit_settle_stage(26); // transfer submitted and fake Promise is pending
  libusb_close(handle);
  emit_settle_stage(27); // libusb_close returned
  const auto report = pack_close_report(state->callbacks, state->status, true,
                                        fake_transfer_in_call_count());
  // Intentionally leak isolated transfer/state/buffer/list/context. The late
  // Promise callback may still retain itransfer; only Worker/process teardown
  // is used as cleanup, never a second close/free/exit here.
  (void)devices;
  (void)context;
  emit_settle_stage(28); // observation packed; isolated termination required
  return report;
}
