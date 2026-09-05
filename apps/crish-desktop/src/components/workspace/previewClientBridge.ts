/**
 * 应用预览 DOM 拾取客户端通信桥（iframe 内运行时）
 *
 * 职责（对照 docs/native-preview-proxy-and-dom-picker/02-分维详案 §二/§三）：
 * 1. 监听宿主 postMessage 的 `INSPECT_TOGGLE`（source = crish-preview-host），
 *    据此启用/停用 DOM 拾取；非法 source 或未知 type 的消息一律静默丢弃。
 * 2. 拾取激活时，在捕获阶段拦截 pointermove / click：悬停上报 INSPECT_HOVER
 *    （tagName + bestSelector + rect）；点击阻止默认行为并上报 INSPECT_SELECT
 *    （含 computedStyles 摘要、outerHtmlSnippet、textContent）。
 * 3. 安装即上报 INSPECT_READY；拾取态下按 Esc 退出并通知宿主。
 *
 * 与 previewDomInspector 的分工：本桥是「宿主消息 ⇄ 拾取引擎」的胶水；
 * 选择器生成（computeBestSelector / generateCssSelector）与元素详情提取
 * （extractElementPayload）全部复用 previewDomInspector，不重复实现算法。
 * 消息契约权威定义见 ./previewProtocol.ts。
 */

import {
  CRISH_PREVIEW_HOST_SOURCE,
  CRISH_PREVIEW_INSPECTOR_SOURCE,
  type InspectRect,
  type PreviewClientToHostMessage,
  type PreviewHostToClientMessage,
} from './previewProtocol';
import {
  computeBestSelector,
  extractElementPayload,
  isElementNode,
} from './previewDomInspector';

/** 客户端桥安装选项（默认取全局 document/window，便于测试注入） */
export interface PreviewInspectorClientOptions {
  /** 目标文档（默认当前 document） */
  doc?: Document;
  /** 目标窗口（默认当前 window） */
  win?: Window;
}

/** 双安装防护：同一窗口内重复安装时直接返回空清理函数 */
const INSTALLED_FLAG_KEY = '__crish_preview_client_installed__' as const;

/**
 * 在 iframe 内安装 DOM 拾取客户端桥运行时。
 * @returns 清理函数：解除全部监听并退出拾取（幂等）
 */
