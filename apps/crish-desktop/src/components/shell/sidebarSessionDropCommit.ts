import type { SessionTabDropTarget } from './sessionTabDropCommit';
import { useWorkspaceShellStore } from '../../store/storeAccess';

/**
 * 侧栏会话拖入右侧工作区落点提交器（支持直接分屏或在顶栏任意位置自由插入）。
 * 独立模块：解耦顶栏内部 Tab 树操作与侧栏跨域打开/分屏协调器。
 */
export function commitSidebarSessionDrop(input: {
  sessionId: string;
  target: SessionTabDropTarget;
}): void {
  const { sessionId, target } = input;
  if (!sessionId) return;

  const shell = useWorkspaceShellStore.getState();

  if (target.kind === 'strip') {
    shell.openOrFocusSession(sessionId, {
      activeLeafId: target.targetLeafId,
      insertIdx: target.insertIdx,
    });
    return;
  }

  if (target.region === 'center') {
    shell.openOrFocusSession(sessionId, {
      activeLeafId: target.targetLeafId,
    });
    return;
  }

  shell.splitSessionFromSidebar(sessionId, target.targetLeafId, target.region);
}
