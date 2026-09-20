# px4-userland 仕様

Status: Frozen v0.15 (2026-09-11)

本書の`MUST`、`MUST NOT`、`SHOULD`は規範要件を示す。実機観測で前提の誤りが判明した場合も暗黙に
実装だけを変えず、本書のversionと変更理由を更新してから実装する。

v0.15では、Termuxランチャーの終了処理を改訂する。v0.14の猶予（約2秒）では、tune（最大30秒）やカードAPDU（最大3秒）の処理中にSIGKILLが送られる可能性があったため、stage 0によるプロセスグループ回収（drain）を固定40秒の有限猶予へ変更する。猶予超過時はSIGKILLを用い、graceful cleanup、LNB 0V、およびruntime endpoint削除を保証できない旨を警告する。また、source archive監査で `__pycache__/`、`.pyc`、`.pyo`、`.pyd` を拒否する。
v0.14では、Androidの全ABIで共通して不足していたTermux用の正式な2 FD起動経路を追加する。`px4-termux`をstage 0の監督プロセスとして残し、`util-linux`の`setsid`で最初の`termux-usb`を独立したプロセスグループとして起動する。stage 0はそのグループを監督し、stage 1およびstage 2は`exec`で1回につき1 FDを渡す入れ子の`termux-usb`を経て`px4d`へ引き継ぐ。これによりQ3U4の2つのUSBデバイスを1つの`px4d`へ渡し、x86_64をaarch64およびarmv7aと同じ配布候補に加える。
v0.13では、Android NDK API 24のx86_64をCIでcompile/ELF verifyするbuild-only経路として追加する。これは
runtime supportや配布対象ではなく、Bliss OSでの実機試験を行うまではhardware-unverifiedとする。
v0.8では、`empty_intervals`の訂正でstream starvationを見逃さないよう、1秒以下の観測間隔と連続5秒以内の
packet/byte進行を受入条件に追加した。これはwire semanticsの変更ではなく、v0.7のacceptance erratumを
機械的に検証可能にする訂正であり、protocol minorは変更しない。
v0.12ではLinux production executableをlibusb 1.0.30包含のmusl完全静的ELFへ変更し、IFD Handlerをglibc 2.31
またはmuslのhost-loadable shared objectとして分離する。配布archive名はlibc-qualifiedとし、generic Linux名は廃止する。
（履歴）v0.11ではLinux aarch64のnative CI buildとmusl-dynamic配布archiveを追加した。v0.12で配布方式を置換済みで、
build-tested / hardware-unverifiedと表示し、Stable受入では既知の非ブロッカーとして扱う。
（履歴）v0.10ではStable受入方針を、当時の主環境HAOSでの2時間試験と各対象環境での30分以上の実機試験へ改訂した。
receiver 7の既知burstは、同一個体・同一条件で取得した`tsukumijima/px4_drv`の参照結果より悪化しないことを
確認できれば非ブロッカーとする。LNBは無負荷の0V/15V/0V切替を受入済みとし、代表負荷時の能力未確認は
既知制限として記録する。最終配布archiveそのものの試験、重大な未解決issueがないこと、公開前レビューを
Stable公開の条件に追加する。
v0.9では、`v0.1.0 Beta`の実機試験結果と公開時の扱いを明記した。receiver 7の既知burstは同一個体・同一条件の
参照結果と比較して扱う。Beta公開の目的は、追加個体および追加環境の証拠収集とする。
v0.7では、実機長時間試験で確認した`empty_intervals`の意味をUSB待機のTIMEOUT/空completion回数と明記し、
非zero値だけをTS integrity failureにしない受入条件へ訂正した。
v0.6では、LNB 15Vを明示的に許可したdaemonだけが出力できる安全境界、GPIO完了が曖昧な場合の
cleanup debt、片側USB切断時の生存bridge停止、無負荷電圧と負荷時能力を分ける受入条件を追加した。
v0.5では、GPL/LGPLのrelease contractを明確化し、v0.4からのlegacy source cleanupを完了した。製品対象は
Linux（カーネルドライバを導入できない環境を含む）、AndroidのTermuxおよびAPK経路、macOSに限定する。Windows
runtime、adapter、実機受入、配布物、Windows build-only gateは対象から外した。
対象に残る4 runtime経路では、Q3U4のチューナーと内蔵カードリーダーの両方を成立条件とする。

## 1. Objective

`px4-userland`は、PLEX PX-Q3U4をカーネルモジュールなしで制御するユーザー空間ドライバである。
USB通信にはlibusb-1.0だけを使用し、Q3U4の8チューナーと内蔵ICカードリーダーを同じデバイス所有者の下で扱う。

対象環境はLinux/glibc、Linux/musl、Android/Bionic、macOSとする。ビルド成功と自動試験成功を移植性の
条件とし、実機試験を行っていないOSは、
公開時に「build-tested / hardware-unverified」と明記し、動作確認済みとは表現しない。

support matrixと実機検証経路は次のとおりとする。

| Environment | Machine | Access path | Primary validation |
|---|---|---|---|
| Linux x86_64 | Dell Latitude 5300 / AnduinOS | native libusb | tuner、card core、PC/SC adapter |
| Linux aarch64 | GitHub Actions `ubuntu-24.04-arm` | native arm64 Alpine/musl CI | build-tested / hardware-unverified |
| HAOS SCS native | Lenovo ThinkCentre M720q / Studio Code Server上のDebian 13/glibc、HAOS kernel | native libusb | SCS directのtuner/card/PCSC経路 |
| HAOS Alpine add-on | Lenovo ThinkCentre M720q / Supervisor add-on | add-on内のmusl/libusb | Alpine/musl add-onのtuner/card/PCSC経路 |
| Android | Pixel 9a / aarch64 / Termux | `termux-usb`および`px4-termux`による2 fd渡し | 正式launcherの実機回帰（Bionic CLI、portable IPC） |
| Android | Google TV Streamer / armv7a / Termux | `termux-usb`および`px4-termux`による2 fd渡し | 正式launcherの実機回帰（Bionic CLI、portable IPC） |
| Android | Bliss OS / x86_64 / Termux | `termux-usb`および`px4-termux`による2 fd渡し | 正式launcherの実機回帰（Bionic CLI、portable IPC） |
| Android | Google TV Streamer / ad-hoc APK | Android USB Host APIからfd渡し | armv7a native coreをAPK processから利用する経路 |
| macOS | Apple Mac mini / M2 | native libusb | tuner、card core、PC/SC adapter |
| Windows | unsupported | 対象外 | `tsukumijima/px4_drv`を利用する。px4-userlandのCLI/IPCとは非互換 |

## 2. Scope

### 2.1 Goals

