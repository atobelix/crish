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

    const enabledLabels = screen.getAllByText('允许 Agent 调用');
    expect(enabledLabels.length).toBe(3);

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
      expect(screen.getByText('已禁止 Agent 调用')).toBeInTheDocument();
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
      const disabledLabels = screen.getAllByText('已禁止 Agent 调用');
      expect(disabledLabels.length).toBe(3);
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
      const enabledLabels = screen.getAllByText('允许 Agent 调用');
      expect(enabledLabels.length).toBe(3);
    });

    const currentServers = useSettingsStore.getState().mcpServers || [];
    const server = currentServers.find((s) => s.name === 'chrome-devtools-mcp');
    expect(server?.disabledTools).toEqual([]);
  });
});
