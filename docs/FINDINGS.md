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

この表は再現できる。`npm run regression:libusb` が、同梱ツリーから両方の variant を
組み立てて全シナリオを実行する。stock 側は `vendor/PATCHES/libusb.diff` を逆適用して
再構成し、**再構成した木が固定上流のバイト列と一致すること**を確認してから使うため、
ネットワークも上流の再取得も要らない。CI の `libusb-regression` ジョブが同じものを回す。

Node もブラウザも pthread ビルドである。無改変の `events_posix.c` が `Atomics.waitAsync`
を HEAP32 に対して呼ぶため、共有メモリでないと baseline がそもそも起動しない（次章）。

Chrome の Dedicated Worker でも同じ10シナリオを実測し、**Node と全行一致**した。
`npm run build:libusb-browser` で Worker モジュールを生成し、dev 専用ページ
`/libusb-ownership.html` から実行する。1 Worker = 1 scenario で、実行後に terminate する。
Worker の terminate は測定を有界にするだけで、保留 Promise・libusb handle・物理転送の解放を
意味しない。

### 修正には core の変更も要る

backend だけを直しても「cancel → event処理前に disconnect」で二重完了が残る。
`usbi_handle_disconnect()` が、backend の発行済み完了を completed list から回収してから
自分の `NO_DEVICE` 完了を走らせる必要がある。`list_del()` が entry を NULL 化するため
この回収は冪等にできる。

成立した修正の骨子は次の3点で、`os/emscripten_webusb.cpp` と `io.c` の2ファイルに収まる。

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

## 2. Chrome の Worker の event loop は、共有メモリさえあれば上流のまま動く

**これは以前の記録の訂正である。**かつて「固定 `events_posix.c` の `em_libusb_wait()` が
Chrome の Worker runtime thread で返らない」と記録し、`timeout <= 0` で wait を飛ばす
回避策を当てていた。再測定の結果、**原因は Chrome でも上流でもなく、no-pthread ビルドで
あること**だった。

`em_libusb_wait()` は main runtime thread では `Atomics.waitAsync(HEAP32, ...)` を呼ぶ。
`HEAP32` が `SharedArrayBuffer` 由来でないと、この呼び出しは
`TypeError: [object Int32Array] is not a shared typed array` になる。no-pthread ビルドでは
まさにそうなる。Dedicated Worker 内に読み込んだモジュールは自身が main runtime thread に
なるため、この経路へ入る。

`-pthread -s SHARED_MEMORY=1` でビルドすれば、**固定の `events_posix.c` のまま**
Chrome の Dedicated Worker で event API が正常に返る。所有権修正のみを当てて
`events_posix.c` を上流へ戻した variant を作り、全10シナリオが patched と同一結果に
なることを確認したうえで、この改変は取り下げた。上流との差分は3ファイルから2ファイルへ
減っている。

付随して分かったこと。

- **pthread プールは0にする。**`PTHREAD_POOL_SIZE` が1以上だと、モジュールを Dedicated
  Worker 内へ読み込んだときに `still waiting on run dependencies: loading-workers` で
  止まる。ハーネスはスレッドを作らないので、必要なのは共有メモリだけである。
- 共有メモリを使う以上、ページは cross-origin isolation を必要とする。dev/preview は
  `vite.config.ts`、Cloudflare Pages は `public/_headers` で同じ契約を張っている。
- したがって **0.1.0 は実質 `SharedArrayBuffer` 前提**になる。これは未決扱いだった項目の
  一つに答えを与えている。

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

### 同梱後の再測定

上の数字は使い捨てのビルドで取ったものなので、同梱して正式にビルドし直したもので
測り直した（`scripts/build-mpeg2-decoder.mjs`）。素材は同じ生成手順の合成クリップ
（1440×1080 tff、29.97fps、15.6 Mbps、600フレーム / 20.02秒）。

| 実行環境 | 倍速 | fps | フレーム |
| --- | ---: | ---: | ---: |
| Node（`scripts/mpeg2-decode-benchmark.mjs`、3回） | 10.56〜11.02x | 317〜330 | 600 / 600 |
| Chrome Dedicated Worker（3回） | 8.65〜8.91x | 259〜267 | 600 / 600 |

**Worker の値は使い捨てビルドの 8.6〜9.8x を再現している**（下端寄り）。Node 側は
12〜13x から 10.6〜11.0x へ下がっているが、**この差の原因は特定していない。**
今回の計測はフレームごとに面のポインタを取り出して3面すべてを読む分を含んでおり、
使い捨てビルドがそれを払っていたかどうかは記録が残っていない。

**最後の2フレームが出ない問題は解消した。**原因はハーネスではなく呼び出し方だった。
libmpeg2 は「次の start code を見て」初めて直前の picture を出すので、入力を終えたあとに
sequence_end_code（`00 00 01 B7`）を流す必要がある。流すようにしたら 600 / 600 になった。

### 同梱の方針

- **純Cのみ。**手書きの MMX/SSE、AltiVec、Alpha、VIS、ARM は同梱していない。同梱して
  いないので選択もされず、`mpeg2_detect_accel` はマスクをそのまま返す。
- **`libmpeg2/convert/` は同梱しない。**出力は planar I420 のままにして `VideoFrame` へ
  渡す。合成器に色変換をさせるほうが、libmpeg2 の C の RGB 変換より速く、色の扱いも正しい。
- `config.h` は上流が autotools で生成するもので、`native/libmpeg2-config.h` が
  C ソースが実際に読む数個のシンボルだけを与える。

### 測定していないこと

- **復号だけの数字である。**描画、TS demux、B25 復号、字幕描画のコストは含まない。
  面を読むコストは含む。
- 合成素材であり実放送 TS ではない。実際の映像は動き補償のコストが異なり得る。
- **Android での実測は未了。**低消費電力端末では当然遅くなる。
- **インターレース解除は未着手。**素材は tff だが、フィールドをどう扱うかは決めていない。
- 連続再生時のメモリと GC の挙動は見ていない。20秒を3回回しただけである。

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

## 9. PX-Q3U4 の識別は実機で成立する

2026-09-21、実機の PX-Q3U4 を Chrome の WebUSB 経由で、同梱した上流
`px4::userland::group_q3u4_devices()` にそのまま通した。合成入力ではない。

### 観測

