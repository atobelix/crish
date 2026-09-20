import { getCompositionRoot } from '../../app/compositionRoot';
import { clearRuntimeStatus } from '../../store/sessionRuntimeStatusStore';

/**
 * 用户物理发送瞬间的绝对自愈扫除器：
 * 1. 检查物理句柄：若无真实 live stream，判定任何历史 processing/queued 均为脏数据；
 * 2. 原子清扫历史残余，将 assistant processing 结算为 error（保留已有的 partial 文本，无文本则留空）；
 *    将 user processing / queued 结算为 completed；
 * 3. 同步清空该会话的运行时状态机瞬态状态（单轨收敛 §2.0：错误不再写入 errorDetail 气泡卡）；
 * 4. 彻底打通发送主路径，确保新轮次 100% 成功发起，绝不打回！
 */
export function settleStaleSessionProcessingMessages(
  sessionId: string,
  hasLiveStream: boolean
): { healedCount: number; clearedQueueCount: number } {
  if (hasLiveStream) {
    // 存在真实活动物理流，不干预正常并发控制
    return { healedCount: 0, clearedQueueCount: 0 };
  }

  const root = getCompositionRoot();
  const session = root.session.getState();
  const currentSession = session.sessionsById[sessionId];
  if (!currentSession || !Array.isArray(currentSession.messages)) {
    return { healedCount: 0, clearedQueueCount: 0 };
  }

  let healedCount = 0;
  let clearedQueueCount = 0;

  for (const msg of currentSession.messages) {
    if (msg.status === 'processing') {
      if (msg.sender === 'assistant') {
        // 保留已有的 partial 文本；不再写 errorDetail（错误单轨收敛：UI 不渲染气泡错误卡）
        session.setSessionMessageStatus(sessionId, msg.id, 'error', undefined, {
          force: true,
        });
      } else {
        session.setSessionMessageStatus(sessionId, msg.id, 'completed', undefined, { force: true });
      }
      healedCount++;
    } else if (msg.status === 'queued') {
      session.setSessionMessageStatus(sessionId, msg.id, 'completed', undefined, { force: true });
      clearedQueueCount++;
    }
  }

  // 同步清理运行时状态机瞬态状态（单轨收敛 §2.0）
  try {
    clearRuntimeStatus(sessionId);
  } catch {
    /* ignore */
  }

  return { healedCount, clearedQueueCount };
}