- PX-Q3U4 (`VID 0x0511`, `PID 0x084a`) の全8チューナーをユーザー空間から制御する。
- PX-Q3U4内蔵ICカードリーダーでカード検出、ATR取得、リセット、T=1 APDU送受信を行う。
- Q3U4を構成する2つのIT9305Eを同一筐体として対応付け、2基間で連動するbackend powerを一貫して管理する。
- USB列挙、制御転送、非同期TS転送、カードUARTをlibusb-1.0で実装する。
- Androidでは、アプリが開いたUSB file descriptorを`libusb_wrap_sys_device()`で受け取る。
- portable coreをC++17と標準ライブラリで実装し、OS固有処理をplatform adapterへ隔離する。
- muslおよびBionicでビルドし、glibc固有APIやGNU拡張へ依存しない。
- 派生コードのライセンスをGPL-2.0-onlyとする。
- Linux/macOSではPC/SC IFD Handlerを提供し、Androidではportable IPCを公開する。
- Linux、Android Termux、Android APK、macOSの各runtime経路でチューナーと内蔵カードリーダーを扱う。
- 最終ツリーから、カーネルモジュール、DKMS、カーネル用chardev、非対象機種、旧Windows専用ホストなど、
  portable Q3U4 userland実装に不要なコードと配布処理を削除する。

### 2.2 Non-goals

- `tsukumijima/px4_drv`へのPull Request。
- ファームウェアバイナリの同梱。
- ファームウェアのダウンロード、vendor driverからの抽出、変換機能。
- mirakcの同梱またはmirakc側の変更。
- Home Assistantアドオンの作成または変更。
- PX-W3U4、PX-Q3PE4、PX-Q3PE5、PX-W3PE5、PX-MLT系、e-Better系など、Q3U4以外の動作保証。
- 配布用Android APKまたはdtv-androidへの統合。Google TV Streamer実機検証用のad-hoc APKは試験器具として許容する。
- B-CAS/ACASの暗号処理、ECM処理、TSのスクランブル解除。
- ネットワーク越しの利用。IPCは同一ホスト内に限定する。
- Windows用runtime、adapter、CLI/IPC互換層、配布物、build-only gate。Windows利用者向けの
  `tsukumijima/px4_drv`は別製品・別interfaceであり、px4-userlandのdrop-in代替ではない。

Q3U4と共通するチップを持つ他機種で偶然動作しても、対応機種一覧へ追加しない。
実機確認、回帰試験、明示的な仕様変更を行うまでは「unsupported / unverified」とする。

## 3. Product architecture

### 3.1 Process model

Q3U4のUSBデバイスを直接所有するプロセスは、長寿命の`px4d`ただ1つとする。

Q3U4は同一筐体内に2つのIT9305Eを持ち、各USBデバイス上で複数チューナーと制御経路を共有する。
チューナーごとに独立したプロセスがlibusb interfaceをclaimする構成は採用しない。

提供する実行ファイルは次の3つとする。

- `px4d`: USBデバイス、ファームウェア、受信機、TS転送、共有電源、カードセッションを所有する。
- `px4-ts`: `px4d`へ接続し、1受信機を確保してMPEG-TSをstdoutまたは指定ファイルへ出力する。
- `px4ctl`: デバイス一覧、状態、統計、カード状態、ATR、reset、APDU送受信を扱う診断・制御CLI。

`px4d`はforeground動作を標準とし、自身でdaemonizeしない。プロセス監視は利用側へ委ねる。
LNB 15Vは安全上の明示的opt-inとし、`px4d --allow-lnb-power`なしで受けた15V要求は、GPIOを書き込まず
`UNSUPPORTED`で拒否する。0V要求と地上波利用はこのoptionに依存しない。

### 3.2 Internal layers

最終実装は以下の責務へ分割する。

1. `usb`: libusb context、列挙、fd wrap、interface claim、control/bulk transfer、hotplug。
2. `it930x`: firmware load、register、I2C、TS aggregation、UART、GPIO。
3. `frontend`: TC90522、R850、RT710、ISDB-T/S tune、C/N、LNB。
4. `device`: Q3U4の2 USBデバイスの対応付け、8受信機、共有電源、寿命。
5. `stream`: 非同期bulk transfer、188-byte packet同期、受信機別分配、queue、統計。
6. `card`: card hardware adapter、ATR、T=1状態機械、APDU、共有・排他。
7. `ipc`: versioned local protocol、control connection、TS data connection。
8. `platform`: filesystem Unix domain socket、終了通知などのOS差。
9. `cli`: `px4d`、`px4-ts`、`px4ctl`。

portable coreからOS vendor固有header、Linux kernel header、glibc内部APIをincludeしない。

### 3.3 Build system and language

- CMake 3.16以上を正規ビルドシステムとする。
- portable coreはC++17とする。
- チップ制御コードをCから再利用する場合はC11とし、Linux kernel型・macro・allocatorを含めない。
- portable coreは例外とRTTIを使用せず、失敗を固定enumまたはresult型で返す。標準thread、mutex、
  condition_variable、atomicは使用できる。
- 内部エラーは独自の固定enumを使用し、Linuxの負のerrnoを公開IPCへ直接流さない。
- libusbの最小バージョンは1.0.23とする。
- Androidのruntime targetはAPI 24以上、`armv7a-linux-androideabi`、`aarch64-linux-android`、
  `x86_64-linux-android`とする。3つのABIを同一の配布・監査対象とし、各archiveへ同じ`px4-termux`を収録する。

## 4. Device contract

### 4.1 Q3U4 identification and grouping

- 対応USB IDは`0511:084a`だけとする。
- 同じ物理Q3U4に属する2つのUSBデバイスをserial情報で対応付ける。
- `dev_id == 1`を主デバイスとし、物理カードスロットは主デバイス側の1つだけ公開する。
- 対応する2デバイスが揃わない場合は、完全なQ3U4としてreadyにしない。
- 複数筐体を列挙できる設計にするが、1つの`px4d`インスタンスが所有するのは`--device`で選択した1筐体とする。
- 同一USB interfaceにカーネルドライバまたは別プロセスが接続中なら、暗黙に奪わず`busy`で失敗する。

### 4.2 Receiver numbering

受信機番号は再接続後も次の順序を維持する。

| ID | Main/sub device | System |
|---:|---|---|
| 0 | `dev_id 1`, receiver 0 | ISDB-S |
| 1 | `dev_id 1`, receiver 1 | ISDB-S |
| 2 | `dev_id 1`, receiver 2 | ISDB-T |
| 3 | `dev_id 1`, receiver 3 | ISDB-T |
| 4 | `dev_id 2`, receiver 0 | ISDB-S |
| 5 | `dev_id 2`, receiver 1 | ISDB-S |
| 6 | `dev_id 2`, receiver 2 | ISDB-T |
| 7 | `dev_id 2`, receiver 3 | ISDB-T |

1受信機は同時に1クライアントだけが占有できる。他受信機とカードは並行利用できる。

### 4.3 Tuning API

公開するtune parameterは固定幅で、少なくとも次を含む。

