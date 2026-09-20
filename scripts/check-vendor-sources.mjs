// Verifies the committed vendor tree against vendor/SOURCE_LOCK.json.
// Runs in CI and needs no network: it checks the bytes on disk, not upstream.
// Refreshing the lock from upstream is scripts/vendor-sync.mjs, a separate
// developer-only tool.
//
// Failures:
//   - a locked file is missing, or its bytes changed since the lock was written
//   - vendor/upstream holds a file the lock does not list
//   - a file marked modified has no entry in the patch file, or vice versa

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendorRoot = join(repoRoot, 'vendor');
const upstreamRoot = join(vendorRoot, 'upstream');
const lockPath = join(vendorRoot, 'SOURCE_LOCK.json');

const problems = [];
const fail = (message) => problems.push(message);

if (!existsSync(lockPath)) {
  process.stderr.write('vendor/SOURCE_LOCK.json is missing. Run: node scripts/vendor-sync.mjs\n');
  process.exit(1);
}
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));

async function walk(root, current = root, found = []) {
  if (!existsSync(current)) return found;
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const full = join(current, entry.name);
    if (entry.isDirectory()) await walk(root, full, found);
    else if (entry.isFile()) found.push(relative(root, full).split(sep).join('/'));
  }
  return found;
}

const expected = new Set();
let checked = 0;
let modified = 0;

for (const source of lock.sources) {
  const sourceRoot = join(repoRoot, ...source.root.split('/'));
  if (source.files.length !== source.fileCount) {
    fail(`${source.name}: fileCount says ${source.fileCount} but the list holds ${source.files.length}`);
  }
  const patchPath = join(vendorRoot, 'PATCHES', `${source.name}.diff`);
  const patch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '';
  let modifiedHere = 0;

  for (const file of source.files) {
    const parts = file.path.split('/');
    expected.add([source.name, ...parts].join('/'));
    const full = join(sourceRoot, ...parts);
    if (!existsSync(full)) {
      fail(`${source.name}: ${file.path} is listed in the lock but missing from the tree`);
      continue;
    }
    const actual = createHash('sha256').update(readFileSync(full)).digest('hex');
    if (actual !== file.vendoredSha256) {
      fail(`${source.name}: ${file.path} does not match the lock (${actual.slice(0, 12)} != ${file.vendoredSha256.slice(0, 12)})`);
    }
    checked += 1;

    const isModified = file.upstreamSha256 !== file.vendoredSha256;
    if (isModified !== Boolean(file.modified)) {
      fail(`${source.name}: ${file.path} has an inconsistent modified flag`);
    }
    if (isModified) {
      modifiedHere += 1;
      modified += 1;
      // A modified file must be reviewable: it needs a recorded diff and a
      // change notice, because the upstream licences require stating changes.
      if (!patch.includes(`diff for ${file.path}`)) {
        fail(`${source.name}: ${file.path} is modified but absent from vendor/PATCHES/${source.name}.diff`);
      }
      if (!readFileSync(full, 'utf8').includes('WebTS.app project')) {
        fail(`${source.name}: ${file.path} is modified but carries no change notice`);
      }
    }
  }

  if (modifiedHere !== source.modifiedCount) {
    fail(`${source.name}: modifiedCount says ${source.modifiedCount} but ${modifiedHere} files differ from upstream`);
  }
  if (modifiedHere === 0 && existsSync(patchPath)) {
    fail(`${source.name}: nothing is modified but vendor/PATCHES/${source.name}.diff exists`);
  }
}

for (const path of await walk(upstreamRoot)) {
  if (!expected.has(path)) fail(`vendor/upstream/${path} is not listed in the lock`);
}

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`  ${problem}\n`);
  process.stderr.write(`vendor check failed: ${problems.length} problem(s)\n`);
  process.exit(1);
}

process.stdout.write(
  `vendor check passed: ${lock.sources.length} sources, ${checked} files, ${modified} modified\n`,
);
for (const source of lock.sources) {
  process.stdout.write(
    `  ${source.name.padEnd(14)} ${source.commit.slice(0, 12)}  ${String(source.license).padEnd(18)} ` +
    `${String(source.fileCount).padStart(3)} files, ${source.modifiedCount} modified\n`,
  );
}
