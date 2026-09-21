// Builds the PX-Q3U4 driver stack to run on a pthread instead of the main
// runtime thread.
//
// Upstream is written to block, and on a non-main thread it can: events_posix.c
// takes the emscripten_atomic_wait_u32 branch and the WebUSB backend proxies
// each operation to the main runtime thread while the calling thread blocks.
// Running the driver on the main runtime thread instead meant unwinding a deep
// stack hundreds of times per tune, which is what made a no-signal channel take
// minutes (docs/FINDINGS.md section 12).
//
// ASYNCIFY still has to be linked: the backend's awaitOnMain has a main-thread
// branch calling val::await(), so _emval_await must resolve even though a
// driver confined to a pthread never reaches it. Linking it is not the cost;
// executing it was.
//
// PTHREAD_POOL_SIZE is 1 so the driver thread starts without waiting for a
// worker to spin up. The module is loaded on the page's main thread, which
// stays free to service the proxy queue and resolve WebUSB promises.

import { mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCompilers, run, version } from './lib/emscripten.mjs';
import { C_SOURCES, CXX_SOURCES, prepareVariant } from './lib/libusb-variants.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const upstream = join(root, 'vendor', 'upstream', 'px4-userland', 'userland');
const output = join(root, 'build', 'q3u4-threaded');

const COMMON = ['-O2', '-DPLATFORM_POSIX=1', '-DOS_EMSCRIPTEN=1', '-DENABLE_LOGGING=1', '-pthread'];

const upstreamSources = [
  'libusb_transport.cpp', 'it930x.cpp', 'it930x_protocol.cpp', 'bridge_i2c.cpp',
  'identity.cpp', 'firmware.cpp', 'error.cpp', 'logging.cpp',
  'q3u4_frontend.cpp', 'q3u4_power.cpp', 'frontend_probe_support.cpp',
  'tc90522.cpp', 'r850.cpp', 'rt710.cpp',
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
for (const source of [join(root, 'native', 'q3u4-threaded-session.cpp'), ...upstreamSources]) {
  const object = join(variantRoot, basename(source, '.cpp') + '.px4.o');
  run(emxx, [...COMMON, ...include, ...px4Include, '-std=c++20', '-c', source, '-o', object]);
  objects.push(object);
}

const module = join(output, 'q3u4-threaded.mjs');
run(emxx, [
  '--bind', '-pthread', '-s', 'SHARED_MEMORY=1', '-s', 'PTHREAD_POOL_SIZE=1',
  '-s', 'ASYNCIFY=1', '-s', 'ASSERTIONS=1', '-s', 'MODULARIZE=1', '-s', 'EXPORT_ES6=1',
  '-s', 'ENVIRONMENT=web,worker', '-s', 'ALLOW_MEMORY_GROWTH=1',
  '-s', 'EXPORTED_RUNTIME_METHODS=["ccall","HEAPU8"]',
  '-s', 'EXPORTED_FUNCTIONS=["_webts_q3u4_scan_start","_webts_q3u4_scan_poll",' +
    '"_webts_q3u4_scan_join","_malloc","_free"]',
  '-o', module, ...objects,
]);

const text = readFileSync(module, 'utf8');
for (const required of ['webts_q3u4_scan_start', 'ccall']) {
  if (!text.includes(required)) throw new Error(`q3u4-threaded.mjs is missing ${required}`);
}
process.stdout.write(`built ${module}\n`);
