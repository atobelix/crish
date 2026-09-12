/**
 * FM-14 / D3 DEL-1：conex-db 生产 conn.lock() 写旁路扫描探针。
 *
 * 扫描 crates/conex-db/src/**.rs 中「生产写路径仍持主 Mutex」的共现命中：
 * 同一函数体内出现 `conn.lock`（或 `self.conn.lock`）且含写 SQL 关键字
 * （INSERT / UPDATE / DELETE / REPLACE），且不在豁免表内。
 *
 * 豁免 SSOT：`crates/conex-db/write-bypass-exemptions.json`（机器可读）。
 * 当前登记类目：startup_migrate / startup_import / cross_table_invariant / skeleton / test。
 * cas_gc / lease_guard / 热路径域写已改道 write_blocking，不再豁免。
 *
 * Run: node scripts/check-db-write-bypass.mjs
 * Exit 0 = 无未豁免命中；Exit 1 = 存在写旁路（DEL-1 未完成）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const srcDir = resolve(root, 'crates/conex-db/src');
const exemptionPath = resolve(root, 'crates/conex-db/write-bypass-exemptions.json');

/** 机器可读豁免表（SSOT） */
const exemptions = JSON.parse(readFileSync(exemptionPath, 'utf8'));
const EXEMPT_FILES = new Set(Object.keys(exemptions.files ?? {}));
const EXEMPT_FNS = new Set(Object.keys(exemptions.functions ?? {}));

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

// 反向探针：生产域必须有 write_blocking / writer().write 命中（>0）
let writeBridgeHits = 0;
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const matches = src.match(/write_blocking\s*\(/g);
  if (matches) writeBridgeHits += matches.length;
}

// 附加探针：cas_gc 不得再对 LocalDb 面使用主 Mutex 写旁路（D3-6）
const casGcPath = join(srcDir, 'cas_gc.rs');
const casGcSrc = readFileSync(casGcPath, 'utf8');
const casGcLocalDbBypass = extractFns(casGcSrc).filter(
  (fn) => LOCK_RE.test(fn.body) && WRITE_RE.test(fn.body),
);

console.log(`[check-db-write-bypass] 扫描 ${files.length} 个 .rs 文件`);
console.log(`[check-db-write-bypass] 豁免表：${EXEMPT_FILES.size} 文件 / ${EXEMPT_FNS.size} 函数（write-bypass-exemptions.json）`);
console.log(`[check-db-write-bypass] write_blocking 桥命中 = ${writeBridgeHits}`);

if (writeBridgeHits === 0) {
  console.error('[check-db-write-bypass] FAIL: 生产路径无 write_blocking 桥命中（组提交未接线）');
  failed = true;
}

if (casGcLocalDbBypass.length > 0) {
  console.error('[check-db-write-bypass] FAIL: cas_gc.rs 仍存在 conn.lock 写旁路（D3-6 未出锁）：');
  for (const fn of casGcLocalDbBypass) {
    console.error(`  crates/conex-db/src/cas_gc.rs:${fn.line} fn ${fn.name}`);
  }
  failed = true;
}

if (hits.length > 0) {
  console.error('[check-db-write-bypass] FAIL: 存在未豁免的 conn.lock 写旁路：');
  for (const h of hits) {
    console.error(`  crates/conex-db/src/${h.rel}:${h.line} fn ${h.name}`);
  }
  failed = true;
}

if (failed) {
  process.exit(1);
}
console.log('[check-db-write-bypass] OK — 生产写路径无未豁免 conn.lock 旁路，组提交桥已接线，cas_gc 已出锁。');
process.exit(0);
