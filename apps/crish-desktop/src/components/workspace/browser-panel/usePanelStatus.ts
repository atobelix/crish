/**
 * 面板协作状态 hook（P1-B2：12 文档 §5 + T-12/U-9 裁决）。
 *
 * 驱动源（按优先级）：
 * 1. **引擎侧 AI 动作信号**（`engineAiBusy`）：接线点 = 12 §5.2 的
 *    `browser:status` 控制事件（含 `aiActionText`，引擎侧面板控制器
 *    PanelController 状态投影）；**当前未接线**（BrowserPanel 传 null）；
 * 2. **MVP 推断**（未接线时启用）：帧流 active 且**帧持续到达**（页面在动）
 *    且**无用户输入**（安静窗）→ 推断 AI 忙。依据：S0-01 实测「页面内容
 *    不变时帧率≈0」——AI 操作页面必然产生帧，静态页面 ≈ 0 帧；
 *    已知局限（注释登记）：页面自身动画/视频持续出帧时推断偏正（AI 空闲
 *    也显示忙），引擎事件接线后不再依赖推断。
 *
 * 迁移：[panelStatusMachine]（idle/ai-busy/paused/user-taking-over），
 * 接管 800ms 过渡（T-12：对齐维度 15 TOKEN_MIN_STABLE_WINDOW）由本 hook
 * 定时驱动。
 *
 * ## 接管信号（U-9③）
 * 用户输入（mousedown/keydown/wheel/compositionstart）→ `onUserInput`；
 * 该信号同时是「接管信号」——**前端只需发信号**：Rust 侧 InputPipeline
 * 已 bump 版本（R-1/U-1 注入即时 +1），吊销链唯一入口为维度 15 的
 * Coordinator（T-12：PanelController 仅呈现投影，不直接 abort）。
 *
 * ## 暂停/恢复（P1-B2 展示层）
 * `pause`/`resume` 仅推进本地状态机（指示条投影）；引擎侧暂停（AI 队列
 * 挂起）的接线点为 12 §9 `panel/commands.rs` 的 browser_pause/
 * browser_resume 命令（未注册，接线前按钮只切展示层——注释见 BrowserPanel）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrowserFrameState } from './browserPanelTypes';
import type { PanelStatus } from './browserPanelTypes';
import {
  nextPanelStatus,
  TOKEN_MIN_STABLE_WINDOW_MS,
  type PanelStatusEvent,
} from './panelStatusMachine';

/** 推断模式：帧到达活动窗口（超过此窗口无帧 = 页面静止，不推断 AI 忙）。 */
export const FRAME_ACTIVITY_MS = 1000;
/** 推断模式：无用户输入安静窗口（安静 + 页面在动才推断 AI 忙）。 */
export const USER_QUIET_MS = 1500;
/** 推断防抖（信号须稳定持续此窗口才迁移，防闪烁）。 */
export const INFER_HOLD_MS = 600;
/** 推断轮询间隔。 */
export const INFER_POLL_MS = 250;

export interface UsePanelStatusOptions {
  /** 帧流状态（推断模式前置条件：active）。 */
  frameState: BrowserFrameState;
  /** 最近帧序号（每帧变化 → 帧到达时间戳刷新；null = 无帧）。 */
  lastFrameSeq: number | null;
  /** 引擎侧 AI 忙信号（接线点：browser:status 事件；null = 未接线 → 推断）。 */
  engineAiBusy?: boolean | null;
  /** 推断参数注入（测试短窗/调参；缺省取默认常量）。 */
  frameActivityMs?: number;
  userQuietMs?: number;
  inferHoldMs?: number;
  inferPollMs?: number;
}

export interface UsePanelStatusResult {
  /** 指示条状态（12 §5.1）。 */
  status: PanelStatus;
  /** AI 动作文本（引擎事件携带时透出，例「AI 正在点击元素 [3]…」；
   *  未接线恒 null——接线点见 12 §5.2 browser:status）。 */
  aiActionText: string | null;
  /** 用户活动信号（接管观察；接线到 InputLayer/IME 桥）。 */
  onUserInput: () => void;
  /** 暂停（ai-busy/user-taking-over → paused；引擎侧命令接线点见模块头）。 */
  pause: () => void;
  /** 恢复（paused → idle）。 */
  resume: () => void;
}

