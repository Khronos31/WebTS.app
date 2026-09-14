import { describe, it, expect } from 'vitest';
import {
  categorizeError,
  createDiagnosticEntry,
  sanitizeDetailsAllowlist,
  appendDiagnosticEntry,
  MAX_DIAGNOSTIC_ENTRIES,
} from '../src/usb/diagnostics';

describe('Sanitized Diagnostics and Error Categorization', () => {
  it('distinguishes user cancellation from dialog', () => {
    const error = new Error('No device selected');
    error.name = 'NotFoundError';
    const result = categorizeError(error, 'requestDevice');

    expect(result.code).toBe('USER_CANCELLED');
    expect(result.level).toBe('info');
    expect(result.message).toBe('デバイス選択ダイアログがキャンセルされました。');
  });

  it('distinguishes permission and security errors', () => {
    const secError = new Error('Access denied');
    secError.name = 'SecurityError';
    const result = categorizeError(secError, 'requestDevice');

    expect(result.code).toBe('PERMISSION_DENIED');
    expect(result.level).toBe('error');
    expect(result.message).toBe('デバイスへのアクセス権限が拒否されたか、ブラウザのセキュリティ設定で制限されています。');

    const notAllowed = new Error('Not allowed by user');
    notAllowed.name = 'NotAllowedError';
    const result2 = categorizeError(notAllowed, 'requestDevice');
    expect(result2.code).toBe('PERMISSION_DENIED');
  });

  it('distinguishes open, close, configuration, claim, and release failures by context', () => {
    const openErr = categorizeError(new Error('Device busy'), 'open');
    expect(openErr.code).toBe('OPEN_FAILED');
    expect(openErr.message).toBe('デバイスを開くことができませんでした。OSドライバが排他利用しているか、他のプロセスが使用中の可能性があります。');

    const closeErr = categorizeError(new Error('Device disconnected during close'), 'close');
    expect(closeErr.code).toBe('CLOSE_FAILED');
    expect(closeErr.message).toBe('デバイスのクローズに失敗しました。');

    const configErr = categorizeError(new Error('Invalid configuration'), 'selectConfiguration');
    expect(configErr.code).toBe('CONFIGURATION_FAILED');
    expect(configErr.message).toBe('コンフィギュレーションの設定に失敗しました。');

    const claimErr = categorizeError(new Error('Unable to claim interface'), 'claimInterface');
    expect(claimErr.code).toBe('CLAIM_FAILED');
    expect(claimErr.message).toBe('インターフェイスの要求（claim）に失敗しました。OSのカーネルドライバがインターフェイスを占有している可能性があります。');

    const releaseErr = categorizeError(new Error('Failed to release'), 'releaseInterface');
    expect(releaseErr.code).toBe('RELEASE_FAILED');
    expect(releaseErr.message).toBe('インターフェイスの解放に失敗しました。');
  });

  it('provides fixed generic UI text without interpolating raw error message', () => {
    const genericErr = categorizeError(new Error('Arbitrary internal driver error 0x80004005'));
    expect(genericErr.message).toBe('USB操作中にエラーが発生しました。');
  });

  it('never retains or leaks error stack traces', () => {
    const errorWithStack = new Error('Sensitive error inside driver stack');
    errorWithStack.stack = 'Error: Sensitive error\n    at /internal/driver.c:123\n    at internalRoutine()';

    const categorized = categorizeError(errorWithStack, 'claimInterface');
    expect((categorized as unknown as { stack?: unknown }).stack).toBeUndefined();
    expect(JSON.stringify(categorized)).not.toContain('/internal/driver.c');

    const entry = createDiagnosticEntry(categorized.level, categorized.code, categorized.message, categorized.details);
    expect((entry as unknown as { stack?: unknown }).stack).toBeUndefined();
    expect(JSON.stringify(entry)).not.toContain('/internal/driver.c');
  });

  it('strictly filters details through an allowlist', () => {
    const rawDetails = {
      errorName: 'NetworkError',
      context: 'claimInterface',
      interfaceNumber: 0,
      disallowedKey: 'SECRET_PAYLOAD',
      arbitraryPath: '/config/secrets.yaml',
      token: 'Bearer xyz123',
    };

    const sanitized = sanitizeDetailsAllowlist(rawDetails);
    expect(sanitized.errorName).toBe('NetworkError');
    expect(sanitized.context).toBe('claimInterface');
    expect(sanitized.interfaceNumber).toBe(0);
    expect('disallowedKey' in sanitized).toBe(false);
    expect('arbitraryPath' in sanitized).toBe(false);
    expect('token' in sanitized).toBe(false);
  });

  describe('Adversarial message sanitization tests', () => {
    const adversarialCases = [
      {
        desc: 'device serial in error message',
        error: new Error('USB claim failed for device serial=PXQ3U499918274 sn=TUNER88219'),
      },
      {
        desc: 'file system paths in error message',
        error: new Error('Cannot access /etc/shadow or C:\\Windows\\System32\\drivers\\tuner.sys'),
      },
      {
        desc: 'auth tokens in error message',
        error: new Error('Failed with token=SYNTHETIC_PRIVATE_TOKEN_MARKER_0000'),
      },
      {
        desc: 'internal URLs with credentials',
        error: new Error('Connection refused to https://admin:password123@internal.corp.lan:8443/usb'),
      },
    ];

    for (const testCase of adversarialCases) {
      it(`never retains or exposes ${testCase.desc}`, () => {
        const categorized = categorizeError(testCase.error, 'claimInterface');
        const serializedCategorized = JSON.stringify(categorized);

        const entry = createDiagnosticEntry(
          categorized.level,
          categorized.code,
          categorized.message,
          categorized.details,
        );
        const serializedEntry = JSON.stringify(entry);

        // Verify none of the adversarial strings are leaked
        expect(serializedCategorized).not.toContain('PXQ3U499918274');
        expect(serializedCategorized).not.toContain('/etc/shadow');
        expect(serializedCategorized).not.toContain('System32');
        expect(serializedCategorized).not.toContain('SYNTHETIC_PRIVATE_TOKEN_MARKER_0000');
        expect(serializedCategorized).not.toContain('password123');

        expect(serializedEntry).not.toContain('PXQ3U499918274');
        expect(serializedEntry).not.toContain('/etc/shadow');
        expect(serializedEntry).not.toContain('System32');
        expect(serializedEntry).not.toContain('SYNTHETIC_PRIVATE_TOKEN_MARKER_0000');
        expect(serializedEntry).not.toContain('password123');

        // Verify UI message is fixed
        expect(categorized.message).toBe('インターフェイスの要求（claim）に失敗しました。OSのカーネルドライバがインターフェイスを占有している可能性があります。');
      });
    }
  });

  describe('Diagnostic log bounds capping (MAX_DIAGNOSTIC_ENTRIES)', () => {
    it('enforces MAX_DIAGNOSTIC_ENTRIES = 200 and drops the oldest entry on the 201st item', () => {
      expect(MAX_DIAGNOSTIC_ENTRIES).toBe(200);

      const logs: ReturnType<typeof createDiagnosticEntry>[] = [];

      // Append 200 items
      for (let i = 1; i <= 200; i++) {
        const entry = createDiagnosticEntry('info', 'SUCCESS', `Entry #${i}`, { index: i });
        appendDiagnosticEntry(logs, entry, MAX_DIAGNOSTIC_ENTRIES);
      }

      expect(logs).toHaveLength(200);
      expect(logs[0].message).toBe('Entry #1');
      expect(logs[199].message).toBe('Entry #200');

      // Append the 201st item
      const entry201 = createDiagnosticEntry('info', 'SUCCESS', 'Entry #201', { index: 201 });
      appendDiagnosticEntry(logs, entry201, MAX_DIAGNOSTIC_ENTRIES);

      // Must remain at exactly 200 items, and oldest (Entry #1) must be dropped
      expect(logs).toHaveLength(200);
      expect(logs[0].message).toBe('Entry #2');
      expect(logs[199].message).toBe('Entry #201');
    });
  });
});
