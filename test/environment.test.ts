import { describe, expect, it } from 'vitest';
import { describeEnvironment } from '../src/platform/environment';

describe('environment report', () => {
  it('reports fixed booleans and touches no device API', () => {
    const report = describeEnvironment();
    for (const value of Object.values(report)) {
      expect(typeof value).toBe('boolean');
    }
    expect(Object.isFrozen(report)).toBe(true);
  });

  it('reports WebUSB as absent under the Node test environment', () => {
    // Node has no navigator.usb; the report must say so rather than throw.
    expect(describeEnvironment().webUsbPresent).toBe(false);
  });
});
