// L2 滑动确认组件（F2 §5.3 危险操作二次确认「滑动以允许」/ R2UX §3.2 双阶段确认动效）
// - 方案 A（注入式手势状态机）：buildSlideConfirmPanConfig 配置工厂 + slideConfirmMachine 纯函数
//   承载全部滑动逻辑（拖动百分比 / 70% 阈值判定 / 回弹 / 触发 / busy 锁定），
//   本组件薄层只做 PanResponder 事件转发与视觉映射（状态机全量单测于 slideConfirmMachine.test）；
// - 拖动跟手（0ms 延迟）→ 过 70% 阈值变「松手确认」态（滑轨变绿，R2UX §3.2）→ 抬起触发；
//   未过阈值抬起 → 回弹 spring 200ms（R2UX §2.2-3：刚度低、阻尼中，一次回弹不过冲）；
// - 冲突仲裁（R2UX §2.1）：onMoveShouldSetPanResponder 走 shouldClaimSlidePan 水平判定，
//   起点不劫持（onStartShouldSetPanResponder 恒 false），未过阈值不抢触摸；
// - busy 锁定（R2UX-04-03）：disabled 期间手势锁定 + 视觉置灰（opacity 0.5，M4 §6.2-4）
//   + 确认弹窗强制关闭（防双点，与拒绝弹窗同语义）；
// - 无障碍（R2UX §4.1-3 / §4.4-3）：滑轨暴露为「允许」按钮，读屏激活走两段式确认
//   （点允许 → 确认框 → 确认放行）；reduce-motion 时直接降级为两段式点按。
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  PanResponder,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { Button, Dialog } from '@/presentation/ui';
import {
  SLIDE_THUMB_SIZE,
  createSlideConfirmState,
  shouldClaimSlidePan,
  slideCancel,
  slideEnd,
  slideMove,
  slideStart,
  slideUsableWidth,
} from './slideConfirmMachine';
import type { SlideConfirmState } from './slideConfirmMachine';

export interface SlideToConfirmProps {
  /** 放行回调（滑动过阈值抬起 / 两段式确认后触发一次） */
  onConfirm: () => void;
  /** busy 锁定（store decisionBusy 驱动，组件不自行计时，R2UX-04-03） */
  disabled?: boolean;
  /** 滑轨内文案（默认「⟶ 滑动以允许」，R2UX §3.2） */
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

/**
 * PanResponder 配置子集（与 react-native PanResponderCallbacks 结构兼容，
 * 参数放宽以便组件测试直接以合成 (evt, gestureState) 驱动）。
 */
export interface SlidePanConfig {
  onStartShouldSetPanResponder?: (evt?: unknown) => boolean;
  onMoveShouldSetPanResponder?: (
    evt?: unknown,
    gs?: { dx: number; dy: number }
  ) => boolean;
  onPanResponderGrant?: (evt?: unknown) => void;
  onPanResponderMove?: (evt?: unknown, gs?: { dx: number; dy: number }) => void;
  onPanResponderRelease?: (evt?: unknown) => void;
  onPanResponderTerminate?: (evt?: unknown) => void;
  onPanResponderTerminationRequest?: (evt?: unknown) => boolean;
}

export interface SlidePanDeps {
  getMachine: () => SlideConfirmState;
  setMachine: (next: SlideConfirmState) => void;
  getTrackWidth: () => number;
  getDisabled: () => boolean;
  getOnConfirm: () => () => void;
  /** 滑块位移（Animated.Value：拖动 setValue 跟手 / 回弹 spring） */
  thumbX: Animated.Value;
}

// 回弹 spring 参数（R2UX §2.2-3：刚度低、阻尼中，一次回弹不过冲；时长量级 ~SLIDE_REBOUND_MS）
const REBOUND_SPRING = {
  toValue: 0,
  useNativeDriver: false,
  speed: 18,
  bounciness: 0,
};

/**
 * PanResponder 配置工厂（注入式手势状态机的事件转发层）：
 * - onStartShouldSetPanResponder 恒 false：起点不劫持触摸（R2UX §2.1）；
 * - onMoveShouldSetPanResponder 走 shouldClaimSlidePan 水平仲裁（busy 期间不劫持）；
 * - grant/move/release/terminate 仅转发到 slideConfirmMachine 纯函数并同步滑块位。
 */
export function buildSlideConfirmPanConfig(deps: SlidePanDeps): SlidePanConfig {
  const setThumbFrom = (state: SlideConfirmState) => {
    deps.thumbX.setValue(
      state.progress * slideUsableWidth(deps.getTrackWidth())
    );
  };
  return {
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_evt, gs) =>
      !deps.getDisabled() && shouldClaimSlidePan(gs?.dx ?? 0, gs?.dy ?? 0),
    onPanResponderGrant: () => {
      deps.setMachine(slideStart(deps.getMachine(), deps.getDisabled()));
    },
    onPanResponderMove: (_evt, gs) => {
      const next = slideMove(
        deps.getMachine(),
        gs?.dx ?? 0,
        deps.getTrackWidth(),
        deps.getDisabled()
      );
      if (next !== deps.getMachine()) {
        deps.setMachine(next);
        setThumbFrom(next);
      }
    },
    onPanResponderRelease: () => {
      const { state, triggered } = slideEnd(
        deps.getMachine(),
        deps.getDisabled()
      );
      deps.setMachine(state);
      if (triggered) {
        deps.thumbX.setValue(slideUsableWidth(deps.getTrackWidth()));
        deps.getOnConfirm()();
      } else {
        Animated.spring(deps.thumbX, REBOUND_SPRING).start();
      }
    },
    onPanResponderTerminate: () => {
      deps.setMachine(slideCancel(deps.getMachine(), deps.getDisabled()));
      Animated.spring(deps.thumbX, REBOUND_SPRING).start();
    },
    onPanResponderTerminationRequest: () => false,
  };
}

