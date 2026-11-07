// 移动端模型供应商列表视图（ProvidersListView）
// 权威依据：docs/mobile-provider-architecture/analysis/01-prototype-ui-ux-spec.md 与 00-总方案.md
// 展示：活跃模型 Hero 卡片 + 已配置服务堆栈卡片 + 快速接入官方预置卡片列表
import { useCallback } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useTheme } from '@/adapters/platform/theme';
import {
  useLocalProvidersVm,
  type LocalProvidersVm,
  type LocalProviderRow,
  type PresetVendorItem,
} from '@/adapters/viewmodels/useLocalProvidersVm';
import { ON_DEVICE_PROVIDER_ID } from '@/adapters/onDevice/onDeviceProviderSync';
import {
  AnimatedPressable,
  AppHeader,
  AppText,
  EmptyState,
  Icon,
  IconButton,
  Screen,
  SectionHeader,
} from '@/presentation/ui';
import { SettingsSwitch } from '@/presentation/components/settings/SettingsSwitch';
import { VendorLogo } from '../ui/VendorLogo';

export interface ProvidersListViewProps {
  vm?: LocalProvidersVm;
  onBack?: () => void;
  onAddProvider?: () => void;
  onSelectPreset?: (presetKey: string) => void;
  onSelectProvider?: (providerId: string) => void;
  /** 端侧内置条目「本机模型」特殊行的去向（模型下载管理面） */
  onSelectOnDevice?: () => void;
  testID?: string;
}

