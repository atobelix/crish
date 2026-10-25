// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { ChatCard } from '../ChatCard';
import * as scanModule from '../../../api/import/scan';
import * as pluginRegistry from '../../settings-extensions/pluginRegistryAdapter';
import { slotCore } from '../../../services/view-registry/SlotCore';
import { useSessionStore } from '../../../store/sessionStore';
import { useLayoutStore } from '../../../store/layoutStore';

// 1. Mock IPC listener
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

// 2. Mock plugin registry adapter to toggle plugin enabled / disabled
vi.mock('../../settings-extensions/pluginRegistryAdapter', () => ({
  isPluginEnabled: vi.fn(),
  setPluginEnabled: vi.fn(),
}));

// 3. Mock scan module to verify zero I/O
vi.mock('../../../api/import/scan', () => ({
  scanClaudeCodeSessions: vi.fn().mockResolvedValue([]),
  scanCodexSessions: vi.fn().mockResolvedValue([]),
}));

// 4. Mock store access and profiles
vi.mock('../../../api/storeAccess', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../api/storeAccess')>();
  return {
    ...actual,
    openSettings: vi.fn(),
    patchSession: vi.fn(),
  };
});

vi.mock('../../../api/providerProfiles', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../api/providerProfiles')>();
  return {
    ...actual,
    anyProfileHasKey: () => true,
    getProviderSetupStatus: () => ({
      isSetup: true,
      needsKey: false,
      needsModel: false,
    }),
  };
});

vi.mock('../../../services/toast/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('../../../api/modelVisionSupport', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../api/modelVisionSupport')>();
  return {
    ...actual,
    activeModelAcceptsImage: () => true,
  };
});

vi.mock('../../../api/ptyRegistry', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../api/ptyRegistry')>();
  return {
    ...actual,
    ensurePtyForSession: vi.fn(async () => 'pty-mock'),
    killPtyForSession: vi.fn(async () => undefined),
    killPtyForSessionBackground: vi.fn(),
    killAllPtys: vi.fn(async () => undefined),
  };
});

function normalizeDynamicIds(html: string): string {
  return html
    .replace(/:r[0-9a-zA-Z_]+:/g, ':id:')
    .replace(/_r_[0-9a-zA-Z_]+_/g, '_r_id_');
}

