// Locates the Emscripten compilers and runs them.
//
// Resolution order: EMSCRIPTEN_ROOT, then PATH. On CI, mymindstorm/setup-emsdk
// puts emcc and em++ on PATH, so nothing needs configuring there.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const WINDOWS = process.platform === 'win32';
const SUFFIXES = WINDOWS ? ['.exe', '.bat', ''] : [''];

function fromDirectory(directory, name) {
  for (const suffix of SUFFIXES) {
    const candidate = join(directory, name + suffix);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function fromPath(name) {
  const probe = spawnSync(WINDOWS ? 'where' : 'which', [name], { encoding: 'utf8' });
  if (probe.status !== 0) return null;
  const first = probe.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
  return first && existsSync(first) ? first : null;
}

export function findCompilers() {
  const root = process.env.EMSCRIPTEN_ROOT;
  const resolve = (name) => (root ? fromDirectory(root, name) : null) ?? fromPath(name);
  const emcc = resolve('emcc');
  const emxx = resolve('em++');
  if (!emcc || !emxx) {
    throw new Error(
      'Emscripten was not found. Put emcc and em++ on PATH, or set EMSCRIPTEN_ROOT ' +
      'to the directory that holds them.',
    );
  }
  return { emcc, emxx };
}

export function run(executable, args, { cwd, timeoutMs = 600_000 } = {}) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${executable} ${args.slice(0, 4).join(' ')} … failed (${result.status})\n${detail}`);
  }
  return result;
}

export function version(executable) {
  const result = spawnSync(executable, ['--version'], { encoding: 'utf8' });
  return (result.stdout ?? '').split(/\r?\n/)[0]?.trim() ?? 'unknown';
}
