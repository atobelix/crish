/**
 * chat-stream usage 消费段（G-03c 拆分）：run 收口 / stop 的 token usage 累计。
 *
 * - applyRunUsageSnapshot：complete 路径——DELAY_AFTER_STOP_MS 落定等待后拉
 *   run snapshot，费用 = 引擎 `RunUsage.cost`（三态：未定价 / 免费 / 有价）；
 *   delta 走串行化合并（F5 P2）。
 * - applyStopUsageApprox：stop 路径——正文长度 approx 估算 token；
 *   **费用不估算**（无 usage 样本 → 保持未定价，plans/05 §2.3）。
 * 失败静默；不改变流式语义与回调时序。
 */
import { getSessionById } from '../../store/sessionStore';
import { getSettingsState } from '../../store/storeAccess';
import {
  applyUsageDelta,
  fetchRunSnapshotUsage,
} from '../../api/sessionEventHydrate';
import { accumulateTokenUsage } from '../../api/storeAccess';
import { buildMessageIndex } from './streamCallbacksInternals';
import { DELAY_AFTER_STOP_MS } from './streamCallbacksSurfaces';

/**
 * complete 收口：run usage 快照回填（DELAY_AFTER_STOP_MS 落定等待）。
 * 费用只来自引擎（usage.cost）；无 cost → 不写费用（未定价），不再 JS 估算。
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
    if (runId) {
      await new Promise((r) => setTimeout(r, DELAY_AFTER_STOP_MS));
      const usage = await fetchRunSnapshotUsage(runId);
      if (
        usage &&
        (usage.sampleCount ?? 0) > 0 &&
        (usage.promptTokens || usage.completionTokens)
      ) {
        const cur = getSettingsState().tokenUsage;
        const next = applyUsageDelta(cur, usage);
        const dIn = Math.max(0, (next.input || 0) - (cur.input || 0));
        const dOut = Math.max(0, (next.output || 0) - (cur.output || 0));
        const dCacheRead = Math.max(
          0,
          (next.cacheRead || 0) - (cur.cacheRead || 0)
        );
        const dCacheWrite = Math.max(
          0,
          (next.cacheWrite || 0) - (cur.cacheWrite || 0)
        );
        // 费用三态：引擎 cost（next - cur 差值语义在 applyUsageDelta 内完成；
        // 这里只带引擎三态增量，微元/currency/formatted 由 merge 层同币种累计）
        const costStatus = usage.cost
          ? usage.cost.isFree
            ? 'free'
            : 'priced'
          : undefined;
        accumulateTokenUsage({
          input: dIn,
          output: dOut,
          ...(costStatus ? { costStatus } : {}),
          ...(usage.cost && !usage.cost.isFree
            ? {
                currency: usage.cost.currency,
                costMicros: usage.cost.totalMicros,
                formattedCost: usage.cost.formattedTotal,
              }
            : {}),
          ...(usage.cost?.isFree ? { formattedCost: '免费' } : {}),
          ...(dCacheRead > 0 ? { cacheRead: dCacheRead } : {}),
          ...(dCacheWrite > 0 ? { cacheWrite: dCacheWrite } : {}),
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
      // 兜底只累计 token；费用不估算（保持未定价，plans/05 §2.3）
      accumulateTokenUsage({
        input: approxIn,
        output: approxOut,
      });
    }
  } catch {
    /* ignore */
  }
}

/** stop 路径：无正文不再估算；有正文走 approx 兜底累计（token only，费用不估算）。 */
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
    const approxIn = Math.max(1, Math.ceil(userTxt.length / 4));
    const approxOut = Math.max(0, Math.ceil(asstTxt.length / 4));
    accumulateTokenUsage({
      input: approxIn,
      output: approxOut,
    });
  } catch {
    /* ignore */
  }
}
