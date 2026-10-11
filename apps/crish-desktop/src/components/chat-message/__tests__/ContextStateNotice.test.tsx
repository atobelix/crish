// @vitest-environment jsdom
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ContextStateNotice } from '../ContextStateNotice';
import type { MessageContextInjection } from '../../../store/types';

describe('ContextStateNotice', () => {
  it('renders clean hairline notice without icons or card borders', () => {
    const inj: Partial<MessageContextInjection> = {
      id: 'test-state-1',
      kind: 'workspace_env',
      title: '上下文状态切换',
      metadata: {
        mode: 'context-state',
        model: 'deepseek-chat',
        permission: 'ask',
      },
    };

    const { container } = render(
      <ContextStateNotice injection={inj} rowKey="row-1" />
    );

    expect(
      screen.getByText('已切换到 deepseek-chat · 权限 需确认')
    ).toBeInTheDocument();

    // No buttons, no svg icons
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(container.querySelectorAll('svg')).toHaveLength(0);

    // No emojis
    const textContent = container.textContent || '';
    expect(/[\u{1F300}-\u{1F9FF}]/u.test(textContent)).toBe(false);
  });
});
