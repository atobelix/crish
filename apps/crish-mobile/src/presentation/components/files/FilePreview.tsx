// 文件预览页（R2-06b，F4 §6.3 文件详情页 + R2UX-06-02）：
// - 按需加载数据面在 useFilePreviewVm（进入详情才请求 readFile，列表零预载）；
//   本组件为纯展示：输入 vm 状态 + 回调，渲染文本/占位/错误/续读；
// - 占位态（R2UX-06-02/06-07）：过大（1MB 上限）/ 二进制 / 编码不支持 ——
//   卡片文案 + 元数据（文件名/大小/修改时间，F4-F26 元数据卡）；
// - 错误态：文案（F4 附录 B 映射）+ 重试按钮（preview-retry）；
// - 文本渲染：行号 + 等宽字体（F4-F20）；截断 → 底部「已显示前 N 行 +
//   继续加载」（F4-F27）；5000 行硬顶 → 「已达预览上限」；
// - 敏感文件：顶部警示横幅（F4-F28；内容不落缓存由缓存层保证）；
// - 返回：onBack 交还浏览页（列表缓存保留在 filesStore，X4-6 返回一致性）。
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { FilePreviewVm } from '@/adapters/viewmodels/useFilePreviewVm';
import { useTheme } from '@/adapters/platform/theme';
import { mapFilesErrorCode } from './fileMeta';

export interface FilePreviewProps {
  vm: FilePreviewVm;
  /** 返回浏览页（列表态保留） */
  onBack: () => void;
}

/** 行号渲染：内容 → 编号行数组（纯函数导出供单测；startLine 恒 0，预算式续读） */
export function numberedLines(content: string, startLine = 0): string[] {
  const lines = content === '' ? [''] : content.split('\n');
  return lines.map(
    (line, i) => `${String(startLine + i + 1).padStart(4)}  ${line}`
  );
}

export function FilePreview({ vm, onBack }: FilePreviewProps) {
  const theme = useTheme();
  const file = vm.file;

  if (!file) return null;

  const metaParts: string[] = [];
  if (file.size !== undefined) metaParts.push(`${file.size} 字节`);
  if (file.modified)
    metaParts.push(
      `修改于 ${new Date(Number(file.modified)).toLocaleString()}`
    );

  return (
    <View style={styles.container}>
      <View style={[styles.header, { borderBottomColor: theme.hairline }]}>
        <Pressable
          testID="preview-back"
          accessibilityRole="button"
          accessibilityLabel="返回文件列表"
          onPress={onBack}
          style={({ pressed }) => [
            styles.back,
            { borderColor: theme.hairlineStrong },
            pressed && { opacity: 0.7 },
          ]}
        >
          <Text style={[styles.backText, { color: theme.textPrimary }]}>←</Text>
        </Pressable>
        <View style={styles.titleWrap}>
          <Text
            testID="preview-title"
            numberOfLines={1}
            style={[styles.title, { color: theme.textPrimary }]}
          >
            {file.name}
          </Text>
          <Text
            numberOfLines={1}
            style={[styles.subtitle, { color: theme.textTertiary }]}
          >
            {file.relPath}
          </Text>
        </View>
      </View>

      {vm.sensitive ? (
        <View
          testID="preview-sensitive-banner"
          style={[
            styles.sensitiveBanner,
            { backgroundColor: theme.colorWarningBg },
          ]}
        >
          <Text style={[styles.sensitiveText, { color: theme.colorWarning }]}>
            敏感文件：内容未缓存，请谨慎查看（F4 §7.1）
          </Text>
        </View>
      ) : null}

      {renderBody(vm, metaParts, theme)}
    </View>
  );
}

