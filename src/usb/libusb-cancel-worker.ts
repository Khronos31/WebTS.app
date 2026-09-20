export {};

interface CancellationModule {
  ccall(name: string, returnType: 'number', argTypes: string[], args: number[], options?: { async: true }): Promise<number>;
}

interface WorkerRequest { readonly type: 'run' | 'run-settle' | 'run-event' | 'run-user-free' | 'run-pending-close'; readonly moduleUrl: string; }

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: unknown): void;
};

scope.onmessage = async (event) => {
  if (!event.data || (event.data.type !== 'run' && event.data.type !== 'run-settle' && event.data.type !== 'run-event' && event.data.type !== 'run-user-free' && event.data.type !== 'run-pending-close')) return;
  const report = event.data.type === 'run-event'
    ? await executeEvent(event.data.moduleUrl)
    : event.data.type === 'run-user-free'
      ? await executeUserFree(event.data.moduleUrl)
      : event.data.type === 'run-pending-close'
        ? await executePendingClose(event.data.moduleUrl)
    : await execute(event.data.moduleUrl, event.data.type === 'run-settle');
  scope.postMessage({ type: 'libusb-cancel-worker-result', report });
};

async function execute(moduleUrl: string, settle: boolean) {
  let module: CancellationModule;
  try {
    const imported = await import(/* @vite-ignore */ moduleUrl) as { default?: unknown };
    if (typeof imported.default !== 'function') return failed('WORKER_FAILED', settle);
    module = await (imported.default as () => Promise<CancellationModule>)();
  } catch { return failed('WORKER_FAILED', settle); }
  try {
    const packed = (await module.ccall(
      settle ? 'webts_libusb_webusb_cancel_settle_regression' : 'webts_libusb_webusb_cancel_regression',
      'number', [], [], { async: true },
    )) >>> 0;
    if ((packed & 0xff000000) === 0xff000000) return failed('FAILED', settle);
    if (settle) {
      const callbackCount = packed & 0xff;
      const callbackStatus = (packed >>> 8) & 0xff;
      const eventResult = ((packed >>> 16) & 0xff) - 16;
      const cancelReturn = ((packed >>> 24) & 0xff) - 16;
      return callbackCount === 1 && callbackStatus === 3 && eventResult === 0 && cancelReturn === 0
        ? { diagnostic: 'OBSERVED' as const, callbackCount, callbackStatus, eventResult,
          backendCancelReturn: cancelReturn, physicalAbortProven: false as const }
        : { diagnostic: 'FAILED' as const, callbackCount: null, callbackStatus: null,
          eventResult: null, backendCancelReturn: null, physicalAbortProven: false as const };
    }
    const callbacksBefore = packed & 0xff;
    const callbacksAfter = (packed >>> 8) & 0xff;
    const status = (packed >>> 16) & 0xff;
    const cancelReturn = ((packed >>> 24) & 0xff) - 16;
    if (callbacksBefore !== 0 || callbacksAfter !== 0 || status !== 255 || cancelReturn !== 0) {
      return failed('FAILED', settle);
    }
    return {
      diagnostic: 'OBSERVED' as const,
      backendCancelReturn: cancelReturn,
      callbacksBeforePromiseSettlement: callbacksBefore,
      callbacksAfterTaskTurnWithoutPromiseSettlement: callbacksAfter,
      transferStatusWhilePromisePending: status,
      // The C++ harness asserts transferInCalls == 1 before packing success;
      // this field is therefore a fixed assertion result, not a raw counter.
      fakeTransferInCalls: 1,
      cancelDidNotSettleWithinTaskTurn: true,
      fakePromiseStillPending: true,
      physicalAbortProven: false as const,
    };
  } catch { return failed('WORKER_FAILED', settle); }
}

function failed(diagnostic: 'FAILED' | 'WORKER_FAILED', settle: boolean) {
  if (settle) {
    return {
      diagnostic, callbackCount: null, callbackStatus: null, eventResult: null,
      backendCancelReturn: null, physicalAbortProven: false as const,
    };
  }
  return {
    diagnostic,
    backendCancelReturn: null,
    callbacksBeforePromiseSettlement: null,
    callbacksAfterTaskTurnWithoutPromiseSettlement: null,
    transferStatusWhilePromisePending: null,
    fakeTransferInCalls: null,
    cancelDidNotSettleWithinTaskTurn: false,
    fakePromiseStillPending: false,
    physicalAbortProven: false as const,
  };
}

