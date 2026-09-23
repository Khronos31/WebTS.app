// Checks the whole history for things that must never be in this repository.
//
// The rule is not "the working tree is clean". Once a blob is pushed it stays
// reachable, so the check has to walk every object in every branch and tag.
//
// What it looks for:
//   - binaries of any kind. Firmware, captured TS, card dumps and executables
//     all arrive as binaries, and nothing in this project legitimately needs
//     one committed.
//   - file names that look like data rather than source.
//
// **Binary is decided by content, not by extension.** Guessing from the suffix
// flagged every PowerShell script and missed the point. A blob counts as
// binary if a NUL byte appears near its start, which is what git itself uses.
//
// It deliberately does not try to judge file contents by heuristics for
// secrets. That produces noise and false confidence. The binary rule is sharp,
// and the vendored source manifest already states that no firmware or capture
// is vendored.

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options,
  });
}

/** データらしい名前。ソースに firmware と付くのは普通なので名前では見ない。 */
const DATA_NAME = /(\.fw$|\.inp$|\.bin$|\.rom$|\.img$|\.pem$|\.key$|\.env$|id_rsa|isdbt_rio)/i;

const listing = git(['rev-list', '--objects', '--all']).split('\n');
const entries = [];
for (const line of listing) {
  const space = line.indexOf(' ');
  if (space < 0) continue;
  entries.push({ oid: line.slice(0, space), path: line.slice(space + 1) });
}

// Ask git for each object's type and size in one pass.
const check = git(['cat-file', '--batch-check=%(objecttype) %(objectname) %(objectsize)'],
  { input: entries.map((entry) => entry.oid).join('\n') }).split('\n');
const size = new Map();
for (const line of check) {
  const [type, oid, bytes] = line.split(' ');
  if (type === 'blob') size.set(oid, Number(bytes));
}

/** NUL が先頭付近にあれば binary。git が同じ判定をしている。 */
function isBinary(oid) {
  const head = execFileSync('git', ['cat-file', 'blob', oid],
    { cwd: root, maxBuffer: 64 * 1024 * 1024 }).subarray(0, 8000);
  return head.includes(0);
}

const binaries = [];
const suspicious = [];
const seen = new Set();
const checked = new Map();
for (const entry of entries) {
  if (!size.has(entry.oid)) continue;
  const key = `${entry.oid}:${entry.path}`;
  if (seen.has(key)) continue;
  seen.add(key);
  if (DATA_NAME.test(entry.path)) suspicious.push(entry);
  if ((size.get(entry.oid) ?? 0) === 0) continue;
  let binary = checked.get(entry.oid);
  if (binary === undefined) {
    binary = isBinary(entry.oid);
    checked.set(entry.oid, binary);
  }
  if (binary) binaries.push({ ...entry, bytes: size.get(entry.oid) ?? 0 });
}

let failed = false;
if (binaries.length > 0) {
  failed = true;
  process.stdout.write(`binaries in history: ${binaries.length}\n`);
  for (const found of binaries.sort((a, b) => b.bytes - a.bytes).slice(0, 20)) {
    process.stdout.write(`  ${found.bytes.toString().padStart(9)}  ${found.path}\n`);
    const where = git(['log', '--oneline', '--all', '--', found.path]).trim();
    for (const line of where.split('\n').filter(Boolean)) {
      process.stdout.write(`             ${line}\n`);
    }
  }
}
if (suspicious.length > 0) {
  failed = true;
  process.stdout.write(`\ndata-like names in history: ${suspicious.length}\n`);
  for (const found of suspicious.slice(0, 20)) {
    process.stdout.write(`  ${found.path}\n`);
  }
}
if (!failed) {
  process.stdout.write(
    `history check passed: ${seen.size} blob paths, no binaries\n`);
}
process.exit(failed ? 1 : 0);
