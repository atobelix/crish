import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import { getDesktopDaemonClient } from '../api/daemonClient';
import { isErrorToastCandidate } from '../hooks/useToastQueue';
import {
  RuntimePanel,
  formatEngineStatusFull,
  formatEngineStatusShort,
  formatEngineStatusTitle,
} from './RuntimePanel';
import styles from './RuntimeFloatPanel.module.css';
import { Tooltip } from './settings/SettingsUI';

interface RuntimeFloatPanelProps {
  open: boolean;
  onClose: () => void;
  onShowToast: (msg: string) => void;
}

/** 悬浮层内可聚焦控件（Tab 环） */
const FOCUSABLE_SEL =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** 读屏补充：面板用途 + 关闭方式（中文） */
export function formatFloatDialogDescription(): string {
  return '运行状态。按 Esc 关闭。';
}

/**
 * 悬浮层 chrome 离线提示（与 RuntimePanel 区内空态互补，一行紧凑）。
 */
export function formatFloatOfflineChromeHint(): string {
  return '引擎未连接';
}

/**
 * 悬浮层 toast 闸门：成功/空/提示静默，仅透传错误类文案。
 * 防止打开/刷新路径的成功刷屏回流。
 */
export function filterRuntimeFloatToast(message: string): string | null {
  const m = (message || '').trim();
  if (!m) return null;
  return isErrorToastCandidate(m) ? m : null;
}

/** 收集 sheet 内可见可聚焦元素 */
export function listFloatFocusables(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SEL)).filter((el) => {
    if (el.getAttribute('aria-hidden') === 'true') return false;
    // 隐藏或零尺寸不进环；当前焦点例外（避免中途消失打断）
    if (el === document.activeElement) return true;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    return el.getClientRects().length > 0;
  });
}

/**
 * Compact floating sheet — no dimming mask, does not steal chat layout.
 * 中文 chrome / a11y / 关闭焦点 / 离线提示 / 错误-only toast。
 */
export const RuntimeFloatPanel: React.FC<RuntimeFloatPanelProps> = ({
  open,
  onClose,
  onShowToast,
}) => {
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  /** 打开前焦点，关闭后还原，避免键盘用户丢位置 */
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descId = useId();
  const offlineHintId = useId();

  const [engineOnline, setEngineOnline] = useState(() =>
    getDesktopDaemonClient().isConnected(),
  );

  // 订阅引擎连接态，供 chrome 徽章与离线条使用
  useEffect(() => {
    const client = getDesktopDaemonClient();
    setEngineOnline(client.isConnected());
    const unsub = client.onState((s) => {
      setEngineOnline(s === 'connected' && client.isConnected());
    });
    return () => {
      if (typeof unsub === 'function') unsub();
    };
  }, []);

  /** 仅错误 toast；成功路径静默（列表/状态变化即反馈） */
  const handleShowToast = useCallback(
    (msg: string) => {
      const allowed = filterRuntimeFloatToast(msg);
      if (allowed == null) return;
      onShowToast(allowed);
    },
    [onShowToast],
  );

  useEffect(() => {
    if (!open) return;

    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      // Tab 环：焦点困在 sheet 内，不落到背后聊天
      if (e.key !== 'Tab') return;
      const list = listFloatFocusables(sheetRef.current);
      if (list.length === 0) {
        e.preventDefault();
        closeBtnRef.current?.focus();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (!active || active === first || !sheetRef.current?.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (!active || active === last || !sheetRef.current?.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKey, true);
    // 打开后焦点落到关闭钮，便于键盘立刻 Esc/Enter 关闭；不 toast
    const raf = requestAnimationFrame(() => {
      closeBtnRef.current?.focus();
    });

    return () => {
      window.removeEventListener('keydown', onKey, true);
      cancelAnimationFrame(raf);
      const prev = previousFocusRef.current;
      previousFocusRef.current = null;
      if (prev && typeof prev.focus === 'function' && document.contains(prev)) {
        try {
          prev.focus();
        } catch {
          /* 节点可能已卸载 */
        }
      }
    };
  }, [open, onClose]);

  if (!open) return null;

  const engineShort = formatEngineStatusShort(engineOnline);
  const engineFull = formatEngineStatusFull(engineOnline);
  const engineTitle = formatEngineStatusTitle(engineOnline);
  const describedBy = engineOnline ? descId : `${descId} ${offlineHintId}`;

  return (
    <div
      className={styles.runtimeFloatRoot}
      role="presentation"
    >
      <div
        ref={sheetRef}
        className={styles.runtimeFloatSheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
      >
        <div className={styles.runtimeFloatHeader}>
          <div className={styles.runtimeFloatTitle}>
            <Lucide.Activity size={16} strokeWidth={1.75} aria-hidden />
            <span id={titleId}>运行状态</span>
            {/* 紧凑引擎徽章：中文短标签 + 完整 aria */}
            <span
              className={styles.rtEngineStatus}
              role="status"
              aria-live="polite"
              aria-label={engineFull}
              title={engineTitle}
            >
              <span
                className={`${styles.rtDot} ${engineOnline ? styles.on : styles.off}`}
                aria-hidden
              />
              <span className={`${styles.rtRowMeta} ${styles.rtEngineMeta}`}>{engineShort}</span>
            </span>
          </div>
          <Tooltip content="关闭 (Esc)">
            <button
              ref={closeBtnRef}
              type="button"
              className="header-btn"
              aria-label="关闭运行状态"
              onClick={onClose}
            >
              <Lucide.X size={16} strokeWidth={1.75} aria-hidden />
            </button>
          </Tooltip>
        </div>

        {/* 读屏描述：无 sr-only token，用 clip 隐藏，避免 thrash panels.css */}
        <p
          id={descId}
          className="sr-only"
        >
          {formatFloatDialogDescription()}
        </p>

        {/* 离线状态已在 header 徽章；不重复大块文案 */}
        <span id={offlineHintId} className="sr-only">
          {engineOnline ? '' : formatFloatOfflineChromeHint()}
        </span>

        <div className={styles.runtimeFloatBody}>
          <RuntimePanel wsId="float" onShowToast={handleShowToast} />
        </div>
      </div>
    </div>
  );
};
