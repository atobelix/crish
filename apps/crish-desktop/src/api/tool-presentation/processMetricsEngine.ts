/**
 * apps/crish-desktop/src/api/tool-presentation/processMetricsEngine.ts
 *
 * 过程段度量聚合与图五折叠态文案 / 主导动作仲裁（纯逻辑，无 React 依赖）。
 *
 * 【SSOT】权威定义位置：本文件（07-方案收敛审计与SSOT裁决.md §2.2）。
 * 负向红线：
 *   - 禁止在组件层重新聚合 metrics；
 *   - 禁止在组件层自行拼装摘要文案（必须调用 formatSegmentSummary）；
 *   - 禁止使用 emoji 作为主导图标（图标名统一来自 DOMINANT_ICON_MAP）。
 */

import type { AssistantTimelineItem, TimelineToolsItem } from './toolPresentationTypes';
import type { ProcessLeadAction, ProcessSegmentMetrics } from './toolPresentationTypes';
import { classifyToolAction } from './toolActionClassifier';
import type { MessageToolCall } from '../../store/layoutStore';

/** 中圆点分隔符（图五契约：U+0020 U+00B7 U+0020） */
const MIDDLE_DOT = ' \u00b7 ';

/**
 * 跨平台文件路径归一化（用于 Set 去重）。
 *
 * 处理项：
 *   1. 反斜杠统一为正斜杠（Windows 与 POSIX 收敛同一形态）；
 *   2. Windows 盘符大小写归一（`C:/` 与 `c:/` 视为同一路径）；
 *   3. 折叠连续斜杠；
 *   4. 去除首尾空白。
 *
 * 注意：不做 `..` / `.` 的语义解析——那属于文件系统职责，此处只为**去重**。
 */
