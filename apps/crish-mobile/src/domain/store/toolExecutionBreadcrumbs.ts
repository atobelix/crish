// 工具执行持久化面包屑（波 1 要点 3）：每次工具执行在开始与终局各
// 落一条面包屑（工具名 + 工具调用 id + 阶段 + 时间戳），内存环为
// 同步真源、kv 落盘为尽力镜像——进程若在某次工具执行中原生闪退，
// 重启后读回落盘面即可看到「哪次调用开始后没有终局」，为波 7 的
// 原生级闪退对齐留证据通道。
// 纪律（与 sendQueueStore 同口径）：
// - 记录永不抛、永不阻断工具执行（内部全吞异常）；
// - 未注入持久面 / DB 降级时退化为进程内内存环（诚实降级，跨启动
//   不保留）；
// - 落盘形状由 parse 对称校验，坏值一律收敛为空，绝不抛。
export type ToolExecutionStage =
  | 'start'
  | 'success'
  | 'error'
  | 'timeout'
  | 'aborted';

export interface ToolExecutionBreadcrumb {
  toolName: string;
  toolCallId: string;
  stage: ToolExecutionStage;
  atMs: number;
}

/** 持久接口（SqlSettingsDao 的 get/set/delete 与之同形） */
export interface ToolExecutionBreadcrumbPersist {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete?(key: string): Promise<void>;
}

/** kv 键（settings 表内单值存整环，与 chat.send_queue.* 同层面） */
export const TOOL_EXECUTION_BREADCRUMB_KEY = 'tools.execution_breadcrumbs';

/** 内存环与落盘面的条数上限（超出丢最旧，证据价值在最近执行） */
export const TOOL_EXECUTION_BREADCRUMB_MAX = 100;

const STAGES: readonly ToolExecutionStage[] = [
  'start',
  'success',
  'error',
  'timeout',
  'aborted',
];

let entries: ToolExecutionBreadcrumb[] = [];
let defaultPersist: ToolExecutionBreadcrumbPersist | null = null;

/** 接线层注入默认持久化（persistBootstrap 装配；传 null 复位为内存形态） */
export function configureToolExecutionBreadcrumbPersistence(
  persist: ToolExecutionBreadcrumbPersist | null
): void {
  defaultPersist = persist;
}

export function serializeToolExecutionBreadcrumbs(
  list: readonly ToolExecutionBreadcrumb[]
): string {
  return JSON.stringify(list);
}

/** 解析落盘值：形状不对 → 空数组，绝不抛 */
export function parseToolExecutionBreadcrumbs(
  raw: string | null
): ToolExecutionBreadcrumb[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: ToolExecutionBreadcrumb[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) continue;
      const { toolName, toolCallId, stage, atMs } = entry as Record<
        string,
        unknown
      >;
      if (typeof toolName !== 'string' || toolName === '') continue;
      if (typeof toolCallId !== 'string' || toolCallId === '') continue;
      if (
        typeof stage !== 'string' ||
        !STAGES.includes(stage as ToolExecutionStage)
      ) {
        continue;
      }
      if (typeof atMs !== 'number' || !Number.isFinite(atMs)) continue;
      out.push({
        toolName,
        toolCallId,
        stage: stage as ToolExecutionStage,
        atMs,
      });
    }
    return out.slice(-TOOL_EXECUTION_BREADCRUMB_MAX);
  } catch {
    return [];
  }
}

/** 变更后尽力落盘（内存恒为同步真源；落盘失败不阻断执行） */
function persistBreadcrumbs(): void {
  const persist = defaultPersist;
  if (!persist) return;
  void persist
    .set(
      TOOL_EXECUTION_BREADCRUMB_KEY,
      serializeToolExecutionBreadcrumbs(entries)
    )
    .catch(() => {
      // 本次落盘丢失可接受：内存环仍在，本进程内证据不丢
    });
}

/**
 * 记录一条面包屑（toolRegistry.executeToolCall 在执行开始与终局调用）。
 * 永不抛：面包屑是旁路证据通道，自身故障绝不许影响工具执行。
 */
export function recordToolExecutionBreadcrumb(
  crumb: ToolExecutionBreadcrumb
): void {
  try {
    entries = [...entries, crumb].slice(-TOOL_EXECUTION_BREADCRUMB_MAX);
    persistBreadcrumbs();
  } catch {
    // 旁路通道静默降级
  }
}

/** 当前内存环快照（最近执行在尾部） */
export function getToolExecutionBreadcrumbs(): readonly ToolExecutionBreadcrumb[] {
  return entries;
}

/**
 * 读回落盘面（波 7 闪退对齐的证据入口）：返回上次进程落盘的面包屑，
 * 供重启后核对「有 start 无终局」的悬空调用。无持久面 / 读失败 → []。
 */
export async function loadPersistedToolExecutionBreadcrumbs(): Promise<
  ToolExecutionBreadcrumb[]
> {
  const persist = defaultPersist;
  if (!persist) return [];
  try {
    return parseToolExecutionBreadcrumbs(
      await persist.get(TOOL_EXECUTION_BREADCRUMB_KEY)
    );
  } catch {
    return [];
  }
}

/** 测试隔离：清空内存环与持久注入（仅测试调用） */
export function resetToolExecutionBreadcrumbsForTest(): void {
  entries = [];
  defaultPersist = null;
}
