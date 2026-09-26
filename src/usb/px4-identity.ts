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
  /** 使うチューナーの機種。無ければ、許可が途中の機種。どちらも無ければ null。 */
  readonly model: Px4Model | null;
  /** その筐体で許可されている USB 機器の数。 */
  readonly granted: number;
  /** 1台ぶんに要る USB 機器の数。 */
  readonly required: number;
  readonly ready: boolean;
}

// ---- 接続済みのチューナー ------------------------------------------------
//
// 許可されていて、いまつながっている USB 機器を、筐体ごとにまとめる。
// PX-Q3U4 は1台が USB 機器2つに見えるが、一覧では1行になる。
//
// **筐体は上流の規則で見分ける。**USB 機器の serial から上流が作る識別子
// （base serial）を px4-identity の webts_px4_tuner_key で得る。規則は
// 書き写さない。
//
// 識別子は、選んだ1台を覚えておくためにだけ使う。**端末内（localStorage）に
// 保存するだけで、表示も送信もしない。**画面では機種名で呼び、同じ機種が
// 複数あれば「1台目」「2台目」と数える（作者の決定、2026-09-26）。

/** 接続済みのチューナー1台（筐体1つ）。 */
export interface ConnectedTuner {
  /** 筐体の識別子。**表示も送信もしない。**上流が読めない serial なら null。 */
  readonly key: string | null;
  readonly model: Px4Model;
  /** 画面に出す名前。同じ機種が複数あれば「PX-Q3U4（2台目）」のように数える。 */
  readonly label: string;
  /** その筐体で許可されている USB 機器の数。 */
  readonly granted: number;
  /** 1台ぶんに要る USB 機器の数。 */
  readonly required: number;
  /** USB 機器がそろい、開ける状態か。 */
  readonly ready: boolean;
  /** 視聴と走査がこの1台を使うか。ready のものから1つだけ。 */
  readonly selected: boolean;
}

/** まとめる対象の USB 機器と、その筐体の識別子。 */
export interface KeyedDevice {
  readonly vendorId: number;
  readonly productId: number;
  readonly key: string | null;
}

/**
 * USB 機器を筐体ごとにまとめ、使う1台を決める。
 *
 * 使うのは、保存された選択が開ける状態ならそれ、そうでなければ開ける
 * もののうち一覧の先頭。並びは上流の機種の表の順、同じ機種の中は識別子の順
 * （抜き差ししても変わらない）。
 */
export function groupTuners(
  models: readonly Px4Model[],
  devices: readonly KeyedDevice[],
  storedKey: string | null,
): ConnectedTuner[] {
  interface Draft { key: string | null; model: Px4Model; modelIndex: number; granted: number }
  const drafts: Draft[] = [];
  for (const device of devices) {
    const modelIndex = models.findIndex((model) => model.vendorId === device.vendorId
      && model.productId === device.productId);
    const model = models[modelIndex];
    if (model === undefined) continue;
    // 識別子が読めない機器は、ほかとまとめずに1行ずつにする（開けない）。
    const existing = device.key === null ? undefined
      : drafts.find((draft) => draft.key === device.key && draft.model === model);
    if (existing !== undefined) existing.granted += 1;
    else drafts.push({ key: device.key, model, modelIndex, granted: 1 });
  }
  const order = (key: string | null) => key ?? '￿';
  drafts.sort((left, right) => left.modelIndex - right.modelIndex
    || order(left.key).localeCompare(order(right.key)));

  const ready = (draft: Draft) => draft.key !== null && draft.granted >= draft.model.usbDevices;
  const chosen = drafts.find((draft) => ready(draft) && draft.key === storedKey)
    ?? drafts.find(ready);

  return drafts.map((draft) => {
    const siblings = drafts.filter((other) => other.model === draft.model);
    const label = siblings.length > 1
      ? `${draft.model.name}（${siblings.indexOf(draft) + 1}台目）`
      : draft.model.name;
    return Object.freeze({
      key: draft.key,
      model: draft.model,
      label,
      granted: draft.granted,
      required: draft.model.usbDevices,
      ready: ready(draft),
      selected: draft === chosen,
    });
  });
}

const SELECTED_TUNER_KEY = 'webts-selected-tuner';
const KEY_CAPACITY = 64;

type TunerListener = () => void;
const tunerListeners = new Set<TunerListener>();

function storedTunerKey(): string | null {
  try {
    return localStorage.getItem(SELECTED_TUNER_KEY);
  } catch {
    return null;
  }
}

function notifyTuners(): void {
  for (const listener of tunerListeners) listener();
}

