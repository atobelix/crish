// 本地模型选择 Sheet（CON-2）：本地模式下主页模型钮的数据面。
// 选项来自 localChatStore 的本机供应商配置（与桌面模型树完全无关），
// 切换经 localChatStore.setActiveModel 落本地活动选择（本机持久化）。
// 状态诚实呈现：未配置（无供应商）/ 有供应商但无可用模型 / 正常列表
// 三者分开，不编造型号；禁用（enabled=false）的供应商与模型不出现在
// 可选列表（与 resolveActiveSelection 的可选口径一致）。
import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { useLocalChatStore } from '@/adapters/hooks/useAppStore';
import { localChatStore } from '@/domain/store/localChatStore';
import { AppText, Button, Sheet, SheetOptionRow } from '@/presentation/ui';
import type { LocalVendorKey } from '@/domain/types/localChat';
import { VendorLogo } from '@/presentation/components/localChat/ui/VendorLogo';
import { isLocalVendorKey } from '@/presentation/components/localChat/ui/vendorLogosData';

function resolveVendorKey(providerId?: string | null): LocalVendorKey {
  if (!providerId) return 'custom';
  const normalized = providerId.toLowerCase().trim();
  if (isLocalVendorKey(normalized)) return normalized;
  if (normalized.includes('openai')) return 'openai';
  if (normalized.includes('anthropic') || normalized.includes('claude'))
    return 'anthropic';
  if (normalized.includes('google') || normalized.includes('gemini'))
    return 'google';
  if (normalized.includes('deepseek')) return 'deepseek';
  if (normalized.includes('ollama')) return 'ollama';
  if (normalized.includes('siliconflow')) return 'siliconflow';
  return 'custom';
}

export interface LocalModelSheetProps {
  visible: boolean;
  onClose: () => void;
  onCloseComplete?: () => void;
  /** 未配置时的去向：打开供应商配置（设置内的本地供应商页） */
  onOpenProviders: () => void;
  testID?: string;
}

interface LocalModelOption {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
}

export function LocalModelSheet({
  visible,
  onClose,
  onCloseComplete,
  onOpenProviders,
  testID = 'local-model-sheet',
}: LocalModelSheetProps) {
  const theme = useTheme();
  const config = useLocalChatStore((s) => s.config);

  const options = useMemo<LocalModelOption[]>(() => {
    const list: LocalModelOption[] = [];
    for (const [providerId, provider] of Object.entries(config.providers)) {
      if (provider.enabled === false) continue;
      for (const model of provider.models) {
        if (model.enabled === false) continue;
        list.push({
          providerId,
          providerName: provider.displayName ?? providerId,
          modelId: model.id,
          modelName: model.displayName ?? model.id,
        });
      }
    }
    return list;
  }, [config]);

  const hasProviders = Object.keys(config.providers).length > 0;
  const active = config.activeModel;

  return (
    <Sheet
      keyboard="none"
      visible={visible}
      onClose={onClose}
      onCloseComplete={onCloseComplete}
      title="本地模型"
      size="large"
      testID={testID}
    >
      {options.length > 0 ? (
        <View style={[styles.list, { gap: theme.space.xxs }]}>
          {options.map((option) => {
            const key = `${option.providerId}::${option.modelId}`;
            return (
              <SheetOptionRow
                key={key}
                testID={`${testID}-option-${option.providerId}-${option.modelId}`}
                leading={
                  <VendorLogo
                    vendor={resolveVendorKey(option.providerId)}
                    size={28}
                    borderRadius={7}
                  />
                }
                label={option.modelName}
                selected={
                  active?.providerId === option.providerId &&
                  active?.modelId === option.modelId
                }
                onPress={() => {
                  localChatStore
                    .getState()
                    .setActiveModel(option.providerId, option.modelId);
                  onClose();
                }}
              />
            );
          })}
        </View>
      ) : (
        <View style={styles.center}>
          <AppText variant="body" color="textSecondary">
            {hasProviders ? '暂无可用模型' : '尚未配置本地供应商'}
          </AppText>
          <Button
            label="去配置供应商"
            variant="secondary"
            onPress={onOpenProviders}
          />
        </View>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  list: {
    flexDirection: 'column',
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
    gap: 12,
  },
});

export default LocalModelSheet;
