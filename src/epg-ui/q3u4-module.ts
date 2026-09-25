// Q3U4 の WASM モジュール。**視聴と走査で同じ実体を使う。**
//
// C 側はデバイスを開いた状態をセッションとして持ち、受信機ごとの仕事が
// それを共有する。JS 側で `factory.default()` を別々に呼ぶと Emscripten の
// 実体が2つでき、ヒープもグローバルも別になる。セッションが分かれてしまえば
// 同じデバイスを2つの実体が開こうとして失敗する。
//
// そのため、実体の生成はここ1か所に集める。

import { readTunerPermission } from '../usb/px4-identity';

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
 * **機種によっては1台が USB 機器いくつかとして列挙される。**PX-Q3U4 は
 * 内部に IT930x が2個あり、2つに見える（FINDINGS 9章）。ブラウザの選択
 * ダイアログには同じに見える行が2つ並び、一度では片方しか許可できない。
 * 片方だけだと C 側は NOT_FOUND を返すが、その番号を見せられても何を
 * すればいいか分からない。ここで止めて、何が足りないかを言う。
 * 何台要るかは上流の機種の表が答える（px4-identity.ts）。
 */
export async function ensureTunerAvailable(): Promise<void> {
  if (typeof navigator === 'undefined' || !('usb' in navigator)) {
    throw new Error('この環境では WebUSB が使えません。'
      + 'Chromium 系のブラウザで、HTTPS か localhost から開いてください。');
  }
  const permission = await readTunerPermission();
  if (permission.ready) return;
  if (permission.model === null) {
    throw new Error('チューナーが許可されていません。設定の「チューナーを接続」から許可してください。');
  }
  const { model, granted, required } = permission;
  throw new Error(`${model.name} の許可が ${granted} 台ぶんしかありません。`
    + `この機種は USB 機器 ${required} つとして見え、選択ダイアログには同じ行が`
    + ` ${required} つ並びます。設定からもう一度接続して、残りも許可してください。`);
}
