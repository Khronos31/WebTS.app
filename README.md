# WebTS.app

WebTS.app は、ローカルに接続されたテレビチューナーを WebUSB でブラウザから直接制御し、
サーバーを介さずライブ視聴するための Web アプリケーションです。

> 現在は非公開の技術検証段階です。視聴可能なアプリケーションはまだ提供していません。

## 初期スコープ

- PLEX PX-S1UD と PX-Q3U4
- クライアントサイド完結
- ライブ視聴のみ
- Chromium 系ブラウザの WebUSB

次の機能は初期スコープに含みません。

- 録画
- 視聴・録画予約
- 番組表
- 公開クラウド上のチューナー／復号サーバー

設計、検証順序、公開条件は [プロジェクト計画](docs/PROJECT_PLAN.md) を参照してください。

## M0 WebUSBプローブ

最初の検証対象はWindows 11版Google Chromeです。Node.js 22.12以降または24系を使い、
リポジトリを取得したWindows端末で次を実行します。

```powershell
npm ci
npm run dev
```

Chromeでターミナルに表示された `http://localhost:5173/` を開きます。localhostは
WebUSBを利用できるtrustworthy originとして扱われます。チューナーのdriver bindingは
この段階では変更せず、まずデバイス選択とopenの結果を記録してください。

M0の操作範囲と合格条件は
[Windows 11 + Chrome WebUSB probe](docs/M0_WINDOWS_CHROME.md)を参照してください。

## ライセンス

プロジェクト独自コードは `GPL-2.0-only` です。第三者コードにはそれぞれのライセンスが
適用されます。現時点の候補と採用状態は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
に記録します。
