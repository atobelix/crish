#!/usr/bin/env node
/**
 * FM-15 / U-GATE 防御脚本：生产路径禁止 per-call `CommandGatekeeper::new()`。
 *
 * 断言：
 * - 生产 .rs 中 `CommandGatekeeper::new` = 0
 * - 白名单：conex-sandbox tests 目录、crates 下 tests 目录、src 内 #[cfg(test)] 模块
 * - SHARED_GATEKEEPER 的 LazyLock 工厂允许
 *
 * 用法：
 *   node scripts/check-gatekeeper-shared.mjs
 *   node scripts/check-gatekeeper-shared.mjs --guide <metric>
 *     → 打印该指标的正确做法（五元规约：违反项 · 文件:行号 · 当前值 · 阈值 · 正确做法）；
 *       未知或缺省 metric → 列出可用指标并 exit 1。
 *
 * 指标名（= FAIL 输出的违规类别，一一对应）：
 *   per_call_gatekeeper_new   生产路径出现 per-call `CommandGatekeeper::new()` 构造点（U-GATE / DEL-4）
 *
 * 注：--guide 仅在直接运行时生效（本模块若被 import，不劫持导入方流程）。
 *
 * 退出码：0 = 通过；1 = 发现违规生产 new() 站点。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── --guide 解析（增量添加，不影响无 flag 的既有行为） ────────────────────────
function argVal(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const GUIDE_FLAG = process.argv.includes("--guide");
const GUIDE = argVal("--guide");
const isDirectRun =
  !!process.argv[1] &&
  (import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/")) ||
    fileURLToPath(import.meta.url) === resolve(process.argv[1]));

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "target" || name === "dist" || name === ".git") {
      continue;
    }
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, out);
    } else if (name.endsWith(".rs")) {
      out.push(full);
    }
  }
  return out;
}

/** 剥离 #[cfg(test)] 模块内容（粗粒度花括号匹配） */
function stripTestRegions(src) {
  const lines = src.split(/\r?\n/);
  const kept = [];
  let inTest = false;
  let depth = 0;
  let seenOpen = false;
  for (const line of lines) {
    if (!inTest && /#\[cfg\(test\)\]/.test(line)) {
      inTest = true;
      depth = 0;
      seenOpen = false;
      kept.push("// [cfg(test)] stripped");
      continue;
    }
    if (inTest) {
      for (const ch of line) {
        if (ch === "{") {
          depth++;
          seenOpen = true;
        } else if (ch === "}") {
          depth--;
        }
      }
      if (seenOpen && depth <= 0) {
        inTest = false;
      }
      kept.push("");
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

// ── 正确做法指引（--guide <metric>）────────────────────────────────────────
const GUIDE_TEXT = {
  per_call_gatekeeper_new: [
    '违反项：生产路径出现 per-call `CommandGatekeeper::new()` 构造点（U-GATE / DEL-4）。',
    '文件:行号 / 当前值：FAIL 列表逐条打印 `<file>:<line>: <源码行>`；当前值 = 该列表条数。',
    '阈值：0（生产路径恒为 0，不读基线，不得以任何理由豁免为非 0）。',
    '',
    '正确做法：改读进程级共享实例，删除本行 new()。',
    '  权威源已提供静态实例（crates/conex-sandbox/src/lib.rs:24-25）：',
    '    pub static SHARED_GATEKEEPER: LazyLock<CommandGatekeeper> =',
    '        LazyLock::new(CommandGatekeeper::new);',
    '  站点改法（照抄仓库现存正确范例）：',
    '    // 修改前',
    '    let gatekeeper = CommandGatekeeper::new();',
    '    // 修改后（apps/agent-workbench/src-tauri/src/process.rs:77 同款）',
    '    let gatekeeper = &*conex_sandbox::gatekeeper::SHARED_GATEKEEPER;',
    '  需要 Arc 的消费点（crates/agent-tools/src/tools/shell.rs:237 同款）：',
    '    conex_sandbox::gatekeeper::SHARED_GATEKEEPER',
    '        .check_command_with_analysis(&analysis, cmd, &args, &full_line)',
    '  壳层注入点（main.rs 的 app.manage）只构造一次，下游一律 clone Arc 或引用静态，禁止二次 new()。',
    '',
    '允许保留（脚本白名单，勿改）：crates/conex-sandbox/src/lib.rs 的 SHARED_GATEKEEPER LazyLock 工厂；',
    '  */tests/ 集成测试与 crates/conex-sandbox/tests/；src 内 #[cfg(test)] 模块（脚本剥离后判定）。',
    '权威文档：docs/performance-audit/materials/plans/detail-D2-阻塞IO与Gatekeeper.md §3.3（第 243-290 行）。',
    '复核：node scripts/check-gatekeeper-shared.mjs  # 期望 OK（production CommandGatekeeper::new = 0）',
  ],
};

function printGuide(metric) {
  const g = GUIDE_TEXT[metric];
  if (!g) {
    console.error(`[check-gatekeeper-shared] 未知指标：${metric}`);
    console.error(`可用：${Object.keys(GUIDE_TEXT).join(", ")}`);
    process.exit(1);
  }
  console.log(`[check-gatekeeper-shared] 正确做法 · ${metric}\n`);
  for (const l of g) console.log(`  ${l}`);
  process.exit(0);
}

if (isDirectRun && GUIDE_FLAG) printGuide(GUIDE);

const files = walk(join(root, "crates")).concat(
  walk(join(root, "apps", "agent-workbench", "src-tauri", "src")),
);

const re = /CommandGatekeeper\s*::\s*new\s*\(/;
const violations = [];

for (const file of files) {
  const rel = relative(root, file).split(sep).join("/");

  // 集成测试文件白名单（detail-D2 §2.1 注：测试允许）
  if (rel.includes("/tests/") || rel.startsWith("crates/conex-sandbox/tests/")) {
    continue;
  }

  // sandbox lib.rs：SHARED_GATEKEEPER 工厂与测试模块允许
  if (rel === "crates/conex-sandbox/src/lib.rs") {
    const src = readFileSync(file, "utf8");
    const stripped = stripTestRegions(src);
    // 去掉 LazyLock 工厂
    const withoutFactory = stripped.replace(
      /LazyLock::new\(\s*CommandGatekeeper\s*::\s*new\s*\)/g,
      "/* shared factory */",
    );
    // Default impl 的 Self::new 无 CommandGatekeeper:: 前缀，不匹配
    if (re.test(withoutFactory)) {
      const lines = withoutFactory.split(/\r?\n/);
      lines.forEach((line, idx) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        if (re.test(line) && !/LazyLock/.test(line)) {
          violations.push({ file: rel, line: idx + 1, text: trimmed });
        }
      });
    }
    continue;
  }

  const src = readFileSync(file, "utf8");
  const stripped = stripTestRegions(src);
  const lines = stripped.split(/\r?\n/);
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("///") || trimmed.startsWith("*")) {
      return;
    }
    if (re.test(line) && !/LazyLock/.test(line) && !/fn\s+new\s*\(/.test(line)) {
      violations.push({ file: rel, line: idx + 1, text: trimmed });
    }
  });
}

if (violations.length > 0) {
  console.error("check-gatekeeper-shared: FAIL — 生产路径禁止 CommandGatekeeper::new()");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}: ${v.text}`);
  }
  process.exit(1);
}

console.log(
  `check-gatekeeper-shared: OK (${files.length} files scanned; production CommandGatekeeper::new = 0)`,
);
