import { runLibusbCancelWorker } from './libusb-cancel-worker-diagnostic';
import { runLibusbCancelSettleWorker } from './libusb-cancel-settle-worker-diagnostic';
import { runLibusbEventSmokeWorker } from './libusb-cancel-event-worker-diagnostic';
import { runLibusbUserFreeWorker } from './libusb-cancel-user-free-worker-diagnostic';
import { runLibusbPendingCloseWorker } from './libusb-pending-close-worker-diagnostic';

const app = document.querySelector('#app');
if (!(app instanceof HTMLElement)) throw new Error('fixture root missing');
const heading = document.createElement('h1');
heading.textContent = 'libusb WebUSB pending-cancel Worker fixture';
app.appendChild(heading);
const notice = document.createElement('p');
notice.textContent = '公式libusb backend＋fake navigator.usbのみ。実USB、requestDevice、firmware、tune、TSは使用しません。';
app.appendChild(notice);
const button = document.createElement('button');
button.type = 'button';
button.textContent = 'Dedicated Workerで実行（USBなし）';
app.appendChild(button);
const scenario = document.createElement('select');
scenario.setAttribute('aria-label', 'libusb cancellation scenario');
scenario.innerHTML = '<option value="pending">cancel→pending（1 task turn）</option><option value="settle">cancel→resolve→CANCELLED callback</option><option value="event">zero-timeout event API smoke（USBなし）</option><option value="event-fast">zero-timeout fast-path実験（別build）</option><option value="settle-fast">settle fast-path実験（event-fast成功後のみ）</option><option value="user-free-fast">callback内transfer free実験（Node成功後のみ）</option><option value="pending-close-stock">pending中libusb_close（stock Worker）</option><option value="pending-close-fast">pending中libusb_close実験（fast-path Worker）</option>';
app.appendChild(scenario);
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
  const selectedScenario = scenario.value === 'settle' || scenario.value === 'event' || scenario.value === 'event-fast' || scenario.value === 'settle-fast' || scenario.value === 'user-free-fast' || scenario.value === 'pending-close-stock' || scenario.value === 'pending-close-fast' ? scenario.value : 'pending';
  const fastModuleUrl = '/build/libusb-webusb-cancel-worker-zero-fastpath/libusb-webusb-cancel-worker-zero-fastpath-browser.js';
  const stockModuleUrl = '/build/libusb-webusb-cancel-worker/libusb-webusb-cancel-worker-browser.js';
  const report = selectedScenario === 'pending-close-stock'
    ? await runLibusbPendingCloseWorker(stockModuleUrl)
    : selectedScenario === 'pending-close-fast'
    ? await runLibusbPendingCloseWorker(fastModuleUrl)
    : selectedScenario === 'user-free-fast'
    ? await runLibusbUserFreeWorker()
    : selectedScenario === 'settle' || selectedScenario === 'settle-fast'
    ? await runLibusbCancelSettleWorker(selectedScenario === 'settle-fast' ? fastModuleUrl : undefined)
    : selectedScenario === 'event' || selectedScenario === 'event-fast'
      ? await runLibusbEventSmokeWorker(selectedScenario === 'event-fast' ? fastModuleUrl : undefined)
      : await runLibusbCancelWorker();
  status.textContent = `libusb cancel Worker ${report.diagnostic}（合成のみ）`;
  const outputReport: Record<string, unknown> = { ...report };
  if (report.diagnostic !== 'TIMEOUT') delete outputReport.stage;
  outputReport.note = selectedScenario === 'pending-close-stock' || selectedScenario === 'pending-close-fast'
    ? `${selectedScenario === 'pending-close-stock' ? '公式stock events_posix Worker' : 'zero-timeout fast-path Worker'}。Node source-bound成功後のみの実験。pending transfer中にlibusb_closeが復帰するかだけを観測し、Promise解決・transfer free・context exitは行わない。physical abort/安全な解放は未証明。`
    : selectedScenario === 'user-free-fast'
    ? 'Node source-bound成功後のみの実験。callback内でtransferを同期freeし、event API復帰後にhandle/contextをcleanupする。late Promise/physical abort/UAFは未検証。'
    : selectedScenario === 'settle' || selectedScenario === 'settle-fast'
    ? selectedScenario === 'settle-fast'
      ? 'ignored build copyのevents_posix.cだけにzero-timeout fast pathを加えたsettle実験。event-fast成功後のみ実行し、physical abort/stop/join boundednessは未証明。'
      : 'C++ asserted fake transferIn call count is 1; fake Promise resolve後にboundedなevent処理を試行。Physical WebUSB abort and stop/join boundedness are unproven.'
    : selectedScenario === 'event' || selectedScenario === 'event-fast'
      ? selectedScenario === 'event-fast'
        ? 'ignored build copyのevents_posix.cだけにzero-timeout fast pathを加えた実験。vendor/production/physical abortは変更・検証しない。'
        : '公式libusb event APIのzero-timeout呼出しだけを検査。デバイス列挙・transfer・physical abortは行わない。'
      : 'C++ asserted fake transferIn call count is 1; one bounded task turn only. Physical WebUSB abort and stop/join boundedness are unproven.';
  output.textContent = JSON.stringify(outputReport, null, 2);
  button.disabled = false;
});
