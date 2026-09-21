// Vitest ships its own defineConfig so the `test` block is typed. Importing it
// from 'vite' leaves `test` unknown and fails the typecheck.
import { createReadStream, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vitest/config';

// The official libusb WebUSB backend uses pthreads and atomics. These headers
// make the dev and preview servers cross-origin isolated so a SharedArrayBuffer
// build stays possible. Production hosting must reproduce the same contract;
// on Cloudflare Pages that is a `_headers` file.
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// Development-only. Lets a page hand a file to the machine running the dev
// server, which is the same machine the browser is on.
//
// POST writes a file, GET reads one back. Reading has to go through here too,
// because a captured stream is named .ts and Vite would otherwise try to
// transform it as TypeScript.
//
// This exists because browser downloads are awkward to drive while developing
// -- a save dialog or a download shelf gets in the way -- and because captures
// taken for demux work have to land somewhere predictable. It touches only
// local/, which is gitignored, and only under a sanitised name. `apply: 'serve'`
// keeps it out of any build, and the dev server is bound to localhost, so
// nothing here is reachable from outside this machine.
function localCapture(): Plugin {
  const directory = resolve(import.meta.dirname, 'local');
  return {
    name: 'webts-local-capture',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__local-capture', (request, response) => {
        if (request.method !== 'POST' && request.method !== 'GET') {
          response.statusCode = 405;
          response.end('GET or POST only');
          return;
        }
        const query = new URL(request.url ?? '/', 'http://localhost');
        const requested = query.searchParams.get('name') ?? 'capture.ts';
        // Names come from a page, so take only what is unmistakably a
        // basename: no separators, no dots leading a traversal.
        const name = requested.replaceAll(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
        if (name === '' || !name.endsWith('.ts')) {
          response.statusCode = 400;
          response.end('name must be a simple basename ending in .ts');
          return;
        }
        if (request.method === 'GET') {
          try {
            const path = join(directory, name);
            response.statusCode = 200;
            response.setHeader('Content-Type', 'video/mp2t');
            response.setHeader('Content-Length', String(statSync(path).size));
            createReadStream(path).pipe(response);
          } catch (error) {
            response.statusCode = 404;
            response.end(error instanceof Error ? error.message : String(error));
          }
          return;
        }
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          try {
            mkdirSync(directory, { recursive: true });
            const path = join(directory, name);
            writeFileSync(path, Buffer.concat(chunks));
            response.statusCode = 200;
            response.end(path);
          } catch (error) {
            response.statusCode = 500;
            response.end(error instanceof Error ? error.message : String(error));
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [localCapture()],
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
