#!/usr/bin/env node
/**
 * scripts/check-session-message-upsert.mjs
 * 探针 A（详案 06 §5.1 · Wave D1）：session_messages / session_agents 全量清空刚性拦截。
 *
 * 责任：
 *   静态扫描全仓 Rust 源码，刚性拦截任何对 session_messages 或 session_agents
 *   的无界全量 DELETE，零白名单豁免。
 *
 * 合法形态（契约补丁）：
 *   - session_messages：仅允许 `DELETE ... WHERE session_id = ? AND seq >= ?` / `seq > ?`（有界截断）
 *   - session_agents：仅允许追加 `AND agent_id = ?` 或 `AND agent_id NOT IN (...)`（差集移除）
 *
 * 违规形态：
 *   - `DELETE FROM session_messages [WHERE session_id = ?]`（无 seq 限定）
 *   - `DELETE FROM session_agents [WHERE session_id = ?]`（无 agent_id 限定的全删）
 *
 * 五元诊断契约：--list / --guide；违规项 · 文件:行号 · 当前片段 · 规则 · 正确做法。
 *
 * Run: node scripts/check-session-message-upsert.mjs [--list] [--guide <metric>]
 * Exit 0 = 全仓无违规；Exit 1 = 存在违规全量清空（或扫描根缺失 Fail-Closed）。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const LIST = process.argv.includes('--list');
const guideIdx = process.argv.indexOf('--guide');
const GUIDE = guideIdx >= 0 ? process.argv[guideIdx + 1] : undefined;

const METRICS = ['blanket_session_messages_delete', 'blanket_session_agents_delete', 'scan_root_missing'];

const GUIDE_TEXT = {
  blanket_session_messages_delete: [
    'session_messages 禁止无界全量 DELETE（全量清空会抹白消息并级联毁窗）。',
    '合法删除仅限有界差异收缩：DELETE FROM session_messages WHERE session_id = ?N AND seq >= ?M（或 seq > ?M）。',
    '正确做法：改用 (session_id, seq) 增量 Upsert + seq >= 有界 Diff Shrink（messages.rs save_session_body_versioned）。',
    '禁止任何形式的白名单豁免；测试中的负向触发器用例若命中，应在测试内改写为带 seq 限定或改为注入触发器的专用路径。',
  ],
  blanket_session_agents_delete: [
    'session_agents 禁止无 agent_id 限定的全删（会级联清空 session_agent_messages）。',
    '合法删除：追加 AND agent_id = ? 或 AND agent_id NOT IN (...)（Upsert + 差集移除，ADD-01）。',
    '正确做法：save_session_agents / import 路径改走 Upsert + agent_id NOT IN 差集删除。',
  ],
  scan_root_missing: [
    '扫描根 crates/ 缺失时必须 Fail-Closed（exit 1），严禁 silent pass。',
    '正确做法：在仓库根目录运行本探针；确认 crates/conex-db 等目录存在。',
  ],
};

if (GUIDE) {
  const lines = GUIDE_TEXT[GUIDE];
  if (!lines) {
    console.error(`[check-session-message-upsert] 未知指标: ${GUIDE}`);
    console.error(`可用指标: ${METRICS.join(', ')}`);
    process.exit(1);
  }
  console.log(`[check-session-message-upsert] guide: ${GUIDE}`);
  for (const line of lines) console.log(`  - ${line}`);
  process.exit(0);
}

// ── 扫描范围：全仓 crates/ 与 apps/ 下生产 .rs（含 workbench 壳）────────────
const SCAN_ROOTS = [
  resolve(root, 'crates'),
  resolve(root, 'apps/agent-workbench/src-tauri/src'),
];

function listRsFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'target' || name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) listRsFiles(p, out);
    else if (name.endsWith('.rs')) out.push(p);
  }
  return out;
}

// ── 规则正则（修正 review-05 指出的 >= 自杀式 Bug：必须完整匹配 >= 与 >）──
// 仅在 Rust 字符串字面量内匹配，避免 doc 注释里的「禁止 …」说明文字误报。
const BOUNDED_MESSAGES_RE =
  /DELETE\s+FROM\s+session_messages\s+WHERE\s+session_id\s*=\s*\S+\s+AND\s+seq\s*(?:>=|>)\s*\S+/is;
const AGENTS_AGENT_ID_EQ_RE = /AND\s+agent_id\s*=/is;
const AGENTS_AGENT_ID_NOT_IN_RE = /AND\s+agent_id\s+NOT\s+IN\b/is;
// 字符串字面量（普通 "…"，允许跨行；跳过注释中的反引号引用）
const STR_LIT_RE = /"(?:[^"\\]|\\.)*"/gs;

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length;
}

function snippetAt(src, index, len = 120) {
  const lineStart = src.lastIndexOf('\n', index) + 1;
  let lineEnd = src.indexOf('\n', index);
  if (lineEnd < 0) lineEnd = src.length;
  let s = src.slice(lineStart, lineEnd).trim();
  if (s.length > len) s = s.slice(0, len) + '…';
  return s;
}

let failed = false;
const hits = [];
let missingRoots = 0;
const files = [];

for (const dir of SCAN_ROOTS) {
  if (!existsSync(dir)) {
    missingRoots++;
    console.error(
      `[check-session-message-upsert] FAIL: 扫描根缺失（Fail-Closed）: ${dir}\n` +
        `  当前值: missing=${missingRoots} · 阈值: 0 · 正确做法: 在仓库根运行，确认 crates/ 存在`,
    );
    failed = true;
    continue;
  }
  listRsFiles(dir, files);
}

files.sort();

for (const file of files) {
  const rel = file.slice(root.length + 1).replace(/\\/g, '/');
  const src = readFileSync(file, 'utf8');

  // 只扫描字符串字面量内的 SQL（doc 注释 / 行注释里的说明文字不参与判定）
  STR_LIT_RE.lastIndex = 0;
  let lit;
  while ((lit = STR_LIT_RE.exec(src)) !== null) {
    const sql = lit[0];
    const litIndex = lit.index;

    // 规则 1：session_messages 无界删除
    if (/DELETE\s+FROM\s+session_messages\b/i.test(sql)) {
      if (!BOUNDED_MESSAGES_RE.test(sql)) {
        hits.push({
          metric: 'blanket_session_messages_delete',
          file: rel,
          line: lineOf(src, litIndex),
          snippet: snippetAt(src, litIndex),
          rule: 'session_messages 全量清空（无 seq >= / seq > 限定）',
          fix: '改为 WHERE session_id = ? AND seq >= ?（有界 Diff Shrink）',
        });
        failed = true;
      }
    }

    // 规则 2：session_agents 无 agent_id 限定的全删（排除 session_agent_messages）
    // 合法例外：空列表显式清空（agents.is_empty() 分支内）——契约 §2.2
    if (/DELETE\s+FROM\s+session_agents(?!_messages)\b/i.test(sql)) {
      const nearby = src.slice(Math.max(0, litIndex - 400), litIndex);
      const emptyClear = /agents\s*\.is_empty\s*\(\s*\)/.test(nearby);
      if (
        !AGENTS_AGENT_ID_EQ_RE.test(sql) &&
        !AGENTS_AGENT_ID_NOT_IN_RE.test(sql) &&
        !emptyClear
      ) {
        hits.push({
          metric: 'blanket_session_agents_delete',
          file: rel,
          line: lineOf(src, litIndex),
          snippet: snippetAt(src, litIndex),
          rule: 'session_agents 全删（无 agent_id = / NOT IN 且非空列表清空）',
          fix: '改为 Upsert + AND agent_id NOT IN (...)；空列表清空须在 agents.is_empty() 分支内',
        });
        failed = true;
      }
    }
  }
}

if (LIST) {
  console.log(`[check-session-message-upsert] --list 明细（扫描 ${files.length} 个 .rs）`);
  if (hits.length === 0) {
    console.log('  （无违规）');
  } else {
    for (const h of hits) {
      console.log(`  ${h.file}:${h.line}`);
      console.log(`    metric: ${h.metric}`);
      console.log(`    snippet: ${h.snippet}`);
      console.log(`    rule: ${h.rule}`);
      console.log(`    fix: ${h.fix}`);
    }
  }
  console.log(`metrics: blanket_session_messages_delete=${hits.filter((h) => h.metric === 'blanket_session_messages_delete').length}`);
  console.log(`         blanket_session_agents_delete=${hits.filter((h) => h.metric === 'blanket_session_agents_delete').length}`);
  console.log(`         scan_root_missing=${missingRoots}`);
  process.exit(failed ? 1 : 0);
}

console.log(`[check-session-message-upsert] 扫描 ${files.length} 个 .rs 文件`);

if (failed) {
  console.error(
    `[check-session-message-upsert] FAIL: 发现 ${hits.length} 处违规全量清空：`,
  );
  for (const h of hits) {
    console.error(`  ${h.file}:${h.line}  [${h.metric}]`);
    console.error(`    违反项: ${h.rule}`);
    console.error(`    当前片段: ${h.snippet}`);
    console.error(`    正确做法: ${h.fix}`);
  }
  console.error(
    '  阈值: 违规数 = 0（零豁免）· 详情: node scripts/check-session-message-upsert.mjs --list',
  );
  process.exit(1);
}

console.log(
  '[check-session-message-upsert] OK — 全仓无 session_messages / session_agents 无界全量清空（有界 seq 与 agent_id 限定已放行）。',
);
process.exit(0);
