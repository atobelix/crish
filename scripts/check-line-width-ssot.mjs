#!/usr/bin/env node
/**
 * scripts/check-line-width-ssot.mjs
 *
 * 线宽 SSOT 门禁 —— 守住「线条粗细统一」这条视觉契约。
 *
 * 背景：仓库已有 check-icon-ssot 只校验「是否经 AppIcon 入口」，
 * 不校验内部 strokeWidth 数值，导致 8 种图标线宽（1.25/1.4/1.5/1.6/1.8/2/2.5/3）
 * 长期共存；CSS 侧也散落 0.1px / 0.5px / 1.5px 等非契约描边。
 *
 * 本门禁校验三件事：
 *  ① 图标描边（strokeWidth）：只允许 ICON_STROKE 契约值（chrome/ui/fine/heavy），
 *     禁止裸数字字面量；合法例外必须在同级上一行有显式注释说明理由。
 *  ② UI 线条（border / outline 宽度）：只允许 1px（--hairline-width）与
 *     2px（--border-width-emphasis）两档；3/4/6px 仅限侧边强调条（border-left 等）。
 *  ③ 焦点环：固定 1.5px，只允许在 focus-visible.css / tokens.css 中定义。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SRC = path.resolve(REPO_ROOT, 'apps/crish-desktop/src');

/**
 * 图标描边契约（与 components/ui/icons/iconTokens.ts 的 ICON_STROKE 同步）。
 * 若 iconTokens 变更，此处必须同步——由文件头部一致性断言兜底。
 */
const ICON_TOKENS_PATH = path.resolve(SRC, 'components/ui/icons/iconTokens.ts');
const UI_LINE_ALLOWED = new Set([0, 1, 2]);
/** 侧边强调条允许的宽度（语义强调，非描边） */
const SIDE_STRIPE_ALLOWED = new Set([1, 2, 3, 4, 6]);
const FOCUS_RING_ALLOWED_FILES = [
  'styles/focus-visible.css',
  'styles/tokens.css',
];

function readIconStrokeValues() {
  const text = fs.readFileSync(ICON_TOKENS_PATH, 'utf8');
  const block = /export const ICON_STROKE = \{([\s\S]*?)\}/.exec(text);
  if (!block) throw new Error('无法从 iconTokens.ts 解析 ICON_STROKE');
  const values = new Set();
  for (const m of block[1].matchAll(/:\s*([\d.]+)\s*,/g)) values.add(parseFloat(m[1]));
  if (!values.size) throw new Error('ICON_STROKE 未解析到任何数值');
  return values;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      walk(p, out);
    } else if (/\.(ts|tsx|css)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 允许豁免的图标资产：几何构造性质的粗描边（非 UI 图标描边语义） */
const ICON_STROKE_EXEMPT = new Set(['assets/icons/ModelVendorFallback.tsx']);

const iconStrokeAllowed = readIconStrokeValues();
const errors = [];

for (const abs of walk(SRC)) {
  const rel = path.relative(SRC, abs).replace(/\\/g, '/');
  const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);

  // ---------- ① 图标描边 ----------
  if (/\.(tsx|ts)$/.test(rel) && !ICON_STROKE_EXEMPT.has(rel)) {
    lines.forEach((line, idx) => {
      const m = /strokeWidth\s*=\s*"([\d.]+)"/.exec(line);
      if (!m) return;
      const v = parseFloat(m[1]);
      if (iconStrokeAllowed.has(v)) return;
      // 上一行若有「合法例外」类注释则豁免（几何载荷显式声明）
      const prev = (lines[idx - 1] ?? '') + line;
      if (/非图标描边|几何(构造|载荷)参数|图表几何|不走\s*ICON_STROKE/.test(prev)) return;
      errors.push(
        `${rel}:${idx + 1}  图标描边裸写 ${v}（契约值：${[...iconStrokeAllowed].join(' / ')}）\n` +
          `      应改用 ICON_STROKE.* ；若是几何载荷请在上一行注明「非图标描边」`,
      );
    });
  }

  // ---------- ② UI 线条宽度 ----------
  if (rel.endsWith('.css')) {
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('/*') || trimmed.startsWith('*')) return;
      if (/radius|offset|shadow/.test(line)) return;
      const m = /(?:^|[{;\s])(border(?:-(?:top|bottom|left|right))?(?:-width)?|outline(?:-width)?)\s*:\s*([^;{}]*)/i.exec(
        line,
      );
      if (!m) return;
      const prop = m[1].toLowerCase();
      const value = m[2];
      // 值里可能含 var(...) 兜底数字：剥掉 var() 内容再看裸字面量
      const stripped = value.replace(/var\([^)]*\)/g, '');
      const nums = [...stripped.matchAll(/(?:^|[\s(])(\d+(?:\.\d+)?)px/g)].map((x) => parseFloat(x[1]));
      if (!nums.length) return;
      for (const n of nums) {
        // 焦点环例外
        if (n === 1.5 && prop.startsWith('outline') && FOCUS_RING_ALLOWED_FILES.includes(rel)) continue;
        if (prop.startsWith('border-left') || prop.startsWith('border-right')) {
          if (SIDE_STRIPE_ALLOWED.has(n)) continue;
        } else if (UI_LINE_ALLOWED.has(n)) {
          continue;
        }
        errors.push(
          `${rel}:${idx + 1}  UI 线条宽度 ${n}px 不在契约内（常规 1px / 强调 2px；侧边条 3·4·6px）\n` +
            `      应改用 var(--hairline-width) 或 var(--border-width-emphasis)`,
        );
      }
    });
  }
}

if (errors.length) {
  console.error('❌ 线宽 SSOT 门禁失败 (check-line-width-ssot)\n');
  for (const e of errors) console.error('  - ' + e + '\n');
  console.error(`共 ${errors.length} 处违规。`);
  console.error('契约出处：components/ui/icons/iconTokens.ts（图标）· styles/tokens.css（UI 线条）');
  process.exit(1);
}
console.log('✅ 线宽 SSOT 门禁通过');
