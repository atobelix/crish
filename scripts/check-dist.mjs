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
 *     （仅允许具体 localhost/ipc 条目）；内联 script 双态（G-05B 修订）——
 *     内联 script 为零时允许 script-src 无 sha256- 条目（阶段 A 外链化后常态）；
 *     有内联 script 时其对应 sha256 hash 必须存在于 script-src（逐条校验内容）。
 * 用法：node scripts/check-dist.mjs [--max-app-kb 500] [--csp-enforce] [--guide <metric>]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const DIST_DIR = join(process.cwd(), 'apps', 'crish-desktop', 'dist');
const ASSETS_DIR = join(DIST_DIR, 'assets');

// ---- 参数解析 ----
const args = process.argv.slice(2);
let maxAppKb = 500;
let cspEnforce = false;
let guideRequested = false;
let guideMetric;
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
  } else if (args[i] === '--guide') {
    guideRequested = true;
    guideMetric = args[i + 1];
    i++;
  } else {
    console.error(`check-dist: 未知参数 ${args[i]}`);
    process.exit(2);
  }
}

// ── 正确做法指引（--guide <metric>；纯增量，不影响既有判定与退出码）──────
// 指标名取自本脚本各强制断言的 FAIL 语义（见上方 usage 与各 fail() 调用）。
const GUIDE_TEXT = {
  app_chunk_missing: [
    '违反项：`主入口/App chunk 缺失：dist/assets 下无 App-*.js 或 index-*.js`（scripts/check-dist.mjs:77）。',
    '位置/当前值/阈值：apps/crish-desktop/dist/assets 下匹配 ^App-.*\\.js$ 与 ^index-.*\\.js$ 的文件数 = 0；阈值 >= 1。',
    '正确做法：产物未生成或被清理 —— 先在 apps/crish-desktop 跑构建（npm run build --workspace apps/crish-desktop），',
    '  再核对：ls apps/crish-desktop/dist/assets | grep -E \'^(App|index)-.*\\.js$\'。',
    '若产物存在但命名不符 → 检查 apps/crish-desktop/vite.config.ts:743 rollupOptions.output 的 entry/chunk 命名契约是否被改动。',
    '参考：docs/frontend-audit/40-final-plan/10-details/07-engineering-detail.md（构建产物断言 T3-4）。',
  ],
  app_chunk_oversize: [
    '违反项：`主入口/App chunk 超限：<name> = <bytes> B >= <limit> B`（scripts/check-dist.mjs:79）。',
    '位置：apps/crish-desktop/vite.config.ts:754 `manualChunks(id)`。',
    '当前值：appChunk.bytes；阈值：--max-app-kb（默认 500）* 1024 = 512000 B（脚本以 >= 判定超限）。',
    '正确做法：把该 chunk 里的大依赖按包名拆出独立 vendor chunk，例如在 manualChunks 内追加：',
    '    if (n.includes(\'some-heavy-pkg\')) return \'vendor-heavy\';',
    '  已有先例：vite.config.ts:776-779 用 dompurify / @chenglou 拆出 vendor-dompurify / vendor-pretext 后 App 实测约 455KB。',
    '  复看清单：node scripts/check-dist.mjs（打印 chunk 字节降序），本地试算可加 --max-app-kb <N>。',
    '参考：docs/performance-audit/11-资产与构建体积审查报告.md；07-engineering-detail.md。',
  ],
  vendor_tiptap_missing: [
    '违反项：`vendor-tiptap-*.js 缺失（tiptap 族未拆出 App chunk）`（scripts/check-dist.mjs:88）。',
    '位置：apps/crish-desktop/vite.config.ts:774 `if (n.includes(\'@tiptap\')) return \'vendor-tiptap\';`。',
    '当前值：dist/assets 下匹配 ^vendor-tiptap-.*\\.js$ 的文件数 = 0；阈值 >= 1。',
    '正确做法：恢复该 manualChunks 分支（若被删）；若 tiptap 入口已改懒加载，确认懒加载点仍在',
    '  （ChatComposer.tsx:21）以使该 chunk 仍被产出。',
    '参考：07-engineering-detail.md（06-步骤2 / P2-4 vendor 拆分）。',
  ],
  vendor_xterm_missing: [
    '违反项：`vendor-xterm-*.js 缺失（xterm 族未拆出 App chunk）`（scripts/check-dist.mjs:93）。',
    '位置：apps/crish-desktop/vite.config.ts:775 `if (n.includes(\'@xterm\')) return \'vendor-xterm\';`。',
    '当前值：dist/assets 下匹配 ^vendor-xterm-.*\\.js$ 的文件数 = 0；阈值 >= 1。',
    '正确做法：恢复该 manualChunks 分支；确认终端懒加载点仍存在（CardPanelLayout.tsx:5）以产出该 chunk。',
    '参考：07-engineering-detail.md（06-步骤2 / P2-4 vendor 拆分）。',
  ],
  index_html_missing: [
    '违反项：`dist/index.html 缺失`（scripts/check-dist.mjs:101）。',
    '位置：apps/crish-desktop/dist/index.html；当前值：文件不存在；阈值：必须存在。',
    '正确做法：构建未完成或产物被清理 —— 重跑 apps/crish-desktop 的构建；',
    '  并确认 vite build 的 build.outDir 未被改指向他处（模板源在 apps/crish-desktop/index.html）。',
  ],
  csp_meta_count: [
    '违反项：`CSP meta 数量应为 1，实测 N（唯一真源 = cspPlugin）`（scripts/check-dist.mjs:124）。',
    '位置：apps/crish-desktop/dist/index.html 的 <meta http-equiv="Content-Security-Policy">。',
    '当前值：N 个；阈值：恰 1 个。',
    '正确做法：CSP 唯一真源是 cspPlugin（vite.config.ts:77 定义，:684 注册），',
    '  删除 index.html 模板（apps/crish-desktop/index.html）里手写的 CSP meta，不要两处并存。',
    '参考：07-engineering-detail.md §3（CSP 单源）；附录 B 切换点登记。',
  ],
  csp_missing_directive: [
    '违反项：`CSP 缺少 script-src 指令` / `CSP 缺少 connect-src 指令`（scripts/check-dist.mjs:139-140）。',
    '位置：apps/crish-desktop/vite.config.ts 的 cspPlugin prod CSP 串（约 :201-250）。',
    '当前值：缺失指令；阈值：script-src 与 connect-src 都必须存在。',
    '正确做法：在 prod 串补回完整指令，可直接对照 07-engineering-detail.md:250 的落地串：',
    '    script-src \'self\' \'sha256-<内联hash>\'; ... connect-src \'self\' ipc: http://ipc.localhost http://localhost:8765 http://127.0.0.1:8765 ws://localhost:8765 ws://127.0.0.1:8765;',
  ],
  csp_unsafe_eval: [
    '违反项：`script-src 含 unsafe-eval（生产面禁止）`（scripts/check-dist.mjs:142）。',
    '位置：vite.config.ts cspPlugin prod 串的 script-src。',
    '当前值：含 \'unsafe-eval\'；阈值：0 次出现。',
    '正确做法：从 prod 串删除 \'unsafe-eval\'（dev 宽松串可保留，vite/HMR 需要）；',
    '  若确需 wasm 依赖 → 按 07-engineering-detail.md 附录 B「切换点 2」改为回填 \'wasm-unsafe-eval\'（当前 xterm webgl 为 WebGL API 非 wasm）。',
    '参考：07-engineering-detail.md:499-504（附录 B CSP 切换点登记）。',
  ],
  csp_unsafe_inline: [
    '违反项：`script-src 含 unsafe-inline（内联 script 必须经 sha256 hash 放行）`（scripts/check-dist.mjs:145）。',
    '位置：vite.config.ts cspPlugin prod 串的 script-src。',
    '当前值：含 \'unsafe-inline\'；阈值：0 次出现。',
    '正确做法：删除 script-src 的 \'unsafe-inline\'；内联 script 由 cspPlugin 自动计算 sha256 放行',
    '  （vite.config.ts:214-221 `createHash(\'sha256\').update(m[1]).digest(\'base64\')`）；',
    '  或将内联脚本外链为 public/theme-init.js（备选方案 B，07-engineering-detail.md:278）。',
    '注意：style-src 的 \'unsafe-inline\' 是骨架屏内联 CSS 所需，属允许项，勿误删（07-engineering-detail.md:263）。',
  ],
  csp_inline_sha256_mismatch: [
    '违反项：`内联 script 缺对应 sha256 条目：sha256-<hash>`（scripts/check-dist.mjs:160）。',
    '位置：dist/index.html 的内联 <script> 正文 ↔ 同页 CSP script-src 条目。',
    '当前值：该内联脚本内容哈希；阈值：每条内联 script 的 sha256 必须逐一出现在 script-src。',
    '正确做法：不要手写 hash（内联内容一改即失效）—— 交给 cspPlugin 构建期扫描计算（vite.config.ts:214-221）。',
    '  手工核对当前产物 hash：',
    '    node -e "const{createHash}=require(\'node:crypto\'),fs=require(\'node:fs\');const h=fs.readFileSync(\'apps/crish-desktop/dist/index.html\',\'utf8\');for(const m of h.matchAll(/<script\\b(?![^>]*\\bsrc=)[^>]*>([\\s\\S]*?)<\\/script>/gi))console.log(\'sha256-\'+createHash(\'sha256\').update(m[1]).digest(\'base64\'))"',
    '参考：07-engineering-detail.md §3（G-05B 双态断言）。',
  ],
  csp_connect_generic: [
    '违反项：`connect-src 含泛化 <http:/https:/ws:/wss:>（仅允许具体 localhost/ipc 条目）`（scripts/check-dist.mjs:168）。',
    '位置：vite.config.ts cspPlugin prod 串的 connect-src。',
    '当前值：泛化 scheme token 列表；阈值：0 个。',
    '正确做法：把泛化 scheme 换成具体条目，落地形态见 07-engineering-detail.md:250：',
    '    connect-src \'self\' ipc: http://ipc.localhost http://localhost:8765 http://127.0.0.1:8765 ws://localhost:8765 ws://127.0.0.1:8765;',
    '参考：07-engineering-detail.md 附录 B「切换点 3（新依赖引入）」。',
  ],
};

