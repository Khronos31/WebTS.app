import { describe, it, expect } from 'vitest';
import { SUPPORTED_DEVICE_FILTERS, getDeviceModelInfo } from '../src/usb/filters';

describe('USB Device Filters', () => {
  it('contains exactly the specified VID:PID pairs for PX-Q3U4 and Siano Rio states', () => {
    expect(SUPPORTED_DEVICE_FILTERS).toHaveLength(4);

    const filterList = SUPPORTED_DEVICE_FILTERS.map((f) => ({
      vid: `0x${f.vendorId.toString(16).padStart(4, '0')}`,
      pid: `0x${f.productId?.toString(16).padStart(4, '0')}`,
    }));

    expect(filterList).toEqual([
      { vid: '0x0511', pid: '0x084a' }, // PX-Q3U4
      { vid: '0x3275', pid: '0x0080' }, // PX-S1UD (hardware-confirmed)
      { vid: '0x187f', pid: '0x0600' }, // Siano Rio compatible (unverified)
      { vid: '0x187f', pid: '0x0302' }, // Siano Rio compatible (unverified)
    ]);
  });

  it('correctly maps hardware-confirmed PX-S1UD and unverified Siano compatible labels', () => {
    const pxQ3U4 = getDeviceModelInfo(0x0511, 0x084a);
    expect(pxQ3U4.label).toContain('PX-Q3U4');
    expect(pxQ3U4.isKnown).toBe(true);

    const pxS1ud = getDeviceModelInfo(0x3275, 0x0080);
    expect(pxS1ud.label).toContain('PX-S1UD');
    expect(pxS1ud.label).toContain('実機確認済み');
    expect(pxS1ud.isKnown).toBe(true);

    const siano600 = getDeviceModelInfo(0x187f, 0x0600);
    expect(siano600.label).toContain('Siano Rio');
    expect(siano600.label).toContain('実機未検証');
    expect(siano600.isKnown).toBe(true);

    const siano302 = getDeviceModelInfo(0x187f, 0x0302);
    expect(siano302.label).toContain('Siano Rio');
    expect(siano302.label).toContain('実機未検証');
    expect(siano302.isKnown).toBe(true);

    const unknown = getDeviceModelInfo(0x1234, 0x5678);
    expect(unknown.isKnown).toBe(false);
    expect(unknown.label).toContain('0x1234:0x5678');
  });
});
