/** Opt-in M1 WebUSB/libusb WASM diagnostics, including a separate lifecycle probe. */
import '../styles/app.css';
import {
  enumerateAuthorizedDevices,
  enumerateAuthorizedSianoRioDevices,
  inspectLocalSianoFirmware,
  runAuthorizedSianoRioLifecycle,
  requestAndEnumerateAuthorizedDevices,
  WasmEnumerationDiagnosticError,
  type WebUsbPermissionSource,
} from '../usb/wasm-enumeration-diagnostic';
import type { USBDeviceFilter } from '../types/usb';
import { runPx4GroupingMockScenario } from '../usb/px4-grouping-diagnostic';
import { runPx4RuntimeMockOpenClose } from '../usb/px4-runtime-mock-diagnostic';
import { runPx4It930xProtocolMock } from '../usb/px4-it930x-protocol-diagnostic';
import { runPx4TaggedTsDemuxMock } from '../usb/px4-tagged-ts-demux-diagnostic';
import { runB25CoreNoCardSmoke, runB25FacadeNoCardSmoke } from '../usb/b25-core-diagnostic';
import { runSianoTsQueueMock } from '../usb/siano-ts-queue-diagnostic';
import { runSianoLiveStatsMock } from '../usb/siano-live-stats-diagnostic';
import { runDedicatedWorkerEnumeration } from '../usb/webusb-worker-diagnostic';
import { runSianoWorkerFixture, type SianoWorkerFixtureKind } from '../usb/siano-worker-diagnostic';
import { runPx4StreamLifecycleWorker } from '../usb/px4-stream-lifecycle-worker-diagnostic';
import {
  DEFAULT_LIBUSB_WASM_MODULE_URL,
  loadGeneratedLibusbModule,
  NON_PTHREAD_LIBUSB_WASM_MODULE_URL,
  loadGeneratedSianoFirmwareModule,
  loadGeneratedPx4GroupingModule,
  loadGeneratedPx4RuntimeMockModule,
  loadGeneratedPx4It930xProtocolModule,
  loadGeneratedPx4TaggedTsDemuxModule,
  loadGeneratedB25CoreModule,
  loadGeneratedSianoTsQueueModule,
  loadGeneratedSianoLiveStatsModule,
  loadGeneratedSianoRioModule,
} from '../usb/wasm-loader';
import { SUPPORTED_DEVICE_FILTERS } from '../usb/filters';

const root = document.getElementById('m1-app');
if (!root) throw new Error('M1 root element #m1-app not found');

const heading = document.createElement('h1');
heading.className = 'app-title';
heading.textContent = 'WebTS.app M1 WASM診断（列挙 / lifecycle opt-in）';
root.appendChild(heading);

const explanation = document.createElement('p');
explanation.className = 'app-subtitle';
explanation.textContent = '列挙ボタンはVID/PIDと件数だけを確認する読み取り診断です。Siano open→closeボタンは別の明示的opt-inで、interface claimと両endpointのclear-haltを試みます。';
root.appendChild(explanation);

const button = document.createElement('button');
button.type = 'button';
button.className = 'btn btn-primary';
button.textContent = 'WebUSB権限を取得してWASM列挙';
root.appendChild(button);

const authorizedButton = document.createElement('button');
authorizedButton.type = 'button';
authorizedButton.className = 'btn btn-secondary';
authorizedButton.textContent = '既許可デバイスだけでWASM列挙';
root.appendChild(authorizedButton);

const workerEnumerationButton = document.createElement('button');
workerEnumerationButton.type = 'button';
workerEnumerationButton.className = 'btn btn-secondary';
workerEnumerationButton.textContent = 'Worker内・既許可WebUSB列挙（read-only）';
root.appendChild(workerEnumerationButton);

const workerEnumerationNotice = document.createElement('p');
workerEnumerationNotice.className = 'app-subtitle';
workerEnumerationNotice.textContent = 'requestDeviceはWindowのユーザー操作だけで実行します。このボタンはWorker内のgetDevices＋公式libusb列挙のみで、標準descriptor control-INと一時open以外のclaim/bulk/firmware/tune/TSは行いません。Worker terminateは保留USB処理の物理解放を保証しません。';
root.appendChild(workerEnumerationNotice);

const sianoButton = document.createElement('button');
sianoButton.type = 'button';
sianoButton.className = 'btn btn-secondary';
sianoButton.textContent = '既許可Siano Rioだけを確認';
root.appendChild(sianoButton);

const lifecycleButton = document.createElement('button');
lifecycleButton.type = 'button';
lifecycleButton.className = 'btn btn-secondary';
lifecycleButton.textContent = 'Siano open→close診断（実機操作）';
root.appendChild(lifecycleButton);

const lifecycleNotice = document.createElement('p');
lifecycleNotice.className = 'app-subtitle';
lifecycleNotice.textContent = '注意: open→closeはデバイス状態に触れます。upstreamはclear-haltの戻り値を無視するため、成功表示はopen/closeの固定codeだけで、clear-halt成功とは判定しません。';
root.appendChild(lifecycleNotice);

const firmwareButton = document.createElement('button');
firmwareButton.type = 'button';
firmwareButton.className = 'btn btn-secondary';
firmwareButton.textContent = 'ファームウェアをローカル検査（USB送信なし）';
root.appendChild(firmwareButton);

const firmwareInput = document.createElement('input');
firmwareInput.type = 'file';
firmwareInput.accept = '.inp,application/octet-stream';
firmwareInput.hidden = true;
firmwareInput.setAttribute('aria-hidden', 'true');
root.appendChild(firmwareInput);

const firmwareNotice = document.createElement('p');
firmwareNotice.className = 'app-subtitle';
firmwareNotice.textContent = '選択したbytesはSHA-256とupstream header/path境界だけをローカル検査します。ファイル名・digest・内容は表示せず、USB open/claim/transferは行いません。';
root.appendChild(firmwareNotice);

