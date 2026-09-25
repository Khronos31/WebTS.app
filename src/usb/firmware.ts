// IT930x ファームウェアを配布サーバから取る。
//
// デプロイ時に scripts/fetch-firmware.mjs がプレクスのドライバから取り出し、
// 上流に検証させて配信物に置く。**ほかの配信物と同じ扱いで、取れなければ
// アプリは動かない。**利用者から受け取る経路は持たない。
//
// ここでは中身を検査しない。受け取った上流の open が FirmwareProvider::load()
// でサイズ・SHA-256・scatter image を検査する。

export const FIRMWARE_URL = '/firmware/it930x-firmware.bin';

export async function loadFirmware(): Promise<Uint8Array> {
  forgetUploadedFirmware();
  const response = await fetch(FIRMWARE_URL);
  // 開発サーバーは、置かれていないパスにも index.html を返すことがある。
  const type = response.headers.get('content-type') ?? '';
  if (!response.ok || type.startsWith('text/html')) {
    throw new Error(
      `配布サーバからファームウェアを取得できませんでした（${FIRMWARE_URL}、HTTP ${response.status}）`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

let forgotten = false;

/**
 * 以前は利用者が渡したドライバから取り出して IndexedDB に置いていた。
 * もう読まないので、残っていれば消す。失敗しても視聴には関係しない。
 */
function forgetUploadedFirmware(): void {
  if (forgotten || typeof indexedDB === 'undefined') return;
  forgotten = true;
  try {
    indexedDB.deleteDatabase('webts-firmware');
  } catch {
    // 消せなくても困らない。
  }
}
