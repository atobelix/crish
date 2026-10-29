// 账号 v3 页面骨架：浅灰底（canvas）、处理上下安全区与键盘避让；全程无阴影。
import type { ReactNode } from 'react';
import { useTheme } from '@/adapters/platform/theme';
import { Screen } from '@/presentation/ui';

export interface AuthPageProps {
  children: ReactNode;
  testID?: string;
}

export function AuthPage({ children, testID }: AuthPageProps) {
  const theme = useTheme();
  return (
    <Screen
      avoidKeyboard
      topInset
      bottomInset
      testID={testID}
      style={{ backgroundColor: theme.colors.canvas }}
    >
      {children}
    </Screen>
  );
}

export default AuthPage;
