// 実機の WebUSB デバイスを、同梱した上流 px4::userland::group_q3u4_devices()
// へそのまま渡す。判定ロジックはブラウザ側に書かない。
//
// serial は上流の grouping が base_serial と dev_id を取り出すために必要なので
// 読み取って ABI へ渡すが、表示・記録・送信はしない。ABI も serial を返さない。

interface GroupingModule {
  ccall(name: string, returnType: 'number', argTypes: readonly string[], args: readonly number[]): number;
  _malloc(size: number): number;
  _free(pointer: number): void;
  readonly HEAPU8: Uint8Array;
}

/** px4/identity.h の UsbSpeed と同じ並び。 */
const SPEED = Object.freeze({
  unknown: 0, low: 1, full: 2, high: 3, super: 4, superPlus: 5, superPlusX2: 6,
});

/** px4/identity.h の EndpointType。bulk 以外は other 扱い。 */
const ENDPOINT_TYPE_BULK = 2;

export const PX4_ERROR = Object.freeze<Record<number, string>>({
  0: 'OK', 1: 'INVALID_ARGUMENT', 2: 'VERSION_MISMATCH', 3: 'NOT_FOUND', 4: 'BUSY',
  5: 'NOT_READY', 6: 'TIMEOUT', 7: 'USB_IO', 8: 'DISCONNECTED', 9: 'PROTOCOL_ERROR',
  10: 'FIRMWARE_REJECTED', 11: 'UNSUPPORTED', 12: 'NO_CARD', 13: 'CARD_REMOVED',
  14: 'BUFFER_TOO_SMALL', 15: 'SLOW_CONSUMER', 255: 'INTERNAL',
});

export const GROUP_STATUS = Object.freeze<Record<number, string>>({
  0: 'ready', 1: 'incomplete', 2: 'duplicate', 3: 'invalid_observation',
});

export const OBSERVATION_STATUS = Object.freeze<Record<number, string>>({
  0: 'usable', 1: 'unsupported', 2: 'invalid_serial', 3: 'insufficient_speed',
  4: 'invalid_topology', 5: 'open_failed',
});

export interface GroupingSummary {
  readonly error: string;
  readonly groupCount: number;
  readonly readyGroups: number;
  readonly incompleteGroups: number;
  readonly rejectedCount: number;
  readonly firstRejectedStatus: string | null;
  readonly group0Status: string | null;
  readonly group0Slot1Present: boolean | null;
  readonly group0Slot2Present: boolean | null;
  readonly usableObservations: number;
}

/**
 * WebUSB は negotiated speed を公開しないが、bulk の最大パケットサイズから
 * 一意に決まる。USB 2.0 仕様で bulk は full speed なら 8/16/32/64、high speed
 * なら 512、SuperSpeed なら 1024 と定められているため、観測値からの導出であって
 * 決め打ちではない。遅いポートに挿された場合は full と導出され、上流が
 * insufficient_speed で正しく弾く。
 */
export function deriveSpeed(device: USBDevice): number {
  let largestBulk = 0;
  for (const configuration of device.configurations) {
    for (const iface of configuration.interfaces) {
      for (const alternate of iface.alternates) {
        for (const endpoint of alternate.endpoints) {
          if (endpoint.type === 'bulk' && endpoint.packetSize > largestBulk) {
            largestBulk = endpoint.packetSize;
          }
        }
      }
    }
  }
  if (largestBulk >= 1024) return SPEED.super;
  if (largestBulk === 512) return SPEED.high;
  if (largestBulk > 0) return SPEED.full;
  return SPEED.unknown;
}

function encode(devices: readonly USBDevice[]): Uint8Array {
  const parts: number[] = [];
  const u8 = (value: number) => parts.push(value & 0xff);
  const u16 = (value: number) => { u8(value); u8(value >>> 8); };
  const u32 = (value: number) => { u16(value); u16(value >>> 16); };

  u32(devices.length);
  for (const device of devices) {
    u16(device.vendorId);
    u16(device.productId);
    u8(deriveSpeed(device));
    const serial = new TextEncoder().encode(device.serialNumber ?? '');
    u8(serial.length);
    for (const byte of serial) u8(byte);

    const configuration = device.configuration ?? device.configurations[0];
    const interfaces = configuration?.interfaces ?? [];
    u8(interfaces.length);
    for (const iface of interfaces) {
      u8(iface.interfaceNumber);
      u8(iface.alternate.alternateSetting);
      u8(iface.alternate.endpoints.length);
      for (const endpoint of iface.alternate.endpoints) {
        // 上流は 0x81 のような address 表現を見る。WebUSB は番号と向きに
        // 分かれているので、USB の address バイトへ戻す。
        const address = endpoint.endpointNumber | (endpoint.direction === 'in' ? 0x80 : 0x00);
        u8(address);
        u8(endpoint.type === 'bulk' ? ENDPOINT_TYPE_BULK : 0);
        u16(endpoint.packetSize);
      }
    }
  }
  return Uint8Array.from(parts);
}

export async function groupQ3U4Devices(
  module: GroupingModule,
  devices: readonly USBDevice[],
): Promise<GroupingSummary> {
  const input = encode(devices);
  const words = module.ccall('webts_px4_identity_output_words', 'number', [], []);
  const inputPointer = module._malloc(Math.max(input.length, 1));
  const outputPointer = module._malloc(words * 4);
  try {
    module.HEAPU8.set(input, inputPointer);
    module.ccall(
      'webts_px4_group_q3u4', 'number',
      ['number', 'number', 'number', 'number'],
      [inputPointer, input.length, outputPointer, words],
    );
    const view = new DataView(
      module.HEAPU8.buffer as ArrayBuffer, module.HEAPU8.byteOffset + outputPointer, words * 4,
    );
    const at = (index: number) => view.getInt32(index * 4, true);
    const optional = (index: number) => (at(index) < 0 ? null : at(index));
    const slot1 = optional(7);
    const slot2 = optional(8);
    return Object.freeze({
      error: PX4_ERROR[at(0)] ?? `UNKNOWN_${at(0)}`,
      groupCount: at(1),
      readyGroups: at(2),
      incompleteGroups: at(3),
      rejectedCount: at(4),
      firstRejectedStatus: at(5) < 0 ? null : (OBSERVATION_STATUS[at(5)] ?? `UNKNOWN_${at(5)}`),
      group0Status: at(6) < 0 ? null : (GROUP_STATUS[at(6)] ?? `UNKNOWN_${at(6)}`),
      group0Slot1Present: slot1 === null ? null : slot1 === 1,
      group0Slot2Present: slot2 === null ? null : slot2 === 1,
      usableObservations: at(9),
    });
  } finally {
    // serial を含む入力バッファは読み取り後に必ず消す。
    module.HEAPU8.fill(0, inputPointer, inputPointer + Math.max(input.length, 1));
    module.HEAPU8.fill(0, outputPointer, outputPointer + words * 4);
    module._free(inputPointer);
    module._free(outputPointer);
  }
}
