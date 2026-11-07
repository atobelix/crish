// 既有供应商综合管理全量视图（ProviderDetailView）
// 权威依据：01-prototype-ui-ux-spec.md 与 00-总方案.md
// 单文件行数严格门禁 <= 450 行，UTF-8 无 BOM。
import { memo, useCallback, useState, type FC } from 'react';
import { StyleSheet, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useTheme } from '@/adapters/platform/theme';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';
import {
  readTextFromClipboard,
  sanitizeApiKeyInput,
} from '@/adapters/platform/clipboard';
import {
  useProviderDetailVm,
  type ProviderDetailVm,
  type StoredModelRowItem,
} from '@/adapters/viewmodels/useProviderDetailVm';
import VendorLogo from '../ui/VendorLogo';
import {
  DEFAULT_CANONICAL_SLOTS,
  isCapabilitySupported,
} from '../ui/ModelSelectCard';
import {
  AppHeader,
  AppText,
  Dialog,
  Icon,
  Input,
  Screen,
} from '@/presentation/ui';
import {
  AnimatedPressable,
  usePressFade,
} from '@/presentation/ui/pressFeedback';

export interface ProviderDetailViewProps {
  providerId: string;
  vm?: ProviderDetailVm;
  onBack?: () => void;
  onNavigateWizard?: (providerId: string) => void;
  onSelectModel?: (modelId: string) => void;
  /** 进入二级页「连接诊断」（实测耗时只在那里展示，详情不再放测速与毫秒） */
  onOpenDiagnostics?: (providerId: string) => void;
  onDeleted?: () => void;
}

interface StoredModelRowProps {
  readonly item: StoredModelRowItem;
  readonly isLast: boolean;
  readonly onSelect: () => void;
}

const StoredModelRow: FC<StoredModelRowProps> = memo(function StoredModelRow({
  item,
  isLast,
  onSelect,
}) {
  const theme = useTheme();
  const press = usePressFade();

  return (
    <AnimatedPressable
      testID={`stored-model-item-${item.id}`}
      accessibilityRole="button"
      accessibilityLabel={`模型 ${item.displayName ?? item.id} 规格详情`}
      onPress={onSelect}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      style={[
        styles.modelRow,
        !isLast && styles.modelRowDivider,
        { borderBottomColor: theme.colors.hairline },
        press.fadeStyle,
      ]}
    >
      <View style={styles.rowBetween}>
        <View style={[styles.row, { gap: theme.space.xs, flex: 1 }]}>
          {item.isDefault && (
            <View
              style={[
                styles.badge,
                {
                  backgroundColor: theme.colors.successSoft,
                  borderRadius: theme.radius.xs,
                },
              ]}
              testID={`model-default-badge-${item.id}`}
            >
              <AppText
                variant="caption"
                style={{ color: theme.colors.brandStrong, fontWeight: '600' }}
              >
                默认
              </AppText>
            </View>
          )}
          <AppText
            variant="callout"
            numberOfLines={1}
            style={[
              styles.flex,
              { fontWeight: '600', color: theme.colors.textPrimary },
            ]}
            testID={`model-id-${item.id}`}
          >
            {item.displayName ?? item.id}
          </AppText>
        </View>
        {item.thinking?.supported && (
          <View
            style={[
              styles.badge,
              styles.row,
              {
                gap: 2,
                backgroundColor: theme.colors.fillSubtle,
                borderRadius: theme.radius.xs,
              },
            ]}
            testID={`model-thinking-${item.id}`}
          >
            <Icon
              name="zap"
              size={theme.size.iconSmall - 4}
              color={theme.colors.textSecondary}
            />
            <AppText variant="caption" color="textSecondary">
              {item.thinkingTierText !== '关闭'
                ? `思考: ${item.thinkingTierText}`
                : '思考'}
            </AppText>
          </View>
        )}
      </View>
      <View style={[styles.row, { gap: theme.space.xs }]}>
        <View
          style={[
            styles.contextPill,
            {
              backgroundColor: theme.colors.fillSubtle,
              borderRadius: theme.radius.xs,
            },
          ]}
          testID={`model-context-${item.id}`}
        >
          <AppText variant="caption" color="textTertiary">
            {item.contextText || '默认'}
          </AppText>
        </View>
        <View
          style={styles.canonicalSlotsRow}
          testID={`model-slots-${item.id}`}
          accessibilityLabel="能力槽位"
        >
          {DEFAULT_CANONICAL_SLOTS.map((slot) => {
            const supported = isCapabilitySupported(
              slot.key,
              item.raw.modalities,
              item.thinking?.supported
            );
            return (
              <View
                key={slot.key}
                style={styles.slotBox}
                testID={`model-slot-${item.id}-${slot.key}`}
              >
                {supported ? (
                  <Icon
                    name={slot.icon}
                    size={theme.size.iconSmall - 2}
                    color={theme.colors.textSecondary}
                  />
                ) : (
                  <View style={styles.slotEmpty} />
                )}
              </View>
            );
          })}
        </View>
        <View style={styles.flex} />
        <Icon
          name="chevron-right"
          size={theme.size.iconSmall - 2}
          color={theme.colors.textTertiary}
        />
      </View>
    </AnimatedPressable>
  );
});

