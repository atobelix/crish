/**
 * 工具展示卡片格式化逻辑（P5 T-P5-02 · ToolPresentation SSOT）。
 *
 * 职责：
 * 1. 人类意图说明清洗与内含目标判定（cleanHumanExplanation / isTargetContainedInExplanation）
 * 2. 状态标签与无障碍朗读文本格式化（formatPresentationStatus / formatRowAriaLabel）
 * 3. 失败态错误提炼（formatErrorTarget）
 * 4. 展示元数据编排截断（formatPresentationMeta，预算最多 2 项）
 * 5. MCP 动态动作标题解析（resolveMcpAction）
 */

import type { MessageToolCall } from '../../store/types';
import { t } from '../../i18n';
import { basename } from './toolArgsNormalizer';
import {
  clipText,
  resolveDiffMeta,
  resolveDurationMeta,
  str,
} from './toolPresentationParsers';
import type {
  ToolMeta,
  ToolPresentationOptions,
  ToolPresentationRegistration,
  ToolPresentationStatus,
  ToolTarget,
} from './toolPresentationTypes';

export const EXT_LANG_ALIASES: Readonly<Record<string, readonly string[]>> = {
  rs: ['rust', '.rs'],
  ts: ['typescript', '.ts'],
  tsx: ['typescript', 'react', '.tsx'],
  js: ['javascript', '.js'],
  jsx: ['javascript', 'react', '.jsx'],
  py: ['python', '.py'],
  go: ['golang', '.go'],
  md: ['markdown', '.md'],
  json: ['json', '.json'],
  css: ['css', 'style', '.css'],
  html: ['html', '.html'],
  toml: ['toml', '.toml'],
  yaml: ['yaml', '.yaml'],
  yml: ['yaml', '.yml'],
};

/** 清理并验证人类意图说明 */
export function cleanHumanExplanation(
  raw?: string | null,
  toolName?: string
): string {
  if (!raw) return '';
  const text = raw.replace(/\s+/g, ' ').trim();
  const needsApprovalZh = t('tool.action.needsApproval', '需要确认');
  if (
    !text ||
    text === needsApprovalZh ||
    text.toLowerCase() === 'needs approval' ||
    text.startsWith('{') ||
    text.startsWith('[')
  ) {
    return '';
  }
  if (toolName && text.toLowerCase() === toolName.toLowerCase()) return '';
  return clipText(text, 120);
}

/** 判定 explanation 是否已内含 target（含去除引号、不带扩展名 stem 及通配符语言映射） */
export function isTargetContainedInExplanation(
  explanation: string,
  target: ToolTarget | undefined
): boolean {
  if (!explanation || !target || !target.text) return false;
  const expLower = explanation.toLowerCase();
  const stripped = target.text
    .trim()
    .replace(/^["'「『`]+|["'」』`]+$/g, '')
    .trim();
  if (!stripped || stripped === '.') return false;

  if (expLower.includes(stripped.toLowerCase())) return true;
  if (target.tooltip) {
    const tipBase = basename(target.tooltip).toLowerCase();
    if (tipBase && tipBase !== '.' && expLower.includes(tipBase)) return true;
  }

  const base = basename(stripped);
  const dotIdx = base.lastIndexOf('.');
  if (dotIdx > 0) {
    const stem = base.slice(0, dotIdx).trim();
    if (
      stem &&
      stem !== '*' &&
      stem.length >= 3 &&
      expLower.includes(stem.toLowerCase())
    ) {
      return true;
    }
    const ext = base.slice(dotIdx + 1).toLowerCase();
    if (
      stem === '*' &&
      EXT_LANG_ALIASES[ext]?.some((alias) => expLower.includes(alias))
    ) {
      return true;
    }
  }
  return false;
}

/** 格式化状态中文文本 */
export function formatPresentationStatus(
  status: ToolPresentationStatus
): string {
  switch (status) {
    case 'running':
      return t('tool.action.statusRunning', '执行中');
    case 'error':
      return t('tool.action.statusFailed', '失败');
    case 'pending':
      return t('tool.action.statusPending', '待确认');
    case 'success':
    default:
      return t('tool.action.statusSuccess', '完成');
  }
}

/** 格式化无障碍 aria-label 文本 */
export function formatRowAriaLabel(
  label: string,
  targetText?: string,
  meta: readonly ToolMeta[] = [],
  statusZh?: string
): string {
  return [
    label,
    targetText,
    ...meta.map((m) => m.ariaLabel || m.text),
    statusZh,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** 失败态错误摘要格式化（status === 'error' 时提取首行错误摘要至 target，截断 60 字符） */
export function formatErrorTarget(
  output: string,
  defaultAction: string,
  currentLabel: string
): { target: ToolTarget; label: string } {
  const trimmed = output.trim();
  const firstLine =
    trimmed
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) || t('tool.action.executionFailed', '执行失败');
  const cleanErr =
    firstLine.replace(/^(?:\[[^\]]+\]\s*)+/, '').trim() || firstLine;
  const errText = clipText(cleanErr, 60);
  return {
    target: {
      text: errText,
      kind: 'text',
      clickable: false,
      tooltip: trimmed,
    },
    label: currentLabel === errText ? defaultAction : currentLabel,
  };
}

/** 提取并限制展示元数据（最多保留 2 项：Diff 统计 > 次要指标 > 耗时） */
export function formatPresentationMeta(
  tc: MessageToolCall,
  args: Record<string, unknown>,
  reg?: ToolPresentationRegistration,
  options?: ToolPresentationOptions
): readonly ToolMeta[] {
  const metaList: ToolMeta[] = [...resolveDiffMeta(tc, options?.diffStats)];
  if (reg?.extractMeta) {
    for (const m of reg.extractMeta(tc, args)) {
      if (
        (m.type === 'diff' && metaList.some((x) => x.type === 'diff')) ||
        m.type === 'duration'
      ) {
        continue;
      }
      metaList.push(m);
    }
  }
  metaList.push(...resolveDurationMeta(tc, options?.durationStr));
  return metaList.slice(0, 2);
}

/** 格式化 MCP 工具调用动作标题 */
export function resolveMcpAction(args: Record<string, unknown>): string {
  const s = str(args, ['server', 'servername', 'server_name']);
  const tName = str(args, ['tool', 'toolname', 'tool_name']);
  if (s && tName) return `MCP [${s}:${tName}]`;
  if (tName) return `MCP [${tName}]`;
  if (s) return `MCP [${s}]`;
  return t('tool.action.mcpCall', '调用 MCP 工具');
}