- system: `ISDB_T`または`ISDB_S`
- frequency: kHz単位の`uint64`
- stream ID: ISDB-SのTSID、または明示的に指定したslot
- bandwidth: ISDB-Tでは6MHz
- LNB voltage: 0Vまたは15V

slotとTSIDはIPC上で別fieldとし、値の大きさから暗黙判定しない。

### 4.4 TS stream

- 1パケットを188 byteとして扱う。
- aggregation tagは筐体全体のreceiver IDではなく、各IT9305E内で独立した`1..4`である。
- wire上の同期byteは`(local_receiver_tag << 4) | 0x07`、すなわち`0x17`、`0x27`、`0x37`、`0x47`だけを
  受理する。bit 7が立つ値はtransport error indicatorとして拒否する。
- global receiver IDは`((dev_id - 1) * 4) + (local_receiver_tag - 1)`で求める。したがって同じ`0x17`でも、
  `dev_id 1`ではreceiver 0、`dev_id 2`ではreceiver 4へ分配する。
- 受信機へ分配するとき、出力TSのsync byteを`0x47`へ戻す。
- tune、stop、再openの境界で前回TSの端数とqueueを破棄する。
- queue overflow、bulk transfer failure、同期喪失をsilent dropにせず、統計と終了理由へ反映する。
- `px4-ts`のstdoutにはTS以外を書かず、診断はstderrへ出す。

### 4.5 Firmware

- `px4d --firmware PATH`を必須とする。
- 同じfirmwareを両方のIT9305Eへ必要に応じてloadする。
- v0.4で受理するIT930x firmware imageは、長さ2,169 byte、SHA-256
  `5213a5a38872661277a2cc1b2dfdfe88faf06f41205f460f3b51857f0568b484`の1種類だけとする。
- SHA-256はファイル全体に対して計算する。長さまたはhashが一致しないファイルは`FIRMWARE_REJECTED`で拒否し、
  未知imageを強制使用するoptionは設けない。
- 別imageを追加する場合は、実機で8 receiverとcard readerの受入試験を通し、本節へ長さ、SHA-256、由来を
  追記する仕様変更を先に行う。
- firmwareの探索、ダウンロード、archive展開、vendor driverからの抽出は行わない。
- git追跡対象、source archive、release artifactへfirmwareまたは元vendor driverを含めない。

## 5. IC card reader contract

### 5.1 Ownership and public interface

カードUARTとT=1 sessionは`px4d`が所有する。クライアントがT=1 sequence numberを保持しない。

portable IPCは以下を提供する。

- reader status
- card present/removed event
- ATR取得
- card reset
- APDU transmit
- transaction begin/end

複数clientからのAPDUは1つのカードsession上で直列化する。transaction中は他clientのAPDUを割り込ませない。
client切断、USB切断、カード抜去、timeout、protocol errorではtransactionとT=1 sessionを破棄する。

LinuxおよびmacOSではpcsc-lite/PCSC.framework向けIFD Handlerをportable IPCのadapterとして提供する。
初期Q3U4実機受入ではportable IPCと`px4ctl`による
ATR/APDU成功を必須とし、OS固有PC/SC adapterの完成は各OSのruntime supportを宣言する条件とする。
Androidではsystem PC/SCを前提とせず、portable IPCを利用する。

### 5.2 Hardware and power

- backend power stateは筐体全体の単純な1カウンタではなく、`dev_id 1`と`dev_id 2`ごとに保持する。
- 既定modeは`all`とし、どちらかのIT9305Eでreceiverが1つでもopenなら両IT9305Eのbackend powerを維持する。
- card openは`dev_id 1`だけをpower userにする。receiverが1つもopenでなければ`dev_id 2`まで通電させない。
- card open時は`dev_id 1`のpower requestを記録してから`it930x_bcas_init()`相当を行い、初期化失敗時は
  そのrequestをrollbackする。
- 各bridgeの最後のreceiverを閉じても、反対側のreceiverとの連動または`dev_id 1`のcard requestがあれば、
  必要なbackend powerを停止しない。
- LNB powerはbridgeごとのGPIO 11と参照数で管理し、そのbridge上で15Vを要求する最後のISDB-S receiverを
  閉じたときだけ0Vへ戻す。
- receiverごとに直前に成功したtuneのLNB要求を保持する。retuneでは新しい0V/15V要求をtune前に適用し、
  後続のtune処理が失敗した場合は直前の要求へ戻す。参照の追加・削除とGPIO遷移はbridge単位で直列化する。
- GPIO 11への書込みが成功応答なしで終わった場合、物理状態を推測して`off`または`on`と確定しない。
  `DISCONNECTED`以外は`unknown`とcleanup debtを記録し、参照が0になったclose、shutdown、reconcileで
  GPIO 11 lowを再試行する。`DISCONNECTED`となったbridgeには以後の電源操作を送らない。
- 片側USB切断で筐体を停止する場合、切断したbridgeには追加書込みを行わない。接続が残る反対側bridgeは、
  そのtransportを閉じる前にLNB参照を解放してGPIO 11 lowを試みる。失敗は成功扱いにしない。
- 通常の正常終了およびSIGINT、SIGTERM、SIGHUPの受信時は、USB transportを閉じる前に両bridgeのLNBを0Vへ戻す。SIGKILL、host crash、
  USB stack failureではcleanupを保証できないため、明示的なopt-inと再初期化時のGPIO 11 lowを安全境界とする。
- `px4-termux`のstage 0は、通常終了時およびSIGINT、SIGTERM、SIGHUPの受信時に、固定40秒の猶予を設けて子プロセスグループの終了を待つ。
  40秒後もグループが生存している場合のみSIGKILLを使用し、標準エラー出力へ警告を出力する。この強制終了経路では、graceful cleanup、
  LNB 0V、およびruntime endpoint削除を保証しない。

### 5.3 ATR and T=1

派生元のWinUSB実装にあった`SmartCard`状態機械を参照し、少なくとも以下を維持する。

- direct convention `0x3b`とinverse convention `0x3f`
- TA1 `0x11`、`0x12`、`0x13`
- TA3/IFSC、TB3/BWI、TC3/LRCまたはCRC
- TCK検証、ATR最大33 byte、余分なbyteの拒否
- UART frame上限255 byte
- LRC時INF上限251 byte、CRC時INF上限250 byte
- I-block chaining、R-block retry、S-block RESYNCH/IFS/WTX
- APDU全体の絶対期限3000ms
- block retry最大3回
- malformed ATRだけcard resetを1回再試行
- 失敗時にATR、IFSC、EDC、timeout、送受信sequenceを一括破棄
- 254-byte APDUをUART上限に合わせて分割

B-CASの実カードをQ3U4受入試験の対象とする。ACASは模擬試験を保持できるが、実機未確認なら対応済みと表現しない。

## 6. IPC contract

### 6.1 Transport and authorization

- transportは同一ホスト内のfilesystem Unix domain socketとし、TCP、abstract Unix socket、loopback networkへ
  fallbackしない。
