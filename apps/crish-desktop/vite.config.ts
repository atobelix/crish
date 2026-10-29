import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import net from 'node:net';
import { transformSync } from 'esbuild';
import { isSameOriginRequest } from './dev-server/sameOriginRequest';

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
  "connect-src 'self' ipc: http: https: ws: wss:; " +
  "frame-src 'self' http://localhost:* http://127.0.0.1:* http://*.localhost https://*.localhost asset: http://asset.localhost https://asset.localhost data: blob:;";

const PROD_CSP_BASE =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "font-src 'self' data:; img-src 'self' data: blob: asset: http://asset.localhost https://asset.localhost; " +
  "media-src 'self' data: blob: asset: http://asset.localhost https://asset.localhost; " +
  "connect-src 'self' ipc: http://ipc.localhost http://localhost:8765 http://127.0.0.1:8765 ws://localhost:8765 ws://127.0.0.1:8765; " +
  "worker-src 'self' blob:; frame-src 'self' http://localhost:* http://127.0.0.1:* http://*.localhost https://*.localhost asset: http://asset.localhost https://asset.localhost data: blob:; " +
  "frame-ancestors 'self'; form-action 'self'; object-src 'none'; base-uri 'self'";

// chunk 体积门禁阈值：
// 全局最大候选：vendor-xterm ~441 kB / chat-provider-catalog ~422 kB /
// vendor-tiptap ~419 kB / index(entry) ~322 kB / chat-runtime-core ~305 kB —— 均低于 600 hard 门禁。
// 消除 chunk 环依赖后：chat-runtime-core ~305 kB / chat-provider-catalog ~422 kB / vendor-shared-utils ~134 kB。
// 阈值 = 抛错门禁（chunkSizeGatePlugin），与 vite:reporter 的 chunkSizeWarningLimit
// 同值（单真源），避免 reporter 默认 500 对 lucide 误报。
const CHUNK_SIZE_GATE_KB = 600;

/**
 * 懒加载例外（白名单，不是全局放宽）：
 * Mermaid 仅在 `[data-md-island="mermaid"]` 出现时动态 import，不进入首屏
 * 静态图；其 core chunk 约 610KB，低于此单独阈值。其余 chunk 仍受 600KB 硬门禁。
 */
const LAZY_CHUNK_SIZE_LIMITS_KB: ReadonlyArray<{
  pattern: RegExp;
  limitKb: number;
  reason: string;
}> = [
  {
    pattern: /vendor-mermaid-[^/]+\.js$/,
    limitKb: 4096,
    reason: 'Mermaid diagram island dynamic import (not in startup graph)',
  },
  {
    pattern: /mermaid\.core-[^/]+\.js$/,
    limitKb: 1200,
    reason: 'Mermaid diagram island dynamic import (not in startup graph)',
  },
  {
    pattern: /cynefin-[^/]+\.js$/,
    limitKb: 1200,
    reason: 'Mermaid diagram island dynamic import (not in startup graph)',
  },
];

/**
 * chunk 体积门禁（06-步骤2 / T-G 批次 7.1，P2-4/N4）：
 * vite 7 的 chunk 超限告警由 vite:reporter 在 generateBundle 直发 logger.warn
 * （无 CHUNK_SIZE_WARN 结构化 warning，rollupOptions.onwarn 捕获不到——
 * 实读 vite 7.3.5 dist/node/chunks/config.js:5163-5177，与 07-detail §2.2 草案
 * 的 onwarn 方案不同，故以插件拦截实现同语义）：任何 JS chunk 超过阈值即抛错，
 * build 失败（阈值 = 门禁而非降噪开关，chunkSizeWarningLimit: 1100 退役）。
 * App chunk <500KB 的专属断言由 scripts/check-dist.mjs 承载（全局阈值 + App
 * 断言双轨，06 风险 R3 缓解）。
 */
