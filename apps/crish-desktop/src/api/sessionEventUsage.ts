/**
 * run-snapshot usage 解析与累计（从 sessionEventHydrate 拆分）。
 *
 * 只负责 usage 结构解析 / delta 累加；事件投影见 sessionEventProjection，
 * 分页拉取与 hydrate 编排见 sessionEventHydrate。纯结构性拆分，逻辑一致。
 */

import { getTransport } from './transport';
import { logInternalError } from './userFacingErrors';

type AnyRec = Record<string, unknown>;

function asRec(v: unknown): AnyRec | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as AnyRec) : null;
}

/** usage delta 累加状态（4D：支持 cache read/write + savedCost） */
export type UsageDeltaState = {
  input: number;
  output: number;
  cost: number;
  inputMax: number;
  outputMax: number;
  cacheRead?: number;
  cacheWrite?: number;
  savedCost?: number;
};

/** run-snapshot usage 解析结果（4D 可选字段） */
export type RunSnapshotUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  sampleCount: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheMissTokens?: number;
  /** 命中率 = cacheRead / inputTotal；undefined = 未上报（隐藏而非 0%） */
  hitRatio?: number;
  /** 写入占比 = cacheWrite / inputTotal；undefined = 未上报 */
  writeRatio?: number;
  /** 本 run 审计出的浪费量（detectMiss 累计） */
  missedTokens?: number;
  /** 缓存温暖截止（now + TTL）；undefined = 无 TTL 数据 */
  warmUntilMs?: number;
};

/**
 * H3 钩子：拉取 run snapshot 中的 usage（若协议可用）。
 * H2 仅提供 API，UI 可选用。
 *
 * T-47：透出 cache 字段（cacheReadTokens / cacheWriteTokens / cacheMissTokens /
 * hitRatio / writeRatio / missedTokens / warmUntilMs），解析统一走
 * `parseRunSnapshotUsage`（与 H2 投影同口径，禁止两套解析漂移）。
 */
export async function fetchRunSnapshotUsage(
  runId: string
): Promise<RunSnapshotUsage | null> {
  const transport = getTransport();
  try {
    if (!transport.isReady()) return null;
    const res = (await transport.request<Record<string, unknown>>(
      'core_get_run_snapshot',
      { runId },
      { timeoutMs: 10_000 }
    )) as Record<string, unknown>;
    return parseRunSnapshotUsage(res);
  } catch (e) {
    logInternalError('fetchRunSnapshotUsage', e);
    return null;
  }
}

/**
 * 同步解析 run-snapshot 原始数据为规范化 usage 结构。
 * 支持 snapshot.cache.readTokens/writeTokens（legacy daemon 形态）和
 * usage.cacheReadTokens/cacheWriteTokens（T-40 wire 形态）两种字段路径；
 * cacheMissTokens / hitRatio / writeRatio / missedTokens / warmUntilMs 同源透出。
 * null 语义：缺失/非法值 → undefined（UI 隐藏而非显示 0）。
 */