- endpointは既定で`$XDG_RUNTIME_DIR/px4-userland/<instance>/`に作り、directoryを`0700`、socketを
  `0600`とする。明示したgroup共有modeだけdirectoryを`0750`、socketを`0660`にできる。
- control endpointとTS data endpointは分離し、control/card request、遅いTS client、別receiverのいずれも
  USB event loopまたは他receiverをblockしてはならない。

### 6.2 Common frame

全整数はlittle-endianとし、signed値は2の補数で表す。各frameは次の20-byte headerと
`payload_length` byteのpayloadを持つ。

| Offset | Type | Field | Contract |
|---:|---|---|---|
| 0 | `u8[4]` | magic | ASCII `PX4U` |
| 4 | `u16` | major | IPC protocol v1では`1` |
| 6 | `u16` | minor | IPC protocol v1では`0` |
| 8 | `u16` | type | 6.4節のmessage type |
| 10 | `u16` | flags | bit 0=response、bit 1=error、他は0 |
| 12 | `u32` | request_id | request/responseで同値、eventは0 |
| 16 | `u32` | payload_length | control最大65,536、TS_DATA最大1,048,596 |

- reserved flag、未知type、不正magic、上限超過、宣言長と実長の不一致はconnection単位の`PROTOCOL_ERROR`とし、
  そのconnectionを閉じる。allocation前に長さを検査する。
- pointer、`bool`、`size_t`、native enum、native struct padding、NUL終端前提の文字列をwireへ出さない。
- 文字列は`u16 byte_length`とその長さのUTF-8で表す。不正UTF-8と埋め込みNULを拒否する。
- responseはrequestと同じtype/request_idを持つ。error responseのpayloadは`u32 error_code`、
  `u16 detail_length`、UTF-8 detailとする。detailは診断用で、client分岐にはerror codeだけを使う。
- 1 control connectionで同時にoutstandingにできるrequestは1つとする。clientはconnectionを閉じてcancelできる。
  daemonは有限timeoutで処理を中止し、lease、transaction、card sessionを解放する。

### 6.3 Version, leases, and flow control

- 各connectionの最初のframeは`HELLO`または`ATTACH_STREAM`でなければならない。
- `HELLO` payloadは`u16 min_major, u16 min_minor, u16 max_major, u16 max_minor, u32 requested_capabilities`とする。
  互換majorがなければ`VERSION_MISMATCH`を返してcloseする。major 1ではserver minor以下の機能だけを使用する。
- `ACQUIRE`成功時、daemonは`u64 lease_id`と128-bit CSPRNG nonceを返す。leaseはcontrol connection、receiver、
  instanceに結び付け、再接続へ持ち越せない。
- `START_STREAM`成功後5秒以内にdata endpointへ接続し、`ATTACH_STREAM` payloadとしてlease IDとnonceを送る。
  期限切れ、再利用、別instanceのtokenは拒否する。
- receiverごとのTS queueは有限長とし、既定65,536 packet、設定可能範囲4,096..262,144 packetとする。
  queue満杯ではUSB callbackをblockせず、そのclientを`SLOW_CONSUMER`で終了する。dropして配信継続しない。
- `TS_DATA` payloadは`u64 sequence, u64 cumulative_drop_count, u32 byte_count, bytes[byte_count]`とし、
  `byte_count`は188の倍数かつ1,048,576以下とする。正常streamではdrop countは常に0、sequenceはframeごとに1増える。

### 6.4 Message types and payloads

| Type | Name | Request payload | Success payload |
|---:|---|---|---|
| `0x0001` | `HELLO` | 6.3節 | `u16 major, u16 minor, u32 capabilities` |
| `0x0010` | `LIST` | empty | 4.1/4.2の固定情報 |
| `0x0011` | `STATUS` | empty | ready、USB/card presence、8 receiver state、error counters |
| `0x0020` | `ACQUIRE` | `u8 receiver_id` | `u64 lease_id, u8 nonce[16]` |
| `0x0021` | `RELEASE` | `u64 lease_id` | empty |
| `0x0022` | `TUNE` | `u64 lease_id, u8 system, u64 frequency_khz, u16 stream_id, u16 slot, u32 bandwidth_hz, u8 lnb_voltage, u32 timeout_ms` | lock stateとC/N |
| `0x0023` | `START_STREAM` | `u64 lease_id` | empty |
| `0x0024` | `STOP_STREAM` | `u64 lease_id` | final counters |
| `0x0025` | `STATS` | `u64 lease_id` | packet、byte、sync、TEI、continuity、queue、USB counters |
| `0x0030` | `CARD_STATUS` | empty | present、initialized、ATR、reader generation |
| `0x0031` | `CARD_CONNECT` | `u8 share_mode` | `u64 card_handle, u8 atr_length, atr[]` |
| `0x0032` | `CARD_RECONNECT` | `u64 card_handle, u8 share_mode, u8 disposition` | `u8 atr_length, atr[]` |
| `0x0033` | `CARD_DISCONNECT` | `u64 card_handle, u8 disposition` | empty |
| `0x0034` | `CARD_RESET` | `u64 card_handle` | ATR |
| `0x0035` | `CARD_TRANSMIT` | `u64 card_handle, u32 length, bytes[length]` | `u32 length, bytes[length]` |
| `0x0036` | `BEGIN_TRANSACTION` | `u64 card_handle` | empty |
| `0x0037` | `END_TRANSACTION` | `u64 card_handle, u8 disposition` | empty |
| `0x0040` | `ATTACH_STREAM` | `u64 lease_id, u8 nonce[16]` | empty、その後serverからTS_DATA |
| `0x8040` | `TS_DATA` | server event only | 6.3節 |
| `0x80f0` | `DEVICE_EVENT` | server event only | generation、event kind、affected receiver/card |
| `0x80ff` | `STREAM_END` | server event only | final countersと`u32 error_code` |

- `system`は1=`ISDB_T`、2=`ISDB_S`、`lnb_voltage`は0または15、未使用のstream ID/slotは`0xffff`とする。
- tune timeoutは100..30,000msとし、CLI既定値は10,000msとする。範囲外をclampせず`INVALID_ARGUMENT`で拒否する。
- CARD_TRANSMITのrequest/response上限は各4,096 byteとし、APDU全体の期限は5.3節の3,000msを超えない。
- event subscriptionはHELLO capabilitiesの`EVENTS` bitを要求したconnectionだけに行う。eventはresponseの途中へ
  byte単位で割り込まず、frame単位でのみ挿入できる。

capability bitはbit 0=`EVENTS`、bit 1=`CARD`、bit 2=`STREAM_STATS`とし、未知bitは無視する。
HELLO responseのcapabilitiesはrequestとserver対応bitの積集合とする。
可変配列は先頭に`u16 count`、可変byte列は先頭に`u32 length`を置く。ATRだけは上限33なので`u8 length`とする。
各recordは次の固定layoutとし、field追加または意味変更はprotocol minor更新を要する。

