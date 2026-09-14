#!/usr/bin/env node
/**
 * FM-15 / U-BLOCK 防御脚本：壳 fs 命令 async + 工具路径 spawn_blocking 纪律。
 *
 * 断言：
 * 1. `fs_commands/mod.rs` 中 `#[tauri::command]` 业务命令必须为 `async fn`（白名单：workbench_discover_skills）。
 * 2. 重 IO 工具 `async fn execute` 体内：
 *    - 存在 `spawn_blocking`；
 *    - 裸 `std::fs::` 仅允许出现在 `spawn_blocking` 闭包内（深度追踪）。
 *
 * 用法：
 *   node scripts/check-async-commands.mjs
 *   node scripts/check-async-commands.mjs --guide <metric>
 *     → 打印该指标的正确做法（五元规约：违反项 · 文件:行号 · 当前值 · 阈值 · 正确做法）；
 *       未知或缺省 metric → 列出可用指标并 exit 1。
 *
 * 指标名（= FAIL 输出的两类违规，一一对应）：
 *   non_async_fs_command      壳 fs 三命令非 async，或缺 async fn / 缺 spawn_blocking（U-BLOCK / DEL-1）
 *   bare_std_fs_in_execute    重 IO 工具 async fn execute 内裸 std::fs（未包 spawn_blocking）或整文件缺 spawn_blocking（U-BLOCK / DEL-9 / INV-B3）
 *
 * 注：--guide 仅在直接运行时生效（本模块若被 import，不劫持导入方流程）。
 *
 * 退出码：0 = 通过；1 = 发现违规。
 */
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const violations = [];

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
  non_async_fs_command: [
    '违反项：壳 fs 命令不是 async（DEL-1），或三命令缺 async fn / 缺 spawn_blocking（U-BLOCK）。',
    '文件:行号 / 当前值：FAIL 列表逐条给出 `<file>[:<line>]: <说明>`；当前值 = 违规条数。',
    '阈值：0。壳 fs 三命令（list_directory / read_file_content / write_file_content）必须全部 async + 内部 spawn_blocking。',
    '',
    '正确做法：`pub(crate) fn` → `pub(crate) async fn`，同步 IO 核心整体移入 tokio::task::spawn_blocking 闭包。',
    '  仓库现存正确范例（apps/agent-workbench/src-tauri/src/fs_commands/mod.rs:29-40，照抄）：',
    '    /// U-BLOCK：async + spawn_blocking——tokio worker 不被同步目录 IO 占满。',
    '    #[tauri::command]',
    '    pub(crate) async fn list_directory<R: tauri::Runtime>(app: AppHandle<R>, path: String) -> ... {',
    '        let result = tokio::task::spawn_blocking(move || directory::list_directory(&app, path))',
    '            .await',
    '            .map_err(|e| /* 沿用既有错误映射，勿改错误码 */)?;',
    '        ...',
    '    }',
    '  要点：闭包入参用值语义 move（PathBuf / String / Vec<u8>）；非 Send 部分在闭包外准备；',
    '        错误码与响应形状零变化；wire 键 workbench_list_directory / workbench_read_file_content /',
    '        workbench_write_file_content 保持不变。禁止「先留同步兼容分支再改」。',
    '  白名单：workbench_discover_skills 允许保持同步（脚本内 WHITELIST）。',
    '权威文档：docs/performance-audit/materials/plans/detail-D2-阻塞IO与Gatekeeper.md §3.1（第 128-166 行）。',
    '复核：node scripts/check-async-commands.mjs  # 期望 OK',
  ],
  bare_std_fs_in_execute: [
    '违反项：agent-tools 重 IO 工具 `async fn execute` 内出现裸 `std::fs::`（未包 spawn_blocking），',
    '        或整个 execute 体缺 spawn_blocking（U-BLOCK / DEL-9 / INV-B3）。',
    '文件:行号 / 当前值：FAIL 列表逐条给出 `<file>[:<line>]: <说明>`；当前值 = 违规条数。',
    '阈值：0（async 路径不得直调同步 std::fs；相关工具文件须至少一处 spawn_blocking）。',
    '',
    '正确做法：把同步 IO 全路径整体 move 进 tokio::task::spawn_blocking 闭包，await 后再做业务组装。',
    '  仓库现存正确范例（crates/agent-tools/src/tools/fs.rs:93-97，照抄）：',
    '    let outcome = {',
    '        let file_path = file_path.clone();',
    '        let display = display.clone();',
    '        tokio::task::spawn_blocking(move || -> Result<ReadFileOutcome, ToolError> {',
    '            let metadata = std::fs::metadata(&file_path)',
    '                .map_err(|e| ToolError::execution_failed("read_file", format!("{display}: {e}")))?;',
    '            ... // 同步 std::fs 全部留在这里',
    '        })',
    '        .await',
    '        .map_err(|e| ToolError::execution_failed("read_file", format!("spawn_blocking: {e}")))?',
    '    };',
    '  要点：闭包入参 move（PathBuf / Vec<u8> / String）；AbortToken 检查留在闭包外循环点；',
    '        行为语义（错误码 / 输出形状）零变化；薄封装函数若仅 .await 委托给已包 spawn 的 helper 则合规。',
    '  覆盖文件：crates/agent-tools/src/tools/{fs,search,replace,diff,project_tree,delete,decompress_context}.rs。',
    '权威文档：docs/performance-audit/materials/plans/detail-D2-阻塞IO与Gatekeeper.md §3.1（第 138-151 行，DEL-9）。',
    '复核：node scripts/check-async-commands.mjs  # 期望 OK（tools spawn_blocking skeleton）',
  ],
};

