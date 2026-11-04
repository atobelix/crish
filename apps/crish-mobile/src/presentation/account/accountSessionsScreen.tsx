// 账号 v3 已登录设备：账号中心「登录会话」列表（GET /api/auth/sessions），
// 与中继远程控制设备（DeviceSheet）是两回事。版式按原型「已登录设备」页：
// 居中标题 +「受信任设备列表」分组白卡，下拉刷新。
//
// 设备描述与桌面端同构（2026-11-03 细修，用户裁决「以桌面端为真源」）：
// 行 = 类别图标（电脑 monitor / 笔记本 laptop / 手机 smartphone）+ 解析后
// 设备名（domain/pure/deviceIdentity，与桌面同一引擎：电脑「计算机名 ·
// 系统」、手机系列名、同系列多型号升级型号名），名后内联状态段——在线 =
// 绿点 +「在线」，离线 = 最近活跃月日（buildSessionDeviceRows 拼装，含
// 在线判定与 本机 → 在线 → 活跃 排序）。旧形态的「UA 原样当名字」与
// 「ip · 登录时间」副行随之退役（桌面行没有这两样）。
// 尾部一列对齐：本机标签与解绑钮共用同一尾部槽内衬（paddingHorizontal
// sm / Vertical xs），两者的字形右缘落在同一基线（旧形态本机是无内衬
// 裸文本、比解绑字形右缘多出 sm=8dp，即用户所见「不在一列」）。
//
// 与桌面的有意差异（动作而非描述）：桌面撤销是单段「退出」按钮；移动端
// 保留「解绑 / 确认解绑」两段文字链防误触（原型口径），动词亦沿用移动端
// 既有「解绑」。账号无设备改名接口 → 不放改名入口；本页也不放「扫码添加
// 新设备」——扫码配对是远程控制设备的配对流程，账号登录会话没有扫码
// 新增能力，混放即假入口。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { useAccountStore } from '@/adapters/hooks/useAccountStore';
import {
  AnimatedPressable,
  usePressFade,
} from '@/presentation/ui/pressFeedback';
import {
  listAccountSessions,
  revokeAccountSessionById,
} from '@/adapters/account/accountService';
import {
  buildSessionDeviceRows,
  type SessionDeviceKind,
  type SessionDeviceRow,
} from '@/domain/pure/accountDeviceRows';
import { formatMonthDay } from '@/domain/pure/time';
import type { AccountSessionInfo } from '@/domain/types/account';
import { AppText, Icon, type IconName } from '@/presentation/ui';
import { AuthBar, AuthPage } from './ui';

/** 在线绿点直径（原型 device-online-pip 分档 7；圆盘圆角取直径/2 实值，
 * 不用 pill/9999——圆盘口径见 theme.ts radius 注释） */
const ONLINE_DOT_SIZE = 7;

/** 类别图标（与桌面 KIND_ICON 同表；tablet 在桌面同归 smartphone） */
const KIND_ICON: Record<SessionDeviceKind, IconName> = {
  desktop: 'monitor',
  laptop: 'laptop',
  phone: 'smartphone',
  tablet: 'smartphone',
  unknown: 'monitor',
};

export interface AccountSessionsScreenProps {
  onBack: () => void;
}

