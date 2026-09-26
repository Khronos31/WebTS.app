import { loadFirmware } from '../usb/firmware';
import { AudioPlayer } from './audio';
import { CaptionOverlay } from './captions';
import type { PlayerMessage, PlayerRequest } from './player-worker';

// 見た目は作り込まない。素の要素のみ。
//
// チューナーから画面まで一本で繋ぐ。
//
//   WASM（page main thread）   USB → 復号 → 復号済み TS を溜める
//        ↓ drain（消費したぶんだけ）
//   Player Worker              分離 → MPEG-2 復号 → OffscreenCanvas
//
// WASM をページの main thread に置くのは、その中の pthread が WebUSB の
// Promise を main へ委譲して待つからである（docs/FINDINGS.md 12章）。
// main を塞いではいけないので、ここでやるのは memcpy と postMessage だけ。
//
// 補充は Worker が要求したときだけ行う。main が勝手な周期で押し込むと、
// 表示より速く送ってしまい遅延が積み上がる。

const MODULE_URL = '/build/q3u4-descramble/q3u4-descramble.mjs';
const POLL_WORDS = 16;
/** 1回の drain で取り出す上限。live は 2 MB/s 程度なので十分余る。 */
const DRAIN_BYTES = 1024 * 1024;

// 地上デジタルの物理チャンネル: ch13 = 473143 kHz、以降 6 MHz 間隔。
const CHANNEL_BASE_KHZ = 473_143;
const CHANNEL_STEP_KHZ = 6_000;
const MIN_CHANNEL = 13;
const MAX_CHANNEL = 62;

const STAGE = [
  'start', 'firmware-image', 'open-runtime', 'init', 'card', 'b25',
  'frontend-open', 'tune', 'demod-lock', 'data-plane', 'attach', 'reading',
  'flush', 'cleanup', 'done',
];

interface DescrambleModule {
  ccall(
    name: string,
    returnType: string | null,
    argumentTypes: string[],
    args: unknown[],
  ): number | string;
  _malloc(size: number): number;
  _free(pointer: number): void;
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
}

const app = document.querySelector('#app');
if (!(app instanceof HTMLElement)) throw new Error('app root missing');

const heading = document.createElement('h1');
heading.textContent = 'ライブ視聴';
app.append(heading);

const explain = document.createElement('p');
explain.textContent =
  'チューナーで受信し、内蔵カードで復号し、分離して復号して表示するまでを'
  + 'すべてブラウザ内で行います。保存も送信もしません。'
  + '音声は主音声を鳴らし、字幕も出します。';
app.append(explain);

const form = document.createElement('form');
app.append(form);

function field(labelText: string, input: HTMLElement): HTMLParagraphElement {
  const paragraph = document.createElement('p');
  const label = document.createElement('label');
  label.append(labelText + ' ', input);
  paragraph.append(label);
  return paragraph;
}

const channel = document.createElement('input');
channel.type = 'number';
channel.min = String(MIN_CHANNEL);
channel.max = String(MAX_CHANNEL);
channel.value = '27';
channel.required = true;
const frequencyNote = document.createElement('span');

// 上流の global 受信機番号。地上波は 2, 3（dev1）と 6, 7（dev2）。
const receiver = document.createElement('select');
for (const value of ['2', '3', '6', '7']) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = `${value}（ISDB-T / ${Number(value) < 4 ? 'dev1' : 'dev2'}）`;
  receiver.append(option);
}

const channelField = field('物理チャンネル:', channel);
channelField.append(' ', frequencyNote);
form.append(channelField);
form.append(field('受信機:', receiver));

const start = document.createElement('button');
start.type = 'submit';
start.textContent = '視聴開始';
form.append(start);

const stop = document.createElement('button');
stop.type = 'button';
stop.textContent = '停止';
stop.disabled = true;
form.append(' ');
form.append(stop);

const status = document.createElement('p');
status.setAttribute('role', 'status');
app.append(status);

const screen = document.createElement('div');
app.append(screen);

const table = document.createElement('table');
app.append(table);

