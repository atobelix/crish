// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { FileViewerCard, FileViewerCardView } from './FileViewerCard';
import { ToastProvider } from '../../services/toast/ToastContext';
import * as workspaceFsApi from '../../api/workspaceFsApi';
import * as hostOpenersApi from '../../api/hostOpenersApi';
import * as gitApi from '../../api/gitApi';
import { useTerminalStore } from '../../store/terminalStore';

vi.mock('../diff/DiffCardUnifiedView', () => ({
  DiffCardUnifiedView: ({ f }: { f: any }) => (
    <div data-testid="diff-card-unified-view">
      Unified diff for {f.filePath}
    </div>
  ),
}));

vi.mock('../diff/VirtualPlainCodeViewer', () => ({
  VirtualPlainCodeViewer: ({
    content,
    filePath,
    wordWrap,
  }: {
    content: string;
    filePath: string;
    wordWrap?: boolean;
  }) => (
    <div
      data-testid="virtual-plain-code-viewer"
      data-wordwrap={String(wordWrap)}
    >
      Plain code for {filePath}: {content}
    </div>
  ),
}));

describe('FileViewerCard 单轨差异比对与模式响应', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(workspaceFsApi, 'readTextFile').mockResolvedValue({
      content: 'console.log("hello world");',
    });
    vi.spyOn(workspaceFsApi, 'getWorkspacePath').mockReturnValue('C:/Software/conex');
    vi.spyOn(hostOpenersApi, 'listOpenOptionsForFile').mockResolvedValue({
      defaultLabel: 'VSCode',
      openers: [],
    });

    useTerminalStore.setState({
      diffFiles: [
        {
          filePath: 'src/App.tsx',
          additions: 2,
          deletions: 1,
          changes: [
            { type: 'addition', content: '+ const a = 1;' },
            { type: 'deletion', content: '- const a = 0;' },
          ],
        },
      ],
    });
  });

  it('1. 默认 plain 模式渲染 VirtualPlainCodeViewer', async () => {
    render(
      <ToastProvider>
        <FileViewerCard filePath="src/App.tsx" initialMode="plain" />
      </ToastProvider>
    );

    expect(await screen.findByTestId('virtual-plain-code-viewer')).toBeDefined();
    expect(screen.queryByTestId('diff-card-unified-view')).toBeNull();
  });

  it('2. initialMode="diff" 时接入系统单轨 DiffCardUnifiedView（彻底消灭 30 行手写对比）', async () => {
    render(
      <ToastProvider>
        <FileViewerCard filePath="src/App.tsx" initialMode="diff" />
      </ToastProvider>
    );

    expect(await screen.findByTestId('diff-card-unified-view')).toBeDefined();
    expect(screen.queryByTestId('virtual-plain-code-viewer')).toBeNull();
  });

  it('3. 无变更文件在 diff 模式下呈现标准空态', async () => {
    render(
      <ToastProvider>
        <FileViewerCard filePath="src/NoChanges.tsx" initialMode="diff" />
      </ToastProvider>
    );

    expect(await screen.findByText('该文件目前没有本地改动')).toBeDefined();
    expect(screen.queryByTestId('diff-card-unified-view')).toBeNull();
  });

  it('4. 响应 conex:file-viewer-mode 微任务热激活事件（彻底根除 HAL-06 状态死锁）', async () => {
    render(
      <ToastProvider>
        <FileViewerCard filePath="src/App.tsx" initialMode="plain" />
      </ToastProvider>
    );

    expect(await screen.findByTestId('virtual-plain-code-viewer')).toBeDefined();

    // 模拟同名 Tab 热激活事件派发
    act(() => {
      window.dispatchEvent(
        new CustomEvent('conex:file-viewer-mode', {
          detail: {
            canonicalTabId: 'file-viewer:src/App.tsx',
            mode: 'diff',
          },
        })
      );
    });

    expect(await screen.findByTestId('diff-card-unified-view')).toBeDefined();
    expect(screen.queryByTestId('virtual-plain-code-viewer')).toBeNull();
  });

  it('5. 响应 initialMode prop 变动（React 生命周期通道）', async () => {
    const { rerender } = render(
      <ToastProvider>
        <FileViewerCard filePath="src/App.tsx" initialMode="plain" />
      </ToastProvider>
    );

    expect(await screen.findByTestId('virtual-plain-code-viewer')).toBeDefined();

    rerender(
      <ToastProvider>
        <FileViewerCard filePath="src/App.tsx" initialMode="diff" />
      </ToastProvider>
    );

    expect(await screen.findByTestId('diff-card-unified-view')).toBeDefined();
    expect(screen.queryByTestId('virtual-plain-code-viewer')).toBeNull();
  });

  it('6. 复制全部内容按钮点击后将完整源码写入剪贴板', async () => {
    const writeTextSpy = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextSpy,
      },
    });

    render(
      <ToastProvider>
        <FileViewerCard filePath="src/App.tsx" initialMode="plain" />
      </ToastProvider>
    );

    const copyBtn = await screen.findByRole('button', { name: '复制全部内容' });
    expect(copyBtn).toBeInTheDocument();

    await act(async () => {
      copyBtn.click();
    });

    expect(writeTextSpy).toHaveBeenCalledWith('console.log("hello world");');
  });

  it('7. 点击查看历史编辑情况展开 Git 提交历史抽屉并展示提交列表与未提交改动', async () => {
    vi.spyOn(gitApi, 'runLocalGit').mockResolvedValue({
      ok: true,
      stdout: 'a1b2c3d feat: initial commit\ne4f5a6b fix: update button style\n',
      stderr: '',
    });

    const writeTextSpy = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextSpy,
      },
    });

    render(
      <ToastProvider>
        <FileViewerCard filePath="src/App.tsx" initialMode="plain" />
      </ToastProvider>
    );

    const historyBtn = await screen.findByRole('button', { name: '查看历史编辑情况' });
    expect(historyBtn).toBeInTheDocument();

    await act(async () => {
      historyBtn.click();
    });

    expect(await screen.findByText('提交历史 (2)')).toBeInTheDocument();
    expect(screen.getByText('feat: initial commit')).toBeInTheDocument();
    expect(screen.getByText('fix: update button style')).toBeInTheDocument();

    // 点击复制提交哈希
    const hashBtn = screen.getByRole('button', { name: '复制提交哈希 a1b2c3d' });
    await act(async () => {
      hashBtn.click();
    });
    expect(writeTextSpy).toHaveBeenCalledWith('a1b2c3d');

    // 含有未提交修改提示
    expect(screen.getByText('工作区未提交改动')).toBeInTheDocument();
  });

  it('8. 更多操作下拉菜单提供打开文件路径、复制相对/绝对路径与选择打开方式', async () => {
    const revealSpy = vi.spyOn(workspaceFsApi, 'revealInOs').mockResolvedValue(true as any);
    const openDefaultSpy = vi.spyOn(hostOpenersApi, 'openPathDefault').mockResolvedValue({} as any);

    const writeTextSpy = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextSpy,
      },
    });

    render(
      <ToastProvider>
        <FileViewerCard filePath="src/App.tsx" initialMode="plain" />
      </ToastProvider>
    );

    const moreBtn = await screen.findByRole('button', { name: '更多操作' });
    expect(moreBtn).toBeInTheDocument();

    // 1. 打开菜单并验证所有选项存在
    await act(async () => {
      moreBtn.click();
    });

    expect(await screen.findByText('打开文件路径')).toBeInTheDocument();
    expect(screen.getByText('复制相对路径')).toBeInTheDocument();
    expect(screen.getByText('复制绝对路径')).toBeInTheDocument();
    expect(screen.getByText('选择打开方式')).toBeInTheDocument();

    // 2. 测试复制相对路径
    const copyRelOption = screen.getByText('复制相对路径');
    await act(async () => {
      copyRelOption.click();
    });
    expect(writeTextSpy).toHaveBeenCalledWith('src/App.tsx');

    // 3. 再次打开菜单，测试复制绝对路径
    await act(async () => {
      moreBtn.click();
    });
    const copyAbsOption = await screen.findByText('复制绝对路径');
    await act(async () => {
      copyAbsOption.click();
    });
    expect(writeTextSpy).toHaveBeenCalledWith('C:/Software/conex/src/App.tsx');

    // 4. 再次打开菜单，测试打开文件路径
    await act(async () => {
      moreBtn.click();
    });
    const openPathOption = await screen.findByText('打开文件路径');
    await act(async () => {
      openPathOption.click();
    });
    expect(revealSpy).toHaveBeenCalled();

    // 5. 再次打开菜单，测试选择打开方式
    await act(async () => {
      moreBtn.click();
    });
    const openWithOption = await screen.findByText('选择打开方式');
    await act(async () => {
      openWithOption.click();
    });
    expect(openDefaultSpy).toHaveBeenCalled();
  });

  it('9. FileViewerCardView 视图适配器正确消费 ViewRenderContext 参数并挂载', async () => {
    render(
      <ToastProvider>
        <FileViewerCardView
          panelId="file-viewer"
          leafId="leaf-1"
          isActive={true}
          openView={vi.fn()}
          params={{
            filePath: 'src/App.tsx',
            initialMode: 'diff',
          }}
        />
      </ToastProvider>
    );

    expect(await screen.findByTestId('diff-card-unified-view')).toBeDefined();
  });

  it('10. 支持工具栏自动换行切换按钮并向 VirtualPlainCodeViewer 传递 wordWrap 属性', async () => {
    localStorage.removeItem('crish:file-viewer-word-wrap');

    render(
      <ToastProvider>
        <FileViewerCard filePath="src/App.tsx" initialMode="plain" />
      </ToastProvider>
    );

    const viewer = await screen.findByTestId('virtual-plain-code-viewer');
    // 默认开启换行
    expect(viewer.getAttribute('data-wordwrap')).toBe('true');

    const wrapBtn = screen.getByRole('button', { name: '关闭自动换行' });
    expect(wrapBtn).toBeDefined();

    // 点击切换为关闭
    await act(async () => {
      wrapBtn.click();
    });

    expect(viewer.getAttribute('data-wordwrap')).toBe('false');
    expect(localStorage.getItem('crish:file-viewer-word-wrap')).toBe('false');

    // 再次点击切换为开启
    await act(async () => {
      wrapBtn.click();
    });

    expect(viewer.getAttribute('data-wordwrap')).toBe('true');
    expect(localStorage.getItem('crish:file-viewer-word-wrap')).toBe('true');
  });

  it('11. 当打开 JSON 文件时渲染格式化按钮，点击格式化后显示缩进内容并可还原', async () => {
    vi.mocked(workspaceFsApi.readTextFile).mockResolvedValueOnce({
      content: '{"hello":"world","count":10}',
      lineCount: 1,
      truncated: false,
      path: 'data/config.json',
    });

    render(
      <ToastProvider>
        <FileViewerCard filePath="data/config.json" initialMode="plain" />
      </ToastProvider>
    );

    const viewer = await screen.findByTestId('virtual-plain-code-viewer');
    expect(viewer.textContent).toContain('{"hello":"world","count":10}');

    const formatBtn = screen.getByRole('button', { name: '格式化 JSON 排版' });
    expect(formatBtn).toBeDefined();

    // 点击格式化
    await act(async () => {
      formatBtn.click();
    });

    // 格式化后包含 2 空格缩进换行
    expect(viewer.textContent).toContain('{\n  "hello": "world"');

    // 按钮文案变为还原
    const restoreBtn = screen.getByRole('button', { name: '还原紧凑格式' });
    expect(restoreBtn).toBeDefined();

    // 点击还原
    await act(async () => {
      restoreBtn.click();
    });

    expect(viewer.textContent).toContain('{"hello":"world","count":10}');
  });
});