function chunkSizeGatePlugin(): Plugin {
  return {
    name: 'crish-chunk-size-gate',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const [name, chunk] of Object.entries(bundle)) {
        if (chunk.type !== 'chunk') continue;
        const exemption = LAZY_CHUNK_SIZE_LIMITS_KB.find((item) =>
          item.pattern.test(name)
        );
        const limitKb = exemption?.limitKb ?? CHUNK_SIZE_GATE_KB;
        if (chunk.code.length / 1e3 > limitKb) {
          this.error(
            `chunk size 超限门禁：${name} = ${(chunk.code.length / 1e3).toFixed(1)} kB ` +
              `> ${limitKb} kB —— 拆分或校准阈值后放行` +
              (exemption ? `（${exemption.reason}）` : '')
          );
        }
      }
    },
  };
}

function cspPlugin(): Plugin {
  return {
    name: 'crish-csp',
    transformIndexHtml(html, ctx) {
      // dev 有 server 上下文（vite serve），build 无 → 按 mode 注入（唯一真源两端成立）
      const isDev = !!ctx.server;
      let content: string;
      let transformedHtml = html;

      // ACT-202：生产构建将 loader.css/js 内联为 CRP 关键资产（dev 保留外链便于断点调试）
      if (!isDev) {
        transformedHtml = inlineCriticalAssets(transformedHtml);
      }

      if (isDev) {
        content = DEV_CSP;
      } else {
        // 对 html 中无 src 的内联 <script> 计算 sha256（含刚内联的 loader.js；
        // 静态内容 hash 稳定；未来内联 script 变更则 hash 自动跟随，无人工同步点）
        // INV-01：严禁 'unsafe-inline'；script-src 保留 'self' 保障模块脚本放行
        const hashes: string[] = [];
        const inlineRe = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
        let m: RegExpExecArray | null;
        while ((m = inlineRe.exec(transformedHtml))) {
          hashes.push(
            `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`
          );
        }
        content = PROD_CSP_BASE.replace(
          "script-src 'self'",
          `script-src 'self'${hashes.length ? ' ' + hashes.join(' ') : ''}`
        );
      }
      return {
        html: transformedHtml,
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
 * CRP 关键资源编译期内联（ACT-202 · INV-OUT-201）：
 * 将 index.html 对 /loader.css、/loader.js 的外链引用替换为内联
 * <style id="crish-critical-css"> 与 <script id="crish-critical-js">。
 * 压缩一律 esbuild transformSync（audits/05 §3.13-3：禁自制正则压缩）。
 * 仅在 build 路径调用；文件缺失时保留原 HTML 并 warn（不阻断 dev）。
 */
function inlineCriticalAssets(html: string): string {
  const publicDir = resolve(__dirname, 'public');
  const cssPath = joinPath(publicDir, 'loader.css');
  const jsPath = joinPath(publicDir, 'loader.js');

  let minifiedCss = '';
  let minifiedJs = '';
  try {
    if (existsSync(cssPath)) {
      minifiedCss = transformSync(readFileSync(cssPath, 'utf-8'), {
        minify: true,
        loader: 'css',
      }).code;
    } else {
      console.warn(`[crish-csp] loader.css 未找到: ${cssPath}`);
    }
    if (existsSync(jsPath)) {
      minifiedJs = transformSync(readFileSync(jsPath, 'utf-8'), {
        minify: true,
        loader: 'js',
        target: 'es2020',
      }).code;
    } else {
      console.warn(`[crish-csp] loader.js 未找到: ${jsPath}`);
    }
  } catch (err) {
    // 压缩失败时退回原始内容内联（仍消除外链往返；hash 由 cspPlugin 扫描计算）
    console.warn(
      '[crish-csp] esbuild 压缩 loader 失败，回退原始内容内联:',
      err instanceof Error ? err.message : err
    );
    try {
      if (existsSync(cssPath)) minifiedCss = readFileSync(cssPath, 'utf-8');
      if (existsSync(jsPath)) minifiedJs = readFileSync(jsPath, 'utf-8');
    } catch {
      /* swallow-ok: 保持外链 */
    }
  }

  let out = html;
  const cssLinkRe = /<link\b[^>]*?href=["'][^"']*?loader\.css["'][^>]*?\/?>/i;
  if (minifiedCss) {
    const styleTag = `<style id="crish-critical-css">${minifiedCss}</style>`;
    if (cssLinkRe.test(out)) {
      out = out.replace(cssLinkRe, styleTag);
    } else {
      out = out.replace('</head>', `  ${styleTag}\n</head>`);
    }
  }

  const jsScriptRe =
    /<script\b[^>]*?src=["'][^"']*?loader\.js["'][^>]*?>\s*<\/script>/i;
  if (minifiedJs) {
    const scriptTag = `<script id="crish-critical-js">${minifiedJs}</script>`;
    if (jsScriptRe.test(out)) {
      out = out.replace(jsScriptRe, scriptTag);
    } else {
      out = out.replace('</head>', `  ${scriptTag}\n</head>`);
    }
  }

  return out;
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
 * 活跃本地开发端口探测端点（50ms 内并行探测常用开发端口）：
 * GET /__crish_active_ports
 * 返回当前处于 LISTEN 状态的活跃端口列表 JSON，如 [5173]。
 */
const COMMON_DEV_PORTS = [
  5173, 3000, 3001, 3002, 4200, 5000, 8000, 8080, 8081, 8888, 9000, 9999,
];

function probePort(port: number, timeoutMs = 50): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (active: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(active);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try {
      socket.connect(port, '127.0.0.1');
    } catch {
      finish(false);
    }
  });
}

function crishActivePortsPlugin(): Plugin {
  return {
    name: 'crish-active-ports',
    configureServer(server) {
      server.middlewares.use(
        async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
          if (!req.url?.startsWith('/__crish_active_ports')) {
            next();
            return;
          }
          // audit-repair-202609 T18：仅限同源访问——消费方（PreviewCard）与
          // 端点同源，无需 CORS；跨源请求一律 403，防外部网页驱动 dev server。
          if (!isSameOriginRequest(req)) {
            res.statusCode = 403;
            res.end('Forbidden: cross-origin requests are not allowed');
            return;
          }
          if (req.method !== 'GET') {
            res.statusCode = 405;
            res.end('Method Not Allowed');
            return;
          }

          const selfPort =
            typeof server.config.server.port === 'number'
              ? server.config.server.port
              : 5174;
          const portsToProbe = COMMON_DEV_PORTS.filter((p) => p !== selfPort);
          const probePromises = portsToProbe.map(async (port) => {
            const active = await probePort(port, 50);
            return active ? port : null;
          });

          const results = await Promise.all(probePromises);
          const activePorts = results.filter((p): p is number => p !== null);

          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(activePorts));
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
  plugins: [
    react(),
    crishHttpProxyPlugin(),
    crishActivePortsPlugin(),
    nodeBuiltinStubPlugin(),
    cspPlugin(),
    chunkSizeGatePlugin(),
  ],
  resolve: {
    dedupe: ['react', 'react-dom', 'react-dom/client'],
    alias: [
      { find: '@', replacement: resolve(__dirname, 'src') },
      {
        find: '@crish/block-paper/chrome.css',
        replacement: resolve(
          __dirname,
          '../../packages/block-paper/src/chrome/blockChrome.css'
        ),
      },
      {
        find: '@crish/block-paper/paper-list.css',
        replacement: resolve(
          __dirname,
          '../../packages/block-paper/src/list/paperList.css'
        ),
      },
      {
        find: /^@crish\/block-paper$/,
        replacement: resolve(
          __dirname,
          '../../packages/block-paper/src/index.ts'
        ),
      },
      {
        find: /^@crish\/block-paper-contract$/,
        replacement: resolve(
          __dirname,
          '../../packages/block-paper-contract/src/index.ts'
        ),
      },
      {
        find: '@crish/shared-utils/browser',
        replacement: resolve(
          __dirname,
          '../../packages/shared-utils/src/browser-index.ts'
        ),
      },
      {
        find: '@crish/shared-utils/node',
        replacement: resolve(
          __dirname,
          '../../packages/shared-utils/src/node-index.ts'
        ),
      },
      {
        find: /^@crish\/shared-utils$/,
        replacement: resolve(
          __dirname,
          '../../packages/shared-utils/src/index.ts'
        ),
      },
      {
        find: /^@crish\/shared-types$/,
        replacement: resolve(
          __dirname,
          '../../packages/shared-types/src/index.ts'
        ),
      },
      {
        find: /^@crish\/conversation-flow$/,
        replacement: resolve(
          __dirname,
          '../../packages/conversation-flow/src/index.ts'
        ),
      },
      {
        find: /^@crish\/editor-kit$/,
        replacement: resolve(
          __dirname,
          '../../packages/editor-kit/src/index.ts'
        ),
      },
    ],
  },
  optimizeDeps: {
    // 避免 dev prebundle 把 Node-only stdio transport 打进浏览器 deps
    exclude: ['@modelcontextprotocol/sdk'],
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      '@radix-ui/react-popover',
      '@tauri-apps/api/window',
      'dompurify',
      '@hugeicons/core-free-icons',
      '@hugeicons/react',
      'zustand',
      'immer',
      'highlight.js',
      'use-sync-external-store',
      'use-sync-external-store/shim',
      '@codemirror/state',
      '@codemirror/view',
      '@codemirror/commands',
      '@codemirror/lang-javascript',
      '@xterm/xterm',
      '@xterm/addon-fit',
      '@xterm/addon-webgl',
    ],
  },
  server: {
    port: 5174,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    // 供 check-startup-budget.mjs 依赖图谱门禁（无 manifest 时脚本走 assets 启发式）
    manifest: true,
    // chunk 体积门禁（06-步骤2）：与 chunkSizeGatePlugin 同值（单真源）；
    // reporter 的同名阈值确保"超限即告警"与"超限即抛错"口径一致（1100 降噪开关退役）
    chunkSizeWarningLimit: CHUNK_SIZE_GATE_KB,
    commonjsOptions: { transformMixedEsModules: true },
    rollupOptions: {
      // R2-4 P3-1：Tauri 专属插件模块外部化——浏览器构建（vite build）下
      // rollup 不打包、运行时动态 import 拒绝 → skillsApi/importFsHost 的
      // catch 回退；Tauri 壳内运行时由 webview 插件面提供（解析成功）。
      external: [
        '@tauri-apps/plugin-fs',
        '@tauri-apps/plugin-opener',
        '@tauri-apps/plugin-shell',
      ],
      output: {
        hoistTransitiveImports: false,
        // Function form: Windows-safe path match + incremental vendor/business splits
        manualChunks(id) {
          const n = id.replace(/\\/g, '/');
          if (n.includes('node_modules')) {
            // Mermaid 图表引擎及其独有依赖：仅由 mermaid island 动态 import，
            // 合并为单一懒加载 vendor chunk，避免数十个 diagram 子 chunk 各自
            // 触碰 600KB 门禁；该 chunk 不在首屏静态图内。
            if (
              n.includes('/node_modules/mermaid/') ||
              n.includes('/node_modules/@mermaid-js/') ||
              n.includes('/node_modules/cytoscape/') ||
              n.includes('/node_modules/dagre') ||
              n.includes('/node_modules/d3/') ||
              n.includes('/node_modules/d3-') ||
              n.includes('/node_modules/khroma/') ||
              n.includes('/node_modules/elkjs/')
            ) {
              return 'vendor-mermaid';
            }
            // /react/ 会误伤 @tiptap/react 与 zustand/esm/react/*（→ 循环 chunk
            // vendor-react↔vendor-tiptap/zustand），收窄为仅 react 包本体；
            // react-dom 及其浮层 peer（@floating-ui/react-dom 等）继续归 vendor-react
            if (
              n.includes('react-dom') ||
              n.includes('node_modules/react/') ||
              n.includes('node_modules/scheduler/')
            ) {
              return 'vendor-react';
            }
            if (
              n.includes('zustand') ||
              n.includes('immer') ||
              n.includes('use-sync-external-store')
            ) {
              return 'vendor-zustand';
            }
            if (n.includes('@hugeicons')) return 'vendor-hugeicons';
            if (n.includes('highlight.js')) return 'vendor-highlight';
            if (n.includes('@fontsource')) return 'vendor-fonts';
            // 06-步骤2 / Stage 10：tiptap 族（含 prosemirror 与 @codemirror）
            // 与 xterm 族拆出主 chunk，保持 vendor-tiptap / vendor-xterm 命名对齐 check-dist.mjs
            if (
              n.includes('@tiptap') ||
              n.includes('prosemirror') ||
              n.includes('@codemirror')
            ) {
              return 'vendor-tiptap';
            }
            if (n.includes('@xterm')) return 'vendor-xterm';
            // App chunk 残留的 dompurify 与 @chenglou/pretext 独立切块
            if (n.includes('dompurify')) return 'vendor-dompurify';
            if (n.includes('@chenglou')) return 'vendor-pretext';
            if (n.includes('node_modules/motion')) return 'vendor-motion';
            if (n.includes('node_modules/marked')) return 'vendor-marked';
            if (n.includes('@radix-ui')) return 'vendor-radix';
            if (n.includes('@tauri-apps/api')) return 'vendor-tauri';
          }
          if (
            n.includes('/packages/shared-utils/') ||
            n.includes('/packages/shared-types/') ||
            n.includes('/packages/plugin-import-claude-codex/') ||
            n.includes('/src/utils/lifecycle/')
          ) {
            return 'vendor-shared-utils';
          }

          if (n.includes('/src/i18n/locales/')) {
            return 'i18n-locales';
          }

          if (n.includes('modelsAutofillBaselineData.json')) {
            return 'data-models-autofill';
          }

          // 2.1 模型目录元数据独立切块（惰性加载，严禁渗入传输协议）
          if (
            (n.includes('/src/api/providerProfiles') &&
              !n.includes('providerProfilesLight')) ||
            n.includes('/src/api/provider-profiles') ||
            n.includes('/src/api/modelCatalog') ||
            n.includes('/src/api/modelCatalogTypes') ||
            n.includes('/src/api/modelCatalogPure') ||
            n.includes('/src/api/modelCatalogMeta') ||
            n.includes('/src/api/modelCatalogIpc') ||
            n.includes('catalog.json')
          ) {
            return 'chat-provider-catalog';
          }

          // 2.2 跨层共享工具与纯函数（切断 catalog/store 与 runtime 核心的双向 chunk 依赖环）
          if (
            n.includes('/src/services/LoggerService') ||
            n.includes('/src/api/modelsNormalize') ||
            n.includes('/src/api/providerProfilesLight') ||
            n.includes('/src/api/chat-bridge/handlers/cacheMetricsCompute') ||
            n.includes('/src/api/chat-bridge/handlers/eventUtils') ||
            n.includes('/src/api/chat-bridge/handlers/eventParser') ||
            n.includes('/src/api/chat-bridge/handlers/eventEnvelope') ||
            n.includes('/src/api/chat-bridge/handlers/eventType') ||
            n.includes('/src/api/chat-bridge/handlers/toolUtils') ||
            n.includes('/src/api/chat-bridge/editSessionConsumer') ||
            n.includes('/src/api/userFacingErrors') ||
            n.includes('/src/services/ErrorStore') ||
            n.includes('/src/api/uiEvents') ||
            n.includes('/src/api/toolPresentation') ||
            n.includes('/src/api/tool-presentation/') ||
            n.includes('/src/api/toolFeedback')
          ) {
            return 'chat-bridge-common';
          }

          // 2.3 核心会话状态切块（解耦会话状态与运行时流传输）
          if (
            n.includes('/src/store/sessionStore') ||
            n.includes('/src/store/sessionSubtreeModel') ||
            n.includes('/src/store/sessionActions') ||
            n.includes('/src/store/sessionIndex') ||
            n.includes('/src/store/sessionListEqual') ||
            n.includes('/src/store/sessionMessage') ||
            n.includes('/src/store/sessionCrud') ||
            n.includes('/src/store/layout-helpers/') ||
            n.includes('/src/store/middleware/') ||
            n.includes('/src/api/storeAccess')
          ) {
            return 'store-session-core';
          }

          // 2.4 聊天运行时核心（统一收归 transport 与 stream 处理核心）
          if (
            n.includes('/src/api/StreamRenderBuffer') ||
            n.includes('/src/services/StreamRecovery') ||
            n.includes('/src/api/chatBridge') ||
            n.includes('/src/api/chat-bridge/')
          ) {
            return 'chat-runtime-core';
          }
          if (n.includes('/src/workers/')) return 'vendor-workers';
        },
      },
    },
  },
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_'],
});
