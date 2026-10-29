// 确认弹窗：真实 Modal；标题 + 可选正文 + 纵向动作。
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import AppText from './AppText';
import Button, { type ButtonVariant } from './Button';

export interface DialogAction {
  label: string;
  variant: ButtonVariant;
  onPress: () => void;
  testID?: string;
}

export interface DialogProps {
  visible: boolean;
  title: string;
  description?: string;
  actions: readonly DialogAction[];
  onDismiss: () => void;
  testID?: string;
}

export function Dialog({
  visible,
  title,
  description,
  actions,
  onDismiss,
  testID,
}: DialogProps) {
  const theme = useTheme();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onDismiss}
      statusBarTranslucent
    >
      <View style={[styles.overlay, { padding: theme.space.xxl }]}>
        <Pressable
          testID="dialog-backdrop"
          accessibilityRole="button"
          accessibilityLabel="关闭"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: theme.colors.scrim },
          ]}
          onPress={onDismiss}
        />
        <View
          testID={testID ?? 'dialog'}
          accessibilityViewIsModal
          style={[
            styles.card,
            {
              maxWidth: theme.layout.dialogMaxWidth,
              borderRadius: theme.radius.xl,
              padding: theme.space.xl,
              gap: theme.space.md,
              backgroundColor: theme.colors.surfaceRaised,
            },
            theme.shadow.lg,
          ]}
        >
          <AppText variant="title2">{title}</AppText>
          {description ? (
            <AppText variant="body" color="textSecondary">
              {description}
            </AppText>
          ) : null}
          <View style={{ gap: theme.space.sm, marginTop: theme.space.sm }}>
            {actions.map((action) => (
              <Button
                key={action.label}
                label={action.label}
                variant={action.variant}
                onPress={action.onPress}
                testID={action.testID}
              />
            ))}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    width: '100%',
  },
});

export default Dialog;
