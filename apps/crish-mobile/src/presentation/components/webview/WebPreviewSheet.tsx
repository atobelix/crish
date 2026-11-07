/**
 * apps/crish-mobile/src/presentation/components/webview/WebPreviewSheet.tsx
 *
 * 应用内轻量网页安全预览抽屉体系：
 * - 安全守卫第一准则（SSRF 门禁）：加载前调用 validateSafeUrl 强制校验，保留 IP、内网域名、非 http/https 刚性拦截；
 * - 顶栏布局：左侧安全徽标 + 归一化域名，中间单行截断标题，右侧外链直达、复制链接与关闭按钮；
 * - 加载与错误反馈：顶部 2px 细线柔和进度条，加载故障展示优雅居中错误卡片并支持一键重新加载；
 * - 跨端自适应：动态容错探测 react-native-webview，测试与真机环境零崩溃。
 */

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { validateSafeUrl } from '@crish/shared-utils';
import { useTheme } from '@/adapters/platform/theme';
import { openLink } from '@/adapters/platform/openLink';
import { copyTextToClipboard } from '@/adapters/platform/clipboard';
import { haptics } from '@/adapters/platform/haptics';
import { AppText, Icon, IconButton } from '@/presentation/ui';
import { useOverlayRegistration } from '@/presentation/ui/overlayStack';
import { normalizeDomain } from './normalizeDomain';
import { probeNativeWebView } from './nativeWebView';
import {
  WebPreviewBlockedCard,
  WebPreviewErrorCard,
} from './WebPreviewStatusCard';
import type { WebPreviewSheetProps, WebPreviewSecurityInfo } from './types';

export { normalizeDomain };

/**
 * 运行时容错探测 react-native-webview（2026-11-05 收敛到共享单点
 * nativeWebView.ts——全 App 唯一探测点；探测失败本抽屉降级为
 * 「不支持预览」错误卡，零崩溃）。
 */
const NativeWebView = probeNativeWebView();

