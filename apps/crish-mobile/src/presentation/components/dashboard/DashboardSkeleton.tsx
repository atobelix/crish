// 首页首帧骨架屏（R2UX-05-10：骨架三块 + 缓存优先 + 网关聚合 ≤500ms 首页预算）
// - 三块布局对齐首页实际布局：状态卡 / 快速操作 / 事件流（R2-05b 仪表盘 + R2-05f
//   QuickRunPanel 骨架占位；数据未就绪时避免白屏）；
// - 颜色取 token 三档背景（M4 §8.1：卡片底 bgCard + 块色 bgTertiary），无硬编码色值；
// - 微动画：整组 opacity 脉冲 0.4↔0.7、1.2s 循环（R2UX-05-04 呼吸数值 + 任务书 1.2s
//   周期），easing 线性（R2UX §2.2 骨架呼吸行）；reduce-motion（AccessibilityInfo 探测，
//   变化即时响应 + prop 注入优先）→ 静态不闪（R2UX §4.4-2/4.4-3）；
// - 无闪烁替换：骨架尺寸对齐真实内容（feed 行高对齐 EVENT_ROW_HEIGHT=56、卡片/输入/
//   按钮参数对齐 QuickRunPanel），数据到达原位替换无高度跳变；
// - 首帧预算：本组件纯静态渲染（无挂载期异步拉取，动画为不阻塞布局的 opacity 循环），
//   不阻塞首帧（R2UX-05-10「骨架不阻塞首帧」注记）。
import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  StyleSheet,
  View,
} from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import type { ConnectionPhase } from '@/domain/store/connectionStore';
import { EVENT_ROW_HEIGHT } from '@/presentation/components/blocks/EventRow';

// ── 常量与判据纯函数（可单测）─────────────────────────────────────────────

/** 骨架呼吸 opacity 下限（M4 §8.1：呼吸 0.4→0.7→0.4） */
export const SKELETON_OPACITY_LOW = 0.4;
/** 骨架呼吸 opacity 上限（M4 §8.1；reduce-motion 静态取高值端保持可见） */
export const SKELETON_OPACITY_HIGH = 0.7;
/** 骨架脉冲半周期 ms（任务书：1.2s 完整周期 = 0.6s 升 + 0.6s 降） */
export const SKELETON_PULSE_HALF_MS = 600;
/** feed 骨架行数（视口内可见量；行高对齐 EVENT_ROW_HEIGHT，替换无高度跳变） */
export const SKELETON_FEED_ROWS = 4;

/**
 * 首页骨架判据（R2UX-05-10「骨架三块 + 缓存优先」接线纯函数）：
 * - 缓存优先：有会话或 feed 窗口条目（已水合数据）→ 不显示骨架，数据立即可见
 *   （eventStore 已有窗口数据直接渲染，R2UX-05-04「缓存命中不出现骨架」）；
 * - 无数据：连接尚未稳定（disconnected/connecting = 水合/首拉进行中）→ 骨架；
 * - 无数据且连接已稳定（ready/recovering/offline）→ 空态路径（不骨架，
 *   避免「真无数据」时骨架永不消失，R2UX-05-05 空态由页面承接）。
 */
export function dashboardShowSkeleton(
  phase: ConnectionPhase,
  sessionId: string | null,
  entryCount: number
): boolean {
  if (sessionId !== null || entryCount > 0) return false;
  return phase === 'disconnected' || phase === 'connecting';
}

export interface DashboardSkeletonProps {
  /** reduce-motion 注入（测试/上层透传优先；缺省走 AccessibilityInfo 系统探测，R2UX §4.4-1） */
  reduceMotion?: boolean;
}

/**
 * 首页首帧骨架三块：状态卡 / 快速操作 / 事件流。
 * 读屏友好：骨架为装饰性占位，整体对辅助技术隐藏（社区骨架屏惯例）。
 */
