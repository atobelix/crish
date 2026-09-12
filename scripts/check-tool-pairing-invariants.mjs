#!/usr/bin/env node
/**
 * scripts/check-tool-pairing-invariants.mjs
 * 探针 B（详案 06 §5.2 · Wave D2）：工具成对与恢复断言（结构性静态守门）。
 *
 * 三大刚性判定维度：
 *   1. converge_orphan_pairing_missing —— loop_exec.rs 的 converge 终态收敛
 *      必须显式包含 reconcile_orphan_tool_calls 或 assert_tool_pairing_invariants
 *      调用（孤儿工具闭环守卫接线）。
 *   2. executing_tools_bare_exit —— executing_tools.rs 在 check_control 命中退出前
 *      必须存在向合成器分派未执行工具的调用；严禁裸退
 *      `return Ok(HandlerOutcome::end(end))`。
 *   3. restore_reconcile_terminal_conflicts —— restore_manager.rs 全文件物理绝迹
 *      reconcile_terminal_conflicts 符号与「只上报不修正」类消极对账语义。
 *
 * 五元诊断契约：--list / --guide；违规项 · 文件:行号 · 当前值 · 阈值 · 正确做法。
 *
 * Run: node scripts/check-tool-pairing-invariants.mjs [--list] [--guide <metric>]
 * Exit 0 = 三维度全绿；Exit 1 = 存在违规（或关键文件缺失 Fail-Closed）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const LIST = process.argv.includes('--list');
const guideIdx = process.argv.indexOf('--guide');
const GUIDE = guideIdx >= 0 ? process.argv[guideIdx + 1] : undefined;

const METRICS = [
  'converge_orphan_pairing_missing',
  'executing_tools_bare_exit',
  'restore_reconcile_terminal_conflicts',
  'key_file_missing',
];

const GUIDE_TEXT = {
  converge_orphan_pairing_missing: [
    'converge 是全部收敛路径的唯一收口；若不在 converge 内闭合孤儿 tool_use，中断后孤儿调用会引爆上游 LLM HTTP 400。',
    '正确做法：在 crates/session-loop/src/loop/loop_exec.rs 的 converge 函数体内显式调用 reconcile_orphan_tool_calls 或 assert_tool_pairing_invariants。',
    '阈值: converge 内匹配符号数 ≥ 1。',
  ],
  executing_tools_bare_exit: [
    'executing_tools 在 abort / 控制意图命中时裸退，会使前序 tool_use 永久孤立（D-S01）。',
    '正确做法：check_control 命中后先向 Tier-1 工具中断合成器分派未执行工具（产出取消态结果），再安全退出；严禁块内仅 return Ok(HandlerOutcome::end(end))。',
    '阈值: 裸退模式数 = 0。',
  ],
  restore_reconcile_terminal_conflicts: [
    'reconcile_terminal_conflicts 是 G-29 消极对账死函数（只报不修），已由事件权威前置决策取代（D-O03）。',
    '正确做法：物理删除 restore_manager.rs 中的 reconcile_terminal_conflicts 定义与全部调用；终态查询前置到处理循环之前。',
    '阈值: reconcile_terminal_conflicts 出现次数 = 0。',
  ],
  key_file_missing: [
    '关键守卫目标文件缺失时必须 Fail-Closed（exit 1），严禁 silent pass。',
    '正确做法：确认 loop_exec.rs / executing_tools.rs / restore_manager.rs 仍位于约定路径；若路径迁移，同步更新本探针 SCAN 目标。',
  ],
};

if (GUIDE) {
  const lines = GUIDE_TEXT[GUIDE];
  if (!lines) {
    console.error(`[check-tool-pairing-invariants] 未知指标: ${GUIDE}`);
    console.error(`可用指标: ${METRICS.join(', ')}`);
    process.exit(1);
  }
  console.log(`[check-tool-pairing-invariants] guide: ${GUIDE}`);
  for (const line of lines) console.log(`  - ${line}`);
  process.exit(0);
}

// ── 扫描目标（约定路径；缺失即 Fail-Closed）────────────────────────────────
const LOOP_EXEC = 'crates/session-loop/src/loop/loop_exec.rs';
const EXECUTING_TOOLS = 'crates/session-loop/src/loop/handlers/executing_tools.rs';
const RESTORE_MANAGER = 'crates/orchestrator/src/restore_manager.rs';

function readRequired(rel) {
  const abs = resolve(root, rel);
  if (!existsSync(abs)) return null;
  return readFileSync(abs, 'utf8');
}

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length;
}

/** 从 fn name 起按花括号配对提取**实现体**（跳过 trait/extern 中以 `;` 结束的声明）。 */
function extractFn(src, name) {
  const re = new RegExp(
    `(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?fn\\s+${name}\\b\\s*(?:<[^>]*>)?\\s*\\(`,
    'g',
  );
  let m;
  while ((m = re.exec(src)) !== null) {
    let i = re.lastIndex;
    while (i < src.length && src[i] !== '{' && src[i] !== ';') i++;
    if (i >= src.length) continue;
    if (src[i] === ';') continue; // trait 声明 / 外部声明，非实现体
    let depth = 0;
    const start = i;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) {
          return { body: src.slice(start, i + 1), start: m.index };
        }
      }
    }
    return { body: src.slice(start), start: m.index };
  }
  return null;
}

