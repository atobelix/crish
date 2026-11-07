// 供应商连接诊断二级页（ProviderDiagnosticsView）
// 从供应商详情的一行进入：实测耗时只在这里展示，详情与列表不再出现毫秒。
// 测速沿用既有 pingProviderEndpoint（经 useProviderDetailVm.runPing）：量的是
// 向供应商发起模型列表请求（GET /models）的整段耗时——含建连、安全握手与
// 服务端组装列表——文案统一为「模型列表请求耗时」，不称网络延迟。
// 失败展示既有错误原文；本机模型没有网络端点，本页不对它开放（路由层改道）。
import { useCallback, useEffect, useRef } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';
import {
  useProviderDetailVm,
  type ProviderDetailVm,
} from '@/adapters/viewmodels/useProviderDetailVm';
import VendorLogo from '../ui/VendorLogo';
import { AppHeader, AppText, EmptyState, Icon, Screen } from '@/presentation/ui';
import {
  AnimatedPressable,
  usePressFade,
} from '@/presentation/ui/pressFeedback';

export interface ProviderDiagnosticsViewProps {
  providerId: string;
  vm?: ProviderDetailVm;
  onBack?: () => void;
}

export default function ProviderDiagnosticsView({
  providerId,
  vm: customVm,
  onBack,
}: ProviderDiagnosticsViewProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const safeBack = useSafeBack();
  const defaultVm = useProviderDetailVm(providerId);
  const vm = customVm ?? defaultVm;

  const runPress = usePressFade();

  // 进入页面自动测一次；同一供应商只自动测一次，之后由按钮手动重测。
  const autoRanForRef = useRef<string | null>(null);
  useEffect(() => {
    if (vm.provider && autoRanForRef.current !== vm.providerId) {
      autoRanForRef.current = vm.providerId;
      void vm.runPing();
    }
  }, [vm]);

  const handleBack = useCallback(() => {
    if (onBack) onBack();
    else safeBack();
  }, [onBack, safeBack]);

  const result = vm.pingResult;

  return (
    <Screen
      style={{ backgroundColor: theme.colors.canvasGrouped }}
      testID="provider-diagnostics-view"
    >
      <AppHeader title="连接诊断" onBack={handleBack} floating />

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.space.lg,
          paddingTop: insets.top + theme.size.touchLarge + theme.space.sm + 2,
          paddingBottom: insets.bottom + theme.space.xxl,
          gap: theme.space.lg,
        }}
      >
        {vm.isNotFound ? (
          <View
            style={[
              styles.card,
              {
                backgroundColor: theme.colors.surface,
                borderRadius: theme.radius.card,
              },
            ]}
          >
            <EmptyState title="未找到该供应商" />
          </View>
        ) : (
          <>
            {/* 诊断对象：供应商名称与端点（只读） */}
            <View
              style={[
                styles.card,
                styles.row,
                {
                  backgroundColor: theme.colors.surface,
                  borderRadius: theme.radius.card,
                  gap: theme.space.sm,
                },
              ]}
            >
              <VendorLogo
                vendor={vm.vendor}
                size={36}
                borderRadius={theme.radius.sm}
              />
              <View style={styles.flex}>
                <AppText variant="headline" numberOfLines={1}>
                  {vm.name || vm.providerId}
                </AppText>
                <AppText variant="mono" color="textSecondary" numberOfLines={1}>
                  {vm.baseUrl}
                </AppText>
              </View>
            </View>

            {/* 诊断结果：模型列表请求耗时 / 失败错误原文 */}
            <View
              style={[
                styles.card,
                {
                  backgroundColor: theme.colors.surface,
                  borderRadius: theme.radius.card,
                },
              ]}
            >
              <AppText
                variant="footnote"
                color="textSecondary"
                style={styles.groupHeader}
              >
                模型列表请求耗时
              </AppText>
              <AppText variant="caption" color="textTertiary">
                向供应商发起一次模型列表请求（GET
                /models）的整段耗时，包含建立连接、安全握手与服务端组装列表的时间。
              </AppText>

              {vm.pinging ? (
                <AppText
                  variant="callout"
                  color="textSecondary"
                  testID="diagnostics-running"
                >
                  正在检测…
                </AppText>
              ) : result == null ? (
                <AppText
                  variant="callout"
                  color="textTertiary"
                  testID="diagnostics-idle"
                >
                  尚未检测
                </AppText>
              ) : result.ok ? (
                <AppText
                  variant="headline"
                  testID="diagnostics-latency-value"
                >
                  {`${result.latencyMs}ms`}
                </AppText>
              ) : (
                <View testID="diagnostics-error" style={styles.errorBox}>
                  <AppText
                    variant="callout"
                    style={{ color: theme.colors.danger, fontWeight: '600' }}
                  >
                    {result.error?.message ?? '连接失败'}
                  </AppText>
                  {result.error?.detail ? (
                    <AppText variant="caption" color="textTertiary">
                      {result.error.detail}
                    </AppText>
                  ) : null}
                </View>
              )}

              <AnimatedPressable
                testID="btn-run-diagnostics"
                accessibilityRole="button"
                accessibilityLabel="开始检测"
                disabled={vm.pinging}
                onPress={() => void vm.runPing()}
                onPressIn={runPress.onPressIn}
                onPressOut={runPress.onPressOut}
                style={[
                  styles.runBtn,
                  {
                    backgroundColor: theme.colors.fillSubtle,
                    borderRadius: theme.radius.pill,
                  },
                  runPress.fadeStyle,
                ]}
              >
                <Icon
                  name="zap"
                  size={theme.size.iconSmall - 2}
                  color={theme.colors.actionPrimary}
                />
                <AppText
                  variant="footnote"
                  style={{
                    color: theme.colors.actionPrimary,
                    fontWeight: '600',
                  }}
                >
                  {vm.pinging
                    ? '检测中...'
                    : result
                      ? '重新检测'
                      : '开始检测'}
                </AppText>
              </AnimatedPressable>
            </View>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  card: { padding: 16, gap: 12 },
  groupHeader: { fontWeight: '500' },
  errorBox: { gap: 4 },
  runBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignSelf: 'flex-start',
  },
});
