// 悬浮胶囊输入条（新对话空态与会话页共用）。
// 底部功能区只有输入框 + 发送；附件等能力接入前不预留入口。
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
          borderRadius: radius.pill,
          backgroundColor: colors.surfaceRaised,
          borderColor: colors.hairline,
          paddingLeft: space.lg,
          paddingRight: space.sm,
          paddingVertical: space.sm,
          gap: space.sm,
        },
        theme.shadow.md,
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
    borderWidth: StyleSheet.hairlineWidth,
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
