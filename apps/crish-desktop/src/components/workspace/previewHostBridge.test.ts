// @vitest-environment jsdom
/**
 * previewHostBridge 宿主桥单元测试：
 * 1. enableInspector 向 iframe contentWindow 投递 INSPECT_TOGGLE（source 校验）；
 * 2. subscribeToInspector 来源校验：非法 source / 未知 type 的消息静默丢弃；
 * 3. INSPECT_READY / INSPECT_HOVER / INSPECT_SELECT 归一化派发与 unsubscribe 清理。
 * 遵循测试资产保护铁律（UTF-8 无 BOM，中文注释）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  enableInspector,
  parseClientToHostMessage,
  subscribeToInspector,
  type InspectorIframeRef,
} from './previewHostBridge';
import {
  CRISH_PREVIEW_HOST_SOURCE,
  CRISH_PREVIEW_INSPECTOR_SOURCE,
} from './previewProtocol';

/** 构造可投递的 iframe 引用（contentWindow 由外部 mock 注入） */
function makeIframeRef(
  postMessageMock: ReturnType<typeof vi.fn>
): InspectorIframeRef {
  return {
    current: {
      contentWindow: {
        postMessage: postMessageMock,
        location: { origin: window.location.origin },
      },
    } as unknown as HTMLIFrameElement,
  };
}

/** 派发一条客户端 → 宿主 message 事件 */
function dispatchClientMessage(
  data: unknown,
  origin: string = window.location.origin
): void {
  window.dispatchEvent(new MessageEvent('message', { data, origin }));
}

