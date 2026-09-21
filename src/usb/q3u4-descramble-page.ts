import { readCachedFirmware } from './firmware';

// 見た目は作り込まない。素の要素のみ。
//
// これは実機から TS を受信するための検証ページで、製品 UI ではない。
// WASM モジュールはページの main thread で読み込み、ドライバ作業は
// その中の pthread が行う。main thread は WebUSB の Promise を解決する
// 側なので塞いではならない（docs/FINDINGS.md 12章）。

const MODULE_URL = '/build/q3u4-descramble/q3u4-descramble.mjs';
const POLL_WORDS = 16;

// 地上デジタルの物理チャンネル: ch13 = 473143 kHz、以降 6 MHz 間隔。
const CHANNEL_BASE_KHZ = 473_143;
const CHANNEL_STEP_KHZ = 6_000;
const MIN_CHANNEL = 13;
const MAX_CHANNEL = 62;

const STATE = ['待機', '実行中', '完了', '失敗'];
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
  // 復号済み TS は WASM ヒープ上にある。取り出したら discard で消す。
  _malloc(size: number): number;
  _free(pointer: number): void;
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
}

const app = document.querySelector('#app');
if (!(app instanceof HTMLElement)) throw new Error('app root missing');

const heading = document.createElement('h1');
heading.textContent = 'PX-Q3U4 TS 復号';
app.append(heading);

const explain = document.createElement('p');
explain.textContent =
  '選局してロックし、TS を受信しながら内蔵カードで復号します。'
  + '受信したデータも復号したデータも保存・送信しません。'
  + '表示するのはスクランブル制御ビットが落ちたかどうかといった形の集計だけです。'
  + '「復号した TS を保存」を選ぶと、復号済み TS を手元にダウンロードできます。'
  + '自分の受信機で受信した放送を自分の端末に保存するだけで、どこへも送信しません。'
  + 'VLC などのプレイヤーで再生できます。';
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

const duration = document.createElement('input');
duration.type = 'number';
duration.min = '500';
duration.max = '120000';
duration.step = '500';
duration.value = '5000';
duration.required = true;

const channelField = field('物理チャンネル:', channel);
channelField.append(' ', frequencyNote);
form.append(channelField);
form.append(field('受信機:', receiver));
form.append(field('受信時間 (ms):', duration));

const collect = document.createElement('input');
collect.type = 'checkbox';
collect.checked = true;
form.append(field('復号した TS を保存:', collect));

const start = document.createElement('button');
start.type = 'submit';
start.textContent = '受信して復号';
form.append(start);

// 保存したときだけ現れる。リンクは使い終わったら必ず revoke する。
const download = document.createElement('p');
app.append(download);
let objectUrl: string | null = null;
function clearDownload(): void {
  if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  download.replaceChildren();
}

const status = document.createElement('p');
status.setAttribute('role', 'status');
app.append(status);

const table = document.createElement('table');
app.append(table);

