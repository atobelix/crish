// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModernJsonToolCall } from './ModernJsonToolCall';
import { ModernTerminalToolCall } from './ModernTerminalToolCall';
import { ModernToolCall } from './ModernToolCall';

describe('ModernToolCall 极简黑白灰工具调用组件套件', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  describe('1. ModernJsonToolCall 结构化工具（截图 1 形态）', () => {
    it('正确渲染折叠 Header：动作文本、参数胶囊与完成绿勾', () => {
      const { container } = render(
        <ModernJsonToolCall
          id="t-1"
          name="search_docs"
          actionText="Searched the docs"
          paramPill="draft persistence"
          request={{ query: 'draft persistence' }}
          result="3 matches, best hit /docs/runtime/drafts"
          status="success"
        />
      );

      expect(screen.getByText('Searched the docs')).toBeDefined();
      expect(screen.getByText('draft persistence')).toBeDefined();

      // 默认折叠，不渲染 Request / Result 卡片
      expect(screen.queryByText('Request')).toBeNull();
      expect(screen.queryByText('Result')).toBeNull();

      // 绿色对勾呈现
      const successIcon = container.querySelector('svg.lucide-check');
      expect(successIcon).toBeDefined();
    });

    it('点击 Header 能够展开呈现 Request 与 Result 区域', () => {
      render(
        <ModernJsonToolCall
          id="t-2"
          name="search_docs"
          actionText="Searched the docs"
          paramPill="draft persistence"
          request={{ query: 'draft persistence' }}
          result="3 matches, best hit /docs/runtime/drafts"
          status="success"
        />
      );

      const headBtn = screen.getByRole('button', { name: /Searched the docs/ });
      fireEvent.click(headBtn);

      expect(screen.getByText('Request')).toBeDefined();
      expect(screen.getByText(/"query": "draft persistence"/)).toBeDefined();
      expect(screen.getByText('Result')).toBeDefined();
      expect(
        screen.getByText('3 matches, best hit /docs/runtime/drafts')
      ).toBeDefined();

      // 再次点击折叠
      fireEvent.click(headBtn);
      expect(screen.queryByText('Request')).toBeNull();
    });

    it('支持 defaultOpen 与外部受控 isOpen / onToggle', () => {
      const onToggle = vi.fn();
      render(
        <ModernJsonToolCall
          id="t-3"
          name="view_file"
          isOpen={true}
          onToggle={onToggle}
          request={{ path: 'README.md' }}
          result="# Overview"
        />
      );

      expect(screen.getByText('Request')).toBeDefined();
      expect(screen.getByText('# Overview')).toBeDefined();

      const headBtn = screen.getByRole('button');
      fireEvent.click(headBtn);
      expect(onToggle).toHaveBeenCalledWith(false);
    });
  });

  describe('2. ModernTerminalToolCall 终端命令行工具（截图 2 形态）', () => {
    it('正确渲染 $ 命令头行与终端日志流', () => {
      const log = [
        'running 12 tests',
        'test batcher::tests::test_batch_flush_interval ... ok',
        'test batcher::tests::test_ring_buffer_overflow ... ok',
      ].join('\n');

      render(
        <ModernTerminalToolCall
          id="t-term-1"
          command="cargo test -p conex-session-loop -- --nocapture"
          output={log}
          status="success"
        />
      );

      expect(screen.getByText('$')).toBeDefined();
      expect(
        screen.getByText('cargo test -p conex-session-loop -- --nocapture')
      ).toBeDefined();
      expect(
        screen.getByText(/test batcher::tests::test_batch_flush_interval \.\.\. ok/)
      ).toBeDefined();
    });

    it('点击复制按钮应复制命令到剪贴板', () => {
      render(
        <ModernTerminalToolCall
          id="t-term-copy"
          command="npm test"
          output="PASS"
        />
      );

      const copyBtn = screen.getByRole('button', { name: '复制命令行' });
      fireEvent.click(copyBtn);
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('npm test');
    });
  });

  describe('3. ModernToolCall 智能路由分发', () => {
    it('对于 Shell/终端命令工具，自动分发到 Terminal 格式', () => {
      render(
        <ModernToolCall
          tool={{
            id: 'call-1',
            name: 'run_command',
            arguments: JSON.stringify({ CommandLine: 'cargo check' }),
            output: 'Finished dev [unoptimized + debuginfo] target(s)',
            status: 'success',
          }}
        />
      );

      expect(screen.getByText('$')).toBeDefined();
      expect(screen.getByText('cargo check')).toBeDefined();
      expect(
        screen.getByText('Finished dev [unoptimized + debuginfo] target(s)')
      ).toBeDefined();
    });

    it('对于搜索等结构化工具，自动提取 query 为胶囊并分发到 JSON 格式', () => {
      render(
        <ModernToolCall
          defaultOpen={true}
          tool={{
            id: 'call-2',
            name: 'grep_search',
            arguments: JSON.stringify({ Query: 'draft persistence' }),
            output: '3 matches found',
            status: 'success',
          }}
        />
      );

      // 提取出的参数胶囊
      expect(screen.getByText('draft persistence')).toBeDefined();
      // 展开的 Request
      expect(screen.getByText('Request')).toBeDefined();
      expect(screen.getByText('Result')).toBeDefined();
      expect(screen.getByText('3 matches found')).toBeDefined();
    });
  });
});
