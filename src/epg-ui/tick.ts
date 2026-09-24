// 裏のタブでも遅れない待ち。
//
// **走査の読み取りはメインスレッドのタイマーで回っていた。**タブが裏へ回ると
// Chrome はそれを1秒以上に、5分を過ぎると1分単位に絞る。その間に C 側の
// バッファが溢れて大半を捨て、CS の走査が全局0になった（FINDINGS 33章）。
// 視聴は音が鳴っているので絞られず、この問題に当たらない。
//
// 待ちの計時だけを Worker に任せる。読み取り自体はメインスレッドのまま。

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, () => void>();

function tickWorker(): Worker | null {
  if (worker !== null) return worker;
  if (typeof Worker === 'undefined') return null;
  worker = new Worker(new URL('./tick-worker.ts', import.meta.url), { type: 'module' });
  worker.addEventListener('message', (event: MessageEvent<number>) => {
    const resolve = pending.get(event.data);
    pending.delete(event.data);
    resolve?.();
  });
  return worker;
}

export function sleepUnthrottled(milliseconds: number): Promise<void> {
  const target = tickWorker();
  if (target === null) {
    return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
  }
  return new Promise((resolve) => {
    const id = nextId;
    nextId += 1;
    pending.set(id, resolve);
    target.postMessage({ id, ms: milliseconds });
  });
}
