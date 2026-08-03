#!/usr/bin/env node
/**
 * G1 clippy 基线 ratchet 脚本（新增告警 > 0 即失败）。
 *
 * 语义（对齐 docs/multi-agent-repair/improvement/04-治理收尾方案.md G1）：
 * - 读取 `基线记录/clippy-workspace-T13.md` 的 BASELINE_LIST_START/END 标记区作为基线真源；
 * - 运行 `cargo clippy --workspace --all-targets`，按「消息文本 + 文件」归一键
 *   （忽略行号列号：行号变动不算新增告警）；
 * - 基线外的告警（新增）→ 输出清单（按文件域分组）并 exit 1；
 * - 存量告警仍在 / 存量减少 → exit 0；存量减少时提示可显式 `--update` 刷新基线；
 * - `--update`：把当前告警集合全量写回标记区（提升基线必须显式、有意的清理，
 *   jcode check_warning_budget.sh 语义：只许降不许升）。
 *
 * Run: node scripts/check-clippy-baseline.mjs [--update]
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const START_MARKER = '<!-- BASELINE_LIST_START -->';
const END_MARKER = '<!-- BASELINE_LIST_END -->';

const UPDATE = process.argv.includes('--update');

function normFile(p) {
  return p.trim().replace(/\\/g, '/');
}

function itemKey(msg, file) {
  return `${msg.trim()}\u0000${normFile(file)}`;
}

function findT13() {
  const docsDir = join(root, 'docs/multi-agent-repair');
  const candidates = [];
  for (const entry of readdirSync(docsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const p = join(docsDir, entry.name, 'clippy-workspace-T13.md');
    if (existsSync(p)) candidates.push(p);
  }
  if (candidates.length !== 1) {
    console.error(
      `[check-clippy-baseline] FAIL: 未找到唯一 T13 基线文件（找到 ${candidates.length} 个）`
    );
    process.exit(1);
  }
  return candidates[0];
}

/** 解析 T13 标记区基线条目：`- 消息  --> 文件:行:列` */
function parseBaseline(text) {
  const si = text.indexOf(START_MARKER);
  const ei = text.indexOf(END_MARKER);
  if (si < 0 || ei < 0 || ei <= si) {
    console.error(
      '[check-clippy-baseline] FAIL: T13 缺少 BASELINE_LIST_START/END 标记区'
    );
    process.exit(1);
  }
  const region = text.slice(si + START_MARKER.length, ei);
  const items = new Map();
  for (const line of region.split('\n')) {
    const m = line.match(/^-\s+(.*?)\s+-->\s+(.+):(\d+):(\d+)\s*$/);
    if (!m) continue;
    const key = itemKey(m[1], m[2]);
    items.set(key, { msg: m[1].trim(), file: normFile(m[2]), line: m[3], col: m[4] });
  }
  return items;
}

/** 运行 clippy（warn 级口径），返回合并输出；编译失败直接退出 */
function runClippy() {
  const res = spawnSync('cargo', ['clippy', '--workspace', '--all-targets'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const text = `${res.stdout || ''}${res.stderr || ''}`;
  if (res.status !== 0) {
    console.error(
      `[check-clippy-baseline] FAIL: cargo clippy 退出码 ${res.status}（编译失败，基线比对前置失败）`
    );
    console.error(text.split('\n').slice(-40).join('\n'));
    process.exit(1);
  }
  return text;
}

/**
 * 解析 clippy 输出告警：`warning: 消息` + `  --> 文件:行:列`（忽略无位置行）。
 * 返回：
 * - byKey：按「消息 + 文件」归一的集合（比对语义：忽略行号，行号变动不算新增）；
 * - raw：唯一告警实例全量（消息 + 文件 + 行 + 列，跨 bin/test 编译目标重复去重，
 *   --update 写回用，保留每处位置供逐条核销）。
 */
function parseWarnings(text) {
  const byKey = new Map();
  const raw = new Map();
  let block = null;
  for (const line of text.split('\n')) {
    const start = line.match(/^(warning|error):\s*(.*)$/);
    if (start) {
      block = { msg: start[2].trim() };
      continue;
    }
    if (!block) continue;
    const loc = line.match(/^\s+-->\s+(.+):(\d+):(\d+)\s*$/);
    if (loc) {
      const item = {
        msg: block.msg,
        file: normFile(loc[1]),
        line: loc[2],
        col: loc[3],
      };
      byKey.set(itemKey(item.msg, item.file), item);
      raw.set(`${item.msg}\u0000${item.file}:${item.line}:${item.col}`, item);
    }
  }
  return { byKey, raw: [...raw.values()] };
}

function printGrouped(keys, map) {
  const byFile = new Map();
  for (const k of keys) {
    const w = map.get(k);
    if (!byFile.has(w.file)) byFile.set(w.file, []);
    byFile.get(w.file).push(w);
  }
  for (const [file, ws] of [...byFile.entries()].sort()) {
    console.error(`  ${file}`);
    for (const w of ws) {
      console.error(`    - ${w.msg}  --> ${w.file}:${w.line}:${w.col}`);
    }
  }
}

const t13Path = findT13();
const baselineText = readFileSync(t13Path, 'utf8');
const baseline = parseBaseline(baselineText);
const { byKey: current, raw: currentRaw } = parseWarnings(runClippy());

const currentKeys = new Set(current.keys());
const baselineKeys = new Set(baseline.keys());
const added = [...currentKeys].filter((k) => !baselineKeys.has(k));
const removed = [...baselineKeys].filter((k) => !currentKeys.has(k));

if (UPDATE) {
  const sorted = [...currentRaw].sort((a, b) =>
    a.msg < b.msg ? -1 : a.msg > b.msg ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line
  );
  const lines = sorted.map((w) => `- ${w.msg}  --> ${w.file}:${w.line}:${w.col}`);
  const eol = baselineText.includes('\r\n') ? '\r\n' : '\n';
  const si = baselineText.indexOf(START_MARKER);
  const ei = baselineText.indexOf(END_MARKER);
  const newText =
    baselineText.slice(0, si + START_MARKER.length) +
    eol +
    lines.join(eol) +
    eol +
    baselineText.slice(ei);
  writeFileSync(t13Path, newText);
  console.log(
    `[check-clippy-baseline] --update 完成：标记区已刷新为 ${lines.length} 条（git diff 可复核）`
  );
  process.exit(0);
}

console.log(
  `[check-clippy-baseline] 基线条目：${baselineKeys.size}，当前告警：${currentKeys.size}，新增：${added.length}，存量减少：${removed.length}`
);

if (added.length > 0) {
  console.error(
    `[check-clippy-baseline] FAIL: 发现 ${added.length} 条新增告警（不在 T13 基线内）：`
  );
  printGrouped(added, current);
  console.error(
    '[check-clippy-baseline] 处置：新增告警必须消除；若确属有意清理后的基线提升，显式运行 `node scripts/check-clippy-baseline.mjs --update`'
  );
  process.exit(1);
}

if (removed.length > 0) {
  console.log(
    `[check-clippy-baseline] OK: 存量减少 ${removed.length} 条（ratchet 允许下降）；清理有意后可显式 \`--update\` 刷新基线`
  );
} else {
  console.log('[check-clippy-baseline] OK: 新增 0，存量全部在基线内');
}
