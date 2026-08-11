/**
 * AI 受管浏览器面板（P1-B1 + P1-B2：帧渲染 + 输入转发 + IME 桥 + 指示条/接管）。
 *
 * P1 形态：引擎拉起的受管浏览器画面经 Tauri Channel 帧流渲染进 canvas
 * （U-13 裁决：帧下行 Channel / 输入上行 browser_input invoke），用户可
 * 直接操作面板（点击/滚动/键盘 ASCII 直转）；P1-B2 落地 IME 隐藏输入框桥
 * （12 §3.7：compositionend 整串 insertText 注入）与指示条/接管状态机
 * （12 §5：idle/ai-busy/paused/user-taking-over，800ms 过渡 T-12）。
 *
 * 状态指示（running 态）：
 * - 帧流 active → 「帧流已激活」（帧指示条）；
 * - 协作状态 → IndicatorBar（AI 空闲/AI 正在操作/已暂停/已接管）；
 * - AI 忙信号：引擎侧未接线（browser:status 事件，12 §5.2），前端先按
 *   帧流 active + 帧在动 + 无用户输入推断（usePanelStatus 注释说明）；
 *   引擎接线后经 `engineAiBusy` 注入。
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
import { Button, Tooltip } from '../ui';
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
import { IndicatorBar } from './browser-panel/IndicatorBar';
import { InputLayer } from './browser-panel/InputLayer';
import {
  useFrameStream,
  type UseFrameStreamOptions,
} from './browser-panel/useFrameStream';
import { usePanelStatus } from './browser-panel/usePanelStatus';
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

/** 帧流指示条文案（P1-B1 基础版；协作状态由 IndicatorBar 呈现）。 */
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

  // 协作状态机（12 §5）：AI 忙信号引擎侧未接线（browser:status 事件）——
  // 传 null 走「帧在动 + 用户安静」推断（usePanelStatus 注释说明接线点）
  const { status, onUserInput, pause, resume } = usePanelStatus({
    frameState,
    lastFrameSeq: lastFrame?.seq ?? null,
    engineAiBusy: null,
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
          <div className={styles.statusTitle}>{BROWSER_STATE_LABEL[state]}</div>
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
            onUserInput={onUserInput}
          />
          <IndicatorBar
            status={status}
            aiActionText={null}
            onTogglePause={status === 'paused' ? resume : pause}
          />
          <div className={styles.frameIndicator} role="status">
            <span className={styles.frameIndicatorDot} aria-hidden />
            {frameIndicatorText(frameState)}
          </div>
        </div>
      ) : null}

      <div className={styles.actions} role="group" aria-label="浏览器控制">
        <Tooltip content="启动受管浏览器窗口">
          <Button
            type="button"
            variant="primary"
            size="sm"
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
          </Button>
        </Tooltip>
        <Tooltip content="正常停止浏览器">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className={styles.btn}
            disabled={busy || !stopReady}
            onClick={stop}
            aria-label="停止浏览器"
          >
            <Square size={14} strokeWidth={1.75} aria-hidden />
            <span>停止</span>
          </Button>
        </Tooltip>
        <Tooltip content="强制终止（与停止同一命令，用于启动/运行异常时）">
          <Button
            type="button"
            variant="danger"
            size="sm"
            className={`${styles.btn} ${styles.btnDanger}`}
            disabled={busy || !killReady}
            onClick={kill}
            aria-label="急停浏览器（强制）"
          >
            <OctagonX size={14} strokeWidth={1.75} aria-hidden />
            <span>急停（强制）</span>
          </Button>
        </Tooltip>
      </div>
    </div>
  );
};
