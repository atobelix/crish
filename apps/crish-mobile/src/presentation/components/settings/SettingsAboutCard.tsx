// 关于卡片（R2-06 设置页「关于」组；F6 §3.2 只读参考 + 任务书「版本/桌面连接信息」）：
// - 版本：queryPresence.engineVersion（wire 只读）；未查询到显示 —；
// - 桌面连接信息：presence.desktopOnline（在线/离线）+ authStore host/desktopId
//   （脱敏短显：desktopId 前 4 位，对齐 F6 §6.5 设备 ID 短显精神）+ getSettings
//   镜像摘要（权限模式/信任命令数，只读展示不改——F6 §8.1 手机端禁止改权限）；
// - 四态：loading（菊花）/ loaded（数据）/ error（错误文案 + 重试）/ disconnected
//   （「未连接」禁用态，任务书）；idle 不渲染细节；
// - 热区（R2-16 §3.2 第 7 项修复）：重试钮视觉 minHeight 28 → HitSlop 补足
//   （iOS 44 / Android 48 双轨）。
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { PresenceResult } from '@crish/shared-types';
import type {
  AboutStatus,
  SettingsMirror,
} from '@/adapters/viewmodels/useSettingsVm';
import { useTheme } from '@/adapters/platform/theme';
import { dualHitSlop } from '@/presentation/components/ui/hitTargets';

export interface SettingsAboutCardProps {
  status: AboutStatus;
  presence: PresenceResult | null;
  mirror: SettingsMirror | null;
  host: string | null;
  desktopId: string | null;
  onRefresh: () => void;
}

/** 桌面 Hub id 短显（前 4 位；null/空 → null，不显示） */
export function shortDesktopId(id: string | null): string | null {
  return id && id.length > 4 ? id.slice(0, 4) : id;
}

export default function SettingsAboutCard({
  status,
  presence,
  mirror,
  host,
  desktopId,
  onRefresh,
}: SettingsAboutCardProps) {
  const theme = useTheme();
  const online = presence?.desktopOnline === true;
  const desktopIdShort = shortDesktopId(desktopId);

  return (
    <View
      testID="settings-about"
      style={[
        styles.card,
        { backgroundColor: theme.bgCard, borderColor: theme.hairline },
      ]}
    >
      <View style={styles.row}>
        <Text style={[styles.label, { color: theme.textPrimary }]}>版本</Text>
        <Text style={[styles.value, { color: theme.textSecondary }]}>
          {presence?.engineVersion ?? '—'}
        </Text>
      </View>
      <View style={[styles.row, { borderTopColor: theme.hairline }]}>
        <Text style={[styles.label, { color: theme.textPrimary }]}>
          桌面连接
        </Text>
        {status === 'disconnected' ? (
          <Text style={[styles.value, { color: theme.textTertiary }]}>
            未连接
          </Text>
        ) : status === 'loading' ? (
          <ActivityIndicator size="small" color={theme.colorInfo} />
        ) : status === 'error' ? (
          <View style={styles.valueCol}>
            <Text style={[styles.value, { color: theme.colorError }]}>
              获取失败
            </Text>
            <Pressable
              testID="settings-about-refresh"
              accessibilityRole="button"
              accessibilityLabel="重试获取桌面连接信息"
              onPress={onRefresh}
              hitSlop={dualHitSlop(28)}
              style={({ pressed }) => [
                styles.retry,
                { borderColor: theme.colorError },
                pressed && { opacity: 0.7 },
              ]}
            >
              <Text style={[styles.retryText, { color: theme.colorError }]}>
                重试
              </Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.valueCol}>
            <View style={styles.statusLine}>
              <View
                testID="settings-about-status"
                style={[
                  styles.dot,
                  {
                    backgroundColor: online
                      ? theme.colorSuccess
                      : theme.textTertiary,
                  },
                ]}
              />
              <Text style={[styles.value, { color: theme.textSecondary }]}>
                {online ? '在线' : '离线'}
              </Text>
            </View>
            {host ? (
              <Text style={[styles.value, { color: theme.textTertiary }]}>
                {host}
              </Text>
            ) : null}
            {desktopIdShort ? (
              <Text style={[styles.value, { color: theme.textTertiary }]}>
                桌面 #{desktopIdShort}
              </Text>
            ) : null}
          </View>
        )}
      </View>
      {mirror &&
      (mirror.permissionMode || mirror.trustedCommandCount !== null) ? (
        <View style={[styles.row, { borderTopColor: theme.hairline }]}>
          <Text style={[styles.label, { color: theme.textPrimary }]}>
            桌面安全
          </Text>
          <Text style={[styles.value, { color: theme.textSecondary }]}>
            {mirror.permissionMode ?? '—'}
            {mirror.trustedCommandCount !== null
              ? ` · 信任 ${mirror.trustedCommandCount} 条`
              : ''}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
  },
  row: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: 6,
  },
  label: {
    fontSize: 14,
    fontWeight: '500',
  },
  value: {
    fontSize: 13,
  },
  valueCol: {
    alignItems: 'flex-end',
    gap: 2,
  },
  statusLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  retry: {
    minHeight: 28,
    borderRadius: 9999,
    borderWidth: 1,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryText: {
    fontSize: 12,
    fontWeight: '500',
  },
});
