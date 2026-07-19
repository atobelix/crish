/**
 * React hook + Context 集成：在 App 启动时完成硬件检测、等级分配、动态自适应。
 *
 * 用法:
 *   const { profile, level, config, adaptations, engine } = usePlatformAdaptation();
 *
 * 或通过 Context:
 *   const ctx = usePlatformAdaptationCtx();
 */

import { useEffect, useState, useRef, useSyncExternalStore, createContext, useContext } from 'react';
import { detectHardware } from './hardware-profile';
import type { HardwareProfile } from './hardware-profile';
import { PerformanceLevel, assignTier, TIER_CONFIGS } from './performance-tier';
import type { TierConfig, TierAssignment } from './performance-tier';
import { DynamicAdaptationEngine, createAdaptationEngine } from './dynamic-adaptation';
import type { MetricEvent } from './dynamic-adaptation';
import { getFullAdaptation } from './platform-adaptation';
import type { FullPlatformAdaptation } from './platform-adaptation';
import { applyRenderAdaptation } from './platform-adaptation';

// ── 状态形状 ──

export interface PlatformAdaptationState {
  /** 硬件检测是否完成 */
  hardwareReady: boolean;
  /** 完整硬件 Profile */
  profile: HardwareProfile | null;
  /** 当前性能等级 */
  level: PerformanceLevel;
  /** 等级详细配置 */
  config: TierConfig | null;
  /** 等级赋值详情（含评分理由） */
  assignment: TierAssignment | null;
  /** 完整子系统自适应配置 */
  adaptations: FullPlatformAdaptation | null;
  /** 动态自适应引擎 */
  engine: DynamicAdaptationEngine | null;
  /** 最近的自适应事件 */
  lastEvent: MetricEvent | null;
}

const INITIAL: PlatformAdaptationState = {
  hardwareReady: false,
  profile: null,
  level: PerformanceLevel.Level1,
  config: null,
  assignment: null,
  adaptations: null,
  engine: null,
  lastEvent: null,
};

// ── Store 快照订阅（类似 useSyncExternalStore 模式） ──

class PlatformStore {
  private state: PlatformAdaptationState = { ...INITIAL };
  private listeners = new Set<() => void>();

  getState(): PlatformAdaptationState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setState(partial: Partial<PlatformAdaptationState>): void {
    this.state = { ...this.state, ...partial };
    for (const fn of this.listeners) fn();
  }
}

const globalStore = new PlatformStore();

// ── Context (store 引用转发，方便组件树消费) ──

export const PlatformAdaptationCtx = createContext<PlatformAdaptationState>(INITIAL);

export function usePlatformAdaptationCtx(): PlatformAdaptationState {
  return useContext(PlatformAdaptationCtx);
}

// ── Hook ──

export interface PlatformAdaptationOptions {
  skipStorageBench?: boolean;
  hardwareTimeout?: number;
  /** 检测完成后是否自动启动动态自适应引擎 */
  autoStartEngine?: boolean;
  /** 检测完成后是否自动应用 DOM 渲染自适应 */
  autoApplyRender?: boolean;
  /** 引擎升级检查间隔 ms（默认 30000） */
  upgradeCheckIntervalMs?: number;
}

const DEFAULT_OPTS: Required<PlatformAdaptationOptions> = {
  skipStorageBench: false,
  hardwareTimeout: 3000,
  autoStartEngine: true,
  autoApplyRender: true,
  upgradeCheckIntervalMs: 30_000,
};

export interface UsePlatformAdaptationResult extends PlatformAdaptationState {
  /** 手动触发重新检测硬件 */
  redetect: () => Promise<void>;
  /** 手动切换到指定等级 */
  setLevel: (level: PerformanceLevel) => void;
}

export function usePlatformAdaptation(opts?: PlatformAdaptationOptions): UsePlatformAdaptationResult {
  const state = useSyncExternalStore(
    (cb) => globalStore.subscribe(cb),
    () => globalStore.getState(),
  );

  const prevLevelRef = useRef<PerformanceLevel>(state.level);
  const cleanupRenderRef = useRef<(() => void) | null>(null);
  const upgradeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const resolvedOpts = { ...DEFAULT_OPTS, ...opts };

  // ── 初始硬件检测 ──

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      const profile = await detectHardware({
        skipStorageBench: resolvedOpts.skipStorageBench,
        timeout: resolvedOpts.hardwareTimeout,
      });
      if (cancelled) return;

      const assignment = assignTier(profile);
      const adaptations = getFullAdaptation(assignment.level);

      globalStore.setState({
        hardwareReady: true,
        profile,
        level: assignment.level,
        config: assignment.config,
        assignment,
        adaptations,
      });

      // 自动启动引擎（创建失败不级联崩溃）
      if (resolvedOpts.autoStartEngine) {
        try {
          const engine = createAdaptationEngine(profile);
          engine.onEvent((event) => {
            const adaptations = getFullAdaptation(event.toLevel);
            globalStore.setState({
              level: event.toLevel,
              config: TIER_CONFIGS[event.toLevel],
              adaptations,
              lastEvent: event,
            });
          });
          globalStore.setState({ engine });
        } catch (err) {
          console.warn('[PlatformAdaptation] Engine creation failed, continuing without dynamic adaptation:', err);
        }
      }
    };

    run();
    return () => { cancelled = true; };
  }, []);

  // ── 等级变化时自动应用 DOM 渲染 ──

  useEffect(() => {
    if (!state.hardwareReady || !state.adaptations) return;
    if (!resolvedOpts.autoApplyRender) return;
    if (state.level === prevLevelRef.current) return;

    prevLevelRef.current = state.level;

    // 清理前一次的应用
    if (cleanupRenderRef.current) {
      cleanupRenderRef.current();
    }

    cleanupRenderRef.current = applyRenderAdaptation(state.adaptations.render);
  }, [state.level, state.hardwareReady]);

  // ── 升级检查定时器 ──

  useEffect(() => {
    if (!state.engine) return;
    if (upgradeTimerRef.current) clearInterval(upgradeTimerRef.current);
    upgradeTimerRef.current = setInterval(() => {
      state.engine!.checkUpgrade();
    }, resolvedOpts.upgradeCheckIntervalMs);
    return () => {
      if (upgradeTimerRef.current) clearInterval(upgradeTimerRef.current);
    };
  }, [state.engine]);

  // ── 清理 ──

  useEffect(() => {
    return () => {
      if (state.engine) state.engine.stop();
      if (cleanupRenderRef.current) cleanupRenderRef.current();
    };
  }, []);

  // ── 手动方法 ──

  const redetect = async () => {
    const profile = await detectHardware({
      skipStorageBench: resolvedOpts.skipStorageBench,
      timeout: resolvedOpts.hardwareTimeout,
    });
    const assignment = assignTier(profile);
    const adaptations = getFullAdaptation(assignment.level);
    globalStore.setState({
      hardwareReady: true,
      profile,
      level: assignment.level,
      config: assignment.config,
      assignment,
      adaptations,
    });
    if (state.engine) {
      state.engine.updateProfile(profile);
    }
  };

  const setLevel = (level: PerformanceLevel) => {
    const adaptations = getFullAdaptation(level);
    globalStore.setState({
      level,
      config: adaptations.config,
      adaptations,
    });
  };

  return { ...state, redetect, setLevel };
}
