# Third-party notices and release-candidate contract

This document describes the dependencies and materials for the currently implemented `release-candidate` packaging
contract. It is not, by itself, a declaration that the project is stable or ready for a general release. The release
candidate workflow generates and audits eight platform archives plus one corresponding-source archive, then uploads them
together with an outer `SHA256SUMS` file.

## No vendored dependency in the repository source

The repository source does not vendor libusb, pcsc-lite, the Android NDK, libc++/libc++abi, musl, or firmware. Native
CMake discovers libusb and PC/SC headers from the host or from explicit build inputs. The Linux static, macOS, and
Android release builds obtain the verified libusb source archive during the build; it is not checked into this
repository.

The source archive is made from the exact committed source ref selected by the workflow. It also contains the exact
verified libusb 1.0.30 source archive, its `COPYING`, checksums, and `BUILD-RELINK.md`. It excludes `.git`, build outputs,
firmware, APK/add-on material, and vendor drivers.

## libusb license copy in binary archives

Every Linux, macOS, and Android binary archive includes the exact libusb 1.0.30 license text at `libusb/COPYING`, verified
against the pinned SHA-256.

Primary license text: [libusb 1.0.30 `COPYING`](https://github.com/libusb/libusb/blob/v1.0.30/COPYING).

## Android binary archives

The Android archives are API 24+ Bionic builds for `aarch64`, `armv7a`, and `x86_64`. libusb 1.0.30 is statically linked as
`libusb-1.0.a` and remains licensed under LGPL-2.1-or-later. Each Android archive includes:

- the architecture-independent `px4-termux` shell launcher; it is audited as a shell artifact and is not an ELF or
  static-link inventory member;

- the exact NDK `source.properties` revision used by the build;
- NDK `NOTICE` and `NOTICE.toolchain`;
- a prominent `DEPENDENCY-NOTICE.txt` identifying libusb 1.0.30, static linkage, LGPL-2.1-or-later, the NDK revision and
  notice materials, and the corresponding-source archive;
- sanitized `evidence/inventory/*-static-archives.tsv` files listing archive basenames, member names, and categories;
- `manifest.json` and `SHA256SUMS`, both checked against the archived payload.

The static NDK C++ runtime portions, including the applicable `libc++`/`libc++abi` portions, are under Apache-2.0 WITH
LLVM-exception. The bundled NDK `NOTICE` and `NOTICE.toolchain` provide the associated terms and notices for those
runtime materials. The exact NDK revision is retained in `ndk/source.properties` and identified in the prominent
dependency notice.

The CI release-candidate path uses NDK r27d. The archive audit retains and checks the exact `27.x` revision recorded in
`ndk/source.properties`; it does not replace that revision with a generic NDK label. The static inventory is generated
from explicit linker-map inputs, but raw linker maps and their source/build/NDK paths are not shipped in the archive.

The corresponding-source archive provides the exact px4-userland source and exact libusb source needed to rebuild or
relink the Android artifacts. The libusb 1.0.30 obligation follows LGPL-2.1-or-later section 6(d), with the corresponding
source and relink route provided under section 6(a): the same candidate handoff contains the exact source, verification
hashes, and `BUILD-RELINK.md`. libusb's LGPL terms remain applicable; this contract does not claim that libusb was
converted to GPL under LGPL section 3. The complete px4-userland source is GPL-2.0-only and is rebuildable, so separate
application object files are not required as a relinkable deliverable under this contract.

## Linux and macOS native archives

The Linux archives are libc-qualified x86_64 and aarch64 packages. Their three production executables are fully static
musl ELFs and embed libusb 1.0.30 built with udev disabled. Each package also contains a separately built PC/SC IFD
shared object: `linux-glibc-*` uses a glibc 2.31 baseline and `linux-musl-*` uses the matching musl ABI. The IFD must
be loaded by matching host pcscd. The macOS archive is Apple Silicon; `px4d` embeds the same libusb 1.0.30 as static
`libusb-1.0.a`, and all three production executables dynamically link only macOS system libraries and frameworks
(`px4d` additionally links `libobjc`, IOKit, CoreFoundation, and Security for the libusb darwin backend). The macOS IFD
bundle does not link libusb.
The Linux and macOS static-libusb executables do not require host libusb or PC/SC client libraries. Linux IFD shared
objects require only their matching libc because libstdc++ and libgcc are statically linked; macOS retains its host
system `libc++` dependency.
The actual `NEEDED`/dynamic dependency lists are retained in `evidence/binary-audit.json`.

Only `px4d` directly requires libusb. `px4-ts` and `px4ctl` are IPC clients and must not directly require libusb. The
Linux/macOS IFD adapter also communicates with `px4d` over IPC and must not directly require libusb or a PC/SC client
library. A host PC/SC consumer/pcscd loads the IFD adapter through the supplied reader template.

The native dependency claim is verified from each built binary: Linux uses `readelf` to reject PT_INTERP/DT_NEEDED on
production executables and to verify the matching IFD libc and glibc floor; macOS uses `otool` to reject any libusb dylib
and any dependency outside `/usr/lib/` and `/System/Library/`, and to enforce the IFD dependency restrictions.

The Linux and macOS binary archives include `libusb/COPYING` but do not carry the libusb source themselves. Their prominent
`DEPENDENCY-NOTICE.txt` identifies libusb 1.0.30, static linkage, LGPL-2.1-or-later, and the corresponding-source archive of
the same candidate handoff, which contains the exact libusb source, verification hashes, and the Linux and macOS
build/relink instructions in `BUILD-RELINK.md`. The license copy in every binary archive supplies the license text; the
separate source archive supplies the exact source and source/relink materials. Both parts of the LGPL-2.1-or-later section 6
route apply.

Primary PC/SC license reference: [pcsc-lite `COPYING`](https://github.com/LudovicRousseau/PCSC/blob/master/COPYING).
The exact host package versions remain deployment-specific system inputs and are not copied into the native archives.

## CI and archive audit

The local packaging scripts and `.github/workflows/build_userland.yml` implement the same release-candidate contract.
They require explicit already-built platform inputs, strict `N.N.N` version matching, and the exact pinned libusb source
where Android or source packaging needs it. They audit archive allowlists, required files, manifests, checksums, path
traversal, symlinks/hardlinks, firmware, Windows, probe, kernel/DKMS, and vendor content.

The final CI artifact is named `release-candidate` and contains exactly these nine archives (eight binary plus one source)
and the outer `SHA256SUMS`:

- `px4-userland-<version>-linux-glibc-x86_64.tar.gz`;
- `px4-userland-<version>-linux-musl-x86_64.tar.gz`;
- `px4-userland-<version>-linux-glibc-aarch64.tar.gz`;
- `px4-userland-<version>-linux-musl-aarch64.tar.gz`;
- `px4-userland-<version>-darwin-arm64.tar.gz`;
- `px4-userland-<version>-android-aarch64.tar.gz`;
- `px4-userland-<version>-android-armv7a.tar.gz`;
- `px4-userland-<version>-android-x86_64.tar.gz`;
- `px4-userland-<version>-source.tar.gz`.

This artifact is a candidate handoff, not a Git tag or GitHub Release. Stable acceptance is described in [`SPEC.md`](SPEC.md):
the exact final candidate artifact must pass a hardware canary lasting at least 10 minutes for every Stable release. Targeted
requalification and a long soak are required when triggered by the change-impact rules or when periodic recertification is due;
they are not blanket per-release requirements. The release record identifies evidence lineage, impact decisions, and which
evidence is fresh, inherited, or expired. Receiver 7 reference comparison follows the freshness rules in SPEC 10.2.6a.
Stable publication also requires no major unresolved issue and a pre-publication review. The Linux aarch64 archive remains
`build-tested / hardware-unverified`; its lack of hardware validation is a known non-blocking limitation.

## CI-only actions

GitHub Actions and their runners are CI infrastructure rather than product dependencies in a release source snapshot.
The workflow uses SHA-pinned checkout, artifact, and NDK setup actions. Their notices and licenses apply to the CI
execution environment; they are not copied into the product archives.

## Firmware is separate and not included

IT930x firmware is not a third-party library used by the source build and is not included as a source file, blob, archive
member, or release artifact. It is a separately supplied runtime input whose licensing and acquisition remain outside this
inventory. The project does not download, extract, or transform vendor firmware.
