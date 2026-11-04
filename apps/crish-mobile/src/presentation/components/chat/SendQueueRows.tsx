// 生成中排队行（批 C 01-4/②）：composer 上方的待发队列呈现——逐条
// 编号、内容预览、逐条可撤回（撤回 = 该条不再发送，已发出的不受
// 影响）。两引擎（远端/本地）共用同一组件，队列数据面 =
// sendQueueStore（按会话键隔离 + 持久化）。
import { StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import type { SendQueueItem } from '@/domain/store/sendQueueStore';
import { AppText, Icon } from '@/presentation/ui';
import {
  AnimatedPressable,
  usePressFade,
} from '@/presentation/ui/pressFeedback';

/** 队列行内容预览：文本优先；纯附件条目以附件名呈现（不留空行） */
export function sendQueueItemPreview(item: SendQueueItem): string {
  const text = item.text.trim();
  const attachmentCount = item.attachments.length;
  if (text !== '') {
    return attachmentCount > 0
      ? `${text}（含 ${attachmentCount} 个附件）`
      : text;
  }
  if (attachmentCount > 0) {
    const first = item.attachments[0]!;
    return attachmentCount > 1
      ? `${first.name} 等 ${attachmentCount} 个附件`
      : first.name;
  }
  return '';
}

export interface SendQueueRowsProps {
  items: readonly SendQueueItem[];
  onWithdraw: (itemId: string) => void;
}

export function SendQueueRows({ items, onWithdraw }: SendQueueRowsProps) {
  const theme = useTheme();
  if (items.length === 0) return null;
  return (
    <View
      testID="send-queue"
      style={{ gap: theme.space.xs, marginBottom: theme.space.sm }}
    >
      {items.map((item, index) => (
        <SendQueueRow
          key={item.id}
          item={item}
          index={index}
          onWithdraw={onWithdraw}
        />
      ))}
    </View>
  );
}

function SendQueueRow({
  item,
  index,
  onWithdraw,
}: {
  item: SendQueueItem;
  index: number;
  onWithdraw: (itemId: string) => void;
}) {
  const theme = useTheme();
  const withdrawPress = usePressFade();
  return (
    <View
      testID="send-queue-row"
      style={[
        styles.row,
        {
          backgroundColor: theme.colors.surface,
          borderRadius: theme.radius.menu,
          paddingHorizontal: theme.space.md,
          paddingVertical: theme.space.sm,
          gap: theme.space.sm,
        },
      ]}
    >
      <AppText variant="caption" color="textTertiary">
        {index + 1}
      </AppText>
      <AppText
        variant="footnote"
        color="textPrimary"
        numberOfLines={1}
        style={styles.flex}
      >
        {sendQueueItemPreview(item)}
      </AppText>
      <AnimatedPressable
        testID={`send-queue-withdraw-${item.id}`}
        accessibilityRole="button"
        accessibilityLabel="撤回排队消息"
        onPress={() => onWithdraw(item.id)}
        onPressIn={withdrawPress.onPressIn}
        onPressOut={withdrawPress.onPressOut}
        hitSlop={theme.space.sm}
        style={withdrawPress.fadeStyle}
      >
        <Icon name="x" size={14} />
      </AnimatedPressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