1台の Q3U4 は **USB 上で2デバイスとして見える**（`0x0511:0x084a`）。OS 上も
`class=USBDevice` として2件見え、関数ドライバに占有されていない。両デバイスの記述子は
**完全に同一**で、configuration 1個（value 1、選択済み）、interface 0 の alt0 のみ、
class 255/0/0、bulk endpoint 4本（`0x81` / `0x02` / `0x84` / `0x85`、各 512 bytes）。

記述子だけでは2台を区別できない。区別しているのは serial で、上流の
`parse_q3u4_serial()` が要求する「15桁の数字、末尾が `1` か `2`」を実機が満たし、
先頭14桁（base_serial）が一致、末尾（dev_id）が 1 と 2 に分かれていた。
serial の値は読み取っているが表示・記録していない。

### 上流へ通した結果

| 項目 | 値 |
| --- | --- |
| error | `OK` |
| groupCount / readyGroups / incompleteGroups | 1 / 1 / 0 |
| rejectedCount | 0 |
| group0Status | **ready** |
| slot1 / slot2 present | true / true |
| usableObservations | 2 |

M0 で「chooser 2行と同一記述子を観測したが物理2 instance への一意対応は証明していない」
と残っていた点は、**上流の判定基準に照らして解決した。**

### WebUSB は USB speed を公開しない

上流の `validate_q3u4_observation()` は speed を見て、`high` 以上でなければ
`insufficient_speed` で弾く。これは「Q3U4 が 2.0 か」の確認ではなく「いま何で
繋がっているか」の確認で、USB 1.1 ポートや不調なハブ経由なら bulk が 64 バイトになり
4チューナー分の TS が流れないため、早期に明確なエラーを出すためのものである。

WebUSB に negotiated speed を取る API はない。しかし**決め打ちは不要**で、bulk の
最大パケットサイズから一意に導出できる。USB 2.0 仕様で bulk は full speed なら
8/16/32/64、high speed なら 512、SuperSpeed なら 1024 と定められているため、
観測値からの導出であって推定ではない。実機は 512 を報告し、`high` と導出された。
遅いポートに挿された場合は `full` と導出され、上流が正しく弾く。

`location`（bus/address/port path）も WebUSB では取れないが、埋めていない。
`observation_less()` の最終タイブレークにしか使われず、有効な1グループ内では
dev_id が 1 と 2 に分かれるため結果を左右する経路がない。

上流の変更は不要と判断した。上流はネイティブの libusb プログラムで
`libusb_get_device_speed()` があり、そこでの実装は正しい。

### 測定していないこと

**open も claim も転送も行っていない。**firmware、選局、TS 受信、B25 は未着手。
抜き差し後の再列挙、複数台の Q3U4 が同時に接続された場合の grouping も未確認。
確認したのは「許可済みの実機2デバイスが、上流の判定で1つの ready なグループになる」
ことだけである。

---

## 10. 実機の open / claim は本番経路で成立する

2026-09-21、実機の PX-Q3U4 に対し、**同梱した（所有権修正済みの）libusb の
Emscripten/WebUSB backend 経由**で open → claim(interface 0) → release(0) → close の
一往復を行った。fake `navigator.usb` は使っていない。ページが持つ実際の WebUSB 権限を
通している。

| 項目 | 値 |
| --- | --- |
| libusb が列挙した数 | 2 |
| VID:PID 一致 | 2 |
| device 0 | open=0 claim=0 release=0 close 呼び出し済み |
| device 1 | open=0 claim=0 release=0 close 呼び出し済み |

`0` は `LIBUSB_SUCCESS`。3回連続で同一結果、16〜19ms で完了した。

ビルドは `-pthread -s SHARED_MEMORY=1 -s PTHREAD_POOL_SIZE=0`、ページは
cross-origin isolated。所有権回帰で確立した構成をそのまま使っている。

### 読み取り方法の注意

最初の1回だけ、出力バッファの読み取りが矛盾した値を返した（`returnCode` が OK なのに
一致数 0、列挙数が 90848）。**原因は特定できていない。**呼び出し前に領域をマーカーで
埋め、呼び出し後に `Int32Array` を作り直して読む方法に変えたところ一貫し、3回再現した。
ABI 側ではなく読み取り側の問題と見ているが断定しない。WASM 出力を読む箇所では
書き込み範囲を検証する形にすること。

### 測定していないこと

**転送を一切行っていない。**bulk read/write、clear halt、set configuration、reset、
firmware、選局、TS 受信、B25 はすべて未着手。claim 競合、抜き差し後の再 claim、
claim 失敗経路、4チューナーの個別制御も未確認。

---

## 11. ファームウェアの取得と書き込みは実機で成立する

2026-09-21、実機の PX-Q3U4 に対し、ベンダードライバからのファームウェア取り出しと
IT930x への書き込みをブラウザだけで通した。合成入力ではない。

### 取得

ファームウェアは再配布できないため webts.app からは配らない。利用者がプレクスの
ドライバを取得し、ページへ渡す。ブラウザからドライバを直接取得することはできない
（`plex-net.co.jp` は CORS ヘッダを返さず、静的ホスティングにプロキシもない）。

| 段 | 成果物 | サイズ | 照合 |
| --- | --- | ---: | --- |
| 1 | `pxw3u4_BDA_ver1x64.zip` | 213,410 | 固定 SHA-256 と一致 |
| 2 | ZIP 内 `pxw3u4_BDA_ver1x64/PXW3U4.sys` | 189,440 | 固定 SHA-256 と一致 |
| 3 | offset `0x287d0` の 2,169 バイト | 2,169 | 上流 `FirmwareProvider::load()` が受理 |

**fwtool は同梱していないし書き写してもいない。**読んだ結果、その必要がないと分かった。
fwtool は `.sys` の CRC32 で `fwinfo.tsv` の行を引き、`code_ofs` から `code_len` バイトを
そのまま書き出しているだけで、ファームウェアは連続・無加工で埋まっている。したがって
上流 `px4/identity.h` が既に持つ SHA-256 に一致する 2169 バイト窓を探せば同じ結果になる。
既知オフセットは探索を1回で終わらせる近道にすぎず、正しさはハッシュ一致が保証する。
**オフセットヒントを外して全域走査させても同じ位置に到達した**（約5秒）。ZIP のエントリ名も
同じ理由で決め手にしていない。

取り出した 2169 バイトは IndexedDB に置く。IT930x はコールドブート毎にファームウェアを
要求するため、キャッシュが要る。どこへも送信しない。

