// Builds the ownership regression as opt-in Dedicated Worker modules, one per
// libusb variant, for the dev-only fixture page at /libusb-ownership.html.
//
// Unlike the Node regression these are browser modules, but they are built the
// same way in every other respect: pthreads and shared memory, because the
// unmodified events_posix.c reaches Atomics.waitAsync on HEAP32 and cannot run
// without it. That is also why the page needs cross-origin isolation, which
// vite.config.ts and public/_headers provide.
//
// Output is under build/, which is gitignored. These modules are test-only and
// are never packaged into dist/.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCompilers, run, version } from './lib/emscripten.mjs';
import { C_SOURCES, CXX_SOURCES, VARIANTS, prepareVariant } from './lib/libusb-variants.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = join(repoRoot, 'build', 'libusb-ownership-browser');
const harness = join(repoRoot, 'test', 'native', 'libusb-ownership-regression.cpp');

const COMMON = [
  '-O0',
  '-DPLATFORM_POSIX=1',
  '-DOS_EMSCRIPTEN=1',
  '-DENABLE_LOGGING=1',
  '-pthread',
];

const { emcc, emxx } = findCompilers();
process.stdout.write(`emcc: ${version(emcc)}\n`);
mkdirSync(buildRoot, { recursive: true });

const built = [];
for (const variant of VARIANTS) {
  process.stdout.write(`building ${variant}…\n`);
  const { root, src, includes } = prepareVariant(repoRoot, buildRoot, variant);
  const include = includes.flatMap((directory) => ['-I', directory]);
  // The observation counters exist only where the ownership change is present.
  const hooks = variant === 'stock' ? [] : ['-DWEBTS_LIBUSB_TEST_HOOKS=1'];
  const objects = [];

  for (const relativePath of C_SOURCES) {
    const object = join(root, relativePath.replaceAll('/', '_') + '.o');
    run(emcc, [...COMMON, ...include, '-c', join(src, ...relativePath.split('/')), '-o', object]);
    objects.push(object);
  }
  for (const relativePath of [...CXX_SOURCES]) {
    const object = join(root, relativePath.replaceAll('/', '_') + '.o');
    run(emxx, [...COMMON, ...hooks, ...include, '-std=c++20', '-c',
      join(src, ...relativePath.split('/')), '-o', object]);
    objects.push(object);
  }
  const harnessObject = join(root, 'harness.o');
  run(emxx, [...COMMON, ...hooks, ...include, '-std=c++20', '-c', harness, '-o', harnessObject]);

  const moduleName = `libusb-ownership-${variant}.mjs`;
  const module = join(buildRoot, moduleName);
  run(emxx, [
    // Shared memory without a pthread pool. The harness starts no threads, and
    // an eager pool makes the module wait forever on 'loading-workers' when it
    // is itself loaded inside a Dedicated Worker.
    '--bind', '-pthread', '-s', 'SHARED_MEMORY=1', '-s', 'PTHREAD_POOL_SIZE=0',
    '-s', 'ASYNCIFY=1', '-s', 'ASSERTIONS=2', '-s', 'MODULARIZE=1',
    '-s', 'EXPORT_ES6=1', '-s', 'ENVIRONMENT=web,worker',
    '-s', 'ALLOW_MEMORY_GROWTH=1',
    '-s', 'EXPORTED_RUNTIME_METHODS=["ccall","HEAPU8"]',
    '-s', 'EXPORTED_FUNCTIONS=["_webts_libusb_ownership_regression","_malloc","_free"]',
    '-o', module, harnessObject, ...objects,
  ]);

  const text = readFileSync(module, 'utf8');
  for (const required of ['webts_libusb_ownership_regression', 'ccall']) {
    if (!text.includes(required)) throw new Error(`${moduleName} is missing ${required}`);
  }
  built.push(moduleName);
  process.stdout.write(`  ${moduleName}\n`);
}

writeFileSync(join(buildRoot, 'variants.json'), JSON.stringify(VARIANTS, null, 2) + '\n');
process.stdout.write(`\nbuilt ${built.length} Worker modules under build/libusb-ownership-browser/\n`);
process.stdout.write('open http://localhost:5173/libusb-ownership.html after npm run dev\n');
