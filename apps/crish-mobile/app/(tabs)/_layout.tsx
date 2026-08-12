import { Redirect, Tabs } from 'expo-router';
import { useApprovalStore, useAuthStore } from '@/adapters/hooks/useAppStore';

// 底部五 Tab（M4 §0.2 裁决：首页/会话/审批/文件/设置）—— AuthGuard 落地层：
// 未配对 → 强制重定向配对流程（D4 §5.0）；Tab 图标（lucide）随 R2-04 引入
export default function TabsLayout() {
  const pairState = useAuthStore((s) => s.pairState);
  // 通知入口（F2 §6 / R2UX §3.5 最小实现，R2-04 任务书第 3 点）：
  // 审批 Tab 角标 = 待办总数（store 驱动，前台事件到达即时刷新；系统通知/应用内横幅
  // 属 F1 推送域 R3 范围，本轮仅做入口）
  const pendingApprovalCount = useApprovalStore((s) => s.pending.length);

  if (pairState !== 'paired') {
    return <Redirect href="/pair/welcome" />;
  }

  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: 'hsl(142,35%,42%)' }}>
      <Tabs.Screen name="index" options={{ title: '首页' }} />
      <Tabs.Screen name="sessions" options={{ title: '会话' }} />
      <Tabs.Screen
        name="approvals"
        options={{
          title: '审批',
          tabBarBadge:
            pendingApprovalCount > 0 ? pendingApprovalCount : undefined,
        }}
      />
      <Tabs.Screen name="files" options={{ title: '文件' }} />
      <Tabs.Screen name="settings" options={{ title: '设置' }} />
    </Tabs>
  );
}
