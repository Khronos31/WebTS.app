// Source-bound regression for the libusb transfer-ownership fix.
//
// Links the same harness twice against the pinned libusb core and backend:
// once against the pristine upstream tree (the failure baseline) and once
// against the vendored tree carrying the WebTS.app changes. Every scenario
// runs in its own bounded Node child, because an unmet expectation parks
// libusb state on purpose and the module instance must not be reused.
//
// The only USB surface is a fake navigator.usb installed inside the module.
// No real device, firmware, mode, tune, TS or B25 path is involved.

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCompilers, run, version } from './lib/emscripten.mjs';
import { C_SOURCES, CXX_SOURCES, VARIANTS, prepareVariant } from './lib/libusb-variants.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = join(repoRoot, 'build', 'libusb-ownership');
const harness = join(repoRoot, 'test', 'native', 'libusb-ownership-regression.cpp');
const runner = join(repoRoot, 'test', 'native', 'libusb-ownership-runner.mjs');

const SCENARIOS = Object.freeze([
  'pending-cancel-bounded',
  'late-resolve-after-cancel',
  'late-reject-after-cancel',
  'user-free-then-late-resolve',
  'double-cancel',
  'disconnect-while-pending',
  'multi-handle-cancel-close',
  'natural-completion',
  'disconnect-user-free-then-late-resolve',
  'cancel-then-disconnect-before-events',
]);

// Scenario 7 is the regression guard: ordinary completion must keep working on
// both variants. Every other scenario is a stock failure baseline.
const GUARD = SCENARIOS.indexOf('natural-completion');

const COMMON = [
  '-O0',
  '-DPLATFORM_POSIX=1',
  '-DOS_EMSCRIPTEN=1',
  '-DENABLE_LOGGING=1',
  // Built with pthreads so memory is shared. Stock events_posix.c reaches
  // Atomics.waitAsync on HEAP32, which throws on a non-shared typed array, so
  // the unmodified baseline cannot even start without this. Note that the
  // browser Worker build is a no-pthread one; see docs/FINDINGS.md section 2.
  '-pthread',
];

const timeoutMs = Number(process.env.WEBTS_REGRESSION_TIMEOUT_MS ?? 30_000);
const { emcc, emxx } = findCompilers();
process.stdout.write(`emcc: ${version(emcc)}\n`);

function build(variant) {
  const { root, src, includes } = prepareVariant(repoRoot, buildRoot, variant);
  const objects = [];
  const include = includes.flatMap((directory) => ['-I', directory]);

  for (const relativePath of C_SOURCES) {
    const object = join(root, relativePath.replaceAll('/', '_') + '.o');
    run(emcc, [...COMMON, ...include, '-c', join(src, ...relativePath.split('/')), '-o', object]);
    objects.push(object);
  }
  for (const relativePath of CXX_SOURCES) {
    const object = join(root, relativePath.replaceAll('/', '_') + '.o');
    // The observation counters only exist in the patched backend.
    const hooks = variant === 'patched' ? ['-DWEBTS_LIBUSB_TEST_HOOKS=1'] : [];
    run(emxx, [...COMMON, ...hooks, ...include, '-std=c++20', '-c',
      join(src, ...relativePath.split('/')), '-o', object]);
    objects.push(object);
  }

  const harnessObject = join(root, 'harness.o');
  const hooks = variant === 'patched' ? ['-DWEBTS_LIBUSB_TEST_HOOKS=1'] : [];
  run(emxx, [...COMMON, ...hooks, ...include, '-std=c++20', '-c', harness, '-o', harnessObject]);

  const module = join(root, `libusb-ownership-${variant}.mjs`);
  run(emxx, [
    '--bind', '-pthread', '-s', 'SHARED_MEMORY=1', '-s', 'PTHREAD_POOL_SIZE=1',
    '-s', 'ASYNCIFY=1', '-s', 'ASSERTIONS=2', '-s', 'MODULARIZE=1',
    '-s', 'EXPORT_ES6=1', '-s', 'ENVIRONMENT=node',
    '-s', 'EXPORTED_RUNTIME_METHODS=["ccall","HEAPU8"]',
    '-s', 'EXPORTED_FUNCTIONS=["_webts_libusb_ownership_regression","_malloc","_free"]',
    '-o', module, harnessObject, ...objects,
  ]);
  return module;
}

function invoke(module, scenario) {
  const child = spawnSync(process.execPath, [runner, module, String(scenario)], {
    encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
  });
  if (child.error?.code === 'ETIMEDOUT') return { outcome: 'TIMEOUT' };
  if (child.status !== 0) return { outcome: 'CHILD_FAILED', stderr: child.stderr };
  const line = (child.stdout ?? '').split(/\r?\n/).reverse().find((l) => l.trim().startsWith('{'));
  if (!line) return { outcome: 'NO_REPORT', stderr: child.stderr };
  return { outcome: 'REPORTED', report: JSON.parse(line), stderr: child.stderr };
}

mkdirSync(buildRoot, { recursive: true });
const modules = {};
for (const variant of VARIANTS) {
  process.stdout.write(`building ${variant}…\n`);
  modules[variant] = build(variant);
}

const failures = [];
const rows = [];
for (let scenario = 0; scenario < SCENARIOS.length; scenario += 1) {
  const results = {};
  for (const variant of VARIANTS) {
    const result = invoke(modules[variant], scenario);
    results[variant] = result.outcome === 'REPORTED' ? result.report.diagnostic : result.outcome;
    if (variant === 'patched') {
      if (result.outcome === 'REPORTED' && result.stderr?.trim()) {
        failures.push(`scenario ${scenario}: the patched child wrote to stderr`);
      }
      rows.push({ scenario, name: SCENARIOS[scenario], ...results, report: result.report ?? null });
    }
  }

  if (scenario === GUARD) {
    for (const variant of VARIANTS) {
      if (results[variant] !== 'OK') {
        failures.push(`scenario ${scenario} (${SCENARIOS[scenario]}): ${variant} regressed ordinary completion (${results[variant]})`);
      }
    }
  } else {
    if (results.stock === 'OK') {
      failures.push(`scenario ${scenario} (${SCENARIOS[scenario]}): stock unexpectedly satisfied the expectations`);
    }
    if (results.patched !== 'OK') {
      failures.push(`scenario ${scenario} (${SCENARIOS[scenario]}): patched did not satisfy the expectations (${results.patched})`);
    }
  }
}

const width = Math.max(...SCENARIOS.map((name) => name.length));
process.stdout.write(`\n${'scenario'.padEnd(width + 3)}stock          patched\n`);
for (const row of rows) {
  process.stdout.write(
    `${String(row.scenario).padStart(2)} ${row.name.padEnd(width)} ${String(row.stock).padEnd(14)} ${row.patched}\n`,
  );
}

if (failures.length > 0) {
  process.stderr.write('\n');
  for (const failure of failures) process.stderr.write(`  ${failure}\n`);
  process.stderr.write(`libusb ownership regression failed: ${failures.length} problem(s)\n`);
  process.exit(1);
}

process.stdout.write(
  `\nlibusb ownership regression passed: ${SCENARIOS.length} scenarios, ` +
  'stock is the failure baseline for all but the guard. ' +
  'No real USB was used and no physical abort is claimed.\n',
);
