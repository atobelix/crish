#!/usr/bin/env node
/**
 * SYSTEMATIC-FIX-PLAN §7.3 / AGENTS §21 门禁
 *
 * GFM emoji 短码翻译默认关闭；Rust `GFM_EMOJI_SHORTCODES_DEFAULT` 与
 * JS `GFM_EMOJI_SHORTCODES_DEFAULT` 同为 false；默认渲染路径不得强制开启。
 *
 * Run: node scripts/check-sec7-gfm-emoji.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── --guide（T-DEBT-08：正确做法指引 · 五元规约） ─────────────────────────────
// 用法：node scripts/check-sec7-gfm-emoji.mjs --guide → 打印违反项/定位/阈值/正确做法。
// 仅在直接运行且带 --guide 时早退；不带 flag 时既有行为零变化。
const __debt08GuideFlag = process.argv.includes('--guide');
if (__debt08GuideFlag) {
  const __debt08Guide = [
    "违反项：Rust `GFM_EMOJI_SHORTCODES_DEFAULT` 或 JS 同名常量非 false，或默认渲染路径强制开启 GFM emoji 短码。",
    "文件:行号 / 当前值：FAIL 输出命中文件:行号与当前值。",
    "阈值：两侧常量同 false（AGENTS §21 / SYSTEMATIC-FIX-PLAN §7.3）。",
    "正确做法：保持默认关闭；用户显式 opt-in 才在会话层开启，禁止改默认值。",
    "复核：node scripts/check-sec7-gfm-emoji.mjs  # 期望 OK",
  ];
  console.log('[check-sec7-gfm-emoji] 正确做法 · 五元规约\n');
  for (const l of __debt08Guide) console.log('  ' + l);
  process.exit(0);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const errors = [];

function fail(msg) {
  errors.push(msg);
}

function read(rel) {
  return readFileSync(resolve(root, rel), 'utf8');
}

function checkRustDefaultOff() {
  const rel = 'crates/conex-markdown/src/renderer.rs';
  const src = read(rel);
  if (!/pub const GFM_EMOJI_SHORTCODES_DEFAULT:\s*bool\s*=\s*false/.test(src)) {
    fail(`${rel}: 须有 GFM_EMOJI_SHORTCODES_DEFAULT = false`);
  }
  if (!/translate_gfm_emoji_with\(text,\s*GFM_EMOJI_SHORTCODES_DEFAULT\)/.test(src)) {
    fail(`${rel}: translate_gfm_emoji 须委托 GFM_EMOJI_SHORTCODES_DEFAULT`);
  }
  const handleStart = src.indexOf('fn handle_text');
  const handleEnd = src.indexOf('fn handle_inline_code');
  if (handleStart < 0 || handleEnd < 0) {
    fail(`${rel}: 缺少 handle_text / handle_inline_code`);
    return;
  }
  const body = src.slice(handleStart, handleEnd);
  if (!/translate_gfm_emoji\(text\)/.test(body)) {
    fail(`${rel}: handle_text 须调用 translate_gfm_emoji(text)（走默认关）`);
  }
  if (/translate_gfm_emoji_with\([^)]*true/.test(body)) {
    fail(`${rel}: handle_text 禁止 translate_gfm_emoji_with(..., true)`);
  }
  console.log('ok  sec7_rust_gfm_emoji_default_off');
}

function checkJsDefaultOff() {
  const rel = 'apps/crish-desktop/src/api/markdown-render/markdownInlineFormat.ts';
  const src = read(rel);
  if (!/export const GFM_EMOJI_SHORTCODES_DEFAULT\s*=\s*false\s+as const/.test(src)) {
    fail(`${rel}: 须有 GFM_EMOJI_SHORTCODES_DEFAULT = false as const`);
  }
  if (!/enabled:\s*boolean\s*=\s*GFM_EMOJI_SHORTCODES_DEFAULT/.test(src)) {
    fail(`${rel}: translateGfmEmoji 参数默认须为 GFM_EMOJI_SHORTCODES_DEFAULT`);
  }
  if (/translateGfmEmoji\([^)]*,\s*true\s*\)/.test(src)) {
    fail(`${rel}: 生产路径禁止 translateGfmEmoji(..., true)`);
  }
  if (!/s\s*=\s*translateGfmEmoji\(s\)/.test(src)) {
    fail(`${rel}: formatMarkdownTextSegment 须调用 translateGfmEmoji(s)`);
  }
  console.log('ok  sec7_js_gfm_emoji_default_off');
}

function checkLibExport() {
  const rel = 'crates/conex-markdown/src/lib.rs';
  const src = read(rel);
  if (!src.includes('GFM_EMOJI_SHORTCODES_DEFAULT')) {
    fail(`${rel}: 须 re-export GFM_EMOJI_SHORTCODES_DEFAULT`);
  }
  if (!src.includes('translate_gfm_emoji_with')) {
    fail(`${rel}: 须 re-export translate_gfm_emoji_with`);
  }
  console.log('ok  sec7_rust_lib_exports_default_and_with');
}

checkRustDefaultOff();
checkJsDefaultOff();
checkLibExport();

if (errors.length) {
  console.error('SEC7 FAIL');
  for (const e of errors) console.error(`- ${e}`);
  process.exit(1);
}

console.log('SEC7 PASS  (gfm emoji shortcodes default OFF, rust+js aligned)');
