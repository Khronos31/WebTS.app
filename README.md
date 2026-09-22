# WebTS.app

PX-S1UD または PX-Q3U4 を利用者の端末へ直接つなぎ、WebUSB 対応ブラウザだけで ISDB の
ライブ放送を視聴する静的 Web アプリケーション。放送 TS、カード通信、復号、映像音声処理を
公開クラウドへ送らない。

現在 **0.1.0 に向けた再実装の初期段階**にある。動作するアプリケーションはまだ無い。

## 状態

| | |
| --- | --- |
| 配信 | Cloudflare Pages の静的ホスティング、`webts.app`、PWA |
| ビルド | Linux 上の CI。ビルドスクリプトを PowerShell に依存させない |
| ライセンス | GPL-2.0-only（[LICENSE](LICENSE)） |
| リポジトリ | private。公開は M4 のゲートを通してから |

## 方針

Siano と PX4 のチューナー処理を TypeScript で書き直さず、上流 C/C++ を source-only で
同梱して WASM 化する。libusb も公式の Emscripten/WebUSB backend を使い、独自の互換層を
作らない。詳細は [docs/UPSTREAM.md](docs/UPSTREAM.md)。

ただし公式 WebUSB backend は**無改変のままでは保留中の転送を安全に止められない**ことが
測定済みで、backend と core の双方に修正が要る。[docs/FINDINGS.md](docs/FINDINGS.md) の1章。

## ビルド

WASM の各モジュールは Emscripten を要る。`emcc` と `em++` を PATH に置くか、
`EMSCRIPTEN_ROOT` にそれらのあるディレクトリを渡す。

このリポジトリの開発機では scoop で入れており、shim が PATH に出ないので
環境変数で渡す。

```sh
EMSCRIPTEN_ROOT="$HOME/scoop/apps/emscripten/current/upstream/emscripten" npm run build:q3u4-scan
```

`npm run check`（vendor 検査・型・テスト・Vite ビルド）に WASM のビルドは
含まれない。`native/` を触ったときは対応する `build:*` を明示的に走らせる。

## `#/api/` の操作口

画面を持たない操作はハッシュから叩く。サーバーは無いので HTTP の
エンドポイントではなく、ページ内で実行して JSON を表示するだけである。

```
#/api/                    使える操作の一覧
#/api/channels            保存済みの局
#/api/programs            保存済みの番組
#/api/status              いま受信機を使っているか
#/api/scan?wave=GR|BS|CS  その波を走査して保存する
#/api/epg/refresh         既知の中継器から番組情報を取り直す
#/api/lnb                 LNB 給電の許可を読む
#/api/lnb?allow=1|0       LNB 給電の許可を書く
```

受信機は1本しか開けないので、視聴中や走査中は重ねて呼ばない。
`#/api/status` で誰が握っているかを確認できる。

## ドキュメント

| | |
| --- | --- |
| [docs/FINDINGS.md](docs/FINDINGS.md) | 前回実装からの検証結果。測定した事実だけ |
| [docs/UPSTREAM.md](docs/UPSTREAM.md) | 上流コアの構造メモ |

計画と仕様はリポジトリの外（`.local/SPEC/`）に置いている。

## `archived/`

再実装前の実装一式を退避してある。gitignore 済みで履歴には入らない。**0.1.0 のリリース前に
ディレクトリごと削除する。**内容は再構成前のコミットにも残っているため、失っても git から
復元できる。

## 扱わないもの

実機の USB 操作、firmware、選局、放送 TS、B-CAS / カード情報を、serial や raw payload の
形でログ・表示・送信しない。firmware、放送キャプチャ、カード情報、実行バイナリはコミット
しない。
