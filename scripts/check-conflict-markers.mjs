#!/usr/bin/env node

/**
 * Git 冲突标记快速扫描门禁（check-conflict-markers.mjs）
 *
 * 扫描 staged 文件（或 --all 模式下全量跟踪文件）中的未解析 Git 冲突标记：
 * `<<<<<<<`, `=======`, `>>>>>>>`
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const isAllMode = process.argv.includes('--all');

function getFilesToScan() {
  if (isAllMode) {
    try {
      const output = execSync('git ls-files', { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
      return output
        .split('\n')
        .map((f) => f.trim())
        .filter((f) => f.length > 0 && fs.existsSync(f) && fs.statSync(f).isFile());
    } catch {
      return [];
    }
  }

  // 默认模式：优先检查 staged 文件
  try {
    const output = execSync('git diff --cached --name-only --diff-filter=ACM', {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    });
    const staged = output
      .split('\n')
      .map((f) => f.trim())
      .filter((f) => f.length > 0 && fs.existsSync(f) && fs.statSync(f).isFile());

    if (staged.length > 0) {
      return staged;
    }
  } catch {
    // 忽略异常，降级全量检查
  }

  // 若无 staged 文件（例如本地直接运行 npm run check:conflict-markers），扫描 git diff 变更文件与未跟踪文件
  try {
    const output = execSync('git status --porcelain', {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    });
    const modified = output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 3)
      .map((line) => line.slice(3).trim())
      .filter((f) => f.length > 0 && fs.existsSync(f) && fs.statSync(f).isFile());
    if (modified.length > 0) {
      return modified;
    }
  } catch {
    // 忽略
  }

  return [];
}

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svgz',
  '.wasm', '.lock', '.exe', '.dll', '.so', '.dylib', '.bin',
  '.pdf', '.zip', '.tar', '.gz', '.db', '.sqlite',
]);

const CONFLICT_MARKER_REGEX = /^(<{7}|={7}|>{7})(?:\s+.*)?$/;

const files = getFilesToScan();
let violations = 0;

for (const file of files) {
  const ext = path.extname(file).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) continue;
  if (file.includes('node_modules') || file.includes('.git/') || file.includes('target/')) continue;

  try {
    const content = fs.readFileSync(file, 'utf-8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trimEnd();
      if (CONFLICT_MARKER_REGEX.test(line)) {
        console.error(
          `❌ [ConflictMarker] ${file}:${i + 1} - Unresolved Git conflict marker detected:\n   ${line}`
        );
        violations++;
      }
    }
  } catch {
    // 忽略无法以 UTF-8 读取的二进制/临时文件
  }
}

if (violations > 0) {
  console.error(
    `\n❌ Total ${violations} unresolved Git conflict marker(s) detected. Please resolve them before committing.\n`
  );
  process.exit(1);
} else {
  console.log(`✅ [check-conflict-markers] 0 conflict markers detected across ${files.length} scanned file(s).`);
  process.exit(0);
}