### 書き込み

`Q3U4Runtime::open_native()` が同梱 libusb 経由で列挙・grouping・open・claim を行い、
`It930xController::initialize_q3u4()` が上流の手順どおりに送信する。送信ロジックは
ブラウザ側に書いていない。

| 実行 | `already_loaded` | `firmware_version` | `verified` | 所要 |
| --- | ---: | --- | ---: | ---: |
| 1回目（送信前は両デバイス `version = 0`） | **0** | `0x01040000` | 1 | 319 ms |
| 2回目 | **1** | `0x01040000` | 1 | 135 ms |
| 3回目 | **1** | `0x01040000` | 1 | 131 ms |

dev1 と dev2 の両方で同じ値。1回目だけ `already_loaded` が 0 で、実際に scatter block の
送信が走っている。2回目以降は送信せずウォーム初期化だけを行う。**冪等である。**

**USB 再列挙は起きない。**`kBoot` の直後に同じハンドルで `firmware_version` を読み、
それが 0 でないことを成立条件にしているためで、実機でもそのとおりだった。PX-S1UD
（Siano）が firmware/mode 適用後に再列挙するのとは異なる。権限もハンドルも維持される。

失敗時は保守的に倒れる。`initialize_q3u4` は入口で backend power の論理状態を unknown に
してから I/O を始めるので、途中失敗は「状態不明」として扱われ、次回はフル初期化を
再試行する。ファームウェアは RAM に載るもので、フラッシュは書き換えない。

### 測定していないこと

**選局、TS 受信、カード操作、B25 は未着手。**4チューナーの個別制御、ストリーム開始、
`start_stream` / `wait_stream` の経路も未検証。送信中に切断された場合、および
`require_cold` ポリシーの挙動も試していない。

---

## 12. 選局と復調ロックは実機で成立する。ただし main thread + Asyncify では遅すぎる

2026-09-21、実機の PX-Q3U4 で地上デジタルを選局し、実際の放送波に復調ロックした。

```
ch27 (557,143 kHz)  receiver = 2 (ISDB-T)
  locked = 1   checks = 2   lockMs = 350
```

組み立ては上流の `frontend_probe` と同じで、ロジックは書き写していない。
`Q3U4Runtime` → `It930xController` ×2 → `It930xBackendPower` ×2 →
`CoupledProbePower` → `It930xBridgeI2cMaster` → `Q3U4Frontend`。電源は dev1/dev2
連動でなければならない。TC90522 復調器、R850 チューナー、I2C ブリッジがブラウザで動く。

### 受信機の割り当て

`local_receiver` 0 と 1 が **ISDB-S**（衛星、RT710）、2 と 3 が **ISDB-T**（地上波、R850）。
地上波に 0 を渡すと `UNSUPPORTED` が返る。上流 `open_receiver()` が
`local_receiver < 2 ? isdb_s : isdb_t` で期待する系を決めている。

### セッションは開きっぱなしにする

最初の実装は選局のたびに `Q3U4Runtime` を作り直し、毎回 backend power を落としていた。
それを走査ループで12回連打した結果、**実機の片方の USB デバイスが列挙から消えた。**
抜き差しで完全に復帰し（両デバイス再列挙、コールドに戻る、WebUSB の再許可は不要）、
恒久的な影響はなかった。ファームウェアが RAM のみという読みどおりである。

上流の probe は「プロセス起動につき1回」の想定で、ループへの流用が誤りだった。
open と初期化は1回だけ行い、以後は選局だけを繰り返す形に変えると安定する。実運用でも
チャンネル切替のたびに USB を開き直すことはないので、こちらが正しい。

### メインスレッドのタイマー依存はタブのスロットリングに支配される

**これは当初の記録の訂正である。**最初は「Asyncify のアンワインド費用で遅い」と書いたが、
計測し直した結果それは誤りだった。原因は **Chrome のバックグラウンドタブ・タイマー
スロットリング**である。

ロック待ちは上流で **300回 × 10ms ポーリング**で、信号があれば2回で抜けるが無い場合は
300回回る。`emscripten_sleep(10)` は内部で `setTimeout` を使う。隠れたタブでは Chrome が
タイマーを約 1Hz に絞るため、**10ms の要求が約1000ms になり、300回で約5分**になっていた。

決定的な実測。

| `document.visibilityState` | `setTimeout(10)` の実測 |
| --- | --- |
| `hidden` | 496 / 998 / 995 / 997 / 1011 ms |
| `visible` | 12 / 10 / 10 / 12 / 11 ms |

同じコードを可視タブで走らせると次のとおりだった。

| 方式 | タブ可視 | タブ隠れ |
| --- | --- | --- |
| メインスレッド + Asyncify | ch13（無信号）**3,679 ms** / ch27（信号）537 ms | ch13 **約5分** |
| pthread | 未測定 | ch13 + ch27 **合計 5,875 ms** |

**当初「イベントループが1/10に落ちた」と記録したのも計測ミスだった。**心拍に使った
`setInterval(100ms)` 自身が同じスロットリングを受けていただけで、何も走っていない
アイドル状態でも同じ値が出る。計測器がスロットルされていることに気づかず、それを
アプリの遅さとして記録した。

### したがってドライバは pthread で動かす

理由は速度そのものではなく、**タブのスロットリングを受けないこと**である。pthread 上の
`std::this_thread::sleep_for` は `setTimeout` ではなく Atomics.wait による実ブロッキングを
使うため、タブが隠れても速度が変わらない。実測でも隠れたタブのまま2チャンネルを
5.9秒で完走している。

**TV アプリでは視聴中にタブが背面へ回るのが普通であり、そのたびにドライバが100倍
遅くなる方式は採れない。**これが決め手である。

あわせて、非メインスレッドでは `events_posix.c` が `emscripten_atomic_wait_u32` の
同期待ちを使い、WebUSB backend は `proxySync` でメインスレッドへ委譲して呼び出し側を
ブロックするため、上流のブロッキング前提のコードがそのまま動く。

**ASYNCIFY はリンクからは外せない。**backend の `awaitOnMain` にメインスレッド用の
`val::await()` 分岐があり、`_emval_await` が解決できないとリンクが通らない。pthread に
閉じた実行では到達しないので、リンクされるだけで実行されない。

### 測定していないこと