- `LIST` success: `u64 generation, u16 serial_length, serial_utf8, u8 ready, u8 usb_present_mask,
  u8 receiver_count, u8 card_reader_count`に続き、receiver count個の
  `u8 global_id, u8 dev_id, u8 local_id, u8 system`。v1ではcountは8、card reader countは1。
- `STATUS` success: `u64 generation, u8 ready, u8 usb_present_mask, u8 card_present,
  u8 card_initialized`、8個の`u8 receiver_state`、続いて`u64 usb_errors, u64 protocol_errors`。
  receiver stateは0=free、1=leased、2=tuned、3=streaming、4=error。
- `TUNE` success: `u8 locked, i32 cnr_mdb`。C/N不明は`INT32_MIN`。
- `STATS`およびfinal counters: 順に`u64 packets, bytes, sync_errors, tei_packets,
  continuity_errors, queue_drops, usb_errors, empty_intervals`。
  `empty_intervals`はstream pumpがUSB完了を待った際のTIMEOUTまたは長さ0のcompletion回数であり、burst転送の
  正常動作中にも増加し得るbridge単位の診断値とする。同一bridgeのactive receiverへ同じ増分が反映されるため、
  receiver別starvationの判定には使用しない。非zeroであることだけをTS integrity failureにせず、受入ではpacket/byteの
  進行と、sync/TEI/continuity/queue/USB counterを別に判定する。この明確化はwire semanticsの変更ではなく、
  protocol minorを更新しない。
- `CARD_STATUS` success: `u8 present, u8 initialized, u64 reader_generation, u8 atr_length,
  atr[atr_length]`。未初期化時のATR lengthは0。
- `CARD_RESET` success: `u8 atr_length, atr[atr_length]`。
- `DEVICE_EVENT`: `u64 generation, u8 kind, u8 target_type, u8 target_id`。kindは1=attached、
  2=detached、3=card_inserted、4=card_removed、5=state_changed。target typeは1=device、2=receiver、3=card。
- `STREAM_END`: final countersの後に`u32 error_code`。

`LIST`/`STATUS`のreserved countやmask、ATR上限、receiver ID、enum範囲を受信側で検証する。上記layoutから
golden byte vectorを作り、異なる言語でencode/decodeしたvectorの一致をprotocol v1の受入条件とする。

card handleは作成したcontrol connectionに結び付ける。share modeは1=shared、2=exclusive、dispositionは
0=leave、1=resetとする。異常切断は全handleとtransactionを解放し、最後のhandle解放時だけcard hardwareをcloseする。
exclusive handleがある間は他のconnectを`BUSY`にし、transaction中は同じhandle以外のAPDUを`BUSY`にする。

### 6.5 Error and CLI contract

固定error codeは、0=`OK`、1=`INVALID_ARGUMENT`、2=`VERSION_MISMATCH`、3=`NOT_FOUND`、4=`BUSY`、
5=`NOT_READY`、6=`TIMEOUT`、7=`USB_IO`、8=`DISCONNECTED`、9=`PROTOCOL_ERROR`、10=`FIRMWARE_REJECTED`、
11=`UNSUPPORTED`、12=`NO_CARD`、13=`CARD_REMOVED`、14=`BUFFER_TOO_SMALL`、15=`SLOW_CONSUMER`、
255=`INTERNAL`とする。Linuxの負errnoを公開しない。

CLI exit codeは0=success、2=usage、3=not found/not ready、4=busy、5=timeout、6=IPC version/protocol、
7=USB/disconnect、8=TS integrity/backpressure、9=card/protocol、10=firmware、70=internalとする。
`px4-ts`は要求されたduration/packet countへの到達または明示的な正常stopだけを0とし、daemon切断、USB抜去、
queue overflow、sync/TEI/drop検出を0にしない。stdoutはTSだけ、全診断はstderrへ出す。

## 7. Portability contract

### 7.1 Common requirements

- portable coreはC++17/C11、libusb-1.0、標準固定幅整数だけを前提とする。
- `_GNU_SOURCE`、glibc内部symbol、`eventfd`、`signalfd`、`epoll`、GNU `getopt_long`をportable coreで使用しない。
- Linux固有最適化は任意のplatform adapterとし、機能成立の条件にしない。
- wall clockをtimeoutへ使わず、単調時計を使う。
- path、IPC endpoint、USB serialを固定長bufferへ無検証で格納しない。

### 7.2 Android/Bionic

- `px4d`は`--fd FD`を繰り返し受け取り、Q3U4の2 USB deviceをwrapできる。
- fd modeでは`/dev/bus/usb`の列挙を要求しない。
- fdの所有権とclose責任を明記し、double-closeしない。
- Android NDK API 24でaarch64、armv7a、x86_64をクロスビルドし、3つのABIを同一の配布・監査対象とする。
- ELF interpreterはBionic linker、libusbはstatic link、host RPATH/RUNPATHは空とする。
- Termux試験では正式ランチャー `px4-termux` が `termux-usb` から開いた2つのfdを渡し、通常のCLI/IPC経路を使用する。
- `px4-termux --usb-device PATH --usb-device PATH --firmware PATH [--device BASE_SERIAL] [--runtime-dir PATH] [--group] [--allow-lnb-power]`
  を提供する。利用者は異なる2つのデバイスパスを明示し、自動選択は行わない。ランチャーの実行時依存はTermux付属のsh、
  Termux:APIの `termux-usb`、およびtermux-apiパッケージの依存関係として提供される `util-linux` の `setsid` のみとし、
  Python、補助デーモン、eval、一時状態ファイルを要求しない。
- stage 0の `px4-termux` は監督プロセスとして残り、`setsid termux-usb -e CALLBACK USB1` を子プロセスとして起動して
  `wait` する。起動時に `setsid` と `termux-usb` の存在を明示検査する。stage 1は受領した1つ目のFDを保持したまま
  `exec termux-usb -e CALLBACK USB2` を実行し、stage 2は2つ目のFDを受け取って `exec px4d --fd FD1 --fd FD2 ...` を実行する。
  渡される2つのFDは互いに異なり、かつオープン中でなければならない。通常の正常終了および第2open失敗の終了ステータス（status）は
  そのまま伝播する。stage 0は `SIGINT`、`SIGTERM`、`SIGHUP` を受信すると子プロセスグループ全体へシグナルを転送して
  回収（reap）し、固定40秒の猶予内にグループの消滅を確認してから終了する。40秒の猶予内に終了しない場合のみSIGKILLを使用し、
  標準エラー出力へ graceful cleanup、LNB 0V、およびruntime endpoint削除を保証できない旨を警告する。第2open失敗、シグナル受信、
  USB切断のいずれにおいても有限時間で終了する。ランチャーは利用者が指定したruntime rootを自動で再帰削除しない。
