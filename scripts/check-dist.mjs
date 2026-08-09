#!/usr/bin/env node
/**
 * 生产产物断言脚本（06-步骤1/2，T-G 批次 7.1，P1-1/P2-4；T3-4 移交 CSP 断言）：
 * - 解析 apps/crish-desktop/dist/（相对仓库根解析，node:fs 原生零依赖）；
 * - 登记面（始终输出）：chunk 清单 { name, bytes }（按体积降序）、index.html 的
 *   CSP meta / script / modulepreload 概况——步骤 2 调阈值与评审的对照基线；
 * - 强制断言（全部通过才 exit 0）：
 *   · App-*.js 存在且体积 < --max-app-kb（默认 500，单位 KiB）——App 专属目标（T2-3）；
 *   · vendor-tiptap-*.js / vendor-xterm-*.js 存在（拆分落地，T2-3）；
 *   · --csp-enforce 时（CI 固定加参，T3-4）：恰 1 个 CSP meta；无 unsafe-eval；
 *     script-src 无 unsafe-inline；connect-src 无泛化 http:/https:/ws:/wss:
 *     （仅允许具体 localhost/ipc 条目）；script-src 含 sha256- 条目（内联 theme
 *     script hash 放行）。
 * 用法：node scripts/check-dist.mjs [--max-app-kb 500] [--csp-enforce]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST_DIR = join(process.cwd(), 'apps', 'crish-desktop', 'dist');
const ASSETS_DIR = join(DIST_DIR, 'assets');

// ---- 参数解析 ----
const args = process.argv.slice(2);
let maxAppKb = 500;
let cspEnforce = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--max-app-kb') {
    maxAppKb = Number(args[i + 1]);
    if (!Number.isFinite(maxAppKb) || maxAppKb <= 0) {
      console.error(`check-dist: --max-app-kb 需要正数，收到 ${args[i + 1]}`);
      process.exit(2);
    }
    i++;
  } else if (args[i] === '--csp-enforce') {
    cspEnforce = true;
  } else {
    console.error(`check-dist: 未知参数 ${args[i]}`);
    process.exit(2);
  }
}

const errors = [];
const fail = (msg) => errors.push(msg);

// ---- chunk 清单 ----
function listJsChunks() {
  const out = [];
  for (const name of readdirSync(ASSETS_DIR)) {
    if (name.endsWith('.js')) {
      out.push({ name, bytes: statSync(join(ASSETS_DIR, name)).size });
    }
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

console.log('=== dist chunk 清单（字节降序）===');
let appChunk = null;
const vendorTiptap = [];
const vendorXterm = [];
for (const c of listJsChunks()) {
  console.log(`  ${c.name}  ${c.bytes}`);
  if (/^App-.*\.js$/.test(c.name)) appChunk = c;
  if (/^vendor-tiptap-.*\.js$/.test(c.name)) vendorTiptap.push(c);
  if (/^vendor-xterm-.*\.js$/.test(c.name)) vendorXterm.push(c);
}
console.log(`chunk 总数（js）：${listJsChunks().length}`);

// ---- 强制断言：App chunk < maxAppKb ----
const appLimitBytes = maxAppKb * 1024;
if (!appChunk) {
  fail(`App chunk 缺失：dist/assets 下无 App-*.js（manualChunks 拆分失效？）`);
} else if (appChunk.bytes >= appLimitBytes) {
  fail(
    `App chunk 超限：${appChunk.name} = ${appChunk.bytes} B >= ${appLimitBytes} B（${maxAppKb} KiB 目标）—— 需进一步拆分`
  );
} else {
  console.log(`App chunk ${appChunk.name} = ${appChunk.bytes} B < ${appLimitBytes} B ✓`);
}

// ---- 强制断言：vendor 拆分落地 ----
if (vendorTiptap.length === 0) {
  fail('vendor-tiptap-*.js 缺失（tiptap 族未拆出 App chunk）');
} else {
  console.log(`vendor-tiptap 存在：${vendorTiptap[0].name} = ${vendorTiptap[0].bytes} B ✓`);
}
if (vendorXterm.length === 0) {
  fail('vendor-xterm-*.js 缺失（xterm 族未拆出 App chunk）');
} else {
  console.log(`vendor-xterm 存在：${vendorXterm[0].name} = ${vendorXterm[0].bytes} B ✓`);
}

// ---- index.html 概况 ----
const htmlPath = join(DIST_DIR, 'index.html');
if (!exists(htmlPath)) {
  fail(`dist/index.html 缺失`);
} else {
  const html = readFileSync(htmlPath, 'utf8');
  const cspMetas = [...html.matchAll(/<meta\b[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/gi)].map(
    (m) => m[0]
  );
  const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)].map((m) => m[1]);
  const preloads = [...html.matchAll(/<link\b[^>]*rel=["']modulepreload["'][^>]*>/gi)].map(
    (m) => m[0]
  );

  console.log('=== index.html 概况 ===');
  console.log(`CSP meta 数量：${cspMetas.length}`);
  console.log(`script 数量：${scripts.length}（内联 ${scripts.filter((s) => !/src=/.test(s)).length}，外链 ${scripts.filter((s) => /src=/.test(s)).length}）`);
  console.log(`modulepreload 数量：${preloads.length}`);

  // ---- CSP 强制断言（--csp-enforce，T3-4）----
  if (cspEnforce) {
    if (cspMetas.length !== 1) {
      fail(`CSP meta 数量应为 1，实测 ${cspMetas.length}（唯一真源 = cspPlugin）`);
    } else {
      const m = cspMetas[0].match(/content=["']([^"']*)["']/i);
      // vite 构建时对 meta content 做 HTML 实体转义（' → &#39; 等），先解码再分词
      const csp = m ? decodeHtml(m[1]) : '';
      const dirs = csp.split(';').map((d) => d.trim()).filter(Boolean);
      const getTokens = (name) => {
        const d = dirs.find((x) => x.startsWith(name));
        return d ? d.slice(name.length).trim().split(/\s+/) : null;
      };
      const scriptSrc = getTokens('script-src');
      const connectSrc = getTokens('connect-src');
      const genericConn = connectSrc
        ? connectSrc.filter((t) => /^(https?|wss?):$/.test(t))
        : [];
      if (!scriptSrc) fail('CSP 缺少 script-src 指令');
      if (!connectSrc) fail('CSP 缺少 connect-src 指令');
      if (scriptSrc && scriptSrc.includes("'unsafe-eval'")) {
        fail('script-src 含 unsafe-eval（生产面禁止；未来引入 wasm 依赖按 07-detail 附录 B 切换点 2 回填 wasm-unsafe-eval）');
      }
      if (scriptSrc && scriptSrc.includes("'unsafe-inline'")) {
        fail('script-src 含 unsafe-inline（内联 script 必须经 sha256 hash 放行）');
      }
      if (scriptSrc && !scriptSrc.some((t) => t.replace(/^'|'$/g, '').startsWith('sha256-'))) {
        fail('script-src 无 sha256- 条目（内联 theme script 放行缺失）');
      }
      if (genericConn.length > 0) {
        fail(`connect-src 含泛化 ${genericConn.join(' ')}（仅允许具体 localhost/ipc 条目）`);
      }
      if (errors.length === 0) {
        console.log('CSP 断言：单 policy、无 unsafe-eval、script-src 无 unsafe-inline、connect-src 无泛化、含 sha256- ✓');
      }
    }
  }
}

function exists(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

// HTML 实体解码（&amp; 必须先于其余，避免二次解码）
function decodeHtml(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// ---- 收口 ----
if (errors.length > 0) {
  console.error('\ncheck-dist 断言失败：');
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log('\ncheck-dist 全部断言通过 ✓');
process.exit(0);
