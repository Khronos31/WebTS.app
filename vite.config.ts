// Vitest ships its own defineConfig so the `test` block is typed. Importing it
// from 'vite' leaves `test` unknown and fails the typecheck.
import { defineConfig } from 'vitest/config';

// The official libusb WebUSB backend uses pthreads and atomics. These headers
// make the dev and preview servers cross-origin isolated so a SharedArrayBuffer
// build stays possible. Production hosting must reproduce the same contract;
// on Cloudflare Pages that is a `_headers` file.
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
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
