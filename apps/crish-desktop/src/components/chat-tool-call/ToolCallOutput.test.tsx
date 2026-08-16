// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToolCallInputPane } from './ToolCallInputPane';
import { ToolCallOutputPane } from './ToolCallOutputPane';
import { ToolCallOutput, TOOL_OUTPUT_LINE_CAP } from './ToolCallOutput';

describe('DIM-05 两段式结构化分栏容器与大输出保护测试套件', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  describe('1. ToolCallInputPane 📥 输入区测试', () => {
    it('Shell 工具应渲染 $ CLI 提示符与工作目录 CWD', () => {
      render(
        <ToolCallInputPane
          toolId="t-shell-1"
          name="run_command"
          argumentsStr={JSON.stringify({
            CommandLine: 'npm run test:coverage',
            Cwd: 'C:/Software/conex',
          })}
        />
      );

      expect(screen.getByText('📥 输入')).toBeDefined();
      expect(screen.getByText('命令行指令')).toBeDefined();
      expect(screen.getByText('$')).toBeDefined();
      expect(screen.getByText('npm run test:coverage')).toBeDefined();
      expect(screen.getByText('工作目录:')).toBeDefined();
      expect(screen.getByText('C:/Software/conex')).toBeDefined();
    });

    it('非 Shell 工具应以结构化属性表格渲染，并支持切换原始 JSON', () => {
      const argsObj = {
        AbsolutePath: 'C:/Software/conex/src/App.tsx',
        StartLine: 10,
        EndLine: 50,
      };

      render(
        <ToolCallInputPane
          toolId="t-view-1"
          name="view_file"
          argumentsStr={JSON.stringify(argsObj)}
        />
      );

      expect(screen.getByText('📥 输入')).toBeDefined();
      expect(screen.getByText('入参配置')).toBeDefined();
      expect(screen.getByText('AbsolutePath')).toBeDefined();
      expect(screen.getByText('C:/Software/conex/src/App.tsx')).toBeDefined();
      expect(screen.getByText('StartLine')).toBeDefined();
      expect(screen.getByText('10')).toBeDefined();
      expect(screen.getByText('EndLine')).toBeDefined();
      expect(screen.getByText('50')).toBeDefined();
    });

    it('点击复制按钮应复制命令或入参到剪贴板', () => {
      render(
        <ToolCallInputPane
          toolId="t-shell-copy"
          name="run_command"
          argumentsStr={JSON.stringify({
            CommandLine: 'cargo test --workspace',
          })}
        />
      );

      const copyBtn = screen.getByRole('button', { name: /复制/ });
      fireEvent.click(copyBtn);
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        'cargo test --workspace'
      );
    });
  });

  describe('2. ToolCallOutputPane 📤 输出区测试', () => {
    it('成功状态应渲染耗时、行数并展示输出正文', () => {
      render(
        <ToolCallOutputPane
          toolId="t-out-1"
          output="Tests passed successfully.\nTotal 42 passed."
          status="success"
          durationStr="1.4s"
          totalLines={2}
          totalBytes={45}
        />
      );

      expect(screen.getByText('📤 输出')).toBeDefined();
      expect(screen.getByText(/✓ 执行成功/)).toBeDefined();
      expect(screen.getByText(/1.4s/)).toBeDefined();
      expect(screen.getByText(/2 行/)).toBeDefined();
      expect(screen.getByText(/Tests passed successfully/)).toBeDefined();
    });

    it('执行失败时应展示诊断横幅 AlertTriangle', () => {
      render(
        <ToolCallOutputPane
          toolId="t-out-err"
          output="Error: Module not found: ./nonexistent"
          status="error"
        />
      );

      expect(screen.getByText(/✕ 执行失败/)).toBeDefined();
      expect(
        screen.getByText(/执行遇到异常中断，详情见下方 Stderr \/ 输出日志/)
      ).toBeDefined();
      expect(
        screen.getByText('Error: Module not found: ./nonexistent')
      ).toBeDefined();
    });

    it('无返回内容时应渲染优雅成功空状态', () => {
      render(
        <ToolCallOutputPane toolId="t-out-empty" output="" status="success" />
      );

      expect(screen.getByText('执行成功，无返回内容')).toBeDefined();
    });

    it('大输出保护 (RUL-05) 截断时应展示下载日志与终端检查器按钮', () => {
      const onOpenTerminal = vi.fn();
      render(
        <ToolCallOutputPane
          toolId="t-out-large"
          output="Truncated output snippet..."
          status="success"
          isTruncated={true}
          totalLines={2500}
          totalBytes={300 * 1024}
          onOpenTerminal={onOpenTerminal}
        />
      );

      expect(
        screen.getByText(/输出已超过 2000 行 \/ 256KB 保护门限/)
      ).toBeDefined();
      expect(screen.getByText('下载日志')).toBeDefined();

      const inspectorBtn = screen.getByRole('button', {
        name: /在命令检查器中查看完整日志/,
      });
      expect(inspectorBtn).toBeDefined();
      fireEvent.click(inspectorBtn);
      expect(onOpenTerminal).toHaveBeenCalledTimes(1);
    });
  });

  describe('3. ToolCallOutput 两段式集成容器测试 (FIN-01)', () => {
    it('应同时包含 📥 输入区 与 📤 输出区 分栏', () => {
      const tc = {
        id: 'tc-full-1',
        name: 'run_command',
        arguments: JSON.stringify({
          CommandLine: 'cargo test',
          Cwd: 'C:/Software/conex',
        }),
        output: 'test result: ok. 10 passed; 0 failed',
        status: 'success',
        startedAt: 1000,
        completedAt: 2500,
      };

      const { container } = render(
        <ToolCallOutput tc={tc} bodyId="body-tc-full-1" />
      );

      const root = container.querySelector('#body-tc-full-1');
      expect(root).toBeDefined();
      expect(root?.getAttribute('role')).toBe('region');

      // 验证输入区存在
      expect(screen.getByText('📥 输入')).toBeDefined();
      expect(screen.getByText('cargo test')).toBeDefined();

      // 验证输出区存在
      expect(screen.getByText('📤 输出')).toBeDefined();
      expect(screen.getByText(/1.5s/)).toBeDefined();
      expect(
        screen.getByText('test result: ok. 10 passed; 0 failed')
      ).toBeDefined();
    });

    it('超出 2000 行限制自动进行轻量视口截断', () => {
      const bigOutput = Array.from(
        { length: 2500 },
        (_, i) => `log line ${i + 1}`
      ).join('\n');

      const tc = {
        id: 'tc-big-1',
        name: 'run_command',
        arguments: JSON.stringify({ CommandLine: 'npm run dev' }),
        output: bigOutput,
        status: 'success',
      };

      render(<ToolCallOutput tc={tc} bodyId="body-big-1" />);

      expect(
        screen.getByText(new RegExp(`已截断显示前 ${TOOL_OUTPUT_LINE_CAP} 行`))
      ).toBeDefined();
      expect(screen.getByText('下载日志')).toBeDefined();
    });
  });
});
