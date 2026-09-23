# 上流コアの構造メモ

再 vendor と再実装の前提になる、上流コードの構造だけを記録する。固定 commit・ライセンス・
ハッシュは再 vendor 時に作り直す。ここには設計判断ではなく**読んで分かった事実**を書く。

方針として、Siano と PX4 のチューナー処理を TypeScript で書き直さず、上流 C/C++ を
source-only で同梱して WASM 化する。libusb も公式の Emscripten/WebUSB backend を使い、
独自の互換層は作らない。

---

## libusb 1.0.30（LGPL-2.1-or-later）

公式の `os/emscripten_webusb.cpp` が WebUSB backend を提供する。ここを出発点にする。

転送所有権の欠陥と、backend / core 双方に必要な修正は
[FINDINGS](FINDINGS.md) の1章に測定結果としてまとめてある。**無改変のままでは保留転送を
有界に止められない**ため、再実装でもここは避けて通れない。

`os/events_posix.c` の `em_libusb_wait()` が Chrome の Worker で返らない件も同じく
[FINDINGS](FINDINGS.md) の2章。

vendor 時は `.gitattributes` の `vendor/** -text` を忘れないこと（FINDINGS 5章）。

---

## Khronos31/siano-userland（GPL-2.0-or-later） — PX-S1UD

**取り込んでいない。**PX-S1UD の対応は取り下げた（docs/FINDINGS.md 28章）。
外付けカードリーダへブラウザから到達する手段が無く、復号できないためである。
参考として記録だけ残す。

単一チューナー、カードリーダーなし。

| ファイル | 内容 |
| --- | --- |
| `siano-ts.c` | デバイス識別、open/close、TS キュー、ストリーミング |
| `protocol.c` | SMS メッセージのフレーミングと解析 |
| `stream-state.c` | ストリーム状態と停止ポリシー |

### 押さえるべき点

- `is_rio_id()` が対象 VID/PID を判定する。TypeScript 側で VID/PID を重複定義しないこと。
- `open_rio()` は interface claim と**両 bulk endpoint の clear-halt** を伴う。
  upstream は `clear_halt` の戻り値を無視するため、成功コードは clear-halt の成功を
  意味しない。
- `ts_queue` は固定 **256 slot × 16,384 bytes**。満杯または close 済みなら drop、過大
  chunk は 16,384 bytes へ切り詰め、`ts_pop` は最大 100ms 待機する。UI 側で別に持つ
  bounded queue とは統計の意味が異なるので混同しないこと。
- **`stop_streaming()` は cancel 後、active transfer が 0 になるまで event thread を
  回して `pthread_join()` する。**保留 promise が残ると停止時間を保証できない。
  これが FINDINGS 1章の欠陥が実害になる場所である。
- firmware は `isdbt_rio.inp` を `set_device_mode()` で送る。`sms_parse_firmware_header()`
  は 12 byte ヘッダと宣言長しか見ず、**checksum も真正性も検証しない。**
  README 記載の既知 SHA-256 は
  `054520642d5d09cb7ab7d08dbd6fd9ba9365de56adf2e7d7d06927f9845ff818`。
  firmware 本体は vendor しない。

---

## Khronos31/px4-userland（GPL-2.0-only） — PX-Q3U4

4チューナー、内蔵カードリーダーあり。

| ファイル | 内容 |
| --- | --- |
| `it930x.cpp` / `it930x_protocol.cpp` | IT930x USB ブリッジ、scatter image の解析 |
| `identity.cpp` | serial による機器集約（`group_q3u4_devices()`） |
| `tagged_ts_demux.cpp` | wire tag 付き TS を receiver 別に分離 |
| `q3u4_stream.cpp` | `Q3U4StreamDataPlane` |
| `q3u4_card_backend.cpp` / `pcsc_ifd.cpp` | 内蔵カードリーダー。PC/SC 側はブラウザへ持ち込まない |
| `mock_transport.cpp` | 上流が持つ fake transport |

### 押さえるべき点

- **1台の Q3U4 は USB 上で複数デバイスとして見える。**`group_q3u4_devices()` が serial を
  基に4チューナーを1台へまとめる。chooser の行数と物理台数は一致しない。
- tagged TS の wire tag は `0x17 / 0x27 / 0x37 / 0x47`。demux が 4連続 packet で同期し、
  188 byte 境界を跨ぐ入力を扱い、invalid tag と TEI で sync loss を検出する。
  sink へ渡す前に sync byte を `0x47` へ正規化する。
- `Q3U4StreamDataPlane::attach()` は worker `std::thread` を開始し、`detach()` /
  `shutdown()` は `cancel_stream()` 後に join する。**ブラウザの main thread から join を
  呼ばないこと。**Dedicated Worker か、専用 pthread 上で使う。
- **pump は bridge ごとに1本**（`kBridgeCount = 2`）。ドライバ用の1本と合わせて3本
  同時に動くので、Emscripten では `PTHREAD_POOL_SIZE` をそれ以上にする。
- **開始と停止の順序は `TunerService::attach_stream` / `detach_stream` が正**。
  `backend.start_capture()` → `stream.attach()`、停止は `stream.detach()` →
  `backend.stop_capture()`。逆順にしてはならない。
- `TunerAttachment` の同一性は `same_attachment()` が client_id / lease_id /
  attachment_id / receiver / nonce の全一致で判定する。attach と read と detach へ
  同じ値を渡すこと。`attachment_id == 0` は拒否される。
- `it930x_protocol.h` には command frame の encode/decode も CRC 検査 API も無い。
  scatter image の境界検査だけが上流から得られる。

---

## shirow-github/libaribb25 v0.2.10（ISC） — B25

TS section parser と MULTI2 を使う。**PC/SC 実装 `b_cas_card.c` は vendor しない。**
`b_cas_card.h` 等の interface / error ヘッダは含める。

`arib_std_b25.c` の facade は create → `set_emm_proc(0)` → `set_unit_size(188)` →
release まで通る。カード callback、鍵、TS payload は未検証。

WebUSB の非同期 I/O と同期的な `proc_ecm()` の境界をどう繋ぐかは未解決。JSPI、Asyncify、
明示的な状態機械の比較が要る。EMM 処理は初期状態で無効にする。

---

## ライセンスの整合

成果物は GPL-2.0-only。px4-userland が GPL-2.0-only、siano-userland が
GPL-2.0-or-later、libaribb25 が ISC、libusb が LGPL-2.1-or-later で、いずれも両立する。

**Apache-2.0 の libaribb25 系（stz2012 / tsukumijima）は参照のみ**で、成果物へ組み込まない。

配布する WASM は GPL / LGPL のソースから生成されるため、GPLv2 3節の complete source code
には**コンパイルを制御するスクリプトも含まれる**。ビルドスクリプトは対応ソースの一部として
配布できる形で保持すること。firmware、放送 TS、カード情報、実行バイナリはコミットしない。
