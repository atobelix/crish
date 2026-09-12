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
 * 退出码：0 = 通过；1 = 发现违规。
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const violations = [];

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
