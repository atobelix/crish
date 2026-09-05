/**
 * 应用预览 DOM 拾取器与检查器引擎 (DOM Inspector)
 *
 * 提供轻量级、零依赖的 DOM 元素检查、跟随高亮浮层、微型悬浮 Badge、
 * CSS Selector / XPath 生成、及 iframe 跨环境注入与通信能力。
 */

export const DOM_INSPECTED_MESSAGE_TYPE = 'crish:dom-inspected' as const;
export const DOM_INSPECTOR_TOGGLE_MESSAGE_TYPE = 'crish:dom-inspector-toggle' as const;

/** 拾取到的 DOM 元素结构化详情 */
export interface InspectedElementPayload {
  tagName: string;
  id: string;
  className: string;
  selector: string;
  xpath: string;
  outerHtml: string;
  textContent: string;
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
    top: number;
    left: number;
  };
  attributes: Record<string, string>;
}

/** 上报给父容器的消息结构 */
export interface DomInspectedMessage {
  type: typeof DOM_INSPECTED_MESSAGE_TYPE;
  payload: InspectedElementPayload;
}

/** 启停 Inspector 的控制消息结构 */
export interface DomInspectorToggleMessage {
  type: typeof DOM_INSPECTOR_TOGGLE_MESSAGE_TYPE;
  enabled: boolean;
  active?: boolean;
  action?: 'toggle_inspector';
}

const OVERLAY_ROOT_ID = '__crish_dom_inspector_root__';
const MAX_OUTER_HTML_LEN = 2000;
const MAX_TEXT_CONTENT_LEN = 500;

/** 跨 window / iframe realm 鲁棒检查 DOM 元素节点（避开跨域 realm 下 instanceof Element 判定失效） */
export function isElementNode(val: unknown): val is Element {
  return Boolean(val && typeof val === 'object' && (val as Node).nodeType === 1);
}

/**
 * 为指定 DOM 元素生成唯一且精确的 CSS Selector
 */
export function generateCssSelector(el: Element): string {
  if (!isElementNode(el)) return '';
  if (el.tagName.toLowerCase() === 'html') return 'html';
  if (el.tagName.toLowerCase() === 'body') return 'body';

  const doc = el.ownerDocument || document;

  // 1. 如果有全局唯一 ID，直接返回 ID 选择器
  if (el.id) {
    const escapedId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(el.id) : el.id;
    try {
      if (doc.querySelectorAll(`#${escapedId}`).length === 1) {
        return `#${escapedId}`;
      }
    } catch {
      // 降级继续向上遍历
    }
  }

  // 2. 向上追溯层级路径
  const path: string[] = [];
  let curr: Element | null = el;

  while (curr && curr.nodeType === Node.ELEMENT_NODE) {
    const tag = curr.tagName.toLowerCase();
    if (tag === 'body' || tag === 'html') {
      path.unshift(tag);
      break;
    }

    let selector = tag;
    if (curr.id) {
      const escapedId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(curr.id) : curr.id;
      try {
        if (doc.querySelectorAll(`#${escapedId}`).length === 1) {
          path.unshift(`#${escapedId}`);
          break;
        }
      } catch {
        // 继续计算类名和索引
      }
      selector += `#${escapedId}`;
    } else if (curr.classList && curr.classList.length > 0) {
      const classList = Array.from(curr.classList)
        .filter((c) => !c.startsWith('__crish_'))
        .slice(0, 2);
      if (classList.length > 0) {
        const escapedClasses = classList
          .map((c) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(c) : c))
          .join('.');
        selector += `.${escapedClasses}`;
      }
    }

    // 计算同名兄弟索引
    let sibling = curr.previousElementSibling;
    let nth = 1;
    let hasSameTagSibling = false;
    while (sibling) {
      if (sibling.tagName === curr.tagName) {
        nth++;
        hasSameTagSibling = true;
      }
      sibling = sibling.previousElementSibling;
    }
    if (!hasSameTagSibling) {
      let next = curr.nextElementSibling;
      while (next) {
        if (next.tagName === curr.tagName) {
          hasSameTagSibling = true;
          break;
        }
        next = next.nextElementSibling;
      }
    }
    if (hasSameTagSibling) {
      selector += `:nth-of-type(${nth})`;
    }

    path.unshift(selector);
    curr = curr.parentElement;
  }

  return path.join(' > ');
}

/** 原生测试/业务锚点属性（O(1) 最高优先级，对照 audits/01 selector_generator_priority） */
const TEST_ANCHOR_ATTRS = ['data-testid', 'data-test', 'data-cy', 'data-qa', 'data-id'] as const;

/** Tailwind 动态哈希 / 非语义原子类启发式：6+ 位纯字母数字类名视为无语义 */
const TAILWIND_ATOMIC_CLASS_RE = /^[a-z0-9]{6,}$/i;