- APK試験ではAndroid USB Host APIでQ3U4の両deviceへpermissionを取得し、detachしないfdをnative側へ渡す。
- ad-hoc APKはUSB permission、2 fdの対応付け、8 receiver、card APDU、detach/reconnectを検証できればよく、
  製品UI、自動更新、配布署名、ストア公開を要件にしない。APKはrelease artifactへ含めない。

### 7.3 Linux/macOS native linkage

- Linux production executableはlibusb 1.0.30を静的包含したmusl完全静的ELFとし、`readelf -l`のPT_INTERPと
  `readelf -d`のDT_NEEDEDを持たないことを検証する。IFD Handlerだけはhost-loadable shared objectとし、
  glibc archiveはglibc 2.31 baseline、musl archiveはmatching musl ABIでビルドする。
  macOS Mach-Oは`otool -L`でhost-provided dynamic libusbを検証し、各出力をrelease evidenceへ保存する。
  staticになっていたbinaryはdynamic releaseとして出さない。
- libusb、pcsc-lite、その他のhost dependencyをstaticまたはbundleした場合は、Androidと同等のexact source、license、
  notice、build/relink obligationsへ切り替える。

### 7.4 macOS

- libusbで列挙・claimできることを前提とし、DriverKit/kextを要求しない。
- hardware未確認の場合はrelease metadataへ明記する。

## 8. Repository end state

最終ツリーには、少なくとも以下だけを残す。

- portable sourceとplatform adapter
- Q3U4 device definition
- CLI source
- unit/integration/hardware test tools
- CMake、CI、license、README、仕様・検証記録

v0.5のscope cleanupでは旧Windows専用source、build、package、試験記録とfirmware extraction projectを削除した。
参照由来は9節に残し、削除したsourceはdirect sourceの`tsukumijima/px4_drv` snapshot commit
`9eedea8c502875a788697984b93b50032339b9aa`から復元できる。

以下はv0.5で削除済みであり、repository end stateに含めない。

- Linux kernel module、chardev、ioctl ABI、DKMS、Debian DKMS package
- tracked firmware、firmwareを含むpackage素材
- Q3U4以外のdevice implementationとpackage definition
- 旧px4_drvの導入文書、kernel build文書、非対象機種の利用文書

## 9. Prior-art classification

| Candidate | Classification | Use |
|---|---|---|
| `tsukumijima/px4_drv` Linux kernel driver | adapt/reference | Q3U4初期化、tune、TS、電源、エラー契約 |
| 同WinUSB `DriverHost_PX4` | adapt/reference (primary) | 既存userland USB、複数receiver、device ownership |
| 同`SmartCard` / `WinSCard_PX4` | adapt/reference (primary) | ATR、T=1、APDU、共有、実機試験 |
| `makeding/linux-with-card-reader`等 | reference | Q3U4 card GPIO/UART、Linux実機知見 |
| `siano-userland` | adapt/reference | libusb-only CLI、musl/Bionic、Android fd、CI |

公開GitHubとローカル調査では、Q3U4の8チューナーと内蔵カードをlibusb-onlyで所有し、
Linux・Android・macOSを対象にする既存実装は確認できなかった。このため本体はbuildと分類する。

## 10. Acceptance criteria

### 10.1 Offline and CI

1. `cmake -S . -B build -G Ninja -DPX4_BUILD_TESTS=ON`が成功する。
2. `cmake --build build`がwarningをerrorとして扱う設定で成功する。
3. `ctest --test-dir build --output-on-failure`が成功する。
4. Ubuntu/glibc、Alpine/musl、macOSでbuildとoffline testsが成功する。
5. Android NDK API 24の3 ABI build/ELF/artifact audit、`px4-termux`の構文およびプロセス・FD引き継ぎ試験が成功する。
6. Android ELFにglibc/musl loader、shared libusb、host RPATH/RUNPATHが含まれない。
7. mock USBによるQ3U4 grouping、firmware framing、I2C、tune sequence、bridge別TS demux、hotplug試験が成功する。
8. `smart_card_state_test`相当のATR、T=1、timeout、retry、APDU分割、抜去、再挿入試験が成功する。
9. IPCの全messageについてgolden byte vector、malformed frame、version negotiation、権限、異常切断、
   slow-consumer/backpressure、CLI exit code試験が成功する。
10. stream counter試験で、正常TS中に`empty_intervals`だけが非zeroでも成功し、他のerror counterが0でも
    packet/byteの進行が5秒停止した場合は失敗する。
11. fuzzまたは境界値試験でUSB response lengthとIPC payload lengthの範囲外アクセスがない。
12. `git ls-files`にfirmware binary、vendor driver binary、kernel module、DKMS、非Q3U4 device packageが残らない。
13. 全派生source fileに`SPDX-License-Identifier: GPL-2.0-only`を付け、LICENSEがGPL-2.0を示す。

### 10.2 Q3U4 hardware acceptance on Linux

1. `px4ctl list`が2 USB deviceを1筐体へまとめ、8 receiverと1 card readerを報告する。
2. firmwareを両IT9305Eへloadし、再openとプロセス再起動後も初期化できる。
3. receiver 0..7を各々open、tune、30秒capture、stop、再openできる。
4. 両bridgeへそれぞれ`0x17`..`0x47`を注入するmockと実受信で、dev_id 1をreceiver 0..3、dev_id 2を
   receiver 4..7へ分配し、bridgeを跨いだ混入がない。
5. 8 receiverを同時に30分captureできる。
6. tune完了後の測定区間で各streamを1秒以下の間隔で観測し、任意の連続5秒窓の中でpacketとbyteの両方が
   増加する。counterは単調非減少で、常に`bytes == packets * 188`を満たす。receiver 0--6ではsync error、
   TEI、queue drop、USB errorが0である。receiver 7の既知burstは10.2.6aの参照比較を適用する。
   `empty_intervals`は6.4節の診断値として記録するが、非zeroだけでは失敗としない。
7. continuity errorはdiscontinuity indicatorとtune境界を除外して計数する。receiver 0--6では測定区間で0とし、
   receiver 7の既知burstは10.2.6aの参照比較を適用する。
8. 1 receiverの停止または再tuneが、他receiverのTSを停止・混入させない。
9. receiverを片側だけ、両側、cardだけ、receiver+cardの順にopen/closeし、5.2節のbridge別power stateを満たす。
10. `--allow-lnb-power`なしでは15V要求をGPIO書込みなしで拒否する。opt-in時はLNB 0V/15Vとbridgeごとの
    複数ISDB-S receiverの参照数が正しく、最後の利用者のcloseでだけ停止する。GPIO応答喪失、通常終了、
    SIGINT、SIGTERM、SIGHUP、片側USB切断のcleanup規則は5.2節を満たす。
