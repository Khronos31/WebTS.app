// PX-Q3U4 の USB 識別子を、同梱した上流 (px4/identity.h) から取得する。
// TypeScript 側で値を書かないのは、上流が変わったときに黙ってずれるのを防ぐため。

export interface IdentityModule {
  ccall(name: string, returnType: 'number', argTypes: readonly string[], args: readonly number[]): number;
  _malloc(size: number): number;
  _free(pointer: number): void;
  readonly HEAPU8: Uint8Array;
}

let moduleCache: Promise<IdentityModule> | null = null;

/** 生成モジュールを一度だけ読み込む。識別子取得と grouping で共有する。 */
export function loadIdentityModule(moduleUrl = DEFAULT_MODULE_URL): Promise<IdentityModule> {
  moduleCache ??= (async () => {
    const imported = (await import(/* @vite-ignore */ moduleUrl)) as { default?: unknown };
    if (typeof imported.default !== 'function') {
      throw new Error('px4-identity module did not export a factory');
    }
    return (imported.default as () => Promise<IdentityModule>)();
  })();
  return moduleCache;
}

export interface Q3U4Identifiers {
  readonly vendorId: number;
  readonly productId: number;
}

const DEFAULT_MODULE_URL = '/build/px4-identity/px4-identity.mjs';

let cached: Promise<Q3U4Identifiers> | null = null;

/**
 * 生成モジュールを一度だけ読み込み、上流の定数を返す。
 * 失敗時は握りつぶさず投げる。値を推測して埋めることはしない。
 */
export function loadQ3U4Identifiers(moduleUrl = DEFAULT_MODULE_URL): Promise<Q3U4Identifiers> {
  cached ??= (async () => {
    const module = await loadIdentityModule(moduleUrl);
    const vendorId = module.ccall('webts_px4_q3u4_vendor_id', 'number', [], []);
    const productId = module.ccall('webts_px4_q3u4_product_id', 'number', [], []);
    if (!isUsbId(vendorId) || !isUsbId(productId)) {
      throw new Error('px4-identity module returned an out-of-range identifier');
    }
    return Object.freeze({ vendorId, productId });
  })();
  return cached;
}

function isUsbId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 0xffff;
}

/** テスト用。モジュールを読み直させる。 */
export function resetQ3U4IdentifierCache(): void {
  cached = null;
  moduleCache = null;
}

export function formatUsbId(value: number): string {
  return `0x${value.toString(16).padStart(4, '0')}`;
}