/**
 * 为指定 DOM 元素生成「确定性优先」最佳 CSS Selector（审计断言 selector_generator_priority）：
 * 1. data-testid / data-test / data-cy / data-qa / data-id 测试锚点（O(1)）；
 * 2. 页面唯一 id；
 * 3. 语义化 class 组合（过滤 Tailwind 原子类与 __crish_ 内部类），且全文档唯一；
 * 4. 保底：精确层级路径（复用 generateCssSelector）。
 */
export function computeBestSelector(el: Element): string {
  if (!isElementNode(el)) return '';

  const doc = el.ownerDocument || document;

  // 1. 最高优先级：原生测试/业务锚点属性（O(1)）
  for (const attr of TEST_ANCHOR_ATTRS) {
    const val = el.getAttribute(attr);
    if (val) {
      const escapedVal = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(val) : val;
      return `[${attr}="${escapedVal}"]`;
    }
  }

  // 2. 第二优先级：全局唯一 id
  if (el.id) {
    const escapedId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(el.id) : el.id;
    try {
      if (doc.querySelectorAll(`#${escapedId}`).length === 1) {
        return `#${escapedId}`;
      }
    } catch {
      // 选择器非法时降级继续
    }
  }

  // 3. 第三优先级：语义化 class 组合（过滤 Tailwind 原子类 / __crish_ 内部类），唯一则直接命中
  const validClasses = Array.from(el.classList).filter(
    (c) =>
      !!c &&
      !c.startsWith('__crish_') &&
      !c.includes(':') &&
      !c.includes('[') &&
      !TAILWIND_ATOMIC_CLASS_RE.test(c)
  );
  if (validClasses.length > 0) {
    const escaped = validClasses
      .map((c) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(c) : c))
      .join('.');
    const classSelector = `${el.tagName.toLowerCase()}.${escaped}`;
    try {
      if (doc.querySelectorAll(classSelector).length === 1) {
        return classSelector;
      }
    } catch {
      // 选择器非法时降级继续
    }
  }

  // 4. 保底：精确层级路径
  return generateCssSelector(el);
}

/**
 * 为指定 DOM 元素生成标准 XPath 路径
 */
export function generateXPath(el: Element): string {
  if (!isElementNode(el)) return '';
  if (el.nodeType === Node.DOCUMENT_NODE) return '/';

  const parts: string[] = [];
  let curr: Element | null = el;

  while (curr && curr.nodeType === Node.ELEMENT_NODE) {
    let index = 1;
    let sibling = curr.previousElementSibling;
    while (sibling) {
      if (sibling.nodeName === curr.nodeName) {
        index++;
      }
      sibling = sibling.previousElementSibling;
    }

    const tag = curr.nodeName.toLowerCase();
    const part = `${tag}[${index}]`;
    parts.unshift(part);

    curr = curr.parentElement;
  }

  return parts.length ? `/${parts.join('/')}` : '';
}

/**
 * 提取 DOM 元素的结构化快照信息
 */
export function extractElementPayload(el: Element): InspectedElementPayload {
  const rect = el.getBoundingClientRect();
  const rawHtml = el.outerHTML || '';
  const rawText = el.textContent || '';

  const attributes: Record<string, string> = {};
  if (el.attributes) {
    for (let i = 0; i < el.attributes.length; i++) {
      const attr = el.attributes[i];
      if (attr && !attr.name.startsWith('__crish_')) {
        attributes[attr.name] = attr.value;
      }
    }
  }

  return {
    tagName: el.tagName.toLowerCase(),
    id: el.id || '',
    className: typeof el.className === 'string' ? el.className : '',
    selector: generateCssSelector(el),
    xpath: generateXPath(el),
    outerHtml: rawHtml.length > MAX_OUTER_HTML_LEN ? `${rawHtml.slice(0, MAX_OUTER_HTML_LEN)}...` : rawHtml,
    textContent: (rawText.trim().length > MAX_TEXT_CONTENT_LEN
      ? `${rawText.trim().slice(0, MAX_TEXT_CONTENT_LEN)}...`
      : rawText.trim()
    ),
    rect: {
      x: Math.round(rect.x * 100) / 100,
      y: Math.round(rect.y * 100) / 100,
      width: Math.round(rect.width * 100) / 100,
      height: Math.round(rect.height * 100) / 100,
      top: Math.round(rect.top * 100) / 100,
      left: Math.round(rect.left * 100) / 100,
    },
    attributes,
  };
}

/**
 * 校验并解析父容器接收到的 DOM 拾取消息 Payload
 */
