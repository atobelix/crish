/**
 * apps/crish-desktop/src/components/ui/SplitResizer/useSplitResize.ts
 *
 * 统一分栏拖拽 hook（泛化自 useTreeResize 的手势机制，与布局树解耦，px 尺寸域）。
 *
 * 托管的手势协议（全仓收敛为这一套）：
 * 1. pointerdown 于 separator 元素 → setPointerCapture；window 级 pointermove /
 *    pointerup 监听（捕获后事件仍冒泡至 window），rAF 节流后只更新 ref 与
 *    live CSS 变量，拖拽全程零 React setState、零每帧重渲染；
 * 2. Esc 取消并恢复起始值；blur / pointercancel / lostpointercapture 按
 *    「提交当前值结束」兜底（与 useTreeResize 的看门狗恢复语义一致）；
 * 3. 拖拽期 body 协议唯一化：`data-split-resizing="<orientation>"` 属性 +
 *    body 内联 cursor 锁定，结束即清理；
 * 4. 提交模式可配：'release'（默认，松手一次性提交）/ 'live'（rAF 节流实时提交）；
 * 5. 钳位 [min, max] 与折叠阈值 collapseBelow 由调用方传入；原始（未钳制）目标
 *    经 rawValueRef 暴露给呈现层做橡皮筋 / 触限形态；折叠时机可配：默认松手
 *    判定（跌破阈值并松手才 onCollapse），liveCollapse 开启时改为拖中实时
 *    口径——原始值跌破阈值即进入折叠区、呈现值归 0（面板在拖拽流中当场
 *    收起，用户 2026-11-03 裁决：松手才消失会被误读为最小宽度），拖回阈值
 *    之上（带迟滞）即退出、呈现恢复；store 层折叠提交仍在松手时以
 *    onCollapse 落定，Esc 取消不折叠；
 * 6. 键盘：方向键步进（Shift 大步）、Home/End 到界，立即提交；
 * 7. 双击复位：defaultValue 存在时提交复位值，并回调 onReset。
 *
 * 呈现（弹性手柄等）由消费组件经 liveValueRef / rawValueRef / phaseRef 读取，
 * 本 hook 不感知任何视觉形态。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from 'react';

export type SplitResizeOrientation = 'vertical' | 'horizontal';
export type SplitResizeCommitMode = 'release' | 'live';
export type SplitResizePhase = 'idle' | 'dragging';

export interface UseSplitResizeOptions {
  /** 当前已提交尺寸（px，受控） */
  value: number;
  min: number;
  max: number;
  /** 分界线方向：vertical = 竖线、沿 X 拖拽调宽（默认）；horizontal = 横线、沿 Y 调高 */
  orientation?: SplitResizeOrientation;
  /**
   * 轴向符号：1（默认）= 指针沿轴正向移动时尺寸增大；
   * -1 = 反向（如分界线位于被调面板左侧、调右侧坞宽时）。
   */
  axisSign?: 1 | -1;
  /** 键盘步进（px，默认 10，与 TreeResizeSash 现行口径一致） */
  step?: number;
  /** 键盘大步（Shift，默认 50） */
  largeStep?: number;
  /** 提交模式：默认 'release'（松手提交）；'live' = 拖中 rAF 节流提交 */
  commitMode?: SplitResizeCommitMode;
  /**
   * 折叠阈值（px）：拖拽原始值低于此值并松手时触发 onCollapse 而非 onCommit。
   * 仅在提供 onCollapse 时生效。
   */
  collapseBelow?: number;
  /**
   * 实时折叠（默认关）：开启后（须同时提供 collapseBelow 与 onCollapse）
   * 拖拽原始值跌破 collapseBelow 即进入折叠区——liveValueRef / live CSS
   * 变量归 0，呈现层据此在拖拽流中当场收起面板；原始值回到
   * collapseBelow + 迟滞量之上才退出折叠区（防阈值边缘抖动翻转弹簧
   * 目标）。折叠区内不发 onLiveChange、不做 live 提交（0 不是宽度）；
   * 松手时若仍在折叠区走 onCollapse 落定，退出后松手按正常钳制值提交；
   * Esc 取消恢复起始值且不折叠。关闭时行为与旧口径逐字一致。
   */
  liveCollapse?: boolean;
  /** 双击复位目标（px）；未提供时双击仅回调 onReset */
  defaultValue?: number;
  disabled?: boolean;
  /** 提交回调（松手 / 键盘 / 双击 / live 模式拖中节流） */
  onCommit?: (value: number) => void;
  /** rAF 节流的钳制后实时值（呈现层自绘面板时使用） */
  onLiveChange?: (value: number) => void;
  /** 松手时原始值跌破折叠阈值（或 liveCollapse 下仍在折叠区）时触发（替代该次 onCommit） */
  onCollapse?: () => void;
  /** 双击复位时触发（无论是否提供 defaultValue） */
  onReset?: () => void;
  /** 拖拽开始 / 结束（含取消）时触发，供呈现层切换状态机 */
  onDragStateChange?: (dragging: boolean) => void;
  /**
   * 唤醒呈现层动画循环的信号：手势开始、拖拽原始目标变化（rAF 落定后）、
   * 键盘 / 双击 / 程序化设定改变目标时触发
   */
  onWakeRequest?: () => void;
  /**
   * 拖中实时写入的 CSS 变量（呈现层自管时勿传，如 SplitResizer 的弹簧引擎）：
   * 拖拽期每帧把钳制后尺寸写为 `<value>px`，结束时移除。
   */
  liveCssVar?: {
    name: string;
    target?: () => HTMLElement | null;
  };
}