11. card未挿入、挿入、ATR、reset、基本APDU、抜去、再挿入が成功する。
12. 外付け標準readerで同じB-CASを使ったAPDU responseと、Q3U4内蔵readerのresponseが一致する。
13. 8 receiverの同時capture中にcard APDUを反復し、APDU failureが0である。TS error/dropはreceiver 0--6で0とし、
    receiver 7の既知burstは10.2.6aの参照比較を適用する。
14. card利用中にtunerをすべて閉じてもcard通信を継続し、tuner利用中にcardを閉じてもTSを継続する。
15. idle、streaming、card transaction中のUSB切断が有限時間で失敗を返し、hangまたはuse-after-freeを起こさない。
16. 再接続後に旧lease、ATR、T=1 sequence、TS端数を再利用せず、再列挙・再初期化できる。
17. Stable候補はSCS native（Debian 13/glibc、HAOS kernel）とHAOS Alpine/musl Supervisor add-onの両方で、
    それぞれ2時間、8 receiver、反復APDU、定期的なretune/stop/reopenを含むsoak testを行い、crash、stale lease、
    APDU failure、RSSまたはhandle数の増加傾向を生じない。両環境は相互に代替しない。TS errorはreceiver 0--6で0とし、
    receiver 7の既知burstは10.2.6aの参照比較を適用する。
18. Stable候補はLatitude native Linux x86_64、SCS native、HAOS Alpine add-on、macOS、Android Termux、Android ad-hoc APKの
    各対象環境で30分以上の試験を行う。各環境で地上波・衛星capture、stop/reopen、USB detach/reconnect、Q3U4内蔵
    カード経路の反復APDUを確認する。SCS nativeとHAOS Alpine add-onは別々に完了させる。Linux aarch64は実機未検証のため対象外とする。
19. 壁設備と完全に分離した開放端で0V、15V、cleanup後0Vを測定し、GPIO 11の極性と切替を確認する。
    この無負荷試験をもってLNB切替をhardware-verifiedとするが、代表負荷時の給電能力は未確認として
    `LNB switching hardware-verified / loaded supply unverified`と記録する。これはStableのブロッカーではない。

### 10.2.6a receiver 7 reference comparison

receiver 7でTEIまたはcontinuity errorのburstが発生した場合、同一Q3U4個体、同一アンテナ・電源・firmware、
同一周波数、同一測定時間および同等のcapture条件で`tsukumijima/px4_drv`を実行し、同じcounterを取得する。
px4-userlandのburstが参照結果より悪化せず、追加のUSB error、queue drop、stream停止、crash、stale leaseを
生じない場合、そのburstは既知制限として記録し、Stable受入のブロッカーにしない。比較条件を再現できない場合は
判定保留とし、receiver 7を無条件に合格扱いしない。

`v0.1.0 Beta`では、receiver 0--6は2時間soakでerror 0だった。receiver 7はTEI `10974`、
`continuity_errors=453`を記録した。同一試験個体では、参照`tsukumijima/px4_drv`でも約11k TEIの署名が再現した。
この結果は10.2.6aの既知制限の初期証拠として扱うが、Stable候補では同一条件の比較記録を改めて保存する。
`px4-ts`はTS integrity errorをCLI exit code 8で報告する。

### 10.3 Cross-platform support claims

support表示は機能軸を混ぜず、OSごとに次の4列を持つ。

- `build-tested`: buildとoffline testsだけが成功。
- `tuner-hardware-verified`: 実機でgrouping、firmware、ISDB-T/S capture、stop/reopen、disconnect/reconnectが成功。
- `card-core-hardware-verified`: portable IPCでATR、reset、反復APDU、抜去/再挿入が成功。
- `native-card-adapter-verified`: Linux/macOSでは実PC/SC consumerからresetと反復APDUが成功。
  Androidはこの列を`not applicable`とする。

OS全体を`runtime-supported`と表記するには、上記の該当列を満たし、8 receiver同時stream中にnative card adapter
（Androidはportable IPC client）から反復APDUを行って、10.2.6aを適用したTS受入条件とcard error条件を満たさなければ
ならない。

`tuner-hardware-verified`には2 USB deviceのgrouping、firmware load、ISDB-T 1 receiverとISDB-S 1 receiverの
capture、stop/reopen、USB disconnect/reconnectを要する。`card-core-hardware-verified`にはATR、reset、反復APDU、
card抜去/再挿入、USB disconnect/reconnectを要する。buildとoffline testだけの場合は
`build-tested / hardware-unverified`と表記する。

v0.4実機試験の割当は次のとおりとする。

| Test path | Required evidence |
|---|---|
| Latitude 5300 / AnduinOS (x86_64) native | T/S capture、8 receiver、内蔵card経路、USB detach/reconnect、30分以上、実PC/SC consumer |
| Linux aarch64 / GitHub Actions | native build、offline test、archive audit、実機未検証 |
| M720q / SCS native Debian 13/glibc + HAOS kernel | T/S capture、8 receiver、内蔵card経路、USB detach/reconnect、2時間soak |
| M720q / HAOS Alpine/musl Supervisor add-on | T/S capture、8 receiver、内蔵card経路、USB detach/reconnect、2時間soak |
| Latitude 5300 / Alpine Docker | auxiliary build/parser smoke only; SCS、HAOS add-on、Latitude nativeの代替不可 |
| Pixel 9a / aarch64 / Termux | 最終候補archiveの正式launcherで2 fd、T/S capture、内蔵card経路、stop/reopen、USB detach/reconnect、30分以上、process/FD/endpoint非残留、即時再起動 |
| Google TV Streamer / armv7a / Termux | 最終候補archiveの正式launcherで2 fd、T/S capture、内蔵card経路、stop/reopen、USB detach/reconnect、30分以上、process/FD/endpoint非残留、即時再起動 |
| Bliss OS / x86_64 / Termux | 最終候補archiveの正式launcherで2 fd、T/S capture、内蔵card経路、stop/reopen、USB detach/reconnect、30分以上、process/FD/endpoint非残留、即時再起動 |
| Google TV Streamer / ad-hoc APK | armv7a、USB permission、2 fd wrap、T/S capture、内蔵card経路、stop/reopen、USB detach/reconnect、30分以上 |
| M2 Mac mini / macOS | grouping、T/S capture、内蔵card経路、実PC/SC consumer、USB detach/reconnect、30分以上 |

TermuxとAPKは同一ハードウェアでも別runtime経路として個別に合否を記録する。SCS native、HAOS Alpine add-on、
Latitude native、Latitude Alpine Dockerは別runtime経路であり、いずれも他の要件を代替しない。

### 10.4 Release artifacts

最終配布物のplatform/architectureは次の8 binary archiveとする。source archiveは全binaryに共通で1つ作成する。

