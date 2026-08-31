// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installPreviewInspectorClient } from './previewClientBridge';
import {
  CRISH_PREVIEW_HOST_SOURCE,
  CRISH_PREVIEW_INSPECTOR_SOURCE,
  type PreviewClientToHostMessage,
  type PreviewHostToClientMessage,
} from './previewProtocol';

describe('previewClientBridge', () => {
  let container: HTMLDivElement;
  let posted: PreviewClientToHostMessage[] = [];
  /** 记录当前安装的实例，afterEach 兜底清理，防断言失败泄漏监听器 */
  let installedCleanup: (() => void) | null = null;

  /** 构造宿主 → 客户端 toggle 消息 */
  const hostToggle = (enabled: boolean): PreviewHostToClientMessage => ({
    source: CRISH_PREVIEW_HOST_SOURCE,
    type: 'INSPECT_TOGGLE',
    payload: { enabled },
  });

  /** 向 iframe 客户端投递一条 message 事件 */
  const dispatchMessage = (data: unknown) => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data,
        origin: 'http://127.0.0.1:1',
      } as MessageEventInit)
    );
  };

  /** 安装桥并记录清理函数（配合 afterEach 兜底） */
  const install = () => {
    installedCleanup = installPreviewInspectorClient({ doc: document, win: window });
    return installedCleanup;
  };

  /** 构造以 target 为事件目标的分发事件 */
  const dispatchWithTarget = (type: string, target: Element) => {
    const evt = new MouseEvent(type, { bubbles: true, cancelable: true });
    Object.defineProperty(evt, 'target', { value: target });
    window.dispatchEvent(evt);
  };

  beforeEach(() => {
    container = document.createElement('div');
    container.id = 'bridge-test-container';
    document.body.appendChild(container);
    posted = [];
    installedCleanup = null;

    vi.spyOn(window, 'postMessage').mockImplementation((message: unknown) => {
      posted.push(message as PreviewClientToHostMessage);
    });
  });

  afterEach(() => {
    installedCleanup?.();
    installedCleanup = null;
    vi.restoreAllMocks();
    container.remove();
  });

  describe('installPreviewInspectorClient', () => {
    it('sends INSPECT_READY on install', () => {
      install();

      expect(posted.length).toBeGreaterThan(0);
      const ready = posted.find((m) => m.type === 'INSPECT_READY');
      expect(ready).toBeDefined();
      expect(ready?.source).toBe(CRISH_PREVIEW_INSPECTOR_SOURCE);
      expect(ready?.type).toBe('INSPECT_READY');
    });

    it('posts INSPECT_HOVER on pointermove while enabled and INSPECT_SELECT on click', () => {
      const btn = document.createElement('button');
      btn.id = 'btn-hover';
      btn.className = 'action-btn';
      btn.setAttribute('data-testid', 'hover-btn');
      btn.textContent = 'Click me';
      container.appendChild(btn);

      install();

      // 激活拾取
      dispatchMessage(hostToggle(true));
      expect(posted).toHaveLength(1); // 仅 READY，激活本身不产生上报

      // pointermove 捕获阶段 → hover 上报
      dispatchWithTarget('pointermove', btn);

      const hover = posted.find((m) => m.type === 'INSPECT_HOVER');
      expect(hover).toBeDefined();
      if (hover?.type === 'INSPECT_HOVER') {
        expect(hover.payload.tagName).toBe('button');
        // 选择器优先级：data-testid 锚点优于唯一 id
        expect(hover.payload.selector).toBe('[data-testid="hover-btn"]');
        // 矩形为有限数值结构（jsdom 布局坐标为默认值，不断言具体尺寸）
        expect(typeof hover.payload.rect.x).toBe('number');
        expect(typeof hover.payload.rect.y).toBe('number');
        expect(typeof hover.payload.rect.width).toBe('number');
        expect(typeof hover.payload.rect.height).toBe('number');
      }

      // click 捕获阶段 → select 上报 + 阻止默认行为
      const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
      Object.defineProperty(clickEvent, 'target', { value: btn });
      window.dispatchEvent(clickEvent);

      expect(clickEvent.defaultPrevented).toBe(true);
      const select = posted.find((m) => m.type === 'INSPECT_SELECT');
      expect(select).toBeDefined();
      if (select?.type === 'INSPECT_SELECT') {
        const p = select.payload;
        expect(p.tagName).toBe('button');
        expect(p.id).toBe('btn-hover');
        expect(p.classes).toEqual(['action-btn']);
        expect(p.attributes['data-testid']).toBe('hover-btn');
        expect(p.bestSelector).toBe('[data-testid="hover-btn"]');
        expect(p.xpath).toContain('button');
        expect(p.textContent).toBe('Click me');
        expect(p.outerHtmlSnippet).toContain('data-testid="hover-btn"');
        expect(p.computedStyles).toMatchObject({
          display: expect.any(String),
          position: expect.any(String),
          color: expect.any(String),
          backgroundColor: expect.any(String),
          fontSize: expect.any(String),
          margin: expect.any(String),
          padding: expect.any(String),
        });
      }
    });

    it('stops reporting after toggle disabled', () => {
      const div = document.createElement('div');
      div.id = 'div-disabled';
      container.appendChild(div);

      install();

      dispatchMessage(hostToggle(false));
      const before = posted.length;

      dispatchWithTarget('pointermove', div);

      expect(posted.length).toBe(before); // 停用后不再上报 hover
    });

    it('reports only one hover for the same element consecutively', () => {
      const div = document.createElement('div');
      div.id = 'div-hover-once';
      container.appendChild(div);

      install();
      dispatchMessage(hostToggle(true));

      dispatchWithTarget('pointermove', div);
      dispatchWithTarget('pointermove', div);
      dispatchWithTarget('pointermove', div);

      const hovers = posted.filter((m) => m.type === 'INSPECT_HOVER');
      expect(hovers).toHaveLength(1);
    });
  });

  describe('Esc 退出拾取', () => {
    it('disables inspector and notifies host on Escape while enabled', () => {
      install();
      dispatchMessage(hostToggle(true));

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

      const toggle = posted.find(
        (m) => m.type === 'INSPECT_TOGGLE' && m.payload.enabled === false
      );
      expect(toggle).toBeDefined();
      if (toggle?.type === 'INSPECT_TOGGLE') {
        expect(toggle.source).toBe(CRISH_PREVIEW_INSPECTOR_SOURCE);
        expect(toggle.payload.enabled).toBe(false);
      }

      // 退出后不再响应拾取事件
      const div = document.createElement('div');
      container.appendChild(div);
      dispatchWithTarget('pointermove', div);

      expect(posted.filter((m) => m.type === 'INSPECT_HOVER')).toHaveLength(0);
    });

    it('does not emit when Escape pressed while disabled', () => {
      install();
      const before = posted.length;

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(posted.length).toBe(before);
    });
  });

  describe('postmessage_security_origin 静默丢弃', () => {
    it('ignores messages with wrong source', () => {
      install();
      dispatchMessage({ source: 'evil-other-frame', type: 'INSPECT_TOGGLE', payload: { enabled: true } });

      // 非法 source 不激活拾取 → 悬停不产生上报
      const div = document.createElement('div');
      container.appendChild(div);
      dispatchWithTarget('pointermove', div);

      expect(posted.filter((m) => m.type === 'INSPECT_HOVER')).toHaveLength(0);
    });

    it('ignores messages with unknown type', () => {
      install();
      dispatchMessage({ source: CRISH_PREVIEW_HOST_SOURCE, type: 'INSPECT_EXPLODE', payload: {} });

      const div = document.createElement('div');
      container.appendChild(div);
      dispatchWithTarget('pointermove', div);

      expect(posted.filter((m) => m.type === 'INSPECT_HOVER')).toHaveLength(0);
    });

    it('ignores malformed payload (missing enabled)', () => {
      install();
      dispatchMessage({ source: CRISH_PREVIEW_HOST_SOURCE, type: 'INSPECT_TOGGLE' });

      const div = document.createElement('div');
      container.appendChild(div);
      dispatchWithTarget('pointermove', div);

      expect(posted.filter((m) => m.type === 'INSPECT_HOVER')).toHaveLength(0);
    });

    it('ignores non-object / primitive message data', () => {
      install();

      dispatchMessage('hello');
      dispatchMessage(42);
      dispatchMessage(null);
      dispatchMessage(undefined);

      expect(posted.filter((m) => m.type === 'INSPECT_HOVER')).toHaveLength(0);
    });
  });

  describe('清理函数', () => {
    it('removes message listener and disables inspector on cleanup', () => {
      const cleanup = install();
      cleanup();
      installedCleanup = null;

      // 清理后 toggle 不再生效（监听已移除）
      dispatchMessage(hostToggle(true));
      const div = document.createElement('div');
      container.appendChild(div);
      dispatchWithTarget('pointermove', div);

      expect(posted.filter((m) => m.type === 'INSPECT_HOVER')).toHaveLength(0);
    });

    it('is idempotent against double installation', () => {
      const cleanup1 = installPreviewInspectorClient({ doc: document, win: window });
      const cleanup2 = installPreviewInspectorClient({ doc: document, win: window });

      // 二次安装被双安装防护拦截，不重复上报 READY
      const readys = posted.filter((m) => m.type === 'INSPECT_READY');
      expect(readys).toHaveLength(1);

      cleanup1();
      cleanup2();
      // 清理后无泄漏（重复 cleanup 幂等）
    });
  });
});
