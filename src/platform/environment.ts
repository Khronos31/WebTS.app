/**
 * 起動環境が 0.1.0 の前提を満たしているかを、固定の真偽値だけで報告する。
 * デバイスには触れない。`navigator.usb` の有無しか見ず、`getDevices()` も
 * `requestDevice()` も呼ばない。
 */
export interface EnvironmentReport {
  /** WebUSB は secure context を必要とする。 */
  readonly secureContext: boolean;
  /** `navigator.usb` が存在するか。権限の有無とは無関係。 */
  readonly webUsbPresent: boolean;
  /** SharedArrayBuffer を使う pthread ビルドに必要。 */
  readonly crossOriginIsolated: boolean;
  /** 映像は WASM で復号するが、音声は WebCodecs に任せる想定。 */
  readonly webCodecsPresent: boolean;
  /** 番組情報の保持先。 */
  readonly indexedDbPresent: boolean;
}

export function describeEnvironment(): EnvironmentReport {
  return Object.freeze({
    secureContext: typeof isSecureContext === 'boolean' ? isSecureContext : false,
    webUsbPresent: typeof navigator !== 'undefined' && 'usb' in navigator,
    crossOriginIsolated:
      typeof globalThis.crossOriginIsolated === 'boolean'
        ? globalThis.crossOriginIsolated
        : false,
    webCodecsPresent: typeof globalThis.VideoDecoder === 'function',
    indexedDbPresent: typeof globalThis.indexedDB === 'object' && globalThis.indexedDB !== null,
  });
}
