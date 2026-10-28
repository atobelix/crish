/**
 * 工具展示与时间线类型与契约。
 */

import type {
  MessageContextInjection,
  MessageToolCall,
} from '../../store/layoutStore';
import type { IconName } from '@/components/ui/icons';
import type { ToolCommandKind } from './toolCommandType';

export type ToolRenderItem =
  | { kind: 'single'; tc: MessageToolCall }
  | { kind: 'group'; id: string; tools: MessageToolCall[]; label: string };

export type ToolRowTone = 'running' | 'success' | 'error' | 'pending' | 'idle';

export type TimelineThoughtItem = {
  kind: 'thought';
  key: string;
  content: string;
  id?: string;
  turnIndex?: number;
  startTime?: number;
  durationMs?: number;
  isLive?: boolean;
  isStreaming?: boolean;
  isHistoricalCollapsed?: boolean;
};

export type TimelineTextItem = {
  kind: 'text';
  content: string;
  key: string;
  turnIndex?: number;
  startTime?: number;
  durationMs?: number;
  isFinal?: boolean;
};

export type TimelineToolsItem = {
  kind: 'tools';
  items: ToolRenderItem[];
  key: string;
  turnIndex?: number;
  startTime?: number;
  durationMs?: number;
};

/** 可见上下文注入卡片时间线项（Prompt 注入管线 · 维度二） */
export type TimelineInjectionItem = {
  kind: 'injection';
  key: string;
  injection: MessageContextInjection;
  turnIndex?: number;
  startTime?: number;
  durationMs?: number;
};

export type AssistantTimelineItem =
  | TimelineThoughtItem
  | TimelineTextItem
  | TimelineToolsItem
  | TimelineInjectionItem;

/* ═══════════════════════════════════════════════════════════════════════════
 * 正文交错过程折叠战役（assistant-process-folding）· SSOT 契约
 *
 * 权威定义位置：本文件（07-方案收敛审计与SSOT裁决.md §2.1）
 * 纯逻辑实现：
 *   - partitionTimelineSegments → ./timelineSegmenter.ts
 *   - aggregateProcessMetrics / formatDurationLabel / formatProcessControlLabel /
 *     arbitrateLeadAction         → ./processMetricsEngine.ts
 *   - classifyToolAction         → ./toolActionClassifier.ts
 *
 * 负向红线：禁止在其它文件重复定义 ProcessSegmentMetrics / TimelineSegment /
 * ProcessLeadAction / DOMINANT_ICON_MAP（历史旧别名结构已物理废除）。
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 过程段主导动作（折叠态左前导图标的语义轴）。
 *
 * 收敛说明：取代历史旧命名；枚举值 `'run'` 已改为 `'command'`，
 * `'generic'` 已改为 `'mixed'`。
 */
export type ProcessLeadAction =
  'subagent' | 'edit' | 'search' | 'read' | 'command' | 'thought' | 'mixed';

/**
 * 主导动作 → 语义图标名（AppIcon / @hugeicons/core-free-icons）。
 *
 * 图标名必须在 `components/ui/icons/iconMap.ts` 的 `ICON_NAMES` 内，否则
 * `check:icon-ssot` 门禁失败。
 */
export const DOMINANT_ICON_MAP: Record<ProcessLeadAction, IconName> = {
  subagent: 'bot',
  edit: 'file-edit',
  search: 'search',
  read: 'file-search',
  command: 'terminal',
  thought: 'brain-circuit',
  mixed: 'wrench',
};

/**
 * 过程段聚合度量指标（单一权威结构）。
 *
 * 不变量：`subagentCount ⊆ toolCount`（子代理调用本身也是工具调用），因此
 * `toolCount` 不等于各分类计数之和——禁止写成
 * `editFilesCount + searchCount + readFilesCount + commandCount`。
 */
export interface ProcessSegmentMetrics {
  /** 思考块数量 */
  thoughtCount: number;
  /** 思考累计耗时（毫秒）；收敛：原 `durationMs` */
  thoughtDurationMs: number;
  /** 工具调用总次数（含 subagent 调用） */
  toolCount: number;
  /** 子代理调用次数（⊆ toolCount） */
  subagentCount: number;
  /** 检索搜索次数 */
  searchCount: number;
  /** 终端命令执行条数 */
  commandCount: number;
  /** 文件读取次数（路径去重后）；收敛：原 `readCount` */
  readFilesCount: number;
  /** 文件编辑次数（路径去重后）；收敛：原 `editCount` */
  editFilesCount: number;
  /** 去重后的读取路径 */
  readPaths: string[];
  /** 去重后的编辑路径 */
  editPaths: string[];
  /** 上下文注入卡片数量 */
  injectionCount: number;
  /** 段内总耗时（毫秒）；收敛：原 `durationMs` */
  totalDurationMs: number;
  /** 段内是否存在运行中的工具 */
  hasRunning: boolean;
  /** 段内是否存在失败的工具 */
  hasError: boolean;
  /** 段内是否存在流式内容 */
  isStreaming: boolean;
  /** 主导动作（折叠态图标与摘要排序依据） */
  leadAction: ProcessLeadAction;
}

