# 固定upstream source

このディレクトリの `vendor/upstream/` は、WASM化の調査対象を再現できるよう、
upstream commitを固定したsource-only snapshotである。これはまだEmscriptenで
ビルド済みの実機経路ではなく、firmware、実行binary、放送キャプチャを含まない。

| component | origin | pinned commit/tag | license | vendored scope |
| --- | --- | --- | --- | --- |
| Siano userland | `https://github.com/Khronos31/siano-userland.git` | `eb73192e4e6dbdc4b84502ccfc5ec14f5ce86c86` (`main` at 2026-09-19) | GPL-2.0-or-later (`COPYING`, `LICENCE.siano`) | protocol/stream C sources and headers only |
| PX4 userland | `https://github.com/Khronos31/px4-userland.git` | `10a373dbda0603b2d8180bb2508e2d88dd70eb2d` (`main` at 2026-09-19) | GPL-2.0-only (`LICENSE`) | `userland/include` and `userland/src` sources; firmware-named files excluded |
| libusb | `https://github.com/libusb/libusb.git` | `87a55632db62c9bdc58cd31d3ccfa673f1bb017f` (`v1.0.30`) | LGPL-2.1-or-later (`COPYING`) | official `libusb/` core and OS backends, including `emscripten_webusb.cpp` |
| libaribb25 | `https://github.com/shirow-github/libaribb25.git` | tag `v0.2.10` (`b978fe5caf6bfe162e944ad4d323b7c0205276e3`; tag object `51dfd21fd803062520131ab52d987ac5897eb2f3`) | ISC (`LICENCE`) | `multi2`, `ts_section_parser`, and upstream facade source; PC/SC implementation and test CLI excluded |

Commit IDs are the source checksums used for retrieval. `vendor/SOURCE_LOCK.json`
records per-file SHA-256 values for the selected snapshot, and
`scripts/check-vendor-sources.ps1` checks those values and rejects firmware/binary
extensions. The vendor tree is intentionally not wired into the current Vite build:
Emscripten, ABI flags, and the JS/WASM lifetime boundary must be verified before any
runtime adapter is exposed.

The vendored PX4 files retain their upstream `PROVENANCE.md` and `SPEC.md`; the Siano
files retain both upstream license notices. No source was translated into TypeScript,
and no libusb backend was modified or replaced. Updating a snapshot requires changing
the pinned commit, regenerating `SOURCE_LOCK.json`, reviewing the license and excluded
file report, and recording any local patch separately.

The libaribb25 snapshot retains the upstream `LICENCE`, `README.md`, and a local
`PROVENANCE.md`. The TS section parser, MULTI2 core, and upstream `arib_std_b25.c/.h`
facade plus interface/error headers are included. The upstream `b_cas_card.c`, `td.c`,
PC/SC/card integration, keys, binaries, firmware, and captured TS are excluded. The
facade is compiled only by the disconnected no-card create/configure/release smoke ABI;
this does not claim card access or descrambling.

## 監査と最小ビルド導線

Sianoの固定commitの全ツリーを照合した結果、実装に必要なトップレベルのC/Hは
`protocol.c/.h`、`siano-ts.c`、`siano-clock.h`、`siano-os.h`、
`stream-state.c/.h`の全7件であり、すべて同梱している。tests、CLI/mdev包装、
platform scriptは同梱していない。PX4も `userland/include` と `userland/src` の
source-only集合を同梱し、`firmware*` は除外している。

公式libusbの必要なcore、POSIX event/thread glue、`os/emscripten_webusb.cpp`を
使う最小のbuild-only smoke導線を
[`scripts/build-libusb-webusb.ps1`](../scripts/build-libusb-webusb.ps1) に置いた。
Emscriptenの `em++` が見つからない場合は明示的に停止し、独自USB互換層や実機転送を
作らない。導線は公式configureの `--bind -s ASYNCIFY`、memory growth、Web環境指定を
再現するが、現時点では実行時WebUSB接続を検証しない。Emscripten導入後に次で確認する。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-libusb-webusb.ps1
```

Emscripten 6.0.9（`em++`）では上記smoke buildが成功し、`build/libusb-webusb/` に
JS/WASMと中間objectを生成した。公式backendが要求するatomicsのためpthreadフラグを
使うので、将来ブラウザ実行へ進む場合はCOOP/COEP、SharedArrayBuffer、Worker寿命管理を
別途検証する。このsmokeは `libusb_init` / `libusb_exit` のリンク確認だけであり、
`navigator.usb.requestDevice()`、デバイス列挙、endpoint転送は実行していない。

libusbの生成moduleは`ENVIRONMENT=web,worker`を明示し、WindowとDedicated Workerの双方で
同一公式backendをloadできる構成にした。`src/usb/webusb-enumeration-worker.ts`はWorker
`navigator.usb.getDevices()`と既許可集合のlibusb列挙だけを行い、固定count/diagnostic/context
だけを返す。Worker側に`requestDevice()`経路はなく、permission取得はWindowのユーザー操作に
限定する。公式列挙に伴う一時open・標準descriptor control-INは発生し得るため、完全な無操作
ではなく、claim/bulk/firmware/tune/TSなしのread-only descriptor診断として扱う。
timeout後のWorker terminateは保留Promiseやdevice handleの物理解放を保証しない。

2026-09-20、Chrome M1ページで既許可PX-S1UD 1台を対象にWorker列挙を実測した。pthread通常と
non-pthread Asyncifyの両variantが`NONE`、Worker WebUSB available、authorized `1/1`、delta
`0`、WASM `1`、WASM WebUSB probe `1`、probe/diagnostic `OK/NONE`、execution context
`DEDICATED_WORKER`を返し、chooserは表示しなかった。公式backendの一時open/標準descriptor
control-INはあり得るがclaim/bulkはなく、terminateによるpending transferの物理解放は未証明である。

Siano `siano-rio-enumeration` moduleも`ENVIRONMENT=web,worker`で生成し、同じDedicated Worker
からsource-backed `ts_queue`/live-statsのUSB-free fixtureを呼ぶopt-inボタンを追加した。kind、
scenario、固定統計だけを表示し、実open/claim/clear-halt/start/version、firmware、tune、TS、
payload、`navigator.usb`へ接続しない。Worker terminateの途中cleanup保証がないため、実機経路
はUIへ接続していない。

2026-09-20、Chrome M1でSiano Worker実WASMを確認した。QUEUE scenario 0はOK（accepted/
dequeued 5/5、drop 0、FIFO/reinit true）、LIVE_STATS scenario 1はOK（OPEN、generation 1、
queue 2、drop 0、active 0、counter patch適用前のbytes/errorはnull）だった。LIVE_STATS時
scenario 4のdisabledも確認した。これはUSB-free synthetic ABIのWorker実行であり、実機Siano
lifecycleやstream/versionを検証したものではない。counter patch適用後の値の意味と境界は
後記のlive statistics節に記録する。

upstream coreの最小overlayは
[`scripts/build-upstream-wasm-overlay.ps1`](../scripts/build-upstream-wasm-overlay.ps1) で
生成する。PX4は `error.cpp`、`identity.cpp`、`libusb_transport.cpp` と公式libusb
objectsだけをリンクする。`px4-transport-smoke.js` は
`webts_px4_portable_link_smoke` というC ABI exportを持ち、upstreamの
`parse_q3u4_serial` と `map_libusb_error` を純粋呼出しすることで、identity/transport
実装のリンク保持を確認する。このABI smokeは固定の合成serialだけを検査し、
`Q3U4Runtime`を構築せず、open、claim、write、firmware、tune、stream transferを行わない。
加えて `scripts/px4-enumeration-shim.cpp` の
`webts_px4_enumerate_native_summary` は、upstreamの
`Q3U4Runtime::enumerate_native()` を呼ぶ実コードをリンクに保持する。戻り値は固定
`Error` enumと上限255の候補数・ready/incomplete group数を詰めた整数だけであり、
serial、bus/port path、descriptor、ログ、payloadは公開しない。このexportは現在のUIから
呼ばず、実機アクセスを発生させない。将来呼ぶ場合もAsyncifyの
`Module.ccall(name, "number", [], [], { async: true })`を使い、公式backendの一時openと
標準descriptor control-INを伴う診断であることを明示する。
PX4のcontrol/IPC、PCSC、frontend/tune、firmware、Q3U4の2台grouping実行はこのoverlayに
含めない。Sianoは元の `protocol.c`、`stream-state.c`、`siano-ts.c` をlibusb objectsと
リンクできることを確認するが、`siano-ts.c` のPOSIX CLI、firmware path、実機USB操作は
ブラウザ経路として公開せず、`siano-ts-smoke.js` はsource buildability確認用に限る。

Sianoのread-only Rio確認には `scripts/siano-rio-enumeration-shim.c` を使う。vendorの
`siano-ts.c`を変更せず、overlay translation unit内でCLI `main`だけをrenameしてsourceを
includeし、同ファイル内のstatic `is_rio_id()`をそのまま再利用する。新たなVID/PID定義や
TypeScriptでの判定複製は行わない。shimは公式libusbのdevice list/descriptorを呼び、戻り値を
固定diagnosticと上限255の対応台数へ限定する。firmware、claim、bulk、tune、TS処理は含めず、
`siano-rio-enumeration-browser.js`は明示overlay build時だけ生成されるignored build成果物であり、
Emscriptenの`EXPORTED_RUNTIME_METHODS=["ccall"]`を必須とする。overlay buildは生成JSに
`Module["ccall"]`が公開されていることも検査する。
このsource-include方式は将来Siano判定を独立libraryへ分離するまでのbuild-only境界であり、
UIは「既許可Siano Rioだけを確認」ボタンからAsyncify `ccall(..., { async: true })`でのみ
opt-in実行できる。公式backend列挙に伴う一時openと標準descriptor control-IN、global log
callbackによるraw log抑止を含むが、書き込み・serial・payloadは公開しない。

### Siano Rio Chrome実測（親エージェント確認）

2026-09-19、`http://localhost:5173/m1.html` の「既許可Siano Rioだけを確認」を実行した。
対象は前段の一般WASM列挙でも確認済みのPX-S1UD `0x3275:0x0080` 1台である。初回は
Siano moduleのEmscripten `ccall` runtime export漏れにより `INVALID_MODULE` となったが、
`EXPORTED_RUNTIME_METHODS=["ccall"]`追加・再ビルド後は次を得た。

