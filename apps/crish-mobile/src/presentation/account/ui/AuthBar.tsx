// 账号页顶栏：左侧返回白圆钮、居中标题 15.5/600、右侧可选操作位（如「保存」）。
// 视觉口径与设置族悬浮顶栏一致（白圆钮 + 纯文字标题）；账号页为短表单页，
// 内容不滚动穿行，顶栏保留流内布局（高度 52），不做绝对悬浮。
// 返回钮统一 IconButton floating（GlassBackButton 重复实现已删除，实现波总方案 G4）。
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { AppText, IconButton } from '@/presentation/ui';

export interface AuthBarProps {
  title?: string;
  onBack?: () => void;
  right?: ReactNode;
}

export function AuthBar({ title, onBack, right }: AuthBarProps) {
  const theme = useTheme();
  const side = { minWidth: theme.size.iconButton };
  return (
    <View
      style={[
        styles.bar,
        { height: theme.size.header, paddingHorizontal: theme.space.lg },
      ]}
    >
      <View style={side}>
        {onBack ? (
          <IconButton
            name="chevron-left"
            variant="floating"
            tone="step"
            accessibilityLabel="返回"
            onPress={onBack}
            testID="auth-bar-back"
          />
        ) : null}
      </View>
      <AppText
        variant="headline"
        color="textPrimary"
        numberOfLines={1}
        accessibilityRole="header"
        testID="auth-bar-title"
        style={[
          styles.title,
          { fontSize: (theme.type.headline.fontSize ?? 0) - 0.5 },
        ]}
      >
        {title ?? ''}
      </AppText>
      <View style={[side, styles.right]}>{right}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center' },
  title: { flex: 1, textAlign: 'center' },
  right: { alignItems: 'flex-end' },
});

export default AuthBar;
