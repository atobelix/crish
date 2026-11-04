// 移动端思考链卡片：
// 支持实时深度思考流式呈现、固定 160dp 视口内嵌滚动、思考完成默认折叠、
// 点击卡片呼出沉浸式大视口抽屉，以及仿代码块沙盒质感与偏浅文字阶梯。
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { AppText, Icon } from '@/presentation/ui';
import { useMinResidencyText } from './useActivityLabel';
import { ReasoningSheet } from './ReasoningSheet';

/** 思考链卡片视口最大高度限制 (160dp) */
export const REASONING_CARD_MAX_HEIGHT = 160;
export const REASONING_BOX_MAX_HEIGHT = 160;

export interface ReasoningBlockData {
  id?: string;
  kind?: string;
  text: string;
  streaming?: boolean;
  isThinking?: boolean;
  status?: 'thinking' | 'done';
  durationMs?: number;
  atMs?: number;
}

export interface ReasoningContentBoxProps {
  text: string;
  isThinking?: boolean;
  onOpenDrawer: () => void;
  testID?: string;
}

/**
 * 固定高度视口内容框：仿代码块底板质感，超限内部滚动，支持手势点击唤起抽屉
 */
export function ReasoningContentBox({
  text,
  isThinking = false,
  onOpenDrawer,
  testID = 'reasoning-content-box',
}: ReasoningContentBoxProps) {
  const theme = useTheme();
  const scrollRef = useRef<ScrollView>(null);

  // 流式思考过程中随新内容到达自动跟随滚到底部
  const handleContentSizeChange = useCallback(
    (_width: number, height: number) => {
      if (isThinking && height > REASONING_BOX_MAX_HEIGHT) {
        scrollRef.current?.scrollToEnd({ animated: true });
      }
    },
    [isThinking]
  );

  return (
    <View
      testID={testID}
      style={[
        styles.boxContainer,
        {
          backgroundColor: theme.colors.canvasDrawer,
          borderColor: theme.colors.hairline,
          borderRadius: theme.radius.control,
          maxHeight: REASONING_BOX_MAX_HEIGHT,
        },
      ]}
    >
      {/* 顶部工具栏：标识与放大进入抽屉按钮 */}
      <View style={styles.topToolbar} testID="reasoning-box-toolbar">
        <View style={styles.toolbarLeft}>
          <AppText
            variant="caption"
            color="textTertiary"
            style={[styles.monoLabel, theme.type.mono]}
          >
            THINKING
          </AppText>
          {text.trim().length > 0 ? (
            <AppText
              variant="caption"
              color="textTertiary"
              style={styles.toolbarWordCount}
            >
              {text.trim().length} 字
            </AppText>
          ) : null}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="放大至抽屉查看全部"
          hitSlop={8}
          onPress={onOpenDrawer}
          style={styles.maximizeButton}
          testID="reasoning-drawer-btn"
        >
          <AppText
            variant="caption"
            color="textTertiary"
            style={styles.maximizeButtonText}
          >
            查看全部 ↗
          </AppText>
        </Pressable>
      </View>

      {/* 核心滚动区域：轻触区域唤起抽屉，拖拽区域滚动 */}
      <Pressable
        onPress={onOpenDrawer}
        style={styles.scrollWrapper}
        accessibilityRole="button"
        accessibilityLabel="点击打开思考抽屉"
        testID="reasoning-card-pressable"
      >
        <ScrollView
          ref={scrollRef}
          nestedScrollEnabled={true}
          overScrollMode="never"
          bounces={false}
          scrollEnabled={true}
          scrollEventThrottle={16}
          onContentSizeChange={handleContentSizeChange}
          showsVerticalScrollIndicator={true}
          style={styles.scrollArea}
          testID="reasoning-scroll-view"
        >
          <AppText
            variant="footnote"
            color="textSecondary"
            style={[styles.reasoningText, theme.type.mono]}
            testID="reasoning-text"
          >
            {text}
          </AppText>
        </ScrollView>
      </Pressable>

      {/* 底部遮罩提示：超出区域或触底前的引导指示条 */}
      <Pressable
        onPress={onOpenDrawer}
        accessibilityRole="button"
        accessibilityLabel="点击展开完整思考"
        testID="reasoning-expand-sheet-bar"
        style={[
          styles.bottomHintBar,
          {
            backgroundColor: theme.colors.canvasDrawer,
            borderBottomLeftRadius: theme.radius.control,
            borderBottomRightRadius: theme.radius.control,
          },
        ]}
      >
        <AppText
          variant="caption"
          color="textTertiary"
          style={styles.bottomHintText}
        >
          点击卡片展开思考抽屉
        </AppText>
        <Icon name="chevron-down" size={11} color={theme.colors.textTertiary} />
      </Pressable>
    </View>
  );
}

export interface ReasoningCardProps {
  block?: ReasoningBlockData;
  text?: string;
  isThinking?: boolean;
  status?: 'thinking' | 'done';
  streaming?: boolean;
  durationMs?: number;
  disclosureStore?: Map<string, boolean>;
  onToggleDisclosure?: () => void;
  onOpenDrawer?: () => void;
  onCloseDrawer?: () => void;
  drawerVisible?: boolean;
  initialExpanded?: boolean;
  minResidencyMs?: number;
  testID?: string;
}

/**
 * 思考链完整卡片：
 * 包含状态机管理（思考中默认展开、思考完成默认折叠）、紧凑状态行、固定高度沙盒与大视口抽屉
 */
