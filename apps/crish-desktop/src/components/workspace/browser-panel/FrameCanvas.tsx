/**
 * 帧渲染画布（P1-B1）：canvas 帧渲染 + 无帧占位。
 *
 * 渲染循环本体在 useFrameStream（订阅/解码/绘制）；本组件只挂载 canvas
 * 并呈现占位态：
 * - frameState=active：画布（内容由 hook 绘制）；
 * - starting：「帧流启动中…」占位；
 * - stopped：「帧流未激活」占位（无帧时的默认态，任务书验收面）。
 *
 * canvas tabIndex=0：键盘事件捕获载体（焦点管理；InputLayer 覆盖其上，
 * 事件经冒泡统一处理，见 usePanelInput）。
 */
import React from 'react';
import styles from '../BrowserPanel.module.css';
import type { BrowserFrameMeta, BrowserFrameState } from './browserPanelTypes';

export interface FrameCanvasProps {
  frameState: BrowserFrameState;
  lastFrame: BrowserFrameMeta | null;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
}

/** 占位文案（帧流三态）。 */
export function framePlaceholderText(state: BrowserFrameState): string {
  if (state === 'starting') return '帧流启动中…';
  if (state === 'active') return '';
  return '帧流未激活';
}

export const FrameCanvas: React.FC<FrameCanvasProps> = ({
  frameState,
  lastFrame,
  canvasRef,
}) => {
  const placeholder = framePlaceholderText(frameState);
  return (
    <div className={styles.frameStage}>
      <canvas
        ref={canvasRef}
        className={styles.frameCanvas}
        tabIndex={0}
        role="img"
        aria-label="受管浏览器画面"
      />
      {placeholder ? (
        <div className={styles.framePlaceholder} aria-hidden="true">
          {placeholder}
        </div>
      ) : null}
      {frameState === 'active' && lastFrame ? (
        <div className={styles.frameMeta} aria-hidden="true">
          {lastFrame.width}×{lastFrame.height}
        </div>
      ) : null}
    </div>
  );
};
