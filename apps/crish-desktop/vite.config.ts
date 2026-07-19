import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Dev 代理：浏览器无法直连供应商 API（CORS）时，
 * 由 Vite 进程代发请求（与聊天走 daemon 同理，服务端出站无 CORS）。
 *
 * POST /__crish_http_proxy
 * body: { url, method, headers?, body? }
 */
function crishHttpProxyPlugin(): Plugin {
  return {
    name: 'crish-http-proxy',
    configureServer(server) {
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (!req.url?.startsWith('/__crish_http_proxy')) {
          next();
          return;
        }
        if (req.method === 'OPTIONS') {
          res.statusCode = 204;
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
          res.end();
          return;
        }
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('Method Not Allowed');
          return;
        }

        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(Buffer.from(c)));
        req.on('end', async () => {
          try {
            const raw = Buffer.concat(chunks).toString('utf8') || '{}';
            const payload = JSON.parse(raw) as {
              url?: string;
              method?: string;
              headers?: Record<string, string>;
              body?: string | null;
            };
            const url = String(payload.url || '').trim();
            const method = String(payload.method || 'GET').toUpperCase();
            if (!/^https?:\/\//i.test(url)) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok: false, status: 0, body: 'url must be http(s)' }));
              return;
            }
            if (!['GET', 'POST', 'HEAD'].includes(method)) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok: false, status: 0, body: 'unsupported method' }));
              return;
            }

            const headers: Record<string, string> = { ...(payload.headers || {}) };
            if (method === 'GET' || method === 'HEAD') {
              delete headers['Content-Type'];
              delete headers['content-type'];
            }

            const init: RequestInit = { method, headers };
            if (method === 'POST' && payload.body != null) {
              init.body = payload.body;
            }

            const upstream = await fetch(url, init);
            const text = await upstream.text();
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                ok: upstream.ok,
                status: upstream.status,
                body: text,
              }),
            );
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                ok: false,
                status: 0,
                body: '',
                error: msg,
              }),
            );
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), crishHttpProxyPlugin()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5174,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-zustand': ['zustand', 'immer'],
          'vendor-lucide': ['lucide-react'],
          'vendor-highlight': ['highlight.js'],
          'vendor-fonts': [
            '@fontsource/inter',
            '@fontsource/jetbrains-mono',
            '@fontsource/ibm-plex-sans',
            '@fontsource/ibm-plex-mono',
          ],
          'vendor-workers': [
            './src/workers/render-worker.ts',
            './src/workers/compute-worker.ts',
            './src/workers/io-worker.ts',
          ],
        },
      },
    },
  },
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_'],
});
