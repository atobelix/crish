// eventStore 纯逻辑 reducers（M5 §3.1：集合更新纯函数，store 动作只转发，jest 直测）
// 覆盖：feed 环形缓冲（F3 §3.4.2 / R2UX-05-09 / M6 §7.3：上限 500 条，超出丢最旧）、
//       去重（M6 §8.3 游标规则 2/4：(sessionId, sequence) 幂等键 + 游标只升不降）、
//       游标跟踪（lastSeq 供 resume）、过滤（R2UX-05-06 过滤条数据面）、稳定排序（seq 升序）

// ── 契约类型 ─────────────────────────────────────────────────────────────
// 契约：events.push.body.event 的 AgentEventEnvelope 扁平 JSON（events.rs:1092-1179 / M6 §10.5）
// 只声明信封字段（type/runId/sequence/schemaVersion/sessionId）；事件体字段平铺在
// 信封顶层（additionalProperties: true，M6 §10.5），逐事件访问走宽容读取（read* 助手），
// 不在此复制契约字段（M5 §1.3 组合纪律）。
export interface EventEnvelopeFrame {
  /** 事件 wire type（AgentEvent 变体名；未知 type 宽容跳过，MessageKind::Unknown 语义） */
  type: string;
  /** 事件归属 run id（emit 层注入；数据面事件缺失，events.rs:1116） */
  runId?: string;
  /** 会话内连续序列（resume 游标唯一依据，M6 §8.3；预览帧未落库时仍带值） */
  sequence?: number;
  /** 信封 wire schema 版本（缺省视为 1，events.rs:1100-1103） */
  schemaVersion?: number;
  sessionId: string;
  // 事件体字段平铺在信封顶层（additionalProperties: true，M6 §10.5）——
  // 逐事件访问走宽容读取（read* 助手），不在此复制契约字段（M5 §1.3 组合纪律）
  [key: string]: unknown;
}

// 组合纪律（M5 §1.3 / D4 §9.3）：FeedEntry = 契约信封 & 本地附加（receivedAtMs），禁止复制契约字段
export interface FeedEntry extends EventEnvelopeFrame {
  /** 本地附加：移动端收达时刻 ms（F2 §3.3 requestedAt 同款口径） */
  receivedAtMs: number;
}

// feed 环形上限（F3 §3.4.2 条目上限 500 / R2UX-05-09 内存预算 / M6 §7.3 feed 渲染环形 500 条）
export const FEED_RING_MAX = 500;

// 会话事件窗口（M5 §3.1.1 EventWindow；R2UX-05-09 窗口卸载 ≤4 活跃窗口由接线层执行）
export interface EventWindow {
  /** 有界环形条目（seq 升序稳定排序；无 seq 帧按到达序置于尾部） */
  entries: FeedEntry[];
  /** 游标：该会话已确认（非 preview）的最大 sequence（resume 用；只升不降，M6 §8.3 规则 4） */
  lastSeq: number;
  /** 被环形淘汰的条目计数（F3 §3.4.2 顶部「已收起 N 条」标记数据面） */
  truncatedCount: number;
}

export function createWindow(): EventWindow {
  return { entries: [], lastSeq: 0, truncatedCount: 0 };
}

// ── 宽容读取助手（事件体为宽容 JSON：缺失/类型错 → undefined/false，M6 §10.5） ──

export function readRecord(v: unknown): Record<string, unknown> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  return v as Record<string, unknown>;
}

export function readString(v: unknown, key: string): string | undefined {
  const obj = readRecord(v);
  const value = obj?.[key];
  return typeof value === 'string' ? value : undefined;
}