const px4GroupingButton = document.createElement('button');
px4GroupingButton.type = 'button';
px4GroupingButton.className = 'btn btn-secondary';
px4GroupingButton.textContent = 'PX4 identity grouping（合成mockのみ）';
root.appendChild(px4GroupingButton);

const px4ScenarioLabel = document.createElement('label');
px4ScenarioLabel.textContent = 'PX4 mock scenario: ';
const px4ScenarioSelect = document.createElement('select');
px4ScenarioSelect.setAttribute('aria-label', 'PX4 mock scenario');
px4ScenarioSelect.innerHTML = '<option value="0">0: ready pair</option><option value="1">1: incomplete</option><option value="2">2: duplicate slot</option><option value="3">3: two ready groups</option>';
px4ScenarioLabel.appendChild(px4ScenarioSelect);
root.appendChild(px4ScenarioLabel);

const px4GroupingNotice = document.createElement('p');
px4GroupingNotice.className = 'app-subtitle';
px4GroupingNotice.textContent = 'PX4 upstream identity.cppへ合成観測だけを渡します。USB権限、serial read、open/claim、command、firmware、tune、TSは行いません。';
root.appendChild(px4GroupingNotice);

const px4RuntimeMockButton = document.createElement('button');
px4RuntimeMockButton.type = 'button';
px4RuntimeMockButton.className = 'btn btn-secondary';
px4RuntimeMockButton.textContent = 'PX4 runtime open→close（合成mockのみ）';
root.appendChild(px4RuntimeMockButton);

const px4RuntimeMockNotice = document.createElement('p');
px4RuntimeMockNotice.className = 'app-subtitle';
px4RuntimeMockNotice.textContent = 'upstream RuntimeTestAccessへ合成LibusbApiだけを注入します。実USB、navigator.usb、serial、実機open/claim、command、firmware、tune、TSは行いません。';
root.appendChild(px4RuntimeMockNotice);

const px4StreamWorkerButton = document.createElement('button');
px4StreamWorkerButton.type = 'button';
px4StreamWorkerButton.className = 'btn btn-secondary';
px4StreamWorkerButton.textContent = 'PX4 stream lifecycle Worker（合成fixtureのみ）';
root.appendChild(px4StreamWorkerButton);

const px4StreamWorkerNotice = document.createElement('p');
px4StreamWorkerNotice.className = 'app-subtitle';
px4StreamWorkerNotice.textContent = 'Dedicated Worker内でupstream Q3U4StreamDataPlaneと同期fakeを実行します。USB、WebUSB、serial、firmware、command、tune、実TSは扱わず、main threadでpthread joinを行いません。15秒timeout後のWorker terminateは物理解放を保証しません。';
root.appendChild(px4StreamWorkerNotice);

const px4ProtocolButton = document.createElement('button');
px4ProtocolButton.type = 'button';
px4ProtocolButton.className = 'btn btn-secondary';
px4ProtocolButton.textContent = 'PX4 IT930x scatter parser（合成fixtureのみ）';
root.appendChild(px4ProtocolButton);

const px4ProtocolScenarioLabel = document.createElement('label');
px4ProtocolScenarioLabel.textContent = 'PX4 scatter scenario: ';
const px4ProtocolScenarioSelect = document.createElement('select');
px4ProtocolScenarioSelect.setAttribute('aria-label', 'PX4 framing scenario');
px4ProtocolScenarioSelect.innerHTML = '<option value="0">0: valid block</option><option value="1">1: valid two blocks</option><option value="2">2: invalid magic</option><option value="3">3: truncated metadata</option><option value="4">4: zero payload</option><option value="5">5: over bound</option><option value="6">6: empty input</option>';
px4ProtocolScenarioLabel.appendChild(px4ProtocolScenarioSelect);
root.appendChild(px4ProtocolScenarioLabel);

const px4ProtocolNotice = document.createElement('p');
px4ProtocolNotice.className = 'app-subtitle';
px4ProtocolNotice.textContent = 'upstream it930x_protocol.cpp のscatter image parserだけを合成入力で検査します。USB command、CRC検査（上流APIなし）、firmware、card、tune、TSは行いません。';
root.appendChild(px4ProtocolNotice);

const px4TaggedTsDemuxButton = document.createElement('button');
px4TaggedTsDemuxButton.type = 'button';
px4TaggedTsDemuxButton.className = 'btn btn-secondary';
px4TaggedTsDemuxButton.textContent = 'PX4 tagged TS demux（合成fixtureのみ）';
root.appendChild(px4TaggedTsDemuxButton);

const px4TaggedTsDemuxScenarioLabel = document.createElement('label');
px4TaggedTsDemuxScenarioLabel.textContent = 'PX4 tagged TS scenario: ';
const px4TaggedTsDemuxScenarioSelect = document.createElement('select');
px4TaggedTsDemuxScenarioSelect.setAttribute('aria-label', 'PX4 tagged TS scenario');
px4TaggedTsDemuxScenarioSelect.innerHTML = '<option value="0">0: four tags</option><option value="1">1: split input</option><option value="2">2: invalid tag＋sync loss</option><option value="3">3: sink failure＋empty retry</option><option value="4">4: reset</option><option value="5">5: input bounds</option>';
px4TaggedTsDemuxScenarioLabel.appendChild(px4TaggedTsDemuxScenarioSelect);
root.appendChild(px4TaggedTsDemuxScenarioLabel);

const px4TaggedTsDemuxNotice = document.createElement('p');
px4TaggedTsDemuxNotice.className = 'app-subtitle';
px4TaggedTsDemuxNotice.textContent = 'vendor px4-userland TaggedTsDemuxへ合成tagged packetだけを渡します。packet payload、USB、serial、実Q3U4、firmware、tune、実TSは扱いません。';
root.appendChild(px4TaggedTsDemuxNotice);

