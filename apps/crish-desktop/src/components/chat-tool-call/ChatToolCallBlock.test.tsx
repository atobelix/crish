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
});