export default function ProvidersListView({
  vm: customVm,
  onBack,
  onAddProvider,
  onSelectPreset,
  onSelectProvider,
  onSelectOnDevice,
  testID = 'providers-list-view',
}: ProvidersListViewProps) {
  const defaultVm = useLocalProvidersVm();
  const vm = customVm ?? defaultVm;
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const handleBack = useCallback(() => (onBack ? onBack() : router.back()), [onBack]);
  const handleAdd = useCallback(
    () => (onAddProvider ? onAddProvider() : router.push('/settings-local-provider-wizard')),
    [onAddProvider]
  );
  const handleSelectPreset = useCallback(
    (key: string) =>
      onSelectPreset
        ? onSelectPreset(key)
        : router.push({ pathname: '/settings-local-provider-wizard', params: { presetKey: key } }),
    [onSelectPreset]
  );
  const handleSelectProvider = useCallback(
    (id: string) =>
      onSelectProvider
        ? onSelectProvider(id)
        : router.push({ pathname: '/settings-local-provider-detail', params: { id } }),
    [onSelectProvider]
  );
  const handleSelectOnDevice = useCallback(
    () =>
      onSelectOnDevice
        ? onSelectOnDevice()
        : router.push('/settings-local-ondevice'),
    [onSelectOnDevice]
  );

  return (
    <Screen style={{ backgroundColor: theme.colors.canvasGrouped }} testID={testID}>
      <AppHeader
        title="模型供应商"
        onBack={handleBack}
        floating
        actions={
          <IconButton
            name="add"
            variant="floating"
            accessibilityLabel="添加供应商"
            onPress={handleAdd}
            testID="btn-header-add-provider"
          />
        }
      />

      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          {
            paddingTop: insets.top + theme.size.touchLarge + theme.space.sm + 2,
            paddingBottom: insets.bottom + theme.space.xxl,
            paddingHorizontal: theme.space.lg,
          },
        ]}
      >
        {/* 0. 本机模型（端侧内置条目置顶特殊行，O4）：无密钥/延迟/
            启停开关语义，点按去模型下载管理面；计数 = 已下载且校验
            在案的模型数，尚无条目（从未同步）时如实呈现未下载 */}
        <View style={styles.sectionWrap}>
          <SectionHeader title="本机模型" />
          <AnimatedPressable
            testID="ondevice-provider-card"
            style={[styles.providerCard, { backgroundColor: theme.colors.surfaceGrouped, borderRadius: theme.radius.lg }]}
            onPress={handleSelectOnDevice}
          >
            <View style={styles.providerCardInner}>
              <View style={styles.cardHeaderRow}>
                <VendorLogo vendor={vm.onDeviceRow?.vendorKey ?? 'custom'} size={36} />
                <View style={styles.cardHeaderInfo}>
                  <AppText variant="headline" numberOfLines={1} style={styles.providerNameText}>
                    本机模型
                  </AppText>
                  <AppText variant="mono" color="textTertiary" numberOfLines={1}>
                    {vm.onDeviceRow && vm.onDeviceRow.modelCount > 0
                      ? `${vm.onDeviceRow.modelCount} 个可用模型`
                      : '尚未下载模型'}
                  </AppText>
                </View>
                <Icon name="chevron-right" size={16} color={theme.colors.textTertiary} />
              </View>
            </View>
          </AnimatedPressable>
        </View>

        {/* 1. 活跃模型 Hero 卡片 */}
        {vm.activeProvider ? (
          <View style={styles.sectionWrap}>
            <SectionHeader title="当前活跃" />
            <AnimatedPressable
              testID="active-provider-hero"
              style={[styles.heroCard, { backgroundColor: theme.colors.surfaceGrouped, borderRadius: theme.radius.lg }]}
              onPress={() =>
                vm.activeProvider!.id === ON_DEVICE_PROVIDER_ID
                  ? handleSelectOnDevice()
                  : handleSelectProvider(vm.activeProvider!.id)
              }
            >
              <View style={styles.heroTopRow}>
                <View style={styles.heroStatusBadge}>
                  <View style={[styles.heroStatusDot, { backgroundColor: theme.colors.brand, borderRadius: theme.radius.pill }]} />
                  <AppText variant="footnote" color="brand" style={styles.boldText}>
                    当前使用中
                  </AppText>
                </View>
              </View>

              <View style={styles.heroMainRow}>
                <VendorLogo vendor={vm.activeProvider.vendorKey} size={42} />
                <View style={styles.heroInfoCol}>
                  <AppText variant="headline" numberOfLines={1}>
                    {vm.activeProvider.name}
                  </AppText>
                  <AppText variant="mono" color="textSecondary" numberOfLines={1}>
                    {vm.activeProvider.defaultModelName ?? vm.activeProvider.defaultModelId ?? '未选模型'}
                  </AppText>
                  <AppText variant="caption" color="textTertiary" numberOfLines={1}>
                    {vm.activeProvider.host || vm.activeProvider.baseUrl}
                  </AppText>
                </View>
                <Icon name="chevron-right" size={theme.size.iconSmall + 2} color={theme.colors.textTertiary} />
              </View>
            </AnimatedPressable>
          </View>
        ) : null}

        {/* 2. 已配置服务列表 */}
        <View style={styles.sectionWrap}>
          <SectionHeader
            title="已配置服务"
            trailing={vm.rows.length > 0 ? `${vm.rows.length} 个服务` : undefined}
          />
          {vm.rows.length === 0 ? (
            <View style={[styles.emptyBox, { backgroundColor: theme.colors.surfaceGrouped, borderRadius: theme.radius.lg }]}>
              <EmptyState title="尚未配置服务" />
            </View>
          ) : (
            <View style={styles.providerCardsStack}>
              {vm.rows.map((row: LocalProviderRow) => (
                <View
                  key={row.id}
                  testID={`provider-card-${row.id}`}
                  style={[styles.providerCard, { backgroundColor: theme.colors.surfaceGrouped, borderRadius: theme.radius.lg }]}
                >
                  <AnimatedPressable
                    testID={`provider-card-press-${row.id}`}
                    style={styles.providerCardInner}
                    onPress={() => handleSelectProvider(row.id)}
                  >
                    <View style={styles.cardHeaderRow}>
                      <VendorLogo vendor={row.vendorKey} size={36} />
                      <View style={styles.cardHeaderInfo}>
                        <View style={styles.providerNameRow}>
                          <AppText variant="headline" numberOfLines={1} style={styles.providerNameText}>
                            {row.name}
                          </AppText>
                          <View
                            style={[
                              styles.keyIndicatorDot,
                              {
                                backgroundColor: row.hasKey ? theme.colors.brand : theme.colors.warning,
                                borderRadius: theme.radius.pill,
                              },
                            ]}
                          />
                        </View>
                        <AppText variant="mono" color="textTertiary" numberOfLines={1}>
                          {row.host || row.baseUrl}
                        </AppText>
                      </View>
                    </View>

                    <View style={styles.cardFooterRow}>
                      <View style={styles.modelMetaCol}>
                        <AppText variant="mono" color="textSecondary" numberOfLines={1} style={styles.defaultModelLabel}>
                          {row.defaultModelName ?? row.defaultModelId ?? '无默认模型'}
                        </AppText>
                        <AppText variant="caption" color="textTertiary">
                          {row.modelCount} 个可用模型
                        </AppText>
                      </View>

                      <View style={styles.cardControlsRow}>
                        <View style={styles.switchTouchWrap}>
                          <SettingsSwitch
                            value={row.isActive}
                            onValueChange={() => vm.activate(row.id)}
                            testID={`switch-provider-active-${row.id}`}
                            accessibilityLabel={row.isActive ? '当前已激活' : '点击设为当前'}
                          />
                        </View>
                        <Icon name="chevron-right" size={16} color={theme.colors.textTertiary} />
                      </View>
                    </View>
                  </AnimatedPressable>
                </View>
              ))}
            </View>
          )}
        </View>

        {/* 3. 快速接入预置列表 */}
        <View style={styles.sectionWrap}>
          <SectionHeader title="快速接入预置" />
          <View style={styles.presetsList}>
            {vm.presets.map((preset: PresetVendorItem) => (
              <AnimatedPressable
                key={preset.key}
                testID={`preset-vendor-${preset.key}`}
                style={[styles.presetRow, { backgroundColor: theme.colors.surfaceGrouped, borderRadius: theme.radius.lg }]}
                onPress={() => handleSelectPreset(preset.key)}
              >
                <View style={styles.presetLeft}>
                  <VendorLogo vendor={preset.vendor} size={34} />
                  <View style={styles.presetMetaCol}>
                    <AppText variant="callout" numberOfLines={1} style={styles.boldText}>
                      {preset.name}
                    </AppText>
                    <AppText variant="mono" color="textTertiary" numberOfLines={1}>
                      {preset.host || preset.desc}
                    </AppText>
                  </View>
                </View>
                <Icon name="chevron-right" size={16} color={theme.colors.textTertiary} />
              </AnimatedPressable>
            ))}
          </View>
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scrollContent: { gap: 16 },
  sectionWrap: { gap: 8 },
  heroCard: { padding: 16, gap: 12 },
  heroTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  heroStatusBadge: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  heroStatusDot: { width: 7, height: 7 },
  boldText: { fontWeight: '600' },
  heroMainRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  heroInfoCol: { flex: 1, gap: 2, minWidth: 0 },
  emptyBox: { padding: 16 },
  providerCardsStack: { gap: 10 },
  providerCard: { overflow: 'hidden' },
  providerCardInner: { padding: 15, gap: 10 },
  cardHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  cardHeaderInfo: { flex: 1, gap: 2, minWidth: 0 },
  providerNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  providerNameText: { fontWeight: '600', flexShrink: 1 },
  keyIndicatorDot: { width: 6, height: 6, flexShrink: 0 },
  cardFooterRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 4, gap: 8 },
  modelMetaCol: { flex: 1, gap: 2, minWidth: 0 },
  defaultModelLabel: { fontWeight: '500' },
  cardControlsRow: { flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 0 },
  switchTouchWrap: { justifyContent: 'center', alignItems: 'center' },
  presetsList: { gap: 8 },
  presetRow: { paddingVertical: 12, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  presetLeft: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 },
  presetMetaCol: { flex: 1, gap: 2, minWidth: 0 },
});
