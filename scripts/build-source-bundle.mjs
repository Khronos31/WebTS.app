// Produces the corresponding source bundle.
//
// The shipped WASM is built from GPL-2.0 code (px4-userland, libmpeg2) and
// LGPL code (libusb), so whoever receives the binary has to be able to get the
// source it was built from. The repository is that source, but "go look at the
// repository" is not an offer — a specific archive for a specific build is.
//
// `git archive` is used rather than copying the working tree: it emits exactly
// what is committed at that revision, so the bundle cannot quietly include an
// untracked file, and it reproduces from the revision alone.
//
// **The bundle is the source, not the build.** dist/ and build/ are excluded by
// .gitattributes export-ignore if set; nothing generated is added here.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

const commit = git(['rev-parse', 'HEAD']);
const short = commit.slice(0, 12);

// **汚れた作業ツリーから作らない。**コミットされていない変更が入った
// バイナリに対して、その変更を含まない bundle を配ることになる。
const dirty = git(['status', '--porcelain']);
if (dirty.length > 0) {
  process.stderr.write(
    'working tree is not clean; commit or stash before building the bundle:\n');
  process.stderr.write(`${dirty}\n`);
  process.exit(1);
}

const name = `${pkg.name}-${pkg.version}-${short}-src.tar.gz`;
const output = join(root, 'dist', name);
mkdirSync(dirname(output), { recursive: true });

git(['archive', '--format=tar.gz', `--prefix=${pkg.name}-${short}/`,
  '-o', output, commit]);

const digest = createHash('sha256').update(readFileSync(output)).digest('hex');
process.stdout.write(`wrote ${output}\n`);
process.stdout.write(`commit: ${commit}\n`);
process.stdout.write(`bytes: ${statSync(output).size}  sha256: ${digest}\n`);
