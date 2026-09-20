/*
 * Test-only source-bound regression for the libusb 1.0.30 core/WebUSB backend
 * transfer-ownership boundary.
 *
 * The same harness is linked twice: once against the pristine official
 * `emscripten_webusb.cpp` (the failure baseline) and once against an ignored
 * build copy carrying the WebTS.app ownership patch. Every scenario runs in
 * its own bounded isolated child process or Dedicated Worker.
 *
 * The only USB surface is a fake `navigator.usb` installed inside this module.
 * No real device, firmware, mode, tune, TS, or B25 path is touched, and this
 * file is never linked into an M1 or production module.
 */
#include <emscripten.h>

#include <cstdint>
#include <cstring>

#include <libusb.h>

#include "libusbi.h"

namespace {

constexpr int kReportWords = 20;

// Fixed diagnostics. OK means every expectation of the selected scenario held.
constexpr int kDiagOk = 0;
constexpr int kDiagDiverged = 1;  // ran to completion, expectations unmet
constexpr int kDiagUnknownScenario = 2;
constexpr int kDiagInvalidOutput = 3;
constexpr int kDiagSetupFailed = 4;
constexpr int kDiagHarnessFailed = 5;

// Fixed scenario ids.
constexpr int kScenarioPendingCancelBounded = 0;
constexpr int kScenarioLateResolveAfterCancel = 1;
constexpr int kScenarioLateRejectAfterCancel = 2;
constexpr int kScenarioUserFreeThenLateResolve = 3;
constexpr int kScenarioDoubleCancel = 4;
constexpr int kScenarioDisconnectWhilePending = 5;
constexpr int kScenarioMultiHandleCancelClose = 6;
constexpr int kScenarioNaturalCompletion = 7;
constexpr int kScenarioDisconnectUserFreeLateResolve = 8;
// Exploratory: a logical cancellation is signalled and core's disconnect path
// then runs before the event loop handles it. This probes core's own
// flying/completed list ordering, which the backend patch does not change.
constexpr int kScenarioCancelThenDisconnectBeforeEvents = 9;
constexpr int kScenarioCount = 10;

constexpr int kTransferLength = 64;
constexpr int kNaturalPayloadLength = 32;
constexpr int kMaxEventAttempts = 8;

// clang-format off
EM_JS(void, webts_install_fake_usb, (), {
  const descriptor = new DataView(Uint8Array.from([
    18, 1, 0x00, 0x02, 0, 0, 0, 64, 0x75, 0x32, 0x80, 0x00,
    1, 0, 1, 2, 3, 0
  ]).buffer);
  const state = {
    transferInCalls: 0,
    pending: [],
    suppressedConsoleErrors: 0,
    realConsoleError: null
  };
  const device = {
    configuration: null,
    open: () => Promise.resolve(),
    close: () => Promise.resolve(),
    controlTransferIn: () => Promise.resolve({ status: 'ok', data: descriptor }),
    transferIn: () => {
      state.transferInCalls++;
      return new Promise((resolve, reject) => {
        state.pending.push({ resolve: resolve, reject: reject, settled: false });
      });
    }
  };
  if (!globalThis.navigator) {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  }
  Object.defineProperty(globalThis.navigator, 'usb', {
    configurable: true, value: { getDevices: () => Promise.resolve([device]) }
  });
  globalThis.__webtsOwnership = state;
});

EM_JS(int, webts_transfer_in_calls, (), {
  const state = globalThis.__webtsOwnership;
  return state ? state.transferInCalls : -1;
});

EM_JS(int, webts_suppressed_console_errors, (), {
  const state = globalThis.__webtsOwnership;
  return state ? state.suppressedConsoleErrors : -1;
});

EM_ASYNC_JS(void, webts_yield, (), {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

// mode 0: resolve with a short IN payload, mode 1: reject with an AbortError
// shaped DOMException-like value. The official backend's promise wrapper calls
// console.error on rejection, so that one call is captured into a counter
// instead of being written to the isolated child's stderr.
EM_ASYNC_JS(int, webts_settle_pending, (int index, int mode, int payloadLength), {
  const state = globalThis.__webtsOwnership;
  if (!state) return -1;
  const entry = state.pending[index];
  if (!entry || entry.settled) return -1;
  entry.settled = true;
  if (mode === 0) {
    entry.resolve({ status: 'ok', data: new DataView(new Uint8Array(payloadLength).buffer) });
  } else {
    state.realConsoleError = console.error;
    console.error = () => { state.suppressedConsoleErrors++; };
    const error = new Error('test-only rejection');
    error.name = 'AbortError';
    entry.reject(error);
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (mode !== 0 && state.realConsoleError) {
    console.error = state.realConsoleError;
    state.realConsoleError = null;
  }
  return 0;
});

EM_JS(void, webts_emit_stage, (int scenario, int stage), {
  if (typeof globalThis.postMessage === 'function') {
    globalThis.postMessage({ type: 'libusb-ownership-progress', scenario, stage });
  }
});
// clang-format on

// Observation hooks exist only in the patched build copy. The pristine build
// links the stubs below so the same harness source produces a baseline report.
#ifdef WEBTS_LIBUSB_OWNERSHIP_PATCH
extern "C" unsigned webts_libusb_em_priv_constructed_count(void);
extern "C" unsigned webts_libusb_em_priv_destroyed_count(void);
extern "C" unsigned webts_libusb_em_logical_signal_count(void);
extern "C" unsigned webts_libusb_em_late_after_detach_count(void);
extern "C" unsigned webts_libusb_em_late_after_settle_count(void);
int priv_constructed() { return static_cast<int>(webts_libusb_em_priv_constructed_count()); }
int priv_destroyed() { return static_cast<int>(webts_libusb_em_priv_destroyed_count()); }
int logical_signals() { return static_cast<int>(webts_libusb_em_logical_signal_count()); }
int late_after_detach() { return static_cast<int>(webts_libusb_em_late_after_detach_count()); }
int late_after_settle() { return static_cast<int>(webts_libusb_em_late_after_settle_count()); }
#else
int priv_constructed() { return -1; }
int priv_destroyed() { return -1; }
int logical_signals() { return -1; }
int late_after_detach() { return -1; }
int late_after_settle() { return -1; }
#endif

struct CallbackState {
  int callbacks = 0;
  int status = -1;
  int transferred = -1;
  bool free_in_callback = false;
  bool freed = false;
};

void transfer_callback(libusb_transfer* transfer) {
  auto* state = static_cast<CallbackState*>(transfer->user_data);
  ++state->callbacks;
  state->status = static_cast<int>(transfer->status);
  state->transferred = transfer->actual_length;
  if (state->free_in_callback && !state->freed) {
    // The callback is the only owner that frees this transfer. Nothing after
    // this point in the harness may touch it.
    libusb_free_transfer(transfer);
    state->freed = true;
  }
}

void discard_libusb_log(libusb_context*, enum libusb_log_level, const char*) {}

// Bounded zero-timeout event pumping. A non-success result stops the loop so a
// hang or an error is reported rather than retried indefinitely.
int pump_events(libusb_context* context, const CallbackState& state,
                int attempts) {
  timeval zero_timeout{};
  int result = LIBUSB_SUCCESS;
  for (int attempt = 0; attempt < attempts; ++attempt) {
    result = libusb_handle_events_timeout(context, &zero_timeout);
    if (result != LIBUSB_SUCCESS) break;
    webts_yield();
    if (state.callbacks > 0 && attempt >= 1) break;
  }
  return result;
}

struct Report {
  int values[kReportWords] = {};

  void set(int index, int value) {
    if (index >= 0 && index < kReportWords) values[index] = value;
  }

  void capture_hooks() {
    set(7, priv_constructed());
    set(8, priv_destroyed());
    set(9, logical_signals());
    set(10, late_after_detach());
    set(11, late_after_settle());
    set(18, webts_transfer_in_calls());
    set(17, webts_suppressed_console_errors());
    set(19, 0);  // physicalAbortProven is never claimed by this harness
  }
};

struct Fixture {
  libusb_context* context = nullptr;
  libusb_device** devices = nullptr;
  libusb_device_handle* handle = nullptr;
  libusb_device_handle* second_handle = nullptr;
  bool setup_ok = false;
};

bool open_fixture(Fixture& fixture, bool second_handle) {
  libusb_set_log_cb(nullptr, discard_libusb_log, LIBUSB_LOG_CB_GLOBAL);
  webts_install_fake_usb();
  if (libusb_init(&fixture.context) != LIBUSB_SUCCESS || fixture.context == nullptr) {
    return false;
  }
  const auto count = libusb_get_device_list(fixture.context, &fixture.devices);
  if (count != 1 || fixture.devices == nullptr) return false;
  if (libusb_open(fixture.devices[0], &fixture.handle) != LIBUSB_SUCCESS ||
      fixture.handle == nullptr) {
    return false;
  }
  if (second_handle) {
    if (libusb_open(fixture.devices[0], &fixture.second_handle) != LIBUSB_SUCCESS ||
        fixture.second_handle == nullptr) {
      return false;
    }
  }
  fixture.setup_ok = true;
  return true;
}

// Heap-owned so an unmet expectation can be abandoned safely when the isolated
// child or Worker is terminated. Stack storage would become a use-after-free if
// the fake promise settled later.
struct TransferOwner {
  CallbackState* state = new CallbackState();
  unsigned char* buffer = new unsigned char[kTransferLength]();
  libusb_transfer* transfer = libusb_alloc_transfer(0);
};

bool submit(TransferOwner& owner, libusb_device_handle* handle) {
  if (owner.transfer == nullptr) return false;
  libusb_fill_bulk_transfer(owner.transfer, handle, 0x81, owner.buffer,
                            kTransferLength, transfer_callback, owner.state, 0);
  return libusb_submit_transfer(owner.transfer) == LIBUSB_SUCCESS;
}

}  // namespace

// Runs exactly one scenario. The caller must use a fresh module instance per
// scenario: unmet expectations intentionally leave libusb state parked instead
// of risking a second free or a close over an in-flight transfer.
extern "C" int webts_libusb_ownership_regression(int scenario, int* out, int words) {
  if (out == nullptr || words != kReportWords) return kDiagInvalidOutput;
  if (scenario < 0 || scenario >= kScenarioCount) return kDiagUnknownScenario;

  Report report;
  report.set(0, scenario);
  report.set(2, 0);
  report.set(3, -1);
  report.set(4, -1000);
  report.set(5, -1000);
  report.set(6, -1000);
  report.set(14, 0);
  report.set(15, -1);
  report.set(16, -1);

  auto publish = [&](int stage, int diagnostic) {
    report.set(1, stage);
    report.capture_hooks();
    std::memcpy(out, report.values, sizeof(report.values));
    return diagnostic;
  };

  const bool wants_second_handle = scenario == kScenarioMultiHandleCancelClose;
  Fixture fixture;
  webts_emit_stage(scenario, 1);
  if (!open_fixture(fixture, wants_second_handle)) {
    return publish(1, kDiagSetupFailed);
  }
  webts_emit_stage(scenario, 2);

  TransferOwner primary;
  if (scenario == kScenarioUserFreeThenLateResolve ||
      scenario == kScenarioDisconnectUserFreeLateResolve) {
    primary.state->free_in_callback = true;
  }
  if (!submit(primary, fixture.handle)) return publish(2, kDiagSetupFailed);
  if (webts_transfer_in_calls() != 1) return publish(2, kDiagHarnessFailed);
  webts_emit_stage(scenario, 3);

  TransferOwner secondary;
  if (scenario == kScenarioMultiHandleCancelClose) {
    if (!submit(secondary, fixture.second_handle)) return publish(3, kDiagSetupFailed);
    if (webts_transfer_in_calls() != 2) return publish(3, kDiagHarnessFailed);
  }
  webts_emit_stage(scenario, 4);


  bool expectations_met = false;
  timeval zero_timeout{};

  if (scenario == kScenarioNaturalCompletion) {
    // Regression guard: the ownership patch must not change ordinary
    // completion. No cancellation is requested in this scenario at all.
    if (webts_settle_pending(0, 0, kNaturalPayloadLength) != 0) {
      return publish(4, kDiagHarnessFailed);
    }
    webts_emit_stage(scenario, 5);
    const int event_result =
        pump_events(fixture.context, *primary.state, kMaxEventAttempts);
    report.set(6, event_result);
    report.set(2, primary.state->callbacks);
    report.set(3, primary.state->status);
    report.set(16, primary.state->transferred);
    expectations_met = event_result == LIBUSB_SUCCESS &&
                       primary.state->callbacks == 1 &&
                       primary.state->status == LIBUSB_TRANSFER_COMPLETED &&
                       primary.state->transferred == kNaturalPayloadLength;
  } else if (scenario == kScenarioDisconnectWhilePending ||
             scenario == kScenarioDisconnectUserFreeLateResolve) {
    // Core's disconnect path clears the backend transfer private data and then
    // completes the transfer with NO_DEVICE while the fake promise is pending.
    usbi_handle_disconnect(fixture.context, fixture.handle);
    webts_emit_stage(scenario, 5);
    const int callbacks_after_disconnect = primary.state->callbacks;
    // The WebUSB promise settles only after the transfer is already completed.
    if (webts_settle_pending(0, 0, kNaturalPayloadLength) != 0) {
      return publish(5, kDiagHarnessFailed);
    }
    webts_yield();
    const int late_event_result =
        libusb_handle_events_timeout(fixture.context, &zero_timeout);
    report.set(6, late_event_result);
    report.set(2, primary.state->callbacks);
    report.set(3, primary.state->status);
    webts_emit_stage(scenario, 6);
    report.set(12, primary.state->freed ? 1 : 0);
    expectations_met = callbacks_after_disconnect == 1 &&
                       primary.state->callbacks == 1 &&
                       primary.state->status == LIBUSB_TRANSFER_NO_DEVICE &&
                       late_event_result == LIBUSB_SUCCESS &&
                       late_after_detach() == 1 && late_after_settle() == 0;
    if (scenario == kScenarioDisconnectUserFreeLateResolve) {
      // The disconnect callback freed the transfer. In the pristine backend the
      // late promise still holds that raw usbi_transfer*, so this scenario is a
      // deliberate use-after-free there and its baseline outcome is undefined.
      expectations_met = expectations_met && primary.state->freed;
    }
  } else if (scenario == kScenarioCancelThenDisconnectBeforeEvents) {
    const int cancel = libusb_cancel_transfer(primary.transfer);
    report.set(4, cancel);
    // No event pump in between: core's disconnect walks the flying list while a
    // logical completion may already be queued on the completed list.
    usbi_handle_disconnect(fixture.context, fixture.handle);
    webts_emit_stage(scenario, 5);
    const int event_result =
        pump_events(fixture.context, *primary.state, kMaxEventAttempts);
    report.set(6, event_result);
    if (webts_settle_pending(0, 0, kNaturalPayloadLength) != 0) {
      return publish(5, kDiagHarnessFailed);
    }
    webts_yield();
    libusb_handle_events_timeout(fixture.context, &zero_timeout);
    report.set(2, primary.state->callbacks);
    report.set(3, primary.state->status);
    webts_emit_stage(scenario, 6);
    // Safety would require exactly one logical completion for this transfer.
    expectations_met = primary.state->callbacks == 1 &&
                       event_result == LIBUSB_SUCCESS &&
                       late_after_settle() == 0;
  } else {
    const int cancel = libusb_cancel_transfer(primary.transfer);
    report.set(4, cancel);
    webts_emit_stage(scenario, 5);

    if (scenario == kScenarioDoubleCancel) {
      // Core rejects the second cancel before it reaches the backend, so at
      // most one logical completion may be delivered.
      report.set(5, libusb_cancel_transfer(primary.transfer));
    } else if (scenario == kScenarioMultiHandleCancelClose) {
      report.set(5, libusb_cancel_transfer(secondary.transfer));
    }

    const int event_result =
        pump_events(fixture.context, *primary.state, kMaxEventAttempts);
    report.set(6, event_result);
    report.set(2, primary.state->callbacks);
    report.set(3, primary.state->status);
    report.set(12, primary.state->freed ? 1 : 0);
    webts_emit_stage(scenario, 6);

    const bool bounded_cancel = cancel == LIBUSB_SUCCESS &&
                                event_result == LIBUSB_SUCCESS &&
                                primary.state->callbacks == 1 &&
                                primary.state->status == LIBUSB_TRANSFER_CANCELLED;

    if (scenario == kScenarioPendingCancelBounded) {
      // The fake promise is deliberately never settled here.
      expectations_met = bounded_cancel && late_after_detach() == 0 &&
                         late_after_settle() == 0;
    } else if (scenario == kScenarioDoubleCancel) {
      expectations_met = bounded_cancel &&
                         report.values[5] == LIBUSB_ERROR_NOT_FOUND &&
                         late_after_detach() == 0 && late_after_settle() == 0;
    } else if (scenario == kScenarioMultiHandleCancelClose) {
      const int secondary_event =
          pump_events(fixture.context, *secondary.state, kMaxEventAttempts);
      report.set(14, secondary.state->callbacks);
      report.set(15, secondary.state->status);
      const bool secondary_bounded =
          secondary_event == LIBUSB_SUCCESS &&
          secondary.state->callbacks == 1 &&
          secondary.state->status == LIBUSB_TRANSFER_CANCELLED &&
          report.values[5] == LIBUSB_SUCCESS;
      if (bounded_cancel && secondary_bounded) {
        // Both handles reference the same fake device; the official backend's
        // open/close chain owns the device reference count.
        libusb_close(fixture.second_handle);
        fixture.second_handle = nullptr;
        report.set(13, 1);
        expectations_met = true;
      }
    } else if (!bounded_cancel ||
               (scenario == kScenarioUserFreeThenLateResolve &&
                !primary.state->freed)) {
      expectations_met = false;
    } else {
      const int mode = scenario == kScenarioLateRejectAfterCancel ? 1 : 0;
      if (webts_settle_pending(0, mode, kNaturalPayloadLength) != 0) {
        return publish(6, kDiagHarnessFailed);
      }
      webts_yield();
      webts_emit_stage(scenario, 7);
      // A second bounded pump proves the late promise queued no further work.
      const int late_event_result =
          libusb_handle_events_timeout(fixture.context, &zero_timeout);
      report.set(6, late_event_result);
      report.set(2, primary.state->callbacks);
      expectations_met = primary.state->callbacks == 1 &&
                         late_event_result == LIBUSB_SUCCESS &&
                         late_after_detach() == 1 && late_after_settle() == 0;
      if (scenario == kScenarioLateRejectAfterCancel) {
        // The official promise wrapper logs the rejection; the harness captures
        // that call so no raw error text reaches the isolated child's stderr.
        expectations_met =
            expectations_met && webts_suppressed_console_errors() >= 1;
      }
    }
  }

  const int result = publish(8, expectations_met ? kDiagOk : kDiagDiverged);

  if (expectations_met) {
    // Every transfer reached exactly one logical completion and its shared
    // state was detached, so freeing here cannot race a late promise.
    if (!primary.state->freed) libusb_free_transfer(primary.transfer);
    delete[] primary.buffer;
    delete primary.state;
    libusb_free_transfer(secondary.transfer);
    delete[] secondary.buffer;
    delete secondary.state;
    libusb_close(fixture.handle);
    libusb_free_device_list(fixture.devices, 1);
    libusb_exit(fixture.context);
    webts_emit_stage(scenario, 9);
  }
  // Otherwise: park. The isolated supervisor terminates this child or Worker;
  // no second free and no close over an in-flight transfer is attempted.
  return result;
}
