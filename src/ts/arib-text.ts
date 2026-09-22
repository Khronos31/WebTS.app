// SI に入っている ARIB STD-B24 の8単位符号系の文字列を、普通の文字列にする。
//
// 局名も番組名もこの符号系で入っている。JIS X 0208 と外字を含むので自前で
// 変換せず、字幕と同じ `aribb24.js` に解かせる。`tokenizeStatement()` は
// 生のバイト列を受けて字句に分解する公開メソッドで、SI の文字列にもそのまま
// 使える（字幕本文と同じ符号系であるため）。

import { ARIBB24JapaneseJIS8Tokenizer } from 'aribb24.js';
import { installAribDictionaries } from './arib-dictionary';

/**
 * SI の文字列の初期状態を明示する指示列。
 *
 * **これを前置しないと化ける。**字幕本文は字幕管理データで初期状態が決まるので
 * トークナイザはそちらの既定で始まるが、SI の文字列は ARIB STD-B24 で
 * G0=漢字 / G1=英数 / G2=ひらがな / G3=カタカナ、GL=G0、GR=G2 と決まっている。
 * 実測では局名が `＄＂＄ｉ…` のように、漢字のバイト列が全角英数として出た。
 *
 * 呼び出しごとに前置することで、前の文字列の状態が残るのも防げる。
 *
 *   1B 24 42  G0 に漢字         1B 29 4A  G1 に英数
 *   1B 2A 30  G2 にひらがな     1B 2B 31  G3 にカタカナ
 *   0F        GL = G0           1B 7D     GR = G2
 */
const SI_INITIAL_STATE = Uint8Array.of(
  0x1b, 0x24, 0x42,
  0x1b, 0x29, 0x4a,
  0x1b, 0x2a, 0x30,
  0x1b, 0x2b, 0x31,
  0x0f,
  0x1b, 0x7d,
);

let tokenizer: ARIBB24JapaneseJIS8Tokenizer | null = null;

export function decodeAribText(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  // 外字を私用領域へ回すと表示できない環境で豆腐になる。既定のままにする。
  installAribDictionaries();
  tokenizer ??= new ARIBB24JapaneseJIS8Tokenizer({ usePUA: false });
  const prefixed = new Uint8Array(SI_INITIAL_STATE.length + bytes.length);
  prefixed.set(SI_INITIAL_STATE);
  prefixed.set(bytes, SI_INITIAL_STATE.length);
  // **落ちても、そこまで解けたぶんは返す。**末尾が2バイト文字の途中で
  // 切れていると EOF で落ちる。全部捨てると1文字のために文章が丸ごと
  // 消えるので、読めたところまでを出す。
  let text = '';
  try {
    for (const token of tokenizer.tokenizeStatement(prefixed)) {
      if (token.tag === 'Character') text += token.character;
    }
  } catch {
    return text;
  }
  return text;
}
