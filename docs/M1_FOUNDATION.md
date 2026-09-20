# M1 最小土台

## 範囲

`src/tuner/` は機種固有の USB コマンドを持たない。`TunerAdapter` は
`open`、`firmware`、`tune`、`start`、`stop`、`close` と状態通知だけを公開し、
実際の処理は `TunerOperations` として注入する。したがって M0 の
`WebUSBAdapter` や転送 API には接続しない。

## ライフサイクル

`ManagedTunerAdapter` は操作を一つずつ実行し、不正な順序と同時操作を拒否する。
注入されていない必須操作は `NOT_IMPLEMENTED` で拒否し、未実装のまま成功状態へは
遷移しない。状態通知と公開エラーには固定のエラーコードだけを含め、デバイスや
下位ライブラリの raw exception は公開しない。
外部 `AbortSignal` と切断は保留中の完了を無効化し、古い操作が新しい状態へ遷移
させることを防ぐ。処理が abort/disconnect 後に遅れて成功した場合も、`open` は
補償 `close`、`start` は補償 `stop` を同じ操作の資源に対して実行する。補償処理
が失敗した場合は raw exception を公開せず、状態通知とエラーには `cleanupFailed` フラグだけを
保持する。ストリーミング中の
`close` は `stop` を先に試行し、失敗しても `close` を必ず試行する。

## bounded byte queue

`BoundedByteQueue` は bytes と chunks の両方に上限を持ち、`drop-oldest`、
`drop-newest`、`reject`、`clear` の overflow policy を明示する。enqueue と
dequeue の双方で `Uint8Array` をコピーし、所有権を呼び出し側と共有しない。
`queued`、`peak`、`accepted`、`dequeued`、`dropped`、`cleared` は bytes 単位で、
各操作の chunk 数も `*Chunks` として取得できる。

## 模擬TS受け皿

`TsStreamSink` は模擬 `Uint8Array` を上記queueへ渡し、受信・受理・排出・drop・
clear・queue深度/ピーク・転送エラー・queue境界のコピーbytesをセッション単位で
集計する。既定のoverflow policyは `drop-oldest`（メモリ上限を守る代わりに古い
payloadを捨てる）で、`overflowEvents` は容量超過に伴うdropまたはclearの発生回数
をreceive単位で表す（1回のreceiveで複数chunkを捨てても1 event）。chunk単位の量は
`droppedChunks` / `clearedChunks` で取得できる。従ってM1の「buffer overrun 0」は
`overflowEvents === 0` かつ
`droppedBytes === 0` を主条件として実機検証で確認する必要がある。`clearedBytes` は
明示的な `clear()` と切断時の正常なqueue破棄を含み、buffer overrunとは別の廃棄理由
として解釈する。この模擬受け皿だけでは達成扱いにしない。

空 `Uint8Array` は入力不備としてdrop統計には計上するが、容量超過ではないため
`overflowEvents` には計上しない。

切断はpayloadだけをclearしてinactiveにし、`disconnect()` の戻り値、`getStats()`、
`getLastSessionStats()` から最終セッションの数値統計を取得できる。`reconnect()` は
切断後のみ呼び出せ、queueと現セッション統計をresetし、新しいsessionIdで再開する。
活動中のsessionを破棄して新sessionへ移る場合は、明示的に `disconnect()` を先に呼ぶ。
TS continuityとブラウザ/Worker memoryはこの
層では解析・測定せず `null`（未計測）とし、必要な場合だけ外部サンプルを注入する。
payloadをログ・永続化・telemetryへ保存するAPIは持たない。

## upstreamコアの同梱方針

SianoとPX4のUSB・チューナー処理はTypeScriptで重複実装せず、計画7.1に従って
upstream C/C++コアを固定commitのsource-only vendorとして別管理する。libusbは
公式1.0.30のEmscripten/WebUSB backendをそのまま検証対象とし、独自互換層は追加しない。
固定値、取得元、ライセンス、除外（firmware・実行binary・放送データ）は
[`docs/VENDOR_SOURCES.md`](VENDOR_SOURCES.md) と `THIRD_PARTY_NOTICES.md` に記録する。

従ってこのTypeScript土台は実機経路ではなく、UI側のライフサイクルとbounded queueの
候補に限る。USB転送、選局、firmware、TS continuity解析はvendorコアのWASM化検証が
完了するまでM1達成とは扱わない。

## WebUSB WASM列挙診断のChrome実測（2026-09-19）

親エージェントがChromeで `http://localhost:5173/m1.html` を開き、
「既許可デバイスだけでWASM列挙」を実行した。対象は同一originで既に許可済みの
Siano PX-S1UD `0x3275:0x0080` 1台である。実測値は次のとおり。

| variant | JS getDevices before/after | WASM内probe | libusb列挙 | diagnostic | execution context |
|---|---:|---:|---:|---|---|
| pthread | 1 / 1 | 1 | 1 | `NONE` | `WINDOW` |
| non-pthread Asyncify | 1 / 1 | 1 | 1 | `NONE` | `WINDOW` |

この結果により、M1の「既許可WebUSB集合を公式libusb WebUSB backendのWASMから
列挙し、VID/PIDと件数だけを返す」診断は成功と判定する。以前のWASM側0件は
pthread有無やpermission scopeではなく、JSからAsyncify exportを直接呼んでいたため、
非同期処理完了前の戻り値を観測していたことが原因だった。`Module.ccall(...,
{ async: true })` に切り替え、完了後にheapを読み取る修正で解消した。

この診断は書き込みを行わないが、公式libusb backendの列挙中に許可済みdeviceを一時openし、
標準device/configuration descriptorのcontrol-INを実行してcloseする。firmware、tune、
bulk/stream TS受信、B25復号はこの実測で実施していない。したがってM1の実機チューナー
動作、TS連続性、firmware/B25達成を意味しない。

なお、同ページのSiano open→closeボタンは列挙診断とは別のdevice-affecting opt-inである。
対象がJS/WASM双方で正確に1台のPX-S1UDと確認できた場合だけ、同一moduleのone-shot
Asyncify callでupstream `open_rio()`（interface claimと両endpoint clear-halt）から
`close_device()`までを試行する。clear-haltの戻り値はupstreamが無視するため、成功codeは
clear-halt成功を意味しない。firmware、tune、TS、B25は行わない。

## Siano Rio read-only確認 seam

`scripts/siano-rio-enumeration-shim.c` はvendorの `siano-ts.c` を変更せず、source
includeとCLI `main` renameによって同ファイルのstatic `is_rio_id()`を再利用する。
TypeScript側でVID/PIDを重複定義せず、戻り値は固定diagnosticと上限付き対応台数だけに
限定する。`m1.html` の「既許可Siano Rioだけを確認」はchooserを開かず、生成WASMの
Asyncify exportを `ccall(..., { async: true })`で呼ぶopt-in導線である。公式libusbの
列挙に伴う一時openと標準descriptor control-INは発生し得るが、claim、bulk、firmware、
tune、TS受信、serial・ログ・payloadの公開は行わない。このsource-include方式は将来の
Siano判定library分離までのbuild-only境界である。

2026-09-19、親エージェントが同じ `http://localhost:5173/m1.html` の「既許可Siano
Rioだけを確認」をChromeで実行した。対象は既許可のPX-S1UD `0x3275:0x0080` 1台で、
初回は `ccall` runtime export漏れにより `INVALID_MODULE` となった。修正・再ビルド後は
`authorizedDeviceCount: 1`、`supportedDeviceCount: 1`、`diagnostic: NONE` を得た。
これはupstream `siano-ts.c` の `is_rio_id()`を再利用した読み取り列挙の成功である。
公式backendの列挙に伴う一時openと標準descriptor control-INは発生し得るが、firmware、
claim、bulk、tune、TS受信、B25の成功を意味しない。

2026-09-19、親エージェントが同ページの「Siano open→close診断（実機操作）」を1回
実行した。対象は許可済みPX-S1UD `0x3275:0x0080`で、JS/WASM Siano列挙とも1台・
`diagnostic: NONE`を確認した後、one-shot native open→closeを実行した結果は次のとおり。

| authorizedDeviceCount | supportedDeviceCount | diagnostic | lifecycleOpenDiagnostic | lifecycleCloseDiagnostic |
| ---: | ---: | --- | --- | --- |
| 1 | 1 | `NONE` | `NONE` | `NONE` |

その後の読み取りSiano列挙も1台・`NONE`に戻った。upstreamはinterface claimと両endpoint
clear-haltを試行するが、`clear_halt`の戻り値を無視し、`close_device()`もrelease結果を
報告しないため、これら個別操作の成功は断定しない。firmware、tune、TS、B25、切断・
再接続は検証していない。

## Dedicated Worker WebUSB列挙診断

`src/usb/webusb-enumeration-worker.ts` はWindowのpermission取得経路から分離した、既許可
集合専用のopt-in Workerである。Worker側では`WorkerNavigator.usb.getDevices()`の有無と件数を
取得し、公式libusb WebUSB WASMの`getDeviceList`結果と固定diagnostic/count/contextだけを
Windowへ返す。`requestDevice()`はWorkerから呼ばず、ユーザー操作を伴うpermission取得は
既存Windowボタンに限定する。VID/PID配列、serial、descriptor内容、payload、raw exceptionは
Worker ABI/UIへ渡さない。

