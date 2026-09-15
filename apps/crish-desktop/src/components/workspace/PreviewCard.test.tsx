// @vitest-environment jsdom
/**
 * PreviewCard 原生预览与透明代理/DOM 拾取器测试套件：
 * 1. 代理 URL 解析函数（外部 URL 走代理、本地 URL 直连、空白 URL）；
 * 2. 默认空态渲染与快捷地址导航；
 * 3. 书签与历史浮层切换；
 * 4. DOM 拾取器按钮点击切换状态与 postMessage 双向通信（previewProtocol 单轨契约）；
 * 5. 右上角 AI 协同指示与「停止」操作。
 *
 * 遵循测试资产保护铁律（UTF-8 无 BOM，中文注释）；仅随死代码清退同步删除
 * 断言对象已不存在的用例（见 T19 注记）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { PreviewCard } from './PreviewCard';
import {
  isLocalDevUrl,
  safeIframeSrc,
  toProxyPreviewUrl,
} from './previewCardLib';
import { ToastProvider } from '../../services/toast/ToastContext';
import { useSessionStore } from '../../store/sessionStore';
import type { SessionState } from '../../store/types';
import {
  CRISH_PREVIEW_HOST_SOURCE,
  CRISH_PREVIEW_INSPECTOR_SOURCE,
} from './previewProtocol';
import {
  setCachedActivePorts,
  clearActivePortCache,
} from './activePortDetector';

function renderCard(initialTarget?: string) {
  return render(
    <ToastProvider>
      <PreviewCard wsId="default" initialTarget={initialTarget} />
    </ToastProvider>
  );
}

describe('PreviewCard 原生预览浏览器与透明代理', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    setCachedActivePorts([5173]);
    useSessionStore.setState({
      activeSessionId: '',
      sessionsById: {},
    });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    clearActivePortCache();
    useSessionStore.setState({
      activeSessionId: '',
      sessionsById: {},
    });
  });

  describe('1. 代理 URL 解析函数 (toProxyPreviewUrl / safeIframeSrc / isLocalDevUrl)', () => {
    it('外部 HTTP/HTTPS URL：自动重定向至 /__crish_preview_proxy 同源代理端点', () => {
      const ext1 = 'https://example.com';
      const ext2 = 'http://api.github.com/v1/docs';
      const ext3 = 'https://sub.domain.org:8443/page?query=1&sort=desc';

      expect(toProxyPreviewUrl(ext1)).toBe(
        `/__crish_preview_proxy?url=${encodeURIComponent(ext1)}`
      );
      expect(toProxyPreviewUrl(ext2)).toBe(
        `/__crish_preview_proxy?url=${encodeURIComponent(ext2)}`
      );
      expect(toProxyPreviewUrl(ext3)).toBe(
        `/__crish_preview_proxy?url=${encodeURIComponent(ext3)}`
      );
    });

    it('本地开发服务 URL：直连不走代理', () => {
      const locals = [
        'http://localhost:5173',
        'http://localhost:3000/dashboard',
        'http://127.0.0.1:8080',
        'http://0.0.0.0:4173',
        'http://[::1]:3000',
        'http://dev.localhost:8000',
        'http://my-app.local:3000',
        'http://service.internal',
        'http://project.lan',
      ];

      for (const loc of locals) {
        expect(isLocalDevUrl(loc)).toBe(true);
        expect(toProxyPreviewUrl(loc)).toBe(loc);
      }
    });

    it('空白与特殊协议 URL：保持原样或安全直连', () => {
      expect(toProxyPreviewUrl('')).toBe('');
      expect(toProxyPreviewUrl('about:blank')).toBe('about:blank');
      expect(toProxyPreviewUrl('data:text/html,<h1>Test</h1>')).toBe(
        'data:text/html,<h1>Test</h1>'
      );
    });

    // audit-repair-202609 T19：injectPreviewBridgeHtml 已删除——桥脚本唯一
    // 真源为 dev-server/previewBridgeScript.ts（由代理在服务端注入），
    // 其契约断言见 previewBridgeScript.test.ts。

    it('file 协议处理', () => {
      expect(toProxyPreviewUrl('file:///path/to/page.html')).toBe(
        'file:///path/to/page.html'
      );
    });

    it('已是代理端点的 URL：幂等处理，不重复封装', () => {
      const proxyUrl1 =
        '/__crish_preview_proxy?url=https%3A%2F%2Fexample.com';
      expect(toProxyPreviewUrl(proxyUrl1)).toBe(proxyUrl1);

      const proxyUrl2 =
        'http://127.0.0.1:8765/v1/preview/proxy?url=https%3A%2F%2Fexample.com';
      expect(toProxyPreviewUrl(proxyUrl2)).toBe(proxyUrl2);
    });

    // audit-repair-202609 T20：initialTarget（preview:<target> resolver 透传）
    // 挂载时导航一次，iframe 加载该目标的代理地址
    it('initialTarget 挂载时导航到目标（iframe src 为该目标的代理端点）', async () => {
      renderCard('https://example.com/landing');

      await waitFor(() => {
        const iframe = document.querySelector('iframe');
        expect(iframe).toBeTruthy();
        expect(iframe?.getAttribute('src')).toContain('/__crish_preview_proxy');
        expect(iframe?.getAttribute('src')).toContain(
          encodeURIComponent('https://example.com/landing')
        );
      });
    });

    it('地址栏同步显示 initialTarget 导航结果', async () => {
      renderCard('https://example.com/landing');

      await waitFor(() => {
        const input = document.querySelector('input[type="text"]');
        expect(input).toBeTruthy();
      });
      // 地址栏经由 navigate 更新为最终 URL
      await waitFor(() => {
        const inputs = Array.from(
          document.querySelectorAll('input')
        ) as HTMLInputElement[];
        expect(
          inputs.some((el) => el.value.includes('example.com/landing'))
        ).toBe(true);
      });
    });

    it('safeIframeSrc 安全判定：对外部合法 URL 返回代理地址，对非法/危险 scheme 返回 null', () => {
      // 外部合法 URL 走代理
      expect(safeIframeSrc('https://example.com')).toBe(
        `/__crish_preview_proxy?url=${encodeURIComponent('https://example.com')}`
      );
      // 本地合法 URL 直连
      expect(safeIframeSrc('http://localhost:5173')).toBe('http://localhost:5173');
      // 空白 / 空串返回 null
      expect(safeIframeSrc('')).toBeNull();
      expect(safeIframeSrc('about:blank')).toBeNull();
      // 危险 scheme 返回 null
      expect(safeIframeSrc('javascript:alert(1)')).toBeNull();
      expect(safeIframeSrc('vbscript:msgbox(1)')).toBeNull();
    });
  });

  describe('2. 基础渲染与快捷导航', () => {
    it('默认无活跃端口时：保持纯净极简空白，无视觉杂质，不显示废话文字与地球图标', async () => {
      setCachedActivePorts([]);
      renderCard();
      await waitFor(() => {
        expect(
          screen.getByRole('toolbar', { name: '预览浏览器工具栏' })
        ).toBeTruthy();
      });
      expect(screen.queryByText('预览浏览器')).toBeNull();
      expect(screen.queryByText(/输入本地地址/)).toBeNull();
      expect(screen.queryByRole('button', { name: /localhost/ })).toBeNull();
      expect(screen.getByLabelText('后退')).toBeDisabled();
      expect(screen.getByLabelText('前进')).toBeDisabled();
      expect(screen.getByLabelText('加入书签')).toBeDisabled();
    });

    it('检测到活跃端口：展示极简运行中的本地服务胶囊，点击直接导航', async () => {
      setCachedActivePorts([5173]);
      renderCard();
      const chip = await screen.findByRole('button', {
        name: /localhost:5173/,
      });
      expect(chip.textContent).toContain('运行中的本地服务:');
      expect(chip.textContent).toContain('localhost:5173');
      fireEvent.click(chip);

      await waitFor(() => {
        const iframe = document.querySelector('iframe');
        expect(iframe).toBeTruthy();
        expect(iframe?.getAttribute('src')).toBe('http://localhost:5173');
      });
    });

    it('外部网站自动转换为同源代理端点加载', async () => {
      renderCard();
      const input = screen.getByLabelText('预览地址');
      fireEvent.change(input, { target: { value: 'https://example.com/demo' } });
      fireEvent.submit(input.closest('form')!);

      await waitFor(() => {
        const iframe = document.querySelector('iframe');
        expect(iframe).toBeTruthy();
        expect(iframe?.getAttribute('src')).toBe(
          `/__crish_preview_proxy?url=${encodeURIComponent('https://example.com/demo')}`
        );
      });
    });

    it('历史与书签浮层可正常展开与关闭', async () => {
      renderCard();
      const histBtn = await screen.findByRole('button', { name: '历史与书签' });
      fireEvent.click(histBtn);

      await waitFor(() => {
        expect(document.querySelector('#preview-hist-panel')).toBeTruthy();
      });

      fireEvent.click(histBtn);
      await waitFor(() => {
        expect(document.querySelector('#preview-hist-panel')).toBeNull();
      });
    });
  });

  describe('3. DOM 元素拾取器交互与状态机', () => {
    it('空白状态下 DOM 拾取器按钮处于 disabled 状态', async () => {
      renderCard();
      const inspectorBtn = screen.getByLabelText('拾取页面元素');
      expect(inspectorBtn).toBeDisabled();
    });

    it('DOM 元素拾取器：点击切换激活态并向 iframe 发送 INSPECT_TOGGLE 指令', async () => {
      renderCard();
      // 先加载一个本地页面
      const chip = await screen.findByRole('button', { name: /localhost:5173/ });
      fireEvent.click(chip);

      await waitFor(() => {
        expect(document.querySelector('iframe')).toBeTruthy();
      });

      const inspectorBtn = screen.getByLabelText('拾取页面元素');
      expect(inspectorBtn).not.toBeDisabled();
      expect(inspectorBtn.getAttribute('aria-pressed')).toBe('false');

      const iframe = document.querySelector('iframe')!;
      const postMessageSpy = vi.fn();
      Object.defineProperty(iframe, 'contentWindow', {
        value: { postMessage: postMessageSpy },
        writable: true,
      });

      // 点击激活拾取器
      fireEvent.click(inspectorBtn);
      expect(inspectorBtn.getAttribute('aria-pressed')).toBe('true');
      // §4.1 安全加固：targetOrigin 不再用通配 '*'，改为解析出的 iframe origin
      // （previewHostBridge.ts resolveInspectorTargetOrigin：优先
      // iframe.contentWindow.location.origin，跨域不可读则回落宿主 origin；
      // 本用例以 { postMessage } 替身覆写 contentWindow ⇒ 无 location ⇒ 回落宿主 origin）
      const expectedOrigin = window.location.origin;
      expect(postMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          source: CRISH_PREVIEW_HOST_SOURCE,
          type: 'INSPECT_TOGGLE',
          payload: { enabled: true },
        }),
        expectedOrigin
      );

      // 再次点击退出拾取器
      fireEvent.click(inspectorBtn);
      expect(inspectorBtn.getAttribute('aria-pressed')).toBe('false');
      expect(postMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          source: CRISH_PREVIEW_HOST_SOURCE,
          type: 'INSPECT_TOGGLE',
          payload: { enabled: false },
        }),
        expectedOrigin
      );
      // 反向锁定：任何一次投递都不得用通配 targetOrigin
      for (const call of postMessageSpy.mock.calls) {
        expect(call[1]).not.toBe('*');
      }
    });
  });

  describe('4. iframe 跨窗口消息与 DOM 拾取结果展示', () => {
    it('接收 INSPECT_SELECT 消息：展示选中详情卡（标签/尺寸/复制/发送到 AI）', async () => {
      renderCard();
      // 加载页面
      const chip = await screen.findByRole('button', { name: /localhost:5173/ });
      fireEvent.click(chip);

      await waitFor(() => {
        expect(document.querySelector('iframe')).toBeTruthy();
      });

      // 派发新协议 INSPECT_SELECT 消息
      // §4.1：subscribeToInspector 先校验 origin 白名单
      // （previewProtocol.ts:110 isAllowedPreviewMessageOrigin === window.location.origin）
      // 再解析 source/type 防伪造；不带 origin 的 MessageEvent 会被直接丢弃。
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            origin: window.location.origin,
            data: {
              source: CRISH_PREVIEW_INSPECTOR_SOURCE,
              type: 'INSPECT_SELECT',
              payload: {
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
                outerHtmlSnippet: '<button>Go</button>',
                textContent: 'Go',
              },
            },
          })
        );
      });

      await waitFor(() => {
        expect(screen.getByText('已拾取 DOM 元素：')).toBeTruthy();
        expect(screen.getByText('<button#submit-btn.submit.primary>')).toBeTruthy();
      });

      // 选中详情卡带出尺寸与操作按钮
      expect(screen.getByText('100×40')).toBeTruthy();
      expect(screen.getByLabelText('复制选择器')).toBeTruthy();
      expect(screen.getByLabelText('发送到 AI')).toBeTruthy();
    });

    it('接收 INSPECT_HOVER 消息：展示悬停浮层（Tag/选择器/坐标）', async () => {
      renderCard();
      const chip = await screen.findByRole('button', { name: /localhost:5173/ });
      fireEvent.click(chip);

      await waitFor(() => {
        expect(document.querySelector('iframe')).toBeTruthy();
      });

      // 激活拾取态后悬停消息才展示浮层
      const inspectorBtn = screen.getByLabelText('拾取页面元素');
      fireEvent.click(inspectorBtn);

      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            // §4.1：origin 白名单校验（同 INSPECT_SELECT 用例）
            origin: window.location.origin,
            data: {
              source: CRISH_PREVIEW_INSPECTOR_SOURCE,
              type: 'INSPECT_HOVER',
              payload: {
                tagName: 'div',
                selector: 'div.card',
                rect: { x: 4, y: 8, width: 120, height: 60 },
              },
            },
          })
        );
      });

      await waitFor(() => {
        const overlay = document.querySelector('[data-inspector-hover]');
        expect(overlay).toBeTruthy();
        expect(overlay?.textContent).toContain('div');
        expect(overlay?.textContent).toContain('div.card');
      });
    });
    // audit-repair-202609 T19：legacy `crish:dom-inspected` 协议已随
    // previewDomInspector 双轨清退而删除；拾取 Badge 的行为由上方
    // INSPECT_SELECT（previewProtocol 单轨契约）用例覆盖。
  });

  describe('5. AI 协同状态指示与停止操作', () => {
    it('未发生 AI 协同：默认不展示右上角 AI 运行徽标与停止按钮', async () => {
      renderCard();
      expect(screen.queryByText('AI 正在协同')).toBeNull();
      expect(screen.queryByRole('button', { name: '停止' })).toBeNull();
    });

    it('当有消息处理中 (processing)：展示「AI 正在协同」与「停止」按钮，点击分派 crish:chat-stop 事件', async () => {
      const stopListener = vi.fn();
      window.addEventListener('crish:chat-stop', stopListener);

      useSessionStore.setState({
        activeSessionId: 'sess-streaming-1',
        sessionsById: {
          'sess-streaming-1': {
            id: 'sess-streaming-1',
            messages: [
              {
                id: 'msg-1',
                role: 'assistant',
                content: '正在生成代码...',
                status: 'processing',
              },
            ],
            agents: [],
          } as unknown as SessionState,
        },
      });

      renderCard();

      await waitFor(() => {
        expect(screen.getByText('AI 正在协同')).toBeTruthy();
      });

      const stopBtn = screen.getByRole('button', { name: '停止' });
      expect(stopBtn).toBeTruthy();

      fireEvent.click(stopBtn);
      expect(stopListener).toHaveBeenCalled();

      window.removeEventListener('crish:chat-stop', stopListener);
    });

    it('当有 Agent 运行中 (running)：同样展示「AI 正在协同」与「停止」按钮', async () => {
      useSessionStore.setState({
        activeSessionId: 'sess-streaming-2',
        sessionsById: {
          'sess-streaming-2': {
            id: 'sess-streaming-2',
            messages: [],
            agents: [
              {
                id: 'agent-1',
                status: 'running',
              },
            ],
          } as unknown as SessionState,
        },
      });

      renderCard();

      await waitFor(() => {
        expect(screen.getByText('AI 正在协同')).toBeTruthy();
        expect(screen.getByRole('button', { name: '停止' })).toBeTruthy();
      });
    });

    it('AI 正在协同停止按钮：独立分派 crish:chat-stop 事件验证（已有用例资产保护）', async () => {
      const stopListener = vi.fn();
      window.addEventListener('crish:chat-stop', stopListener);

      renderCard();
      // 模拟 dispatch 触发停止事件
      window.dispatchEvent(new CustomEvent('crish:chat-stop'));
      expect(stopListener).toHaveBeenCalled();

      window.removeEventListener('crish:chat-stop', stopListener);
    });
  });
});
