/**
 * 应用预览宿主侧 postMessage 通信桥（previewHostBridge）
 *
 * 职责：
 * 1. `enableInspector(iframeRef, enabled)`：向预览 iframe 的 contentWindow
 *    postMessage `INSPECT_TOGGLE`（source = crish-preview-host），激活/关闭
 *    iframe 内 DOM 拾取器（客户端实现 = dev-server/previewBridgeScript.ts
 *    注入桥，由预览代理在服务端注入；监听并响应 INSPECT_TOGGLE）。
 * 2. `subscribeToInspector(callback)`：监听宿主 window 的 message 事件，
 *    校验 event.origin 白名单 + source = crish-preview-inspector，过滤未知 type，
 *    向回调派发 INSPECT_READY / INSPECT_TOGGLE（客户端 Esc 退出）/
 *    INSPECT_HOVER / INSPECT_SELECT。
 * 3. 返回 unsubscribe 清理函数，卸载时移除监听器。
 *
 * 消息契约权威定义见 ./previewProtocol.ts；本模块只做转发与来源/类型校验，
 * 不解析业务展示逻辑。
 */
import {
  CRISH_PREVIEW_HOST_SOURCE,
  CRISH_PREVIEW_INSPECTOR_SOURCE,
  getPreviewHostOrigin,
  isAllowedPreviewMessageOrigin,
  type InspectHoverPayload,
  type InspectRect,
  type InspectSelectPayload,
  type PreviewClientToHostMessage,
  type PreviewHostToClientMessage,
} from './previewProtocol';

/** iframe 引用形态：支持 React RefObject 或原生元素 */
export type InspectorIframeRef =
  | { current: HTMLIFrameElement | null }
  | HTMLIFrameElement
  | null;

/** 宿主桥向 UI 层派发的归一化拾取事件 */
export type PreviewInspectorEvent =
  | { type: 'INSPECT_READY' }
  | { type: 'INSPECT_TOGGLE'; payload: { enabled: boolean } }
  | { type: 'INSPECT_HOVER'; payload: InspectHoverPayload }
  | { type: 'INSPECT_SELECT'; payload: InspectSelectPayload };

export type PreviewInspectorListener = (event: PreviewInspectorEvent) => void;

/** 从 iframe 引用/元素形态中解出原生 iframe 元素 */
function unwrapIframe(ref: InspectorIframeRef): HTMLIFrameElement | null {
  if (!ref) return null;
  if (typeof ref === 'object' && 'current' in ref) return ref.current;
  return ref;
}

/** 解析悬停矩形载荷（须为有限数值，杜绝 NaN/字符串混入） */
function parseRect(value: unknown): InspectRect | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const { x, y, width, height } = raw;
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number'
  ) {
    return null;
  }
  return { x, y, width, height };
}

/** 解析 computedStyles 载荷（七项全部要求字符串） */
function parseComputedStyles(
  value: unknown
): InspectSelectPayload['computedStyles'] | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const keys = [
    'display',
    'position',
    'color',
    'backgroundColor',
    'fontSize',
    'margin',
    'padding',
  ] as const;
  const out: Record<string, string> = {};
  for (const key of keys) {
    if (typeof raw[key] !== 'string') return null;
    out[key] = raw[key];
  }
  return out as InspectSelectPayload['computedStyles'];
}

/**
 * 校验并解析客户端 → 宿主消息。
 * 校验规则：source 必须等于 crish-preview-inspector；type 必须命中
 * INSPECT_READY / INSPECT_HOVER / INSPECT_SELECT；关键载荷字段类型不合法
 * 即视为脏数据并返回 null（不派发）。
 */
