// 移动端思考链卡片：
// 用户裁决改版：纯白背景（theme.colors.surface）、固定 160dp 视口内嵌手势滚动、
// 彻底去除多余的 THINKING 标签与抽屉入口，纯净呈现思考正文。
import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View, Pressable } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
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
 * 固定高度视口内容框：纯白背景（theme.colors.surface），超限支持手指内部自由滚动
 */
export const ReasoningContentBox = memo(function ReasoningContentBox({
  text,
  isThinking = false,
  testID = 'reasoning-content-box',
}: ReasoningContentBoxProps) {
  const theme = useTheme();
  const scrollRef = useRef<ScrollView>(null);
  const lastScrollTimeRef = useRef(0);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (scrollTimerRef.current !== null) {
        clearTimeout(scrollTimerRef.current);
        scrollTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!isThinking && scrollTimerRef.current !== null) {
      clearTimeout(scrollTimerRef.current);
      scrollTimerRef.current = null;
    }
  }, [isThinking]);

  // 流式思考过程中随新内容到达自动跟随滚到底部（100ms 节流防抖，杜绝每字逐字调用原生平滑滚动导致的动画冲突）
  const handleContentSizeChange = useCallback(
    (_width: number, height: number) => {
      if (!isThinking || height <= REASONING_BOX_MAX_HEIGHT) {
        return;
      }
      const now = Date.now();
      const elapsed = now - lastScrollTimeRef.current;
      const THROTTLE_MS = 100;

      if (elapsed >= THROTTLE_MS) {
        if (scrollTimerRef.current !== null) {
          clearTimeout(scrollTimerRef.current);
          scrollTimerRef.current = null;
        }
        lastScrollTimeRef.current = now;
        scrollRef.current?.scrollToEnd({ animated: true });
      } else if (scrollTimerRef.current === null) {
        const remaining = THROTTLE_MS - elapsed;
        scrollTimerRef.current = setTimeout(() => {
          scrollTimerRef.current = null;
          lastScrollTimeRef.current = Date.now();
          scrollRef.current?.scrollToEnd({ animated: true });
        }, remaining);
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

  // 3. 状态机翻转监听：思考收口（thinking -> done）瞬间刚性折叠
  const prevThinkingRef = useRef(isThinking);
  useEffect(() => {
    if (prevThinkingRef.current && !isThinking) {
      setUserExpanded(false);
      disclosureStore?.set(blockId, false);
    }
    prevThinkingRef.current = isThinking;
  }, [isThinking, blockId, disclosureStore]);

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
    const next = !expanded;
    setUserExpanded(next);
    disclosureStore?.set(blockId, next);
    // 展开/折叠折叠区时通知时间线脱离跟随
    onToggleDisclosure?.();
  }, [expanded, blockId, disclosureStore, onToggleDisclosure]);

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

      {/* 展开态：固定高度纯白卡片视口，超长支持手指内部滑动 */}
      {expanded && (cleanText.length > 0 || isThinking) ? (
        <ReasoningContentBox
          text={text}
          isThinking={isThinking}
          testID="reasoning-content-box"
        />
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
