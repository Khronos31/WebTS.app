// 一覧の並び。リモコンの物理ボタンの順に出す。

import { describe, expect, it } from 'vitest';
import { sortChannels } from '../src/epg-ui/channel-source';
import type { ChannelItem } from '../src/epg-ui/types';

function channel(
  name: string, serviceId: number, remote: number | undefined,
  channelType: 'GR' | 'BS' | 'CS' = 'GR',
): ChannelItem {
  return {
    id: serviceId, serviceId, networkId: 1, name, halfWidthName: name,
    channelType, channel: '1', remoteControlKeyId: remote,
  };
}

describe('sortChannels', () => {
  it('リモコン番号の順に並べる', () => {
    const sorted = sortChannels([
      channel('フジ', 1088, 8),
      channel('NHK総合', 1024, 1),
      channel('TBS', 1072, 6),
      channel('Eテレ', 1032, 2),
    ]);
    expect(sorted.map((item) => item.name)).toEqual(['NHK総合', 'Eテレ', 'TBS', 'フジ']);
  });

  it('同じ番号の枝はサービス番号順', () => {
    const sorted = sortChannels([
      channel('Eテレ3', 1034, 2),
      channel('Eテレ1', 1032, 2),
      channel('Eテレ2', 1033, 2),
    ]);
    expect(sorted.map((item) => item.name)).toEqual(['Eテレ1', 'Eテレ2', 'Eテレ3']);
  });

  it('番号を持たない局は後ろへ回す', () => {
    const sorted = sortChannels([channel('番号なし', 2000, undefined), channel('MX', 1200, 9)]);
    expect(sorted.map((item) => item.name)).toEqual(['MX', '番号なし']);
  });

  it('波ごとにまとめる。地上波が先、次に BS、CS', () => {
    const sorted = sortChannels([
      channel('CS局', 3000, 1, 'CS'),
      channel('BS局', 2000, 1, 'BS'),
      channel('GR局', 1000, 9),
    ]);
    expect(sorted.map((item) => item.name)).toEqual(['GR局', 'BS局', 'CS局']);
  });
});