describe('previewHostBridge', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('enableInspector', () => {
    it('激活时向 iframe contentWindow 发送 INSPECT_TOGGLE（source=crish-preview-host）', () => {
      const postMessageMock = vi.fn();
      const ok = enableInspector(makeIframeRef(postMessageMock), true);
      expect(ok).toBe(true);
      expect(postMessageMock).toHaveBeenCalledWith(
        {
          source: CRISH_PREVIEW_HOST_SOURCE,
          type: 'INSPECT_TOGGLE',
          payload: { enabled: true },
        },
        window.location.origin
      );
    });

    it('关闭时发送 enabled=false 指令', () => {
      const postMessageMock = vi.fn();
      const ok = enableInspector(makeIframeRef(postMessageMock), false);
      expect(ok).toBe(true);
      expect(postMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'INSPECT_TOGGLE',
          payload: { enabled: false },
        }),
        window.location.origin
      );
    });

    it('iframe 或 contentWindow 未就绪时返回 false 且不投递', () => {
      expect(enableInspector(null, true)).toBe(false);
      expect(enableInspector({ current: null }, true)).toBe(false);
      const noWin = {
        current: {} as unknown as HTMLIFrameElement,
      };
      expect(enableInspector(noWin, true)).toBe(false);
    });
  });

  describe('parseClientToHostMessage 来源与类型校验', () => {
    it('非法 source（宿主方向 / 缺失 / 未知）一律返回 null', () => {
      expect(
        parseClientToHostMessage({
          source: CRISH_PREVIEW_HOST_SOURCE,
          type: 'INSPECT_HOVER',
          payload: {},
        })
      ).toBeNull();
      expect(
        parseClientToHostMessage({ type: 'INSPECT_HOVER', payload: {} })
      ).toBeNull();
      expect(
        parseClientToHostMessage({
          source: 'some-other-window',
          type: 'INSPECT_HOVER',
          payload: {},
        })
      ).toBeNull();
      expect(parseClientToHostMessage(null)).toBeNull();
      expect(parseClientToHostMessage('string')).toBeNull();
    });

    it('未知 type（即使来源合法）返回 null', () => {
      expect(
        parseClientToHostMessage({
          source: CRISH_PREVIEW_INSPECTOR_SOURCE,
          type: 'INSPECT_DRAG',
          payload: {},
        })
      ).toBeNull();
    });

    it('INSPECT_HOVER 载荷类型非法（rect 缺字段）返回 null', () => {
      expect(
        parseClientToHostMessage({
          source: CRISH_PREVIEW_INSPECTOR_SOURCE,
          type: 'INSPECT_HOVER',
          payload: { tagName: 'button', selector: 'x', rect: { x: 1 } },
        })
      ).toBeNull();
    });

    it('INSPECT_SELECT 载荷关键字段缺失返回 null', () => {
      expect(
        parseClientToHostMessage({
          source: CRISH_PREVIEW_INSPECTOR_SOURCE,
          type: 'INSPECT_SELECT',
          payload: { tagName: 'div', bestSelector: 'div' },
        })
      ).toBeNull();
    });
  });

  describe('subscribeToInspector', () => {
    it('INSPECT_READY：派发就绪事件', () => {
      const listener = vi.fn();
      const unsubscribe = subscribeToInspector(listener);
      dispatchClientMessage({
        source: CRISH_PREVIEW_INSPECTOR_SOURCE,
        type: 'INSPECT_READY',
        payload: {},
      });
      expect(listener).toHaveBeenCalledWith({ type: 'INSPECT_READY' });
      unsubscribe();
    });

    it('INSPECT_TOGGLE（客户端 Esc 退出）：派发复位指令', () => {
      const listener = vi.fn();
      const unsubscribe = subscribeToInspector(listener);
      dispatchClientMessage({
        source: CRISH_PREVIEW_INSPECTOR_SOURCE,
        type: 'INSPECT_TOGGLE',
        payload: { enabled: false },
      });
      expect(listener).toHaveBeenCalledWith({
        type: 'INSPECT_TOGGLE',
        payload: { enabled: false },
      });
      unsubscribe();
    });

    it('INSPECT_TOGGLE 载荷非法（enabled 非布尔）：静默丢弃', () => {
      const listener = vi.fn();
      const unsubscribe = subscribeToInspector(listener);
      dispatchClientMessage({
        source: CRISH_PREVIEW_INSPECTOR_SOURCE,
        type: 'INSPECT_TOGGLE',
        payload: { enabled: 'yes' },
      });
      expect(listener).not.toHaveBeenCalled();
      unsubscribe();
    });

    it('INSPECT_TOGGLE 不允许网页把宿主拾取状态设为 active', () => {
      const listener = vi.fn();
      const unsubscribe = subscribeToInspector(listener);
      dispatchClientMessage({
        source: CRISH_PREVIEW_INSPECTOR_SOURCE,
        type: 'INSPECT_TOGGLE',
        payload: { enabled: true },
      });
      expect(listener).not.toHaveBeenCalled();
      unsubscribe();
    });

    it('INSPECT_HOVER：派发归一化悬停载荷', () => {
      const listener = vi.fn();
      const unsubscribe = subscribeToInspector(listener);
      dispatchClientMessage({
        source: CRISH_PREVIEW_INSPECTOR_SOURCE,
        type: 'INSPECT_HOVER',
        payload: {
          tagName: 'button',
          selector: '#submit',
          rect: { x: 1, y: 2, width: 30, height: 10 },
        },
      });
      expect(listener).toHaveBeenCalledWith({
        type: 'INSPECT_HOVER',
        payload: {
          tagName: 'button',
          selector: '#submit',
          rect: { x: 1, y: 2, width: 30, height: 10 },
        },
      });
      unsubscribe();
    });

    it('INSPECT_SELECT：派发完整选中载荷', () => {
      const listener = vi.fn();
      const unsubscribe = subscribeToInspector(listener);
      const selectPayload = {
        tagName: 'button',
        id: 'submit-btn',
        classes: ['submit', 'primary'],
        attributes: { 'data-testid': 'submit-btn' },
        bestSelector: 'button.submit.primary',
        xpath: '/html/body/button[1]',
        rect: { x: 10, y: 20, width: 100, height: 40 },
        computedStyles: {
          display: 'block',
          position: 'relative',
          color: '#fff',
          backgroundColor: '#2563eb',
          fontSize: '14px',
          margin: '0px',
          padding: '4px 8px',
        },
        outerHtmlSnippet: '<button class="submit primary">Go</button>',
        textContent: 'Go',
      };
      dispatchClientMessage({
        source: CRISH_PREVIEW_INSPECTOR_SOURCE,
        type: 'INSPECT_SELECT',
        payload: selectPayload,
      });
      expect(listener).toHaveBeenCalledWith({
        type: 'INSPECT_SELECT',
        payload: selectPayload,
      });
      unsubscribe();
    });

    it('非法来源 / 未知 type / 脏载荷：静默丢弃，不触发任何回调', () => {
      const listener = vi.fn();
      const unsubscribe = subscribeToInspector(listener);

      // 来源错误（宿主方向 / 缺失）
      dispatchClientMessage({
        source: CRISH_PREVIEW_HOST_SOURCE,
        type: 'INSPECT_HOVER',
        payload: {},
      });
      dispatchClientMessage({ type: 'INSPECT_HOVER', payload: {} });
      // 未知 type
      dispatchClientMessage({
        source: CRISH_PREVIEW_INSPECTOR_SOURCE,
        type: 'INSPECT_UNKNOWN',
        payload: {},
      });
      // 载荷类型非法
      dispatchClientMessage({
        source: CRISH_PREVIEW_INSPECTOR_SOURCE,
        type: 'INSPECT_SELECT',
        payload: { tagName: 'div' },
      });

      expect(listener).not.toHaveBeenCalled();
      unsubscribe();
    });

    it('非法 event.origin：即使 source 合法也静默丢弃', () => {
      const listener = vi.fn();
      const unsubscribe = subscribeToInspector(listener);
      dispatchClientMessage(
        {
          source: CRISH_PREVIEW_INSPECTOR_SOURCE,
          type: 'INSPECT_READY',
          payload: {},
        },
        'https://evil.example'
      );
      expect(listener).not.toHaveBeenCalled();
      unsubscribe();
    });

    it('unsubscribe 之后不再接收消息', () => {
      const listener = vi.fn();
      const unsubscribe = subscribeToInspector(listener);
      unsubscribe();
      dispatchClientMessage({
        source: CRISH_PREVIEW_INSPECTOR_SOURCE,
        type: 'INSPECT_READY',
        payload: {},
      });
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
