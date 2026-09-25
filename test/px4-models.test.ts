import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  evaluateTunerPermission, loadPx4Models, resetPx4ModelCache, usbFilters, type Px4Model,
} from '../src/usb/px4-identity';

// 機種の表は上流のもの（identity.cpp）。ここでは許可の判定の規則だけを
// 試すので、形だけ同じ表を置く。実際の表は下の2つ目の describe が
// ビルド済みのモジュールから読んで確かめる。
const q3u4: Px4Model = {
  name: 'PX-Q3U4', vendorId: 0x0511, productId: 0x084a, usbDevices: 2, receivers: 8,
  verified: true,
};
const mlt5pe: Px4Model = {
  name: 'PX-MLT5PE', vendorId: 0x0511, productId: 0x024e, usbDevices: 1, receivers: 5,
  verified: false,
};
const models = [q3u4, mlt5pe];
const device = (model: Px4Model) => ({ vendorId: model.vendorId, productId: model.productId });

describe('チューナーの許可の判定', () => {
  it('何も許可されていなければ機種は null', () => {
    expect(evaluateTunerPermission(models, [])).toEqual(
      { model: null, granted: 0, required: 0, ready: false });
  });

  it('PX-Q3U4 は USB 機器2つそろって準備ができる', () => {
    expect(evaluateTunerPermission(models, [device(q3u4)]))
      .toEqual({ model: q3u4, granted: 1, required: 2, ready: false });
    expect(evaluateTunerPermission(models, [device(q3u4), device(q3u4)]))
      .toEqual({ model: q3u4, granted: 2, required: 2, ready: true });
  });

  it('PX-MLT5PE は USB 機器1つで準備ができる', () => {
    expect(evaluateTunerPermission(models, [device(mlt5pe)]))
      .toEqual({ model: mlt5pe, granted: 1, required: 1, ready: true });
  });

  it('準備ができた機種を、許可が途中の機種より優先する', () => {
    expect(evaluateTunerPermission(models, [device(q3u4), device(mlt5pe)]).model).toBe(mlt5pe);
  });

  it('知らない機器は数えない', () => {
    expect(evaluateTunerPermission(models, [{ vendorId: 0x0511, productId: 0x1234 }]).model)
      .toBeNull();
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

  it('v0.1.5-beta の4機種が、USB 機器と受信機の数つきで読める', async () => {
    // 並びは上流の機種の番号（DeviceModel）の順。
    const loaded = await loadPx4Models(pathToFileURL(modulePath).href);
    expect(loaded).toEqual([
      { name: 'PX-Q3U4', vendorId: 0x0511, productId: 0x084a, usbDevices: 2, receivers: 8, verified: true },
      { name: 'PX-MLT5PE', vendorId: 0x0511, productId: 0x024e, usbDevices: 1, receivers: 5, verified: false },
      { name: 'DTV02A-5TS-P', vendorId: 0x0511, productId: 0x924e, usbDevices: 1, receivers: 5, verified: false },
      { name: 'PX-W3U4', vendorId: 0x0511, productId: 0x083f, usbDevices: 1, receivers: 4, verified: false },
    ]);
  });
});