function renderBody(
  vm: FilePreviewVm,
  metaParts: string[],
  theme: ReturnType<typeof useTheme>
) {
  const metaText = metaParts.join(' · ');
  switch (vm.status) {
    case 'loading':
      return (
        <View testID="preview-loading" style={styles.center}>
          <Text style={[styles.hint, { color: theme.textSecondary }]}>
            加载中…
          </Text>
        </View>
      );
    case 'too-large':
      return (
        <View testID="preview-too-large" style={styles.center}>
          <Text style={[styles.placeholderTitle, { color: theme.textPrimary }]}>
            文件过大，无法预览
          </Text>
          <Text style={[styles.hint, { color: theme.textSecondary }]}>
            预览上限 1MB（R2UX-06-02）
          </Text>
          {metaText ? (
            <Text style={[styles.meta, { color: theme.textTertiary }]}>
              {metaText}
            </Text>
          ) : null}
        </View>
      );
    case 'binary':
      return (
        <View testID="preview-binary" style={styles.center}>
          <Text style={[styles.placeholderTitle, { color: theme.textPrimary }]}>
            二进制文件，无法预览
          </Text>
          <Text style={[styles.hint, { color: theme.textSecondary }]}>
            仅支持文本类文件内容展示（F4-F26）
          </Text>
          {metaText ? (
            <Text style={[styles.meta, { color: theme.textTertiary }]}>
              {metaText}
            </Text>
          ) : null}
        </View>
      );
    case 'unsupported-encoding':
      return (
        <View testID="preview-encoding" style={styles.center}>
          <Text style={[styles.placeholderTitle, { color: theme.textPrimary }]}>
            文件编码不受支持
          </Text>
          <Text style={[styles.hint, { color: theme.textSecondary }]}>
            请用支持该编码的编辑器查看
          </Text>
          {metaText ? (
            <Text style={[styles.meta, { color: theme.textTertiary }]}>
              {metaText}
            </Text>
          ) : null}
        </View>
      );
    case 'error': {
      const text = mapFilesErrorCode(vm.errorCode);
      return (
        <View testID="preview-error" style={styles.center}>
          <Text style={[styles.placeholderTitle, { color: theme.textPrimary }]}>
            {text.title}
          </Text>
          <Text style={[styles.hint, { color: theme.textSecondary }]}>
            {text.hint}
          </Text>
          <Pressable
            testID="preview-retry"
            accessibilityRole="button"
            accessibilityLabel="重试"
            onPress={vm.retry}
            style={({ pressed }) => [
              styles.retryButton,
              { borderColor: theme.colorSuccess },
              pressed && { opacity: 0.7 },
            ]}
          >
            <Text style={[styles.retryText, { color: theme.colorSuccess }]}>
              重试
            </Text>
          </Pressable>
        </View>
      );
    }
    case 'loaded':
      return (
        <ScrollView
          testID="preview-content"
          style={{ backgroundColor: theme.bgPrimary }}
          contentContainerStyle={styles.contentWrap}
        >
          {numberedLines(vm.content).map((line, i) => (
            <Text
              key={i}
              testID="preview-line"
              selectable
              style={[styles.line, { color: theme.textPrimary }]}
            >
              {line}
            </Text>
          ))}
          {vm.truncated ? (
            <View style={styles.footer}>
              <Text style={[styles.footerText, { color: theme.textTertiary }]}>
                已显示前 {vm.lineCount} 行
              </Text>
              {vm.atCap ? (
                <Text
                  testID="preview-limit"
                  style={[styles.footerText, { color: theme.textTertiary }]}
                >
                  已达预览上限（5000 行，F4-F27）
                </Text>
              ) : (
                <Pressable
                  testID="preview-load-more"
                  accessibilityRole="button"
                  accessibilityLabel="继续加载"
                  onPress={vm.loadMore}
                  style={({ pressed }) => [
                    styles.retryButton,
                    { borderColor: theme.colorInfo },
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Text style={[styles.retryText, { color: theme.colorInfo }]}>
                    继续加载
                  </Text>
                </Pressable>
              )}
            </View>
          ) : null}
        </ScrollView>
      );
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 52,
    paddingHorizontal: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  back: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backText: {
    fontSize: 16,
    lineHeight: 18,
  },
  titleWrap: {
    flex: 1,
    paddingRight: 12,
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
  },
  subtitle: {
    fontSize: 12,
    marginTop: 2,
  },
  sensitiveBanner: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  sensitiveText: {
    fontSize: 12,
    fontWeight: '600',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 10,
  },
  placeholderTitle: {
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  hint: {
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
  },
  meta: {
    fontSize: 12,
    marginTop: 4,
    textAlign: 'center',
  },
  retryButton: {
    marginTop: 8,
    minHeight: 40,
    borderRadius: 9999,
    borderWidth: 1,
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryText: {
    fontSize: 14,
    fontWeight: '600',
  },
  contentWrap: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    paddingBottom: 32,
  },
  line: {
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: 18,
  },
  footer: {
    alignItems: 'center',
    gap: 8,
    paddingTop: 16,
  },
  footerText: {
    fontSize: 12,
  },
});
