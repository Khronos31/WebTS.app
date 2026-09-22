// 「どこへ合わせるか」の表し方。
//
// **地上波と衛星では選局の単位が違う。**
//
//   地上波  物理チャンネル1つ = TS 1つ。周波数を決めれば TS が決まる。
//   BS/CS   1つの中継器に複数の TS が載る。周波数だけでは決まらず、
//           復調器に TSID を指定して1つ選ぶ（`select_satellite_tsid`）。
//
// 物理チャンネル番号を持ち回る作りでは衛星を表せないので、選局に要るものを
// ひとまとめにして持ち回る。

export type WaveType = 'GR' | 'BS' | 'CS';

export interface Tuning {
  readonly wave: WaveType;
  readonly frequencyKhz: number;
  /**
   * 衛星の TS を指す識別子。地上波は null。
   * 中継器をまたいでも変わらないので、保存にはこちらを使う。
   */
  readonly tsid: number | null;
  /**
   * TMCC の相対 TS 番号 (0〜11)。走査で TS を1つずつ当たるのに使う。
   * 放送側の編成で変わりうるので、選局の拠り所にはしない。
   */
  readonly slot: number | null;
  /** 表示と保存に使う短い名前。地上波は "27"、衛星は "BS15" / "ND4"。 */
  readonly label: string;
}

// 地上デジタル: ch13 = 473143 kHz、以降 6 MHz 間隔。UHF は ch13〜ch62。
const GR_BASE_KHZ = 473_143;
const GR_STEP_KHZ = 6_000;
export const MIN_PHYSICAL_CHANNEL = 13;
export const MAX_PHYSICAL_CHANNEL = 62;

// BS の第1中継器 (BS-1) の IF 周波数と間隔。中継器番号は奇数 1〜23。
const BS_BASE_KHZ = 1_049_480;
const BS_STEP_KHZ = 38_360;
const BS_MAX = 23;

// CS110 (ND2〜ND24、偶数) の IF 周波数と間隔。
const CS_BASE_KHZ = 1_613_000;
const CS_STEP_KHZ = 40_000;
const CS_MIN = 2;
const CS_MAX = 24;

export function grFrequencyKhz(physicalChannel: number): number {
  return GR_BASE_KHZ + (physicalChannel - MIN_PHYSICAL_CHANNEL) * GR_STEP_KHZ;
}

export function grTuning(physicalChannel: number): Tuning {
  return {
    wave: 'GR',
    frequencyKhz: grFrequencyKhz(physicalChannel),
    tsid: null,
    slot: null,
    label: String(physicalChannel),
  };
}

/** BS 中継器。番号は奇数。TSID はスキャンで判明するまで null。 */
export function bsTuning(
  transponder: number, tsid: number | null = null, slot: number | null = null,
): Tuning {
  return {
    wave: 'BS',
    frequencyKhz: BS_BASE_KHZ + ((transponder - 1) / 2) * BS_STEP_KHZ,
    tsid,
    slot,
    label: slot === null ? `BS${transponder}` : `BS${transponder}/${slot}`,
  };
}

/** CS110 の ND 番号。番号は偶数。 */
export function csTuning(
  nd: number, tsid: number | null = null, slot: number | null = null,
): Tuning {
  return {
    wave: 'CS',
    frequencyKhz: CS_BASE_KHZ + ((nd - CS_MIN) / 2) * CS_STEP_KHZ,
    tsid,
    slot,
    label: slot === null ? `ND${nd}` : `ND${nd}/${slot}`,
  };
}

/** TMCC の相対 TS 番号の数。上流が 12 以上を弾く。 */
export const MAX_SLOTS = 12;

/**
 * 衛星の走査で回る先。
 *
 * **どのスロットが埋まっているかは合わせてみるまで分からない。**中継器ごとに
 * スロットを総当たりし、選べたものだけが TS として残る。空きは上流が
 * 弾くので速い。
 */
export function satelliteScanTunings(transponders: readonly Tuning[]): Tuning[] {
  const list: Tuning[] = [];
  for (const transponder of transponders) {
    for (let slot = 0; slot < MAX_SLOTS; slot += 1) {
      list.push({ ...transponder, slot,
        label: `${transponder.label}/${slot}` });
    }
  }
  return list;
}

/** 地上デジタルの全物理チャンネル。 */
export function grTunings(): Tuning[] {
  const list: Tuning[] = [];
  for (let channel = MIN_PHYSICAL_CHANNEL; channel <= MAX_PHYSICAL_CHANNEL; channel += 1) {
    list.push(grTuning(channel));
  }
  return list;
}

/** BS の全中継器。奇数のみ。 */
export function bsTunings(): Tuning[] {
  const list: Tuning[] = [];
  for (let transponder = 1; transponder <= BS_MAX; transponder += 2) {
    list.push(bsTuning(transponder));
  }
  return list;
}

/** CS110 の全 ND。偶数のみ。 */
export function csTunings(): Tuning[] {
  const list: Tuning[] = [];
  for (let nd = CS_MIN; nd <= CS_MAX; nd += 2) list.push(csTuning(nd));
  return list;
}

/** 同じ中継器・同じ TS を指しているか。走査で重複を畳むのに使う。 */
export function sameTuning(left: Tuning, right: Tuning): boolean {
  return left.wave === right.wave
    && left.frequencyKhz === right.frequencyKhz
    && left.tsid === right.tsid;
}

/**
 * 同じ TS を指すものを畳むための鍵。
 * **スロットは含めない。**編成で変わりうるので、同じ TS が別物になる。
 */
export function tuningKey(tuning: Tuning): string {
  return `${tuning.wave}:${tuning.frequencyKhz}:${tuning.tsid ?? ''}`;
}

/**
 * 保存済みのチャンネルから選局先を取り出す。
 *
 * `tuning` を持たない古い保存（地上波しか無かった頃のもの）は、物理チャンネル
 * 番号の文字列から組み立てる。走査し直せば `tuning` が入るので、それまでの
 * つなぎである。
 */
export function tuningForChannel(channel: {
  channelType: 'GR' | 'BS' | 'CS';
  channel: string;
  tuning?: Tuning | undefined;
}): Tuning | null {
  if (channel.tuning !== undefined) return channel.tuning;
  if (channel.channelType !== 'GR') return null;
  const physical = Number(channel.channel);
  if (!Number.isFinite(physical)) return null;
  return grTuning(physical);
}