export function usePanelStatus(opts: UsePanelStatusOptions): UsePanelStatusResult {
  const {
    frameState,
    lastFrameSeq,
    engineAiBusy = null,
    frameActivityMs = FRAME_ACTIVITY_MS,
    userQuietMs = USER_QUIET_MS,
    inferHoldMs = INFER_HOLD_MS,
    inferPollMs = INFER_POLL_MS,
  } = opts;

  const [status, setStatus] = useState<PanelStatus>('idle');

  // 状态机权威面（ref：迁移判定与定时回调不依赖渲染闭包）
  const statusRef = useRef<PanelStatus>('idle');
  // 推断输入面（ref：轮询读取最新值）
  const frameStateRef = useRef(frameState);
  frameStateRef.current = frameState;
  const engineBusyRef = useRef(engineAiBusy);
  engineBusyRef.current = engineAiBusy;
  const lastFrameAtRef = useRef(0);
  const lastUserInputAtRef = useRef(0);
  // 推断状态面
  const inferredRef = useRef(false); // 最近一次已派发的推断值
  const pendingInferRef = useRef<boolean | null>(null); // 防抖等待中的值
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 接管过渡定时（T-12：800ms）
  const takeoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 迁移派发 + 接管过渡定时管理。 */
  const dispatch = useCallback((evt: PanelStatusEvent) => {
    const prev = statusRef.current;
    const next = nextPanelStatus(prev, evt);
    if (next === prev) return;
    statusRef.current = next;
    setStatus(next);
    if (next === 'user-taking-over') {
      // T-12：进入接管 → 启动 800ms 过渡定时（对齐维度 15
      // TOKEN_MIN_STABLE_WINDOW；吊销后 AI 可重试的最小稳定窗）
      if (takeoverTimerRef.current !== null) {
        clearTimeout(takeoverTimerRef.current);
      }
      takeoverTimerRef.current = setTimeout(() => {
        takeoverTimerRef.current = null;
        dispatch({ type: 'TAKEOVER_TIMEOUT' });
      }, TOKEN_MIN_STABLE_WINDOW_MS);
    } else if (prev === 'user-taking-over') {
      if (takeoverTimerRef.current !== null) {
        clearTimeout(takeoverTimerRef.current);
        takeoverTimerRef.current = null;
      }
    }
  }, []);

  // 帧到达跟踪：每帧刷新（推断模式「页面在动」判定基准）
  useEffect(() => {
    if (lastFrameSeq === null) return;
    lastFrameAtRef.current = Date.now();
  }, [lastFrameSeq]);

  // 推断轮询：引擎未接线时按「帧在动 + 用户安静」推断；防抖后派发
  useEffect(() => {
    let disposed = false;

    const clearHold = () => {
      if (holdTimerRef.current !== null) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
    };

    const poll = () => {
      const now = Date.now();
      const engine = engineBusyRef.current;
      const inferred =
        engine !== null
          ? engine
          : frameStateRef.current === 'active' &&
            now - lastFrameAtRef.current <= frameActivityMs &&
            now - lastUserInputAtRef.current >= userQuietMs;
      if (pendingInferRef.current !== null) {
        if (inferred === pendingInferRef.current) return; // 防抖等待中且未变化
        clearHold(); // 推断翻转：重启防抖
      }
      if (inferred === inferredRef.current) return; // 与已派发一致
      pendingInferRef.current = inferred;
      holdTimerRef.current = setTimeout(() => {
        holdTimerRef.current = null;
        pendingInferRef.current = null;
        if (disposed) return;
        // 推断信号非引擎权威的抑制面：
        // - 暂停期不推断 AI 忙（12 §5.2：暂停 = 队列挂起，无新动作）；
        // - 接管期不推断 AI 结束（800ms 过渡由 TAKEOVER_TIMEOUT 负责）
        const engineWired = engineBusyRef.current !== null;
        if (inferred && statusRef.current === 'paused' && !engineWired) return;
        if (!inferred && statusRef.current === 'user-taking-over' && !engineWired) {
          return;
        }
        inferredRef.current = inferred;
        dispatch(inferred ? { type: 'AI_START' } : { type: 'AI_END' });
      }, inferHoldMs);
    };

    poll(); // 首轮立即求值（测试确定性）
    const timer = setInterval(poll, inferPollMs);
    return () => {
      disposed = true;
      clearInterval(timer);
      clearHold();
      if (takeoverTimerRef.current !== null) {
        clearTimeout(takeoverTimerRef.current);
        takeoverTimerRef.current = null;
      }
    };
  }, [dispatch, frameActivityMs, userQuietMs, inferHoldMs, inferPollMs]);

  /** 用户活动信号：刷新安静窗 + 推进接管状态机。 */
  const onUserInput = useCallback(() => {
    lastUserInputAtRef.current = Date.now();
    dispatch({ type: 'USER_INPUT' });
  }, [dispatch]);

  const pause = useCallback(() => dispatch({ type: 'PAUSE' }), [dispatch]);
  const resume = useCallback(() => dispatch({ type: 'RESUME' }), [dispatch]);

  return {
    status,
    aiActionText: null, // 引擎事件未接线（接线点：12 §5.2 browser:status）
    onUserInput,
    pause,
    resume,
  };
}
