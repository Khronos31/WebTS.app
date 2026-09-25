import { loadFirmware } from './firmware';

// 見た目は作り込まない。素の要素のみ。
//
// カードの応答バイトは表示しない。SW1SW2 と応答長、ATR の長さと
// プロトコル引数だけを出す。カード ID・鍵・ATR のバイト列は C 側でも
// 保持していない。

const MODULE_URL = '/build/q3u4-b25/q3u4-b25.mjs';
const POLL_WORDS = 12;

const STATE = ['待機', '実行中', '完了', '失敗'];
const STAGE = [
  'start', 'firmware-image', 'open-runtime', 'init', 'create', 'card-init',
  'init-status', 'get-id', 'power-on-control', 'release', 'shutdown', 'done',
];

interface B25Module {
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
heading.textContent = 'libaribb25 B_CAS_CARD';
app.append(heading);

const explain = document.createElement('p');
explain.textContent =
  '上流 libaribb25 が期待する B_CAS_CARD の vtable を、PX-Q3U4 内蔵リーダの上で'
  + '動かします。b_cas_card.c は改変せず同梱し、PC/SC の面だけをこちらで'
  + '用意しています。復号はまだ行いません。'
  + 'カード ID・システム鍵・CBC 初期値は表示も保存もしません。'
  + '出すのは「あるかどうか」だけです。';
app.append(explain);

const start = document.createElement('button');
start.type = 'button';
start.textContent = 'B_CAS_CARD を試す';
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

let cached: B25Module | null = null;
async function load(): Promise<B25Module> {
  if (cached) return cached;
  const factory = (await import(/* @vite-ignore */ MODULE_URL)) as {
    default: () => Promise<B25Module>;
  };
  cached = await factory.default();
  return cached;
}

function name(module: B25Module, error: number): string {
  return String(module.ccall('webts_q3u4_b25_error_name', 'string', ['number'], [error]));
}

function tri(value: number): string {
  if (value < 0) return '-';
  return value === 1 ? 'はい' : 'いいえ';
}

function describe(module: B25Module, words: Int32Array): [string, string][] {
  const at = (index: number): number => words[index] ?? 0;
  return [
    ['状態', STATE[at(0)] ?? String(at(0))],
    ['段階', STAGE[at(1)] ?? String(at(1))],
    ['エラー', `${name(module, at(2))} (${at(2)})`],
    ['経過 (ms)', String(at(3))],
    ['init() 戻り値', at(4) < 0 ? '-' : String(at(4))],
    ['CA system ID', at(5) < 0 ? '-' : `0x${at(5).toString(16).padStart(4, '0')}`],
    ['card status', at(6) < 0 ? '-' : String(at(6))],
    ['システム鍵あり', tri(at(7))],
    ['CBC 初期値あり', tri(at(8))],
    ['カード ID あり', tri(at(9))],
    ['ID 件数', at(10) < 0 ? '-' : String(at(10))],
    ['電源制御情報 件数', at(11) < 0 ? '-' : String(at(11))],
  ];
}

start.addEventListener('click', async () => {
  start.disabled = true;
  table.replaceChildren();
  status.textContent = 'ファームウェアを読み出しています…';

  let firmwarePointer = 0;
  let firmwareLength = 0;
  let outputPointer = 0;
  let module: B25Module | null = null;
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

    const started = module.ccall('webts_q3u4_b25_start', 'number',
      ['number', 'number'], [firmwarePointer, firmware.length]) as number;
    if (started !== 0) {
      status.textContent = `開始できません: ${name(module, started)} (${started})`;
      return;
    }

    status.textContent = '実行中…';
    for (;;) {
      module.ccall('webts_q3u4_b25_poll', 'number', ['number', 'number'],
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
    module.ccall('webts_q3u4_b25_join', 'number', [], []);
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