公式backendの列挙はWindow版と同じく、書き込みやclaim/bulk/streamを行わない一方、許可済み
deviceの一時openと標準device/configuration descriptor control-INを行い得る。Worker導線を
「物理USB操作なし」と表現せず、このread-only descriptor取得範囲までを明示する。firmware、
mode、tune、TS受信、B25は行わない。

libusb smoke buildの`ENVIRONMENT=web,worker`を明示し、WindowとDedicated Workerの両方で
生成moduleをloadできるようにした。COOP/COEPとsecure contextは既存M1 dev serverの前提を
引き継ぐ。timeout時はWorker objectをterminateして固定`WORKER_FAILED`を返すだけであり、
保留中のWebUSB/libusb Promise、device handle、物理転送が解放されたとは主張しない。

2026-09-20、親エージェントがChrome `http://localhost:5173/m1.html`でWorker列挙を実測した。
既許可PX-S1UD 1台に対し、pthread通常variantとnon-pthread Asyncify variantの双方が、
`diagnostic: NONE`、`workerWebUsbAvailable: true`、authorized before/after `1/1`、
delta `0`、`wasmDeviceCount: 1`、`wasmWebUsbDeviceCount: 1`、`wasmDiagnostic: NONE`、
`wasmWebUsbDiagnostic: OK`、`wasmExecutionContext: DEDICATED_WORKER`を返した。chooserは
表示していない。これはWorkerからの既許可集合列挙成功を示すが、公式backendの一時openと
標準descriptor control-INは発生し得る。claim/bulk/firmware/mode/tune/TSは行っておらず、
Worker terminateが保留transferの物理解放まで保証することも未証明である。

### Siano WASM Dedicated Worker synthetic fixture

`src/usb/webusb-enumeration-worker.ts`にSiano用メッセージを追加し、同じWorker内で
`siano-rio-enumeration` moduleをloadして`webts_siano_ts_queue_mock`または
`webts_siano_live_stats_mock`だけを実行できるようにした。`m1.html`の「Siano Worker合成
fixture（USBなし）」はkind/ scenarioを選び、固定診断と既存queue/live-stats集計のみを表示する。
実open/claim/clear-halt/start/version、firmware、tune、TS、payload、`navigator.usb`は扱わない。

Siano生成moduleも`ENVIRONMENT=web,worker`でbuildする。Worker terminateの途中でSiano
moduleや将来のUSB handleを安全に解放できる保証はないため、synthetic ABI以外の経路には
接続していない。

2026-09-20、親エージェントがChrome `http://localhost:5173/m1.html`でSiano Worker実WASMを
実測した。QUEUE scenario 0は`diagnostic: OK`、accepted/dequeued `5/5`、dropped `0`、
`fifoVerified: true`、`reinitialized: true`だった。LIVE_STATS scenario 1は`diagnostic: OK`、
state `OPEN`、generation `1`、queueChunks `2`、dropped `0`、activeTransfers `0`、
accepted/dequeued bytesとtransferErrorsはcounter patch適用前のmoduleで`null`だった。
LIVE_STATS選択時にscenario 4がdisabledになることも確認した。これはDedicated Worker内のupstream Siano synthetic ABI実行
成功であり、実機open/claim/stream/version/firmware/tune/TSの成功ではない。

同じoverlayには `webts_siano_lifecycle_create_close` をbuild-only exportとして含め、
upstream `init_device_state()`成功後に `close_device()`を実行する一セッション境界も確認
できる。ただしupstreamの初期化途中失敗には完全なrollback APIがなく、shimは成功時だけ
`close_device()`を呼ぶ。`open_rio()`はclaimと両bulk endpointのclear-haltを伴うため、
現UIの明示的なopen→closeボタンからのみ呼び出す。分離open/close exportは現UIからは呼ばず、
実機接続前の別設計課題として残す。
`webts_siano_lifecycle_open_link_smoke` はopen/close関数ポインタを参照してリンク保持だけ
を確認するが、USB副作用は実行しない。明示承認後に実行可能な
`webts_siano_lifecycle_open(magic,index)` / `webts_siano_lifecycle_close(magic)`も
overlayへ保持したが、現UIからは呼ばない。
生成moduleを将来ロードする場合もloaderはEmscriptenの`print`/`printErr`を空sinkへ渡し、
raw stdout/stderrがUIやconsoleへ流れない境界を維持する。

## Siano firmware bytes staging boundary

`webts_siano_firmware_validate_stage(bytes, size)` は、将来の
`set_device_mode()` 接続に備えた build-only 境界である。入力上限は16 MiBで、upstream
`sms_parse_firmware_header()` を使って12-byte headerとdeclared lengthだけを検査する。
このparserはchecksumや真正性を検証しないため、成功はfirmware全体の安全性・一致性を
保証しない。入力は固定private path `/tmp/webts-siano-firmware.bin`（Emscriptenでは
MEMFS）へ一時的に書き、upstreamと同じpath-bearing `read_file()`で再読してから、読み出し
bufferをzeroize/freeし、ファイル本体をzeroizeしてunlinkする。途中失敗は固定stage error
を返す。呼び出し元が所有するWASM heapの入力bytesは、この関数の責任範囲外であり、JS側が
呼び出し後にzeroizeする。

戻り値は `OK=0`、`TOO_LARGE=1`、`INVALID_INPUT=2`、`HEADER_INVALID=3`、
`STAGE_FAILED=4` に固定する。

このABIは `start_streaming()`、`set_device_mode()`、`load_family2_firmware()`、USB転送を
呼ばず、firmwareの取得・永続化・ログ・telemetryも行わない。将来の実機接続では、既に
初期化・streamingされたSiano deviceと明示的なUSB権限が必要であり、firmwareのchecksum/
真正性検証やUI配線は別ゲートである。合成bytesの境界検証とoverlayの静的/link検証のみを
行い、firmware本体をvendorしない。

### ローカルfirmware検査ボタン

`m1.html` の「ファームウェアをローカル検査（USB送信なし）」は、利用者が選択した
`isdbt_rio.inp`のbytesをブラウザ内だけで扱う。まずSiano README記載の既知SHA-256
`054520642d5d09cb7ab7d08dbd6fd9ba9365de56adf2e7d7d06927f9845ff818`をWebCryptoで照合し、
不一致ならWASMをロードせず固定 `FIRMWARE_HASH_MISMATCH` を返す。一致時だけ、生成Siano
moduleの `HEAPU8` / `_malloc` / `_free` と Asyncify `ccall(...,{async:true})`で上記ABIを
呼ぶ。WASM heap、digest copy、読み込みArrayBufferはbest-effortでzeroize/freeし、ファイル名、
path、bytes、実digestはUI・ログ・永続領域へ出さない。

この導線はheader/path stagingの検査だけで、USB open、claim、transfer、streaming、mode、
tune、TS、firmware uploadを行わない。成功表示は「既知SHA-256一致＋upstream header/path
検査完了」を意味するだけで、firmwareの真正性・実機適用成功を意味しない。File pickerの
2026-09-19、親エージェントがChrome `http://localhost:5173/m1.html` の同ボタンで
実際の利用者選択 `isdbt_rio.inp` を検査した。画面の観測結果は
`SHA-256一致・upstream header/path検査完了（upload未実行）`、diagnosticは `NONE` だった。
これは既知SHA-256照合とupstream header/path stagingの成功だけを示し、firmware upload、
USB open/claim、start_streaming、set_device_mode、tune、TS、B25の成功を示さない。実firmware
bytes、ファイル名、digestは記録・表示していない。

## Siano stream/version handshake boundary

`webts_siano_lifecycle_start_version(magic)` は、既存のopen後にupstream
`start_streaming()`（MAX_URBS bulk-IN submit）と `get_version()`（bulk-OUT request＋response
待機）を順に呼ぶbuild-only exportである。戻り値はlow byte=start diagnostic、high byte=
version diagnosticの固定enumで、startの非ゼロ（pthread/allocator/libusbの戻り値が混在）は
常に `OTHER`、versionは明示的な `-ETIMEDOUT` だけ `TIMEOUT`、その他の負値は `OTHER` とする。
raw error/log/version payloadは公開しない。状態は
`OPEN→STARTING→STREAMING→VERSIONED`と進み、start途中失敗でも`close_device()`が部分submit
をcleanupできる`STREAMING`状態を保持する。closeはOPEN/STREAMING/VERSIONEDを受け付け、
close後はIDLEへ戻る。

このexportはfirmware staging、`set_device_mode()`、tune、TS処理、UIへ接続していない。
`start_streaming()`が実際にbulk-IN、`get_version()`がbulk-OUTを行うため、Chrome実機での
呼出しと物理検証は未実施である。magicは誤呼出し防止でありsecurity boundaryではない。

open→start_streaming→get_version→closeを一回のボタンで束ねる案は検討したが、採用していない。
公式libusb WebUSB backendの`em_cancel_transfer()`は保留中の`transferIn` Promiseを物理中断せず、
upstream `stop_streaming()`のpthread joinがPromise解決まで待ち続けるため、idle deviceでは
close完了時間を保証できない。公式backendを改変せずにこの境界を安全なbounded one-shotへ
する方法は未確立であり、one-shot WASM export・UIボタンは追加しない。現段階の安全な代替は
既存のopen→close診断（streamingを開始しない）と、未接続build-onlyのstart/version seamを
保持することだけである。