export function parseInspectedElementPayload(data: unknown): InspectedElementPayload | null {
  if (!data || typeof data !== 'object') return null;

  const raw = data as Record<string, unknown>;
  const isTargetType =
    raw.type === DOM_INSPECTED_MESSAGE_TYPE ||
    raw.action === DOM_INSPECTED_MESSAGE_TYPE ||
    raw.type === 'dom-inspected';

  const candidate = (raw.payload ||
    raw.detail ||
    (isTargetType ? raw : null) ||
    (raw.tagName || raw.tag ? raw : null)) as Record<string, unknown> | null;
  if (!candidate || typeof candidate !== 'object') return null;

  const tagName =
    typeof candidate.tagName === 'string'
      ? candidate.tagName
      : typeof candidate.tag === 'string'
        ? candidate.tag
        : '';

  if (!tagName) return null;

  const className =
    typeof candidate.className === 'string'
      ? candidate.className
      : typeof candidate.classes === 'string'
        ? candidate.classes
        : '';

  const selector =
    typeof candidate.selector === 'string'
      ? candidate.selector
      : typeof candidate.path === 'string'
        ? candidate.path
        : tagName +
          (className
            ? `.${className.trim().split(/\s+/).filter(Boolean).join('.')}`
            : '');

  const xpath = typeof candidate.xpath === 'string' ? candidate.xpath : '';
  const outerHtml = typeof candidate.outerHtml === 'string' ? candidate.outerHtml : '';
  const textContent =
    typeof candidate.textContent === 'string' ? candidate.textContent : '';
  const id = typeof candidate.id === 'string' ? candidate.id : '';

  const rectObj = (candidate.rect && typeof candidate.rect === 'object'
    ? candidate.rect
    : {}) as Record<string, unknown>;
  const rect = {
    x: typeof rectObj.x === 'number' ? rectObj.x : 0,
    y: typeof rectObj.y === 'number' ? rectObj.y : 0,
    width: typeof rectObj.width === 'number' ? rectObj.width : 0,
    height: typeof rectObj.height === 'number' ? rectObj.height : 0,
    top: typeof rectObj.top === 'number' ? rectObj.top : 0,
    left: typeof rectObj.left === 'number' ? rectObj.left : 0,
  };

  const attributes = (candidate.attributes && typeof candidate.attributes === 'object'
    ? candidate.attributes
    : {}) as Record<string, string>;

  return {
    tagName: tagName.toLowerCase(),
    id,
    className,
    selector,
    xpath,
    outerHtml,
    textContent,
    rect,
    attributes,
  };
}

/**
 * 在目标 Document 上挂载 DOM Inspector（支持在同源 iframe 或当前页直接运行）
 * @returns 销毁与清理函数
 */