| authorizedDeviceCount | supportedDeviceCount | diagnostic |
| ---: | ---: | --- |
| 1 | 1 | `NONE` |

これはvendor `siano-ts.c` のstatic `is_rio_id()`を再利用した読み取り列挙の成功であり、
公式backendの一時openと標準descriptor control-INを伴う。firmware、claim、bulk、tune、
TS受信、B25の成功ではない。旧失敗は上記の初回診断としてのみ記録し、対応後の結果と
重複する未解決観測は残さない。

### Siano lifecycle Chrome実測（親エージェント確認）

2026-09-19、同じ `http://localhost:5173/m1.html` で、JS/WASM Siano列挙がともに
PX-S1UD `0x3275:0x0080` 1台・`NONE`であることを確認後、「Siano open→close診断
（実機操作）」を1回実行した。

| authorizedDeviceCount | supportedDeviceCount | diagnostic | open | close |
| ---: | ---: | --- | --- | --- |
| 1 | 1 | `NONE` | `NONE` | `NONE` |

その後の読み取り列挙も1台・`NONE`だった。これはone-shot native `open_rio()`→
`close_device()`の固定code結果である。interface claimと両endpoint clear-haltは試行されるが、
upstreamはclear-halt戻り値を無視し、close時のrelease結果も報告しないため、各操作の個別成功は
断定しない。firmware/tune/TS/B25、切断・再接続は未検証である。

Siano lifecycleのbuild-only確認には `webts_siano_lifecycle_create_close` を使う。
これはupstream `init_device_state()`が完全成功した場合だけ `close_device()`を呼ぶ。
初期化途中失敗はupstreamに完全なrollback APIがないため固定失敗codeとして返し、
`close_device()`を無条件には呼ばない。`open_rio()`はclaimと両bulk endpointの
clear-halt、およびupstreamのstderr診断を伴う。既存のone-shot open→close exportは
明示的な実機操作で一度検証済みだが、分離open/closeはUIへ接続しない。
`webts_siano_lifecycle_open_link_smoke` は `open_rio`/`close_device` の関数ポインタを
参照してリンク保持だけを検査する。実行可能exportは明示承認後に追加したが、未接続の
build/static検証では呼び出さず、interface claim/clear-haltは発生させていない。
明示承認後に実装した `webts_siano_lifecycle_open(magic,index)` /
`webts_siano_lifecycle_close(magic)` は、magic gate、index上限、単一セッション、
成功init後のみclose、open失敗時cleanup、冪等closeと再openを持つ。内部状態は
`IDLE/OPENING/OPEN/STARTING/STREAMING/VERSIONED/CLOSING/POISONED`で、非IDLEの再openはBUSY、partial-init失敗は
POISONEDとして再試行を拒否する。magicは誤呼出し防止でありsecurity boundaryではない。
現UIは接続せず、将来ロードするloaderはEmscriptenの
`print`/`printErr`を空sinkへ渡してraw stdout/stderrを抑止する。USB関数呼出しはこのターン
のbuild/static検証では行っていない。
`webts_siano_lifecycle_open_close_probe(magic,index)` はopen→closeを同一native call内で
順次実行し、low byte=open、次byte=closeの固定codeだけを返す。UIはJS/WASM双方で対象が
正確に1台のPX-S1UDと確認した場合だけこのone-shotを使う。openはinterface claimと両endpoint
clear-haltを試みるが、upstreamがclear-halt戻り値を無視するため成功codeはclear-halt成功を
意味しない。列挙ボタンと異なりdevice-affecting操作なので、firmware/tune/TS/B25には進まず、
ブラウザでの実行は明示的な実機担当操作に限る。

`webts_siano_lifecycle_start_version(magic)` は、open済みsessionだけを対象にupstreamの
`start_streaming()`と`get_version()`を順次呼ぶ次段のbuild-only ABIである。low/high byteに
固定diagnosticを返す。startの非ゼロはpthread/allocator/libusbの戻り値混在を避けて常に
`OTHER`、versionは明示的な`-ETIMEDOUT`だけ`TIMEOUT`、その他は`OTHER`とする。partial submitでもcloseがcleanupできるよう状態をSTREAMINGへ進める。
bulk-IN submitとbulk-OUT requestを伴うため、UIには未接続で、Chrome/実機ではまだ呼び出して
いない。firmware uploadや`set_device_mode()`の代替ではない。

open→start_streaming→get_version→closeを束ねるone-shotは安全性の理由で出荷していない。
公式libusb WebUSB backendの`em_cancel_transfer()`は保留中`transferIn` Promiseを物理的に
中断せず、upstream `stop_streaming()`のpthread joinがPromise解決まで待つため、idle device
ではcloseのbounded completionを保証できない。公式backendを改変・代替実装せずにこの問題を
解決できるまでは、one-shot WASM exportとUIボタンを追加しない。既存open→close（streaming
なし）と未接続build-only start/version seamだけを保持する。

### Siano firmware staging boundary

