// EPGStationスタイルのUIで使用する型定義

import type { Tuning } from './tuning';

// 'api' は画面ではなく、`#/api/...` で叩く操作口。ドロワーには出さない。
export type RouteType = 'onair' | 'watch' | 'settings' | 'about' | 'api';

export type BroadcastType = 'ALL' | 'GR' | 'BS' | 'CS';

export interface ChannelItem {
  id: number;
  serviceId: number;
  networkId: number;
  name: string;
  halfWidthName: string;
  channelType: 'GR' | 'BS' | 'CS';
  /** 表示用の短い名前。地上波は物理チャンネル番号、衛星は "BS15" など。 */
  channel: string;
  /**
   * 選局に要るもの。衛星は周波数だけでは TS が決まらないため、文字列では
   * 表せない。古い保存には無いので `tuningForChannel()` を通して読む。
   */
  tuning?: Tuning | undefined;
  remoteControlKeyId?: number | undefined;
  hasLogoData?: boolean | undefined;
  isSubChannel?: boolean | undefined;
  isPrimary?: boolean | undefined;
}

export interface ProgramItem {
  id: number;
  channelId: number;
  startAt: number; // Unixtime in ms
  endAt: number;   // Unixtime in ms
  name: string;
  description: string;
  extended?: Record<string, string> | undefined;
  genre?: string | undefined;
  subGenre?: string | undefined;
  videoType?: string | undefined;
  audioMode?: string | undefined;
}

export interface OnAirScheduleItem {
  channel: ChannelItem;
  currentProgram: ProgramItem | null;
  nextProgram: ProgramItem | null;
  digestibility: number; // 0 - 100 (%)
}

export interface RegionScanOption {
  id: string;
  name: string;
  prefecture: string;
  physicalChannels: number[];
}