const b25Button = document.createElement('button');
b25Button.type = 'button';
b25Button.className = 'btn btn-secondary';
b25Button.textContent = 'B25 上流facade（カード/TSなし）';
root.appendChild(b25Button);

const b25Notice = document.createElement('p');
b25Notice.className = 'app-subtitle';
b25Notice.textContent = 'libaribb25 upstream facadeの生成・設定・解放とcore smokeだけを検査します。カード、鍵、TS、PC/SC、USB、復号は行わず、復号未検証です。';
root.appendChild(b25Notice);

const sianoQueueButton = document.createElement('button');
sianoQueueButton.type = 'button';
sianoQueueButton.className = 'btn btn-secondary';
sianoQueueButton.textContent = 'Siano TS queue（合成fixtureのみ・実TS未受信）';
root.appendChild(sianoQueueButton);

const sianoQueueScenarioLabel = document.createElement('label');
sianoQueueScenarioLabel.textContent = 'Siano queue scenario: ';
const sianoQueueScenarioSelect = document.createElement('select');
sianoQueueScenarioSelect.setAttribute('aria-label', 'Siano queue scenario');
sianoQueueScenarioSelect.innerHTML = '<option value="0">0: FIFO/drain/reinit</option><option value="1">1: capacity drop</option><option value="2">2: close/drop</option><option value="3">3: oversized truncate</option><option value="4">4: reinitialize</option>';
sianoQueueScenarioLabel.appendChild(sianoQueueScenarioSelect);
root.appendChild(sianoQueueScenarioLabel);

const sianoQueueNotice = document.createElement('p');
sianoQueueNotice.className = 'app-subtitle';
sianoQueueNotice.textContent = 'upstream siano-ts.c の固定queueへ合成chunkだけを渡します。実TS、USB、stream/version、firmware、tuneは受信・実行せず、payloadも表示しません。';
root.appendChild(sianoQueueNotice);

const sianoLiveStatsButton = document.createElement('button');
sianoLiveStatsButton.type = 'button';
sianoLiveStatsButton.className = 'btn btn-secondary';
sianoLiveStatsButton.textContent = 'Siano live stats（合成fixtureのみ・実セッション未接続）';
root.appendChild(sianoLiveStatsButton);

const sianoLiveStatsScenarioLabel = document.createElement('label');
sianoLiveStatsScenarioLabel.textContent = 'Siano live stats scenario: ';
const sianoLiveStatsScenarioSelect = document.createElement('select');
sianoLiveStatsScenarioSelect.setAttribute('aria-label', 'Siano live stats scenario');
sianoLiveStatsScenarioSelect.innerHTML = '<option value="0">0: idle（counter未計測）</option><option value="1">1: open queue</option><option value="2">2: streaming overflow/drop</option><option value="3">3: close＋truncate/dequeue/drop/failure</option>';
sianoLiveStatsScenarioLabel.appendChild(sianoLiveStatsScenarioSelect);
root.appendChild(sianoLiveStatsScenarioLabel);

const sianoLiveStatsNotice = document.createElement('p');
sianoLiveStatsNotice.className = 'app-subtitle';
sianoLiveStatsNotice.textContent = 'upstream mutex付きsnapshotの合成境界だけを検査します。実セッション、USB、stream/version、firmware、tune、payloadは扱いません。計測済みbytesはdecimal stringで表示し、IDLEなど未計測値は0に偽装せずnullで表示します。transferErrorsは全USBエラーではなく初回stream failure遷移数です。';
root.appendChild(sianoLiveStatsNotice);

const sianoWorkerButton = document.createElement('button');
sianoWorkerButton.type = 'button';
sianoWorkerButton.className = 'btn btn-secondary';
sianoWorkerButton.textContent = 'Siano Worker合成fixture（USBなし）';
root.appendChild(sianoWorkerButton);

const sianoWorkerKindLabel = document.createElement('label');
sianoWorkerKindLabel.textContent = 'Siano Worker fixture: ';
const sianoWorkerKindSelect = document.createElement('select');
sianoWorkerKindSelect.setAttribute('aria-label', 'Siano Worker fixture');
sianoWorkerKindSelect.innerHTML = '<option value="QUEUE">queue</option><option value="LIVE_STATS">live stats</option>';
sianoWorkerKindLabel.appendChild(sianoWorkerKindSelect);
root.appendChild(sianoWorkerKindLabel);

const sianoWorkerScenarioLabel = document.createElement('label');
sianoWorkerScenarioLabel.textContent = 'scenario: ';
const sianoWorkerScenarioSelect = document.createElement('select');
sianoWorkerScenarioSelect.setAttribute('aria-label', 'Siano Worker scenario');
sianoWorkerScenarioSelect.innerHTML = '<option value="0">0</option><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option>';
sianoWorkerScenarioLabel.appendChild(sianoWorkerScenarioSelect);
root.appendChild(sianoWorkerScenarioLabel);
sianoWorkerKindSelect.addEventListener('change', () => {
  const scenarioFour = sianoWorkerScenarioSelect.querySelector('option[value="4"]');
  if (scenarioFour instanceof HTMLOptionElement) scenarioFour.disabled = sianoWorkerKindSelect.value === 'LIVE_STATS';
  if (sianoWorkerKindSelect.value === 'LIVE_STATS' && sianoWorkerScenarioSelect.value === '4') {
    sianoWorkerScenarioSelect.value = '3';
  }
});

const sianoWorkerNotice = document.createElement('p');
sianoWorkerNotice.className = 'app-subtitle';
sianoWorkerNotice.textContent = 'Siano WASMをWorker内でloadし、USB-freeのqueue/live-stats合成ABIだけを実行します。実open/claim/clear-halt/start/version、firmware、tune、TS、payloadは扱いません。';
root.appendChild(sianoWorkerNotice);

