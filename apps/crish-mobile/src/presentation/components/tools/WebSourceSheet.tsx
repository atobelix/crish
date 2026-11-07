// 网页搜索来源详情半屏抽屉（WebSourceSheet）：
// 当用户点击时间线上的微胶囊卡片或回答中的正文角标 [N] 时展开。
// 展示引证序号胶囊 [N]、网页标题、域名、发布日期、搜索引擎提供商、完整 URL 与核心摘录，
// 并提供“在应用内打开”和“复制链接”标准底部动作。
import { useCallback } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { copyTextToClipboard } from '@/adapters/platform/clipboard';
import { openLink } from '@/adapters/platform/openLink';
import { AppText, Button, Icon, Sheet, useToast } from '@/presentation/ui';
import type { WebSearchProviderId, WebSearchSource } from '@crish/shared-types';
import { extractCleanDomain } from './WebSourceCard';

export interface WebSourceSheetProps {
  /** 控制半屏抽屉显示/隐藏 */
  visible: boolean;
  /** 关闭抽屉回调 */
  onClose: () => void;
  /** 当前选中的网页搜索来源（为 null 时不呈现内容） */
  source: WebSearchSource | null;
  /** 1-based 引证序号（例如 1 对应 [1]） */
  citationIndex?: number | undefined;
  /** 点击“在应用内打开”回调（若不传则尝试打开系统链接） */
  onOpenPreview?: ((url: string) => void) | undefined;
  /** 点击“复制链接”回调（若不传则默认写入剪贴板并提示 Toast） */
  onCopyLink?: ((url: string) => void) | undefined;
  testID?: string | undefined;
}

/** 格式化发布时间展示（支持 ISO 字符串与时间戳） */
export function formatPublishDate(dateStr?: string): string | null {
  if (!dateStr) return null;
  const trimmed = dateStr.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    return trimmed.slice(0, 10);
  }
  try {
    const d = new Date(trimmed);
    if (!isNaN(d.getTime())) {
      return d.toISOString().slice(0, 10);
    }
  } catch {
    // 忽略异常，回退返回原串
  }
  return trimmed;
}

/** 搜索引擎提供商友好名称映射 */
export function getProviderBadgeLabel(
  provider?: WebSearchProviderId | string
): string {
  if (!provider) return 'Web 检索';
  switch (provider) {
    case 'tavily':
      return 'Tavily';
    case 'jina':
      return 'Jina';
    case 'exa':
      return 'Exa';
    case 'brave':
      return 'Brave';
    case 'bocha':
      return 'Bocha';
    case 'serpapi':
      return 'SerpApi';
    case 'duckduckgo_html':
      return 'DuckDuckGo';
    case 'bing_html':
      return 'Bing';
    case 'baidu_html':
      return 'Baidu';
    case 'wikipedia':
      return 'Wikipedia';
    case 'model_native':
      return '原生检索';
    default:
      return String(provider);
  }
}

