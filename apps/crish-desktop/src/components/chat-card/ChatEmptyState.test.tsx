// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatEmptyState } from './ChatEmptyState';
import * as projectStore from '../../api/projectStore';
import emptyStyles from './ChatEmptyState.module.css';
import { layerStackService } from '../ui/internal/layer-stack/LayerStackService';

afterEach(() => {
  vi.restoreAllMocks();
  layerStackService.dispose();
});

function stubProject(name = 'conex'): void {
  vi.spyOn(projectStore, 'getActiveProject').mockReturnValue({
    id: 'proj-1',
    name,
    path: 'C:/Software/conex',
    addedAt: 1,
    lastOpenedAt: 2,
  });
  vi.spyOn(projectStore, 'getWorkspacePath').mockReturnValue(
    'C:/Software/conex'
  );
}

describe('ChatEmptyState', () => {
  it('session-empty 欢迎面：我们该在 {项目} 中处理什么？', () => {
    stubProject('conex');
    const { container } = render(
      <ChatEmptyState kind="session-empty" onSetChatInput={vi.fn()} />
    );
    const title = screen.getByRole('heading', { level: 3 });
    expect(title.textContent?.replace(/\s+/g, '')).toContain(
      '我们该在conex中处理什么？'
    );
    expect(screen.queryByText('正在加载消息')).toBeNull();
    expect(container.textContent).not.toMatch(/打开文件/);
    expect(container.querySelector('[data-unit-chrome-actions]')).toBeNull();
  });

  it('messagesLoading 不卸载欢迎面，只出轻量指示、不出快捷 prompt', () => {
    stubProject('conex');
    const { container } = render(
      <ChatEmptyState
        kind="session-empty"
        messagesLoading
        onSetChatInput={vi.fn()}
      />
    );
    const title = screen.getByRole('heading', { level: 3 });
    expect(title.textContent).toMatch(/我们该在/);
    expect(title.textContent).toMatch(/中处理什么/);
    const root = container.querySelector('[data-empty-kind="session-empty"]');
    expect(root?.getAttribute('data-messages-loading')).toBe('true');
    expect(
      container.querySelector('[data-empty-region="loading"]')
    ).toBeTruthy();
    expect(screen.getByText('正在加载消息')).toBeTruthy();
    expect(
      container.querySelector('[data-empty-region="quick-prompts"]')
    ).toBeNull();
    expect(container.querySelector('[data-empty-kind="session-empty"]')).not.toBeNull();
  });

  it('空态项目选择钮不带 no-drag；展开面板不带 sort-filter 死类', async () => {
    stubProject('conex');
    const { container } = render(
      <ChatEmptyState
        kind="session-empty"
        showProjectPicker
        onShowProjectPicker={vi.fn()}
        onSetChatInput={vi.fn()}
      />
    );
    const btn = screen.getByRole('button', { name: /当前项目：conex/ });
    expect(btn.className).toContain(emptyStyles.chatEmptyProjectBtnInline);
    expect(btn.className).not.toMatch(/\bno-drag\b/);
    const html = `${container.innerHTML}${document.body.innerHTML}`;
    expect(html).not.toContain('sort-filter-menu');
    expect(html).not.toContain('sort-filter-option');
    expect(
      await screen.findByRole('menu', { name: '选择项目' })
    ).toBeInTheDocument();
  });

  it('无 loading 时 session-empty 可出快捷 prompt', () => {
    stubProject('conex');
    const { container } = render(
      <ChatEmptyState kind="session-empty" onSetChatInput={vi.fn()} />
    );
    expect(
      container.querySelector('[data-empty-region="quick-prompts"]')
    ).toBeTruthy();
    expect(container.querySelector('[data-empty-region="loading"]')).toBeNull();
  });
});
