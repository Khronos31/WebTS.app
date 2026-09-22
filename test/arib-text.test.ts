// SI の ARIB STD-B24 文字列を解く経路の回帰試験。
//
// 試験値は実放送の EIT から取った短形式イベント記述子の event_name である。
// CRC32 を検証したセクションから取り出したバイト列で、合成ではない。
// 放送 TS そのものではなく、公開されている番組名の1件だけを持つ。

import { describe, expect, it } from 'vitest';
import { decodeAribText } from '../src/ts/arib-text';

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.trim().split(/\s+/).map((part) => Number.parseInt(part, 16)));
}

describe('decodeAribText', () => {
  it('SI の初期状態を前置して漢字・ひらがな・カタカナを解く', () => {
    // 「イット！」だけの部分。LS3R でカタカナ、SO で英数、SI で漢字へ戻る。
    expect(decodeAribText(bytes('1b 7c a4 c3 c8 0e 21 0f 21 5a'))).toBe('イット！【');
  });

  it('JIS互換漢字1面を指示された区間の漢字を落とさない', () => {
    // ESC 02/04 03/09 で JIS互換漢字1面へ切り替えた後の漢字が、辞書が空で
    // あるために丸ごと消えていた。仮名だけが残って別の文につながっていた。
    const name = bytes(`
      1b 7c a4 c3 c8 0e 21 0f 21 5a 31 5d 4a 42 42 67 46 73 4f 3a 1b 7d fd 3b 33
      1b 24 3b 0f 75 40 1b 24 39 0f 4d 3c 35 2e fd 31 73 46 23 4e 68 3b 52 ac fb
      4d 3c 4a 7d fc f2 30 42 3f 34 b7 c6 32 61 b4 b9 aa 3c 6a 45 41 a4 21 5b
      1b 24 3b 0f 7a 56
    `);
    expect(decodeAribText(name)).toBe(
      'イット！【榎並大二郎、山﨑夕貴、遠藤玲子が「夕方」を安心して過ごすお手伝い】🈑');
  });
});
