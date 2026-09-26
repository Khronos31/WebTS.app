import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  groupTuners, loadPx4Models, resetPx4ModelCache, usbFilters,
  type IdentityModule, type KeyedDevice, type Px4Model,
} from '../src/usb/px4-identity';

// 機種の表は上流のもの（identity.cpp）。ここではまとめ方と選び方の規則だけを
// 試すので、形だけ同じ表を置く。実際の表は下の describe がビルド済みの
// モジュールから読んで確かめる。
//
// 識別子（base serial）は試験用に作った値で、実機のものではない。
const q3u4: Px4Model = {
  name: 'PX-Q3U4', vendorId: 0x0511, productId: 0x084a, usbDevices: 2, receivers: 8,
  verified: true,
};
const mlt5pe: Px4Model = {
  name: 'PX-MLT5PE', vendorId: 0x0511, productId: 0x024e, usbDevices: 1, receivers: 5,
  verified: false,
};
const models = [q3u4, mlt5pe];
const device = (model: Px4Model, key: string | null): KeyedDevice =>
  ({ vendorId: model.vendorId, productId: model.productId, key });
const summary = (tuners: ReturnType<typeof groupTuners>) => tuners.map(
  ({ label, granted, required, ready, selected }) => ({ label, granted, required, ready, selected }));

describe('接続済みのチューナーのまとめ方', () => {
  it('何も無ければ空', () => {
    expect(groupTuners(models, [], null)).toEqual([]);
  });

  it('PX-Q3U4 は USB 機器2つで1行、そろって開ける', () => {
    expect(summary(groupTuners(models, [device(q3u4, '10000000000001')], null))).toEqual([
      { label: 'PX-Q3U4', granted: 1, required: 2, ready: false, selected: false },
    ]);
    expect(summary(groupTuners(models,
      [device(q3u4, '10000000000001'), device(q3u4, '10000000000001')], null))).toEqual([
      { label: 'PX-Q3U4', granted: 2, required: 2, ready: true, selected: true },
    ]);
  });

  it('別々の筐体は別の行になり、選ばれるのは1つだけ', () => {
    const tuners = groupTuners(models, [
      device(mlt5pe, '200000000000001'),
      device(q3u4, '10000000000001'), device(q3u4, '10000000000001'),
    ], null);
    // 並びは機種の表の順。何も選んでいなければ開けるものの先頭。
    expect(summary(tuners)).toEqual([
      { label: 'PX-Q3U4', granted: 2, required: 2, ready: true, selected: true },
      { label: 'PX-MLT5PE', granted: 1, required: 1, ready: true, selected: false },
    ]);
  });

  it('保存された選択が開けるならそれを使う', () => {
    const tuners = groupTuners(models, [
      device(q3u4, '10000000000001'), device(q3u4, '10000000000001'),
      device(mlt5pe, '200000000000001'),
    ], '200000000000001');
    expect(tuners.filter((tuner) => tuner.selected).map((tuner) => tuner.label))
      .toEqual(['PX-MLT5PE']);
  });

  it('保存された選択が開けなければ、開けるものの先頭に戻る', () => {
    const tuners = groupTuners(models, [
      device(q3u4, '10000000000001'),
      device(mlt5pe, '200000000000001'),
    ], '10000000000001');
    expect(summary(tuners)).toEqual([
      { label: 'PX-Q3U4', granted: 1, required: 2, ready: false, selected: false },
      { label: 'PX-MLT5PE', granted: 1, required: 1, ready: true, selected: true },
    ]);
  });

  it('同じ機種が複数あれば「n台目」と数える（識別子の順）', () => {
    const tuners = groupTuners(models, [
      device(mlt5pe, '300000000000001'),
      device(mlt5pe, '200000000000001'),
    ], '300000000000001');
    expect(summary(tuners)).toEqual([
      { label: 'PX-MLT5PE（1台目）', granted: 1, required: 1, ready: true, selected: false },
      { label: 'PX-MLT5PE（2台目）', granted: 1, required: 1, ready: true, selected: true },
    ]);
  });

  it('識別子が読めない機器は1行ずつで、開けない', () => {
    expect(summary(groupTuners(models, [device(q3u4, null), device(q3u4, null)], null))).toEqual([
      { label: 'PX-Q3U4（1台目）', granted: 1, required: 2, ready: false, selected: false },
      { label: 'PX-Q3U4（2台目）', granted: 1, required: 2, ready: false, selected: false },
    ]);
  });

  it('知らない機器は数えない', () => {
    expect(groupTuners(models, [{ vendorId: 0x0511, productId: 0x1234, key: '1' }], null))
      .toEqual([]);
  });

  it('選択ダイアログの候補は全機種', () => {
    expect(usbFilters(models)).toEqual([
      { vendorId: 0x0511, productId: 0x084a },
      { vendorId: 0x0511, productId: 0x024e },
    ]);
  });
});