## PX4 identity/grouping offline seam

`webts_px4_grouping_mock_summary(scenario)` は、vendorの`identity.cpp`にある
`group_q3u4_devices()`へ合成`DeviceObservation`だけを渡すbuild-only seamである。scenario
0（1組ready）、1（incomplete）、2（duplicate slot）、3（独立した2組ready）を固定し、戻り値は
`Error`と候補数・ready数・incomplete数だけをpackする。serial、base_serial、USB topologyの
詳細、path、rawログはABIを越えない。TypeScript側のwrapperもAsyncify `ccall`と固定packed
resultのdecodeだけを行う。`m1.html` の独立した合成mockボタンから利用できるが、
`navigator.usb` やWebUSB権限には依存しない。

親エージェントがChromeの `http://localhost:5173/m1.html` で4シナリオを実行した結果は
次のとおりである。すべて `diagnostic: OK` で、画面には診断コードと候補・ready・incomplete
の集計値だけが表示された。

| scenario | candidateCount | readyGroupCount | incompleteGroupCount | diagnostic |
| ---: | ---: | ---: | ---: | --- |
| 0 (ready pair) | 2 | 1 | 0 | `OK` |
| 1 (incomplete) | 1 | 0 | 1 | `OK` |
| 2 (duplicate slot) | 3 | 0 | 0 | `OK` |
| 3 (two ready groups) | 4 | 2 | 0 | `OK` |

これはsource-backedな合成入力のChrome/WASM実行確認（2026-09-20、親エージェント確認）で
あり、実際のQ3U4 2台、serial取得、USB open/claim、control/command、firmware、tune、TSの
検証ではない。

この検査は実USBの`Q3U4Runtime::enumerate_native()`、open/claim、serial descriptor、command、
firmware、tune、TSを呼ばない。したがってPX4の実機2台組み合わせを確認したものではなく、
upstream identity/groupingのsource-backed挙動をハードウェアなしで保持するための境界である。

### PX4 runtime synthetic lifecycle fixture

`webts_px4_runtime_mock_open_close` は、vendorに含まれる
`RuntimeTestAccess::open_native()`へ、overlay内だけの合成`LibusbApi`を注入するbuild-only
fixtureである。合成APIは2台分のdescriptor/topology/serialをupstreamの発見・grouping・
open/claim経路へ渡し、`Q3U4Runtime`の実デストラクタが両interfaceをreleaseし、両handleを
closeするところまでを通す。返り値はcleanup検証を含む固定`Error`だけで、serial、topology、
USB payload、呼出し回数はABIを越えない。

これは実libusb/WebUSB、実機open/claim、serial取得、command、firmware、tune、TSを実行しない。
したがってPX4の実機ライフサイクル検証ではなく、upstream
runtimeの資源所有・cleanup経路を合成入力で回帰検査する境界である。JS側から将来呼ぶ場合は
生成moduleの`ccall(..., { async: true })`契約を使う。`m1.html`には「PX4 runtime
open→close（合成mockのみ）」ボタンを接続しているが、これは上記の合成fixtureを実行する
だけであり、実USBや`navigator.usb`には依存しない。

2026-09-20、親エージェントがChromeの `http://localhost:5173/m1.html` で同ボタンを実行し、
status `PX4 runtime mock OK` と `{"diagnostic":"OK"}` を確認した。これはWASM合成fixtureの
実行確認であり、実Q3U4のopen/closeやUSB接続を検証したものではない。

## Siano release-first stop boundary fixture

公式libusb 1.0.30のEmscripten WebUSB backendでは、`em_cancel_transfer()`は成功値を
返すだけで保留中の`transferIn` Promiseを物理的には中断しない。upstream
`stop_streaming()`はcancel後にevent threadのjoinを待つため、Promiseが解決しない場合は
boundedな停止完了を保証できない。`releaseInterface()`がChromium実装で保留転送を解決する
可能性はあるが、WebUSB仕様・対象OSでの完了保証としては未実証である。

`webts_siano_release_first_stop_mock(scenario)`は、upstreamの`stream-state.c`を使いながら、
libusb/WebUSB/deviceを呼ばずに停止ポリシーだけを決定論的に検証する。interface releaseを
先に試し、成功後にtransfer cancellationを行い、未解決transferが残る場合はhandle
close/freeを行わない。release失敗もcloseせず、正常停止の再呼出しは冪等とする。ABIは
`OK`、`RELEASE_FAILED`、`PENDING_NOT_SETTLED`等の固定診断だけを返し、UIには接続していない。

これは実backendのPromiseがreleaseで解決する証明でも、実機停止がboundedになった証明でも
ない。実機へ接続する前に、対象Chromium/Windowsのrelease、pending transfer、join、handle
closeの失敗・タイムアウト挙動を別途検証する必要がある。start_streaming、version、firmware、
tune、TS、実機USB操作はこのfixtureから行わない。

### USBDevice.close() 先行hookの検証結果

WebUSB仕様の`USBDevice.close()`は実行中algorithmをAbortErrorへ進める一方、公式libusb
backendの`CachedDevice`はanonymous namespace内のprivate型で、保持する`USBDevice` objectは
libusbの公開APIや追加overlay C++から取得できない。`safeOpenCloseOnMain(Close)`もbackend
内部のSymbolチェーンとhandle参照数を管理するprivate処理である。したがって、外側から
`navigator.usb.getDevices()`のdeviceを閉じるだけでは対象libusb handleとの一対一対応、二重close
防止、open/close refcount整合を保証できず、実験的hookとして安全に追加できない。

`libusb_close()`を先行させる案も採用しない。公式`core.c`の`do_close()`はin-flight transferを
リストから外して`dev_handle`をNULL化してからbackend closeを呼ぶため、upstream Sianoの
transfer所有権とevent-thread joinを壊し得る。releaseInterface先行もWebUSB仕様上pending
transferのabortを保証しない。以上から、公式backend改変なしでhandle寿命を保ったまま
`USBDevice.close()`を先行させる公開hookは現時点では未成立であり、危険な仮実装・UI接続・
fake成功診断は追加していない。必要条件はbackend内部のhandle↔USBDevice対応を維持した
協調API、または対象Chromium/Windowsでの実機pending-transfer挙動の実証である。

## Siano version-response parser fixture

`webts_siano_version_response_mock(scenario)`は、実際の`get_version()`送信を行わず、
upstream `protocol.c`の`sms_frame_message()`へ合成した
`MSG_SMS_GET_VERSION_EX_RES` frameを渡すbuild-only fixtureである。通常frame、split/aligned
frame、短いheader・宣言長不正のframeを固定診断へ変換し、payload、version値、serial、raw
exceptionは公開しない。splitケースはupstream parserが計算するoffsetとpayload長の検証だけで、
実際のUSB分割受信を意味しない。

timeout相当とretry抑止のケースは、通信を発行しないローカルpolicy状態の検査である。
upstream `get_version()`、`send_and_wait()`、bulk OUT/IN、firmware、tune、TSは呼ばないため、
実機のtimeoutやlibusbの再試行挙動を証明するものではない。UIには接続していない。

## M2 B25 source-only foundation

`shirow-github/libaribb25` v0.2.10（ISC）のtag commit
`b978fe5caf6bfe162e944ad4d323b7c0205276e3`を固定し、TS section parserとMULTI2 coreに
必要なsourceとupstream `arib_std_b25.c/.h` facade、interface/error headerを
`vendor/upstream/libaribb25`へ同梱した。PC/SC実装`b_cas_card.c`、`td.c`、card経路、keys、
firmware、binary、captured TSは除外している。
由来、tag object、ライセンス、sha256は`PROVENANCE.md`と`vendor/SOURCE_LOCK.json`に記録する。

`scripts/build-upstream-wasm-overlay.ps1`は、vendorの`multi2.c`と`ts_section_parser.c`を
`libaribb25-smoke.js`へEmscripten compile/linkし、`webts_b25_core_no_card_smoke`という固定
diagnostic ABIをexportする。このABIはカード・鍵・TS入力を受けず、factory生成と「未設定
MULTI2」「空parser」の固定エラー契約だけを検査する。これはB25復号、カード通信、実TS処理、
descrambling成功を意味せず、UIにも接続しない。TypeScript wrapper/testはABIの固定codeと
raw exception非公開だけを検査する。

同じmoduleにはupstream `arib_std_b25.c/.h` facadeをsource-onlyで追加し、
`webts_b25_facade_no_card_smoke`がcreate→`set_emm_proc(0)`→`set_unit_size(188)`→
program count 0→releaseを検査する。`b_cas_card.h`等のinterface/error headerは含むが、
PC/SC実装`b_cas_card.c`は除外し、card callback、put/get、TS payload、keysは呼ばない。
したがってこれはfacadeの生成・設定・解放とlink成立だけを示し、B25復号、カード通信、
実TS処理、descrambling成功を示さない。

`m1.html`には「B25 上流facade（カード/TSなし）」ボタンを接続している。生成moduleの
core/facade smokeを同一module instanceで実行し、facade/coreの固定diagnosticだけを表示する。
WASM未生成時は`B25_WASM_UNAVAILABLE`、その他の失敗は`INTERNAL`として扱い、カード、鍵、
TS、PC/SC、USB、復号結果やraw例外は表示しない。ボタンの`OK`は生成・設定・解放とlinkの
確認に限られ、復号未検証である。