`webts_siano_firmware_validate_stage(bytes,size)` は、vendorの
`sms_parse_firmware_header()` と `read_file()` を再利用するbuild-only ABIである。入力は
16 MiBに制限し、header 12 bytesとdeclared lengthを検査するが、upstream parser自体は
checksumや真正性を検査しない。固定private MEMFS path `/tmp/webts-siano-firmware.bin`
へ一時書込みし、path-bearing `read_file()`で同じbytesを再読した後、読み出しbufferを
zeroize/freeし、ファイルをzeroizeしてunlinkする。失敗時もunlinkを試行し、固定codeだけを
返す。caller-owned WASM heapのzeroizeはJS側の責務である。

固定codeは `OK=0`、`TOO_LARGE=1`、`INVALID_INPUT=2`、`HEADER_INVALID=3`、
`STAGE_FAILED=4` である。

このABIは `start_streaming()`、`set_device_mode()`、`load_family2_firmware()`、libusb
transferを呼ばず、firmwareを取得・vendor・永続化・ログ出力しない。したがってこれは
`set_device_mode()`が将来必要とするpath境界を検証するだけで、実機firmware uploadや
firmwareの安全性・一致性を保証しない。合成入力とoverlayのbuild/static検証のみを対象にし、
実機/UIからは未接続である。

### PX4 identity/grouping mock seam

PX4 overlayは`webts_px4_grouping_mock_summary(scenario)`もexportする。これは新しいTS実装や
シリアル規則の複製ではなく、vendored `identity.cpp` の`group_q3u4_devices()`へ合成観測を
渡すsource-backed検査である。固定scenarioはready pair / incomplete / duplicate / 2 ready
groupsで、ABIは`Error`、候補数、ready数、incomplete数のみを返す。fake serialはWASM内部の
合成入力に限り、serial/base_serial/topology/rawログをUI・JSへ返さない。

このseamは`Q3U4Runtime::enumerate_native()`やlibusbを呼ばず、open、claim、serial read、
control/command、firmware、tune、TSも行わない。実機Q3U4の2台grouping成功を意味せず、
upstream identity/grouping logicのoffline保持と回帰検査だけを目的とする。生成moduleは
Asyncify `ccall`を公開し、`m1.html` の独立した合成mockボタンから呼び出せる。これは
`navigator.usb`やWebUSB権限を要求せず、synthetic inputだけを処理する。

同じPX4 overlayには`webts_px4_runtime_mock_open_close`も追加した。これはvendorの
`RuntimeTestAccess::open_native()`へ、overlay translation unit内の合成`LibusbApi`を渡し、
upstreamの発見・grouping・2台open/claimと、`Q3U4Runtime`デストラクタによる2台release/close
を実際に通す。返り値は内部cleanup検証を含む固定`Error`だけであり、合成serial、descriptor、
USB payload、API呼出し回数は公開しない。fake APIは実libusb/WebUSBを呼ばないため、これは
実機Q3U4のopen/close検証ではない。`m1.html`の「PX4 runtime open→close
（合成mockのみ）」ボタンからこのfixtureを実行できるが、`navigator.usb`や実USBには依存しない。
JSから利用する場合もAsyncify `ccall`を使い、raw exception/logは固定`INTERNAL`へサニタイズする。

2026-09-20、親エージェントがChromeで同ボタンを実行し、status `PX4 runtime mock OK`、
JSON `{"diagnostic":"OK"}` を確認した。これは合成WASM/UI導線の確認であり、実Q3U4の
USB open/closeやserial取得の検証ではない。

### PX4 grouping mock Chrome実測（親エージェント確認）

2026-09-20、親エージェントがChromeの `http://localhost:5173/m1.html` で4シナリオを
実行した。すべて `diagnostic: OK` となり、次の固定集計を得た。

| scenario | candidateCount | readyGroupCount | incompleteGroupCount | diagnostic |
| ---: | ---: | ---: | ---: | --- |
| 0 (ready pair) | 2 | 1 | 0 | `OK` |
| 1 (incomplete) | 1 | 0 | 1 | `OK` |
| 2 (duplicate slot) | 3 | 0 | 0 | `OK` |
| 3 (two ready groups) | 4 | 2 | 0 | `OK` |

この観測は合成mockのWASM/UI導線確認に限られ、実際のQ3U4機器、2台組み合わせ、serial
取得、USB open/claim、control/command、firmware、tune、TSを検証したものではない。

### PX4 TaggedTsDemux synthetic fixture

既存PX4 overlayにvendor `tagged_ts_demux.cpp/.h`を直接compile/linkし、
`webts_px4_tagged_ts_demux_mock`を追加した。合成wire tag `0x17/27/37/47`の4連続同期、
分割入力、invalid tag/TEI、sync loss、sink failure後のempty retry、reset、入力上限を
固定scenarioで検査する。返り値は診断、入力/排出/破棄/保留件数、receiver別packet数だけで、
packet payload・serial・USB状態は返さない。`m1.html`の専用ボタンはUSB権限を要求せず、
実Q3U4、command、firmware、tune、実TS受信には接続しない。TaggedTsDemuxの実装・容量・
retry契約はvendor sourceに委ね、TypeScript側では再実装していない。

2026-09-20、修正版generated WASMを親エージェントがChromeでscenario 0〜5まで実行し、全て
`OK`を確認した。scenario 0/1はaccepted 752・emitted 4・receiver各1、scenario 2はaccepted
2,068・emitted 8・discard sync-search 188・invalidTag 2・syncLoss 1・receiver各2、scenario 3は
`retryVerified: true`、scenario 4は`resetVerified: true`、scenario 5は`boundaryVerified: true`
だった。初回は`HEAPU8`/`_malloc`/`_free`未exportのため`INTERNAL`だったが、export修正後に再build・
再確認済みである。合成WASM/UIのみの観測で、実USB・実TS受信・Q3U4実機は未実行である。

`m1.html`には、このABIへ接続するローカル検査ボタンも追加した。Siano READMEの既知SHA-256
`054520642d5d09cb7ab7d08dbd6fd9ba9365de56adf2e7d7d06927f9845ff818`をWebCryptoで先に照合し、
不一致時はWASMロードとUSB経路を短絡する。一致時も `HEAPU8`へ一時copyしてAsyncify
`ccall`するだけで、USB open/claim/transferや `set_device_mode()`は呼ばない。WASM heapと
JSの一時bufferはbest-effortでzeroize/freeし、ファイル名・path・bytes・実digestは公開しない。
この導線のUSB実機経路は未検証で、成功はhashとheader/path検査だけを示す。

2026-09-19、親エージェントがChrome `http://localhost:5173/m1.html` で実際に選択した
`isdbt_rio.inp`を検査し、AX観測は `SHA-256一致・upstream header/path検査完了（upload未実行）`、
diagnosticは `NONE`だった。実firmwareのbytes・ファイル名・digestは記録していない。この結果は
local hash/header/path検査に限られ、USB upload、open/claim、streaming、mode、tune、TS、B25を
意味しない。

このsubsetは「PX4全体のブラウザ移植」ではない。`it930x.cpp`/`it930x_protocol.cpp`
（firmware・bridge command）、`q3u4_frontend*`/`q3u4_stream.cpp`（電源・選局・TS）、
card/PCSC、control server/client、IPC、POSIX CLIは、実機I/Oまたはブラウザ非対応の
依存を含むため明示的に除外している。今後これらを加える場合も、まず依存と権限境界を
別途監査し、build-onlyと実機経路を混同しない。なお公式libusb WebUSB backendは
Emscripten上でbus/addressをWebUSB session由来の合成値にする一方、PX4のQ3U4 grouping
は15桁serialの末尾1/2を使うため、device identity適合性は未検証であり、serialをこの
smokeやUIへ公開しない。

