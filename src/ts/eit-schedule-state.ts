// EIT[schedule] が揃ったかを判定する。
//
// **Mirakurun の判定を移したもの**（src/Mirakurun/TSFilter.ts の
// `_updateEpgState`）。版番号の扱いだけ変えた。Mirakurun は2つ以上飛んだ
// 版も捨てるので、1つ取りこぼすとその表が二度と揃わない。ここでは
// 「1つ前の版」だけを捨て、それ以外の変化では数え直す。
//何セクションで完結するかは事前に分からないので、
// 届いたセクションと「来ないと分かっているセクション」をビットで持ち、
// 両方で全部が埋まったら揃ったとみなす。
//
// 表の構造（ARIB TR-B14、ETSI TR 101 211）:
//
//   table_id の下位3ビット   4日ぶんを1表として最大8表（basic と extended で別）
//   section_number >> 3      3時間ごとのセグメント。1表に32
//   section_number & 7       セグメントの中のセクション
//
// 来ないと分かっているもの:
//
//   last_table_id より後の表
//   last_section_number のセグメントより後
//   segment_last_section_number より後のセクション
//   先頭の表の、今日すでに過ぎたセグメント（送出されない）

const SEGMENTS = 32;
const TABLES = 8;
const HOUR_MS = 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * HOUR_MS;
const SEGMENT_MS = 3 * HOUR_MS;

export interface ScheduleSectionHeader {
  readonly tableId: number;
  readonly networkId: number;
  readonly serviceId: number;
  readonly version: number;
  readonly sectionNumber: number;
  readonly lastSectionNumber: number;
  readonly segmentLastSectionNumber: number;
  readonly lastTableId: number;
}

interface TableFlags {
  /** セグメントごとに、届いたセクションのビット。 */
  readonly received: Uint8Array;
  /** セグメントごとに、来ないと分かっているセクションのビット。 */
  readonly ignore: Uint8Array;
  version: number;
}

interface TableSet {
  readonly tables: TableFlags[];
  lastTableIndex: number;
}

interface ServiceState {
  readonly basic: TableSet;
  readonly extended: TableSet;
}

function emptySet(): TableSet {
  // **まだ何も届いていない表は「揃っている」扱いで始める。**extended を
  // 送らない局もあり、それを待つと永久に揃わない。最初のセクションが
  // 届いた時点で、要る表だけ ignore を落とす。
  return {
    tables: Array.from({ length: TABLES }, () => ({
      received: new Uint8Array(SEGMENTS),
      ignore: new Uint8Array(SEGMENTS).fill(0xff),
      version: -1,
    })),
    lastTableIndex: -1,
  };
}

function setComplete(set: TableSet): boolean {
  for (const table of set.tables) {
    for (let segment = 0; segment < SEGMENTS; segment += 1) {
      if (((table.received[segment] ?? 0) | (table.ignore[segment] ?? 0)) !== 0xff) return false;
    }
  }
  return true;
}

/** networkId と serviceId から、局の id と同じ組み立てで鍵を作る。 */
export function serviceKey(networkId: number, serviceId: number): number {
  return networkId * 100_000 + serviceId;
}

export class ScheduleCompleteness {
  readonly #services = new Map<number, ServiceState>();
  readonly #now: () => number;

