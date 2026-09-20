# 前回実装からの検証結果

0.1.0 のクリーン再実装へ持ち越す**測定結果**だけを記録する。仕様と計画は本書に含まない。
実装コードは `archived/`（gitignore済み。0.1.0リリース前に削除する）と、再構成前のコミットに
残っている。

各項目は「測定したこと」と「測定していないこと」を分けて書く。合成fixtureでの成功を実機の
成功として読まないこと。

---

## 1. 公式 libusb WebUSB backend の転送所有権には欠陥がある

libusb 1.0.30 の `os/emscripten_webusb.cpp` を無改変で使う前提は、**保留中の転送を安全に
止められない**という形で破綻する。合成入力で再現済み。

### 原因（ソース上の事実）

- `em_cancel_transfer()` は `LIBUSB_SUCCESS` を返すだけの実質 no-op で、
  `em_submit_transfer()` が登録した WebUSB `transferIn` の promise を中断しない。
  よって cancel しても promise が解決するまで論理 callback が届かない。
- その promise callback は生の `usbi_transfer*` を捕捉する。一方
  `em_clear_transfer_priv()` は transfer private に置かれた `PromiseResult` を破棄する。
  core の `usbi_handle_disconnect()` は private を破棄した直後に `NO_DEVICE` 完了を走らせ、
  その user callback は transfer を free してよい。**後から解決した promise は解放済みの
  メモリを参照する。**

### 測定結果

公式 core と backend を無改変のままリンクし、fake `navigator.usb` だけを差し込んだ
source-bound harness で、1 scenario = 1 隔離プロセス / Dedicated Worker として実行した。
**Node と Chrome で同一の固定値**が出ている。

| scenario | stock（公式snapshot） | 所有権patch適用後 |
| --- | --- | --- |
| cancel後 promise 未解決 | callback **0回** | 1回 / `CANCELLED` |
| cancel後の late resolve / reject | callback 0回 | 1回、late promise は破棄 |
| user callback 内 free → late resolve | callback 0回 | 1回、free 済みに触れない |
| 二重 cancel | callback 0回 | 1回、2回目は `NOT_FOUND` |
| pending 中の disconnect | callback **2回** | 1回 / `NO_DEVICE` |
| 2 handle 同時 cancel + 一方 close | callback 0回 | 各1回、close 成功 |
| 通常完了（回帰ガード） | 1回 / `COMPLETED` | 同左 |
| disconnect + callback 内 free | **`abort()`** | 1回、free 済みに触れない |
| cancel → event処理前に disconnect | callback **2回** | 1回 / `NO_DEVICE` |

**最も重いのは disconnect 経路の二重 callback である。**user callback が transfer を free
している場合、stock は Node でも Chrome でも実際に `abort()` した。これは従来「未証明」と
していた use-after-free を、合成入力で再現できる形にしたものである。

### 修正には core の変更も要る

backend だけを直しても「cancel → event処理前に disconnect」で二重完了が残る。
`usbi_handle_disconnect()` が、backend の発行済み完了を completed list から回収してから
自分の `NO_DEVICE` 完了を走らせる必要がある。`list_del()` が entry を NULL 化するため
この回収は冪等にできる。

成立した修正の骨子は次の3点だった。

1. transfer private を `PromiseResult` から「shared state + `optional<PromiseResult>`」へ
   変え、promise callback に生の `usbi_transfer*` を持たせない
2. `em_cancel_transfer()` が有界な論理完了を1回だけ発行する
3. transfer private の破棄と shared state の detach を **user callback より前**に完了する
   （`em_handle_transfer_completion()` と `em_clear_transfer_priv()` の双方）

### 測定していないこと

WebUSB の**物理** abort。`transferIn` の promise は依然として解決されないまま残る。実機
Chromium / Windows での保留転送・切断・timeout の挙動。Siano `stop_streaming()` の有界完了。
pthread build での競合（検証はすべて単一thread）。

---

## 2. Chrome の Worker で公式 event loop が返らない

固定 `os/events_posix.c` の `em_libusb_wait()` は、timeout が 0 でも `poll()` の前に
`Atomics.waitAsync` を使う helper へ入る。**Chrome の Worker runtime thread では、USB も
転送も無い状態で `libusb_handle_events_timeout()` に zero timeout を渡しても返ってこない。**

