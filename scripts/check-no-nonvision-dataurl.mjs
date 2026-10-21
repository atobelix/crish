/**
 * §9.4 / §3.3：禁止非视觉多模态路径拼接完整 dataUrl 或绝对盘符路径进 prompt。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── --guide（T-DEBT-08：正确做法指引 · 五元规约） ─────────────────────────────
// 用法：node scripts/check-no-nonvision-dataurl.mjs --guide → 打印违反项/定位/阈值/正确做法。
// 仅在直接运行且带 --guide 时早退；不带 flag 时既有行为零变化。
const __debt08GuideFlag = process.argv.includes('--guide');
if (__debt08GuideFlag) {
  const __debt08Guide = [
    "违反项：非视觉多模态路径拼接完整 dataUrl 或绝对盘符路径进 prompt（§9.4 / §3.3）。",
    "文件:行号 / 当前值：FAIL 输出命中文件:行号。",
    "阈值：0。",
    "正确做法：非视觉资产走引用（文件 id / 相对路径白名单形态），视觉路径维持既有 dataUrl 约定，两者不得混用。",
    "复核：node scripts/check-no-nonvision-dataurl.mjs  # 期望 OK",
  ];
  console.log('[check-no-nonvision-dataurl] 正确做法 · 五元规约\n');
  for (const l of __debt08Guide) console.log('  ' + l);
  process.exit(0);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(
  REPO_ROOT,
  'apps/crish-desktop/src/hooks/chat-stream/multimodal.ts'
);

const src = fs.readFileSync(TARGET, 'utf8');
const errors = [];

if (/源数据:\s*\$\{a\.dataUrl\}/.test(src) || /sourceDataSnippet/.test(src)) {
  errors.push('multimodal.ts 仍将 dataUrl 拼进非视觉 prompt（源数据片段）');
}
if (/路径:\s*\$\{a\.path\}/.test(src) || /pathInfo\s*=\s*[^]*\$\{a\.path\}/.test(src)) {
  errors.push('multimodal.ts 仍将绝对/本地 path 拼进非视觉或通用附件 prompt');
}
if (!/纯文本非视觉模型/.test(src) && !/脱敏元数据/.test(src)) {
  errors.push('multimodal.ts 缺少非视觉脱敏元数据路径标记');
}

if (errors.length) {
  console.error('FAIL no-nonvision-dataurl gate:');
  for (const e of errors) console.error(' -', e);
  process.exit(1);
}
console.log('PASS no-nonvision-dataurl gate');