export function WebSourceSheet({
  visible,
  onClose,
  source,
  citationIndex,
  onOpenPreview,
  onCopyLink,
  testID,
}: WebSourceSheetProps) {
  const theme = useTheme();
  const { showToast } = useToast();

  const handleCopyLink = useCallback(async () => {
    if (!source?.url) return;
    if (onCopyLink) {
      onCopyLink(source.url);
    } else {
      await copyTextToClipboard(source.url);
    }
    showToast('已复制网页链接', 'info');
  }, [source?.url, onCopyLink, showToast]);

  const handleOpenPreview = useCallback(() => {
    if (!source?.url) return;
    if (onOpenPreview) {
      onOpenPreview(source.url);
    } else {
      void openLink(source.url);
    }
  }, [source?.url, onOpenPreview]);

  if (!source) {
    return (
      <Sheet
        keyboard="none"
        visible={false}
        onClose={onClose}
        size="medium"
        testID={testID ?? 'web-source-sheet-hidden'}
      >
        <View />
      </Sheet>
    );
  }

  const cleanDomain = extractCleanDomain(source.domain || source.url);
  const displayIndex =
    citationIndex !== undefined
      ? citationIndex
      : source.id && /^\d+$/.test(source.id)
        ? Number(source.id)
        : undefined;
  const formattedDate = formatPublishDate(source.publishedDate);
  const providerLabel = getProviderBadgeLabel(source.provider);

  const footer = (
    <View style={styles.footerRow} testID="web-source-sheet-footer">
      <View style={styles.footerButtonWrapper}>
        <Button
          variant="secondary"
          size="compact"
          label="复制链接"
          onPress={handleCopyLink}
          testID="web-source-sheet-copy-btn"
        />
      </View>
      <View style={styles.footerButtonWrapper}>
        <Button
          variant="primary"
          size="compact"
          label="在应用内打开"
          onPress={handleOpenPreview}
          testID="web-source-sheet-preview-btn"
        />
      </View>
    </View>
  );

  return (
    <Sheet
      keyboard="none"
      visible={visible}
      onClose={onClose}
      size="medium"
      footer={footer}
      testID={testID ?? 'web-source-sheet'}
    >
      <View style={[styles.container, { gap: theme.space.md }]}>
        {/* 顶部标题栏：引证编号胶囊 [N] + 网页标题（2 行截断）+ 关闭按钮 */}
        <View style={styles.titleRow}>
          <View style={styles.titleContent}>
            {displayIndex !== undefined ? (
              <View
                style={[
                  styles.indexCapsule,
                  {
                    backgroundColor: theme.colors.brandSoft,
                    borderColor: theme.colors.brand,
                    borderRadius: theme.radius.pill,
                  },
                ]}
                testID="web-source-sheet-index"
              >
                <AppText
                  variant="mono"
                  color="brand"
                  style={styles.indexCapsuleText}
                >
                  {`[${displayIndex}]`}
                </AppText>
              </View>
            ) : null}

            <AppText
              variant="headline"
              color="textPrimary"
              numberOfLines={2}
              style={styles.sheetTitle}
              testID="web-source-sheet-title"
            >
              {source.title?.trim() || cleanDomain || source.url}
            </AppText>
          </View>

          <Pressable
            testID="web-source-sheet-close"
            accessibilityRole="button"
            accessibilityLabel="关闭"
            onPress={onClose}
            hitSlop={8}
            style={[
              styles.closeButton,
              {
                width: theme.size.sheetClose,
                height: theme.size.sheetClose,
                borderRadius: theme.size.sheetClose / 2,
                backgroundColor: theme.colors.fillSubtle,
              },
            ]}
          >
            <Icon
              name="x"
              size={theme.size.iconSmall}
              color={theme.colors.textSecondary}
            />
          </Pressable>
        </View>

        {/* 元数据行：域名、发布时间、搜索提供商徽章 */}
        <View style={styles.metaRow}>
          <View style={styles.domainGroup}>
            <Icon name="globe" size={14} color={theme.colors.textTertiary} />
            <AppText
              variant="caption"
              color="textSecondary"
              numberOfLines={1}
              testID="web-source-sheet-domain"
            >
              {cleanDomain || '网页'}
            </AppText>
          </View>

          {formattedDate ? (
            <>
              <AppText variant="caption" color="textTertiary">
                ·
              </AppText>
              <AppText
                variant="caption"
                color="textTertiary"
                testID="web-source-sheet-date"
              >
                {formattedDate}
              </AppText>
            </>
          ) : null}

          <View
            style={[
              styles.providerBadge,
              {
                backgroundColor: theme.colors.fillSubtle,
                borderColor: theme.colors.hairline,
                borderRadius: theme.radius.pill,
              },
            ]}
            testID="web-source-sheet-provider"
          >
            <AppText
              variant="caption"
              color="textTertiary"
              style={styles.providerBadgeText}
            >
              {providerLabel}
            </AppText>
          </View>
        </View>

        {/* 完整 URL（可点击复制） */}
        <Pressable
          testID="web-source-sheet-url"
          accessibilityRole="button"
          accessibilityLabel="复制完整链接"
          onPress={handleCopyLink}
          style={[
            styles.urlBox,
            {
              backgroundColor: theme.colors.fillSubtle,
              borderColor: theme.colors.hairline,
              borderRadius: theme.radius.control,
            },
          ]}
        >
          <AppText
            variant="caption"
            color="textTertiary"
            numberOfLines={1}
            ellipsizeMode="middle"
            style={styles.urlText}
          >
            {source.url}
          </AppText>
          <Icon name="copy" size={14} color={theme.colors.textTertiary} />
        </Pressable>

        {/* 核心摘录（Quote Snippet）：卡片包裹，优雅排版，支持长按选择 */}
        <View
          style={[
            styles.snippetCard,
            {
              backgroundColor: theme.colors.surfaceGrouped,
              borderColor: theme.colors.hairline,
              borderRadius: theme.radius.card,
              padding: theme.space.md,
            },
          ]}
          testID="web-source-sheet-snippet-card"
        >
          <View style={styles.snippetHeader}>
            <AppText
              variant="caption"
              color="textTertiary"
              style={styles.snippetSectionLabel}
            >
              核心摘录
            </AppText>
          </View>
          <AppText
            variant="body"
            color="textPrimary"
            selectable
            style={styles.snippetContent}
            testID="web-source-sheet-snippet"
          >
            {source.snippet?.trim() || '暂无网页摘录内容'}
          </AppText>
        </View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingBottom: 8,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
  },
  titleContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
  },
  indexCapsule: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  indexCapsuleText: {
    fontWeight: '700',
  },
  sheetTitle: {
    flex: 1,
  },
  closeButton: {
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
  },
  domainGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  providerBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderWidth: StyleSheet.hairlineWidth,
  },
  providerBadgeText: {},
  urlBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  urlText: {
    flex: 1,
  },
  snippetCard: {
    borderWidth: StyleSheet.hairlineWidth,
    gap: 6,
  },
  snippetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  snippetSectionLabel: {
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  snippetContent: {},
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  footerButtonWrapper: {
    flex: 1,
  },
});

export default WebSourceSheet;
