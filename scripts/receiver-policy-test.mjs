// 受信機の割り当て（native/px4-receiver-policy.h）の試験を Emscripten で
// 組み、Node で走らせる。USB も backend も使わない。
//
// `npm run check` には入れていない。WASM のビルドと同じく Emscripten が要る。

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCompilers, run, version } from './lib/emscripten.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'build', 'receiver-policy-test');
mkdirSync(output, { recursive: true });

const { emcc, emxx } = findCompilers();
process.stdout.write(`emcc: ${version(emcc)}\n`);

const program = join(output, 'receiver-policy-test.cjs');
run(emxx, ['-O1', '-std=c++20', '-I', join(root, 'native'),
  '-s', 'ENVIRONMENT=node', '-s', 'EXIT_RUNTIME=1',
  join(root, 'test', 'native', 'receiver-policy-test.cpp'), '-o', program]);

const result = spawnSync(process.execPath, [program], { encoding: 'utf8' });
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
