// 本地供应商编辑（设置子页）：名称 / Base URL / API Key（安全输入）/
// 模型清单（拉取或手填）/ 默认模型 / 连通性自检 / 保存与删除。
// 密钥只在输入瞬间存在于表单状态，保存后落 SecureStore，配置仅存引用。
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
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
  const [deleteOpen, setDeleteOpen] = useState(false);
  const providerId = vm.providerId;

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
      <ScrollView
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
            value={vm.draft.name}
            onChangeText={vm.setName}
            placeholder="如 DeepSeek / OpenAI / 本地 Ollama"
            autoCapitalize="none"
          />
          <FieldLabel text="Base URL" />
          <Input
            testID="local-provider-base-url"
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
                value={vm.draft.apiKey}
                onChangeText={vm.setApiKey}
                placeholder={vm.hasStoredKey ? '已保存（留空不修改）' : 'sk-…'}
                secureTextEntry={!keyVisible}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={keyVisible ? '隐藏密钥' : '显示密钥'}
              onPress={() => setKeyVisible((v) => !v)}
              style={styles.eyeButton}
            >
              <Icon
                name={keyVisible ? 'eye-off' : 'eye'}
                size={theme.size.iconSmall + 2}
                color={theme.colors.textSecondary}
              />
            </Pressable>
          </View>
          <AppText variant="caption" color="textTertiary">
            密钥保存在本机安全存储中，不会同步到电脑或其他设备。
          </AppText>
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
          {vm.draft.modelIds.map((id) => {
            const isDefault = vm.draft.defaultModelId === id;
            return (
              <Pressable
                key={id}
                testID={`local-model-${id}`}
                accessibilityRole="button"
                accessibilityLabel={`${id}${isDefault ? '，默认模型' : ''}`}
                onPress={() => vm.setDefaultModelId(id)}
                style={[
                  styles.modelRow,
                  {
                    borderRadius: theme.radius.menu,
                    backgroundColor: theme.colors.surfaceGrouped,
                    paddingHorizontal: theme.space.md,
                    paddingVertical: theme.space.sm + 2,
                  },
                ]}
              >
                <Icon
                  name={isDefault ? 'check' : 'add'}
                  size={theme.size.iconSmall}
                  color={
                    isDefault ? theme.colors.brand : theme.colors.textTertiary
                  }
                />
                <AppText variant="body" style={styles.flex}>
                  {id}
                </AppText>
                {isDefault ? (
                  <AppText variant="caption" color="brand">
                    默认
                  </AppText>
                ) : null}
                <AppText
                  variant="footnote"
                  color="textTertiary"
                  onPress={() => vm.removeModel(id)}
                >
                  移除
                </AppText>
              </Pressable>
            );
          })}
          <View style={styles.keyRow}>
            <View style={styles.flex}>
              <Input
                testID="local-model-input"
                value={modelInput}
                onChangeText={setModelInput}
                placeholder="手动输入模型 id，如 deepseek-chat"
                autoCapitalize="none"
                autoCorrect={false}
                onSubmitEditing={addModelFromInput}
              />
            </View>
            <Button label="添加" variant="ghost" onPress={addModelFromInput} />
          </View>
          <Button
            label={vm.fetchingModels ? '拉取中…' : '从供应商拉取模型列表'}
            variant="secondary"
            disabled={vm.fetchingModels || vm.draft.baseUrl.trim() === ''}
            onPress={() => void vm.fetchModels()}
          />
          {vm.fetchError ? (
            <AppText variant="footnote" color="danger">
              {vm.fetchError.message}
              {vm.fetchError.detail ? `（${vm.fetchError.detail}）` : ''}
            </AppText>
          ) : null}
          <AppText variant="caption" color="textTertiary">
            点按模型行设为默认；拉取失败不影响手填。
          </AppText>
        </View>

        <View style={{ gap: theme.space.sm }}>
          <Button
            label={vm.checking ? '检查中…' : '连通性检查'}
            variant="secondary"
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
      </ScrollView>

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
  return (
    <AppText variant="sectionLabel" color="textTertiary">
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
