import {
  LIBUSB_OWNERSHIP_SCENARIOS,
  LIBUSB_OWNERSHIP_VARIANTS,
  runLibusbOwnershipWorker,
  type LibusbOwnershipReport,
  type LibusbOwnershipVariant,
} from './libusb-ownership-diagnostic';

// Test-only page. It is not a Vite production input, so it never reaches dist/.
// Everything runs against a fake navigator.usb inside an isolated Worker.

const app = document.querySelector('#app');
if (!(app instanceof HTMLElement)) throw new Error('fixture root missing');

const heading = document.createElement('h1');
heading.textContent = 'libusb transfer ownership regression';
app.append(heading);

const notice = document.createElement('p');
notice.textContent =
  '公式libusb core＋WebUSB backendを fake navigator.usb だけで実行します。実USB、' +
  'requestDevice、firmware、mode、tune、TS、B25 は使用しません。1 Worker = 1 scenario で、' +
  '実行後にWorkerをterminateします。先に npm run build:libusb-browser が必要です。';
app.append(notice);

const isolation = document.createElement('p');
isolation.textContent = `crossOriginIsolated: ${globalThis.crossOriginIsolated}`;
app.append(isolation);

const button = document.createElement('button');
button.type = 'button';
button.textContent = '全 variant × 全 scenario を実行';
app.append(button);

const status = document.createElement('p');
status.setAttribute('role', 'status');
status.textContent = '未実行';
app.append(status);

const output = document.createElement('pre');
app.append(output);

type Row = { scenario: number; name: string } & Record<string, unknown>;

async function runAll(): Promise<Row[]> {
  const rows: Row[] = [];
  for (let index = 0; index < LIBUSB_OWNERSHIP_SCENARIOS.length; index += 1) {
    const row: Row = { scenario: index, name: LIBUSB_OWNERSHIP_SCENARIOS[index] ?? '?' };
    for (const variant of LIBUSB_OWNERSHIP_VARIANTS) {
      status.textContent = `scenario ${index} / ${variant} 実行中…`;
      const report: LibusbOwnershipReport = await runLibusbOwnershipWorker(index, variant);
      row[variant] = report.diagnostic;
      if (variant === 'patched') row.patchedReport = report;
    }
    rows.push(row);
    output.textContent = format(rows);
  }
  return rows;
}

function format(rows: readonly Row[]): string {
  const width = Math.max(...LIBUSB_OWNERSHIP_SCENARIOS.map((name) => name.length));
  const head = `${'scenario'.padEnd(width + 4)}${LIBUSB_OWNERSHIP_VARIANTS.map((v) => v.padEnd(16)).join('')}`;
  const body = rows.map((row) =>
    `${String(row.scenario).padStart(2)} ${String(row.name).padEnd(width)} ` +
    LIBUSB_OWNERSHIP_VARIANTS.map((v) => String(row[v] ?? '-').padEnd(16)).join(''));
  return [head, ...body].join('\n');
}

button.addEventListener('click', async () => {
  button.disabled = true;
  output.textContent = '';
  try {
    const rows = await runAll();
    (globalThis as unknown as { __rows?: Row[] }).__rows = rows;
    status.textContent = `完了（${rows.length} scenario × ${LIBUSB_OWNERSHIP_VARIANTS.length} variant）`;
  } catch (error) {
    status.textContent = 'FAILED';
    output.textContent = String(error instanceof Error ? error.message : error);
  } finally {
    button.disabled = false;
  }
});
