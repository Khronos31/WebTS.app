// EIT を読む。既定は p/f（いま放送中の番組と次の番組）だけ。
//
// **EIT[schedule] は既定では読まない。**全期間の番組表は EDCB の実績で
// 15〜30分かかり、放映中の一覧を出すだけならそこまで要らない
// （.local/SPEC/M3_LIVE_UI.md）。p/f は数秒ごとに繰り返されるので、
// 走査のついでに取れる。
//
// 番組表を作るときだけ `schedule: true` で有効にする。1つの中継器に
// 留まる時間を長く取らないと揃わない。
//
// 保存の形は「サービスごとのイベント列」にする。p/f と schedule を同じ形で
// 持てるので、番組表を足すときに UI 側の契約を変えずに済む。
//
// 文字列は ARIB STD-B24 の8単位符号系。字幕・SDT と同じデコーダに渡す。

import { PacketAligner, PACKET_SIZE, crc32 } from './demux';
import { ScheduleCompleteness } from './eit-schedule-state';

const EIT_PID = 0x0012;
/** actual の present/following。other (0x4F) は選局し直さないと信用できない。 */
const EIT_PF_ACTUAL = 0x4e;
/** actual の schedule。0x50〜0x57 が basic（直近8日）、0x58〜0x5F が extended。 */
const EIT_SCHEDULE_ACTUAL_FIRST = 0x50;
const EIT_SCHEDULE_ACTUAL_LAST = 0x5f;
/**
 * other の schedule。同じネットワークの**ほかの TS の局**の番組表。
 *
 * BS と CS は1つの TS にネットワーク全局ぶんが載る。Mirakurun も EDCB も
 * これを前提に、ネットワークごとに1つの TS しか選局しない。p/f の other
 * (0x4F) は「いま」が選局し直さないと信用できないので、引き続き読まない。
 */
const EIT_SCHEDULE_OTHER_FIRST = 0x60;
const EIT_SCHEDULE_OTHER_LAST = 0x6f;

export interface EventEntry {
  readonly networkId: number;
  readonly transportStreamId: number;
  readonly serviceId: number;
  readonly eventId: number;
  /** Unix 時刻 (ms)。 */
  readonly startAt: number;
  /** ミリ秒。0 は未定（放送中の特番などで起きる）。 */
  readonly duration: number;
  readonly name: string;
  readonly description: string;
  /** 拡張形式イベント記述子の項目。 */
  readonly extended: Record<string, string>;
  /** コンテント記述子の大分類。無ければ null。 */
  readonly genre: number | null;
  readonly subGenre: number | null;
  /** p/f の present なら 0、following なら 1。schedule は 2。 */
  readonly section: 0 | 1 | 2;
}

export interface EitHandlers {
  readonly onEvents?: ((events: readonly EventEntry[]) => void) | undefined;
  readonly decodeText: (bytes: Uint8Array) => string;
  /**
   * EIT[schedule] も読むか。既定は読まない。
   * 読むと件数が2桁増え、揃うまでの滞在時間も桁で伸びる。
   */
  readonly schedule?: boolean | undefined;
  /** schedule に加えて other (0x60〜0x6F) も読むか。 */
  readonly scheduleOther?: boolean | undefined;
}

/** 2桁 BCD。 */
function bcd(value: number): number {
  return ((value >> 4) & 0x0f) * 10 + (value & 0x0f);
}

/**
 * MJD と BCD の時刻から Unix 時刻を作る。ARIB の SI は JST なので、
 * UTC へ直してから組み立てる。ETSI EN 300 468 附属書 C の式。
 */
function decodeStartTime(bytes: Uint8Array, offset: number): number {
  const mjd = ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
  // 未定義の開始時刻は全ビット1で送られる。
  if (mjd === 0xffff) return 0;
  const yearGuess = Math.floor((mjd - 15_078.2) / 365.25);
  const monthGuess = Math.floor((mjd - 14_956.1 - Math.floor(yearGuess * 365.25)) / 30.6001);
  const day = mjd - 14_956 - Math.floor(yearGuess * 365.25) - Math.floor(monthGuess * 30.6001);
  const correction = monthGuess === 14 || monthGuess === 15 ? 1 : 0;
  const year = yearGuess + correction + 1900;
  const month = monthGuess - 1 - correction * 12;

  const hour = bcd(bytes[offset + 2] ?? 0);
  const minute = bcd(bytes[offset + 3] ?? 0);
  const second = bcd(bytes[offset + 4] ?? 0);
  // JST は UTC+9。
  return Date.UTC(year, month - 1, day, hour - 9, minute, second);
}

