/**
 * R4-T15 conex-db 拆分行数门禁脚本。
 *
 * 检查：
 * 1. crates/conex-db/src/lib.rs 行数 ≤ 800（lib.rs 仅保留公共 API 面与壳层）
 * 2. crates/conex-db/src/*.rs 每个 mod 文件行数 ≤ 600（tests.rs 亦计入）
 *
 * Run: node scripts/check-conex-db-size.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── --guide（T-DEBT-08：正确做法指引 · 五元规约） ─────────────────────────────
// 用法：node scripts/check-conex-db-size.mjs --guide → 打印违反项/定位/阈值/正确做法。
// 仅在直接运行且带 --guide 时早退；不带 flag 时既有行为零变化。
const __debt08GuideFlag = process.argv.includes('--guide');
if (__debt08GuideFlag) {
  const __debt08Guide = [
    "违反项：crates/conex-db/src/lib.rs 超 800 行，或 src/*.rs 任一 mod 文件超 600 行（tests.rs 计入）。",
    "文件:行号 / 当前值：FAIL 输出超限文件与实测行数。",
    "阈值：lib.rs ≤ 800；mod 文件 ≤ 600（R4-T15 拆分验收定额）。",
    "正确做法：按职责拆出新的 mod 文件（拆出真实逻辑，禁止切空壳/纯 re-import 凑数）；拆分后同步更新文档行数口径。",
    "复核：node scripts/check-conex-db-size.mjs  # 期望 OK",
  ];
  console.log('[check-conex-db-size] 正确做法 · 五元规约\n');
  for (const l of __debt08Guide) console.log('  ' + l);
  process.exit(0);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const srcDir = resolve(root, 'crates/conex-db/src');

const LIB_LIMIT = 800;
const MOD_LIMIT = 600;

function countLines(file) {
  const content = readFileSync(file, 'utf8');
  let lines = 0;
  for (const ch of content) {
    if (ch === '\n') lines++;
  }
  if (content.length > 0 && !content.endsWith('\n')) lines++;
  return lines;
}

let failed = false;

function fail(msg) {
  console.error(`[check-conex-db-size] FAIL: ${msg}`);
  failed = true;
}

const libPath = join(srcDir, 'lib.rs');
const libLines = countLines(libPath);
console.log(
  `[check-conex-db-size] lib.rs = ${libLines} 行（门禁 ≤ ${LIB_LIMIT}）${libLines <= LIB_LIMIT ? '✓' : '✗'}`
);
if (libLines > LIB_LIMIT) {
  fail(`crates/conex-db/src/lib.rs 行数 ${libLines} > ${LIB_LIMIT}（T15 门禁 lib.rs ≤ ${LIB_LIMIT}）`);
}

const files = readdirSync(srcDir)
  .filter((f) => f.endsWith('.rs') && f !== 'lib.rs')
  .sort();
console.log(`[check-conex-db-size] 域 mod 文件数 = ${files.length}`);
let maxMod = 0;
for (const f of files) {
  const n = countLines(join(srcDir, f));
  maxMod = Math.max(maxMod, n);
  const ok = n <= MOD_LIMIT;
  if (!ok) {
    fail(`crates/conex-db/src/${f} 行数 ${n} > ${MOD_LIMIT}（T15 门禁每 mod ≤ ${MOD_LIMIT}）`);
  }
  console.log(
    `  ${ok ? '✓' : '✗'} ${f.padEnd(16)} ${String(n).padStart(4)} 行`
  );
}
console.log(`[check-conex-db-size] 最大 mod 行数 = ${maxMod}（门禁 ≤ ${MOD_LIMIT}）`);

if (failed) {
  console.error(
    '[check-conex-db-size] FAIL: lib.rs 超过 800 行或存在超过 600 行的 mod 文件。'
  );
  process.exit(1);
}

console.log(
  '[check-conex-db-size] OK — lib.rs ≤ 800 行，每个 mod ≤ 600 行，拆分门禁通过。'
);
