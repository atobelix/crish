#!/usr/bin/env node
/**
 * X-05 MP-P5 防回归：Rust 源禁止 `#[path]` 模块属性。
 *
 * 规则：`crates/**` 与 `apps/agent-workbench/src-tauri/**` 下任何 `.rs`
 * （生产与测试一视同仁）出现 `#[path = ...]` 即失败；无白名单。
 *
 * Run: node scripts/check-no-path-attr.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const roots = ['crates', 'apps/agent-workbench/src-tauri'];
const skipDirs = new Set(['target', 'node_modules', 'dist', '.git']);
const pattern = /#\s*\[\s*path\s*=/;

const violations = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.isFile() && entry.name.endsWith('.rs')) {
      const rel = relative(root, full).split(sep).join('/');
      const lines = readFileSync(full, 'utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (pattern.test(lines[i])) violations.push(`${rel}:${i + 1}`);
      }
    }
  }
}

for (const rel of roots) {
  const dir = join(root, rel);
  try {
    if (statSync(dir).isDirectory()) walk(dir);
  } catch {
    // 目录不存在时忽略（分支裁剪场景）
  }
}

if (violations.length > 0) {
  console.error('[check-no-path-attr] FAIL: 禁止 #[path] 模块属性');
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log('[check-no-path-attr] OK — 无 #[path] 属性');
