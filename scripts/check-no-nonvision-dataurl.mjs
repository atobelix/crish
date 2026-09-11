/**
 * §9.4 / §3.3：禁止非视觉多模态路径拼接完整 dataUrl 或绝对盘符路径进 prompt。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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