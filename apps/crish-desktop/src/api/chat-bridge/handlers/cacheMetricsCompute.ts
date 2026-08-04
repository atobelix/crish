/**
 * 消息级缓存指标纯函数（无环依赖模块）。
 *
 * 本模块被 messageHandlers 与 session-persistence（sessionRustDb）共同消费，
 * 独立成文件以切断「sessionRustDb → messageHandlers → store/index →
 * workspaceStore → … → sessionRustDb」的循环依赖（TDZ：Cannot access
 * 'useLayoutStore' before initialization，系统性收口 2026-08-04 修复）。
 *
 * null 语义（P5 §3.1 / P6 C15）：null = 无可展示数据 → UI 隐藏而非显示 0%。
 */

/** 消息级缓存指标（T-47；T-41 的 shared-utils `computeCacheMetrics` 未就位时的
 * 本地等效，R6 合并替换为 shared-utils 纯函数）。 */
export interface MessageCacheMetrics {
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheMissTokens?: number;
  /** 命中率 = cacheRead / inputTotal（inputTotal == 0 → undefined 隐藏） */
  hitRate?: number;
  /** 写入占比 = cacheWrite / inputTotal */
  writeRate?: number;
  /** 输入总量 = miss + read + write（C9 恒等式） */
  inputTotal?: number;
}

function asRec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** 计数类：仅正数透出（0 = 无缓存活动；undefined = 未上报） */
function positiveNum(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * 从 message-end 消息的 metadata 派生消息级缓存指标。
 * - `metadata.cacheBreakdown`（Rust 已按 C9 口径派生，camelCase
 *   read/write/miss/inputTotal）优先；
 * - 否则从 `metadata.usage`（ProviderUsage camelCase：promptTokens /
 *   cacheReadTokens / cacheWriteTokens / cacheMissTokens）取值并本地推导；
 * - Included 形态兜底（T-48）：未直报 cacheMissTokens 但上报 promptTokens
 *   时，inputTotal = promptTokens（C9 恒等式隐含 miss = prompt - read - write）；
 * - C15 null 语义：usage 存在且上报了非零输入（prompt）→ 「已上报确为 0」
 *   的非 null 结果（0 与 null 必须可区分，P6 §3.6.1 / e2e 用例④）；
 *   完全无任何字段 / 全零 breakdown → null（未上报，隐藏而非 0%）。
 */
export function computeCacheMetricsFromUsage(
  metadata: unknown
): MessageCacheMetrics | null {
  const meta = asRec(metadata);
  if (!meta) return null;
  const breakdown = asRec(meta.cacheBreakdown);
  const usage = asRec(meta.usage);

  const read = breakdown
    ? positiveNum(breakdown.read)
    : positiveNum(usage?.cacheReadTokens);
  const write = breakdown
    ? positiveNum(breakdown.write)
    : positiveNum(usage?.cacheWriteTokens);
  const miss = breakdown
    ? positiveNum(breakdown.miss)
    : positiveNum(usage?.cacheMissTokens);

  let inputTotal: number | undefined;
  if (breakdown) {
    inputTotal = positiveNum(breakdown.inputTotal);
  } else {
    const sum = (miss ?? 0) + (read ?? 0) + (write ?? 0);
    const prompt = positiveNum(usage?.promptTokens);
    if (prompt !== undefined && prompt >= (read ?? 0) + (write ?? 0)) {
      // Included 形态（权威口径）：promptTokens = inputTotal = miss + read + write，
      // miss 未直报时隐含 = prompt - read - write（T-45 fixture 75% 口径）
      inputTotal = prompt;
    } else if (sum > 0) {
      // Excluded / 部分上报：inputTotal = 已上报的 miss + read + write
      inputTotal = sum;
    }
  }

  // usage 显式声明了缓存字段（值可为 0）→ 「已上报确为 0」与未上报可区分（C15）
  const explicitCache =
    usage != null &&
    (usage.cacheReadTokens !== undefined ||
      usage.cacheWriteTokens !== undefined ||
      usage.cacheMissTokens !== undefined);
  const hasCounts =
    read !== undefined || write !== undefined || miss !== undefined;
  // 全零且无 inputTotal 可推导 → null（隐藏）；「确为 0」需 inputTotal 锚定命中率
  if (!hasCounts && !(explicitCache && inputTotal !== undefined)) return null;

  const hitRate =
    inputTotal !== undefined && inputTotal > 0
      ? (read ?? 0) / inputTotal
      : undefined;
  const writeRate =
    inputTotal !== undefined && inputTotal > 0 && write !== undefined
      ? write / inputTotal
      : undefined;

  return {
    ...(read !== undefined && { cacheReadTokens: read }),
    ...(write !== undefined && { cacheWriteTokens: write }),
    ...(miss !== undefined && { cacheMissTokens: miss }),
    ...(hitRate !== undefined && { hitRate }),
    ...(writeRate !== undefined && { writeRate }),
    ...(inputTotal !== undefined && { inputTotal }),
  };
}