2026-09-20、親エージェントがChrome `http://localhost:5173/m1.html`で同ボタンを実行し、
status `B25 OK（復号未検証）`、JSONの`diagnostic: OK`、`facadeDiagnostic: OK`、
`coreDiagnostic: OK`を確認した。表示noteどおりcard/keys/TS/PCSC/USB/descramblingは未実行で、
これはupstream facade/coreのno-card生成・設定・解放smoke確認に限られる。

### ManagedTunerAdapter Siano Rio bridge

`src/tuner/siano-rio-operations.ts` は、既許可USBがPX-S1UD `0x3275:0x0080`ちょうど1台、かつ
同一Siano WASM moduleの列挙結果も1台であることを確認してから、既存の
`webts_siano_lifecycle_open` / `webts_siano_lifecycle_close` ABIへ接続する
`TunerOperations`実装である。`ManagedTunerAdapter`のopen/close排他・補償cleanup・disconnect
世代管理を利用し、open失敗後もcloseを試み、close失敗は再試行可能な固定診断にする。
firmware、tune、start/stop、version、TSは未実装で、serial、payload、raw exceptionは公開しない。

これは実機UIへ接続したものではなく、USB操作を自動実行しないcode-only seamである。実機で
openを行う場合は、既許可対象の再確認とユーザー操作を別途要求し、upstream openがinterface
claim/clear-haltを伴うこと、WebUSB転送停止のbounded保証が未解決であることを維持する。
native openのPromiseが保留中にdisconnectされた場合、bridgeのonDisconnectは同時closeを
発行せず、ManagedTunerAdapterがopen完了後のstale completionを検出して補償closeを行う。
WebUSB/libusb側の保留Promise自体を物理キャンセルする保証はこのbridgeにもなく、実機での
有界停止を解決済みとは扱わない。

### Siano upstream `ts_queue` fixture

`webts_siano_ts_queue_mock(scenario, output, words)` は、vendorの`siano-ts.c`にある
`ts_queue_init`、`ts_enqueue`、`ts_pop`、`ts_queue_close`、`ts_queue_destroy`を同一overlay
translation unitから直接呼ぶ、USB-freeのbuild-only fixtureである。合成chunkだけでFIFO/drain・
固定256-slot容量drop・close後enqueue拒否・16,384-byte超過の切り詰め・close後再初期化を検査し、
ABIには固定diagnostic、accepted/dequeued bytes、drop/queue/chunk件数、FIFO/reinitフラグだけを
返す。payload、serial、raw error、USB transferは公開・実行しない。

このqueueは上流仕様どおり固定256 slot（各16,384 bytes）、満杯/closed時はdrop、過大chunkは
16,384 bytesへ切り詰め、`ts_pop`は最大100ms待機する。一方TypeScript `TsStreamSink`は
maxBytes/maxChunksとdrop policy、overflow/copy/last-session統計、再接続を持つため、両者の
統計は同一意味ではない。fixtureのOKは上流queueの合成境界だけを示し、実TS受信・stream/version・
firmware・tune・連続性解析を意味しない。

`m1.html`には「Siano TS queue（合成fixtureのみ・実TS未受信）」ボタンとscenario selectorを
接続している。これは生成moduleの固定集計を表示するだけで、`navigator.usb`、実stream、
version、firmware、tune、TS payloadは扱わない。WASM未生成時は固定の
`SIANO_TS_QUEUE_WASM_UNAVAILABLE`として表示する。

2026-09-20、親エージェントがChrome `http://localhost:5173/m1.html`でscenario 0を実行し、
status `Siano TS queue OK（実TS未受信）`、`diagnostic: OK`、accepted/dequeued bytes `5/5`、
dropped `0`、FIFO/reinit `true`を確認した。scenario 1では`diagnostic: OK`、
`acceptedBytes: 256`、`droppedChunks: 1`、`queuedChunks: 256`、`acceptedChunks: 256`を確認した。
いずれも合成WASM queue fixtureであり、USB、実stream、version、firmware、tune、TS受信は未実行である。
続けてscenario 2（close/drop）は`OK`、accepted/dequeued `1/1` bytes、`droppedChunks: 1`、
`queuedChunks: 0`、scenario 3（oversized truncate）は`OK`、accepted/dequeued `16384/16384`
bytes、`droppedChunks: 0`、scenario 4（reinitialize）は`OK`、`acceptedBytes: 2`、
`queuedChunks: 1`、`reinitialized: true`を確認した。5 scenarioすべてChrome実WASMで成功したが、
これは上流queue境界の合成検証であり、実TS受信やUSB lifecycleの成功ではない。

### Siano live statistics snapshot (build-only)

`webts_siano_live_stats_snapshot(expectedGeneration, output, words)` は、既存Siano
セッションの状態、世代、上流`ts_queue`のqueue深さ/累積drop、`active_transfers`、
stream-state errorを、それぞれのupstream mutexで読み取り、固定enumと上限付き数値だけを
返す。`scripts/siano-ts-counters.patch`をlocked vendor sourceへビルド時だけ適用し、
`ts_enqueue`/`ts_pop`と最初の`fail_streaming`遷移にaccepted/dequeued/dropped/truncated
bytesおよびtransfer-error遷移数を追加計測する。値はABIのuint64 split word、TypeScriptでは
decimal stringで公開し、UINT64_MAX到達時は`countersSaturated`を立てる。raw errno、serial、
payloadは公開しない。

`webts_siano_live_stats_mock(scenario, output, words)` は同じsnapshot境界をUSB-freeのheap
fixtureで検証する（IDLE、queue/drop、closed/truncate/dequeue/fatal transition）。fixtureは実機状態を
変更せず、実TS受信・stream/version・firmware・tuneを呼ばない。任意の非NULLポインタの
メモリ安全性をABI側で検証するものではなく、TypeScript wrapperが生成したWASM heap領域と
固定word数だけを対象とする。

live ABIは現在UIへ接続していない。session stateの読み取り後にclose/reopenが並行すると、
upstream mutex破棄との競合を外側ABIだけでは防げないため、実セッションではライフサイクルと
snapshotをone-in-flightで直列化し、切断/close中に呼ばないことが必要である。これは実機での
安全性やbounded stopを証明する契約ではなく、合成fixtureのmutex・境界検証に限られる。

`m1.html`の「Siano live stats（合成fixtureのみ・実セッション未接続）」はscenario 0〜3を
生成WASMで実行できるが、`navigator.usb`を呼ばず、snapshotの固定診断/queue深さ/drop/
active transfer/error enumと、合成fixtureで計測したuint64値だけを表示する。実セッションで
counterが利用できない旧moduleやunsafe stateでは`null`を返し、0として偽装しない。この
ボタンは実セッションABIのrace安全性や実TS受信を検証しない。

scenario 4のpthread writer/join fixtureは一度実装したが、Chromeのmain browser threadから
呼ぶとタブが応答停止したため削除した。Emscriptenではmain thread上のblocking `pthread_join`
がevent loopを止め得るためであり、以後UI/C ABI/TypeScript wrapperはscenario 0〜3だけを
受け付ける。したがってこのM1 fixtureは実同時更新を検証済みとは扱わず、mutex付き単一thread
境界に限定する。scenario 0〜3の再ビルド後確認は別タブで行う。

2026-09-20、counter patch適用後の生成WASMでscenario 0〜3を個別実行し、全て
`diagnostic: OK`を確認した。scenario 0はIDLEでcounterは未計測`null`、scenario 1はOPEN・
`queueChunks: 2`・acceptedBytes `2`・dequeuedBytes `0`・droppedBytes/truncatedBytes/
transferErrors `0`、scenario 2はSTREAMING・`queueChunks: 256`・droppedChunks `1`・
acceptedBytes `256`・droppedBytes `1`、scenario 3はSTREAMING・`queueClosed: true`・
`queueChunks: 0`・droppedChunks `1`・acceptedBytes/dequeuedBytes `16,385/16,385`・
droppedBytes `2`・truncatedBytes `9`・transferErrors `1`・streamError `IO`を返した。全て
USB/session/実TS受信なしであり、transfer-errorは全USBエラーではなく最初のstream failure
遷移件数（通常0/1）である。旧scenario 4のmain-thread hangは修正済みで、pthreadによる
同時更新は検証対象から除外した。

同日、Worker scenario 3も同じ固定値（closed、queue 0、drop chunk 1、accepted/dequeued
16,385/16,385、dropped 2、truncated 9、初回stream failure遷移 1、IO）で`OK`を返した。
これはDedicated Worker内のUSB-free synthetic ABI実行であり、実機Siano streamではない。

### Pending `transferIn` stop hook assessment

公式libusb 1.0.30 Emscripten backendの`em_cancel_transfer()`は成功値だけを返し、
`em_submit_transfer()`が登録したWebUSB `transferIn` Promiseをabortしない。`stop_streaming()`
のevent-thread joinはそのPromiseのcallback完了を待つため、idle deviceや切断時に有界停止を
このoverlayだけで保証できない。