function frequencyKhz(): number {
  const number = Number(channel.value);
  return CHANNEL_BASE_KHZ + (number - MIN_CHANNEL) * CHANNEL_STEP_KHZ;
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

let cached: DescrambleModule | null = null;
async function load(): Promise<DescrambleModule> {
  if (cached) return cached;
  const factory = (await import(/* @vite-ignore */ MODULE_URL)) as {
    default: () => Promise<DescrambleModule>;
  };
  cached = await factory.default();
  return cached;
}

function name(module: DescrambleModule, error: number): string {
  return String(module.ccall('webts_q3u4_descramble_error_name', 'string', ['number'], [error]));
}

/**
 * 溜めた復号済み TS を利用者の端末へ渡す。コピーを1回取ったら WASM 側は
 * すぐ捨てる。ヒープに放送内容を残したままにしない。
 */
function offerDownload(module: DescrambleModule): void {
  const size = module.ccall('webts_q3u4_descramble_output_size', 'number', [], []) as number;
  if (size <= 0) return;
  const pointer = module.ccall('webts_q3u4_descramble_output', 'number', [], []) as number;
  if (pointer === 0) return;
  const copy = module.HEAPU8.slice(pointer, pointer + size);
  module.ccall('webts_q3u4_descramble_discard', null, [], []);

  objectUrl = URL.createObjectURL(new Blob([copy], { type: 'video/mp2t' }));
  const link = document.createElement('a');
  link.href = objectUrl;
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  link.download = `webts-${stamp}.ts`;
  link.textContent = `復号済み TS をダウンロード (${(size / 1_048_576).toFixed(1)} MiB)`;
  download.replaceChildren(link);
}

function describe(module: DescrambleModule, words: Int32Array): [string, string][] {
  const at = (index: number): number => words[index] ?? 0;
  const inPackets = at(6) >>> 0;
  const inScrambled = at(7) >>> 0;
  const outPackets = at(8) >>> 0;
  const outScrambled = at(9) >>> 0;
  const share = (part: number, whole: number): string =>
    whole > 0 ? ` (${((part / whole) * 100).toFixed(1)}%)` : '';
  return [
    ['状態', STATE[at(0)] ?? String(at(0))],
    ['段階', STAGE[at(1)] ?? String(at(1))],
    ['エラー', `${name(module, at(2))} (${at(2)})`],
    ['libaribb25 の戻り値', String(at(3))],
    ['経過 (ms) 全体 / 受信のみ', `${at(4)} / ${at(5)}`],
    ['復号前 packet', String(inPackets)],
    ['復号前 スクランブル', `${inScrambled}${share(inScrambled, inPackets)}`],
    ['復号後 packet', String(outPackets)],
    ['復号後 スクランブル', `${outScrambled}${share(outScrambled, outPackets)}`],
    ['復号後 非整列', String(at(10) >>> 0)],
    ['番組数', at(11) < 0 ? '-' : String(at(11))],
    ['上流 総 packet', String(at(12) >>> 0)],
    ['上流 未復号 packet', String(at(13) >>> 0)],
    ['未契約 ECM 数', at(14) < 0 ? '-' : String(at(14))],
    ['直近の ECM エラー', at(15) < 0 ? '-' : String(at(15))],
  ];
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  start.disabled = true;
  table.replaceChildren();
  clearDownload();
  status.textContent = 'ファームウェアを読み出しています…';

  let firmwarePointer = 0;
  let firmwareLength = 0;
  let outputPointer = 0;
  let module: DescrambleModule | null = null;
  try {
    const firmware = await readCachedFirmware();
    if (!firmware) {
      status.textContent =
        'ファームウェアがキャッシュされていません。先に /firmware.html で取り込んでください。';
      return;
    }

    status.textContent = 'モジュールを読み込んでいます…';
    module = await load();

    firmwarePointer = module._malloc(firmware.length);
    firmwareLength = firmware.length;
    module.HEAPU8.set(firmware, firmwarePointer);
    outputPointer = module._malloc(POLL_WORDS * 4);

    status.textContent = '受信を開始しています…';
    const started = module.ccall(
      'webts_q3u4_descramble_start', 'number',
      ['number', 'number', 'number', 'number', 'number', 'number'],
      [firmwarePointer, firmware.length, Number(receiver.value), frequencyKhz(),
        Number(duration.value), collect.checked ? 1 : 0],
    ) as number;
    if (started !== 0) {
      status.textContent = `開始できません: ${name(module, started)} (${started})`;
      return;
    }

    status.textContent = '受信中…';
    for (;;) {
      module.ccall('webts_q3u4_descramble_poll', 'number', ['number', 'number'],
        [outputPointer, POLL_WORDS]);
      const words = module.HEAP32.slice(outputPointer / 4, outputPointer / 4 + POLL_WORDS);
      render(describe(module, words));
      const state = words[0] ?? 0;
      if (state !== 1) {
        status.textContent = state === 2 ? '完了しました。' : '失敗しました。';
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    module.ccall('webts_q3u4_descramble_join', 'number', [], []);
    offerDownload(module);
  } catch (error) {
    status.textContent = `失敗: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    // ファームウェアのバイト列をヒープに残さない。
    if (module && firmwarePointer !== 0) {
      module.HEAPU8.fill(0, firmwarePointer, firmwarePointer + firmwareLength);
      module._free(firmwarePointer);
    }
    if (module && outputPointer !== 0) module._free(outputPointer);
    start.disabled = false;
  }
});