export function WebPreviewSheet({
  visible,
  url,
  title,
  onClose,
  testID = 'web-preview-sheet',
  onOpenExternal,
  onCopyLink,
  allowLoopback = false,
}: WebPreviewSheetProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();

  // 抽屉高度：占窗口约 92%，留出顶部状态栏通透视觉与手势遮罩
  const panelHeight = Math.min(
    windowHeight - Math.max(insets.top, 24),
    Math.round(windowHeight * 0.92)
  );

  // 覆盖层注册（Android 系统返回按栈顶裁决）
  const generatedOverlayId = useId();
  const overlayId = testID ?? generatedOverlayId;
  useOverlayRegistration(overlayId, visible, {
    dismissible: true,
    onRequestClose: onClose,
  });

  // 安全门禁检查（SSRF 防御）
  const security: WebPreviewSecurityInfo = useMemo(() => {
    const trimmed = (url || '').trim();
    if (!trimmed) {
      return {
        isSafe: false,
        normalizedDomain: '',
        blockedReason: 'URL 不能为空',
      };
    }
    const check = validateSafeUrl(trimmed, { allowLoopback });
    const domain = normalizeDomain(trimmed, check.hostname);
    return {
      isSafe: check.isSafe,
      normalizedDomain: domain,
      blockedReason: check.reason,
    };
  }, [url, allowLoopback]);

  // 内部加载与错误状态
  const [loadError, setLoadError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0.15);
  const [pageTitle, setPageTitle] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // 可见性或 URL 切换时重置状态
  useEffect(() => {
    if (visible) {
      setLoadError(null);
      setProgress(0.15);
      setPageTitle(null);
    }
  }, [visible, url, reloadKey]);

  // 进度条平滑动画
  const progressShared = useSharedValue(0.15);
  useEffect(() => {
    progressShared.value = withTiming(progress, {
      duration: theme.motion.duration.sheet,
      easing: Easing.bezier(0.25, 0.1, 0.25, 1),
    });
  }, [progress, progressShared, theme.motion.duration.sheet]);

  const progressAnimatedStyle = useAnimatedStyle(() => {
    const isDone = progressShared.value >= 1;
    return {
      width: `${Math.min(100, Math.max(0, progressShared.value * 100))}%`,
      opacity: isDone
        ? withTiming(0, { duration: theme.motion.duration.expand })
        : 1,
    };
  });

  // 外部系统浏览器打开
  const handleOpenExternal = useCallback(async () => {
    haptics.selection();
    const handler = onOpenExternal ?? openLink;
    await handler(url);
  }, [onOpenExternal, url]);

  // 复制链接
  const handleCopyLink = useCallback(async () => {
    haptics.selection();
    const handler = onCopyLink ?? copyTextToClipboard;
    const ok = await handler(url);
    if (ok) {
      haptics.success();
    }
  }, [onCopyLink, url]);

  // 重新加载重试
  const handleReload = useCallback(() => {
    haptics.selection();
    setLoadError(null);
    setProgress(0.15);
    setReloadKey((k) => k + 1);
  }, []);

  if (!visible) return null;

  const displayTitle =
    title || pageTitle || security.normalizedDomain || '网页预览';

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.modalRoot}>
        {/* 背景遮罩 */}
        <Pressable
          testID="web-preview-backdrop"
          accessibilityRole="button"
          accessibilityLabel="关闭网页预览"
          style={[styles.backdrop, { backgroundColor: theme.colors.scrim }]}
          onPress={onClose}
        />

        {/* 抽屉面板主体 */}
        <View
          testID={testID}
          style={[
            styles.panel,
            {
              backgroundColor: theme.colors.surfaceRaised,
              borderTopLeftRadius: theme.radius.sheet,
              borderTopRightRadius: theme.radius.sheet,
              height: panelHeight,
              paddingBottom: Math.max(insets.bottom, theme.space.xs),
            },
          ]}
        >
          {/* 顶部手柄指示胶囊 */}
          <View style={styles.handleContainer}>
            <View
              testID="web-preview-handle"
              style={[
                styles.handle,
                {
                  width: theme.size.sheetHandleWidth,
                  height: theme.size.sheetHandleHeight,
                  borderRadius: theme.radius.pill,
                  backgroundColor: theme.dark
                    ? 'rgba(255,255,255,0.18)'
                    : 'rgba(0,0,0,0.14)',
                },
              ]}
            />
          </View>

          {/* 顶栏 Header */}
          <View
            style={[
              styles.header,
              {
                borderBottomColor: theme.colors.hairline,
                paddingHorizontal: theme.space.screenX,
              },
            ]}
          >
            {/* 左侧：安全锁图标 + 归一化域名 */}
            <View style={styles.headerLeft} testID="web-preview-domain-badge">
              <Icon
                name="shield"
                size={16}
                color={
                  security.isSafe ? theme.colors.success : theme.colors.danger
                }
              />
              <AppText
                variant="caption"
                numberOfLines={1}
                style={[
                  styles.domainText,
                  {
                    color: security.isSafe
                      ? theme.colors.textSecondary
                      : theme.colors.danger,
                  },
                ]}
              >
                {security.normalizedDomain ||
                  (security.isSafe ? '安全网页' : '安全拦截')}
              </AppText>
            </View>

            {/* 中间：标题文本（单行省略） */}
            <View style={styles.headerCenter}>
              <AppText
                variant="headline"
                numberOfLines={1}
                style={[styles.titleText, { color: theme.colors.textPrimary }]}
                testID="web-preview-title"
              >
                {displayTitle}
              </AppText>
            </View>

            {/* 右侧：外部浏览器、复制链接、关闭 */}
            <View style={styles.headerRight}>
              <IconButton
                name="share"
                testID="web-preview-open-external"
                accessibilityLabel="在外部浏览器打开"
                onPress={handleOpenExternal}
                diameter={32}
                size={18}
              />

              <IconButton
                name="copy"
                testID="web-preview-copy-link"
                accessibilityLabel="复制链接"
                onPress={handleCopyLink}
                diameter={32}
                size={18}
              />

              <IconButton
                name="x"
                testID="web-preview-close"
                accessibilityLabel="关闭"
                onPress={onClose}
                diameter={32}
                size={18}
              />
            </View>
          </View>

          {/* 顶部 2px 细线柔和加载进度条 */}
          {security.isSafe && !loadError ? (
            <View
              style={[
                styles.progressBarTrack,
                { backgroundColor: theme.colors.surfaceGrouped },
              ]}
            >
              <Animated.View
                testID="web-preview-progress-bar"
                style={[
                  styles.progressBarIndicator,
                  { backgroundColor: theme.colors.actionPrimary },
                  progressAnimatedStyle,
                ]}
              />
            </View>
          ) : null}

          {/* 内容展示区 */}
          <View style={styles.contentContainer}>
            {!security.isSafe ? (
              // 1. SSRF 刚性阻断界面
              <WebPreviewBlockedCard reason={security.blockedReason} />
            ) : loadError ? (
              // 2. 加载失败错误卡片与重新加载
              <WebPreviewErrorCard error={loadError} onReload={handleReload} />
            ) : Platform.OS === 'web' || !NativeWebView ? (
              // 3. Web/无原生模块容错
              <View
                testID="web-preview-fallback-container"
                style={styles.webViewHost}
              >
                {Platform.OS === 'web' ? (
                  <iframe
                    src={url}
                    title={displayTitle}
                    style={{ width: '100%', height: '100%', border: 'none' }}
                    onLoad={() => {
                      setProgress(1);
                      setLoadError(null);
                    }}
                    onError={() => {
                      setLoadError('网页加载失败');
                    }}
                  />
                ) : (
                  <View
                    testID="web-preview-webview-placeholder"
                    style={styles.fallbackCard}
                  >
                    <AppText
                      variant="caption"
                      style={{ color: theme.colors.textSecondary }}
                    >
                      当前环境未提供原生 Web 容器
                    </AppText>
                  </View>
                )}
              </View>
            ) : (
              // 4. 标准 NativeWebView 挂载
              <View style={styles.webViewHost}>
                <NativeWebView
                  key={`webview-${reloadKey}`}
                  testID="web-preview-webview"
                  source={{ uri: url }}
                  style={styles.webView}
                  onLoadStart={() => {
                    setProgress(0.2);
                    setLoadError(null);
                  }}
                  onLoadProgress={(e: {
                    nativeEvent?: { progress?: number };
                  }) => {
                    const p = e?.nativeEvent?.progress;
                    if (typeof p === 'number') {
                      setProgress(Math.max(0.2, p));
                    }
                  }}
                  onLoadEnd={() => {
                    setProgress(1);
                  }}
                  onError={(e: { nativeEvent?: { description?: string } }) => {
                    const desc = e?.nativeEvent?.description || '网络连接故障';
                    setLoadError(desc);
                  }}
                  onHttpError={(e: {
                    nativeEvent?: { statusCode?: number };
                  }) => {
                    const code = e?.nativeEvent?.statusCode;
                    if (typeof code === 'number' && code >= 400) {
                      setLoadError(`HTTP 错误 (${code})`);
                    }
                  }}
                  onNavigationStateChange={(navState: { title?: string }) => {
                    if (navState?.title && !title) {
                      setPageTitle(navState.title);
                    }
                  }}
                />
              </View>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalRoot: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
  },
  panel: {
    width: '100%',
    overflow: 'hidden',
  },
  handleContainer: {
    alignItems: 'center',
    paddingTop: 8,
    paddingBottom: 6,
  },
  handle: {
    // 尺寸与圆角由 theme 动态注入
  },
  header: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    maxWidth: 120,
    gap: 4,
    marginRight: 8,
  },
  domainText: {
    fontWeight: '500',
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  titleText: {
    fontWeight: '600',
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginLeft: 8,
  },
  progressBarTrack: {
    width: '100%',
    height: 2,
    overflow: 'hidden',
  },
  progressBarIndicator: {
    height: '100%',
  },
  contentContainer: {
    flex: 1,
    position: 'relative',
  },
  webViewHost: {
    flex: 1,
    width: '100%',
    height: '100%',
  },
  webView: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  fallbackCard: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
