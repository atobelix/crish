/**
 * AI 受管浏览器面板（P1-B1：帧渲染 + 基础输入转发）。
 *
 * P1 形态：引擎拉起的受管浏览器画面经 Tauri Channel 帧流渲染进 canvas
 * （U-13 裁决：帧下行 Channel / 输入上行 browser_input invoke），用户可
 * 直接操作面板（点击/滚动/键盘 ASCII 直转）；P1-B2 完善接管 UI 与 IME 桥。
 *
 * 状态指示（running 态）：
 * - 帧流 active → 「帧流已激活」（任务书指示条；P1-B2 完善接管 UI）；
 * - starting → 「帧流启动中…」；stopped → 「帧流未激活」。
 */
import React from 'react';
import {
  AlertTriangle,
  CircleX,
  Loader2,
  MonitorPlay,
  OctagonX,
  Play,
  Power,
  Square,
} from 'lucide-react';
import styles from './BrowserPanel.module.css';
import { Tooltip } from '../ui';
import { useBrowserSession } from './useBrowserSession';
import {
  BROWSER_AI_READY_TEXT,
  BROWSER_STATE_DESC,
  BROWSER_STATE_LABEL,
  canKillBrowserSession,
  canStartBrowserSession,
  canStopBrowserSession,
  type BrowserSessionState,
} from './browserSessionLib';
import { FrameCanvas } from './browser-panel/FrameCanvas';
import { InputLayer } from './browser-panel/InputLayer';
import { useFrameStream, type UseFrameStreamOptions } from './browser-panel/useFrameStream';
import type { ShowToastFn } from '../../hooks/useToastQueue';

export interface BrowserPanelProps {
  onShowToast: ShowToastFn;
  /** 测试注入：帧通道工厂（缺省惰性加载 @tauri-apps/api/core；非 Tauri 降级）。 */
  frameChannelFactory?: UseFrameStreamOptions['channelFactory'];
}

/** 状态图标：launching/stopping 为旋转加载态，其余为静态态标 */
function renderStateIcon(state: BrowserSessionState, spinClass?: string) {
  const icoProps = {
    size: 26,
    strokeWidth: 1.5,
    'aria-hidden': true as const,
  };
  switch (state) {
    case 'launching':
    case 'stopping':
      return <Loader2 {...icoProps} className={spinClass} />;
    case 'running':
      return <MonitorPlay {...icoProps} />;
    case 'crashed':
      return <AlertTriangle {...icoProps} />;
    case 'error':
      return <CircleX {...icoProps} />;
    case 'stopped':
      return <Square {...icoProps} />;
    default:
      return <Power {...icoProps} />;
  }
}

/** 帧流指示条文案（P1-B1 基础版；P1-B2 完善接管 UI）。 */
function frameIndicatorText(state: 'starting' | 'active' | 'stopped'): string {
  if (state === 'active') return '帧流已激活';
  if (state === 'starting') return '帧流启动中…';
  return '帧流未激活';
}

export const BrowserPanel: React.FC<BrowserPanelProps> = ({
  onShowToast,
  frameChannelFactory,
}) => {
  const { state, url, busy, start, stop, kill } = useBrowserSession({
    onShowToast,
  });

  const running = state === 'running';
  const { frameState, lastFrame, canvasRef } = useFrameStream({
    active: running,
    channelFactory: frameChannelFactory,
  });

  const startReady = canStartBrowserSession(state);
  const stopReady = canStopBrowserSession(state);
  const killReady = canKillBrowserSession(state);

  return (
    <div className={styles.panel} data-state={state}>
      <div className={styles.status} role="status" aria-label="浏览器运行状态">
        <div
          className={`${styles.statusIco} ${styles[`state-${state}`]}`}
          aria-hidden
        >
          {renderStateIcon(state, styles.spin)}
        </div>
        <div className={styles.statusText}>
          <div className={styles.statusTitle}>
            {BROWSER_STATE_LABEL[state]}
          </div>
          <div className={styles.statusDesc}>
            {BROWSER_STATE_DESC[state]}
            {state === 'running' && url ? (
              <span className={styles.urlLine}>
                当前页面：
                <code className={styles.urlCode}>{url}</code>
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {state === 'running' ? (
        <div className={styles.aiReady} role="status">
          <span className={styles.readyDot} aria-hidden />
          {BROWSER_AI_READY_TEXT}
        </div>
      ) : null}

      {running ? (
        <div className={styles.frameStageWrap} data-frame-state={frameState}>
          <FrameCanvas
            frameState={frameState}
            lastFrame={lastFrame}
            canvasRef={canvasRef}
          />
          <InputLayer
            active={frameState === 'active'}
            getFrameMeta={() => lastFrame}
          />
          <div className={styles.frameIndicator} role="status">
            <span className={styles.frameIndicatorDot} aria-hidden />
            {frameIndicatorText(frameState)}
          </div>
        </div>
      ) : null}

      <div className={styles.actions} role="group" aria-label="浏览器控制">
        <Tooltip content="启动受管浏览器窗口">
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={busy || !startReady}
            onClick={start}
            aria-label="启动浏览器"
          >
            {busy && state === 'launching' ? (
              <Loader2
                size={14}
                strokeWidth={1.75}
                className={styles.spin}
                aria-hidden
              />
            ) : (
              <Play size={14} strokeWidth={1.75} aria-hidden />
            )}
            <span>启动</span>
          </button>
        </Tooltip>
        <Tooltip content="正常停止浏览器">
          <button
            type="button"
            className={styles.btn}
            disabled={busy || !stopReady}
            onClick={stop}
            aria-label="停止浏览器"
          >
            <Square size={14} strokeWidth={1.75} aria-hidden />
            <span>停止</span>
          </button>
        </Tooltip>
        <Tooltip content="强制终止（与停止同一命令，用于启动/运行异常时）">
          <button
            type="button"
            className={`${styles.btn} ${styles.btnDanger}`}
            disabled={busy || !killReady}
            onClick={kill}
            aria-label="急停浏览器（强制）"
          >
            <OctagonX size={14} strokeWidth={1.75} aria-hidden />
            <span>急停（强制）</span>
          </button>
        </Tooltip>
      </div>
    </div>
  );
};
