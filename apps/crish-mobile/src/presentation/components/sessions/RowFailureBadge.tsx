// 会话行失败徽标（批 D，远端/本地行共用）：alert-circle 危险色图标 +
// 「失败」弱文字——与 SessionListItem 的待审批徽标同盒（点/图标 + 弱
// 文字、字号自 caption 派生），只是状态语义与色不同。失败承载决策
// 关键状态（这条会话上一轮挂了、需要用户看一眼），在内容净化口径
// 的保留面内，故给文字而不只给点；已完成态不设对应徽标（裁决）。
import { StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { AppText, Icon } from '@/presentation/ui';

export function RowFailureBadge({ testID }: { testID?: string }) {
  const theme = useTheme();
  return (
    <View testID={testID} style={[styles.badge, { gap: theme.space.xs + 1 }]}>
      <Icon name="alert-circle" size={12} color={theme.colors.danger} />
      <AppText
        variant="caption"
        color="danger"
        style={{
          // 与待审批徽标文字同档（原型徽标文字 10.5/400，自 caption 派生）
          fontSize: theme.type.caption.fontSize - 2,
          lineHeight: theme.type.caption.lineHeight - 2,
        }}
      >
        失败
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { flexDirection: 'row', alignItems: 'center' },
});

export default RowFailureBadge;
