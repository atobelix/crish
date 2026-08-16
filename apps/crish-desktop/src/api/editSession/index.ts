/**
 * 编辑会话抽象（R2-a① · 统一输入流收敛战役）
 *
 * 前端唯一「编辑会话」入口：open → commit/invalidate 生命周期 + 内存事件总线。
 * 事件不进消息时间线 seq（17 审计纪律：编辑/定制状态属独立带）。
 *
 * 用法：
 * - 组件内声明持有：`openEditSession(blockId, baseRev)`
 * - 提交成功：`commitEditSession(blockId)`
 * - 外部失效（R2-b：撤回/截断/conflict）：`invalidateEditSession(objectId, reason)`
 * - 投影刷新保护：`isEditSessionOpen(blockId)` 判定
 * - 测注入独立实例：`new EditSessionRegistry()` 经组件 prop 传入
 */

export type {
  EditSessionCommitOptions,
  EditSessionCommitResult,
  EditSessionEvent,
  EditSessionInvalidateReason,
  EditSessionInvalidateResult,
  EditSessionListener,
  EditSessionOpenResult,
  EditSessionState,
} from './types';

export { EditSessionRegistry, defaultEditSessionRegistry } from './registry';

export {
  commitEditSession,
  getEditSession,
  invalidateEditSession,
  isEditSessionOpen,
  openEditSession,
  subscribeEditSession,
} from './registry';
