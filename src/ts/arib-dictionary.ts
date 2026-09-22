// aribb24.js の文字集合辞書の穴を埋める。
//
// **JIS互換漢字1面 (ESC 02/04 03/09) の辞書が空である。**ライブラリは
// `JIS_X_0213_2004_KANJI_1` を用意しているが中身が無く、トークナイザは
// 辞書に無い符号を**例外にせず黙って捨てる**（`if (dict.has(code))`）。
// 結果、この集合を指示した区間の文字が丸ごと消える。
//
// 実際にフジテレビの番組名で起きた。「イット！【榎並大二郎、山﨑夕貴、
// 遠藤玲子が…】」が「イット！【榎並大二郎、山﨑、が「」をしてごすおい」
// になっていた。GR のひらがなだけが残り、指示後の漢字が全部落ちている。
// バイト列は CRC32 を検証した EIT から取っており、壊れていたのは解釈の側。
//
// JIS X 0213 1面は JIS X 0208 を包含し、共通部分の符号位置は一致する。
// 放送局はこの集合へ普通の漢字を載せてくるので、漢字辞書をそのまま引けば
// 正しく出る。実際に落ちていた符号（夕 0x4d3c、貴 0x352e、遠 0x3173、
// 藤 0x4623、玲 0x4e68、子 0x3b52、】 0x215b）はいずれも漢字辞書にある。
//
// **2面 (03/10) は埋めない。**1面とは別の集合で符号位置が一致しないため、
// 漢字辞書を当てると違う字が出る。消えるほうがまだ正直である。
//
// 辞書は static なので、ここで一度埋めれば SI も字幕も同じ経路で直る。

import { ARIBB24JapaneseJIS8Tokenizer } from 'aribb24.js';

interface CharacterDict {
  readonly code: number;
  readonly bytes: number;
  readonly dict: Map<number, string>;
}

function fillPlaneOne(dicts: Record<string, CharacterDict>): void {
  const kanji = dicts['KANJI'];
  const plane1 = dicts['JIS_X_0213_2004_KANJI_1'];
  if (kanji === undefined || plane1 === undefined) return;
  // 既に中身があるなら触らない。ライブラリが埋めてきたときに上書きしない。
  if (plane1.dict.size > 0) return;
  for (const [code, character] of kanji.dict) plane1.dict.set(code, character);
}

let installed = false;

/** 一度だけ埋める。SI と字幕の両方から呼ばれる。 */
export function installAribDictionaries(): void {
  if (installed) return;
  installed = true;
  const tokenizer = ARIBB24JapaneseJIS8Tokenizer as unknown as
    Record<string, Record<string, CharacterDict>>;
  for (const name of ['NORMAL_DICT_USE_PUA', 'NORMAL_DICT_USE_UNICODE']) {
    const dicts = tokenizer[name];
    if (dicts !== undefined) fillPlaneOne(dicts);
  }
}
