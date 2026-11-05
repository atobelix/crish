// 已选附件条（G5b）：Composer 上方的横向已选区。
// - 图片：56×56 缩略图（圆角 sm）；文本/普通文件：图标 + 文件名名片卡
//   （文本文件超长截断时带「已截断」标注，组装层按 80000 字符截断）；
// - 每项右上 × 逐个移除（宿主 remove）；发送失败保留、成功清空的
//   生命周期由宿主 VM 管理，本组件只呈现；
// - 进出场走 Collapsible 原语（批 A，2026-11-03）：共享值直驱
//   height+opacity 同曲线收展，不再条件渲染硬切（旧形态附件一出现
//   悬浮区高度「啪」地跳一档）；空列表且未在导入时整体卸载。
// - 导入进度（批 A，2026-11-03）：picking 在途时行尾出一枚导入中
//   tile（Spinner + 文案）——选取/压缩是异步长尾，进度必须可见、
//   不许静默（旧形态只有 VM 里的 picking 布尔，界面零呈现）。
import { memo } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useTheme } from '@/adapters/platform/theme';
import { AppText, Collapsible, Icon, Spinner } from '@/presentation/ui';
import { usePressFade } from '@/presentation/ui/pressFeedback';
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
  /** 附件导入在途（选择器/压缩处理中）：行尾呈现导入中 tile */
  picking?: boolean;
  testID?: string;
}

export const AttachmentStrip = memo(function AttachmentStrip({
  attachments,
  onRemove,
  picking = false,
  testID = 'attachment-strip',
}: AttachmentStripProps) {
  const theme = useTheme();
  return (
    <Collapsible visible={attachments.length > 0 || picking}>
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
            <RemoveAttachmentButton
              testID={`${testID}-remove-${attachment.id}`}
              name={attachment.name}
              onPress={() => onRemove(attachment.id)}
              hitSlop={theme.space.xs}
            />
          </View>
        ))}
        {picking ? (
          <View
            testID={`${testID}-picking`}
            style={[
              styles.pickingTile,
              {
                height: THUMB_SIZE,
                borderRadius: theme.radius.sm,
                backgroundColor: theme.colors.fillSubtle,
                gap: theme.space.xs,
                paddingHorizontal: theme.space.md,
              },
            ]}
          >
            <Spinner />
            <AppText variant="caption" color="textSecondary">
              导入中…
            </AppText>
          </View>
        ) : null}
      </ScrollView>
    </Collapsible>
  );
});

/** 附件移除钮（列表项内独立组件：按压叠层 hook 不得进 map 回调） */
function RemoveAttachmentButton({
  testID,
  name,
  onPress,
  hitSlop,
}: {
  testID: string;
  name: string;
  onPress: () => void;
  hitSlop: number;
}) {
  const theme = useTheme();
  const press = usePressFade();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`移除附件 ${name}`}
      onPress={onPress}
      hitSlop={hitSlop}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      style={[
        styles.remove,
        {
          width: REMOVE_SIZE,
          height: REMOVE_SIZE,
          borderRadius: theme.radius.pill,
          backgroundColor: theme.colors.fillSubtle,
        },
      ]}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            borderRadius: theme.radius.pill,
            backgroundColor: theme.colors.fillPressed,
          },
          press.overlayStyle,
        ]}
      />
      <Icon
        name="x"
        size={theme.size.iconSmall - 4}
        color={theme.colors.textTertiary}
      />
    </Pressable>
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
  pickingTile: {
    flexDirection: 'row',
    alignItems: 'center',
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
