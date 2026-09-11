// @vitest-environment jsdom
/**
 * ChatToolStack（ChatToolCallBlock）V1-γ 折叠单源渲染测试：
 * 渲染端不再展平/重分组——group 直接渲染为折叠标题行（复活 label）+
 * 组内子行展开列表；single 保持单行。
 */
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { ChatToolStack } from './ChatToolCallBlock';
import type { MessageToolCall } from '../../store/types';

function tc(
  id: string,
  name: string,
  status: MessageToolCall['status'],
  extra?: Partial<MessageToolCall>
): MessageToolCall {
  return { id, name, status, arguments: '', ...extra };
}

function baseProps() {
  return {
    agents: [],
    activeSessionId: 's1',
    expandedTools: {},
    onToggleTool: vi.fn(),
    approvalBusy: false,
  };
}

describe('ChatToolStack V1-γ 折叠单源渲染', () => {
  it('group → 折叠标题行（复活 label）+ 组内子行展开列表', () => {
    const { container } = render(
      <ChatToolStack
        items={[
          {
            kind: 'group',
            id: 'grp-t1',
            label: '查看 src · 3 步',
            tools: [
              tc('t1', 'list_dir', 'running'),
              tc('t2', 'list_dir', 'running'),
              tc('t3', 'list_dir', 'running'),
            ],
          },
        ]}
        msgId="m1"
        {...baseProps()}
      />
    );
    // 折叠头文案 = 投影层 group.label（死字段复活）
    expect(container.textContent).toContain('查看 src · 3 步');
    // 组容器带有 data-group-id 与 data-expanded="true"
    const groupEl = container.querySelector('[data-group-id="grp-t1"]');
    expect(groupEl).toBeTruthy();
    expect(groupEl?.getAttribute('data-expanded')).toBe('true');
    // 组内子行逐一渲染（不展平为独立组外行、也不重分组）
    expect(container.querySelectorAll('.tool-row')).toHaveLength(3);
    expect(container.querySelectorAll('[data-tool-id="t1"]')).toHaveLength(1);
  });

  it('single → 单行渲染（不包裹组容器）', () => {
    const { container } = render(
      <ChatToolStack
        items={[
          {
            kind: 'single',
            tc: tc('s1', 'replace_file_content', 'success', {
              output: 'ok',
            }),
          },
        ]}
        msgId="m1"
        {...baseProps()}
      />
    );
    expect(container.querySelectorAll('.tool-row')).toHaveLength(1);
    expect(container.textContent).not.toContain('Parallel');
  });

  it('混合 items：single 与 group 按投影顺序直出', () => {
    const { container } = render(
      <ChatToolStack
        items={[
          {
            kind: 'single',
            tc: tc('a1', 'read_file', 'success', { output: 'content' }),
          },
          {
            kind: 'group',
            id: 'grp-b',
            label: '运行终端命令 · 2 步',
            tools: [
              tc('b1', 'run_command', 'running'),
              tc('b2', 'run_command', 'running'),
            ],
          },
        ]}
        msgId="m1"
        {...baseProps()}
      />
    );
    const ids = [...container.querySelectorAll('.tool-row')].map((el) =>
      el.getAttribute('data-tool-id')
    );
    expect(ids).toEqual(['a1', 'b1', 'b2']);
    expect(container.textContent).toContain('运行终端命令 · 2 步');
    // 渲染端零重分组标记：无「Parallel（N）」字面
    expect(container.textContent).not.toContain('Parallel');
  });

  it('批量待审批工具（>=2）渲染 BatchApprovalBar，恢复权威 Primary 实心填充', () => {
    const onBatchApprove = vi.fn();
    const onBatchDeny = vi.fn();

    const { container } = render(
      <ChatToolStack
        items={[
          {
            kind: 'group',
            id: 'grp-pending',
            label: '待审批工具 · 2 步',
            tools: [
              tc('p1', 'run_command', 'pending_approval'),
              tc('p2', 'run_command', 'pending_approval'),
            ],
          },
        ]}
        msgId="m-appr"
        actions={{
          onBatchApprove,
          onBatchDeny,
        }}
        {...baseProps()}
      />
    );

    expect(container.textContent).toContain('待确认工具（2）');

    const approveBtn = container.querySelector('button[data-variant="primary"]');
    const denyBtn = container.querySelector('button[data-variant="danger"]');

    expect(approveBtn).not.toBeNull();
    expect(approveBtn?.textContent).toContain('全部批准');
    expect(denyBtn).not.toBeNull();
    expect(denyBtn?.textContent).toContain('全部拒绝');

    approveBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onBatchApprove).toHaveBeenCalledWith(['m-appr', 'm-appr'], ['p1', 'p2']);

    denyBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onBatchDeny).toHaveBeenCalledWith(['m-appr', 'm-appr'], ['p1', 'p2']);
  });

  describe('DIM-04 24px 极简单行与 Figma 规范', () => {
    it('文件读取工具：左侧渲染 14px 图标 + 人类友好动作「读取文件」+ 核心参数文件名', () => {
      const { container } = render(
        <ChatToolStack
          items={[
            {
              kind: 'single',
              tc: tc('read-1', 'read_file', 'success', {
                arguments: JSON.stringify({ filePath: 'src/main.ts' }),
                output: 'console.log("hello");',
              }),
            },
          ]}
          msgId="m-read"
          {...baseProps()}
        />
      );

      // 验证存在 24px 单行外层头部
      const head = container.querySelector('.tool-row-head');
      expect(head).not.toBeNull();

      // 验证人类友好动作「读取」
      expect(container.textContent).toContain('读取');
      // 验证核心参数「main.ts」
      expect(container.textContent).toContain('main.ts');
      // 验证存在分隔圆点
      expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
      // 验证展开折叠符号已被净化（不产生每一行的视觉噪音）
      const chevron = container.querySelector('[data-icon="chevron-right"]');
      expect(chevron).toBeNull();
      // 验证文件读取工具默认不可展开（点击路径超链接直接导流至右侧栏检视）
      expect(head?.classList.contains('tool-row-head-static')).toBe(true);
    });

    it('Shell 执行命令工具：渲染「终端」与命令行核心参数', () => {
      const { container } = render(
        <ChatToolStack
          items={[
            {
              kind: 'single',
              tc: tc('cmd-1', 'run_command', 'running', {
                arguments: JSON.stringify({ CommandLine: 'cargo test --workspace' }),
                startedAt: Date.now() - 1500,
              }),
            },
          ]}
          msgId="m-cmd"
          {...baseProps()}
        />
      );

      expect(container.textContent).toContain('终端');
      expect(container.textContent).toContain('cargo test --workspace');
      // 运行态指标验证
      const runningRow = container.querySelector('.is-running');
      expect(runningRow).not.toBeNull();
    });

    it('错误态工具：正确渲染错误状态样式', () => {
      const { container } = render(
        <ChatToolStack
          items={[
            {
              kind: 'single',
              tc: tc('err-1', 'run_command', 'error', {
                arguments: JSON.stringify({ CommandLine: 'npm run fail' }),
                output: 'Command failed',
              }),
            },
          ]}
          msgId="m-err"
          {...baseProps()}
        />
      );

      // 验证存在错误行
      expect(container.querySelector('.is-error')).not.toBeNull();
    });
  });
});
