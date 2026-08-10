/**
 * 输入捕获层（P1-B1）：覆盖画布的事件捕获 + 归一化 + browser_input 上行。
 *
 * 对齐 12 文档 §3：
 * - 覆盖画布区域（absolute 定位，z-index 高于 canvas）；监听
 *   mousedown/mousemove/mouseup/wheel/keydown/keyup/blur/contextmenu；
 * - 统一阻止浏览器默认行为（wheel/contextmenu/Tab），防 webview 自身
 *   滚动/菜单/焦点逃逸劫持（§3.1）；
 * - 键盘捕获需焦点：本层 tabIndex=0，点击即聚焦；失焦 → 补发修饰键 keyUp
 *   （防 sticky，§3.1/§3.6）；IME 隐藏输入框桥本期不做（P1-B2 轮），
 *   合成键（keyCode 229）不转发。
 * - 指示条/接管（IndicatorBar）为 P1-B2 完善项，本期仅「帧流已激活」提示
 *   由 BrowserPanel 呈现。
 */
import React, { useRef } from 'react';
import styles from '../BrowserPanel.module.css';
import type { BrowserFrameMeta } from './browserPanelTypes';
import { usePanelInput } from './usePanelInput';

export interface InputLayerProps {
  /** 帧流激活才转发（未激活时事件仅本地维护状态）。 */
  active: boolean;
  /** 最近帧元信息（坐标映射基准）。 */
  getFrameMeta: () => BrowserFrameMeta | null;
}

export const InputLayer: React.FC<InputLayerProps> = ({ active, getFrameMeta }) => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const metaRef = useRef(getFrameMeta);
  metaRef.current = getFrameMeta;

  const { onMouseDown, onMouseMove, onMouseUp, onWheel, onKeyDown, onKeyUp, onBlur } =
    usePanelInput({
      enabled: active,
      getFrameMeta: () => metaRef.current(),
      getRect: () => rootRef.current?.getBoundingClientRect() ?? null,
    });

  return (
    <div
      ref={rootRef}
      className={styles.inputLayer}
      tabIndex={0}
      role="application"
      aria-label="受管浏览器输入层"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onWheel={onWheel}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={onBlur}
      onContextMenu={(e) => e.preventDefault()}
    />
  );
};
