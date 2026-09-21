// MPEG-2 TS の分離。PAT/PMT を追い、選んだ PID の PES を組み立てる。
//
// ここは上流に相当するものが無い。px4-userland の `tagged_ts_demux` は
// USB の wire tag を剥がして受信機ごとに分ける層で、PSI も PES も見ない。
// libaribb25 の `ts_section_parser` は section を組むが、facade の内部で
// 使われていて外へ出ていない。したがってこれは自前である。
//
// 扱う範囲を先に書いておく。**地上デジタルの live 視聴に要るものだけ**で、
// 汎用の TS パーサではない。
//   - 188 バイト固定。204 バイト（RS 付き）は扱わない。
//   - PSI は PAT と PMT のみ。NIT/SDT/EIT は読まない（番組表は 0.1.0 の対象外）。
//   - section は1パケットに収まらない場合を跨いで組み立てる。
//   - PES は PTS/DTS を取り出し、payload を連結して返す。
//   - scrambling control が立った packet は捨てる。復号は B25 の仕事であり、
//     ここへ来る時点で落ちているべきものである。
//
// CRC32 は検査する。放送の PSI は壊れることがあり、壊れた PMT を信じると
// 存在しない PID を選んでしまう。

export const PACKET_SIZE = 188;
const SYNC_BYTE = 0x47;
const NULL_PID = 0x1fff;
const PAT_PID = 0x0000;

/** ARIB で実際に出てくるものだけ。網羅ではない。 */
export const STREAM_TYPE = Object.freeze({
  mpeg2Video: 0x02,
  /** ADTS AAC (ISO/IEC 13818-7)。地デジの音声はこれ。 */
  adtsAac: 0x0f,
  /** PES 私用データ。ARIB STD-B24 の字幕・文字スーパーはここ。 */
  privateData: 0x06,
  /** データ放送のカルーセル。 */
  dataCarousel: 0x0d,
});

export interface ElementaryStream {
  readonly pid: number;
  readonly streamType: number;
  /** stream_identifier_descriptor の component_tag。無ければ null。 */
  readonly componentTag: number | null;
}

export interface Program {
  readonly programNumber: number;
  readonly pmtPid: number;
  readonly pcrPid: number;
  readonly streams: readonly ElementaryStream[];
}

export interface PesPacket {
  readonly pid: number;
  readonly streamId: number;
  /** 90kHz 単位。無ければ null。33bit なので Number で表せる。 */
  readonly pts: number | null;
  readonly dts: number | null;
  /** PES ヘッダを外した中身。呼び出し側へ渡したあとは再利用しない。 */
  readonly data: Uint8Array;
}

export interface DemuxCounters {
  packets: number;
  /** sync byte が 0x47 でなかった packet。 */
  badSync: number;
  /** transport_error_indicator が立っていた packet。 */
  errored: number;
  /** まだ復号されていない packet。ここへ来ること自体が異常。 */
  scrambled: number;
  /** continuity_counter が飛んだ回数。 */
  continuityErrors: number;
  /** CRC32 が合わなかった section。 */
  badSections: number;
  nullPackets: number;
}

/** PSI section の組み立て。pointer_field と複数パケットに跨る場合を扱う。 */
class SectionAssembler {
  #buffer: Uint8Array = new Uint8Array(0);
  #wanted = 0;

