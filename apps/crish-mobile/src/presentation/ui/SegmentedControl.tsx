// 分段控件：2–4 项；选中块表面色 + 细描边，其余透明。
import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import AppText from './AppText';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  testID?: string;
}

export interface SegmentedControlProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  testID?: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  testID,
}: SegmentedControlProps<T>) {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      style={[
        styles.track,
        {
          borderRadius: theme.radius.pill,
          backgroundColor: theme.colors.fillSubtle,
        },
      ]}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            testID={option.testID}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={option.label}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => [
              styles.option,
              { borderRadius: theme.radius.pill },
              active && [
                styles.selected,
                {
                  backgroundColor: theme.colors.surface,
                  borderColor: theme.colors.hairline,
                },
              ],
              pressed && !active && { opacity: 0.65 },
            ]}
          >
            <AppText
              variant="footnote"
              color={active ? 'textPrimary' : 'textSecondary'}
              style={active ? styles.selectedText : undefined}
            >
              {option.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    padding: 3,
    gap: 2,
  },
  option: {
    flex: 1,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'transparent',
    paddingHorizontal: 8,
  },
  selected: {
    borderWidth: 1,
  },
  selectedText: {
    fontWeight: '600',
  },
});

export default SegmentedControl;
