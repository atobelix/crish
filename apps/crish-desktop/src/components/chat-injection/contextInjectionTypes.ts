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
  /** 失败卡片重试注入回调 */
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

/**
 * ContextInjectionCardProps —— 注入卡片组件 props（同构于 CompactInjectionRowProps）
 */
export type ContextInjectionCardProps = CompactInjectionRowProps;

/**
 * 文件上下文专属结构化元数据契约（SSOT）
 */
export interface FileContextMetadata {
  /** 主文件绝对路径或项目相对路径 */
  filePath: string;
  /** 关联的目标文件路径列表（支持多文件引用） */
  targetPaths?: string[];
  /** 关联的文件改动快照（Diff）列表（可选） */
  diffs?: FileDiff[];
  /** 精确计算或估算的上下文 Token 消耗量 */
  tokenEstimate?: number;
  /** 选区行号范围或代码范围提示（例如 "L12-L45"） */
  lineRange?: string;
  /** 文件行数 */
  lineCount?: number;
  /** 文件摘要或批注说明（纯文本，供 Header 快速预览） */
  summary?: string;
  /** 注入触发类型：选区批注 / 文件引用 / 语义检索 / 工具上下文 */
  triggerKind?: 'annotation' | 'at_file' | 'retrieval' | 'tool_output';
  [key: string]: unknown;
}

/**
 * 上下文状态元数据契约（模型/权限/思考档位等切换感知）
 */
export interface ContextStateMetadata {
  mode?: string;
  model?: string;
  profile?: string;
  permission?: string;
  thinking?: string;
  [key: string]: unknown;
}

/** 紧凑 Header 栏 props（图标 / 分类徽章 / 标题 / 摘要 / 状态元数据） */
export interface InjectionHeaderProps {
  /** 注入项实体（展示字段来自本实体） */
  injection: MessageContextInjection;
  /** 分类语义图标组件 */
  icon: React.ComponentType<{
    size?: number | string;
    strokeWidth?: number | string;
    className?: string;
    'aria-hidden'?: boolean | 'true' | 'false';
  }>;
  /** 是否为可展开态 */
  canToggle: boolean;
  isOpen: boolean;
  isFailed: boolean;
  isPending: boolean;
  /** 展开/折叠切换回调 */
  onToggle: () => void;
  /** 行级 aria-label（含分类/标题/状态/开合） */
  rowAriaLabel: string;
  onOpenPath?: ((filePath: string) => void) | undefined;
  onOpenDiff?: ((diff: FileDiff) => void) | undefined;
  onRetryInjection?: ((injectionId: string) => void) | undefined;
}

/** 展开详情面板 props（Markdown 正文 + Diff 快捷跳转） */
export interface InjectionBodyProps {
  injection: MessageContextInjection;
  onOpenPath?: ((filePath: string) => void) | undefined;
  onOpenDiff?: ((diff: FileDiff) => void) | undefined;
}

/** 内容 > 160 字符默认折叠（评审 03 §2.5 折叠策略） */
export const INJECTION_COLLAPSE_CHAR_THRESHOLD = 160;

/** 超大文件分段截断保护阈值（>1000 行 / >50KB），防止长会话 DOM 节点暴增 */
export const MAX_INJECTION_CONTENT_LINES = 1000;
export const MAX_INJECTION_CONTENT_BYTES = 50 * 1024;
