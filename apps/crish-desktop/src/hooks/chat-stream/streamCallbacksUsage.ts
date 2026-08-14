/**
 * chat-stream usage 消费段（G-03c 拆分）：run 收口 / stop 的 token usage 累计。
 *
 * - applyRunUsageSnapshot：complete 路径——DELAY_AFTER_STOP_MS 落定等待后拉
 *   run snapshot，4D/2D 估算器回退（T-47），delta 走串行化合并（F5 P2）；
 * - applyStopUsageApprox：stop 路径——正文长度 approx 估算兜底。
 * 失败静默（与原 try/catch 包裹等价）；不改变流式语义与回调时序。
 */
import { getSessionById } from '../../store/sessionStore';
import { getActiveModelId } from '../../api/providerProfiles';
import { getSettingsState } from '../../store/storeAccess';
import {
  applyUsageDelta,
  fetchRunSnapshotUsage,
} from '../../api/sessionEventHydrate';
import { accumulateTokenUsage } from '../../api/storeAccess';
import { buildMessageIndex } from './streamCallbacksInternals';
import {
  pickUsageCostEstimators,
  DELAY_AFTER_STOP_MS,
} from './streamCallbacksSurfaces';

/**
 * complete 收口：run usage 快照回填（DELAY_AFTER_STOP_MS 落定等待）+ 估算兜底。
 * 失败静默；F5 P2 串行化合并语义不变（多 run 同刻收尾不丢增量）。
 */
export async function applyRunUsageSnapshot(opts: {
  runId: string | null;
  sid: string;
  userMsgId: string;
  assistantMsgId: string;
}): Promise<void> {
  const { runId, sid, userMsgId, assistantMsgId } = opts;
  try {
    let applied = false;
    const { estimateCostUsd, estimateCostUsd4d, estimateSavingsUsd } =
      await import('../../api/pricingStore');
    if (runId) {
      await new Promise((r) => setTimeout(r, DELAY_AFTER_STOP_MS));
      const usage = await fetchRunSnapshotUsage(runId);
      if (
        usage &&
        (usage.sampleCount ?? 0) > 0 &&
        (usage.promptTokens || usage.completionTokens)
      ) {
        const model = getActiveModelId() || 'unknown';
        const cur = getSettingsState().tokenUsage;
        // T-47：4D 消费——缓存字段上报时用 estimateCostUsd4d + estimateSavingsUsd
        //（savedCost = 2D 全价 - 4D 实际价）；缓存缺失回退 2D，不虚报节省
        const { estimateCost, estimateSavings } = pickUsageCostEstimators(
          usage,
          {
            estimateCostUsd,
            estimateCostUsd4d,
            estimateSavingsUsd,
          },
          model
        );
        const next = applyUsageDelta(cur, usage, estimateCost, estimateSavings);
        const dIn = Math.max(0, (next.input || 0) - (cur.input || 0));
        const dOut = Math.max(0, (next.output || 0) - (cur.output || 0));
        const dCost = Math.max(0, (next.cost || 0) - (cur.cost || 0));
        const dCacheRead = Math.max(
          0,
          (next.cacheRead || 0) - (cur.cacheRead || 0)
        );
        const dCacheWrite = Math.max(
          0,
          (next.cacheWrite || 0) - (cur.cacheWrite || 0)
        );
        const dSavedCost = Math.max(
          0,
          (next.savedCost || 0) - (cur.savedCost || 0)
        );
        // F5 P2 修复：并发增量不丢失——delta 走串行化合并入口，
        // 不再「读陈旧快照 → 整体替换」（多 run 同刻收尾时后写者
        // 覆盖先写者、增量丢失）。D4 收敛：历史流水委托内建
        // （accumulateTokenUsage 单点完成 recordUsageDelta 委托）。
        accumulateTokenUsage({
          input: dIn,
          output: dOut,
          cost: dCost,
          model,
          ...(dCacheRead > 0 ? { cacheRead: dCacheRead } : {}),
          ...(dCacheWrite > 0 ? { cacheWrite: dCacheWrite } : {}),
          ...(dSavedCost > 0 ? { savedCost: dSavedCost } : {}),
        });
        applied = true;
      }
    }
    if (!applied) {
      const index = buildMessageIndex(getSessionById(sid));
      const userText = index.get(userMsgId)?.text || '';
      const asstText = index.get(assistantMsgId)?.text || '';
      const approxIn = Math.max(1, Math.ceil(userText.length / 4));
      const approxOut = Math.max(0, Math.ceil(asstText.length / 4));
      const model = getActiveModelId() || 'unknown';
      const dCost = estimateCostUsd(model, approxIn, approxOut);
      // F5 P2 修复：估算兜底路径同样走串行化合并（并发不丢增量）；
      // D4 收敛：历史流水委托内建（同上，不再并列双写）
      accumulateTokenUsage({
        input: approxIn,
        output: approxOut,
        cost: dCost,
        model,
      });
    }
  } catch {
    /* ignore */
  }
}

/** stop 路径：无正文不再估算；有正文走 approx 兜底累计（串行化合并）。 */
export async function applyStopUsageApprox(opts: {
  sid: string;
  userMsgId: string;
  assistantMsgId: string;
  stopText: string;
}): Promise<void> {
  const { sid, userMsgId, assistantMsgId, stopText } = opts;
  try {
    const index = buildMessageIndex(getSessionById(sid));
    const userTxt = index.get(userMsgId)?.text || '';
    const asstTxt = index.get(assistantMsgId)?.text || stopText || '';
    if (!userTxt && !asstTxt) return;
    const { estimateCostUsd } = await import('../../api/pricingStore');
    const approxIn = Math.max(1, Math.ceil(userTxt.length / 4));
    const approxOut = Math.max(0, Math.ceil(asstTxt.length / 4));
    const model = getActiveModelId() || 'unknown';
    const dCost = estimateCostUsd(model, approxIn, approxOut);
    // F5 P2 修复：stop 兜底路径走串行化合并（并发不丢增量）；
    // D4 收敛：历史流水委托内建（同上）
    accumulateTokenUsage({
      input: approxIn,
      output: approxOut,
      cost: dCost,
      model,
    });
  } catch {
    /* ignore */
  }
}
