// 退出登录确认 sheet：统一复用 presentation/ui/Sheet（实现波总方案 F5）。
// 删除自造 Modal + 双 Animated.Value 动画（theme.motion.account 已废除），
// 进出场/遮罩/Android 返回键/安全区全部由通用 Sheet 单一实现承载。
import { useTheme } from '@/adapters/platform/theme';
import { AppText, Sheet } from '@/presentation/ui';
import { AuthButton } from './AuthButton';

export interface SignOutSheetProps {
  visible: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function SignOutSheet({
  visible,
  busy = false,
  onConfirm,
  onCancel,
}: SignOutSheetProps) {
  const theme = useTheme();
  return (
    <Sheet
      visible={visible}
      onClose={onCancel}
      testID="sign-out-sheet"
      maxHeightRatio={0.5}
    >
      <AppText variant="headline" color="textPrimary" style={styles.center}>
        退出登录？
      </AppText>
      <AppText
        variant="footnote"
        color="textSecondary"
        style={{ ...styles.center, marginBottom: theme.space.lg }}
      >
        退出后，这台设备需要重新登录才能使用账号。
      </AppText>
      <AuthButton
        label="退出登录"
        variant="secondary"
        danger
        loading={busy}
        loadingLabel="正在退出…"
        testID="sign-out-confirm"
        onPress={onConfirm}
      />
      <AuthButton
        label="取消"
        variant="ghost"
        testID="sign-out-cancel"
        onPress={onCancel}
      />
    </Sheet>
  );
}

const styles = {
  center: { textAlign: 'center' as const },
};

export default SignOutSheet;
