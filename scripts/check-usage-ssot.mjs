#!/usr/bin/env node
/**
 * scripts/check-usage-ssot.mjs
 *
 * 用量数据面单一真源门禁（Usage SSOT guardrail）
 *
 * 背景（2026-10-27 事故）：设置 · 用量页读 Rust `usage_records`，生产写入却
 * 只落 localStorage 旧账本（`crish_usage_history_v1`），两套账本互不相通，
 * 导致仪表盘永远为空。现以 Rust DB 为唯一真源：
 * - 生产代码禁止再写入/读取 `crish_usage_history_v1`（唯一例外 =
 *   `api/usage/legacyUsageMigration.ts` 的一次性迁移读取）；
 * - 禁止复活 `usageStore` 模块引用。
 *
 * 阈值 0；测试文件不扫描。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SCAN_ROOT =
  process.env.USAGE_SSOT_SCAN_ROOT || path.join(ROOT, 'apps/crish-desktop/src');
const MIGRATION_MODULE = 'api/usage/legacyUsageMigration.ts';
const IGNORE_DIRS = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.git',
  'target',
]);

const violations = [];

function isTestFile(file) {
  return (
    /\.(test|spec)\.[tj]sx?$/.test(file) ||
    /[\\/]__tests__[\\/]/.test(file)
  );
}

function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(entry.name)) continue;
    if (isTestFile(full)) continue;
    out.push(full);
  }
}

function scanFile(file) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const text = fs.readFileSync(file, 'utf8');

  if (/crish_usage_history_v1/.test(text) && !rel.endsWith(MIGRATION_MODULE)) {
    violations.push(
      `${rel} 引用了退役的 localStorage 用量账本 crish_usage_history_v1；唯一真源 = Rust usage_records`
    );
  }
  if (/from\s+['"][^'"]*\/usageStore['"]/.test(text)) {
    violations.push(
      `${rel} 引用了已删除的 usageStore；用量历史必须走 usage_record_delta / usage_get_dashboard_data`
    );
  }
}

const files = [];
walk(SCAN_ROOT, files);
for (const file of files) scanFile(file);

if (violations.length > 0) {
  console.error(`\nFAIL usage-ssot guard (${violations.length}):`);
  for (const [i, violation] of violations.entries()) {
    console.error(`  ${i + 1}. ${violation}`);
  }
  console.error(
    '\n正确做法：历史流水唯一写入方 = Rust 内核（conex-run::write_back_cache_stats → usage_records）；' +
      '前端只读 usage_get_dashboard_data；旧账本迁移只在 api/usage/legacyUsageMigration.ts 出现。\n'
  );
  process.exit(1);
}

console.log(
  `PASS usage-ssot guard（扫描 ${files.length} 个生产文件，0 处旧账本/usageStore 引用）`
);