export function DashboardSkeleton({ reduceMotion }: DashboardSkeletonProps) {
  const theme = useTheme();
  const [reduceMotionDetected, setReduceMotionDetected] = useState(false);
  /** 探测是否完成（未完成前动画不启动：避免「先启动再因探测结果停止」的时序抖动） */
  const [probeDone, setProbeDone] = useState(false);
  const pulse = useRef(new Animated.Value(SKELETON_OPACITY_LOW)).current;
  const loopRef = useRef<Animated.CompositeAnimation | null>(null);

  // reduce-motion 探测（R2UX §4.4-1：订阅变化即时响应；jest/无原生环境回落默认 false）
  useEffect(() => {
    let mounted = true;
    try {
      AccessibilityInfo.isReduceMotionEnabled()
        .then((value) => {
          if (!mounted) return;
          setReduceMotionDetected(value);
          setProbeDone(true);
        })
        .catch(() => {
          // swallow-ok：原生模块缺失（jest 等）时按默认 false 完成探测
          if (mounted) setProbeDone(true);
        });
    } catch {
      // 原生模块缺失（jest 等）时按默认 false 完成探测
      setProbeDone(true);
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
  const motionResolved = reduceMotion !== undefined || probeDone;

  // 呼吸动画（R2UX-05-04）：探测完成且非 reduce-motion 才启动循环；
  // reduce-motion → 静态不闪（R2UX §4.4-2/4.4-3）；运行中开启 → 即时停止
  useEffect(() => {
    if (!motionResolved) return;
    if (effectiveReduceMotion) {
      loopRef.current?.stop();
      loopRef.current = null;
      pulse.setValue(SKELETON_OPACITY_HIGH);
      return;
    }
    pulse.setValue(SKELETON_OPACITY_LOW);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: SKELETON_OPACITY_HIGH,
          duration: SKELETON_PULSE_HALF_MS,
          easing: Easing.linear,
          useNativeDriver: false,
        }),
        Animated.timing(pulse, {
          toValue: SKELETON_OPACITY_LOW,
          duration: SKELETON_PULSE_HALF_MS,
          easing: Easing.linear,
          useNativeDriver: false,
        }),
      ])
    );
    loopRef.current = loop;
    loop.start();
    return () => loop.stop();
  }, [motionResolved, effectiveReduceMotion, pulse]);

  const blockStyle = { backgroundColor: theme.bgTertiary };
  const cardStyle = { backgroundColor: theme.bgCard };

  return (
    <Animated.View
      testID="dashboard-skeleton"
      style={[styles.root, { opacity: pulse }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {/* 状态卡骨架（概览卡：标题 + 三指标列，F1 状态卡形态） */}
      <View testID="skeleton-status-card" style={[styles.card, cardStyle]}>
        <View
          testID="skeleton-status-title"
          style={[styles.titleBar, blockStyle]}
        />
        <View style={styles.metricRow}>
          {[0, 1, 2].map((i) => (
            <View
              key={i}
              testID={`skeleton-status-metric-${i}`}
              style={[styles.metricBlock, blockStyle]}
            />
          ))}
        </View>
      </View>

      {/* 快速操作骨架（对齐 QuickRunPanel：标题 + 输入行 + 会话 chips 行） */}
      <View testID="skeleton-quickrun" style={[styles.card, cardStyle]}>
        <View
          testID="skeleton-quickrun-title"
          style={[styles.titleBar, blockStyle]}
        />
        <View style={styles.inputRow}>
          <View
            testID="skeleton-quickrun-input"
            style={[styles.inputBlock, blockStyle]}
          />
          <View
            testID="skeleton-quickrun-submit"
            style={[styles.submitBlock, blockStyle]}
          />
        </View>
        <View style={styles.chipRow}>
          {[0, 1, 2].map((i) => (
            <View
              key={i}
              testID={`skeleton-quickrun-chip-${i}`}
              style={[styles.chipBlock, blockStyle]}
            />
          ))}
        </View>
      </View>

      {/* 事件流骨架（过滤条 + N 行 feed 骨架行，行内结构对齐 EventRow） */}
      <View testID="skeleton-event-feed" style={styles.feedSection}>
        <View style={styles.filterBar}>
          {[0, 1, 2].map((i) => (
            <View
              key={i}
              testID={`skeleton-feed-filter-${i}`}
              style={[styles.filterChip, blockStyle]}
            />
          ))}
        </View>
        {Array.from({ length: SKELETON_FEED_ROWS }, (_, i) => (
          <View
            key={i}
            testID={`skeleton-feed-row-${i}`}
            style={[styles.feedRow, { borderBottomColor: theme.hairline }]}
          >
            <View
              testID={`skeleton-feed-time-${i}`}
              style={[styles.timeBlock, blockStyle]}
            />
            <View
              testID={`skeleton-feed-kind-${i}`}
              style={[styles.kindBlock, blockStyle]}
            />
            <View
              testID={`skeleton-feed-summary-${i}`}
              style={[styles.summaryBlock, blockStyle]}
            />
          </View>
        ))}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  card: {
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 12,
    padding: 14,
    gap: 12,
  },
  titleBar: {
    width: 120,
    height: 14,
    borderRadius: 7,
  },
  metricRow: {
    flexDirection: 'row',
    gap: 12,
  },
  metricBlock: {
    flex: 1,
    height: 32,
    borderRadius: 8,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  inputBlock: {
    flex: 1,
    height: 44,
    borderRadius: 10,
  },
  submitBlock: {
    width: 92,
    height: 44,
    borderRadius: 9999,
  },
  chipRow: {
    flexDirection: 'row',
    gap: 8,
  },
  chipBlock: {
    width: 60,
    height: 32,
    borderRadius: 9999,
  },
  feedSection: {
    marginTop: 12,
    flex: 1,
  },
  filterBar: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  filterChip: {
    width: 84,
    height: 32,
    borderRadius: 9999,
  },
  feedRow: {
    height: EVENT_ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  timeBlock: {
    width: 64,
    height: 12,
    borderRadius: 6,
  },
  kindBlock: {
    width: 36,
    height: 20,
    borderRadius: 8,
  },
  summaryBlock: {
    flex: 1,
    height: 12,
    borderRadius: 6,
  },
});
