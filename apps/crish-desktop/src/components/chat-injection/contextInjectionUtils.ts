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
import type { ContextStateMetadata } from './contextInjectionTypes';

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
    case 'memory':
      return styles.toneMemory || '';
    case 'workspace_env':
      return styles.toneWorkspace || '';
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

/**
 * 目标路径安全规整（支持带行号锚点与相对路径/URI 转义）
 */
export function normalizeTargetPath(rawPath: string, lineRange?: string): string {
  if (!rawPath) return '';
  let p = rawPath.trim();
  // 1. URI 解码（如包含 %20 等转义）
  if (p.includes('%')) {
    try {
      p = decodeURIComponent(p);
    } catch {
      // ignore
    }
  }
  // 2. 去除 file:// 或 file:/// 协议前缀
  if (p.startsWith('file:///')) {
    p = p.slice(8);
  } else if (p.startsWith('file://')) {
    p = p.slice(7);
  }
  // 3. 统一 Windows 反斜杠为正斜杠（UNC 路径保留双前导斜杠）
  if (!p.startsWith('\\\\')) {
    p = p.replace(/\\/g, '/');
  }
  // 4. 去除多余的前导 ./
  if (p.startsWith('./')) {
    p = p.slice(2);
  }
  // 5. 若传入行号选区 (lineRange) 且路径未自带 :line 或 #Lline 锚点，则优雅追加
  if (lineRange && !/(:\d+|#L?\d+)/i.test(p)) {
    const cleanRange = lineRange.trim().replace(/^L/i, '').replace(/-L/i, '-');
    p = `${p}:${cleanRange}`;
  }
  return p;
}

/**
 * 格式化文件上下文行数或选区信息（Header 胶囊呈现）
 */
export function formatLineInfo(
  lineRange?: string,
  lineCount?: number
): string | undefined {
  if (lineRange && lineRange.trim()) {
    const trimmed = lineRange.trim();
    return trimmed.startsWith('L') ? trimmed : `L${trimmed}`;
  }
  if (typeof lineCount === 'number' && Number.isFinite(lineCount) && lineCount > 0) {
    return `${lineCount} 行`;
  }
  return undefined;
}

/**
 * 超大正文分段截断保护（>1000 行 / >50KB），防止长会话 DOM 节点暴增卡死。
 * 严格保护代码栅格（```）闭合，杜绝 Markdown 渲染破损。
 */
export function getTruncatedContent(
  text: string,
  maxLines = 1000,
  maxBytes = 50 * 1024
): {
  displayText: string;
  totalLines: number;
  shownLines: number;
  isTruncated: boolean;
} {
  if (!text) {
    return { displayText: '', totalLines: 0, shownLines: 0, isTruncated: false };
  }
  const lines = text.split('\n');
  const totalLines = lines.length;

  if (totalLines <= maxLines && text.length <= maxBytes) {
    return { displayText: text, totalLines, shownLines: totalLines, isTruncated: false };
  }

  let currentBytes = 0;
  let shownLines = 0;
  const resultLines: string[] = [];

  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (currentBytes + line.length + 1 > maxBytes && i > 0) {
      break;
    }
    resultLines.push(line);
    currentBytes += line.length + 1;
    shownLines++;
  }

  let displayText = resultLines.join('\n');

  // 检查并修复未闭合的代码栅格
  const codeBlockMatches = displayText.match(/```/g);
  if (codeBlockMatches && codeBlockMatches.length % 2 !== 0) {
    displayText += '\n```\n';
  }

  return { displayText, totalLines, shownLines, isTruncated: true };
}

