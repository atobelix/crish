/**
 * SessionCoordinator — 跨 Store 会话生命周期级联协调器。
 *
 * 职责：
 * 统一收敛会话删除、清理等跨 Store 级联副作用，保证单向数据流与内存回收闭环：
 * 1. sessionStore：移除持久化会话记录与 activeSessionId 自动迁移；
 * 2. streamingStore：清空会话在途的流式文本、思考与工具状态；
 * 3. messageSnapshotsBridge：清空撤销历史与分支快照栈；
 * 4. terminalStore：清理会话关联的终端输出镜像与行缓冲区。
 */
import { useSessionStore } from './sessionStore';
import { useStreamingStore } from './streamingStore';
import { clearMessageSnapshots } from './messageSnapshotsBridge';
import { useTerminalStore } from './terminalStore';
import { getShellReadApi } from './workspace-shell/shellReadBridge';
import { clearRuntimeStatus } from './sessionRuntimeStatusStore';
import { clearWorkflowConfirmSignaturesForSession } from '../api/workflow-api/workflowConfirmSignatures';
import { cancelSessionCascade } from './sessionCascadeCancellation';

export const SessionCoordinator = {
  /**
   * 删除会话时的全系统原子级联清理
   *
   * @param sessionId 目标会话 ID
   * @returns boolean 是否成功删除了既有持久会话
   */
  deleteSessionCascade(sessionId: string): boolean {
    const id = String(sessionId || '').trim();
    if (!id) return false;

    // 首行接入三级级联取消总线（Tier 1 计算强杀 / Tier 2 流与 IPC 中止 / Tier 3 500 容量 LRU 墓碑拦截）
    cancelSessionCascade(id);

    // 0. 树上有该 session 的 tab 则摘掉（经 shell 桥，避免 Coordinator ↔ store 环）
    getShellReadApi()?.closeTabBySessionId?.(id);

    // 1. 清理 sessionStore 中的持久数据（返回是否真实命中并删除）
    const removed = useSessionStore.getState().deleteSession(id);

    // 2. 清理 streamingStore 中的内存流式缓冲
    useStreamingStore.getState().clearSession(id);

    // 3. 清理 MessageSnapshots 撤销快照栈
    clearMessageSnapshots(id);

    // 4. 清理 terminalStore 中的终端绑定与会话关联
    useTerminalStore.getState().removePtySession(id);

    // 5. 清理运行时状态机中的内存瞬态状态，杜绝内存泄漏（单轨收敛 §2.0）
    clearRuntimeStatus(id);

    // 6. §5.3：清理 WorkflowConfirm 按会话分桶的确认签名
    clearWorkflowConfirmSignaturesForSession(id);

    return removed;
  },
};

/**
 * 模块级快捷函数导出，方便跨域直接调用
 */
export function deleteSessionCascade(sessionId: string): boolean {
  return SessionCoordinator.deleteSessionCascade(sessionId);
}
