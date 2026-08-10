/**
 * 面板输入捕获 hook（P1-B1：事件归一化 + 高频节流 + browser_input 上行）。
 *
 * 对齐 12 文档 §3：
 * - 坐标归一化：clientX/Y 相对输入层 rect → 面板 CSS 坐标 → contain 等比
 *   （与渲染共用 containFit）→ 页面坐标（§2.6：emulation 锁 1:1，
 *   setDeviceMetricsOverride dsf=1，pageScaleFactor=1，帧图 = 视口 CSS 像素）；
 * - 节流（任务书二选一：**Rust 侧按帧间隔合并为权威节流**，见
 *   browser/panel_input.rs 模块头注释）——前端 33ms 合并仅为 IPC 预过滤：
 *   mousemove 只保留最新 pending，wheel delta 同窗累加（§3.4 rAF 合并语义）；
 *   离散事件（down/up/key）直通不合并；
 * - 修饰键：按下状态集合 → CDP 位掩码（1=Alt 2=Ctrl 4=Meta 8=Shift，§3.1）；
 *   window blur → 补发已按住修饰键 keyUp + 清空（防 sticky 修饰键）；
 * - 点击计数（§3.5）：位移 <5px 且间隔 <500ms → clickCount 递增；
 * - 阻止默认行为：wheel / contextmenu / Tab（保持焦点在输入层内）。
 *
 * 键盘：本期仅 ASCII/功能键直转（key/code/VK 直取浏览器事件，§3.3）；
 * **合成期阻断**（P1-B2 IME 桥接管该路径）：`compositionstart` 至
 * `compositionend` 期间 keydown/keyup 一律不转发（12 §3.7 防双输入）；
 * 合成键（keyCode 229）恒不转发（S0-03 C1：Process 键无转发价值，
 * 页面不会因 229 触发合成——转发虽无害但无意义）。
 *
 * 反馈约定：输入事件不 toast（高频面，仅 console.debug 留痕）；invoke
 * 失败静默（no-wait 语义，引擎侧路由吞错）。
 */
import { useCallback, useEffect, useRef } from 'react';
import { sendBrowserInput } from '../../../api/browserSessionApi';
import type { BrowserInputEventPayload } from './browserPanelTypes';
import type { BrowserFrameMeta } from './browserPanelTypes';
import {
  cdpModifiers,
  ClickCounter,
  containFit,
  normalizeWheelDelta,
  panelPointToPagePoint,
  pointerButtonsMask,
} from './inputNormalize';

/** 前端合并窗（IPC 预过滤；权威节流在 Rust 侧按帧间隔合并）。 */
const FRONTEND_FLUSH_MS = 33;

export interface UsePanelInputOptions {
  /** 帧流激活才转发（未激活时仅本地维护状态，不 invoke）。 */
  enabled: boolean;
  /** 最近帧元信息（坐标映射基准；null = 无帧，按 1:1 面板坐标兜底）。 */
  getFrameMeta: () => BrowserFrameMeta | null;
  /** 输入层 DOMRect（相对坐标基准 = 面板内容区 CSS 尺寸）。 */
  getRect: () => DOMRect | null;
  /** 合成期（IME 桥）：合成中一律不转发键盘（12 §3.7；ref 读最新）。 */
  composing?: boolean;
  /** 用户活动回调（接管信号观察：mousedown/wheel/keydown 时触发；
   *  吊销链在维度 15 Coordinator，前端仅发信号——T-12/U-9③）。 */
  onUserInput?: () => void;
}

export interface PanelInputHandlers {
  onMouseDown: (e: React.MouseEvent) => void;
  onMouseMove: (e: React.MouseEvent) => void;
  onMouseUp: (e: React.MouseEvent) => void;
  onWheel: (e: React.WheelEvent) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onKeyUp: (e: React.KeyboardEvent) => void;
  onBlur: () => void;
}

interface PendingMove {
  x: number;
  y: number;
  button: NonNullable<BrowserInputEventPayload['button']>;
  buttons: number;
  clickCount: number;
  modifiers: number;
}

interface WheelAccum {
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  modifiers: number;
}