/** 过程段（可折叠的过程块） */
export interface ProcessTimelineSegment {
  kind: 'process_section';
  /** 唯一稳定键，格式 `${msgId}-proc-${index}` */
  id: string;
  items: AssistantTimelineItem[];
  metrics: ProcessSegmentMetrics;
  /**
   * 段起始时间戳（毫秒，取段内最早子项的 `startTime`）。
   * 用于顶部工作时间区：运行中跳秒，终态定格为「工作 xx 时间」。
   */
  startTime?: number;
  /**
   * 段结束时间戳（毫秒，仅在段处于终态时存在）。
   * 与 `startTime` 配合计算「工作 xx 时间」。
   */
  endTime?: number;
  /**
   * 顶部「工作工作时间区 + 虚线分割」是否显示。
   *
   * 唯一口径（用户裁决 · 2026-09-11）：段内思考与工具调用计数之和 ≥ 2 时显示；
   * **只有一个思考 或 只有一个工具调用时，工作时间区域与分割线一律不显示**。
   *
   * 该字段由 `partitionTimelineSegments` 唯一裁决，禁止调用方本地重推导。
   */
  showWorkTime: boolean;
  /** 是否具备折叠资格（由四铁律裁决，禁止调用方本地推导） */
  foldable: boolean;
  /** 默认展开态（仅作初始态参考；运行时展开态由宿主字典控制） */
  defaultExpanded: boolean;
  /** 【铁律四】含子代理的过程段强制展开：true 时收起行为须被禁用 */
  forceExpanded: boolean;
  /** 是否处于流式活跃执行态 */
  isLive: boolean;
}

/** 正文叙事段（天然物理界标，常驻平铺、绝不折叠） */
export interface TextTimelineSegment {
  kind: 'text_narrative';
  /** 唯一稳定键，格式 `${msgId}-text-${index}` */
  id: string;
  /** kind === 'text' 的时间线项 */
  item: TimelineTextItem;
  /** 是否为本轮终结论正文 */
  isFinalAnswer: boolean;
  /** 是否正在流式输出 */
  isStreaming: boolean;
}

/**
 * 系统状态通知段（上下文压缩 / 模型切换 / 思考强度切换 / 权限模式切换）。
 *
 * 【为何独立成段】状态通知是**系统对用户的告知**，语义上不属于「AI 过程产出」，
 * 绝不允许被过程段折叠吞掉。故注入项在分段器中作为**物理界标**处理：
 * 先冲掉前置过程缓冲，再以本段常驻平铺，渲染走 `ContextStateNotice`
 * （居中 + 发丝分割线，与模型切换同一视觉通道）。
 */
export interface StateNoticeTimelineSegment {
  kind: 'state_notice';
  /** 唯一稳定键，格式 `${msgId}-state-${index}` */
  id: string;
  /** kind === 'injection' 的时间线项 */
  item: TimelineInjectionItem;
}

/** 时间线交错分段（判别联合） */
export type TimelineSegment =
  ProcessTimelineSegment | TextTimelineSegment | StateNoticeTimelineSegment;

/**
 * Slot DOM ID 唯一生成规则（SSOT）。
 * `sectionId` 已含 `${msgId}-proc-${index}` 前缀，故此处不再重复 msgId。
 */
export function buildSlotId(sectionId: string): string {
  return `process-slot-${sectionId}`;
}

/**
 * 子代理工具名判定（SSOT）。
 *
 * 收敛说明：本函数原寄居于 `components/chat-message/turnProcessState.ts`，
 * 但 `api/tool-presentation/toolActionClassifier.ts` 亦需消费，形成
 * `api → components` 的反向依赖。故上移至本层，成为唯一判定源。
 *
 * 负向红线：禁止在其它文件重复实现子代理名判定。
 */