/** 检测 check_control 裸退：块内仅 return Ok(HandlerOutcome::end(...))，无合成器分派。
 * 仅扫描函数内**首个** check_control（SP-1 分派前安全点）——批后安全点
 * （工具结果已齐）裸退不破坏成对性，放行。 */
function findBareExits(src) {
  const bare = [];
  const headerRe =
    /if\s+let\s+Some\s*\(\s*\w+\s*\)\s*=\s*check_control\s*\(([^)]*)\)\s*\?\s*\{/g;
  let m;
  let seen = 0;
  while ((m = headerRe.exec(src)) !== null) {
    seen += 1;
    if (seen > 1) break; // 只守 SP-1；批后安全点允许裸 end
    let i = headerRe.lastIndex;
    let depth = 1;
    const bodyStart = i;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    const block = src.slice(bodyStart, i);
    const hasSynthesis =
      /synthes\w*|reconcile_orphan|assert_tool_pairing|mark_rest_cancelled|cancel_pending|emit_cancel/i.test(
        block,
      );
    const codeOnly = block
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim();
    const isBare =
      !hasSynthesis &&
      /^return\s+Ok\s*\(\s*HandlerOutcome::end\s*\(\s*\w+\s*\)\s*\)\s*;?$/.test(codeOnly);
    if (isBare) {
      bare.push({ index: m.index, line: lineOf(src, m.index), snippet: codeOnly });
    }
  }
  return bare;
}

let failed = false;
const hits = [];
let missingKeyFiles = 0;

// ── 维度 1：converge 必须接线 orphan pairing 守卫 ───────────────────────────
{
  const src = readRequired(LOOP_EXEC);
  if (src === null) {
    missingKeyFiles++;
    hits.push({
      metric: 'key_file_missing',
      file: LOOP_EXEC,
      line: 0,
      current: 'missing',
      threshold: 'exists',
      fix: '确认 converge 目标文件路径；路径迁移需同步更新探针',
    });
    failed = true;
  } else {
    const fn = extractFn(src, 'converge');
    const body = fn ? fn.body : '';
    const hasPairing =
      /reconcile_orphan_tool_calls|assert_tool_pairing_invariants/.test(body);
    if (!hasPairing) {
      hits.push({
        metric: 'converge_orphan_pairing_missing',
        file: LOOP_EXEC,
        line: fn ? lineOf(src, fn.start) : 0,
        current: 'converge 体内无 reconcile_orphan_tool_calls / assert_tool_pairing_invariants',
        threshold: '≥ 1 处显式调用',
        fix: '在 converge 内调用 reconcile_orphan_tool_calls 或 assert_tool_pairing_invariants（闭合孤儿 tool_use）',
      });
      failed = true;
    }
  }
}

