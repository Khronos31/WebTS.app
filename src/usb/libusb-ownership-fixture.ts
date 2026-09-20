import {
  LIBUSB_OWNERSHIP_SCENARIOS,
  runLibusbOwnershipWorker,
  type LibusbOwnershipVariant,
} from './libusb-ownership-worker-diagnostic';

// Test-only page. It is intentionally absent from the production Vite inputs
// and is served by the dev server only. Everything below runs against a fake
// navigator.usb inside an isolated Dedicated Worker.

const SCENARIO_LABELS: Record<number, string> = {
  0: '0 pending cancel（Promise未解決のまま論理callback）',
  1: '1 cancel後のlate resolve',
  2: '2 cancel後のlate reject',
  3: '3 callback内free → late resolve',
  4: '4 二重cancel',
  5: '5 pending中のdisconnect',
  6: '6 複数handleのcancel/close',
  7: '7 通常完了（回帰ガード・stockも成功する想定）',
  8: '8 disconnect＋callback内free → late resolve',
  9: '9 cancel→event処理前のdisconnect（core側list順序）',
};

const EXPECTATION_NOTE =
  'stockは0〜6・8・9で失敗基準、7だけが両方成功する想定です。' +
  'この観測はfake navigator.usbに限られ、WebUSBの物理abort、実機のbounded stop/join、' +
  '実transferの解放を証明しません。';

const app = document.querySelector('#app');
if (!(app instanceof HTMLElement)) throw new Error('fixture root missing');

const heading = document.createElement('h1');
heading.textContent = 'libusb transfer ownership regression fixture';
app.appendChild(heading);

const notice = document.createElement('p');
notice.textContent =
  '公式libusb core＋WebUSB backend（pristine／ownership patch適用済みbuild copy）を' +
  'fake navigator.usbだけで実行します。実USB、requestDevice、firmware、mode、tune、TS、' +
  'B25は使用しません。1 Worker＝1 scenarioで、実行後にWorkerをterminateします。';
app.appendChild(notice);

const scenarioSelect = document.createElement('select');
scenarioSelect.setAttribute('aria-label', 'ownership scenario');
scenarioSelect.innerHTML = LIBUSB_OWNERSHIP_SCENARIOS
  .map((name, index) => `<option value="${index}">${SCENARIO_LABELS[index] ?? name}</option>`)
  .join('');
app.appendChild(scenarioSelect);

const variantSelect = document.createElement('select');
variantSelect.setAttribute('aria-label', 'backend variant');
variantSelect.innerHTML =
  '<option value="patched">patched（ownership patch適用build copy）</option>' +
  '<option value="stock">stock（公式snapshotそのまま・失敗基準）</option>';
app.appendChild(variantSelect);

const button = document.createElement('button');
button.type = 'button';
button.textContent = 'Dedicated Workerで1 scenario実行（USBなし）';
app.appendChild(button);

const status = document.createElement('p');
status.setAttribute('role', 'status');
status.textContent = '未実行';
app.appendChild(status);

const output = document.createElement('pre');
app.appendChild(output);

button.addEventListener('click', async () => {
  button.disabled = true;
  status.textContent = 'Worker実行中…';
  output.textContent = '';
  const scenarioIndex = Number.parseInt(scenarioSelect.value, 10);
  const variant: LibusbOwnershipVariant =
    variantSelect.value === 'stock' ? 'stock' : 'patched';
  const report = await runLibusbOwnershipWorker(scenarioIndex, variant);
  status.textContent =
    `libusb ownership ${variant} scenario ${scenarioIndex}: ${report.diagnostic}（合成のみ）`;
  output.textContent = JSON.stringify(
    { ...report, variant, scenario: scenarioIndex, note: EXPECTATION_NOTE }, null, 2);
  button.disabled = false;
});
