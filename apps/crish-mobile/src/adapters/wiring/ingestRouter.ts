// 接线层：StoreIngestAction → store 动作路由（M5 §4.2 适配层职责）
// - eventMappers（R2-05a 已交付）产出动作列表（纯函数，49/49 事件覆盖），本模块是唯一执行点
//   （组合纪律 M5 §1.3：映射面与执行面分离，测试可分别断言）；
// - sessions-refresh 无本地可执行语义（索引全量拉取是 IO，M6 §10.5），经
//   onSessionsRefresh 回调交给接线层 repository（FeedBridge.listSessions）；
// - ignore 动作宽容跳过 + 留痕（MessageKind::Unknown 语义，不崩溃不猜测）。
import { eventStore } from '@/domain/store/eventStore';
import { sessionStore } from '@/domain/store/sessionStore';
import type { StoreIngestAction } from '@/domain/store/eventMappers';

export interface IngestDispatchOptions {
  /** sessions-refresh 信号回调（索引全量拉取由接线层 repository 执行，M6 §10.5） */
  onSessionsRefresh?: () => void;
}

/**
 * 执行 store 动作列表（逐条路由，顺序执行不吞错）：
 * - feed 面：feed-append（ingest，preview 透传）/ feed-hydrate（快照重建）/ feed-set-cursor（游标对齐）；
 * - 会话面：session-upsert / session-remove（连带卸载事件窗口）/ sessions-refresh（回调上抛）；
 * - 会话副作用（F1 §2.5「落/刷」列）：run-active / run-terminal / approval-delta；
 * - ignore：debug 留痕后跳过。
 */
export function dispatchIngestActions(
  actions: readonly StoreIngestAction[],
  opts: IngestDispatchOptions = {}
): void {
  for (const action of actions) {
    switch (action.kind) {
      case 'feed-append':
        eventStore
          .getState()
          .ingest(action.sessionId, action.frame, action.preview);
        break;
      case 'feed-hydrate':
        eventStore
          .getState()
          .hydrate(action.sessionId, action.events, action.cursor);
        break;
      case 'feed-set-cursor':
        eventStore.getState().setCursor(action.sessionId, action.seq);
        break;
      case 'session-upsert':
        sessionStore.getState().upsert(action.session);
        break;
      case 'session-remove':
        sessionStore.getState().remove(action.sessionId);
        // 投影清理连带事件窗口卸载（M6 §9.3 ② cleanup 同口径，内存回收）
        eventStore.getState().unloadWindow(action.sessionId);
        break;
      case 'sessions-refresh':
        opts.onSessionsRefresh?.();
        break;
      case 'run-active':
        sessionStore
          .getState()
          .applyRunActive(action.sessionId, action.runId, true);
        break;
      case 'run-terminal':
        sessionStore
          .getState()
          .applyRunActive(action.sessionId, action.runId, false);
        break;
      case 'approval-delta':
        sessionStore
          .getState()
          .applyApprovalDelta(action.sessionId, action.delta);
        break;
      case 'session-unread-update':
        sessionStore
          .getState()
          .applyLatestSeq(
            action.sessionId,
            action.latestSeq,
            action.isAssistant
          );
        break;
      case 'ignore':
        // 宽容跳过留痕（未知 type / 域外 kind / 解析失败，D3 §10.3 不打断连接）
        console.debug(`[wiring] 忽略入站动作：${action.reason}`);
        break;
    }
  }
}
