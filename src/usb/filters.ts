/**
 * WebTS.app - USB Device Filters and Model Label Mapping
 * License: GPL-2.0-only
 */

import type { USBDeviceFilter } from '../types/usb';

export const SUPPORTED_DEVICE_FILTERS: readonly USBDeviceFilter[] = Object.freeze([
  Object.freeze({ vendorId: 0x0511, productId: 0x084a }), // PX-Q3U4
  Object.freeze({ vendorId: 0x3275, productId: 0x0080 }), // PX-S1UD (hardware-confirmed)
  Object.freeze({ vendorId: 0x187f, productId: 0x0600 }), // Siano Rio compatible (hardware-unverified)
  Object.freeze({ vendorId: 0x187f, productId: 0x0302 }), // Siano Rio compatible (hardware-unverified)
]);

export interface DeviceModelInfo {
  readonly label: string;
  readonly description: string;
  readonly isKnown: boolean;
}

export function getDeviceModelInfo(vendorId: number, productId: number): DeviceModelInfo {
  if (vendorId === 0x0511 && productId === 0x084a) {
    return {
      label: 'PLEX PX-Q3U4',
      description: 'PLEX 8ch 地デジ・BS/CS 3波対応チューナー (内蔵スマートカードリーダー搭載)',
      isKnown: true,
    };
  }

  if (vendorId === 0x3275 && productId === 0x0080) {
    return {
      label: 'PLEX PX-S1UD (実機確認済み)',
      description: 'PLEX PX-S1UD USB地上デジタルTVチューナー (ハードウェア確認済みID)',
      isKnown: true,
    };
  }

  if (vendorId === 0x187f && productId === 0x0600) {
    return {
      label: 'Siano Rio 互換デバイス [0x187f:0x0600] (実機未検証)',
      description: 'Siano Rio 互換USB識別子 (ハードウェア実機未検証)',
      isKnown: true,
    };
  }

  if (vendorId === 0x187f && productId === 0x0302) {
    return {
      label: 'Siano Rio 互換デバイス [0x187f:0x0302] (実機未検証)',
      description: 'Siano Rio 互換USB識別子 (ハードウェア実機未検証)',
      isKnown: true,
    };
  }

  const vidHex = vendorId.toString(16).padStart(4, '0');
  const pidHex = productId.toString(16).padStart(4, '0');
  return {
    label: `未知のデバイス (0x${vidHex}:0x${pidHex})`,
    description: 'WebTS.appの対象チューナー定義に含まれていないデバイスです',
    isKnown: false,
  };
}