function frequencyKhz(): number {
  return CHANNEL_BASE_KHZ + (Number(channel.value) - MIN_CHANNEL) * CHANNEL_STEP_KHZ;
}

function showFrequency(): void {
  const number = Number(channel.value);
  frequencyNote.textContent =
    number >= MIN_CHANNEL && number <= MAX_CHANNEL ? `= ${frequencyKhz()} kHz` : '';
}
channel.addEventListener('input', showFrequency);
showFrequency();

function render(rows: [string, string][]): void {
  const body = document.createElement('tbody');
  for (const [name, value] of rows) {
    const row = document.createElement('tr');
    const head = document.createElement('th');
    head.scope = 'row';
    head.textContent = name;
    const cell = document.createElement('td');
    cell.textContent = value;
    row.append(head, cell);
    body.append(row);
  }
  table.replaceChildren(body);
}

/**
 * transferControlToOffscreen は canvas ひとつにつき一度きりなので、毎回作る。
 * 字幕はこの上に重ねるので、入れ物を position: relative にしておく。
 *
 * 表示比は入れ物が持つ。canvas の内在寸法は符号化された 1440x1080 のままで、
 * それをそのまま見せると横に潰れる。標本比 4:3 を掛けた 16:9 を
 * aspect-ratio として入れ物に与え、canvas は入れ物いっぱいに伸ばす。
 */
function freshScreen(): { canvas: OffscreenCanvas; overlay: HTMLDivElement } {
  const overlay = document.createElement('div');
  overlay.style.position = 'relative';
  overlay.style.width = '100%';
  overlay.style.maxWidth = '960px';
  overlay.style.aspectRatio = '16 / 9';
  overlay.style.background = 'black';
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  overlay.append(canvas);
  screen.replaceChildren(overlay);
  return { canvas: canvas.transferControlToOffscreen(), overlay };
}

/** sequence が分かった時点で、標本比を含めた表示比を入れ物へ与える。 */
function applyAspect(overlay: HTMLDivElement, sequence: {
  pictureWidth: number; pictureHeight: number; pixelWidth: number; pixelHeight: number;
}): void {
  const width = sequence.pictureWidth * (sequence.pixelWidth || 1);
  const height = sequence.pictureHeight * (sequence.pixelHeight || 1);
  if (width > 0 && height > 0) overlay.style.aspectRatio = `${width} / ${height}`;
}

let cached: DescrambleModule | null = null;
async function load(): Promise<DescrambleModule> {
  if (cached) return cached;
  const factory = (await import(/* @vite-ignore */ MODULE_URL)) as {
    default: () => Promise<DescrambleModule>;
  };
  cached = await factory.default();
  return cached;
}

function errorName(module: DescrambleModule, error: number): string {
  return String(module.ccall('webts_q3u4_descramble_error_name', 'string', ['number'], [error]));
}

function kib(bytes: number): string {
  return `${(bytes / 1024).toFixed(0)} KiB`;
}

interface Session {
  readonly module: DescrambleModule;
  readonly worker: Worker;
  readonly audio: AudioPlayer;
  readonly captions: CaptionOverlay;
  readonly overlay: HTMLDivElement;
  aspectApplied: boolean;
  clock: number;
  readonly drainPointer: number;
  readonly pollPointer: number;
  readonly firmwarePointer: number;
  readonly firmwareLength: number;
  wantPending: boolean;
  retry: number;
  poll: number;
  ended: boolean;
}

let session: Session | null = null;

function teardown(): void {
  if (session === null) return;
  const active = session;
  session = null;
  clearInterval(active.retry);
  clearInterval(active.poll);
  clearInterval(active.clock);
  active.worker.terminate();
  void active.audio.close();
  active.captions.destroy();
  active.module.HEAPU8.fill(0, active.firmwarePointer,
    active.firmwarePointer + active.firmwareLength);
  active.module._free(active.firmwarePointer);
  active.module._free(active.drainPointer);
  active.module._free(active.pollPointer);
  // 溜まったままの復号済み TS を残さない。
  active.module.ccall('webts_q3u4_descramble_discard', null, [], []);
  start.disabled = false;
  stop.disabled = true;
}

