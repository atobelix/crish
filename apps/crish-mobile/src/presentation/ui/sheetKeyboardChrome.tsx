// Sheet 键盘壳：选择型与输入型拆开，避免选择面板订阅键盘。
// 选择型打开时只发一次收起，不读键盘高度。
// 输入型保留库版避让，并订阅高度供测试与后续垫高判断。
import { useEffect, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { KeyboardAvoidingView, KeyboardController } from 'react-native-keyboard-controller';
import { useKeyboardHeight } from '@/adapters/platform/useKeyboardHeight';

export function SelectionSheetChrome({
  visible,
  children,
}: {
  visible: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!visible) return;
    void KeyboardController.dismiss();
  }, [visible]);
  return <View style={styles.flex}>{children}</View>;
}

export function SheetChrome({
  keyboard,
  visible,
  children,
}: {
  keyboard: 'input' | 'none';
  visible: boolean;
  children: ReactNode;
}) {
  if (keyboard === 'input') return <InputSheetChrome>{children}</InputSheetChrome>;
  return <SelectionSheetChrome visible={visible}>{children}</SelectionSheetChrome>;
}

export function InputSheetChrome({ children }: { children: ReactNode }) {
  const keyboardHeight = useKeyboardHeight();
  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior="padding"
      testID={
        keyboardHeight > 0
          ? 'sheet-keyboard-avoiding-active'
          : 'sheet-keyboard-avoiding'
      }
    >
      {children}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
});
