// 已选附件条（G5b）：Composer 上方的横向已选区。
// - 图片：56×56 缩略图（圆角 sm）；文本/普通文件：图标 + 文件名名片卡
//   （文本文件超长截断时带「已截断」标注，组装层按 80000 字符截断）；
// - 每项右上 × 逐个移除（宿主 remove）；发送失败保留、成功清空的
//   生命周期由宿主 VM 管理，本组件只呈现；
// - 空列表不渲染（宿主区高度不跳变之外的占位不设）。
import { Image, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { AppText, Icon } from '@/presentation/ui';
import type { ComposerAttachment } from '@/domain/pure/attachments';

/** 已选区高度（宿主悬浮区高度估算用：缩略 56 + 上下呼吸） */
export const ATTACHMENT_STRIP_HEIGHT = 68;
/** 缩略图边长（theme 无 56 档，就地定值） */
const THUMB_SIZE = 56;
/** 移除钮命中盒 */
const REMOVE_SIZE = 20;

export interface AttachmentStripProps {
  attachments: readonly ComposerAttachment[];
  onRemove: (id: string) => void;
  testID?: string;
}

export function AttachmentStrip({
  attachments,
  onRemove,
  testID = 'attachment-strip',
}: AttachmentStripProps) {
  const theme = useTheme();
  if (attachments.length === 0) return null;
  return (
    <ScrollView
      testID={testID}
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ height: ATTACHMENT_STRIP_HEIGHT }}
      contentContainerStyle={[
        styles.row,
        {
          gap: theme.space.sm,
          paddingHorizontal: theme.space.lg,
          paddingTop: theme.space.sm,
        },
      ]}
    >
      {attachments.map((attachment) => (
        <View key={attachment.id} style={styles.item}>
          {attachment.kind === 'image' ? (
            <Image
              testID={`${testID}-thumb-${attachment.id}`}
              source={{
                uri: attachment.previewUri ?? attachment.dataUrl,
              }}
              style={[
                styles.thumb,
                {
                  width: THUMB_SIZE,
                  height: THUMB_SIZE,
                  borderRadius: theme.radius.sm,
                  backgroundColor: theme.colors.fillSubtle,
                },
              ]}
            />
          ) : (
            <View
              style={[
                styles.fileCard,
                {
                  height: THUMB_SIZE,
                  borderRadius: theme.radius.sm,
                  backgroundColor: theme.colors.fillSubtle,
                  gap: theme.space.xs,
                  paddingHorizontal: theme.space.md,
                },
              ]}
            >
              <View style={styles.fileTitleRow}>
                <Icon
                  name="file"
                  size={theme.size.iconSmall}
                  color={theme.colors.textSecondary}
                />
                <AppText
                  variant="footnote"
                  numberOfLines={1}
                  style={styles.fileName}
                >
                  {attachment.name}
                </AppText>
              </View>
              {attachment.kind === 'text' && attachment.textTruncated ? (
                <AppText variant="caption" color="textTertiary">
                  正文过长，发送时截断
                </AppText>
              ) : null}
            </View>
          )}
          <Pressable
            testID={`${testID}-remove-${attachment.id}`}
            accessibilityRole="button"
            accessibilityLabel={`移除附件 ${attachment.name}`}
            onPress={() => onRemove(attachment.id)}
            hitSlop={theme.space.xs}
            style={({ pressed }) => [
              styles.remove,
              {
                width: REMOVE_SIZE,
                height: REMOVE_SIZE,
                borderRadius: theme.radius.pill,
                backgroundColor: pressed
                  ? theme.colors.fillPressed
                  : theme.colors.fillSubtle,
              },
            ]}
          >
            <Icon
              name="x"
              size={theme.size.iconSmall - 4}
              color={theme.colors.textTertiary}
            />
          </Pressable>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  item: {
    position: 'relative',
  },
  thumb: {
    resizeMode: 'cover',
  },
  fileCard: {
    justifyContent: 'center',
    maxWidth: 180,
  },
  fileTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  fileName: {
    flexShrink: 1,
  },
  remove: {
    position: 'absolute',
    top: -6,
    right: -6,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default AttachmentStrip;
