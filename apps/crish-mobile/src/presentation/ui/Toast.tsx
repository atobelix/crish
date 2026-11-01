// 轻量 Toast：操作结果反馈；半透明墨色胶囊悬浮在顶部（原型 toast-pill），2.5s 自动消失。
// 原型数值：底 rgba(23,23,23,0.9)、字 12.5/500、padding 6/14、阴影 0 4px 12px α0.15、无图标；
// 进出场 = 0.2s 内 opacity + top 8px 滑移（RN Animated 手动驱动，曲线走 decelerate）。
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
import { Animated, Easing, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import AppText from './AppText';

export type ToastTone = 'success' | 'error' | 'info';

interface ToastState {
  message: string;
  tone: ToastTone;
}

interface ToastContextValue {
  showToast: (message: string, tone?: ToastTone) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/** 原型 toast-pill 进出滑移量（top 56 → 64）与时长 */
const SLIDE_PX = 8;
const ANIM_MS = 200;

export function ToastProvider({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 展示序号：退出动画完成时只清属于自己的那条（连发新条时旧退出不得误清）
  const showSeq = useRef(0);
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(-SLIDE_PX)).current;

  const animateTo = useCallback(
    (visible: boolean, onDone?: () => void) => {
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: visible ? 1 : 0,
          duration: ANIM_MS,
          easing: Easing.bezier(...theme.motion.easing.decelerate),
          useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: visible ? 0 : -SLIDE_PX,
          duration: ANIM_MS,
          easing: Easing.bezier(...theme.motion.easing.decelerate),
          useNativeDriver: true,
        }),
      ]).start(({ finished }) => {
        if (finished) onDone?.();
      });
    },
    [opacity, translateY, theme.motion.easing.decelerate]
  );

  const showToast = useCallback(
    (message: string, tone: ToastTone = 'info') => {
      if (timer.current) clearTimeout(timer.current);
      showSeq.current += 1;
      const seq = showSeq.current;
      setToast({ message, tone });
      timer.current = setTimeout(() => {
        animateTo(false, () => {
          if (showSeq.current === seq) setToast(null);
        });
        timer.current = null;
      }, theme.motion.toast.displayMs);
    },
    [animateTo, theme.motion.toast.displayMs]
  );

  useEffect(() => {
    if (toast) {
      opacity.setValue(0);
      translateY.setValue(-SLIDE_PX);
      animateTo(true);
    }
  }, [toast, animateTo, opacity, translateY]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {toast ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.host,
            {
              // 顶部安全区下方悬浮（原型为状态栏下 56→64，本端锚安全区保持一致手感）
              top: insets.top + theme.space.xl,
              borderRadius: theme.radius.pill,
              // 原型 toast-pill：padding 6/14、无 minHeight
              paddingVertical: 6,
              paddingHorizontal: 14,
              // 墨色元素两主题同值（原型 rgba(23,23,23,0.9)），不随主操作绿/主题墨档走
              backgroundColor: 'rgba(23,23,23,0.9)',
              shadowColor: theme.colors.shadow,
              shadowOpacity: 0.15,
              // 原型阴影半径 12 与 shadow.sm 档同值（守卫禁数字圆角半径，走 theme 表达式）
              shadowRadius: theme.shadow.sm.shadowRadius,
              shadowOffset: { width: 0, height: 4 },
              elevation: 6,
              opacity,
              transform: [{ translateY }],
            },
          ]}
        >
          <AppText
            variant="caption"
            color="onMedia"
            numberOfLines={2}
            style={[styles.text, styles.messageText]}
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
  // 原型 toast-pill 字重 500（caption variant 为 400，就地收值）
  messageText: {
    fontWeight: '500',
  },
});

export default ToastProvider;
