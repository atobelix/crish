// 会话同步错误浮层（M1 错误面 → 2026-11-02 悬浮化）：
// - 只呈对账失败一件事：「会话列表同步失败，可能不完整」+ 错误信息 + 重试钮；
// - 「正在同步…」呈现已删除（用户裁决：无差分同步零呈现，有差分直接呈新
//   内容，反复出现的同步指示是注意力噪音）；syncing/ok/idle 一律不呈现——
//   用户主动刷新的反馈走下拉刷新原生指示；
// - 呈现形态 = 悬浮面板：由主页的状态浮层容器绝对定位承载（不占布局
//   高度、内容不被顶下去），卡片几何与 ConnectionBanner 同口径；
// - 仅主页 remote 模式挂载——local 模式由 ConnectionBanner 说明连接
//   事实，避免双横幅（审计 §七）。
import { StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import type { SessionSyncStatus } from '@/domain/store/connectionStore';
import { AppText, IconButton } from '@/presentation/ui';

export interface SessionSyncBarProps {
  /** 对账状态（connectionStore 数据面投影，经 useSessionsVm 透传） */
  status: SessionSyncStatus;
  /** 对账失败的错误信息（error 态副行呈现；null 时不呈副行） */
  error: string | null;
  /** 重试（= useSessionsVm.refresh，与下拉刷新同路） */
  onRetry: () => void;
  testID?: string;
}

export function SessionSyncBar({
  status,
  error,
  onRetry,
  testID = 'session-sync-bar',
}: SessionSyncBarProps) {
  const theme = useTheme();
  if (status !== 'error') return null;
  return (
    <View
      testID={testID}
      style={[
        styles.card,
        {
          marginHorizontal: theme.space.lg,
          marginTop: theme.space.sm + 2,
          borderRadius: theme.radius.menu,
          backgroundColor: theme.colors.surface,
          paddingVertical: theme.space.sm + 2,
          paddingLeft: theme.space.lg,
          paddingRight: theme.space.md + 2,
          gap: theme.space.sm,
        },
      ]}
    >
      <View style={styles.textCol}>
        <AppText variant="caption" color="danger">
          会话列表同步失败，可能不完整
        </AppText>
        {error ? (
          <AppText variant="caption" color="textTertiary">
            {error}
          </AppText>
        ) : null}
      </View>
      <IconButton
        name="refresh"
        accessibilityLabel="重试同步会话列表"
        onPress={onRetry}
        size={theme.size.iconSmall}
        color={theme.colors.textTertiary}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center' },
  textCol: { flex: 1 },
});

export default SessionSyncBar;
