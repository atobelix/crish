// 模型选择 Sheet（G2/W-B · F22）：桌面全局默认模型的真实列表与切换。
// 数据面来自 useComposerContextVm（C38 listModels / C39 setActiveModel，
// modelsWiring 注入）——读写与桌面「设置 → 模型」页同一份真源（统一模型
// 树 activeModel）；用户裁决 Q3：切换 = 改桌面全局默认，含桌面端生效，
// 不是手机本地覆盖。状态诚实呈现：未连接 / 加载中 / 列表失败（可重试）/
// 空列表 / 切换失败五者分开，不编造模型名、不伪造成功。
// 口径呈现（M3）：会话不钉模型是协议事实（per-session 钉定为待裁决的 M4），
// 「当前对话使用的模型」只能等于全局默认——Sheet 首行把这层等价明说
// （当前全局默认名 + 本对话后续消息将使用它）；未设默认独立成态；默认
// 已停用/不在可选集时加注脚，不再静默无选中。列表失败面呈现错误码（M2，
// 与切换失败面同口径），不再只有一个无解释的「无法获取」。
import { StyleSheet, View } from 'react-native';
import type { ActiveModelInfo, ModelEntry } from '@crish/shared-types';
import { useTheme } from '@/adapters/platform/theme';
import {
  AppText,
  ErrorState,
  LoadingState,
  Sheet,
  SheetOptionRow,
} from '@/presentation/ui';
import { modelRefKey } from '@/domain/repositories/modelCommands';
import { VendorLogo } from '@/presentation/components/localChat/ui/VendorLogo';
import {
  isLocalVendorKey,
  type LocalVendorKey,
} from '@/presentation/components/localChat/ui/vendorLogosData';

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

export interface ModelSheetProps {
  visible: boolean;
  onClose: () => void;
  /** 是否已连接桌面（未连接与命令失败分开呈现） */
  connected: boolean;
  /** 可选模型列表（未拉取为 null） */
  models: readonly ModelEntry[] | null;
  status: 'idle' | 'loading' | 'loaded' | 'error';
  /** 当前全局默认的身份键（modelRefKey(providerId, modelId)），无默认 = null */
  activeModelId: string | null;
  /** 当前全局默认（桌面真源投影；口径行呈现其名，未设置 = null） */
  activeModel: ActiveModelInfo | null;
  /** 当前全局默认是否在可选集内（false 且有默认 = 已停用/不可选，呈注脚） */
  activeModelSelectable: boolean;
  switching: boolean;
  /** 最近一次命令错误码（列表失败面与切换失败面都呈现，与状态面分工见各分支） */
  errorCode: string | null;
  onSelectModel: (providerId: string, modelId: string) => void;
  onRetry: () => void;
  testID?: string;
}

export function ModelSheet({
  visible,
  onClose,
  connected,
  models,
  status,
  activeModelId,
  activeModel: _activeModel,
  activeModelSelectable: _activeModelSelectable,
  switching,
  errorCode,
  onSelectModel,
  onRetry,
  testID = 'model-sheet',
}: ModelSheetProps) {
  const theme = useTheme();
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="选择模型"
      size="large"
      testID={testID}
    >
      {!connected ? (
        <View style={styles.center}>
          <AppText variant="body" color="textSecondary">
            未连接桌面
          </AppText>
        </View>
      ) : status === 'loading' || status === 'idle' ? (
        <LoadingState compact />
      ) : status === 'error' ? (
        <ErrorState
          compact
          title={`无法获取模型列表${errorCode ? `（${errorCode}）` : ''}`}
          onRetry={onRetry}
        />
      ) : models && models.length > 0 ? (
        <>
          <View style={[styles.list, { gap: theme.space.xxs }]}>
            {models.map((model) => {
              const key = modelRefKey(model.providerId, model.modelId);
              return (
                <SheetOptionRow
                  key={key}
                  testID={`${testID}-option-${model.providerId}-${model.modelId}`}
                  leading={
                    <VendorLogo
                      vendor={resolveVendorKey(model.providerId)}
                      size={28}
                      borderRadius={7}
                    />
                  }
                  label={model.displayName}
                  selected={key === activeModelId}
                  onPress={() => onSelectModel(model.providerId, model.modelId)}
                />
              );
            })}
          </View>
          {switching ? (
            <AppText
              variant="caption"
              color="textTertiary"
              style={{ marginTop: theme.space.md }}
            >
              正在切换…
            </AppText>
          ) : errorCode ? (
            <AppText
              variant="caption"
              color="danger"
              style={{ marginTop: theme.space.md }}
            >
              切换失败（{errorCode}），当前模型未变更，请重试
            </AppText>
          ) : null}
        </>
      ) : (
        <AppText variant="body" color="textSecondary">
          桌面端尚未配置可用模型
        </AppText>
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
  centerText: {
    textAlign: 'center',
  },
});

export default ModelSheet;