export function installPreviewInspectorClient(
  options: PreviewInspectorClientOptions = {}
): () => void {
  const doc = options.doc ?? document;
  const win = options.win ?? doc.defaultView ?? window;

  // 双安装防护：防止注入脚本与模块引用在页面内重复挂载
  const winAny = win as unknown as Record<string, unknown>;
  if (winAny[INSTALLED_FLAG_KEY]) {
    return () => {
      /* 已安装过，返回空清理函数 */
    };
  }
  winAny[INSTALLED_FLAG_KEY] = true;

  /** 拾取是否处于激活态 */
  let active = false;
  /** 当前悬停元素（用于同元素连续悬停去重上报） */
  let hoveredEl: Element | null = null;

  const postToHost = (msg: PreviewClientToHostMessage) => {
    try {
      if (win.parent && win.parent !== win) {
        win.parent.postMessage(msg, '*');
      } else {
        win.postMessage(msg, '*');
      }
    } catch {
      // 跨源窗口 postMessage 异常（安全模型）静默忽略
    }
  };

  /** 上报拾取器就绪 */
  const sendReady = () => {
    postToHost({
      source: CRISH_PREVIEW_INSPECTOR_SOURCE,
      type: 'INSPECT_READY',
      payload: {},
    });
  };

  /** 归一化元素视口矩形（保留两位小数） */
  const toRect = (el: Element): InspectRect => {
    const r = el.getBoundingClientRect();
    const round2 = (v: number) => Math.round(v * 100) / 100;
    return {
      x: round2(r.x),
      y: round2(r.y),
      width: round2(r.width),
      height: round2(r.height),
    };
  };

  /** 提取 computedStyles 摘要（七项全部来自 getComputedStyle，保证字符串） */
  const extractComputedStyles = (el: Element): InspectSelectComputedStyles => {
    const cs = win.getComputedStyle(el);
    return {
      display: cs.display,
      position: cs.position,
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      fontSize: cs.fontSize,
      margin: cs.margin,
      padding: cs.padding,
    };
  };

  const handlePointerMove = (e: Event) => {
    if (!active) return;
    const target = e.target as Element | null;
    if (!target || !isElementNode(target) || !target.isConnected) return;
    // 同一元素连续悬停只上报一次，降低消息洪泛
    if (target === hoveredEl) return;
    hoveredEl = target;
    postToHost({
      source: CRISH_PREVIEW_INSPECTOR_SOURCE,
      type: 'INSPECT_HOVER',
      payload: {
        tagName: target.tagName.toLowerCase(),
        selector: computeBestSelector(target),
        rect: toRect(target),
      },
    });
  };

  const handleClick = (e: Event) => {
    if (!active) return;
    // 拾取态下拦截点击：阻止页面跳转 / 表单提交 / 业务处理
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const target = (e.target as Element | null) ?? hoveredEl;
    if (!target || !isElementNode(target)) return;

    const detail = extractElementPayload(target);
    postToHost({
      source: CRISH_PREVIEW_INSPECTOR_SOURCE,
      type: 'INSPECT_SELECT',
      payload: {
        tagName: detail.tagName,
        id: detail.id || null,
        classes: Array.from(target.classList),
        attributes: detail.attributes,
        bestSelector: computeBestSelector(target),
        xpath: detail.xpath,
        rect: toRect(target),
        computedStyles: extractComputedStyles(target),
        outerHtmlSnippet: detail.outerHtml,
        textContent: detail.textContent,
      },
    });
  };

  const handleKeyDown = (e: Event) => {
    if (!active) return;
    const key = (e as KeyboardEvent).key;
    if (key !== 'Escape') return;
    setActive(false);
    // 通知宿主退出拾取，保持两侧状态同步
    postToHost({
      source: CRISH_PREVIEW_INSPECTOR_SOURCE,
      type: 'INSPECT_TOGGLE',
      payload: { enabled: false },
    });
  };

  const handleMessage = (e: MessageEvent) => {
    const msg = e.data as PreviewHostToClientMessage | undefined;
    // 安全校验：非法 source / 未知 type / 载荷缺字段 一律静默丢弃
    if (!msg || typeof msg !== 'object') return;
    if (msg.source !== CRISH_PREVIEW_HOST_SOURCE) return;
    if (msg.type !== 'INSPECT_TOGGLE') return;
    const payload = (msg as { payload?: { enabled?: unknown } }).payload;
    setActive(Boolean(payload?.enabled));
  };

  /** 切换拾取激活态：激活挂捕获阶段监听，停用解除并复位悬停元素 */
  const setActive = (next: boolean) => {
    if (next === active) return;
    active = next;
    if (active) {
      win.addEventListener('pointermove', handlePointerMove, true);
      win.addEventListener('click', handleClick, true);
      win.addEventListener('keydown', handleKeyDown, true);
    } else {
      hoveredEl = null;
      win.removeEventListener('pointermove', handlePointerMove, true);
      win.removeEventListener('click', handleClick, true);
      win.removeEventListener('keydown', handleKeyDown, true);
    }
  };

  win.addEventListener('message', handleMessage);
  sendReady();

  return () => {
    setActive(false);
    win.removeEventListener('message', handleMessage);
    delete winAny[INSTALLED_FLAG_KEY];
  };
}

/** computedStyles 摘要载荷类型（与 previewProtocol 契约一致） */
type InspectSelectComputedStyles = {
  display: string;
  position: string;
  color: string;
  backgroundColor: string;
  fontSize: string;
  margin: string;
  padding: string;
};
