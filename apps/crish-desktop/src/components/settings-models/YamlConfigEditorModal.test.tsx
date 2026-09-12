// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { YamlConfigEditorModal } from './YamlConfigEditorModal';

vi.mock('../../api/tauriInvoke', () => ({
  invokeTyped: vi.fn(),
}));

vi.mock('../../api/modelsCatalogStore', () => ({
  ensureModelsCatalogLoaded: vi.fn().mockResolvedValue(undefined),
  getModelsCatalogPath: vi.fn().mockReturnValue('/mock/path/models.yaml'),
}));

vi.mock('../../api/codeHighlight', () => ({
  highlightCode: vi.fn().mockImplementation((code: string) => code),
}));

import { invokeTyped } from '../../api/tauriInvoke';

describe('YamlConfigEditorModal (模型 YAML 编辑器弹窗)', () => {
  const mockInvoke = vi.mocked(invokeTyped);

  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'workbench_read_models_yaml') {
        return {
          status: 'ok',
          data: {
            path: '/mock/path/models.yaml',
            content: 'version: 1\nproviders: []\n',
            template: 'version: 1\n# default template\nproviders: []\n',
            seeded: false,
            parseError: null,
          },
        };
      }
      if (cmd === 'workbench_validate_models_yaml') {
        return {
          status: 'ok',
          data: {
            valid: true,
          },
        };
      }
      return { status: 'ok', data: {} };
    });
  });

  it('正确渲染弹窗标题、动态状态指示及功能工具栏', async () => {
    render(<YamlConfigEditorModal open={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('模型能力与参数配置')).toBeTruthy();
    });

    // 状态指示位于标题旁边且为纯实点动态状态（无文本陈列，通过 aria-label 与 Tooltip 呈现）
    expect(screen.getByRole('status', { name: '已与磁盘同步' })).toBeTruthy();

    // 标题下方功能行：搜索框与工具按钮
    expect(screen.getByPlaceholderText('在配置中查找 (Ctrl+F)...')).toBeTruthy();
    expect(screen.getByRole('button', { name: /显示代码行数/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /开启自动换行/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /复制全部内容/ })).toBeTruthy();
  });

  it('底栏包含撤回、刷新与恢复内置模板按钮', async () => {
    render(<YamlConfigEditorModal open={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /撤回/ })).toBeTruthy();
    });

    const undoBtn = screen.getByRole('button', { name: /撤回/ });
    const refreshBtn = screen.getByRole('button', { name: /刷新/ });
    const resetBtn = screen.getByRole('button', { name: /恢复内置模板/ });

    expect(undoBtn).toBeTruthy();
    expect(refreshBtn).toBeTruthy();
    expect(resetBtn).toBeTruthy();

    // 初始状态下内容未修改，撤回按钮应当 disabled
    expect(undoBtn.hasAttribute('disabled')).toBe(true);
    // 标题旁边指示已与磁盘同步
    expect(screen.getByRole('status', { name: '已与磁盘同步' })).toBeTruthy();
  });

  it('编辑内容后撤回按钮可用，点击可撤回修改', async () => {
    render(<YamlConfigEditorModal open={true} onClose={vi.fn()} />);

    const textarea = await waitFor(() => {
      const el = screen.getByPlaceholderText('请输入 models.yaml 配置内容...');
      expect((el as HTMLTextAreaElement).value).toBe('version: 1\nproviders: []\n');
      return el as HTMLTextAreaElement;
    });

    fireEvent.change(textarea, { target: { value: 'version: 2\ncustom: true\n' } });

    // 修改后撤回按钮亮起
    const undoBtn = screen.getByRole('button', { name: /撤回/ });
    expect(undoBtn.hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('status', { name: '有未保存修改' })).toBeTruthy();

    // 点击撤回
    fireEvent.click(undoBtn);
    expect(textarea.value).toBe('version: 1\nproviders: []\n');
    expect(screen.getByRole('status', { name: '已与磁盘同步' })).toBeTruthy();
    expect(undoBtn.hasAttribute('disabled')).toBe(true);
  });

  it('恢复内置模板具备二次确认保护', async () => {
    render(<YamlConfigEditorModal open={true} onClose={vi.fn()} />);

    const textarea = await waitFor(() => {
      const el = screen.getByPlaceholderText('请输入 models.yaml 配置内容...');
      expect((el as HTMLTextAreaElement).value).toBe('version: 1\nproviders: []\n');
      return el as HTMLTextAreaElement;
    });

    const resetBtn = screen.getByRole('button', { name: /恢复内置模板/ });
    // 当前内容与 template 不一致，重置按钮可用
    expect(resetBtn.hasAttribute('disabled')).toBe(false);

    // 点击后弹出二次确认对话框
    fireEvent.click(resetBtn);
    expect(screen.getByText('恢复内置默认模板？')).toBeTruthy();
    expect(screen.getByText(/覆盖当前编辑器内容/)).toBeTruthy();

    const confirmDialog = screen.getByRole('alertdialog', { name: '恢复内置默认模板？' });

    // 取消重置
    const cancelBtn = within(confirmDialog).getByRole('button', { name: '取消' });
    fireEvent.click(cancelBtn);
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog', { name: '恢复内置默认模板？' })).toBeNull();
    });

    // 再次点击并确认重置
    fireEvent.click(resetBtn);
    const nextConfirmDialog = screen.getByRole('alertdialog', { name: '恢复内置默认模板？' });
    const confirmBtn = within(nextConfirmDialog).getByRole('button', { name: '确认恢复模板' });
    fireEvent.click(confirmBtn);

    // 内容更新为 template 内容
    expect(textarea.value).toBe('version: 1\n# default template\nproviders: []\n');
  });

  it('点击刷新重新读取磁盘 models.yaml 内容', async () => {
    render(<YamlConfigEditorModal open={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /刷新/ })).toBeTruthy();
    });

    const refreshBtn = screen.getByRole('button', { name: /刷新/ });
    await act(async () => {
      fireEvent.click(refreshBtn);
    });

    expect(mockInvoke).toHaveBeenCalledWith('workbench_read_models_yaml', {});
  });

  it('未保存修改时退出弹出防丢确认', async () => {
    const onClose = vi.fn();
    render(<YamlConfigEditorModal open={true} onClose={onClose} />);

    const textarea = await waitFor(() => {
      const el = screen.getByPlaceholderText('请输入 models.yaml 配置内容...');
      expect((el as HTMLTextAreaElement).value).toBe('version: 1\nproviders: []\n');
      return el as HTMLTextAreaElement;
    });

    fireEvent.change(textarea, { target: { value: 'version: 9\n' } });

    // 点击取消/关闭
    const closeBtn = screen.getByRole('button', { name: '取消' });
    fireEvent.click(closeBtn);

    expect(screen.getByText('放弃未保存的修改？')).toBeTruthy();
    const abandonBtn = screen.getByRole('button', { name: '放弃修改并退出' });
    fireEvent.click(abandonBtn);

    expect(onClose).toHaveBeenCalled();
  });

  it('行号开关控制行号显示，搜索框支持关键词查找', async () => {
    render(<YamlConfigEditorModal open={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /显示代码行数/ })).toBeTruthy();
    });

    const toggleLineBtn = screen.getByRole('button', { name: /显示代码行数/ });
    // 默认不开启行号
    expect(screen.queryByText('1', { selector: '._gutterLine_f230ef' })).toBeNull();

    // 点击开启行号
    fireEvent.click(toggleLineBtn);
    expect(screen.getByRole('button', { name: /隐藏代码行数/ })).toBeTruthy();

    // 搜索框输入与导航
    const searchInput = screen.getByPlaceholderText('在配置中查找 (Ctrl+F)...');
    fireEvent.change(searchInput, { target: { value: 'providers' } });

    // 存在匹配结果
    expect(screen.getByText(/1 \/ 1/)).toBeTruthy();
  });
});