外部C++ overlayからの最小差分hookは採用していない。対象の`CachedDevice`、保持する
`USBDevice`、`safeOpenCloseAssumingMainThread()`、open/close chain/refcountは公式backendの
anonymous namespace/private実装であり、公開libusb handleから安全に取得できない。外側から
`navigator.usb.getDevices()`のdeviceを`close()`してもhandle identity・複数handleのrefcount・
completion callbackの一回性を結び付けられず、releaseInterfaceにも仕様上のabort保証がない。
`libusb_close()`先行はcoreの`do_close()`がin-flight transferをリストから外しhandleをNULL化
するため、transfer寿命とevent-thread joinを壊し得る。

従ってこの段階では危険なpatch/overlayやfake成功ABIを追加せず、既存のpolicy fixtureを
build-onlyで維持する。決定論的fake Promiseで検査できるのはrelease/cancel/joinの順序、二重
callback拒否、close失敗時poisonなどのadapter policyだけで、Chromium/WebUSBが保留Promiseを
解決することやUAF不在は証明できない。将来必要な最小変更は公式backend内部でper-handleの
`USBDevice.close()`操作、open/close refcount、transfer completion ownershipを同じ状態機械へ
接続し、coreのcloseより前に全transfer callbackを一度だけ完了させる協調APIである。実機の
切断・pending transfer・timeout挙動を確認するまで、Siano version/stream/UIには接続しない。

#### Internal backend patch feasibility

公式snapshotそのものを変更するpatchも、この時点では残していない。`em_cancel_transfer()`
から`USBDevice.close()`を呼ぶ案は、WebUSBのcloseが同じdeviceの全handle・全operationへ影響し、
backendのSymbolベースopen/close chainのrefcountを暗黙に減らすため、後続`em_close()`との
二重closeを防ぐ状態を追加で必要とする。さらに複数pending transferのPromise callbackが
同時・遅延到着した場合、`usbi_signal_transfer_completion()`とcoreのflying/completed listを
一度だけ更新し、`itransfer`の解放後に触れないことをbackend側で保証しなければならない。
これらは外部patch fileのfake Promiseでは証明できず、個別cancel APIもWebUSBにはない。

従って、公式source hashを保つためのpatch/build step、内部fake Promise、WASM smokeは追加せず、
実backendへの未証明差分を残さない。将来patchを作る条件は、backend内部のper-device
sole-handle/transfer registry、暗黙closeと`em_close()`のrefcount協調、Promise callbackの
once guard、core close/join順序を同時にテストできること、および対象Chromium/Windowsでの
実pending transfer検証である。

### `selectAlternateInterface(alt=0)` stop hypothesis

WebUSB仕様には`USBDevice.selectAlternateInterface()`前に対象interfaceの進行中transferを
abortする記述があり、公式libusbの`em_set_interface_altsetting()`も同メソッドへ直結する。
しかしSiano upstreamの`inspect_and_claim()`はbulk-INを持つdescriptorを走査してinterface番号
だけを保存し、選択したalternate setting番号を保存・設定していない。したがってM1側で無条件に
同interfaceのalt=0を選び直すと、実機descriptorによっては意図しない設定変更になる。

さらに、確認したChromium Windows実装の`SetInterfaceAlternateSetting`経路は
`WinUsb_SetCurrentAlternateSetting`へ進むが、見えるrequest ownership経路にpending
`Request::Abort()`呼出しを確認できない。仕様文言だけからPromise settleやSiano event-thread
joinの有界完了を断定できない。selectAlternateInterfaceの成功、AbortErrorの到着、複数bulk-IN
callbackの一回性、release/close後のtransfer寿命を同時に検証する実機条件も未成立である。
Microsoftの`WinUsb_SetCurrentAlternateSetting`仕様もinterface上にoutstanding I/O requestが
ある場合は失敗し得ると記載しており、pending transferの停止nudgeとして利用できる根拠には
ならない。

このためalt=0を呼ぶguarded lifecycle helper、patch、fake成功ABIは追加しない。決定論的fakeで
検査できるのは「alt操作をstop前に一度だけ試す」policy順序までで、Chromium/WinUSBがpending
requestをabortする証明にはならない。将来は実descriptorのactive alternate setting保持、対象
Chromium/Windowsのrequest cancellation挙動、libusb coreのtransfer callback寿命を一体で検証し、
失敗時にstream handleをpoisonして再利用しない設計が必要である。

### PX4 IT930x scatter parser fixture

`webts_px4_it930x_protocol_mock(scenario)` は、vendorのupstream
`it930x_protocol.cpp` にある `parse_scatter_block()` / `validate_scatter_image()` を、
USBなしの合成imageへ直接適用するbuild-only ABIである。正常な単一・複数blockと、magic不正、
metadata切断、zero-length block、上限超過、空入力を固定診断へ分類し、image/payloadはABI外へ
出さない。`m1.html` の「PX4 IT930x scatter parser（合成fixtureのみ）」からscenarioを選べるが、
`navigator.usb`、control/command、firmware、card、tune、TSは行わない。

上流`it930x_protocol.h`にはcommand frameのencode/decodeやCRC検査APIがないため、このfixtureは
それらを実装・検証しない。従って「frame/CRC検証済み」や実機制御経路の成立を意味せず、上流が
提供するscatter image境界のsource-backed検査だけを保持する。

2026-09-20、親エージェントが再build・reload後のChrome `http://localhost:5173/m1.html`で
scenario 0（正常block）を実行し、status `PX4 IT930x OK` とJSON `diagnostic: OK`を確認した。
scenario 2（invalid magic）はstatus `PX4 IT930x REJECTED`、JSON `diagnostic: REJECTED`となった。
初回の`INTERNAL`はHMRが古いWASMを先に参照した一時状態で、再build・reload後に解消した。
これは合成WASM fixtureのUI実行確認であり、実機Q3U4、USB command、firmware、CRC、tune、TSの
検証ではない。

### PX4 tagged TS demux fixture

`webts_px4_tagged_ts_demux_mock(scenario, output, words)` は、vendorの
`tagged_ts_demux.cpp` / `tagged_ts_demux.h` の`TaggedTsDemux`へ合成wire packetだけを渡す
build-only ABIである。4連続packet（wire tag `0x17/27/37/47`）による同期、188-byte境界を
跨ぐ分割入力、invalid tag/TEIとsync loss、sink failure後のempty push retry、reset、入力上限
をscenario 0〜5で検証し、固定diagnostic・packet数・receiver別件数・queue境界counterだけを
返す。sinkにはnormalized sync `0x47`だけを検査させ、packet bytesは保存・公開しない。

`m1.html`の「PX4 tagged TS demux（合成fixtureのみ）」から実行できるが、
`navigator.usb`、Q3U4 open/claim/command、firmware、tune、実TS受信は行わない。main threadの
blocking joinも使用しない。これはvendor demuxの合成境界検証であり、PX-Q3U4 raw USB payload
または実放送TSへの適用成功を意味しない。

2026-09-20、修正版generated WASMを親エージェントがChromeでscenario 0〜5まで再確認し、
全て`OK`となった。scenario 0/1はaccepted 752、emitted 4、receiver各1、scenario 2は
accepted 2,068、emitted 8、discard sync-search 188、invalidTag 2、syncLoss 1、receiver各2、
scenario 3は`retryVerified: true`、scenario 4は`resetVerified: true`、scenario 5は
`boundaryVerified: true`だった。初回WASMは`HEAPU8`/`_malloc`/`_free`未exportで`INTERNAL`となったが、
overlayのexport修正後に再build・再確認済みである。これは合成fixtureのWASM/UI観測であり、
実USB・実TS受信・Q3U4実機の検証ではない。

### PX4 Q3U4StreamDataPlane source-link boundary

`q3u4_stream.cpp` と `mock_transport.cpp` は、vendor/upstream/px4-userland の
`Q3U4StreamDataPlane`/`MockTransport` を改変せずにoverlayへコンパイル・リンクした。
`webts_px4_stream_source_link_smoke` は `attach`、`read`、`stats`、`final_snapshot`、
`terminal`、`shutdown` 等のupstream API symbolを保持するだけで、data-planeを構築・実行
しない。従ってこれはsource/link成立の確認であり、stream受信の成功ではない。

実行fixture/UIは意図的に追加していない。`attach()`はworker `std::thread`を開始し、
`detach()`/`shutdown()`は`cancel_stream()`後にjoinする。上流`MockTransport`の期待列は
worker側のstream event消費と呼び出し側のcancel/stopが同時に触れ得るが、fixture用の同期
契約を持たない。この状態でブラウザmain threadからjoinを呼ぶと停止が有界であると証明
できず、Dedicated Workerへ移しても期待列の競合とdetach完了の境界を保証できないためである。
ブラウザmain threadのblocking join、実Q3U4、USB、serial、firmware、command、tune、
実TSは未実行である。将来はworker専用の有界harnessと、同期されたtransport/barrierまたは
上流test seamを別途設計し、stop/join完了を明示的に検証してからUIへ接続する。

### PX4 Q3U4StreamDataPlane synchronized lifecycle fixture

`scripts/px4-stream-lifecycle-mock.cpp` は、上流data-planeを変更せず、同期付きtest-only
`Transport` fakeを介して、4 receiver attach、合成tagged packet event、nonblocking read/
stats、detach、final snapshot、release、shutdownを実行する。fakeは4 receiverのattach完了
まで最初のeventをgateし、cancelで待機condition variableを起こすため、packet処理完了後の
detach/join境界を決定論的に検査できる。payloadは固定集計外へ出さない。

