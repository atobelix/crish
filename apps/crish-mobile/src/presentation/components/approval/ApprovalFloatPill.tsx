// 审批悬浮卡的收起态：「● N 个待审批 · m:ss」，点按展开。
// 浮层阴影（容器外阴影批，2026-11-02）：悬浮白胶囊走 SoftShadowSurface
// button 档（--btn-shadow），仅 Android 浅色渲染；按压叠层 120ms 过渡。
import { Pressable, StyleSheet } from 'react-native';
import Animated from 'react-native-reanimated';
import { useTheme } from '@/adapters/platform/theme';
import { AppText, Badge, SoftShadowSurface } from '@/presentation/ui';
import { usePressFade } from '@/presentation/ui/pressFeedback';
import { formatRemainingMs } from '@/presentation/components/blocks/ApprovalCard';

export interface ApprovalFloatPillProps {
  count: number;
  remainingMs: number;
  onExpand: () => void;
}

export function ApprovalFloatPill({
  count,
  remainingMs,
  onExpand,
}: ApprovalFloatPillProps) {
  const theme = useTheme();
  const press = usePressFade();
  const label = `${count} 个待审批 · ${formatRemainingMs(remainingMs)}`;
  return (
    <Pressable
      testID="approval-float-pill"
      accessibilityRole="button"
      accessibilityLabel={`${label}，展开审批`}
      onPress={onExpand}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
    >
      <SoftShadowSurface
        preset="button"
        borderRadius={theme.radius.pill}
        fill={theme.colors.surfaceRaised}
        fillStyle={{
          minHeight: theme.size.touch,
          paddingHorizontal: theme.space.lg,
          gap: theme.space.sm,
          flexDirection: 'row',
          alignItems: 'center',
        }}
      >
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: theme.colors.fillPressed },
            press.overlayStyle,
          ]}
        />
        <Badge dot tone="warning" />
        <AppText variant="footnote" style={styles.tabular}>
          {label}
        </AppText>
      </SoftShadowSurface>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tabular: { fontVariant: ['tabular-nums'] },
});

export default ApprovalFloatPill;
