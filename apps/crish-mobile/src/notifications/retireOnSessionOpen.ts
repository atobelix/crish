// 打开即退休·移动侧（批 C ⑫）：用户经任何入口打开某会话时，该会话
// 在通知中心的未读条目一并退休（shown → resolved，角标随未读计数
// 联动）。此前只有「点通知本身」的路径自带已读（通知中心行点击 /
// 深链落点），从主页状态板、抽屉列表等入口打开同一会话时条目仍挂
// 未读——本模块把退休收敛为会话打开的统一动作，调用点 = 远端会话
// 引擎挂载（一切入口最终都汇入会话屏）。
// 归属判定（只用可验证事实）：
// - 条目深链指向该会话（notificationSessionId，路由语义单一真源）；
// - 或条目是审批通知（toolCallId 非空）且该审批的归属会话为本会话
//   （经 approvalStore pending / history 连接——审批深链指向审批页
//   而非会话页，必须走连接，不能靠路由猜）。
// 本地线程没有通知面（本地通知生产者的深链目标为空），不在此处理。
import { notificationStore } from '@/domain/store/notificationStore';
import { approvalStore } from '@/domain/store/approvalStore';
import { notificationSessionId } from './notificationMeta';

/** 审批 toolCallId → 归属会话 id（pending 优先，history 兜底；无则 null） */
function approvalSessionIdOf(toolCallId: string): string | null {
  const state = approvalStore.getState();
  const pending = state.pending.find(
    (p) => p.request.toolCallId === toolCallId
  );
  if (pending) return pending.request.sessionId || null;
  const record = state.history.find((h) => h.toolCallId === toolCallId);
  return record ? record.sessionId || null : null;
}

/**
 * 退休某会话的全部未读通知条目，返回退休条数（0 = 无可退休）。
 * 已 resolved / dismissed 的条目不动；重复调用幂等。
 */
export function retireNotificationsForSession(sessionId: string): number {
  if (!sessionId) return 0;
  const { items } = notificationStore.getState();
  const ids: string[] = [];
  for (const item of items) {
    if (item.status !== 'shown') continue;
    if (notificationSessionId(item) === sessionId) {
      ids.push(item.id);
      continue;
    }
    if (item.toolCallId && approvalSessionIdOf(item.toolCallId) === sessionId) {
      ids.push(item.id);
    }
  }
  if (ids.length === 0) return 0;
  return notificationStore.getState().markManyRead(ids);
}