export function attachDomInspector(
  targetDoc: Document,
  onInspect?: (payload: InspectedElementPayload) => void
): () => void {
  const win = targetDoc.defaultView || window;
  let active = true;
  let hoveredEl: Element | null = null;
  let rafId: number | null = null;

  // 1. 创建或获取浮层容器
  let root = targetDoc.getElementById(OVERLAY_ROOT_ID);
  if (!root) {
    root = targetDoc.createElement('div');
    root.id = OVERLAY_ROOT_ID;
    root.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:9000;';
    targetDoc.documentElement.appendChild(root);
  }

  // 2. 高亮矩形浮层
  const overlay = targetDoc.createElement('div');
  overlay.style.cssText =
    'position:fixed;pointer-events:none;box-sizing:border-box;' +
    'border:2px solid #3b82f6;background:rgba(59,130,246,0.15);' +
    'display:none;border-radius:2px;z-index:9000;';
  root.appendChild(overlay);

  // 3. 微型悬浮 Badge
  const badge = targetDoc.createElement('div');
  badge.style.cssText =
    'position:fixed;pointer-events:none;z-index:9000;display:none;' +
    'background:#1e293b;color:#f8fafc;font-size:11px;line-height:1.2;' +
    'font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;' +
    'padding:2px 6px;border-radius:3px;box-shadow:0 2px 8px rgba(0,0,0,0.3);' +
    'white-space:nowrap;';
  root.appendChild(badge);

  const updateOverlay = () => {
    if (!active || !hoveredEl || !hoveredEl.isConnected) {
      overlay.style.display = 'none';
      badge.style.display = 'none';
      return;
    }

    const rect = hoveredEl.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      overlay.style.display = 'none';
      badge.style.display = 'none';
      return;
    }

    overlay.style.top = `${rect.top}px`;
    overlay.style.left = `${rect.left}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    overlay.style.display = 'block';

    const tag = hoveredEl.tagName.toLowerCase();
    const id = hoveredEl.id ? `#${hoveredEl.id}` : '';
    const classStr = hoveredEl.classList && hoveredEl.classList.length > 0
      ? `.${Array.from(hoveredEl.classList).filter((c) => !c.startsWith('__crish_')).slice(0, 2).join('.')}`
      : '';
    const dimension = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
    badge.textContent = `<${tag}${id}${classStr}> (${dimension})`;

    let badgeTop = rect.top - 24;
    if (badgeTop < 4) badgeTop = rect.bottom + 4;
    const badgeLeft = Math.max(4, Math.min(win.innerWidth - 180, rect.left));

    badge.style.top = `${badgeTop}px`;
    badge.style.left = `${badgeLeft}px`;
    badge.style.display = 'block';
  };

  const handlePointerMove = (e: MouseEvent | PointerEvent) => {
    if (!active) return;
    const target = e.target as Element | null;
    if (!target || target === root || root?.contains(target)) return;

    hoveredEl = target;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(updateOverlay);
  };

  const handleClick = (e: MouseEvent) => {
    if (!active) return;
    const target = e.target as Element | null;
    if (!target || target === root || root?.contains(target)) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const payload = extractElementPayload(target);
    if (onInspect) {
      onInspect(payload);
    }
    const msg: DomInspectedMessage = {
      type: DOM_INSPECTED_MESSAGE_TYPE,
      payload,
    };
    if (win.parent && win.parent !== win) {
      win.parent.postMessage(msg, '*');
    } else {
      win.postMessage(msg, '*');
    }
  };

  const handleScrollOrResize = () => {
    if (!active || !hoveredEl) return;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(updateOverlay);
  };

  const handleMouseLeave = () => {
    hoveredEl = null;
    overlay.style.display = 'none';
    badge.style.display = 'none';
  };

  // 捕获阶段拦截事件，优先于业务监听
  win.addEventListener('pointermove', handlePointerMove as EventListener, true);
  win.addEventListener('mousemove', handlePointerMove as EventListener, true);
  win.addEventListener('click', handleClick, true);
  win.addEventListener('scroll', handleScrollOrResize, true);
  win.addEventListener('resize', handleScrollOrResize, true);
  targetDoc.addEventListener('mouseleave', handleMouseLeave);

  return () => {
    active = false;
    if (rafId) cancelAnimationFrame(rafId);
    win.removeEventListener('pointermove', handlePointerMove as EventListener, true);
    win.removeEventListener('mousemove', handlePointerMove as EventListener, true);
    win.removeEventListener('click', handleClick, true);
    win.removeEventListener('scroll', handleScrollOrResize, true);
    win.removeEventListener('resize', handleScrollOrResize, true);
    targetDoc.removeEventListener('mouseleave', handleMouseLeave);
    root?.remove();
  };
}

/**
 * 驱动 iframe 内部开启或关闭 DOM Inspector
 */
export function inspectElementInIframe(iframe: HTMLIFrameElement | null, enabled: boolean): boolean {
  if (!iframe) return false;

  const msg: DomInspectorToggleMessage = {
    type: DOM_INSPECTOR_TOGGLE_MESSAGE_TYPE,
    enabled,
    active: enabled,
    action: 'toggle_inspector',
  };

  // 1. 发送 postMessage 控制指令
  try {
    if (iframe.contentWindow) {
      iframe.contentWindow.postMessage(msg, '*');
    }
  } catch {
    // 跨域或未就绪忽略
  }

  // 2. 如果是同源 iframe，且未注入过脚本，可直接就地挂载/销毁
  try {
    const doc = iframe.contentDocument;
    const win = iframe.contentWindow as (Window & { __crish_inspector_cleanup__?: () => void }) | null;
    if (doc && win) {
      if (enabled) {
        if (!win.__crish_inspector_cleanup__) {
          win.__crish_inspector_cleanup__ = attachDomInspector(doc);
        }
      } else if (win.__crish_inspector_cleanup__) {
        win.__crish_inspector_cleanup__();
        delete win.__crish_inspector_cleanup__;
      }
    }
  } catch {
    // 跨域 iframe 由 postMessage 与注入脚本内部监听处理
  }

  return true;
}

/**
 * 可直接注入到目标网页/iframe 内部执行的纯原生轻量脚本代码串
 */
export const DOM_INSPECTOR_SCRIPT = `
(function() {
  if (window.__CRISH_INSPECTOR_LOADED__) return;
  window.__CRISH_INSPECTOR_LOADED__ = true;

  var cleanup = null;

  window.addEventListener('message', function(e) {
    if (!e || !e.data || e.data.type !== '${DOM_INSPECTOR_TOGGLE_MESSAGE_TYPE}') return;
    var enabled = Boolean(e.data.enabled);
    if (enabled && !cleanup) {
      cleanup = (${attachDomInspector.toString()})(document);
    } else if (!enabled && cleanup) {
      cleanup();
      cleanup = null;
    }
  });
})();
`.trim();
