import {
  runPx4StreamLifecycleWorker,
} from './px4-stream-lifecycle-worker-diagnostic';

const app = document.querySelector('#app');
if (!(app instanceof HTMLElement)) throw new Error('fixture root missing');

const heading = document.createElement('h1');
heading.textContent = 'PX4 Q3U4 stream lifecycle Worker fixture';
app.appendChild(heading);

const notice = document.createElement('p');
notice.textContent = '合成Transport＋upstream data-planeのみ。USB、WebUSB、serial、firmware、command、tune、実TSは使用しません。';
app.appendChild(notice);

const button = document.createElement('button');
button.type = 'button';
button.textContent = 'Dedicated Workerで実行（合成fixtureのみ）';
app.appendChild(button);

const status = document.createElement('p');
status.setAttribute('role', 'status');
status.textContent = '未実行';
app.appendChild(status);

const output = document.createElement('pre');
app.appendChild(output);

const moduleUrl = '/build/upstream-wasm/px4-stream-lifecycle-worker-browser.js';
const timeoutMs = 15_000;

button.addEventListener('click', async () => {
  button.disabled = true;
  status.textContent = 'Worker実行中…';
  output.textContent = '';
  const report = await runPx4StreamLifecycleWorker(moduleUrl, timeoutMs);
  status.textContent = report.diagnostic === 'OK'
    ? 'PX4 Worker fixture OK（合成のみ）'
    : `PX4 Worker fixture ${report.diagnostic}`;
  output.textContent = JSON.stringify(report, null, 2);
  button.disabled = false;
});
