// 确认弹窗原子组件（M4 §6.3 Dialog 规范：标题 + 后果说明 + 主按钮 + 取消）
// - 自研 overlay（不用 RN Modal，避免平台宿主差异与测试盲区；视觉语义对齐居中确认框）；
// - 遮罩点击 / 返回等价操作经 onDismiss 取消（M4 §6.3：Esc/遮罩点击/返回键取消）；
// - 主按钮默认不聚焦（M4 §6.3 防误触回车）；危险动作主按钮用 danger 红底。
import { StyleSheet, Text, View } from 'react-native';
import { Pressable } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import Button from './Button';

export interface DialogAction {
  label: string;
  variant: 'primary' | 'secondary' | 'danger';
  onPress: () => void;
  testID?: string;
}

export interface DialogProps {
  visible: boolean;
  title: string;
  /** 后果说明（1-2 句，确认文案模板「操作名 + 对象 + 后果 + 可操作动作」，M4 §6.3） */
  description?: string;
  actions: DialogAction[];
  onDismiss: () => void;
  testID?: string;
}

export default function Dialog({
  visible,
  title,
  description,
  actions,
  onDismiss,
  testID,
}: DialogProps) {
  const theme = useTheme();
  if (!visible) return null;

  return (
    <View
      testID={testID ?? 'dialog-overlay'}
      accessibilityViewIsModal
      style={[styles.overlay, { backgroundColor: theme.backdrop }]}
    >
      <Pressable
        testID="dialog-backdrop"
        style={StyleSheet.absoluteFill}
        accessibilityRole="button"
        accessibilityLabel="关闭弹窗"
        onPress={onDismiss}
      />
      <View style={[styles.card, { backgroundColor: theme.bgElevated }]}>
        <Text style={[styles.title, { color: theme.textPrimary }]}>
          {title}
        </Text>
        {description ? (
          <Text style={[styles.description, { color: theme.textSecondary }]}>
            {description}
          </Text>
        ) : null}
        <View style={styles.actions}>
          {actions.map((action) => (
            <Button
              key={action.label}
              label={action.label}
              variant={action.variant}
              onPress={action.onPress}
              testID={action.testID}
              style={styles.actionButton}
            />
          ))}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 1000,
    elevation: 20,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    borderRadius: 16,
    padding: 16,
    minWidth: 260,
    maxWidth: 340,
    gap: 12,
  },
  title: {
    fontSize: 17,
    fontWeight: '600',
  },
  description: {
    fontSize: 13,
    lineHeight: 20,
  },
  actions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  actionButton: {
    flex: 1,
  },
});
