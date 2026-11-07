// 移动端思考链卡片：
// 用户裁决改版：纯白背景（theme.colors.surface）、固定 160dp 视口内嵌手势滚动、
// 彻底去除多余的 THINKING 标签与抽屉入口，纯净呈现思考正文。
// R9 连续收拢：流式跟随由内容尺寸事件驱动（瞬时落底，无定时器、无 animated
// 重启）；思考收口时卡片高度从实测值连续收到 0（UI 线程），负 delta 由
// 时间线滚动仲裁器逐帧消化，不再刚性卸载造成时间线跳变。
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@/adapters/platform/theme';
import { useReducedMotion } from '@/adapters/platform/useReducedMotion';
import { AppText, Icon } from '@/presentation/ui';
import { useMinResidencyText } from './useActivityLabel';

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
  onOpenDrawer?: () => void;
  testID?: string;
}

/**
 * 固定高度视口内容框：纯白背景（theme.colors.surface），超限支持手指内部自由滚动。
 * R9：流式跟随由内容尺寸事件驱动——增长即一次瞬时落底（animated: false，
 * 不反复启动 animated 滚动，无定时器抢滚动）；用户拖动立即取消跟随，
 * 上滑阅读不抢读，回到底部自动恢复跟随。
 */
export const ReasoningContentBox = memo(function ReasoningContentBox({
  text,
  isThinking = false,
  testID = 'reasoning-content-box',
}: ReasoningContentBoxProps) {
  const theme = useTheme();
  const scrollRef = useRef<ScrollView>(null);
  // 内部跟随态：真 = 流式增长时瞬时落底；拖动/上滑阅读即取消
  const innerFollowRef = useRef(true);

  const handleScroll = useCallback((event: { nativeEvent: { contentSize: { height: number }; contentOffset: { y: number }; layoutMeasurement: { height: number } } }) => {
    const { contentSize, contentOffset, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom =
      contentSize.height - contentOffset.y - layoutMeasurement.height;
    // 瞬时落底回读时距离≈0，保持跟随；用户上滑超过阈值即脱离
    innerFollowRef.current = distanceFromBottom < 40;
  }, []);

  const handleScrollBeginDrag = useCallback(() => {
    // 用户拖动立即取消跟随（阅读历史不抢读）
    innerFollowRef.current = false;
  }, []);

  const handleContentSizeChange = useCallback(
    (_width: number, height: number) => {
      if (!isThinking || height <= REASONING_BOX_MAX_HEIGHT) {
        return;
      }
      if (!innerFollowRef.current) {
        return;
      }
      // 一次瞬时落底：无动画重启冲突、无定时器
      scrollRef.current?.scrollToEnd({ animated: false });
    },
    [isThinking]
  );

  return (
    <View
      testID={testID}
      style={[
        styles.boxContainer,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.hairline,
          borderRadius: theme.radius.control,
          maxHeight: REASONING_BOX_MAX_HEIGHT,
        },
      ]}
    >
      <ScrollView
        ref={scrollRef}
        nestedScrollEnabled={true}
        overScrollMode="never"
        bounces={false}
        scrollEnabled={true}
        scrollEventThrottle={16}
        onScroll={handleScroll}
        onScrollBeginDrag={handleScrollBeginDrag}
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
    </View>
  );
});

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
 * 包含状态机管理（思考中默认展开、思考完成默认折叠）、紧凑状态行与固定高度纯白卡片视口
 */
