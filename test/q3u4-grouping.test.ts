import { describe, expect, it } from 'vitest';
import { deriveSpeed } from '../src/usb/q3u4-grouping';

// ここで検査するのは speed 導出そのものだけ。実機の列挙や grouping が成立する
// ことの検証ではない。それは実機でしか確認できない。

function deviceWithBulk(packetSize: number): USBDevice {
  const endpoints = packetSize > 0
    ? [{ endpointNumber: 1, direction: 'in' as const, type: 'bulk' as const, packetSize }]
    : [];
  const alternate = {
    alternateSetting: 0, interfaceClass: 255, interfaceSubclass: 0,
    interfaceProtocol: 0, endpoints,
  };
  const configuration = {
    configurationValue: 1,
    interfaces: [{ interfaceNumber: 0, alternate, alternates: [alternate], claimed: false }],
  };
  return {
    vendorId: 0x0511, productId: 0x084a, deviceClass: 0, deviceSubclass: 0,
    deviceProtocol: 0, usbVersionMajor: 2, usbVersionMinor: 0, usbVersionSubminor: 0,
    deviceVersionMajor: 0, deviceVersionMinor: 0, deviceVersionSubminor: 0,
    opened: false, configuration, configurations: [configuration],
  } as USBDevice;
}

describe('USB speed derivation', () => {
  // USB 2.0 仕様: bulk の最大パケットサイズは full speed で 8/16/32/64、
  // high speed で 512、SuperSpeed で 1024。だから観測値から一意に決まる。
  it('derives high speed from a 512 byte bulk endpoint', () => {
    expect(deriveSpeed(deviceWithBulk(512))).toBe(3);
  });

  it('derives full speed from the full-speed bulk sizes', () => {
    for (const size of [8, 16, 32, 64]) {
      expect(deriveSpeed(deviceWithBulk(size))).toBe(2);
    }
  });

  it('derives super speed from a 1024 byte bulk endpoint', () => {
    expect(deriveSpeed(deviceWithBulk(1024))).toBe(4);
  });

  it('reports unknown when there is no bulk endpoint to judge from', () => {
    expect(deriveSpeed(deviceWithBulk(0))).toBe(0);
  });
});
