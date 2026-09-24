// 待ち時間を数えるだけの Worker。tick.ts から使う。
//
// **Worker のタイマーは、裏のタブでも絞られない。**絞られるのはメイン
// スレッドのタイマーだけで、ここから届くメッセージは遅れない。

self.addEventListener('message', (event: MessageEvent<{ id: number; ms: number }>) => {
  const { id, ms } = event.data;
  setTimeout(() => { self.postMessage(id); }, ms);
});
