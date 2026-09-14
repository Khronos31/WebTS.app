import { describe, it, expect } from 'vitest';
import {
  evaluateInterfaceClaimability,
  USB_CLASS_SMART_CARD_CCID,
  USB_CLASS_VENDOR_SPECIFIC,
} from '../src/usb/claim-policy';
import { createMockAlternate, createMockInterface } from './mocks/usb-mock';

describe('Interface Claim Policy', () => {
  it('allows claiming vendor-specific interfaces when all alternates are class 0xff', () => {
    const ifaceSingle = createMockInterface(0, [
      createMockAlternate(0, USB_CLASS_VENDOR_SPECIFIC),
    ]);
    const resultSingle = evaluateInterfaceClaimability(ifaceSingle);
    expect(resultSingle.allowed).toBe(true);
    expect(resultSingle.isVendorSpecific).toBe(true);
    expect(resultSingle.isSmartCardCcid).toBe(false);

    const ifaceMultiple = createMockInterface(0, [
      createMockAlternate(0, USB_CLASS_VENDOR_SPECIFIC),
      createMockAlternate(1, USB_CLASS_VENDOR_SPECIFIC),
    ]);
    const resultMultiple = evaluateInterfaceClaimability(ifaceMultiple);
    expect(resultMultiple.allowed).toBe(true);
    expect(resultMultiple.isVendorSpecific).toBe(true);
  });

  it('strictly forbids claiming smart-card / CCID interfaces (class 0x0b)', () => {
    const iface = createMockInterface(1, [
      createMockAlternate(0, USB_CLASS_SMART_CARD_CCID),
    ]);

    const result = evaluateInterfaceClaimability(iface);
    expect(result.allowed).toBe(false);
    expect(result.isSmartCardCcid).toBe(true);
    expect(result.reason).toContain('0x0b');
  });

  it('forbids claiming non-vendor interfaces (e.g. HID 0x03, Video 0x0e)', () => {
    const hidIface = createMockInterface(2, [
      createMockAlternate(0, 0x03), // HID
    ]);

    const hidResult = evaluateInterfaceClaimability(hidIface);
    expect(hidResult.allowed).toBe(false);
    expect(hidResult.reason).toContain('0x03');

    const videoIface = createMockInterface(3, [
      createMockAlternate(0, 0x0e), // Video
    ]);

    const videoResult = evaluateInterfaceClaimability(videoIface);
    expect(videoResult.allowed).toBe(false);
    expect(videoResult.reason).toContain('0x0e');
  });

  it('forbids claiming if ANY alternate has CCID even if mixed with vendor', () => {
    const mixedCcidIface = createMockInterface(0, [
      createMockAlternate(0, USB_CLASS_VENDOR_SPECIFIC),
      createMockAlternate(1, USB_CLASS_SMART_CARD_CCID),
    ]);

    const result = evaluateInterfaceClaimability(mixedCcidIface);
    expect(result.allowed).toBe(false);
    expect(result.isSmartCardCcid).toBe(true);
  });

  it('denies mixed interfaces where vendor (0xff) is paired with standard classes (e.g. HID, CDC, Printer)', () => {
    // Vendor + HID (0x03)
    const vendorHidIface = createMockInterface(0, [
      createMockAlternate(0, USB_CLASS_VENDOR_SPECIFIC),
      createMockAlternate(1, 0x03),
    ]);
    const hidResult = evaluateInterfaceClaimability(vendorHidIface);
    expect(hidResult.allowed).toBe(false);
    expect(hidResult.reason).toContain('混在');
    expect(hidResult.reason).toContain('0x03');

    // Vendor + CDC Control (0x02)
    const vendorCdcIface = createMockInterface(0, [
      createMockAlternate(0, USB_CLASS_VENDOR_SPECIFIC),
      createMockAlternate(1, 0x02),
    ]);
    const cdcResult = evaluateInterfaceClaimability(vendorCdcIface);
    expect(cdcResult.allowed).toBe(false);
    expect(cdcResult.reason).toContain('混在');
    expect(cdcResult.reason).toContain('0x02');

    // Vendor + Mass Storage (0x08)
    const vendorStorageIface = createMockInterface(0, [
      createMockAlternate(0, USB_CLASS_VENDOR_SPECIFIC),
      createMockAlternate(1, 0x08),
    ]);
    const storageResult = evaluateInterfaceClaimability(vendorStorageIface);
    expect(storageResult.allowed).toBe(false);
    expect(storageResult.reason).toContain('混在');
    expect(storageResult.reason).toContain('0x08');
  });

  it('handles empty alternates safely', () => {
    const emptyIface = {
      interfaceNumber: 0,
      alternate: undefined as unknown as ReturnType<typeof createMockAlternate>,
      alternates: [],
      claimed: false,
    };

    const result = evaluateInterfaceClaimability(emptyIface);
    expect(result.allowed).toBe(false);
  });
});
