// 页面大标题（28/36 粗体）+ 可选说明；左右留 24，与输入区对齐。
import { View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { AppText } from '@/presentation/ui';

export interface BigTitleProps {
  title: string;
  subtitle?: string;
}

export function BigTitle({ title, subtitle }: BigTitleProps) {
  const theme = useTheme();
  return (
    <View
      style={{
        paddingTop: theme.layout.fieldPadding,
        paddingHorizontal: theme.layout.accountPageX,
      }}
    >
      <AppText
        variant="bigTitle"
        color="textPrimary"
        accessibilityRole="header"
      >
        {title}
      </AppText>
      {subtitle ? (
        <AppText
          variant="callout"
          color="textSecondary"
          style={{ marginTop: theme.space.sm }}
        >
          {subtitle}
        </AppText>
      ) : null}
    </View>
  );
}

export default BigTitle;
