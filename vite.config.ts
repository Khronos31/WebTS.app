/// <reference types="vitest" />
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      // Keep the M1 diagnostic opt-in as a separate entry; the M0 index is
      // unchanged and never imports the diagnostic or WASM loader.
      input: {
        main: 'index.html',
        m1: 'm1.html',
        px4WorkerFixture: 'px4-worker-fixture.html',
      },
    },
  },
  // Emscripten's official WebUSB backend uses pthread/atomics. These headers
  // are scoped to the Vite dev/preview server; production hosting is a later
  // deployment concern and must preserve the same isolation contract.
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
