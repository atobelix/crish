/**
 * 过程簇相邻同类聚合纯函数（P5 T-P5-04 · clusterProcessItems）。
 *
 * 核心规则（对齐用户 R2 裁决与 P5 §4.3）：
 *   1. 相邻同类判定：当且仅当 `toolCommandType(a) === toolCommandType(b)` 时归入同一簇；
 *   2. 异类严格隔离：`Read -> Grep -> Read` 生成 3 个独立簇，绝不跨类合并破坏因果时序；
 *   3. 阈值与默认收拢：当簇内数量 `N >= 2` 时，默认 `defaultExpanded: false` 收起为单行摘要
 *      （如「读取 5 个文件 · 耗时 1.2s」），同时完整保留原始 `tools` / `items` 供展开查看；
 *   4. 单工具退化保底：当 `N === 1` 时，`isSingle: true`，直接呈现该工具自身的 `ToolPresentation`，
 *      绝不展示无意义的「读取 1 个文件」「列出 1 个目录」。
 */

import type { MessageToolCall } from '../../store/types';
import { t } from '../../i18n';
import { toolCommandType, type ToolCommandKind } from './toolCommandType';
import { resolveToolPresentation } from './toolPresentationModel';
import type {
  AssistantTimelineItem,
  ProcessClusterItem,
  TimelineClusteredItem,
  TimelineToolsItem,
  ToolMeta,
  ToolPresentation,
  ToolPresentationStatus,
  ToolRenderItem,
} from './toolPresentationTypes';

export type {
  ProcessCluster,
  ProcessClusterItem,
  TimelineClusteredItem,
} from './toolPresentationTypes';

/**
 * 判定两个相邻工具调用是否属于同一聚合簇类别。
 */
export function isSameClusterKind(
  a: MessageToolCall,
  b: MessageToolCall
): boolean {
  return toolCommandType(a) === toolCommandType(b);
}

/**
 * 根据簇类别与调用数量生成聚合动作短语（N >= 2 时调用）。
 */
export function formatClusterActionLabel(
  kind: ToolCommandKind,
  count: number
): string {
  switch (kind) {
    case 'read':
      return t('cluster.action.read', '读取 {count} 个文件', { count });
    case 'search':
      return t('cluster.action.search', '检索 {count} 次', { count });
    case 'edit':
    case 'write':
      return t('cluster.action.modify', '修改 {count} 个文件', { count });
    case 'shell':
      return t('cluster.action.shell', '运行 {count} 条命令', { count });
    case 'list':
      return t('cluster.action.list', '列出 {count} 个目录', { count });
    case 'network':
      return t('cluster.action.network', '访问 {count} 个网络资源', { count });
    case 'mcp':
      return t('cluster.action.mcp', '调用 {count} 次扩展工具', { count });
    case 'task':
      return t('cluster.action.task', '管理 {count} 个后台任务', { count });
    case 'workspace':
      return t('cluster.action.workspace', '执行 {count} 项工作区操作', {
        count,
      });
    case 'delete':
      return t('cluster.action.delete', '删除 {count} 个路径', { count });
    case 'subagent':
      return t('cluster.action.subagent', '调用 {count} 个子代理', { count });
    case 'timer':
      return t('cluster.action.schedule', '设置 {count} 个定时器', { count });
    case 'note':
      return t('cluster.action.note', '操作 {count} 个笔记区块', { count });
    case 'misc':
    default:
      return t('cluster.action.tool', '调用 {count} 个工具', { count });
  }
}

/** 格式化簇累计耗时文本 */
export function formatClusterDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 计算单次工具调用的耗时（毫秒） */
function getToolDurationMs(tc: MessageToolCall): number {
  if (typeof tc.durationMs === 'number' && tc.durationMs > 0) {
    return tc.durationMs;
  }
  if (tc.startedAt) {
    const end = tc.completedAt ?? tc.finishedAt;
    if (end && end > tc.startedAt) {
      return end - tc.startedAt;
    }
  }
  return 0;
}

