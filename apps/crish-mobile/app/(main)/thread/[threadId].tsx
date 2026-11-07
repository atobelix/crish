// 本地线程页路由（移动界面统一方案 §2.2 / U2）：与远端会话页
// 同处 (main) 抽屉壳内——壳内换 Stack 内容（2026-11-05 导航语义矩阵：
// (main) 组显式 Stack + getId，同 id 去重 / 异 id 压栈）。宿主构造本地
// 引擎 → 同一 ConversationScreen（旧本地页已在 U5 删除）。
// regenerate（D-REGEN）：本地引擎具备重新生成能力（regenerateLocalThread），
// 经 ConversationScreen 的 onRegenerate 通道下发。
import { useCallback, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { ConversationScreen } from '@/presentation/screens/sessionDetailScreen';
import { useLocalConversationEngine } from '@/adapters/conversation/useLocalConversationEngine';
import { regenerateLocalThread } from '@/adapters/localChat/localChatEngine';

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
      // 重新生成（能力驱动）：引擎生成中由 canRegenerate 关闭入口；
      // 具体锚点/截断校验在 regenerateLocalThread 内诚实 no-op
      onRegenerate={(messageId) => regenerateLocalThread(id, messageId)}
      canRegenerate={!engine.busy}
    />
  );
}