const variantLabel = document.createElement('label');
variantLabel.textContent = 'WASM variant: ';
const variantSelect = document.createElement('select');
variantSelect.setAttribute('aria-label', 'WASM variant');
variantSelect.innerHTML = '<option value="pthread">pthread（通常）</option><option value="nopthread">non-pthread Asyncify（比較用）</option>';
variantLabel.appendChild(variantSelect);
root.appendChild(variantLabel);

const status = document.createElement('p');
status.setAttribute('role', 'status');
status.setAttribute('aria-live', 'polite');
status.textContent = '待機中';
root.appendChild(status);

const output = document.createElement('pre');
output.className = 'code-font';
root.appendChild(output);

const usb = getWebUsbSource();
button.disabled = usb === null;
authorizedButton.disabled = usb === null;
sianoButton.disabled = usb === null;
lifecycleButton.disabled = usb === null;
if (usb === null) status.textContent = 'UNSUPPORTED_WEBUSB（ファームウェア検査は利用可能）';

button.addEventListener('click', async () => {
  if (usb === null) return;
  button.disabled = true;
  authorizedButton.disabled = true;
  sianoButton.disabled = true;
  lifecycleButton.disabled = true;
  firmwareButton.disabled = true;
  px4GroupingButton.disabled = true;
  px4RuntimeMockButton.disabled = true;
  px4ProtocolButton.disabled = true;
  b25Button.disabled = true;
  sianoQueueButton.disabled = true;
  status.textContent = 'requestDevice待機中…';
  output.textContent = '';
  try {
    // This call is intentionally the first async operation in the click path.
    const report = await requestAndEnumerateAuthorizedDevices(
      usb,
      () => loadGeneratedLibusbModule(selectedModuleUrl()),
      SUPPORTED_DEVICE_FILTERS,
    );
    status.textContent = '列挙完了';
    output.textContent = JSON.stringify({
      permissionDevice: report.permissionDevice,
      wasmDeviceCount: report.wasmDeviceCount,
      wasmDevices: report.wasmDevices,
      wasmDiagnostic: report.wasmDiagnostic,
      wasmWebUsbDeviceCount: report.wasmWebUsbDeviceCount,
      wasmWebUsbDiagnostic: report.wasmWebUsbDiagnostic,
      wasmExecutionContext: report.wasmExecutionContext,
    }, null, 2);
  } catch (error) {
    const code = error instanceof WasmEnumerationDiagnosticError
      ? error.code
      : 'WASM_ENUMERATION_FAILED';
    status.textContent = code;
    output.textContent = '';
  } finally {
    button.disabled = false;
    authorizedButton.disabled = false;
    sianoButton.disabled = false;
    lifecycleButton.disabled = false;
    firmwareButton.disabled = false;
    px4GroupingButton.disabled = false;
    px4RuntimeMockButton.disabled = false;
    px4ProtocolButton.disabled = false;
    b25Button.disabled = false;
    sianoQueueButton.disabled = false;
  }
});

sianoButton.addEventListener('click', async () => {
  if (usb === null) return;
  button.disabled = true;
  authorizedButton.disabled = true;
  sianoButton.disabled = true;
  lifecycleButton.disabled = true;
  firmwareButton.disabled = true;
  px4GroupingButton.disabled = true;
  px4RuntimeMockButton.disabled = true;
  px4ProtocolButton.disabled = true;
  b25Button.disabled = true;
  sianoQueueButton.disabled = true;
  status.textContent = '既許可Siano Rioを確認中…';
  output.textContent = '';
  try {
    const report = await enumerateAuthorizedSianoRioDevices(
      usb,
      () => loadGeneratedSianoRioModule(),
    );
    status.textContent = report.diagnostic === 'NONE' ? 'Siano Rio確認完了' : report.diagnostic;
    output.textContent = JSON.stringify({
      authorizedDeviceCount: report.authorizedDeviceCount,
      supportedDeviceCount: report.supportedDeviceCount,
      diagnostic: report.diagnostic,
    }, null, 2);
  } catch (error) {
    const code = error instanceof WasmEnumerationDiagnosticError
      ? error.code
      : 'WASM_ENUMERATION_FAILED';
    status.textContent = code;
    output.textContent = '';
  } finally {
    button.disabled = false;
    authorizedButton.disabled = false;
    sianoButton.disabled = false;
    lifecycleButton.disabled = false;
    firmwareButton.disabled = false;
    px4GroupingButton.disabled = false;
    px4RuntimeMockButton.disabled = false;
    px4ProtocolButton.disabled = false;
    b25Button.disabled = false;
    sianoQueueButton.disabled = false;
  }
});

authorizedButton.addEventListener('click', async () => {
  if (usb === null) return;
  button.disabled = true;
  authorizedButton.disabled = true;
  sianoButton.disabled = true;
  lifecycleButton.disabled = true;
  firmwareButton.disabled = true;
  px4GroupingButton.disabled = true;
  px4RuntimeMockButton.disabled = true;
  px4ProtocolButton.disabled = true;
  b25Button.disabled = true;
  sianoQueueButton.disabled = true;
  status.textContent = '既許可デバイスを確認中…';
  output.textContent = '';
  try {
    const report = await enumerateAuthorizedDevices(
      usb,
      () => loadGeneratedLibusbModule(selectedModuleUrl()),
    );
    status.textContent = report.authorizedDeviceCount === 0
      ? '既許可デバイス0件（chooserは表示していません）'
      : '既許可デバイスの列挙完了';
    output.textContent = JSON.stringify({
      authorizedDeviceCount: report.authorizedDeviceCount,
      authorizedDevices: report.authorizedDevices,
      authorizedDeviceCountAfter: report.authorizedDeviceCountAfter,
      authorizedDeviceCountDelta: report.authorizedDeviceCountDelta,
      wasmDeviceCount: report.wasmDeviceCount,
      wasmDevices: report.wasmDevices,
      wasmDiagnostic: report.wasmDiagnostic,
      wasmWebUsbDeviceCount: report.wasmWebUsbDeviceCount,
      wasmWebUsbDiagnostic: report.wasmWebUsbDiagnostic,
      wasmExecutionContext: report.wasmExecutionContext,
    }, null, 2);
  } catch (error) {
    const code = error instanceof WasmEnumerationDiagnosticError
      ? error.code
      : 'WASM_ENUMERATION_FAILED';
    status.textContent = code;
    output.textContent = '';
  } finally {
    button.disabled = false;
    authorizedButton.disabled = false;
    sianoButton.disabled = false;
    lifecycleButton.disabled = false;
    firmwareButton.disabled = false;
    px4GroupingButton.disabled = false;
    px4RuntimeMockButton.disabled = false;
    px4ProtocolButton.disabled = false;
    b25Button.disabled = false;
    sianoQueueButton.disabled = false;
  }
});