カード操作と B25 は未着手。走査は完走していないため、この地域でどの物理チャンネルが
受信できるかは ch27 以外分かっていない（ch13 は無信号と確認）。pthread 方式を
可視タブで測っていないが、スロットリングの影響を受けない以上、隠れたタブの値が
上限と見てよい。

---

## 13. TS 受信は実機で成立する。取りこぼしはない

`native/q3u4-ts-capture.cpp` と `src/usb/q3u4-capture-page.ts` で、選局・復調ロックの
あとに実際の TS を受信した。ドライバは専用 pthread（12章）、ストリームは上流の
`Q3U4StreamDataPlane` がそのまま回す。demux も同期復帰もこちらでは書いていない。

**開始と停止の順序は上流 `TunerService::attach_stream` に従う。**

```
start_terrestrial_capture() → attach()
... read() ...
detach() → stop_terrestrial_capture() → shutdown()
```

最初に書いた試作はこれを両方とも逆にしていた。逆順では、まだ誰も読まないキューへ
復調器が吐き続けるか、停止済みの経路をポンプが空読みする。

**スレッドは3本必要。**ドライバ用に自分で作る1本に加えて、データプレーンが
IT930x ごとに bridge pump の `std::thread` を1本ずつ起こす。`PTHREAD_POOL_SIZE` は
4 にした。プールが足りないと、pump の生成がメインスレッドの Worker 生成待ちで
止まる。

### 測定（PX-Q3U4、地上波 ch27 = 557143 kHz、local_receiver 2、Chrome 152）

| 項目 | 5 秒 | 15 秒 |
|---|---:|---:|
| 受信バイト | 7,518,872 | 29,156,732 |
| スループット（read ループの実時間で除算） | 12.03 Mbps | **15.48 Mbps** |
| 整列 packet（先頭が 0x47） | 39,994 | 155,089 |
| 非整列 packet | **0** | **0** |
| 上流 sync errors | **0** | **0** |
| 上流 continuity errors | **0** | **0** |
| 上流 queue drops | **0** | **0** |
| 上流 usb errors | **0** | **0** |
| 上流 TEI packets | **0** | **0** |
| スクランブル packet | 28,690 (71.7%) | 129,028 (83.2%) |
| 出現 PID 数 | 32 | 34 |
| read 回数 / うち timeout | 2,427 / 3 | 6,575 / 3 |
| 終端理由 | none | none |
| 終了時の error | OK | OK |

15.48 Mbps は ISDB-T フルセグの実効レートとして妥当な範囲にある。

**スループットの分母は read ループの実時間でなければならない。**全経過には列挙・
ファームウェア投入・選局・ロック待ちが入る（15秒受信で全体 16154 ms に対し受信のみ
15067 ms）。最初は全経過で割って 9.86 Mbps と出していた。これは測り方の誤りである。

**上流 `stats()` の packets が自前の整列数を 3 だけ上回る**（155,092 対 155,089）。
上流はキューへ入れた時点で数え、こちらは配送されたものを数えるので、detach 時点で
キューに残っていた分が差になる。系統が違う2つの計数が3パケット差で一致している
こと自体が、経路に取りこぼしがないことの裏付けになっている。

**これは映像ではない。**スクランブル packet が 8 割を占めるのは日本の地上デジタルが
暗号化されているためで、正常な観測である。映像にするには B25 とカード（M2）、
そのあと分離と MPEG-2 復号が要る。いずれも未着手。

### この経路で libusb の所有権修正が効いている

`shutdown()` は保留中の bulk 転送をキャンセルする。1章の修正がなければ、ここで
論理 callback が二重に届くか、解放済み転送に触れる。15秒×1回・5秒×1回の停止は
いずれも `error OK` / `terminal none` で戻っており、異常終了もアサートも出ていない。
ただし**これは通常終了の経路だけの確認であり、切断中の停止は実機では試していない**。
その場合の挙動は Node と Chrome Worker の隔離試作で測ってある（1章、scenario 5 と 9）。

### 測定していないこと

- 30分連続受信は未実施。上の最長は15秒である。メモリ増加の上限も測っていない。
- 受信中の USB 切断（物理的な抜去）は試していない。
- 複数受信機の同時受信は試していない。local_receiver 3 も未使用。

---

## 14. 内蔵カードリーダは実機で成立する

`native/q3u4-card-probe.cpp` と `src/usb/q3u4-card-page.ts` で、PX-Q3U4 の内蔵
カードリーダに実際のカードを入れた状態で、電源投入・UART 初期化・リセット・
ATR 取得・T=1 セッション確立・APDU 往復まで通した。復号はまだ行っていない。

**カード電源の権限を持つのは `Q3U4FrontendEnclosure` であり、単一受信機の
`Q3U4Frontend` ではない。**後者には `acquire_card()` が無い。これまでの選局・
TS 受信は `Q3U4Frontend` で組んでいたが、カードを併用する本番構成では
enclosure 側に寄せる必要がある。

組み立て（上流 `CardService` が要求する形）:

```
Q3U4FrontendEnclosure(bridge1, bridge2, dev1_power, dev2_power, delay)
Q3U4CardBackend(dev1, enclosure)
It930xCardHardware(dev1) + SystemCardTime → CardSession
NativeCardProtocolSession → CardService
service.connect(client, ShareMode::exclusive)  // 電源投入と UART 初期化はこの中
service.transmit(...) → service.disconnect(...) → service.shutdown()
```

### 測定（PX-Q3U4 内蔵リーダ、カード挿入済み、Chrome 152）

| 項目 | 値 |
|---|---|
| 所要時間（列挙からカード切断まで） | 824 ms |
| カード検出 | はい |
| ATR 長 | 13 バイト |
| ボーレート | 19200 |
| IFSC | 124 |
| EDC | LRC |
| ブロックタイムアウト | 1600 ms |
| T=1 セッション確立 | はい |
| 応答長 | 61 バイト |
| SW1SW2 | **0x9000** |
| 終了時の error | OK |

送ったのは ARIB STD-B25 Part 3 の初期設定条件コマンド（CLA=0x90 INS=0x30）1本だけで、
カードが正常応答することの確認にとどまる。

**カードの応答内容は読み出していない。**C 側は応答バッファをスコープを出る前に
ゼロ埋めし、外へ渡すのは SW1SW2 と長さだけである。カード ID、システム鍵、
CBC 初期値、ATR のバイト列は保持も表示も送信もしていない。ATR について出して
いるのは長さとプロトコル引数（ボーレート・IFSC・EDC・タイムアウト）だけで、
これらはカード個体ではなく通信条件である。

