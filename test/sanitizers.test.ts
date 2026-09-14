import { describe, it, expect } from 'vitest';
import {
  sanitizeDeviceSummary,
  getUsbClassName,
  formatBcdVersion,
  normalizeUsbString,
  MAX_USB_STRING_LENGTH,
} from '../src/usb/sanitizers';
import {
  MockUSBDevice,
  createMockConfiguration,
  createMockInterface,
  createMockAlternate,
  createMockEndpoint,
} from './mocks/usb-mock';

describe('Descriptor Sanitization and Privacy', () => {
  it('formats BCD version numbers correctly', () => {
    expect(formatBcdVersion(2, 0, 0)).toBe('2.0.0');
    expect(formatBcdVersion(2, 1, 0)).toBe('2.1.0');
    expect(formatBcdVersion(1, 1, 2)).toBe('1.1.2');
  });

  it('maps USB class codes to human readable descriptions', () => {
    expect(getUsbClassName(0xff)).toBe('Vendor Specific');
    expect(getUsbClassName(0x0b)).toBe('Smart Card / CCID');
    expect(getUsbClassName(0x03)).toBe('HID (Human Interface Device)');
    expect(getUsbClassName(0x00)).toBe('Device (Interface-defined)');
    expect(getUsbClassName(0xee)).toContain('0xee');
  });

  it('strictly NEVER accesses or exposes device serial number', () => {
    const rawDevice = new MockUSBDevice({
      vendorId: 0x0511,
      productId: 0x084a,
      serialNumber: 'SECRET_TUNER_SERIAL_12345',
      manufacturerName: 'PLEX',
      productName: 'PX-Q3U4',
    });

    const summary = sanitizeDeviceSummary(rawDevice);

    // 1. Property must not exist on summary
    expect('serialNumber' in summary).toBe(false);
    expect('serial' in summary).toBe(false);
    expect((summary as unknown as Record<string, unknown>).serialNumber).toBeUndefined();

    // 2. Serial string must not appear anywhere in JSON serialization
    const jsonString = JSON.stringify(summary);
    expect(jsonString).not.toContain('SECRET_TUNER_SERIAL_12345');
    expect(jsonString).not.toContain('serial');
  });

  it('correctly maps configurations, interfaces, alternates, and endpoints', () => {
    const epIn = createMockEndpoint(1, 'in', 'bulk', 512);
    const epOut = createMockEndpoint(2, 'out', 'interrupt', 64);

    const alt0 = createMockAlternate(0, 0xff, [epIn, epOut], 'Data Streaming');
    const iface0 = createMockInterface(0, [alt0]);

    const altCcid = createMockAlternate(0, 0x0b, [], 'Card Reader');
    const ifaceCcid = createMockInterface(1, [altCcid]);

    const config = createMockConfiguration(1, [iface0, ifaceCcid], 'Default Config');

    const device = new MockUSBDevice({
      vendorId: 0x0511,
      productId: 0x084a,
      configurations: [config],
      configuration: config,
      opened: true,
    });

    const summary = sanitizeDeviceSummary(device);

    expect(summary.vendorIdHex).toBe('0x0511');
    expect(summary.productIdHex).toBe('0x084a');
    expect(summary.knownModelLabel).toContain('PX-Q3U4');
    expect(summary.opened).toBe(true);
    expect(summary.activeConfigurationValue).toBe(1);
    expect(summary.configurations).toHaveLength(1);

    const configSummary = summary.configurations[0];
    expect(configSummary.configurationValue).toBe(1);
    expect(configSummary.configurationName).toBe('Default Config');
    expect(configSummary.isSelected).toBe(true);
    expect(configSummary.interfaces).toHaveLength(2);

    // Interface 0: Vendor specific (claimable)
    const if0 = configSummary.interfaces[0];
    expect(if0.interfaceNumber).toBe(0);
    expect(if0.isClaimable).toBe(true);
    expect(if0.claimDisallowedReason).toBeUndefined();
    expect(if0.alternates[0].endpoints).toHaveLength(2);
    expect(if0.alternates[0].endpoints[0]).toEqual({
      endpointNumber: 1,
      direction: 'in',
      type: 'bulk',
      packetSize: 512,
    });

    // Interface 1: CCID (not claimable)
    const if1 = configSummary.interfaces[1];
    expect(if1.interfaceNumber).toBe(1);
    expect(if1.isClaimable).toBe(false);
    expect(if1.claimDisallowedReason).toContain('0x0b');
  });

  describe('Untrusted USB string descriptor normalization', () => {
    it('removes C0 and C1 control characters', () => {
      const input = 'PLEX\u0000\u0007\u001b\u007f\u0080\u009f Tuner';
      const output = normalizeUsbString(input);
      expect(output).toBe('PLEX Tuner');
    });

    it('removes Unicode bidi override and isolate control characters', () => {
      // U+202E (RLO), U+202A (LRE), U+202C (PDF), U+2066 (LRI), U+2069 (PDI), U+200E (LRM), U+200F (RLM)
      const input = 'Device\u202Eexe.cod\u202C\u2066test\u2069\u200E';
      const output = normalizeUsbString(input);
      expect(output).toBe('Deviceexe.codtest');
    });

    it('trims leading and trailing whitespace and returns undefined for empty strings', () => {
      expect(normalizeUsbString('   hello world   ')).toBe('hello world');
      expect(normalizeUsbString('    ')).toBeUndefined();
      expect(normalizeUsbString('\u0000\u001b')).toBeUndefined();
      expect(normalizeUsbString(undefined)).toBeUndefined();
    });

    it('caps strings at exactly 128 Unicode code points', () => {
      expect(MAX_USB_STRING_LENGTH).toBe(128);

      const longAscii = 'A'.repeat(200);
      const normalizedAscii = normalizeUsbString(longAscii);
      expect(normalizedAscii).toHaveLength(128);
      expect(Array.from(normalizedAscii!).length).toBe(128);

      // Multi-byte Unicode code points (emoji / Japanese)
      const longUnicode = '📺テレビ'.repeat(50); // 4 code points * 50 = 200 code points
      const normalizedUnicode = normalizeUsbString(longUnicode);
      expect(Array.from(normalizedUnicode!).length).toBe(128);
    });

    it('preserves HTML tags as text at sanitizer level without stripping angle brackets', () => {
      const tagString = '<script>alert("xss")</script>';
      const output = normalizeUsbString(tagString);
      // Tags remain as text at sanitizer level; HTML escaping happens at rendering
      expect(output).toBe('<script>alert("xss")</script>');
    });

    it('normalizes manufacturerName, productName, configurationName, and interfaceName in sanitizeDeviceSummary', () => {
      const alt = createMockAlternate(0, 0xff, [], '  Interface\u0000\u202Ename  ');
      const iface = createMockInterface(0, [alt]);
      const config = createMockConfiguration(1, [iface], '  Config\u001b\u0085name  ');

      const overlongProduct = 'Product\u0007 ' + 'X'.repeat(200);
      const rawDevice = new MockUSBDevice({
        vendorId: 0x0511,
        productId: 0x084a,
        manufacturerName: '  PLEX\u0000\u2066Corp\u2069  ',
        productName: overlongProduct,
        configurations: [config],
        configuration: config,
      });

      const summary = sanitizeDeviceSummary(rawDevice);

      // Controls and bidi removed, whitespace trimmed
      expect(summary.manufacturerName).toBe('PLEXCorp');

      // Product name capped at 128 code points
      expect(summary.productName).toBeDefined();
      expect(Array.from(summary.productName!).length).toBe(128);
      expect(summary.productName).not.toContain('\u0007');

      // Configuration and interface names normalized
      expect(summary.configurations[0].configurationName).toBe('Configname');
      expect(summary.configurations[0].interfaces[0].alternates[0].interfaceName).toBe('Interfacename');
    });
  });
});
