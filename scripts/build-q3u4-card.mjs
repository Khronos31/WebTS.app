// Builds the PX-Q3U4 card probe module.
//
// Same shape as the TS capture build: the driver runs on a pthread the module
// creates, and the main runtime thread stays free to resolve WebUSB promises.
// The card path needs no stream pumps, but the pool is left at 4 so one build
// script's settings do not have to be reasoned about differently from the
// other's.
//
// The card backend needs Q3U4FrontendEnclosure, which owns card power, so
// q3u4_power.cpp and the full frontend come in even though nothing here tunes.

import { mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCompilers, run, version } from './lib/emscripten.mjs';
import { C_SOURCES, CXX_SOURCES, prepareVariant } from './lib/libusb-variants.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const upstream = join(root, 'vendor', 'upstream', 'px4-userland', 'userland');
const output = join(root, 'build', 'q3u4-card');

const COMMON = ['-O2', '-DPLATFORM_POSIX=1', '-DOS_EMSCRIPTEN=1', '-DENABLE_LOGGING=1', '-pthread'];

const upstreamSources = [
  'libusb_transport.cpp', 'it930x.cpp', 'it930x_protocol.cpp', 'bridge_i2c.cpp',
  'identity.cpp', 'firmware.cpp', 'error.cpp', 'logging.cpp',
  'q3u4_frontend.cpp', 'q3u4_power.cpp', 'frontend_probe_support.cpp',
  'tc90522.cpp', 'r850.cpp', 'rt710.cpp',
  'card.cpp', 'card_service.cpp', 'q3u4_card_backend.cpp', 'ipc.cpp',
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
for (const source of [join(root, 'native', 'q3u4-card-probe.cpp'), ...upstreamSources]) {
  const object = join(variantRoot, basename(source, '.cpp') + '.px4.o');
  run(emxx, [...COMMON, ...include, ...px4Include, '-std=c++20', '-c', source, '-o', object]);
  objects.push(object);
}

const module = join(output, 'q3u4-card.mjs');
run(emxx, [
  '--bind', '-pthread', '-s', 'SHARED_MEMORY=1', '-s', 'PTHREAD_POOL_SIZE=4',
  '-s', 'ASYNCIFY=1', '-s', 'ASSERTIONS=1', '-s', 'MODULARIZE=1', '-s', 'EXPORT_ES6=1',
  '-s', 'ENVIRONMENT=web,worker', '-s', 'ALLOW_MEMORY_GROWTH=1',
  '-s', 'EXPORTED_RUNTIME_METHODS=["ccall","HEAPU8","HEAP32"]',
  '-s', 'EXPORTED_FUNCTIONS=["_webts_q3u4_card_start","_webts_q3u4_card_poll",' +
    '"_webts_q3u4_card_join","_webts_q3u4_card_error_name","_malloc","_free"]',
  '-o', module, ...objects,
]);

const text = readFileSync(module, 'utf8');
for (const required of ['webts_q3u4_card_start', 'ccall']) {
  if (!text.includes(required)) throw new Error(`q3u4-card.mjs is missing ${required}`);
}
process.stdout.write(`built ${module}\n`);
