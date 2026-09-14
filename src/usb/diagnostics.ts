/**
 * WebTS.app - Sanitized Diagnostics and Error Categorization
 * License: GPL-2.0-only
 */

import type { DiagnosticCode, DiagnosticEntry, DiagnosticLevel } from '../types/usb';

let diagnosticCounter = 0;

export const MAX_DIAGNOSTIC_ENTRIES = 200;

/**
 * Appends a diagnostic entry to an in-memory log array, capping length
 * at maxEntries and dropping the oldest entry when exceeding the bound.
 */
export function appendDiagnosticEntry(
  logs: DiagnosticEntry[],
  entry: DiagnosticEntry,
  maxEntries: number = MAX_DIAGNOSTIC_ENTRIES,
): DiagnosticEntry[] {
  logs.push(entry);
  if (logs.length > maxEntries) {
    logs.splice(0, logs.length - maxEntries);
  }
  return logs;
}

export function formatTimestamp(date: Date = new Date()): string {
  const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
  const h = pad(date.getHours());
  const m = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  const ms = pad(date.getMilliseconds(), 3);
  return `${h}:${m}:${s}.${ms}`;
}

export function createDiagnosticEntry(
  level: DiagnosticLevel,
  code: DiagnosticCode,
  message: string,
  details?: Record<string, string | number | boolean>,
): DiagnosticEntry {
  diagnosticCounter += 1;
  return {
    id: `diag-${Date.now()}-${diagnosticCounter}`,
    timestamp: formatTimestamp(),
    level,
    code,
    message,
    details: details ? sanitizeDetailsAllowlist(details) : undefined,
  };
}

export interface CategorizedError {
  readonly code: DiagnosticCode;
  readonly level: DiagnosticLevel;
  readonly message: string;
  readonly details: Record<string, string | number | boolean>;
}

const ALLOWED_DETAIL_KEYS = new Set([
  'errorName',
  'context',
  'interfaceNumber',
  'configurationValue',
  'vendorId',
  'productId',
  'model',
  'isSmartCardCcid',
]);

/**
 * Ensures details only contain allowlisted metadata keys, preventing arbitrary
 * error strings, paths, tokens, or serials from being retained.
 */
export function sanitizeDetailsAllowlist(
  details: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  const sanitized: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(details)) {
    if (ALLOWED_DETAIL_KEYS.has(key)) {
      if (typeof value === 'number' || typeof value === 'boolean') {
        sanitized[key] = value;
      } else if (typeof value === 'string') {
        // Only allow safe alphanumeric / identifier characters
        sanitized[key] = value.replace(/[^a-zA-Z0-9_\-.:# ]/g, '').slice(0, 100);
      }
    }
  }
  return Object.freeze(sanitized);
}

/**
 * Sanitizes and categorizes errors into safe, human-readable diagnostics.
 * PRIVACY & SECURITY CONTRACT:
 * - Never returns or retains err.stack.
 * - Never retains or displays arbitrary raw exception messages.
 * - All UI messages are fixed, deterministic strings.
 * - Details only use an allowlist (e.g. errorName, context).
 * - Distinguishes cancellation, permission errors, open failure, close failure, claim failure, etc.
 */
export function categorizeError(error: unknown, context?: string): CategorizedError {
  const errorObj = typeof error === 'object' && error !== null ? error : {};
  const rawErrorName = 'name' in errorObj && typeof errorObj.name === 'string' ? errorObj.name : 'Error';
  const rawMessage = 'message' in errorObj && typeof errorObj.message === 'string'
    ? errorObj.message
    : (typeof error === 'string' ? error : '');

  // Sanitize errorName to standard identifier
  const errorName = /^[a-zA-Z0-9_]+$/.test(rawErrorName) && rawErrorName.length <= 50
    ? rawErrorName
    : 'Error';

  const details: Record<string, string | number | boolean> = {
    errorName,
  };
  if (context && /^[a-zA-Z0-9_\-]+$/.test(context)) {
    details.context = context;
  }

  const msgLower = rawMessage.toLowerCase();

  // 1. User cancellation
  if (
    errorName === 'NotFoundError' ||
    msgLower.includes('no device selected') ||
    msgLower.includes('user cancelled') ||
    msgLower.includes('cancelled')
  ) {
    return {
      code: 'USER_CANCELLED',
      level: 'info',
      message: 'デバイス選択ダイアログがキャンセルされました。',
      details: sanitizeDetailsAllowlist(details),
    };
  }

  // 2. Permission / Security errors
  if (
    errorName === 'SecurityError' ||
    errorName === 'NotAllowedError' ||
    msgLower.includes('access denied') ||
    msgLower.includes('permission denied') ||
    msgLower.includes('feature policy')
  ) {
    return {
      code: 'PERMISSION_DENIED',
      level: 'error',
      message: 'デバイスへのアクセス権限が拒否されたか、ブラウザのセキュリティ設定で制限されています。',
      details: sanitizeDetailsAllowlist(details),
    };
  }

  // 3. Close failure
  if (context === 'close' || msgLower.includes('close device') || msgLower.includes('failed to close')) {
    return {
      code: 'CLOSE_FAILED',
      level: 'error',
      message: 'デバイスのクローズに失敗しました。',
      details: sanitizeDetailsAllowlist(details),
    };
  }

  // 4. Open failure
  if (context === 'open' || msgLower.includes('open device') || msgLower.includes('failed to open')) {
    return {
      code: 'OPEN_FAILED',
      level: 'error',
      message: 'デバイスを開くことができませんでした。OSドライバが排他利用しているか、他のプロセスが使用中の可能性があります。',
      details: sanitizeDetailsAllowlist(details),
    };
  }

  // 5. Configuration failure
  if (
    context === 'selectConfiguration' ||
    msgLower.includes('configuration')
  ) {
    return {
      code: 'CONFIGURATION_FAILED',
      level: 'error',
      message: 'コンフィギュレーションの設定に失敗しました。',
      details: sanitizeDetailsAllowlist(details),
    };
  }

  // 6. Claim failure
  if (
    context === 'claimInterface' ||
    msgLower.includes('claim')
  ) {
    return {
      code: 'CLAIM_FAILED',
      level: 'error',
      message: 'インターフェイスの要求（claim）に失敗しました。OSのカーネルドライバがインターフェイスを占有している可能性があります。',
      details: sanitizeDetailsAllowlist(details),
    };
  }

  // 7. Release failure
  if (
    context === 'releaseInterface' ||
    msgLower.includes('release')
  ) {
    return {
      code: 'RELEASE_FAILED',
      level: 'error',
      message: 'インターフェイスの解放に失敗しました。',
      details: sanitizeDetailsAllowlist(details),
    };
  }

  // Generic fallback: FIXED UI text, no interpolation of arbitrary exception message
  return {
    code: 'OPEN_FAILED',
    level: 'error',
    message: 'USB操作中にエラーが発生しました。',
    details: sanitizeDetailsAllowlist(details),
  };
}
