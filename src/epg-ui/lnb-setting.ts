// LNB 給電の許可。
//
// **既定は出さない。**集合住宅の共聴やブースターのように、別の機器が既に
// 給電している線へ重ねて出すと競合する。出してよいかは利用者しか知らない
// ので、設定で明示的に許可されたときだけ 15V を出す。
//
// 許可は構築時のポリシーとして C 側の LNB 調停器へ渡る。許可が無ければ
// 調停器は 0V のまま参照だけを数える。

const KEY = 'webts-lnb-15v';

export function allowLnb15v(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    // 私用ウィンドウなどで読めないことがある。読めないときは出さない。
    return false;
  }
}

export function setAllowLnb15v(allow: boolean): void {
  try {
    localStorage.setItem(KEY, allow ? '1' : '0');
  } catch {
    // 保存できなくても既定の「出さない」で動く。
  }
}
