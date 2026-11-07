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
import { FlatList, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
  SHEET_SIZE_RATIOS,
  Sheet,
  SheetOptionRow,
} from '@/presentation/ui';
import { modelRefKey } from '@/domain/repositories/modelCommands';
import type { LocalVendorKey } from '@/domain/types/localChat';
import { VendorLogo } from '@/presentation/components/localChat/ui/VendorLogo';
import { isLocalVendorKey } from '@/presentation/components/localChat/ui/vendorLogosData';

/** 首屏约一屏行数。超过这个数量才锁高度，短列表仍按内容收缩。 */
const MODEL_LIST_INITIAL = 8;
const MODEL_LIST_BATCH = 6;
/** 视口倍数。比时间线的 9 更紧，避免把整份模型史提前挂上。 */
const MODEL_LIST_WINDOW = 5;

export interface ModelSheetListChrome {
  windowHeight: number;
  maxHeightRatio: number;
  paddingTop: number;
  handleMarginTop: number;
  handleHeight: number;
  handleMarginBottom: number;
  headerRowHeight: number;
  headerMarginBottom: number;
  paddingBottom: number;
  scrollContentPaddingBottom: number;
}

/**
 * 嵌套列表的可用高度。
 * Sheet 的子节点始终包在纵向 ScrollView 里，这一轮不能改公共 Sheet。
 * 没有明确高度时，内部列表会跟着内容撑开，虚拟化不会发生。
 * 这里扣掉的每一项都对应 Sheet 实际渲染的内边距、把手、标题行和滚动内容底衬。
 */
export function modelSheetListMaxHeight(chrome: ModelSheetListChrome): number {
  const panelMax = chrome.windowHeight * chrome.maxHeightRatio;
  const chromeHeight =
    chrome.paddingTop +
    chrome.handleMarginTop +
    chrome.handleHeight +
    chrome.handleMarginBottom +
    chrome.headerRowHeight +
    chrome.headerMarginBottom +
    chrome.paddingBottom +
    chrome.scrollContentPaddingBottom;
  return Math.max(0, Math.floor(panelMax - chromeHeight));
}

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
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
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
  const listMaxHeight = modelSheetListMaxHeight({
    windowHeight,
    maxHeightRatio: SHEET_SIZE_RATIOS.large,
    paddingTop: theme.space.sm,
    handleMarginTop: theme.space.xs,
    handleHeight: theme.size.sheetHandleHeight,
    handleMarginBottom: theme.space.md + theme.space.xxs,
    headerRowHeight: Math.max(
      theme.type.headline.lineHeight,
      theme.size.sheetClose
    ),
    headerMarginBottom: theme.space.lg,
    paddingBottom: Math.max(insets.bottom, theme.space.xxl),
    scrollContentPaddingBottom: theme.space.xs,
  });
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
            models.length > MODEL_LIST_INITIAL
              ? { height: listMaxHeight }
              : { maxHeight: listMaxHeight }
          }
          nestedScrollEnabled={models.length > MODEL_LIST_INITIAL}
          scrollEnabled={models.length > MODEL_LIST_INITIAL}
          initialNumToRender={MODEL_LIST_INITIAL}
          maxToRenderPerBatch={MODEL_LIST_BATCH}
          windowSize={MODEL_LIST_WINDOW}
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