/** 溜まっているぶんを取り出して Worker へ渡す。渡せたら true。 */
function drainTo(active: Session): boolean {
  const size = active.module.ccall('webts_q3u4_descramble_drain', 'number',
    ['number', 'number'], [active.drainPointer, DRAIN_BYTES]) as number;
  if (size <= 0) return false;
  const copy = active.module.HEAPU8.slice(active.drainPointer, active.drainPointer + size);
  // 取り出したあとの残りを添える。Worker はこれを見て刻みを伸縮させる。
  const backlogBytes = Number(
    active.module.ccall('webts_q3u4_descramble_pending', 'number', [], []));
  const request: PlayerRequest = { kind: 'chunk', bytes: copy.buffer, backlogBytes };
  active.worker.postMessage(request, [copy.buffer]);
  return true;
}

stop.addEventListener('click', () => {
  if (session === null) return;
  stop.disabled = true;
  status.textContent = '停止しています…';
  session.module.ccall('webts_q3u4_descramble_stop', null, [], []);
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  teardown();
  start.disabled = true;
  table.replaceChildren();
  status.textContent = 'ファームウェアを読み出しています…';

  try {
    let firmware: Uint8Array;
    try {
      firmware = await loadFirmware();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
      start.disabled = false;
      return;
    }

    status.textContent = 'モジュールを読み込んでいます…';
    const module = await load();

    const firmwarePointer = module._malloc(firmware.length);
    module.HEAPU8.set(firmware, firmwarePointer);

    const { canvas, overlay } = freshScreen();
    const worker = new Worker(new URL('./player-worker.ts', import.meta.url), { type: 'module' });
    const active: Session = {
      module,
      worker,
      drainPointer: module._malloc(DRAIN_BYTES),
      pollPointer: module._malloc(POLL_WORDS * 4),
      firmwarePointer,
      firmwareLength: firmware.length,
      audio: new AudioPlayer(),
      // 字幕の座標系は 960x540（ARIB の標準的な表示領域）。実際の表示寸法は
      // renderer が canvas の CSS 側で合わせる。
      captions: new CaptionOverlay(overlay, 960, 540),
      overlay,
      aspectApplied: false,
      clock: 0,
      wantPending: false,
      retry: 0,
      poll: 0,
      ended: false,
    };
    session = active;
    // AudioContext は利用者の操作から作る。ここは submit の中なので許される。
    active.audio.start();

    let header: [string, string][] = [];
    worker.addEventListener('message', (message: MessageEvent<PlayerMessage>) => {
      const data = message.data;
      if (data.kind === 'want') {
        if (!drainTo(active)) active.wantPending = true;
        return;
      }
      if (data.kind === 'audio') {
        active.audio.push({ pts: data.pts, bytes: new Uint8Array(data.bytes) });
        return;
      }
      if (data.kind === 'caption') {
        active.captions.push(data.pts, new Uint8Array(data.bytes));
        return;
      }
      if (data.kind === 'failed') {
        status.textContent = `再生に失敗: ${data.message}`;
        teardown();
        return;
      }
      if (data.kind === 'started') {
        header = [
          ['番組', String(data.programNumber)],
          ['映像 PID', `0x${data.videoPid.toString(16).padStart(4, '0')}`],
          ['音声 PID', data.audioPids.map((pid) => `0x${pid.toString(16)}`).join(', ') || '-'],
          ['字幕 PID', data.captionPids.map((pid) => `0x${pid.toString(16)}`).join(', ') || '-'],
        ];
        status.textContent = '視聴中';
        return;
      }
      if (data.kind === 'progress') {
        const sequence = data.sequence;
        if (sequence !== null && !active.aspectApplied) {
          applyAspect(active.overlay, sequence);
          active.aspectApplied = true;
        }
        const pending = Number(module.ccall('webts_q3u4_descramble_pending', 'number', [], []));
        const dropped = Number(module.ccall('webts_q3u4_descramble_dropped', 'number', [], []));
        const audio = active.audio.stats();
        render([
          ...header,
          ['解像度', sequence
            ? `${sequence.pictureWidth}x${sequence.pictureHeight}`
              + ` (標本比 ${sequence.pixelWidth}:${sequence.pixelHeight})`
            : '-'],
          ['表示フレーム', String(data.frames)],
          ['復号に使った時間', `${(data.decodeMs / 1000).toFixed(2)} s`],
          ['刻み直し', String(data.resyncs)],
          // 音声の時計が来ている間、刻みの伸縮は使っていない。出すと誤解を招く。
          ['映像の合わせ方', data.avSkewMs === null
            ? `自前の刻み（伸縮 ${(data.rateTrim * 100).toFixed(1)} %）`
            : `音声の時計（ずれ ${data.avSkewMs.toFixed(0)} ms）`],
          ['音声フレーム', `${audio.decoded}（取りこぼし ${audio.dropped}、エラー ${audio.errors}）`],
          ['音声の置き直し', String(audio.reanchors)],
          ['音声バッファ', `${audio.bufferedSeconds.toFixed(2)} s`],
          ['字幕', (() => { const c = active.captions.stats();
            return `受信 ${c.fed}、描画 ${c.rendered}、エラー ${c.errors}`; })()],
          ['未復号の映像 ES', kib(data.pendingEsBytes)],
          ['未取り出しの TS', kib(pending)],
          ['詰まって捨てた TS', kib(dropped)],
          ['分離カウンタ', JSON.stringify(data.counters)],
        ]);
        return;
      }
      if (data.kind === 'done') status.textContent = `再生を終えました。${data.frames} フレーム。`;
      teardown();
    });

    const init: PlayerRequest = { kind: 'init', canvas };
    worker.postMessage(init, [canvas]);

    status.textContent = '選局しています…';
    // duration 0 は「止めるまで」、collect 2 は「溜めては渡す」。
    const started = module.ccall('webts_q3u4_descramble_start', 'number',
      ['number', 'number', 'number', 'number', 'number', 'number'],
      [firmwarePointer, firmware.length, Number(receiver.value), frequencyKhz(), 0, 2]) as number;
    if (started !== 0) {
      status.textContent = `開始できません: ${errorName(module, started)} (${started})`;
      teardown();
      return;
    }
    stop.disabled = false;

    // 鳴っている位置を Worker へ伝える。映像も字幕もこれに合わせる。
    active.clock = self.setInterval(() => {
      const pts = active.audio.clockPts();
      if (pts === null) return;
      const clock: PlayerRequest = { kind: 'clock', pts };
      worker.postMessage(clock);
      active.captions.tick(pts);
    }, 100);

    // Worker の要求に応えられなかったぶんを拾い直す。
    active.retry = self.setInterval(() => {
      if (!active.wantPending) return;
      if (drainTo(active)) active.wantPending = false;
    }, 20);

    active.poll = self.setInterval(() => {
      module.ccall('webts_q3u4_descramble_poll', 'number', ['number', 'number'],
        [active.pollPointer, POLL_WORDS]);
      const words = module.HEAP32.subarray(
        active.pollPointer / 4, active.pollPointer / 4 + POLL_WORDS);
      const state = words[0] ?? 0;
      const stage = words[1] ?? 0;
      if (state === 1 && stage < 11) status.textContent = `${STAGE[stage] ?? stage} …`;
      if (state !== 1 && !active.ended) {
        active.ended = true;
        const error = words[2] ?? 0;
        status.textContent = state === 3
          ? `受信が止まりました: ${errorName(module, error)} (${error})`
          : '受信を終えました。残りを再生しています…';
        // 取り残しを出し切ってから終端を伝える。
        while (drainTo(active)) { /* 全部渡す */ }
        const end: PlayerRequest = { kind: 'end' };
        worker.postMessage(end);
      }
    }, 250);
  } catch (error) {
    status.textContent = `失敗: ${error instanceof Error ? error.message : String(error)}`;
    teardown();
  }
});
