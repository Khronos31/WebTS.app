import { readCachedFirmware } from './firmware';

// 見た目は作り込まない。素の要素のみ。
//
// これは実機から TS を受信するための検証ページで、製品 UI ではない。
// WASM モジュールはページの main thread で読み込み、ドライバ作業は
// その中の pthread が行う。main thread は WebUSB の Promise を解決する
// 側なので塞いではならない（docs/FINDINGS.md 12章）。

const MODULE_URL = '/build/q3u4-capture/q3u4-capture.mjs';
const POLL_WORDS = 21;

// 地上デジタルの物理チャンネル: ch13 = 473143 kHz、以降 6 MHz 間隔。
const CHANNEL_BASE_KHZ = 473_143;
const CHANNEL_STEP_KHZ = 6_000;
const MIN_CHANNEL = 13;
const MAX_CHANNEL = 62;

const STATE = ['待機', '実行中', '完了', '失敗'];
const STAGE = [
  'start', 'firmware-image', 'open-runtime', 'init', 'frontend-open', 'tune',
  'demod-lock', 'data-plane', 'start-capture', 'attach', 'reading', 'cleanup', 'done',
];
const TERMINAL = [
  'none', 'slow_consumer', 'usb_error', 'sync_error', 'bridge_fatal', 'stopped', 'disconnected',
];

interface CaptureModule {
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
heading.textContent = 'PX-Q3U4 TS 受信';
app.append(heading);

const explain = document.createElement('p');
explain.textContent =
  '選局してロックしたあと、実際に TS を受信します。受信したデータは保存も送信もせず、'
  + '同期・PID 数・スクランブル制御ビットといった形の集計だけを表示します。'
  + 'これは映像ではありません。日本の地上デジタルは暗号化されているため、'
  + '映像にするには B25 とカード、そのあと分離と復号が要ります。';
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

const receiver = document.createElement('select');
for (const value of ['2', '3']) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = `${value}（ISDB-T）`;
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

const start = document.createElement('button');
start.type = 'submit';
start.textContent = '受信開始';
form.append(start);

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

let cached: CaptureModule | null = null;
async function load(): Promise<CaptureModule> {
  if (cached) return cached;
  const factory = (await import(/* @vite-ignore */ MODULE_URL)) as {
    default: () => Promise<CaptureModule>;
  };
  cached = await factory.default();
  return cached;
}

function name(module: CaptureModule, error: number): string {
  return String(module.ccall('webts_q3u4_capture_error_name', 'string', ['number'], [error]));
}

function describe(module: CaptureModule, words: Int32Array): [string, string][] {
  // noUncheckedIndexedAccess のもとでは添字アクセスが number | undefined になる。
  // 語数は C 側と合意済みなので、読めない語は 0 として扱う。
  const at = (index: number): number => words[index] ?? 0;
  const bytes = (at(5) >>> 0) + at(6) * 2 ** 32;
  // スループットの分母は read ループの実時間。全経過には列挙・選局・
  // ロック待ちが含まれるので、そちらで割ると実際より遅く見える。
  const readingSeconds = at(20) / 1000;
  const rate = readingSeconds > 0 ? bytes / readingSeconds / 125_000 : 0;
  return [
    ['状態', STATE[at(0)] ?? String(at(0))],
    ['段階', STAGE[at(1)] ?? String(at(1))],
    ['エラー', `${name(module, at(2))} (${at(2)})`],
    ['終端理由', TERMINAL[at(3)] ?? String(at(3))],
    ['経過 (ms) 全体 / 受信のみ', `${at(4)} / ${at(20)}`],
    ['受信バイト', `${bytes} (受信中 ${rate.toFixed(2)} Mbps)`],
    ['整列 packet', String(at(7) >>> 0)],
    ['非整列 packet', String(at(8) >>> 0)],
    ['スクランブル packet', String(at(9) >>> 0)],
    ['出現 PID 数', String(at(10))],
    ['read 回数 / うち timeout', `${at(11)} / ${at(12)}`],
    ['TSID', at(13) < 0 ? '-' : `0x${(at(13) >>> 0).toString(16)}`],
    ['上流 packets', String(at(14) >>> 0)],
    ['上流 sync errors', String(at(15) >>> 0)],
    ['上流 continuity errors', String(at(16) >>> 0)],
    ['上流 queue drops', String(at(17) >>> 0)],
    ['上流 usb errors', String(at(18) >>> 0)],
    ['上流 TEI packets', String(at(19) >>> 0)],
  ];
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  start.disabled = true;
  table.replaceChildren();
  status.textContent = 'ファームウェアを読み出しています…';

  let firmwarePointer = 0;
  let firmwareLength = 0;
  let outputPointer = 0;
  let module: CaptureModule | null = null;
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
      'webts_q3u4_capture_start', 'number',
      ['number', 'number', 'number', 'number', 'number'],
      [firmwarePointer, firmware.length, Number(receiver.value), frequencyKhz(),
        Number(duration.value)],
    ) as number;
    if (started !== 0) {
      status.textContent = `開始できません: ${name(module, started)} (${started})`;
      return;
    }

    status.textContent = '受信中…';
    for (;;) {
      module.ccall('webts_q3u4_capture_poll', 'number', ['number', 'number'],
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
    module.ccall('webts_q3u4_capture_join', 'number', [], []);
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
