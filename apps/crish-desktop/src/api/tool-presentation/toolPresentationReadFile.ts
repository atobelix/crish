/**
 * apps/crish-desktop/src/api/tool-presentation/toolPresentationReadFile.ts
 *
 * read_file 工具的目标对象（带行号范围超链接）提取器。
 * 遵循架构依赖规则：位于 api/tool-presentation 层，供 model 与 presentation 组件单向消费。
 */

import type { MessageToolCall } from '../../store/types';
import { basename } from './toolArgsNormalizer';
import type { ToolTarget } from './toolPresentationTypes';

/** read_file 目标提取器（用于 ToolPresentation 领域注册模型） */
export function extractReadFileTarget(
  args: Record<string, unknown>,
  tc?: MessageToolCall
): ToolTarget | undefined {
  const p = String(
    args.path ?? args.Path ?? args.filePath ?? args.filepath ?? ''
  ).trim();
  if (!p) return undefined;
  const base = basename(p) || p;
  const m = tc?.output?.match(/^startLine:\s*(\d+),\s*endLine:\s*(\d+)$/im);
  const rangeStr = m ? `:${m[1]}-${m[2]}` : '';
  return {
    text: `${base}${rangeStr}`,
    kind: 'path',
    clickable: true,
    tooltip: rangeStr ? `${p}:${rangeStr.slice(1)}` : p,
  };
}
