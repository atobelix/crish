/**
 * 应用预览 postMessage 双向通信协议（宿主 Host ↔ iframe 客户端 Client）
 *
 * 本文件为跨窗口消息契约的唯一权威定义：
 * - 宿主侧（PreviewCard / previewHostBridge.ts）以 `crish-preview-host` 为 source
 *   发送 INSPECT_TOGGLE 激活/关闭 iframe 内拾取器；
 * - iframe 内客户端实现 = dev-server/previewBridgeScript.ts（预览代理注入
 *   桥，audit-repair-202609 T19 单轨唯一真源）以 `crish-preview-inspector`
 *   为 source 上报 INSPECT_READY / INSPECT_HOVER / INSPECT_SELECT，并在
 *   拾取态按 Esc 退出时上报 INSPECT_TOGGLE(enabled:false) 请求宿主复位
 *   工具栏拾取态。
 * source 字段区分消息方向，接收方校验 source 与 type，不匹配的消息一律静默丢弃。
 */

/** 宿主 → iframe 方向标识 */
export const CRISH_PREVIEW_HOST_SOURCE = 'crish-preview-host' as const;
/** iframe → 宿主方向标识 */
export const CRISH_PREVIEW_INSPECTOR_SOURCE = 'crish-preview-inspector' as const;

/** 方向：宿主 → iframe 客户端 */
export type PreviewHostToClientMessage =
  | {
      source: typeof CRISH_PREVIEW_HOST_SOURCE;
      type: 'INSPECT_TOGGLE';
      payload: { enabled: boolean };
    };

/** 方向：iframe 客户端 → 宿主 */
export type PreviewClientToHostMessage =
  | {
      source: typeof CRISH_PREVIEW_INSPECTOR_SOURCE;
      type: 'INSPECT_READY';
      payload: Record<string, never>;
    }
  | {
      source: typeof CRISH_PREVIEW_INSPECTOR_SOURCE;
      type: 'INSPECT_TOGGLE';
      payload: { enabled: boolean };
    }
  | {
      source: typeof CRISH_PREVIEW_INSPECTOR_SOURCE;
      type: 'INSPECT_HOVER';
      payload: InspectHoverPayload;
    }
  | {
      source: typeof CRISH_PREVIEW_INSPECTOR_SOURCE;
      type: 'INSPECT_SELECT';
      payload: InspectSelectPayload;
    };

/** 悬停元素矩形（相对于 iframe 视口的客户端坐标） */
export interface InspectRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** INSPECT_HOVER 载荷：悬停定位所需的精简信息 */
export interface InspectHoverPayload {
  tagName: string;
  selector: string;
  rect: InspectRect;
}

/** INSPECT_SELECT 载荷：选中元素的结构化完整详情 */
export interface InspectSelectPayload {
  tagName: string;
  id: string | null;
  classes: string[];
  attributes: Record<string, string>;
  bestSelector: string;
  xpath: string;
  rect: InspectRect;
  computedStyles: {
    display: string;
    position: string;
    color: string;
    backgroundColor: string;
    fontSize: string;
    margin: string;
    padding: string;
  };
  outerHtmlSnippet: string;
  textContent: string;
}

/** 客户端 → 宿主消息的合法 type 清单（宿主订阅过滤用） */
export const PREVIEW_INSPECTOR_MESSAGE_TYPES = [
  'INSPECT_READY',
  'INSPECT_TOGGLE',
  'INSPECT_HOVER',
  'INSPECT_SELECT',
] as const;

export type PreviewInspectorMessageType =
  (typeof PREVIEW_INSPECTOR_MESSAGE_TYPES)[number];
