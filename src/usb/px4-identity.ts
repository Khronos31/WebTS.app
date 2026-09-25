// PX4 系の機種の一覧を、同梱した上流 (px4/identity.h, identity.cpp) から取得する。
// TypeScript 側で値を書かないのは、上流が変わったときに黙ってずれるのを防ぐため。
// **機種の表も書き写さない。**上流が機種を足せば、vendor を同期するだけで
// USB の許可の候補にも、許可が足りているかの判定にも入る。

export interface IdentityModule {
  ccall(name: string, returnType: 'number', argTypes: readonly string[], args: readonly number[]): number;
  ccall(name: string, returnType: 'string', argTypes: readonly string[], args: readonly number[]): string;
  _malloc(size: number): number;
  _free(pointer: number): void;
  readonly HEAPU8: Uint8Array;
  readonly HEAP32: Int32Array;
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

/** 上流が知っている PX4 系の機種1つ。 */
export interface Px4Model {
  readonly name: string;
  readonly vendorId: number;
  readonly productId: number;
  /**
   * 1台が USB 上でいくつの機器に見えるか。PX-Q3U4 は内部に IT930x が2個
   * あるので 2（FINDINGS 9章）。選択ダイアログには同じ行がこの数だけ並ぶ。
   */
  readonly usbDevices: number;
  readonly receivers: number;
  /**
   * WebTS で実機を動かして確かめた機種か。**上流の対応とは別。**上流が
   * 対応していても、WebTS で動かしていなければ false。画面で「未確認
   * （報告募集）」を出すのに使う。
   */
  readonly verified: boolean;
}

/**
 * WebTS で実機を動かして確かめた機種の product ID。**確かめたら足す。**
 * 載っていない機種（上流が今後足す機種を含む）は未確認として扱う。
 *
 *   0x084a PX-Q3U4 … Windows・Linux・macOS・Android（docs/COMPATIBILITY.md）
 */
const VERIFIED_IN_WEBTS: ReadonlySet<number> = new Set([0x084a]);

const DEFAULT_MODULE_URL = '/build/px4-identity/px4-identity.mjs';
const MODEL_WORDS = 4;

let cached: Promise<readonly Px4Model[]> | null = null;

/**
 * 生成モジュールを一度だけ読み込み、上流の機種の一覧を返す。
 * 失敗時は握りつぶさず投げる。値を推測して埋めることはしない。
 */
export function loadPx4Models(moduleUrl = DEFAULT_MODULE_URL): Promise<readonly Px4Model[]> {
  cached ??= (async () => {
    const module = await loadIdentityModule(moduleUrl);
    const count = module.ccall('webts_px4_model_count', 'number', [], []);
    if (!Number.isSafeInteger(count) || count <= 0 || count > 64) {
      throw new Error('px4-identity module returned no models');
    }
    const pointer = module._malloc(MODEL_WORDS * 4);
    try {
      const models: Px4Model[] = [];
      for (let index = 0; index < count; index += 1) {
        const error = module.ccall('webts_px4_model', 'number',
          ['number', 'number', 'number'], [index, pointer, MODEL_WORDS]);
        const words = module.HEAP32.subarray(pointer / 4, pointer / 4 + MODEL_WORDS);
        const [vendorId = 0, productId = 0, usbDevices = 0, receivers = 0] = words;
        const name = module.ccall('webts_px4_model_name', 'string', ['number'], [index]);
        if (error !== 0 || !isUsbId(vendorId) || !isUsbId(productId)
          || usbDevices < 1 || receivers < 1 || name === '') {
          throw new Error('px4-identity module returned an out-of-range model');
        }
        models.push(Object.freeze({
          name, vendorId, productId, usbDevices, receivers,
          verified: VERIFIED_IN_WEBTS.has(productId),
        }));
      }
      return Object.freeze(models);
    } finally {
      module._free(pointer);
    }
  })();
  return cached;
}

function isUsbId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 0xffff;
}

/** `requestDevice()` の候補。上流が知っている全機種。 */
export function usbFilters(models: readonly Px4Model[]): { vendorId: number; productId: number }[] {
  return models.map(({ vendorId, productId }) => ({ vendorId, productId }));
}

/** 許可済みの USB 機器から見た、チューナーの準備の具合。 */
export interface TunerPermission {
  /** 準備ができた機種。無ければ、許可が途中の機種。どちらも無ければ null。 */
  readonly model: Px4Model | null;
  /** その機種で許可されている USB 機器の数。 */
  readonly granted: number;
  /** 1台ぶんに要る USB 機器の数。 */
  readonly required: number;
  readonly ready: boolean;
}

/**
 * 許可済みの USB 機器から、使える筐体があるかを判定する。
 *
 * 機種ごとに数え、1台ぶんの USB 機器（PX-Q3U4 は2つ）がそろっている機種が
 * あれば準備ができている。そろっている機種が無ければ、許可が途中の機種を
 * 返す（何が足りないかを言うため）。**どの機器が同じ筐体かまでは見ない。**
 * それは開くときに上流が確かめる（identity.cpp の grouping）。
 */
export function evaluateTunerPermission(
  models: readonly Px4Model[],
  devices: readonly { vendorId: number; productId: number }[],
): TunerPermission {
  let partial: TunerPermission | null = null;
  for (const model of models) {
    const granted = devices.filter((device) => device.vendorId === model.vendorId
      && device.productId === model.productId).length;
    if (granted >= model.usbDevices) {
      return { model, granted, required: model.usbDevices, ready: true };
    }
    if (granted > 0 && partial === null) {
      partial = { model, granted, required: model.usbDevices, ready: false };
    }
  }
  return partial ?? { model: null, granted: 0, required: 0, ready: false };
}

/** 許可済みの USB 機器を読んで判定する。プロンプトは出ない。 */
export async function readTunerPermission(): Promise<TunerPermission> {
  const [models, devices] = await Promise.all([loadPx4Models(), navigator.usb.getDevices()]);
  return evaluateTunerPermission(models, devices);
}

/** テスト用。モジュールを読み直させる。 */
export function resetPx4ModelCache(): void {
  cached = null;
  moduleCache = null;
}

export function formatUsbId(value: number): string {
  return `0x${value.toString(16).padStart(4, '0')}`;
}
