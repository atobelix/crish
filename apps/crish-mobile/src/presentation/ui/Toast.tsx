// 轻量 Toast：操作结果反馈；墨色胶囊悬浮在输入条上方、2.5s 自动消失。
// 墨色底上统一用反色前景，语气靠图标形状区分。
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import AppText from './AppText';
import Icon, { type IconName } from './Icon';

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

  const showToast = useCallback((message: string, tone: ToastTone = 'info') => {
    if (timer.current) clearTimeout(timer.current);
    setToast({ message, tone });
    timer.current = setTimeout(() => {
      setToast(null);
      timer.current = null;
    }, 2500);
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const icon: IconName =
    toast?.tone === 'error'
      ? 'alert-circle'
      : toast?.tone === 'success'
        ? 'check-circle'
        : 'info';

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {toast ? (
        <View
          pointerEvents="none"
          style={[
            styles.host,
            {
              // 让出底部 Composer 的高度，避免遮住输入条
              bottom: insets.bottom + theme.size.composerMin + theme.space.xl,
              minHeight: theme.size.summaryRow,
              borderRadius: theme.radius.pill,
              paddingHorizontal: theme.space.lg,
              paddingVertical: theme.space.sm,
              gap: theme.space.sm,
              backgroundColor: theme.colors.actionPrimary,
            },
            theme.shadow.md,
          ]}
        >
          <Icon
            name={icon}
            size={theme.size.iconSmall}
            color={theme.colors.actionPrimaryText}
          />
          <AppText
            variant="footnote"
            color="actionPrimaryText"
            numberOfLines={2}
            style={styles.text}
          >
            {toast.message}
          </AppText>
        </View>
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
