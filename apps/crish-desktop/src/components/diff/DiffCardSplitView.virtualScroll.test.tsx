// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { DiffCardSplitView } from './DiffCardSplitView';
import type { FileDiff } from '../../store/types';

describe('DiffCardSplitView 虚拟滚动真实物理高度 (Task 3)', () => {
  it('DiffCardSplitView 占位容器高度必须严格等于 totalItems * 22px', () => {
    const mockItems = Array.from({ length: 1000 }, (_, i) => ({
      isCollapsedPlaceholder: false as const,
      startIndex: i,
      pair: {
        left: {
          change: { content: `old line ${i}`, type: 'normal' as const },
          oldLine: i + 1,
        },
        right: {
          change: { content: `new line ${i}`, type: 'normal' as const },
          newLine: i + 1,
        },
      },
    }));

    const mockFile: FileDiff = {
      filePath: 'src/long.ts',
      additions: 500,
      deletions: 500,
      changes: [],
    };

    const { container } = render(
      <DiffCardSplitView
        f={mockFile}
        renderItems={mockItems}
        onExpandBlock={vi.fn()}
      />
    );

    const placeholderDiv = container.querySelector(
      '[style*="position: relative"] > div'
    );
    expect(placeholderDiv).not.toBeNull();
    expect(placeholderDiv?.getAttribute('style')).toContain('height: 22000px');
  });
});
