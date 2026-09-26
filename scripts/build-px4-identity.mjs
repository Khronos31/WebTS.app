// Builds the PX-Q3U4 identity module from the vendored upstream headers.
// Output goes to build/px4-identity/, which is gitignored; the dev server
// serves it and production packaging is a later concern.

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCompilers, run, version } from './lib/emscripten.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const upstream = join(repoRoot, 'vendor', 'upstream', 'px4-userland', 'userland');
const output = join(repoRoot, 'build', 'px4-identity');
const sources = [
  join(repoRoot, 'native', 'px4-identity.cpp'),
  join(repoRoot, 'native', 'px4-firmware.cpp'),
  // 判定ロジックは上流の実装をそのままリンクする。書き写さない。
  join(upstream, 'src', 'identity.cpp'),
  join(upstream, 'src', 'error.cpp'),
  join(upstream, 'src', 'firmware.cpp'),
  join(upstream, 'src', 'it930x_protocol.cpp'),
];

const { emxx } = findCompilers();
process.stdout.write(`em++: ${version(emxx)}\n`);
mkdirSync(output, { recursive: true });

const module = join(output, 'px4-identity.mjs');
run(emxx, [
  '-O2', '-std=c++20',
  '-I', join(upstream, 'include'),
  // firmware_internal.h と it930x_protocol.h は src/ にある。
  '-I', join(upstream, 'src'),
  '-s', 'MODULARIZE=1', '-s', 'EXPORT_ES6=1', '-s', 'ENVIRONMENT=web,worker,node',
  '-s', 'EXPORTED_RUNTIME_METHODS=["ccall","HEAPU8","HEAP32"]',
  '-s', 'EXPORTED_FUNCTIONS=["_webts_px4_model_count","_webts_px4_model",' +
    '"_webts_px4_model_name","_webts_px4_tuner_key",' +
    '"_webts_px4_identity_output_words","_webts_px4_group_q3u4",' +
    '"_webts_px4_firmware_expected_size","_webts_px4_firmware_expected_sha256",' +
    '"_webts_px4_firmware_find","_webts_px4_firmware_validate","_malloc","_free"]',
  '-o', module, ...sources,
]);

const text = readFileSync(module, 'utf8');
for (const required of ['webts_px4_model_count', 'webts_px4_group_q3u4',
  'webts_px4_firmware_find', 'webts_px4_firmware_validate']) {
  if (!text.includes(required)) throw new Error(`px4-identity.mjs is missing ${required}`);
}
process.stdout.write(`built ${module}\n`);
