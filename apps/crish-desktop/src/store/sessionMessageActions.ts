/**
 * 会话消息 actions hub（从原单文件拆分为 core + tools 两个子模块）。
 *
 * 纯结构性重构（T4-11 R5）：保留 createSessionMessageActions 唯一导出与
 * 全部 action 键，import 路径不变。实现分别落在：
 * - ./sessionMessageActionsCore：消息增删 / 文本 / 思考 / 撤回 / 时间线截断 / 审批
 * - ./sessionMessageActionsTools：工具调用 / 状态 / pinned / runId / 时间线归一 / 补丁 / 缓存 / 批量审批
 */

import type {
  SessionActions,
  SessionStoreSlice,
  SessionImmerSet,
} from './sessionActions';
import { createSessionMessageActionsCore } from './sessionMessageActionsCore';
import { createSessionMessageActionsTools } from './sessionMessageActionsTools';

export function createSessionMessageActions<T extends SessionStoreSlice>(
  set: SessionImmerSet<T>
): Pick<
  SessionActions,
  | 'addMessage'
  | 'withdrawMessage'
  | 'applyTimelineTruncate'
  | 'respondToApproval'
  | 'updateMessageText'
  | 'updateMessageThinking'
  | 'addMessageToolCall'
  | 'updateMessageToolCall'
  | 'setSessionMessageStatus'
  | 'pinMessage'
  | 'unpinMessage'
  | 'setEngineLastRunId'
  | 'updateMessageTimeline'
  | 'applyToolCallPatches'
  | 'setMessageCacheMetrics'
  | 'markToolCallLocalStatus'
  | 'batchRespondToApproval'
> {
  return {
    ...createSessionMessageActionsCore(set),
    ...createSessionMessageActionsTools(set),
  };
}