  /** payload を投入し、完成した section があれば返す。 */
  feed(payload: Uint8Array, payloadUnitStart: boolean): Uint8Array[] {
    const done: Uint8Array[] = [];
    let offset = 0;
    if (payloadUnitStart) {
      // 先頭バイトは pointer_field。その分だけ前の section の続きが入る。
      const pointer = payload[0] ?? 0;
      const tail = payload.subarray(1, 1 + pointer);
      if (this.#wanted > 0 && tail.length > 0) {
        this.#append(tail);
        const finished = this.#take();
        if (finished !== null) done.push(finished);
      }
      this.#reset();
      offset = 1 + pointer;
    } else if (this.#wanted === 0) {
      // 続きを待っていないのに続きが来た。開始を待つ。
      return done;
    }

    while (offset < payload.length) {
      if (this.#wanted === 0) {
        // stuffing。以降は全部 0xff。
        if (payload[offset] === 0xff) break;
        if (payload.length - offset < 3) break;
        const length = (((payload[offset + 1] ?? 0) & 0x0f) << 8) | (payload[offset + 2] ?? 0);
        this.#wanted = length + 3;
        this.#buffer = new Uint8Array(0);
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

  #reset(): void {
    this.#buffer = new Uint8Array(0);
    this.#wanted = 0;
  }
}

/** PES の組み立て。PES_packet_length が 0 の映像は次の開始まで続く。 */
class PesAssembler {
  #chunks: Uint8Array[] = [];
  #length = 0;
  #wanted = 0;
  #started = false;

  feed(payload: Uint8Array, payloadUnitStart: boolean): Uint8Array[] {
    const done: Uint8Array[] = [];
    if (payloadUnitStart) {
      const previous = this.#take();
      if (previous !== null) done.push(previous);
      this.#started = true;
      this.#chunks = [];
      this.#length = 0;
      // PES_packet_length は 6 バイト目から2バイト。0 は「長さ未指定」で、
      // 映像の PES では普通に使われる。その場合は次の開始まで溜める。
      const declared = payload.length >= 6
        ? (((payload[4] ?? 0) << 8) | (payload[5] ?? 0))
        : 0;
      this.#wanted = declared === 0 ? 0 : declared + 6;
    }
    if (!this.#started) return done;
    this.#chunks.push(payload);
    this.#length += payload.length;
    if (this.#wanted > 0 && this.#length >= this.#wanted) {
      const finished = this.#take();
      if (finished !== null) done.push(finished);
    }
    return done;
  }

  /** ストリーム終端で、溜まっているぶんを出す。 */
  flush(): Uint8Array | null {
    return this.#take();
  }

  #take(): Uint8Array | null {
    if (!this.#started || this.#length === 0) return null;
    const merged = new Uint8Array(this.#length);
    let offset = 0;
    for (const chunk of this.#chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.#chunks = [];
    this.#length = 0;
    this.#started = false;
    return this.#wanted > 0 ? merged.subarray(0, this.#wanted) : merged;
  }
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index << 24;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 0x8000_0000) !== 0 ? (value << 1) ^ 0x04c1_1db7 : value << 1;
    }
    table[index] = value;
  }
  return table;
})();

/** MPEG-2 PSI の CRC32。値そのものではなく 0 になることを見る。 */
export function crc32(bytes: Uint8Array): number {
  let crc = -1;
  for (const byte of bytes) {
    crc = (crc << 8) ^ (CRC_TABLE[((crc >>> 24) ^ byte) & 0xff] ?? 0);
  }
  return crc >>> 0;
}

export interface DemuxerHandlers {
  /** PAT と PMT が揃って構成が確定・変化したとき。 */
  onPrograms?: (programs: readonly Program[]) => void;
  onPes?: (packet: PesPacket) => void;
}

export class TsDemuxer {
  readonly #handlers: DemuxerHandlers;
  readonly #sections = new Map<number, SectionAssembler>();
  readonly #pes = new Map<number, PesAssembler>();
  readonly #continuity = new Map<number, number>();
  /** PMT PID → program_number */
  #pmtPids = new Map<number, number>();
  #programs = new Map<number, Program>();
  #selected = new Set<number>();
  #patVersion = -1;
  readonly #pmtVersions = new Map<number, number>();
  readonly #counters: DemuxCounters = {
    packets: 0, badSync: 0, errored: 0, scrambled: 0,
    continuityErrors: 0, badSections: 0, nullPackets: 0,
  };
  /** 188 の倍数で切れなかった端。次の push の先頭に繋ぐ。 */
  #remainder = new Uint8Array(0);

  constructor(handlers: DemuxerHandlers = {}) {
    this.#handlers = handlers;
  }

  get counters(): Readonly<DemuxCounters> {
    return this.#counters;
  }

