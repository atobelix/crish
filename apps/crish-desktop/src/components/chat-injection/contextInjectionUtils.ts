/**
 * chat-injection 纯逻辑工具库：图标映射 / 分类文案 / 语义色调类提取 / Token 格式化。
 * 无 React 副作用，可独立单测。
 */
import React from 'react';
import {
  Box,
  Brain,
  Clock,
  FileCode2,
  FolderTree,
  GitBranch,
  Navigation,
  ShieldCheck,
  Sparkles,
  Terminal,
} from 'lucide-react';
import type { ContextInjectionKind, MessageContextInjection } from '../../store/types';

/** 注入图标组件签名（统一 size / strokeWidth / className，方便槽位套用） */
export type InjectionIconComponent = React.FC<{
  size?: number | string;
  strokeWidth?: number | string;
  className?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
}>;

/** 分类 → 图标映射（7+2 类语义图标 + 兜底 Box） */
export function getInjectionIcon(kind: ContextInjectionKind): InjectionIconComponent {
  switch (kind) {
    case 'rule':
      return ShieldCheck;
    case 'skill':
      return Sparkles;
    case 'file_context':
      return FileCode2;
    case 'git_status':
      return GitBranch;
    case 'terminal_output':
      return Terminal;
    case 'runtime_steering':
      return Navigation;
    case 'schedule_trigger':
      return Clock;
    case 'memory':
      return Brain;
    case 'workspace_env':
      return FolderTree;
    default:
      return Box;
  }
}

/** 分类 → 中文展示文案（Header 分类徽章） */
export function getInjectionKindLabel(kind: ContextInjectionKind): string {
  switch (kind) {
    case 'rule':
      return '规则注入';
    case 'skill':
      return '技能上下文';
    case 'file_context':
      return '文件上下文';
    case 'git_status':
      return 'Git 状态';
    case 'terminal_output':
      return '终端上下文';
    case 'runtime_steering':
      return '运行时纠偏';
    case 'schedule_trigger':
      return '定时唤醒';
    case 'memory':
      return '会话记忆';
    case 'workspace_env':
      return '工作区环境';
    default:
      return '系统注入';
  }
}

/** 注入生命周期状态 → 中文文案（aria / 展示） */
export function getInjectionStatusLabel(
  status: MessageInjectionStatusLike
): string {
  switch (status) {
    case 'pending':
      return '准备中';
    case 'injected':
      return '已注入';
    case 'active':
      return '持续生效';
    case 'expired':
      return '已过期';
    case 'failed':
      return '注入失败';
    default:
      return '未知状态';
  }
}

type MessageInjectionStatusLike =
  | 'pending'
  | 'injected'
  | 'active'
  | 'expired'
  | 'failed';

/**
 * 分类 → CSS Module 语义色调类名提取。
 * 7 类语义色 + 2 类（memory / workspace_env）回落 toneDefault 中性灰。
 * kind 均按 ContextInjectionKind 穷举，default 分支仅兜底畸形数据。
 */
export function getInjectionToneClass(
  kind: ContextInjectionKind,
  styles: Record<string, string>
): string {
  switch (kind) {
    case 'rule':
      return styles.toneRule || '';
    case 'skill':
      return styles.toneSkill || '';
    case 'file_context':
      return styles.toneFile || '';
    case 'git_status':
      return styles.toneGit || '';
    case 'terminal_output':
      return styles.toneTerminal || '';
    case 'runtime_steering':
      return styles.toneSteering || '';
    case 'schedule_trigger':
      return styles.toneSchedule || '';
    default:
      return styles.toneDefault || '';
  }
}

/**
 * Token 估算格式化：< 1000 → "N t"；≥ 1000 → "N.Nk t"。
 * 非有限值回退空串（避免 NaN/Infinity 渲染）。
 */
export function formatTokenCount(tokens: number): string {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) {
    return '';
  }
  if (tokens < 1000) return `${Math.round(tokens)} t`;
  return `${(tokens / 1000).toFixed(1)}k t`;
}

/** 注入标题中的控制字符清洗（杜绝注入标题引发布局破坏） */
export function sanitizeInjectionTitle(title: string): string {
  return (title || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 判定注入实体是否为状态切换感知项（模型/服务商/权限/档位切换通知）。
 * 覆盖 metadata.mode、title、content、summary 等多种上游产生路径。
 */
export function isContextStateInjection(
  injection: Partial<MessageContextInjection> | undefined
): boolean {
  if (!injection) return false;
  if (
    injection.metadata &&
    (injection.metadata as Record<string, unknown>).mode === 'context-state'
  ) {
    return true;
  }
  const title = injection.title || '';
  if (title.includes('状态切换') || title.includes('上下文状态切换')) {
    return true;
  }
  const content = injection.content || '';
  if (
    content.includes('[系统上下文注入 · 状态切换]') ||
    content.includes('当前已切换到模型') ||
    content.startsWith('切换到') ||
    content.startsWith('系统 · 切换到')
  ) {
    return true;
  }
  const summary = injection.summary || '';
  if (summary.includes('当前已切换到模型') || summary.includes('状态切换')) {
    return true;
  }
  return false;
}

/**
 * 格式化上下文状态切换在对话流中的展示文案（极简纯文字打样）。
 * 剥离内部机器标头与服务端标识噪点，统一输出为：
 * `系统 · 切换到<model>。 权限模式：<mode>。`（若含思考档位则追加）。
 */
export function formatContextStateDisplayText(rawText: string): string {
  if (!rawText) return '系统 · 状态切换';

  let text = rawText.trim();

  // 1. 去掉方括号标头（如 [系统上下文注入 · 状态切换]）
  text = text.replace(/^\[系统上下文注入\s*[·\-_]\s*状态切换\]\s*/i, '').trim();

  // 2. 去掉服务商/服务端等内部 profile 标识，如 "(服务端 custom-ms983y2d)" 或 "（服务商 p1）"
  text = text.replace(/[(（](?:服务商|服务端)\s*[^)）]+[)）]\s*/g, '');

  // 3. 将 "当前已切换到模型" 或 "已切换到模型" 规范为 "切换到"
  text = text.replace(/(?:当前)?已切换到模型\s*/g, '切换到');

  // 4. 清理标点符号前的多余空格，例如 "muse-spark-1.2-contributor 。" -> "muse-spark-1.2-contributor。"
  text = text.replace(/\s+([。！？:：])/g, '$1');

  // 5. 规范标点："权限模式: full" -> "权限模式：full"
  text = text.replace(/权限模式\s*[:：]\s*/g, '权限模式：');
  text = text.replace(/思考档位\s*[:：]\s*/g, '思考档位：');

  // 6. 规范句子之间的空格分隔，例如 "。权限模式：" -> "。 权限模式："
  text = text.replace(/([。！？])\s*([^\s。！？])/g, '$1 $2');

  // 7. 统一前缀为 "系统 · "（避免重复添加）
  text = text.replace(/^系统\s*[·\-_]\s*/, '');
  text = `系统 · ${text.trim()}`;

  return text;
}
