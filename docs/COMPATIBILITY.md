# 動作環境

**実機で確かめたものだけを書く**。理屈の上で動くはずのものは「未確認」に置く。

## 確認済み

| OS | ブラウザ | チューナー | 確認できたところ |
| --- | --- | --- | --- |
| Windows 11 Pro 26220 | Chrome 152 | PX-Q3U4 | 視聴・字幕・音声、走査（地上波・BS）、番組表、**31分の連続視聴**、切断と再接続 |
| AnduinOS 2.0.2（kernel 7.0.0-31） | Chromium 152.0.7977.82（Flatpak） | PX-Q3U4 | 視聴（**CS を含む**）、走査（地上波・BS・CS）。長時間運転と切断試験は未実施 |
| Android 17（Pixel 9a、CP2A.260805.005） | Chrome 153.0.8010.52 | PX-Q3U4 | 視聴・走査とも成立。**MPEG-2 の復号がスマートフォンでも実時間に間に合う**。フレーム落ちの数値は未測定 |
| macOS 26.6.2（25G83、Apple Silicon） | Chromium 152.0.7977.82 | PX-Q3U4 | 視聴（地上波・BS・CS）、字幕、走査。**前提条件なしで通った** |

CS の視聴と、テレビと並べたライブ遅延の観測は Linux 側で行った（FINDINGS 30章）。
31分の連続視聴と切断・再接続は Windows 側で行った（FINDINGS 26章）。
**両方を同じ環境で通したわけではない。**

ブラウザは Chromium 系に限る。WebUSB が Firefox と Safari に無い。

## 対応チューナー

| 機種 | USB ID | WebTS での実機確認 | 根拠 |
| --- | --- | --- | --- |
| PLEX PX-Q3U4 | `0511:084a` | **確認済み**（上の表） | ─ |
| PLEX PX-MLT5PE | `0511:024e` | **未確認** | 上流 px4-userland v0.1.4 の対応機種。上流の実機回帰は DTV02A-5TS-P で行われた |
| e-Better DTV02A-5TS-P | `0511:924e` | **未確認** | 同上（PX-MLT5PE と基板が同じで、USB の product ID だけが違う） |
| PLEX PX-W3U4 | `0511:083f` | **未確認** | 上流 px4-userland v0.1.5-beta の **Beta**。上流でも実機では確かめていない |

**PX-Q3U4 以外は、手元に実機が無いまま上流に追従して入れた。**デバイスを動かす
部分は上流のコードをそのまま使い、組み立ては上流 px4d と同じ手順にしてある
（PX-W3U4 の組み立ては上流では px4d の中にしか無いので、native/px4-enclosure.cpp
に写した）。WebTS で書いた周り（USB の許可、受信機の割り当て）は試験で確かめた。
**動いた・動かなかったの報告を募集している。**

機種の違いは上流が知っている。受信機の数と、各受信機が地上波と衛星のどちらを
受けられるかは上流が答え（PX-Q3U4 は 0/1/4/5 が衛星・2/3/6/7 が地上波、
PX-W3U4 は 0/1 が衛星・2/3 が地上波、PX-MLT5PE は 0〜4 のどれでも両方）、
WebTS はそれに従って視聴用に1本を空け、残りを走査に回す。

## 前提条件

### すべての環境

- **セキュアコンテキストであること**。`https://` か `localhost` でなければ
  `navigator.usb` が生えず、`SharedArrayBuffer`（WASM の pthread に必須）も
  使えない。`http://192.168.x.x` のような LAN アドレスで開いても動かない。
- **クロスオリジン分離**。`Cross-Origin-Opener-Policy: same-origin` と
  `Cross-Origin-Embedder-Policy: require-corp` を返す必要がある。
  `public/_headers` と `vite.config.ts` が設定している。
- **PX-Q3U4 は USB 機器2つとして列挙される**。ブラウザの選択ダイアログには
  同じに見える行が2つ並び、一度では片方しか許可できない。**両方を許可する**
  まで受信機は開けない。PX-W3U4 は USB 機器1つ。PX-MLT5PE と DTV02A-5TS-P は
  PCIe のカードだが、上流によればカード上の USB コントローラの先に USB 機器
  1つとして見える。

### macOS

**追加の設定は要らなかった**。kext も常駐プロセスも競合せず、権限の付与も
求められなかった。USB2.0 ハブ経由でも問題なく開けている。

### Linux

**udev ルールが要る**。既定ではデバイスノードが `root:root 0660` で、一般
利用者として動くブラウザからは開けない。列挙はできるので「見えているのに
開けない」状態になる。

