import { AudioPlayer } from './audio';
import { CaptionOverlay } from './captions';
import type { PlayerMessage, PlayerRequest } from './player-worker';

// 見た目は作り込まない。素の要素のみ。
//
// 開発用の再生ページ。復号済み TS を渡すと、分離・MPEG-2 復号・描画を
// すべてブラウザ内で行う。音声と字幕はまだ無い。

const app = document.querySelector('#app');
if (!(app instanceof HTMLElement)) throw new Error('app root missing');

const heading = document.createElement('h1');
heading.textContent = 'TS 再生';
app.append(heading);

const explain = document.createElement('p');
explain.textContent =
  '復号済みの TS を渡すと、分離・MPEG-2 復号・描画をすべてブラウザ内で行います。'
  + 'ファイルは読み込むだけで、どこへも送信しません。'
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

const picker = document.createElement('input');
picker.type = 'file';
picker.accept = '.ts,.m2ts,.mts';
form.append(field('TS ファイル:', picker));

const url = document.createElement('input');
url.type = 'text';
url.size = 40;
url.placeholder = '/local/webts-....ts';
form.append(field('または URL:', url));

const play = document.createElement('button');
play.type = 'submit';
play.textContent = '再生';
form.append(play);

const status = document.createElement('p');
status.setAttribute('role', 'status');
app.append(status);

const screen = document.createElement('div');
app.append(screen);

const table = document.createElement('table');
app.append(table);

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

let worker: Worker | null = null;
let audio: AudioPlayer | null = null;
let captions: CaptionOverlay | null = null;
let clockTimer = 0;

/** Worker が消費したぶんだけ送る。溜め込ませない。 */
const SLICE = 1024 * 1024;

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  play.disabled = true;
  table.replaceChildren();
  status.textContent = '読み込んでいます…';

  try {
    const file = picker.files?.[0];
    let bytes: Uint8Array;
    if (file) {
      bytes = new Uint8Array(await file.arrayBuffer());
    } else if (url.value.trim() !== '') {
      const response = await fetch(url.value.trim());
      if (!response.ok) throw new Error(`${url.value}: HTTP ${response.status}`);
      bytes = new Uint8Array(await response.arrayBuffer());
    } else {
      status.textContent = 'ファイルを選ぶか URL を入れてください。';
      play.disabled = false;
      return;
    }

    worker?.terminate();
    void audio?.close();
    captions?.destroy();
    audio = new AudioPlayer();
    // AudioContext は利用者の操作から作る。ここは submit の中なので許される。
    audio.start();
    const active_audio = audio;
    const { canvas, overlay } = freshScreen();
    // 字幕の座標系は 960x540。表示寸法は renderer が CSS 側で合わせる。
    captions = new CaptionOverlay(overlay, 960, 540);
    const active_captions = captions;
    let aspectApplied = false;
    const active = new Worker(new URL('./player-worker.ts', import.meta.url), { type: 'module' });
    worker = active;

    let offset = 0;
    let header: [string, string][] = [
      ['入力', `${(bytes.length / 1_048_576).toFixed(2)} MiB`],
    ];
    const send = (request: PlayerRequest, transfer: Transferable[] = []): void => {
      active.postMessage(request, transfer);
    };

    active.addEventListener('message', (message: MessageEvent<PlayerMessage>) => {
      const data = message.data;
      if (data.kind === 'want') {
        if (offset >= bytes.length) { send({ kind: 'end' }); return; }
        const slice = bytes.slice(offset, offset + SLICE);
        offset += slice.length;
        send({ kind: 'chunk', bytes: slice.buffer }, [slice.buffer]);
        return;
      }
      if (data.kind === 'audio') {
        active_audio.push({ pts: data.pts, bytes: new Uint8Array(data.bytes) });
        return;
      }
      if (data.kind === 'caption') {
        active_captions.push(data.pts, new Uint8Array(data.bytes));
        return;
      }
      if (data.kind === 'failed') {
        status.textContent = `失敗: ${data.message}`;
        play.disabled = false;
        return;
      }
      if (data.kind === 'started') {
        status.textContent = '再生中…';
        header = [
          ...header,
          ['番組', String(data.programNumber)],
          ['映像 PID', `0x${data.videoPid.toString(16).padStart(4, '0')}`],
          ['音声 PID', data.audioPids.map((pid) => `0x${pid.toString(16)}`).join(', ') || '-'],
          ['字幕 PID', data.captionPids.map((pid) => `0x${pid.toString(16)}`).join(', ') || '-'],
        ];
        render(header);
        return;
      }
      if (data.kind === 'progress') {
        if (data.sequence !== null && !aspectApplied) {
          applyAspect(overlay, data.sequence);
          aspectApplied = true;
        }
        render([...header, ...progressRows(data),
          ...audioRows(active_audio), ...captionRows(active_captions)]);
        return;
      }
      if (data.kind === 'done') status.textContent = `終了しました。${data.frames} フレーム。`;
      clearInterval(clockTimer);
      void active_audio.close();
      play.disabled = false;
    });

    send({ kind: 'init', canvas }, [canvas]);
    clearInterval(clockTimer);
    clockTimer = self.setInterval(() => {
      const pts = active_audio.clockPts();
      if (pts === null) return;
      send({ kind: 'clock', pts });
      active_captions.tick(pts);
    }, 100);
  } catch (error) {
    status.textContent = `失敗: ${error instanceof Error ? error.message : String(error)}`;
    play.disabled = false;
  }
});

export function progressRows(
  data: Extract<PlayerMessage, { kind: 'progress' }>,
): [string, string][] {
  const sequence = data.sequence;
  return [
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
    ['未復号の映像 ES', `${(data.pendingEsBytes / 1024).toFixed(0)} KiB`],
    ['分離カウンタ', JSON.stringify(data.counters)],
  ];
}

function audioRows(player: AudioPlayer): [string, string][] {
  const stats = player.stats();
  return [
    ['音声フレーム', `${stats.decoded}（取りこぼし ${stats.dropped}、エラー ${stats.errors}）`],
    ['音声の置き直し', String(stats.reanchors)],
    ['音声バッファ', `${stats.bufferedSeconds.toFixed(2)} s`],
  ];
}

function captionRows(overlay: CaptionOverlay): [string, string][] {
  const stats = overlay.stats();
  return [['字幕', `受信 ${stats.fed}、描画 ${stats.rendered}、エラー ${stats.errors}`]];
}