describe('ChatCard Pluggable Lifecycle & Architectural Decoupling Suite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useLayoutStore.setState({ chatMainSurface: 'chat' });
    useSessionStore.setState({
      sessions: [],
      sessionsById: {},
      activeSessionId: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Case 1: 插件启停生命周期零 DOM 异化，且 workspace.chat.composerAbove 扩展插槽平滑挂载不破坏输入框', () => {
    // 1. 模拟插件处于停用状态 (Disabled)
    vi.mocked(pluginRegistry.isPluginEnabled).mockReturnValue(false);
    const { container, rerender, unmount } = render(
      <ChatCard handleGlobalTabClick={vi.fn()} sessionId={null} />
    );
    const disabledDom = normalizeDynamicIds(container.innerHTML);

    // 2. 模拟插件处于启用状态 (Enabled)
    vi.mocked(pluginRegistry.isPluginEnabled).mockReturnValue(true);
    rerender(<ChatCard handleGlobalTabClick={vi.fn()} sessionId={null} />);
    const enabledDom = normalizeDynamicIds(container.innerHTML);

    // 刚性断言：核心视口结构保持 100% 同构，无任何直接 DOM 侵入
    expect(enabledDom).toBe(disabledDom);

    // 3. 动态通过 slotCore 挂载解耦的 ambient 建议条
    expect(screen.queryByTestId('external-import-ambient-bar')).toBeNull();
    let unregisterSlot: (() => void) | undefined;
    act(() => {
      unregisterSlot = slotCore.registerSingle('workspace.chat.composerAbove', {
        id: 'ambient-import-suggestion',
        priority: 10,
        component: () => (
          <div data-testid="external-import-ambient-bar">
            <span>检测到外部会话</span>
            <button type="button">导入并继续</button>
            <button type="button">跳过</button>
          </div>
        ),
      });
    });

    rerender(<ChatCard handleGlobalTabClick={vi.fn()} sessionId={null} />);
    expect(
      screen.getByTestId('external-import-ambient-bar')
    ).toBeInTheDocument();

    // 底部输入框依然完好且无幽灵按钮
    const composerAfter = container.querySelector(
      '[data-composer-grid="text"]'
    );
    expect(composerAfter).toBeInTheDocument();
    expect(
      composerAfter?.querySelector(
        '[data-testid="external-session-import-btn"]'
      )
    ).toBeNull();

    // 注销插槽节点
    act(() => {
      unregisterSlot?.();
    });

    rerender(<ChatCard handleGlobalTabClick={vi.fn()} sessionId={null} />);
    expect(screen.queryByTestId('external-import-ambient-bar')).toBeNull();
    unmount();
  });

  it('Case 2: 零扫描开销断言：在 ChatCard 挂载、渲染和空态交互期间，绝不触发全盘文件系统扫描函数', async () => {
    const claudeScanSpy = vi.spyOn(scanModule, 'scanClaudeCodeSessions');
    const codexScanSpy = vi.spyOn(scanModule, 'scanCodexSessions');

    vi.mocked(pluginRegistry.isPluginEnabled).mockReturnValue(true);

    const { container } = render(
      <ChatCard handleGlobalTabClick={vi.fn()} sessionId={null} />
    );

    // 交互：点击输入框区域
    const fieldSlot = container.querySelector('[data-composer-grid="text"]');
    if (fieldSlot) {
      fireEvent.click(fieldSlot);
    }

    // 推进微任务与计时器
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });

    // 刚性断言：零扫描 I/O 开销
    expect(claudeScanSpy).not.toHaveBeenCalled();
    expect(codexScanSpy).not.toHaveBeenCalled();
  });

  it('Case 3: 空态单一真理源断言：data-empty-kind 与 data-empty 恒定受控于 state.emptyKind，绝不被篡改', () => {
    // 1. 草稿空态阶段
    const { container, rerender } = render(
      <ChatCard
        handleGlobalTabClick={vi.fn()}
        sessionId="__pending_draft__:test"
      />
    );

    const chatBody = container.querySelector('[data-testid="chat-body"]');
    const chatDocFlow = container.querySelector(
      '[data-testid="chat-doc-flow"]'
    );

    expect(chatBody?.getAttribute('data-empty-kind')).toBe('session-empty');
    expect(chatDocFlow?.getAttribute('data-empty')).toBe('true');

    // 2. 切换到有真实消息的活跃会话
    useSessionStore.setState({
      sessions: [
        {
          id: 'sess-active-1',
          title: '活跃会话',
          folder: '默认',
          isPinned: false,
          isArchived: false,
          timestamp: 't1',
          messages: [
            { id: 'm1', sender: 'user', timestamp: 100, text: '你好' },
            {
              id: 'm2',
              sender: 'assistant',
              timestamp: 200,
              text: '很高兴为你服务',
            },
          ],
          agents: [],
        } as any,
      ],
      sessionsById: {
        'sess-active-1': {
          id: 'sess-active-1',
          title: '活跃会话',
          folder: '默认',
          isPinned: false,
          isArchived: false,
          timestamp: 't1',
          messages: [
            { id: 'm1', sender: 'user', timestamp: 100, text: '你好' },
            {
              id: 'm2',
              sender: 'assistant',
              timestamp: 200,
              text: '很高兴为你服务',
            },
          ],
          agents: [],
        } as any,
      },
      activeSessionId: 'sess-active-1',
    });

    rerender(
      <ChatCard handleGlobalTabClick={vi.fn()} sessionId="sess-active-1" />
    );

    // 有消息状态下：空态属性完全清除，单一真理源纯洁生效
    expect(chatBody?.getAttribute('data-empty-kind')).toBeNull();
    expect(chatDocFlow?.getAttribute('data-empty')).toBeNull();
  });

  it('Case 4: 原生输入框不可退化断言：ChatComposer 恒定挂载原生输入槽，无幽灵导入按钮', () => {
    const { container } = render(
      <ChatCard handleGlobalTabClick={vi.fn()} sessionId={null} />
    );

    // 幽灵导入按钮与文案绝不存在
    expect(
      container.querySelector('[data-testid="external-session-import-btn"]')
    ).toBeNull();
    expect(container.querySelector('.externalSessionImportBtn')).toBeNull();
    expect(screen.queryByText(/点击以导入对话并继续输入/)).toBeNull();
    expect(screen.queryByText(/正在导入对话并接续/)).toBeNull();

    // 原生输入框槽位恒定挂载
    const fieldSlot = container.querySelector('[data-composer-grid="text"]');
    expect(fieldSlot).not.toBeNull();

    const inputElement =
      container.querySelector('[contenteditable="true"]') ||
      container.querySelector('textarea') ||
      screen.getByRole('textbox');
    expect(inputElement).toBeInTheDocument();
    expect(inputElement).not.toHaveAttribute('disabled');
  });
});