function printGuide(metric) {
  const g = GUIDE_TEXT[metric];
  if (!g) {
    console.error(`[check-async-commands] 未知指标：${metric}`);
    console.error(`可用：${Object.keys(GUIDE_TEXT).join(", ")}`);
    process.exit(1);
  }
  console.log(`[check-async-commands] 正确做法 · ${metric}\n`);
  for (const l of g) console.log(`  ${l}`);
  process.exit(0);
}

if (isDirectRun && GUIDE_FLAG) printGuide(GUIDE);

// ── 1. 壳 fs_commands 三命令必须 async ──
{
  const path = join(root, "apps/agent-workbench/src-tauri/src/fs_commands/mod.rs");
  const src = stripTestRegions(readFileSync(path, "utf8"));
  const re = /#\[tauri::command[^\]]*\]\s*pub\(crate\)\s+(async\s+)?fn\s+(\w+)/g;
  let m;
  const nonAsync = [];
  while ((m = re.exec(src)) !== null) {
    if (!m[1]) nonAsync.push(m[2]);
  }
  const WHITELIST = new Set(["workbench_discover_skills"]);
  for (const name of nonAsync) {
    if (!WHITELIST.has(name)) {
      violations.push({
        file: "apps/agent-workbench/src-tauri/src/fs_commands/mod.rs",
        text: `#[tauri::command] ${name} 非 async（U-BLOCK / DEL-1）`,
      });
    }
  }
  for (const need of ["list_directory", "read_file_content", "write_file_content"]) {
    if (!new RegExp(`async\\s+fn\\s+${need}\\b`).test(src)) {
      violations.push({
        file: "apps/agent-workbench/src-tauri/src/fs_commands/mod.rs",
        text: `缺少 async fn ${need}`,
      });
    }
    if (!new RegExp(`spawn_blocking`).test(src)) {
      violations.push({
        file: "apps/agent-workbench/src-tauri/src/fs_commands/mod.rs",
        text: "缺少 spawn_blocking（U-BLOCK）",
      });
    }
  }
}

// ── 2. agent-tools 重 IO：async fn execute 内 std::fs 须在 spawn_blocking 内 ──
const toolFiles = [
  "crates/agent-tools/src/tools/fs.rs",
  "crates/agent-tools/src/tools/search.rs",
  "crates/agent-tools/src/tools/replace.rs",
  "crates/agent-tools/src/tools/diff.rs",
  "crates/agent-tools/src/tools/project_tree.rs",
  // INV-B3 残留补齐：删除 / 解压落盘也须 spawn_blocking
  "crates/agent-tools/src/tools/delete.rs",
  "crates/agent-tools/src/tools/decompress_context.rs",
];

