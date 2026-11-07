// 移动端规格配置底抽屉：TokenPresetSheet
// 遵循 docs/mobile-provider-architecture/analysis/01-prototype-ui-ux-spec.md 与 05-rn-components-and-gestures.md
// 上部单行数字输入盒（带单位 Tokens 后缀）+ 下部常用阶梯预设胶囊横向滚动行 + 底部确定保存主按钮。
import { useEffect, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { haptics } from '@/adapters/platform/haptics';
import { AppText, Button, Sheet, useSheetSearchRaise } from '@/presentation/ui';

export interface TokenPresetSheetProps {
  visible: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  value: number | undefined;
  unit?: string;
  presets: number[];
  onApply: (val: number) => void;
  /** 兼容契约（底座 Sheet 语义档位，默认 medium） */
  snapPoints?: readonly (string | number)[];
  testID?: string;
}

/** 格式化阶梯预设简短标签（如 131072 -> 128k, 200000 -> 200k, 1048576 -> 1M） */
export function formatTokenPreset(val: number): string {
  if (val >= 1048576 && val % 1048576 === 0) {
    return `${val / 1048576}M`;
  }
  if (val >= 1000000 && val % 1000000 === 0) {
    return `${val / 1000000}M`;
  }
  if (val >= 1024 && val % 1024 === 0) {
    return `${val / 1024}k`;
  }
  if (val >= 1000 && val % 1000 === 0) {
    return `${val / 1000}k`;
  }
  return String(val);
}

export function TokenPresetSheet({
  visible,
  onClose,
  title,
  subtitle,
  value,
  unit = 'Tokens',
  presets,
  onApply,
  snapPoints: _snapPoints,
  testID = 'token-preset-sheet',
}: TokenPresetSheetProps) {
  const theme = useTheme();
  const searchRaise = useSheetSearchRaise();
  const [inputText, setInputText] = useState(
    value != null ? String(value) : ''
  );
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (visible) {
      setInputText(value != null ? String(value) : '');
    }
  }, [visible, value]);

  const currentVal = parseInt(inputText, 10);

  const handleApply = () => {
    const parsed = parseInt(inputText, 10);
    const finalVal = Number.isFinite(parsed) ? parsed : (value ?? 0);
    onApply(finalVal);
    onClose();
  };

  const handleSelectPreset = (presetVal: number) => {
    setInputText(String(presetVal));
    haptics.selection();
  };

  // 胶囊配色：遵循原型与规范——激活为深黑/纯白高亮，未激活为浅灰胶囊
  const activeBg = theme.colors.bubbleUser;
  const activeText = theme.colors.bubbleUserText;
  const inactiveBg = theme.colors.fillSubtle;
  const inactiveText = theme.colors.textSecondary;

  return (
    <Sheet
      keyboard="input"
      visible={visible}
      onClose={onClose}
      title={title}
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
        {subtitle ? (
          <AppText
            variant="footnote"
            color="textSecondary"
            style={[styles.subtitle, { marginBottom: theme.space.md }]}
          >
            {subtitle}
          </AppText>
        ) : null}

        {/* 上部单行数字输入盒 */}
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
            value={inputText}
            onChangeText={(text) => setInputText(text.replace(/[^\d]/g, ''))}
            onFocus={() => {
              setFocused(true);
              searchRaise.onFocus();
            }}
            onBlur={() => {
              setFocused(false);
              searchRaise.onBlur();
            }}
            keyboardType="number-pad"
            placeholder="0"
            placeholderTextColor={theme.colors.textTertiary}
            selectionColor={theme.colors.textPrimary}
            accessibilityLabel={`${title}输入框`}
          />
          <AppText
            variant="footnote"
            color="textTertiary"
            style={styles.unitText}
          >
            {unit}
          </AppText>
        </View>

        {/* 下部预设胶囊横向滚动行 */}
        <View style={[styles.presetsSection, { marginTop: theme.space.md }]}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={[
              styles.pillsScrollContent,
              { gap: theme.space.xs },
            ]}
          >
            {presets.map((preset) => {
              const isActive =
                Number.isFinite(currentVal) && currentVal === preset;
              return (
                <Pressable
                  key={preset}
                  testID={`${testID}-pill-${preset}`}
                  accessibilityRole="button"
                  accessibilityLabel={`${formatTokenPreset(preset)} ${unit}`}
                  accessibilityState={{ selected: isActive }}
                  onPress={() => handleSelectPreset(preset)}
                  style={[
                    styles.pill,
                    {
                      borderRadius: theme.radius.pill,
                      backgroundColor: isActive ? activeBg : inactiveBg,
                      paddingHorizontal: theme.space.md,
                      paddingVertical: theme.space.xs + 2,
                    },
                  ]}
                >
                  <AppText
                    variant="caption"
                    style={[
                      styles.pillText,
                      {
                        color: isActive ? activeText : inactiveText,
                        fontWeight: isActive ? '600' : '500',
                      },
                    ]}
                  >
                    {formatTokenPreset(preset)}
                  </AppText>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  container: {
    alignSelf: 'stretch',
  },
  subtitle: {
    paddingHorizontal: 2,
  },
  inputBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  input: {
    flex: 1,
    paddingVertical: 0,
    marginRight: 8,
  },
  unitText: {
    fontWeight: '400',
  },
  presetsSection: {
    alignSelf: 'stretch',
  },
  pillsScrollContent: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 2,
  },
  pill: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 32,
  },
  pillText: {
    includeFontPadding: false,
  },
});

export default TokenPresetSheet;
