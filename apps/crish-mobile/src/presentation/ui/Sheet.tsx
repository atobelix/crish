// 底部 Sheet：真实 Modal + 安全区 + 遮罩 / Android 返回关闭。
import type { ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import AppText from './AppText';
import IconButton from './IconButton';

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  /** 固定在底部的内容（如主按钮） */
  footer?: ReactNode;
  /** 内容最大高度比例（默认 0.85） */
  maxHeightRatio?: number;
  testID?: string;
}

export function Sheet({
  visible,
  onClose,
  title,
  children,
  footer,
  maxHeightRatio = 0.85,
  testID,
}: SheetProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const gutter = { paddingHorizontal: theme.space.screenX };
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.overlay}>
          <Pressable
            testID="sheet-backdrop"
            accessibilityRole="button"
            accessibilityLabel="关闭"
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: theme.colors.scrim },
            ]}
            onPress={onClose}
          />
          <View
            testID={testID}
            style={[
              {
                borderTopLeftRadius: theme.radius.sheet,
                borderTopRightRadius: theme.radius.sheet,
                backgroundColor: theme.colors.surfaceRaised,
                maxHeight: `${Math.round(maxHeightRatio * 100)}%`,
                paddingBottom: Math.max(insets.bottom, theme.space.md),
              },
              theme.shadow.lg,
            ]}
          >
            <View
              style={[
                styles.handle,
                {
                  width: theme.size.sheetHandleWidth,
                  height: theme.size.sheetHandleHeight,
                  borderRadius: theme.radius.pill,
                  marginTop: theme.space.sm,
                  backgroundColor: theme.colors.borderStrong,
                },
              ]}
            />
            {title ? (
              <View
                style={[
                  styles.header,
                  {
                    paddingLeft: theme.space.screenX,
                    paddingRight: theme.space.sm,
                    minHeight: theme.size.header,
                  },
                ]}
              >
                <AppText
                  variant="title2"
                  style={styles.title}
                  numberOfLines={1}
                >
                  {title}
                </AppText>
                <IconButton
                  name="x"
                  accessibilityLabel="关闭"
                  onPress={onClose}
                  testID="sheet-close"
                />
              </View>
            ) : null}
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={[
                gutter,
                { paddingBottom: theme.space.md },
              ]}
              keyboardShouldPersistTaps="handled"
            >
              {children}
            </ScrollView>
            {footer ? (
              <View style={[gutter, { paddingTop: theme.space.md }]}>
                {footer}
              </View>
            ) : null}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  handle: {
    alignSelf: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  title: {
    flex: 1,
  },
  scroll: {
    flexGrow: 0,
  },
});

export default Sheet;
