/**
 * 工具内容揭示状态（AN4 · 工具内容伪流式显现）。
 *
 * 工具调用没有数据增量（tool-start 全参数 / tool-end 全结果的离散
 * 模型），伪流式纯属呈现调度：数据已全量在手，本模块只管「何时、
 * 以什么节奏给眼睛看」的状态与判定——
 *
 * - 呈现记忆（会话级 Set，FIFO 上限）：入场只播一次、输出只揭示
 *   一次；重挂载 / 滚动回屏 / 手动展开一律全量直出（分析 §五门 2）；
 * - 入场交错协调：同一批（同一 commit 相邻挂载）的工具行按挂载序
 *   领取交错延时（50ms/行、至多 6 行、总延时 ≤300ms，分析 §三 #1）；
 * - 排空注册表：进行中的文本排空可被外部 settle（用户让位 §5.1），
 *   也供 FoldableToolGroup 的自动折叠延后查询（§1.3 衔接段）；
 * - 交互登记：用户对某行做过展开/折叠后，该行视同已授权全量，
 *   不再对它排空（分析 §五门 4）。
 *
 * 节律速度域（啮合门槛 / 稳态速率 / 单帧硬顶）不在本文件定义：
 * 统一消费 utils/revealPacing（R11 / AN4 共建，单一出生地）。
 * 本模块的时长带（排空总时长 150–900ms、量级带顶 4600 字）是
 * AN4 依据数据模型（整块到达）导出的本案常数（分析 §四.1）。
 */
import { TEXT_REVEAL_PACING } from '../../utils/revealPacing';

/** 交错步长（ms/行）：取 tokens 既有交错步长档（分析 §三 #1） */
export const REVEAL_STAGGER_STEP_MS = 50;
/** 交错上限行数：超出者零延时直入（第 7 行起） */
export const REVEAL_STAGGER_MAX_ROWS = 6;
/** 入场批次窗（ms）：相邻两次领取间隔超过此值视为新一批 */
export const ENTRANCE_BATCH_GAP_MS = 120;
/** 排空量级带顶（字）：超过此量整块淡入（分析 §四.1 推导） */
export const DRAIN_BAND_MAX_CHARS = 4600;
/** 排空总时长下限（ms）：短于此不可知觉为「过程」，只剩两次闪烁 */
export const DRAIN_MIN_DURATION_MS = 150;
/** 排空总时长硬顶（ms）：与 tool-end 事件点脱钩即成空转表演 */
export const DRAIN_MAX_DURATION_MS = 900;
/** 自动折叠等待排空 settle 的硬顶（ms）：等于排空总时长上限 */
export const AUTO_COLLAPSE_DRAIN_WAIT_CAP_MS = DRAIN_MAX_DURATION_MS;

/** 呈现记忆容量（FIFO 淘汰最旧）：与 useMessageRowEntrance 同量级口径放大一档 */
const REVEAL_MEMORY_CAP = 1000;

function createFifoSet(): Set<string> {
  return new Set<string>();
}

function fifoAdd(set: Set<string>, key: string): void {
  if (!key || set.has(key)) return;
  if (set.size >= REVEAL_MEMORY_CAP) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
  set.add(key);
}

/** 已播入场的呈现键（工具行 = toolId；分派卡 = `agent:<id>`；工具组 = `group:<…>`） */
const enteredKeys = createFifoSet();
/** 输出已完成首次呈现的 toolId */
const presentedOutputIds = createFifoSet();
/** 用户已交互（展开/折叠/点击/聚焦）过的 toolId */
const interactedToolIds = createFifoSet();

export function hasEntered(key: string): boolean {
  return enteredKeys.has(key);
}

export function markEntered(key: string): void {
  fifoAdd(enteredKeys, key);
}

export function hasPresentedOutput(toolId: string): boolean {
  return presentedOutputIds.has(toolId);
}

export function markPresentedOutput(toolId: string): void {
  fifoAdd(presentedOutputIds, toolId);
}

export function hasToolInteracted(toolId: string): boolean {
  return interactedToolIds.has(toolId);
}

export function markToolInteracted(toolId: string): void {
  fifoAdd(interactedToolIds, toolId);
}