export interface SplitResizeSeparatorProps {
  role: 'separator';
  tabIndex: number;
  'aria-orientation': SplitResizeOrientation;
  'aria-valuemin': number;
  'aria-valuemax': number;
  'aria-valuenow': number;
  'aria-disabled': boolean | undefined;
  'data-dragging': true | undefined;
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
  onDoubleClick: () => void;
}

export interface UseSplitResizeResult {
  dragging: boolean;
  phaseRef: MutableRefObject<SplitResizePhase>;
  /** 钳制后的呈现目标（px），每 rAF 更新 */
  liveValueRef: MutableRefObject<number>;
  /** 未钳制的原始目标（px），橡皮筋 / 触限形态的输入 */
  rawValueRef: MutableRefObject<number>;
  /** 本次拖拽的起始尺寸（px） */
  dragStartValueRef: MutableRefObject<number>;
  /**
   * 实时折叠区状态（liveCollapse 开启时有效）：true = 当前拖拽已跌破
   * 折叠阈值、呈现应收起。呈现层逐帧读取以驱动折叠呈现（如弹性引擎的
   * 位置目标归 0），与 liveValueRef 的归 0 同步。
   */
  collapseZoneRef: MutableRefObject<boolean>;
  separatorProps: SplitResizeSeparatorProps;
  /** 程序化设定并提交（钳制后） */
  setValue: (value: number) => void;
  /** 程序化步进并提交 */
  nudge: (deltaPx: number) => void;
  /** 触发双击复位等价动作 */
  reset: () => void;
}

interface DragContext {
  pointerId: number;
  captureEl: HTMLElement;
  startClient: number;
  startValue: number;
}

const DEFAULT_STEP = 10;
const DEFAULT_LARGE_STEP = 50;
/**
 * 实时折叠的退出迟滞（px）：进入折叠区只需跌破 collapseBelow，退出须
 * 回到 collapseBelow + 本值之上。迟滞带宽小于「阈值 → 最小钳制值」的
 * 间距时不可见（退出点仍在钳制下限之下，展开直接落回 min），只防指针
 * 在阈值边缘 ±数 px 抖动时呈现目标在 0 与钳制值之间逐帧翻转。
 */
const COLLAPSE_ZONE_EXIT_SLACK_PX = 24;

export function clampSplitSize(
  value: number,
  min: number,
  max: number
): number {
  if (!Number.isFinite(value)) return min;
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.min(hi, Math.max(lo, value));
}