/** 将同一类的连续工具数组构造为单个 ProcessClusterItem */
function buildClusterFromRun(
  run: readonly MessageToolCall[],
  clusterIdx: number
): ProcessClusterItem {
  const first = run[0]!;
  const clusterKind = toolCommandType(first);
  let totalDurationMs = 0;
  let hasRunning = false;
  let hasError = false;

  for (const tc of run) {
    totalDurationMs += getToolDurationMs(tc);
    if (tc.status === 'running') hasRunning = true;
    if (tc.status === 'error') hasError = true;
  }

  const id = `cluster-${first.id || clusterIdx}-${run.length}`;

  // 退化态保底：N === 1 时直接展示单工具原生的 ToolPresentation
  if (run.length === 1) {
    const pres = resolveToolPresentation(first);
    const singleSummary = pres.target
      ? `${pres.label} ${pres.target.text}`
      : pres.label;
    return {
      id,
      kind: 'process_cluster',
      clusterKind,
      tools: run,
      items: run,
      summaryLabel: singleSummary,
      label: pres.label,
      presentation: pres,
      totalDurationMs,
      hasRunning,
      hasError,
      defaultExpanded: false,
      isSingle: true,
    };
  }

  // 聚合态：N >= 2 时生成单行聚合摘要，默认收起内部细粒度行（defaultExpanded: false）
  const firstPres = resolveToolPresentation(first);
  const actionLabel = formatClusterActionLabel(clusterKind, run.length);
  const durStr = formatClusterDuration(totalDurationMs);
  const durText = durStr
    ? t('cluster.action.duration', '耗时 {duration}', { duration: durStr })
    : '';
  const summaryLabel = durText
    ? t('cluster.action.withDuration', '{action} · 耗时 {duration}', {
        action: actionLabel,
        duration: durStr,
      })
    : actionLabel;
  const meta: ToolMeta[] = durText
    ? [{ type: 'duration', text: durText, ariaLabel: durText }]
    : [];
  const status: ToolPresentationStatus = hasRunning
    ? 'running'
    : hasError
      ? 'error'
      : 'success';

  const presentation: ToolPresentation = {
    label: actionLabel,
    meta,
    status,
    iconName: firstPres.iconName,
    kind: clusterKind,
    rowAriaLabel: summaryLabel,
  };

  return {
    id,
    kind: 'process_cluster',
    clusterKind,
    tools: run,
    items: run,
    summaryLabel,
    label: summaryLabel,
    presentation,
    totalDurationMs,
    hasRunning,
    hasError,
    defaultExpanded: false,
    isSingle: false,
  };
}

function isTimelineNonToolItem(
  item: unknown
): item is Exclude<AssistantTimelineItem, { kind: 'tools' }> {
  if (!item || typeof item !== 'object') return false;
  const k = (item as { kind?: unknown }).kind;
  return k === 'thought' || k === 'text' || k === 'injection';
}

function isTimelineToolsItem(item: unknown): item is TimelineToolsItem {
  return Boolean(
    item &&
    typeof item === 'object' &&
    (item as { kind?: unknown }).kind === 'tools' &&
    Array.isArray((item as TimelineToolsItem).items)
  );
}

function isToolRenderItem(item: unknown): item is ToolRenderItem {
  if (!item || typeof item !== 'object') return false;
  const k = (item as { kind?: unknown }).kind;
  return k === 'single' || k === 'group';
}

function extractCallsFromRenderItem(ri: ToolRenderItem): MessageToolCall[] {
  if (ri.kind === 'single') {
    return ri.tc ? [ri.tc] : [];
  }
  if (ri.kind === 'group' && Array.isArray(ri.tools)) {
    return ri.tools.filter(Boolean);
  }
  return [];
}

/**
 * 将线性时间线项或工具调用序列按「相邻同类」规则聚合成过程簇序列。
 */
export function clusterProcessItems(
  items: readonly MessageToolCall[]
): ProcessClusterItem[];
export function clusterProcessItems(
  items: readonly ToolRenderItem[]
): ProcessClusterItem[];
export function clusterProcessItems(
  items: readonly AssistantTimelineItem[]
): TimelineClusteredItem[];
export function clusterProcessItems(
  items: readonly (AssistantTimelineItem | ToolRenderItem | MessageToolCall)[]
): TimelineClusteredItem[] {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const out: TimelineClusteredItem[] = [];
  let toolBuf: MessageToolCall[] = [];
  let clusterIdx = 0;

  const flushToolBuf = (): void => {
    if (toolBuf.length === 0) return;
    let currentRun: MessageToolCall[] = [];
    for (const tc of toolBuf) {
      if (!tc) continue;
      if (
        currentRun.length === 0 ||
        isSameClusterKind(currentRun[currentRun.length - 1]!, tc)
      ) {
        currentRun.push(tc);
      } else {
        out.push(buildClusterFromRun(currentRun, clusterIdx++));
        currentRun = [tc];
      }
    }
    if (currentRun.length > 0) {
      out.push(buildClusterFromRun(currentRun, clusterIdx++));
    }
    toolBuf = [];
  };

  for (const item of items) {
    if (!item) continue;

    if (isTimelineNonToolItem(item)) {
      flushToolBuf();
      out.push(item);
      continue;
    }

    if (isTimelineToolsItem(item)) {
      for (const ri of item.items) {
        if (!ri) continue;
        toolBuf.push(...extractCallsFromRenderItem(ri));
      }
      continue;
    }

    if (isToolRenderItem(item)) {
      toolBuf.push(...extractCallsFromRenderItem(item));
      continue;
    }

    // 直接传入的 MessageToolCall
    toolBuf.push(item as MessageToolCall);
  }

  flushToolBuf();
  return out;
}

/**
 * 逆向展平函数：从聚合后的序列中无损还原原始工具调用列表（用于正逆向对称验证与展开态渲染）。
 */
export function flattenClusteredTools(
  clustered: readonly TimelineClusteredItem[]
): MessageToolCall[] {
  const result: MessageToolCall[] = [];
  for (const item of clustered) {
    if (item && item.kind === 'process_cluster') {
      result.push(...item.tools);
    }
  }
  return result;
}