export function isSubagentToolName(name?: string): boolean {
  if (!name) return false;
  return (
    name.includes('subagent') ||
    name === 'invoke_subagent' ||
    name === 'run_subagent' ||
    name === 'wait_subagents'
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 * P5 对话流过程呈现 · ToolPresentation SSOT 与过程簇聚合契约（T-P5-01 / T-P5-04）
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 工具调用展示状态（仅 running 与 error 赋予语义色） */
export type ToolPresentationStatus =
  'running' | 'success' | 'error' | 'pending';

/** 目标对象语义类型 */
export type ToolTargetKind = 'path' | 'pattern' | 'command' | 'url' | 'text';

/** 工具行目标对象（与 label 互斥承载“对象”，杜绝双写回显） */
export interface ToolTarget {
  /** 目标文本：路径、搜索关键词、命令预览、URL 等 */
  text: string;
  kind: ToolTargetKind;
  /** 是否允许点击交互（例如打开文件面板或终端） */
  clickable: boolean;
  tooltip?: string | undefined;
}

/** 工具行右侧元数据类型 */
export type ToolMetaType = 'diff' | 'duration' | 'metric';

/** 工具行右侧紧凑元数据（最多保留 2 项：diff > metric > duration） */
export interface ToolMeta {
  type: ToolMetaType;
  /** 格式化后的紧凑展示文本，如 "+32 -0"、"15 行"、"340ms" */
  text: string;
  add?: number | undefined;
  del?: number | undefined;
  ariaLabel?: string | undefined;
}

/** 单条工具调用或过程簇的统一展示模型（SSOT） */
export interface ToolPresentation {
  /** 唯一首要人类语义标签：已去重、已消解动词冗余，如「读取文件」「Grep」「写入配置」 */
  label: string;
  /** 可选目标：与 label 互斥地承载“对象”。当 label 已含对象时为 undefined，杜绝双写 */
  target?: ToolTarget | undefined;
  /** 右侧元信息：最多 2 项（diff 统计优先、次要指标其次、耗时兜底） */
  meta: readonly ToolMeta[];
  /** 运行状态：仅 error 与 running 赋予语义色 */
  status: ToolPresentationStatus;
  /** 图标名称：严格映射自语义图标契约 */
  iconName: string;
  /** 工具命令语义分类轴 */
  kind: ToolCommandKind;
  /** 无障碍辅助朗读完整文本 */
  rowAriaLabel: string;
}

/** 单工具呈现注册项接口 */
export interface ToolPresentationRegistration {
  kind: ToolCommandKind;
  iconName: string;
  defaultAction: string;
  resolveAction?: (
    args: Record<string, unknown>,
    tc: MessageToolCall
  ) => string;
  extractTarget: (
    args: Record<string, unknown>,
    tc: MessageToolCall
  ) => ToolTarget | undefined;
  extractMeta?: (
    tc: MessageToolCall,
    args: Record<string, unknown>
  ) => readonly ToolMeta[];
}

/** 构建 ToolPresentation 的可选覆盖参数 */
export interface ToolPresentationOptions {
  /** 外部已提取的文件路径 */
  filePath?: string | undefined;
  /** 外部已提取的路径短标签 */
  pathLabel?: string | undefined;
  /** 外部已格式化的耗时文本 */
  durationStr?: string | null | undefined;
  /** 外部已计算的 diff 增删统计 */
  diffStats?: { add: number; del: number } | null | undefined;
}

/** 相邻同类工具调用聚合后的过程簇项（T-P5-04） */
export interface ProcessClusterItem {
  id: string;
  kind: 'process_cluster';
  clusterKind: ToolCommandKind;
  /** 簇内原始工具调用列表（供展开查看明细） */
  tools: readonly MessageToolCall[];
  /** 与 tools 同引用的原始项列表（供展开查看明细） */
  items: readonly MessageToolCall[];
  /** 簇摘要标签：如「读取 5 个文件 · 耗时 1.2s」或单项工具标签 */
  summaryLabel: string;
  /** summaryLabel 的同义属性 */
  label: string;
  /** 簇行统一展示模型（N===1 时直出原工具 ToolPresentation，N>=2 时为聚合摘要模型） */
  presentation: ToolPresentation;
  /** 簇内累计耗时（毫秒） */
  totalDurationMs: number;
  /** 是否存在运行中的工具 */
  hasRunning: boolean;
  /** 是否存在失败的工具 */
  hasError: boolean;
  /** 默认展开状态：相邻同类 >= 2 默认 false 收起为单行摘要 */
  defaultExpanded: boolean;
  /** 是否为单工具退化态（tools.length === 1） */
  isSingle: boolean;
}

export type ProcessCluster = ProcessClusterItem;

export type TimelineClusteredItem =
  Exclude<AssistantTimelineItem, { kind: 'tools' }> | ProcessClusterItem;
