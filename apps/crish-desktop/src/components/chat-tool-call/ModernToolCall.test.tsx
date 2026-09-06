// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModernJsonToolCall } from './ModernJsonToolCall';
import { ModernTerminalToolCall, TerminalCard } from './ModernTerminalToolCall';
import { ModernToolCall } from './ModernToolCall';
import { ModernApprovalCard } from './ModernApprovalCard';
import { ToolCallDiffPreview, DiffCard } from './ToolCallDiffPreview';
import type { FileDiff } from '../../store/types';

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

    it('超过 30 行时默认截断为首尾 15 行并展示展开药丸，点击后展开全量行', () => {
      const sixtyLines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n');
      render(
        <TerminalCard command="cargo test" output={sixtyLines} />
      );

      // 默认展示首尾
      expect(screen.getByText('line 1')).toBeDefined();
      expect(screen.getByText('line 60')).toBeDefined();
      expect(screen.queryByText('line 30')).toBeNull();

      // 点击展开药丸
      const expandBtn = screen.getByRole('button', { name: /展开中间剩余 30 行/ });
      fireEvent.click(expandBtn);

      // 展开后全量展示
      expect(screen.getByText('line 30')).toBeDefined();

      // 点击收起
      const collapseBtn = screen.getByRole('button', { name: '收起中间日志输出' });
      fireEvent.click(collapseBtn);
      expect(screen.queryByText('line 30')).toBeNull();
    });

    it('正确解析 ANSI 彩色转义序列', () => {
      render(
        <ModernTerminalToolCall
          command="make test"
          output={'\x1b[32mPASS_ALL_TESTS\x1b[0m'}
        />
      );

      const coloredNode = screen.getByText('PASS_ALL_TESTS');
      expect(coloredNode).toBeDefined();
      expect(coloredNode.style.color).toBe('rgb(110, 231, 183)');
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

  describe('4. ModernApprovalCard 高危命令授权卡片 (DIM-04.1 一屏一主色治理)', () => {
    it('正确渲染标题、命令预览与原子按钮（Primary允许 + Ghost拒绝）', () => {
      const onAllow = vi.fn();
      const onDeny = vi.fn();

      render(
        <ModernApprovalCard
          id="appr-1"
          command="rm -rf ./target/release"
          summary="高危删除执行确认"
          onAllow={onAllow}
          onDeny={onDeny}
        />
      );

      expect(screen.getByText('高危删除执行确认')).toBeDefined();
      expect(screen.getByText('$ rm -rf ./target/release')).toBeDefined();

      const allowBtn = screen.getByRole('button', { name: '允许执行' });
      const denyBtn = screen.getByRole('button', { name: '拒绝' });

      expect(allowBtn).toBeDefined();
      expect(denyBtn).toBeDefined();

      // 验证单一主色契约：允许执行必须为 primary，拒绝必须为 ghost
      expect(allowBtn.getAttribute('data-variant')).toBe('primary');
      expect(denyBtn.getAttribute('data-variant')).toBe('ghost');

      fireEvent.click(denyBtn);
      expect(onDeny).toHaveBeenCalledTimes(1);
      expect(onAllow).not.toHaveBeenCalled();

      fireEvent.click(allowBtn);
      expect(onAllow).toHaveBeenCalledTimes(1);
    });
  });

  describe('5. ToolCallDiffPreview / DiffCard 差异比对卡片平铺视图测试', () => {
    const mockDiff: FileDiff = {
      filePath: 'src/components/Button.tsx',
      additions: 12,
      deletions: 3,
      changes: [
        { type: 'normal', content: 'import React from "react";', lineNum: 1 },
        { type: 'deletion', content: 'export const OldButton = () => null;', lineNum: 2 },
        { type: 'addition', content: 'export const Button = () => <button />;', lineNum: 2 },
        { type: 'addition', content: 'export default Button;', lineNum: 3 },
      ],
    };

    it('正确渲染差异卡片头部、+A -R 统计胶囊与代码行三列对齐', () => {
      const { container } = render(<DiffCard diff={mockDiff} />);

      // 文件路径
      expect(container.textContent).toContain('src/components/Button.tsx');
      // +12 增与 -3 删统计胶囊
      expect(container.textContent).toContain('+12');
      expect(container.textContent).toContain('-3');

      // 变动符号列与代码文本
      expect(container.textContent).toContain('+');
      expect(container.textContent).toContain('-');
      expect(container.textContent).toContain('export const Button');
      expect(container.textContent).toContain('export const OldButton');
      expect(container.textContent).toContain('import React from "react";');
    });

    it('点击复制差异按钮应将清洗后的 Unified Diff 纯文本复制至剪贴板', () => {
      render(<ToolCallDiffPreview diff={mockDiff} />);

      const copyBtn = screen.getByRole('button', { name: '复制差异内容' });
      fireEvent.click(copyBtn);

      expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
      const copiedText = vi.mocked(navigator.clipboard.writeText).mock.calls[0]?.[0];
      expect(copiedText).toContain('+ export const Button = () => <button />;');
      expect(copiedText).toContain('- export const OldButton = () => null;');
      expect(copiedText).toContain('  import React from "react";');
    });

    it('点击在右侧查看或卡片头部应触发 onOpenDiff 回调', () => {
      const onOpenDiff = vi.fn();
      render(<DiffCard diff={mockDiff} onOpenDiff={onOpenDiff} />);

      const openTag = screen.getByRole('button', { name: '在右侧面板查看完整差异' });
      fireEvent.click(openTag);
      expect(onOpenDiff).toHaveBeenCalledWith(mockDiff);

      // 头部点击
      const header = screen.getByRole('button', { name: '查看差异：src/components/Button.tsx' });
      fireEvent.click(header);
      expect(onOpenDiff).toHaveBeenCalledTimes(2);
    });

    it('超过平铺门限时支持平铺展开与收起', () => {
      const longChanges = Array.from({ length: 30 }, (_, i) => ({
        type: 'addition' as const,
        content: `const val${i + 1} = ${i + 1};`,
        lineNum: i + 1,
      }));

      const longDiff: FileDiff = {
        filePath: 'src/constants.ts',
        additions: 30,
        deletions: 0,
        changes: longChanges,
      };

      const { container } = render(<ToolCallDiffPreview diff={longDiff} />);

      // 默认展示前 24 行，未展开第 28 行
      expect(container.textContent).toContain('const val1 = 1;');
      expect(container.textContent).not.toContain('const val28 = 28;');

      // 点击平铺展开
      const expandBtn = screen.getByRole('button', { name: /平铺展开剩余 6 行/ });
      fireEvent.click(expandBtn);

      // 全量平铺呈现
      expect(container.textContent).toContain('const val28 = 28;');

      // 点击收起
      const collapseBtn = screen.getByRole('button', { name: '收起部分平铺行' });
      fireEvent.click(collapseBtn);
      expect(container.textContent).not.toContain('const val28 = 28;');
    });
  });
});