/** 注入标题中的控制字符清洗（杜绝注入标题引发布局破坏） */
export function sanitizeInjectionTitle(title: string): string {
  return (title || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type { ContextStateMetadata };

/**
 * 判定注入实体是否为状态切换感知项（模型/服务商/权限/档位切换通知）。
 * 优先且严格检查 metadata.mode === 'context-state'（结构化判定）。
 */
export function isContextStateInjection(
  injection: Partial<MessageContextInjection> | undefined
): boolean {
  if (!injection) return false;
  const meta = injection.metadata as Record<string, unknown> | undefined;
  if (meta?.mode === 'context-state') {
    return true;
  }
  const title = injection.title || '';
  if (title === '上下文状态切换' || title === '状态切换') {
    return true;
  }
  return false;
}

/**
 * 格式化上下文状态切换在对话流中的展示文案（极简纯文字打样）。
 * 直接从 metadata 中的 { model, profile, permission, thinking } 进行纯函数格式化输出：
 * 例如 `系统 · 切换到 ${model}${permission ? ` (${permission})` : ''}`
 * 无结构化数据时回落简短文本，绝不做侵入式正则硬编码替换。
 */
export function formatContextStateDisplayText(
  input?: Partial<MessageContextInjection> | ContextStateMetadata | string,
  fallbackText?: string
): string {
  let metadata: ContextStateMetadata | undefined;
  let fallback = fallbackText || '';

  if (typeof input === 'string') {
    fallback = input;
  } else if (input && typeof input === 'object') {
    const inputObj = input as Record<string, unknown>;
    const nestedMeta = inputObj.metadata as Record<string, unknown> | undefined;
    if (inputObj.mode === 'context-state') {
      metadata = inputObj as unknown as ContextStateMetadata;
    } else if (nestedMeta && nestedMeta.mode === 'context-state') {
      metadata = nestedMeta as unknown as ContextStateMetadata;
      fallback = fallback || (typeof inputObj.summary === 'string' ? inputObj.summary : '') || (typeof inputObj.content === 'string' ? inputObj.content : '') || '';
    } else if (typeof inputObj.summary === 'string' || typeof inputObj.content === 'string') {
      fallback = fallback || (typeof inputObj.summary === 'string' ? inputObj.summary : '') || (typeof inputObj.content === 'string' ? inputObj.content : '') || '';
    }
  }

  if (metadata) {
    const parts: string[] = [];
    if (metadata.model) {
      let modelPart = metadata.model;
      if (metadata.permission) {
        modelPart = `${modelPart} (${metadata.permission})`;
      } else if (metadata.profile) {
        modelPart = `${modelPart} (${metadata.profile})`;
      }
      parts.push(`切换到 ${modelPart}`);
    } else if (metadata.permission) {
      parts.push(`权限: ${metadata.permission}`);
    }
    if (
      metadata.thinking &&
      metadata.thinking !== 'off' &&
      metadata.thinking !== 'default'
    ) {
      parts.push(`思考 ${metadata.thinking}`);
    }
    if (parts.length > 0) {
      return `系统 · ${parts.join(' · ')}`;
    }
  }

  // 纯文本兜底（首行提取，安全防御）
  const trimmed = fallback.trim();
  if (!trimmed) return '系统 · 状态切换';
  const firstLine =
    trimmed.split('\n').find((l) => l.trim().length > 0)?.trim() ||
    '系统 · 状态切换';
  return firstLine.startsWith('系统 · ') ? firstLine : `系统 · ${firstLine}`;
}

/**
 * 判定消息是否为纯上下文状态切换载体消息（PureCarrier）。
 * 必须满足全称命题：除了合法的 context-state 注入项外，绝对不包含任何有效业务数据。
 */
export function isContextStateCarrierMessage(
  msg:
    | {
        sender?: string;
        text?: string;
        toolCalls?: unknown[];
        thinking?: string;
        thinkingTurns?: unknown[];
        images?: unknown[];
        attachments?: unknown[];
        errorDetail?: unknown;
        blocks?: Array<{ type: string; id?: string; injection?: Partial<MessageContextInjection> }>;
        injections?: Array<Partial<MessageContextInjection>>;
      }
    | undefined
    | null
): boolean {
  if (!msg || msg.sender !== 'assistant') return false;
  if ((msg.text || '').trim().length > 0) return false;
  if (msg.toolCalls && msg.toolCalls.length > 0) return false;
  if ((msg.thinking || '').trim().length > 0) return false;
  if (msg.thinkingTurns && msg.thinkingTurns.length > 0) return false;
  if (msg.images && msg.images.length > 0) return false;
  if (msg.attachments && msg.attachments.length > 0) return false;
  if (msg.errorDetail) return false;

  const blocks = msg.blocks || [];
  const injections = msg.injections || [];
  const hasBlocks = blocks.length > 0;
  const hasInjections = injections.length > 0;
  if (!hasBlocks && !hasInjections) return false;
  if (hasBlocks && !blocks.every((b) => b.type === 'context_injection')) {
    return false;
  }
  const allInjectionsState =
    !hasInjections || injections.every((inj) => isContextStateInjection(inj));
  const allBlocksState =
    !hasBlocks ||
    blocks.every((b) => {
      const inj = b.injection || injections.find((i) => i.id === b.id);
      return isContextStateInjection(inj);
    });
  return allBlocksState && allInjectionsState;
}

/**
 * 过滤消息列表中连续堆叠的状态切换微提示消息，在同一连续块中仅保留最后一次生效的状态切换，
 * 消除用户在下拉框多次试探切换产生的连续复读微提示。
 */
export function dedupeStateCarrierMessages<
  T extends {
    sender?: string;
    text?: string;
    toolCalls?: unknown[];
    thinking?: string;
    blocks?: Array<{ type: string; injection?: Partial<MessageContextInjection> }>;
    injections?: Array<Partial<MessageContextInjection>>;
  },
>(messages: T[]): T[] {
  if (messages.length <= 1) return messages;
  const result: T[] = [];
  for (let i = 0; i < messages.length; i++) {
    const current = messages[i];
    if (!current) continue;
    if (isContextStateCarrierMessage(current)) {
      const next = messages[i + 1];
      if (next && isContextStateCarrierMessage(next)) {
        continue;
      }
    }
    result.push(current);
  }
  return result;
}
