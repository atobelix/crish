// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  within,
} from '@testing-library/react';
import { McpDetailWorkbench } from './McpDetailWorkbench';
import { ToastProvider } from '../../services/toast/ToastContext';
import { ToastStore } from '../../services/toast/ToastStore';
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
    // ToastStore 是模块级单例：不清空则上一用例（或重试）的 toast 会带进下一用例
    ToastStore.clear();
  });

  it('renders tools list, initial enabled count and independent switches', () => {
    render(
      <ToastProvider>
        <McpDetailWorkbench server={mockServer} />
      </ToastProvider>
    );

    expect(screen.getByText('chrome-devtools-mcp')).toBeInTheDocument();
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

  it('displays empty state when tools array is empty and renders dynamically when real tools are reflected', () => {
    const emptyServer: McpServerInfo = {
      id: 'fs-1',
      name: 'filesystem',
      state: 'ready',
      status: 'connected',
      tools: [],
    };

    const { unmount } = render(
      <ToastProvider>
        <McpDetailWorkbench server={emptyServer} />
      </ToastProvider>
    );

    expect(screen.getByText('暂未发现导出的工具')).toBeInTheDocument();
    unmount();

    // 未连接状态展示“未连接，启动后动态反射”
    const unconnServer: McpServerInfo = {
      id: 'fs-unconn',
      name: 'filesystem',
      state: 'stopped',
      status: 'disconnected',
      tools: [],
    };

    const { unmount: unmountUnconn } = render(
      <ToastProvider>
        <McpDetailWorkbench server={unconnServer} />
      </ToastProvider>
    );

    expect(screen.getByText('未连接，启动后动态反射')).toBeInTheDocument();
    unmountUnconn();

    // 动态反射真实工具与 Schema
    const reflectedServer: McpServerInfo = {
      id: 'fs-real',
      name: 'filesystem',
      state: 'ready',
      status: 'connected',
      tools: ['read_file', 'write_file'],
      toolDefs: [
        {
          name: 'read_file',
          description: '读取本地文件内容',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '文件相对或绝对路径' },
            },
            required: ['path'],
          },
        },
      ],
    };

    render(
      <ToastProvider>
        <McpDetailWorkbench server={reflectedServer} />
      </ToastProvider>
    );

    expect(screen.getByText('read_file')).toBeInTheDocument();
    expect(screen.getByText('write_file')).toBeInTheDocument();
    expect(screen.getByText('读取本地文件内容')).toBeInTheDocument();
    expect(screen.getByText('path')).toBeInTheDocument();
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

    // 成功后同时出现两处延迟文案：头部延迟徽标「Nms」与 toast「…（Nms）」。
    // 两者分别经 ToastStore 外部订阅与组件 state 提交，旧断言 getByText(/\d+ms/)
    // 只有在恰好仅一处已渲染时才唯一命中（实测稳定后恒为 2 处），
    // 负载下两者同时可见即报 multiple elements。这里分别精确断言两处并核对数值一致。
    const badge = await screen.findByText(/^\d+ms$/);
    const latency = Number(badge.textContent!.replace('ms', ''));
    expect(latency).toBeGreaterThanOrEqual(1);
    const toastRegion = await screen.findByRole('region', { name: '通知中心' });
    expect(
      within(toastRegion).getByText(
        `连通性测试成功：服务响应正常（${latency}ms）`
      )
    ).toBeInTheDocument();
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

  it('handles external MCP server with lastError in empty states gracefully', () => {
    const errorServer: McpServerInfo = {
      id: 'failed-mcp',
      name: 'failed-mcp-service',
      state: 'error',
      status: 'disconnected',
      tools: [],
      lastError: 'Spawn error: process exited with code 1',
    };

    render(
      <ToastProvider>
        <McpDetailWorkbench server={errorServer} />
      </ToastProvider>
    );

    expect(
      screen.getByText('Spawn error: process exited with code 1')
    ).toBeInTheDocument();
  });

  it('gracefully renders malformed or extreme toolDefs and schema without crashing', () => {
    const extremeServer: McpServerInfo = {
      id: 'extreme-mcp',
      name: 'extreme-mcp-service',
      state: 'ready',
      status: 'connected',
      tools: ['extreme_tool', 'malformed_tool'],
      toolDefs: [
        null as any,
        { name: undefined as any },
        {
          name: 'extreme_tool',
          description: 'A tool with massive parameter schema',
          inputSchema: {
            type: 'object',
            properties: {
              param_ultra_long_name_abcdefghijklmnopqrstuvwxyz_123456789: {
                type: 'string',
                description:
                  'Super long parameter description testing boundary wrapping behavior',
              },
              null_prop: null as any,
            },
            required: [
              'param_ultra_long_name_abcdefghijklmnopqrstuvwxyz_123456789',
            ],
          },
        },
        {
          name: 'malformed_tool',
          description: 'A tool with malformed array properties',
          inputSchema: {
            type: 'object',
            properties: ['invalid_array_format'] as any,
          },
        },
      ],
    };

    render(
      <ToastProvider>
        <McpDetailWorkbench server={extremeServer} />
      </ToastProvider>
    );

    expect(screen.getByText('extreme_tool')).toBeInTheDocument();
    expect(screen.getByText('malformed_tool')).toBeInTheDocument();
    expect(
      screen.getByText(
        'param_ultra_long_name_abcdefghijklmnopqrstuvwxyz_123456789'
      )
    ).toBeInTheDocument();
  });
});
