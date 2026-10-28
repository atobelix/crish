#!/usr/bin/env node
/**
 * scripts/check-motion-strict.mjs
 *
 * 动效组件严格模式门禁（Motion strict guardrail）
 *
 * 背景（2026-10-27 事故）：全局 `AppMotionProvider` 以
 * `<LazyMotion features={domAnimation} strict>` 锁定动效标签，但多处组件仍
 * 导入并渲染 `motion.*`。在 strict 模式下 Motion 直接抛错，导致：
 * - 设置 · 用量页（SlotText / AnimatedCounter）整页被错误边界接管；
 * - 多端互通开启服务后的普通 Toast（ToastCard）把整个 React 树打崩为白屏。
 *
 * 约束：
 * 1. 生产代码只能从 'motion/react' 导入 `m` 组件（features 由全局
 *    LazyMotion 提供）；禁止导入 `motion` 组件本体；
 * 2. 禁止 `<motion.*>` JSX 与 `motion.create(` 动态工厂；
 * 3. 禁止从已淘汰的 'framer-motion' 包导入（双包分叉会重复打包动效运行时）。
 *
 * 阈值 0；测试文件（*.test.* / *.spec.* / __tests__）不扫描。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
// 允许自检注入（验证门禁可红）：MOTION_STRICT_SCAN_ROOT 指向夹具目录
const SCAN_ROOT =
  process.env.MOTION_STRICT_SCAN_ROOT || path.join(ROOT, 'apps/crish-desktop/src');
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
  const text = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const lines = text.split(/\r?\n/);

  // 1. 命名导入 `motion`（允许同一 import 里的 m / AnimatePresence 等）
  const namedImportRe = /import\s*\{([\s\S]*?)\}\s*from\s*['"]motion\/react['"]/g;
  let match;
  while ((match = namedImportRe.exec(text)) !== null) {
    const members = match[1]
      .split(',')
      .map((part) => part.trim().replace(/^type\s+/, ''))
      .map((part) => part.split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    if (members.includes('motion')) {
      const line = text.slice(0, match.index).split(/\r?\n/).length;
      violations.push(
        `${rel}:${line} 以命名导入引入了 motion 组件（strict 模式下会抛错）；请改用 m`
      );
    }
  }

  // 2. 禁止 framer-motion 双包
  if (/from\s+['"]framer-motion['"]/.test(text)) {
    violations.push(
      `${rel} 仍从 'framer-motion' 导入；统一使用 'motion/react'（禁止双包分叉）`
    );
  }

  // 3. JSX 与动态工厂
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/<\/?motion\.[A-Za-z]/.test(line)) {
      violations.push(
        `${rel}:${i + 1} 使用了 motion.* JSX 标签；全局 LazyMotion(strict) 下必须改用 m.*`
      );
    }
    if (/\bmotion\.create\s*\(/.test(line)) {
      violations.push(
        `${rel}:${i + 1} 使用了 motion.create(...)；strict 模式请改用 m.create(...)`
      );
    }
  }
}

const files = [];
walk(SCAN_ROOT, files);
for (const file of files) scanFile(file);

if (violations.length > 0) {
  console.error(`\nFAIL motion-strict guard (${violations.length}):`);
  for (const [i, violation] of violations.entries()) {
    console.error(`  ${i + 1}. ${violation}`);
  }
  console.error(
    '\n正确做法：import { m } from \'motion/react\'，并使用 <m.div> / <m.span>；' +
      '全局 LazyMotion 已注入 domAnimation。详见 apps/crish-desktop/src/components/motion/AppMotionProvider.tsx。\n'
  );
  process.exit(1);
}

console.log(
  `PASS motion-strict guard（扫描 ${files.length} 个生产文件，0 处 motion.* 违规）`
);
