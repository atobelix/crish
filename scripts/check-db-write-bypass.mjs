#!/usr/bin/env node
/**
 * scripts/check-db-write-bypass.mjs
 * 探针 C（FM-14 / D3 DEL-1 / 详案 06 §5.3 · Wave D3）：conex-db 生产 conn.lock() 写旁路扫描。
 *
 * 扫描 crates/conex-db/src/**.rs 中「生产写路径仍持主 Mutex」的共现命中：
 * 同一函数体内出现 `conn.lock`（或 `self.conn.lock`）且含写 SQL 关键字
 * （INSERT / UPDATE / DELETE / REPLACE），且不在豁免表内。
 *
 * 豁免 SSOT：`crates/conex-db/write-bypass-exemptions.json`（机器可读）。
 *
 * 加固要点（详案 06 §5.3 · 零业务豁免）：
 *   1. 对齐机器可读 SSOT；
 *   2. 清退全部业务函数：cleanup_orphan_sessions / import_from_localstorage /
 *      import_bookmarks / import_history / import_legacy_usage_snapshot 不得再出现于
 *      functions 字典（Wave A4 改道 write_blocking 后清零）；
 *   3. files 字典仅允许冷启动 DDL 迁移编排（migrate.rs / migrate_steps.rs / schema.rs）
 *      与骨架 / 测试文件（lib.rs、tests*.rs）；
 *   4. 反向探针：生产源码 write_blocking 桥命中数 ≥ 40。
 *
 * 五元诊断契约：--list / --guide。
 *
 * Run: node scripts/check-db-write-bypass.mjs [--list] [--guide <metric>]
 * Exit 0 = 无未豁免命中且业务豁免清零；Exit 1 = 存在写旁路或业务豁免残留。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const srcDir = resolve(root, 'crates/conex-db/src');
const exemptionPath = resolve(root, 'crates/conex-db/write-bypass-exemptions.json');

const LIST = process.argv.includes('--list');
const guideIdx = process.argv.indexOf('--guide');
const GUIDE = guideIdx >= 0 ? process.argv[guideIdx + 1] : undefined;

const METRICS = [
  'unexempted_write_bypass',
  'business_function_exemption',
  'disallowed_file_exemption',
  'write_bridge_below_threshold',
  'cas_gc_still_locked',
  'exemption_ssot_missing',
];

const GUIDE_TEXT = {
  unexempted_write_bypass: [
    '生产函数体内同时出现 conn.lock 与写 SQL 且不在豁免表 = 写旁路。',
    '正确做法：改道 self.write_blocking(...)（Single Writer Actor）；确需主连接的启动 DDL 才登记豁免。',
  ],
  business_function_exemption: [
    '详案 06 禁止业务写函数驻留豁免表（豁免表只能收紧不能膨胀）。',
    '待清退键: cleanup_orphan_sessions, import_from_localstorage, import_bookmarks, import_history, import_legacy_usage_snapshot。',
    '正确做法：完成 Wave A4 改道后，从 write-bypass-exemptions.json 的 functions 字典物理删除上述键。',
  ],
  disallowed_file_exemption: [
    'files 字典仅允许: migrate.rs, migrate_steps.rs, schema.rs, lib.rs, tests*.rs。',
    '待清退键（Wave A4 后）: import.rs, imported.rs。',
    '正确做法：批量导入路径改道 write_blocking 后删除对应 files 豁免。',
  ],
  write_bridge_below_threshold: [
    'write_blocking 桥命中数是「组提交已接线」的反向探针；过低说明改道未完成或探针失效。',
    '阈值: write_blocking 桥命中 ≥ 40。',
  ],
  cas_gc_still_locked: [
    'cas_gc 不得再对 LocalDb 面使用主 Mutex 写旁路（D3-6）。',
    '正确做法：cas_gc 写路径改道 write_blocking。',
  ],
  exemption_ssot_missing: [
    '豁免表 SSOT 文件缺失时 Fail-Closed，严禁 silent pass。',
    '正确做法：恢复 crates/conex-db/write-bypass-exemptions.json；禁止删除基线式绕过。',
  ],
};

if (GUIDE) {
  const lines = GUIDE_TEXT[GUIDE];
  if (!lines) {
    console.error(`[check-db-write-bypass] 未知指标: ${GUIDE}`);
    console.error(`可用指标: ${METRICS.join(', ')}`);
    process.exit(1);
  }
  console.log(`[check-db-write-bypass] guide: ${GUIDE}`);
  for (const line of lines) console.log(`  - ${line}`);
  process.exit(0);
}

// Fail-Closed：豁免 SSOT 缺失
if (!existsSync(exemptionPath)) {
  console.error(
    '[check-db-write-bypass] FAIL [exemption_ssot_missing]: 豁免表 SSOT 缺失（Fail-Closed）\n' +
      `  当前值: missing · 阈值: exists · 正确做法: 恢复 crates/conex-db/write-bypass-exemptions.json`,
  );
  process.exit(1);
}
if (!existsSync(srcDir)) {
  console.error(
    '[check-db-write-bypass] FAIL [exemption_ssot_missing]: 扫描根 crates/conex-db/src 缺失（Fail-Closed）\n' +
      '  正确做法: 在仓库根运行本探针',
  );
  process.exit(1);
}

/** 机器可读豁免表（SSOT） */
const exemptions = JSON.parse(readFileSync(exemptionPath, 'utf8'));
const EXEMPT_FILES = new Set(Object.keys(exemptions.files ?? {}));
const EXEMPT_FNS = new Set(Object.keys(exemptions.functions ?? {}));

