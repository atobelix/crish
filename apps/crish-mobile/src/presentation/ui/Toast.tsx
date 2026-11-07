// 增强型应用内 Actionable Toast 悬浮胶囊（方案 06 落地）：
// - 支持消息提示与多态反馈（info / success / warning / danger / error）；
// - 支持 Action 交互按钮（如“重试”、“查看详情”）；
// - 支持关闭按钮与无障碍（accessibilityRole="button" 与 dismissLabel）；
// - 纯深色精致墨色药丸悬浮（原型 rgba(23,23,23,0.92)），平滑滑入淡出；
// - 支持 top（安全区下悬浮）与 bottom（吸附软键盘 KeyboardStickyView 避让）；
// - 浮层阴影（2026-11-02 裁定）：所有阴影走 SoftShadowSurface toast 档软阴影；
// - 减动效（feelInfra 守卫）：系统 Reduce Motion 开启时位移塌缩为 0，仅 opacity 淡化。
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Animated, Easing, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { useTheme } from '@/adapters/platform/theme';
import { useReducedMotion } from '@/adapters/platform/useReducedMotion';
import AppText from './AppText';
import { Icon, type IconName } from './Icon';
import { SoftShadowSurface } from './SoftShadowSurface';
import { subscribeHostToasts } from './toastBus';

export type ToastTone = 'info' | 'success' | 'warning' | 'error' | 'danger';
export type ToastPlacement = 'top' | 'bottom';

export interface ToastAction {
  /** 动作按钮文字 */
  label: string;
  /** 点击回调 */
  onPress: () => void;
  /** 按钮样式变体，primary 高亮，subtle 弱化 */
  variant?: 'primary' | 'subtle';
}

export interface ToastOptions {
  /** 提示消息正文 */
  message: string;
  /** 标题（可选，适用于复合卡片 Toast） */
  title?: string;
  /** 色调变体 */
  tone?: ToastTone;
  /** 展示时长（毫秒，默认 2500ms；带 action 时默认 5000ms） */
  durationMs?: number;
  /** 弹出位置：top 悬浮于安全区下；bottom 吸附在软键盘/底部栏上方 */
  placement?: ToastPlacement;
  /** 底部偏移量（例如输入框高度，用于 bottom placement） */
  bottomOffset?: number;
  /** 可操作动作按钮列表 */
  actions?: readonly ToastAction[];
  /** 是否允许手动点击关闭按钮 */
  dismissible?: boolean;
  /** 点击关闭按钮无障碍文案 */
  dismissLabel?: string;
}

export interface ToastController {
  /** 呼出 Toast（支持配置对象或纯文本），返回条目唯一 id */
  show: (options: ToastOptions | string, tone?: ToastTone) => string;
  /** 兼容历史接口 showToast(message, tone) */
  showToast: (message: string, tone?: ToastTone) => string;
  /** 手动关闭指定或当前 Toast */
  hide: (id?: string) => void;
  /** 清空当前所有 Toast */
  clear: () => void;
}

const ToastContext = createContext<ToastController | null>(null);

/** 原型 toast-pill 进出滑移量与时长 */
const SLIDE_PX = 8;
/** 进出场时长 = theme.motion.duration.normal（批 A 字面量收编：
 * 原本地 ANIM_MS=200 与 token 同值两套，已并轨到 token 单源） */

interface ActiveToastItem {
  id: string;
  options: ToastOptions;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const reduceMotion = useReducedMotion();
  const insets = useSafeAreaInsets();

