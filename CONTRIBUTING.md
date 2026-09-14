# Contributing

WebTS.appは現在privateの技術検証段階です。外部コントリビューションを受け付ける前に、
以下をCIで検証できる形にします。

## License

- プロジェクト独自コードへの寄稿は `GPL-2.0-only` とします。
- 第三者由来のファイルは元の著作権表示、ライセンス、由来を保持してください。
- Apache-2.0、GPL-3.0-only、AGPLコードをruntimeへ追加しないでください。
- commitには[Developer Certificate of Origin](https://developercertificate.org/)への同意を示す
  `Signed-off-by`を付けてください。

## Prohibited repository content

- 再配布許諾を記録していないファームウェア
- 放送から取得したMPEG-TS、映像、音声、字幕、番組データ
- B-CASカード番号、カードdump、ECM/EMM応答、復号鍵
- USB capture、packet capture、個体識別子を含む未加工ログ
- credential、token、秘密鍵、`.env`の実値

デバイス検証の結果はpayloadではなく、ブラウザ・OS・機種・統計・エラーコードを匿名化して
記録してください。
