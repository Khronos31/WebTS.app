import { formatUsbId, loadQ3U4Identifiers, loadIdentityModule } from './px4-identity';
import { groupQ3U4Devices } from './q3u4-grouping';

// 実機の PX-Q3U4 を WebUSB の許可済み集合として見えるようにするページ。
// 表示するのは VID/PID と件数、configuration/interface の構成だけで、
// serial number は読まない・出さない。open、claim、転送は行わない。
//
// 見た目は作り込まない（素の要素のみ）。

const app = document.querySelector('#app');
if (!(app instanceof HTMLElement)) throw new Error('app root missing');

const heading = document.createElement('h1');
heading.textContent = 'PX-Q3U4 列挙';
app.append(heading);

const note = document.createElement('p');
note.textContent =
  'このページは許可の取得と列挙だけを行います。open、claim、転送、firmware、選局、'
  + 'TS 受信は行いません。serial number は読み取りません。';
app.append(note);

const ids = document.createElement('p');
app.append(ids);

const grant = document.createElement('button');
grant.type = 'button';
grant.textContent = 'PX-Q3U4 を許可する（ダイアログが開きます）';
app.append(grant);

const refresh = document.createElement('button');
refresh.type = 'button';
refresh.textContent = '許可済みを再読み込み';
app.append(refresh);

const status = document.createElement('p');
status.setAttribute('role', 'status');
app.append(status);

const list = document.createElement('ol');
app.append(list);

let filters: USBDeviceFilter[] = [];

async function init(): Promise<void> {
  if (!('usb' in navigator)) {
    status.textContent = 'この環境に navigator.usb がありません。';
    grant.disabled = true;
    refresh.disabled = true;
    return;
  }
  try {
    const identifiers = await loadQ3U4Identifiers();
    filters = [{ vendorId: identifiers.vendorId, productId: identifiers.productId }];
    ids.textContent =
      `上流 px4/identity.h の識別子: vendorId ${formatUsbId(identifiers.vendorId)} / `
      + `productId ${formatUsbId(identifiers.productId)}`;
  } catch (error) {
    ids.textContent = `識別子を読めませんでした: ${message(error)}`;
    grant.disabled = true;
    return;
  }
  await show();
}

async function show(): Promise<void> {
  const devices = await navigator.usb.getDevices();
  const matching = devices.filter((device) =>
    filters.some((f) => device.vendorId === f.vendorId && device.productId === f.productId));
  status.textContent =
    `許可済み: 全 ${devices.length} 件、うち PX-Q3U4 として一致 ${matching.length} 件`;
  list.replaceChildren();
  for (const device of matching) {
    const item = document.createElement('li');
    item.textContent =
      `${formatUsbId(device.vendorId)}:${formatUsbId(device.productId)} `
      + `USB ${device.usbVersionMajor}.${device.usbVersionMinor} `
      + `class ${device.deviceClass} `
      + `configurations ${device.configurations.length} `
      + `opened ${device.opened}`;
    list.append(item);
  }
}

grant.addEventListener('click', async () => {
  status.textContent = 'ダイアログで PX-Q3U4 を選んでください…';
  try {
    await navigator.usb.requestDevice({ filters });
  } catch (error) {
    // 選ばずに閉じた場合も NotFoundError になる。握りつぶさず表示する。
    status.textContent = `requestDevice: ${message(error)}`;
    await show();
    return;
  }
  await show();
});

const group = document.createElement('button');
group.type = 'button';
group.textContent = '上流 group_q3u4_devices() に通す';
app.append(group);

const groupOutput = document.createElement('pre');
app.append(groupOutput);

group.addEventListener('click', async () => {
  group.disabled = true;
  groupOutput.textContent = '実行中…';
  try {
    const module = await loadIdentityModule();
    const devices = await navigator.usb.getDevices();
    const matching = devices.filter((device) =>
      filters.some((f) => device.vendorId === f.vendorId && device.productId === f.productId));
    const summary = await groupQ3U4Devices(module, matching);
    groupOutput.textContent = `入力 ${matching.length} 件
` + JSON.stringify(summary, null, 2);
  } catch (error) {
    groupOutput.textContent = `失敗: ${message(error)}`;
  } finally {
    group.disabled = false;
  }
});

refresh.addEventListener('click', () => { void show(); });

function message(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

void init();
