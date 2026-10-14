// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from '@testing-library/react';
import { McpDetailWorkbench } from './McpDetailWorkbench';
import { ToastProvider } from '../../services/toast/ToastContext';
import { useSettingsStore } from '../../store/settingsStore';
import { clientApi } from '../../api/clientApi';
import type { McpServerInfo } from '../../api/mcpApi';

describe('McpDetailWorkbench - Tool Granularity Control', () => {
  const mockServer: McpServerInfo = {
    id: 'test-chrome-devtools',
    name: 'chrome-devtools-mcp',
    state: 'ready',
    status: 'connected',
    tools: ['navigate_page', 'click', 'take_screenshot'],
    transport: 'stdio',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.getState().setMcpServers([
      {
        id: 'test-chrome-devtools',
        name: 'chrome-devtools-mcp',
        type: 'stdio',
        status: 'connected',
        tools: ['navigate_page', 'click', 'take_screenshot'],
        disabledTools: [],
      },
    ]);
    vi.spyOn(clientApi, 'saveSettingsEx').mockResolvedValue({} as any);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders tools list, initial enabled count and independent switches', () => {
    render(
      <ToastProvider>
        <McpDetailWorkbench server={mockServer} />
      </ToastProvider>
    );

    expect(screen.getByText('chrome-devtools-mcp')).toBeInTheDocument();
    expect(screen.getByText('可用工具清单 (3)')).toBeInTheDocument();
    expect(
      screen.getByText('已允许 Agent 调用: 3 / 3 个工具')
    ).toBeInTheDocument();

    expect(screen.getByText('navigate_page')).toBeInTheDocument();
    expect(screen.getByText('click')).toBeInTheDocument();
    expect(screen.getByText('take_screenshot')).toBeInTheDocument();

    const switchBtn = screen.getByRole('switch', { name: '切换工具 click' });
    expect(switchBtn).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('已连接')).toBeInTheDocument();

    expect(screen.getByRole('button', { name: '全部允许' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '全部禁止' })).not.toBeDisabled();
  });

  it('toggles a single tool to disabled, updates store and calls saveSettingsEx', async () => {
    render(
      <ToastProvider>
        <McpDetailWorkbench server={mockServer} />
      </ToastProvider>
    );

    const switchBtn = screen.getByRole('switch', { name: '切换工具 click' });
    expect(switchBtn).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(switchBtn);

    await waitFor(() => {
      expect(switchBtn).toHaveAttribute('aria-checked', 'false');
      expect(
        screen.getByText('已允许 Agent 调用: 2 / 3 个工具')
      ).toBeInTheDocument();
    });

    const currentServers = useSettingsStore.getState().mcpServers || [];
    const server = currentServers.find((s) => s.name === 'chrome-devtools-mcp');
    expect(server?.disabledTools).toEqual(['click']);

    expect(clientApi.saveSettingsEx).toHaveBeenCalledWith(
      '__global__',
      'global',
      expect.objectContaining({
        mcpServers: expect.any(Array),
      })
    );
  });

  it('toggles a disabled tool back to enabled', async () => {
    useSettingsStore.getState().setMcpServers([
      {
        id: 'test-chrome-devtools',
        name: 'chrome-devtools-mcp',
        type: 'stdio',
        status: 'connected',
        tools: ['navigate_page', 'click', 'take_screenshot'],
        disabledTools: ['click'],
      },
    ]);

    render(
      <ToastProvider>
        <McpDetailWorkbench server={mockServer} />
      </ToastProvider>
    );

    expect(
      screen.getByText('已允许 Agent 调用: 2 / 3 个工具')
    ).toBeInTheDocument();

    const switchBtn = screen.getByRole('switch', { name: '切换工具 click' });
    expect(switchBtn).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(switchBtn);

    await waitFor(() => {
      expect(
        screen.getByText('已允许 Agent 调用: 3 / 3 个工具')
      ).toBeInTheDocument();
    });

    const currentServers = useSettingsStore.getState().mcpServers || [];
    const server = currentServers.find((s) => s.name === 'chrome-devtools-mcp');
    expect(server?.disabledTools).toEqual([]);

    expect(clientApi.saveSettingsEx).toHaveBeenCalled();
  });

  it('disables all tools when clicking 全部禁止 button', async () => {
    render(
      <ToastProvider>
        <McpDetailWorkbench server={mockServer} />
      </ToastProvider>
    );

    const disableAllBtn = screen.getByRole('button', { name: '全部禁止' });
    fireEvent.click(disableAllBtn);

    await waitFor(() => {
      expect(
        screen.getByText('已允许 Agent 调用: 0 / 3 个工具')
      ).toBeInTheDocument();
      const clickSwitch = screen.getByRole('switch', {
        name: '切换工具 click',
      });
      expect(clickSwitch).toHaveAttribute('aria-checked', 'false');
    });

    const currentServers = useSettingsStore.getState().mcpServers || [];
    const server = currentServers.find((s) => s.name === 'chrome-devtools-mcp');
    expect(server?.disabledTools).toEqual([
      'navigate_page',
      'click',
      'take_screenshot',
    ]);

    expect(screen.getByRole('button', { name: '全部禁止' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '全部允许' })).not.toBeDisabled();
  });

  it('enables all tools when clicking 全部允许 button', async () => {
    useSettingsStore.getState().setMcpServers([
      {
        id: 'test-chrome-devtools',
        name: 'chrome-devtools-mcp',
        type: 'stdio',
        status: 'connected',
        tools: ['navigate_page', 'click', 'take_screenshot'],
        disabledTools: ['navigate_page', 'click', 'take_screenshot'],
      },
    ]);

    render(
      <ToastProvider>
        <McpDetailWorkbench server={mockServer} />
      </ToastProvider>
    );

    expect(
      screen.getByText('已允许 Agent 调用: 0 / 3 个工具')
    ).toBeInTheDocument();

    const enableAllBtn = screen.getByRole('button', { name: '全部允许' });
    fireEvent.click(enableAllBtn);

    await waitFor(() => {
      expect(
        screen.getByText('已允许 Agent 调用: 3 / 3 个工具')
      ).toBeInTheDocument();
      const clickSwitch = screen.getByRole('switch', {
        name: '切换工具 click',
      });
      expect(clickSwitch).toHaveAttribute('aria-checked', 'true');
    });

    const currentServers = useSettingsStore.getState().mcpServers || [];
    const server = currentServers.find((s) => s.name === 'chrome-devtools-mcp');
    expect(server?.disabledTools).toEqual([]);
  });

  it('injects and resolves preset tools for filesystem, fetch, sqlite, git, and node_repl when tools array is empty', () => {
    const presetServers: McpServerInfo[] = [
      {
        id: 'fs-1',
        name: 'filesystem',
        state: 'ready',
        status: 'connected',
        tools: [],
      },
      {
        id: 'fetch-1',
        name: 'fetch',
        state: 'ready',
        status: 'connected',
        tools: [],
      },
      {
        id: 'sqlite-1',
        name: 'sqlite',
        state: 'ready',
        status: 'connected',
        tools: [],
      },
      {
        id: 'git-1',
        name: 'git',
        state: 'ready',
        status: 'connected',
        tools: [],
      },
      {
        id: 'repl-1',
        name: 'node_repl',
        state: 'ready',
        status: 'connected',
        tools: [],
      },
    ];

    for (const ps of presetServers) {
      const { unmount } = render(
        <ToastProvider>
          <McpDetailWorkbench server={ps} />
        </ToastProvider>
      );

      if (ps.name === 'filesystem') {
        expect(screen.getByText('read_file')).toBeInTheDocument();
        expect(screen.getByText('write_file')).toBeInTheDocument();
      } else if (ps.name === 'fetch') {
        expect(screen.getByText('fetch_url')).toBeInTheDocument();
      } else if (ps.name === 'sqlite') {
        expect(screen.getByText('read_query')).toBeInTheDocument();
      } else if (ps.name === 'git') {
        expect(screen.getByText('git_status')).toBeInTheDocument();
      } else if (ps.name === 'node_repl') {
        expect(screen.getByText('eval_js')).toBeInTheDocument();
      }
      unmount();
    }
  });

  it('executes connectivity test when online and shows success badge with latency', async () => {
    render(
      <ToastProvider>
        <McpDetailWorkbench server={mockServer} />
      </ToastProvider>
    );

    const testBtn = screen.getByRole('button', { name: /连通性测试/ });
    expect(testBtn).toBeInTheDocument();

    fireEvent.click(testBtn);

    await waitFor(() => {
      expect(screen.getByText(/\d+ms/)).toBeInTheDocument();
    });
  });

  it('handles connectivity test when offline by indicating server is not running', async () => {
    const offlineServer: McpServerInfo = {
      ...mockServer,
      status: 'disconnected',
    };
    useSettingsStore.getState().setMcpServers([
      {
        id: 'test-chrome-devtools',
        name: 'chrome-devtools-mcp',
        type: 'stdio',
        status: 'disconnected',
        tools: ['click'],
      },
    ]);

    render(
      <ToastProvider>
        <McpDetailWorkbench server={offlineServer} />
      </ToastProvider>
    );

    const testBtn = screen.getByRole('button', { name: /连通性测试/ });
    fireEvent.click(testBtn);

    await waitFor(() => {
      expect(screen.getByText('服务未启用')).toBeInTheDocument();
    });
  });

  it('filters tools list dynamically via search input and shows empty search state', () => {
    render(
      <ToastProvider>
        <McpDetailWorkbench server={mockServer} />
      </ToastProvider>
    );

    expect(screen.getByText('click')).toBeInTheDocument();
    expect(screen.getByText('navigate_page')).toBeInTheDocument();

    const searchInput = screen.getByPlaceholderText('搜索工具名称或描述...');
    fireEvent.change(searchInput, { target: { value: 'click' } });

    expect(screen.getByText('click')).toBeInTheDocument();
    expect(screen.queryByText('navigate_page')).not.toBeInTheDocument();

    fireEvent.change(searchInput, {
      target: { value: 'non_existent_tool_xyz' },
    });
    expect(
      screen.getByText(/未找到匹配「non_existent_tool_xyz」的工具/)
    ).toBeInTheDocument();

    const clearBtn = screen.getByRole('button', { name: '清空搜索' });
    fireEvent.click(clearBtn);

    expect(screen.getByText('click')).toBeInTheDocument();
    expect(screen.getByText('navigate_page')).toBeInTheDocument();
  });

  it('toggles server running status directly in settingsStore and saves via clientApi.saveSettingsEx', async () => {
    render(
      <ToastProvider>
        <McpDetailWorkbench server={mockServer} />
      </ToastProvider>
    );

    const serverSwitch = screen.getByRole('switch', {
      name: `切换服务状态 ${mockServer.id}`,
    });
    expect(serverSwitch).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(serverSwitch);

    await waitFor(() => {
      const servers = useSettingsStore.getState().mcpServers || [];
      const s = servers.find((item) => item.name === 'chrome-devtools-mcp');
      expect(s?.status).toBe('disconnected');
    });

    expect(clientApi.saveSettingsEx).toHaveBeenCalledWith(
      '__global__',
      'global',
      expect.objectContaining({
        mcpServers: expect.any(Array),
      })
    );
  });
});
