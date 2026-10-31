// 账号页顶栏：左侧返回圆钮、居中 17/600 标题、右侧可选操作位（如「保存」）。
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
        style={styles.title}
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
