// SDT と NIT から、その物理チャンネルに載っているサービスを読む。
//
// チャンネルスキャンに要るのはこれだけである。**EIT は読まない。**0.1.0 の
// 番組情報は後回しで、まず「何が映るか」を確定させる。
//
// 扱う範囲は地上デジタルに要るものだけで、汎用の SI パーサではない。
//   - SDT actual (table_id 0x42) のみ。other (0x46) は他局の情報で、
//     選局し直さないと信用できないので読まない。
//   - NIT actual (table_id 0x40) のみ。
//   - 記述子はサービス記述子 (0x48) と TS 情報記述子 (0xCD) だけ。
//
// **地上分配システム記述子 (0xFA) からは物理チャンネルを読まない。**
// 一度読んでいたが、記述子の先頭 2 バイト（area_code 12bit + guard_interval 2bit
// + transmission_mode 2bit）を飛ばし忘れて周波数を 2 バイトずれた位置から
// 読んでおり、NHK 総合が ch16、フジテレビが ch19 のように全部ずれていた。
// 結果として死んだ周波数へ選局し、視聴が始まらなかった。
//
// そもそも**どの物理チャンネルを選局したかは呼び出し側が知っている**。
// 放送側の申告を読み直す必要が無く、読めば間違える余地が増えるだけである。
//
// 文字列は ARIB STD-B24 の8単位符号系で入っている。JIS X 0208 と外字を含むので
// 自前で変換せず、字幕と同じ `aribb24.js` に解かせる。

import { PacketAligner, PACKET_SIZE, crc32 } from './demux';

const SDT_PID = 0x0011;
const NIT_PID = 0x0010;
const SDT_ACTUAL = 0x42;
const NIT_ACTUAL = 0x40;

export interface ServiceEntry {
  readonly networkId: number;
  readonly transportStreamId: number;
  readonly serviceId: number;
  /** サービス形式種別。0x01 がデジタルTV、0xA5 が臨時映像など。 */
  readonly serviceType: number;
  readonly providerName: string;
  readonly serviceName: string;
}

export interface NetworkEntry {
  readonly networkId: number;
  readonly transportStreamId: number;
  readonly originalNetworkId: number;
  /** TS 情報記述子の remote_control_key_id。リモコン番号。無ければ null。 */
  readonly remoteControlKeyId: number | null;
  /** TS 情報記述子の ts_name。 */
  readonly tsName: string;
}

export interface ServiceInfoHandlers {
  /**
   * NIT actual を待つか。
   *
   * **衛星では待たない。**BS の NIT は巨大で送出間隔が長く、1局あたりの
   * 走査時間では届かない。実測で SDT actual が 23 回届くあいだ NIT actual は
   * 0 回だった。待つと、サービスは読めているのに何も残らない。
   *
   * NIT から取っているのはリモコン番号と TS 名だけで、局の識別に要る
   * network_id と transport_stream_id は SDT のセクションにも入っている。
   */
  readonly requireNetwork?: boolean | undefined;
  readonly onServices?: ((services: readonly ServiceEntry[]) => void) | undefined;
  readonly onNetwork?: ((network: NetworkEntry) => void) | undefined;
  /** ARIB の8単位符号系を文字列にする。呼び出し側が aribb24.js を渡す。 */
  readonly decodeText: (bytes: Uint8Array) => string;
}

/** PSI section の組み立て。demux.ts のものと同じ規則で、こちらは PID 2本ぶん。 */
class SectionAssembler {
  #buffer = new Uint8Array(0);
  #wanted = 0;

  feed(payload: Uint8Array, payloadUnitStart: boolean): Uint8Array[] {
    const done: Uint8Array[] = [];
    let offset = 0;
    if (payloadUnitStart) {
      const pointer = payload[0] ?? 0;
      const tail = payload.subarray(1, 1 + pointer);
      if (this.#wanted > 0 && tail.length > 0) {
        this.#append(tail);
        const finished = this.#take();
        if (finished !== null) done.push(finished);
      }
      this.#buffer = new Uint8Array(0);
      this.#wanted = 0;
      offset = 1 + pointer;
    } else if (this.#wanted === 0) {
      return done;
    }

    while (offset < payload.length) {
      if (this.#wanted === 0) {
        if (payload[offset] === 0xff) break;
        if (payload.length - offset < 3) break;
        const length = (((payload[offset + 1] ?? 0) & 0x0f) << 8) | (payload[offset + 2] ?? 0);
        this.#wanted = length + 3;
      }
      const need = this.#wanted - this.#buffer.length;
      const available = Math.min(need, payload.length - offset);
      this.#append(payload.subarray(offset, offset + available));
      offset += available;
      const finished = this.#take();
      if (finished !== null) done.push(finished);
      else break;
    }
    return done;
  }

