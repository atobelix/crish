import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * CSP 单一真源（06-步骤3 / T-G 批次 7.2）：
 * - dev 宽松串 = 原 index.html 静态 meta 字面等价（HMR/供应商代理依赖，零变化）；
 * - prod 严格串 = 原 tauri.conf.json security.csp 逐指令迁移，并做三处修正：
 *   · script-src 追加内联主题/字体预载 script 的 sha256 hash（构建期自动计算）；
 *   · 移除 'wasm-unsafe-eval'（当前无 wasm 依赖；引入时回填，见 07-engineering-detail 附录 B）；
 *   · connect-src 含 http://ipc.localhost（tauri v2 IPC http 形态，现串一致）。
 * 切换点登记（isolation pattern / wasm / 新远程面）见 07-engineering-detail 附录 B。
 */
const DEV_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  "connect-src 'self' ipc: http: https: ws: wss:;";

const PROD_CSP_BASE =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "font-src 'self' data:; img-src 'self' data: blob: asset: http://asset.localhost https://asset.localhost; " +
  "media-src 'self' data: blob: asset: http://asset.localhost https://asset.localhost; " +
  "connect-src 'self' ipc: http://ipc.localhost http://localhost:8765 http://127.0.0.1:8765 ws://localhost:8765 ws://127.0.0.1:8765; " +
  "worker-src 'self' blob:; frame-src 'self' asset: http://asset.localhost https://asset.localhost; " +
  "frame-ancestors 'self'; form-action 'self'; object-src 'none'; base-uri 'self'";

function cspPlugin(): Plugin {
  return {
    name: 'crish-csp',
    transformIndexHtml(html, ctx) {
      // dev 有 server 上下文（vite serve），build 无 → 按 mode 注入（唯一真源两端成立）
      const isDev = !!ctx.server;
      let content: string;
      if (isDev) {
        content = DEV_CSP;
      } else {
        // 对 html 中无 src 的内联 <script> 计算 sha256（静态内容 hash 稳定；
        // 未来内联 script 变更则 hash 自动跟随，无人工同步点）
        const hashes: string[] = [];
        const inlineRe = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
        let m: RegExpExecArray | null;
        while ((m = inlineRe.exec(html))) {
          hashes.push(
            `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`,
          );
        }
        content = PROD_CSP_BASE.replace(
          "script-src 'self'",
          `script-src 'self'${hashes.length ? ' ' + hashes.join(' ') : ''}`,
        );
      }
      return {
        html,
        tags: [
          {
            tag: 'meta',
            attrs: {
              'http-equiv': 'Content-Security-Policy',
              content,
            },
            injectTo: 'head',
          },
        ],
      };
    },
  };
}

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
      server.middlewares.use(
        (req: IncomingMessage, res: ServerResponse, next: () => void) => {
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
                res.end(
                  JSON.stringify({
                    ok: false,
                    status: 0,
                    body: 'url must be http(s)',
                  })
                );
                return;
              }
              if (!['GET', 'POST', 'HEAD'].includes(method)) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(
                  JSON.stringify({
                    ok: false,
                    status: 0,
                    body: 'unsupported method',
                  })
                );
                return;
              }

              const headers: Record<string, string> = {
                ...(payload.headers || {}),
              };
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
                })
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
                })
              );
            }
          });
        }
      );
    },
  };
}

/**
 * MCP SDK stdio transport 会拉入 Node 内置（node:stream / child_process 等）。
 * 浏览器生产构建无法解析；对 node: 协议与 MCP SDK 引入的 bare builtin
 * 提供最小 stub，让 Rollup 完成打包。运行时 stdio 由 mcpClient 在非桌面环境拒绝。
 * 不全局 stub `events`/`buffer` 等 bare 名，避免覆盖 npm 浏览器 polyfill 包。
 */
