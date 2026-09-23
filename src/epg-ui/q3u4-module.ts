// Q3U4 の WASM モジュール。**視聴と走査で同じ実体を使う。**
//
// C 側はデバイスを開いた状態をセッションとして持ち、受信機ごとの仕事が
// それを共有する。JS 側で `factory.default()` を別々に呼ぶと Emscripten の
// 実体が2つでき、ヒープもグローバルも別になる。セッションが分かれてしまえば
// 同じデバイスを2つの実体が開こうとして失敗する。
//
// そのため、実体の生成はここ1か所に集める。

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