```
# /etc/udev/rules.d/70-px4-userland.rules
# PX-Q3U4
SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{idVendor}=="0511", ATTR{idProduct}=="084a", MODE="0660", GROUP="video"
# PX-W3U4（WebTS では未確認）
SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{idVendor}=="0511", ATTR{idProduct}=="083f", MODE="0660", GROUP="video"
# PX-MLT5PE / DTV02A-5TS-P（上流 README と同じ。WebTS では未確認）
SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{idVendor}=="0511", ATTR{idProduct}=="024e", MODE="0660", GROUP="video"
SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{idVendor}=="0511", ATTR{idProduct}=="924e", MODE="0660", GROUP="video"
```

使う機種の行だけを置けばよい。

```sh
sudo udevadm control --reload-rules
sudo udevadm trigger --subsystem-match=usb --action=add
```

`GROUP` は利用者が属するグループに合わせる。`TAG+="uaccess"` でも良い
（systemd-logind がログイン中の利用者にだけ渡す）。

反映後は**ブラウザで許可を取り直す**。権限の無い状態で与えた許可は記録に
残っていても開けない。

### ドライバの binding

| 環境 | 先にデバイスを掴むもの | 結果 |
| --- | --- | --- |
| Windows 11 | 製造元ドライバは未インストール | 競合なし |
| AnduinOS 2.0.2 | `/opt/px4-stable-818aca1` は存在するが**未ロード** | 競合なし |
| Android 17 | 他のチューナーアプリ（`dev.khronos31.mirakc`） | **競合する**。外すまで開けなかった |
| macOS 26.6.2 | 該当する kext もプロセスも無し | 競合なし |

**Android は USB デバイスをアプリ単位で排他的に掴む**。加えて、機器を挿した
ときに「このデバイスで既定にするアプリ」へ自動的に渡す。実測では mirakc を
入れたままだと「デバイスを開く」から進まず、外すと通った。

**アンインストールで通った**。より軽い手（既定の解除や強制停止）で足りるかは
試していない。Android は機器を挿したときに「このデバイスで既定にするアプリ」へ
自動的に渡すので、そちらでも足りる可能性はある。

（`pm list packages` は全ユーザーぶんの記録を見せる。別ユーザーに同じアプリが
残っていると、アンインストール済みでも一覧に出る。`installed=` を
ユーザーごとに見ないと判断を誤る。)

このとき**エラーにならず「デバイスを開く」で止まったまま**になる。拒否された
のなら失敗として返るべきで、待ちが返ってこないのは不具合である。段階の表示が
無ければ、どこで詰まったかも分からなかった。未修正。

Linux で `px4_drv` や `dvb_usb_*` が読み込まれている場合はインターフェイスを
先に claim するため、WebUSB からは開けない。`lsmod` で確認し、必要なら
`modprobe -r` する。**この環境では読み込まれていなかったので、競合そのものは
未確認である。**上流によれば、PX-MLT5PE / DTV02A-5TS-P は `px4_drv` が
入っているとそちらへ結び付けられる。

**Windows でもドライバの取り合いがある。**WebUSB から開けるのは WinUSB が
割り当たった機器だけである。2026-09-25、PX-Q3U4 に製造元の BDA ドライバが
割り当たり、ブラウザから見えなくなった（そのドライバ自体も読み込みに
失敗していた）。デバイスマネージャーで割り当てを確かめ、WinUSB に戻す。

## 未確認

- **Android でのフレーム落ちの数値**。体感では問題ないが、TS ドロップと
  A/V ずれを読んでいない。
- **Windows 以外での長時間運転**、切断・再接続。31分の連続視聴とチューナーの
  抜き差しは Windows でしか通していない。
- **macOS、ChromeOS。**
- **PX-W3U4、PX-MLT5PE、DTV02A-5TS-P**。上の「対応チューナー」。報告を募集している。
- **PX-S1UD**。対応を取り下げた。理由は docs/FINDINGS.md 28章。

## 別の端末から試すとき

dev サーバーは既定で localhost にしか bind しない。別の端末から開くには
`host` を有効にしたうえで **HTTPS が要る**（上記のセキュアコンテキスト）。
証明書は環境変数で渡す。リポジトリには置かない。

```sh
WEBTS_TLS_CERT=/path/to/cert.crt WEBTS_TLS_KEY=/path/to/cert.key npm run dev
```

Tailscale を使っているなら `tailscale cert` が出す Let's Encrypt の証明書を
そのまま使える。自己署名の警告も CA の導入も要らない。