export default function SlideToConfirm({
  onConfirm,
  disabled = false,
  label = '⟶ 滑动以允许',
  accessibilityLabel,
  confirmTitle = '确认放行？',
  confirmDescription = '允许后将立即执行，不可撤销',
  reduceMotion,
  testID,
}: SlideToConfirmProps) {
  const theme = useTheme();
  const [machine, setMachine] = useState<SlideConfirmState>(
    createSlideConfirmState
  );
  const [trackWidth, setTrackWidth] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reduceMotionDetected, setReduceMotionDetected] = useState(false);
  const thumbX = useRef(new Animated.Value(0)).current;

  // ref 镜像：PanResponder 配置仅创建一次，回调经 ref 读最新值（闭包不过期）
  const machineRef = useRef(machine);
  machineRef.current = machine;
  const trackWidthRef = useRef(trackWidth);
  trackWidthRef.current = trackWidth;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const onConfirmRef = useRef(onConfirm);
  onConfirmRef.current = onConfirm;

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

  // busy 锁定：弹窗强制关闭 + 拖动中状态复位（防双点，R2UX-04-03 同拒绝弹窗语义）
  useEffect(() => {
    if (!disabled) return;
    setDialogOpen(false);
    setMachine((current) =>
      current.phase === 'dragging' || current.phase === 'armed'
        ? createSlideConfirmState()
        : current
    );
  }, [disabled]);

  const panResponder = useMemo(
    () =>
      PanResponder.create(
        buildSlideConfirmPanConfig({
          getMachine: () => machineRef.current,
          setMachine,
          getTrackWidth: () => trackWidthRef.current,
          getDisabled: () => disabledRef.current,
          getOnConfirm: () => onConfirmRef.current,
          thumbX,
        })
      ),
    [setMachine, thumbX]
  );

  const openTwoStep = () => {
    if (disabled) return;
    setDialogOpen(true);
  };

  const confirmTwoStep = () => {
    setDialogOpen(false);
    onConfirmRef.current();
  };

  const isArmed = machine.phase === 'armed';
  const isTriggered = machine.phase === 'triggered';
  const emphasized = isArmed || isTriggered;
  const labelText = isArmed ? '松手确认' : label;
  const trackColor = emphasized
    ? theme.colors.success
    : theme.colors.fillSubtle;
  const labelColor = emphasized
    ? theme.colors.actionPrimaryText
    : theme.colors.textSecondary;

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
          onPress={openTwoStep}
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
      <View
        testID={testID ?? 'slide-to-confirm'}
        accessible
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? '允许此请求'}
        accessibilityHint="水平滑动到阈值后松手放行；读屏用户可双击改用两段式确认"
        accessibilityState={{ disabled }}
        accessibilityValue={{
          min: 0,
          max: 100,
          now: Math.round(machine.progress * 100),
          text: labelText,
        }}
        onAccessibilityTap={openTwoStep}
        onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
        style={[
          styles.track,
          { borderRadius: theme.radius.pill },
          {
            backgroundColor: trackColor,
            borderColor: theme.colors.borderStrong,
          },
          disabled && styles.disabled,
        ]}
        {...panResponder.panHandlers}
      >
        <Animated.View
          testID="slide-thumb"
          style={[
            styles.thumb,
            {
              backgroundColor: theme.colors.surfaceRaised,
              borderColor: emphasized
                ? theme.colors.success
                : theme.colors.borderStrong,
              transform: [{ translateX: thumbX }],
            },
            theme.shadow.sm,
          ]}
        />
        <Text
          testID="slide-label"
          numberOfLines={1}
          style={[theme.type.footnote, styles.label, { color: labelColor }]}
        >
          {labelText}
        </Text>
      </View>
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
    borderWidth: 1,
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
    borderWidth: 1,
  },
  label: {
    fontWeight: '500',
    paddingHorizontal: 48,
  },
  disabled: {
    opacity: 0.5,
  },
});