export function usePanelInput(opts: UsePanelInputOptions): PanelInputHandlers {
  const { enabled, getFrameMeta, getRect } = opts;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const metaRef = useRef(getFrameMeta);
  metaRef.current = getFrameMeta;
  const rectRef = useRef(getRect);
  rectRef.current = getRect;
  // 合成期（IME 桥）与用户活动回调：ref 面读最新（高频不触发渲染）
  const composingRef = useRef(opts.composing ?? false);
  composingRef.current = opts.composing ?? false;
  const userInputRef = useRef(opts.onUserInput);
  userInputRef.current = opts.onUserInput;

  // 状态面（ref：高频读写不触发渲染）
  const buttonsRef = useRef(0);
  const modifiersRef = useRef({ ctrl: false, shift: false, alt: false, meta: false });
  const heldButtonRef = useRef<NonNullable<BrowserInputEventPayload['button']>>('none');
  const clickCounterRef = useRef(new ClickCounter());
  const lastClickCountRef = useRef(1);
  const pendingMoveRef = useRef<PendingMove | null>(null);
  const wheelAccumRef = useRef<WheelAccum | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 页面坐标（§2.6 单一比例换算；无帧时按 1:1 面板坐标兜底）。 */
  const toPagePoint = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } => {
      const rect = rectRef.current();
      if (!rect) return { x: 0, y: 0 };
      const frame = metaRef.current();
      const fit = containFit(
        rect.width,
        rect.height,
        frame?.width ?? rect.width,
        frame?.height ?? rect.height,
      );
      return panelPointToPagePoint(clientX - rect.left, clientY - rect.top, fit);
    },
    [],
  );

  const currentModifiers = useCallback((): number => {
    const m = modifiersRef.current;
    return cdpModifiers(m.ctrl, m.shift, m.alt, m.meta);
  }, []);

  /** 单发（离散事件直通；no-wait，失败静默留痕）。 */
  const send = useCallback((event: BrowserInputEventPayload) => {
    if (!enabledRef.current) return;
    sendBrowserInput(event).catch(() => {
      /* 输入面静默（高频，不 toast） */
    });
  }, []);

  /** 合并窗 flush：move 最新值 + wheel 累加各派发一次。 */
  const flushPending = useCallback(() => {
    const move = pendingMoveRef.current;
    pendingMoveRef.current = null;
    if (move) {
      send({
        kind: 'mouse',
        action: 'move',
        x: move.x,
        y: move.y,
        button: move.button,
        buttons: move.buttons,
        clickCount: move.clickCount,
        modifiers: move.modifiers,
      });
    }
    const wheel = wheelAccumRef.current;
    wheelAccumRef.current = null;
    if (wheel) {
      send({
        kind: 'wheel',
        x: wheel.x,
        y: wheel.y,
        deltaX: wheel.deltaX,
        deltaY: wheel.deltaY,
        modifiers: wheel.modifiers,
      });
    }
  }, [send]);

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current !== null) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      flushPending();
    }, FRONTEND_FLUSH_MS);
  }, [flushPending]);

  /** 清空合并窗（失焦/拖出兜底，防陈旧事件落地）。 */
  const clearPending = useCallback(() => {
    pendingMoveRef.current = null;
    wheelAccumRef.current = null;
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }, []);

  /** 补发按住修饰键 keyUp + 清空状态（12 §3.1 防 sticky 修饰键）。 */
  const releaseHeldModifiers = useCallback(() => {
    const m = modifiersRef.current;
    const held: Array<[boolean, string, number]> = [
      [m.ctrl, 'Control', 17],
      [m.shift, 'Shift', 16],
      [m.alt, 'Alt', 18],
      [m.meta, 'Meta', 91],
    ];
    for (const [pressed, key, vk] of held) {
      if (pressed) {
        send({
          kind: 'key',
          action: 'up',
          key,
          code: key,
          windowsVirtualKeyCode: vk,
        });
      }
    }
    m.ctrl = false;
    m.shift = false;
    m.alt = false;
    m.meta = false;
    clearPending();
    clickCounterRef.current.reset();
  }, [send, clearPending]);

  // window blur：补发按住修饰键 keyUp + 清空状态（12 §3.1 防 sticky）
  useEffect(() => {
    const onWindowBlur = () => {
      releaseHeldModifiers();
    };
    window.addEventListener('blur', onWindowBlur);
    return () => window.removeEventListener('blur', onWindowBlur);
  }, [releaseHeldModifiers]);

  // ── 鼠标 ──

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (enabledRef.current) userInputRef.current?.();
      const { x, y } = toPagePoint(e.clientX, e.clientY);
      const button: NonNullable<BrowserInputEventPayload['button']> =
        e.button === 0
          ? 'left'
          : e.button === 1
            ? 'middle'
            : e.button === 2
              ? 'right'
              : e.button === 3
                ? 'back'
                : e.button === 4
                  ? 'forward'
                  : 'none';
      heldButtonRef.current = button;
      const buttons = pointerButtonsMask(e.buttons || 1 << Math.max(e.button, 0));
      buttonsRef.current = buttons;
      const clickCount = clickCounterRef.current.down(x, y);
      lastClickCountRef.current = clickCount;
      // 离散事件直通（press 前由引擎侧 flush 积压 move，事件序保真）
      send({
        kind: 'mouse',
        action: 'down',
        x,
        y,
        button,
        buttons,
        clickCount,
        modifiers: currentModifiers(),
      });
    },
    [send, toPagePoint, currentModifiers],
  );

  const onMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!enabledRef.current) return;
      const { x, y } = toPagePoint(e.clientX, e.clientY);
      buttonsRef.current = pointerButtonsMask(e.buttons);
      // 高频合并（最新优先；IPC 预过滤，权威节流在 Rust 侧）
      pendingMoveRef.current = {
        x,
        y,
        button: heldButtonRef.current,
        buttons: buttonsRef.current,
        clickCount: lastClickCountRef.current,
        modifiers: currentModifiers(),
      };
      scheduleFlush();
    },
    [toPagePoint, currentModifiers, scheduleFlush],
  );

  const onMouseUp = useCallback(
    (e: React.MouseEvent) => {
      const { x, y } = toPagePoint(e.clientX, e.clientY);
      const button =
        e.button === 0
          ? 'left'
          : e.button === 1
            ? 'middle'
            : e.button === 2
              ? 'right'
              : e.button === 3
                ? 'back'
                : e.button === 4
                  ? 'forward'
                  : 'none';
      buttonsRef.current = pointerButtonsMask(e.buttons);
      if (heldButtonRef.current === button) {
        heldButtonRef.current = 'none';
      }
      send({
        kind: 'mouse',
        action: 'up',
        x,
        y,
        button,
        buttons: buttonsRef.current,
        clickCount: lastClickCountRef.current,
        modifiers: currentModifiers(),
      });
    },
    [send, toPagePoint, currentModifiers],
  );

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault(); // 阻止 webview 自身滚动（12 §3.1）
      if (!enabledRef.current) return;
      userInputRef.current?.();
      const { x, y } = toPagePoint(e.clientX, e.clientY);
      const rect = rectRef.current();
      const viewportHeight = rect?.height || 0;
      // §3.4：deltaMode 归一化为像素（0 直用 / 1 行×16 / 2 页×视口高）
      const { deltaX, deltaY } = normalizeWheelDelta(
        e.deltaMode,
        e.deltaX,
        e.deltaY,
        viewportHeight,
      );
      const accum = wheelAccumRef.current;
      if (accum) {
        accum.deltaX += deltaX;
        accum.deltaY += deltaY;
        accum.x = x;
        accum.y = y;
        accum.modifiers = currentModifiers(); // ctrl+wheel 保留 ctrl 位 → 页面缩放
      } else {
        wheelAccumRef.current = {
          x,
          y,
          deltaX,
          deltaY,
          modifiers: currentModifiers(),
        };
      }
      scheduleFlush();
    },
    [toPagePoint, currentModifiers, scheduleFlush],
  );

  // ── 键盘（本期 ASCII/功能键直转；IME 桥 P1-B2）──

  const keyPayload = useCallback(
    (e: React.KeyboardEvent, isUp: boolean): BrowserInputEventPayload => {
      const m = modifiersRef.current;
      const modifiers = cdpModifiers(m.ctrl, m.shift, m.alt, m.meta);
      const base: BrowserInputEventPayload = {
        kind: 'key',
        action: isUp ? 'up' : 'down',
        key: e.key,
        code: e.code,
        windowsVirtualKeyCode: e.keyCode,
        nativeVirtualKeyCode: e.keyCode,
        autoRepeat: e.repeat,
        modifiers,
        location: e.location,
      };
      if (!isUp && e.key.length === 1 && !m.ctrl && !m.alt && !m.meta) {
        // 可打印字符：text = 字符（§3.3；组合键 text 置空——Ctrl+A 全选语义）
        base.text = e.key;
      } else if (!isUp && e.key === 'Enter') {
        base.text = '\r'; // §3.3：Enter text="\r"
      } else if (!isUp && e.key === 'Tab') {
        base.text = '\t'; // §3.3：Tab text="\t"
      }
      return base;
    },
    [],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // 合成期（IME 桥）：keydown/keyup 一律不转发（12 §3.7 防双输入）
      if (composingRef.current) return;
      // 合成键（keyCode 229）恒不转发（S0-03 C1：Process 键无转发价值）
      if (e.keyCode === 229) return;
      // Tab：阻止焦点逃逸（Tab 注入页面而非浏览器 chrome）
      if (e.key === 'Tab') e.preventDefault();
      if (e.key === 'Backspace' && e.metaKey) e.preventDefault(); // 防 webview 后退
      const m = modifiersRef.current;
      if (e.key === 'Control') m.ctrl = true;
      else if (e.key === 'Shift') m.shift = true;
      else if (e.key === 'Alt') m.alt = true;
      else if (e.key === 'Meta') m.meta = true;
      if (enabledRef.current) userInputRef.current?.();
      send(keyPayload(e, false));
    },
    [send, keyPayload],
  );

  const onKeyUp = useCallback(
    (e: React.KeyboardEvent) => {
      // 合成期（IME 桥）不转发（12 §3.7）
      if (composingRef.current) return;
      if (e.keyCode === 229) return;
      const m = modifiersRef.current;
      if (e.key === 'Control') m.ctrl = false;
      else if (e.key === 'Shift') m.shift = false;
      else if (e.key === 'Alt') m.alt = false;
      else if (e.key === 'Meta') m.meta = false;
      send(keyPayload(e, true));
    },
    [send, keyPayload],
  );

  const onBlur = useCallback(() => {
    // 键盘注入前置：焦点丢失 → 补发修饰键 keyUp + 清空（防 sticky）
    releaseHeldModifiers();
  }, [releaseHeldModifiers]);

  return { onMouseDown, onMouseMove, onMouseUp, onWheel, onKeyDown, onKeyUp, onBlur };
}