  #append(bytes: Uint8Array): void {
    const merged = new Uint8Array(this.#buffer.length + bytes.length);
    merged.set(this.#buffer);
    merged.set(bytes, this.#buffer.length);
    this.#buffer = merged;
  }

  #take(): Uint8Array | null {
    if (this.#wanted === 0 || this.#buffer.length < this.#wanted) return null;
    const section = this.#buffer.subarray(0, this.#wanted);
    this.#buffer = new Uint8Array(0);
    this.#wanted = 0;
    return section;
  }
}

export class ServiceInfoReader {
  readonly #handlers: ServiceInfoHandlers;
  readonly #sdt = new SectionAssembler();
  readonly #nit = new SectionAssembler();
  readonly #services = new Map<number, ServiceEntry>();
  #network: NetworkEntry | null = null;
  readonly #aligner = new PacketAligner();
  #sdtVersion = -1;
  #nitVersion = -1;
  /** 計測用。どこで読み捨てているかを数える。 */
  readonly stats = {
    bytes: 0, packets: 0, noSync: 0, tei: 0, sdtPackets: 0, sdtSections: 0, notActual: 0, crcErrors: 0,
    sameVersion: 0, decodeErrors: 0,
  };

  constructor(handlers: ServiceInfoHandlers) {
    this.#handlers = handlers;
  }

  get services(): readonly ServiceEntry[] {
    return [...this.#services.values()];
  }

  get network(): NetworkEntry | null {
    return this.#network;
  }

  /** 揃ったかどうか。スキャンはこれが立った時点で次の物理チャンネルへ進める。 */
  get complete(): boolean {
    if (this.#services.size === 0) return false;
    return this.#handlers.requireNetwork === false || this.#network !== null;
  }

  push(chunk: Uint8Array): void {
    this.stats.bytes += chunk.length;
    this.#aligner.push(chunk, (packet) => { this.#packet(packet); });
  }

  #packet(packet: Uint8Array): void {
    this.stats.packets += 1;
    if (packet[0] !== 0x47) { this.stats.noSync += 1; return; }
    const second = packet[1] ?? 0;
    if ((second & 0x80) !== 0) { this.stats.tei += 1; return; }
    const pid = ((second & 0x1f) << 8) | (packet[2] ?? 0);
    if (pid !== SDT_PID && pid !== NIT_PID) return;
    const third = packet[3] ?? 0;
    if ((third & 0xc0) !== 0) return;
    if ((third & 0x10) === 0) return;

    let start = 4;
    if ((third & 0x20) !== 0) {
      start += 1 + (packet[4] ?? 0);
      if (start >= PACKET_SIZE) return;
    }
    const payload = packet.subarray(start);
    const unitStart = (second & 0x40) !== 0;
    const assembler = pid === SDT_PID ? this.#sdt : this.#nit;
    if (pid === SDT_PID) this.stats.sdtPackets += 1;
    for (const section of assembler.feed(payload, unitStart)) {
      if (pid === SDT_PID) this.#onSdt(section);
      else this.#onNit(section);
    }
  }

  #onSdt(section: Uint8Array): void {
    this.stats.sdtSections += 1;
    if (section[0] !== SDT_ACTUAL || section.length < 15) { this.stats.notActual += 1; return; }
    if (crc32(section) !== 0) { this.stats.crcErrors += 1; return; }
    if (((section[5] ?? 0) & 0x01) === 0) return;
    const version = ((section[5] ?? 0) >> 1) & 0x1f;
    if (version === this.#sdtVersion) { this.stats.sameVersion += 1; return; }
    this.#sdtVersion = version;

    const transportStreamId = ((section[3] ?? 0) << 8) | (section[4] ?? 0);
    const networkId = ((section[8] ?? 0) << 8) | (section[9] ?? 0);
    let offset = 11;
    const end = section.length - 4;
    while (offset + 5 <= end) {
      const serviceId = ((section[offset] ?? 0) << 8) | (section[offset + 1] ?? 0);
      const loopLength = (((section[offset + 3] ?? 0) & 0x0f) << 8) | (section[offset + 4] ?? 0);
      const descriptors = section.subarray(offset + 5, offset + 5 + loopLength);
      const service = this.#readServiceDescriptor(descriptors);
      if (service !== null) {
        this.#services.set(serviceId, {
          networkId, transportStreamId, serviceId,
          serviceType: service.serviceType,
          providerName: service.providerName,
          serviceName: service.serviceName,
        });
      }
      offset += 5 + loopLength;
    }
    if (this.#services.size > 0) this.#handlers.onServices?.(this.services);
  }

  /** サービス記述子 (0x48)。 */
  #readServiceDescriptor(descriptors: Uint8Array): {
    serviceType: number; providerName: string; serviceName: string;
  } | null {
    let offset = 0;
    while (offset + 2 <= descriptors.length) {
      const tag = descriptors[offset] ?? 0;
      const length = descriptors[offset + 1] ?? 0;
      const body = descriptors.subarray(offset + 2, offset + 2 + length);
      if (tag === 0x48 && body.length >= 3) {
        const serviceType = body[0] ?? 0;
        const providerLength = body[1] ?? 0;
        const provider = body.subarray(2, 2 + providerLength);
        const nameLength = body[2 + providerLength] ?? 0;
        const name = body.subarray(3 + providerLength, 3 + providerLength + nameLength);
        return {
          serviceType,
          providerName: this.#handlers.decodeText(provider),
          serviceName: this.#handlers.decodeText(name),
        };
      }
      offset += 2 + length;
    }
    return null;
  }

  #onNit(section: Uint8Array): void {
    if (section[0] !== NIT_ACTUAL || section.length < 16) return;
    if (crc32(section) !== 0) return;
    if (((section[5] ?? 0) & 0x01) === 0) return;
    const version = ((section[5] ?? 0) >> 1) & 0x1f;
    if (version === this.#nitVersion) return;
    this.#nitVersion = version;

    const networkId = ((section[3] ?? 0) << 8) | (section[4] ?? 0);
    const networkDescriptorsLength =
      (((section[8] ?? 0) & 0x0f) << 8) | (section[9] ?? 0);
    let offset = 10 + networkDescriptorsLength + 2;
    const end = section.length - 4;
    while (offset + 6 <= end) {
      const transportStreamId = ((section[offset] ?? 0) << 8) | (section[offset + 1] ?? 0);
      const originalNetworkId = ((section[offset + 2] ?? 0) << 8) | (section[offset + 3] ?? 0);
      const loopLength = (((section[offset + 4] ?? 0) & 0x0f) << 8) | (section[offset + 5] ?? 0);
      const descriptors = section.subarray(offset + 6, offset + 6 + loopLength);
      const info = this.#readTransportDescriptors(descriptors);
      this.#network = {
        networkId, transportStreamId, originalNetworkId,
        remoteControlKeyId: info.remoteControlKeyId,
        tsName: info.tsName,
      };
      this.#handlers.onNetwork?.(this.#network);
      offset += 6 + loopLength;
    }
  }

  /** TS 情報記述子 (0xCD)。リモコン番号と TS 名だけを取る。 */
  #readTransportDescriptors(descriptors: Uint8Array): {
    remoteControlKeyId: number | null; tsName: string;
  } {
    let remoteControlKeyId: number | null = null;
    let tsName = '';
    let offset = 0;
    while (offset + 2 <= descriptors.length) {
      const tag = descriptors[offset] ?? 0;
      const length = descriptors[offset + 1] ?? 0;
      const body = descriptors.subarray(offset + 2, offset + 2 + length);
      if (tag === 0xcd && body.length >= 2) {
        remoteControlKeyId = body[0] ?? null;
        const lengthOfTsName = ((body[1] ?? 0) >> 2) & 0x3f;
        tsName = this.#handlers.decodeText(body.subarray(2, 2 + lengthOfTsName));
      }
      offset += 2 + length;
    }
    return { remoteControlKeyId, tsName };
  }
}
