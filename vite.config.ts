// Vitest ships its own defineConfig so the `test` block is typed. Importing it
// from 'vite' leaves `test` unknown and fails the typecheck.
import {
  cpSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vitest/config';

// The official libusb WebUSB backend uses pthreads and atomics. These headers
// make the dev and preview servers cross-origin isolated so a SharedArrayBuffer
// build stays possible. Production hosting must reproduce the same contract;
// on Cloudflare Pages that is a `_headers` file.
/**
 * 別端末から試すための HTTPS。
 *
 * **証明書はリポジトリに置かない。**環境変数で渡す。Tailscale の
 * `tailscale cert` が出す Let's Encrypt の証明書をそのまま使えるので、
 * 自己署名の警告も CA の導入も要らない。
 *
 *   WEBTS_TLS_CERT=~/home-pc.tailXXXX.ts.net.crt  *   WEBTS_TLS_KEY=~/home-pc.tailXXXX.ts.net.key npm run dev
 *
 * 指定が無ければ平文のまま。手元の localhost はそれで足りる。
 */
function tls() {
  const cert = process.env['WEBTS_TLS_CERT'];
  const key = process.env['WEBTS_TLS_KEY'];
  if (cert === undefined || key === undefined) return {};
  if (!existsSync(cert) || !existsSync(key)) {
    throw new Error(`WEBTS_TLS_CERT / WEBTS_TLS_KEY が読めません: ${cert} / ${key}`);
  }
  return { https: { cert: readFileSync(cert), key: readFileSync(key) } };
}

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
/**
 * WASM の出力を配信物へ入れる。
 *
 * **`build/` は Vite の管理外にある。**Emscripten が吐く場所で、`public/` でも
 * `src/` でもない。dev サーバーはプロジェクト直下を配信するので気づかないが、
 * `vite build` の出力には入らず、本番では `/build/...` が 404 になって
 * アプリが何も動かない。
 *
 * 出力先を `public/` へ移す手もあるが、ビルドスクリプト側の出力パスを全部
 * 書き換えることになる。ここで写すほうが変更が1か所で済む。
 */
/**
 * 配信するのはアプリが読むものだけ。
 *
 * `build/` には開発用のプローブ（カード単体、TS 取得単体、libusb の所有権
 * 検査など）も入っている。**それらは公開物ではない。**入口は index.html
 * だけで、プローブ用の HTML はビルド対象にも入っていない。
 */
const SHIPPED_MODULES = ['mpeg2-decoder', 'px4-identity', 'q3u4-descramble'];

function wasmModules(): Plugin {
  return {
    name: 'webts-wasm-modules',
    apply: 'build',
    closeBundle() {
      const root = import.meta.dirname;
      const to = resolve(root, 'dist', 'build');
      rmSync(to, { recursive: true, force: true });
      for (const name of SHIPPED_MODULES) {
        const from = resolve(root, 'build', name);
        if (!existsSync(from)) {
          throw new Error(`build/${name} がありません。`
            + `npm run build:${name === 'mpeg2-decoder' ? 'mpeg2' : name} を先に走らせてください。`);
        }
        // **`.mjs` と `.wasm` だけ。**同じ場所に中間生成物が残っている。
        // `patched/` のオブジェクトファイル（1モジュールあたり 1.4 MB）と、
        // リンカが残す `.wasm.tmp0` である。前者は配る意味が無く、後者は
        // 掴めずに copy が失敗する。
        mkdirSync(resolve(to, name), { recursive: true });
        for (const file of readdirSync(from)) {
          if (!file.endsWith('.mjs') && !file.endsWith('.wasm')) continue;
          cpSync(resolve(from, file), resolve(to, name, file));
        }
      }
    },
  };
}

/**
 * データ放送のフォント（web-bml-fonts、Apache-2.0）のライセンスを配信物へ添える。
 *
 * フォント本体は `?url` の import で `assets/` へ出る。Apache-2.0 は受け取った人に
 * ライセンス本文を渡すことを求めるので、同じ配信物へ入れる。README には、
 * 太丸ゴシックが原本を機械的に太らせた派生物であることが書いてある
 * （第4条(b)の変更告知にあたる）。
 */
function fontLicenses(): Plugin {
  return {
    name: 'webts-font-licenses',
    apply: 'build',
    closeBundle() {
      const root = import.meta.dirname;
      const from = resolve(root, 'node_modules', 'web-bml-fonts');
      const to = resolve(root, 'dist', 'licenses', 'web-bml-fonts');
      mkdirSync(to, { recursive: true });
      for (const file of ['LICENSE.txt', 'AUTHORS.txt', 'README.md']) {
        cpSync(resolve(from, file), resolve(to, file));
      }
    },
  };
}

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
  plugins: [localCapture(), wasmModules(), fontLicenses()],
  resolve: {
    alias: [
      // **Apache-2.0 の `crc-32` を成果物へ入れない。**web-bml が PNG の CRC に
      // 使うだけなので、同じ値を返す自前の実装へ向ける（src/bml/crc32.ts）。
      { find: /^crc-32$/, replacement: resolve(import.meta.dirname, 'src/bml/crc32.ts') },
    ],
  },
  // web-bml は Worker と、呼ばれてから読む動的 import からしか使わないので、
  // dev サーバーの事前走査では見つからない。途中で見つかると依存を束ね直して
  // ページを読み直すので、最初から束ねておく。
  optimizeDeps: { include: ['web-bml', 'web-bml/ts'] },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
  // **LAN へ出す。**既定では localhost にしか bind せず、別の端末から届かない。
  //
  // ただし届くだけでは足りない。`http://` の LAN アドレスはセキュア
  // コンテキストではないので、`navigator.usb` も SharedArrayBuffer も
  // 生えない。別端末から実機を試すには HTTPS が要る。
  server: { host: true, headers: crossOriginIsolation, ...tls() },
  preview: { host: true, headers: crossOriginIsolation, ...tls() },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
