/**
 * 浏览器面板共享类型（P1-B1：帧流 + 输入转发）。
 *
 * 契约对齐：
 * - 帧流状态：引擎 `browser_frame_status` / `browser://frame-state-changed`
 *   （starting/active/stopped，独立事件不与面板状态机混流）；
 * - 输入载荷：`browser_input` 命令（camelCase 字段，与 Rust
 *   `BrowserInputEvent` serde 契约一致；kind 决定取用字段子集）。
 */

/** 帧流状态（引擎契约：starting/active/stopped）。 */
export type BrowserFrameState = 'starting' | 'active' | 'stopped';

/** 面板协作状态（12 文档 §5.1：idle/ai-busy/paused/user-taking-over）。 */
export type PanelStatus = 'idle' | 'ai-busy' | 'paused' | 'user-taking-over';

/** 帧元信息（解码自帧二进制头；宽高 = 帧图像素 = 视口 CSS 像素，emulation 锁 1:1）。 */
export interface BrowserFrameMeta {
  /** 帧序号（丢帧统计/诊断用；u32 回绕可接受） */
  seq: number;
  /** 帧图宽度 px（deviceWidth） */
  width: number;
  /** 帧图高度 px（deviceHeight） */
  height: number;
}

/**
 * 输入事件上行载荷（browser_input 契约；字段对齐 Rust BrowserInputEvent
 * camelCase）。按 kind 取用子集：
 * - mouse：action/x/y/button/buttons/clickCount/modifiers
 * - wheel：x/y/deltaX/deltaY/buttons/modifiers（delta 为像素，已按 §3.4 归一化）
 * - key：action/down|up、key/code/text/windowsVirtualKeyCode/
 *   nativeVirtualKeyCode/autoRepeat/modifiers/location
 * - text：text（IME 合成文本，P1-B2 桥接后接入）
 */
export interface BrowserInputEventPayload {
  kind: 'mouse' | 'wheel' | 'key' | 'text';
  /** mouse：down/up/move（缺省视为 move）；key：down/up（缺省 down） */
  action?: 'down' | 'up' | 'move';
  x?: number;
  y?: number;
  /** mouse：none/left/right/middle/back/forward */
  button?: 'none' | 'left' | 'right' | 'middle' | 'back' | 'forward';
  /** 位掩码（1=左 2=右 4=中 8=back 16=forward，12 文档 §3.2） */
  buttons?: number;
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
  /** CDP modifiers（1=Alt 2=Ctrl 4=Meta 8=Shift，12 文档 §3.1） */
  modifiers?: number;
  key?: string;
  code?: string;
  /** keydown 可打印字符 / text 种类合成文本（IME 桥 P1-B2 后接入） */
  text?: string;
  windowsVirtualKeyCode?: number;
  nativeVirtualKeyCode?: number;
  autoRepeat?: boolean;
  /** 数字小键盘置 3（12 文档 §3.3） */
  location?: number;
}
