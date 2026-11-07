// 移动端统一新建会话协议（2026-11-05 修订版，取代 2026-11-04"维度 1"落点）：
// 任何入口（抽屉加号 / 会话顶栏加号）= 双模槽位重置 + 回到主页新对话面。
// - 实质不变量保留：新建前必须清空本地活动线程与远端选中态，彻底阻断
//   历史会话上下文向新会话污染（主页挂载 effect 同款复位兜底）。
// - 落点反转（2026-11-05 用户裁决）：旧口径"/session/draft 草稿屏、严禁
//   踢回主页"废止——主页即唯一新对话落点，设备维度由主页 CON-2 中央派生
//   承担（连接就绪 → 远端按当前目标设备创建；否则 → 本地新线程），旧
//   draft 伪路由把"新建"硬编码成远端对话的协议断层随之删除。
// - 命令式导出已删除（无生产调用方且 _options 死参漂移，见巡检 §3.6）；
//   Hook 是唯一入口。
import { useCallback } from 'react';
import { navigateHome } from '@/presentation/navigation/useSafeBack';
import { localChatSessionStore } from '@/domain/store/localChatSessionStore';
import { sessionStore } from '@/domain/store/sessionStore';
import { useDrawerActions } from '@/presentation/components/drawer/DrawerContext';

export interface NewConversationOptions {
  /** 是否需要同时关闭抽屉（抽屉内点击时为 true，顶栏点击无需触发抽屉动画） */
  closeDrawer?: boolean;
}

/**
 * 响应式新建会话 Hook（全 App 唯一新建入口）：
 * 1. 本地对话槽位重置（当前活动线程归入 inactive，清空前台活跃投影）；
 * 2. 远端会话槽位重置（清除选中历史会话 id）；
 * 3. 按需收拢抽屉；
 * 4. 导航回主页新对话面（发送时按主页 CON-2 派生模式在当前设备上创建）。
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

      // 4. 回到主页新对话面：落点原语与返回面共用 navigateHome
      //（2026-11-07 起单一真源，见 navigation/useSafeBack）
      navigateHome();
    },
    [actions]
  );
}

export default useNewConversation;