workerEnumerationButton.addEventListener('click', async () => {
  button.disabled = true;
  authorizedButton.disabled = true;
  workerEnumerationButton.disabled = true;
  sianoButton.disabled = true;
  lifecycleButton.disabled = true;
  firmwareButton.disabled = true;
  px4GroupingButton.disabled = true;
  px4RuntimeMockButton.disabled = true;
  px4ProtocolButton.disabled = true;
  b25Button.disabled = true;
  sianoQueueButton.disabled = true;
  status.textContent = 'Dedicated Worker内で既許可WebUSBを確認中…';
  output.textContent = '';
  try {
    const report = await runDedicatedWorkerEnumeration(selectedModuleUrl());
    status.textContent = `Worker列挙 ${report.diagnostic}`;
    output.textContent = JSON.stringify({
      diagnostic: report.diagnostic,
      workerWebUsbAvailable: report.workerWebUsbAvailable,
      authorizedDeviceCount: report.authorizedDeviceCount,
      authorizedDeviceCountAfter: report.authorizedDeviceCountAfter,
      authorizedDeviceCountDelta: report.authorizedDeviceCountDelta,
      wasmDeviceCount: report.wasmDeviceCount,
      wasmWebUsbDeviceCount: report.wasmWebUsbDeviceCount,
      wasmDiagnostic: report.wasmDiagnostic,
      wasmWebUsbDiagnostic: report.wasmWebUsbDiagnostic,
      wasmExecutionContext: report.wasmExecutionContext,
      note: 'Worker getDevices + official libusb descriptor enumeration only; no claim/bulk/firmware/tune/TS. terminate is not physical cancellation.',
    }, null, 2);
  } catch {
    status.textContent = 'WORKER_ENUMERATION_FAILED';
    output.textContent = '';
  } finally {
    button.disabled = false;
    authorizedButton.disabled = false;
    workerEnumerationButton.disabled = false;
    sianoButton.disabled = false;
    lifecycleButton.disabled = false;
    firmwareButton.disabled = false;
    px4GroupingButton.disabled = false;
    px4RuntimeMockButton.disabled = false;
    px4ProtocolButton.disabled = false;
    b25Button.disabled = false;
    sianoQueueButton.disabled = false;
  }
});

lifecycleButton.addEventListener('click', async () => {
  if (usb === null) return;
  button.disabled = true;
  authorizedButton.disabled = true;
  sianoButton.disabled = true;
  lifecycleButton.disabled = true;
  firmwareButton.disabled = true;
  px4GroupingButton.disabled = true;
  px4RuntimeMockButton.disabled = true;
  px4ProtocolButton.disabled = true;
  b25Button.disabled = true;
  sianoQueueButton.disabled = true;
  status.textContent = 'Siano open→close診断中…（claim/clear-haltを試行）';
  output.textContent = '';
  try {
    const report = await runAuthorizedSianoRioLifecycle(
      usb,
      () => loadGeneratedSianoRioModule(),
    );
    status.textContent = report.lifecycleOpenDiagnostic === 'NONE' &&
      report.lifecycleCloseDiagnostic === 'NONE'
      ? 'Siano open→close完了'
      : `open:${report.lifecycleOpenDiagnostic} close:${report.lifecycleCloseDiagnostic}`;
    output.textContent = JSON.stringify({
      authorizedDeviceCount: report.authorizedDeviceCount,
      supportedDeviceCount: report.supportedDeviceCount,
      diagnostic: report.diagnostic,
      lifecycleOpenDiagnostic: report.lifecycleOpenDiagnostic,
      lifecycleCloseDiagnostic: report.lifecycleCloseDiagnostic,
      note: 'openはinterface claimと両endpoint clear-haltを試行します。upstreamはclear-halt戻り値を無視するため、clear-halt成功とは表示しません。',
    }, null, 2);
  } catch (error) {
    const code = error instanceof WasmEnumerationDiagnosticError
      ? error.code
      : 'WASM_ENUMERATION_FAILED';
    status.textContent = code;
    output.textContent = '';
  } finally {
    button.disabled = false;
    authorizedButton.disabled = false;
    sianoButton.disabled = false;
    lifecycleButton.disabled = false;
    firmwareButton.disabled = false;
    px4GroupingButton.disabled = false;
    px4RuntimeMockButton.disabled = false;
    px4ProtocolButton.disabled = false;
    b25Button.disabled = false;
    sianoQueueButton.disabled = false;
  }
});

firmwareButton.addEventListener('click', () => {
  firmwareInput.value = '';
  firmwareInput.click();
});

