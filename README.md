# WebTS.app

PX4 系のチューナーを利用者の端末へ直接つなぎ、WebUSB 対応ブラウザだけで ISDB の
ライブ放送を視聴する静的 Web アプリケーション。放送 TS、カード通信、復号、映像音声処理を
公開クラウドへ送らない。

対応チューナーは PLEX PX-Q3U4（実機確認済み）と、上流 px4-userland v0.1.6 で対応した計16機種
（PX-Q3PE4 / PX-Q3PE5 / PX-W3U4 / PX-W3PE4 / PX-W3PE5 / PX-MLT5PE / PX-MLT8PE3 /
PX-MLT8PE5 / PX-M1UR / PX-S1UR、e-Better DTV02A-5TS-P / DTV02A-4TS-P / DTV03A-1TU /
DTV02-1T1S-U / DTV02A-1T1S-U）。**PX-Q3U4 以外は WebTS でも上流でも実機未確認のため「未確認・報告募集」としており、動作報告を受け付けています（本番はオプトイン、beta 版は既定で有効）**。詳しくは [動作環境](docs/COMPATIBILITY.md)。

地上波・BS・CS の視聴、字幕、チャンネル走査、番組表の取得が Windows・Linux・
macOS・Android で動く。M0〜M3 の受け入れ条件は満たしている（[受け入れ結果](docs/ACCEPTANCE.md)）。

0.2.0 でデータ放送（BML）を足した。視聴を始めると裏で受信し、d ボタンで開く。
**放送で届く分だけを扱い、双方向（通信）には対応しない**。局のサーバーへは何も
送らない。地上波・BS・110度CS を Windows の Chrome と PX-Q3U4 で確かめた
（[docs/FINDINGS.md](docs/FINDINGS.md) の36章）。

## 状態

| 項目 | 内容 |
| --- | --- |
| 配信 | Cloudflare Pages の静的ホスティング、`webts.app`、PWA |
| ビルド | Linux 上の CI |
| ライセンス | GPL-2.0-only（[LICENSE](LICENSE)） |

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
EMSCRIPTEN_ROOT="$HOME/scoop/apps/emscripten/current/upstream/emscripten" npm run build:q3u4-descramble
```

配信するのは `mpeg2-decoder`、`px4-identity`、`q3u4-descramble` の3つ。残りは
開発用のプローブで、公開物には入らない。

`npm run check`（vendor 検査・型・テスト・Vite ビルド）に WASM のビルドは
含まれない。**ただし `build/` が無いと Vite ビルドは失敗する**（本番で
`/build/...` が 404 になるより、そこで落ちるほうがよいため）。`native/` を
触ったときは対応する `build:*` を明示的に走らせる。

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
#/api/epg/schedule        番組表を取る（EIT[schedule]。波と滞在時間を指定できる）
#/api/epg/coverage        番組情報が何時から何時までを覆っているか
#/api/lnb                 LNB 給電の許可を読む
#/api/lnb?allow=1|0       LNB 給電の許可を書く
```

受信機は8本あり、走査は視聴が使っているものを避けて残りを使う。**視聴しながら
番組情報を取り直せる**。走査どうしは同時に走らない。`#/api/status` で誰が
握っているかを確認できる。

## リリース

開発は `Khronos31/WebTS.app-dev`（private）で行い、まとまったら squash して
このリポジトリへ出す。手順は [リリース手順](docs/RELEASE.md)。

## 受け入れ結果

M0〜M4 の条件と実測を1対1で並べたものが [受け入れ結果](docs/ACCEPTANCE.md)。
**「たぶん通る」は通っていないものとして扱っている。**

## 動作環境

対応 OS・ブラウザ・前提条件は [動作環境](docs/COMPATIBILITY.md) にまとめてある。
**Linux は udev ルールが要る**点と、**別端末から開くには HTTPS が要る**点に注意。

## ドキュメント

| 文書 | 内容 |
| --- | --- |
| [docs/FINDINGS.md](docs/FINDINGS.md) | 実機で測った事実。推測は書かない |
| [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) | 受け入れ条件と実測の突き合わせ |
| [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) | 動作環境と前提条件 |
| [docs/RELEASE.md](docs/RELEASE.md) | リポジトリ構成とリリース手順 |
| [docs/UPSTREAM.md](docs/UPSTREAM.md) | 上流コアの構造メモ |

計画と仕様はリポジトリの外（`.local/SPEC/`）に置いている。
