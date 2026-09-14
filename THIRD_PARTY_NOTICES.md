# Third-party software inventory

このファイルは候補、採用、配布状態を区別して記録します。`candidate` はコードやバイナリを
リポジトリへ取り込んだことを意味しません。

| Component | Version / ref | License | Status | Intended use |
|---|---|---|---|---|
| libusb | 1.0.30 | LGPL-2.1-or-later | candidate | Emscripten/WebUSB backend |
| Khronos31/siano-userland | 未固定 | GPL-2.0-or-later | candidate | PX-S1UD tuner adapter |
| Khronos31/px4-userland | 未固定 | GPL-2.0-only | candidate | PX-Q3U4 tuner/card adapter |
| shirow-github/libaribb25 | 0.2.10 | ISC | candidate | TS descrambling core |
| stz2012/libarib25 | 未固定 | Apache-2.0 | reference-only | Native behavior comparison |
| tsukumijima/libaribb25 | 未固定 | Apache-2.0 | reference-only | Native behavior comparison |
| kazuki0824/recisdb-rs | 未固定 | GPL-3.0 and Apache-2.0 components | reference-only | Native behavior comparison |

## Runtime license policy

- WebTS.appの結合された配布物へ入れるコードはGPL-2.0-onlyと互換でなければならない。
- Apache-2.0コードをGPL-2.0-only成果物へリンク、トランスパイル、コピーしない。
- 第三者コードは取得元、commit/tag、checksum、ライセンス、変更patchを固定する。
- 配布artifactと同時に、再現に必要な正確な対応ソースとライセンス通知を提供する。
- ビルドツールと配布ランタイムを区別し、生成物へ取り込まれるruntime helperは個別に監査する。

## Firmware and captured data

- ファームウェアは、再配布条件と取得元を確認して明示的にallowlistへ追加するまでcommitしない。
- PX-Q3U4のIT930xファームウェアは初期状態で配布対象外とする。
- Sianoファームウェアも、専用ライセンスと配布形態を公開ゲートで再確認するまでは取り込まない。
- 放送TS、カードdump、ECM/EMM応答、カード番号、鍵をcommitしない。
- テストfixtureは仕様から生成した人工データを原則とし、由来を記録する。
