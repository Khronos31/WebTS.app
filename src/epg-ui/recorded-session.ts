import { AudioPlayer } from '../video/audio';
import type { PlayerMessage, PlayerRequest } from '../video/player-worker';
import { CaptionCanvas } from './caption-canvas';
import { reportOutcome } from '../reports/reports';
import type { Report } from '../reports/report-schema';

/**
 * 録画の再生の結果を動作報告に出す（送らない設定なら何もしない）。チューナーは
 * 使わないので機種は none。番組や局は送らない。波が分からない（0.4.0 より前の
 * 録画）ときは送らない。
 */
export function reportPlayback(wave: Report['wave'] | undefined, detail?: Report['detail']): void {
  if (wave === undefined) return;
  reportOutcome(detail === undefined
    ? { kind: 'playback', wave, model: 'none', result: 'ok' }
    : { kind: 'playback', wave, model: 'none', result: 'failed', stage: 0, code: 0, detail });
}

/** 同じ分離・デコード経路へ、ファイルを要求された分だけ渡す。USB は開かない。 */
export class RecordedSession {
  readonly #worker: Worker;
  readonly #audio = new AudioPlayer(true);
  readonly #captions: CaptionCanvas;
  readonly #timer: ReturnType<typeof setInterval>;
  #offset = 0;
  #stopped = false;
  #reading = false;
  #paused = false;
  #hasFrames = false;
  #reported = false;

  constructor(
    readonly file: File,
    canvas: OffscreenCanvas,
    captionHost: HTMLElement,
    serviceId: number,
    readonly onStatus: (text: string) => void,
    readonly onEnded: () => void,
    readonly wave?: Report['wave'],
  ) {
    this.#audio.start();
    this.#captions = new CaptionCanvas(captionHost);
    this.#worker = new Worker(new URL('../video/player-worker.ts', import.meta.url), { type: 'module' });
    this.#worker.addEventListener('message', (event: MessageEvent<PlayerMessage>) => {
      this.#message(event.data);
    });
    this.#worker.addEventListener('error', () => { this.#fail('再生処理でエラーが発生しました。'); });
    this.#send({ kind: 'init', canvas, programNumber: serviceId, filePlayback: true }, [canvas]);
    this.#timer = setInterval(() => {
      if (this.#paused || this.#stopped) return;
      const pts = this.#audio.clockPts();
      if (pts === null) return;
      this.#send({ kind: 'clock', pts });
      this.#captions.tick(pts);
    }, 100);
    onStatus('録画を読み込んでいます…');
  }

  #send(message: PlayerRequest, transfer: Transferable[] = []): void {
    if (!this.#stopped) this.#worker.postMessage(message, transfer);
  }

  async #read(): Promise<void> {
    if (this.#reading || this.#stopped) return;
    if (this.#offset >= this.file.size) { this.#send({ kind: 'end' }); return; }
    this.#reading = true;
    try {
      const bytes = await this.file.slice(this.#offset, this.#offset + 1024 * 1024).arrayBuffer();
      if (this.#stopped) return;
      this.#offset += bytes.byteLength;
      this.#send({ kind: 'chunk', bytes }, [bytes]);
    } catch (error) {
      this.#fail(error instanceof Error ? error.message : String(error));
    } finally {
      this.#reading = false;
    }
  }

  #message(message: PlayerMessage): void {
    if (this.#stopped) return;
    switch (message.kind) {
      case 'want': void this.#read(); break;
      case 'audio': this.#audio.push({ pts: message.pts, bytes: new Uint8Array(message.bytes) }); break;
      case 'caption': this.#captions.push(message.pts, new Uint8Array(message.bytes)); break;
      case 'progress':
        if (message.frames > 0 && !this.#hasFrames) {
          this.#hasFrames = true;
          this.onStatus('');
          this.#report();
        }
        break;
      case 'failed': this.#fail(message.message); break;
      case 'done':
        if (!this.#hasFrames) this.#report('playback-no-video');
        this.onStatus(this.#hasFrames ? '再生が終了しました。' : '再生できる映像がありません。');
        this.stop();
        this.onEnded();
        break;
    }
  }

  /** 1回の再生で1回だけ送る。映ったら ok、映る前に止まったら理由の語。 */
  #report(detail?: Report['detail']): void {
    if (this.#reported) return;
    this.#reported = true;
    reportPlayback(this.wave, detail);
  }

  #fail(message: string): void {
    if (this.#stopped) return;
    this.#report('playback-error');
    this.onStatus(`録画を再生できませんでした: ${message}`);
    this.stop();
    this.onEnded();
  }

  setPaused(paused: boolean): void {
    if (this.#stopped) return;
    this.#paused = paused;
    this.#send({ kind: 'paused', value: paused });
    void this.#audio.setFilePaused(paused).catch((error: unknown) => {
      this.#fail(error instanceof Error ? error.message : String(error));
    });
  }

  setVolume(volume: number, muted: boolean): void {
    this.#audio.setVolume(volume);
    this.#audio.setMuted(muted);
  }

  setCaptionsVisible(visible: boolean): void { this.#captions.setVisible(visible); }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#worker.terminate();
    void this.#audio.close();
    this.#captions.destroy();
  }
}
