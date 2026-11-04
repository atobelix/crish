// 移动端统一新建会话协议原语（维度 1 根治，2026-11-04 裁决）：
// 无论是从侧边抽屉、会话顶栏还是全局快捷方式点击新建会话，
// 必须同时执行本地线程槽位重置、远端会话选中重置与路由切回主页，
// 彻底阻断历史会话上下文向新会话污染。
import { useCallback } from 'react';
import { router } from 'expo-router';
import { localChatSessionStore } from '@/domain/store/localChatSessionStore';
import { sessionStore } from '@/domain/store/sessionStore';
import { useDrawerActions } from '@/presentation/components/drawer/DrawerContext';

export interface NewConversationOptions {
  /** 是否需要同时关闭抽屉（抽屉内点击时为 true，顶栏点击无需触发抽屉动画） */
  closeDrawer?: boolean;
}

/**
 * 执行全局新建会话重置（命令式，可供任意无 React Hook 上下文直接调用）
 */
export function executeNewConversation(
  _options: NewConversationOptions = {}
): void {
  // 1. 本地对话槽位重置：将当前活动线程归入 inactive 隔离表，清空前台活跃投影
  localChatSessionStore.getState().resetActiveThread();

  // 2. 远端会话槽位重置：清除当前选中的历史会话 ID，确保 quickRun 不携带历史 sessionId
  sessionStore.getState().setSelected(null);

  // 3. 路由重置导航到主屏新会话发射台
  router.navigate('/');
}

/**
 * 响应式新建会话 Hook（供组件层消费，自动编排抽屉动画稳定性）
 */
export function useNewConversation(): (
  options?: NewConversationOptions
) => void {
  const actions = useDrawerActions();

  return useCallback(
    (options?: NewConversationOptions) => {
      // 1. 本地对话槽位重置
      localChatSessionStore.getState().resetActiveThread();

      // 2. 远端会话槽位重置
      sessionStore.getState().setSelected(null);

      // 3. 若要求关闭抽屉，调用稳定动作面收拢
      if (options?.closeDrawer) {
        actions.close();
      }

      // 4. 切回主屏
      router.navigate('/');
    },
    [actions]
  );
}

export default useNewConversation;
