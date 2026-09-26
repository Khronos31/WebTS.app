// 保存を「永続」にしてもらう。
//
// 局・番組表は IndexedDB に、表示の選択などは localStorage に
// 置いている。**何も言わなければ「空きがあれば残す」扱い**で、ディスクが
// 逼迫するとブラウザが使われていないサイトから消す。消えると、スキャンを
// やり直すことになる。
//
// Chromium はプロンプトを出さずに、インストール済みの PWA や利用頻度などから
// 可否を決める。一度断られても、起動のたびに頼み直す。インストールした後や
// 使い込んだ後なら通ることがある。

export async function requestPersistentStorage(): Promise<boolean> {
  const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
  if (storage?.persist === undefined || storage.persisted === undefined) return false;
  try {
    if (await storage.persisted()) return true;
    return await storage.persist();
  } catch {
    return false;
  }
}