上記1の Chrome 検証は、`timeout <= 0` のとき wait を飛ばす実験的な差分を当てた build
copy でのみ通っている。したがって Chrome の結果は**所有権 patch と event loop 差分の2つの
上**で得たものであり、公式 snapshot そのままの挙動ではない。

固定 `events_posix.c` のまま Chrome で event API を回す方法は未解決である。

---

## 3. WebUSB 列挙は成立している

既に許可済みの PX-S1UD 1台に対し、公式 libusb WebUSB backend の WASM から
`getDeviceList` が 1台を返すことを Chrome で確認した。Window と Dedicated Worker の双方、
pthread variant と non-pthread Asyncify variant の双方で成立する。

upstream Siano の `is_rio_id()` を再利用した読み取り列挙、および `open_rio()` →
`close_device()` の一往復も成功している。

注意点として、**この列挙は許可済みデバイスの一時 open と標準 descriptor の control-IN を
伴う。**「USB操作なし」と表現してはいけない。claim・bulk・firmware・mode・tune・TS受信は
行っていない。

---

## 4. Asyncify export は `ccall(..., { async: true })` で呼ぶ

WASM 側の列挙が 0 件になる現象があったが、原因は pthread の有無でも権限スコープでもなく、
**JS から Asyncify export を直接呼んで非同期完了前の戻り値を読んでいた**ことだった。
`Module.ccall(..., { async: true })` に切り替え、完了後に heap を読む形で解消する。

同様に、生成モジュールから heap を読む場合は `HEAPU8` / `_malloc` / `_free` を
`EXPORTED_RUNTIME_METHODS` / `EXPORTED_FUNCTIONS` に含める必要がある。

---

## 5. vendor の改行コードは正規化してはいけない

vendor のハッシュロックはディスク上のバイト列に対して SHA-256 を取る。リポジトリ全体の
`* text=auto eol=lf` をそのまま適用すると、コミット時に改行が LF へ書き換えられ、
**クローン先でハッシュ検証が必ず失敗する。**

実測値（libusb `io.c`）:

| | SHA-256 |
| --- | --- |
| CRLF のまま（ロック記録値と一致） | `2afb326fdb52426e9bcfef869bea1be3cc3223ee3d4afad4503f7096dfbd356a` |
| LF へ正規化 | `c83a9e14b9ff8b9566e42d23d1e90c919e223fd1e04721c5ca1a3aff13239a3d` |

`.gitattributes` に `vendor/** -text` を置いて回避した。この行は再 vendor 後も必要である。
diff は有効なままなのでソースレビューには影響しない。

---

## 6. EPGStation / Mirakurun の EPG 更新頻度

番組情報の陳腐化をどう扱うかの参考として、実際の設定既定値を確認した。

| | 設定 | 既定値 | 意味 |
| --- | --- | --- | --- |
| Mirakurun | `epgGatheringJobSchedule` | `20,50 * * * *` | 30分ごとの定期スキャン |
| Mirakurun | `epgRetrievalTime` | `600000` | 1回の取得に最大10分 |
| Mirakurun | `disableEITParsing` | `false` | 稼働中チューナーのストリームから EIT を常時取得 |
| Mirakurun | `logoDataInterval` | `604800000` | **ロゴ更新は7日間隔** |
| EPGStation | `epgUpdateIntervalTime` | `10` | 10分ごとに Mirakurun から取り込み |

陳腐化を防いでいるのではなく、定期スキャン・稼働中チューナーからの便乗取得・定期取り込みの
三層で抑えている。

あわせて、EDCB による EIT[schedule]（番組表本体）の全取得は実運用で15〜30分かかる。
地上デジタルは局ごとに物理チャンネルを選局し直さないと EIT が取れないためである。

---

## 7. MPEG-2 映像はブラウザ内で実時間復号できる

地デジのフルセグは MPEG-2 Video だが、**ブラウザ内蔵のデコーダでは復号できない。**
Chromium 152 の WebCodecs で実測した対応状況は次のとおり。

| コーデック | `isConfigSupported` |
| --- | --- |
| `mp2v` / `mp2v.61` / `mpeg2video` / `mp4v.20.9` | **すべて false** |
| `avc1.42E01E`（H.264） / `hev1.1.6.L93.B0`（HEVC） | true |
| `mp4a.40.2` / `.5` / `.29`（AAC-LC / HE-AAC / v2） | **すべて true** |

