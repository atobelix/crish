// 模型展示名单字段编辑底抽屉（DisplayNameSheet）
// 详情「基础」组的展示名编辑点：只编辑 displayName 一个字段；留空保存 =
// 未设置（undefined），界面回落显示模型 ID 本身。输入型 Sheet
// （keyboard="input"）；文本输入不挂 useSheetSearchRaise（那只给搜索框）。
import { useEffect, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { AppText, Button, Sheet } from '@/presentation/ui';

export interface DisplayNameSheetProps {
  visible: boolean;
  onClose: () => void;
  /** 模型真实 ID（留空回落提示用） */
  modelId: string;
  displayName?: string;
  onApply: (displayName: string | undefined) => void;
  testID?: string;
}

export function DisplayNameSheet({
  visible,
  onClose,
  modelId,
  displayName,
  onApply,
  testID = 'display-name-sheet',
}: DisplayNameSheetProps) {
  const theme = useTheme();
  const [text, setText] = useState(displayName ?? '');
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (visible) {
      setText(displayName ?? '');
    }
  }, [visible, displayName]);

  const handleApply = () => {
    const trimmed = text.trim();
    onApply(trimmed === '' ? undefined : trimmed);
    onClose();
  };

  return (
    <Sheet
      keyboard="input"
      visible={visible}
      onClose={onClose}
      title="展示名"
      size="medium"
      testID={testID}
      footer={
        <Button
          testID={`${testID}-apply`}
          label="确定保存"
          variant="primary"
          onPress={handleApply}
        />
      }
    >
      <View style={styles.container}>
        <View
          style={[
            styles.inputBox,
            {
              borderRadius: theme.radius.control,
              backgroundColor: focused
                ? theme.colors.fieldFocus
                : theme.colors.fillSubtle,
              height: theme.size.touchLarge,
              paddingHorizontal: theme.space.md,
            },
          ]}
        >
          <TextInput
            testID={`${testID}-input`}
            style={[
              styles.input,
              theme.type.body,
              { color: theme.colors.textPrimary },
            ]}
            value={text}
            onChangeText={setText}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={modelId}
            placeholderTextColor={theme.colors.textTertiary}
            selectionColor={theme.colors.textPrimary}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="展示名输入框"
          />
        </View>
        <AppText
          variant="footnote"
          color="textTertiary"
          style={{ marginTop: theme.space.sm }}
        >
          留空则显示模型 ID 本身
        </AppText>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  container: {
    alignSelf: 'stretch',
  },
  inputBox: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  input: {
    flex: 1,
    paddingVertical: 0,
  },
});

export default DisplayNameSheet;
