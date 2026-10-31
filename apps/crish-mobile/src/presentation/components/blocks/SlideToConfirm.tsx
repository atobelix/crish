// L2 滑动确认组件（F2 §5.3 危险操作二次确认「滑动以允许」/ R2UX §3.2 双阶段确认动效）
// - Reanimated Worklet 手势（实现波总方案 F2）：Gesture.Pan + useSharedValue 驱动
//   滑块位移——拖动全程 0 次 React 渲染（位移走 UI 线程），仅阈值跨越翻转
//   armed 状态（≤2 次/手势）；未过阈值松手 → withSpring 物理回弹；
// - 阈值语义（F2 §5.3「滑过 70% 才可抬起触发」）：releaseDecision 纯函数承载
//   判定，组件与单测共用同一真理；进 100% 不自动触发（「抬起触发」语义）；
// - busy 锁定：disabled 期间手势 enabled=false + 视觉置灰 + 确认弹窗强制关闭；
// - 无障碍（R2UX §4.1-3 / §4.4-3）：滑轨暴露为「允许」按钮，读屏激活走两段式
//   确认（点允许 → 确认框 → 确认放行）；reduce-motion 时整体降级为两段式点按；
// - U8 零描边：滑轨/滑块一律表面色阶表达（armed → successSoft 轨道 + 图标变色），
//   无 borderWidth、无阴影。
import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  GestureResponderEvent,
  StyleSheet,
  Text,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { useTheme } from '@/adapters/platform/theme';
import { Button, Dialog } from '@/presentation/ui';

/** 触发阈值（F2 §5.3 / R2UX §2.4-3：滑过 70% 才可抬起触发） */
export const SLIDE_TRIGGER_THRESHOLD = 0.7;
/** 滑块尺寸（触控目标 ≥44，R2UX §1.2 热区基线） */
export const SLIDE_THUMB_SIZE = 44;

/** 可滑动距离（轨道宽 - 滑块宽；轨道未测量（<=0）时返回 0） */
export function slideUsableWidth(
  trackWidthPx: number,
  thumbSize: number = SLIDE_THUMB_SIZE
): number {
  return Math.max(trackWidthPx - thumbSize, 0);
}

/**
 * 抬起判定（纯函数；worklet 与单测共用）：
 * progress ≥ 阈值 → confirm（触发放行）；否则 rebound（弹簧回弹）。
 */
export function slideReleaseDecision(
  progress: number,
  threshold: number = SLIDE_TRIGGER_THRESHOLD
): 'confirm' | 'rebound' {
  return progress >= threshold ? 'confirm' : 'rebound';
}

export interface SlideToConfirmProps {
  /** 放行回调（滑动过阈值抬起 / 两段式确认后触发一次） */
  onConfirm: () => void;
  /** busy 锁定（store decisionBusy 驱动，组件不自行计时，R2UX-04-03） */
  disabled?: boolean;
  /** 滑轨内文案（默认「滑动以允许」，R2UX §3.2） */
  label?: string;
  /** 无障碍 label（「类型 + 摘要」，R2UX-04-10） */
  accessibilityLabel?: string;
  /** 两段式确认弹窗文案（默认「允许后将立即执行，不可撤销」，F2 §9.3-5 / R2UX §3.2） */
  confirmTitle?: string;
  confirmDescription?: string;
  /** reduce-motion 降级（运行时由 AccessibilityInfo 探测；测试可显式注入，R2UX §4.4-3） */
  reduceMotion?: boolean;
  testID?: string;
}

