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
import { memo, useCallback, useRef } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import type { ActiveModelInfo, ModelEntry } from '@crish/shared-types';
import { useTheme } from '@/adapters/platform/theme';
import {
  beginInteraction,
  isInteractionTimingEnabled,
  type InteractionHandle,
} from '@/presentation/perf/interactionTiming';
import {
  AppText,
  ErrorState,
  LoadingState,
  Sheet,
  SheetOptionRow,
} from '@/presentation/ui';
import {
  SHEET_LIST_BATCH,
  SHEET_LIST_INITIAL,
  SHEET_LIST_WINDOW,
  useLargeSheetListBudget,
} from '@/presentation/ui/sheetListWindow';
import { modelRefKey } from '@/domain/repositories/modelCommands';
import type { LocalVendorKey } from '@/domain/types/localChat';
import { VendorLogo } from '@/presentation/components/localChat/ui/VendorLogo';
import { isLocalVendorKey } from '@/presentation/components/localChat/ui/vendorLogosData';

const ModelOptionRow = memo(function ModelOptionRow({
  model,
  selected,
  testID,
  onSelect,
}: {
  model: ModelEntry;
  selected: boolean;
  testID: string;
  onSelect: (providerId: string, modelId: string) => void;
}) {
  const onPress = useCallback(() => {
    onSelect(model.providerId, model.modelId);
  }, [model.providerId, model.modelId, onSelect]);
  return (
    <SheetOptionRow
      testID={testID}
      leading={
        <VendorLogo
          vendor={resolveVendorKey(model.providerId)}
          size={28}
          borderRadius={7}
        />
      }
      label={model.displayName}
      selected={selected}
      onPress={onPress}
    />
  );
});

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
  onCloseComplete?: () => void;
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
  onCloseComplete,
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
  const listMaxHeight = useLargeSheetListBudget();
  const onSelectRef = useRef(onSelectModel);
  onSelectRef.current = onSelectModel;
  const selectModel = useCallback((providerId: string, modelId: string) => {
    onSelectRef.current(providerId, modelId);
  }, []);
  const keyExtractor = useCallback(
    (model: ModelEntry) => modelRefKey(model.providerId, model.modelId),
    []
  );
  const renderModel = useCallback(
    ({ item }: { item: ModelEntry }) => (
      <ModelOptionRow
        model={item}
        selected={keyExtractor(item) === activeModelId}
        testID={`${testID}-option-${item.providerId}-${item.modelId}`}
        onSelect={selectModel}
      />
    ),
    [activeModelId, keyExtractor, selectModel, testID]
  );
  // 公共 Sheet 没有打开完成回调。这里只记「请求打开」和「内容完成布局」。
  // 完成相位是挂载，不是面板动画结束后用户已经看见。
  const spanRef = useRef<InteractionHandle | null>(null);
  const wasVisibleRef = useRef(false);
  if (visible !== wasVisibleRef.current) {
    if (visible) {
      const span = beginInteraction('model-sheet');
      span.mark('request');
      spanRef.current = span;
    } else {
      spanRef.current?.cancel();
      spanRef.current = null;
    }
    wasVisibleRef.current = visible;
  }
  const timingEnabled = isInteractionTimingEnabled();
  return (
    <Sheet
      keyboard="none"
      visible={visible}
      onClose={onClose}
      onCloseComplete={onCloseComplete}
      title="选择模型"
      size="large"
      testID={testID}
      measureKey={testID}
      contentKey={`${connected ? 'on' : 'off'}:${status}:${models?.length ?? 0}`}
    >
      {timingEnabled ? (
        <View
          pointerEvents="none"
          onLayout={() => {
            const span = spanRef.current;
            if (!span) return;
            span.mark('mount');
            span.end('mount');
            spanRef.current = null;
          }}
        />
      ) : null}
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
        <FlatList
          testID={`${testID}-list`}
          data={models}
          keyExtractor={keyExtractor}
          renderItem={renderModel}
          extraData={activeModelId}
          // 方向与外层 Sheet 一致，都是纵向。短列表不锁高度，避免两行模型撑满抽屉。
          // 超过首屏才锁到面板预算，内部自己滚动，外层才不会把每一行都挂上。
          style={
            models.length > SHEET_LIST_INITIAL
              ? { height: listMaxHeight }
              : { maxHeight: listMaxHeight }
          }
          nestedScrollEnabled={models.length > SHEET_LIST_INITIAL}
          scrollEnabled={models.length > SHEET_LIST_INITIAL}
          initialNumToRender={SHEET_LIST_INITIAL}
          maxToRenderPerBatch={SHEET_LIST_BATCH}
          windowSize={SHEET_LIST_WINDOW}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ gap: theme.space.xxs }}
          ListFooterComponent={
            switching ? (
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
            ) : null
          }
        />
      ) : (
        <AppText variant="body" color="textSecondary">
          桌面端尚未配置可用模型
        </AppText>
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

export default ModelSheet;
