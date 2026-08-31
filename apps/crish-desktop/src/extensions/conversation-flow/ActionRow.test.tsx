// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { projectPurposes } from '@crish/conversation-flow';
import type { MessageToolCall } from '../../store/types';
import { ActionRow } from './ActionRow';

vi.mock('../../components/chat-message-row/StreamingMarkdownView', () => ({
  StreamingMarkdownView: ({ text }: { text: string }) =>
    React.createElement('div', { 'data-testid': 'async-markdown-block' }, text),
}));

function writeCall(path: string, contents: string): MessageToolCall {
  return {
    id: 'w1',
    name: 'write_file',
    status: 'success',
    arguments: JSON.stringify({ path, contents }),
    output: 'Wrote file',
  };
}

describe('ActionRow · S7 分流', () => {
  it('代码产物点路径走 onOpenPath，不挂 Notebook', () => {
    const tool = writeCall('src/index.ts', 'export const a = 1;\n');
    const action = projectPurposes([tool])[0]!.actions[0]!;
    const onOpenPath = vi.fn();
    const { container } = render(
      <ActionRow action={action} tool={tool} onOpenPath={onOpenPath} />
    );
    expect(container.querySelector('[data-flow-artifact]')).toBeNull();
    expect(container.querySelector('[data-flow-artifact-notebook]')).toBeNull();
    const pathBtn = container.querySelector('[data-flow-path="code"]');
    expect(pathBtn).not.toBeNull();
    fireEvent.click(pathBtn!);
    expect(onOpenPath).toHaveBeenCalledWith('src/index.ts');
  });

  it('文档产物出 chip；点击钉住阅读面，不调 onOpenPath', () => {
    const tool = writeCall('docs/纪要.md', '# 纪要\n\n正文');
    const action = projectPurposes([tool])[0]!.actions[0]!;
    const onOpenPath = vi.fn();
    const { container } = render(
      <ActionRow action={action} tool={tool} onOpenPath={onOpenPath} />
    );
    expect(container.querySelector('[data-flow-path="code"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /已生成/ }));
    expect(container.querySelector('[data-flow-artifact-notebook="reading"]')).not.toBeNull();
    expect(screen.getByTestId('async-markdown-block').textContent).toMatch(/纪要/);
    expect(onOpenPath).not.toHaveBeenCalled();
    expect(document.body.querySelector(':scope > [data-flow-artifact-notebook]')).toBeNull();
  });
});
