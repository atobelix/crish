// apps/crish-mobile/app/settings-web-search.tsx
// 移动端网页搜索设置中心页面（Expo Router 路由）
// 依据方案文档：docs/mobile-web-search-and-sandbox/06-分维-状态机演进与SQLite持久化及设置方案.md §5, §6
//
// 视觉规范：对齐 settings-local-providers.tsx 与 SettingsScreenView 规范
// 满足铁律：严格禁止裸 hex、禁止数字圆角、禁止原生阴影，全部取自 useTheme tokens

import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';
import { readTextFromClipboard } from '@/adapters/platform/clipboard';
import { haptics } from '@/adapters/platform/haptics';
import {
  useWebSearchSettingsVm,
  type ByokProviderMeta,
} from '@/adapters/viewmodels/useWebSearchSettingsVm';
import {
  AnimatedPressable,
  AppHeader,
  AppText,
  Button,
  Icon,
  Input,
  Screen,
  SectionHeader,
  Sheet,
} from '@/presentation/ui';
import { SettingsSwitch } from '@/presentation/components/settings/SettingsSwitch';

export default function SettingsWebSearchRoute() {
  const vm = useWebSearchSettingsVm();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const goBack = useSafeBack();

  // API Key 弹窗编辑抽屉状态
  const [editingProvider, setEditingProvider] =
    useState<ByokProviderMeta | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [savingKey, setSavingKey] = useState(false);

  // 打开 Key 录入 Sheet
  const handleOpenKeySheet = useCallback((provider: ByokProviderMeta) => {
    setEditingProvider(provider);
    // 预填已有掩码提示或空白
    setKeyDraft('');
  }, []);

  // 关闭 Key 录入 Sheet
  const handleCloseKeySheet = useCallback(() => {
    setEditingProvider(null);
    setKeyDraft('');
  }, []);

  // 从剪贴板粘贴
  const handlePasteFromClipboard = useCallback(async () => {
    haptics.selection();
    const clip = await readTextFromClipboard();
    if (clip) {
      setKeyDraft(clip.trim());
    }
  }, []);

  // 保存 Key
  const handleSaveKey = useCallback(async () => {
    if (!editingProvider) return;
    setSavingKey(true);
    try {
      haptics.tap();
      await vm.saveKey(editingProvider.id, keyDraft);
      handleCloseKeySheet();
    } finally {
      setSavingKey(false);
    }
  }, [editingProvider, keyDraft, vm, handleCloseKeySheet]);

  // 一键清空 Key
  const handleClearKey = useCallback(async () => {
    if (!editingProvider) return;
    setSavingKey(true);
    try {
      haptics.tap();
      await vm.saveKey(editingProvider.id, '');
      handleCloseKeySheet();
    } finally {
      setSavingKey(false);
    }
  }, [editingProvider, vm, handleCloseKeySheet]);

  // 连通性测试触发
  const handleCheckHealth = useCallback(
    async (providerId: string) => {
      haptics.tap();
      await vm.checkProviderHealth(providerId);
    },
    [vm]
  );

  return (
    <Screen
      style={{ backgroundColor: theme.colors.canvasGrouped }}
      testID="settings-web-search-screen"
    >
      <AppHeader title="网页搜索与工具" onBack={goBack} floating />

      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          {
            paddingTop: insets.top + theme.size.touchLarge + theme.space.sm + 2,
            paddingBottom: insets.bottom + theme.space.xxl,
            paddingHorizontal: theme.space.lg,
          },
        ]}
        testID="settings-web-search-scroll"
      >
        {/* ================= 1. 顶部全局与原生优先切换卡片 ================= */}
        <View style={styles.sectionWrap}>
          <SectionHeader title="全局开关与检索偏好" />

          <View
            style={[
              styles.cardBox,
              {
                backgroundColor: theme.colors.surfaceGrouped,
                borderRadius: theme.radius.card,
              },
            ]}
          >
            {/* 全局联网总开关 */}
            <View style={styles.cardRow}>
              <View style={styles.flex}>
                <View style={[styles.inlineRow, { gap: theme.space.xs }]}>
                  <Icon
                    name="globe"
                    size={theme.size.iconSmall}
                    color={theme.colors.brand}
                  />
                  <AppText variant="headline" style={styles.boldText}>
                    启用网页搜索
                  </AppText>
                </View>
                <AppText
                  variant="footnote"
                  color="textSecondary"
                  style={{ marginTop: theme.space.xxs }}
                >
                  总开关：开启后允许模型向互联网发起事实检索与网页信息抓取
                </AppText>
              </View>
              <SettingsSwitch
                value={vm.enabled}
                onValueChange={vm.toggleEnabled}
                testID="switch-global-search-enabled"
                accessibilityLabel="启用网页搜索"
              />
            </View>

            <View
              style={[
                styles.divider,
                { backgroundColor: theme.colors.hairline },
              ]}
            />

            {/* 原生模型优先偏好 */}
            <View style={styles.cardRow}>
              <View style={styles.flex}>
                <View style={[styles.inlineRow, { gap: theme.space.xs }]}>
                  <Icon
                    name="zap"
                    size={theme.size.iconSmall}
                    color={theme.colors.brand}
                  />
                  <AppText variant="headline" style={styles.boldText}>
                    优先使用模型内置搜索
                  </AppText>
                  <View
                    style={[
                      styles.inlineBadge,
                      {
                        backgroundColor: theme.colors.successSoft,
                        borderRadius: theme.radius.xs,
                      },
                    ]}
                  >
                    <AppText
                      variant="caption"
                      style={{
                        color: theme.colors.brandStrong,
                        fontWeight: '600',
                      }}
                    >
                      推荐
                    </AppText>
                  </View>
                </View>
                <AppText
                  variant="footnote"
                  color="textSecondary"
                  style={{ marginTop: theme.space.xxs }}
                >
                  当活动模型（如 Gemini、OpenAI、Claude
                  3.7）原生支持搜索时，优先启用官方 Grounding，不消耗自备 Key
                  且回答更流畅
                </AppText>
              </View>
              <SettingsSwitch
                value={vm.modelToolsPreferred}
                onValueChange={vm.toggleModelToolsPreferred}
                testID="switch-native-search-preferred"
                accessibilityLabel="优先使用模型内置搜索"
              />
            </View>
          </View>
        </View>

        {/* ================= 2. 商业搜索服务商 (BYOK) 卡片组 ================= */}
        <View style={styles.sectionWrap}>
          <SectionHeader
            title="商业搜索服务商 (BYOK)"
            trailing="系统安全区隔离"
          />
          <AppText
            variant="caption"
            color="textTertiary"
            style={{ marginBottom: theme.space.sm }}
          >
            自备 API Key，享受极速无拦截的专业商业搜索；密钥存入系统
            Keychain/Keystore，严禁明文入库。
          </AppText>

          <View style={{ gap: theme.space.md }}>
            {vm.availableProviders.map((provider) => {
              const isSelected = vm.selectedProvider === provider.id;
              const hasKey = Boolean(vm.keyPresence[provider.id]);
              const maskedKey = vm.getMaskedKey(provider.id);
              const isTesting = vm.testingProviderId === provider.id;
              const health = vm.healthResults[provider.id];

              return (
                <View
                  key={provider.id}
                  style={[
                    styles.providerCard,
                    {
                      backgroundColor: theme.colors.surfaceGrouped,
                      borderRadius: theme.radius.card,
                      borderWidth: isSelected ? 1.5 : 1,
                      borderColor: isSelected
                        ? theme.colors.brand
                        : theme.colors.hairline,
                    },
                  ]}
                  testID={`provider-card-${provider.id}`}
                >
                  {/* 顶部标题与单选标记 */}
                  <AnimatedPressable
                    style={styles.providerHeaderRow}
                    onPress={() => {
                      haptics.selection();
                      vm.selectProvider(provider.id);
                    }}
                    testID={`provider-select-${provider.id}`}
                    accessibilityLabel={`设为首选服务商 ${provider.name}`}
                  >
                    <View style={styles.flex}>
                      <View style={[styles.inlineRow, { gap: theme.space.xs }]}>
                        <AppText variant="headline" style={styles.boldText}>
                          {provider.name}
                        </AppText>
                        {isSelected ? (
                          <View
                            style={[
                              styles.inlineBadge,
                              {
                                backgroundColor: theme.colors.fillSubtle,
                                borderRadius: theme.radius.xs,
                              },
                            ]}
                          >
                            <AppText
                              variant="caption"
                              style={{
                                color: theme.colors.brand,
                                fontWeight: '600',
                              }}
                            >
                              首选
                            </AppText>
                          </View>
                        ) : null}
                      </View>
                      <AppText
                        variant="footnote"
                        color="textSecondary"
                        style={{ marginTop: theme.space.xxs }}
                      >
                        {provider.desc}
                      </AppText>
                    </View>

                    {/* 单选圈 */}
                    <View
                      style={[
                        styles.radioCircle,
                        {
                          borderRadius: theme.radius.pill,
                          borderColor: isSelected
                            ? theme.colors.brand
                            : theme.colors.borderStrong,
                        },
                      ]}
                    >
                      {isSelected ? (
                        <View
                          style={[
                            styles.radioInnerDot,
                            {
                              backgroundColor: theme.colors.brand,
                              borderRadius: theme.radius.pill,
                            },
                          ]}
                        />
                      ) : null}
                    </View>
                  </AnimatedPressable>

                  {/* 密钥信息行 */}
                  <View
                    style={[
                      styles.keyDisplayRow,
                      {
                        backgroundColor: theme.colors.fillSubtle,
                        borderRadius: theme.radius.sm,
                      },
                    ]}
                  >
                    <View style={styles.flex}>
                      <AppText variant="caption" color="textTertiary">
                        API Key 状态
                      </AppText>
                      {hasKey ? (
                        <AppText
                          variant="mono"
                          style={{
                            color: theme.colors.textPrimary,
                            fontWeight: '600',
                            marginTop: 2,
                          }}
                          testID={`masked-key-${provider.id}`}
                        >
                          {maskedKey}
                        </AppText>
                      ) : (
                        <AppText
                          variant="footnote"
                          color="textTertiary"
                          style={{ marginTop: 2 }}
                        >
                          未配置密钥（点击录入）
                        </AppText>
                      )}
                    </View>

                    {/* 配置 Key 按钮 */}
                    <AnimatedPressable
                      style={[
                        styles.actionPill,
                        {
                          backgroundColor: theme.colors.surfaceGrouped,
                          borderRadius: theme.radius.pill,
                        },
                      ]}
                      onPress={() => handleOpenKeySheet(provider)}
                      testID={`btn-edit-key-${provider.id}`}
                      accessibilityLabel={`配置 ${provider.name} 密钥`}
                    >
                      <Icon
                        name="settings"
                        size={theme.size.iconSmall - 2}
                        color={theme.colors.textPrimary}
                      />
                      <AppText variant="caption" style={styles.boldText}>
                        {hasKey ? '修改' : '录入'}
                      </AppText>
                    </AnimatedPressable>
                  </View>

                  {/* 底部连通性测试栏 */}
                  <View style={styles.providerFooterRow}>
                    <Button
                      label="测试连通性"
                      variant="secondary"
                      size="compact"
                      loading={isTesting}
                      disabled={isTesting}
                      onPress={() => handleCheckHealth(provider.id)}
                      testID={`btn-test-health-${provider.id}`}
                    />

                    {/* 测试结果气泡 */}
                    {health ? (
                      health.ok ? (
                        <View
                          style={[
                            styles.healthBubble,
                            {
                              backgroundColor: theme.colors.successSoft,
                              borderRadius: theme.radius.pill,
                            },
                          ]}
                          testID={`health-bubble-ok-${provider.id}`}
                        >
                          <AppText
                            variant="caption"
                            style={{
                              color: theme.colors.brandStrong,
                              fontWeight: '600',
                            }}
                          >
                            ⚡ {health.latencyMs}ms 正常
                          </AppText>
                        </View>
                      ) : (
                        <View
                          style={[
                            styles.healthBubble,
                            {
                              backgroundColor: theme.colors.dangerSoft,
                              borderRadius: theme.radius.pill,
                              maxWidth: 180,
                            },
                          ]}
                          testID={`health-bubble-fail-${provider.id}`}
                        >
                          <AppText
                            variant="caption"
                            numberOfLines={1}
                            style={{
                              color: theme.colors.danger,
                              fontWeight: '500',
                            }}
                          >
                            ❌ {health.error || '连通失败'}
                          </AppText>
                        </View>
                      )
                    ) : null}
                  </View>
                </View>
              );
            })}
          </View>
        </View>

        {/* ================= 3. 免 Key 开放引擎开关与排序列表 ================= */}
        <View style={styles.sectionWrap}>
          <SectionHeader
            title="免 Key 开放引擎（降级顺序）"
            trailing="无需配置 Key"
          />
          <AppText
            variant="caption"
            color="textTertiary"
            style={{ marginBottom: theme.space.sm }}
          >
            当商业服务商配额耗尽或未配置时，端侧自动按以下优先级降级执行免 Key
            检索。
          </AppText>

          <View
            style={[
              styles.cardBox,
              {
                backgroundColor: theme.colors.surfaceGrouped,
                borderRadius: theme.radius.card,
              },
            ]}
          >
            {vm.freeEnginesOrder.map((engineId, index) => {
              const meta = vm.availableFreeEngines.find(
                (e) => e.id === engineId
              ) ?? {
                id: engineId,
                name: engineId,
                desc: '开放免 Key 搜索引擎',
              };
              const isEnabled = vm.isFreeEngineEnabled(engineId);
              const isFirst = index === 0;
              const isLast = index === vm.freeEnginesOrder.length - 1;

              return (
                <View key={engineId}>
                  <View style={styles.freeEngineRow}>
                    {/* 排序序号 */}
                    <View
                      style={[
                        styles.orderIndexBadge,
                        {
                          backgroundColor: theme.colors.fillSubtle,
                          borderRadius: theme.radius.pill,
                        },
                      ]}
                    >
                      <AppText variant="caption" style={styles.boldText}>
                        {index + 1}
                      </AppText>
                    </View>

                    {/* 引擎名称与说明 */}
                    <View style={styles.flex}>
                      <AppText variant="headline" style={styles.boldText}>
                        {meta.name}
                      </AppText>
                      <AppText
                        variant="footnote"
                        color="textSecondary"
                        style={{ marginTop: theme.space.xxs }}
                      >
                        {meta.desc}
                      </AppText>
                    </View>

                    {/* 排序微操动作 (上移 / 下移) */}
                    <View style={[styles.inlineRow, { gap: 4 }]}>
                      <Pressable
                        disabled={isFirst}
                        onPress={() => {
                          haptics.selection();
                          vm.moveFreeEngine(index, index - 1);
                        }}
                        style={[
                          styles.reorderBtn,
                          {
                            backgroundColor: theme.colors.fillSubtle,
                            borderRadius: theme.radius.sm,
                            opacity: isFirst ? 0.3 : 1,
                          },
                        ]}
                        testID={`btn-move-up-${engineId}`}
                        accessibilityLabel={`上移 ${meta.name}`}
                      >
                        <AppText variant="caption" style={styles.boldText}>
                          上移
                        </AppText>
                      </Pressable>

                      <Pressable
                        disabled={isLast}
                        onPress={() => {
                          haptics.selection();
                          vm.moveFreeEngine(index, index + 1);
                        }}
                        style={[
                          styles.reorderBtn,
                          {
                            backgroundColor: theme.colors.fillSubtle,
                            borderRadius: theme.radius.sm,
                            opacity: isLast ? 0.3 : 1,
                          },
                        ]}
                        testID={`btn-move-down-${engineId}`}
                        accessibilityLabel={`下移 ${meta.name}`}
                      >
                        <AppText variant="caption" style={styles.boldText}>
                          下移
                        </AppText>
                      </Pressable>
                    </View>

                    {/* 独立开关 */}
                    <SettingsSwitch
                      value={isEnabled}
                      onValueChange={() => vm.toggleFreeEngine(engineId)}
                      testID={`switch-free-engine-${engineId}`}
                      accessibilityLabel={`启用 ${meta.name}`}
                    />
                  </View>

                  {!isLast ? (
                    <View
                      style={[
                        styles.divider,
                        { backgroundColor: theme.colors.hairline },
                      ]}
                    />
                  ) : null}
                </View>
              );
            })}
          </View>
        </View>

        {/* ================= 4. 网页抓取 Token 上限选项 ================= */}
        <View style={styles.sectionWrap}>
          <SectionHeader title="网页提取正文 Token 上限" />
          <AppText
            variant="caption"
            color="textTertiary"
            style={{ marginBottom: theme.space.sm }}
          >
            单篇网页正文经清洗提取至模型上下文时的最大截断上限。数值越大内容越完整，但消耗的模型上下文也越多。
          </AppText>

          <View
            style={[
              styles.tokenOptionsRow,
              {
                backgroundColor: theme.colors.surfaceGrouped,
                borderRadius: theme.radius.card,
                padding: theme.space.sm,
              },
            ]}
          >
            {vm.tokenOptions.map((tokenCount) => {
              const isSelected = vm.maxTokens === tokenCount;

              return (
                <AnimatedPressable
                  key={tokenCount}
                  onPress={() => {
                    haptics.selection();
                    vm.setMaxTokens(tokenCount);
                  }}
                  style={[
                    styles.tokenPill,
                    {
                      backgroundColor: isSelected
                        ? theme.colors.actionPrimary
                        : theme.colors.fillSubtle,
                      borderRadius: theme.radius.pill,
                    },
                  ]}
                  testID={`token-option-${tokenCount}`}
                  accessibilityLabel={`${tokenCount} Tokens`}
                >
                  <AppText
                    variant="callout"
                    style={{
                      color: isSelected
                        ? theme.colors.actionPrimaryText
                        : theme.colors.textPrimary,
                      fontWeight: isSelected ? '700' : '500',
                    }}
                  >
                    {tokenCount} Tokens
                  </AppText>
                </AnimatedPressable>
              );
            })}
          </View>
        </View>
      </ScrollView>

      {/* ================= 5. API Key 录入与编辑 Sheet ================= */}
      <Sheet
        keyboard="input"
        visible={editingProvider !== null}
        onClose={handleCloseKeySheet}
        title={editingProvider ? `配置 ${editingProvider.name} 密钥` : ''}
        size="medium"
        testID="sheet-api-key-edit"
      >
        {editingProvider ? (
          <View style={{ padding: theme.space.md, gap: theme.space.md }}>
            <AppText variant="footnote" color="textSecondary">
              API Key 存入硬件 SecureStore，支持输入单个 Key 或换行/逗号输入多个
              Key 进行自动轮询与高可用容灾。
            </AppText>

            <Input
              label="API Key"
              placeholder={editingProvider.placeholder}
              value={keyDraft}
              onChangeText={setKeyDraft}
              tone="field"
              multiline
              numberOfLines={3}
              testID="input-api-key"
            />

            {/* 剪贴板快捷动作 */}
            <View style={[styles.inlineRow, { gap: theme.space.sm }]}>
              <Button
                label="从剪贴板粘贴"
                variant="secondary"
                size="compact"
                onPress={handlePasteFromClipboard}
                testID="btn-paste-key"
              />
              <Button
                label="清空输入"
                variant="ghost"
                size="compact"
                onPress={() => setKeyDraft('')}
                testID="btn-clear-draft"
              />
            </View>

            {/* 底部保存与移除 */}
            <View
              style={[
                styles.inlineRow,
                { gap: theme.space.sm, marginTop: theme.space.md },
              ]}
            >
              <View style={styles.flex}>
                <Button
                  label="保存并更新"
                  variant="primary"
                  loading={savingKey}
                  onPress={handleSaveKey}
                  testID="btn-save-key-confirm"
                />
              </View>
              {vm.keyPresence[editingProvider.id] ? (
                <Button
                  label="移除 Key"
                  variant="danger"
                  loading={savingKey}
                  onPress={handleClearKey}
                  testID="btn-remove-key"
                />
              ) : null}
            </View>
          </View>
        ) : null}
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    gap: 20,
  },
  sectionWrap: {
    gap: 8,
  },
  cardBox: {
    overflow: 'hidden',
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    gap: 12,
  },
  providerCard: {
    padding: 16,
    gap: 12,
  },
  providerHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  keyDisplayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  providerFooterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 4,
  },
  freeEngineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    gap: 12,
  },
  orderIndexBadge: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reorderBtn: {
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  tokenOptionsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  tokenPill: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    gap: 4,
  },
  healthBubble: {
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  radioCircle: {
    width: 20,
    height: 20,
    borderWidth: 1.8,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  radioInnerDot: {
    width: 10,
    height: 10,
  },
  divider: {
    height: 1,
    marginHorizontal: 16,
  },
  inlineBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inlineRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  flex: {
    flex: 1,
  },
  boldText: {
    fontWeight: '600',
  },
});
