/** @vitest-environment jsdom */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GitStatusBadge, DiffStatBar } from './GitStatusBadge';
import { OverviewGitTree } from './OverviewGitTree';
import type { GitStatusFile } from '../../api/gitTreeHelpers';

describe('Overview - GitStatusBadge & DiffStatBar', () => {
  it('renders 4px GitStatusBadge with correct status label and text', () => {
    const { container, rerender } = render(<GitStatusBadge status="M" />);
    const badge = container.querySelector('[role="status"]');
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toBe('M');
    expect(badge?.getAttribute('aria-label')).toContain('修改 (Modified)');

    rerender(<GitStatusBadge status="A" staged />);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('A');
    expect(
      container.querySelector('[role="status"]')?.getAttribute('aria-label')
    ).toContain('已暂存');

    rerender(<GitStatusBadge status="D" />);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('D');

    rerender(<GitStatusBadge status="C" conflicted />);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('C');
  });

  it('renders DiffStatBar with 3-color 5-box micro bar and numbers', () => {
    const { container } = render(<DiffStatBar additions={45} deletions={12} />);
    const statContainer = container.querySelector('[aria-label="+45, -12"]');
    expect(statContainer).toBeTruthy();
    expect(statContainer?.textContent).toContain('+45');
    expect(statContainer?.textContent).toContain('−12');
  });

  it('returns null for DiffStatBar if 0 additions and 0 deletions', () => {
    const { container } = render(<DiffStatBar additions={0} deletions={0} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('Overview - OverviewGitTree', () => {
  const sampleFiles: GitStatusFile[] = [
    {
      path: 'apps/crish-desktop/src/components/A.tsx',
      status: 'M',
      additions: 15,
      deletions: 5,
    },
    {
      path: 'apps/crish-desktop/src/components/B.tsx',
      status: 'A',
      additions: 30,
      deletions: 0,
    },
    { path: 'package.json', status: 'M', additions: 2, deletions: 1 },
  ];

  it('renders git files tree structure with compact folders and file count', () => {
    render(
      <OverviewGitTree
        files={sampleFiles}
        openingPath={null}
        onOpenFile={() => {}}
      />
    );

    expect(screen.getByText('3 个改动文件')).toBeTruthy();
    expect(screen.getByText('apps/crish-desktop/src/components')).toBeTruthy();
    expect(screen.getByText('package.json')).toBeTruthy();
  });
});