これはNode/Emscripten専用のコンソールfixtureを基準にした検査であり、standaloneの
`px4-worker-fixture.html`も残している。`scripts/
run-px4-stream-lifecycle-fixture.ps1` はtest-access版upstream objectを別にcompileし、10秒の
process上限で実行する。2026-09-20、同fixtureは`diagnostic: OK`、read 188 bytes、2 packets/
376 bytes、final terminal `stopped`、detach/release/shutdown成功を返した。さらに同じ生成
moduleを5回、各10秒上限で反復し、全て同一結果・時間内に完了した。これは同期fakeとupstream
data-planeのoffline lifecycle検査であり、実Q3U4、USB、serial、firmware、command、tune、
実TSを検証しない。ブラウザmain threadからのjoinやUI実行も行わない。

`scripts/build-px4-stream-lifecycle-worker.ps1` は同じsource-linked fixtureと同期fakeを
`ENVIRONMENT=web,worker`、`PTHREAD_POOL_SIZE=2`で別moduleへリンクし、
`px4-stream-lifecycle-worker-browser.js`を生成する。`src/usb/
px4-stream-lifecycle-worker-diagnostic.ts`が固定message shape、15秒timeout、Worker terminate、
不正応答の固定code化を共通化し、standaloneページと`m1.html`の独立したopt-inボタンから
利用する。ボタンはUSB/WebUSB経路と無関係で、main threadからpthread joinを呼ばない。

2026-09-20、親エージェントがChromeの`http://localhost:5173/px4-worker-fixture.html`で
実測し、`PX4 Worker fixture OK（合成のみ）`、`attached: true`、`readBytes: 188`、
`packets: 2`、`bytes: 376`、`finalTerminal: 5`、`detached/released/shutdown: true`を確認した。
同じWorker wrapperをM1の「PX4 stream lifecycle Worker（合成fixtureのみ）」ボタンにも接続した。
これはupstream data-plane＋同期fakeの有界完了観測であり、実Q3U4、USB、serial、firmware、
command、tune、実TS受信を検証しない。timeout後のWorker terminateがpthreadやupstream handleを
物理解放する保証もない。

同日、親エージェントが`http://localhost:5173/m1.html`の同ボタンをChromeで実行し、
`PX4 stream lifecycle Worker OK（合成のみ）`、JSONの`attached: true`、`readBytes: 188`、
`packets: 2`、`bytes: 376`、`finalTerminal: 5`、`detached/released/shutdown: true`を確認した。
これはM1ページのUI接続確認であり、standaloneページと同じく実機経路の検証ではない。

`npm run build`は`vite build`後に`scripts/package-px4-worker-dist.ps1`を実行し、検証済みの
3ファイル（browser module、pthread helper、WASM）だけを`dist/build/upstream-wasm/`へコピーする。
generated中間名、libusb/Siano/PX4の実機module、firmware、captureはproduction distへコピーしない。
helper/WASM参照、export、欠落・余分なPX4 Worker assetを同scriptが検査する。Workerビルドは
5つの直接入力source、実際にlinkしたobject群、3 assetのSHA-256 manifestも生成し、package時に
それらの変更やstale assetを拒否するとともにvendor lockを再検証する。これはupstream全ソース
の再ビルドを代替しないため、clean checkoutではoverlay object準備後にWorker buildを先に実行する。
その後は`vite preview`でもM1の合成Workerボタンが同じ相対assetで動作する。

2026-09-20、親エージェントがproduction preview `http://127.0.0.1:4173/m1.html`で同ボタンを
実行し、`PX4 stream lifecycle Worker OK（合成のみ）`、`attached: true`、`readBytes: 188`、
`packets: 2`、`bytes: 376`、`finalTerminal: 5`、`detached/released/shutdown: true`を確認した。

### libusb WebUSB pending-transfer boundary (no patch adopted)

vendorの公式`emscripten_webusb.cpp`を再監査した。`em_cancel_transfer()`は成功値だけを
返し、`em_submit_transfer()`が登録した`transferIn` Promiseを中断しない。さらにbackendの
`PromiseResult`はPromise callback到着時に初めてplacement-constructされるため、cancel時に
単純に`usbi_signal_transfer_completion()`を先行発行すると、未構築のtransfer-private値を
読み出す可能性がある。逆に先行して論理cancel callbackを作るには、遅れて到着するPromise
callbackが同じ`itransfer`を参照せず、completion listへの二重登録もしない共有寿命とonce
guardが必要になる。

libusb coreの`do_close()`はin-flight transferをlistから外し、`dev_handle`をNULL化してから
backend closeを呼ぶため、`libusb_close()`先行はSianoのjoinを安全に解決する代替にならない。
WebUSBのopen/close chainはdevice-level reference countだけを調停し、transfer-level所有権を
提供しない。外部overlayからはbackend privateの`CachedDevice`、Promise、open/close chainへ
安全に接続できないため、vendor変更なしの最小patchやfake成功ABIは追加していない。

検証に必要なのは、公式backend内部とcoreの両方で、`Pending -> CancelRequested -> Settled`
を共有状態として管理し、論理callback once、Promise late-resolution、transfer-private
destructor、複数handle close/refcountを同時に検査するpatchと、fake Promise/実Chromiumの
pending `transferIn`観測である。現状は論理停止の有界性も物理解放も証明できず、Siano
stream/version/UIへ接続しない。

### USB-free transfer ownership model (experimental, not libusb)

`scripts/libusb-transfer-ownership-model.cpp` は公式libusbへ接続しないtest-only modelで、
Promise側がraw `itransfer`ではなくshared stateだけを保持する仮想境界を検査する。pending
からcancel-requested、settled/detachedへの遷移、自然完了、二重cancel、disconnect、late
resolve/reject、同期user callbackによるtransfer token破棄、複数pendingと同一device相当の
handle refcount、close failureを7 scenarioで固定検査する。`run-libusb-transfer-ownership-model.ps1`
はEmscripten/Nodeで10秒上限付き実行し、`OK`、callback exactly-once、late Promise safe、
duplicate cancel処理、複数handle処理を確認した。cancelではPromiseがpendingのまま先に
core相当callbackをsettleし、その後のresolve/rejectをlateとして無視する。disconnectでも
coreの`NO_DEVICE`相当callbackをexactly onceで発行する。cancel callbackとlate Promise
callbackを無防備に両方通すnaive baselineがdouble-callbackになる回帰条件もモデル内で確認し、
shared-state once guardを通した側だけを`OK`とする。late callbackについてはtoken破棄後に
モデルstateが5件のlate eventを受けたことだけを計測し、これは実backendのUAF不在を証明しない。
固定report
はcallback合計3、late ignored 5、late-after-user-free 5、physical abort未証明だった。

これは所有権state modelの回帰試験であり、`emscripten_webusb.cpp`、libusb coreの
flying/completed list、WebUSB `USBDevice.close()`の物理abort、Chromium/WinUSBの有界settleを
検証・保証しない。`physicalWebUsbAbortProven: false`を固定出力し、通常M1 module、UI、実USB、
firmware、tune、実TSへ接続していない。

なおcoreのdisconnect pathは、Promise未完了でも`clear_transfer_priv()`後に
`usbi_handle_transfer_completion(NO_DEVICE)`を直接呼ぶ。従ってbackend側だけのcancel patch
では、submit時のstate初期化、idempotentなprivate clear、late callbackの`itransfer`非参照を
同時に満たせない。completion処理はユーザーcallbackがtransferをfreeし得るため、once guard
の解除とbackend private stateのdetachをその前に完了させる必要がある。このcore/backend
境界を変更・統合テストせずにexperimental patchを残すことは、検証ではなくUAFリスクの導入
になるため見送った。
### Source-bound libusb WebUSB cancellation regression (test-only)

`scripts/run-libusb-webusb-cancel-regression.ps1` compiles the vendored,
unmodified `core.c`, `io.c`, `emscripten_webusb.cpp` and the other official
libusb objects with a C++ harness. The harness installs only a fake WebUSB
`navigator.usb`/`USBDevice`, reaches the real `getDevices` → descriptor →
`open` → bulk `transferIn` path, and keeps that `transferIn` promise pending.
The bounded child-process report was:

```json
{"diagnostic":"OBSERVED","backendCancelReturn":0,"fakeTransferInCalls":1,"callbacksBeforePromiseSettlement":0,"callbacksAfterTaskTurnWithoutPromiseSettlement":0,"transferStatusWhilePromisePending":255,"cancelDidNotSettleWithinTaskTurn":true,"fakePromiseStillPending":true,"physicalAbortProven":false}
```

Thus the real backend invoked the fake `transferIn` exactly once, returned
success from `libusb_cancel_transfer`, and delivered no callback through one
JavaScript task turn; the transfer status remained unset while the fake
Promise was pending. This does not establish behavior beyond that task turn.
The isolated child intentionally does not free
that still-in-flight transfer; it terminates after recording the observation.
The harness does not claim physical WebUSB abort, bounded `stop/join`, or
safe cleanup. A one-configuration descriptor variant aborted in this Node
fixture, so the passing fixture deliberately uses a valid device descriptor
with zero configurations and does not claim configuration-parser coverage.
No production backend, UI, or real USB path uses this fixture.

