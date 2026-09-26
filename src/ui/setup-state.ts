// セットアップが済んでいるかを実データから判定する。
//
// バッジの根拠はここ1箇所に集める。画面ごとに別々の判定を書くと、
// 「メニューには印が出ているのに設定画面では何も無い」が起きる。
//
// **ここは利用者に何も尋ねない。**`navigator.usb.getDevices()` は既に許可された
// デバイスを返すだけでプロンプトを出さないので、起動のたびに呼んでよい。
// `requestDevice()` は利用者の操作からしか呼ばない。

import { readTunerPermission } from '../usb/px4-identity';
import { readChannels } from '../epg-ui/channel-store';

export interface SetupItemState {
  /** 済んでいれば false。バッジはこれで出す。 */
  readonly needed: boolean;
  /** 一覧に出す短い状態。 */
  readonly detail: string;
}

export interface SetupState {
  readonly tuner: SetupItemState;
  readonly channels: SetupItemState;
  /** どれか1つでも要設定なら true。親のバッジに使う。 */
  readonly anyNeeded: boolean;
}

async function tunerState(): Promise<SetupItemState> {
  if (typeof navigator === 'undefined' || !('usb' in navigator)) {
    return { needed: true, detail: 'この環境では WebUSB が使えません' };
  }
  try {
    // 機種の表と VID/PID は上流のもので、TypeScript 側に書き写さない。
    // 許可済みのデバイスを読むだけ。プロンプトは出ない。PX-Q3U4 は1台が
    // USB 上で2デバイスとして見える（FINDINGS 9章）ので、機種ごとに要る数で見る。
    const permission = await readTunerPermission();
    if (!permission.ready) {
      return {
        needed: true,
        detail: permission.granted === 0 ? '未許可' : `${permission.granted} 台のみ許可済み`,
      };
    }
    return { needed: false, detail: `${permission.granted} 台を許可済み` };
  } catch {
    return { needed: true, detail: '確認できません' };
  }
}

/**
 * 局が1つでも保存されていれば済み。
 *
 * **ここは長いあいだ「常に未取得」を返すスタブだった。**局の保存を実装した
 * ときに差し替え忘れ、何をしても設定の赤丸が消えなかった。
 *
 * 全局を「表示しない」にしていても済みとみなす。非表示は利用者が選んだ
 * ことで、設定し忘れではない。
 */
async function channelState(): Promise<SetupItemState> {
  const saved = await readChannels();
  return saved === null
    ? { needed: true, detail: '未取得' }
    : { needed: false, detail: `${saved.channels.length} 局` };
}

export async function readSetupState(): Promise<SetupState> {
  // ファームウェアは項目に無い。配信物の一部として毎回取るので、利用者が
  // 用意するものではない（src/usb/firmware.ts）。
  const [tuner, channels] = await Promise.all([tunerState(), channelState()]);
  return {
    tuner,
    channels,
    anyNeeded: tuner.needed || channels.needed,
  };
}
