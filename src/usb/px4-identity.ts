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
   * LNB へ 15V を出せる機種か。上流の機種の表が答える。出せない機種では、
   * 給電を許していても 0V で受ける（PX-M1UR など）。
   */
  readonly lnb15v: boolean;
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
 *   0x0854 PX-M1UR … Windows（上流 v0.1.9。地上波・BS の視聴、15V 非対応で
 *                     給電オンでも 0V で BS が映る、2026-10-02〜03。走査は 0.3.2 で）
 *   0x0855 PX-S1UR … Windows（上流 v0.1.9。地上波の視聴、2026-10-02〜03）
 *   M1UR と S1UR は serial が重なる個体があり、両方挿して選び分けて視聴できた。
 */
const VERIFIED_IN_WEBTS: ReadonlySet<number> = new Set([0x084a, 0x0854, 0x0855]);

const DEFAULT_MODULE_URL = '/build/px4-identity/px4-identity.mjs';
const MODEL_WORDS = 5;

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
        const [vendorId = 0, productId = 0, usbDevices = 0, receivers = 0, lnb = -1] = words;
        const name = module.ccall('webts_px4_model_name', 'string', ['number'], [index]);
        if (error !== 0 || !isUsbId(vendorId) || !isUsbId(productId)
          || usbDevices < 1 || receivers < 1 || (lnb !== 0 && lnb !== 1) || name === '') {
          throw new Error('px4-identity module returned an out-of-range model');
        }
        models.push(Object.freeze({
          name, vendorId, productId, usbDevices, receivers,
          lnb15v: lnb === 1,
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
  /**
   * いまつながっているあいだだけの、この1台の呼び名（USB 機器のアドレスを
   * 並べたもの）。serial が同じ筐体を見分けるのに使う。**抜き差しで変わる。**
   * アドレスが読めない機器を含むなら空文字。
   */
  readonly id: string;
  /**
   * C 側へ渡す USB 機器の位置（上流の書式 "1:<アドレス>"）。**serial が同じ
   * 筐体がほかにつながっているときだけ**入る。それ以外は空で、serial で開く。
   */
  readonly usbPaths: readonly string[];
  /** この1台の USB 機器のアドレス（読めたものだけ）。 */
  readonly addresses: readonly number[];
}

/** まとめる対象の USB 機器と、その筐体の識別子。 */
export interface KeyedDevice {
  readonly vendorId: number;
  readonly productId: number;
  readonly key: string | null;
  /** 同梱 libusb がこの機器に振るアドレス（usbAddressOf）。読めなければ null。 */
  readonly address: number | null;
}

// ---- serial が重なる筐体 ---------------------------------------------------
//
// PX-M1UR と PX-S1UR などは、別の筐体でも serial が同じことがある（上流
// v0.1.9）。上流は serial だけでは開かず、USB の位置で名指させる。ブラウザ
// には USB の位置が無いので、**同梱 libusb の WebUSB 実装が USBDevice ごとに
// 振る番号を使う。**libusb はそれをバス 1 のアドレス（とポート番号）にする。
// 番号はつながっているあいだ変わらない（下の「握っておく」が前提）が、
// 抜き差しで振り直される。抜き差しを
// またいで同じ筐体を見分けることはしない（上流と同じ判断）。
//
// 番号は USBDevice に Symbol.for() の鍵で付いている。libusb がまだ見ていない
// 機器には、libusb と同じ数え方（同じ鍵の数え役）でここが振る。どちらが先に
// 振っても同じ番号になる。この取り決めは vendor/PATCHES/libusb.diff。
//
// **番号を振った USBDevice は、抜かれるまでここで握っておく。**Chrome は
// getDevices() が返すオブジェクトを弱くしか持たない。誰も参照していないと
// 回収され、次の getDevices() は別のオブジェクト（番号なし）を返す。すると
// 番号が振り直され、選んだ1台を見失い、C 側へ渡した位置も libusb の番号と
// ずれる（PX-M1UR と PX-S1UR を挿して、開いていない側の番号が呼ぶたびに
// 変わった。実機、2026-10-02）。

const SESSION_ID = Symbol.for('libusb.session_id');
const NEXT_SESSION_ID = Symbol.for('libusb.next_session_id');

const retainedDevices = new Set<USBDevice>();
let retainListenerInstalled = false;

function retainDevice(device: USBDevice): void {
  retainedDevices.add(device);
  if (retainListenerInstalled || typeof navigator === 'undefined' || !('usb' in navigator)) return;
  retainListenerInstalled = true;
  navigator.usb.addEventListener('disconnect', (event) => {
    retainedDevices.delete((event as USBConnectionEvent).device);
  });
}

/** USBDevice に libusb が振る（振った）アドレス。USB のアドレスの範囲外なら null。 */
export function usbAddressOf(device: USBDevice): number | null {
  retainDevice(device);
  const tagged = device as unknown as Record<symbol, unknown>;
  let id = tagged[SESSION_ID];
  if (typeof id !== 'number') {
    const counter = globalThis as unknown as Record<symbol, unknown>;
    const next = counter[NEXT_SESSION_ID];
    id = typeof next === 'number' ? next : 1;
    counter[NEXT_SESSION_ID] = (id as number) + 1;
    tagged[SESSION_ID] = id;
  }
  // libusb はアドレスを 8 ビットに詰める。255 を超えたら名指せない
  // （ページを読み直せば 1 から数え直す）。
  return Number.isInteger(id) && (id as number) >= 1 && (id as number) <= 255 ? id as number : null;
}

/**
 * USB 機器を筐体ごとにまとめ、使う1台を決める。
 *
 * 使うのは、このページで選んだ1台（chosenId）が開ける状態ならそれ、次に
 * 保存された選択（serial）が開ける状態ならそれ、どちらでもなければ開ける
 * もののうち一覧の先頭。serial が同じ筐体が複数あると、保存された選択では
 * 見分けられず、その中の先頭になる。並びは上流の機種の表の順、同じ機種の
 * 中は識別子の順、識別子も同じならアドレスの順。
 *
 * **serial が同じ筐体は1行ずつにする。**USB 機器1つの機種は、機器ごとに
 * 1行。USB 機器2つの機種（PX-Q3U4 など）で serial が重なると、どの2つが
 * 同じ筐体か分からないので開けない（未対応）。
 */
export function groupTuners(
  models: readonly Px4Model[],
  devices: readonly KeyedDevice[],
  storedKey: string | null,
  chosenId: string | null = null,
): ConnectedTuner[] {
  interface Draft {
    key: string | null; model: Px4Model; modelIndex: number; addresses: (number | null)[];
  }
  const drafts: Draft[] = [];
  for (const device of devices) {
    const modelIndex = models.findIndex((model) => model.vendorId === device.vendorId
      && model.productId === device.productId);
    const model = models[modelIndex];
    if (model === undefined) continue;
    // 識別子が読めない機器は、ほかとまとめずに1行ずつにする（開けない）。
    // 1台ぶんそろった筐体には足さない（serial が同じ別の筐体）。
    const existing = device.key === null ? undefined
      : drafts.find((draft) => draft.key === device.key && draft.model === model
        && draft.addresses.length < model.usbDevices);
    if (existing !== undefined) existing.addresses.push(device.address);
    else drafts.push({ key: device.key, model, modelIndex, addresses: [device.address] });
  }
  const order = (key: string | null) => key ?? '￿';
  const firstAddress = (draft: Draft) => Math.min(...draft.addresses.map((a) => a ?? 256));
  drafts.sort((left, right) => left.modelIndex - right.modelIndex
    || order(left.key).localeCompare(order(right.key))
    || firstAddress(left) - firstAddress(right));

  const known = (draft: Draft) => draft.addresses.filter((a): a is number => a !== null);
  const idOf = (draft: Draft) => known(draft).length === draft.addresses.length
    ? known(draft).map((a) => `1:${a}`).join(',') : '';
  // serial が同じ筐体がほかにある（機種は問わない。上流は serial で探す）。
  const shared = (draft: Draft) => draft.key !== null
    && drafts.some((other) => other !== draft && other.key === draft.key);
  const ready = (draft: Draft) => draft.key !== null
    && draft.addresses.length >= draft.model.usbDevices
    && (!shared(draft) || (draft.model.usbDevices === 1 && idOf(draft) !== ''));
  const chosen = drafts.find((draft) => ready(draft) && chosenId !== null && idOf(draft) === chosenId)
    ?? drafts.find((draft) => ready(draft) && draft.key === storedKey)
    ?? drafts.find(ready);

  return drafts.map((draft) => {
    const siblings = drafts.filter((other) => other.model === draft.model);
    const label = siblings.length > 1
      ? `${draft.model.name}（${siblings.indexOf(draft) + 1}台目）`
      : draft.model.name;
    const id = idOf(draft);
    return Object.freeze({
      key: draft.key,
      model: draft.model,
      label,
      granted: draft.addresses.length,
      required: draft.model.usbDevices,
      ready: ready(draft),
      selected: draft === chosen,
      id,
      usbPaths: Object.freeze(shared(draft) && id !== '' ? id.split(',') : []),
      addresses: Object.freeze(known(draft)),
    });
  });
}

const SELECTED_TUNER_KEY = 'webts-selected-tuner';
const KEY_CAPACITY = 64;
/** このページで選んだ1台（ConnectedTuner.id）。保存しない。 */
let chosenTunerId: string | null = null;

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

async function keyedDevices(): Promise<{ device: USBDevice; key: string | null; address: number | null }[]> {
  const devices = await navigator.usb.getDevices();
  return Promise.all(devices.map(async (device) => ({
    device, key: await tunerKeyOf(device), address: usbAddressOf(device),
  })));
}

/** その USB 機器がこの1台のものか。アドレスで見る。読めなければ機種と serial で。 */
function belongsTo(tuner: ConnectedTuner, { device, key, address }:
  { device: USBDevice; key: string | null; address: number | null }): boolean {
  if (device.vendorId !== tuner.model.vendorId || device.productId !== tuner.model.productId) {
    return false;
  }
  return tuner.id !== '' && address !== null ? tuner.addresses.includes(address) : key === tuner.key;
}

/** diagnoseTunerOpen の結果。 */
export type TunerOpenDiagnosis =
  'unseen' | 'unconfigured' | 'network' | 'security' | 'state' | 'other'
  | 'descriptor' | 'readable';

let diagnosing: Promise<TunerOpenDiagnosis> | null = null;

/**
 * 選んだチューナーを WebUSB が開けるかを確かめる。上流が「開ける機器が無い」
 * と言ったときの理由を知るためだけに使う（q3u4-module.ts の resolveOpenDetail）。
 *
 * - `unseen`：選んだチューナーが WebUSB の一覧に無い（抜けた、許可が無い）
 * - `unconfigured`：構成が読めていない（configuration が null）
 * - `network` / `security` / `state` / `other`：open() が失敗した（例外の種類）
 * - `descriptor`：開けるが、デバイス記述子が読めない
 * - `readable`：開けて記述子も読める（外された理由はほかにある）
 *
 * **同時には1つしか走らせない。**地上波と衛星の走査が同時に失敗すると、
 * 同じ機器を同時に開け閉めして互いに InvalidStateError になった（実機、
 * 2026-09-27）。走っている間に頼まれたら、同じ結果を返す。
 *
 * 識別子は返さない。
 */
export function diagnoseTunerOpen(): Promise<TunerOpenDiagnosis> {
  diagnosing ??= runTunerOpenDiagnosis().finally(() => { diagnosing = null; });
  return diagnosing;
}

async function runTunerOpenDiagnosis(): Promise<TunerOpenDiagnosis> {
  const [tuner, devices] = await Promise.all([selectedTunerOrFirst(), keyedDevices()]);
  if (tuner === null) return 'unseen';
  const mine = devices.filter((entry) => belongsTo(tuner, entry));
  if (mine.length === 0) return 'unseen';
  for (const { device } of mine) {
    if (device.configuration === null) return 'unconfigured';
    if (device.opened) continue;
    try {
      await device.open();
    } catch (error) {
      const name = error instanceof DOMException ? error.name : '';
      return name === 'NetworkError' ? 'network'
        : name === 'SecurityError' ? 'security'
          : name === 'InvalidStateError' ? 'state' : 'other';
    }
    try {
      // libusb の WebUSB 実装が一覧を作るときに読むのと同じ、デバイス記述子。
      const result = await device.controlTransferIn({
        requestType: 'standard', recipient: 'device', request: 0x06, value: 0x0100, index: 0,
      }, 18);
      if (result.status !== 'ok') return 'descriptor';
    } catch {
      return 'descriptor';
    } finally {
      await device.close().catch(() => undefined);
    }
  }
  return 'readable';
}

/** 選んだチューナー。開けるものが無ければ、一覧の先頭（そろっていなくても）。 */
async function selectedTunerOrFirst(): Promise<ConnectedTuner | null> {
  const tuners = await listConnectedTuners();
  return tuners.find((tuner) => tuner.selected) ?? tuners[0] ?? null;
}

/**
 * 接続済みのチューナーの一覧。**プロンプトは出ない。**許可されていて、
 * いまつながっている機器だけが対象（`navigator.usb.getDevices()`）。
 */
export async function listConnectedTuners(): Promise<ConnectedTuner[]> {
  const [models, devices] = await Promise.all([loadPx4Models(), keyedDevices()]);
  return groupTuners(models,
    devices.map(({ device, key, address }) =>
      ({ vendorId: device.vendorId, productId: device.productId, key, address })),
    storedTunerKey(), chosenTunerId);
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
  // serial が同じ筐体を見分けるのは、このページのあいだだけ（アドレス）。
  // 次に開いたときは serial で選び、重なっていればその中の先頭になる。
  chosenTunerId = tuner.id === '' ? null : tuner.id;
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
  for (const entry of await keyedDevices()) {
    if (!belongsTo(tuner, entry)) continue;
    await entry.device.forget();
    retainedDevices.delete(entry.device);
  }
  if (tuner.id !== '' && tuner.id === chosenTunerId) chosenTunerId = null;
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