### 測定していないこと

- **ECM 処理は未実施。**`proc_ecm` に相当する往復はまだ送っていない。
- **受信と同時にカードを使う構成は試していない。**今回は選局も capture も
  していない。両方を同時に動かしたときの電源調停は未確認。
- カード抜き差し中の挙動、`poll_presence()` は試していない。

---

## 15. libaribb25 の B_CAS_CARD は内蔵リーダの上で動く

上流 `b_cas_card.c` は PC/SC 向けに書かれている。当初は「PC/SC 実装だから
同梱しない、自前で書く」としていたが、**これは判断を誤っていた。**

このファイルの価値は ARIB STD-B25 Part 3 の応答解析であって PC/SC ではない。
そして実際に使っている PC/SC の面は次の6関数と定数数個しかない。

```
SCardEstablishContext  SCardListReaders  SCardConnect
SCardTransmit  SCardDisconnect  SCardReleaseContext
SCARD_PCI_T1 ほか定数
```

したがって **`b_cas_card.c` は改変せず同梱し、`native/winscard/` がこの面だけを
内蔵リーダの上に用意する**構成にした。解析を書き直すより小さく、間違いにくい。
vendor ツリーに改変が増えないという副次的な利点もある。

`SCardConnect` は `CardService::connect` を呼ぶので、カード電源の投入と UART
初期化は上流の CardService の中で起きる。シムは電源にも T=1 にも触れない。

### 測定（PX-Q3U4 内蔵リーダ、カード挿入済み、Chrome 152）

| 項目 | 値 |
|---|---|
| 所要時間 | 821 ms |
| `init()` 戻り値 | **0** |
| CA system ID | **0x0005** |
| card status | 0 |
| システム鍵 | あり |
| CBC 初期値 | あり |
| カード ID | あり |
| `get_id()` 件数 | 1 |
| `get_pwr_on_ctrl()` 件数 | 0 |
| 終了時の error | OK |

`init()` が 0 を返すということは、上流の `connect_card()` が応答長 57 以上を
受け取り、リターンコード 0x2100 を確認し、システム鍵・CBC 初期値・カード ID・
CA system ID の取り出しまで通ったということである。

**カードの内容は持ち出していない。**鍵、CBC 初期値、カード ID については
「ゼロでないか」だけを見て、読み出した構造体はその場でゼロ埋めしている。
CA system ID と card status は規格上の分類であってカード個体ではない。

### 測定していないこと

- **`proc_ecm` / `proc_emm` は呼んでいない。**実際の復号はこの次。
- 受信と同時にカードを使う構成は未確認（14章と同じ）。
- シムは1リーダ・1カード・T=1 だけを支える。`SCardStatus`、
  `SCardGetStatusChange`、T=0、属性取得はどれも無い。汎用の PC/SC ではない。

---

## 16. 実放送の TS は実機で復号できる

`native/q3u4-descramble-probe.cpp` と `src/usb/q3u4-descramble-page.ts` で、
選局・ロック・TS 受信・カードによる復号を**同時に**動かした。13章（受信）、
14章（カード）、15章（B_CAS_CARD）をひとつの経路に繋いだ形である。

**選局とカードを同時に使う構成はここが初めてで、電源調停は成立した。**
14章・15章で「未確認」としていた点が解消した。カード電源は
`Q3U4FrontendEnclosure` が持ち、受信機の電源と同じ調停器の下にある。

受信機は上流の **global 番号**（0..7）で指定する。`map_receiver` により
local = global % 4、bridge = global < 4 ? dev1 : dev2、local < 2 が ISDB-S。
地上波は global 2, 3（dev1）と 6, 7（dev2）。データプレーンのセッションも
同じ global 番号で引く。

### 測定（PX-Q3U4、地上波 ch27 = 557143 kHz、global receiver 2、Chrome 152）

| 項目 | 値 |
|---|---|
| 受信時間 | 5046 ms（全体 6571 ms） |
| 復号前 packet | 39,991 |
| 復号前 スクランブル | 36,155（**90.4%**） |
| 復号後 packet | 38,263 |
| 復号後 スクランブル | **0（0.0%）** |
| 復号後 非整列 | 0 |
| 番組数 | 4 |
| 上流 未復号 packet | **0** |
| 未契約 ECM 数 | 0 |
| 直近の ECM エラー | 0 |
| libaribb25 の戻り値 | 0 |
| 終了時の error | OK |

**入口で 90.4% がスクランブルされていたものが、出口で 0% になっている。**
上流 libaribb25 自身の申告でも未復号パケットは 0 である。

### 復号した TS の中身（ffprobe、20秒・39.4 MB）

| stream | 内容 |
|---|---|
| 1 | `mpeg2video` Main **1440x1080** 29.97fps（標本比 4:3 → 表示 1920x1080） |
| 2, 3 | `aac` LC 48000 Hz 2ch ×2（主音声・副音声） |
| 4 | **`arib_caption` Profile A**（ARIB STD-B24 字幕。0.1.0 のスコープ内） |
| 5 | `bin_data`（データ放送） |

同期外れ 0、PID 36種、null packet (0x1fff) 8,876 個。`ffmpeg` で全長デコードが
通る。**自前の libmpeg2 ビルドでも通った**（次節）。

### 自前の MPEG-2 デコーダは実放送でも動く

7章の測定は合成素材だけで、「実放送は動き補償のコストが異なり得る」と
但し書きを付けていた。上の TS から映像 ES を取り出して同じモジュールにかけた。

| 素材 | 倍速 | fps | フレーム |
|---|---:|---:|---:|
| 合成（1440x1080 tff、15.6 Mbps） | 10.56〜11.02x | 317〜330 | 600 |
| **実放送（ch27、17.85秒）** | **9.35x** | **280.2** | 535 |

実放送のほうが約15%遅いが、実時間の9倍以上あり余裕は変わらない。
7章の但し書きはこれで解消する（Node での測定。Chrome Worker では合成素材で
8.65〜8.91x だったので、実放送では8倍前後と見るのが妥当）。

### 説明できていないこと

**入口より出口の packet がわずかに少ない。**時間を変えて4回測った。

