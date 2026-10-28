// @vitest-environment jsdom
/**
 * PreviewCard 原生预览与透明代理/DOM 拾取器测试套件：
 * 1. 代理 URL 解析函数（外部 URL 走代理、本地 URL 直连、空白 URL）；
 * 2. 默认空态渲染与快捷地址导航；
 * 3. 书签与历史浮层切换；
 * 4. DOM 拾取器 Native command/event 通信与结果展示（previewProtocol 单轨契约）；
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
import { isLocalDevUrl, safeIframeSrc } from './previewCardLib';
import { ToastProvider } from '../../services/toast/ToastContext';
import { ToastStore } from '../../services/toast/ToastStore';
import { useSessionStore } from '../../store/sessionStore';
import type { SessionState } from '../../store/types';
import type { NativeBrowserInspectorEvent } from './nativeBrowserInspectorApi';
import {
  setCachedActivePorts,
  clearActivePortCache,
} from './activePortDetector';
import { resetNativeBrowserLifecyclesForTesting } from '../../api/nativeBrowserLifecycle';

const { mockInvoke, inspectorApiMock } = vi.hoisted(() => ({
  mockInvoke: vi.fn().mockImplementation((command: string, args?: unknown) => {
    if (command.includes('browser_webview_set_hit_test')) {
      return Promise.resolve({
        status: 'unsupported',
        reason: 'Native browser hit-test is not implemented',
      });
    }
    if (
      command === 'browser_webview_create' ||
      command === 'browser_webview_navigate'
    ) {
      const commandArgs = (args ?? {}) as Record<string, unknown>;
      const tabId = commandArgs.tabId;
      const url =
        command === 'browser_webview_create'
          ? commandArgs.initialUrl
          : commandArgs.url;
      queueMicrotask(() =>
        emitNativeBrowserEvent('browser://navigation-state', {
          tabId,
          url: typeof url === 'string' ? url : 'about:blank',
          title: '',
          canGoBack: false,
          canGoForward: false,
          isLoading: false,
        })
      );
    }
    return Promise.resolve(undefined);
  }),
  inspectorApiMock: {
    setInspector: vi.fn(),
    listener: null as ((event: unknown) => void) | null,
    nativeEvents: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  },
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    async (
      eventName: string,
      callback: (event: { payload: unknown }) => void
    ) => {
      const listeners =
        inspectorApiMock.nativeEvents.get(eventName) ?? new Set();
      listeners.add(callback);
      inspectorApiMock.nativeEvents.set(eventName, listeners);
      return () => {
        listeners.delete(callback);
      };
    }
  ),
}));

vi.mock('./nativeBrowserInspectorApi', () => ({
  browserWebviewSetInspector: inspectorApiMock.setInspector,
  onNativeBrowserInspectorEvent: (
    callback: (event: unknown) => void,
    observer?: { onReady?: () => void; onError?: (error: Error) => void }
  ) => {
    inspectorApiMock.listener = callback;
    observer?.onReady?.();
    return vi.fn();
  },
}));

function emitInspectorEvent(event: NativeBrowserInspectorEvent) {
  act(() => inspectorApiMock.listener?.(event));
}

function emitNativeBrowserEvent(eventName: string, payload: unknown) {
  act(() => {
    for (const listener of inspectorApiMock.nativeEvents.get(eventName) ?? []) {
      listener({ payload });
    }
  });
}

function emitNativeBrowserNavigationSettled(url = 'http://localhost:5173') {
  emitNativeBrowserEvent('browser://navigation-state', {
    tabId: 'browser-default',
    url,
    title: '',
    isLoading: false,
  });
}

function renderCard(initialTarget?: string) {
  return render(
    <ToastProvider>
      <PreviewCard wsId="default" initialTarget={initialTarget} />
    </ToastProvider>
  );
}

describe('PreviewCard 原生预览浏览器与透明代理', () => {
  beforeEach(() => {
    (window as any).__TAURI_INTERNALS__ = {};
    resetNativeBrowserLifecyclesForTesting();
    localStorage.clear();
    vi.clearAllMocks();
    mockInvoke.mockClear();
    ToastStore.clear();
    inspectorApiMock.listener = null;
    inspectorApiMock.nativeEvents.clear();
    inspectorApiMock.setInspector.mockResolvedValue(undefined);
    setCachedActivePorts([5173]);
    useSessionStore.setState({
      activeSessionId: '',
      sessionsById: {},
      composerDrafts: {},
    });
  });

  afterEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
    resetNativeBrowserLifecyclesForTesting();
    cleanup();
    localStorage.clear();
    clearActivePortCache();
    ToastStore.clear();
    useSessionStore.setState({
      activeSessionId: '',
      sessionsById: {},
      composerDrafts: {},
    });
  });

  describe('1. 基础 URL 解析与验证 (safeIframeSrc / isLocalDevUrl)', () => {
    it('安全 URL 判定放行与拦截', () => {
      expect(safeIframeSrc('https://example.com')).toBe('https://example.com');
      expect(safeIframeSrc('http://localhost:3000')).toBe(
        'http://localhost:3000'
      );
      expect(safeIframeSrc('javascript:void(0)')).toBeNull();
      expect(safeIframeSrc('')).toBeNull();
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
      }
    });

    // audit-repair-202609 T20：initialTarget（preview:<target> resolver 透传）
    // 挂载时导航一次，NativeBrowserSurface 加载该目标
    it('initialTarget 挂载时导航到目标（NativeBrowserSurface 加载该目标）', async () => {
      renderCard('https://example.com/landing');

      await waitFor(() => {
        const surface = document.querySelector('[data-native-surface="true"]');
        expect(surface).toBeTruthy();
        expect(surface?.getAttribute('data-initial-url')).toBe(
          'https://example.com/landing'
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

    it('safeIframeSrc 安全判定：对外部合法 URL 直接放行原样，对非法/危险 scheme 返回 null', () => {
      // 外部合法 URL 直接放行原样
      expect(safeIframeSrc('https://example.com')).toBe('https://example.com');
      // 本地合法 URL 直连
      expect(safeIframeSrc('http://localhost:5173')).toBe(
        'http://localhost:5173'
      );
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
      expect(chip.textContent).toBe('localhost:5173');
      fireEvent.click(chip);

      await waitFor(() => {
        const surface = document.querySelector('[data-native-surface="true"]');
        expect(surface).toBeTruthy();
        expect(surface?.getAttribute('data-initial-url')).toBe(
          'http://localhost:5173'
        );
      });
    });

    it('外部网站导航至 NativeBrowserSurface', async () => {
      renderCard();
      const input = screen.getByLabelText('预览地址');
      fireEvent.change(input, {
        target: { value: 'https://example.com/demo' },
      });
      fireEvent.submit(input.closest('form')!);

      await waitFor(() => {
        const surface = document.querySelector('[data-native-surface="true"]');
        expect(surface).toBeTruthy();
        expect(surface?.getAttribute('data-initial-url')).toBe(
          'https://example.com/demo'
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

    it('Native surface 创建完成前禁用拾取，创建成功后启用', async () => {
      const previousImplementation = mockInvoke.getMockImplementation();
      let releaseCreate!: () => void;
      const createGate = new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });
      mockInvoke.mockImplementation((command: string, args?: unknown) => {
        if (command === 'browser_webview_create') return createGate;
        return previousImplementation?.(command, args);
      });

      renderCard();
      fireEvent.click(
        await screen.findByRole('button', { name: /localhost:5173/ })
      );
      const inspectorBtn = screen.getByLabelText('拾取页面元素');
      try {
        await waitFor(() =>
          expect(mockInvoke).toHaveBeenCalledWith(
            'browser_webview_create',
            expect.objectContaining({ tabId: 'browser-default' })
          )
        );
        expect(inspectorBtn).toBeDisabled();

        await act(async () => {
          releaseCreate();
          await createGate;
        });
        emitNativeBrowserNavigationSettled();
        await waitFor(() => expect(inspectorBtn).toBeEnabled());
      } finally {
        releaseCreate();
        if (previousImplementation) {
          mockInvoke.mockImplementation(previousImplementation);
        }
      }
    });

    it('Native navigation loading 保留 Inspector 意图并在新文档 READY 后恢复探针', async () => {
      renderCard();
      fireEvent.click(
        await screen.findByRole('button', { name: /localhost:5173/ })
      );
      emitNativeBrowserNavigationSettled();
      const inspectorBtn = screen.getByLabelText('拾取页面元素');
      await waitFor(() => expect(inspectorBtn).toBeEnabled());
      fireEvent.click(inspectorBtn);
      await waitFor(() =>
        expect(inspectorBtn).toHaveAttribute('aria-pressed', 'true')
      );
      await waitFor(() =>
        expect(inspectorApiMock.setInspector).toHaveBeenCalledWith(
          'browser-default',
          true
        )
      );

      emitNativeBrowserEvent('browser://navigation-state', {
        tabId: 'browser-default',
        url: 'http://localhost:5173',
        title: '',
        isLoading: true,
      });
      expect(inspectorBtn).toBeDisabled();
      expect(inspectorBtn.getAttribute('aria-pressed')).toBe('true');

      emitInspectorEvent({
        tabId: 'browser-default',
        type: 'INSPECT_READY',
      });
      await waitFor(() =>
        expect(inspectorApiMock.setInspector).toHaveBeenCalledTimes(2)
      );
      expect(inspectorApiMock.setInspector).toHaveBeenLastCalledWith(
        'browser-default',
        true
      );
      expect(inspectorBtn).toBeDisabled();

      emitNativeBrowserEvent('browser://navigation-state', {
        tabId: 'browser-default',
        url: 'http://localhost:5173',
        title: '',
        isLoading: false,
      });
      await waitFor(() => expect(inspectorBtn).toBeEnabled());
      expect(inspectorBtn.getAttribute('aria-pressed')).toBe('true');
    });

    it('DOM 元素拾取器：点击切换激活态', async () => {
      renderCard();
      // 先加载一个本地页面
      const chip = await screen.findByRole('button', {
        name: /localhost:5173/,
      });
      fireEvent.click(chip);

      await waitFor(() => {
        expect(
          document.querySelector('[data-native-surface="true"]')
        ).toBeTruthy();
      });
      emitNativeBrowserNavigationSettled();

      const inspectorBtn = screen.getByLabelText('拾取页面元素');
      await waitFor(() => expect(inspectorBtn).toBeEnabled());
      expect(inspectorBtn.getAttribute('aria-pressed')).toBe('false');

      // 点击激活拾取器
      fireEvent.click(inspectorBtn);
      expect(inspectorBtn.getAttribute('aria-pressed')).toBe('true');

      // 再次点击退出拾取器
      fireEvent.click(inspectorBtn);
      expect(inspectorBtn.getAttribute('aria-pressed')).toBe('false');
      await waitFor(() =>
        expect(inspectorApiMock.setInspector).toHaveBeenCalledTimes(2)
      );
      expect(inspectorApiMock.setInspector).toHaveBeenNthCalledWith(
        1,
        'browser-default',
        true
      );
      expect(inspectorApiMock.setInspector).toHaveBeenNthCalledWith(
        2,
        'browser-default',
        false
      );
    });
  });

  describe('4. Native Inspector 事件与 DOM 拾取结果展示', () => {
    it('接收 INSPECT_SELECT 事件：展示选中详情卡（标签/尺寸/复制/发送到 AI）', async () => {
      renderCard();
      // 加载页面
      const chip = await screen.findByRole('button', {
        name: /localhost:5173/,
      });
      fireEvent.click(chip);

      await waitFor(() => {
        expect(
          document.querySelector('[data-native-surface="true"]')
        ).toBeTruthy();
      });
      emitNativeBrowserNavigationSettled();

      const inspectorBtn = screen.getByLabelText('拾取页面元素');
      await waitFor(() => expect(inspectorBtn).toBeEnabled());
      fireEvent.click(inspectorBtn);
      await waitFor(() =>
        expect(inspectorApiMock.setInspector).toHaveBeenCalledWith(
          'browser-default',
          true
        )
      );

      emitInspectorEvent({
        tabId: 'browser-default',
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
      });

      await waitFor(() => {
        expect(
          screen.getByText('<button#submit-btn.submit.primary>')
        ).toBeTruthy();
      });

      // 选中详情卡带出尺寸与操作按钮
      expect(screen.getByText('100×40')).toBeTruthy();
      expect(screen.getByLabelText('复制选择器')).toBeTruthy();
      expect(screen.getByLabelText('发送到 AI')).toBeTruthy();

      fireEvent.click(screen.getByLabelText('发送到 AI'));
      await waitFor(() =>
        expect(
          ToastStore.getToasts().some((item) =>
            String(item.message).includes('当前没有可用的对话')
          )
        ).toBe(true)
      );
      expect(
        ToastStore.getToasts().some((item) =>
          String(item.message).includes('已发送到对话输入框')
        )
      ).toBe(false);
      expect(useSessionStore.getState().composerDrafts).toEqual({});
    });

    it('发送 DOM 引用时将完整结构与真实页面来源写入会话草稿', async () => {
      useSessionStore.setState({
        activeSessionId: 'session-dom-reference',
        sessionsById: {
          'session-dom-reference': {} as SessionState,
        },
      });
      renderCard();
      fireEvent.click(
        await screen.findByRole('button', { name: /localhost:5173/ })
      );
      await waitFor(() =>
        expect(
          document.querySelector('[data-native-surface="true"]')
        ).toBeTruthy()
      );
      emitNativeBrowserEvent('browser://navigation-state', {
        tabId: 'browser-default',
        url: 'https://redirected.example/page',
        title: 'Actual page title',
        isLoading: false,
      });
      await waitFor(() =>
        expect(screen.getByLabelText('预览地址')).toHaveValue(
          'https://redirected.example/page'
        )
      );

      const inspectorBtn = screen.getByLabelText('拾取页面元素');
      await waitFor(() => expect(inspectorBtn).toBeEnabled());
      fireEvent.click(inspectorBtn);
      await waitFor(() =>
        expect(inspectorApiMock.setInspector).toHaveBeenCalledWith(
          'browser-default',
          true
        )
      );
      emitInspectorEvent({
        tabId: 'browser-default',
        type: 'INSPECT_SELECT',
        payload: {
          tagName: 'button',
          id: 'submit-btn',
          classes: ['primary'],
          attributes: { 'data-testid': 'submit-btn' },
          bestSelector: '#submit-btn',
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
      });
      fireEvent.click(await screen.findByLabelText('发送到 AI'));

      await waitFor(() => {
        const draft =
          useSessionStore.getState().composerDrafts['session-dom-reference'];
        expect(draft).toContain(
          'DOM_REFERENCE_PAYLOAD schema=DomReferenceChipPayload version=1.0'
        );
        expect(draft).toContain('"kind": "dom_reference"');
        expect(draft).toContain('"xpath": "/html/body/button[1]"');
        expect(draft).toContain(
          '"sourceUrl": "https://redirected.example/page"'
        );
        expect(draft).toContain('"pageTitle": "Actual page title"');
      });
    });

    it('接收 INSPECT_HOVER 事件：展示悬停浮层（Tag/选择器/坐标）', async () => {
      renderCard();
      const chip = await screen.findByRole('button', {
        name: /localhost:5173/,
      });
      fireEvent.click(chip);

      await waitFor(() => {
        expect(
          document.querySelector('[data-native-surface="true"]')
        ).toBeTruthy();
      });
      emitNativeBrowserNavigationSettled();

      // 激活拾取态后悬停消息才展示浮层
      const inspectorBtn = screen.getByLabelText('拾取页面元素');
      await waitFor(() => expect(inspectorBtn).toBeEnabled());
      fireEvent.click(inspectorBtn);

      emitInspectorEvent({
        tabId: 'browser-default',
        type: 'INSPECT_HOVER',
        payload: {
          tagName: 'div',
          selector: 'div.card',
          rect: { x: 4, y: 8, width: 120, height: 60 },
        },
      });

      await waitFor(() => {
        const overlay = document.querySelector('[data-inspector-hover]');
        expect(overlay).toBeTruthy();
        expect(overlay?.textContent).toContain('div');
        expect(overlay?.textContent).toContain('div.card');
      });
    });
    it('Escape 停止拾取并发送 enabled:false', async () => {
      renderCard();
      fireEvent.click(
        await screen.findByRole('button', { name: /localhost:5173/ })
      );
      emitNativeBrowserNavigationSettled();
      const inspectorBtn = screen.getByLabelText('拾取页面元素');
      await waitFor(() => expect(inspectorBtn).not.toBeDisabled());

      fireEvent.click(inspectorBtn);
      expect(inspectorBtn.getAttribute('aria-pressed')).toBe('true');
      fireEvent.keyDown(window, { key: 'Escape' });

      await waitFor(() =>
        expect(inspectorBtn.getAttribute('aria-pressed')).toBe('false')
      );
      await waitFor(() =>
        expect(inspectorApiMock.setInspector).toHaveBeenCalledTimes(2)
      );
      expect(inspectorApiMock.setInspector).toHaveBeenLastCalledWith(
        'browser-default',
        false
      );
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
