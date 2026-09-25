// データ放送の受信機設定。いまは郵便番号だけ。
//
// 本来は受信機の設定画面で入れる項目で、BML からは
// `nvram://receiverinfo/zipcode`（7桁）として読まれる。未設定だと NHK の
// データ放送は「郵便番号が正しく設定されていません」と出す。
//
// **この端末の localStorage にだけ置く。**どこへも送らない。双方向（通信）は
// 非対応なので、局のスクリプトが読んでも外へ出る道は無い。
//
// web-bml は読むたびに localStorage を見に行くので、書けばすぐ効く。
// キーと値の形は web-bml の nvram.js に合わせてある（値は7文字の base64）。

/** web-bml へ渡す保存先の接頭辞。data-broadcast.ts もこれを使う。 */
export const BML_STORAGE_PREFIX = 'webts.bml.';
export const BML_NVRAM_PREFIX = 'nvram.';
export const BML_BROADCASTER_DB_PREFIX = 'bdb.';

const ZIPCODE_KEY = `${BML_STORAGE_PREFIX}${BML_NVRAM_PREFIX}prefix=receiverinfo%2Fzipcode`;

/**
 * 入力を7桁の郵便番号にする。形にならなければ null。
 *
 * ハイフン（全角・半角・長音記号の打ち間違いも）と空白を除き、全角数字は
 * 半角にする。「〒」も落とす。桁数は変えない（補わない・切らない）。
 */
export function normalizeZipcode(input: string): string | null {
  const digits = input
    .replaceAll(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replaceAll(/[\s〒\-‐－−ー]/g, '');
  return /^\d{7}$/.test(digits) ? digits : null;
}

/** いま設定されている郵便番号。未設定か読めなければ null。 */
export function getZipcode(): string | null {
  try {
    const stored = localStorage.getItem(ZIPCODE_KEY);
    if (stored === null || stored === '') return null;
    const value = atob(stored);
    return /^\d{7}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * 郵便番号を設定する。null か空文字で消す。
 * 形にならない入力は設定せず false を返す。保存できなかったときも false。
 */
export function setZipcode(input: string | null): boolean {
  try {
    if (input === null || input.trim() === '') {
      localStorage.removeItem(ZIPCODE_KEY);
      return true;
    }
    const zipcode = normalizeZipcode(input);
    if (zipcode === null) return false;
    localStorage.setItem(ZIPCODE_KEY, btoa(zipcode));
    return true;
  } catch {
    return false;
  }
}

/**
 * 以前の保存先を今の場所へ移す。
 *
 * 最初の版は web-bml の2つの接頭辞の両方に `webts.bml.` を入れていて、
 * キーが `webts.bml.webts.bml.nvram.…` と二重になっていた。局が書いた
 * 保存データ（地域の選択など）を失わないよう、見つけたら移す。
 */
export function migrateBmlStorage(): void {
  try {
    const moves: [string, string][] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key === null) continue;
      for (const inner of [BML_NVRAM_PREFIX, BML_BROADCASTER_DB_PREFIX]) {
        const old = `${BML_STORAGE_PREFIX}webts.bml.${inner}`;
        if (key.startsWith(old)) {
          moves.push([key, `${BML_STORAGE_PREFIX}${inner}${key.slice(old.length)}`]);
        }
      }
    }
    for (const [from, to] of moves) {
      const value = localStorage.getItem(from);
      if (value !== null && localStorage.getItem(to) === null) localStorage.setItem(to, value);
      localStorage.removeItem(from);
    }
  } catch {
    // 読めない・書けない環境では移さない。データ放送は既定値で動く。
  }
}
