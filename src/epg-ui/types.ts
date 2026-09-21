// EPGStationスタイルのUIで使用する型定義

export type RouteType = 'onair' | 'watch' | 'settings' | 'about';

export type BroadcastType = 'ALL' | 'GR' | 'BS' | 'CS';

export interface ChannelItem {
  id: number;
  serviceId: number;
  networkId: number;
  name: string;
  halfWidthName: string;
  channelType: 'GR' | 'BS' | 'CS';
  channel: string;
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