  const [activeToast, setActiveToast] = useState<ActiveToastItem | null>(null);
  const activeToastRef = useRef<ActiveToastItem | null>(null);
  activeToastRef.current = activeToast;

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showSeq = useRef(0);
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(-SLIDE_PX)).current;

  const clearTimer = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const animateHide = useCallback(
    (targetId?: string, onDone?: () => void) => {
      if (targetId && activeToastRef.current?.id !== targetId) return;
      if (!activeToastRef.current) return;
      clearTimer();
      const curSeq = showSeq.current;
      const isBottom = activeToastRef.current.options.placement === 'bottom';
      const targetTranslate = reduceMotion
        ? 0
        : isBottom
          ? SLIDE_PX
          : -SLIDE_PX;

      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 0,
          duration: theme.motion.duration.normal,
          easing: Easing.bezier(...theme.motion.easing.decelerate),
          useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: targetTranslate,
          duration: theme.motion.duration.normal,
          easing: Easing.bezier(...theme.motion.easing.decelerate),
          useNativeDriver: true,
        }),
      ]).start(({ finished }) => {
        if (finished && showSeq.current === curSeq) {
          setActiveToast(null);
          onDone?.();
        }
      });
    },
    [
      clearTimer,
      opacity,
      translateY,
      reduceMotion,
      theme.motion.easing.decelerate,
    ]
  );

  const show = useCallback(
    (input: ToastOptions | string, toneOverride?: ToastTone): string => {
      clearTimer();
      showSeq.current += 1;
      const seq = showSeq.current;
      const id = `toast_${seq}`;

      const options: ToastOptions =
        typeof input === 'string'
          ? { message: input, tone: toneOverride ?? 'info' }
          : { ...input, tone: input.tone ?? toneOverride ?? 'info' };

      const isBottom = options.placement === 'bottom';
      const initialTranslate = reduceMotion
        ? 0
        : isBottom
          ? SLIDE_PX
          : -SLIDE_PX;

      opacity.setValue(0);
      translateY.setValue(initialTranslate);

      setActiveToast({ id, options });

      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 1,
          duration: theme.motion.duration.normal,
          easing: Easing.bezier(...theme.motion.easing.decelerate),
          useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: 0,
          duration: theme.motion.duration.normal,
          easing: Easing.bezier(...theme.motion.easing.decelerate),
          useNativeDriver: true,
        }),
      ]).start();

      const duration =
        options.durationMs ??
        (options.actions && options.actions.length > 0
          ? 5000
          : theme.motion.toast.displayMs);

      if (duration > 0 && duration < Infinity) {
        timer.current = setTimeout(() => {
          animateHide(id);
        }, duration);
      }

      return id;
    },
    [
      clearTimer,
      opacity,
      translateY,
      reduceMotion,
      theme.motion.easing.decelerate,
      theme.motion.toast.displayMs,
      animateHide,
    ]
  );

  const showToast = useCallback(
    (message: string, tone?: ToastTone): string => {
      return show(message, tone);
    },
    [show]
  );

  const hide = useCallback(
    (id?: string) => {
      animateHide(id);
    },
    [animateHide]
  );

  const clear = useCallback(() => {
    clearTimer();
    setActiveToast(null);
  }, [clearTimer]);

  useEffect(
    () => () => {
      clearTimer();
    },
    [clearTimer]
  );

  const controller = useMemo<ToastController>(
    () => ({
      show,
      showToast,
      hide,
      clear,
    }),
    [show, showToast, hide, clear]
  );

  // 运行时域桥（2026-11-05 设备上线提醒接线）：非 React 域（runtime
  // 编排层）经 toastBus 发出的前台提醒统一走本控制器呈现（载荷与 show
  // 同构，支持复合卡片与动作）；卸载时退订。toastBus 为单点（见
  // toastBus.ts 头注），未挂载时静默丢弃。
  useEffect(() => {
    return subscribeHostToasts((options, tone) => {
      show(options, tone);
    });
  }, [show]);

  const renderToastContent = () => {
    if (!activeToast) return null;
    const { options, id } = activeToast;
    const tone = options.tone ?? 'info';
    const isBottom = options.placement === 'bottom';
    const hasActions = Boolean(options.actions && options.actions.length > 0);
    const hasTitle = Boolean(options.title);
    const isDismissible = options.dismissible ?? (hasActions || hasTitle);

    const toneIcon: IconName =
      tone === 'success'
        ? 'check'
        : tone === 'warning'
          ? 'alert-circle'
          : tone === 'danger' || tone === 'error'
            ? 'alert-circle'
            : 'info';

    const toneColor =
      tone === 'success'
        ? theme.colors.success
        : tone === 'warning'
          ? theme.colors.warning
          : tone === 'danger' || tone === 'error'
            ? theme.colors.danger
            : theme.colors.info;

    const toastCard = (
      <Animated.View
        pointerEvents="box-none"
        style={[
          styles.host,
          isBottom
            ? {
                bottom:
                  (options.bottomOffset ?? 0) + insets.bottom + theme.space.md,
              }
            : {
                top: insets.top + theme.space.lg,
              },
          {
            opacity,
            transform: [{ translateY }],
          },
        ]}
      >
        <SoftShadowSurface
          preset="toast"
          borderRadius={hasActions ? theme.radius.card : theme.radius.pill}
          fill="rgba(23, 23, 23, 0.92)"
          fillStyle={{
            borderRadius: hasActions ? theme.radius.card : theme.radius.pill,
            paddingVertical: hasActions ? theme.space.sm : theme.space.xs + 2,
            paddingHorizontal: theme.space.md + 2,
          }}
        >
          <View style={styles.headerRow}>
            <Icon
              name={toneIcon}
              size={theme.size.iconSmall}
              color={toneColor}
            />
            <View style={styles.textColumn}>
              {options.title ? (
                <AppText
                  variant="caption"
                  color="onMedia"
                  numberOfLines={1}
                  style={styles.titleText}
                >
                  {options.title}
                </AppText>
              ) : null}
              <AppText
                variant="caption"
                color="onMedia"
                numberOfLines={3}
                style={[styles.text, styles.messageText]}
              >
                {options.message}
              </AppText>
            </View>

            {isDismissible ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={options.dismissLabel ?? '关闭通知'}
                onPress={() => animateHide(id)}
                hitSlop={theme.space.sm}
                style={styles.closeBtn}
              >
                <Icon
                  name="x"
                  size={theme.size.iconSmall}
                  color="rgba(255, 255, 255, 0.6)"
                />
              </Pressable>
            ) : null}
          </View>

          {hasActions ? (
            <View
              style={[
                styles.actionsRow,
                {
                  borderTopWidth: StyleSheet.hairlineWidth,
                  borderTopColor: 'rgba(255, 255, 255, 0.15)',
                  marginTop: theme.space.xs + 2,
                  paddingTop: theme.space.xs + 2,
                  gap: theme.space.sm,
                },
              ]}
            >
              {options.actions!.map((action, idx) => (
                <Pressable
                  key={idx}
                  accessibilityRole="button"
                  accessibilityLabel={action.label}
                  onPress={() => {
                    animateHide(id);
                    action.onPress();
                  }}
                  style={[
                    styles.actionBtn,
                    {
                      borderRadius: theme.radius.sm,
                      paddingHorizontal: theme.space.sm + 2,
                      paddingVertical: theme.space.xxs + 1,
                      backgroundColor:
                        action.variant === 'subtle'
                          ? 'transparent'
                          : 'rgba(255, 255, 255, 0.18)',
                    },
                  ]}
                >
                  <AppText
                    variant="caption"
                    color="onMedia"
                    style={styles.actionText}
                  >
                    {action.label}
                  </AppText>
                </Pressable>
              ))}
            </View>
          ) : null}
        </SoftShadowSurface>
      </Animated.View>
    );

    if (isBottom) {
      return (
        <KeyboardStickyView
          pointerEvents="box-none"
          offset={{ opened: insets.bottom }}
          style={StyleSheet.absoluteFill}
        >
          {toastCard}
        </KeyboardStickyView>
      );
    }

    return toastCard;
  };

  return (
    <ToastContext.Provider value={controller}>
      {children}
      {renderToastContent()}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastController {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    alignSelf: 'center',
    maxWidth: '92%',
    zIndex: 9999,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  textColumn: {
    flexShrink: 1,
  },
  titleText: {
    fontWeight: '600',
    marginBottom: 2,
  },
  text: {
    flexShrink: 1,
  },
  messageText: {
    fontWeight: '500',
  },
  closeBtn: {
    padding: 2,
    marginLeft: 4,
  },
  actionsRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  actionBtn: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  actionText: {
    fontWeight: '600',
  },
});

export default ToastProvider;
