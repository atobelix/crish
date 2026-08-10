/**
 * 输入捕获层（P1-B1 + P1-B2）：覆盖画布的事件捕获 + 归一化 + browser_input
 * 上行 + IME 隐藏输入框桥（12 文档 §3.7）。
 *
 * 对齐 12 文档 §3：
 * - 覆盖画布区域（absolute 定位，z-index 高于 canvas）；监听
 *   mousedown/mousemove/mouseup/wheel/keydown/keyup/blur/contextmenu；
 * - 统一阻止浏览器默认行为（wheel/contextmenu/Tab），防 webview 自身
 *   滚动/菜单/焦点逃逸劫持（§3.1）；
 * - **焦点模型（§3.6/§3.7，P1-B2）**：隐藏输入框（`data-ime-bridge`）
 *   始终持有焦点——本层 div 不抢焦点（mousedown preventDefault），
 *   点击面板任意处 → 隐藏框 focus + 定位到点击点下方（OS IME 候选窗
 *   跟随隐藏框）；面板失焦 → 输入框 blur → 键盘转发暂停 + 合成期失焦
 *   重置（S0-03 R2 残余 2 / T10）；
 * - **IME 桥（§3.7）**：composition 事件在隐藏框上捕获 → 状态机 →
 *   compositionend 整串经 `browser_input { kind: 'text' }` 注入（Rust
 *   InputPipeline InputCmd::Text → insertText，S0-03 C2-C8 实测背书）；
 *   合成期键盘一律不转发（usePanelInput composing 面）；229 合成键恒不转发；
 * - 页面焦点由 CDP 信任输入自然维持（S0-03 C5：insertText 自动聚焦页面
 *   「最后可编辑元素」——页面无需真实聚焦到具体输入框，注入自动落点）。
 *
 * 指示条/接管（IndicatorBar）为 P1-B2 完善项，由 BrowserPanel 编排。
 */
import React, { useRef } from 'react';
import styles from '../BrowserPanel.module.css';
import { sendBrowserInput } from '../../../api/browserSessionApi';
import type { BrowserFrameMeta } from './browserPanelTypes';
import { usePanelInput } from './usePanelInput';
import { useImeBridge } from './useImeBridge';

export interface InputLayerProps {
  /** 帧流激活才转发（未激活时事件仅本地维护状态）。 */
  active: boolean;
  /** 最近帧元信息（坐标映射基准）。 */
  getFrameMeta: () => BrowserFrameMeta | null;
  /** 用户活动回调（接管信号观察：mousedown/wheel/keydown/compositionstart；
   *  吊销链在维度 15 Coordinator，前端仅发信号——T-12/U-9③）。 */
  onUserInput?: () => void;
}

export const InputLayer: React.FC<InputLayerProps> = ({
  active,
  getFrameMeta,
  onUserInput,
}) => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const metaRef = useRef(getFrameMeta);
  metaRef.current = getFrameMeta;

  const ime = useImeBridge({
    enabled: active,
    getRect: () => rootRef.current?.getBoundingClientRect() ?? null,
    onCommitted: (text) => {
      // 12 §3.7：compositionend 整串一次注入（防 surrogate pair 切分破坏）；
      // 空串（Esc 取消）不注入（Rust 侧 Text 变体亦跳过空文本）
      sendBrowserInput({ kind: 'text', text }).catch(() => {
        /* 输入面静默（高频，不 toast） */
      });
    },
    onUserInput,
  });

  const { onMouseDown, onMouseMove, onMouseUp, onWheel, onKeyDown, onKeyUp, onBlur } =
    usePanelInput({
      enabled: active,
      getFrameMeta: () => metaRef.current(),
      getRect: () => rootRef.current?.getBoundingClientRect() ?? null,
      composing: ime.composing,
      onUserInput,
    });

  return (
    <div
      ref={rootRef}
      className={styles.inputLayer}
      role="application"
      aria-label="受管浏览器输入层"
      onMouseDown={(e) => {
        // 焦点管理（12 §3.6）：本层 div 不抢焦点——preventDefault 后显式
        // 聚焦隐藏输入框（IME 会话绑定隐藏框焦点）
        e.preventDefault();
        ime.positionImeInput(e.clientX, e.clientY);
        ime.focusImeInput();
        onMouseDown(e);
      }}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onWheel={onWheel}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={onBlur}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 隐藏输入框桥：1px 隐形但可聚焦可接收 IME（12 §3.7）；候选窗
          跟随本框位置（点击点下方 ~20px）；键盘事件冒泡到本层统一转发 */}
      <input
        ref={ime.imeInputRef}
        type="text"
        data-ime-bridge
        className={styles.imeBridge}
        autoComplete="off"
        spellCheck={false}
        aria-label="受管浏览器 IME 输入桥"
        onCompositionStart={ime.imeInputHandlers.onCompositionStart}
        onCompositionUpdate={ime.imeInputHandlers.onCompositionUpdate}
        onCompositionEnd={ime.imeInputHandlers.onCompositionEnd}
        onKeyDown={ime.imeInputHandlers.onKeyDown}
        onBlur={ime.onImeBlur}
      />
    </div>
  );
};