export default function SlideToConfirm({
  onConfirm,
  disabled = false,
  label = '滑动以允许',
  accessibilityLabel,
  confirmTitle = '确认放行？',
  confirmDescription = '允许后将立即执行，不可撤销',
  reduceMotion,
  testID,
}: SlideToConfirmProps) {
  const theme = useTheme();
  const [trackWidth, setTrackWidth] = useState(0);
  const [armed, setArmed] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reduceMotionDetected, setReduceMotionDetected] = useState(false);
  const thumbX = useSharedValue(0);
  const onConfirmRef = useRef(onConfirm);
  onConfirmRef.current = onConfirm;

  const usable = slideUsableWidth(trackWidth);

  // reduce-motion 探测（R2UX §4.4-1：订阅变化即时响应；jest/无原生环境回落默认 false）
  useEffect(() => {
    let mounted = true;
    try {
      AccessibilityInfo.isReduceMotionEnabled()
        .then((value) => {
          if (mounted) setReduceMotionDetected(value);
        })
        .catch(() => {
          /* swallow-ok: 原生模块缺失（jest 等）时保持默认 false */
        });
    } catch {
      // 原生模块缺失（jest 等）时保持默认 false
    }
    let subscription: { remove: () => void } | null = null;
    try {
      subscription = AccessibilityInfo.addEventListener(
        'reduceMotionChanged',
        (value) => {
          if (mounted) setReduceMotionDetected(value);
        }
      );
    } catch {
      subscription = null;
    }
    return () => {
      mounted = false;
      subscription?.remove();
    };
  }, []);

  const effectiveReduceMotion = reduceMotion ?? reduceMotionDetected;

  // busy 锁定：弹窗强制关闭 + 复位滑块（防双点，R2UX-04-03 同拒绝弹窗语义）
  useEffect(() => {
    if (!disabled) return;
    setDialogOpen(false);
    setArmed(false);
    thumbX.value = 0;
  }, [disabled, thumbX]);

  const trigger = () => {
    setArmed(false);
    onConfirmRef.current();
  };

  const pan = Gesture.Pan()
    .enabled(!disabled && usable > 0)
    .onUpdate((event) => {
      'worklet';
      thumbX.value = Math.min(Math.max(event.translationX, 0), usable);
    })
    .onEnd(() => {
      'worklet';
      const progress = usable > 0 ? thumbX.value / usable : 0;
      if (slideReleaseDecision(progress) === 'confirm') {
        thumbX.value = usable;
        runOnJS(trigger)();
      } else {
        thumbX.value = withSpring(0, theme.motion.spring.slideThumb);
      }
    });

  // 阈值跨越翻转 armed（仅跨越时 1 次 React 渲染；拖动本身 0 渲染）
  useAnimatedReaction(
    () => (usable > 0 ? thumbX.value / usable : 0) >= SLIDE_TRIGGER_THRESHOLD,
    (next, prev) => {
      if (next !== prev) runOnJS(setArmed)(next);
    },
    [usable]
  );

  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: thumbX.value }],
  }));

  const openTwoStep = (event?: GestureResponderEvent) => {
    event?.preventDefault?.();
    if (disabled) return;
    setDialogOpen(true);
  };

  const confirmTwoStep = () => {
    setDialogOpen(false);
    onConfirmRef.current();
  };

  const labelText = armed ? '松手确认' : label;
  const trackColor = armed ? theme.colors.successSoft : theme.colors.fillSubtle;
  const labelColor = armed ? theme.colors.success : theme.colors.textSecondary;

  const twoStepDialog = (
    <Dialog
      visible={dialogOpen}
      title={confirmTitle}
      description={confirmDescription}
      testID="slide-confirm-dialog"
      actions={[
        {
          label: '取消',
          variant: 'secondary',
          onPress: () => setDialogOpen(false),
          testID: 'slide-confirm-cancel',
        },
        {
          label: '确认放行',
          variant: 'primary',
          onPress: confirmTwoStep,
          testID: 'slide-confirm-accept',
        },
      ]}
      onDismiss={() => setDialogOpen(false)}
    />
  );

  // reduce-motion 降级：滑轨改「点允许 → 确认框 → 确认放行」（R2UX §4.4-3 / M4 §8.4）
  if (effectiveReduceMotion) {
    return (
      <>
        <Button
          label="允许"
          variant="primary"
          onPress={() => openTwoStep()}
          disabled={disabled}
          testID={testID ?? 'slide-allow-button'}
          accessibilityLabel={accessibilityLabel}
          style={styles.buttonFill}
        />
        {twoStepDialog}
      </>
    );
  }

  return (
    <>
      <GestureDetector gesture={pan}>
        <Animated.View
          testID={testID ?? 'slide-to-confirm'}
          accessible
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel ?? '允许此请求'}
          accessibilityHint="水平滑动到阈值后松手放行；读屏用户可双击改用两段式确认"
          accessibilityState={{ disabled }}
          accessibilityValue={{
            min: 0,
            max: 100,
            now: armed
              ? 100
              : Math.round(
                  (usable > 0 ? (thumbX.value ?? 0) / usable : 0) * 100
                ),
            text: labelText,
          }}
          onAccessibilityTap={openTwoStep}
          onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
          style={[
            styles.track,
            { borderRadius: theme.radius.pill, backgroundColor: trackColor },
            disabled && styles.disabled,
          ]}
        >
          <Animated.View
            testID="slide-thumb"
            style={[
              styles.thumb,
              { backgroundColor: theme.colors.surfaceRaised },
              thumbStyle,
            ]}
          />
          <Text
            testID="slide-label"
            numberOfLines={1}
            style={[theme.type.footnote, styles.label, { color: labelColor }]}
          >
            {labelText}
          </Text>
        </Animated.View>
      </GestureDetector>
      {twoStepDialog}
    </>
  );
}

const styles = StyleSheet.create({
  buttonFill: {
    width: '100%',
  },
  track: {
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  thumb: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: SLIDE_THUMB_SIZE,
    height: SLIDE_THUMB_SIZE,
    borderRadius: SLIDE_THUMB_SIZE / 2,
  },
  label: {
    fontWeight: '500',
    paddingHorizontal: 48,
  },
  disabled: {
    opacity: 0.5,
  },
});
