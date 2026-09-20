# 第三者コードとライセンス

## 同梱している上流ソース

`vendor/upstream/` に source-only で同梱している。固定 commit、選定範囲、除外理由は
[`vendor/sources.json`](vendor/sources.json) に、ファイル単位のハッシュは
[`vendor/SOURCE_LOCK.json`](vendor/SOURCE_LOCK.json) にある。
`npm run vendor:check` が同梱ツリーとロックの一致を検査する。

| 対象 | 固定 | ライセンス | 用途 | 改変 |
|---|---|---|---|---|
| [libusb](https://github.com/libusb/libusb) | v1.0.30 / `87a55632db62c9bdc58cd31d3ccfa673f1bb017f` | LGPL-2.1-or-later | 公式 Emscripten/WebUSB backend と、それが必要とする core | **あり（3ファイル）** |
| [Khronos31/px4-userland](https://github.com/Khronos31/px4-userland) | `10a373dbda0603b2d8180bb2508e2d88dd70eb2d` | GPL-2.0-only | PX-Q3U4 のコア。IT930x ブリッジ、identity grouping、tagged TS demux、stream data plane、内蔵カード | なし |
| [shirow-github/libaribb25](https://github.com/shirow-github/libaribb25) | v0.2.10 / `b978fe5caf6bfe162e944ad4d323b7c0205276e3` | ISC | TS section parser、MULTI2、`arib_std_b25` facade | なし |

PX-S1UD 向けの [Khronos31/siano-userland](https://github.com/Khronos31/siano-userland)
（GPL-2.0-or-later）は、0.1.0 が PX-Q3U4 から始まるため**まだ同梱していない**。S1UD に
着手する時点で同じ手順で追加する。

### libusb の改変

LGPL-2.1 第2条(a)に従い、改変したファイルには変更告知を入れてある。上流との差分は
[`vendor/PATCHES/libusb.diff`](vendor/PATCHES/libusb.diff) にあり、
`vendor/SOURCE_LOCK.json` は上流バイト列のハッシュと同梱バイト列のハッシュを両方記録する。

| ファイル | 変更内容 |
|---|---|
| `libusb/os/emscripten_webusb.cpp` | 保留転送の所有権。promise callback が生の `usbi_transfer*` を持たないようにし、`em_cancel_transfer()` が有界な論理完了を1回だけ発行し、transfer private の破棄と detach を user callback より前に行う |
| `libusb/io.c` | `usbi_handle_disconnect()` が backend の発行済み完了を回収してから `NO_DEVICE` 完了を走らせる |
| `libusb/os/events_posix.c` | `em_libusb_wait()` が非正の timeout で即座に戻る。Chrome の Worker で event API が返らない問題への**回避策であって解決ではない** |

理由と実測は [`docs/FINDINGS.md`](docs/FINDINGS.md) の1章と2章に記録している。

## 参照のみ（成果物へ組み込まない）

| 対象 | ライセンス | 理由 |
|---|---|---|
| stz2012 / tsukumijima の libaribb25 | Apache-2.0 | GPL-2.0-only 成果物と両立しない |
| kazuki0824/recisdb-rs | GPL-3.0 と Apache-2.0 の混在 | ネイティブ動作の比較対象 |
| mirakc / EPGStation / KonomiTV | 各自 | TS 処理とブラウザ再生の挙動の参照 |
| daig0rian/epcltvapp | MIT | 0.1.0 の UI 目標。画面構成と操作モデルの参照 |
| libmpeg2 (mpeg2dec) | GPL-2.0-or-later | MPEG-2 デコーダの候補。ベンチ実施済み、未同梱 |

## ビルド・テスト専用

| 対象 | ライセンス |
|---|---|
| TypeScript | Apache-2.0 |
| Vite | MIT |
| Vitest | MIT |
| Emscripten | MIT / NCSA |

npm の直接・推移依存は `package-lock.json` に固定する。成果物へコードが取り込まれる依存が
生じた場合は、その時点で個別に監査する。

## ランタイムのライセンス方針

- 結合された配布物へ入るコードは GPL-2.0-only と互換でなければならない。
- Apache-2.0 コードを GPL-2.0-only 成果物へリンク、トランスパイル、コピーしない。
- 第三者コードは取得元、commit、ハッシュ、ライセンス、改変内容を固定する。
- 配布 artifact と同時に、再現に必要な対応ソースとライセンス通知を提供する。
  **GPLv2 第3条の complete source code にはコンパイルを制御するスクリプトも含まれる**ため、
  ビルドスクリプトも対応ソースの一部として配布できる形で保持する。
- ビルドツールと配布ランタイムを区別し、生成物へ取り込まれる runtime helper は個別に監査する。

## ファームウェアと収録データ

- ファームウェアは、再配布条件と取得元を確認して明示的に許可するまでコミットしない。
- PX-Q3U4 の IT930x ファームウェアは配布対象外とする。
- 放送 TS、カード dump、ECM/EMM 応答、カード番号、鍵をコミットしない。
- テスト fixture は仕様から生成した人工データを原則とし、由来を記録する。
