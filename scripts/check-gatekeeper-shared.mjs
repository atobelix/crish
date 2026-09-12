#!/usr/bin/env node
/**
 * FM-15 / U-GATE 防御脚本：生产路径禁止 per-call `CommandGatekeeper::new()`。
 *
 * 断言：
 * - 生产 .rs 中 `CommandGatekeeper::new` = 0
 * - 白名单：conex-sandbox tests 目录、crates 下 tests 目录、src 内 #[cfg(test)] 模块
 * - SHARED_GATEKEEPER 的 LazyLock 工厂允许
 *
 * 退出码：0 = 通过；1 = 发现违规生产 new() 站点。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

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