firmwareInput.addEventListener('change', async () => {
  const selected = firmwareInput.files?.[0];
  if (!selected) return;
  button.disabled = true;
  authorizedButton.disabled = true;
  sianoButton.disabled = true;
  lifecycleButton.disabled = true;
  firmwareButton.disabled = true;
  px4GroupingButton.disabled = true;
  px4RuntimeMockButton.disabled = true;
  px4ProtocolButton.disabled = true;
  b25Button.disabled = true;
  sianoQueueButton.disabled = true;
  status.textContent = 'ファームウェアをローカル検査中…';
  output.textContent = '';
  try {
    const report = await inspectLocalSianoFirmware(
      selected,
      () => loadGeneratedSianoFirmwareModule(),
    );
    status.textContent = report.diagnostic === 'NONE'
      ? 'SHA-256一致・upstream header/path検査完了（upload未実行）'
      : report.diagnostic;
    output.textContent = JSON.stringify({ diagnostic: report.diagnostic }, null, 2);
  } catch {
    status.textContent = 'FIRMWARE_READ_FAILED';
    output.textContent = '';
  } finally {
    firmwareInput.value = '';
    button.disabled = false;
    authorizedButton.disabled = false;
    sianoButton.disabled = false;
    lifecycleButton.disabled = false;
    firmwareButton.disabled = false;
    px4GroupingButton.disabled = false;
    px4RuntimeMockButton.disabled = false;
    px4ProtocolButton.disabled = false;
    b25Button.disabled = false;
    sianoQueueButton.disabled = false;
  }
});

px4GroupingButton.addEventListener('click', async () => {
  button.disabled = true;
  authorizedButton.disabled = true;
  sianoButton.disabled = true;
  lifecycleButton.disabled = true;
  firmwareButton.disabled = true;
  px4GroupingButton.disabled = true;
  px4RuntimeMockButton.disabled = true;
  px4ProtocolButton.disabled = true;
  b25Button.disabled = true;
  sianoQueueButton.disabled = true;
  status.textContent = 'PX4 synthetic groupingを検査中…';
  output.textContent = '';
  try {
    const report = await runPx4GroupingMockScenario(
      () => loadGeneratedPx4GroupingModule(),
      Number.parseInt(px4ScenarioSelect.value, 10),
    );
    status.textContent = `PX4 mock ${report.diagnostic}`;
    output.textContent = JSON.stringify({
      diagnostic: report.diagnostic,
      candidateCount: report.candidateCount,
      readyGroupCount: report.readyGroupCount,
      incompleteGroupCount: report.incompleteGroupCount,
    }, null, 2);
  } catch {
    status.textContent = 'PX4_GROUPING_FAILED';
    output.textContent = '';
  } finally {
    button.disabled = false;
    authorizedButton.disabled = false;
    sianoButton.disabled = false;
    lifecycleButton.disabled = false;
    firmwareButton.disabled = false;
    px4GroupingButton.disabled = false;
    px4RuntimeMockButton.disabled = false;
    px4ProtocolButton.disabled = false;
    b25Button.disabled = false;
    sianoQueueButton.disabled = false;
  }
});

px4RuntimeMockButton.addEventListener('click', async () => {
  button.disabled = true;
  authorizedButton.disabled = true;
  sianoButton.disabled = true;
  lifecycleButton.disabled = true;
  firmwareButton.disabled = true;
  px4GroupingButton.disabled = true;
  px4RuntimeMockButton.disabled = true;
  px4ProtocolButton.disabled = true;
  b25Button.disabled = true;
  sianoQueueButton.disabled = true;
  status.textContent = 'PX4 synthetic runtime open→closeを検査中…';
  output.textContent = '';
  try {
    const report = await runPx4RuntimeMockOpenClose(
      () => loadGeneratedPx4RuntimeMockModule(),
    );
    status.textContent = `PX4 runtime mock ${report.diagnostic}`;
    output.textContent = JSON.stringify({ diagnostic: report.diagnostic }, null, 2);
  } catch {
    status.textContent = 'PX4_RUNTIME_MOCK_FAILED';
    output.textContent = '';
  } finally {
    button.disabled = false;
    authorizedButton.disabled = false;
    sianoButton.disabled = false;
    lifecycleButton.disabled = false;
    firmwareButton.disabled = false;
    px4GroupingButton.disabled = false;
    px4RuntimeMockButton.disabled = false;
    px4ProtocolButton.disabled = false;
    b25Button.disabled = false;
    sianoQueueButton.disabled = false;
  }
});

px4StreamWorkerButton.addEventListener('click', async () => {
  px4StreamWorkerButton.disabled = true;
  status.textContent = 'PX4 stream lifecycle Workerを検査中…';
  output.textContent = '';
  try {
    const report = await runPx4StreamLifecycleWorker();
    status.textContent = report.diagnostic === 'OK'
      ? 'PX4 stream lifecycle Worker OK（合成のみ）'
      : `PX4 stream lifecycle Worker ${report.diagnostic}`;
    output.textContent = JSON.stringify({
      diagnostic: report.diagnostic,
      attached: report.attached,
      readBytes: report.readBytes,
      packets: report.packets,
      bytes: report.bytes,
      finalTerminal: report.finalTerminal,
      detached: report.detached,
      released: report.released,
      shutdown: report.shutdown,
      note: 'Dedicated Worker + upstream data-plane/synchronized fake only; no USB/WebUSB/serial/firmware/command/tune/real TS.',
    }, null, 2);
  } catch {
    status.textContent = 'PX4_STREAM_WORKER_FAILED';
    output.textContent = '';
  } finally {
    px4StreamWorkerButton.disabled = false;
  }
});