/**
 * 降级判定（分析 §五门 6；X1 解耦口径）：仅系统减动效
 * （prefers-reduced-motion）命中 → 全部揭示旁路直出。性能档（eco）
 * 不再构成降级条件——减动效只响应系统设置，eco 只降高成本绘制
 * 效果，不动呈现节律。CSS 侧动画由 tokens 的系统减动效通道独立
 * 兜底，此处管 JS 驱动的排空与入场状态机本身。
 */
export function isRevealDegraded(): boolean {
  if (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function'
  ) {
    try {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        return true;
      }
    } catch {
      // matchMedia 异常环境按未降级处理（CSS 侧仍有系统减动效通道兜底）
    }
  }
  return false;
}

/**
 * 实况时间窗（与 AN2 useMessageRowEntrance 同口径）：事件时间戳
 * 距当前在 [-500ms, 2000ms) 内才算「发生于当前实况」；历史会话
 * 的旧时间戳一律出窗（分析 §五门 1）。
 */
export function isLiveEventTimestamp(
  eventTs: number | undefined,
  now: number
): boolean {
  if (
    typeof eventTs !== 'number' ||
    !Number.isFinite(eventTs) ||
    eventTs <= 0
  ) {
    return false;
  }
  const delta = now - eventTs;
  return delta >= -500 && delta < 2000;
}

export interface EntranceDecisionInput {
  key: string;
  eventTs?: number | undefined;
  now: number;
  /** 原地替换契约命中：禁入场（分析 §五门 5，翻转即其全部动效） */
  replaceHit?: boolean | undefined;
  /** 调用方门控未就绪（如工具组尚未聚合形成） */
  disabled?: boolean | undefined;
}

/** 入场判定（纯函数，副作用仅读注册表）：全部入门条件见分析 §五 */
export function decideEntrance(input: EntranceDecisionInput): boolean {
  if (!input.key || input.disabled || input.replaceHit) return false;
  if (hasEntered(input.key)) return false;
  if (isRevealDegraded()) return false;
  return isLiveEventTimestamp(input.eventTs, input.now);
}

/* ───── 退场判定（S4 · decideEntrance 的对偶，E 类 1 缺口 #1） ───── */

export interface ExitDecisionInput {
  key: string;
  /**
   * 该键是否已完成过入场（呈现记忆）；缺省读 enteredKeys。
   * 未入场者退场亦直落：历史回放里瞬时出现的元素，消失时也不播退场
   * （与入场「历史安静」对称）。引擎/浮层宿主（Base UI / Radix /
   * 自研 closing 态）若已在挂载期亲眼见过元素，可显式传 true——
   * 它们不走入场通道，呈现记忆里没有它们的键。
   */
  entered?: boolean | undefined;
  /** 调用方门控未就绪 */
  disabled?: boolean | undefined;
  /**
   * 处于虚拟窗口内：虚拟器驱动的卸载（滚动出窗）不走退场宿主，
   * 直落。数据驱动的退场（状态变化）不受此限。
   */
  inVirtualWindow?: boolean | undefined;
}

/**
 * 退场判定（纯函数，副作用仅读注册表）——decideEntrance 的对偶：
 * - 空键 / 门控未就绪 → 直落；
 * - 虚拟窗口内卸载 → 直落（宿主结构上就播不了退场）；
 * - 系统减动效 → 直落（减动效只响应系统设置，见 isRevealDegraded）；
 * - 该键从未入场 → 直落（无戳：瞬时出现的元素瞬时消失）。
 *
 * 「同键退场只播一次」不在此处用全局注册表强制：同一键在新的挂载
 * 周期里可再次合法退场（例如同一轮次再次失败的错误条）。一次挂载
 * 周期内只播一次由宿主的状态机保证（closing 标志 + 重挂取消），
 * 快速增删合并亦由宿主处理（重挂即取消待退场）。
 */
export function decideExit(input: ExitDecisionInput): boolean {
  if (!input.key || input.disabled || input.inVirtualWindow) return false;
  if (isRevealDegraded()) return false;
  const entered = input.entered ?? hasEntered(input.key);
  if (!entered) return false;
  return true;
}

/* ───── 入场交错协调（同批挂载序 = 渲染序 = 视觉行序） ───── */

