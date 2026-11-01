// 模型选择 Sheet（G2/W-B · F22）：桌面全局默认模型的真实列表与切换。
// 数据面来自 useComposerContextVm（C38 listModels / C39 setActiveModel，
// modelsWiring 注入）——读写与桌面「设置 → 模型」页同一份真源（统一模型
// 树 activeModel）；用户裁决 Q3：切换 = 改桌面全局默认，含桌面端生效，
// 不是手机本地覆盖。状态诚实呈现：未连接 / 加载中 / 列表失败（可重试）/
// 空列表 / 切换失败五者分开，不编造模型名、不伪造成功。
import { StyleSheet, View } from 'react-native';
import type { ModelEntry } from '@crish/shared-types';
import { useTheme } from '@/adapters/platform/theme';
import {
  AppText,
  Button,
  Sheet,
  SheetOptionRow,
  Spinner,
} from '@/presentation/ui';
import { modelRefKey } from '@/domain/repositories/modelCommands';

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
  switching: boolean;
  /** 最近一次命令错误码（切换失败时呈现；列表失败走 status='error' 面） */
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
  switching,
  errorCode,
  onSelectModel,
  onRetry,
  testID = 'model-sheet',
}: ModelSheetProps) {
  const theme = useTheme();
  return (
    <Sheet visible={visible} onClose={onClose} title="模型选择" testID={testID}>
      {!connected ? (
        <View style={styles.center}>
          <AppText variant="body" color="textSecondary">
            未连接桌面
          </AppText>
          <AppText
            variant="caption"
            color="textTertiary"
            style={styles.centerText}
          >
            连接桌面后可查看并切换全局默认模型
          </AppText>
        </View>
      ) : status === 'loading' || status === 'idle' ? (
        <View style={styles.center}>
          <Spinner />
        </View>
      ) : status === 'error' ? (
        <View style={styles.center}>
          <AppText variant="body" color="textSecondary">
            无法获取模型列表
          </AppText>
          <Button label="重试" variant="secondary" onPress={onRetry} />
        </View>
      ) : models && models.length > 0 ? (
        <>
          <View style={{ gap: theme.space.sm }}>
            {models.map((model) => {
              const key = modelRefKey(model.providerId, model.modelId);
              return (
                <SheetOptionRow
                  key={key}
                  testID={`${testID}-option-${model.providerId}-${model.modelId}`}
                  label={model.displayName}
                  hint={model.providerDisplayName ?? model.providerId}
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
          桌面端尚未配置可用模型，请先在桌面端「设置 → 模型」中添加并启用模型。
        </AppText>
      )}
      <AppText
        variant="caption"
        color="textTertiary"
        style={{ marginTop: theme.space.md }}
      >
        此处切换的是桌面端的全局默认模型，桌面与手机后续任务都会使用所选模型。
      </AppText>
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
  centerText: {
    textAlign: 'center',
  },
});

export default ModelSheet;
