// 把相邻的工具块折叠成一行摘要（纯函数，jest 直测）。
// 消息 / 审批 / 提示块原样透传并打断折叠；单个工具同样折叠成摘要，便于对话保持干净。
//
// 身份纪律（结构共享）：一个工具组的全部派生字段（id / tools /
// running / failed / latest / atMs）只取决于其构成集——成员工具块的
// 引用序列。构成集逐元素不变时复用上次的组块对象（以组首工具块为
// 键缓存 + 逐元素校验构成集）；任一成员换新 / 增长 / 缩短即作废重建，
// 绝不发射构成与输入不符的组。已发射的组块永不回头变异（尾组增长时
// 另建新组），故缓存对象对消费方只读安全。
import type { TimelineBlock, ToolBlock } from './buildTimeline';

export type ToolRunStatus = 'running' | 'success' | 'error';

export interface ToolRunBlock {
  kind: 'toolRun';
  /** 首个工具块 id：作为 /tools/[sessionId]?focus= 的定位锚点 */
  id: string;
  tools: ToolBlock[];
  running: number;
  failed: number;
  /** 整体状态：running（流式进行中） | success（终态全成功） | error（终态含失败） */
  status: ToolRunStatus;
  /** 是否处于流式进行中态（running > 0） */
  active: boolean;
  /** 是否终态封口（running === 0） */
  isSealed: boolean;
  /** 当前活动工具（首个 running 工具，若无则为 latest） */
  activeTool?: ToolBlock;
  latest: ToolBlock;
  atMs: number;
  /** 组总时长（批 B：过程组收尾组头呈现）：封口且全部成员都有
   * endedAtMs 时 = 最晚结束时刻 − 组首开始时刻；成员缺结束时刻
   * （旧数据/本地来源）即整组缺省，不拿部分数据拼时长。 */
  durationMs?: number;
}

export type DisplayBlock = Exclude<TimelineBlock, ToolBlock> | ToolRunBlock;

/** 组首工具块 → 上次以其为锚发射的组块（构成集在取用时逐元素校验） */
const runCache = new WeakMap<ToolBlock, ToolRunBlock>();

function runFor(tools: readonly ToolBlock[]): ToolRunBlock {
  const anchor = tools[0]!;
  const cached = runCache.get(anchor);
  if (
    cached &&
    cached.tools.length === tools.length &&
    cached.tools.every((tool, index) => tool === tools[index])
  ) {
    return cached;
  }
  let running = 0;
  let failed = 0;
  let activeTool: ToolBlock | undefined;
  for (const tool of tools) {
    if (tool.status === 'running') {
      running += 1;
      if (!activeTool) activeTool = tool;
    }
    if (tool.status === 'error') failed += 1;
  }
  const latest = tools[tools.length - 1]!;
  const status: ToolRunStatus =
    running > 0 ? 'running' : failed > 0 ? 'error' : 'success';
  // 组总时长：仅封口（running === 0）且每个成员都有结束时刻时成立
  let durationMs: number | undefined;
  if (running === 0 && tools.length > 0) {
    let endMax = Number.NEGATIVE_INFINITY;
    let complete = true;
    for (const tool of tools) {
      if (tool.endedAtMs === undefined) {
        complete = false;
        break;
      }
      if (tool.endedAtMs > endMax) endMax = tool.endedAtMs;
    }
    if (complete) durationMs = Math.max(0, endMax - anchor.atMs);
  }
  const run: ToolRunBlock = {
    kind: 'toolRun',
    id: anchor.id,
    tools: [...tools],
    running,
    failed,
    status,
    active: running > 0,
    isSealed: running === 0,
    activeTool: activeTool ?? latest,
    latest,
    atMs: anchor.atMs,
  };
  if (durationMs !== undefined) run.durationMs = durationMs;
  runCache.set(anchor, run);
  return run;
}

/** 判断工具组是否处于流式活跃态（存在未决运行项） */
export function isToolRunActive(run: ToolRunBlock): boolean {
  return run.active || run.running > 0;
}

/** 判断工具组是否处于终态封口态（全部工具均已落地完成或失败） */
export function isToolRunSealed(run: ToolRunBlock): boolean {
  return run.isSealed && run.running === 0;
}

/** 上轮输出（元素逐个与本轮相同则复用同一数组引用，给 FlatList 稳定的 data） */
let lastGrouped: DisplayBlock[] | null = null;

export function groupToolRuns(
  blocks: readonly TimelineBlock[]
): DisplayBlock[] {
  const out: DisplayBlock[] = [];
  let pending: ToolBlock[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    out.push(runFor(pending));
    pending = [];
  };
  for (const block of blocks) {
    if (block.kind !== 'tool') {
      flush();
      out.push(block);
      continue;
    }
    pending.push(block);
  }
  flush();
  if (
    lastGrouped !== null &&
    lastGrouped.length === out.length &&
    lastGrouped.every((block, index) => block === out[index])
  ) {
    return lastGrouped;
  }
  lastGrouped = out;
  return out;
}
