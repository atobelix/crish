// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { FileViewerCard } from './FileViewerCard';
import { ToastProvider } from '../../services/toast/ToastContext';
import * as workspaceFsApi from '../../api/workspaceFsApi';
import * as hostOpenersApi from '../../api/hostOpenersApi';
import { useTerminalStore } from '../../store/terminalStore';

vi.mock('../diff/DiffCardUnifiedView', () => ({
  DiffCardUnifiedView: ({ f }: { f: any }) => (
    <div data-testid="diff-card-unified-view">
      Unified diff for {f.filePath}
    </div>
  ),
}));

vi.mock('../diff/VirtualPlainCodeViewer', () => ({
  VirtualPlainCodeViewer: ({ content, filePath }: { content: string; filePath: string }) => (
    <div data-testid="virtual-plain-code-viewer">
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
});