export function canonicalizeFsPath(raw?: string | null): string {
  if (!raw) return '';
  let p = raw.trim().replace(/\\/g, '/');
  if (!p) return '';
  // 折叠连续斜杠（保留开头的 UNC 双斜杠）
  p = p.replace(/([^/])\/{2,}/g, '$1/');
  // Windows 盘符大小写归一：c:/ → C:/
  p = p.replace(/^([a-zA-Z]):\//, (_, d: string) => `${d.toUpperCase()}:/`);
  return p;
}

/**
 * 展开 `TimelineToolsItem` 为扁平的 `MessageToolCall[]`。
 */
function flattenToolCalls(item: TimelineToolsItem): MessageToolCall[] {
  if (!Array.isArray(item.items)) return [];
  const out: MessageToolCall[] = [];
  for (const t of item.items) {
    if (!t) continue;
    if (t.kind === 'single') {
      if (t.tc) out.push(t.tc);
    } else if (t.kind === 'group' && Array.isArray(t.tools)) {
      for (const g of t.tools) {
        if (g) out.push(g);
      }
    }
  }
  return out;
}

/**
 * 从时间线项聚合 14 项过程度量（单段唯一聚合入口）。
 */
export function aggregateProcessMetrics(items: readonly AssistantTimelineItem[]): ProcessSegmentMetrics {
  let thoughtCount = 0;
  let thoughtDurationMs = 0;
  let toolCount = 0;
  let subagentCount = 0;
  let searchCount = 0;
  let commandCount = 0;
  let injectionCount = 0;
  let totalDurationMs = 0;
  let noPathReadCount = 0;
  let hasRunning = false;
  let hasError = false;
  let isStreaming = false;

  const readPathSet = new Set<string>();
  const editPathSet = new Set<string>();

  for (const item of items) {
    if (!item) continue;

    if (typeof item.durationMs === 'number' && item.durationMs > 0) {
      totalDurationMs += item.durationMs;
    }

    if (item.kind === 'thought') {
      thoughtCount += 1;
      if (typeof item.durationMs === 'number' && item.durationMs > 0) {
        thoughtDurationMs += item.durationMs;
      }
      if (item.isStreaming) isStreaming = true;
      continue;
    }

    if (item.kind === 'injection') {
      injectionCount += 1;
      continue;
    }

    if (item.kind === 'text') {
      continue;
    }

    if (item.kind === 'tools') {
      const calls = flattenToolCalls(item);
      for (const tc of calls) {
        toolCount += 1;

        if (tc.status === 'running') hasRunning = true;
        if (tc.status === 'error') hasError = true;

        const action = classifyToolAction(tc.name);
        const target = extractToolTargetPath(tc);

        switch (action) {
          case 'subagent':
            subagentCount += 1;
            break;
          case 'search':
            searchCount += 1;
            if (target) readPathSet.add(canonicalizeFsPath(target));
            break;
          case 'read':
            if (target) {
              readPathSet.add(canonicalizeFsPath(target));
            } else {
              // 无路径的读取（如网络抓取）：以 tool id 计入次数但不作路径去重
              noPathReadCount += 1;
            }
            break;
          case 'edit':
            if (target) editPathSet.add(canonicalizeFsPath(target));
            break;
          case 'command':
            commandCount += 1;
            break;
        }
      }
    }
  }

  const readPaths = [...readPathSet];
  const readFilesCount = readPaths.length + noPathReadCount;
  const editPaths = [...editPathSet];

  const metrics: ProcessSegmentMetrics = {
    thoughtCount,
    thoughtDurationMs,
    toolCount,
    subagentCount,
    searchCount,
    commandCount,
    readFilesCount,
    editFilesCount: editPaths.length,
    readPaths,
    editPaths,
    injectionCount,
    totalDurationMs,
    hasRunning,
    hasError,
    isStreaming,
    leadAction: 'mixed',
  };

  metrics.leadAction = arbitrateLeadAction(metrics);
  return metrics;
}

/** 从未知形状的 tool call 参数中提取目标路径（best-effort，纯函数）。 */
function extractToolTargetPath(tc: MessageToolCall): string {
  if (tc.diffs && tc.diffs.length > 0) {
    const first = tc.diffs[0];
    if (first && first.filePath) return first.filePath;
  }
  const rawArgs = tc.arguments ?? (tc as { args?: unknown }).args;
  let parsedArgs: unknown = rawArgs;
  if (typeof rawArgs === 'string' && rawArgs) {
    try {
      parsedArgs = JSON.parse(rawArgs);
    } catch {
      return rawArgs.trim();
    }
  }
  if (parsedArgs && typeof parsedArgs === 'object') {
    const rec = parsedArgs as Record<string, unknown>;
    for (const key of ['path', 'filePath', 'file_path', 'target', 'TargetFile', 'target_file', 'AbsolutePath', 'SearchPath', 'path_within_root', 'uri', 'url']) {
      const v = rec[key];
      if (typeof v === 'string' && v) return v;
    }
  }
  return '';
}

/**
 * 主导动作仲裁（优先级：subagent > edit > search > read > command > thought > mixed）。
 *
 * 该顺序即 `02-折叠态聚合文案与度量算法详案.md` §6 的唯一权威口径。
 */
export function arbitrateLeadAction(metrics: ProcessSegmentMetrics): ProcessLeadAction {
  if (metrics.subagentCount > 0) return 'subagent';
  if (metrics.editFilesCount > 0) return 'edit';
  if (metrics.searchCount > 0) return 'search';
  if (metrics.readFilesCount > 0) return 'read';
  if (metrics.commandCount > 0) return 'command';
  if (metrics.thoughtCount > 0) return 'thought';
  return 'mixed';
}

/**
 * 图五风格折叠态摘要文案（中圆点拼接，按语序裁剪空项）。
 *
 * 语序：已编辑 E 个文件 · 已搜索 S 次 · 已读取 R 个文件 · 已运行 C 条命令 · 已调度 A 个子任务
 * 无工具时回退思考文案：已深度思考 (3.2s) / 已深度思考
 * 全空时回退：中间处理过程
 */
export function formatSegmentSummary(metrics: ProcessSegmentMetrics): string {
  const parts: string[] = [];

  if (metrics.editFilesCount > 0) parts.push(`已编辑 ${metrics.editFilesCount} 个文件`);
  if (metrics.searchCount > 0) parts.push(`已搜索 ${metrics.searchCount} 次`);
  if (metrics.readFilesCount > 0) parts.push(`已读取 ${metrics.readFilesCount} 个文件`);
  if (metrics.commandCount > 0) parts.push(`已运行 ${metrics.commandCount} 条命令`);
  if (metrics.subagentCount > 0) parts.push(`已调度 ${metrics.subagentCount} 个子任务`);

  if (parts.length === 0) {
    if (metrics.thoughtCount > 0) {
      if (metrics.thoughtDurationMs > 0) {
        parts.push(`已深度思考 (${(metrics.thoughtDurationMs / 1000).toFixed(1)}s)`);
      } else {
        parts.push('已深度思考');
      }
    } else if (metrics.toolCount > 0) {
      parts.push(`已完成 ${metrics.toolCount} 项操作`);
    }
  }

  return parts.join(MIDDLE_DOT) || '中间处理过程';
}

/**
 * 段是否存在任何过程产出（用于 `hasProcessSections` / 空段过滤）。
 */
export function hasProcessContent(metrics: ProcessSegmentMetrics): boolean {
  return (
    metrics.toolCount > 0 ||
    metrics.thoughtCount > 0 ||
    metrics.injectionCount > 0
  );
}
