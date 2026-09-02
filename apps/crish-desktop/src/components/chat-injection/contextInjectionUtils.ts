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
import type { ContextInjectionKind } from '../../store/types';

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
