// IT930x ファームウェアをプレクスのドライバから取り出し、配信物に置く。
//
// **リポジトリには入れない。**デプロイのたびにここで取得し、public/firmware/
// に書く（.gitignore 済み）。Vite がそれを dist/ へ写す。
//
// どこか1つでも合わなければ失敗させる。ZIP と .sys は固定の SHA-256 と一致し、
// 取り出した 2169 バイトは上流の FirmwareProvider::load() が受理しなければ
// ならない。検証はブラウザで使っていたものと同じ src/usb/firmware-extract.ts。
//
// build/px4-identity を先にビルドしておくこと（npm run build:px4-identity）。
//
//   npm run firmware                          プレクスから取得する
//   WEBTS_DRIVER_ZIP=<zip> npm run firmware   手元の ZIP を使う（開発機向け）

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FIRMWARE_SOURCE, extractFirmware } from '../src/usb/firmware-extract.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modulePath = join(root, 'build', 'px4-identity', 'px4-identity.mjs');
const output = join(root, 'public', 'firmware', 'it930x-firmware.bin');

function fail(message) {
  process.stderr.write(`fetch-firmware: ${message}\n`);
  process.exit(1);
}

if (!existsSync(modulePath)) {
  fail(`${modulePath} がありません。先に npm run build:px4-identity を実行してください。`);
}

let archive;
const local = process.env.WEBTS_DRIVER_ZIP;
if (local) {
  archive = new Uint8Array(readFileSync(local));
  process.stdout.write(`read ${local}\n`);
} else {
  const response = await fetch(FIRMWARE_SOURCE.archiveUrl);
  if (!response.ok) fail(`${FIRMWARE_SOURCE.archiveUrl}: HTTP ${response.status}`);
  archive = new Uint8Array(await response.arrayBuffer());
  process.stdout.write(`fetched ${FIRMWARE_SOURCE.archiveUrl}\n`);
}

const factory = (await import(pathToFileURL(modulePath).href)).default;
const module = await factory();

let result;
try {
  result = await extractFirmware(archive, module);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

// 走査で見つかっただけでは足りない。固定した配布物そのものであること。
if (!result.archiveMatchedPin) fail('ZIP が固定の SHA-256 と一致しません');
if (!result.sysMatchedPin) fail('.sys が固定の SHA-256 と一致しません');

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, result.bytes);
process.stdout.write(`wrote ${output} (${result.bytes.length} bytes, offset 0x${result.offset.toString(16)})\n`);
