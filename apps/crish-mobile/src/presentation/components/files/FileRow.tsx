// 文件行：类型图标 + 名称 + 大小/时间（目录无 meta）。
import { memo } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import Animated from 'react-native-reanimated';
import type { FileEntry } from '@/domain/types/domain';
import { useTheme } from '@/adapters/platform/theme';
import { formatRelativeTime } from '@/domain/pure/time';
import { AppText, Icon } from '@/presentation/ui';
import { usePressFade } from '@/presentation/ui/pressFeedback';
import {
  detectFileKind,
  FILE_KIND_ICON,
  FILE_KIND_TONE,
  formatFileSize,
  isSensitiveFile,
} from './fileMeta';

export interface FileRowProps {
  entry: FileEntry;
  onPress: (entry: FileEntry) => void;
  divider?: boolean;
}

export function rowMetaText(entry: FileEntry, nowMs = Date.now()): string {
  if (entry.isDir) return '';
  const parts: string[] = [];
  if (entry.size !== undefined) parts.push(formatFileSize(entry.size));
  if (entry.modified) {
    parts.push(formatRelativeTime(Number(entry.modified), nowMs));
  }
  return parts.join(' · ');
}

export const FileRow = memo(function FileRow({
  entry,
  onPress,
  divider = true,
}: FileRowProps) {
  const theme = useTheme();
  const kind = detectFileKind(entry.name);
  const icon = entry.isDir ? 'folder' : FILE_KIND_ICON[kind];
  const color = entry.isDir
    ? theme.colors.textSecondary
    : theme.colors[FILE_KIND_TONE[kind]];
  const meta = rowMetaText(entry);
  const sensitive = !entry.isDir && isSensitiveFile(entry.name);
  const press = usePressFade();

  return (
    <Pressable
      testID={entry.isDir ? 'file-row-dir' : 'file-row'}
      accessibilityRole="button"
      accessibilityLabel={`${entry.isDir ? '目录' : '文件'} ${entry.name}${
        meta ? `，${meta}` : ''
      }${sensitive ? '，敏感文件' : ''}`}
      onPress={() => onPress(entry)}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      style={[
        styles.row,
        {
          borderBottomColor: theme.colors.hairline,
          borderBottomWidth: divider ? StyleSheet.hairlineWidth : 0,
        },
      ]}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: theme.colors.fillSubtle },
          press.overlayStyle,
        ]}
      />
      <Icon name={icon} size={theme.size.icon} color={color} />
      <AppText variant="body" numberOfLines={1} style={styles.name}>
        {entry.name}
      </AppText>
      {sensitive ? (
        <AppText variant="caption" color="warning">
          敏感
        </AppText>
      ) : null}
      {meta ? (
        <AppText
          variant="caption"
          color="textTertiary"
          numberOfLines={1}
          style={styles.meta}
        >
          {meta}
        </AppText>
      ) : null}
      {/* N05 裁定：folder 符号已标明目录，右侧箭头视觉重复，不显示 */}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    gap: 12,
  },
  name: {
    flex: 1,
  },
  meta: {
    maxWidth: 130,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
});

export default FileRow;
