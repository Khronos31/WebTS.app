import { loadFirmware } from './firmware';

// 見た目は作り込まない。素の要素のみ。
//
// カードの応答バイトは表示しない。SW1SW2 と応答長、ATR の長さと
// プロトコル引数だけを出す。カード ID・鍵・ATR のバイト列は C 側でも
// 保持していない。

const MODULE_URL = '/build/q3u4-card/q3u4-card.mjs';
const POLL_WORDS = 13;

const STATE = ['待機', '実行中', '完了', '失敗'];
const STAGE = [
  'start', 'firmware-image', 'open-runtime', 'init', 'status', 'connect',
  'transmit', 'disconnect', 'shutdown', 'done',
];
const BAUD = ['9600', '19200', '38400', '57600'];
const EDC = ['LRC', 'CRC'];

interface CardModule {
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
heading.textContent = 'PX-Q3U4 内蔵カードリーダ';
app.append(heading);

const explain = document.createElement('p');
explain.textContent =
  'カードリーダに電源を入れ、リセットして ATR を読み、T=1 セッションを張って '
  + 'APDU を1往復させます。復号はまだ行いません。'
  + 'カードの応答内容は表示も保存もしません。出すのは成否と長さだけです。';
app.append(explain);

const start = document.createElement('button');
start.type = 'button';
start.textContent = 'カードを試す';
app.append(start);

const status = document.createElement('p');
status.setAttribute('role', 'status');
app.append(status);

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

let cached: CardModule | null = null;
async function load(): Promise<CardModule> {
  if (cached) return cached;
  const factory = (await import(/* @vite-ignore */ MODULE_URL)) as {
    default: () => Promise<CardModule>;
  };
  cached = await factory.default();
  return cached;
}

function name(module: CardModule, error: number): string {
  return String(module.ccall('webts_q3u4_card_error_name', 'string', ['number'], [error]));
}

function tri(value: number): string {
  if (value < 0) return '-';
  return value === 1 ? 'はい' : 'いいえ';
}

function describe(module: CardModule, words: Int32Array): [string, string][] {
  const at = (index: number): number => words[index] ?? 0;
  const sw = at(12);
  return [
    ['状態', STATE[at(0)] ?? String(at(0))],
    ['段階', STAGE[at(1)] ?? String(at(1))],
    ['エラー', `${name(module, at(2))} (${at(2)})`],
    ['経過 (ms)', String(at(3))],
    ['カード検出', tri(at(4))],
    ['ATR 長 (bytes)', at(5) < 0 ? '-' : String(at(5))],
    ['ボーレート', at(6) < 0 ? '-' : (BAUD[at(6)] ?? String(at(6)))],
    ['IFSC', at(7) < 0 ? '-' : String(at(7))],
    ['EDC', at(8) < 0 ? '-' : (EDC[at(8)] ?? String(at(8)))],
    ['ブロックタイムアウト (ms)', at(9) < 0 ? '-' : String(at(9))],
    ['T=1 セッション確立', tri(at(10))],
    ['応答長 (bytes)', at(11) < 0 ? '-' : String(at(11))],
    ['SW1SW2', sw < 0 ? '-' : `0x${sw.toString(16).padStart(4, '0')}`],
  ];
}

start.addEventListener('click', async () => {
  start.disabled = true;
  table.replaceChildren();
  status.textContent = 'ファームウェアを読み出しています…';

  let firmwarePointer = 0;
  let firmwareLength = 0;
  let outputPointer = 0;
  let module: CardModule | null = null;
  try {
    let firmware: Uint8Array;
    try {
      firmware = await loadFirmware();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
      return;
    }

    status.textContent = 'モジュールを読み込んでいます…';
    module = await load();

    firmwarePointer = module._malloc(firmware.length);
    firmwareLength = firmware.length;
    module.HEAPU8.set(firmware, firmwarePointer);
    outputPointer = module._malloc(POLL_WORDS * 4);

    const started = module.ccall('webts_q3u4_card_start', 'number',
      ['number', 'number'], [firmwarePointer, firmware.length]) as number;
    if (started !== 0) {
      status.textContent = `開始できません: ${name(module, started)} (${started})`;
      return;
    }

    status.textContent = '実行中…';
    for (;;) {
      module.ccall('webts_q3u4_card_poll', 'number', ['number', 'number'],
        [outputPointer, POLL_WORDS]);
      const words = module.HEAP32.slice(outputPointer / 4, outputPointer / 4 + POLL_WORDS);
      render(describe(module, words));
      const state = words[0] ?? 0;
      if (state !== 1) {
        status.textContent = state === 2 ? '完了しました。' : '失敗しました。';
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    module.ccall('webts_q3u4_card_join', 'number', [], []);
  } catch (error) {
    status.textContent = `失敗: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    if (module && firmwarePointer !== 0) {
      module.HEAPU8.fill(0, firmwarePointer, firmwarePointer + firmwareLength);
      module._free(firmwarePointer);
    }
    if (module && outputPointer !== 0) module._free(outputPointer);
    start.disabled = false;
  }
});
