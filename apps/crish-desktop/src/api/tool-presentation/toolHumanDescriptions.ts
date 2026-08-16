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
    return sanitizeHumanLabel(clipToolLabel(exp), tc.name);
  }
  if (
    exp &&
    !expLooksLikeRawCmd &&
    /[\u4e00-\u9fff]/.test(exp) &&
    exp.length >= 8 &&
    !isGenericExplanationSpam(exp)
  ) {
    return sanitizeHumanLabel(clipToolLabel(exp.replace(/^正在/, '')), tc.name);
  }
  return sanitizeHumanLabel(clipToolLabel(toolLabelFromArgs(tc)), tc.name);
}
