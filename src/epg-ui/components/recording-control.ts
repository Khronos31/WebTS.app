import {
  failureOf, RecordingCapture, type RecordingIssue, type RecordingResult,
} from '../recording-capture';
import { openRecordingSink, recordingError, recordingStorageSupported, type RecordingSource } from '../recording-store';
import { reportModelName, reportOutcome } from '../../reports/reports';
import type { Report } from '../../reports/report-schema';

export class RecordingControl {
  readonly element = document.createElement('div');
  readonly #button = document.createElement('button');
  readonly #status = document.createElement('span');
  readonly #stop = document.createElement('button');
  readonly #saved = document.createElement('a');
  #capture: RecordingCapture | null = null;
  #starting: Promise<void> | null = null;
  #dialogAbort = new AbortController();
  #destroyed = false;
  #ready = false;
  #timer: ReturnType<typeof setInterval> | null = null;
  #dropped: number | null = null;
  #continuity: number | null = null;

  constructor(readonly source: () => RecordingSource) {
    this.element.className = 'recording-control';
    this.#button.type = 'button';
    this.#button.className = 'btn-small recording-button';
    this.#button.textContent = '録画';
    this.#button.disabled = true;
    this.#status.className = 'recording-status';
    this.#status.setAttribute('role', 'status');
    this.#status.setAttribute('aria-live', 'polite');
    this.#button.setAttribute('aria-label', '30秒録画を開始');
    this.#stop.type = 'button';
    this.#stop.className = 'btn-small recording-stop';
    this.#stop.textContent = '停止';
    this.#stop.hidden = true;
    this.#stop.addEventListener('click', () => { void this.#stopByUser(); });
    this.#saved.href = '#/recorded';
    this.#saved.textContent = '録画済みを見る';
    this.#saved.hidden = true;
    this.element.append(this.#button, this.#status, this.#stop, this.#saved);
    if (!recordingStorageSupported()) this.#status.textContent = 'このブラウザでは録画を保存できません。';
    this.#button.addEventListener('click', () => {
      if (this.#starting || this.#capture || !this.#ready || this.#destroyed) return;
      this.#starting = this.#start().finally(() => {
        this.#starting = null;
        this.#updateButton();
      });
      this.#updateButton();
    });
    document.addEventListener('visibilitychange', this.#visibility);
  }

  setReady(ready: boolean): void { this.#ready = ready; this.#updateButton(); }

  observeLoss(dropped: number, continuity: number): void {
    if (this.#capture && ((this.#dropped !== null && dropped > this.#dropped)
      || (this.#continuity !== null && continuity > this.#continuity))) {
      this.#capture.markIncomplete('受信データの欠損を検出しました', 'record-loss');
    }
    this.#dropped = dropped;
    this.#continuity = continuity;
  }

  push(bytes: Uint8Array): void {
    try { this.#capture?.push(bytes); } catch (error) { this.#capture?.fail(error); }
  }

  #updateButton(): void {
    this.#button.disabled = this.#destroyed || !this.#ready || !recordingStorageSupported()
      || this.#starting !== null || this.#capture !== null;
  }

  async #start(): Promise<void> {
    this.#dialogAbort = new AbortController();
    if (!(await confirmRecording(this.#dialogAbort.signal)) || this.#destroyed || !this.#ready) return;
    this.#status.textContent = '保存先を準備しています…';
    this.#saved.hidden = true;
    // 動作報告の機種は始めた時点のもの（抜かれたあとに読むと unknown になる）。
    const model = await reportModelName();
    const source = this.source();
    try {
      const id = crypto.randomUUID();
      let sink;
      try {
        sink = await openRecordingSink(id);
      } catch (error) {
        report(source, model, { failure: failureOf(error, 'record-open') });
        throw error;
      }
      if (this.#destroyed || this.#dialogAbort.signal.aborted || !this.#ready || document.hidden) {
        await sink.abort();
        this.#status.textContent = '録画を開始しませんでした。';
        return;
      }
      this.#capture = new RecordingCapture(id, source, sink, (result) => {
        report(source, model, result);
        this.#capture = null;
        if (this.#timer !== null) clearInterval(this.#timer);
        this.#timer = null;
        this.element.classList.remove('is-recording');
        this.#button.textContent = '録画';
        this.#stop.hidden = true;
        this.#saved.hidden = !result.info;
        this.#status.textContent = result.info
          ? result.info.incompleteReason ? '途中終了した録画を保存しました。' : '録画済みに保存しました。'
          : `保存できませんでした: ${recordingError(result.error)}`;
        this.#updateButton();
      });
      this.element.classList.add('is-recording');
      this.#button.textContent = '録画中';
      this.#stop.hidden = false;
      this.#stop.disabled = false;
      const tick = (): void => {
        if (!this.#capture) return;
        this.#stop.disabled = this.#capture.closing;
        const text = this.#capture.closing ? '保存しています…'
          : `あと${this.#capture.remainingSeconds}秒`;
        if (this.#status.textContent !== text) this.#status.textContent = text;
      };
      tick();
      this.#timer = setInterval(tick, 250);
    } catch (error) {
      this.#status.textContent = `録画できませんでした: ${recordingError(error)}`;
    }
  }

  /**
   * 停止ボタン。**利用者が自分で止めたものは完了として扱う**（作者の決定、2026-10-05）。
   * 30秒に届かなくても途中終了にしない。受信の途切れなど、ほかの理由があれば
   * そちらで途中終了になる。
   */
  async #stopByUser(): Promise<void> {
    this.#dialogAbort.abort();
    await this.#starting;
    if (this.#capture !== null) {
      this.#status.textContent = '保存しています…';
      this.#stop.disabled = true;
      await this.#capture.finish();
    }
  }

  async finish(reason: string, issue: RecordingIssue): Promise<void> {
    this.#dialogAbort.abort();
    await this.#starting;
    if (this.#capture !== null) {
      this.#status.textContent = '保存しています…';
      this.#stop.disabled = true;
      await this.#capture.finish(reason, issue);
    }
  }

  readonly #visibility = (): void => {
    if (document.hidden) void this.finish('画面が非表示になったため終了しました', 'record-hidden');
  };

  destroy(): void {
    this.#destroyed = true;
    document.removeEventListener('visibilitychange', this.#visibility);
    void this.finish('視聴を終了しました', 'record-left');
  }
}

/**
 * 録画の結果を動作報告に出す（送らない設定なら何もしない）。**番組名・局名・
 * serviceId・長さ・容量は送らない。**30秒録れたか、途中で終わった・残せなかった
 * 理由の語だけ。波が分からない（古い局一覧）ときは送らない。
 */
function report(source: RecordingSource, model: string,
  result: RecordingResult | { failure: Report['detail'] }): void {
  if (source.wave === undefined) return;
  if ('info' in result && result.info !== undefined) {
    reportOutcome({
      kind: 'record', wave: source.wave, model,
      ...(result.issue === null ? { result: 'ok' } : { result: 'incomplete', detail: result.issue }),
    });
    return;
  }
  reportOutcome({
    kind: 'record', wave: source.wave, model, result: 'failed', stage: 0, code: 0,
    detail: result.failure,
  });
}

function confirmRecording(signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'recording-dialog dialog-box';
    dialog.setAttribute('aria-labelledby', 'recording-dialog-title');
    dialog.setAttribute('aria-describedby', 'recording-dialog-description');
    dialog.innerHTML = `
      <div class="dialog-header"><h2 class="dialog-title" id="recording-dialog-title">30秒録画（デモ）</h2></div>
      <div class="dialog-body" id="recording-dialog-description">
        <p>視聴中の放送を、今から30秒間この端末に保存します。</p>
        <p>録画中はこの画面を開いたままにしてください。</p>
        <p class="recording-storage-note">保存した録画は、サイトデータの削除やブラウザの保存領域の整理によって消える場合があります。</p>
      </div>
      <form method="dialog" class="dialog-footer">
        <button class="btn btn-secondary" value="cancel" autofocus>キャンセル</button>
        <button class="btn btn-primary" value="record">録画する</button>
      </form>`;
    const abort = (): void => { dialog.close('cancel'); };
    dialog.addEventListener('close', () => {
      signal.removeEventListener('abort', abort);
      const accepted = dialog.returnValue === 'record' && !signal.aborted;
      dialog.remove();
      resolve(accepted);
    }, { once: true });
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right
        || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close('cancel');
    });
    signal.addEventListener('abort', abort, { once: true });
    document.body.append(dialog);
    dialog.showModal();
    if (signal.aborted) abort();
  });
}
