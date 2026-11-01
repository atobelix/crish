// 悬浮胶囊输入条（主屏平铺列表页与会话页共用）。
// 原型规范：圆角恒定 26（与高度解耦）、纯白底零描边、微柔浮雕阴影；
// 多行自适应增高，底部只有输入框 + 发送（无附件/语音——协议无对应能力，诚实化）。
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import Icon from './Icon';

export interface ComposerProps {
  value: string;
  onChangeText: (text: string) => void;
  onSubmit: () => void;
  canSubmit: boolean;
  editable: boolean;
  placeholder: string;
  maxLength?: number;
  /** 输入框 testID；发送钮为 `${testID}-send` */
  testID?: string;
}

export function Composer({
  value,
  onChangeText,
  onSubmit,
  canSubmit,
  editable,
  placeholder,
  maxLength,
  testID,
}: ComposerProps) {
  const theme = useTheme();
  const { colors, radius, size, space } = theme;
  return (
    <View
      style={[
        styles.shell,
        {
          minHeight: size.composerMin,
          borderRadius: radius.composer,
          backgroundColor: colors.surface,
          paddingLeft: space.lg,
          paddingRight: space.sm,
          paddingVertical: space.sm,
          gap: space.sm,
        },
        theme.shadow.sm,
      ]}
    >
      <TextInput
        testID={testID}
        multiline
        value={value}
        onChangeText={onChangeText}
        editable={editable}
        maxLength={maxLength}
        placeholder={placeholder}
        placeholderTextColor={colors.textTertiary}
        style={[
          styles.input,
          theme.type.body,
          {
            color: colors.textPrimary,
            maxHeight: theme.layout.composerInputMaxHeight,
          },
        ]}
      />
      <Pressable
        testID={testID ? `${testID}-send` : undefined}
        accessibilityRole="button"
        accessibilityLabel="发送"
        accessibilityState={{ disabled: !canSubmit }}
        disabled={!canSubmit}
        onPress={onSubmit}
        style={({ pressed }) => [
          styles.send,
          {
            width: size.sendButton,
            height: size.sendButton,
            borderRadius: radius.pill,
            backgroundColor: canSubmit
              ? colors.actionPrimary
              : colors.actionDisabled,
          },
          pressed && { transform: [{ scale: theme.motion.pressScale }] },
        ]}
      >
        <Icon
          name="send"
          size={size.iconSmall}
          color={canSubmit ? colors.actionPrimaryText : colors.textDisabled}
        />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  input: {
    flex: 1,
    alignSelf: 'center',
    paddingVertical: 0,
    textAlignVertical: 'center',
  },
  send: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default Composer;
