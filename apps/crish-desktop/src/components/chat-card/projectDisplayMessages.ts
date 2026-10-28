/**
 * S-6（FINAL-PLAN §2）：列表展示投影——消息流展示的唯一入口。
 *
 * 顺序：排序（compareMessageOrder）→ 搜索过滤 → S-3 可渲染过滤 → S-5 载体折叠。
 * 先排序后折叠（E4 正确性修正）；不可渲染行（空助手行、只含 S7 旧思考的历史行）
 * 先被滤掉，所以只隔着不可见行的相邻载体会被折叠为一条；隔着用户气泡的载体不合并。
 * 渲染期投影，不改写 store / 持久化数据。
 */
import type { SessionMessage } from '../../store/types';
import { sortMessagesByOrder } from '../../store/storeAccess';
import { messageMatchesSearch } from '../../api/sessionSearch';
import { isRenderableAssistantMessage } from '../../api/toolPresentation';
import { dedupeStateCarrierMessages } from '../chat-message/contextStateUtils';

export interface DisplayProjection {
  /** 列表实际渲染的消息 */
  display: SessionMessage[];
  /** 投影后、搜索前的条数（空态判定用：全部不可渲染 → 0 → 欢迎面） */
  visibleCount: number;
}

export function projectDisplayMessages(
  messages: readonly SessionMessage[],
  query: string
): DisplayProjection {
  const q = query.trim();
  const renderable = sortMessagesByOrder(messages as SessionMessage[]).filter(
    (m) => isRenderableAssistantMessage(m)
  );
  const all = dedupeStateCarrierMessages(renderable);
  if (!q) return { display: all, visibleCount: all.length };
  const display = dedupeStateCarrierMessages(
    renderable.filter((m) => messageMatchesSearch(m, q))
  );
  return { display, visibleCount: all.length };
}