export function parseClientToHostMessage(
  data: unknown
): PreviewClientToHostMessage | null {
  if (!data || typeof data !== 'object') return null;
  const raw = data as Record<string, unknown>;
  if (raw.source !== CRISH_PREVIEW_INSPECTOR_SOURCE) return null;

  const type = raw.type;
  if (type === 'INSPECT_READY') {
    return {
      source: CRISH_PREVIEW_INSPECTOR_SOURCE,
      type: 'INSPECT_READY',
      payload: {},
    };
  }

  // 客户端 Esc 退出拾取：请求宿主复位工具栏拾取态（enabled 恒为 false）
  if (type === 'INSPECT_TOGGLE') {
    const payload = raw.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload.enabled !== 'boolean') return null;
    return {
      source: CRISH_PREVIEW_INSPECTOR_SOURCE,
      type: 'INSPECT_TOGGLE',
      payload: { enabled: payload.enabled },
    };
  }

  const payload = raw.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== 'object') return null;

  if (type === 'INSPECT_HOVER') {
    const { tagName, selector } = payload;
    const rect = parseRect(payload.rect);
    if (
      typeof tagName !== 'string' ||
      typeof selector !== 'string' ||
      !rect
    ) {
      return null;
    }
    return {
      source: CRISH_PREVIEW_INSPECTOR_SOURCE,
      type: 'INSPECT_HOVER',
      payload: { tagName, selector, rect },
    };
  }

  if (type === 'INSPECT_SELECT') {
    const {
      tagName,
      id,
      classes,
      attributes,
      bestSelector,
      xpath,
      outerHtmlSnippet,
      textContent,
    } = payload;
    const rect = parseRect(payload.rect);
    const computedStyles = parseComputedStyles(payload.computedStyles);
    const classesOk =
      Array.isArray(classes) && classes.every((c) => typeof c === 'string');
    const attrsOk =
      attributes !== null &&
      typeof attributes === 'object' &&
      !Array.isArray(attributes);
    if (
      typeof tagName !== 'string' ||
      (id !== null && typeof id !== 'string') ||
      !classesOk ||
      !attrsOk ||
      typeof bestSelector !== 'string' ||
      typeof xpath !== 'string' ||
      !rect ||
      !computedStyles ||
      typeof outerHtmlSnippet !== 'string' ||
      typeof textContent !== 'string'
    ) {
      return null;
    }
    return {
      source: CRISH_PREVIEW_INSPECTOR_SOURCE,
      type: 'INSPECT_SELECT',
      payload: {
        tagName,
        id: id as string | null,
        classes: classes as string[],
        attributes: attributes as Record<string, string>,
        bestSelector,
        xpath,
        rect,
        computedStyles,
        outerHtmlSnippet,
        textContent,
      },
    };
  }

  return null;
}

/**
 * §4.1：宿主 → iframe 的明确 targetOrigin（禁 '*'）。
 * 预览经同源代理加载时 iframe.origin === 宿主 origin；若可读 contentWindow.location 则用之。
 */
function resolveInspectorTargetOrigin(iframe: HTMLIFrameElement): string | null {
  try {
    const childOrigin = iframe.contentWindow?.location?.origin;
    if (childOrigin && childOrigin !== 'null') return childOrigin;
  } catch {
    // 跨域不可读 location —— 回落宿主 origin（代理架构下仍同源）
  }
  return getPreviewHostOrigin();
}

/**
 * 向预览 iframe 发送拾取器启停指令。
 * @param iframeRef iframe 引用（RefObject 或原生元素；null 安全）
 * @param enabled   true = 激活拾取，false = 退出拾取
 * @returns 是否成功投递（iframe 或其 contentWindow 尚未就绪时返回 false）
 */
export function enableInspector(
  iframeRef: InspectorIframeRef,
  enabled: boolean
): boolean {
  const iframe = unwrapIframe(iframeRef);
  const contentWindow = iframe?.contentWindow;
  if (!iframe || !contentWindow) return false;

  const targetOrigin = resolveInspectorTargetOrigin(iframe);
  if (!targetOrigin) return false;

  const message: PreviewHostToClientMessage = {
    source: CRISH_PREVIEW_HOST_SOURCE,
    type: 'INSPECT_TOGGLE',
    payload: { enabled },
  };
  try {
    contentWindow.postMessage(message, targetOrigin);
    return true;
  } catch {
    // 跨域 / 页面未就绪时投递失败，静默返回 false
    return false;
  }
}

/**
 * 订阅 iframe 客户端上报的拾取消息。
 * @param listener 归一化拾取事件回调（INSPECT_READY / INSPECT_HOVER / INSPECT_SELECT）
 * @returns 取消订阅函数（组件卸载时应调用）
 */
export function subscribeToInspector(
  listener: PreviewInspectorListener
): () => void {
  const handleMessage = (event: MessageEvent) => {
    // §4.1：先校验 origin 白名单，再解析 source/type（防伪造 source）
    if (!isAllowedPreviewMessageOrigin(event.origin)) return;
    const message = parseClientToHostMessage(event.data);
    if (!message) return;

    if (message.type === 'INSPECT_READY') {
      listener({ type: 'INSPECT_READY' });
    } else if (message.type === 'INSPECT_TOGGLE') {
      listener({ type: 'INSPECT_TOGGLE', payload: message.payload });
    } else if (message.type === 'INSPECT_HOVER') {
      listener({ type: 'INSPECT_HOVER', payload: message.payload });
    } else if (message.type === 'INSPECT_SELECT') {
      listener({ type: 'INSPECT_SELECT', payload: message.payload });
    }
  };

  window.addEventListener('message', handleMessage);
  return () => {
    window.removeEventListener('message', handleMessage);
  };
}
