/**
 * WebTS.app - Device-independent tuner adapter contract and lifecycle
 * License: GPL-2.0-only
 */

export type TunerState =
  | 'IDLE' | 'OPENING' | 'OPEN' | 'TUNING' | 'TUNED' | 'STARTING'
  | 'STREAMING' | 'STOPPING' | 'CLOSING' | 'CLOSED' | 'DISCONNECTED';

export type TunerOperation = 'open' | 'firmware' | 'tune' | 'start' | 'stop' | 'close' | null;

export interface TuneRequest {
  readonly channel: number | string;
  readonly [key: string]: unknown;
}

/** Boundary for a future transport implementation; deliberately not WebUSB-specific. */
export interface UsbTransport {
  open(signal: AbortSignal): Promise<void>;
  close(signal: AbortSignal): Promise<void>;
}

export interface TunerOperations {
  open?(signal: AbortSignal): Promise<void>;
  firmware?(signal: AbortSignal): Promise<void>;
  tune?(request: TuneRequest, signal: AbortSignal): Promise<void>;
  start?(signal: AbortSignal): Promise<void>;
  stop?(signal: AbortSignal): Promise<void>;
  close?(signal: AbortSignal): Promise<void>;
  onDisconnect?(): void | Promise<void>;
}

export interface TunerStatus {
  readonly state: TunerState;
  readonly busy: boolean;
  readonly operation: TunerOperation;
  readonly sessionId: number;
  readonly error: TunerErrorInfo | null;
}

export type TunerStatusListener = (status: TunerStatus) => void;

export interface TunerAdapter {
  readonly state: TunerState;
  open(signal?: AbortSignal): Promise<void>;
  firmware(signal?: AbortSignal): Promise<void>;
  tune(request: TuneRequest, signal?: AbortSignal): Promise<void>;
  start(signal?: AbortSignal): Promise<void>;
  stop(signal?: AbortSignal): Promise<void>;
  close(signal?: AbortSignal): Promise<void>;
  disconnect(): void;
  onStatusChange(listener: TunerStatusListener): () => void;
}

export type TunerErrorCode = 'INVALID_STATE' | 'BUSY' | 'ABORTED' | 'DISCONNECTED' | 'OPERATION_FAILED' | 'NOT_IMPLEMENTED';

/** Safe status/cause information; raw device errors are never exposed. */
export interface TunerErrorInfo {
  readonly code: TunerErrorCode;
  readonly operation: TunerOperation;
  readonly cleanupFailed?: boolean;
}

export class TunerAdapterError extends Error {
  public readonly code: TunerErrorCode;
  public readonly operation: TunerOperation;
  public readonly cause: TunerErrorInfo | null;
  public constructor(code: TunerErrorCode, message: string, operation: TunerOperation = null, cause: TunerErrorInfo | null = null) {
    super(message);
    this.name = 'TunerAdapterError';
    this.code = code;
    this.operation = operation;
    this.cause = cause;
  }
}

class CleanupFailure extends Error {
  public readonly primaryError: unknown;
  public readonly cleanupError: unknown | null;
  public readonly cleanupState: TunerState;

  public constructor(
    message: string,
    primaryError: unknown,
    cleanupError: unknown | null,
    cleanupState: TunerState,
  ) {
    super(message);
    this.name = 'CleanupFailure';
    this.primaryError = primaryError;
    this.cleanupError = cleanupError;
    this.cleanupState = cleanupState;
  }
}

interface OperationToken {
  readonly generation: number;
  readonly previousState: TunerState;
  readonly operation: Exclude<TunerOperation, null>;
  readonly controller: AbortController;
}

/** Lifecycle safety only; all device-specific commands are injected. */
export class ManagedTunerAdapter implements TunerAdapter {
  private currentState: TunerState = 'IDLE';
  private operationInFlight = false;
  private generation = 0;
  private sessionId = 0;
  private readonly listeners = new Set<TunerStatusListener>();
  private readonly operations: TunerOperations;
  private activeToken: OperationToken | null = null;
  private lastError: TunerErrorInfo | null = null;

  public constructor(operations: TunerOperations = {}) { this.operations = operations; }
  public get state(): TunerState { return this.currentState; }
  public isBusy(): boolean { return this.operationInFlight; }
  public getStatus(): TunerStatus { return this.snapshot(); }

