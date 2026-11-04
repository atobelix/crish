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

export interface LocalModelSheetProps {
  visible: boolean;
  onClose: () => void;
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
      visible={visible}
      onClose={onClose}
      title="本地模型"
      size="large"
      testID={testID}
    >
      {options.length > 0 ? (
        <View style={{ gap: theme.space.sm }}>
          {options.map((option) => {
            const key = `${option.providerId}::${option.modelId}`;
            return (
              <SheetOptionRow
                key={key}
                testID={`${testID}-option-${option.providerId}-${option.modelId}`}
                label={option.modelName}
                hint={option.providerName}
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
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
    gap: 12,
  },
});

export default LocalModelSheet;
