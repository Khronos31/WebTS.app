// Builds the channel scan module.
//
// The driver thread plus the upstream stream data plane, which starts one
// bridge pump std::thread per IT930x, so three run at once. PTHREAD_POOL_SIZE
// is 4 so none of them waits for a Worker to be spawned mid-scan.
//
// No card and no B25 here: SDT and NIT are not scrambled, so scanning does
// not need them, and leaving them out removes their failure modes.
//
// ASYNCIFY is linked for the same reason as the threaded build: the WebUSB
// backend's awaitOnMain has a main-thread branch referencing _emval_await.
// Nothing on the driver thread reaches it.

import { mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCompilers, run, version } from './lib/emscripten.mjs';
import { C_SOURCES, CXX_SOURCES, prepareVariant } from './lib/libusb-variants.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const upstream = join(root, 'vendor', 'upstream', 'px4-userland', 'userland');
const output = join(root, 'build', 'q3u4-scan');

const COMMON = ['-O2', '-DPLATFORM_POSIX=1', '-DOS_EMSCRIPTEN=1', '-DENABLE_LOGGING=1', '-pthread'];

const upstreamSources = [
  'libusb_transport.cpp', 'it930x.cpp', 'it930x_protocol.cpp', 'bridge_i2c.cpp',
  'identity.cpp', 'firmware.cpp', 'error.cpp', 'logging.cpp',
  'q3u4_frontend.cpp', 'q3u4_power.cpp', 'frontend_probe_support.cpp',
  // Satellite tuning needs the LNB authority: it is the only thing allowed to
  // drive GPIO 11, and it reference-counts the two receivers on a bridge.
  'q3u4_lnb_power.cpp',
  'tc90522.cpp', 'r850.cpp', 'rt710.cpp',
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
for (const source of [join(root, 'native', 'q3u4-scan.cpp'), ...upstreamSources]) {
  const object = join(variantRoot, basename(source, '.cpp') + '.px4.o');
  run(emxx, [...COMMON, ...include, ...px4Include, '-std=c++20', '-c', source, '-o', object]);
  objects.push(object);
}

const module = join(output, 'q3u4-scan.mjs');
run(emxx, [
  '--bind', '-pthread', '-s', 'SHARED_MEMORY=1', '-s', 'PTHREAD_POOL_SIZE=4',
  '-s', 'ASYNCIFY=1', '-s', 'ASSERTIONS=1', '-s', 'MODULARIZE=1', '-s', 'EXPORT_ES6=1',
  '-s', 'ENVIRONMENT=web,worker', '-s', 'ALLOW_MEMORY_GROWTH=1',
  '-s', 'EXPORTED_RUNTIME_METHODS=["ccall","HEAPU8","HEAP32"]',
  '-s', 'EXPORTED_FUNCTIONS=["_webts_q3u4_scan_start","_webts_q3u4_scan_poll",' +
    '"_webts_q3u4_scan_drain","_webts_q3u4_scan_advance","_webts_q3u4_scan_acknowledge",'+
    '"_webts_q3u4_scan_stop",' +
    '"_webts_q3u4_scan_join","_webts_q3u4_scan_error_name","_malloc","_free"]',
  '-o', module, ...objects,
]);

const text = readFileSync(module, 'utf8');
for (const required of ['webts_q3u4_scan_start', 'ccall']) {
  if (!text.includes(required)) throw new Error(`q3u4-scan.mjs is missing ${required}`);
}
process.stdout.write(`built ${module}\n`);
