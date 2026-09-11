/**
 * apps/crish-desktop/src/api/tool-presentation/processMetricsEngine.ts
 *
 * 过程段度量聚合与图五折叠态文案 / 主导动作仲裁（纯逻辑，无 React 依赖）。
 *
 * 【SSOT】权威定义位置：本文件（07-方案收敛审计与SSOT裁决.md §2.2）。
 * 负向红线：
 *   - 禁止在组件层重新聚合 metrics；
 *   - 禁止在组件层自行拼装折叠栏文案（必须调用 formatProcessControlLabel）；
 *   - 禁止在组件层自行 toFixed 拼接耗时（必须调用 formatDurationLabel）；
 *   - 禁止使用 emoji 作为主导图标（图标名统一来自 DOMINANT_ICON_MAP）；
 *   - 「已深度思考」文案已于 2026-09-11 用户裁决彻底废除，禁止任何形式回潮。
 */

import type { AssistantTimelineItem, TimelineToolsItem } from './toolPresentationTypes';
import type { ProcessLeadAction, ProcessSegmentMetrics } from './toolPresentationTypes';
import { classifyToolAction } from './toolActionClassifier';
import type { MessageToolCall } from '../../store/layoutStore';

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
 * 把毫秒数格式化为人类可读的「xx 时间」标签（纯函数，可穷举验证）。
 *   - < 60s       → "x.x 秒"
 *   - < 3600s     → "m 分 s 秒"
 *   - 否则         → "h 小时 m 分"
 *
 * 【SSOT】全仓唯一耗时文案格式化入口，禁止组件层自行 toFixed 拼接。
 */
export function formatDurationLabel(ms: number): string {
  const sec = ms / 1000;
  if (sec < 60) {
    return `${sec.toFixed(1)} 秒`;
  }
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  if (m < 60) {
    return `${m} 分 ${s} 秒`;
  }
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h} 小时 ${rm} 分`;
}

/**
 * 过程段折叠控制栏文案（SSOT，2026-09-11 用户裁决）。
 *
 * 【裁决要点】
 *   1. 「工作多少秒是在当前的『已深度思考』那里」——控制栏只承载**工作时间**；
 *   2. 「思考就是思考，没有已深度思考这一说」——`已深度思考` 文案被彻底废除；
 *   3. 运行中：跳秒（裸时长，无前缀）；终态：「工作 xx 时间」；
 *   4. 单思考 / 单工具调用段（`showWorkTime=false`）：不显示工作时间区域，
 *      退化为极简语义标签「思考」/「已运行 N 条命令」。
 *
 * @param metrics         段聚合度量
 * @param showWorkTime 是否显示工作时间区域（thoughtCount + toolCount >= 2）
 * @param elapsedMs       已计算好的耗时毫秒
 * @param isLive          是否运行中（true → 跳秒，无「工作」前缀）
 */
export function formatProcessControlLabel(
  metrics: ProcessSegmentMetrics,
  showWorkTime: boolean,
  elapsedMs: number,
  isLive: boolean
): string {
  if (showWorkTime) {
    const duration = formatDurationLabel(elapsedMs);
    return isLive ? duration : `工作 ${duration}`;
  }

  if (metrics.thoughtCount > 0) return '思考';
  if (metrics.toolCount > 0) return `已运行 ${metrics.toolCount} 条命令`;
  return '处理过程';
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
