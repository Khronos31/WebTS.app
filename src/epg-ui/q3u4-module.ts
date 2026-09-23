// Q3U4 の WASM モジュール。**視聴と走査で同じ実体を使う。**
//
// C 側はデバイスを開いた状態をセッションとして持ち、受信機ごとの仕事が
// それを共有する。JS 側で `factory.default()` を別々に呼ぶと Emscripten の
// 実体が2つでき、ヒープもグローバルも別になる。セッションが分かれてしまえば
// 同じデバイスを2つの実体が開こうとして失敗する。
//
// そのため、実体の生成はここ1か所に集める。

import { loadQ3U4Identifiers } from '../usb/px4-identity';

const MODULE_URL = '/build/q3u4-descramble/q3u4-descramble.mjs';

export interface Q3U4Module {
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

let modulePromise: Promise<Q3U4Module> | null = null;

export async function loadQ3U4Module(): Promise<Q3U4Module> {
  modulePromise ??= (async () => {
    const factory = (await import(/* @vite-ignore */ MODULE_URL)) as {
      default: () => Promise<Q3U4Module>;
    };
    return factory.default();
  })();
  return modulePromise;
}

/**
 * セッションを開いたままにするか。
 *
 * 視聴が終わってもデバイスを閉じない状態にしておくと、続けて走査を始める
 * ときに初期化をやり直さずに済む。逆に、誰も使わなくなったら畳みたい。
 */
export function keepSessionOpen(module: Q3U4Module, keep: boolean): void {
  module.ccall('webts_q3u4_session_keep_open', null, ['number'], [keep ? 1 : 0]);
}

/**
 * 受信機を使い始める前の確認。
 *
 * **PX-Q3U4 は USB 機器2つとして列挙される**（内部に IT930x が2個ある。
 * FINDINGS 9章）。ブラウザの選択ダイアログには同じに見える行が2つ並び、
 * 一度では片方しか許可できない。片方だけだと C 側は NOT_FOUND を返すが、
 * その番号を見せられても何をすればいいか分からない。ここで止めて、
 * 何が足りないかを言う。
 */
export async function ensureTunerAvailable(): Promise<void> {
  if (typeof navigator === 'undefined' || !('usb' in navigator)) {
    throw new Error('この環境では WebUSB が使えません。'
      + 'Chromium 系のブラウザで、HTTPS か localhost から開いてください。');
  }
  const identifiers = await loadQ3U4Identifiers();
  const devices = await navigator.usb.getDevices();
  const matching = devices.filter((device) => device.vendorId === identifiers.vendorId
    && device.productId === identifiers.productId);
  if (matching.length >= 2) return;
  throw new Error(matching.length === 0
    ? 'PX-Q3U4 が許可されていません。設定の「チューナーを接続」から許可してください。'
    : 'PX-Q3U4 の許可が1台ぶんしかありません。この機種は USB 機器2つとして見え、'
      + '選択ダイアログには同じ行が2つ並びます。設定からもう一度接続して、'
      + 'もう片方も許可してください。');
}
