#!/usr/bin/env node
/**
 * scripts/check-text-color-tokens.mjs
 * 文字灰度 SSOT 门禁：防止硬编码文字色、color-mix 旁路灰阶、正文 opacity 压暗回潮。
 *
 * 规范（与 tokens.css 对齐）：
 * - 正文灰度只允许 --text-primary / secondary / tertiary / faint / muted
 *   及语义 --text-danger / success / on-accent / on-danger / on-overlay 等
 * - 禁止 color: #hex / hsl(...)（白名单路径除外）
 * - 禁止 color: color-mix(in srgb, var(--text-*) ... transparent) 自造中间灰
 * - 禁止同一规则内 color: var(--text-*) + 静态 opacity 压暗（放行 hover 显隐 0 / :disabled / ::placeholder）
 *
 * 违规 Exit 1。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const DESKTOP_SRC = path.resolve(REPO_ROOT, 'apps/crish-desktop/src');

/** 白名单：相对 DESKTOP_SRC 的路径（系统 chrome / 展示页 / 导出 HTML 字符串） */
const ALLOW_PATH_PREFIXES = [
  'styles/tokens.css',
  'components/gallery/',
  'components/shell/WindowControls.module.css',
  'styles/__tests__/',
  'components/ui/Input/',
  'main.tsx',
  'components/agent-card/agentCardUtils.ts',
  'components/sidebar/sidebarHelpers.ts',
];

function isAllowedPath(rel) {
  return ALLOW_PATH_PREFIXES.some((p) => rel === p || rel.startsWith(p));
}

function extractRuleBodies(css) {
  const bodies = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const selector = m[1].trim();
    const body = m[2].replace(/\/\*[\s\S]*?\*\//g, '');
    bodies.push({ selector, body });
  }
  return bodies;
}

function lineOf(content, index) {
  return content.slice(0, index).split('\n').length;
}

function scanFile(relPath, content, errors) {
  if (isAllowedPath(relPath)) return;

  // 1) 硬编码 color: #hex / hsl() / rgb()
  const colorHard = /(?:^|[;{\s])color:\s*(#[0-9a-fA-F]{3,8}\b|hsla?\(|rgba?\()/g;
  let m;
  while ((m = colorHard.exec(content)) !== null) {
    const before = content.slice(Math.max(0, m.index - 24), m.index);
    if (/background|border|outline|shadow|text-decoration|caret|column|accent|stop-color|fill|stroke|box-shadow/i.test(before)) {
      continue;
    }
    errors.push(`${relPath}:${lineOf(content, m.index)}  硬编码文字色: ${m[0].trim().slice(0, 72)}`);
  }

  // 2) color: color-mix(in srgb, var(--text-*
  const colorMixText = /color:\s*color-mix\(\s*in\s+srgb\s*,\s*var\(--text-/gi;
  while ((m = colorMixText.exec(content)) !== null) {
    const before = content.slice(Math.max(0, m.index - 36), m.index + 8);
    if (/text-decoration-color|border-color|background|outline|box-shadow|caret-color/i.test(before)) {
      continue;
    }
    errors.push(`${relPath}:${lineOf(content, m.index)}  禁止 color-mix(text-*) 作文字色，请改用 --text-* token`);
  }

  // 3) 同一规则：color: var(--text-*) + 静态 opacity 压暗
  //    放行 opacity: 0（hover 显隐默认）、:disabled、::placeholder、::before/::after
  const bodies = extractRuleBodies(content);
  for (const { selector, body } of bodies) {
    if (/^\d+%\s*(,\s*\d+%\s*)*$/.test(selector)) continue;
    if (/@keyframes/i.test(selector)) continue;
    if (/:disabled\b/i.test(selector)) continue;
    if (/::placeholder\b/i.test(selector)) continue;
    if (/::?before\b/i.test(selector) || /::?after\b/i.test(selector)) continue;

    const hasTextColor = /(?:^|[;{\s])color:\s*var\(--text-(primary|secondary|tertiary|faint|muted)\b/i.test(body);
    const opacityMatch = body.match(/(?:^|[;{\s])opacity:\s*(0?\.\d+)\s*;/i);
    if (!hasTextColor || !opacityMatch) continue;

    const op = Number(opacityMatch[1]);
    if (op > 0 && op < 0.95) {
      const sel = selector.split('\n').pop().trim().slice(0, 56);
      errors.push(
        `${relPath}  规则 "${sel}": 同时使用 color: var(--text-*) 与 opacity: ${opacityMatch[1]}（请改用层级 token）`,
      );
    }
  }
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'dist') continue;
      walk(p, out);
    } else if (/\.(css|tsx|ts)$/.test(ent.name)) {
      out.push(p);
    }
  }
  return out;
}

function main() {
  const errors = [];
  const files = walk(DESKTOP_SRC);
  for (const abs of files) {
    const rel = path.relative(DESKTOP_SRC, abs).replace(/\\/g, '/');
    scanFile(rel, fs.readFileSync(abs, 'utf8'), errors);
  }

  if (errors.length > 0) {
    console.error('❌ 文字色 SSOT 门禁失败 (check-text-color-tokens)\n');
    for (const e of errors) console.error('  - ' + e);
    console.error(`\n共 ${errors.length} 处违规。请改用 tokens.css 文字 token。`);
    process.exit(1);
  }
  console.log(`✅ 文字色 SSOT 门禁通过（扫描 ${files.length} 个文件）`);
}

export { scanFile, isAllowedPath, extractRuleBodies };

const invoked = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (invoked) main();