function printGuide(metric) {
  const g = GUIDE_TEXT[metric];
  if (!g) {
    console.error(`[check-dist] 未知指标：${metric ?? '(未给出)'}`);
    console.error(`可用：${Object.keys(GUIDE_TEXT).join(', ')}`);
    process.exit(1);
  }
  console.log(`[check-dist] 正确做法 · ${metric}\n`);
  for (const l of g) console.log(`  ${l}`);
  process.exit(0);
}

if (guideRequested) printGuide(guideMetric);


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
  // Stage 3 后 entry-core 静态聚合 App → 主包为 index-*.js（无独立 App-*.js）
  if (/^App-.*\.js$/.test(c.name)) appChunk = c;
  if (/^index-.*\.js$/.test(c.name) && (!appChunk || c.bytes > appChunk.bytes)) {
    appChunk = c;
  }
  if (/^vendor-tiptap-.*\.js$/.test(c.name)) vendorTiptap.push(c);
  if (/^vendor-xterm-.*\.js$/.test(c.name)) vendorXterm.push(c);
}
console.log(`chunk 总数（js）：${listJsChunks().length}`);

// ---- 强制断言：主入口/App chunk < maxAppKb ----
const appLimitBytes = maxAppKb * 1024;
if (!appChunk) {
  fail(`主入口/App chunk 缺失：dist/assets 下无 App-*.js 或 index-*.js（entry 产物异常？）`);
} else if (appChunk.bytes >= appLimitBytes) {
  fail(
    `主入口/App chunk 超限：${appChunk.name} = ${appChunk.bytes} B >= ${appLimitBytes} B（${maxAppKb} KiB 目标）—— 需进一步拆分`
  );
} else {
  console.log(`主入口/App chunk ${appChunk.name} = ${appChunk.bytes} B < ${appLimitBytes} B ✓`);
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
  // 内联 script 正文（无 src 的 <script> 内容；G-05B 双态断言用，逐条核对 hash）
  const inlineBodies = [
    ...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi),
  ].map((m) => m[1]);
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
      // 内联 script 双态断言（G-05B 修订，取代「必须含 sha256-」旧断言：
      // 阶段 A 外链化后内联归零是常态，零内联时允许无 hash；有内联则必须
      // 逐条带与内容匹配的 sha256 hash，防止 hash 与内容脱节）
      if (scriptSrc && inlineBodies.length === 0) {
        console.log('内联 script 为零，script-src 无需 sha256- 条目 ✓');
      }
      if (scriptSrc && inlineBodies.length > 0) {
        const accepted = new Set(
          scriptSrc.map((t) => t.replace(/^'|'$/g, ''))
        );
        for (const body of inlineBodies) {
          const hash = `sha256-${createHash('sha256').update(body).digest('base64')}`;
          if (!accepted.has(hash)) {
            fail(`内联 script 缺对应 sha256 条目：${hash}（script-src 必须含与内联内容匹配的 hash）`);
          }
        }
        if (errors.length === 0) {
          console.log(`内联 script ${inlineBodies.length} 个，对应 sha256- 条目齐备 ✓`);
        }
      }
      if (genericConn.length > 0) {
        fail(`connect-src 含泛化 ${genericConn.join(' ')}（仅允许具体 localhost/ipc 条目）`);
      }
      if (errors.length === 0) {
        console.log('CSP 断言：单 policy、无 unsafe-eval、script-src 无 unsafe-inline、connect-src 无泛化、内联 hash 双态 ✓');
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
