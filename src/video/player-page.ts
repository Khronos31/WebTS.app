import type { PlayerMessage, PlayerRequest } from './player-worker';

// 見た目は作り込まない。素の要素のみ。
//
// 開発用の再生ページ。復号済み TS を渡すと、分離・MPEG-2 復号・描画を
// すべてブラウザ内で行う。音声と字幕はまだ無い。

const app = document.querySelector('#app');
if (!(app instanceof HTMLElement)) throw new Error('app root missing');

const heading = document.createElement('h1');
heading.textContent = 'TS 再生（映像のみ）';
app.append(heading);

const explain = document.createElement('p');
explain.textContent =
  '復号済みの TS を渡すと、分離・MPEG-2 復号・描画をすべてブラウザ内で行います。'
  + 'ファイルは読み込むだけで、どこへも送信しません。音声と字幕はまだありません。';
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
 * transferControlToOffscreen は canvas ひとつにつき一度きりなので、
 * 再生のたびに新しい canvas を作る。
 */
function freshCanvas(): OffscreenCanvas {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  // 画面幅を超えないようにするだけ。装飾はしない。
  canvas.style.maxWidth = '100%';
  canvas.style.height = 'auto';
  screen.replaceChildren(canvas);
  return canvas.transferControlToOffscreen();
}

let worker: Worker | null = null;

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
    const canvas = freshCanvas();
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
        render([...header, ...progressRows(data)]);
        return;
      }
      status.textContent = `終了しました。${data.frames} フレーム。`;
      play.disabled = false;
    });

    send({ kind: 'init', canvas }, [canvas]);
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
    ['刻みの伸縮', `${(data.rateTrim * 100).toFixed(1)} %`],
    ['未復号の映像 ES', `${(data.pendingEsBytes / 1024).toFixed(0)} KiB`],
    ['分離カウンタ', JSON.stringify(data.counters)],
  ];
}