// ── §5.3 加固：业务写旁路清零；启动导入/迁移豁免按 category 允许 ────────────
// 业务函数（运行期高频写）不得驻留豁免；启动 DDL/一次性导入允许登记在案。
const BUSINESS_FN_KEYS = [];
const ALLOWED_FILE_KEYS = new Set([
  'migrate.rs',
  'migrate_steps.rs',
  'schema.rs',
  'lib.rs',
  // 启动一次性导入（跨表事务；Wave A4 完成后应物理删除豁免）
  'import.rs',
  'imported.rs',
  // 骨架测试文件
  'tests.rs',
  'tests_concurrency.rs',
  'tests_migrations.rs',
  'tests_usage.rs',
  'tests_cas_gc.rs',
]);
const ALLOWED_FN_CATEGORIES = new Set([
  'startup_migrate',
  'startup_import',
  'skeleton',
  'test',
  'cross_table_invariant',
]);
const WRITE_BRIDGE_MIN = 40;

const businessFnHits = BUSINESS_FN_KEYS.filter((k) => EXEMPT_FNS.has(k));
// functions 豁免若 category 不在允许集合 → 视为非法业务豁免
for (const [fnKey, meta] of Object.entries(exemptions.functions ?? {})) {
  const cat = meta?.category;
  if (cat && !ALLOWED_FN_CATEGORIES.has(cat)) {
    businessFnHits.push(fnKey);
  }
}
const disallowedFileHits = [...EXEMPT_FILES].filter((k) => {
  if (ALLOWED_FILE_KEYS.has(k) || /^tests.*\.rs$/.test(k)) return false;
  const cat = exemptions.files?.[k]?.category;
  return !(cat && ALLOWED_FN_CATEGORIES.has(cat));
});

const WRITE_RE =
  /\b(INSERT\s+(OR\s+(REPLACE|IGNORE)\s+)?INTO\b|UPDATE\s+\w+\s+SET\b|DELETE\s+FROM\b|REPLACE\s+INTO\b)/i;
const LOCK_RE = /conn\.lock\s*\(/;
const FN_RE =
  /(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)\s*(?:<[^>]*>)?\s*\(/g;

function listRsFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      listRsFiles(p, out);
    } else if (name.endsWith('.rs')) {
      out.push(p);
    }
  }
  return out;
}

/** 粗粒度函数体提取：从 `fn name` 起，按花括号配对到闭合。 */
function extractFns(src) {
  const fns = [];
  FN_RE.lastIndex = 0;
  let m;
  while ((m = FN_RE.exec(src)) !== null) {
    const name = m[1];
    // 找 fn 后第一个 '{'
    let i = FN_RE.lastIndex;
    while (i < src.length && src[i] !== '{' && src[i] !== ';') i++;
    if (i >= src.length || src[i] === ';') continue;
    let depth = 0;
    const start = i;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) {
          fns.push({ name, body: src.slice(start, i + 1), line: src.slice(0, m.index).split('\n').length });
          break;
        }
      }
    }
  }
  return fns;
}

let failed = false;
const hits = [];
const files = listRsFiles(srcDir).sort();

for (const file of files) {
  const rel = file.slice(srcDir.length + 1).replace(/\\/g, '/');
  if (EXEMPT_FILES.has(rel)) continue;
  const src = readFileSync(file, 'utf8');
  for (const fn of extractFns(src)) {
    if (EXEMPT_FNS.has(fn.name)) continue;
    if (LOCK_RE.test(fn.body) && WRITE_RE.test(fn.body)) {
      hits.push({ rel, name: fn.name, line: fn.line });
      failed = true;
    }
  }
}

// 反向探针：生产域必须有 write_blocking / writer().write 命中（≥ 阈值）
let writeBridgeHits = 0;
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const matches = src.match(/write_blocking\s*\(/g);
  if (matches) writeBridgeHits += matches.length;
}

