// EIT のイベントを UI が使う形に直す。
//
// スキャンと視聴中の更新の両方から使う。同じ番組が両方から来るので、
// **id の作り方を1か所に持つ。**ずれると同じ番組が二重に残る。

import type { EventEntry } from '../ts/eit';
import type { ProgramItem } from './types';

export function toProgramItem(event: EventEntry): ProgramItem {
  return {
    id: event.networkId * 100_000_000 + event.serviceId * 100_000 + event.eventId,
    channelId: event.networkId * 100_000 + event.serviceId,
    startAt: event.startAt,
    endAt: event.startAt + event.duration,
    name: event.name,
    description: event.description,
    extended: Object.keys(event.extended).length > 0 ? event.extended : undefined,
    genre: event.genre === null ? undefined : String(event.genre),
    subGenre: event.subGenre === null ? undefined : String(event.subGenre),
  };
}
