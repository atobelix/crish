/**
 * 对话流可见注入卡片组件群内部契约（chat-injection）。
 *
 * 与 chat-tool-call 的 ChatToolStackSharedProps 保持同构对称：折叠状态、
 * 路径/Diff/重试等操作回调均由组合根（MessageContent 挂载层）注入，
 * 组件群内不直连任何业务 store（零反向依赖）。
 */
import type { FileDiff, MessageContextInjection } from '../../store/types';

/** 组件群共享交互 props（容器与单行通用） */
export interface ContextInjectionSharedProps {
  /** 活跃会话 ID */
  activeSessionId: string;
  /** 当前消息 ID */
  msgId: string;
  /** 注入项折叠状态映射表（injectionId -> isOpen） */
  expandedInjections?: Record<string, boolean>;
  /** 切换折叠回调 */
  onToggleInjection?: (injectionId: string, nextOpen: boolean) => void;
  /** 打开关联路径回调 */
  onOpenPath?: (filePath: string) => void;
  /** 查看关联 Diff 回调 */
  onOpenDiff?: (diff: FileDiff) => void;
  /** 重新注入/重试回调 */
  onRetryInjection?: (injectionId: string) => void;
}

/** 容器组件 props：一次渲染一批注入卡片（含无障碍 region 封装） */
export interface ContextInjectionBlockProps extends ContextInjectionSharedProps {
  /** 本块包含的注入项集合 */
  injections: MessageContextInjection[];
  className?: string;
}

/** 单行卡片组件 props */
export interface CompactInjectionRowProps extends ContextInjectionSharedProps {
  /** 单个注入项 */
  injection: MessageContextInjection;
  /** 渲染稳定 key */
  rowKey: string;
}

/** 紧凑 Header 栏 props（图标 / 分类徽章 / 标题 / 摘要 / 状态元数据） */
export interface InjectionHeaderProps extends CompactInjectionRowProps {
  isOpen: boolean;
  canToggle: boolean;
  isFailed: boolean;
  isPending: boolean;
  onToggle: () => void;
  retryLabel: string;
  toggleLabel: string;
  rowAriaLabel: string;
}

/** 展开详情面板 props（Markdown 正文 + Diff 快捷跳转） */
export interface InjectionBodyProps {
  injection: MessageContextInjection;
  onOpenPath?: ((filePath: string) => void) | undefined;
  onOpenDiff?: ((diff: FileDiff) => void) | undefined;
}

/** 内容 > 160 字符默认折叠（评审 03 §2.5 折叠策略） */
export const INJECTION_COLLAPSE_CHAR_THRESHOLD = 160;
