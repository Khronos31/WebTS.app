// Developer tool. Fetches every pinned upstream source, copies the selected
// files into vendor/upstream/, and writes vendor/SOURCE_LOCK.json.
//
// This needs network access and is NOT part of the build or CI. CI runs
// scripts/check-vendor-sources.mjs instead, which verifies the committed tree
// against the lock without touching the network.
//
// Local modifications to vendored files are preserved: a file already present
// whose hash differs from upstream is treated as intentionally modified, and
// both its upstream and vendored hashes are recorded. Pass --restore to
// discard modifications and take the upstream bytes instead.
// A readable diff of every modified file is written to vendor/PATCHES/.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendorRoot = join(repoRoot, 'vendor');
const upstreamRoot = join(vendorRoot, 'upstream');
const patchRoot = join(vendorRoot, 'PATCHES');
const restore = process.argv.includes('--restore');

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function git(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr || result.stdout}`);
  }
  return result;
}

/** Fetch exactly one commit with upstream bytes, no line-ending translation. */
function checkout(source, into) {
  mkdirSync(into, { recursive: true });
  git(into, ['init', '-q']);
  git(into, ['config', 'core.autocrlf', 'false']);
  git(into, ['config', 'core.eol', 'lf']);
  git(into, ['remote', 'add', 'origin', source.origin]);
  const shallow = git(into, ['fetch', '-q', '--depth', '1', 'origin', source.commit], { allowFailure: true });
  if (shallow.status === 0) {
    git(into, ['checkout', '-q', 'FETCH_HEAD']);
  } else {
    git(into, ['fetch', '-q', 'origin']);
    git(into, ['checkout', '-q', source.commit]);
  }
  const head = git(into, ['rev-parse', 'HEAD']).stdout.trim();
  if (head !== source.commit) {
    throw new Error(`${source.name}: checked out ${head}, expected ${source.commit}`);
  }
}

async function walk(root, current = root, found = []) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const full = join(current, entry.name);
    if (entry.isDirectory()) await walk(root, full, found);
    else if (entry.isFile()) found.push(relative(root, full).split(sep).join('/'));
  }
  return found;
}

/** Only '**' (any depth) and '*' (one segment) are supported. */
function toRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') { out += '.*'; i += 1; if (pattern[i + 1] === '/') i += 1; }
      else out += '[^/]*';
    } else if ('.+?^${}()|[]\\'.includes(c)) out += '\\' + c;
    else out += c;
  }
  return new RegExp(`^${out}$`);
}

function select(allFiles, source) {
  const include = (source.include ?? []).map(toRegExp);
  const exclude = (source.exclude ?? []).map(toRegExp);
  const chosen = allFiles
    .filter((f) => include.some((r) => r.test(f)))
    .filter((f) => !exclude.some((r) => r.test(f)))
    .sort();
  // A literal entry that matches nothing is a mistake in the manifest, not an
  // empty result: fail loudly rather than silently vendoring less.
  for (const pattern of source.include ?? []) {
    if (pattern.includes('*')) continue;
    if (!chosen.includes(pattern)) {
      throw new Error(`${source.name}: manifest lists ${pattern}, which is not in the upstream tree`);
    }
  }
  if (chosen.length === 0) throw new Error(`${source.name}: selection is empty`);
  return chosen;
}

const manifest = JSON.parse(readFileSync(join(vendorRoot, 'sources.json'), 'utf8'));
const workRoot = await mkdtemp(join(tmpdir(), 'webts-vendor-'));
const lock = {
  schema: 2,
  generatedBy: 'scripts/vendor-sync.mjs',
  note: [
    'upstreamSha256 is the byte hash of the file as published upstream at the',
    'pinned commit. vendoredSha256 is the byte hash of the copy in this',
    'repository. They differ only where modified is true; those files carry a',
    'change notice and their diff lives in vendor/PATCHES/.',
  ],
  sources: [],
};

try {
  for (const source of manifest.sources) {
    const work = join(workRoot, source.name);
    process.stdout.write(`${source.name}: fetching ${source.commit.slice(0, 12)}\n`);
    checkout(source, work);

    const chosen = select(await walk(work), source);
    const destRoot = join(upstreamRoot, source.name);
    const files = [];
    let modifiedCount = 0;

    for (const path of chosen) {
      const upstreamBuffer = readFileSync(join(work, path));
      const dest = join(destRoot, ...path.split('/'));
      let vendoredBuffer = upstreamBuffer;
      let modified = false;

      if (!restore && existsSync(dest)) {
        const existing = readFileSync(dest);
        if (!existing.equals(upstreamBuffer)) {
          vendoredBuffer = existing;
          modified = true;
          modifiedCount += 1;
        }
      }
      if (!existsSync(dest) || !readFileSync(dest).equals(vendoredBuffer)) {
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, vendoredBuffer);
      }
      files.push({
        path,
        upstreamSha256: sha256(upstreamBuffer),
        vendoredSha256: sha256(vendoredBuffer),
        ...(modified ? { modified: true } : {}),
      });
    }

    // Record the delta against upstream so the modification is reviewable in
    // this repository, and so it can be offered upstream unchanged.
    const patchFile = join(patchRoot, `${source.name}.diff`);
    if (modifiedCount > 0) {
      // Produce a diff that `git apply` accepts, with paths relative to the
      // source root under the usual a/ and b/ prefixes. The build reverses it
      // to reconstruct the pristine upstream tree without needing network.
      const stage = join(workRoot, `${source.name}-diff`);
      const chunks = [];
      for (const file of files.filter((f) => f.modified)) {
        const parts = file.path.split('/');
        for (const [side, from] of [['a', work], ['b', destRoot]]) {
          const to = join(stage, side, ...parts);
          mkdirSync(dirname(to), { recursive: true });
          writeFileSync(to, readFileSync(join(from, ...parts)));
        }
        const diff = spawnSync('git', [
          'diff', '--no-index', '--no-color', '--src-prefix=', '--dst-prefix=',
          `a/${file.path}`, `b/${file.path}`,
        ], { cwd: stage, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        if (diff.status !== 1) {
          throw new Error(`${source.name}: expected a diff for ${file.path}, git exited ${diff.status}`);
        }
        chunks.push(diff.stdout);
      }
      mkdirSync(patchRoot, { recursive: true });
      writeFileSync(patchFile, chunks.join(''));
      process.stdout.write(`${source.name}: wrote ${relative(repoRoot, patchFile)}
`);
    } else if (existsSync(patchFile)) {
      rmSync(patchFile);
    }

    lock.sources.push({
      name: source.name,
      origin: source.origin,
      ref: source.ref ?? null,
      commit: source.commit,
      license: source.license,
      root: posix.join('vendor/upstream', source.name),
      fileCount: files.length,
      modifiedCount,
      files,
    });
    process.stdout.write(`${source.name}: ${files.length} files, ${modifiedCount} modified\n`);
  }

  writeFileSync(join(vendorRoot, 'SOURCE_LOCK.json'), JSON.stringify(lock, null, 2) + '\n');
  process.stdout.write(`wrote vendor/SOURCE_LOCK.json (${lock.sources.length} sources)\n`);
} finally {
  rmSync(workRoot, { recursive: true, force: true });
}
