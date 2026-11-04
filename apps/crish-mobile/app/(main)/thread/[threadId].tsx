// 本地线程页路由（移动界面统一方案 §2.2 / U2）：与远端会话页
// 同处 (main) 抽屉壳内——壳内换 Slot 内容，无根栈压栈动画（主页
// 发送的「明显切换」根源即旧本地页在壳外根栈）。宿主构造本地
// 引擎 → 同一 ConversationScreen（旧本地页已在 U5 删除）。
import { useCallback, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { ConversationScreen } from '@/presentation/screens/sessionDetailScreen';
import { useLocalConversationEngine } from '@/adapters/conversation/useLocalConversationEngine';

export default function LocalThreadRoute() {
  const { threadId } = useLocalSearchParams<{ threadId: string }>();
  const id = threadId ?? '';
  // 时间线跟随态（屏幕 UI 态，宿主持有，与远端宿主同形）
  const [follow, setFollow] = useState(true);
  const handleSent = useCallback(() => {
    setFollow(true);
  }, []);
  const engine = useLocalConversationEngine(id, {
    onSendSuccess: handleSent,
  });
  return (
    <ConversationScreen
      engine={engine}
      follow={follow}
      onFollowChange={setFollow}
    />
  );
}
