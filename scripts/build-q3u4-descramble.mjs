// Builds the descrambling probe module.
//
// This is the first build that needs the frontend, the stream data plane and
// the card at once, because descrambling needs all three: tune and lock, pull
// TS, and answer ECM from the card. Card power lives on
// Q3U4FrontendEnclosure, which is why the enclosure rather than the
// single-receiver wrapper is what this links.
//
// Same shape as the TS capture build: the driver runs on a pthread the module
// creates, and the main runtime thread stays free to resolve WebUSB promises.
// The card path needs no stream pumps, but the pool is left at 4 so one build
// script's settings do not have to be reasoned about differently from the
// other's.
//
// b_cas_card.c is vendored unmodified and written against PC/SC, so
// native/winscard/ is put ahead of everything on the include path and
// native/winscard-q3u4.cpp supplies the six functions it calls. Nothing else
// in this build includes <winscard.h>.

import { mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCompilers, run, version } from './lib/emscripten.mjs';
import { C_SOURCES, CXX_SOURCES, prepareVariant } from './lib/libusb-variants.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const upstream = join(root, 'vendor', 'upstream', 'px4-userland', 'userland');
const b25 = join(root, 'vendor', 'upstream', 'libaribb25');
const output = join(root, 'build', 'q3u4-descramble');

const COMMON = ['-O2', '-DPLATFORM_POSIX=1', '-DOS_EMSCRIPTEN=1', '-DENABLE_LOGGING=1', '-pthread'];

const upstreamSources = [
  'libusb_transport.cpp', 'it930x.cpp', 'it930x_protocol.cpp', 'bridge_i2c.cpp',
  'identity.cpp', 'firmware.cpp', 'error.cpp', 'logging.cpp',
  'q3u4_frontend.cpp', 'q3u4_power.cpp', 'frontend_probe_support.cpp',
  // Satellite tuning needs the LNB authority: it is the only thing allowed to
  // drive GPIO 11, and it reference-counts the two receivers on a bridge.
  'q3u4_lnb_power.cpp',
  'tc90522.cpp', 'r850.cpp', 'rt710.cpp',
  'card.cpp', 'card_service.cpp', 'q3u4_card_backend.cpp', 'ipc.cpp',
  'q3u4_stream.cpp', 'tagged_ts_demux.cpp',
].map((name) => join(upstream, 'src', name));

const { emcc, emxx } = findCompilers();
process.stdout.write(`emcc: ${version(emcc)}\n`);
mkdirSync(output, { recursive: true });

const { root: variantRoot, src, includes } = prepareVariant(root, output, 'patched');
const include = includes.flatMap((directory) => ['-I', directory]);
const px4Include = ['-I', join(upstream, 'include'), '-I', join(upstream, 'src')];
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
// libaribb25 is C. b_cas_card.c additionally gets the shim's winscard.h ahead
// of any system one; nothing else here includes <winscard.h>.
for (const name of ['b_cas_card.c', 'arib_std_b25.c', 'multi2.c', 'ts_section_parser.c']) {
  const object = join(variantRoot, name + '.o');
  run(emcc, [...COMMON, '-I', join(root, 'native', 'winscard'), '-I', join(b25, 'src'),
    '-c', join(b25, 'src', name), '-o', object]);
  objects.push(object);
}

const cxxShims = [
  join(root, 'native', 'winscard-q3u4.cpp'),
];
for (const source of [join(root, 'native', 'q3u4-descramble-probe.cpp'), ...cxxShims,
  ...upstreamSources]) {
  const object = join(variantRoot, basename(source, '.cpp') + '.px4.o');
  run(emxx, [...COMMON, '-I', join(root, 'native', 'winscard'), '-I', join(b25, 'src'),
    ...include, ...px4Include, '-std=c++20', '-c', source, '-o', object]);
  objects.push(object);
}

const module = join(output, 'q3u4-descramble.mjs');
run(emxx, [
  '--bind', '-pthread', '-s', 'SHARED_MEMORY=1', '-s', 'PTHREAD_POOL_SIZE=10',
  '-s', 'ASYNCIFY=1', '-s', 'ASSERTIONS=1', '-s', 'MODULARIZE=1', '-s', 'EXPORT_ES6=1',
  '-s', 'ENVIRONMENT=web,worker', '-s', 'ALLOW_MEMORY_GROWTH=1',
  '-s', 'EXPORTED_RUNTIME_METHODS=["ccall","HEAPU8","HEAP32"]',
  '-s', 'EXPORTED_FUNCTIONS=["_webts_q3u4_descramble_start","_webts_q3u4_descramble_poll",' +
    '"_webts_q3u4_scan_start","_webts_q3u4_scan_poll","_webts_q3u4_scan_drain",' +
    '"_webts_q3u4_scan_advance","_webts_q3u4_scan_acknowledge",' +
    '"_webts_q3u4_scan_stop","_webts_q3u4_scan_join",' +
    '"_webts_q3u4_scan_error_name",' +
    '"_webts_q3u4_session_keep_open",' +
    '"_webts_q3u4_descramble_join","_webts_q3u4_descramble_error_name",'+
    '"_webts_q3u4_descramble_output","_webts_q3u4_descramble_output_size",'+
    '"_webts_q3u4_descramble_discard","_webts_q3u4_descramble_stop",'+
    '"_webts_q3u4_descramble_drain","_webts_q3u4_descramble_pending",'+
    '"_webts_q3u4_descramble_dropped","_malloc","_free"]',
  '-o', module, ...objects,
]);

const text = readFileSync(module, 'utf8');
for (const required of ['webts_q3u4_descramble_start', 'ccall']) {
  if (!text.includes(required)) throw new Error(`q3u4-descramble.mjs is missing ${required}`);
}
process.stdout.write(`built ${module}\n`);