// ── 维度 2：executing_tools 禁止裸退 ────────────────────────────────────────
{
  const src = readRequired(EXECUTING_TOOLS);
  if (src === null) {
    missingKeyFiles++;
    hits.push({
      metric: 'key_file_missing',
      file: EXECUTING_TOOLS,
      line: 0,
      current: 'missing',
      threshold: 'exists',
      fix: '确认 executing_tools.rs 路径；路径迁移需同步更新探针',
    });
    failed = true;
  } else {
    const bare = findBareExits(src);
    for (const b of bare) {
      hits.push({
        metric: 'executing_tools_bare_exit',
        file: EXECUTING_TOOLS,
        line: b.line,
        current: b.snippet,
        threshold: '裸退模式数 = 0',
        fix: 'check_control 命中后先分派未执行工具至中断合成器，再安全退出；禁止裸 return Ok(HandlerOutcome::end(end))',
      });
      failed = true;
    }
  }
}

// ── 维度 3：restore_manager 消极对账绝迹 ────────────────────────────────────
{
  const src = readRequired(RESTORE_MANAGER);
  if (src === null) {
    missingKeyFiles++;
    hits.push({
      metric: 'key_file_missing',
      file: RESTORE_MANAGER,
      line: 0,
      current: 'missing',
      threshold: 'exists',
      fix: '确认 restore_manager.rs 路径；路径迁移需同步更新探针',
    });
    failed = true;
  } else {
    // 全文件（含注释与定义）物理绝迹
    let idx = src.indexOf('reconcile_terminal_conflicts');
    while (idx >= 0) {
      hits.push({
        metric: 'restore_reconcile_terminal_conflicts',
        file: RESTORE_MANAGER,
        line: lineOf(src, idx),
        current: 'reconcile_terminal_conflicts 符号仍存在',
        threshold: '出现次数 = 0',
        fix: '物理删除 reconcile_terminal_conflicts 定义与调用（D-O03）；终态查询前置为事件权威决策',
      });
      failed = true;
      idx = src.indexOf('reconcile_terminal_conflicts', idx + 1);
    }
  }
}

if (LIST) {
  console.log('[check-tool-pairing-invariants] --list 明细');
  if (hits.length === 0) {
    console.log('  （无违规）');
  } else {
    for (const h of hits) {
      console.log(`  ${h.file}:${h.line}`);
      console.log(`    metric: ${h.metric}`);
      console.log(`    当前值: ${h.current}`);
      console.log(`    阈值: ${h.threshold}`);
      console.log(`    正确做法: ${h.fix}`);
    }
  }
  console.log(
    `metrics: converge_orphan_pairing_missing=${hits.filter((h) => h.metric === 'converge_orphan_pairing_missing').length}`,
  );
  console.log(
    `         executing_tools_bare_exit=${hits.filter((h) => h.metric === 'executing_tools_bare_exit').length}`,
  );
  console.log(
    `         restore_reconcile_terminal_conflicts=${hits.filter((h) => h.metric === 'restore_reconcile_terminal_conflicts').length}`,
  );
  console.log(`         key_file_missing=${missingKeyFiles}`);
  process.exit(failed ? 1 : 0);
}

console.log('[check-tool-pairing-invariants] 扫描:');
console.log(`  ${LOOP_EXEC}`);
console.log(`  ${EXECUTING_TOOLS}`);
console.log(`  ${RESTORE_MANAGER}`);

if (failed) {
  console.error(`[check-tool-pairing-invariants] FAIL: 发现 ${hits.length} 处违规：`);
  for (const h of hits) {
    console.error(`  ${h.file}:${h.line}  [${h.metric}]`);
    console.error(`    当前值: ${h.current}`);
    console.error(`    阈值: ${h.threshold}`);
    console.error(`    正确做法: ${h.fix}`);
  }
  console.error('  详情: node scripts/check-tool-pairing-invariants.mjs --list');
  process.exit(1);
}

console.log(
  '[check-tool-pairing-invariants] OK — converge 孤儿成对守卫已接线；executing_tools 零裸退；restore_manager 零消极对账。',
);
process.exit(0);