| 受信時間 | 入口 | 出口 | 差 |
|---:|---:|---:|---:|
| 5 s | 39,991 | 38,263 | 1,728 |
| 5 s | 39,990 | 37,751 | 2,239 |
| 15 s | 155,096 | 153,862 | 1,234 |
| 20 s | 212,186 | 209,935 | 2,251 |

**差は時間に比例しない。**1,234〜2,251 の範囲で、受信時間とは無関係に見える。
つまり継続的な取りこぼしではなく、開始時または終了時の一定量である。
`flush()` のあと `get()` が空を返すまで繰り返すように直したが**差は変わらなかった**
ので、単に内部に溜まっているわけでもない。`set_strip(0)` なので明示的な破棄でもなく、
null packet も出口に残っている（8,876 個）。**機構は特定できていない。**

実害としては、視聴開始時に 1〜2千 packet（0.1秒前後）が欠ける可能性がある。
出口の TS 自体は同期外れ 0 で完全にデコードできるので、live 視聴の用途では
見えない差だが、**原因を特定しないまま「問題ない」と結論づけてはいない。**

### 構成

```
Q3U4FrontendEnclosure ── open_terrestrial / tune / lock / start_capture
Q3U4StreamDataPlane   ── attach → read
CardService ── winscard シム ── b_cas_card.c ── arib_std_b25
```

`set_emm_proc(0)`。**EMM 処理は明示的に切っている。**受信のみの用途では不要で、
カードへの書き込みを伴うためである。`set_multi2_round(4)`、`set_strip(0)`、
`set_unit_size(188)`。

### 測定していないこと

- **チューナーから画面まで繋がり、音も字幕も出た（18〜20章）。**残るのは
  副音声、DRCS の確認、インターレース解除、チャンネル切替、UI。
- 30分連続は未実施。最長5秒である。
- 復号中の USB 切断、カード抜去は試していない。
- 4受信機の同時使用は試していない。

---

## 17. 分離から描画までブラウザ内で通る

`src/ts/demux.ts`（分離）、`src/video/player-worker.ts`（Worker での復号と描画）、
`player.html`。復号済み TS を渡すと、PAT/PMT の追跡・PES 組み立て・MPEG-2 復号・
canvas への描画をすべてブラウザ内で行う。**外部プレイヤーは要らなくなった。**

### 分離は自前である

相当するものが上流に無い。px4-userland の `tagged_ts_demux` は USB の wire tag を
剥がして受信機ごとに分ける層で、PSI も PES も見ない。libaribb25 の
`ts_section_parser` は section を組むが facade の内部に閉じている。

扱う範囲は地デジの live 視聴に要るものだけで、汎用の TS パーサではない。
188 バイト固定（204 バイトは扱わない）、PSI は PAT と PMT のみ、
section は複数パケットに跨る場合を組み立て、CRC32 を検査する。
scrambling control が立った packet は捨てる（復号は B25 の仕事で、
ここへ来る時点で落ちているべきもの）。

### 実放送での分離結果（ch27、20秒・37.6 MiB）

```
counters {"packets":209935,"badSync":0,"errored":0,"scrambled":0,
          "continuityErrors":0,"badSections":0,"nullPackets":8876}
demux 37.6 MiB in 65 ms
```

**continuity エラー 0、不正 section 0、同期外れ 0。**分離は 65 ms で、
live の流量（約 2 MB/s）に対して 3 桁の余裕がある。

見つかった構成:

| program | 内容 |
|---|---|
| 1024 / 1025 | HD 本編（同一 PID を共有。映像 0x0100、音声 0x0110/0x0111、字幕 0x0130/0x0138） |
| 1408 | ワンセグ（0x0581 が stream_type 0x1b = H.264） |
| 65520 | データ・技術用 |

PES の内訳（program 1024、18.4秒）:

| PID | 種別 | PES 数 | PTS 幅 |
|---|---|---:|---:|
| 0x0100 | MPEG-2 映像 | 549 | 18.39 s |
| 0x0110 | AAC 主音声 | 857 | 18.26 s |
| 0x0111 | AAC 副音声 | 857 | 18.26 s |
| 0x0130 | ARIB 字幕 | 24 | 16.07 s |
| 0x0138 | 文字スーパー | 0 | — |

857 AAC フレーム × 1024 標本 / 48000 = 18.28 秒。映像・音声・字幕の尺が揃う。

### 描画（Chrome 152）

描画まで Worker で完結させる。`OffscreenCanvas` を渡せば `VideoFrame` を
スレッド間で渡す必要がなく、main thread は UI だけを見ていられる。

**`transferControlToOffscreen()` は同じ canvas 要素に一度しか掛けられない。**
二度目は `InvalidStateError` になる。受信を開き直すたびに掛け直す作りにすると、
一時停止から再生へ戻せない。canvas 要素そのものを作り替えて渡す
（`VideoPlayer.takeOffscreen()`）。

I420 のまま `VideoFrame` に渡し、`drawImage` で描く。3面を1本の連続した
バッファへ写す1回が、表示経路で唯一のコピーである。`visibleRect` で
符号化 1440x1088 から表示 1440x1080 を切り出し、`displayWidth` に標本比 4:3 を
掛けて 1920x1080 として見せる。

| 素材 | 表示フレーム | 復号に使った時間 | 遅延 |
|---|---:|---:|---:|
| 実放送 17.85 秒 | **535** | **2.71 s** | **0 ms** |

**実時間再生で 6.6 倍の余裕。**フレーム落ちも遅延も無い。

描画の正しさは合成素材（testsrc2 のカラーバー）で確認した。色順が正しく
U/V の取り違えが無いこと、幾何が崩れていないことを目視した。放送素材では
同じ経路で同じフレーム数（535）が出ており、Node での測定とも一致する。

### 測定していないこと

- **音声は未実装。**WebCodecs の AAC が使えることは7章で確認済みだが、
  PES から ADTS を取り出して鳴らすところはまだ無い。A/V 同期も未着手。
- **字幕は未実装。**PID は取れているが ARIB STD-B24 の解釈はこれから。
- **インターレース解除は無い。**素材は tff だが、そのまま描いている。
- **live 接続は未着手。**いまはファイルからである。live では ES を
  溜め続けるわけにいかないので、流量制御が要る。
- 長時間再生時のメモリは見ていない。最長 18 秒である。

---

## 18. チューナーから画面まで一本で繋がる

`live.html` / `src/video/live-page.ts`。受信・復号・分離・MPEG-2 復号・描画を
ブラウザ内で連続して行う。**ファイルを経由しない。**

