# Source provenance and rights record

`px4-userland` is an independent standalone repository containing derivative portions.
This document preserves the engineering provenance that was previously visible partly through the GitHub
fork relationship. It is not a legal opinion and does not replace the notices in individual source files or the
terms in [`LICENSE`](LICENSE).

## Repository lineage

- Direct source: [`tsukumijima/px4_drv`](https://github.com/tsukumijima/px4_drv), snapshot commit
  `9eedea8c502875a788697984b93b50032339b9aa`.
- Original upstream: [`nns779/px4_drv`](https://github.com/nns779/px4_drv).
- Current product: `Khronos31/px4-userland`, an independent standalone repository for a Linux/Android/macOS userland
  product for PLEX PX-Q3U4.
- License for this project and its derivative portions: [`GPL-2.0-only`](LICENSE).

Git author names and commit history are evidence about repository activity; they are not, by themselves, a list of
copyright holders. In particular, a contributor, git author, maintainer, project name, or implementation agent is
not added as a copyright holder here without a separate rights basis. The retained `Copyright (c) 2018-2021 nns779`
line appears only where the audited origin file explicitly contained that notice and the audit found its substantive
expression retained. The tsukumijima-derived portions without a file-local copyright notice are described with a
source-snapshot maintenance fact without guessing a copyright holder. For the smart-card-derived `card.h`,
`card.cpp`, and `card_tests.cpp`, the audit records that the relevant WinUSB source files were committed/maintained
in the direct-parent history by tsukumijima; that is a commit-author and maintenance fact, not a copyright-holder
claim.

## Date and audit scope

The audit covered all 84 files under `userland/`: 17 adapted, 11 mixed, one uncertain, and 55 original under the
audit's engineering classification. The 28 adapted/mixed files below received a prominent file-local notice. Each
date is an estimated port/change date derived from that file's pre-edit mtime calendar date, cross-checked
against the project memory's Increment 3A–4B work recorded on 2026-09-02 and 2026-09-03. These dates are not the
edit date of this provenance pass and are not claims about the exact historical authorship, creation date, or
copyright date of the source. The unavailability of a
complete creation history for the pre-commit userland files is an explicit ambiguity.

## Complete adapted/mixed mapping

The following table has exactly one row for each of the 28 files classified as adapted or mixed by the audit. The
paths in the Origin path(s) column are paths in the direct parent snapshot above.

| Current file | Class | Origin path(s) in direct parent | Retained notice | Change overview / notice date |
|---|---|---|---|---|
| `userland/include/px4/card.h` | adapted | `winusb/src/DriverHost_PX4/card_device.hpp`; `winusb/src/DriverHost_PX4/smart_card.hpp`; `winusb/src/DriverHost_PX4/smart_card.cpp`; `winusb/src/WinSCard_PX4/bcas_atr.hpp` | No file-local copyright notice in the source snapshot; no holder inferred | Portable card API and card-state declarations for ATR/T=1 support; 2026-09-03 |
| `userland/include/px4/it930x.h` | adapted | `driver/it930x.c`; `driver/it930x.h`; `driver/itedtv_bus.c`; `driver/px4_device.c`; `winusb/src/DriverHost_PX4/px4_device.cpp` | `Copyright (c) 2018-2021 nns779` retained from explicit driver notices | Portable IT930x command/register, firmware, power, and card-UART interface; 2026-09-03 |
| `userland/src/bridge_i2c.cpp` | adapted | `driver/i2c_comm.h`; `driver/it930x.c`; `driver/tc90522.c` | `Copyright (c) 2018-2021 nns779` retained from explicit driver notices | Portable I2C request, repeater, length, and command sequencing; 2026-09-02 |
| `userland/src/bridge_i2c.h` | adapted | `driver/i2c_comm.h`; `driver/it930x.c`; `driver/tc90522.c` | `Copyright (c) 2018-2021 nns779` retained from explicit driver notices | Portable bridge-I2C interface and bounded request definitions; 2026-09-02 |
| `userland/src/card.cpp` | adapted | `winusb/src/DriverHost_PX4/card_device.hpp`; `winusb/src/DriverHost_PX4/smart_card.hpp`; `winusb/src/DriverHost_PX4/smart_card.cpp`; `winusb/src/WinSCard_PX4/bcas_atr.hpp` | No file-local copyright notice in the source snapshot; no holder inferred | Portable ATR and T=1 state machine over the card transport; 2026-09-03 |
| `userland/src/it930x.cpp` | adapted | `driver/it930x.c`; `driver/it930x.h`; `driver/itedtv_bus.c`; `driver/px4_device.c`; `winusb/src/DriverHost_PX4/px4_device.cpp` | `Copyright (c) 2018-2021 nns779` retained from explicit driver notices | Portable IT930x control, firmware initialization, register, power, and UART operations; 2026-09-03 |
| `userland/src/it930x_protocol.cpp` | adapted | `driver/it930x.c` | `Copyright (c) 2018-2021 nns779` retained from the explicit `driver/it930x.c` notice | Portable scatter-image and command-frame parser; 2026-09-02 |
| `userland/src/it930x_protocol.h` | adapted | `driver/it930x.c` | `Copyright (c) 2018-2021 nns779` retained from the explicit `driver/it930x.c` notice | Portable protocol parser contract and bounded views; 2026-09-02 |
| `userland/src/q3u4_frontend.cpp` | adapted | `driver/px4_device.c`; `driver/px4_device.h`; `winusb/src/DriverHost_PX4/px4_device.cpp`; `winusb/src/DriverHost_PX4/px4_device.hpp` | `Copyright (c) 2018-2021 nns779` retained from explicit `driver/px4_device.*` notices | Portable Q3U4 receiver mapping, open/tune/TSID/capture, power, and cleanup flow; 2026-09-03 |
| `userland/src/q3u4_frontend.h` | adapted | `driver/px4_device.c`; `driver/px4_device.h`; `winusb/src/DriverHost_PX4/px4_device.cpp`; `winusb/src/DriverHost_PX4/px4_device.hpp` | `Copyright (c) 2018-2021 nns779` retained from explicit `driver/px4_device.*` notices | Portable frontend and receiver lifecycle declarations; 2026-09-03 |
| `userland/src/r850.cpp` | adapted | `driver/r850.c`; `driver/r850.h` | `Copyright (c) 2018-2021 nns779` retained from explicit R850 notices | Portable R850 tables, initialization, PLL, and tune sequence; 2026-09-02 |
| `userland/src/r850.h` | adapted | `driver/r850.c`; `driver/r850.h` | `Copyright (c) 2018-2021 nns779` retained from explicit R850 notices | Portable R850 interface and parameter definitions; 2026-09-02 |
| `userland/src/rt710.cpp` | adapted | `driver/rt710.c`; `driver/rt710.h` | `Copyright (c) 2018-2021 nns779` retained from explicit RT710 notices | Portable RT710/RT720 tables, PLL, bandwidth, and tune sequence; 2026-09-02 |
| `userland/src/rt710.h` | adapted | `driver/rt710.c`; `driver/rt710.h` | `Copyright (c) 2018-2021 nns779` retained from explicit RT710 notices | Portable RT710/RT720 interface and parameter definitions; 2026-09-02 |
| `userland/src/tc90522.cpp` | adapted | `driver/tc90522.c`; `driver/tc90522.h`; `driver/i2c_comm.h` | `Copyright (c) 2018-2021 nns779` retained from explicit TC90522/I2C notices | Portable TC90522 register, repeater, initialization, and capture sequence; 2026-09-02 |
| `userland/src/tc90522.h` | adapted | `driver/tc90522.c`; `driver/tc90522.h`; `driver/i2c_comm.h` | `Copyright (c) 2018-2021 nns779` retained from explicit TC90522/I2C notices | Portable TC90522 interface and register operation definitions; 2026-09-02 |
| `userland/tests/card_tests.cpp` | adapted | `winusb/tests/smart_card_state_test.cpp`; `winusb/src/WinSCard_PX4/bcas_atr.hpp`; `winusb/src/DriverHost_PX4/smart_card.cpp` | No file-local source copyright notice; no holder inferred | Portable mock/time tests for ATR and T=1 state/error scenarios; 2026-09-03 |
| `userland/src/identity.cpp` | mixed | `driver/px4_device.c`; `driver/px4_usb.c`; `winusb/src/DriverHost_PX4/px4_device.cpp` | `Copyright (c) 2018-2021 nns779` retained from explicit driver notices | Portable serial parsing and strict Q3U4 grouping; Result-based validation is project adaptation; 2026-09-02 |
| `userland/src/libusb_transport.cpp` | mixed | `driver/itedtv_bus.c`; `driver/itedtv_bus.h`; `driver/px4_usb.c`; `driver/px4_usb.h`; `winusb/src/DriverHost_PX4/itedtv_bus_winusb.c`; `winusb/src/DriverHost_PX4/px4_device.cpp` | `Copyright (c) 2018-2021 nns779` retained from explicit driver notices | libusb transport, endpoint/pair lifecycle, fd wrapping, cancellation, and bounded teardown; 2026-09-03 |
| `userland/src/tagged_ts_demux.cpp` | mixed | `driver/px4_device.c`; `driver/ts_sync.h`; `winusb/src/DriverHost_PX4/px4_device.cpp`; `winusb/tests/ts_sync_condition_test.cpp` | `Copyright (c) 2018-2021 nns779` retained from explicit `driver/px4_device.c` notice; `ts_sync.h` alone carries no such notice | Portable tagged-TS synchronization, tag extraction, rewrite, bounded pending data, and recovery counters; 2026-09-02 |
| `userland/tests/frontend_tests.cpp` | mixed | `driver/tc90522.c`; `driver/r850.c`; `driver/rt710.c`; `driver/px4_device.c` | `Copyright (c) 2018-2021 nns779` retained from explicit driver notices | Legacy register/control golden sequences plus new mock and failure-matrix coverage; 2026-09-02 |
| `userland/tests/it930x_card_tests.cpp` | mixed | `driver/it930x.c`; `winusb/src/DriverHost_PX4/smart_card.cpp` | `Copyright (c) 2018-2021 nns779` retained from explicit `driver/it930x.c` notice | IT930x card-UART golden sequence plus portable mock/error coverage; 2026-09-03 |
| `userland/tests/q3u4_frontend_tests.cpp` | mixed | `driver/px4_device.c`; `winusb/src/DriverHost_PX4/px4_device.cpp` | `Copyright (c) 2018-2021 nns779` retained from explicit `driver/px4_device.c` notice | Q3U4 initialization/tune/close golden order plus cleanup/error coverage; 2026-09-03 |
| `userland/tests/q3u4_power_tests.cpp` | mixed | `driver/px4_device.c`; `winusb/src/DriverHost_PX4/px4_device.cpp` | `Copyright (c) 2018-2021 nns779` retained from explicit `driver/px4_device.c` notice | Bridge/card power interlock golden algorithm plus rollback/failure harness; 2026-09-03 |
| `userland/tests/r850_tests.cpp` | mixed | `driver/r850.c` | `Copyright (c) 2018-2021 nns779` retained from explicit R850 notice | Legacy R850 tables/selected outputs plus portable mock/failure tests; 2026-09-02 |
| `userland/tests/rt710_tests.cpp` | mixed | `driver/rt710.c` | `Copyright (c) 2018-2021 nns779` retained from explicit RT710 notice | Legacy RT710/RT720 initialization and output tables plus portable mock/failure tests; 2026-09-03 |
| `userland/tests/tagged_ts_demux_tests.cpp` | mixed | `driver/px4_device.c`; `driver/ts_sync.h`; `winusb/src/DriverHost_PX4/px4_device.cpp`; `winusb/tests/ts_sync_condition_test.cpp` | `Copyright (c) 2018-2021 nns779` retained from explicit `driver/px4_device.c` notice; `ts_sync.h` alone carries no such notice | Legacy sync predicate/golden behavior plus fragment, garbage, recovery, and counter tests; 2026-09-03 |
| `userland/tests/test_main.cpp` | mixed | `driver/it930x.c`; `driver/itedtv_bus.c`; `driver/px4_usb.c`; `driver/px4_device.c`; `winusb/src/DriverHost_PX4/itedtv_bus_winusb.c`; `winusb/src/DriverHost_PX4/px4_device.cpp` | `Copyright (c) 2018-2021 nns779` retained from explicit driver notices | Firmware/control framing, warm init, transport/grouping, and stream-lifecycle golden tests plus portable failure tests; 2026-09-03 |

## Firmware

The firmware binary is not included in the source tree, source archive, or release artifact. It is not a third-party
library. Runtime firmware preparation and licensing are separate from this source provenance record, and the project
does not download, extract, or transform vendor firmware.

`userland/src/firmware.cpp` was classified as `uncertain` at audit time. The post-audit conclusion recorded here and
in the file itself is that it is a project-original Increment 3A implementation: the available source history shows
no evidence that its SHA-256 representation was transcribed from the legacy `driver/` or `winusb/` trees. The
technical claim is limited to the standard FIPS SHA-256 constants and processing.

## Fork-network separation

GitHub fork-network separation is complete: `Khronos31/px4-userland` is an independent repository with no parent
relationship, and `main` is its default branch.

Removing the GitHub fork relationship does not change copyright, license, derivative-work, or corresponding-source
obligations. The fork badge is provenance metadata, not a substitute for file notices, this mapping, `LICENSE`, or
third-party release materials. Any later standalone import, squash, tag, or binary release must preserve these records
and must not reintroduce historical firmware or Windows signing artifacts into the current product.
