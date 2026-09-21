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

## 12. 未達のまま残っていること

- **M1 の受け入れ条件**（両機種で各30分の生TS、transfer error / overflow 0、メモリ増加上限、
  切断後の安全停止）は未達。実 firmware 送信、選局、実 TS 受信は未実施。
- **M2**（B25 とカード経路）は未着手。facade の生成・設定・解放が通っただけで、復号は未検証。
- PX-Q3U4 について、chooser の2行と同一 descriptor は観測したが、**物理2 instance への
  一意対応は証明していない。**
- PX-S1UD の firmware / mode 適用後の再列挙と USB 識別子変化は未観測。