async function executeEvent(moduleUrl: string) {
  let module: CancellationModule;
  try {
    const imported = await import(/* @vite-ignore */ moduleUrl) as { default?: unknown };
    if (typeof imported.default !== 'function') return eventFailed('WORKER_FAILED');
    module = await (imported.default as () => Promise<CancellationModule>)();
  } catch { return eventFailed('WORKER_FAILED'); }
  try {
    const packed = (await module.ccall(
      'webts_libusb_event_zero_timeout_smoke', 'number', [], [], { async: true },
    )) >>> 0;
    if (packed === 0) return { diagnostic: 'OBSERVED' as const, eventClass: 'SUCCESS' as const, physicalAbortProven: false as const };
    if (packed === 1) return { diagnostic: 'OBSERVED' as const, eventClass: 'NO_EVENT_TIMEOUT' as const, physicalAbortProven: false as const };
    return eventFailed('FAILED');
  } catch { return eventFailed('WORKER_FAILED'); }
}

function eventFailed(diagnostic: 'FAILED' | 'WORKER_FAILED') {
  return { diagnostic, eventClass: null, physicalAbortProven: false as const };
}

async function executeUserFree(moduleUrl: string) {
  let module: CancellationModule;
  try {
    const imported = await import(/* @vite-ignore */ moduleUrl) as { default?: unknown };
    if (typeof imported.default !== 'function') return userFreeFailed('WORKER_FAILED');
    module = await (imported.default as () => Promise<CancellationModule>)();
  } catch { return userFreeFailed('WORKER_FAILED'); }
  try {
    const packed = (await module.ccall(
      'webts_libusb_webusb_cancel_user_free_regression', 'number', [], [], { async: true },
    )) >>> 0;
    if ((packed & 0xff000000) === 0xff000000) return userFreeFailed('FAILED');
    const callbackCount = packed & 0xff;
    const callbackStatus = (packed >>> 8) & 0xff;
    const eventResult = ((packed >>> 16) & 0xff) - 16;
    const cancelByte = (packed >>> 24) & 0xff;
    const backendCancelReturn = (cancelByte & 0x7f) - 16;
    const freedInCallback = (cancelByte & 0x80) !== 0;
    if (callbackCount === 1 && callbackStatus === 3 && eventResult === 0 &&
        backendCancelReturn === 0 && freedInCallback) {
      return { diagnostic: 'OBSERVED' as const, callbackCount, callbackStatus,
        eventResult, backendCancelReturn, freedInCallback, physicalAbortProven: false as const };
    }
    return userFreeFailed('FAILED');
  } catch { return userFreeFailed('WORKER_FAILED'); }
}

function userFreeFailed(diagnostic: 'FAILED' | 'WORKER_FAILED') {
  return { diagnostic, callbackCount: null, callbackStatus: null, eventResult: null,
    backendCancelReturn: null, freedInCallback: null, physicalAbortProven: false as const };
}

async function executePendingClose(moduleUrl: string) {
  let module: CancellationModule;
  try {
    const imported = await import(/* @vite-ignore */ moduleUrl) as { default?: unknown };
    if (typeof imported.default !== 'function') return pendingCloseFailed('WORKER_FAILED');
    module = await (imported.default as () => Promise<CancellationModule>)();
  } catch { return pendingCloseFailed('WORKER_FAILED'); }
  try {
    const packed = (await module.ccall(
      'webts_libusb_webusb_pending_close_regression', 'number', [], [], { async: true },
    )) >>> 0;
    if ((packed & 0xff000000) === 0xff000000) return pendingCloseFailed('FAILED');
    const callbacks = packed & 0xff;
    const status = (packed >>> 8) & 0xff;
    const closeReturned = ((packed >>> 16) & 0xff) === 1;
    const fakeTransferInCalls = (packed >>> 24) & 0xff;
    if (callbacks === 0 && status === 255 && closeReturned && fakeTransferInCalls === 1) {
      return { diagnostic: 'OBSERVED' as const, callbacks, status, closeReturned,
        fakeTransferInCalls, promiseSettlementObserved: false, physicalAbortProven: false as const };
    }
    return pendingCloseFailed('FAILED');
  } catch { return pendingCloseFailed('WORKER_FAILED'); }
}

function pendingCloseFailed(diagnostic: 'FAILED' | 'WORKER_FAILED') {
  return { diagnostic, callbacks: null, status: null, closeReturned: false,
    fakeTransferInCalls: null, promiseSettlementObserved: false, physicalAbortProven: false as const };
}