  /**
   * `now` は「今日のどのセグメントまで過ぎたか」にだけ使う。Mirakurun は
   * TOT の時刻を使うが、ここでは端末の時計で足りる。ずれて困るのは
   * 3時間の境目の前後数分だけで、そのときは上限時間で打ち切られる。
   */
  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  record(header: ScheduleSectionHeader): void {
    const key = serviceKey(header.networkId, header.serviceId);
    let state = this.#services.get(key);
    if (state === undefined) {
      state = { basic: emptySet(), extended: emptySet() };
      this.#services.set(key, state);
    }
    const set = (header.tableId & 0x0f) < 0x08 ? state.basic : state.extended;
    const tableIndex = header.tableId & 0x07;
    const lastTableIndex = header.lastTableId & 0x07;
    const table = set.tables[tableIndex];
    if (table === undefined) return;

    if (set.lastTableIndex !== lastTableIndex
      || (table.version !== -1 && table.version !== header.version)) {
      // 1つ前の版が遅れて届いたものは捨てる。巻き戻すと永久に揃わない。
      if (table.version !== -1 && ((table.version - header.version) & 0x1f) === 1) return;
      for (let index = 0; index < TABLES; index += 1) {
        const each = set.tables[index];
        if (each === undefined) continue;
        each.received.fill(0);
        each.ignore.fill(index <= lastTableIndex ? 0x00 : 0xff);
        each.version = -1;
      }
    }

    // 先頭の表は今日の 0 時から始まる。過ぎたセグメントは送られない。
    if (tableIndex === 0) {
      const segmentOfDay =
        Math.floor(((this.#now() + JST_OFFSET_MS) % (24 * HOUR_MS)) / SEGMENT_MS);
      for (let segment = 0; segment < segmentOfDay; segment += 1) table.ignore[segment] = 0xff;
    }
    const lastSegment = header.lastSectionNumber >> 3;
    for (let segment = lastSegment + 1; segment < SEGMENTS; segment += 1) {
      table.ignore[segment] = 0xff;
    }
    const segment = header.sectionNumber >> 3;
    for (let section = (header.segmentLastSectionNumber & 0x07) + 1; section < 8; section += 1) {
      table.ignore[segment] = (table.ignore[segment] ?? 0) | (1 << section);
    }
    table.received[segment] = (table.received[segment] ?? 0) | (1 << (header.sectionNumber & 0x07));

    set.lastTableIndex = lastTableIndex;
    table.version = header.version;
  }

  /** 1セクションでも届いた局。 */
  get seen(): readonly number[] {
    return [...this.#services.keys()];
  }

  isComplete(key: number): boolean {
    const state = this.#services.get(key);
    return state !== undefined && setComplete(state.basic) && setComplete(state.extended);
  }

  /** まだ埋まっていないセクションの数。計測用。 */
  missing(key: number): number {
    return Object.values(this.missingByTable(key)).reduce((sum, count) => sum + count, 0);
  }

  /** 表ごとの、まだ埋まっていないセクションの数（'b0'〜'b7'、'e0'〜'e7'）。計測用。 */
  missingByTable(key: number): Record<string, number> {
    const state = this.#services.get(key);
    const result: Record<string, number> = {};
    if (state === undefined) return result;
    for (const [prefix, set] of [['b', state.basic], ['e', state.extended]] as const) {
      set.tables.forEach((table, index) => {
        let count = 0;
        for (let segment = 0; segment < SEGMENTS; segment += 1) {
          let bits = ((table.received[segment] ?? 0) | (table.ignore[segment] ?? 0)) ^ 0xff;
          while (bits !== 0) { count += bits & 1; bits >>= 1; }
        }
        if (count > 0) result[`${prefix}${index}`] = count;
      });
    }
    return result;
  }

  /** 揃った局。番組の差し替えは、ここに入った局についてだけ行ってよい。 */
  completeKeys(): number[] {
    return this.seen.filter((key) => this.isComplete(key));
  }

  /**
   * 届いた局がすべて揃ったか。**届いていない局は数えない**（Mirakurun と同じ）。
   * 臨時サービスのように番組表を送らない局を待つと、永久に終わらない。
   *
   * `relevant` を渡すと、その局だけで判定する。**登録していない局は数えない**
   * （Mirakurun の `_parseServiceIds`）。BS ではデータ放送など視聴しない
   * サービスも番組表の枠を持っていて、ほぼ空のまま埋まらず、実測で5分の
   * 上限まで判定を止めていた。
   */
  allSeenComplete(relevant?: (key: number) => boolean): boolean {
    const keys = relevant === undefined ? this.seen : this.seen.filter(relevant);
    return keys.length > 0 && keys.every((key) => this.isComplete(key));
  }
}
