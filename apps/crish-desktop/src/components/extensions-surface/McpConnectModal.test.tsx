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
import { McpConnectModal } from './McpConnectModal';
import { ToastProvider } from '../../services/toast/ToastContext';
import { useSettingsStore } from '../../store/settingsStore';
import * as detectApi from './detectExternalMcpServers';

describe('McpConnectModal', () => {
  const onClose = vi.fn();
  const onSuccess = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.getState().setMcpServers([]);
    vi.spyOn(detectApi, 'detectExternalMcpServers').mockResolvedValue([
      {
        id: 'ext-mcp-1',
        source: 'Antigravity',
        name: 'test-antigravity-mcp',
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
      },
    ]);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders and switches between three tabs (manual, syntax, quick)', async () => {
    render(
      <ToastProvider>
        <McpConnectModal open={true} onClose={onClose} onSuccess={onSuccess} />
      </ToastProvider>
    );

    // 默认展示 Tab 1：手动表单配置
    expect(screen.getByText('手动表单配置')).toBeInTheDocument();
    expect(screen.getByText('服务名称')).toBeInTheDocument();
    expect(screen.getByText('启动命令 (command)')).toBeInTheDocument();
    expect(screen.getByText('常用预设模板：')).toBeInTheDocument();

    // 切换至 Tab 2：词法 JSON 编写
    fireEvent.click(screen.getByText('词法 JSON 编写'));
    expect(
      screen.getByPlaceholderText('粘贴或编写 JSON 配置...')
    ).toBeInTheDocument();
    expect(screen.getByText(/支持标准 JSON、单服务配置/)).toBeInTheDocument();

    // 切换至 Tab 3：本机快速接入
    fireEvent.click(screen.getByText('本机快速接入'));
    await waitFor(() => {
      expect(screen.getByText('test-antigravity-mcp')).toBeInTheDocument();
    });
    expect(screen.getByText('Antigravity')).toBeInTheDocument();
  });

  it('saves correctly in manual form mode, calls onSuccess and writes to settingsStore', () => {
    render(
      <ToastProvider>
        <McpConnectModal open={true} onClose={onClose} onSuccess={onSuccess} />
      </ToastProvider>
    );

    // 填写服务名称与启动命令
    const nameInput = screen.getByPlaceholderText('如 sqlite / filesystem');
    const cmdInput = screen.getByPlaceholderText('如 npx, uvx, python');
    const argsInput = screen.getByPlaceholderText(
      '如 -y @modelcontextprotocol/server-filesystem'
    );

    fireEvent.change(nameInput, { target: { value: 'my-custom-tool' } });
    fireEvent.change(cmdInput, { target: { value: 'npx' } });
    fireEvent.change(argsInput, { target: { value: '-y my-mcp-pkg' } });

    // 点击保存并接入
    fireEvent.click(screen.getByRole('button', { name: '保存并接入' }));

    expect(onSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'my-custom-tool',
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'my-mcp-pkg'],
      })
    );
    expect(onClose).toHaveBeenCalled();

    const storedServers = useSettingsStore.getState().mcpServers;
    expect(storedServers.some((s) => s.name === 'my-custom-tool')).toBe(true);
  });

  it('validates syntax mode: shows error on invalid JSON and saves successfully on valid JSON', () => {
    render(
      <ToastProvider>
        <McpConnectModal open={true} onClose={onClose} onSuccess={onSuccess} />
      </ToastProvider>
    );

    // 切换至词法编写 Tab
    fireEvent.click(screen.getByText('词法 JSON 编写'));
    const textarea = screen.getByPlaceholderText('粘贴或编写 JSON 配置...');

    // 输入无效 JSON
    fireEvent.change(textarea, {
      target: { value: '{ "mcpServers": invalid }' },
    });
    expect(screen.getByText(/语法错误：/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '解析并接入' })).toBeDisabled();

    // 输入有效 JSON
    const validConfig = JSON.stringify({
      mcpServers: {
        'sqlite-service': {
          command: 'uvx',
          args: ['mcp-server-sqlite', '--db-path', './test.db'],
        },
      },
    });
    fireEvent.change(textarea, { target: { value: validConfig } });

    expect(screen.getByText(/JSON 语法校验通过/)).toBeInTheDocument();
    const saveBtn = screen.getByRole('button', { name: '解析并接入' });
    expect(saveBtn).toBeEnabled();

    // 保存并接入
    fireEvent.click(saveBtn);

    expect(onSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'sqlite-service',
        type: 'stdio',
        command: 'uvx',
        args: ['mcp-server-sqlite', '--db-path', './test.db'],
      })
    );
    expect(onClose).toHaveBeenCalled();
    const stored = useSettingsStore.getState().mcpServers;
    expect(stored.some((s) => s.name === 'sqlite-service')).toBe(true);
  });
});