音声は WebCodecs で足りる。映像だけが問題になる。

前例も解決していない。[KonomiTV](https://github.com/tsukumijima/KonomiTV) は**サーバー側で
H.264 / HEVC へエンコード**してから mpegts.js + MSE でブラウザへ渡す構成で、Readme にも
「FFmpeg (ソフトウェアエンコーダー) は遅い上に CPU 負荷がかなり高くなるため、ハードウェア
エンコーダーの利用を強くおすすめします」とある。EPGStation も同様にサーバーで変換する。
**サーバーを持たない WebTS.app ではこの回避策が使えない。**

ただし KonomiTV が重いと言っているのは**エンコード**のコストであり、必要なのは
**デコード**である。両者は桁が違う。実測した。

### 測定結果

合成素材（`ffmpeg -f lavfi -i testsrc2` から生成した 1440×1080 インターレース、
29.97fps、15.6 Mbps、600フレーム / 20.02秒の MPEG-2 ES）を、libmpeg2 を Emscripten で
ビルドしたモジュールで復号した。SIMD は使わず純Cにフォールバックさせている。
放送キャプチャは使っていない。

| 実行環境 | 倍速（実時間比） | fps |
| --- | ---: | ---: |
| FFmpeg ネイティブ 1スレッド（SIMD あり） | 28.3x | — |
| FFmpeg ネイティブ 全スレッド | 122x | — |
| libmpeg2 WASM / Node | 12〜13x | 359〜387 |
| libmpeg2 WASM / Chrome メインスレッド | 8.4〜9.4x | 250〜281 |
| libmpeg2 WASM / Chrome Dedicated Worker | 8.6〜9.8x | 258〜293 |

測定機は AMD Ryzen 7 6800H、Chrome 152.0.7977.76。

**純Cの WASM でも実時間の約9倍出ており、余裕がある。**libmpeg2 は GPL-2.0-or-later で
GPL-2.0-only の成果物と両立する。速度が足りなくなった場合の伸びしろとして、WASM SIMD の
有効化と FFmpeg の `mpeg2video` デコーダへの差し替えが残っている。

### 測定していないこと

- **復号だけの数字である。**YUV→RGB 変換と描画、TS demux、B25 復号、字幕描画のコストは
  含まない。
- 合成素材であり実放送 TS ではない。実際の映像は動き補償のコストが異なり得る。
- **Android での実測は未了。**低消費電力端末では当然遅くなる。
- ハーネスが最後の2フレームをフラッシュしないため 600 中 598 フレームを数えている。
  デコーダ側の問題ではなく、測定値には影響しない。

---

## 8. 上流コアの合成検査は通っている

実機なしで、vendor の C/C++ をそのままコンパイル・リンクして通した範囲。いずれも合成入力
であり、実機・実 TS の成功ではない。

- Siano の `ts_queue`（FIFO、容量超過 drop、close 後の拒否、過大 chunk の切り詰め、再初期化）
- Siano の `sms_frame_message()` による `MSG_SMS_GET_VERSION_EX_RES` フレーム解析
- Siano の firmware header / path staging（`sms_parse_firmware_header`）
- PX4 の `group_q3u4_devices()` による serial ベースの機器集約
- PX4 の IT930x scatter image 解析
- PX4 の tagged TS demux（4連続 packet による同期、188 byte 境界跨ぎ、sync loss、reset）
- PX4 の `Q3U4StreamDataPlane` を同期 fake transport で attach → read → detach → shutdown
  まで通す lifecycle（read 188 bytes、2 packets / 376 bytes、有界に完了）
- libaribb25 の no-card facade（create → `set_emm_proc(0)` → `set_unit_size(188)` → release）

---

## 9. 未達のまま残っていること

- **M1 の受け入れ条件**（両機種で各30分の生TS、transfer error / overflow 0、メモリ増加上限、
  切断後の安全停止）は未達。実 firmware 送信、選局、実 TS 受信は未実施。
- **M2**（B25 とカード経路）は未着手。facade の生成・設定・解放が通っただけで、復号は未検証。
- PX-Q3U4 について、chooser の2行と同一 descriptor は観測したが、**物理2 instance への
  一意対応は証明していない。**
- PX-S1UD の firmware / mode 適用後の再列挙と USB 識別子変化は未観測。
