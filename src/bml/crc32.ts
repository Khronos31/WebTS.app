// web-bml が使う `crc-32` の代わり。vite.config.ts の alias でこちらへ向ける。
//
// **`crc-32` は Apache-2.0 で、GPL-2.0-only の成果物へ取り込めない**
// （THIRD_PARTY_NOTICES.md のランタイム方針）。web-bml が使うのは PNG の
// チャンクに付ける CRC だけで、呼び方も `CRC32.buf(data, seed)` の1つだけ。
// 同じ値を返す実装をここに持てば足りる。
//
// PNG の CRC は反転多項式 0xEDB88320 の CRC-32。MPEG の CRC-32
// （arib-mmt-tlv-ts の crc-32.js）とは別物である。
//
// **戻り値は符号付き 32 ビット。**`crc-32` がそう返し、web-bml は
// `DataView#setInt32` で書き込む。

const TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** `seed` は続きから計算するときの前回の戻り値。省略すると最初から。 */
export function buf(data: Uint8Array, seed = 0): number {
  let crc = ~seed;
  for (const byte of data) crc = (TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return ~crc;
}

// web-bml は CommonJS で `__importDefault(require("crc-32")).default.buf` と呼ぶ。
// ES モジュールを require すると `__esModule` 付きの名前空間が返るので、
// `default` に同じ形のオブジェクトを置いておく。
export default { buf };