export function ReasoningCard({
  block,
  text: propText,
  isThinking: propIsThinking,
  status: propStatus,
  streaming: _propStreaming,
  durationMs: propDurationMs,
  disclosureStore,
  onToggleDisclosure,
  onOpenDrawer,
  onCloseDrawer,
  drawerVisible: propDrawerVisible,
  initialExpanded,
  minResidencyMs,
  testID = 'reasoning-card',
}: ReasoningCardProps) {
  const theme = useTheme();

  // 1. 数据规整与状态裁决
  const text = propText ?? block?.text ?? '';
  const status = propStatus ?? block?.status;
  const isThinking =
    status === 'thinking'
      ? true
      : status === 'done'
        ? false
        : propIsThinking !== undefined
          ? propIsThinking
          : (block?.isThinking ?? false);

  const durationMs = propDurationMs ?? block?.durationMs;
  const blockId = block?.id ?? 'reasoning-card-item';

  // 2. 抽屉显示状态
  const [internalDrawerOpen, setInternalDrawerOpen] = useState(false);
  const isDrawerOpen =
    propDrawerVisible !== undefined ? propDrawerVisible : internalDrawerOpen;

  // 3. 展开折叠状态管理
  // 铁律：思考中且显式 status='thinking' 时按独立卡片视口展开；在时间线流式期（或思考收口后）默认收折为单行状态栏
  const [userExpanded, setUserExpanded] = useState<boolean | null>(() => {
    if (disclosureStore && blockId && disclosureStore.has(blockId)) {
      return disclosureStore.get(blockId) ?? null;
    }
    if (initialExpanded !== undefined) {
      return initialExpanded;
    }
    return null;
  });

  const expanded = userExpanded !== null ? userExpanded : status === 'thinking';

  // 4. 状态机翻转监听：思考收口（thinking -> done）瞬间刚性折叠
  const prevThinkingRef = useRef(isThinking);
  useEffect(() => {
    if (prevThinkingRef.current && !isThinking) {
      setUserExpanded(false);
      disclosureStore?.set(blockId, false);
    }
    prevThinkingRef.current = isThinking;
  }, [isThinking, blockId, disclosureStore]);

  // 5. 状态行文案排版
  const seconds =
    durationMs !== undefined && durationMs > 0
      ? Math.max(1, Math.round(durationMs / 1000))
      : null;

  const rawLabel =
    status === 'thinking'
      ? '正在深度思考...'
      : isThinking
        ? '正在思考...'
        : seconds !== null
          ? status === 'done'
            ? `已深度思考 ${seconds} 秒`
            : `已思考 ${seconds} 秒`
          : text.trim().length > 0
            ? `思考过程 (${text.trim().length} 字)`
            : '已思考';

  const label = useMinResidencyText(rawLabel, isThinking, minResidencyMs);

  // 6. 交互处理
  const toggle = useCallback(() => {
    const next = !expanded;
    setUserExpanded(next);
    disclosureStore?.set(blockId, next);
    // ⑰ 规范：展开/折叠折叠区时通知时间线脱离跟随
    onToggleDisclosure?.();
  }, [expanded, blockId, disclosureStore, onToggleDisclosure]);

  const handleOpenDrawer = useCallback(() => {
    setInternalDrawerOpen(true);
    onOpenDrawer?.();
    // ⑰ 规范：打开抽屉阅读同样脱离跟随
    onToggleDisclosure?.();
  }, [onOpenDrawer, onToggleDisclosure]);

  const handleCloseDrawer = useCallback(() => {
    setInternalDrawerOpen(false);
    onCloseDrawer?.();
  }, [onCloseDrawer]);

  return (
    <View testID={testID} style={styles.cardContainer}>
      {/* 紧凑状态行：折叠/展开触发头 */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={toggle}
        style={[styles.headerRow, { paddingVertical: 6, paddingHorizontal: 4 }]}
        testID="reasoning-header"
      >
        <View style={styles.headerLeft}>
          <Icon name="terminal" size={12} color={theme.colors.textTertiary} />
          <AppText
            variant="caption"
            color="textTertiary"
            style={styles.headerLabel}
            testID="reasoning-header-label"
          >
            {label}
          </AppText>
        </View>
        <Icon
          name={expanded ? 'chevron-down' : 'chevron-right'}
          size={12}
          color={theme.colors.textTertiary}
        />
      </Pressable>

      {/* 展开态：固定高度、区域滚动、仿代码块卡片 */}
      {expanded && (text.length > 0 || isThinking) ? (
        <ReasoningContentBox
          text={text}
          isThinking={isThinking}
          onOpenDrawer={handleOpenDrawer}
          testID="reasoning-content-box"
        />
      ) : null}

      {/* 沉浸式大视口抽屉 */}
      <ReasoningSheet
        visible={isDrawerOpen}
        onClose={handleCloseDrawer}
        text={text}
        durationMs={durationMs}
        testID="reasoning-sheet"
      />
    </View>
  );
}

export default ReasoningCard;

const styles = StyleSheet.create({
  cardContainer: {
    marginVertical: 4,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  headerLabel: {},
  boxContainer: {
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    marginTop: 6,
    position: 'relative',
  },
  topToolbar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 4,
  },
  toolbarLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  monoLabel: {
    letterSpacing: 0.8,
    fontWeight: '600',
    opacity: 0.75,
  },
  toolbarWordCount: {
    opacity: 0.65,
  },
  maximizeButton: {
    paddingVertical: 2,
    paddingHorizontal: 6,
  },
  maximizeButtonText: {},
  scrollWrapper: {
    flexShrink: 1,
  },
  scrollArea: {
    paddingHorizontal: 12,
    paddingBottom: 10,
    paddingTop: 4,
  },
  reasoningText: {},
  bottomHintBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(0,0,0,0.05)',
  },
  bottomHintText: {},
});