```
WASM（page main thread）   USB → B25 復号 → 復号済み TS を溜める
     ↓ drain（消費したぶんだけ）
Player Worker              分離 → MPEG-2 復号 → OffscreenCanvas
```

WASM をページの main thread に置くのは、その中の pthread が WebUSB の Promise を
main へ委譲して待つからである（12章）。main がやるのは memcpy と postMessage だけ。

### 補充は消費側が要求する

**main が自分の周期で押し込んではいけない。**表示より速く送れば遅延が積み上がり、
遅く送れば止まる。Worker が水位を割ったときだけ `want` を出し、main はそれに
応えて drain する。

最初は「1つ消費したら1つ要求」にして失敗した。1回の要求で返るのは TS の塊
（MiB 単位）、1回に消費するのは PES ひとつ（数十 KiB）で、**供給が2桁過剰になり
早送りになった**（10秒で 510 フレーム = 51 fps）。水位で頼めば要求と消費の粒度が
揃わなくてよい。低水位 1 MiB にして実時間になった。

### 刻みは滞留量で微調整する

放送の時計とこちらの時計は独立なので、`frame_period` をそのまま刻むと必ずずれる。
**実測で60秒に 1.2 MiB（約0.6秒）滞留が増えた。**放置すれば 16 MiB の上限まで
9分で到達して捨て始める。

滞留（Worker の ES + WASM 側の残り）を見て刻みを ±5% まで伸縮させる。
PCR から時計を復元するのが本筋だが、滞留を見るほうが仕組みが少なく、
入力が途切れても壊れない。

| 経過 | 滞留（ES + 未取り出し） |
|---:|---:|
| 補正なし 20 s | 0 KiB |
| 補正なし 60 s | 1199 KiB（増加中） |
| 補正あり 30 s | 1341 KiB |
| 補正あり 125 s | 1236 KiB（**増えない**） |

### 測定（PX-Q3U4、ch27、global receiver 2、Chrome 152）

4分40秒の連続視聴を完走。

| 項目 | 値 |
|---|---|
| 表示フレーム | **8,377**（279 秒ぶん） |
| 分離した packet | 2,427,867 以上 |
| 同期外れ / continuity / 不正 section / 未復号 | **すべて 0** |
| 詰まって捨てた TS | **0 KiB** |
| 刻み直し | **0** |
| 復号に使った時間 | 35.6 s / 210 s（**約6倍の余裕**） |
| 停止 | 正常終了、再開可能 |

### 背面タブでも止まらない

12章で main thread のタイマーが背面タブで 1/100 に絞られることを測っている。
**live ではそれを踏まない設計にした。**drain を駆動するのは main のタイマーでは
なく Worker からの `want` メッセージで、メッセージ配送は絞られない。

タブを背面へ回した状態で30秒測った結果:

| | |
|---|---|
| `document.visibilityState` | `hidden` |
| 表示レート | **30.21 fps**（公称 29.97 に対し +0.8%、滞留を戻している最中） |
| 捨てた TS | 0 KiB |

20 ms のタイマーは取りこぼしの拾い直しに残してあるが、絞られても
メッセージ駆動のほうが動き続ける。

### 停止時の AbortError について

停止すると `AbortError: Failed to execute 'transferIn' on 'USBDevice':
The transfer was cancelled.` が数本コンソールへ出る。**これは保留中の bulk 転送が
キャンセルされた記録であり、1章の所有権修正が働いている場所そのものである。**
libusb の backend が reject された Promise をそのまま流しているだけで、
停止は `error OK` で完了している。うるさいので将来は黙らせたい。

### 測定していないこと

- **音声・字幕は無い。**PID は取れているが鳴らしていない。
- 最長 4分40秒。**30分は未実施**で、M1 の受け入れ条件は未達のまま。
- 視聴中のチャンネル切替は無い。止めて選び直すしかない。
- 受信中の USB 抜去・カード抜去は試していない。
- 刻みの伸縮は比例制御だけなので定常偏差が残る。実測では滞留が目標より
  0.2 MiB ほど多い位置で釣り合っている。実害は見ていないが、**PCR を使った
  時計復元に置き換える余地がある。**

---

## 19. 音声が鳴り、映像がそれに合う

`src/video/audio.ts`。地デジの音声は AAC-LC で、WebCodecs の `AudioDecoder` が
そのまま受ける（7章）。PES の中身は ADTS なので `mp4a.40.2` として渡すだけでよく、
`description` も変換も要らない。

**音声は main thread でしか鳴らせない。**Web Audio は Worker に無く、AudioWorklet も
main から作る必要がある。したがって Worker は音声 PES を復号せずそのまま main へ渡し、
main が `AudioDecoder` → `AudioContext` へ並べる。

### 時計は音声が持ち、映像が追う

映像を1フレーム落としても気付かれにくいが、**音が途切れるのはすぐ分かる。**
だから音声を PTS どおりに並べ、映像をそれに合わせる。

`AudioContext.currentTime` と PTS を1点で結び、以後は
`anchorTime + (pts - anchorPts) / 90000` に置く。main は 100 ms ごとに
「いま鳴っている位置」を PTS で Worker へ送り、Worker は経過時間で間を補って
フレームの表示時刻を決める。音声が無い番組や鳴り始める前は、18章の
自前の刻み（滞留で伸縮）に落ちる。

### 表示順と PTS の対応には picture tag を使う

**PES と一緒に PTS を持ち回ってはいけない。**B ピクチャがあると符号化順と表示順が
食い違うので、chunk に紐づけた PTS は違うフレームに付く。libmpeg2 には
`mpeg2_tag_picture()` があり、`mpeg2_buffer()` の直後に呼ぶと、そのバッファが
運ぶピクチャに印が付き、**表示されたときに `display_picture->tag` として返る。**
これがこの API の用途そのものである。`native/mpeg2-decoder.c` に
`webts_mpeg2_tag()` を足して通した。

`bytes_since_tag` で「いま解析中のピクチャか、ひとつ前か」を上流が判断するので、
`mpeg2_buffer()` の直後以外で呼んではいけない。

### 測定（PX-Q3U4、ch27、global receiver 2、Chrome 152）

4分35秒の連続視聴。