for (const rel of toolFiles) {
  const path = join(root, rel);
  let src;
  try {
    src = stripTestRegions(readFileSync(path, "utf8"));
  } catch {
    continue;
  }
  const lines = src.split(/\r?\n/);

  // 找到每个 async fn execute / execute_* 块；块内统计 spawn_blocking 深度与裸 std::fs
  let i = 0;
  while (i < lines.length) {
    // 覆盖薄封装 `async fn execute` 与共享 helper `async fn execute_delete` 等
    if (!/async\s+fn\s+execute(_\w+)?\b/.test(lines[i])) {
      i++;
      continue;
    }
    // 扫描到函数体结束（深度回到 0 且见过开括号）
    let depth = 0;
    let seenOpen = false;
    let hasSpawn = false;
    let hasBareFs = false;
    // spawn_depth: 当前处于 spawn_blocking 闭包内的净深度（>0 表示在内）
    let spawnStack = []; // 记录每个 spawn_blocking 闭包开启时的 depth
    for (let j = i; j < lines.length; j++) {
      const line = lines[j];
      if (/spawn_blocking/.test(line)) {
        hasSpawn = true;
        // 将在本行或下一行遇到的 { 开启闭包
        spawnStack.push(depth + 1); // 闭包体 depth 会 +1
      }
      for (const ch of line) {
        if (ch === "{") {
          depth++;
          seenOpen = true;
        } else if (ch === "}") {
          depth--;
          // 清理已关闭的 spawn 闭包
          spawnStack = spawnStack.filter((d) => d <= depth);
        }
      }
      if (/std::fs::/.test(line) && !/spawn_blocking/.test(line)) {
        const inSpawn = spawnStack.length > 0 && spawnStack.some((d) => depth >= d);
        // 也允许：本行前 15 行内出现 spawn_blocking 且当前深度 > 函数起始深度
        const window = lines.slice(Math.max(i, j - 15), j + 1).join("\n");
        if (!inSpawn && !/spawn_blocking/.test(window)) {
          hasBareFs = true;
          violations.push({
            file: rel,
            line: j + 1,
            text: `async fn execute 内裸 std::fs（非 spawn_blocking）: ${line.trim()}`,
          });
        }
      }
      if (seenOpen && depth <= 0) {
        // 仅当本函数体内出现 std::fs 且无 spawn_blocking 时报；
        // 薄封装（仅 .await 委托到已包 spawn 的 helper）不要求本函数自带。
        const body = lines.slice(i, j + 1).join("\n");
        if (
          !hasSpawn &&
          /std::fs::/.test(body) &&
          rel !== "crates/agent-tools/src/tools/mod.rs" &&
          /tools\/(fs|search|replace|diff|project_tree|delete|decompress_context)\.rs/.test(rel)
        ) {
          violations.push({
            file: rel,
            line: i + 1,
            text: "async fn execute 内 std::fs 且缺少 spawn_blocking（U-BLOCK）",
          });
        }
        break;
      }
    }
    i++;
  }

  // 文件级：IO 工具须至少一处 spawn_blocking（防止整文件无包裹）
  if (/tools\/(fs|search|replace|diff|project_tree|delete|decompress_context)\.rs/.test(rel)) {
    if (!/spawn_blocking/.test(src)) {
      violations.push({
        file: rel,
        text: "文件缺少 spawn_blocking（U-BLOCK / INV-B3）",
      });
    }
  }
}

if (violations.length > 0) {
  console.error("check-async-commands: FAIL");
  for (const v of violations) {
    console.error(`  ${v.file}${v.line ? ":" + v.line : ""}: ${v.text}`);
  }
  process.exit(1);
}

console.log("check-async-commands: OK (shell fs commands async; tools spawn_blocking skeleton)");