export default function ProviderDetailView({
  providerId,
  vm: customVm,
  onBack,
  onNavigateWizard,
  onSelectModel,
  onOpenDiagnostics,
  onDeleted,
}: ProviderDetailViewProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const safeBack = useSafeBack();
  const defaultVm = useProviderDetailVm(providerId);
  const vm = customVm ?? defaultVm;

  const [keyVisible, setKeyVisible] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const savePress = usePressFade();
  const eyePress = usePressFade();
  const pastePress = usePressFade();
  const addModelPress = usePressFade();
  const diagnosticsPress = usePressFade();
  const deletePress = usePressFade();

  const handleBack = useCallback(async () => {
    try {
      await vm.saveChanges();
    } catch {
      // 静默保存失败兜底
    }
    if (onBack) onBack();
    else safeBack();
  }, [vm, onBack, safeBack]);

  const handleSave = useCallback(async () => {
    const success = await vm.saveChanges();
    if (success) {
      if (onBack) onBack();
      else safeBack();
    }
  }, [vm, onBack, safeBack]);

  const handlePasteKey = useCallback(async () => {
    const text = await readTextFromClipboard();
    if (text) {
      vm.setApiKey(sanitizeApiKeyInput(text));
    }
  }, [vm]);

  const handleAddModel = useCallback(() => {
    if (onNavigateWizard) {
      onNavigateWizard(vm.providerId);
    } else {
      router.push({
        pathname: '/settings-local-provider-wizard',
        params: { targetProviderId: vm.providerId },
      });
    }
  }, [onNavigateWizard, vm.providerId]);

  const handleSelectModel = useCallback(
    (modelId: string) => {
      if (onSelectModel) {
        onSelectModel(modelId);
      } else {
        router.push({
          pathname: '/settings-local-model-spec',
          params: { providerId: vm.providerId, modelId },
        });
      }
    },
    [onSelectModel, vm.providerId]
  );

  const handleOpenDiagnostics = useCallback(() => {
    if (onOpenDiagnostics) {
      onOpenDiagnostics(vm.providerId);
    } else {
      router.push({
        pathname: '/settings-local-provider-diagnostics',
        params: { id: vm.providerId },
      });
    }
  }, [onOpenDiagnostics, vm.providerId]);

  const handleConfirmDelete = useCallback(async () => {
    setDeleteDialogOpen(false);
    await vm.remove();
    if (onDeleted) onDeleted();
    else if (onBack) onBack();
    else safeBack();
  }, [vm, onDeleted, onBack, safeBack]);

  return (
    <Screen style={{ backgroundColor: theme.colors.canvasGrouped }}>
      <AppHeader
        title="配置供应商"
        onBack={handleBack}
        floating
        actions={
          <AnimatedPressable
            testID="btn-save-provider"
            accessibilityRole="button"
            accessibilityLabel="保存供应商配置"
            onPress={handleSave}
            onPressIn={savePress.onPressIn}
            onPressOut={savePress.onPressOut}
            style={[
              styles.topSaveBtn,
              {
                backgroundColor: theme.colors.actionPrimary,
                borderRadius: theme.radius.pill,
              },
              savePress.fadeStyle,
            ]}
          >
            <AppText
              variant="footnote"
              style={{
                color: theme.colors.actionPrimaryText,
                fontWeight: '600',
              }}
            >
              保存
            </AppText>
          </AnimatedPressable>
        }
      />

      <KeyboardAwareScrollView
        bottomOffset={theme.space.md}
        contentContainerStyle={{
          paddingHorizontal: theme.space.lg,
          paddingTop: insets.top + theme.size.touchLarge + theme.space.sm + 2,
          paddingBottom: theme.space.section,
          gap: theme.space.lg,
        }}
        keyboardShouldPersistTaps="handled"
      >
        {/* 服务连接基础配置卡片 */}
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
            服务连接配置
          </AppText>

          <View style={[styles.row, { gap: theme.space.sm }]}>
            <VendorLogo
              vendor={vm.vendor}
              size={36}
              borderRadius={theme.radius.sm}
            />
            <View style={styles.flex}>
              <Input
                testID="provider-name-input"
                tone="field"
                value={vm.name}
                onChangeText={vm.setName}
                placeholder="供应商名称，如 DeepSeek"
                autoCapitalize="none"
              />
            </View>
          </View>

          <Input
            testID="provider-url-input"
            tone="field"
            value={vm.baseUrl}
            onChangeText={vm.setBaseUrl}
            placeholder="https://api.deepseek.com/v1"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />

          <View style={[styles.row, { gap: theme.space.xs }]}>
            <View style={styles.flex}>
              <Input
                testID="provider-key-input"
                tone="field"
                value={vm.apiKey}
                onChangeText={vm.setApiKey}
                placeholder={
                  vm.hasStoredKey
                    ? '已存入密钥，留空表示不修改'
                    : '输入 API Key (sk-...)'
                }
                secureTextEntry={!keyVisible}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
            <AnimatedPressable
              testID="btn-toggle-key-visible"
              accessibilityRole="button"
              accessibilityLabel={keyVisible ? '隐藏密钥' : '显示密钥'}
              onPress={() => setKeyVisible((v) => !v)}
              onPressIn={eyePress.onPressIn}
              onPressOut={eyePress.onPressOut}
              style={[
                styles.iconBtn,
                {
                  backgroundColor: theme.colors.fillSubtle,
                  borderRadius: theme.radius.control,
                },
                eyePress.fadeStyle,
              ]}
            >
              <Icon
                name={keyVisible ? 'eye-off' : 'eye'}
                size={theme.size.iconSmall + 2}
                color={theme.colors.textSecondary}
              />
            </AnimatedPressable>
            <AnimatedPressable
              testID="btn-paste-key"
              accessibilityRole="button"
              accessibilityLabel="从剪贴板粘贴密钥"
              onPress={handlePasteKey}
              onPressIn={pastePress.onPressIn}
              onPressOut={pastePress.onPressOut}
              style={[
                styles.iconBtn,
                {
                  backgroundColor: theme.colors.fillSubtle,
                  borderRadius: theme.radius.control,
                },
                pastePress.fadeStyle,
              ]}
            >
              <Icon
                name="copy"
                size={theme.size.iconSmall + 2}
                color={theme.colors.textSecondary}
              />
            </AnimatedPressable>
          </View>

          {vm.hasStoredKey && (
            <View style={styles.clearKeyWrap}>
              <AppText
                variant="caption"
                color="danger"
                testID="btn-clear-stored-key"
                onPress={() => void vm.clearStoredKey()}
              >
                清除已存入的密钥
              </AppText>
            </View>
          )}
        </View>

        {/* “添加新模型”首要操作按钮：纯白恒白圆角卡片按钮 */}
        <AnimatedPressable
          testID="btn-provider-add-model"
          accessibilityRole="button"
          accessibilityLabel="添加新模型"
          onPress={handleAddModel}
          onPressIn={addModelPress.onPressIn}
          onPressOut={addModelPress.onPressOut}
          style={[
            styles.addModelCard,
            {
              backgroundColor: theme.colors.surface,
              borderRadius: theme.radius.card,
            },
            addModelPress.fadeStyle,
          ]}
        >
          <View
            style={[
              styles.addIconCircle,
              {
                backgroundColor: theme.colors.successSoft,
                borderRadius: theme.radius.pill,
              },
            ]}
          >
            <Icon
              name="add"
              size={theme.size.iconSmall}
              color={theme.colors.actionPrimary}
              strokeWidth={2.4}
            />
          </View>
          <AppText
            variant="callout"
            style={{ color: theme.colors.actionPrimary, fontWeight: '600' }}
          >
            添加新模型
          </AppText>
        </AnimatedPressable>

        {/* 已存入模型卡片组 */}
        <View style={styles.modelsSection}>
          <View style={styles.groupHeaderRow}>
            <AppText
              variant="footnote"
              color="textSecondary"
              style={styles.groupHeader}
              testID="provider-model-count"
            >
              {`已存入模型 (${vm.models.length})`}
            </AppText>
          </View>

          {vm.models.length === 0 ? (
            <View
              style={[
                styles.emptyCard,
                {
                  backgroundColor: theme.colors.surface,
                  borderRadius: theme.radius.card,
                },
              ]}
            >
              <AppText variant="footnote" color="textTertiary">
                暂无已存入模型，请点击上方“添加新模型”
              </AppText>
            </View>
          ) : (
            <View
              style={[
                styles.modelsCard,
                {
                  backgroundColor: theme.colors.surface,
                  borderRadius: theme.radius.card,
                },
              ]}
            >
              {vm.models.map((item, index) => (
                <StoredModelRow
                  key={item.id}
                  item={item}
                  isLast={index === vm.models.length - 1}
                  onSelect={() => handleSelectModel(item.id)}
                />
              ))}
            </View>
          )}
        </View>

        {/* 连接诊断入口行：测速与实测耗时收敛到二级页，详情不展示毫秒 */}
        <AnimatedPressable
          testID="btn-open-diagnostics"
          accessibilityRole="button"
          accessibilityLabel="连接诊断"
          onPress={handleOpenDiagnostics}
          onPressIn={diagnosticsPress.onPressIn}
          onPressOut={diagnosticsPress.onPressOut}
          style={[
            styles.diagnosticsRow,
            {
              backgroundColor: theme.colors.surface,
              borderRadius: theme.radius.card,
            },
            diagnosticsPress.fadeStyle,
          ]}
        >
          <Icon
            name="zap"
            size={theme.size.iconSmall}
            color={theme.colors.textSecondary}
          />
          <AppText
            variant="callout"
            style={[styles.flex, { color: theme.colors.textPrimary, fontWeight: '600' }]}
          >
            连接诊断
          </AppText>
          <Icon
            name="chevron-right"
            size={theme.size.iconSmall - 2}
            color={theme.colors.textTertiary}
          />
        </AnimatedPressable>

        {/* 底部“删除此供应商”红色操作按钮 */}
        <AnimatedPressable
          testID="btn-delete-provider"
          accessibilityRole="button"
          accessibilityLabel="删除此供应商"
          onPress={() => setDeleteDialogOpen(true)}
          onPressIn={deletePress.onPressIn}
          onPressOut={deletePress.onPressOut}
          style={[
            styles.deleteBtn,
            {
              backgroundColor: theme.colors.surface,
              borderRadius: theme.radius.card,
            },
            deletePress.fadeStyle,
          ]}
        >
          <Icon
            name="trash"
            size={theme.size.iconSmall}
            color={theme.colors.danger}
          />
          <AppText
            variant="callout"
            style={{ color: theme.colors.danger, fontWeight: '600' }}
          >
            删除此供应商
          </AppText>
        </AnimatedPressable>
      </KeyboardAwareScrollView>

      {/* 删除二次确认弹窗 */}
      <Dialog
        visible={deleteDialogOpen}
        title="删除供应商"
        description={`确定要删除“${vm.name || '此供应商'}”吗？删除后旗下模型配置将被永久移除。`}
        onDismiss={() => setDeleteDialogOpen(false)}
        actions={[
          {
            label: '取消',
            variant: 'secondary',
            onPress: () => setDeleteDialogOpen(false),
            testID: 'btn-cancel-delete',
          },
          {
            label: '删除',
            variant: 'danger',
            onPress: handleConfirmDelete,
            testID: 'btn-confirm-delete',
          },
        ]}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  topSaveBtn: {
    height: 32,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  groupHeader: { paddingLeft: 4, marginBottom: 4, fontWeight: '500' },
  groupHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
    marginBottom: 6,
  },
  card: { padding: 16, gap: 12 },
  iconBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clearKeyWrap: { alignItems: 'flex-start', paddingLeft: 4 },
  addModelCard: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  addIconCircle: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modelsSection: { gap: 2 },
  diagnosticsRow: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
  },
  modelsCard: { overflow: 'hidden' },
  emptyCard: { padding: 24, alignItems: 'center', justifyContent: 'center' },
  modelRow: { paddingHorizontal: 16, paddingVertical: 12, gap: 8 },
  modelRowDivider: { borderBottomWidth: StyleSheet.hairlineWidth },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  contextPill: {
    minWidth: 44,
    paddingHorizontal: 6,
    paddingVertical: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  canonicalSlotsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    width: 96,
  },
  slotBox: {
    width: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  slotEmpty: { width: 16, height: 16, opacity: 0 },
  deleteBtn: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
});
