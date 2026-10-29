// 文件行：类型图标 + 名称 + 大小/时间（目录无 meta）。
import { memo } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import type { FileEntry } from '@/domain/types/domain';
import { useTheme } from '@/adapters/platform/theme';
import { formatRelativeTime } from '@/domain/pure/time';
import { AppText, Icon } from '@/presentation/ui';
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

  return (
    <Pressable
      testID={entry.isDir ? 'file-row-dir' : 'file-row'}
      accessibilityRole="button"
      accessibilityLabel={`${entry.isDir ? '目录' : '文件'} ${entry.name}${
        meta ? `，${meta}` : ''
      }${sensitive ? '，敏感文件' : ''}`}
      onPress={() => onPress(entry)}
      style={({ pressed }) => [
        styles.row,
        {
          borderBottomColor: theme.colors.border,
          borderBottomWidth: divider ? StyleSheet.hairlineWidth : 0,
        },
        pressed && { backgroundColor: theme.colors.surfaceSubtle },
      ]}
    >
      <Icon name={icon} size={20} color={color} />
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
      {entry.isDir ? (
        <Icon
          name="chevron-right"
          size={14}
          color={theme.colors.textTertiary}
        />
      ) : null}
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
