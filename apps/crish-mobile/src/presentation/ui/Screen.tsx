// 页面容器：统一背景、安全区与键盘避让。
import type { ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';

export interface ScreenProps {
  children: ReactNode;
  /** 是否避让键盘（表单 / composer 页） */
  avoidKeyboard?: boolean;
  /** 是否自行处理顶部安全区（默认 false；配合 AppHeader 使用） */
  topInset?: boolean;
  /** 是否处理底部安全区（默认 false；底部操作栏自行处理） */
  bottomInset?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Screen({
  children,
  avoidKeyboard = false,
  topInset = false,
  bottomInset = false,
  style,
  testID,
}: ScreenProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const content = (
    <View
      testID={testID}
      style={[
        styles.flex,
        {
          backgroundColor: theme.colors.canvas,
          paddingTop: topInset ? insets.top : 0,
          paddingBottom: bottomInset ? insets.bottom : 0,
          paddingLeft: insets.left,
          paddingRight: insets.right,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
  if (!avoidKeyboard) return content;
  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {content}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
});

export default Screen;
