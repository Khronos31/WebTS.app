# 動作環境

**実機で確かめたものだけを書く。**理屈の上で動くはずのものは「未確認」に置く。

## 確認済み

| OS | ブラウザ | チューナー | 確認できたところ |
| --- | --- | --- | --- |
| Windows 11 Pro 26220 | Chrome 152 | PX-Q3U4 | 視聴・字幕・音声、走査（地上波・BS）、番組表、**31分の連続視聴**、切断と再接続 |
| AnduinOS 2.0.2（kernel 7.0.0-31） | Chromium 152.0.7977.82（Flatpak） | PX-Q3U4 | 視聴（**CS を含む**）、走査（地上波・BS・CS）。長時間運転と切断試験は未実施 |

CS の視聴と、テレビと並べたライブ遅延の観測は Linux 側で行った（FINDINGS 30章）。
31分の連続視聴と切断・再接続は Windows 側で行った（FINDINGS 26章）。
**両方を同じ環境で通したわけではない。**

ブラウザは Chromium 系に限る。WebUSB が Firefox と Safari に無い。

## 前提条件

### すべての環境

- **セキュアコンテキストであること。**`https://` か `localhost` でなければ
  `navigator.usb` が生えず、`SharedArrayBuffer`（WASM の pthread に必須）も
  使えない。`http://192.168.x.x` のような LAN アドレスで開いても動かない。
- **クロスオリジン分離**。`Cross-Origin-Opener-Policy: same-origin` と
  `Cross-Origin-Embedder-Policy: require-corp` を返す必要がある。
  `public/_headers` と `vite.config.ts` が設定している。
- **PX-Q3U4 は USB 機器2つとして列挙される。**ブラウザの選択ダイアログには
  同じに見える行が2つ並び、一度では片方しか許可できない。**両方を許可する**
  まで受信機は開けない。

### Linux

**udev ルールが要る。**既定ではデバイスノードが `root:root 0660` で、一般
利用者として動くブラウザからは開けない。列挙はできるので「見えているのに
開けない」状態になる。

```
# /etc/udev/rules.d/70-px4-userland.rules
SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{idVendor}=="0511", ATTR{idProduct}=="084a", MODE="0660", GROUP="video"
```

```sh
sudo udevadm control --reload-rules
sudo udevadm trigger --subsystem-match=usb --action=add
```

`GROUP` は利用者が属するグループに合わせる。`TAG+="uaccess"` でも良い
（systemd-logind がログイン中の利用者にだけ渡す）。

反映後は**ブラウザで許可を取り直す**。権限の無い状態で与えた許可は記録に
残っていても開けない。

### ドライバの binding

| 環境 | カーネル／OS 側のドライバ | 結果 |
| --- | --- | --- |
| Windows 11 | 製造元ドライバは未インストール | 競合なし |
| AnduinOS 2.0.2 | `/opt/px4-stable-818aca1` は存在するが**未ロード** | 競合なし |

Linux で `px4_drv` や `dvb_usb_*` が読み込まれている場合はインターフェイスを
先に claim するため、WebUSB からは開けない。`lsmod` で確認し、必要なら
`modprobe -r` する。**この環境では読み込まれていなかったので、競合そのものは
未確認である。**

## 未確認

- **Android。**Chrome は WebUSB に対応しており、USB ホストモード（OTG）対応の
  端末なら繋がるはずだが、確かめていない。MPEG-2 の復号が実時間に間に合うか
  が焦点。
- **macOS、ChromeOS。**
- **PX-S1UD。**対応を取り下げた。理由は docs/FINDINGS.md 28章。

## 別の端末から試すとき

dev サーバーは既定で localhost にしか bind しない。別の端末から開くには
`host` を有効にしたうえで **HTTPS が要る**（上記のセキュアコンテキスト）。
証明書は環境変数で渡す。リポジトリには置かない。

```sh
WEBTS_TLS_CERT=/path/to/cert.crt WEBTS_TLS_KEY=/path/to/cert.key npm run dev
```

Tailscale を使っているなら `tailscale cert` が出す Let's Encrypt の証明書を
そのまま使える。自己署名の警告も CA の導入も要らない。