export function readNumber(v: unknown, key: string): number | undefined {
  const obj = readRecord(v);
  const value = obj?.[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

export function readBool(v: unknown, ...keys: string[]): boolean {
  let current: unknown = v;
  for (const key of keys) {
    const obj = readRecord(current);
    if (!obj) return false;
    current = obj[key];
  }
  return current === true;
}

// ── 环形缓冲 / 去重 / 游标 ───────────────────────────────────────────────

export type AppendOutcome = 'appended' | 'replaced' | 'duplicate';

/**
 * feed 追加（events.push 入站 ingest 数据面）：
 * - 去重（M6 §8.3 规则 2/4）：seq ≤ lastSeq（已确认/回退）→ 丢弃；游标只升不降；
 * - 同 seq 原地覆盖（M6 §10.5：持久化副本按同 sequence 覆盖预览帧；保留首次收达时间）；
 * - preview 帧（实时预览，sequence 未落库）：追加但**不推进游标**（M6 §10.5 / §7.3）；
 * - 环形裁剪：超出 FEED_RING_MAX 丢最旧并累计 truncatedCount（R2UX-05-09）；
 * - 排序：追加后若乱序（preview/real 交错）则稳定重排（seq 升序，无 seq 帧在尾部）。
 */
export function appendFeed(
  window: EventWindow,
  frame: EventEnvelopeFrame,
  preview: boolean,
  nowMs: number
): AppendOutcome {
  const seq = readNumber(frame, 'sequence');
  const entry: FeedEntry = { ...frame, receivedAtMs: nowMs };
  if (seq === undefined) {
    // 无 sequence（legacy/畸形帧）：仅追加展示，不记游标（M6 §7.3 Delta 不记游标）
    window.entries.push(entry);
    trimWindow(window);
    return 'appended';
  }
  const existing = window.entries.findIndex(
    (e) => readNumber(e, 'sequence') === seq
  );
  if (existing >= 0) {
    // 同 seq 原地覆盖（预览帧 → 正式帧；保留首次收达时间）
    window.entries[existing] = {
      ...entry,
      receivedAtMs: window.entries[existing]!.receivedAtMs,
    };
    if (!preview && seq > window.lastSeq) {
      window.lastSeq = seq;
    }
    return 'replaced';
  }
  if (seq <= window.lastSeq) {
    // 重复/回退 seq：已确认过（含被环形淘汰）→ 丢弃
    return 'duplicate';
  }
  window.entries.push(entry);
  if (!preview) {
    window.lastSeq = seq;
  }
  // 乱序防护：preview/real 交错可能破坏 seq 升序不变量（如 preview 105 先于 real 104 到达）
  const prev = window.entries[window.entries.length - 2];
  const prevSeq = readNumber(prev, 'sequence');
  if (prevSeq !== undefined && seq < prevSeq) {
    window.entries = stableSortBySeq(window.entries);
  }
  trimWindow(window);
  return 'appended';
}

/** 环形裁剪（F3 §3.4.2 / R2UX-05-09：超 FEED_RING_MAX 丢最旧 + 累计截断计数） */
function trimWindow(window: EventWindow): void {
  const excess = window.entries.length - FEED_RING_MAX;
  if (excess > 0) {
    window.entries.splice(0, excess);
    window.truncatedCount += excess;
  }
}

/**
 * 稳定排序（seq 升序；无 seq 帧保持在尾部按到达序，M6 §8.3 顺序契约）：
 * 有 seq 条目按 seq 升序，同 seq（不应发生）保持原相对序；无 seq 条目整体置于尾部。
 */
export function stableSortBySeq(entries: readonly FeedEntry[]): FeedEntry[] {
  const withSeq: { entry: FeedEntry; index: number; seq: number }[] = [];
  const withoutSeq: FeedEntry[] = [];
  entries.forEach((entry, index) => {
    const seq = readNumber(entry, 'sequence');
    if (seq === undefined) {
      withoutSeq.push(entry);
    } else {
      withSeq.push({ entry, index, seq });
    }
  });
  withSeq.sort((a, b) => (a.seq !== b.seq ? a.seq - b.seq : a.index - b.index));
  return [...withSeq.map((x) => x.entry), ...withoutSeq];
}

/**
 * 快照/续传页合并（events.resume.page / C03 分页，M6 §4.1.3）：
 * 逐条走 appendFeed（preview=false，正式帧推进游标）；cursor（nextAfterSequence）
 * 取与现有游标的较大者（只升不降，M6 §8.3 规则 4）。
 */
export function hydrateFeed(
  window: EventWindow,
  frames: readonly EventEnvelopeFrame[],
  cursor: number | undefined,
  nowMs: number
): void {
  for (const frame of frames) {
    appendFeed(window, frame, false, nowMs);
  }
  if (cursor !== undefined && cursor > window.lastSeq) {
    window.lastSeq = cursor;
  }
}

/** 游标推进（events.resume.done resumedTo / subscribe.ok nextSequence 对齐）：只升不降 */
export function advanceCursor(window: EventWindow, seq: number): void {
  if (seq > window.lastSeq) {
    window.lastSeq = seq;
  }
}

// ── 过滤（R2UX-05-06 过滤条数据面：只看错误 / 只看当前 run / 只看工具） ──

export interface FeedFilter {
  /** 只看错误（F3 §5.1：error-entry + 错误态工具卡/任务卡 + run-header 失败态） */
  errorsOnly?: boolean;
  /** 只看当前 run（F3 §5.1；无 runId 的会话级/数据面条目被隐藏） */
  runId?: string | null;
  /** kind 白名单（只看工具等；F3 §5.1 只看工具 = tool/task/audit 类型集合） */
  typeWhitelist?: ReadonlySet<string>;
}

/**
 * 错误级派生标记（F3 §5.1 错误高亮清单；容错读取事件体）：
 * runtime-error / run-terminal(failed) / tool-end(isError) / task-failed / security-audit(blocked)
 */
export function deriveErrorLevel(frame: EventEnvelopeFrame): boolean {
  switch (frame.type) {
    case 'runtime-error':
      return true;
    case 'run-terminal':
      return readString(frame, 'terminal') === 'failed';
    case 'tool-end':
      return readBool(frame, 'result', 'isError');
    case 'task-failed':
      return true;
    case 'security-audit':
      return readString(frame, 'decision') === 'blocked';
    default:
      return false;
  }
}

/** 只看错误（F3 §5.1 过滤条「只看错误」数据面） */
export function filterErrors(entries: readonly FeedEntry[]): FeedEntry[] {
  return entries.filter((e) => deriveErrorLevel(e));
}

/** 只看当前 run（信封 runId 归属；无 runId 条目隐藏，F3 §5.1 分组规则 4 会话级区段） */
export function filterByRunId(
  entries: readonly FeedEntry[],
  runId: string
): FeedEntry[] {
  return entries.filter((e) => readString(e, 'runId') === runId);
}

/** kind 白名单过滤（只看工具等；F3 §5.1 只看工具 = 类型集合过滤） */
export function filterByTypes(
  entries: readonly FeedEntry[],
  types: ReadonlySet<string>
): FeedEntry[] {
  if (types.size === 0) return [...entries];
  return entries.filter((e) => types.has(e.type));
}

/** 组合过滤（R2UX-05-06 过滤条三维度组合：错误 ∧ run ∧ 类型） */
export function filterFeed(
  entries: readonly FeedEntry[],
  filter: FeedFilter
): FeedEntry[] {
  let out: readonly FeedEntry[] = entries;
  if (filter.errorsOnly) {
    out = filterErrors(out);
  }
  if (filter.runId != null && filter.runId !== '') {
    out = filterByRunId(out, filter.runId);
  }
  if (filter.typeWhitelist) {
    out = filterByTypes(out, filter.typeWhitelist);
  }
  return out as FeedEntry[];
}
