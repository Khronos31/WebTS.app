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
  /** 衛星の TS 選択。地上波は null。 */
  readonly tsid: number | null;
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
    label: String(physicalChannel),
  };
}

/** BS 中継器。番号は奇数。TSID はスキャンで判明するまで null。 */
export function bsTuning(transponder: number, tsid: number | null = null): Tuning {
  return {
    wave: 'BS',
    frequencyKhz: BS_BASE_KHZ + ((transponder - 1) / 2) * BS_STEP_KHZ,
    tsid,
    label: `BS${transponder}`,
  };
}

/** CS110 の ND 番号。番号は偶数。 */
export function csTuning(nd: number, tsid: number | null = null): Tuning {
  return {
    wave: 'CS',
    frequencyKhz: CS_BASE_KHZ + ((nd - CS_MIN) / 2) * CS_STEP_KHZ,
    tsid,
    label: `ND${nd}`,
  };
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
