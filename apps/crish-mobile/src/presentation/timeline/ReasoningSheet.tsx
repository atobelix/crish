// 沉浸式思考链专用展示抽屉：
// 基于项目统一的 Sheet 组件，提供大视口长文沉浸精读、耗时标签、字数统计、复制与手势下滑关闭。
import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { copyTextToClipboard } from '@/adapters/platform/clipboard';
import { haptics } from '@/adapters/platform/haptics';
import { AppText, Button, Sheet } from '@/presentation/ui';

export interface ReasoningSheetProps {
  visible: boolean;
  onClose: () => void;
  text: string;
  durationMs?: number;
  testID?: string;
}

export function ReasoningSheet({
  visible,
  onClose,
  text,
  durationMs,
  testID = 'reasoning-sheet',
}: ReasoningSheetProps) {
  const theme = useTheme();
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
        copyTimerRef.current = null;
      }
    };
  }, []);

  const seconds =
    durationMs !== undefined && durationMs > 0
      ? Math.max(1, Math.round(durationMs / 1000))
      : null;

  const handleCopy = useCallback(async () => {
    const ok = await copyTextToClipboard(text);
    if (ok) {
      haptics.selection();
      setCopied(true);
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = setTimeout(() => {
        setCopied(false);
        copyTimerRef.current = null;
      }, 2000);
    }
  }, [text]);

  const headerTitle =
    seconds !== null ? `深度思考过程 (${seconds}s)` : '深度思考过程';

  return (
    <Sheet
      keyboard="none"
      visible={visible}
      onClose={onClose}
      title={headerTitle}
      size="large"
      testID={testID}
      footer={
        <View style={styles.footerRow}>
          <Button
            label={copied ? '已复制' : '复制思考内容'}
            variant="secondary"
            size="compact"
            onPress={handleCopy}
            testID="reasoning-sheet-copy-btn"
          />
          <Button
            label="完成阅读"
            variant="primary"
            size="compact"
            onPress={onClose}
            testID="reasoning-sheet-close-btn"
          />
        </View>
      }
    >
      <ScrollView
        showsVerticalScrollIndicator
        contentContainerStyle={styles.scrollContent}
        style={styles.container}
        testID="reasoning-sheet-scroll"
      >
        {/* 顶部元信息标签条：思考耗时与字数统计 */}
        <View style={styles.metaRow} testID="reasoning-sheet-meta">
          {seconds !== null ? (
            <View
              style={[
                styles.badge,
                {
                  backgroundColor: theme.colors.fillSubtle,
                  borderColor: theme.colors.hairline,
                  borderRadius: theme.radius.xs,
                },
              ]}
              testID="reasoning-sheet-duration-badge"
            >
              <AppText variant="caption" color="textTertiary">
                耗时 {seconds} 秒
              </AppText>
            </View>
          ) : null}
          <View
            style={[
              styles.badge,
              {
                backgroundColor: theme.colors.fillSubtle,
                borderColor: theme.colors.hairline,
                borderRadius: theme.radius.xs,
              },
            ]}
            testID="reasoning-sheet-count-badge"
          >
            <AppText variant="caption" color="textTertiary">
              字数 {text.length} 字
            </AppText>
          </View>
        </View>

        {/* 仿代码块沙盒质感内容展示区 */}
        <View
          style={[
            styles.sheetBox,
            {
              backgroundColor: theme.colors.canvasDrawer,
              borderRadius: theme.radius.control,
              borderColor: theme.colors.hairline,
            },
          ]}
          testID="reasoning-sheet-box"
        >
          <AppText
            variant="footnote"
            color="textSecondary"
            style={[styles.sheetText, theme.type.mono]}
            selectable
            testID="reasoning-sheet-text"
          >
            {text}
          </AppText>
        </View>
      </ScrollView>
    </Sheet>
  );
}

export default ReasoningSheet;

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderWidth: StyleSheet.hairlineWidth,
  },
  sheetBox: {
    padding: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  sheetText: {},
  footerRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
});
