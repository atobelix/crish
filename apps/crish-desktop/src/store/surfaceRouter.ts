/**
 * Main Surface Router — 主工作区功能表面统一路由器。
 *
 * 架构目标：
 * 1. 单一真理源（SSOT）：主工作区功能表面（chat / scheduled / 未来扩展模块）的统一状态与切换中心；
 * 2. 确定性导航：消除散落在各组件内部的局部事件监听与死锁风险；
 * 3. 极简扩展：未来添加新主功能（如知识库、插件流等）只需注册对应 SurfaceId 即可即开即用。
 */

import { useLayoutStore } from './layoutStore';
import { emitUiEvent } from '../api/uiEvents';
import { getCompositionRoot } from '../app/compositionRoot';
import { clearAgentPanelFocus } from '../api/openAgentPanel';

export type MainSurfaceId = 'chat' | 'scheduled';

export interface MainSurfaceMeta {
  id: MainSurfaceId;
  title: string;
  sidebarNavKey: string;
  isSessionWorkspace: boolean;
}

export const MAIN_SURFACES: Record<MainSurfaceId, MainSurfaceMeta> = {
  chat: {
    id: 'chat',
    title: '对话',
    sidebarNavKey: 'chat',
    isSessionWorkspace: true,
  },
  scheduled: {
    id: 'scheduled',
    title: '定时任务',
    sidebarNavKey: 'scheduled',
    isSessionWorkspace: false,
  },
};

/**
 * 统一切换到指定功能表面
 */
export function navigateToSurface(surfaceId: MainSurfaceId): void {
  const current = useLayoutStore.getState().chatMainSurface;
  if (current === surfaceId) return;

  useLayoutStore.getState().setChatMainSurface(surfaceId);
  if (surfaceId === 'scheduled') {
    emitUiEvent('open-scheduled');
  } else if (surfaceId === 'chat') {
    emitUiEvent('open-chat');
  }
}

/**
 * 双向切换（如果当前处于该表面，则切回默认 chat；否则切入该表面）
 */
export function toggleSurface(surfaceId: MainSurfaceId): void {
  const current = useLayoutStore.getState().chatMainSurface;
  if (current === surfaceId) {
    navigateToSurface('chat');
  } else {
    navigateToSurface(surfaceId);
  }
}

/**
 * 导航并打开/聚焦指定会话（原子化完成：切回 chat 表面 + 聚焦会话 + 激活 Tab）
 */
export function navigateToChatSession(
  sessionId: string,
  opts?: {
    title?: string;
    workspaceKey?: string;
  }
): void {
  // 1. 确保表面切回对话
  navigateToSurface('chat');
  clearAgentPanelFocus();

  // 2. 通过 Shell 激活会话
  const root = getCompositionRoot();
  root.session.openOrFocusSession(sessionId, opts);
}

/**
 * 导航并进入新对话草稿（原子化完成：切回 chat 表面 + 打开新草稿）
 */
export function navigateToNewDraft(workspaceKey?: string): void {
  navigateToSurface('chat');
  clearAgentPanelFocus();

  const root = getCompositionRoot();
  root.shell.openNewDraftTab(workspaceKey);
}

/**
 * React Hook：响应式读取当前主功能表面
 */
export function useMainSurface(): {
  surfaceId: MainSurfaceId;
  meta: MainSurfaceMeta;
  isChat: boolean;
  isScheduled: boolean;
  navigateToSurface: typeof navigateToSurface;
  toggleSurface: typeof toggleSurface;
  navigateToChatSession: typeof navigateToChatSession;
  navigateToNewDraft: typeof navigateToNewDraft;
} {
  const surfaceId = (useLayoutStore((s) => s.chatMainSurface) ??
    'chat') as MainSurfaceId;
  const meta = MAIN_SURFACES[surfaceId] || MAIN_SURFACES.chat;

  return {
    surfaceId,
    meta,
    isChat: surfaceId === 'chat',
    isScheduled: surfaceId === 'scheduled',
    navigateToSurface,
    toggleSurface,
    navigateToChatSession,
    navigateToNewDraft,
  };
}