function decodeDuration(bytes: Uint8Array, offset: number): number {
  const hour = bytes[offset] ?? 0;
  if (hour === 0xff) return 0;
  return (bcd(hour) * 3600 + bcd(bytes[offset + 1] ?? 0) * 60 + bcd(bytes[offset + 2] ?? 0)) * 1000;
}

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

export class EitReader {
  readonly #handlers: EitHandlers;
  readonly #assembler = new SectionAssembler();
  /** `${serviceId}:${eventId}` で1件。 */
  readonly #events = new Map<string, EventEntry>();
  readonly #seenServices = new Set<number>();
  readonly #completeness = new ScheduleCompleteness();
  readonly #aligner = new PacketAligner();

  constructor(handlers: EitHandlers) {
    this.#handlers = handlers;
  }

  get events(): readonly EventEntry[] {
    return [...this.#events.values()];
  }

  /** 番組表がどこまで揃ったか。schedule を読むときだけ意味がある。 */
  get completeness(): ScheduleCompleteness {
    return this.#completeness;
  }

  /** 何件のサービスについて p/f が取れたか。 */
  get serviceCount(): number {
    return this.#seenServices.size;
  }

  push(chunk: Uint8Array): void {
    this.#aligner.push(chunk, (packet) => { this.#packet(packet); });
  }

  #packet(packet: Uint8Array): void {
    if (packet[0] !== 0x47) return;
    const second = packet[1] ?? 0;
    if ((second & 0x80) !== 0) return;
    if ((((second & 0x1f) << 8) | (packet[2] ?? 0)) !== EIT_PID) return;
    const third = packet[3] ?? 0;
    if ((third & 0xc0) !== 0) return;
    if ((third & 0x10) === 0) return;
    let start = 4;
    if ((third & 0x20) !== 0) {
      start += 1 + (packet[4] ?? 0);
      if (start >= PACKET_SIZE) return;
    }
    for (const section of this.#assembler.feed(packet.subarray(start), (second & 0x40) !== 0)) {
      this.#onSection(section);
    }
  }

  #onSection(section: Uint8Array): void {
    if (section.length < 18) return;
    const table = section[0] ?? 0;
    const actual = table >= EIT_SCHEDULE_ACTUAL_FIRST && table <= EIT_SCHEDULE_ACTUAL_LAST;
    const other = table >= EIT_SCHEDULE_OTHER_FIRST && table <= EIT_SCHEDULE_OTHER_LAST;
    const schedule = (actual && this.#handlers.schedule === true)
      || (other && this.#handlers.schedule === true && this.#handlers.scheduleOther === true);
    if (table !== EIT_PF_ACTUAL && !schedule) return;
    if (crc32(section) !== 0) return;
    if (((section[5] ?? 0) & 0x01) === 0) return;

    const serviceId = ((section[3] ?? 0) << 8) | (section[4] ?? 0);
    // p/f は section_number 0 が present、1 が following。
    // schedule は 0〜255 がセグメントに対応するので、番号では切らない。
    const sectionNumber = section[6] ?? 0;
    if (!schedule && sectionNumber > 1) return;
    const transportStreamId = ((section[8] ?? 0) << 8) | (section[9] ?? 0);
    const networkId = ((section[10] ?? 0) << 8) | (section[11] ?? 0);

    // **イベントの無いセクションも数える。**空きのセグメントも1セクションとして
    // 送られ、それが届かないと「揃った」にならない。
    if (schedule) {
      this.#completeness.record({
        tableId: table, networkId, serviceId,
        version: ((section[5] ?? 0) >> 1) & 0x1f,
        sectionNumber,
        lastSectionNumber: section[7] ?? 0,
        segmentLastSectionNumber: section[12] ?? 0,
        lastTableId: section[13] ?? 0,
      });
    }

