// 全局未匹配路由兜底（实现波总方案 E3）：品牌化极简 404，替代框架内置英文调试页。
// 无大图标（U10），仅主题排版文字 + 返回首页按钮；深链坏死不再白屏困死。
import { StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { AppText, Button } from '@/presentation/ui';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';

export default function NotFoundRoute() {
  const theme = useTheme();
  const goBack = useSafeBack();
  return (
    <View
      style={[
        styles.root,
        { backgroundColor: theme.colors.canvas, gap: theme.space.md },
      ]}
    >
      <AppText variant="title" color="textPrimary">
        页面不存在
      </AppText>
      <AppText variant="body" color="textSecondary">
        这个链接没有对应的内容，可能已被移除。
      </AppText>
      <Button
        label="返回首页"
        variant="primary"
        onPress={goBack}
        testID="not-found-back"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
});
