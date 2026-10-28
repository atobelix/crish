// 首页状态卡（F1 §4 连接状态卡 + F03 活动任务 / F1 §5.3 待审批统计 · R4 批次3 补全）：
// - 连接行：相位标签（mapWsPhase 中文文案）+ 重连尝试次数 + 设备数（null = 未知诚实化）+
//   最后同步时间（stale 灰字语义，R2UX-05-10）+ 非就绪时「重试」入口（M4 §3.7 ConnectionBanner）；
// - 统计行：活跃 run / 待审批 / 会话数（F1 F03 / F1 §5.3），待审批 > 0 高亮可点（→ /approvals）；
// - 组件契约（M4 §2.2.2）：vm 由页面注入，组件自身不订阅 store；
// - 触控目标 ≥44（M4 §3.4），无硬编码色值（M4 §3.8 token）。
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { DashboardVm } from '@/adapters/viewmodels/useDashboardVm';
import {
  CONNECTION_PHASE_TEXT,
  selectConnectionPhaseText,
} from '@/domain/store/connectionStore';
import { useTheme } from '@/adapters/platform/theme';

export interface DashboardStatusCardProps {
  vm: DashboardVm;
  /** 重试回调（页面注入 vm.retry；测试 spy） */
  onRetry: () => void;
  /** 打开审批中心（页面注入导航；测试 spy） */
  onOpenApprovals: () => void;
}

/** 最后同步相对文案（ready 打点 → 「N 秒前同步」；null = 未同步过） */
export function lastSyncLabelOf(
  lastSyncAt: number | null,
  nowMs: number
): string | null {
  if (lastSyncAt === null) return null;
  const sec = Math.max(0, Math.floor((nowMs - lastSyncAt) / 1000));
  if (sec < 60) return `${sec} 秒前同步`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前同步`;
  return `${Math.floor(min / 60)} 小时前同步`;
}

export function DashboardStatusCard({
  vm,
  onRetry,
  onOpenApprovals,
}: DashboardStatusCardProps) {
  const theme = useTheme();
  const phaseText = selectConnectionPhaseText(vm.phase);
  const connected = vm.phase === 'ready';
  const syncLabel = lastSyncLabelOf(vm.lastSyncAt, Date.now());
  // 相位标签 + 重连尝试注记（预计算单字符串，避免 JSX 条件空串子节点）
  const phaseLabel =
    phaseText +
    (vm.attemptCount > 0 && !connected ? `（第 ${vm.attemptCount} 次）` : '');

  return (
    <View
      testID="dashboard-status-card"
      style={[styles.card, { backgroundColor: theme.bgCard }]}
    >
      {/* 连接行 */}
      <View style={styles.connectionRow}>
        <View
          testID="dashboard-connection-dot"
          style={[
            styles.dot,
            {
              backgroundColor: connected
                ? theme.colorSuccess
                : theme.colorWarning,
            },
          ]}
        />
        <Text
          testID="dashboard-connection-phase"
          style={[styles.phaseText, { color: theme.textPrimary }]}
        >
          {phaseLabel}
        </Text>
        {vm.deviceCount !== null ? (
          <Text style={[styles.metaText, { color: theme.textTertiary }]}>
            {vm.deviceCount} 台设备
          </Text>
        ) : null}
        {!connected ? (
          <Pressable
            testID="dashboard-retry"
            accessibilityRole="button"
            accessibilityLabel="重试连接"
            onPress={onRetry}
            style={({ pressed }) => [
              styles.retryBtn,
              { borderColor: theme.hairlineStrong },
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.retryText, { color: theme.colorInfo }]}>
              重试
            </Text>
          </Pressable>
        ) : null}
      </View>
      <View style={[styles.syncRow, { borderBottomColor: theme.hairline }]}>
        <Text style={[styles.metaText, { color: theme.textTertiary }]}>
          {vm.lastError !== null ? vm.lastError : (syncLabel ?? '尚未同步')}
          {vm.stale ? ' · 数据可能过期' : ''}
        </Text>
      </View>

      {/* 统计行（F1 F03 活动任务 / F1 §5.3 待审批） */}
      <View style={styles.statsRow}>
        <View style={styles.stat}>
          <Text
            testID="dashboard-stat-active-runs"
            style={[styles.statValue, { color: theme.textPrimary }]}
          >
            {vm.activeRunCount}
          </Text>
          <Text style={[styles.statLabel, { color: theme.textTertiary }]}>
            活动 run
          </Text>
        </View>
        <Pressable
          testID="dashboard-stat-approvals"
          accessibilityRole="button"
          accessibilityLabel={`待审批 ${vm.pendingApprovalCount} 项，打开审批中心`}
          onPress={onOpenApprovals}
          style={({ pressed }) => [styles.stat, pressed && styles.pressed]}
        >
          <Text
            style={[
              styles.statValue,
              {
                color:
                  vm.pendingApprovalCount > 0
                    ? theme.colorWarning
                    : theme.textPrimary,
              },
            ]}
          >
            {vm.pendingApprovalCount}
          </Text>
          <Text style={[styles.statLabel, { color: theme.textTertiary }]}>
            待审批
          </Text>
        </Pressable>
        <View style={styles.stat}>
          <Text
            testID="dashboard-stat-network"
            style={[styles.statValue, { color: theme.textPrimary }]}
          >
            {vm.network === 'live' ? '实时' : CONNECTION_PHASE_TEXT[vm.phase]}
          </Text>
          <Text style={[styles.statLabel, { color: theme.textTertiary }]}>
            事件流
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    gap: 8,
  },
  connectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 36,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  phaseText: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
  },
  metaText: {
    fontSize: 12,
  },
  syncRow: {
    minHeight: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  retryBtn: {
    minHeight: 32,
    minWidth: 56,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  retryText: {
    fontSize: 13,
    fontWeight: '500',
  },
  pressed: {
    opacity: 0.7,
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
  },
  stat: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
    minHeight: 44,
    justifyContent: 'center',
  },
  statValue: {
    fontSize: 17,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  statLabel: {
    fontSize: 11,
  },
});
