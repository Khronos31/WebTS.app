# WebTS.app プロジェクト計画

## 1. 目的

PX-S1UD または PX-Q3U4 を利用者の端末へ直接接続し、WebUSB 対応ブラウザだけで
ISDB のライブ放送を視聴できる静的 Web アプリケーションを作る。放送TS、カード通信、
復号処理および映像・音声処理を公開クラウドへ送信しない。

## 2. 今回のブートストラップ受け入れ条件

1. `gh repo view Khronos31/WebTS.app --json visibility` が `PRIVATE` を返す。
2. ローカル clone の `origin` が `git@github.com:Khronos31/WebTS.app.git` である。
3. 本文書に目的、非目標、制約、ロールバック、prior art、段階別の検証条件がある。
4. ルートに `GPL-2.0-only` の全文と第三者ライセンス方針がある。
5. 初期コミットにファームウェア、放送キャプチャ、カード情報、実行バイナリが含まれない。
6. `git diff --check` が終了コード 0 で終わる。

## 3. 非目標

- 録画、予約、番組表
- サーバー側のチューナー制御、B25復号、トランスコード
- Firefox、Safari を初期対応ブラウザとして扱うこと
- PX-S1UD、PX-Q3U4 以外のチューナー対応
- B-CAS、放送規格、ファームウェアの制限を迂回すること

## 4. 制約

- WebUSB は HTTPS の secure context と利用者の明示操作を必要とする。
- WebUSB は全主要ブラウザ共通の機能ではないため、初期対象を Chromium 系に限定する。
- OS のドライバが対象インターフェイスを占有している場合は WebUSB から利用できない。
- 標準 CCID スマートカードインターフェイスは WebUSB の保護対象であり、初期カード経路にはしない。
- PX-Q3U4 の内蔵カードリーダーはチューナーと同じデバイスを扱うアダプタから制御する。
- PX-S1UD 単体にはカードリーダーがない。ライブ復号に使うカード提供元は別途決定する。
- 公開リポジトリ化、Pagesデプロイ、`webts.app` のDNS変更は、それぞれ明示的なゲートを通す。

## 5. ロールバック

ブートストラップ段階では公開物を作らない。失敗時はリモートをprivateのままarchiveし、
ローカル clone は利用者の明示承認後に退避または削除する。public化後はforkやキャッシュを
回収できないため、公開ゲート前に履歴全体を検査する。

## 6. Prior art と採否

| 対象 | 分類 | 理由 |
|---|---|---|
| libusb 1.0.30 Emscripten/WebUSB backend | adopt | libusb公式実装。既存ドライバのAPIを保ったままWASM化を試せる |
| Khronos31/siano-userland | adapt | PX-S1UDの選局・TS取得実装。POSIX CLI部分とブラウザ寿命管理は分離が必要 |
| Khronos31/px4-userland | adapt | PX-Q3U4のコア、Transport抽象、内蔵カード処理を再利用できる |
| shirow-github/libaribb25 0.2.10 | adapt | ISCでGPL-2.0互換。PC/SC実装を外しカードアダプタを差し替える必要がある |
| stz2012 / tsukumijima libaribb25 | reference | Apache-2.0のためGPL-2.0-only成果物へ組み込まない |
| recisdb-rs | reference | ネイティブ動作の比較対象。GPLv3かつPC/SC前提なのでランタイム依存にしない |
| mirakc / EPGStation / KonomiTV | reference | TS処理やブラウザ再生の挙動を参照するが、クライアント直結WebUSB実装ではない |

既存のブラウザ完結ISDBチューナー実装は採用候補として確認できていないため、アプリ層と
デバイスアダプタ層は新規に構築する。

## 7. アーキテクチャ方針

```text
UI / session controller (TypeScript)
                |
                v
Dedicated Worker: bounded streaming pipeline
    |                 |                  |
    v                 v                  v
tuner adapter     card provider      descrambler
(WASM/libusb)     (PX4 internal)     (ISC aribb25/WASM)
    |
    v
demux -> video/audio decoder -> renderer/audio output
```

### 7.1 USB

