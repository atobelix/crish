// 文件行（R2-06b 渲染面；R2UX-06-01 固定行高 + R2UX-06-08 行 44 热区）：
// - 布局：类型图标（目录 📁 / 文件按类型字形+配色）+ 名称（省略号）+ meta
//   （文件：大小 + 相对时间，F4-F17；目录：不显示 meta）；
// - 固定行高（rowHeight 传入，密度三档 44/48/56 由列表层决定）；
// - memo：条目变化才重渲染（R2UX-05-01 行 memo 纪律同构）；
// - 语义：可点击列表项 + accessibilityLabel（TalkBack/旁白可用）。
import { memo } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import type { FileEntry } from '@/domain/types/domain';
import { useTheme } from '@/adapters/platform/theme';
import {
  DIR_GLYPH,
  detectFileKind,
  fileKindColor,
  fileKindGlyph,
  formatFileSize,
  formatRelativeTime,
  isSensitiveFile,
} from './fileMeta';

export interface FileRowProps {
  entry: FileEntry;
  /** 行高（密度三档 44/48/56，R2UX-06-01） */
  rowHeight: number;
  /** 点击（目录 = 进入；文件 = 打开预览） */
  onPress: (entry: FileEntry) => void;
}

/** 行 meta 文案（文件：大小 · 相对时间；目录：空，F4-F17） */
export function rowMetaText(entry: FileEntry, nowMs: number): string {
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
  rowHeight,
  onPress,
}: FileRowProps) {
  const theme = useTheme();
  const kind = detectFileKind(entry.name);
  const glyph = entry.isDir ? DIR_GLYPH : fileKindGlyph(kind);
  const glyphColor = entry.isDir ? theme.textSecondary : fileKindColor(kind);
  const meta = rowMetaText(entry, Date.now());
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
        { height: rowHeight, borderBottomColor: theme.hairline },
        pressed && styles.pressed,
      ]}
    >
      <Text
        testID="file-row-glyph"
        style={[styles.glyph, { color: glyphColor }]}
      >
        {glyph}
      </Text>
      <Text
        testID="file-row-name"
        numberOfLines={1}
        style={[styles.name, { color: theme.textPrimary }]}
      >
        {entry.name}
      </Text>
      {sensitive ? (
        <Text
          testID="file-row-sensitive"
          style={[styles.sensitive, { color: theme.colorWarning }]}
        >
          敏感
        </Text>
      ) : null}
      {meta ? (
        <Text
          testID="file-row-meta"
          numberOfLines={1}
          style={[styles.meta, { color: theme.textTertiary }]}
        >
          {meta}
        </Text>
      ) : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  pressed: {
    opacity: 0.7,
  },
  glyph: {
    width: 28,
    fontSize: 16,
    textAlign: 'center',
  },
  name: {
    flex: 1,
    fontSize: 14,
  },
  sensitive: {
    fontSize: 11,
    fontWeight: '600',
  },
  meta: {
    maxWidth: 120,
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
});
