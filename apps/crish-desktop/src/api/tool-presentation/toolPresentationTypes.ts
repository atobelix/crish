/**
 * 工具展示与时间线类型与契约。
 */

import type { MessageContextInjection, MessageToolCall } from '../../store/layoutStore';
import type { IconName } from '../../components/ui/icons';

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
 *   - aggregateProcessMetrics / formatSegmentSummary / arbitrateLeadAction
 *                                → ./processMetricsEngine.ts
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
  | 'subagent'
  | 'edit'
  | 'search'
  | 'read'
  | 'command'
  | 'thought'
  | 'mixed';

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

/** 时间线交错分段（判别联合） */
export type TimelineSegment = ProcessTimelineSegment | TextTimelineSegment;

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