- libusb 1.0.30 の Emscripten/WebUSB backend を固定して最初に検証する。
- JavaScript は利用者操作に伴う `requestDevice()` と権限状態を管理する。
- ドライバ固有処理はWASM側に残し、WebUSBを模した独自libusb互換層は作らない。
- libusb公式backendで成立しない機能が判明した場合だけ、差分を記録して代替へ進む。

### 7.2 デバイス境界

- UIは機種固有USB endpointや制御コマンドを知らない。
- `TunerAdapter` は open、firmware、tune、start、stop、close、状態通知を非同期契約として持つ。
- PX-S1UD と PX-Q3U4 の列挙、再列挙、切断、終了処理は別アダプタへ閉じ込める。
- PX-Q3U4のカード通信は同じデバイス所有者を経由し、別WorkerからUSB handleを共有しない。

### 7.3 ストリーム

- USB読み込み、復号、demux、decodeの間は上限付きqueueにする。
- queue上限到達時の挙動を明示し、暗黙のメモリ増加を許さない。
- コピー回数、転送量、continuity error、queue深度、drop、メモリを計測可能にする。

### 7.4 B25

- ISC系 `libaribb25` のTS解析とMULTI2部分をWASM化する。
- PC/SC依存の `b_cas_card.c` は組み込まない。
- WebUSBの非同期I/Oと同期的な `proc_ecm()` の境界は、M2でJSPI、Asyncify、明示状態機械を比較する。
- EMM処理は初期状態で無効とする。

### 7.5 ホスティング

Cloudflare Pagesを第一候補とする。Worker、WASM、将来のSharedArrayBuffer利用に必要となり得る
COOP/COEP等のレスポンスヘッダをリポジトリ内で管理できるためである。GitHub Pagesはソースと
開発履歴の置き場として利用するが、配信先の最終決定はM1後とする。

## 8. 段階と検証条件

### M0: WebUSB適合性

対象コードは最小のデバイスプローブに限定する。チューナー制御や再生UIを作らない。

- 利用者操作からPX-S1UDとPX-Q3U4を個別に選択できる。
- descriptor取得、open、configuration選択、interface claim/release、closeを確認する。
- 切断と再接続を状態遷移として記録する。
- PX-S1UDのファームウェア前後の再列挙と権限挙動を記録する。
- 対象OS、ブラウザの正確なバージョン、必要なドライバbindingを互換表へ記録する。

### M1: 生TSの持続取得

- 同一の`TunerAdapter`契約でPX-S1UDとPX-Q3U4を動かす。
- 各機種で1チューナー、30分以上の連続取得を行う。
- app側USB transfer errorとbuffer overrunが0件である。
- queue使用量が設定上限内に留まり、開始5分後から終了までのメモリ増加が64MiB以下である。
- 切断時に無限再試行せず停止し、再接続後に新しいsessionとして開始できる。
- 放送キャプチャ自体は保存せず、統計だけを保存する。

### M2: B25とカード経路

- PX-Q3U4内蔵カードの初期化とECM処理をブラウザ内で完結する。
- カード番号、カード応答、鍵をログ・永続ストレージ・telemetryへ出さない。
- 復号後TSのscrambling controlとcontinuityを検査する。
- PX-S1UDで利用するカード提供元を決定し、同じ`CardProvider`契約で検証する。

### M3: ライブ再生

- MPEG-2映像とAAC音声をブラウザ内でdemux/decodeする。
- 30分再生でA/V driftを100ms以内に保つ。
- 定常時のライブ遅延を3秒以内に保つ。
- チャンネル変更後、旧sessionのUSB、queue、decoder資源を解放する。

### M4: 公開ベータ

- 対応OS・ブラウザ・ドライバbindingの互換表を公開する。
- SBOM、第三者通知、対応ソースbundleを生成する。
- リポジトリ全履歴に禁止バイナリ、放送キャプチャ、秘密情報がないことを検査する。
- M0〜M3の受け入れ結果を記録した後にpublic化する。
- public化後にCloudflare Pagesと`webts.app`を接続する。

## 9. 未決事項

1. 最初に実機検証するOSとChromium系ブラウザ。
2. PX-S1UDでフルセグを復号する際の`CardProvider`。
3. decoder候補とライセンス。M1完了前には固定しない。
4. SharedArrayBufferが必要か。実測前には固定しない。
