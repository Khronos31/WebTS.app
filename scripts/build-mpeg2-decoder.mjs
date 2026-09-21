// Builds the MPEG-2 video decoder module (libmpeg2 + native/mpeg2-decoder.c).
//
// Pure C, no threads, no Asyncify. Decoding is CPU work with no I/O in it, so
// none of the machinery the USB modules need applies here. The module is built
// for web, worker and node: the browser runs it in a Worker, and
// scripts/mpeg2-decode-benchmark.mjs runs the same binary under Node.
//
// config.h comes from native/libmpeg2-config.h via an include directory of our
// own, placed ahead of the vendored tree. Upstream generates config.h with
// autotools; we are not running autotools for one fixed target.

import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCompilers, run, version } from './lib/emscripten.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const upstream = join(root, 'vendor', 'upstream', 'libmpeg2');
const output = join(root, 'build', 'mpeg2-decoder');
const configDirectory = join(output, 'config');

const SOURCES = [
  'alloc.c', 'cpu_accel.c', 'cpu_state.c', 'decode.c',
  'header.c', 'idct.c', 'motion_comp.c', 'slice.c',
].map((name) => join(upstream, 'libmpeg2', name));

// -fno-strict-aliasing: libmpeg2 is from 2008 and types-punch through uint8_t*
// in the motion compensation and IDCT paths. Upstream's own configure adds it.
const COMMON = ['-O3', '-fno-strict-aliasing', '-std=gnu99'];

const { emcc } = findCompilers();
process.stdout.write(`emcc: ${version(emcc)}\n`);
mkdirSync(configDirectory, { recursive: true });
copyFileSync(join(root, 'native', 'libmpeg2-config.h'), join(configDirectory, 'config.h'));

const include = [
  '-I', configDirectory,
  '-I', join(upstream, 'include'),
  '-I', join(upstream, 'libmpeg2'),
];

const objects = [];
for (const source of [join(root, 'native', 'mpeg2-decoder.c'), ...SOURCES]) {
  const object = join(output, basename(source, '.c') + '.o');
  run(emcc, [...COMMON, ...include, '-c', source, '-o', object]);
  objects.push(object);
}

const module = join(output, 'mpeg2-decoder.mjs');
run(emcc, [
  '-O3', '-s', 'MODULARIZE=1', '-s', 'EXPORT_ES6=1',
  '-s', 'ENVIRONMENT=web,worker,node', '-s', 'ALLOW_MEMORY_GROWTH=1',
  '-s', 'EXPORTED_RUNTIME_METHODS=["ccall","HEAPU8","HEAP32"]',
  '-s', 'EXPORTED_FUNCTIONS=["_webts_mpeg2_open","_webts_mpeg2_close",' +
    '"_webts_mpeg2_feed","_webts_mpeg2_tag","_webts_mpeg2_step","_webts_mpeg2_frame",' +
    '"_webts_mpeg2_frame_words","_webts_mpeg2_sequence",' +
    '"_webts_mpeg2_sequence_words","_webts_mpeg2_frames","_malloc","_free"]',
  '-o', module, ...objects,
]);

const text = readFileSync(module, 'utf8');
for (const required of ['webts_mpeg2_step', 'ccall']) {
  if (!text.includes(required)) throw new Error(`mpeg2-decoder.mjs is missing ${required}`);
}
process.stdout.write(`built ${module}\n`);
