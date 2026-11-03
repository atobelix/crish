/**
 * 13 类工具精准中文语义标题生成与意图过滤门面。
 */

import type { MessageToolCall } from '../../store/layoutStore';
import { clipToolLabel, sanitizeHumanLabel } from './toolLabelSanitizer';
import {
  isHumanExplanation,
  isGenericExplanationSpam,
} from './toolHumanExplanationFilter';
import { toolLabelFromArgs } from './toolDomainDescriptions';

export * from './toolHumanExplanationFilter';
export * from './toolDomainDescriptions';

/** 摘要行人话：优先 AI explanation（意图说明），经严格清洗锁后输出 */
export function toolHumanLabel(tc: MessageToolCall): string {
  return resolveToolHumanLabel(tc).label;
}

/**
 * 人话标签来源（HC1 · D-1 行头单权威文本源的判定依据）：
 * - 'explanation'：模型给出的意图说明（与动作/参数是两个信息源，可并列）；
 * - 'args'：由入参机械派生的整句标签（与行内 action+param 同源同文，
 *   并列必然重复，行内不渲染、只留 aria/Tooltip）。
 */
export type ToolHumanLabelSource = 'explanation' | 'args';

export function resolveToolHumanLabel(tc: MessageToolCall): {
  label: string;
  source: ToolHumanLabelSource;
} {
  const exp = (tc.explanation || '').trim();
  const name = tc.name || '';
  const expLooksLikeRawCmd =
    /^(powershell|pwsh|cmd(?:\.exe)?|bash|sh|zsh)\b/i.test(exp) ||
    (/^[\w./\\:-]+\s+/.test(exp) &&
      exp.length > 48 &&
      !/[\u4e00-\u9fff]/.test(exp));

  if (
    exp &&
    !expLooksLikeRawCmd &&
    !isGenericExplanationSpam(exp) &&
    isHumanExplanation(exp, name)
  ) {
    return {
      label: sanitizeHumanLabel(clipToolLabel(exp), tc.name),
      source: 'explanation',
    };
  }
  if (
    exp &&
    !expLooksLikeRawCmd &&
    /[\u4e00-\u9fff]/.test(exp) &&
    exp.length >= 8 &&
    !isGenericExplanationSpam(exp)
  ) {
    return {
      label: sanitizeHumanLabel(
        clipToolLabel(exp.replace(/^正在/, '')),
        tc.name
      ),
      source: 'explanation',
    };
  }
  return {
    label: sanitizeHumanLabel(clipToolLabel(toolLabelFromArgs(tc)), tc.name),
    source: 'args',
  };
}

/** 只取来源（行头去重判定用，标签文本仍走 toolHumanLabel 单源） */
export function toolHumanLabelSource(
  tc: MessageToolCall
): ToolHumanLabelSource {
  return resolveToolHumanLabel(tc).source;
}