export function AccountSessionsScreen({ onBack }: AccountSessionsScreenProps) {
  const theme = useTheme();
  const devices = useAccountStore((s) => s.devices);
  const [sessions, setSessions] = useState<AccountSessionInfo[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      setSessions(await listAccountSessions());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录设备加载失败');
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(
    () => buildSessionDeviceRows(sessions, devices),
    [sessions, devices]
  );

  const revoke = async (row: SessionDeviceRow) => {
    if (confirmingId !== row.sessionId) {
      setConfirmingId(row.sessionId);
      return;
    }
    setConfirmingId(null);
    try {
      await revokeAccountSessionById(row.sessionId);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '解绑失败，请稍后再试');
    }
  };

  // 尾部槽统一内衬：本机标签与解绑钮的字形右缘同基线（见文件头注）
  const trailingSlotStyle = {
    paddingVertical: theme.space.xs,
    paddingHorizontal: theme.space.sm,
  };

  return (
    <AuthPage testID="account-sessions-screen">
      <AuthBar title="已登录设备" onBack={onBack} />
      <ScrollView
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load()}
            tintColor={theme.colors.textTertiary}
          />
        }
        contentContainerStyle={{
          paddingTop: theme.space.md,
          paddingBottom: theme.space.section,
        }}
      >
        {error ? (
          <AppText
            variant="footnote"
            color="danger"
            testID="account-sessions-error"
            style={{
              paddingHorizontal: theme.space.lg + theme.space.xs,
              paddingBottom: theme.space.md,
            }}
          >
            {error}
          </AppText>
        ) : null}
        <AppText
          variant="sectionLabel"
          color="textTertiary"
          style={{
            paddingHorizontal: theme.space.lg + theme.space.xs,
            paddingBottom: theme.space.sm,
            fontWeight: '500',
          }}
        >
          受信任设备列表
        </AppText>
        <View
          style={{
            marginHorizontal: theme.space.lg,
            borderRadius: theme.radius.card,
            backgroundColor: theme.colors.surfaceGrouped,
            overflow: 'hidden',
          }}
        >
          {rows.length === 0 && !refreshing ? (
            <View
              style={{
                paddingVertical: theme.space.lg,
                paddingHorizontal: theme.space.lg,
              }}
            >
              <AppText variant="body" color="textTertiary">
                暂无登录设备记录
              </AppText>
            </View>
          ) : null}
          {rows.map((row, index) => (
            <View key={row.sessionId}>
              {index > 0 ? (
                <View
                  style={{
                    // 发丝线口径（2026-11-02 分割线裁决：更浅更细）
                    height: StyleSheet.hairlineWidth,
                    marginLeft: theme.space.lg + 28 + theme.space.md,
                    backgroundColor: theme.colors.hairline,
                  }}
                />
              ) : null}
              <View
                testID={`account-session-${row.sessionId}`}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: theme.space.md,
                  paddingVertical: theme.space.md + 2,
                  paddingHorizontal: theme.space.lg,
                }}
              >
                <View
                  style={{
                    width: 28,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Icon
                    name={KIND_ICON[row.kind]}
                    size={theme.size.iconSmall + 2}
                    color={theme.colors.textSecondary}
                  />
                </View>
                <View
                  style={{
                    flex: 1,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: theme.space.sm,
                  }}
                >
                  <AppText
                    variant="body"
                    color="textPrimary"
                    numberOfLines={1}
                    style={{ fontWeight: '500', flexShrink: 1 }}
                  >
                    {row.name || '未知设备'}
                  </AppText>
                  {row.online ? (
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: theme.space.xs,
                      }}
                    >
                      <View
                        style={{
                          width: ONLINE_DOT_SIZE,
                          height: ONLINE_DOT_SIZE,
                          borderRadius: ONLINE_DOT_SIZE / 2,
                          backgroundColor: theme.colors.success,
                        }}
                      />
                      <AppText variant="caption" color="success">
                        在线
                      </AppText>
                    </View>
                  ) : formatMonthDay(row.lastActiveAt) ? (
                    <AppText variant="caption" color="textTertiary">
                      {formatMonthDay(row.lastActiveAt)}
                    </AppText>
                  ) : null}
                </View>
                {row.current ? (
                  <View style={trailingSlotStyle}>
                    <AppText
                      variant="footnote"
                      color="success"
                      style={{ fontWeight: '500' }}
                    >
                      本机
                    </AppText>
                  </View>
                ) : (
                  <RevokeButton
                    id={row.sessionId}
                    label={row.name || '未知设备'}
                    confirming={confirmingId === row.sessionId}
                    hitSlop={theme.space.sm}
                    onPress={() => void revoke(row)}
                  />
                )}
              </View>
            </View>
          ))}
        </View>
      </ScrollView>
    </AuthPage>
  );
}

export default AccountSessionsScreen;

/** 解绑/确认解绑文字链钮（列表项内独立组件：按压 hook 不得进 map 回调）；
 * 按压整件透明度 120ms 过渡（按压过渡统一批）。内衬与本机标签的尾部槽
 * 同值（paddingVertical xs / paddingHorizontal sm），尾部一列同基线。 */
function RevokeButton({
  id,
  label,
  confirming,
  hitSlop,
  onPress,
}: {
  id: string;
  label: string;
  confirming: boolean;
  hitSlop: number;
  onPress: () => void;
}) {
  const theme = useTheme();
  const press = usePressFade();
  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={confirming ? `确认解绑 ${label}` : `解绑 ${label}`}
      testID={`account-session-revoke-${id}`}
      hitSlop={hitSlop}
      onPress={onPress}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      style={[
        {
          paddingVertical: theme.space.xs,
          paddingHorizontal: theme.space.sm,
        },
        press.fadeStyle,
      ]}
    >
      <AppText variant="footnote" color="danger" style={{ fontWeight: '500' }}>
        {confirming ? '确认解绑' : '解绑'}
      </AppText>
    </AnimatedPressable>
  );
}
