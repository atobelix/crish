// 文件预览：文本 / 占位态 / 错误态 / 续读。
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import type { FilePreviewVm } from '@/adapters/viewmodels/useFilePreviewVm';
import { AppText, Button, EmptyState, Icon, Spinner } from '@/presentation/ui';
import { mapFilesErrorCode } from './fileMeta';

export interface FilePreviewProps {
  vm: FilePreviewVm;
  onBack: () => void;
  /** 是否渲染内部标题栏（Tab 内使用时由页面 AppHeader 承担） */
  showHeader?: boolean;
}

export function numberedLines(content: string, startLine = 0): string[] {
  const lines = content === '' ? [''] : content.split('\n');
  return lines.map(
    (line, index) => `${String(startLine + index + 1).padStart(4)}  ${line}`
  );
}

export function FilePreview({
  vm,
  onBack,
  showHeader = true,
}: FilePreviewProps) {
  const theme = useTheme();
  const file = vm.file;
  if (!file) return null;

  return (
    <View style={styles.container}>
      {showHeader ? (
        <View
          style={[styles.header, { borderBottomColor: theme.colors.border }]}
        >
          <Pressable
            testID="preview-back"
            accessibilityRole="button"
            accessibilityLabel="返回文件列表"
            onPress={onBack}
            style={({ pressed }) => [styles.back, pressed && { opacity: 0.6 }]}
          >
            <Icon
              name="chevron-left"
              size={22}
              color={theme.colors.textPrimary}
            />
          </Pressable>
          <View style={styles.titleWrap}>
            <AppText variant="subhead" numberOfLines={1}>
              {file.name}
            </AppText>
            <AppText variant="caption" color="textTertiary" numberOfLines={1}>
              {file.relPath}
            </AppText>
          </View>
        </View>
      ) : null}

      {vm.sensitive ? (
        <View
          testID="preview-sensitive"
          style={[
            styles.sensitive,
            { backgroundColor: theme.colors.warningSoft },
          ]}
        >
          <Icon name="shield" size={14} color={theme.colors.warning} />
          <AppText variant="meta" color="warning">
            敏感文件，内容不会缓存
          </AppText>
        </View>
      ) : null}

      {vm.status === 'loading' ? (
        <View style={styles.center}>
          <Spinner />
        </View>
      ) : vm.status === 'error' ? (
        <EmptyState
          icon="alert-circle"
          title={mapFilesErrorCode(vm.errorCode).title}
          action={
            <Button label="重试" variant="secondary" onPress={vm.retry} />
          }
        />
      ) : vm.status === 'too-large' ? (
        <EmptyState icon="file" title="文件过大，无法预览" />
      ) : vm.status === 'binary' ? (
        <EmptyState icon="file" title="二进制文件，无法预览" />
      ) : vm.status === 'unsupported-encoding' ? (
        <EmptyState icon="file" title="文件编码不受支持" />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {numberedLines(vm.content).map((line, index) => (
            <AppText
              key={index}
              testID="preview-line"
              variant="mono"
              color="textPrimary"
              selectable
              style={styles.line}
            >
              {line}
            </AppText>
          ))}
          {vm.truncated ? (
            <View style={styles.footer}>
              <AppText variant="caption" color="textTertiary">
                已显示前 {vm.lineCount} 行
              </AppText>
              {vm.atCap ? (
                <AppText variant="caption" color="textTertiary">
                  已达预览上限
                </AppText>
              ) : (
                <Button
                  label="继续加载"
                  variant="secondary"
                  onPress={vm.loadMore}
                />
              )}
            </View>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingRight: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  back: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleWrap: {
    flex: 1,
    gap: 1,
    paddingVertical: 8,
  },
  sensitive: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    paddingBottom: 32,
  },
  line: {
    fontSize: 12,
    lineHeight: 18,
  },
  footer: {
    marginTop: 16,
    alignItems: 'center',
    gap: 8,
  },
});