  get programs(): readonly Program[] {
    return [...this.#programs.values()];
  }

  /** この PID の PES だけを組み立てる。空なら PES は一切出さない。 */
  select(pids: Iterable<number>): void {
    this.#selected = new Set(pids);
    for (const pid of [...this.#pes.keys()]) {
      if (!this.#selected.has(pid)) this.#pes.delete(pid);
    }
  }

  push(chunk: Uint8Array): void {
    let data = chunk;
    if (this.#remainder.length > 0) {
      const merged = new Uint8Array(this.#remainder.length + chunk.length);
      merged.set(this.#remainder);
      merged.set(chunk, this.#remainder.length);
      data = merged;
      this.#remainder = new Uint8Array(0);
    }
    let offset = 0;
    for (; offset + PACKET_SIZE <= data.length; offset += PACKET_SIZE) {
      this.#packet(data.subarray(offset, offset + PACKET_SIZE));
    }
    if (offset < data.length) this.#remainder = data.slice(offset);
  }

  /** 終端。溜まっている PES を出し切る。 */
  flush(): void {
    for (const [pid, assembler] of this.#pes) {
      const finished = assembler.flush();
      if (finished !== null) this.#emitPes(pid, finished);
    }
  }

  #packet(packet: Uint8Array): void {
    this.#counters.packets += 1;
    if (packet[0] !== SYNC_BYTE) {
      this.#counters.badSync += 1;
      return;
    }
    const second = packet[1] ?? 0;
    if ((second & 0x80) !== 0) {
      this.#counters.errored += 1;
      return;
    }
    const pid = ((second & 0x1f) << 8) | (packet[2] ?? 0);
    if (pid === NULL_PID) {
      this.#counters.nullPackets += 1;
      return;
    }
    const third = packet[3] ?? 0;
    if ((third & 0xc0) !== 0) {
      // 復号済みのはずのものが暗号化されている。組み立てても意味がない。
      this.#counters.scrambled += 1;
      return;
    }

    const hasPayload = (third & 0x10) !== 0;
    const hasAdaptation = (third & 0x20) !== 0;
    const counter = third & 0x0f;
    if (hasPayload) {
      const previous = this.#continuity.get(pid);
      if (previous !== undefined && counter !== ((previous + 1) & 0x0f)) {
        this.#counters.continuityErrors += 1;
      }
      this.#continuity.set(pid, counter);
    }
    if (!hasPayload) return;

    let start = 4;
    if (hasAdaptation) {
      start += 1 + (packet[4] ?? 0);
      if (start >= PACKET_SIZE) return;
    }
    const payload = packet.subarray(start);
    const payloadUnitStart = (second & 0x40) !== 0;

    if (pid === PAT_PID) {
      this.#sectionsFor(pid).feed(payload, payloadUnitStart)
        .forEach((section) => this.#pat(section));
      return;
    }
    const programNumber = this.#pmtPids.get(pid);
    if (programNumber !== undefined) {
      this.#sectionsFor(pid).feed(payload, payloadUnitStart)
        .forEach((section) => this.#pmt(programNumber, section));
      return;
    }
    if (this.#selected.has(pid)) {
      this.#pesFor(pid).feed(payload, payloadUnitStart)
        .forEach((pes) => this.#emitPes(pid, pes));
    }
  }

  #sectionsFor(pid: number): SectionAssembler {
    let assembler = this.#sections.get(pid);
    if (assembler === undefined) {
      assembler = new SectionAssembler();
      this.#sections.set(pid, assembler);
    }
    return assembler;
  }

  #pesFor(pid: number): PesAssembler {
    let assembler = this.#pes.get(pid);
    if (assembler === undefined) {
      assembler = new PesAssembler();
      this.#pes.set(pid, assembler);
    }
    return assembler;
  }

  #pat(section: Uint8Array): void {
    if (section[0] !== 0x00 || section.length < 12) return;
    if (crc32(section) !== 0) { this.#counters.badSections += 1; return; }
    const version = ((section[5] ?? 0) >> 1) & 0x1f;
    const current = ((section[5] ?? 0) & 0x01) !== 0;
    if (!current || version === this.#patVersion) return;
    this.#patVersion = version;

    const pmtPids = new Map<number, number>();
    // 8 バイトのヘッダと 4 バイトの CRC を除いた 4 バイト単位の繰り返し。
    for (let offset = 8; offset + 4 <= section.length - 4; offset += 4) {
      const programNumber = ((section[offset] ?? 0) << 8) | (section[offset + 1] ?? 0);
      const pid = (((section[offset + 2] ?? 0) & 0x1f) << 8) | (section[offset + 3] ?? 0);
      // program_number 0 は NIT であって番組ではない。
      if (programNumber !== 0) pmtPids.set(pid, programNumber);
    }
    this.#pmtPids = pmtPids;
    for (const [programNumber] of this.#programs) {
      if (![...pmtPids.values()].includes(programNumber)) {
        this.#programs.delete(programNumber);
      }
    }
  }

  #pmt(programNumber: number, section: Uint8Array): void {
    if (section[0] !== 0x02 || section.length < 16) return;
    if (crc32(section) !== 0) { this.#counters.badSections += 1; return; }
    const current = ((section[5] ?? 0) & 0x01) !== 0;
    if (!current) return;
    const version = ((section[5] ?? 0) >> 1) & 0x1f;
    if (this.#pmtVersions.get(programNumber) === version) return;
    this.#pmtVersions.set(programNumber, version);

    const pcrPid = (((section[8] ?? 0) & 0x1f) << 8) | (section[9] ?? 0);
    const programInfoLength = (((section[10] ?? 0) & 0x0f) << 8) | (section[11] ?? 0);
    const streams: ElementaryStream[] = [];
    let offset = 12 + programInfoLength;
    const end = section.length - 4;
    while (offset + 5 <= end) {
      const streamType = section[offset] ?? 0;
      const pid = (((section[offset + 1] ?? 0) & 0x1f) << 8) | (section[offset + 2] ?? 0);
      const infoLength = (((section[offset + 3] ?? 0) & 0x0f) << 8) | (section[offset + 4] ?? 0);
      const info = section.subarray(offset + 5, offset + 5 + infoLength);
      streams.push({ pid, streamType, componentTag: componentTag(info) });
      offset += 5 + infoLength;
    }
    this.#programs.set(programNumber, {
      programNumber, pmtPid: pmtPidOf(this.#pmtPids, programNumber), pcrPid, streams,
    });
    this.#handlers.onPrograms?.(this.programs);
  }

  #emitPes(pid: number, pes: Uint8Array): void {
    const parsed = parsePes(pid, pes);
    if (parsed !== null) this.#handlers.onPes?.(parsed);
  }
}

function pmtPidOf(pmtPids: Map<number, number>, programNumber: number): number {
  for (const [pid, number] of pmtPids) if (number === programNumber) return pid;
  return 0;
}

/** stream_identifier_descriptor (0x52) の component_tag。 */
function componentTag(info: Uint8Array): number | null {
  let offset = 0;
  while (offset + 2 <= info.length) {
    const tag = info[offset] ?? 0;
    const length = info[offset + 1] ?? 0;
    if (tag === 0x52 && length >= 1) return info[offset + 2] ?? null;
    offset += 2 + length;
  }
  return null;
}

/** 5 バイトに散らばった 33bit のタイムスタンプ。単位は 90kHz。 */
function timestamp(bytes: Uint8Array, offset: number): number {
  const high = ((bytes[offset] ?? 0) >> 1) & 0x07;
  const mid = (((bytes[offset + 1] ?? 0) << 8) | (bytes[offset + 2] ?? 0)) >>> 1;
  const low = (((bytes[offset + 3] ?? 0) << 8) | (bytes[offset + 4] ?? 0)) >>> 1;
  // 2**30 を掛けるので 33bit。Number の安全域に収まる。
  return high * 2 ** 30 + mid * 2 ** 15 + low;
}

export function parsePes(pid: number, pes: Uint8Array): PesPacket | null {
  if (pes.length < 9) return null;
  if (pes[0] !== 0x00 || pes[1] !== 0x00 || pes[2] !== 0x01) return null;
  const streamId = pes[3] ?? 0;
  const flags = pes[7] ?? 0;
  const headerLength = pes[8] ?? 0;
  const dataStart = 9 + headerLength;
  if (dataStart > pes.length) return null;
  const ptsDtsFlags = (flags >> 6) & 0x03;
  const pts = ptsDtsFlags >= 2 ? timestamp(pes, 9) : null;
  const dts = ptsDtsFlags === 3 ? timestamp(pes, 14) : null;
  return { pid, streamId, pts, dts, data: pes.subarray(dataStart) };
}
