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

import type {
  AssistantTimelineItem,
  TimelineToolsItem,
} from './toolPresentationTypes';
import type {
  ProcessLeadAction,
  ProcessSegmentMetrics,
} from './toolPresentationTypes';
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
export function aggregateProcessMetrics(
  items: readonly AssistantTimelineItem[]
): ProcessSegmentMetrics {
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
  let errorCount = 0;
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
        if (tc.status === 'error') {
          hasError = true;
          errorCount += 1;
        }

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
    errorCount,
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
    for (const key of [
      'path',
      'filePath',
      'file_path',
      'target',
      'TargetFile',
      'target_file',
      'AbsolutePath',
      'SearchPath',
      'path_within_root',
      'uri',
      'url',
    ]) {
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
export function arbitrateLeadAction(
  metrics: ProcessSegmentMetrics
): ProcessLeadAction {
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
 * 过程段工具动作分类与数量描述（2026-09-11 用户裁决）。
 *
 * 针对非工作时间过程段（紧跟正文后的工具段），精准展示调用了多少工具、分别是什么类型。
 * 格式示例：
 *   - 纯命令：`已运行 5 条命令`
 *   - 混合：`已搜索 2 次 · 已运行 10 条命令`
 *   - 纯读取：`已读取 3 个文件`
 *   - 纯思考：`思考`
 */
export function formatProcessActionsSummary(
  metrics: ProcessSegmentMetrics
): string {
  if (metrics.toolCount === 0 && metrics.thoughtCount > 0) {
    if (metrics.thoughtDurationMs > 0) {
      return `已思考 ${formatDurationLabel(metrics.thoughtDurationMs)}`;
    }
    return '思考';
  }

  const parts: string[] = [];
  // 子代理分派不计入段摘要（R4b）：分派已从工具分组提取为独立消息卡，
  // 摘要只描述段内工具动作；subagentCount 仍由 aggregateProcessMetrics
  // 如实聚合（仲裁/计数消费方不变），仅不再拼进文案。
  if (metrics.searchCount > 0) {
    parts.push(`已搜索 ${metrics.searchCount} 次`);
  }
  if (metrics.readFilesCount > 0) {
    parts.push(`已读取 ${metrics.readFilesCount} 个文件`);
  }
  if (metrics.editFilesCount > 0) {
    parts.push(`已编辑 ${metrics.editFilesCount} 个文件`);
  }
  if (metrics.commandCount > 0) {
    parts.push(`已运行 ${metrics.commandCount} 条命令`);
  }

  if (parts.length > 0) {
    return parts.join(' · ');
  }

  // 兜底计数同样剔除子代理调用：toolCount 含 subagent（子集不变量），
  // 纯分派段不得误报为「已运行 N 条命令」。
  const nonSubagentToolCount = metrics.toolCount - metrics.subagentCount;
  if (nonSubagentToolCount > 0) {
    return `已运行 ${nonSubagentToolCount} 条命令`;
  }

  if (metrics.thoughtCount > 0) {
    return '思考';
  }

  return '处理过程';
}

/**
 * 过程段折叠控制栏文案（SSOT，2026-09-11 用户裁决）。
 *
 * 【裁决要点】
 *   1. 顶部控制栏（紧跟用户消息下方）是整轮唯一承载**工作时间**的位置；
 *   2. 运行中：跳秒（「正在处理 xx 时间」）；终态：「已完成 xx 时间」；
 *   3. 后续工具段（`showWorkTime=false`）：展示调用了多少工具、分别是什么类型的描述（formatProcessActionsSummary）；
 *   4. 「已深度思考」与「工作 xx 秒」文案被彻底废除。
 *
 * 【R8 两级组头分工】（〔同组 §3.2/§3.3〕定稿）：
 *   - 轮次组头（本函数）= 工作时间（或动作分布）+ **失败数 + 子 agent 数**
 *     （整组总量口径，折叠后常驻可见——含失败组自动折的可见性即靠此）；
 *   - 工具组头（FoldableToolGroup）= 本组动作分布，只调
 *     formatProcessActionsSummary，其失败信号走 ⚠+数字角标、不进文案。
 *   动作分布永远只由 formatProcessActionsSummary 一处产出，本函数只做
 *   拼装、禁止另算一份（防两级计数同义重复）。
 *
 * @param metrics         段聚合度量
 * @param showWorkTime 是否显示工作时间区域（整轮首个过程段为 true）
 * @param elapsedMs       已计算好的耗时毫秒
 * 【F1 · R-C】工作时间分支的时长须有计时证据：证据 = elapsedMs（起止
 * 跨度）或 metrics.totalDurationMs（条目 durationMs 聚合，含分段器
 * 折入的 thinkingTime）；两者皆零即无证据——只拼状态词、省略时长，
 * 禁止渲染假「0.0 秒」。有证据时拼接口径与既往逐字一致。
 * @param isLive          是否运行中（true → 正在处理，false → 已完成）
 */
export function formatProcessControlLabel(
  metrics: ProcessSegmentMetrics,
  showWorkTime: boolean,
  elapsedMs: number,
  isLive: boolean
): string {
  // 轮次级常驻统计：失败数 + 子 agent 数（拼装规则见上方分工注记）
  const tailStats: string[] = [];
  if (metrics.errorCount > 0) {
    tailStats.push(`失败 ${metrics.errorCount}`);
  }
  if (metrics.subagentCount > 0) {
    tailStats.push(`子 agent ${metrics.subagentCount}`);
  }

  if (showWorkTime) {
    // 计时证据判定（R-C）：跨度与聚合任一为正即有证据；皆零则省略时长
    const evidenceMs = elapsedMs > 0 ? elapsedMs : metrics.totalDurationMs;
    if (evidenceMs <= 0) {
      const head = isLive ? '正在处理' : '已完成';
      return [head, ...tailStats].join(' · ');
    }
    const duration = formatDurationLabel(evidenceMs);
    const head = isLive ? `正在处理 ${duration}` : `已完成 ${duration}`;
    return [head, ...tailStats].join(' · ');
  }

  return [formatProcessActionsSummary(metrics), ...tailStats].join(' · ');
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