export function useSplitResize(
  options: UseSplitResizeOptions
): UseSplitResizeResult {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const orientation: SplitResizeOrientation = options.orientation ?? 'vertical';
  const min = options.min;
  const max = options.max;

  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);
  const phaseRef = useRef<SplitResizePhase>('idle');
  const valueRef = useRef(options.value);
  const liveValueRef = useRef(options.value);
  const rawValueRef = useRef(options.value);
  const dragStartValueRef = useRef(options.value);
  const collapseZoneRef = useRef(false);
  const dragCtxRef = useRef<DragContext | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const pendingClientRef = useRef<number | null>(null);
  const lastLiveNotifiedRef = useRef(options.value);
  const lastLiveCommittedRef = useRef(options.value);

  // 非拖拽期，受控值变化同步到各 ref 基线
  useEffect(() => {
    if (draggingRef.current) return;
    valueRef.current = options.value;
    liveValueRef.current = options.value;
    rawValueRef.current = options.value;
    lastLiveNotifiedRef.current = options.value;
    lastLiveCommittedRef.current = options.value;
  }, [options.value]);

  const clientFromEvent = useCallback(
    (e: PointerEvent) => (orientation === 'vertical' ? e.clientX : e.clientY),
    [orientation]
  );

  const writeLiveCssVar = useCallback((px: number | null) => {
    const spec = optionsRef.current.liveCssVar;
    if (!spec) return;
    const target = spec.target?.() ?? null;
    if (!target) return;
    if (px === null) target.style.removeProperty(spec.name);
    else target.style.setProperty(spec.name, `${px}px`);
  }, []);

  /** 由最新指针位置计算并写入 refs（rAF 内调用） */
  const applyPendingClient = useCallback(() => {
    const ctx = dragCtxRef.current;
    const client = pendingClientRef.current;
    if (!ctx || client === null) return;
    const o = optionsRef.current;
    const sign = o.axisSign ?? 1;
    const raw = ctx.startValue + (client - ctx.startClient) * sign;
    const rawChanged = raw !== rawValueRef.current;
    rawValueRef.current = raw;
    // 原始目标变化后唤醒呈现层：呈现层可能已在「拖拽中静止」时停循环，
    // 且其监听注册早于本 hook，同一事件批次内总是先读到旧目标——
    // 必须在目标落定后主动唤醒，否则最后一次移动会被漏掉一拍
    if (rawChanged) o.onWakeRequest?.();
    const clamped = clampSplitSize(raw, o.min, o.max);
    // 实时折叠区判定（仅 liveCollapse 且阈值三件套齐备时运行）：跌破
    // collapseBelow 进入、回到阈值 + 迟滞量之上退出（见常量注释）。
    // 折叠区内呈现值归 0：面板在拖拽流中当场收起；onLiveChange 与
    // live 提交一并抑制（0 不是宽度，可见宽镜像与提交值都保留进区前
    // 的钳制值，退出时差分判定自然补发）。
    if (o.liveCollapse && o.collapseBelow !== undefined && o.onCollapse) {
      if (!collapseZoneRef.current && raw < o.collapseBelow) {
        collapseZoneRef.current = true;
      } else if (
        collapseZoneRef.current &&
        raw >= o.collapseBelow + COLLAPSE_ZONE_EXIT_SLACK_PX
      ) {
        collapseZoneRef.current = false;
      }
    } else if (collapseZoneRef.current) {
      collapseZoneRef.current = false;
    }
    const inCollapseZone = collapseZoneRef.current;
    const effectiveLive = inCollapseZone ? 0 : clamped;
    liveValueRef.current = effectiveLive;
    writeLiveCssVar(effectiveLive);
    if (!inCollapseZone) {
      if (clamped !== lastLiveNotifiedRef.current) {
        lastLiveNotifiedRef.current = clamped;
        o.onLiveChange?.(clamped);
      }
      if (o.commitMode === 'live' && clamped !== lastLiveCommittedRef.current) {
        lastLiveCommittedRef.current = clamped;
        valueRef.current = clamped;
        o.onCommit?.(clamped);
      }
    }
  }, [writeLiveCssVar]);

  const scheduleFrame = useCallback(() => {
    if (rafIdRef.current !== null) return;
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      applyPendingClient();
    });
  }, [applyPendingClient]);

  const cleanupDragDom = useCallback(
    (ctx: DragContext) => {
      try {
        if (ctx.captureEl.hasPointerCapture?.(ctx.pointerId)) {
          ctx.captureEl.releasePointerCapture(ctx.pointerId);
        }
      } catch {
        /* ignore — 捕获可能已被浏览器回收 */
      }
      document.body.style.cursor = '';
      document.body.removeAttribute('data-split-resizing');
      writeLiveCssVar(null);
    },
    [writeLiveCssVar]
  );

  /** 结束手势：commit=true 提交当前钳制值（或触发折叠）；false 恢复起始值 */
  const finishDrag = useCallback(
    (commit: boolean) => {
      const ctx = dragCtxRef.current;
      if (!ctx) return;
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      // 先吃掉最后一帧未处理的指针位置，保证提交值与释放点一致
      if (pendingClientRef.current !== null) {
        applyPendingClient();
        pendingClientRef.current = null;
      }
      const o = optionsRef.current;
      const raw = rawValueRef.current;
      dragCtxRef.current = null;
      draggingRef.current = false;
      phaseRef.current = 'idle';
      cleanupDragDom(ctx);

      if (commit) {
        const collapseBelow = o.collapseBelow;
        if (
          collapseBelow !== undefined &&
          o.onCollapse &&
          (collapseZoneRef.current || raw < collapseBelow)
        ) {
          liveValueRef.current = ctx.startValue;
          rawValueRef.current = ctx.startValue;
          o.onCollapse();
        } else {
          const clamped = clampSplitSize(raw, o.min, o.max);
          liveValueRef.current = clamped;
          rawValueRef.current = clamped;
          valueRef.current = clamped;
          lastLiveCommittedRef.current = clamped;
          if (clamped !== ctx.startValue || o.commitMode === 'live') {
            o.onCommit?.(clamped);
          }
        }
      } else {
        liveValueRef.current = ctx.startValue;
        rawValueRef.current = ctx.startValue;
        lastLiveNotifiedRef.current = ctx.startValue;
        o.onLiveChange?.(ctx.startValue);
      }
      collapseZoneRef.current = false;
      setDragging(false);
      o.onDragStateChange?.(false);
    },
    [applyPendingClient, cleanupDragDom]
  );

  // ── 拖拽期 window 监听（镜像 useTreeResize 的装配方式） ──────────

  useEffect(() => {
    if (!dragging) return;

    const handlePointerMove = (e: PointerEvent) => {
      const ctx = dragCtxRef.current;
      if (!ctx || e.pointerId !== ctx.pointerId) return;
      pendingClientRef.current = clientFromEvent(e);
      scheduleFrame();
    };
    const handlePointerUp = (e: PointerEvent) => {
      const ctx = dragCtxRef.current;
      if (!ctx || e.pointerId !== ctx.pointerId) return;
      pendingClientRef.current = clientFromEvent(e);
      finishDrag(true);
    };
    const handleInterrupt = () => {
      // blur / pointercancel / lostpointercapture：按提交当前值结束兜底
      if (dragCtxRef.current) finishDrag(true);
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finishDrag(false);
    };

    const captureEl = dragCtxRef.current?.captureEl;
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('blur', handleInterrupt);
    window.addEventListener('pointercancel', handleInterrupt);
    captureEl?.addEventListener('lostpointercapture', handleInterrupt);
    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('blur', handleInterrupt);
      window.removeEventListener('pointercancel', handleInterrupt);
      captureEl?.removeEventListener('lostpointercapture', handleInterrupt);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [dragging, clientFromEvent, scheduleFrame, finishDrag]);

  // 卸载保底：拖拽中途卸载不遗留 body 协议与指针捕获
  useEffect(() => {
    return () => {
      const ctx = dragCtxRef.current;
      if (ctx) {
        dragCtxRef.current = null;
        cleanupDragDom(ctx);
      }
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [cleanupDragDom]);

  // ── 手势入口 ─────────────────────────────────────────────────────

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const o = optionsRef.current;
      if (o.disabled || e.button !== 0) return;
      e.preventDefault();
      const captureEl = e.currentTarget as HTMLElement;
      try {
        captureEl.setPointerCapture(e.pointerId);
      } catch {
        /* ignore — 部分环境 / 非 primary 指针可能失败 */
      }
      const startValue = clampSplitSize(valueRef.current, o.min, o.max);
      dragCtxRef.current = {
        pointerId: e.pointerId,
        captureEl,
        startClient: clientFromEvent(e.nativeEvent),
        startValue,
      };
      dragStartValueRef.current = startValue;
      collapseZoneRef.current = false;
      rawValueRef.current = startValue;
      liveValueRef.current = startValue;
      lastLiveNotifiedRef.current = startValue;
      lastLiveCommittedRef.current = startValue;
      draggingRef.current = true;
      phaseRef.current = 'dragging';
      document.body.style.cursor =
        orientation === 'vertical' ? 'col-resize' : 'row-resize';
      document.body.setAttribute('data-split-resizing', orientation);
      setDragging(true);
      o.onDragStateChange?.(true);
      o.onWakeRequest?.();
    },
    [clientFromEvent, orientation]
  );

  const commitValue = useCallback((next: number) => {
    const o = optionsRef.current;
    const clamped = clampSplitSize(next, o.min, o.max);
    valueRef.current = clamped;
    liveValueRef.current = clamped;
    rawValueRef.current = clamped;
    lastLiveNotifiedRef.current = clamped;
    lastLiveCommittedRef.current = clamped;
    o.onLiveChange?.(clamped);
    o.onCommit?.(clamped);
    o.onWakeRequest?.();
  }, []);

  const setValue = useCallback(
    (next: number) => {
      if (optionsRef.current.disabled) return;
      commitValue(next);
    },
    [commitValue]
  );

  const nudge = useCallback(
    (deltaPx: number) => {
      if (optionsRef.current.disabled) return;
      commitValue(valueRef.current + deltaPx);
    },
    [commitValue]
  );

  const reset = useCallback(() => {
    const o = optionsRef.current;
    if (o.disabled) return;
    if (o.defaultValue !== undefined) {
      commitValue(o.defaultValue);
    }
    o.onReset?.();
  }, [commitValue]);

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLElement>) => {
      const o = optionsRef.current;
      if (o.disabled) return;
      const step = o.step ?? DEFAULT_STEP;
      const largeStep = o.largeStep ?? DEFAULT_LARGE_STEP;
      const delta = e.shiftKey ? largeStep : step;
      const sign = o.axisSign ?? 1;
      const horiz = orientation === 'horizontal';
      const increaseKey = horiz
        ? sign > 0
          ? 'ArrowDown'
          : 'ArrowUp'
        : sign > 0
          ? 'ArrowRight'
          : 'ArrowLeft';
      const decreaseKey = horiz
        ? sign > 0
          ? 'ArrowUp'
          : 'ArrowDown'
        : sign > 0
          ? 'ArrowLeft'
          : 'ArrowRight';
      let next: number | null = null;
      if (e.key === increaseKey) next = valueRef.current + delta;
      else if (e.key === decreaseKey) next = valueRef.current - delta;
      else if (e.key === 'Home') next = o.min;
      else if (e.key === 'End') next = o.max;
      if (next === null) return;
      e.preventDefault();
      commitValue(next);
    },
    [commitValue, orientation]
  );

  const handleDoubleClick = useCallback(() => {
    reset();
  }, [reset]);

  const separatorProps = useMemo<SplitResizeSeparatorProps>(
    () => ({
      role: 'separator',
      tabIndex: options.disabled ? -1 : 0,
      'aria-orientation': orientation,
      'aria-valuemin': Math.round(min),
      'aria-valuemax': Math.round(max),
      'aria-valuenow': Math.round(options.value),
      'aria-disabled': options.disabled || undefined,
      'data-dragging': dragging || undefined,
      onPointerDown: handlePointerDown,
      onKeyDown: handleKeyDown,
      onDoubleClick: handleDoubleClick,
    }),
    [
      options.disabled,
      options.value,
      orientation,
      min,
      max,
      dragging,
      handlePointerDown,
      handleKeyDown,
      handleDoubleClick,
    ]
  );

  return useMemo<UseSplitResizeResult>(
    () => ({
      dragging,
      phaseRef,
      liveValueRef,
      rawValueRef,
      dragStartValueRef,
      collapseZoneRef,
      separatorProps,
      setValue,
      nudge,
      reset,
    }),
    [dragging, separatorProps, setValue, nudge, reset]
  );
}