  public onStatusChange(listener: TunerStatusListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  public open(signal?: AbortSignal): Promise<void> {
    return this.run('open', ['IDLE', 'CLOSED', 'DISCONNECTED'], 'OPENING', 'OPEN', signal,
      async (s) => {
        try {
          await this.operations.open?.(s);
          if (s.aborted) {
            let closeError: unknown | null = null;
            try {
              await this.operations.close?.(compensationSignal());
            } catch (error) {
              closeError = error;
            }
            throw new CleanupFailure('Open completed after cancellation', abortedError('open'), closeError, 'IDLE');
          }
        } catch (error) {
          if (error instanceof CleanupFailure) throw error;
          let closeError: unknown | null = null;
          try {
            await this.operations.close?.(compensationSignal());
          } catch (cleanupError) {
            closeError = cleanupError;
          }
          throw new CleanupFailure('Open failed and cleanup was attempted', error, closeError, 'IDLE');
        }
      });
  }
  public firmware(signal?: AbortSignal): Promise<void> {
    return this.run('firmware', ['OPEN', 'TUNED'], 'OPEN', 'OPEN', signal,
      (s) => this.operations.firmware?.(s));
  }
  public tune(request: TuneRequest, signal?: AbortSignal): Promise<void> {
    return this.run('tune', ['OPEN', 'TUNED'], 'TUNING', 'TUNED', signal,
      (s) => this.operations.tune?.(request, s));
  }
  public start(signal?: AbortSignal): Promise<void> {
    return this.run('start', ['TUNED'], 'STARTING', 'STREAMING', signal,
      async (s) => {
        try {
          await this.operations.start?.(s);
          if (s.aborted) {
            let stopError: unknown | null = null;
            try {
              await this.operations.stop?.(compensationSignal());
            } catch (error) {
              stopError = error;
            }
            throw new CleanupFailure('Start completed after cancellation', abortedError('start'), stopError, 'TUNED');
          }
        } catch (error) {
          if (error instanceof CleanupFailure) throw error;
          let stopError: unknown | null = null;
          try {
            await this.operations.stop?.(compensationSignal());
          } catch (cleanupError) {
            stopError = cleanupError;
          }
          throw new CleanupFailure('Start failed and stream cleanup was attempted', error, stopError, 'TUNED');
        }
      });
  }
  public stop(signal?: AbortSignal): Promise<void> {
    return this.run('stop', ['STREAMING'], 'STOPPING', 'TUNED', signal,
      (s) => this.operations.stop?.(s));
  }
  public close(signal?: AbortSignal): Promise<void> {
    if (this.currentState === 'CLOSED' || this.currentState === 'IDLE' || this.currentState === 'DISCONNECTED') {
      return Promise.resolve();
    }
    return this.run('close', ['OPEN', 'TUNED', 'STREAMING'], 'CLOSING', 'CLOSED', signal,
      async (s) => {
        let stopError: unknown | null = null;
        const wasStreaming = this.activeToken?.previousState === 'STREAMING';
        if (wasStreaming) {
          try {
            await this.operations.stop?.(s);
          } catch (error) {
            stopError = error;
          }
        }
        let closeError: unknown | null = null;
        const previousState = this.activeToken?.previousState ?? 'OPEN';
        try {
          await this.operations.close?.(s.aborted ? compensationSignal() : s);
        } catch (error) {
          closeError = error;
        }
        if (stopError || closeError) {
          const cleanupState: TunerState = closeError
            ? (stopError ? 'STREAMING' : (wasStreaming ? 'STREAMING' : previousState))
            : 'CLOSED';
          throw new CleanupFailure('Close cleanup completed with errors', stopError ?? closeError, closeError, cleanupState);
        }
      });
  }

  /** Invalidate pending completions and mark the current session stale. */
  public disconnect(): void {
    if (this.currentState === 'DISCONNECTED') return;
    this.generation += 1;
    this.activeToken?.controller.abort();
    this.currentState = 'DISCONNECTED';
    this.lastError = null;
    this.emit();
    void Promise.resolve(this.operations.onDisconnect?.()).catch(() => {
      // Disconnect cleanup is best-effort; it must not create an unhandled
      // rejection or revive the stale session.
    });
  }

  private run(
    operation: Exclude<TunerOperation, null>,
    allowed: readonly TunerState[],
    transitionalState: TunerState,
    successState: TunerState,
    externalSignal: AbortSignal | undefined,
    action: (signal: AbortSignal) => Promise<void> | void | undefined,
  ): Promise<void> {
    if (this.operationInFlight) return Promise.reject(new TunerAdapterError('BUSY', 'Another tuner operation is already in progress', operation));
    if (!allowed.includes(this.currentState)) {
      const code: TunerErrorCode = this.currentState === 'DISCONNECTED' ? 'DISCONNECTED' : 'INVALID_STATE';
      return Promise.reject(new TunerAdapterError(code, `Cannot ${operation} while tuner is ${this.currentState}`, operation));
    }
    if (externalSignal?.aborted) return Promise.reject(new TunerAdapterError('ABORTED', `Tuner ${operation} was aborted`, operation));
    if (!this.isImplemented(operation)) {
      return Promise.reject(new TunerAdapterError('NOT_IMPLEMENTED', `Tuner ${operation} is not implemented`, operation));
    }

    const previousState = this.currentState;
    const controller = new AbortController();
    const token: OperationToken = { generation: this.generation, previousState, operation, controller };
    this.activeToken = token;
    this.operationInFlight = true;
    this.lastError = null;
    this.currentState = transitionalState;
    this.emit();
    const removeAbort = this.linkAbort(externalSignal, controller);
    const completion = Promise.resolve()
      .then(() => action(controller.signal))
      .then(async () => {
        if (!this.isCurrent(token)) return;
        if (controller.signal.aborted) {
          const cleanupError = await this.compensateCancelled(operation);
          if (cleanupError) {
            throw new CleanupFailure('Operation completed after cancellation and cleanup failed', abortedError(operation), cleanupError, this.cancelledSuccessState(operation, previousState));
          }
          this.currentState = this.cancelledSuccessState(operation, previousState);
          this.lastError = errorInfo('ABORTED', operation);
          this.emit();
          throw abortedError(operation);
        }
        this.currentState = successState;
        if (operation === 'open') this.sessionId += 1;
        this.lastError = null;
        this.emit();
      })
      .catch((error: unknown) => {
        if (!this.isCurrent(token)) {
          if (controller.signal.aborted) throw new TunerAdapterError('ABORTED', `Tuner ${operation} was aborted`, operation);
          return;
        }
        if (controller.signal.aborted || isAbortError(error)) {
          const completedAfterCancellation = error instanceof TunerAdapterError
            && error.code === 'ABORTED'
            && this.currentState === this.cancelledSuccessState(operation, previousState);
          this.currentState = error instanceof CleanupFailure
            ? error.cleanupState
            : completedAfterCancellation ? this.currentState : previousState;
          this.lastError = errorInfo('ABORTED', operation, error);
          this.emit();
          throw new TunerAdapterError('ABORTED', `Tuner ${operation} was aborted`, operation, errorInfo('ABORTED', operation, error));
        }
        this.currentState = error instanceof CleanupFailure ? error.cleanupState : previousState;
        this.lastError = errorInfo('OPERATION_FAILED', operation, error);
        this.emit();
        throw new TunerAdapterError('OPERATION_FAILED', `Tuner ${operation} failed`, operation, errorInfo('OPERATION_FAILED', operation, error));
      })
      .finally(() => {
        removeAbort();
        if (this.activeToken === token) this.activeToken = null;
        this.operationInFlight = false;
        this.emit();
      });
    return withAbort(completion, controller.signal, operation);
  }

  private isCurrent(token: OperationToken): boolean {
    return this.activeToken === token && this.generation === token.generation && this.currentState !== 'DISCONNECTED';
  }

  private isImplemented(operation: Exclude<TunerOperation, null>): boolean {
    if (operation === 'open') return this.operations.open !== undefined && this.operations.close !== undefined;
    if (operation === 'firmware') return this.operations.firmware !== undefined;
    if (operation === 'tune') return this.operations.tune !== undefined;
    if (operation === 'start') return this.operations.start !== undefined && this.operations.stop !== undefined;
    if (operation === 'stop') return this.operations.stop !== undefined;
    return this.operations.close !== undefined;
  }

  private cancelledSuccessState(operation: Exclude<TunerOperation, null>, previousState: TunerState): TunerState {
    if (operation === 'stop') return 'TUNED';
    if (operation === 'close') return 'CLOSED';
    return previousState;
  }

  private async compensateCancelled(operation: Exclude<TunerOperation, null>): Promise<unknown | null> {
    try {
      if (operation === 'open') await this.operations.close?.(compensationSignal());
      if (operation === 'start') await this.operations.stop?.(compensationSignal());
      return null;
    } catch (error) {
      return error;
    }
  }
  private linkAbort(externalSignal: AbortSignal | undefined, controller: AbortController): () => void {
    if (!externalSignal) return () => {};
    const abort = (): void => controller.abort();
    externalSignal.addEventListener('abort', abort, { once: true });
    return () => externalSignal.removeEventListener('abort', abort);
  }
  private snapshot(): TunerStatus {
    return Object.freeze({ state: this.currentState, busy: this.operationInFlight,
      operation: this.activeToken?.operation ?? null, sessionId: this.sessionId, error: this.lastError });
  }
  private emit(): void {
    const status = this.snapshot();
    for (const listener of this.listeners) listener(status);
  }
}

export { ManagedTunerAdapter as LifecycleTunerAdapter };

function isAbortError(error: unknown): boolean {
  return typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError';
}

function compensationSignal(): AbortSignal {
  return new AbortController().signal;
}

function abortedError(operation: Exclude<TunerOperation, null>): TunerAdapterError {
  return new TunerAdapterError('ABORTED', `Tuner ${operation} was aborted`, operation);
}

function errorInfo(
  code: TunerErrorCode,
  operation: Exclude<TunerOperation, null>,
  cause?: unknown,
): TunerErrorInfo {
  return Object.freeze({
    code,
    operation,
    ...(cause instanceof CleanupFailure && cause.cleanupError !== null ? { cleanupFailed: true } : {}),
  });
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal, operation: Exclude<TunerOperation, null>): Promise<T> {
  if (signal.aborted) throw new TunerAdapterError('ABORTED', `Tuner ${operation} was aborted`, operation);
  let remove = (): void => {};
  const abort = new Promise<never>((_, reject) => {
    const listener = (): void => reject(new TunerAdapterError('ABORTED', `Tuner ${operation} was aborted`, operation));
    signal.addEventListener('abort', listener, { once: true });
    remove = () => signal.removeEventListener('abort', listener);
  });
  try { return await Promise.race([promise, abort]); }
  finally { remove(); }
}
