// 本地供应商编辑（设置子页）：名称 / Base URL / API Key（安全输入）/
// 模型清单（拉取或手填）/ 默认模型 / 连通性自检 / 保存与删除。
// 密钥只在输入瞬间存在于表单状态，保存后落 SecureStore，配置仅存引用。
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import {
  AnimatedPressable,
  usePressFade,
} from '@/presentation/ui/pressFeedback';
import type { LocalProviderEditVm } from '@/adapters/viewmodels/useLocalProviderEditVm';
import type { ProviderDraftIssue } from '@/domain/types/localChat';
import {
  AppHeader,
  AppText,
  Button,
  Dialog,
  Icon,
  Input,
  Screen,
} from '@/presentation/ui';

const ISSUE_TEXT: Record<ProviderDraftIssue, string> = {
  nameEmpty: '请填写名称（或先填 Base URL）',
  baseUrlEmpty: '请填写 Base URL',
  baseUrlInvalid: 'Base URL 格式不正确（需以 http:// 或 https:// 开头）',
  modelEmpty: '请至少填写一个模型 id',
};

export interface LocalProviderEditViewProps {
  vm: LocalProviderEditVm;
  onBack: () => void;
  onSaved: () => void;
  onDelete: ((providerId: string) => Promise<void>) | null;
}

export default function LocalProviderEditView({
  vm,
  onBack,
  onSaved,
  onDelete,
}: LocalProviderEditViewProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [keyVisible, setKeyVisible] = useState(false);
  const [modelInput, setModelInput] = useState('');
  // 显隐钮 / 模型行按压反馈（按压过渡统一批）
  const eyePress = usePressFade();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const providerId = vm.providerId;
  // 本页底 = canvasGrouped，与次级按钮默认填充 fillSubtle 同值（浅色同为
  // #f9f9f9），胶囊整个隐形、只剩大号粗字与标题无异（用户点名）——本页次级
  // 动作统一以 surface 白填充呈现（与 AuthButton 次按钮白底、模型行白底同口径）
  const groupedSecondaryStyle = { backgroundColor: theme.colors.surface };

  const addModelFromInput = () => {
    const id = modelInput.trim();
    if (id === '') return;
    vm.addModel(id);
    if (vm.draft.defaultModelId === '') vm.setDefaultModelId(id);
    setModelInput('');
  };

  return (
    <Screen style={{ backgroundColor: theme.colors.canvasGrouped }}>
      <AppHeader
        title={vm.isNew ? '添加供应商' : '编辑供应商'}
        onBack={onBack}
        floating
      />
      {/* 库版键盘感知滚动：聚焦下半区字段时自动滚出并逐帧跟随键盘
          （原 RN ScrollView 无键盘 inset，resize 失效时字段滚不出来，
          键盘审计 §一 P1） */}
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
        <View style={{ gap: theme.space.sm }}>
          <FieldLabel text="名称" />
          <Input
            testID="local-provider-name"
            tone="field"
            value={vm.draft.name}
            onChangeText={vm.setName}
            placeholder="如 DeepSeek / OpenAI / 本地 Ollama"
            autoCapitalize="none"
          />
          <FieldLabel text="Base URL" />
          <Input
            testID="local-provider-base-url"
            tone="field"
            value={vm.draft.baseUrl}
            onChangeText={vm.setBaseUrl}
            placeholder="https://api.deepseek.com/v1"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <FieldLabel text="API Key" />
          <View style={styles.keyRow}>
            <View style={styles.flex}>
              <Input
                testID="local-provider-api-key"
                tone="field"
                value={vm.draft.apiKey}
                onChangeText={vm.setApiKey}
                placeholder={vm.hasStoredKey ? '已保存（留空不修改）' : 'sk-…'}
                secureTextEntry={!keyVisible}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
            <AnimatedPressable
              accessibilityRole="button"
              accessibilityLabel={keyVisible ? '隐藏密钥' : '显示密钥'}
              onPress={() => setKeyVisible((v) => !v)}
              onPressIn={eyePress.onPressIn}
              onPressOut={eyePress.onPressOut}
              style={[styles.eyeButton, eyePress.fadeStyle]}
            >
              <Icon
                name={keyVisible ? 'eye-off' : 'eye'}
                size={theme.size.iconSmall + 2}
                color={theme.colors.textSecondary}
              />
            </AnimatedPressable>
          </View>
          {vm.hasStoredKey && !vm.isNew ? (
            <AppText
              variant="footnote"
              color="danger"
              onPress={() => void vm.clearStoredKey()}
            >
              清除已保存的密钥
            </AppText>
          ) : null}
        </View>

        <View style={{ gap: theme.space.sm }}>
          <FieldLabel text="模型" />
          {vm.draft.modelIds.map((id) => (
            <ModelRow
              key={id}
              id={id}
              isDefault={vm.draft.defaultModelId === id}
              onPress={() => vm.setDefaultModelId(id)}
              onRemove={() => vm.removeModel(id)}
            />
          ))}
          <View style={styles.keyRow}>
            <View style={styles.flex}>
              <Input
                testID="local-model-input"
                tone="field"
                value={modelInput}
                onChangeText={setModelInput}
                placeholder="手动输入模型 id，如 deepseek-chat"
                autoCapitalize="none"
                autoCorrect={false}
                onSubmitEditing={addModelFromInput}
              />
            </View>
            <Button
              label="添加"
              variant="secondary"
              style={groupedSecondaryStyle}
              onPress={addModelFromInput}
              testID="local-model-add"
            />
          </View>
          <Button
            label={vm.fetchingModels ? '拉取中…' : '从供应商拉取模型列表'}
            variant="secondary"
            style={groupedSecondaryStyle}
            disabled={vm.fetchingModels || vm.draft.baseUrl.trim() === ''}
            onPress={() => void vm.fetchModels()}
            testID="local-provider-fetch-models"
          />
          {vm.fetchError ? (
            <AppText variant="footnote" color="danger">
              {vm.fetchError.message}
              {vm.fetchError.detail ? `（${vm.fetchError.detail}）` : ''}
            </AppText>
          ) : null}
        </View>

        <View style={{ gap: theme.space.sm }}>
          <Button
            label={vm.checking ? '检查中…' : '连通性检查'}
            variant="secondary"
            style={groupedSecondaryStyle}
            testID="local-provider-check-connectivity"
            disabled={
              vm.checking ||
              vm.draft.baseUrl.trim() === '' ||
              (vm.draft.defaultModelId.trim() === '' &&
                vm.draft.modelIds.length === 0)
            }
            onPress={() => void vm.checkConnectivity()}
          />
          {vm.checkResult ? (
            vm.checkResult.ok ? (
              <AppText variant="footnote" color="brand">
                连接正常（{vm.checkResult.latencyMs} ms）：鉴权与模型可用。
              </AppText>
            ) : (
              <AppText variant="footnote" color="danger">
                {vm.checkResult.error?.message}
                {vm.checkResult.error?.detail
                  ? `（${vm.checkResult.error.detail}）`
                  : ''}
              </AppText>
            )
          ) : null}
        </View>

        {vm.issues.length > 0 ? (
          <View style={{ gap: theme.space.xs }}>
            {vm.issues.map((issue) => (
              <AppText key={issue} variant="footnote" color="danger">
                {ISSUE_TEXT[issue]}
              </AppText>
            ))}
          </View>
        ) : null}

        <Button
          label={vm.saved ? '已保存' : '保存'}
          disabled={!vm.canSave}
          onPress={() => {
            void vm.save().then((ok) => {
              if (ok) onSaved();
            });
          }}
          testID="local-provider-save"
        />

        {!vm.isNew && onDelete && providerId !== null ? (
          <Button
            label="删除供应商"
            variant="danger"
            onPress={() => setDeleteOpen(true)}
            testID="local-provider-delete"
          />
        ) : null}
      </KeyboardAwareScrollView>

      <Dialog
        visible={deleteOpen}
        title="删除供应商？"
        description="将同时删除本机保存的 API Key，此操作不可恢复。"
        onDismiss={() => setDeleteOpen(false)}
        actions={[
          {
            label: '取消',
            variant: 'secondary',
            onPress: () => setDeleteOpen(false),
          },
          {
            label: '删除',
            variant: 'danger',
            onPress: () => {
              setDeleteOpen(false);
              if (providerId !== null) {
                void onDelete?.(providerId).then(() => onSaved());
              }
            },
          },
        ]}
      />
    </Screen>
  );
}