/** USB 機器1つの筐体の識別子。上流が読めなければ null。 */
async function tunerKeyOf(device: USBDevice): Promise<string | null> {
  const serial = device.serialNumber;
  if (serial === undefined || serial === null || serial === '') return null;
  const module = await loadIdentityModule();
  const encoded = new TextEncoder().encode(`${serial}\0`);
  const input = module._malloc(encoded.length);
  const output = module._malloc(KEY_CAPACITY);
  try {
    module.HEAPU8.set(encoded, input);
    const error = module.ccall('webts_px4_tuner_key', 'number',
      ['number', 'number', 'number', 'number', 'number'],
      [device.vendorId, device.productId, input, output, KEY_CAPACITY]);
    if (error !== 0) return null;
    const end = module.HEAPU8.indexOf(0, output);
    return new TextDecoder().decode(module.HEAPU8.slice(output, end < 0 ? output : end));
  } finally {
    // serial と識別子をヒープに残さない。
    module.HEAPU8.fill(0, input, input + encoded.length);
    module.HEAPU8.fill(0, output, output + KEY_CAPACITY);
    module._free(input);
    module._free(output);
  }
}

async function keyedDevices(): Promise<{ device: USBDevice; key: string | null }[]> {
  const devices = await navigator.usb.getDevices();
  return Promise.all(devices.map(async (device) => ({ device, key: await tunerKeyOf(device) })));
}

/**
 * 接続済みのチューナーの一覧。**プロンプトは出ない。**許可されていて、
 * いまつながっている機器だけが対象（`navigator.usb.getDevices()`）。
 */
export async function listConnectedTuners(): Promise<ConnectedTuner[]> {
  const [models, devices] = await Promise.all([loadPx4Models(), keyedDevices()]);
  return groupTuners(models,
    devices.map(({ device, key }) => ({ vendorId: device.vendorId, productId: device.productId, key })),
    storedTunerKey());
}

/** 視聴と走査が使う1台。開けるものが無ければ null。 */
export async function selectedTuner(): Promise<ConnectedTuner | null> {
  return (await listConnectedTuners()).find((tuner) => tuner.selected) ?? null;
}

/**
 * 使う1台を選ぶ。**次に受信機を開くときから効く。**視聴か走査が別の1台を
 * 使っている最中は、それが終わるまで替わらない（C 側が BUSY を返す）。
 */
export function selectTuner(tuner: ConnectedTuner): void {
  if (tuner.key === null || !tuner.ready) return;
  try {
    localStorage.setItem(SELECTED_TUNER_KEY, tuner.key);
  } catch {
    // 覚えられなくても、今回は一覧の先頭を使うだけ。
  }
  notifyTuners();
}

/**
 * このチューナーの許可を取り消す（`USBDevice.forget()`）。PX-Q3U4 なら
 * 2つの機器とも取り消す。録画ソフトなどに渡したい機器をブラウザから外す
 * ために使う。
 */
export async function forgetTuner(tuner: ConnectedTuner): Promise<void> {
  for (const { device, key } of await keyedDevices()) {
    const sameModel = device.vendorId === tuner.model.vendorId
      && device.productId === tuner.model.productId;
    if (sameModel && key === tuner.key) await device.forget();
  }
  if (tuner.key !== null && tuner.key === storedTunerKey()) {
    try {
      localStorage.removeItem(SELECTED_TUNER_KEY);
    } catch {
      // 消せなくても、開けない選択は使われない。
    }
  }
  notifyTuners();
}

let usbEventsInstalled = false;

/** 一覧が変わったら呼ぶ（抜き差し、許可、選択、取り消し）。戻り値で購読をやめる。 */
export function subscribeTuners(listener: TunerListener): () => void {
  if (!usbEventsInstalled && typeof navigator !== 'undefined' && 'usb' in navigator) {
    usbEventsInstalled = true;
    navigator.usb.addEventListener('connect', notifyTuners);
    navigator.usb.addEventListener('disconnect', notifyTuners);
  }
  tunerListeners.add(listener);
  return () => { tunerListeners.delete(listener); };
}

/** 許可を求めたあとなど、画面の外で一覧が変わったことを知らせる。 */
export function tunersChanged(): void {
  notifyTuners();
}

/**
 * 許可済みの USB 機器を読んで、使う1台の準備の具合を返す。プロンプトは出ない。
 * 使える1台があればその機種、無ければ許可が途中の機種を返す（何が足りない
 * かを言うため）。
 */
export async function readTunerPermission(): Promise<TunerPermission> {
  const tuners = await listConnectedTuners();
  const chosen = tuners.find((tuner) => tuner.selected);
  if (chosen !== undefined) {
    return { model: chosen.model, granted: chosen.granted, required: chosen.required, ready: true };
  }
  const partial = tuners[0];
  return partial === undefined
    ? { model: null, granted: 0, required: 0, ready: false }
    : { model: partial.model, granted: partial.granted, required: partial.required, ready: false };
}

/** テスト用。モジュールを読み直させる。 */
export function resetPx4ModelCache(): void {
  cached = null;
  moduleCache = null;
}

export function formatUsbId(value: number): string {
  return `0x${value.toString(16).padStart(4, '0')}`;
}
