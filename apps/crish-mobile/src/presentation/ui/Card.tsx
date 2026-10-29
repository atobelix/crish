// 卡片：无描边、无阴影，靠底色与大圆角区分层级。
// subtle：白底页面上的浅灰卡；grouped：浅灰分组页（canvasGrouped）上的白卡。
import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';

export type CardTone = 'subtle' | 'grouped';

export interface CardProps {
  children: ReactNode;
  padded?: boolean;
  tone?: CardTone;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Card({
  children,
  padded = true,
  tone = 'subtle',
  style,
  testID,
}: CardProps) {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      style={[
        styles.card,
        {
          borderRadius: theme.radius.card,
          backgroundColor:
            tone === 'grouped'
              ? theme.colors.surfaceGrouped
              : theme.colors.fillSubtle,
          padding: padded ? theme.space.lg : 0,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    overflow: 'hidden',
  },
});

export default Card;