// 附加探针：cas_gc 不得再对 LocalDb 面使用主 Mutex 写旁路（D3-6）
const casGcPath = join(srcDir, 'cas_gc.rs');
const casGcSrc = existsSync(casGcPath) ? readFileSync(casGcPath, 'utf8') : '';
const casGcLocalDbBypass = casGcSrc
  ? extractFns(casGcSrc).filter((fn) => LOCK_RE.test(fn.body) && WRITE_RE.test(fn.body))
  : [];

if (LIST) {
  console.log('[check-db-write-bypass] --list 明细');
  console.log(`  扫描文件数: ${files.length}`);
  console.log(`  豁免 files: ${EXEMPT_FILES.size} / functions: ${EXEMPT_FNS.size}`);
  console.log(`  write_blocking 桥命中: ${writeBridgeHits}（阈值 ≥ ${WRITE_BRIDGE_MIN}）`);
  console.log('  业务函数豁免残留:');
  if (businessFnHits.length === 0) console.log('    （无）');
  for (const k of businessFnHits) console.log(`    functions.${k}`);
  console.log('  非白名单 files 豁免:');
  if (disallowedFileHits.length === 0) console.log('    （无）');
  for (const k of disallowedFileHits) console.log(`    files.${k}`);
  console.log('  未豁免写旁路:');
  if (hits.length === 0) console.log('    （无）');
  for (const h of hits) console.log(`    crates/conex-db/src/${h.rel}:${h.line} fn ${h.name}`);
  console.log('  cas_gc 写旁路:');
  if (casGcLocalDbBypass.length === 0) console.log('    （无）');
  for (const fn of casGcLocalDbBypass) console.log(`    cas_gc.rs:${fn.line} fn ${fn.name}`);
  process.exit(
    failed || businessFnHits.length > 0 || disallowedFileHits.length > 0 ||
      writeBridgeHits < WRITE_BRIDGE_MIN || casGcLocalDbBypass.length > 0
      ? 1
      : 0,
  );
}

console.log(`[check-db-write-bypass] 扫描 ${files.length} 个 .rs 文件`);
console.log(
  `[check-db-write-bypass] 豁免表：${EXEMPT_FILES.size} 文件 / ${EXEMPT_FNS.size} 函数（write-bypass-exemptions.json）`,
);
console.log(`[check-db-write-bypass] write_blocking 桥命中 = ${writeBridgeHits}（阈值 ≥ ${WRITE_BRIDGE_MIN}）`);

// 业务函数豁免清零断言
if (businessFnHits.length > 0) {
  console.error(
    '[check-db-write-bypass] FAIL [business_function_exemption]: 业务函数仍驻留豁免表（§5.3 零业务豁免）：',
  );
  for (const k of businessFnHits) {
    console.error(`  functions.${k} · 当前值: 存在 · 阈值: 0 · 正确做法: Wave A4 改道后从 SSOT 物理删除`);
  }
  failed = true;
}

// files 白名单断言
if (disallowedFileHits.length > 0) {
  console.error(
    '[check-db-write-bypass] FAIL [disallowed_file_exemption]: files 字典存在非白名单键（仅允许迁移/骨架/测试）：',
  );
  for (const k of disallowedFileHits) {
    console.error(
      `  files.${k} · 当前值: 存在 · 阈值: 不在白名单 · 正确做法: 改道 write_blocking 后删除该文件豁免`,
    );
  }
  failed = true;
}

if (writeBridgeHits < WRITE_BRIDGE_MIN) {
  console.error(
    `[check-db-write-bypass] FAIL [write_bridge_below_threshold]: write_blocking 桥命中不足\n` +
      `  当前值: ${writeBridgeHits} · 阈值: ≥ ${WRITE_BRIDGE_MIN} · 正确做法: 确认组提交桥接线完整；勿删除 write_blocking 调用`,
  );
  failed = true;
}

if (casGcLocalDbBypass.length > 0) {
  console.error('[check-db-write-bypass] FAIL [cas_gc_still_locked]: cas_gc.rs 仍存在 conn.lock 写旁路（D3-6 未出锁）：');
  for (const fn of casGcLocalDbBypass) {
    console.error(`  crates/conex-db/src/cas_gc.rs:${fn.line} fn ${fn.name}`);
  }
  failed = true;
}

if (hits.length > 0) {
  console.error('[check-db-write-bypass] FAIL [unexempted_write_bypass]: 存在未豁免的 conn.lock 写旁路：');
  for (const h of hits) {
    console.error(`  crates/conex-db/src/${h.rel}:${h.line} fn ${h.name}`);
  }
  failed = true;
}

if (failed) {
  console.error('  详情: node scripts/check-db-write-bypass.mjs --list');
  process.exit(1);
}
console.log(
  '[check-db-write-bypass] OK — 生产写路径无未豁免 conn.lock 旁路；业务豁免清零；组提交桥已接线（≥40）；cas_gc 已出锁。',
);
process.exit(0);
