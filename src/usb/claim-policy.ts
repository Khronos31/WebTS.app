/**
 * WebTS.app - USB Interface Claim Policy
 * License: GPL-2.0-only
 */

import type { USBInterfaceLike } from '../types/usb';

export const USB_CLASS_SMART_CARD_CCID = 0x0b;
export const USB_CLASS_VENDOR_SPECIFIC = 0xff;

export interface ClaimEvaluation {
  readonly allowed: boolean;
  readonly reason: string;
  readonly isVendorSpecific: boolean;
  readonly isSmartCardCcid: boolean;
}

/**
 * Evaluates whether a given USB interface may be claimed by WebTS.app M0.
 * Policy:
 * - Vendor-specific class (0xff) ONLY is allowed.
 * - CCID / Smart Card class (0x0b) is strictly FORBIDDEN.
 * - Any other standard class is disallowed.
 */
export function evaluateInterfaceClaimability(iface: USBInterfaceLike): ClaimEvaluation {
  const alternates = iface.alternates && iface.alternates.length > 0
    ? iface.alternates
    : iface.alternate
      ? [iface.alternate]
      : [];

  if (alternates.length === 0) {
    return {
      allowed: false,
      reason: 'インターフェイスに代替設定（alternate）が存在しません',
      isVendorSpecific: false,
      isSmartCardCcid: false,
    };
  }

  // Check if any alternate contains Smart Card / CCID class
  const hasCcid = alternates.some((alt) => alt.interfaceClass === USB_CLASS_SMART_CARD_CCID);
  if (hasCcid) {
    return {
      allowed: false,
      reason: 'スマートカード / CCID クラス (0x0b) は保護対象のため WebTS.app からの要求は禁止されています',
      isVendorSpecific: false,
      isSmartCardCcid: true,
    };
  }

  // Check if EVERY alternate is Vendor Specific (0xff)
  const allVendorSpecific = alternates.every((alt) => alt.interfaceClass === USB_CLASS_VENDOR_SPECIFIC);
  if (allVendorSpecific) {
    return {
      allowed: true,
      reason: 'すべての代替設定がベンダー固有クラス (0xff) のため要求可能です',
      isVendorSpecific: true,
      isSmartCardCcid: false,
    };
  }

  // Non-vendor or mixed classes
  const nonVendorClasses = alternates
    .filter((alt) => alt.interfaceClass !== USB_CLASS_VENDOR_SPECIFIC)
    .map((alt) => `0x${alt.interfaceClass.toString(16).padStart(2, '0')}`)
    .join(', ');

  const hasVendor = alternates.some((alt) => alt.interfaceClass === USB_CLASS_VENDOR_SPECIFIC);
  return {
    allowed: false,
    reason: hasVendor
      ? `非ベンダー固有クラス (${nonVendorClasses}) が混在しているため要求できません`
      : `非ベンダー固有クラス (${nonVendorClasses}) のインターフェイスは安全のため要求できません`,
    isVendorSpecific: hasVendor,
    isSmartCardCcid: false,
  };
}
