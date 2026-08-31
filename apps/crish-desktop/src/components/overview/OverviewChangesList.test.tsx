/** @vitest-environment jsdom */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GitStatusBadge, DiffStatBar } from './GitStatusBadge';
import { OverviewChangesList } from './OverviewChangesList';
import type { GitStatusFile } from '../../api/gitTreeHelpers';

describe('Overview - GitStatusBadge & DiffStatBar', () => {
  it('renders GitStatusBadge with correct status label and text', () => {
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

describe('Overview - OverviewChangesList', () => {
  const sampleFiles: GitStatusFile[] = [
    {
      path: 'apps/crish-desktop/src/components/ChangesSection.tsx',
      status: 'M',
      additions: 15,
      deletions: 5,
    },
    {
      path: 'apps/crish-desktop/src/components/OverviewChangesList.tsx',
      status: 'A',
      additions: 80,
      deletions: 0,
    },
    { path: 'package.json', status: 'M', additions: 2, deletions: 1 },
  ];

  it('renders flat list with file names and directory paths', () => {
    render(
      <OverviewChangesList
        files={sampleFiles}
        openingPath={null}
        onOpenFile={() => {}}
      />
    );

    expect(screen.getByText('ChangesSection.tsx')).toBeTruthy();
    expect(screen.getByText('OverviewChangesList.tsx')).toBeTruthy();
    expect(screen.getByText('package.json')).toBeTruthy();
    expect(screen.getAllByText('apps/crish-desktop/src/components').length).toBe(2);
  });

  it('triggers onOpenFile callback when clicking a file row', () => {
    const handleOpenFile = vi.fn();
    render(
      <OverviewChangesList
        files={sampleFiles}
        openingPath={null}
        onOpenFile={handleOpenFile}
      />
    );

    const firstItemBtn = screen.getByText('ChangesSection.tsx').closest('button');
    expect(firstItemBtn).toBeTruthy();
    if (firstItemBtn) {
      fireEvent.click(firstItemBtn);
      expect(handleOpenFile).toHaveBeenCalledTimes(1);
      expect(handleOpenFile).toHaveBeenCalledWith(sampleFiles[0]);
    }
  });

  it('applies isOpening class when openingPath matches file.path', () => {
    const { container } = render(
      <OverviewChangesList
        files={sampleFiles}
        openingPath="package.json"
        onOpenFile={() => {}}
      />
    );

    const buttons = container.querySelectorAll('button');
    expect(buttons[2]?.className).toContain('isOpening');
    expect(buttons[0]?.className).not.toContain('isOpening');
  });

  it('truncates list when files exceed maxInitialFiles and toggles expansion', () => {
    const manyFiles: GitStatusFile[] = Array.from({ length: 12 }, (_, i) => ({
      path: `src/file_${i}.ts`,
      status: 'M',
      additions: i + 1,
      deletions: 0,
    }));

    render(
      <OverviewChangesList
        files={manyFiles}
        openingPath={null}
        onOpenFile={() => {}}
        maxInitialFiles={8}
      />
    );

    expect(screen.getByText('file_0.ts')).toBeTruthy();
    expect(screen.getByText('file_7.ts')).toBeTruthy();
    expect(screen.queryByText('file_8.ts')).toBeNull();

    const expandBtn = screen.getByText('显示全部 12 个文件');
    expect(expandBtn).toBeTruthy();
    fireEvent.click(expandBtn);

    expect(screen.getByText('file_8.ts')).toBeTruthy();
    expect(screen.getByText('file_11.ts')).toBeTruthy();
    expect(screen.getByText('收起改动文件')).toBeTruthy();
  });
});