### Source-bound pending `libusb_close()` observation (experimental, test-only)

同じ公式backend/coreとfake WebUSBを使う別シナリオでは、bulk `transferIn` Promiseを保留した
まま`libusb_close(handle)`を呼び、closeの論理復帰だけを観測する。Nodeの10秒上限付き
isolated childで得た固定reportは次のとおりだった。

```json
{"diagnostic":"OBSERVED","callbacks":0,"status":255,"closeReturned":true,"fakeTransferInCalls":1,"promiseSettlementObserved":false,"physicalAbortProven":false}
```

これは実backendのfake `transferIn`が1回呼ばれ、保留中に`libusb_close()`が戻った時点でcallbackが
0、transfer statusが未設定だったことだけを示す。coreの`do_close()`がin-flight transferを
リストから外し`dev_handle`をNULL化するため、harnessはPromiseをresolve/rejectせず、transfer・
handle・contextをfree/exitせずにchild/Worker終了へ後始末を委ねる。したがって物理
`USBDevice.close()`のAbortError、late Promiseの安全性、物理解放、Siano stop/joinの有界性を
証明しない。Chromeでの実験は別途必要であり、通常M1 module・実機USB・Siano UIへ接続していない。

その後、親エージェントがChromeのDedicated Workerで同じexperimental fast-path fixtureを実行し、
次のreportを確認した。

```json
{"diagnostic":"OBSERVED","callbacks":0,"status":255,"closeReturned":true,"fakeTransferInCalls":1,"promiseSettlementObserved":false,"physicalAbortProven":false}
```

Node結果とChrome結果はいずれも`libusb_close()`の論理的な返却を示すだけであり、in-flight
transferのcleanup、WebUSBの物理abort、物理解放、late Promiseの安全性、Siano stop/joinの
有界性を意味しない。実USBやproduction M1経路には接続していない。

比較用に、公式stock `events_posix.c`を使うDedicated Worker moduleにも同じpending-close
exportを追加した。fixtureのscenarioはstock Workerとzero-timeout fast-path Workerを分離して
選択でき、どちらもfake WebUSBのみを使う。fast-path版とstock版のChrome観測は後述のとおり
一致したが、この結果を物理解放へ一般化しない。

その後、親エージェントがChrome Dedicated Workerで`pending-close-stock`も実行し、stock版でも
次の同一reportを確認した。

```json
{"diagnostic":"OBSERVED","callbacks":0,"status":255,"closeReturned":true,"fakeTransferInCalls":1,"promiseSettlementObserved":false,"physicalAbortProven":false}
```

これはstock版とfast-path版の限定的なclose復帰観測が一致したことを示すだけである。
in-flight transferのcleanup、物理解放、WebUSB物理abort、late Promiseの安全性、Siano
stop/joinの有界性は依然として未証明であり、実機・production経路へ接続していない。

`scripts/build-libusb-webusb-cancel-worker.ps1` links the same pristine official
objects and harness as an opt-in Dedicated Worker module with a fake
`navigator.usb`; it does not add this path to the M1 USB buttons. The separate
`libusb-cancel-fixture.html` page is bounded by a 10-second Worker timeout and
shows only the fixed report. Its pending scenario was later confirmed in
Chrome; the separate settle scenario is still only Node-verified. Worker
termination and physical WebUSB abort remain unproven. The
reported `fakeTransferInCalls: 1` is a fixed C++ assertion outcome (the harness
rejects any other count before packing success), not an exposed raw counter;
the fake `navigator.usb` is installed inside the Worker before libusb calls.

The Node settle runner additionally resolved the fake Promise after cancel and
processed the real libusb event path with a zero-timeout loop:

```json
{"diagnostic":"OBSERVED","resolved":{"mode":"resolve","diagnostic":"OBSERVED","callbackCount":1,"callbackStatus":3,"eventResult":0,"backendCancelReturn":0,"physicalAbortProven":false}}
```

This is a resolved-Promise/CANCELLED callback observation only. A rejected fake
Promise emitted raw Emscripten stderr in the experimental runner, so that
scenario was removed rather than exposed or reported as safe; no promise
rejection result is claimed.

The settle selector is not a one-task-turn check: it resolves the fake Promise,
yields, and then makes bounded zero-timeout `libusb_handle_events_timeout`
attempts before deciding whether the `CANCELLED` callback arrived. In Chrome,
the 2026-09-20 attempt timed out at fixed stage `7` (immediately before the
first event-API call), rather than producing an `OBSERVED` result. The Node
source-bound variant separately returns one `CANCELLED` callback after the
resolved fake Promise; that Node result does not transfer to Chrome. The
standalone fixture therefore remains test-only and does not claim a browser
callback or bounded physical abort. A timeout may include only the last fixed
native stage (1--13); progress messages are ignored unless they use that fixed
shape.

The stage-7 location matches the pristine source path: `io.c` preserves the
zero `timeval`, `libusb_handle_events_timeout_completed()` enters `handle_events`,
and Emscripten `events_posix.c` calls `em_libusb_wait()` before `poll()` even
for that zero timeout. On the Worker main runtime thread this reaches the
`EM_ASYNC_JS` `Atomics.waitAsync(HEAP32, ..., timeout)` helper. The Worker
variant uses `ENVIRONMENT=web,worker`, `ASYNCIFY=1`, and the no-pthread objects;
the source audit makes this the leading explanation for the stage-7 hang, not a
proven root cause. A separate USB-free event-loop smoke ABI now probes only
`libusb_init()` → zero-timeout `libusb_handle_events_timeout()` → `libusb_exit()`;
it does not bypass libusb completion or modify the official backend.

The zero-timeout smoke was then run in Chrome on the same generated Worker and
timed out at fixed stage `3` (immediately before its first
`libusb_handle_events_timeout()` call), without a device or transfer. This
isolates the Worker/module event-API boundary rather than the pending Promise.
An experimental script creates an ignored build copy of the pinned
`events_posix.c`, skips `em_libusb_wait()` for `timeout <= 0`, and links a
separate Worker module. It does not alter vendor files, production assets, or
completion semantics; the patched module is not an M1 path. Chrome verification
is recorded below in the required zero-event-before-settle order.

2026-09-20、同じChrome Workerで実験buildを順に実行した結果は、zero-timeout
smokeが `diagnostic: OBSERVED, eventClass: SUCCESS`、続くsettleが
`diagnostic: OBSERVED, callbackCount: 1, callbackStatus: 3 (CANCELLED),
eventResult: 0, backendCancelReturn: 0, physicalAbortProven: false` だった。
これはstock buildのstage 3/7 timeoutとの比較切り分けであり、fast-pathを
M1/productionへ採用した結果ではない。Node source-bound settleは同じ固定
reportを5回連続で返したが、Chromeは各シナリオ1回の観測に留まる。
source-bound backendでuser callbackがtransferをfreeするケース、二重callback
防止、WebUSBの物理abort、Siano stop/joinのboundednessは依然として未証明である。

Nodeのexperimental fast-path childでは、別ABI
`webts_libusb_webusb_cancel_user_free_regression`を実行し、user callback内の
同期`libusb_free_transfer()`後に
`{"diagnostic":"OBSERVED","callbackCount":1,"callbackStatus":3,"eventResult":0,"backendCancelReturn":0,"freedInCallback":true,"physicalAbortProven":false}`
を得た。callback外のstable heap state/bufferを使い、callbackがtransferをfree
しなかった失敗経路ではhandle/contextを閉じずisolated child終了へ委ねる。
これはresolved Promiseの通常完了とcallback内freeの一往復だけをsource-boundに
検査するもので、late Promise、disconnect、二重callback、物理abortは証明しない。

2026-09-20、親エージェントがChrome Dedicated Workerの同じexperimental
fast-path buildでこのuser-free選択肢を実測し、Nodeと同じく
`diagnostic: OBSERVED`、`callbackCount: 1`、`callbackStatus: 3 (CANCELLED)`、
`eventResult: 0`、`backendCancelReturn: 0`、`freedInCallback: true`、
`physicalAbortProven: false`を確認した。これはfake Promiseのresolved pathと
libusb event API復帰後のcallback内freeだけを示すtest-only観測であり、stock
buildへの適用、late Promise/disconnect、二重callback/UAF不存在、WebUSB物理abort、
Siano stop/join boundednessは示さない。

2026-09-20、親エージェントがChromeの`http://localhost:5173/libusb-cancel-fixture.html`で
実測し、`diagnostic: OBSERVED`、cancel return `0`、callbacks `0/0`（Promise settle前／1 task
turn後）、pending status `255`、fake transferIn calls `1`、`physicalAbortProven: false`を確認した。
これはNode fixtureと同じsource-bound official backendのUSB-free Worker観測であり、実WebUSBの
abort、Siano stop/join、Promise resolve後のexactly-once callback、in-flight解放を証明しない。
test-onlyページはVite devでのみ直接配信し、WASM未同梱のproduction distには含めない。

### Test-only backend patch assessment (not adopted)

