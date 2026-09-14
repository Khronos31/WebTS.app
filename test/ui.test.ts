import { describe, it, expect } from 'vitest';
import { getStateLabelAndClass, escapeHtml } from '../src/ui/components';
import type { AdapterState } from '../src/types/usb';

describe('UI Helper and Component Functions', () => {
  it('maps all adapter states to human-readable labels and CSS classes', () => {
    const states: AdapterState[] = [
      'UNSUPPORTED',
      'IDLE',
      'DEVICE_SELECTED',
      'OPENED_NO_CONFIG',
      'OPENED',
      'CLOSED',
      'DISCONNECTED',
    ];

    for (const state of states) {
      const result = getStateLabelAndClass(state);
      expect(result.label).toBeTruthy();
      expect(result.className).toBeTruthy();
    }
  });

  it('escapes HTML special characters properly', () => {
    const raw = '<script>alert("xss & dangerous \'injection\'")</script>';
    const escaped = escapeHtml(raw);

    expect(escaped).not.toContain('<script>');
    expect(escaped).toContain('&lt;script&gt;');
    expect(escaped).toContain('&amp;');
    expect(escaped).toContain('&quot;');
    expect(escaped).toContain('&#039;');
  });
});
