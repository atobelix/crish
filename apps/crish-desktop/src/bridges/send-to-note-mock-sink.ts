/**
 * send_to_note mock sink（从 send-to-note.ts 拆出，纯结构性重构）。
 *
 * 可审计 mock sink：默认成功；`setResult` 切换失败态。
 * **不**写真实块树。
 */

import type {
  SendToNoteIntent,
  SendToNoteSink,
  SendToNoteSinkResult,
} from './send-to-note';

export type MockSendToNoteSink = {
  sink: SendToNoteSink;
  calls: SendToNoteIntent[];
  results: SendToNoteSinkResult[];
  setResult: (result: SendToNoteSinkResult) => void;
  clear: () => void;
};

/**
 * 可审计 mock sink：默认成功；`setResult` 切换失败态。
 * **不**写真实块树。
 */
export function createMockSendToNoteSink(
  initialResult: SendToNoteSinkResult = { ok: true, blockIds: ['mock-b-0001'] }
): MockSendToNoteSink {
  const calls: SendToNoteIntent[] = [];
  const results: SendToNoteSinkResult[] = [];
  let current: SendToNoteSinkResult = { ...initialResult };
  if (initialResult.blockIds) {
    current.blockIds = [...initialResult.blockIds];
  }

  const sink: SendToNoteSink = async (intent) => {
    // 深拷贝 markdown 字符串，证明不持有调用方可变缓冲引用意图
    calls.push({
      ...intent,
      source: { ...intent.source, markdown: String(intent.source.markdown) },
      target: { ...intent.target },
    });
    const r: SendToNoteSinkResult = { ok: current.ok };
    if (current.reason !== undefined) r.reason = current.reason;
    if (current.blockIds !== undefined) r.blockIds = [...current.blockIds];
    results.push(r);
    return r;
  };

  return {
    sink,
    calls,
    results,
    setResult(result) {
      current = { ok: result.ok };
      if (result.reason !== undefined) current.reason = result.reason;
      else delete current.reason;
      if (result.blockIds !== undefined)
        current.blockIds = [...result.blockIds];
      else delete current.blockIds;
    },
    clear() {
      calls.length = 0;
      results.length = 0;
    },
  };
}