// ビルド済みのモジュール（CI では WASM の段が作って渡す）から上流の表を読む。
const modulePath = 'build/px4-identity/px4-identity.mjs';

describe.skipIf(!existsSync(modulePath))('上流の機種の表（ビルド済みのモジュール）', () => {
  afterEach(() => { resetPx4ModelCache(); });

  it('v0.1.6 の16機種が、USB 機器と受信機の数つきで読める', async () => {
    // 並びは上流の機種の番号（DeviceModel）の順。値は上流 SPEC 4.1 節の表と同じ。
    const loaded = await loadPx4Models(pathToFileURL(modulePath).href);
    const row = (name: string, productId: number, usbDevices: number, receivers: number) =>
      ({ name, vendorId: 0x0511, productId, usbDevices, receivers, verified: productId === 0x084a });
    expect(loaded).toEqual([
      row('PX-Q3U4', 0x084a, 2, 8),
      row('PX-MLT5PE', 0x024e, 1, 5),
      row('DTV02A-5TS-P', 0x924e, 1, 5),
      row('PX-W3U4', 0x083f, 1, 4),
      row('PX-W3PE4', 0x023f, 1, 4),
      row('PX-W3PE5', 0x073f, 1, 4),
      row('PX-Q3PE4', 0x024a, 2, 8),
      row('PX-Q3PE5', 0x074a, 2, 8),
      row('PX-MLT8PE3', 0x0252, 1, 3),
      row('PX-MLT8PE5', 0x0253, 1, 5),
      row('DTV02A-4TS-P', 0x0254, 1, 4),
      row('PX-M1UR', 0x0854, 1, 1),
      row('PX-S1UR', 0x0855, 1, 1),
      row('DTV03A-1TU', 0x0052, 1, 1),
      row('DTV02-1T1S-U', 0x004b, 1, 1),
      row('DTV02A-1T1S-U', 0x084b, 1, 1),
    ]);
  });
});

describe.skipIf(!existsSync(modulePath))('筐体の識別子（上流の規則、ビルド済みのモジュール）', () => {
  async function tunerKey(vendorId: number, productId: number, serial: string): Promise<string | null> {
    const factory = (await import(pathToFileURL(modulePath).href)).default;
    const module = await factory() as IdentityModule;
    const encoded = new TextEncoder().encode(`${serial}\0`);
    const input = module._malloc(encoded.length);
    const output = module._malloc(64);
    try {
      module.HEAPU8.set(encoded, input);
      const error = module.ccall('webts_px4_tuner_key', 'number',
        ['number', 'number', 'number', 'number', 'number'],
        [vendorId, productId, input, output, 64]);
      if (error !== 0) return null;
      const end = module.HEAPU8.indexOf(0, output);
      return new TextDecoder().decode(module.HEAPU8.slice(output, end));
    } finally {
      module._free(input);
      module._free(output);
    }
  }

  it('PX-Q3U4 の2つの機器は同じ識別子になる（末尾の 1 と 2 を落とす）', async () => {
    expect(await tunerKey(0x0511, 0x084a, '100000000000011')).toBe('10000000000001');
    expect(await tunerKey(0x0511, 0x084a, '100000000000012')).toBe('10000000000001');
  });

  it('1機器の機種は serial そのものが識別子', async () => {
    expect(await tunerKey(0x0511, 0x024e, '200000000000003')).toBe('200000000000003');
    expect(await tunerKey(0x0511, 0x083f, '300000000000004')).toBe('300000000000004');
  });

  it('上流が受け付けない serial と知らない機種は null', async () => {
    expect(await tunerKey(0x0511, 0x084a, '100000000000013')).toBeNull();
    expect(await tunerKey(0x0511, 0x084a, 'ABC')).toBeNull();
    expect(await tunerKey(0x0511, 0x024e, '12345')).toBeNull();
    expect(await tunerKey(0x0511, 0x1234, '200000000000003')).toBeNull();
  });
});
