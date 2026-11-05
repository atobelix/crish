// 网页搜索来源微胶囊卡片（WebSourceCard）：
// 32px 高度紧凑微胶囊，遵循 theme.radius.pill 与 theme.colors.surfaceGrouped。
// 包含 14px 站点微图标（支持加载失败回退域名首字母或 globe 矢量图标），
// 域名与标题水平单行截断展示，联动高亮时提供 200ms 柔和呼吸微混动画。
import { useEffect, useState } from 'react';
import {
  Image,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@/adapters/platform/theme';
import { AppText, Icon } from '@/presentation/ui';
import { usePressFade } from '@/presentation/ui/pressFeedback';
import type { WebSearchSource } from '@crish/shared-types';

export interface WebSourceCardProps {
  /** 网页搜索单条来源数据 */
  source: WebSearchSource;
  /** 1-based 序号或角标标号（如 1 对应 [1]） */
  index?: number;
  /** 是否处于正文角标或时间线联动高亮态 */
  highlighted?: boolean;
  /** 点击卡片回调 */
  onPress?: (source: WebSearchSource) => void;
  /** 自定义外层样式 */
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** 规范化域名展示（剔除协议与 www 前缀） */
export function extractCleanDomain(domainOrUrl?: string): string {
  if (!domainOrUrl) return '';
  let cleaned = domainOrUrl.trim();
  if (/^https?:\/\//i.test(cleaned)) {
    try {
      cleaned = new URL(cleaned).hostname;
    } catch {
      cleaned = cleaned.replace(/^https?:\/\//i, '').split('/')[0] || cleaned;
    }
  }
  return cleaned.replace(/^www\./i, '');
}

/** 站点标识图标（优先 Favicon，失败/缺失回退域名首字母或 Globe 图标） */
function FaviconOrInitial({
  faviconUrl,
  domain,
}: {
  faviconUrl?: string | undefined;
  domain?: string | undefined;
}) {
  const theme = useTheme();
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    setLoadError(false);
  }, [faviconUrl]);

  if (faviconUrl && !loadError) {
    return (
      <Image
        source={{ uri: faviconUrl }}
        onError={() => setLoadError(true)}
        style={styles.faviconImage}
        testID="web-source-favicon-image"
      />
    );
  }

  const cleanDomain = extractCleanDomain(domain);
  const initial = cleanDomain.charAt(0).toUpperCase();

  if (initial && /^[A-Z0-9]$/.test(initial)) {
    return (
      <View
        style={[
          styles.initialContainer,
          {
            backgroundColor: theme.colors.fillSubtle,
            borderColor: theme.colors.hairline,
          },
        ]}
        testID="web-source-favicon-initial"
      >
        <AppText
          variant="caption"
          color="textSecondary"
          style={styles.initialText}
        >
          {initial}
        </AppText>
      </View>
    );
  }

  return (
    <View style={styles.globeContainer} testID="web-source-favicon-globe">
      <Icon name="globe" size={14} color={theme.colors.textTertiary} />
    </View>
  );
}

export function WebSourceCard({
  source,
  index,
  highlighted = false,
  onPress,
  style,
  testID,
}: WebSourceCardProps) {
  const theme = useTheme();
  const press = usePressFade();

  // 200ms 柔和呼吸高亮动效
  const highlightProgress = useSharedValue(highlighted ? 1 : 0);

  useEffect(() => {
    highlightProgress.value = withTiming(highlighted ? 1 : 0, {
      duration: 200,
    });
  }, [highlighted, highlightProgress]);

  const animatedHighlightOverlayStyle = useAnimatedStyle(() => ({
    opacity: highlightProgress.value,
  }));

  const cleanDomain = extractCleanDomain(source.domain || source.url);
  const displayTitle = source.title?.trim() || cleanDomain || source.url;

  return (
    <Pressable
      testID={testID ?? `web-source-card-${source.id}`}
      accessibilityRole="button"
      accessibilityState={{ selected: highlighted }}
      accessibilityLabel={`${source.title || '网页来源'}，${cleanDomain}`}
      onPress={() => onPress?.(source)}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      style={[
        styles.capsule,
        {
          borderRadius: theme.radius.pill,
          backgroundColor: theme.colors.surfaceGrouped,
          borderColor: theme.colors.hairline,
        },
        style,
      ]}
    >
      {/* 联动高亮呼吸渐变叠层 */}
      <Animated.View
        pointerEvents="none"
        testID="web-source-card-highlight-overlay"
        style={[
          StyleSheet.absoluteFill,
          styles.highlightOverlay,
          {
            borderRadius: theme.radius.pill,
            backgroundColor: theme.colors.brandSoft,
            borderColor: theme.colors.brand,
          },
          animatedHighlightOverlayStyle,
        ]}
      />

      {/* 按压反馈叠层 */}
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          styles.pressOverlay,
          {
            borderRadius: theme.radius.pill,
            backgroundColor: theme.colors.fillPressed,
          },
          press.overlayStyle,
        ]}
      />

      {/* 站点标识 */}
      <FaviconOrInitial
        faviconUrl={source.faviconUrl}
        domain={source.domain || source.url}
      />

      {/* 域名与标题水平单行截断排列 */}
      <View style={styles.contentRow}>
        {index !== undefined ? (
          <AppText
            variant="mono"
            color="textTertiary"
            numberOfLines={1}
            style={styles.indexLabel}
            testID="web-source-card-index"
          >
            {`[${index}]`}
          </AppText>
        ) : null}

        {cleanDomain ? (
          <AppText
            variant="caption"
            color="textTertiary"
            numberOfLines={1}
            style={styles.domainText}
            testID="web-source-card-domain"
          >
            {cleanDomain}
          </AppText>
        ) : null}

        {cleanDomain && displayTitle ? (
          <AppText
            variant="caption"
            color="textTertiary"
            style={styles.separator}
          >
            ·
          </AppText>
        ) : null}

        <AppText
          variant="caption"
          color="textPrimary"
          numberOfLines={1}
          ellipsizeMode="tail"
          style={styles.titleText}
          testID="web-source-card-title"
        >
          {displayTitle}
        </AppText>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  capsule: {
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 6,
    maxWidth: 260,
    overflow: 'hidden',
  },
  highlightOverlay: {
    borderWidth: 1,
  },
  pressOverlay: {
    zIndex: 1,
  },
  faviconImage: {
    width: 14,
    height: 14,
    borderRadius: 2,
    flexShrink: 0,
  },
  initialContainer: {
    width: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    flexShrink: 0,
  },
  initialText: {
    fontSize: 9,
    lineHeight: 11,
    fontWeight: '700',
  },
  globeContainer: {
    width: 14,
    height: 14,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  contentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    flexShrink: 1,
  },
  indexLabel: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '600',
    flexShrink: 0,
  },
  domainText: {
    fontSize: 12,
    lineHeight: 15,
    flexShrink: 0,
    maxWidth: 80,
  },
  separator: {
    fontSize: 12,
    lineHeight: 15,
    flexShrink: 0,
  },
  titleText: {
    fontSize: 12,
    lineHeight: 15,
    flexShrink: 1,
  },
});

export default WebSourceCard;
