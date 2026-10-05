import { PacketAligner, PACKET_SIZE } from '../ts/demux';
import type { RecordingInfo, RecordingSink, RecordingSource } from './recording-store';

export const RECORDING_MS = 30_000;
export const RECORDING_MAX_BYTES = 256 * 1024 * 1024;
const MAX_PENDING_BYTES = 8 * 1024 * 1024;

/**
 * 途中終了の理由を、動作報告へ出す決まった語にしたもの（report-schema.ts の
 * REPORT_DETAILS）。**画面の文言とは別に持つ。**文言は書き換わるので、報告の語を
 * 文言から引かない。
 */
export type RecordingIssue =
  | 'record-late-start' | 'record-gap' | 'record-resync' | 'record-loss'
  | 'record-slow-storage' | 'record-limit' | 'record-stopped' | 'record-hidden'
  | 'record-left' | 'record-reception-ended';

/** 録画として残せなかった理由の語。 */
export type RecordingFailure =
  | 'record-no-data' | 'record-write' | 'record-commit' | 'record-quota' | 'record-open'
  | 'record-error';

export type RecordingResult =
  | { info: RecordingInfo; issue: RecordingIssue | null; error?: never; failure?: never }
  | { error: unknown; failure: RecordingFailure; info?: never; issue?: never };

/** 保存の失敗を報告の語にする。容量不足はどの段でも同じ語にする。 */
export function failureOf(error: unknown, otherwise: RecordingFailure): RecordingFailure {
  return error instanceof DOMException && error.name === 'QuotaExceededError' ? 'record-quota' : otherwise;
}

/** drain のコピーを受け取り、再生側を待たせず、上限付きで順番に保存する。 */
export class RecordingCapture {
  readonly #aligner = new PacketAligner();
  readonly #started = performance.now();
  readonly #createdAt = Date.now();
  readonly #timer: ReturnType<typeof setTimeout>;
  #bytes = 0;
  #pending = 0;
  #tail: Promise<void> = Promise.resolve();
  #failure: unknown = null;
  #failureWord: RecordingFailure = 'record-error';
  #reason = '';
  #issue: RecordingIssue | null = null;
  #closing: Promise<RecordingResult> | null = null;
  #lastDataAt: number | null = null;
  #firstDataAt: number | null = null;

  constructor(
    readonly id: string,
    readonly source: RecordingSource,
    readonly sink: RecordingSink,
    readonly onFinished: (result: RecordingResult) => void,
  ) {
    this.#timer = setTimeout(() => { void this.finish(); }, RECORDING_MS);
  }

  get remainingSeconds(): number {
    return Math.max(0, Math.ceil((RECORDING_MS - (performance.now() - this.#started)) / 1000));
  }

  get closing(): boolean { return this.#closing !== null; }

  /** 途中終了の印。最初の理由を残す（文言と語は同じものを指す）。 */
  markIncomplete(reason: string, issue: RecordingIssue): void {
    if (this.#reason !== '' || reason === '') return;
    this.#reason = reason;
    this.#issue = issue;
  }

  fail(error: unknown): void {
    this.#failure = error;
    this.#failureWord = failureOf(error, 'record-error');
    void this.finish('録画処理に失敗しました', 'record-stopped');
  }

  push(chunk: Uint8Array): void {
    if (this.#closing !== null) return;
    const now = performance.now();
    if (now - this.#started >= RECORDING_MS) { void this.finish(); return; }
    if (this.#firstDataAt === null && now - this.#started > 2000) {
      this.markIncomplete('録画開始後の受信が遅れました', 'record-late-start');
    }
    if (this.#lastDataAt !== null && now - this.#lastDataAt > 2000) {
      this.markIncomplete('受信に間隔が空きました', 'record-gap');
    }
    // 同期を取り直し、先頭・末尾の不完全な188-byte packetは保存しない。
    const copy = new Uint8Array(chunk.byteLength + PACKET_SIZE);
    let size = 0;
    const resyncs = this.#aligner.resyncs;
    this.#aligner.push(chunk, (packet) => { copy.set(packet, size); size += packet.length; });
    if (this.#bytes > 0 && this.#aligner.resyncs > resyncs) {
      this.markIncomplete('TS の同期ずれを検出しました', 'record-resync');
    }
    if (size === 0) return;
    if (this.#bytes + size > RECORDING_MAX_BYTES || this.#pending + size > MAX_PENDING_BYTES) {
      if (this.#pending + size > MAX_PENDING_BYTES) {
        void this.finish('保存が受信に追いつかないため停止しました', 'record-slow-storage');
      } else {
        void this.finish('録画容量の上限で停止しました', 'record-limit');
      }
      return;
    }
    this.#firstDataAt ??= now;
    this.#lastDataAt = now;
    this.#bytes += size;
    this.#pending += size;
    this.#tail = this.#tail.then(async () => {
      if (this.#failure === null) await this.sink.write(copy.subarray(0, size));
    }).catch((error: unknown) => {
      this.#failure = error;
      this.#failureWord = failureOf(error, 'record-write');
      // tail の catch 内から finalize を待たない（自己待ちを避ける）。
      void this.finish('書き込みに失敗しました', 'record-stopped');
    }).finally(() => { this.#pending -= size; });
  }

  /** 終える。reason を渡すなら、報告の語 issue も渡す（途中終了の理由）。 */
  finish(reason = '', issue: RecordingIssue = 'record-stopped'): Promise<RecordingResult> {
    if (this.#closing !== null) return this.#closing;
    clearTimeout(this.#timer);
    this.markIncomplete(reason, issue);
    const elapsed = Math.min(RECORDING_MS, performance.now() - this.#started);
    if (this.#lastDataAt !== null && performance.now() - this.#lastDataAt > 2000) {
      this.markIncomplete('受信が途切れました', 'record-gap');
    }
    const durationMs = this.#reason === '' ? elapsed
      : Math.max(0, (this.#lastDataAt ?? this.#started) - (this.#firstDataAt ?? this.#started));
    // microtask から始めて、コールバックが走る前に closing を確定する。
    this.#closing = Promise.resolve().then(async (): Promise<RecordingResult> => {
      let failure: RecordingFailure = 'record-error';
      try {
        await this.#tail;
        // 書き込みの失敗は待っているあいだに決まる。待ったあとで読む。
        failure = this.#failureWord;
        if (this.#failure !== null) throw this.#failure;
        if (this.#bytes === 0) {
          failure = 'record-no-data';
          throw new Error('録画できる放送データを受信できませんでした。');
        }
        const info: RecordingInfo = {
          version: 1, id: this.id, ...this.source, createdAt: this.#createdAt,
          durationMs, bytes: this.#bytes, incompleteReason: this.#reason,
        };
        failure = 'record-commit';
        try {
          await this.sink.commit(info);
        } catch (error) {
          failure = failureOf(error, 'record-commit');
          throw error;
        }
        return { info, issue: this.#issue };
      } catch (error) {
        await this.sink.abort().catch(() => {});
        return { error, failure };
      }
    });
    void this.#closing.then((result) => { this.onFinished(result); });
    return this.#closing;
  }
}
