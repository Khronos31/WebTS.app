import {
  FIRMWARE_SOURCE,
  cacheFirmware,
  clearCachedFirmware,
  extractFirmware,
  readCachedFirmware,
  type FirmwareStage,
} from './firmware';

// 見た目は作り込まない。素の要素のみ。

const app = document.querySelector('#app');
if (!(app instanceof HTMLElement)) throw new Error('app root missing');

const heading = document.createElement('h1');
heading.textContent = 'IT930x ファームウェアの取得';
app.append(heading);

const explain = document.createElement('p');
explain.textContent =
  'PX-Q3U4 を動かすには IT930x のファームウェアが要ります。これは配布できないため、'
  + 'プレクス社のドライバを利用者自身が取得し、このページへ渡してください。'
  + '取り出した 2169 バイトはブラウザ内 (IndexedDB) に保存するだけで、どこへも送信しません。';
app.append(explain);

const caution = document.createElement('p');
caution.textContent =
  '注意: ダウンロードするのは PX-W3U4 用のドライバです。中に入っている IT930x '
  + 'ファームウェアは PX-Q3U4 と共通のため、これで正しいです。';
app.append(caution);

const linkParagraph = document.createElement('p');
const link = document.createElement('a');
link.href = FIRMWARE_SOURCE.archiveUrl;
link.textContent = FIRMWARE_SOURCE.archiveUrl;
link.rel = 'noreferrer';
linkParagraph.append('1. ドライバをダウンロード: ', link);
app.append(linkParagraph);

const pickLabel = document.createElement('p');
pickLabel.textContent = '2. ダウンロードした ZIP（または展開済みの PXW3U4.sys）を選んでください:';
app.append(pickLabel);

const picker = document.createElement('input');
picker.type = 'file';
picker.accept = '.zip,.sys';
app.append(picker);

const status = document.createElement('p');
status.setAttribute('role', 'status');
app.append(status);

const stages = document.createElement('ol');
app.append(stages);

const cacheState = document.createElement('p');
app.append(cacheState);

const clear = document.createElement('button');
clear.type = 'button';
clear.textContent = 'キャッシュを削除';
app.append(clear);

async function showCacheState(): Promise<void> {
  try {
    const cached = await readCachedFirmware();
    cacheState.textContent = cached
      ? `キャッシュ済み: ${cached.length} バイト`
      : 'キャッシュ: なし';
  } catch (error) {
    cacheState.textContent = `キャッシュ状態を読めません: ${describe(error)}`;
  }
}

picker.addEventListener('change', async () => {
  const file = picker.files?.[0];
  if (!file) return;
  picker.disabled = true;
  stages.replaceChildren();
  status.textContent = '処理中…';
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const onStage = (stage: FirmwareStage) => {
      const item = document.createElement('li');
      item.textContent = stage;
      stages.append(item);
    };
    const result = await extractFirmware(bytes, onStage);
    await cacheFirmware(result.bytes);
    onStage('cached');
    status.textContent =
      `取得できました。${result.bytes.length} バイト、offset 0x${result.offset.toString(16)}`
      + `（ヒント${result.usedHint ? '一致' : '不一致・走査で発見'}、`
      + `ZIP の固定ハッシュ${result.archiveMatchedPin ? '一致' : '不一致'}、`
      + `.sys の固定ハッシュ${result.sysMatchedPin ? '一致' : '不一致'}）`;
  } catch (error) {
    status.textContent = `失敗: ${describe(error)}`;
  } finally {
    picker.disabled = false;
    picker.value = '';
    await showCacheState();
  }
});

clear.addEventListener('click', async () => {
  await clearCachedFirmware();
  await showCacheState();
});

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

void showCacheState();