function FieldLabel({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <AppText
      variant="sectionLabel"
      color="textTertiary"
      style={{
        // 与账号表单 AuthField 标签同口径：内衬 xs、字重 500（盒上标签层级）
        paddingHorizontal: theme.space.xs,
        fontWeight: '500',
      }}
    >
      {text}
    </AppText>
  );
}

const styles = StyleSheet.create({
  keyRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  eyeButton: { padding: 6 },
  modelRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  flex: { flex: 1 },
});

/** 模型行（列表项内独立组件：按压 hook 不得进 map 回调）；行内「移除」为
 * 文字链（AppText onPress），整体行按压走透明度过渡 */
function ModelRow({
  id,
  isDefault,
  onPress,
  onRemove,
}: {
  id: string;
  isDefault: boolean;
  onPress: () => void;
  onRemove: () => void;
}) {
  const theme = useTheme();
  const press = usePressFade();
  return (
    <AnimatedPressable
      testID={`local-model-${id}`}
      accessibilityRole="button"
      accessibilityLabel={`${id}${isDefault ? '，默认模型' : ''}`}
      onPress={onPress}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      style={[
        styles.modelRow,
        {
          borderRadius: theme.radius.menu,
          backgroundColor: theme.colors.surfaceGrouped,
          paddingHorizontal: theme.space.md,
          paddingVertical: theme.space.sm + 2,
        },
        press.fadeStyle,
      ]}
    >
      <Icon
        name={isDefault ? 'check' : 'add'}
        size={theme.size.iconSmall}
        color={isDefault ? theme.colors.brand : theme.colors.textTertiary}
      />
      <AppText variant="body" style={styles.flex}>
        {id}
      </AppText>
      {isDefault ? (
        <AppText variant="caption" color="brand">
          默认
        </AppText>
      ) : null}
      <AppText variant="footnote" color="textTertiary" onPress={onRemove}>
        移除
      </AppText>
    </AnimatedPressable>
  );
}