px4ProtocolButton.addEventListener('click', async () => {
  button.disabled = true;
  authorizedButton.disabled = true;
  sianoButton.disabled = true;
  lifecycleButton.disabled = true;
  firmwareButton.disabled = true;
  px4GroupingButton.disabled = true;
  px4RuntimeMockButton.disabled = true;
  px4ProtocolButton.disabled = true;
  b25Button.disabled = true;
  sianoQueueButton.disabled = true;
  status.textContent = 'PX4 IT930x synthetic parserを検査中…';
  output.textContent = '';
  try {
    const report = await runPx4It930xProtocolMock(
      () => loadGeneratedPx4It930xProtocolModule(),
      Number.parseInt(px4ProtocolScenarioSelect.value, 10),
    );
    status.textContent = `PX4 IT930x ${report.diagnostic}`;
    output.textContent = JSON.stringify({
      diagnostic: report.diagnostic,
      note: 'upstream scatter parser only; no CRC/USB command/firmware/TS',
    }, null, 2);
  } catch {
    status.textContent = 'PX4_IT930X_PROTOCOL_FAILED';
    output.textContent = '';
  } finally {
    button.disabled = false;
    authorizedButton.disabled = false;
    sianoButton.disabled = false;
    lifecycleButton.disabled = false;
    firmwareButton.disabled = false;
    px4GroupingButton.disabled = false;
    px4RuntimeMockButton.disabled = false;
    px4ProtocolButton.disabled = false;
    b25Button.disabled = false;
    sianoQueueButton.disabled = false;
  }
});

px4TaggedTsDemuxButton.addEventListener('click', async () => {
  px4TaggedTsDemuxButton.disabled = true;
  status.textContent = 'PX4 tagged TS demux synthetic fixtureを検査中…';
  output.textContent = '';
  try {
    const report = await runPx4TaggedTsDemuxMock(
      () => loadGeneratedPx4TaggedTsDemuxModule(),
      Number.parseInt(px4TaggedTsDemuxScenarioSelect.value, 10),
    );
    status.textContent = `PX4 tagged TS demux ${report.diagnostic}（合成fixtureのみ）`;
    output.textContent = JSON.stringify({
      diagnostic: report.diagnostic,
      inputBytesAccepted: report.inputBytesAccepted,
      emittedPackets: report.emittedPackets,
      discardedSyncSearchBytes: report.discardedSyncSearchBytes,
      invalidTagPackets: report.invalidTagPackets,
      syncLossEvents: report.syncLossEvents,
      bufferedBytes: report.bufferedBytes,
      receiverPacketCounts: report.receiverPacketCounts,
      retryVerified: report.retryVerified,
      resetVerified: report.resetVerified,
      boundaryVerified: report.boundaryVerified,
      packetTagsVerified: report.packetTagsVerified,
      note: 'upstream TaggedTsDemux only; no packet payload/USB/serial/real TS',
    }, null, 2);
  } catch {
    status.textContent = 'PX4_TAGGED_TS_DEMUX_WASM_UNAVAILABLE';
    output.textContent = '';
  } finally {
    px4TaggedTsDemuxButton.disabled = false;
  }
});

b25Button.addEventListener('click', async () => {
  button.disabled = true;
  authorizedButton.disabled = true;
  sianoButton.disabled = true;
  lifecycleButton.disabled = true;
  firmwareButton.disabled = true;
  px4GroupingButton.disabled = true;
  px4RuntimeMockButton.disabled = true;
  px4ProtocolButton.disabled = true;
  b25Button.disabled = true;
  sianoQueueButton.disabled = true;
  status.textContent = 'B25 upstream facade/core smokeを検査中…';
  output.textContent = '';
  try {
    const module = await loadGeneratedB25CoreModule();
    const moduleFactory = () => module;
    const [facade, core] = await Promise.all([
      runB25FacadeNoCardSmoke(moduleFactory),
      runB25CoreNoCardSmoke(moduleFactory),
    ]);
    const diagnostic = facade.diagnostic === 'OK' && core.diagnostic === 'OK'
      ? 'OK'
      : 'INTERNAL';
    status.textContent = `B25 ${diagnostic}（復号未検証）`;
    output.textContent = JSON.stringify({
      diagnostic,
      facadeDiagnostic: facade.diagnostic,
      coreDiagnostic: core.diagnostic,
      note: 'card/keys/TS/PCSC/USB/descrambling not exercised',
    }, null, 2);
  } catch {
    status.textContent = 'B25_WASM_UNAVAILABLE';
    output.textContent = '';
  } finally {
    button.disabled = false;
    authorizedButton.disabled = false;
    sianoButton.disabled = false;
    lifecycleButton.disabled = false;
    firmwareButton.disabled = false;
    px4GroupingButton.disabled = false;
    px4RuntimeMockButton.disabled = false;
    px4ProtocolButton.disabled = false;
    b25Button.disabled = false;
    sianoQueueButton.disabled = false;
  }
});

sianoQueueButton.addEventListener('click', async () => {
  button.disabled = true;
  authorizedButton.disabled = true;
  sianoButton.disabled = true;
  lifecycleButton.disabled = true;
  firmwareButton.disabled = true;
  px4GroupingButton.disabled = true;
  px4RuntimeMockButton.disabled = true;
  px4ProtocolButton.disabled = true;
  b25Button.disabled = true;
  sianoQueueButton.disabled = true;
  status.textContent = 'Siano upstream ts_queue合成fixtureを検査中…（実TS未受信）';
  output.textContent = '';
  try {
    const report = await runSianoTsQueueMock(
      () => loadGeneratedSianoTsQueueModule(),
      Number.parseInt(sianoQueueScenarioSelect.value, 10),
    );
    status.textContent = `Siano TS queue ${report.diagnostic}（実TS未受信）`;
    output.textContent = JSON.stringify({
      diagnostic: report.diagnostic,
      acceptedBytes: report.acceptedBytes,
      dequeuedBytes: report.dequeuedBytes,
      droppedChunks: report.droppedChunks,
      queuedChunks: report.queuedChunks,
      acceptedChunks: report.acceptedChunks,
      fifoVerified: report.fifoVerified,
      reinitialized: report.reinitialized,
      note: 'synthetic queue only; no USB/stream/version/firmware/tune/TS payload',
    }, null, 2);
  } catch {
    status.textContent = 'SIANO_TS_QUEUE_WASM_UNAVAILABLE';
    output.textContent = '';
  } finally {
    button.disabled = false;
    authorizedButton.disabled = false;
    sianoButton.disabled = false;
    lifecycleButton.disabled = false;
    firmwareButton.disabled = false;
    px4GroupingButton.disabled = false;
    px4RuntimeMockButton.disabled = false;
    px4ProtocolButton.disabled = false;
    b25Button.disabled = false;
    sianoQueueButton.disabled = false;
  }
});

