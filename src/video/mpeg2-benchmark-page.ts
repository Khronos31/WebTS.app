import type { BenchmarkFailure, BenchmarkResult } from './mpeg2-benchmark-worker';

// 見た目は作り込まない。素の要素のみ。
//
// これは開発用の計測ページで、製品 UI ではない。素材は合成クリップであり
// 放送キャプチャではない。素材はリポジトリに入れない（local/ は gitignore）。

const app = document.querySelector('#app');
if (!(app instanceof HTMLElement)) throw new Error('app root missing');

const heading = document.createElement('h1');
heading.textContent = 'MPEG-2 復号スループット';
app.append(heading);

const explain = document.createElement('p');
explain.textContent =
  'libmpeg2 を WASM で動かし、Worker 内での復号速度を測ります。'
  + 'ブラウザ内蔵のデコーダは MPEG-2 を受け付けないため、ここが映像経路の'
  + '唯一の復号手段になります。素材は合成クリップで、放送キャプチャではありません。';
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

const clip = document.createElement('input');
clip.type = 'text';
clip.value = '/local/testsrc2.m2v';
clip.size = 40;
clip.required = true;

const chunk = document.createElement('input');
chunk.type = 'number';
chunk.min = '4096';
chunk.step = '4096';
chunk.value = '65536';
chunk.required = true;

const runs = document.createElement('input');
runs.type = 'number';
runs.min = '1';
runs.max = '10';
runs.value = '3';
runs.required = true;

form.append(field('クリップ:', clip));
form.append(field('チャンク (bytes):', chunk));
form.append(field('試行回数:', runs));

const start = document.createElement('button');
start.type = 'submit';
start.textContent = '計測';
form.append(start);

const status = document.createElement('p');
status.setAttribute('role', 'status');
app.append(status);

const table = document.createElement('table');
app.append(table);

function decode(bytes: ArrayBuffer, chunkSize: number): Promise<BenchmarkResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./mpeg2-benchmark-worker.ts', import.meta.url),
      { type: 'module' });
    worker.addEventListener('message', (event: MessageEvent<BenchmarkResult | BenchmarkFailure>) => {
      worker.terminate();
      if (event.data.ok) resolve(event.data);
      else reject(new Error(event.data.message));
    });
    worker.addEventListener('error', (event) => {
      worker.terminate();
      reject(new Error(event.message));
    });
    // バイト列は transfer する。コピーのコストを計測に混ぜないため。
    worker.postMessage({ bytes, chunkSize }, [bytes]);
  });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  start.disabled = true;
  table.replaceChildren();
  const rows: string[][] = [];
  try {
    status.textContent = 'クリップを読み込んでいます…';
    const response = await fetch(clip.value);
    if (!response.ok) throw new Error(`${clip.value}: HTTP ${response.status}`);
    const source = await response.arrayBuffer();

    const attempts = Number(runs.value);
    const chunkSize = Number(chunk.value);
    let sequenceLine = '';
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      status.textContent = `計測中… ${attempt} / ${attempts}`;
      // transfer で source は detach されるので、試行ごとに複製する。
      const result = await decode(source.slice(0), chunkSize);
      const seconds = result.decodeMs / 1000;
      rows.push([
        String(attempt),
        String(result.frames),
        seconds.toFixed(3),
        (result.frames / seconds).toFixed(1),
        `${(result.clipSeconds / seconds).toFixed(2)}x`,
      ]);
      const sequence = result.sequence;
      if (sequence) {
        sequenceLine =
          `符号化 ${sequence.codedWidth}x${sequence.codedHeight}`
          + ` / 表示 ${sequence.pictureWidth}x${sequence.pictureHeight}`
          + ` / 標本比 ${sequence.pixelWidth}:${sequence.pixelHeight}`
          + ` / クリップ長 ${result.clipSeconds.toFixed(2)} s`;
      }
      render(rows);
    }
    status.textContent = sequenceLine || '完了しました。';
  } catch (error) {
    status.textContent = `失敗: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    start.disabled = false;
  }
});

function render(rows: string[][]): void {
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const name of ['試行', 'フレーム', '復号時間 (s)', 'fps', '実時間比']) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = name;
    headRow.append(cell);
  }
  head.append(headRow);
  const body = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const value of row) {
      const cell = document.createElement('td');
      cell.textContent = value;
      tr.append(cell);
    }
    body.append(tr);
  }
  table.replaceChildren(head, body);
}