function nodeBuiltinStubPlugin(): Plugin {
  const bareFromMcp = new Set([
    'stream',
    'fs',
    'path',
    'child_process',
    'util',
    'events',
    'os',
    'url',
    'buffer',
    'net',
    'tls',
    'crypto',
    'http',
    'https',
    'zlib',
    'process',
  ]);
  return {
    name: 'node-builtin-stub',
    enforce: 'pre',
    resolveId(id, importer) {
      const isNodeProtocol = id.startsWith('node:');
      // cross-spawn / which / isexe 会由 MCP stdio 间接拉入 bare Node builtins
      const fromNodeOnlyChain =
        !!importer &&
        (/[\\/](@modelcontextprotocol|cross-spawn|which|isexe|path-key|shebang-command|shebang-regex)([\\/]|$)/.test(
          importer
        ) ||
          importer.includes('modelcontextprotocol'));
      if (isNodeProtocol || (fromNodeOnlyChain && bareFromMcp.has(id))) {
        return `\0stub:${id}`;
      }
      return null;
    },
    load(id) {
      if (id.startsWith('\0stub:')) {
        return [
          'export default {};',
          'export const PassThrough = class PassThrough {};',
          'export const Readable = class Readable {};',
          'export const Writable = class Writable {};',
          'export const Transform = class Transform {};',
          'export const EventEmitter = class EventEmitter {};',
          'export const spawn = () => ({ on() {}, stdout: { on() {} }, stderr: { on() {} }, stdin: { write() {}, end() {} } });',
          'export const exec = () => {};',
          'export const createRequire = () => () => ({});',
          'export const join = (...a) => a.join("/");',
          'export const resolve = (...a) => a.join("/");',
          'export const dirname = (p) => p;',
          'export const basename = (p) => p;',
          'export const extname = () => "";',
          'export const homedir = () => "";',
          'export const tmpdir = () => "";',
          'export const platform = "browser";',
          'export const env = {};',
          'export const cwd = () => "/";',
          'export const Buffer = globalThis.Buffer;',
        ].join('\n');
      }
      return null;
    },
  };
}

export default defineConfig({
  define: {
    'process.env': {},
    'process.platform': JSON.stringify(process.platform || 'win32'),
  },
  plugins: [react(), crishHttpProxyPlugin(), nodeBuiltinStubPlugin(), cspPlugin()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  optimizeDeps: {
    // 避免 dev prebundle 把 Node-only stdio transport 打进浏览器 deps
    exclude: ['@modelcontextprotocol/sdk'],
    include: ['react', 'react-dom', 'react-dom/client', '@radix-ui/react-popover', '@tauri-apps/api/window', 'dompurify', 'lucide-react', 'zustand', 'immer', 'highlight.js'],
  },
  server: {
    port: 5174,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    // Lower noise for known large entry; not a substitute for real splits
    chunkSizeWarningLimit: 1100,
    commonjsOptions: { transformMixedEsModules: true },
    rollupOptions: {
      output: {
        // Function form: Windows-safe path match + incremental vendor/business splits
        manualChunks(id) {
          const n = id.replace(/\\/g, '/');
          if (n.includes('node_modules')) {
            if (n.includes('react-dom') || n.includes('/react/'))
              return 'vendor-react';
            if (n.includes('zustand') || n.includes('immer'))
              return 'vendor-zustand';
            if (n.includes('lucide-react')) return 'vendor-lucide';
            if (n.includes('highlight.js')) return 'vendor-highlight';
            if (n.includes('@fontsource')) return 'vendor-fonts';
            // 06-步骤2（P2-4）：tiptap 族（含 @tiptap/pm 的 prosemirror）
            // 与 xterm 族拆出主 chunk；运行时懒加载点归 07 性能轨道
            // （T2-4 移交：ChatComposer.tsx:21 / CardPanelLayout.tsx:5）
            if (n.includes('@tiptap')) return 'vendor-tiptap';
            if (n.includes('@xterm')) return 'vendor-xterm';
          } else if (process.env.CRISH_PROBE_APP) {
            // TEMP 探针：列出进 App chunk 的 node_modules 模块（测后还原）
            const pkg = n.replace(/.*node_modules[\\/]/, '').split(/[\\/]/)[0];
            console.log('[PROBE]', pkg);
          }
          // Business-stable splits (async-heavy chat-bridge/stream cores)
          if (n.includes('/src/api/chatBridge')) return 'chat-bridge';
          if (
            n.includes('/src/api/StreamRenderBuffer') ||
            n.includes('/src/services/StreamRecovery')
          ) {
            return 'chat-stream-core';
          }
          if (n.includes('/src/workers/')) return 'vendor-workers';
        },
      },
    },
  },
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_'],
});