| 項目 | 値 |
|---|---|
| 表示フレーム | **8,227** |
| 音声フレーム | 6,013 以上（**取りこぼし 0、エラー 0**） |
| **音声の置き直し** | **0** |
| A/V ずれ | **-2 〜 +18 ms**（0 を挟んで振れる） |
| 刻み直し | **0** |
| 分離カウンタ | 1,473,996 packet で**すべて 0** |
| 詰まって捨てた TS | **0 KiB** |

A/V ずれは ±20 ms 以内に収まっている。口元のずれとして感じ取れるのは
一般に ±40 ms 程度からなので、余裕がある。

### 滞留は増えない

音声が時計を持つと、18章の滞留制御（刻みの伸縮）は使われなくなる。
供給へ押し返すものが無くなるので増え続けないか疑ったが、増えなかった。

| 経過 | 未取り出しの TS | 未復号の ES | 合計 |
|---:|---:|---:|---:|
| 157 s | 1798 KiB | 1114 KiB | 2912 KiB |
| 214 s | 1083 KiB | 1646 KiB | 2729 KiB |
| 275 s | 1109 KiB | 1709 KiB | 2818 KiB |

**合計は 2.7〜2.9 MiB で安定している。**2つのバッファの間で行き来しているだけで、
片方だけを見ると増えているように見える。最初に「未取り出しの TS が
1509 → 1798 KiB で増えている」と読んだのは早合点だった。

音声を PTS どおりに置く以上、消費の速さは放送の時計で決まる。サウンドカードの
時計との差は音声バッファの深さに現れ（0.56〜0.94 s で推移）、許容を超えれば
置き直しで吸収される。**4分35秒では置き直しは1度も起きていない。**

### 測定していないこと

- **置き直しの頻度は分かっていない。**サウンドカードと放送の時計差で必ずいつかは
  起きるが、4分35秒では観測できていない。起きると音が飛ぶ。
- **副音声は鳴らしていない。**PID は取れているが、主音声だけを選んでいる。
  0.1.0 で副音声を扱うかは未決。
- 音声だけの番組、音声が途中で切り替わる場合は試していない。
- 字幕は未実装。
- インターレース解除は無い。

---

## 20. ARIB STD-B24 字幕が出る

`src/video/captions.ts`。解釈と描画は `aribb24.js`（MIT、monyone 版）に任せる。
B24 は8単位符号系に JIS X 0201/0208、外字、DRCS、制御符号による画面座標指定まで
含む仕様で、自前で書き直すところではない。KonomiTV が使っているのも同じ実装である。

**これは vendor/ の方式から外れて npm 依存にしている。**自分でビルドしない
TypeScript ライブラリで、`package-lock.json` が完全性ハッシュ付きで固定する。
推移依存は無く、npm の配布物に `src` も含まれるので GPL の対応ソースも満たせる。
THIRD_PARTY_NOTICES.md に監査として記録した。

### 経路

Worker が字幕 PES を**解釈せずそのまま** main へ渡し、main が `MPEGTSFeeder` へ
入れて `CanvasMainThreadRenderer` で描く。aribb24.js の描画は DOM を要求するので
Worker には置けない。字幕 PID は PMT の stream_type 0x06 のうち
**component_tag 0x30（主字幕）**を選ぶ。0x38 は文字スーパーで別物。

時計は音声と共通（PTS）。音声・映像・字幕が同じ基準で動く。

### `prepare()` を毎回呼んではいけない

最初に動かなかった原因はこれだった。`prepare(t)` は開始点を置き直すもので、
`content(t)` は**前回の時刻から今回まで**を取り出す。直前に同じ時刻で
`prepare` を呼ぶと範囲が空になり、何も出てこない。

```
✗ feeder.prepare(t); feeder.content(t)   // 範囲が空。永久に null
✓ feeder.content(t)                      // 時刻の管理は content 自身がやる
```

入力そのものは最初から正しかった。字幕 PES の先頭は `80 ff f0 …` で、
data_identifier 0x80（字幕）、private_stream_id 0xFF、
PES_data_packet_header_length 0 の同期型 PES で、上流の `demuxPES` が期待する形である。
20 バイトの `data_group_id 0x20`（字幕管理）と 145 バイトの `0x21`（字幕文）の
両方が流れていた。

### 表示比を入れていなかった

字幕を重ねて初めて気付いた。canvas の内在寸法は符号化された 1440x1080 のままで、
**標本比 4:3 を表示に反映していなかったので横に潰れていた。**入れ物に
`aspect-ratio: 16 / 9`（= pictureWidth × pixelWidth : pictureHeight × pixelHeight）を
与え、canvas を入れ物いっぱいに伸ばす形に直した。映像だけ見ていたときは
気付かなかった。

### 測定（Chrome 152）

| | ファイル再生（18秒） | live（25秒） |
|---|---:|---:|
| 字幕 PES 受信 | 24 | 32 |
| 描画 | 7 | 5 |
| エラー | **0** | **0** |
| 音声取りこぼし | 0 | 0 |
| A/V ずれ | 16 ms | 26 ms |

重なり位置を画素で確認した。映像 canvas と字幕 canvas はどちらも
**同じ位置・同じ大きさ**（@8,291 の 960x540）に収まり、字幕の不透明画素は
960x540 の座標系で (170,388)-(649,508) に 41,280 画素。下部中央で、
日本語字幕の標準的な位置である。放送内容は取り出していない。

### 測定していないこと

- **DRCS（外字）と文字スーパーは確認できていない。**今回の放送区間に
  出てこなかった。文字スーパー（component_tag 0x38）は PID を取っているだけで
  流していない。
- 字幕の表示/非表示の切替、位置や大きさの調整は無い。
- ルビ、縦書き、フラッシングは未確認。
- 副音声・副字幕は選べない。

---

## 21. 未達のまま残っていること

- **M1 の受け入れ条件**（両機種で各30分の生TS、transfer error / overflow 0、メモリ増加上限、
  切断後の安全停止）は未達。PX-Q3U4 では15秒の受信までが取れている（13章）が、
  30分連続・メモリ上限・切断後の安全停止は未測定。PX-S1UD は未着手。
- **M2**（B25 とカード経路）は成立した（14〜16章）。ただし長時間運転、
  切断・抜去時の挙動、複数受信機の同時使用は未検証。
- PX-Q3U4 について、chooser の2行と同一 descriptor は観測したが、**物理2 instance への
  一意対応は証明していない。**
- PX-S1UD の firmware / mode 適用後の再列挙と USB 識別子変化は未観測。