export const ReasoningCard = memo(function ReasoningCard({
  block,
  text: propText,
  isThinking: propIsThinking,
  status: propStatus,
  streaming: _propStreaming,
  durationMs: propDurationMs,
  disclosureStore,
  onToggleDisclosure,
  onOpenDrawer: _onOpenDrawer,
  onCloseDrawer: _onCloseDrawer,
  drawerVisible: _propDrawerVisible,
  initialExpanded,
  minResidencyMs,
  testID = 'reasoning-card',
}: ReasoningCardProps) {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();

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

  // 2. 展开折叠状态管理
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

  // R9 连续收拢状态：实测高度 → 0（UI 线程 withTiming），收完卸载
  const [collapsing, setCollapsing] = useState(false);
  const collapseHeight = useSharedValue(-1); // -1 = 不约束高度（auto）
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const measuredBoxHeightRef = useRef(0);

  useEffect(() => {
    return () => {
      if (collapseTimerRef.current !== null) {
        clearTimeout(collapseTimerRef.current);
        collapseTimerRef.current = null;
      }
    };
  }, []);

  const finishCollapse = useCallback(() => {
    collapseTimerRef.current = null;
    collapseHeight.value = -1;
    setCollapsing(false);
    setUserExpanded(false);
  }, [collapseHeight]);

  // 3. 状态机翻转监听：思考收口（thinking -> done）高度连续收拢。
  // expanded 渲染期镜像：effect 里拿到的是翻转后的展开态（false），
  // 收拢判定必须用「上一渲染」（思考中展开）的值。
  const expandedMirrorRef = useRef(expanded);
  const expandedAtPrevRender = expandedMirrorRef.current;
  expandedMirrorRef.current = expanded;
  const prevThinkingRef = useRef(isThinking);
  useEffect(() => {
    if (prevThinkingRef.current && !isThinking) {
      prevThinkingRef.current = isThinking;
      // 披露表照常记录收折（未来重挂以收折态呈现）
      disclosureStore?.set(blockId, false);
      const measured = measuredBoxHeightRef.current;
      if (expandedAtPrevRender && !reducedMotion && measured > 0) {
        // 高度连续收拢：实测高度 → 0，负 delta 由时间线仲裁器逐帧消化，
        // 结束高度与正式回复无缝衔接（不再刚性卸载跳变）
        collapseHeight.value = measured;
        collapseHeight.value = withTiming(0, {
          duration: theme.motion.duration.drawer,
        });
        // 收拢期钉住展开态（expanded 不随 status 翻转提前卸载内容框）
        setUserExpanded(true);
        setCollapsing(true);
        if (collapseTimerRef.current !== null) {
          clearTimeout(collapseTimerRef.current);
        }
        // JS 侧同步计时收尾（与 UI 线程动画同.duration；动画回调不依赖）
        collapseTimerRef.current = setTimeout(
          finishCollapse,
          theme.motion.duration.drawer
        );
        return;
      }
      setUserExpanded(false);
      return;
    }
    prevThinkingRef.current = isThinking;
  }, [
    isThinking,
    blockId,
    disclosureStore,
    expandedAtPrevRender,
    reducedMotion,
    collapseHeight,
    finishCollapse,
    theme.motion.duration.drawer,
  ]);

  const collapseAnimatedStyle = useAnimatedStyle(() => {
    if (collapseHeight.value < 0) {
      return { overflow: 'hidden' as const };
    }
    return { height: collapseHeight.value, overflow: 'hidden' as const };
  });

  // 4. 状态行文案排版与严格非空守门
  const cleanText = text.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();

  // 严格非空守门：收口落定后若无实际思考文字，绝对不渲染空壳卡片
  if (cleanText === '' && !isThinking) {
    return null;
  }

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
          : cleanText.length > 0
            ? `思考过程 (${cleanText.length} 字)`
            : '已思考';

  const label = useMinResidencyText(rawLabel, isThinking, minResidencyMs);

  // 5. 交互处理
  const toggle = useCallback(() => {
    if (collapsing) {
      // R9 中断：收拢途中点胶囊 → 取消收拢回到展开态
      if (collapseTimerRef.current !== null) {
        clearTimeout(collapseTimerRef.current);
        collapseTimerRef.current = null;
      }
      cancelAnimation(collapseHeight);
      collapseHeight.value = -1;
      setCollapsing(false);
      setUserExpanded(true);
      disclosureStore?.set(blockId, true);
      return;
    }
    const next = !expanded;
    setUserExpanded(next);
    disclosureStore?.set(blockId, next);
    // 展开/折叠折叠区时通知时间线脱离跟随
    onToggleDisclosure?.();
  }, [expanded, collapsing, collapseHeight, blockId, disclosureStore, onToggleDisclosure]);

  return (
    <View
      testID={testID}
      style={[styles.cardContainer, expanded && styles.cardContainerExpanded]}
    >
      {/* 极轻量单行微胶囊（高度约 26dp），轻点内联展开，默认不抢占主阅读流 */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={toggle}
        style={[
          styles.microPill,
          {
            backgroundColor: theme.colors.fillSubtle,
            borderColor: theme.colors.hairline,
            borderRadius: theme.radius.pill,
          },
        ]}
        testID="reasoning-header"
      >
        <Icon name="terminal" size={11} color={theme.colors.textTertiary} />
        <AppText
          variant="caption"
          color="textTertiary"
          style={styles.pillLabel}
          testID="reasoning-header-label"
        >
          {label}
        </AppText>
        <Icon
          name={expanded ? 'chevron-down' : 'chevron-right'}
          size={11}
          color={theme.colors.textTertiary}
        />
      </Pressable>

      {/* 展开态：固定高度纯白卡片视口，超长支持手指内部滑动。
          R9 收拢期：实测高度→0 的动画容器承载（时间线负 delta 连续消化） */}
      {expanded && (cleanText.length > 0 || isThinking) ? (
        <Animated.View
          testID="reasoning-collapse-wrapper"
          style={collapseAnimatedStyle}
          onLayout={(event: LayoutChangeEvent) => {
            measuredBoxHeightRef.current = event.nativeEvent.layout.height;
          }}
        >
          <ReasoningContentBox
            text={text}
            isThinking={isThinking}
            testID="reasoning-content-box"
          />
        </Animated.View>
      ) : null}
    </View>
  );
});

export default ReasoningCard;

const styles = StyleSheet.create({
  cardContainer: {
    alignSelf: 'flex-start',
    marginVertical: 3,
    maxWidth: '100%',
  },
  cardContainerExpanded: {
    alignSelf: 'stretch',
    width: '100%',
  },
  microPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    minHeight: 26,
    paddingHorizontal: 9,
    paddingVertical: 3.5,
    borderWidth: StyleSheet.hairlineWidth,
  },
  pillLabel: {},
  boxContainer: {
    borderWidth: 1,
    overflow: 'hidden',
    marginTop: 6,
    position: 'relative',
  },
  scrollArea: {
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  reasoningText: {},
});