    let offset = 14;
    const end = section.length - 4;
    let added = false;
    while (offset + 12 <= end) {
      const eventId = ((section[offset] ?? 0) << 8) | (section[offset + 1] ?? 0);
      const startAt = decodeStartTime(section, offset + 2);
      const duration = decodeDuration(section, offset + 7);
      const loopLength =
        (((section[offset + 10] ?? 0) & 0x0f) << 8) | (section[offset + 11] ?? 0);
      const descriptors = section.subarray(offset + 12, offset + 12 + loopLength);
      const details = this.#readDescriptors(descriptors);
      // **同じイベントは複数の表に現れる。置き換えずに重ねる。**
      // EIT[schedule] は basic (0x50〜0x57) が短形式イベント記述子＝番組名を、
      // extended (0x58〜0x5F) が拡張形式＝詳細を運ぶ。丸ごと置き換えると、
      // 後から届いたほうが相手の持っていた項目を消す。実測で 10,906 件中
      // 7,534 件の番組名が消えていた。
      const key = `${serviceId}:${eventId}`;
      const previous = this.#events.get(key);
      this.#events.set(key, {
        networkId, transportStreamId, serviceId, eventId,
        startAt, duration,
        name: details.name !== '' ? details.name : (previous?.name ?? ''),
        description: details.description !== ''
          ? details.description : (previous?.description ?? ''),
        extended: Object.keys(details.extended).length > 0
          ? { ...previous?.extended, ...details.extended } : (previous?.extended ?? {}),
        genre: details.genre ?? previous?.genre ?? null,
        subGenre: details.subGenre ?? previous?.subGenre ?? null,
        // p/f で取れていたものを schedule が上書きしても、区別は p/f を優先する。
        section: previous !== undefined && previous.section !== 2
          ? previous.section : (schedule ? 2 : (sectionNumber === 0 ? 0 : 1)),
      });
      added = true;
      offset += 12 + loopLength;
    }
    if (added) {
      this.#seenServices.add(serviceId);
      this.#handlers.onEvents?.(this.events);
    }
  }

  #readDescriptors(descriptors: Uint8Array): {
    name: string; description: string; extended: Record<string, string>;
    genre: number | null; subGenre: number | null;
  } {
    let name = '';
    let description = '';
    let genre: number | null = null;
    let subGenre: number | null = null;
    // 拡張形式イベント記述子は複数に分かれて届き、項目名が空なら前の続き。
    let lastItem = '';
    // **断片は復号せずにバイトのまま溜める。**1文字が断片の境目で分かれて
    // 届くため、断片ごとに復号すると、切れた側は2バイト目を待って EOF で
    // 落ち、続く側は文字の後半から読み始めて無関係な字になる。実測で
    // 「番組内容２」の本文が丸ごと落ち、続きが「跛る思い出を…」になっていた。
    // 符号集合の指示も断片をまたいで効くので、連結してから一度だけ解く。
    const parts = new Map<string, Uint8Array[]>();

    let offset = 0;
    while (offset + 2 <= descriptors.length) {
      const tag = descriptors[offset] ?? 0;
      const length = descriptors[offset + 1] ?? 0;
      const body = descriptors.subarray(offset + 2, offset + 2 + length);
      offset += 2 + length;

      if (tag === 0x4d && body.length >= 4) {
        // 短形式イベント記述子。先頭3バイトは言語コード。
        const nameLength = body[3] ?? 0;
        name = this.#handlers.decodeText(body.subarray(4, 4 + nameLength));
        const textLength = body[4 + nameLength] ?? 0;
        description = this.#handlers.decodeText(
          body.subarray(5 + nameLength, 5 + nameLength + textLength));
      } else if (tag === 0x4e && body.length >= 5) {
        // 拡張形式イベント記述子。
        //
        //   body[0]     descriptor_number | last_descriptor_number
        //   body[1..3]  ISO_639_language_code
        //   body[4]     length_of_items
        //   body[5..]   items
        //
        // **ここを1バイトずらして読んでいた。**length_of_items として最初の
        // 項目名の長さを読み、項目の開始も1バイト後ろにしていたため、項目名と
        // 項目値が1つの文字列に混ざり（「【メインキャスター】榎並大二郎…」）、
        // 続く項目では符号の途中から読み始めて復号が例外で落ちていた。
        const itemsLength = body[4] ?? 0;
        let item = 5;
        const itemsEnd = 5 + itemsLength;
        while (item + 1 <= itemsEnd && item < body.length) {
          const itemNameLength = body[item] ?? 0;
          const itemName = this.#handlers.decodeText(
            body.subarray(item + 1, item + 1 + itemNameLength));
          const itemTextLength = body[item + 1 + itemNameLength] ?? 0;
          const itemText = body.subarray(item + 2 + itemNameLength,
            item + 2 + itemNameLength + itemTextLength);
          const key = itemName !== '' ? itemName : lastItem;
          if (key !== '') {
            const collected = parts.get(key) ?? [];
            collected.push(itemText);
            parts.set(key, collected);
          }
          if (itemName !== '') lastItem = itemName;
          item += 2 + itemNameLength + itemTextLength;
        }
      } else if (tag === 0x54 && body.length >= 2 && genre === null) {
        // コンテント記述子。最初の1組だけ使う。
        genre = ((body[0] ?? 0) >> 4) & 0x0f;
        subGenre = (body[0] ?? 0) & 0x0f;
      }
    }
    const extended: Record<string, string> = {};
    for (const [key, collected] of parts) {
      const total = collected.reduce((sum, piece) => sum + piece.length, 0);
      const joined = new Uint8Array(total);
      let offset = 0;
      for (const piece of collected) {
        joined.set(piece, offset);
        offset += piece.length;
      }
      extended[key] = this.#handlers.decodeText(joined);
    }
    return { name, description, extended, genre, subGenre };
  }
}