let lastEntranceClaimAt = Number.NEGATIVE_INFINITY;
let entranceBatchIndex = 0;

/**
 * 领取本行在当前入场批次中的交错延时：同批第 i 行（0 起）延时
 * i × 50ms，至多 6 行；批次间隔超过 ENTRANCE_BATCH_GAP_MS 重新计数。
 */
export function claimEntranceDelay(now: number): number {
  if (now - lastEntranceClaimAt > ENTRANCE_BATCH_GAP_MS) {
    entranceBatchIndex = 0;
  }
  const index = entranceBatchIndex;
  entranceBatchIndex += 1;
  lastEntranceClaimAt = now;
  return index < REVEAL_STAGGER_MAX_ROWS ? index * REVEAL_STAGGER_STEP_MS : 0;
}

/* ───── 输出排空注册表（让位 settle + 组折叠延后查询） ───── */

interface ToolDrainEntry {
  settle: () => void;
  settledListeners: Set<() => void>;
}

const activeToolDrains = new Map<string, ToolDrainEntry>();

export function registerToolDrain(toolId: string, settle: () => void): void {
  if (!toolId) return;
  activeToolDrains.set(toolId, { settle, settledListeners: new Set() });
}

export function unregisterToolDrain(toolId: string): void {
  const entry = activeToolDrains.get(toolId);
  if (!entry) return;
  activeToolDrains.delete(toolId);
  for (const cb of [...entry.settledListeners]) cb();
}

export function hasActiveToolDrain(toolId: string): boolean {
  return activeToolDrains.has(toolId);
}

/** 让位：指定工具的进行中排空同帧抵达终态（无进行中排空则无操作） */
export function settleToolReveal(toolId: string): void {
  activeToolDrains.get(toolId)?.settle();
}

/**
 * 订阅「给定工具集合全部排空落定」：任一工具注销排空时复查，
 * 全清后回调一次。返回取消订阅函数（取消后不再回调）。
 */
export function onAllToolDrainsSettled(
  toolIds: string[],
  cb: () => void
): () => void {
  let fired = false;
  const unsubs: Array<() => void> = [];
  const cleanup = () => {
    for (const unsub of unsubs) unsub();
  };
  const check = () => {
    if (fired) return;
    if (toolIds.every((id) => !activeToolDrains.has(id))) {
      fired = true;
      cleanup();
      cb();
    }
  };
  for (const id of toolIds) {
    const entry = activeToolDrains.get(id);
    if (entry) {
      const listener = () => check();
      entry.settledListeners.add(listener);
      unsubs.push(() => entry.settledListeners.delete(listener));
    }
  }
  return () => {
    fired = true;
    cleanup();
  };
}

/* ───── 输出揭示分类与排空时长（分析 §三 #4 / §四.1） ───── */

export type OutputRevealClass = 'direct' | 'drain' | 'fade';

/**
 * 按展示文本量级分类：≤ 啮合门槛直出；带内（门槛 < 量 ≤ 4600）
 * 行式排空；带外整块淡入。
 */
export function classifyOutputReveal(charCount: number): OutputRevealClass {
  if (charCount <= TEXT_REVEAL_PACING.engageThresholdChars) return 'direct';
  if (charCount > DRAIN_BAND_MAX_CHARS) return 'fade';
  return 'drain';
}

/**
 * 排空总时长：以稳态速率封顶为基准速率推导（量 / 稳态速率），
 * 再夹进 [150ms, 900ms]——带内大端由此自然加速至追赶封顶一带，
 * 工具内容的接收速度始终落在正文同一速度域内（分析 §四.1）。
 */
export function drainDurationMs(charCount: number): number {
  const raw = (charCount / TEXT_REVEAL_PACING.steadyCapCharsPerSec) * 1000;
  return Math.min(DRAIN_MAX_DURATION_MS, Math.max(DRAIN_MIN_DURATION_MS, raw));
}

/** 单元测试专用重置钩子 */
export function _resetToolRevealStateForTesting(): void {
  enteredKeys.clear();
  presentedOutputIds.clear();
  interactedToolIds.clear();
  activeToolDrains.clear();
  lastEntranceClaimAt = Number.NEGATIVE_INFINITY;
  entranceBatchIndex = 0;
}