| Artifact | Runtime contract |
|---|---|
| `px4-userland-<version>-linux-glibc-x86_64.tar.gz` | x86_64 Linux、glibc 2.31 IFD |
| `px4-userland-<version>-linux-musl-x86_64.tar.gz` | x86_64 Linux、musl IFD |
| `px4-userland-<version>-linux-glibc-aarch64.tar.gz` | aarch64 Linux、glibc 2.31 IFD、実機未検証 |
| `px4-userland-<version>-linux-musl-aarch64.tar.gz` | aarch64 Linux、musl IFD、実機未検証 |
| `px4-userland-<version>-darwin-arm64.tar.gz` | Apple Silicon macOS |
| `px4-userland-<version>-android-aarch64.tar.gz` | Android API 24+、Bionic aarch64、Termux用 |
| `px4-userland-<version>-android-armv7a.tar.gz` | Android API 24+、Bionic armv7a、Termux/Google TV用 |
| `px4-userland-<version>-android-x86_64.tar.gz` | Android API 24+、Bionic x86_64、Termux/Bliss OS用 |

各archiveは該当platformの`px4d`、`px4-ts`、`px4ctl`、利用可能なnative card adapter、GPL license、READMEを含む。
Android archiveは既存の3つのELFに加え、libusbをリンクしないシェルランチャー `px4-termux` を含む。既存3 ELFの
inventory、LGPL、NDK、corresponding-source、relink監査は弱めない。ランチャーはELF/static-link inventoryの
対象外であることを監査上明示する。
Linuxの3実行ファイルはlibusb 1.0.30を静的包含したmusl完全静的ELFとし、IFDだけがarchive名のhost libcに依存する。
Android版libusbはstatic linkとし、macOSはhost-provided dynamic dependencyを意図する。firmware、APK、HAOS add-on、
mirakcはどのrelease artifactにも含めない。
source archiveは `__pycache__/`、`.pyc`、`.pyo`、`.pyd` などのPythonバイトコードを含めない。

Android binary release gateは次の全項目を満たすまで未完成とする。

1. 各Android binary archiveのrootにGPL license (`LICENSE`)、libusb LGPL license/COPYING、static libusb 1.0.30と
   NDK runtimeを明示するprominent plain-text notice、`THIRD_PARTY_NOTICES.md`、`README.md`を含める。
2. 同じGitHub Release pageにcorresponding-source archiveをbinary archiveと同行させ、exact px4-userland source、
   binaryに使ったexact libusb source、各sourceの検証hash、build/relink instructionsを含める。GitHub自動source
   archiveだけでは、downloaded libusb sourceがないためこの要件を満たさない。
3. Android static libusbはLGPL-2.1-or-laterのままとし、LGPL-2.1 §6(d) routeで、同じ場所から§6(a)のsource-and-relink
   materialsへアクセスできるようにする。完全なGPL-2.0-only px4-userland sourceから再ビルドできるため、application
   `.o`をrelinkable deliverableとして別途必須とはしない。
   libusbをLGPL §3によりGPL化したとは主張しない。
4. NDK r27の`libc++_static`/`libc++abi`について、Apache-2.0 WITH LLVM-exceptionのterms、`NOTICE`、
   `NOTICE.toolchain`をreleaseへ含め、実際にlinkされたarchive member inventoryをartifactごとに保存する。
5. Linux production executableは`readelf -l`でPT_INTERPなし、`readelf -d`でDT_NEEDEDなしを検証する。Linux IFDは
   archive名に対応するglibc 2.31またはmuslのshared objectとして監査し、macOS binaryは`otool -L`でdynamic libusbを検証する。
6. Linux static libusbのexact source、license text、notice、build/relink instructionsは対応source archiveへ含める。

このgateの包装・manifest・checksum・binary/source archive auditは、local packaging scriptsと
`.github/workflows/build_userland.yml`の`release-candidate` workflowとして実装済みである。workflowはtagや
GitHub Releaseを作成せず、8つのbinary archive、対応source archive、外側`SHA256SUMS`をcandidate artifactとして
まとめる。Stable公開時は、このcandidateで使用した最終配布archiveそのものを各対象環境で試験する。Android 3 ABIは
正式ランチャーを各対象実機で検証するまで配布条件未達とする。Linux aarch64はarchive auditとnative CI buildを必須と
するが、実機未検証を既知の非ブロッカーとして公開時に明記する。

### 10.5 Stable release gate

Stable公開前に、次の条件をすべて満たすこと。

1. 10.1のCI、静的監査、archive manifest、checksum、licenseおよびcorresponding-source監査が成功している。
2. 10.2のHAOS 2時間soakと10.3の実機検証対象環境での30分以上の試験を、公開する最終配布archiveそのもので完了している。
3. 地上波・衛星、USB detach/reconnect、stop/reopen、Q3U4内蔵カード経路および反復APDUの証拠を、環境ごとに保存している。
4. receiver 7の既知burstは10.2.6aの比較結果を添付し、LNBは`LNB switching hardware-verified / loaded supply unverified`
   と明記している。
5. crash、hang、use-after-free、stale lease、再接続不能、カード経路の重大な未解決issueがない。receiver 7の参照一致
   burstおよび代表負荷未検証のLNBは、この項の重大な未解決issueには含めない。
6. 公開前レビューを実施し、README、LICENSE、THIRD_PARTY_NOTICES、provenance、checksum、support表示および
   release archiveの内容が一致している。
7. Linux aarch64はnative CI build、offline test、musl/ELF/IFD/archive監査を満たしている。実機未検証は既知の
   非ブロッカーとしてsupport表示とrelease notesに明記し、実機検証済みとは表現しない。

## 11. Implementation increments

1. Portable build、error、logging、mock transport、CIを作る。
2. libusb transport、通常列挙、Android repeated-fd wrap、Q3U4 groupingを作る。
3. firmware providerとIT930x control/I2Cを移植し、実機で初期化する。
4. TC90522/R850/RT710、1 receiver tune、TS captureを移植する。
5. 1 IT9305E上の4 receiver同時処理、TS aggregation/demuxを完成する。
6. 2 IT9305E、8 receiver、bridge間連動電源を完成する。
7. card hardware transportとportable ATR/T=1 state machineを完成する。
8. local IPC、`px4d`、`px4-ts`、`px4ctl`を完成する。
9. Linux/macOSのPC/SC adapterを接続し、確認できたOSだけsupport表記を更新する。
10. portable replacementごとにlegacy codeを削除し、READMEとrelease metadataをQ3U4-onlyへ更新する。

各incrementは対応するoffline testまたは実機観測がgreenになるまで次へ進めない。

## 12. Constraints and rollback

- firmware、USB dump、カード情報、秘密情報をcommitしない。
- 実機試験は既存PX-S1UD/mirakc/EPGStationの稼働経路を変更しない隔離コマンドで行う。
- HA Core、アドオン、mirakcを自動で再起動しない。
- 既存テストを変更して失敗を隠さない。

実装失敗時は、作業branchを破棄せず失敗証拠を保存し、直前のgreen commitへ戻す。
削除したlegacy sourceは、direct sourceの`tsukumijima/px4_drv` snapshot commit
`9eedea8c502875a788697984b93b50032339b9aa`から復元できる。
