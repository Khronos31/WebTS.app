// Builds the PX-Q3U4 open/claim probe against the vendored libusb, the one
// carrying the transfer-ownership fix. There is no fake navigator.usb here:
// the module talks to the real WebUSB permissions the page holds.
//
// Built with shared memory and no pthread pool, the configuration the
// ownership regression established works in a browser. The page must be
// cross-origin isolated, which vite.config.ts and public/_headers provide.

import { mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCompilers, run, version } from './lib/emscripten.mjs';
import { C_SOURCES, CXX_SOURCES, prepareVariant } from './lib/libusb-variants.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const upstream = join(root, 'vendor', 'upstream', 'px4-userland', 'userland');
const output = join(root, 'build', 'q3u4-claim-probe');
const probes = [
  join(root, 'native', 'q3u4-claim-probe.cpp'),
  join(root, 'native', 'q3u4-version-probe.cpp'),
  join(root, 'native', 'q3u4-firmware-probe.cpp'),
  join(root, 'native', 'q3u4-tune-probe.cpp'),
  join(root, 'native', 'q3u4-session.cpp'),
];
// 上流の transport と IT930x 制御をそのままリンクする。書き写さない。
const upstreamSources = [
  'libusb_transport.cpp', 'it930x.cpp', 'it930x_protocol.cpp', 'bridge_i2c.cpp',
  'identity.cpp', 'firmware.cpp', 'error.cpp', 'logging.cpp',
  'q3u4_frontend.cpp', 'q3u4_power.cpp', 'frontend_probe_support.cpp',
  'tc90522.cpp', 'r850.cpp', 'rt710.cpp',
].map((name) => join(upstream, 'src', name));

const COMMON = ['-O2', '-DPLATFORM_POSIX=1', '-DOS_EMSCRIPTEN=1', '-DENABLE_LOGGING=1', '-pthread'];

const { emcc, emxx } = findCompilers();
process.stdout.write(`emcc: ${version(emcc)}\n`);
mkdirSync(output, { recursive: true });

// The probe links the patched libusb, not a pristine one: the fix is what we
// intend to ship, so it is what the hardware path must exercise.
const { root: variantRoot, src, includes } = prepareVariant(root, output, 'patched');
const include = includes.flatMap((directory) => ['-I', directory]);
const objects = [];

for (const relativePath of C_SOURCES) {
  const object = join(variantRoot, relativePath.replaceAll('/', '_') + '.o');
  run(emcc, [...COMMON, ...include, '-c', join(src, ...relativePath.split('/')), '-o', object]);
  objects.push(object);
}
for (const relativePath of CXX_SOURCES) {
  const object = join(variantRoot, relativePath.replaceAll('/', '_') + '.o');
  run(emxx, [...COMMON, ...include, '-std=c++20', '-c',
    join(src, ...relativePath.split('/')), '-o', object]);
  objects.push(object);
}

const px4Include = ['-I', join(upstream, 'include'), '-I', join(upstream, 'src')];
for (const source of [...probes, ...upstreamSources]) {
  const object = join(variantRoot, basename(source, '.cpp') + '.px4.o');
  run(emxx, [...COMMON, ...include, ...px4Include, '-std=c++20', '-c', source, '-o', object]);
  objects.push(object);
}

const module = join(output, 'q3u4-claim-probe.mjs');
run(emxx, [
  '--bind', '-pthread', '-s', 'SHARED_MEMORY=1', '-s', 'PTHREAD_POOL_SIZE=0',
  '-s', 'ASYNCIFY=1', '-s', 'ASSERTIONS=1', '-s', 'MODULARIZE=1',
  '-s', 'EXPORT_ES6=1', '-s', 'ENVIRONMENT=web,worker',
  '-s', 'ALLOW_MEMORY_GROWTH=1',
  '-s', 'EXPORTED_RUNTIME_METHODS=["ccall","HEAPU8","UTF8ToString"]',
  '-s', 'EXPORTED_FUNCTIONS=["_webts_q3u4_claim_probe","_webts_q3u4_claim_probe_words",' +
    '"_webts_q3u4_version_probe","_webts_q3u4_version_probe_words",' +
    '"_webts_q3u4_firmware_probe","_webts_q3u4_firmware_probe_words",' +
    '"_webts_q3u4_tune_probe","_webts_q3u4_tune_probe_words",' +
    '"_webts_q3u4_tune_probe_stage_name",' +
    '"_webts_q3u4_session_open","_webts_q3u4_session_tune","_webts_q3u4_session_close",' +
    '"_webts_q3u4_session_is_open","_webts_q3u4_session_dev1_version",' +
    '"_webts_q3u4_session_dev2_version","_malloc","_free"]',
  '-o', module, ...objects,
]);

const text = readFileSync(module, 'utf8');
for (const required of ['webts_q3u4_claim_probe', 'webts_q3u4_version_probe',
  'webts_q3u4_firmware_probe', 'webts_q3u4_session_open', 'ccall']) {
  if (!text.includes(required)) throw new Error(`q3u4-claim-probe.mjs is missing ${required}`);
}
process.stdout.write(`built ${module}\n`);