The source-bound audit does not justify an overlay patch. In the pristine
backend, `em_submit_transfer()` captures the raw `usbi_transfer*` in the late
Promise callback, while `em_clear_transfer_priv()` destroys the inline
`PromiseResult`. Independently, core disconnect calls `clear_transfer_priv()`
and then invokes the `NO_DEVICE` completion path; that path may let the user
callback free the transfer. A safe patch would therefore need submit-time
shared state, an exactly-once detach/settle guard, core flying/completed-list
ordering, and per-handle WebUSB close/refcount coordination. Those ownership
edges are not exposed by the backend's public API, so a backend-only patch or
an additive overlay cannot prove late-callback safety. No patch file or
production-build change was left; the regression harness above remains the
honest boundary and is not a stop/join or physical-abort solution.

### Source-bound transfer ownership patch (test-only, 2026-09-20)

上の「Test-only backend patch assessment (not adopted)」が必要条件として挙げた
submit時shared state、user callback前のexactly-once detach、core flying/completed list
順序、複数handleのclose/refcountを、**隔離build copyへのtest-only patchとして一度に
実装し、stockを失敗基準にしたsource-bound regressionで検査した**。vendor snapshotは
変更しておらず、`scripts/check-vendor-sources.ps1`は引き続き成功する。production build、
M1 UI、Siano/PX4の実機経路、実USBには一切接続していない。

#### patchの内容

patch本文は`scripts/libusb-ownership-patch/`（backend）と
`scripts/libusb-ownership-patch-io/`（core）にneedle/replacement対として固定し、
`scripts/build-libusb-webusb-ownership-source.ps1`が固定sourceに対して各hunkが
**ちょうど1回**一致することを検証してから`build/`配下の無視されるcopyを生成する。
一致しなければ生成自体が失敗する。

`os/emscripten_webusb.cpp`への変更は3点である。

1. transfer privateを`PromiseResult`から`TransferPriv`へ変える。`TransferPriv`は
   submit時に構築され、`std::shared_ptr<TransferSharedState>`と
   `std::optional<PromiseResult>`を持つ。WebUSB promiseのcallbackは生の
   `usbi_transfer*`ではなくこのshared stateだけをcaptureする。
2. `em_cancel_transfer()`が、settle済みでなければ`usbi_signal_transfer_completion()`を
   一度だけ発行する。保留promiseを物理中断できないままでも、論理callbackが有界に1回届く。
   後から到着したpromise resultはshared stateの`detached`/`settled`で捨てられる。
3. `em_handle_transfer_completion()`と`em_clear_transfer_priv()`が、transfer privateを
   破棄してshared stateをdetachしてから**user callbackへ制御を渡す**。user callbackが
   transferをfreeしても、late promiseはそのメモリに触れない。

`io.c`への変更は1点で、`usbi_handle_disconnect()`がbackendの発行済み完了を
completed listから回収してから自分の`NO_DEVICE`完了を実行する。`list_del()`が
entryをNULL化するため冪等である。この1点がないと、cancel直後・event処理前の
disconnectで同じtransferが2回完了する（下のscenario 9）。

#### 検査scenarioと結果

`scripts/libusb-webusb-ownership-regression.cpp`を、固定公式objectに対して
**pristine版とpatch版の2回linkし**、1 scenarioにつき1つの隔離childまたはWorkerで実行する。
USB表面はmodule内に設置するfake `navigator.usb`だけで、descriptorとbulk `transferIn`の
promiseしか持たない。期待を満たさない場合はfree/close/exitを行わず、childまたはWorkerの
終了に後始末を委ねる。

| # | scenario | stock（失敗基準） | patched |
| ---: | --- | --- | --- |
| 0 | cancel後、promise未解決のまま | `DIVERGED` callbacks 0 | `OK` callbacks 1 / `CANCELLED` |
| 1 | cancel後のlate resolve | `DIVERGED` callbacks 0 | `OK` callbacks 1、late detach 1 |
| 2 | cancel後のlate reject | `DIVERGED` callbacks 0 | `OK` callbacks 1、late detach 1 |
| 3 | user callback内free → late resolve | `DIVERGED` callbacks 0 | `OK` callbacks 1、freed、late detach 1 |
| 4 | 二重cancel | `DIVERGED` callbacks 0 | `OK` callbacks 1、2回目`NOT_FOUND` |
| 5 | pending中のdisconnect | `DIVERGED` **callbacks 2** | `OK` callbacks 1 / `NO_DEVICE` |
| 6 | 2 handle同時cancel＋一方close | `DIVERGED` callbacks 0 | `OK` 各1 callback、priv 2/2、close成功 |
| 7 | 通常完了（回帰ガード） | `OK` callbacks 1 / `COMPLETED` / 32 bytes | `OK` 同値 |
| 8 | disconnect＋callback内free → late resolve | Nodeは`abort()`、Chromeは`abort()`後に固定`TIMEOUT` | `OK` callbacks 1、freed、late detach 1 |
| 9 | cancel→event処理前のdisconnect | `DIVERGED` **callbacks 2** | `OK` callbacks 1 / `NO_DEVICE` |

scenario 7は両方で成功しなければならない回帰ガードであり、これが通ることで
「patchが通常完了を壊していない」ことと「harness自体が成立している」ことを示す。
scenario 0〜6・8・9はstockが成功してはならない。driver scriptはこの両方向を検証し、
patched childがstderrへ出力した場合も失敗にする。

scenario 5と9でstockが**2回**callbackを配ることが、この段階で新たに測定できた具体的な欠陥である。
late promiseが既に完了済みの`itransfer`を再びcompleted listへ載せるためで、
scenario 8のようにuser callbackがtransferをfreeしていると、stockではその2回目が
解放済みメモリへの参照になり、実際にNode/Chromeの隔離childが`abort()`した。
これは従来「未証明」としていたUAF経路を、合成入力で再現できる形にしたものである。

#### 実行方法と実測

- Node: `pwsh -NoProfile -File scripts/run-libusb-webusb-ownership-regression.ps1`。
  固定公式objectをその場でcompileし、2 variant×10 scenarioを1つずつ20秒上限の
  隔離childで実行して、上表どおり`diagnostic: OK`・`failures: []`を返した
  （2026-09-20実測）。
- Chrome: `pwsh -NoProfile -File scripts/build-libusb-webusb-ownership-worker.ps1`で
  Worker moduleを生成し、dev専用の`http://localhost:5173/libusb-ownership-fixture.html`で
  2 variant×10 scenarioを実行した。**全20件がNodeと同一の固定値**となった
  （2026-09-20実測）。stock scenario 8だけはWorkerが`abort()`し、
  Asyncify中の例外がawaitへ届かないため、wrapperが15秒の固定`TIMEOUT`（stage 5）として
  打ち切った。これはstockが安全でないことの記録であり、成功ではない。

Worker moduleは`ENVIRONMENT=web,worker`・no-pthread objectで、既存の
zero-timeout fast-path copyの`events_posix.c`を併用する。固定upstreamの
`em_libusb_wait`がChromeのWorker runtime threadでzero timeoutでも復帰しないため、
この実験差分なしではChrome側でevent APIが返らない。したがってChromeの結果は
**ownership patchとevents fast-path実験の2つの差分の上**で得たものであり、
公式snapshotそのままの挙動ではない。

#### TypeScript境界とテスト

`src/usb/libusb-ownership-worker.ts`はmodule URLとscenario番号だけを受け取り、
固定20 wordのreportを返す。`src/usb/libusb-ownership-worker-diagnostic.ts`は
15秒timeout、Worker terminate、進捗stageの無視、要求と異なるscenarioを名乗るreportの拒否、
非整数fieldの拒否、失敗時の固定診断を担当する。`physicalAbortProven`と`realUsbUsed`は
常に`false`で、payload、serial、raw exception、raw stdout/stderrはABIとUIへ出さない。
`test/libusb-ownership-worker-diagnostic.test.ts`がこれらの境界を検査する。
fixtureページはRollup inputに含めず、production distへは出力されない（確認済み）。

#### まだ証明していないこと

- WebUSBの**物理**abort。`transferIn`のpromiseは依然として解決されないまま残り、
  patchが保証するのは論理callbackの有界性とtransfer寿命の安全性だけである。
  `physicalAbortProven`は常に`false`のまま出力する。
- 実Chromium/Windowsで実デバイスの保留転送・切断・timeoutがどう振る舞うか。
  本regressionのUSB表面はすべてfakeである。
- Sianoの`stop_streaming()`が有界に完了すること。論理callbackが1回届くことは
  upstreamのactive transfer数減算とevent thread joinの前提を満たす方向だが、
  upstreamと接続した検証はまだ行っていない。
- pthread build（`_REENTRANT`）での競合。patchのshared state更新は`runOnMain()`で
  main threadへ寄せてあるが、本regressionはすべて単一threadで実行しており、
  proxy経路とlock順序の同時実行検査は未実施である。
- 複数handleの**close順序**の網羅。scenario 6は2 handleの同時cancelと一方のcloseまでで、
  open/close chainのrefcountを全組み合わせで検査したものではない。
- 固定upstreamの`events_posix.c`のままChromeでevent APIを回す方法。上記の
  fast-path実験に依存したままである。

以上が満たされるまで、このpatchをvendor snapshot、production build、M1 UI、
Siano/PX4の`start_streaming()`・`get_version()`・実機stream経路へ採用しない。