Emscripten 6.0.9で両overlayのコンパイル・リンクが成功した。これは未接続のWASM
link smokeであり、WebUSB権限、`requestDevice()`、実機enumeration/endpoint転送、
firmware upload、選局、TS取得を実行しない。次の統合では、M0のJS `requestDevice()` と
WASM側libusb `getDevices()` の境界、ならびにWorker/handle cleanupを別途設計する。

libaribb25 v0.2.10のupstream `arib_std_b25.c/.h` facadeと`b_cas_card.h`等のinterface
headerもsource-onlyで同梱した。`webts_b25_facade_no_card_smoke`はfacadeの生成、EMM無効化、
188-byte設定、空program状態、releaseだけを検査する。PC/SC実装`b_cas_card.c`、カード
callback、TS入力、keys、firmware、captured TSは含めず、復号成功を装わない。

M1の`m1.html`には「B25 上流facade（カード/TSなし）」のopt-inボタンを追加した。これは
生成された`webts_b25_core_no_card_smoke`と`webts_b25_facade_no_card_smoke`を同じmoduleで
実行し、固定diagnosticのみ表示する。カード、鍵、TS、PC/SC、USB、復号は実行せず、`OK`も
facadeの生成・設定・解放とlink成立だけを意味する。生成WASMがない場合は固定の
`B25_WASM_UNAVAILABLE`として扱い、raw例外やpayloadは表示しない。

## WebUSB権限・WASM列挙診断（書き込みなし）

[`src/usb/wasm-enumeration-diagnostic.ts`](../src/usb/wasm-enumeration-diagnostic.ts) は、
ユーザー操作から `navigator.usb.requestDevice()` を先に呼び、その後だけEmscripten
moduleをロードする。moduleのローカルshim
[`scripts/libusb-webusb-diagnostic.cpp`](../scripts/libusb-webusb-diagnostic.cpp) は、
公式libusb APIの `libusb_init`、`libusb_get_device_list`、
`libusb_get_device_descriptor`、解放処理だけを呼ぶ。戻すのはVID/PIDと件数のみで、
serial、manufacturer、card情報、payloadを扱わない。open、claim、control/bulk
transfer、firmware、tune、TS受信をこのshimから直接行わない。ただし公式backendの
`libusb_get_device_list()` は許可済みWebUSB deviceの初期化中に一時openし、標準の
device/configuration `GET_DESCRIPTOR` control-INを発行してからcloseする。したがって
この診断は「書き込みなし」だが「open/descriptor readなし」ではない。

このTypeScript seamは既存M0 UIへ自動接続していないため、実機確認時は明示的なbutton
handlerから `requestAndEnumerateAuthorizedDevices()` を直接呼ぶ。権限ダイアログ後に
同じ許可済み集合を公式backendの `navigator.usb.getDevices()` が列挙できるかだけを
確認し、物理クリックと結果判断は実機検証担当へ委ねる。生成WASMを通常Vite buildへ
取り込まず、必要時だけ `build-libusb-webusb.ps1` を実行する。opt-in画面は別entryの
[`m1.html`](../m1.html)（開発時は `/m1.html`）で、M0の [`index.html`](../index.html)
からは参照しない。クリックhandlerでは `requestDevice()` を先に実行し、表示するのは
VID/PID、件数、固定診断codeだけである。WebUSBのsecure contextとユーザー操作が必要で
あり、画面側からopen/claim/transferを直接呼ばない。ただし公式backend列挙に伴う
一時openとdescriptor control-INは発生する。`src/usb/wasm-loader.ts` は明示ビルド
で生成された `/build/libusb-webusb/libusb-webusb-browser.js` だけを動的ロードする。
ビルドscriptはEmscriptenが作るowner-only ACLの元JSを同じignored `build/` 内へ配信用に
複製する（vendor/sourceへは書き込まない）。Viteの
dev/previewにはEmscriptenのatomics前提としてCOOP/COEPヘッダーを設定しているが、
実ホスティング側でも同じ分離要件を満たす必要がある。

別ボタンの「既許可デバイスだけでWASM列挙」は `navigator.usb.getDevices()` を使うため、
chooserを開かない。公式backendの列挙時には上記の一時openとdescriptor control-INが
発生するが、画面側からclaim/bulk/stream transferは行わない。未許可または許可済みデバイスなしは
`authorizedDeviceCount: 0` として正常に表示し、WASM列挙結果の0件と区別できる。これは
M0で同一originに付与済みの権限を再利用する診断経路であり、新しい権限付与を行う
ものではない。

初期化失敗の切り分け用に、overlayは `ENABLE_LOGGING` を有効化し、shimが
`libusb_init()` 前にglobal log callbackを設定する。callbackはraw log本文を保存・出力せず、
`LIBUSB_ERROR_*` の既知名だけを固定enum（例: `IO`, `ACCESS`, `NO_DEVICE`, `TIMEOUT`,
`UNKNOWN`）へ分類する。UIへ返すのはこのenumと件数だけで、serial/card/payloadやrawログは
公開しない。これは公式backendのソースを改変せず、列挙時の標準descriptor IN以外の操作を
追加しない診断境界である。

