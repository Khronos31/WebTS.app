# Third-party software inventory

このファイルは候補、採用、配布状態を区別して記録します。`candidate` はコードやバイナリを
リポジトリへ取り込んだことを意味しません。

| Component | Version / ref | License | Status | Intended use |
|---|---|---|---|---|
| libusb | v1.0.30 / `87a55632db62c9bdc58cd31d3ccfa673f1bb017f` | LGPL-2.1-or-later | vendored source-only | Official Emscripten/WebUSB backend; not built yet |
| Khronos31/siano-userland | `eb73192e4e6dbdc4b84502ccfc5ec14f5ce86c86` | GPL-2.0-or-later | vendored source-only | PX-S1UD core candidate; browser adapter not exposed |
| Khronos31/px4-userland | `10a373dbda0603b2d8180bb2508e2d88dd70eb2d` | GPL-2.0-only | vendored source-only | PX-Q3U4 core candidate; firmware excluded |
| shirow-github/libaribb25 | v0.2.10 / `b978fe5caf6bfe162e944ad4d323b7c0205276e3` | ISC | vendored source-only | M2 TS section parser + MULTI2 + upstream facade create/configure/release smoke; PC/SC implementation excluded |
| stz2012/libarib25 | 未固定 | Apache-2.0 | reference-only | Native behavior comparison |
| tsukumijima/libaribb25 | 未固定 | Apache-2.0 | reference-only | Native behavior comparison |
| kazuki0824/recisdb-rs | 未固定 | GPL-3.0 and Apache-2.0 components | reference-only | Native behavior comparison |
| TypeScript | 7.0.2 | Apache-2.0 | adopted, build-only | Type checking and compilation |
| Vite | 8.3.0 | MIT | adopted, build-only | Development server and static build |
| Vitest | 5.0.0 | MIT | adopted, test-only | Unit tests |

## Runtime license policy

- WebTS.appの結合された配布物へ入れるコードはGPL-2.0-onlyと互換でなければならない。
- Apache-2.0コードをGPL-2.0-only成果物へリンク、トランスパイル、コピーしない。
- 第三者コードは取得元、commit/tag、checksum、ライセンス、変更patchを固定する。
- 現在固定しているtest-only patchは、Siano counter patch（`scripts/siano-ts-counters.patch`）と、
  libusb transfer ownership patch（`scripts/libusb-ownership-patch/`、
  `scripts/libusb-ownership-patch-io/`）である。いずれも`build/`配下のbuild copyにだけ適用し、
  vendor snapshotと配布artifactには適用しない。libusbはLGPL-2.1-or-laterであり、
  patchを配布物へ採用する場合は対応ソースと変更通知を同時に提供する。
- 固定sourceは [`docs/VENDOR_SOURCES.md`](docs/VENDOR_SOURCES.md) と
  `vendor/SOURCE_LOCK.json` に記録し、`scripts/check-vendor-sources.ps1` で検査する。
- 配布artifactと同時に、再現に必要な正確な対応ソースとライセンス通知を提供する。
- ビルドツールと配布ランタイムを区別し、生成物へ取り込まれるruntime helperは個別に監査する。
- npmの正確な直接・推移依存は`package-lock.json`へ固定する。現時点の推移依存には
  MIT、ISC、BSD-3-Clause、Apache-2.0、MPL-2.0のbuild/test用packageが含まれる。
  公開artifactへコードが取り込まれる場合は、そのartifact側の通知と互換性を別途確認する。

## Firmware and captured data

- ファームウェアは、再配布条件と取得元を確認して明示的にallowlistへ追加するまでcommitしない。
- PX-Q3U4のIT930xファームウェアは初期状態で配布対象外とする。
- Sianoファームウェアも、専用ライセンスと配布形態を公開ゲートで再確認するまでは取り込まない。
- 放送TS、カードdump、ECM/EMM応答、カード番号、鍵をcommitしない。
- テストfixtureは仕様から生成した人工データを原則とし、由来を記録する。
