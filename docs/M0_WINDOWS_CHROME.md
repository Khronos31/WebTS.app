# M0: Windows 11 + Chrome WebUSB probe

## Objective

Windows 11版Google Chromeで、PX-S1UDとPX-Q3U4をチューナー制御より前のWebUSB層から
安全に選択し、descriptor確認、interfaceのclaim/release、切断・再接続を観測できる
静的診断プローブを作る。次の検証対象はAndroid版Chromeとする。

## Acceptance criteria

### このリポジトリで自動検証する項目

1. `npm ci && npm run check` が終了コード0で完了する。
2. `npm run build` が終了コード0で完了し、`dist/index.html`を生成する。
3. device filterに以下のVID:PIDだけが含まれる。
   - PX-Q3U4: `0511:084a`
   - PX-S1UD実機確認済みID: `3275:0080`
   - Siano Rioコード対応・実機未検証ID: `187f:0600`、`187f:0302`
4. 自動テストで、未対応ブラウザ、選択取消、open失敗、claim失敗、正常close、物理切断を
   区別した状態遷移を検証する。
5. 診断出力にserial number、USB payload、カード情報を含めない。
6. M0コードからfirmware upload、control transfer、bulk/interrupt transfer、選局を行わない。

### Windows 11実機で検証する項目

以下は対象USB機器をWindows 11端末へ接続してChrome上で操作するまで `unverified` とする。

1. 利用者操作から各機種を個別に選択できる。
2. device open、configuration選択、全interface/endpoint descriptor取得が成功する。
3. claim可能なvendor-specific interfaceをclaimし、releaseしてcloseできる。
4. 物理切断が検出され、再接続後に新しいsessionとして選択できる。
5. PX-S1UDについて、firmware/mode適用前後で再列挙やVID:PID変化が起きるかを観測し、
   Chrome権限の挙動とともに記録できる。

## Windows 11実機検証状況

### PX-Q3U4

Windows 11 Pro Insider Preview build 26220とWinUSB binding（provider: libwdi、
version 6.1.7600.16385）の組合せで、次を確認した。

- chooserに区別可能なPX-Q3U4が2件表示された。
- 両候補でConfiguration #1、Interface #0、Alternate #0と同一のendpoint構成を取得した。
- 両候補でselect、open、vendor-specific Interface #0のclaim、release、closeが成功した。
- claim中の物理切断で`OPENED -> DISCONNECTED`となり、再接続後の新しいsessionも成功した。
- 終了時に全interfaceをreleaseし、全deviceをcloseした。

chooser上の識別値は保存していないため、2つのchooser行をWindows上の2つのdevice instanceへ
事後に一意対応付けすることはできない。Chromeの正確なversionも未取得であり、M0全体の
version記録要件は未完了とする。descriptor詳細は[互換表](COMPATIBILITY.md)に記録する。

### PX-S1UD

Windows 11 Pro Insider Preview build 26220とGoogle Chromeで、以下を確認した。

- `3275:0080`を利用者操作で選択し、active Configuration #1、Interface #0、
  Alternate #0と2本のbulk endpointを表示できた。明示的なconfiguration選択は不要だった。
- vendor-specific Interface #0のclaim、release、closeが成功した。
- claim中の物理切断で`OPENED -> DISCONNECTED`を検出した。
- 再接続後は新しいsessionでselect、open、claim、release、closeが成功した。
- 終了時に全interfaceをreleaseし、deviceをcloseした。

Windowsのsigned-driver情報ではprovider `libwdi`、version `6.1.7600.16385`だった。
binding方式、Chromeの正確なversion、firmware/mode適用前後の
再列挙・VID:PID変化・権限挙動は未確認である。firmware/mode適用は今回の
M0プローブで実施していない。descriptor詳細は[互換表](COMPATIBILITY.md)に記録する。

## Non-goals

- firmware upload、選局、TS受信、B25、映像・音声再生
- Windows driverの自動インストールまたは変更
- Android版Chromeの実機合格
- 公開デプロイ、GitHub Pages、Cloudflare Pages、DNS変更

## Constraints

- USB操作は必ずボタンのclickから開始し、ページロード時に権限要求しない。
- claim対象はdescriptorを表示してから利用者が明示的に選ぶ。
- Windowsのdriver binding変更は管理者権限を伴い、既存の視聴ソフトを使えなくする可能性がある。
  M0アプリは変更を実行せず、必要性と元へ戻す手順だけを別途記録する。
- telemetry、analytics、外部API送信、永続的な診断ログを追加しない。
- firmware、USB capture、放送TS、カード情報をリポジトリへ追加しない。

## Rollback

M0は独立コミットにする。静的検証が失敗した場合はcommitせず修正し、実機方針が不適切だった場合は
そのcommitをrevertする。リポジトリはprivate、PagesとDNSは未変更なので外部配信のrollbackは不要。

## Increment plan

| Increment | Scope | Verification | Main risk |
|---|---|---|---|
| M0.1 | frameworkなしのTypeScript/Vite shellと状態機械 | `npm run check` | ブラウザAPIとUI状態が密結合になる |
| M0.2 | WebUSB adapter、device filters、sanitized diagnostics | unit tests + `npm run build` | 権限拒否とdriver claim失敗を混同する |
| M0.3 | Windows 11 + Chrome手順と互換表記録 | 実機操作 | WinUSB bindingまたは識別子変化で失敗する |

## Pre-implementation challenge

- Cheaper alternative: 素のWebUSB APIによるM0 probe。libusb/WASM化は接続可能性が判明した後に行う。
- Hidden premise: Windows 11で対象interfaceをChromeへ渡せるdriver bindingを用意できること。
  S1UDの現行userland実装はUSB再列挙を前提にしていないため、再列挙は要件ではなく観測項目とする。
- Rollback evidence: M0以前のcommit `45153b5`がremoteに存在し、PagesとDNSは未設定である。