Asyncify exportのJS呼出しは直接 `_webts_libusb_enumerate()` 等を呼ばず、Emscripten
runtimeの `Module.ccall(name, "number", argTypes, args, { async: true })` を使う。
`ccall` が返すPromiseの完了後にだけheapを読み、`free`する。これはEmscriptenの
[Asyncify ccall契約](https://emscripten.org/docs/porting/asyncify.html#usage-with-ccall)
に合わせたもので、unwind中の暫定戻り値を列挙結果として扱わないための境界である。

## pthread比較variantと件数プローブ

通常の `build-libusb-webusb.ps1` は公式backendのEmscripten buildに合わせて `-pthread`
を付ける。`emscripten_webusb.cpp` の `_REENTRANT` 分岐はmain runtime threadへの
proxyingを選び、非pthread時はAsyncifyのmain-thread待機経路を選ぶ。比較用には同じ
vendor/sourceから `build-libusb-webusb.ps1 -NoPthread` を実行でき、
`build/libusb-webusb-nopthread/` に生成する。`events_posix.c` がEmscripten atomics
APIを使うため、非pthreadvariantも `-matomics -mbulk-memory` は使うが `-pthread` は
使わない。これは原因切り分け用のbuild-only比較であり、正規runtime実装・互換層ではない。

shimの `webts_libusb_probe_webusb_device_count()` は `navigator.usb.getDevices()` の件数
だけを返す（このprobe自体はopen/descriptor readを行わない）。その後、公式libusbの
`libusb_get_device_list()` を実行し、UIは browser JS側の許可件数、WASM内probe件数、
libusb列挙件数を別々に表示できる。既許可ボタンではJS側 `getDevices()` をmodule呼出し
前後に実行し、前後件数と差分も表示する。WASM内probeにはWindow、DedicatedWorker、
その他Worker等の固定実行コンテキストenumを付ける。これにより `getDevices()` が空なのか、
libusb側のdevice初期化skipなのか、WASMコードが想定外Workerで実行されたのかを追加の
USB操作なしで切り分ける。固定enumと同様、raw例外・payload・serialは公開しない。

公式backendは内部で常に `navigator.usb.getDevices()` を取得する設計で、既許可の
`USBDevice` objectをlibusbへ外から渡す公開APIはない。Window側のobjectをEmscripten
`val`で注入する独自shimはpermission scopeと所有権を再実装するため、今回の比較では
採用しない。まず実行コンテキストとgetDevices前後件数を観測する。

### Chrome実測メモ（親エージェント確認）

初期版では既許可集合の `3275:0080` 1台に対し公式libusb WASM列挙が0台だった。
これは直接のAsyncify export呼出しで、非同期処理完了前の戻り値を読んでいたことが原因だった。
2026-09-19に `Module.ccall(..., { async: true })` へ修正後、同じChrome originの
「既許可デバイスだけでWASM列挙」で、pthread/non-pthreadの両variantが次を返した。

| variant | browser JS before/after | WASM WebUSB probe | libusb enumeration | diagnostic | execution |
| --- | ---: | ---: | ---: | --- | --- |
| pthread | 1 / 1 | 1 | 1 | `NONE` | `WINDOW` |
| non-pthread Asyncify | 1 / 1 | 1 | 1 | `NONE` | `WINDOW` |

公式backendは `getDeviceList()` の初期化で一時open、device/configuration descriptorの
標準control-IN、closeを行うため、これは書き込みなしの列挙診断であり、openなしの保証ではない。
firmware、tune、bulk transfer、TS、B25は未実施である。PX4 enumeration shimは現時点で
build-onlyかつUI未接続で、raw libusbログを破棄するcallbackを初期化前に設定するが、
実機接続前に固定診断codeの設計・Asyncify呼出し・権限境界を別途レビューする。

B25 M2 foundation is source-only and limited to the ISC `libaribb25` v0.2.10 TS parser/MULTI2
core plus the no-card upstream facade create/configure/release smoke. The PC/SC
`b_cas_card.c` path, keys, firmware, binaries, and captured TS remain excluded. No
descrambling or card access is exposed. The Apache-2.0 reference
implementations remain reference-only.

### Siano stop boundary (build-only)

公式libusb Emscripten WebUSB backendの`em_cancel_transfer()`は、保留中のWebUSB
`transferIn` Promiseをabortせず成功値だけを返す。upstream Sianoの停止はevent threadの
joinを待つため、Promiseが到着しないと完了時間をboundedにできない。`releaseInterface()`が
Chromium実装でI/Oを解決する可能性は、実装上の仮説であってWebUSB/Windows上の保証ではない。

そのため`webts_siano_release_first_stop_mock`はvendor sourceを変更せず、upstreamの
stream-stateと合成sessionだけでrelease→cancel→closeの順序、release失敗、pending未解決時
のclose禁止、冪等な再停止を検査するpolicy fixtureである。libusb/WebUSB、実機transfer、
start_streaming、version、firmware、tune、TSは呼ばず、raw log・payload・serialも返さない。
実backendのrelease/cancel/joinの実証とbounded停止は未完了であり、このfixtureを解決済みと
解釈してはならない。

### USBDevice.close() 先行hookの境界

WebUSB仕様の`USBDevice.close()`は実行中処理をAbortErrorへ進めるが、libusb 1.0.30の
`emscripten_webusb.cpp`で`CachedDevice`と保持`USBDevice`はanonymous namespace内のprivate
実装である。`safeOpenCloseOnMain(Close)`は内部の`Symbol.for('libusb.open_close_chain')`
とrefcountを扱うため、外部C++ overlayや公開libusb handleから安全に呼び出せない。
`navigator.usb.getDevices()`のdeviceを直接閉じる方法もhandle identity・二重close・refcountを
保証しない。

公式`core.c`の`libusb_close()`先行も、in-flight transferをリストから外してhandleをNULL化
する`do_close()`の契約と衝突するため禁止した。releaseInterface先行はabort保証がなく、
このrepoではclose hookのfake成功やUI接続を実装していない。必要なのは公式backend内部の
協調APIまたは対象ブラウザでのpending transfer実証であり、現段階は未解決境界として扱う。

### Siano version-response parser fixture

`webts_siano_version_response_mock`はvendorの`protocol.c`にある
`sms_frame_message()`を合成responseへ直接適用するbuild-only ABIである。通常frame、split
alignment、短いheader・不正な宣言長を固定診断へ分類する。TypeScript側でSiano wire framingを
再実装せず、payloadやversion内容もABI外へ出さない。

timeoutと再試行抑止は、送信を伴わないfixture内のbounded policy状態であり、upstreamの
`get_version()`/`send_and_wait()`、libusb transfer、firmware、tune、TSを呼ばない。このため
実機のtimeout、cancel、再試行の挙動を検証済みとは扱わず、実USB経路・UIにも接続していない。

### Siano upstream `ts_queue` fixture

`webts_siano_ts_queue_mock`はvendor`siano-ts.c`の`ts_queue_init`、`ts_enqueue`、`ts_pop`、
`ts_queue_close`、`ts_queue_destroy`をoverlay translation unitから直接呼ぶUSB-free fixtureで
ある。合成chunkでFIFO/drain、256-slot満杯drop、closed enqueue拒否、16,384-byte切り詰め、
再初期化を実行し、diagnosticとbytes/chunk数・queue深さ・FIFO/reinitフラグだけを返す。
payload、serial、raw error、USB transferはABIに出さない。

上流queueは固定256 slot・各16,384 bytes・満杯/closed drop・`ts_pop`最大100ms待機であり、
可変容量・drop policy・overflow/copy/last-session統計を持つTypeScript `TsStreamSink`とは
統計意味が異なる。このfixtureはsource-backed queue境界の確認であり、実TS受信、stream/version、
firmware、tune、連続性解析を意味しない。

`m1.html`には合成queue専用のopt-inボタンを接続した。scenarioと固定bytes/chunk統計だけを
表示し、`navigator.usb`や実TS/stream/version/firmware/tuneは呼ばない。生成WASMがない場合は
`SIANO_TS_QUEUE_WASM_UNAVAILABLE`としてraw errorを出さない。

### Siano live statistics snapshot (build-only)

overlayの`webts_siano_live_stats_snapshot`は、vendor `siano-ts.c`/`stream-state.c`の
mutexを通じてqueue count、drop count、active transfer count、固定stream error enumを
読む。vendor snapshotは変更せず、`scripts/siano-ts-counters.patch`をlocked sourceの
コピーへビルド時検証適用し、`ts_enqueue`/`ts_pop`と最初の`fail_streaming`遷移に
accepted/dequeued/dropped/truncated bytesとtransfer-error遷移数を追加計測する。ABIはuint64を
low/high wordに分け、TypeScriptはdecimal stringで扱う。飽和時は`countersSaturated`を立て、
raw error・serial・payloadはABI外に出す。

同じ実装をUSB-free `webts_siano_live_stats_mock`でheap上の合成`struct siano_device`へ適用し、
overflow、closed queue、truncate、dequeue、最初のfatal stream transition、state/queue mutex境界を検証する。実セッションsnapshotはUI未接続
であり、state確認からmutex取得までにclose/destroyが入らないよう、将来の呼出し側でlifecycleと
one-in-flight直列化が必要である。このsnapshotは実機stream停止やUSB切断の安全性を保証しない。

M1画面には同ABIのUSB-free scenario 0〜3を確認するボタンを追加した。これは合成heap上の
upstream state/queueだけを使い、実セッションABI・`navigator.usb`・stream/version・payloadへ
接続しない。IDLE/unsafe stateやcounter非対応moduleではbytes/errorを固定`null`としてUIへ渡す。

pthread writer/joinを使うscenario 4は、Chrome main browser threadで実行した際にタブを応答
停止させたため削除した。Emscriptenのblocking joinがevent loopを塞ぐ既知の制約により、
このfixtureで実同時更新を検証済みとは表現しない。現在のC ABI/TypeScript/UIはscenario 0〜3
のみを受け付ける。

2026-09-20、counter patch適用後の生成WASMでscenario 0〜3を個別確認し、全て`OK`となった。
0はIDLEでcounter null、1はOPEN（queue 2、accepted 2、dequeued 0、drop/truncate/error 0）、
2はSTREAMING（queue 256、accepted 256、dropped chunks/bytes 1/1、active 0）、3はSTREAMING
でclosed（queue 0、dropped chunks 1、accepted/dequeued 16,385/16,385、dropped bytes 2、
truncated bytes 9、transfer-error transition 1、stream error IO）だった。Worker scenario 3も
同じ値で`OK`を返した。これは合成fixtureのみで、実TS/USB/sessionは未実行である。
transfer-errorは全USBエラーではなく、最初のstream failure遷移件数（通常0/1）を意味する。

### Siano pending transfer stop hook assessment

公式`emscripten_webusb.cpp`の`em_cancel_transfer()`は`LIBUSB_SUCCESS`を返すだけで、
`transferIn` Promiseを中断しない。upstream Sianoのstop/joinはcompletion待ちになるため、
このsnapshotへ外部overlayだけを足してもidle deviceのbounded stopは成立しない。
`CachedDevice`、`USBDevice`、`safeOpenCloseAssumingMainThread()`、Symbolベースの
open/close chain/refcountはbackend privateで、libusb handleから安全に参照できない。
releaseInterface先行はWebUSB仕様上abortを保証せず、libusb_close先行はcoreのin-flight
transfer所有権を壊す可能性があるため、patchは追加していない。

fake Promiseで検査できるのはpolicy上の順序・二重callback・close失敗時poisonだけであり、
実backendのPromise解決やUAF不在の証明にはならない。将来は公式backend内部のper-handle
close/transfer協調APIと実Chromium/Windowsのpending transfer検証が必要で、現時点ではSiano
stream/version/UIへ接続しない。

公式snapshotを変更する最小patchも未採用である。`em_cancel_transfer()`から
`USBDevice.close()`を呼ぶ場合、同一deviceの全handleへ影響するcloseとSymbolベースの
open/close refcount、後続`em_close()`の二重closeを調停する必要がある。複数pending
Promiseの遅延callbackがcoreのtransfer list、`usbi_signal_transfer_completion()`、
backend private transfer resultを一度だけ処理し、解放後の`itransfer`へ触れない保証も必要で、
WebUSBの個別transfer cancel APIは存在しない。fake Promiseやcompile/link smokeだけではこの
寿命・競合保証を証明できないため、patch file/build stepは追加していない。必要条件は
backend内部registryとonce guardを含む協調変更、決定論的fake、対象Chromium/Windowsでの
実pending transfer試験である。

### `selectAlternateInterface(alt=0)` stop hypothesis

公式backendの`em_set_interface_altsetting()`はWebUSB `selectAlternateInterface()`を呼ぶが、
Siano upstreamは`bInterfaceNumber`しか保持せず、走査時のalternate setting番号を保存しない。
同interfaceをalt=0へ切り替えるoverlayはdescriptor依存の設定変更になり得る。WebUSB仕様の
abort記述に対し、確認したChromium Windowsの`SetInterfaceAlternateSetting`は
`WinUsb_SetCurrentAlternateSetting`へ進むだけで、見えるpending `Request::Abort()`を伴わない。
Microsoftの同API仕様もoutstanding I/O requestがあるinterfaceでは失敗し得るため、pending
transferを解決する停止nudgeとは扱えない。
したがってtransferIn Promiseのsettle、Siano join、callback once、release/close寿命を保証
できず、guarded helperやpatchは追加していない。fakeで検査できるのは順序policyだけであり、
実descriptorと対象Chromium/Windowsのpending request試験が先行条件である。

### PX4 IT930x parser fixture

`scripts/px4-it930x-protocol-smoke.cpp` は、vendor/upstream/px4-userland の
`it930x_protocol.cpp` にある `parse_scatter_block()` と `validate_scatter_image()` を
直接呼ぶsource-backed overlayである。合成imageの正常blockと境界拒否を固定診断へ変換し、
TypeScript側はscenarioとdiagnosticだけを扱う。`m1.html` のボタンも合成fixture専用で、USB、
実firmware、command/control、card、tune、TS、payload公開はない。

同upstream APIはscatter image parserであり、command frameのencode/decodeまたはCRC APIを
提供しない。このためCRCを含む制御frame検証を再実装せず、今回のfixtureからは主張しない。

### Q3U4 stream data-plane source/link boundary

`q3u4_stream.cpp` と `mock_transport.cpp` はsource-only vendor snapshotからoverlayへ追加で
コンパイル・リンクし、`webts_px4_stream_source_link_smoke`でupstream API symbolの保持を
確認する。これは実行fixtureではない。`Q3U4StreamDataPlane`のattach/detach/shutdownは
worker threadとjoinを使い、上流`MockTransport`の期待列はworkerのevent消費とcancel/stopの
並行アクセスを同期しないため、ブラウザmain threadで安全・有界な一往復を証明できない。
したがってUIには接続せず、実機USB、Q3U4、serial、command、firmware、tune、実TSは扱わない。
実行する場合はDedicated Worker専用の有界harnessと同期されたtransport/test seamが必要であり、
現段階でsource/link成立をstream lifecycle成立と解釈してはならない。

### Q3U4 synchronized lifecycle fixture (Node-only)

上流`Q3U4StreamDataPlane`へ同期付きtest-only `Transport` fakeを注入する
`scripts/px4-stream-lifecycle-mock.cpp`を追加した。4 receiver attach後に合成wire packetを
供給し、nonblocking read/stats、detach、final snapshot、release、shutdownを固定集計だけで
検査する。最初のeventは全attach完了までgateし、fakeのcancelはwait condition variableを
起こす。vendor data-planeやdemuxは再実装していない。

`scripts/run-px4-stream-lifecycle-fixture.ps1`はtest-access版`q3u4_stream.cpp`を別objectで
compileし、Node/Emscripten moduleを10秒上限で実行する。2026-09-20の実行結果は`OK`、
read 188 bytes、2 packets/376 bytes、terminal `stopped`、detach/release/shutdown成功で、
同生成moduleの5回反復も全て同一結果・時間内完了だった。これはoffline fake testに限定され、
ブラウザUI、実Q3U4、USB、serial、firmware、command、tune、実TSを扱わない。

`scripts/build-px4-stream-lifecycle-worker.ps1` は同じfixtureを`ENVIRONMENT=web,worker`と
`PTHREAD_POOL_SIZE=2`でbrowser-served moduleへリンクする。`src/usb/
px4-stream-lifecycle-worker-diagnostic.ts`を介してstandaloneページと`m1.html`の独立した
opt-inボタンからDedicated Workerを実行でき、message shape、timeout、不正応答を固定codeへ
制限する。main threadからpthread joinは呼ばず、USB/WebUSB経路にも接続しない。

2026-09-20、Chromeの`http://localhost:5173/px4-worker-fixture.html`で、
`PX4 Worker fixture OK（合成のみ）`、`attached: true`、`readBytes: 188`、`packets: 2`、
`bytes: 376`、`finalTerminal: 5`、`detached/released/shutdown: true`を確認した。
これはvendor Q3U4StreamDataPlaneと同期fakeのsource-linked synthetic lifecycleだけの結果で、
実Q3U4、USB、serial、firmware、command、tune、実TS受信ではない。Worker terminate後のpthreadや
upstream resourceの物理解放も保証しない。

同日、親エージェントが`http://localhost:5173/m1.html`の「PX4 stream lifecycle Worker
（合成fixtureのみ）」ボタンもChromeで実行し、`PX4 stream lifecycle Worker OK（合成のみ）`と
同じ固定集計（attached/readBytes/packets/bytes/finalTerminal/detached/released/shutdown）を確認した。
これはM1 UI接続の確認であり、実機Q3U4やUSB経路の検証ではない。

`npm run build`はVite出力後に`scripts/package-px4-worker-dist.ps1`を使い、検証済みの
browser module、pthread helper、WASMだけを`dist/build/upstream-wasm/`へ同梱する。generated
中間ファイルや実機用libusb/Siano/PX4 module、firmwareはproduction distへ入れない。scriptは
参照先、固定export、欠落・余分なassetを検査し、Vite previewでもこの合成Workerの相対asset
解決を維持する。Workerビルドは入力sourceと3 assetのSHA-256 manifestを生成し、package時に
5つの直接入力source、実際にlinkしたobject群、3 assetのSHA-256を照合し、vendor lockも再検証する。
これはupstream全ソースの再ビルドを代替しないため、clean checkoutではoverlay object準備後に
Worker buildを先に実行する。

2026-09-20、親エージェントがproduction preview `http://127.0.0.1:4173/m1.html`で同ボタンを
実行し、`PX4 stream lifecycle Worker OK（合成のみ）`、`attached: true`、`readBytes: 188`、
`packets: 2`、`bytes: 376`、`finalTerminal: 5`、`detached/released/shutdown: true`を確認した。
これはproduction asset packagingとM1 UIの合成fixture確認であり、実機Q3U4やUSB経路ではない。

### libusb WebUSB pending transfer stop boundary

#### Pending `libusb_close()` observation (experimental, test-only)

公式core/backendのsource-bound fake WebUSB harnessに、保留中bulk `transferIn`のまま
`libusb_close(handle)`を呼ぶ別シナリオを追加した。Nodeの10秒上限付きisolated childでの固定
reportは次のとおりである。

```json
{"diagnostic":"OBSERVED","callbacks":0,"status":255,"closeReturned":true,"fakeTransferInCalls":1,"promiseSettlementObserved":false,"physicalAbortProven":false}
```

fake `transferIn`は1回実行されたが、close復帰時点でcallbackはなくPromiseは未settleだった。
coreのin-flight transfer所有権がcloseで変化するため、harnessはPromise解決、transfer/free、
context exitを行わず、isolated child/Workerの終了だけをcleanupとする。この観測は
`USBDevice.close()`の物理abort、late callback/UAF非発生、物理解放、Sianoのstop/join有界性を
保証しない。通常build/UI/実USBへは接続せず、Chrome観測は未実施である。

その後、親エージェントがChrome Dedicated Workerのexperimental fast-path fixtureでも同じ
固定reportを確認した。これはNode結果と同じくcloseの論理復帰時点の観測であり、in-flight
transferのcleanup・物理解放・WebUSB物理abort・late Promiseの安全性・Siano stop/joinの
有界性を意味しない。通常production build、実USB、Siano経路には接続していない。

比較のため、公式stock `events_posix.c`を使うDedicated Worker moduleにも同じpending-close
exportを追加した。fixtureではstock版とzero-timeout fast-path版を別scenarioとして選択できる。
両variantのChrome観測は一致したが、fast-path版を含む結果を物理解放の証拠とは扱わない。

その後、親エージェントがChrome Dedicated Workerでstock版も実行し、fast-path版と同じ
`diagnostic: OBSERVED`、`callbacks: 0`、`status: 255`、`closeReturned: true`、
`fakeTransferInCalls: 1`、`promiseSettlementObserved: false`、`physicalAbortProven: false`を
確認した。これは限定的なclose復帰時点の一致であり、in-flight transferのcleanup、物理解放、
物理abort、late Promise安全性、Siano stop/joinの有界性を証明しない。

公式`emscripten_webusb.cpp`の`em_cancel_transfer()`はnoop相当で、WebUSBの保留
`transferIn` Promiseをcancelしない。`em_submit_transfer()`のPromise callbackは遅延して
`itransfer`を参照し、backendの`PromiseResult`もcallback時に構築されるため、先行して
論理cancel completionを発行するだけでは未構築private値、late callbackのUAF、completion
list二重登録を防げない。`do_close()`先行もcoreがin-flight transferをlistから外し
`dev_handle`をNULL化するため採用していない。

open/close chainのdevice-level refcountはtransfer ownershipを含まず、private `CachedDevice`
やWebUSB `USBDevice`を外部overlayから安全に取得できない。このため公式vendor snapshotを
変更するpatch、fake成功ABI、実機停止UIは追加していない。将来の実装にはbackend/core双方の
共有transfer state、once guard、late Promise寿命、multi-handle refcountを含む決定論的fake
と対象Chromium/Windowsでのpending transfer観測が必要である。

coreのdisconnect pathは、Promise未完了でも`clear_transfer_priv()`後に
`usbi_handle_transfer_completion(NO_DEVICE)`を直接呼ぶ。したがってsubmit時のstate初期化、
idempotentなprivate clear、late callbackが`itransfer`へ触れない寿命管理をbackendだけで追加
することはできず、ユーザーcallbackによるtransfer freeより前のonce guard解除もcoreとの
統合が必要になる。この境界を変更せずに済む安全なexperimental patchは成立しないため、
fake成功ABIや通常buildへの適用は行っていない。

### Experimental transfer ownership model (not a backend patch)

`scripts/libusb-transfer-ownership-model.cpp` とEmscripten/Node runnerは、公式backend/core
とは独立したUSB-free modelである。shared stateだけをDeferred Promiseが保持し、cancel、
natural completion、double cancel、disconnect、late resolve/reject、同期user callbackによる
token free、複数pending/handle refcount、close failureを7 scenarioで検査する。10秒上限付き
実行はcallback exactly-onceとlate Promiseのshared-state処理を確認した。固定reportはcallback
合計3、late ignored 5、token破棄後のmodel late event 5、physical abort未証明だった。cancelではPromise
pending中にcore相当callbackを先にsettleし、disconnectでは`NO_DEVICE`相当callbackを一度だけ
処理する。cancelとlate Promiseを無防備に
通すnaive baselineのdouble-callback回帰もモデル内で再現し、修正版state once guardでは発生
しないことを確認した。これは実backendのUAF不在を証明しない。

このmodelはbackend private `PromiseResult`、coreのflying/completed list、物理
`USBDevice.close()` abort、Chromium/WinUSBのsettleを再現しない。従って成功はownership model
に限定され、libusb cancelやSiano stopの解決を意味しない。通常build/UI/実USBへ接続していない。
### Source-bound WebUSB cancellation evidence (test-only)

The new `scripts/run-libusb-webusb-cancel-regression.ps1` build links the
pristine vendored libusb 1.0.30 Emscripten backend and core to a USB-free fake
WebUSB device. It reaches the actual backend enumeration/open/bulk-IN submit
functions, then calls the actual public cancel API against a never-settling
fake `transferIn` promise. The bounded isolated-child result is:

```json
{"diagnostic":"OBSERVED","backendCancelReturn":0,"fakeTransferInCalls":1,"callbacksBeforePromiseSettlement":0,"callbacksAfterTaskTurnWithoutPromiseSettlement":0,"transferStatusWhilePromisePending":255,"cancelDidNotSettleWithinTaskTurn":true,"fakePromiseStillPending":true,"physicalAbortProven":false}
```

This is concrete evidence for the current `em_cancel_transfer()` behavior,
not a backend patch: the fake transfer was invoked once, cancel returned
success, and the pending WebUSB promise did not settle or invoke the libusb
callback through one JavaScript task turn. This does not establish behavior
beyond that task turn.
The child deliberately leaves
the in-flight transfer untouched and terminates; it does not prove physical
abort, bounded Siano `stop/join`, or cleanup safety. The fixture uses a valid
device descriptor with zero configurations; a one-configuration fake aborted
in the Node harness, so configuration parsing is outside this result. No
vendor file, production module, UI, or real USB device is modified or used.

`scripts/build-libusb-webusb-cancel-worker.ps1` provides the same source-bound
objects and harness as a separate opt-in Dedicated Worker page,
`libusb-cancel-fixture.html`, using only a fake `navigator.usb`. It is not
connected to the M1 USB buttons. The page has a 10-second timeout and exposes
fixed diagnostics only; settle-scenario browser verification is still pending, so Worker
termination, physical WebUSB abort, and bounded stop/join remain unproven.
The pending harness intentionally does not add a promise-resolve callback path
or free the in-flight transfer. `fakeTransferInCalls: 1` is a fixed C++
assertion result, not a raw counter exposed from the fake; the fake
`navigator.usb` is installed inside the Worker before the official backend is
called.

The Node-only settle extension resolved the fake Promise after cancellation and
processed the official event path, yielding one `CANCELLED` callback:

```json
{"diagnostic":"OBSERVED","resolved":{"mode":"resolve","diagnostic":"OBSERVED","callbackCount":1,"callbackStatus":3,"eventResult":0,"backendCancelReturn":0,"physicalAbortProven":false}}
```

The pending scenario was separately confirmed in Chrome; the settle scenario
was attempted in Chrome but timed out. A rejected fake Promise emitted raw Emscripten
stderr in the experiment, so it was removed and is not claimed as a safe path.

The settle selector is not limited to one task turn: it resolves the fake
Promise, yields, and tries a bounded zero-timeout libusb event loop. The current
Chrome attempt on 2026-09-20 timed out at fixed stage `7`, immediately before
the first event-API call, so no browser callback or bounded physical abort is
claimed. The Node source-bound variant separately produced one `CANCELLED`
callback after resolving the fake Promise; that result is not a Chrome result.
Timeout diagnostics may carry only the last fixed native stage (1--13);
progress messages are ignored by the wrapper unless they use that fixed shape.

The source path explains the diagnostic boundary: `io.c` keeps the zero
`timeval`, then `libusb_handle_events_timeout_completed()` enters
`handle_events`; Emscripten `events_posix.c` invokes `em_libusb_wait()` before
`poll()` even for zero timeout. On the Worker main runtime thread this reaches
the `EM_ASYNC_JS` `Atomics.waitAsync(HEAP32, ..., timeout)` helper. The Worker
build uses `ENVIRONMENT=web,worker`, `ASYNCIFY=1`, and no-pthread objects, so
this is the leading explanation rather than a proven root cause. A separate
USB-free event-loop smoke ABI probes only official init → zero-timeout event API
→ exit and does not bypass completion or patch the vendor backend.

The zero-timeout smoke was then run in Chrome on the same generated Worker and
timed out at fixed stage `3`, immediately before its first
`libusb_handle_events_timeout()` call, without a device or transfer. This
isolates the Worker/module event-API boundary rather than the pending Promise.
The experimental script creates an ignored build copy of the pinned
`events_posix.c`, skips `em_libusb_wait()` for `timeout <= 0`, and links a
separate Worker module. It does not alter vendor files, production assets, or
completion semantics; the patched module is not an M1 path. Chrome verification
is recorded below in the required zero-event-before-settle order.

2026-09-20、同じChrome Workerで実験buildを順に実行し、zero-timeout smokeは
`diagnostic: OBSERVED, eventClass: SUCCESS`、settleは
`diagnostic: OBSERVED, callbackCount: 1, callbackStatus: 3 (CANCELLED),
eventResult: 0, backendCancelReturn: 0, physicalAbortProven: false` だった。
これはstock buildのstage 3/7 timeoutとの比較結果であり、fast-pathをM1や
productionへ採用したことを意味しない。Node source-bound settleは同じ固定
reportを5回連続で返したが、Chromeは各シナリオ1回の観測である。source-bound
backendでuser callbackがtransferをfreeする場合、二重callback防止、物理abort、
Siano stop/joinのboundednessは未証明のままである。

Nodeのexperimental fast-path childでは、別ABI
`webts_libusb_webusb_cancel_user_free_regression`を実行し、callback内の同期
`libusb_free_transfer()`後に固定report
`callbackCount:1, callbackStatus:3, eventResult:0, backendCancelReturn:0,
freedInCallback:true, physicalAbortProven:false`を得た。callback外のstable heap
state/bufferを使用し、callback未到達時はhandle/contextを閉じずisolated child終了へ
委ねる。これはresolved Promiseとcallback内freeの一往復だけであり、late Promise、
disconnect、二重callback、物理abortは証明しない。

2026-09-20、親エージェントがChrome Dedicated Workerの同じexperimental
fast-path buildでこのuser-free選択肢を実測し、`diagnostic: OBSERVED`、
`callbackCount:1, callbackStatus:3 (CANCELLED), eventResult:0,
backendCancelReturn:0, freedInCallback:true, physicalAbortProven:false`を確認した。
これはfake Promiseのresolved pathとevent API復帰後のcallback内freeだけを示す
test-only観測であり、stock build、late Promise/disconnect、二重callback/UAF不存在、
WebUSB物理abort、Siano stop/join boundednessは示さない。

2026-09-20、親エージェントがChromeの`http://localhost:5173/libusb-cancel-fixture.html`で
`diagnostic: OBSERVED`、cancel return `0`、callbacks `0/0`、pending status `255`、fake
transferIn calls `1`、`physicalAbortProven: false`を確認した。これはsource-bound official
backendのUSB-free Worker観測に限られ、実WebUSB abort、stop/join boundedness、Promise解決後の
exactly-once callback、in-flight解放を示さない。test-onlyページはVite dev専用で、WASMなしの
production distへはRollup inputとして含めない。

### Test-only backend patch assessment (not adopted)

The pristine source audit rejects leaving an experimental patch in the tree.
`em_submit_transfer()` captures raw `usbi_transfer*` for the late Promise
callback, whereas `em_clear_transfer_priv()` destroys the inline
`PromiseResult`. Core disconnect can clear that private state and immediately
run the `NO_DEVICE` callback, whose user callback may free the transfer. A
safe change would require shared submit-time state, exactly-once detach before
user callbacks, core flying/completed-list coordination, and per-handle
WebUSB close/refcount ownership. Those internals cannot be safely supplied by
an additive overlay or public libusb API. No vendor patch or production/UI
connection was added; the source-bound harness is limited to the documented
one-task-turn observation and intentionally terminates its isolated child
without freeing the still-pending transfer.

### Test-only transfer ownership patch (build copies only)

固定snapshotを変更しないまま、`os/emscripten_webusb.cpp`と`io.c`のtest-only patchを
needle/replacement対として`scripts/libusb-ownership-patch/`と
`scripts/libusb-ownership-patch-io/`へ固定した。`scripts/build-libusb-webusb-ownership-source.ps1`
は各hunkが固定sourceに**ちょうど1回**一致することを検証してから`build/`配下の無視される
copyを生成し、patch後の不変条件（`ValPtr<PromiseResult>`が消えていること、
`TransferSharedState`と観測hookがあること等）も検査する。一致しなければ生成が失敗するため、
vendor更新時にpatchが黙って腐ることはない。

patchの内容と検査結果は[`docs/M1_FOUNDATION.md`](M1_FOUNDATION.md)の
「Source-bound transfer ownership patch」に記録する。要点は、backendのpromise callbackが
生の`usbi_transfer*`ではなくshared stateを持つこと、`em_cancel_transfer()`が有界な論理
完了を1回だけ発行すること、transfer privateの破棄とdetachがuser callbackより前に完了すること、
`usbi_handle_disconnect()`がbackendの発行済み完了をcompleted listから回収することである。

これらは`build/`配下のbuild copyにだけ適用され、`vendor/`のsnapshot、
`vendor/SOURCE_LOCK.json`、production build、M1 UI、実機経路には適用しない。
`scripts/check-vendor-sources.ps1`は引き続き4 rootのhashを検証して成功する。
WebUSBの物理abort、実Chromium/Windowsの保留転送挙動、Sianoのbounded stop/join、
pthread buildの競合は依然として未証明である。
