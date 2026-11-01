// 轻量 Toast：操作结果反馈；墨色胶囊悬浮在顶部（原型 toast-pill），2.5s 自动消失。
// 墨色底上统一用反色前景；语气由「成功/警示」圆点符号区分（info 无符号）。
// Reanimated 进出场（顶部下滑入 / 上滑出，实现波总方案 F5）；
// displayMs 走 theme.motion.toast 单一真源。
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import Animated, { FadeInDown, FadeOutUp } from 'react-native-reanimated';
import AppText from './AppText';
import Icon from './Icon';

export type ToastTone = 'success' | 'error' | 'info';

interface ToastState {
  message: string;
  tone: ToastTone;
}

interface ToastContextValue {
  showToast: (message: string, tone?: ToastTone) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback(
    (message: string, tone: ToastTone = 'info') => {
      if (timer.current) clearTimeout(timer.current);
      setToast({ message, tone });
      timer.current = setTimeout(() => {
        setToast(null);
        timer.current = null;
      }, theme.motion.toast.displayMs);
    },
    [theme.motion.toast.displayMs]
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const icon: 'check' | 'alert-circle' | null =
    toast?.tone === 'error'
      ? 'alert-circle'
      : toast?.tone === 'success'
        ? 'check'
        : null;

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {toast ? (
        <Animated.View
          pointerEvents="none"
          entering={FadeInDown.springify().damping(20)}
          exiting={FadeOutUp.duration(theme.motion.duration.fast)}
          style={[
            styles.host,
            {
              // 顶部安全区下方，下滑入；不与头栏白圆钮争位
              top: insets.top + theme.space.xl,
              minHeight: theme.size.summaryRow,
              borderRadius: theme.radius.pill,
              paddingHorizontal: theme.space.lg,
              paddingVertical: theme.space.sm,
              gap: theme.space.sm,
              backgroundColor: theme.colors.actionPrimary,
            },
          ]}
        >
          {icon ? (
            <Icon
              name={icon}
              size={theme.size.iconSmall}
              color={theme.colors.actionPrimaryText}
            />
          ) : null}
          <AppText
            variant="footnote"
            color="actionPrimaryText"
            numberOfLines={2}
            style={styles.text}
          >
            {toast.message}
          </AppText>
        </Animated.View>
      ) : null}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    alignSelf: 'center',
    maxWidth: '86%',
    flexDirection: 'row',
    alignItems: 'center',
  },
  text: {
    flexShrink: 1,
  },
});

export default ToastProvider;