sianoLiveStatsButton.addEventListener('click', async () => {
  button.disabled = true;
  authorizedButton.disabled = true;
  sianoButton.disabled = true;
  lifecycleButton.disabled = true;
  firmwareButton.disabled = true;
  px4GroupingButton.disabled = true;
  px4RuntimeMockButton.disabled = true;
  px4ProtocolButton.disabled = true;
  b25Button.disabled = true;
  sianoQueueButton.disabled = true;
  sianoLiveStatsButton.disabled = true;
  status.textContent = 'Siano live stats合成fixtureを検査中…';
  output.textContent = '';
  try {
    const report = await runSianoLiveStatsMock(
      () => loadGeneratedSianoLiveStatsModule(),
      Number.parseInt(sianoLiveStatsScenarioSelect.value, 10),
    );
    status.textContent = `Siano live stats ${report.diagnostic}（合成fixtureのみ）`;
    output.textContent = JSON.stringify({
      diagnostic: report.diagnostic,
      state: report.state,
      generation: report.generation,
      queueMeasured: report.queueMeasured,
      dropsMeasured: report.dropsMeasured,
      transfersMeasured: report.transfersMeasured,
      streamErrorMeasured: report.streamErrorMeasured,
      queueClosed: report.queueClosed,
      queueChunks: report.queueChunks,
      droppedChunks: report.droppedChunks,
      activeTransfers: report.activeTransfers,
      streamError: report.streamError,
      countersSaturated: report.countersSaturated,
      acceptedBytes: report.acceptedBytes,
      dequeuedBytes: report.dequeuedBytes,
      droppedBytes: report.droppedBytes,
      truncatedBytes: report.truncatedBytes,
      transferErrors: report.transferErrors,
      transferErrorsMeaning: 'first stream failure transition count; not all USB errors',
      note: 'synthetic upstream snapshot only; no USB/session/stream/payload',
    }, null, 2);
  } catch {
    status.textContent = 'SIANO_LIVE_STATS_WASM_UNAVAILABLE';
    output.textContent = '';
  } finally {
    button.disabled = false;
    authorizedButton.disabled = false;
    sianoButton.disabled = false;
    lifecycleButton.disabled = false;
    firmwareButton.disabled = false;
    px4GroupingButton.disabled = false;
    px4RuntimeMockButton.disabled = false;
    px4ProtocolButton.disabled = false;
    b25Button.disabled = false;
    sianoQueueButton.disabled = false;
    sianoLiveStatsButton.disabled = false;
  }
});

sianoWorkerButton.addEventListener('click', async () => {
  button.disabled = true;
  authorizedButton.disabled = true;
  workerEnumerationButton.disabled = true;
  sianoButton.disabled = true;
  lifecycleButton.disabled = true;
  firmwareButton.disabled = true;
  px4GroupingButton.disabled = true;
  px4RuntimeMockButton.disabled = true;
  px4ProtocolButton.disabled = true;
  b25Button.disabled = true;
  sianoQueueButton.disabled = true;
  sianoLiveStatsButton.disabled = true;
  sianoWorkerButton.disabled = true;
  const kind = sianoWorkerKindSelect.value as SianoWorkerFixtureKind;
  const scenario = Number.parseInt(sianoWorkerScenarioSelect.value, 10);
  status.textContent = 'Siano WASM Worker合成fixtureを検査中…';
  output.textContent = '';
  try {
    const report = await runSianoWorkerFixture(
      '/build/upstream-wasm/siano-rio-enumeration-browser.js', kind, scenario,
    );
    status.textContent = `Siano Worker ${report.diagnostic}（USBなし）`;
    output.textContent = JSON.stringify({
      diagnostic: report.diagnostic,
      kind: report.kind,
      scenario: report.scenario,
      queue: report.queue,
      liveStats: report.liveStats,
      note: 'Dedicated Worker synthetic ABI only; no open/claim/start/version/firmware/tune/TS/payload',
    }, null, 2);
  } catch {
    status.textContent = 'SIANO_WORKER_WASM_UNAVAILABLE';
    output.textContent = '';
  } finally {
    button.disabled = false;
    authorizedButton.disabled = false;
    workerEnumerationButton.disabled = false;
    sianoButton.disabled = false;
    lifecycleButton.disabled = false;
    firmwareButton.disabled = false;
    px4GroupingButton.disabled = false;
    px4RuntimeMockButton.disabled = false;
    px4ProtocolButton.disabled = false;
    b25Button.disabled = false;
    sianoQueueButton.disabled = false;
    sianoLiveStatsButton.disabled = false;
    sianoWorkerButton.disabled = false;
  }
});

function getWebUsbSource(): WebUsbPermissionSource | null {
  if (typeof navigator === 'undefined' || !('usb' in navigator)) return null;
  const usbApi = (navigator as unknown as {
    usb?: {
      requestDevice(options: { filters: readonly USBDeviceFilter[] }): Promise<{ vendorId: number; productId: number }>;
      getDevices?(): Promise<readonly { vendorId: number; productId: number }[]>;
    };
  }).usb;
  if (!usbApi || typeof usbApi.requestDevice !== 'function') return null;
  return {
    requestDevice: (options) => usbApi.requestDevice(options),
    getDevices: usbApi.getDevices ? () => usbApi.getDevices!() : undefined,
  };
}

function selectedModuleUrl(): string {
  return variantSelect.value === 'nopthread'
    ? NON_PTHREAD_LIBUSB_WASM_MODULE_URL
    : DEFAULT_LIBUSB_WASM_MODULE_URL;
}