export function parseRunSnapshotUsage(raw: unknown): RunSnapshotUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as AnyRec;
  // 优先从 snapshot.usage 读
  const snap = asRec(r.snapshot);
  const usage = asRec(snap?.usage) ?? asRec(r.usage);
  if (!usage) return null;

  const promptTokens =
    typeof usage.promptTokens === 'number' ? usage.promptTokens : null;
  const completionTokens =
    typeof usage.completionTokens === 'number' ? usage.completionTokens : null;
  const totalTokens =
    typeof usage.totalTokens === 'number'
      ? usage.totalTokens
      : (promptTokens ?? 0) + (completionTokens ?? 0);
  const sampleCount =
    typeof usage.sampleCount === 'number' ? usage.sampleCount : 0;

  if (promptTokens === null && completionTokens === null) return null;

  // cache 字段（T-47）：优先 snapshot.cache（legacy daemon 形态），
  // 否则 usage.*（T-40 wire 形态 RunUsage camelCase）。
  const cache = snap ? asRec(snap.cache) : null;
  const readRaw = cache ? cache.readTokens : usage.cacheReadTokens;
  const writeRaw = cache ? cache.writeTokens : usage.cacheWriteTokens;
  const missRaw = cache ? cache.missTokens : usage.cacheMissTokens;
  const hitRatioRaw = cache ? cache.hitRatio : usage.hitRatio;
  const writeRatioRaw = cache ? cache.writeRatio : usage.writeRatio;

  // 计数类仅正数透出（0 = 无缓存活动；undefined = 未上报，UI 隐藏）
  const positive = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  // 比例类非负即透出（0 是合法报告值，区别于未上报 undefined）
  const nonNegative = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };

  const cacheReadTokens = positive(readRaw);
  const cacheWriteTokens = positive(writeRaw);
  const cacheMissTokens = positive(missRaw);
  const hitRatio = nonNegative(hitRatioRaw);
  const writeRatio = nonNegative(writeRatioRaw);
  const missedTokens = positive(usage.missedTokens);
  const warmUntilMs = positive(usage.warmUntilMs);

  return {
    promptTokens: promptTokens ?? 0,
    completionTokens: completionTokens ?? 0,
    totalTokens,
    sampleCount,
    ...(cacheReadTokens !== undefined && { cacheReadTokens }),
    ...(cacheWriteTokens !== undefined && { cacheWriteTokens }),
    ...(cacheMissTokens !== undefined && { cacheMissTokens }),
    ...(hitRatio !== undefined && { hitRatio }),
    ...(writeRatio !== undefined && { writeRatio }),
    ...(missedTokens !== undefined && { missedTokens }),
    ...(warmUntilMs !== undefined && { warmUntilMs }),
  };
}

/**
 * 将 usage delta 并入本地累计状态（4D：支持 cache read/write + savedCost）。
 * sampleCount 为 0 时视为无真实样本，调用方可回退估算。
 *
 * @param current      当前累计状态
 * @param usage        本次增量（promptTokens / completionTokens / cacheRead/WriteTokens）
 * @param estimateCost (input, output, cacheRead?, cacheWrite?) => cost
 * @param estimateSavings (input, output, cacheRead?, cacheWrite?) => savedCost（可选）
 */
export function applyUsageDelta(
  current: UsageDeltaState,
  usage: {
    promptTokens?: number;
    completionTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  },
  estimateCost: (
    input: number,
    output: number,
    cacheRead?: number,
    cacheWrite?: number
  ) => number,
  estimateSavings?: (
    input: number,
    output: number,
    cacheRead?: number,
    cacheWrite?: number
  ) => number
): UsageDeltaState {
  const din = Math.max(0, usage.promptTokens ?? 0);
  const dout = Math.max(0, usage.completionTokens ?? 0);
  const dcr = Math.max(0, usage.cacheReadTokens ?? 0);
  const dcw = Math.max(0, usage.cacheWriteTokens ?? 0);
  if (din === 0 && dout === 0 && dcr === 0 && dcw === 0) return current;

  const nextIn = current.input + din;
  const nextOut = current.output + dout;
  const nextCost =
    current.cost + estimateCost(din, dout, dcr || undefined, dcw || undefined);

  const hasCacheRead = dcr > 0;
  const hasCacheWrite = dcw > 0;
  const nextCacheRead = hasCacheRead
    ? (current.cacheRead ?? 0) + dcr
    : current.cacheRead;
  const nextCacheWrite = hasCacheWrite
    ? (current.cacheWrite ?? 0) + dcw
    : current.cacheWrite;

  let nextSavedCost = current.savedCost;
  if (estimateSavings && (dcr > 0 || dcw > 0)) {
    const ds = estimateSavings(din, dout, dcr || undefined, dcw || undefined);
    nextSavedCost = (current.savedCost ?? 0) + ds;
  }

  return {
    ...current,
    input: nextIn,
    output: nextOut,
    cost: nextCost,
    ...(nextCacheRead !== undefined && { cacheRead: nextCacheRead }),
    ...(nextCacheWrite !== undefined && { cacheWrite: nextCacheWrite }),
    ...(nextSavedCost !== undefined && { savedCost: nextSavedCost }),
  };
}
