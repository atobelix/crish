// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ArtifactChip } from './ArtifactChip';

describe('ArtifactChip', () => {
  it('文档胶囊点击走 onOpenPath，无原生 title', () => {
    const onOpenPath = vi.fn();
    const { container } = render(
      <ArtifactChip label="纪要.md" path="docs/纪要.md" onOpenPath={onOpenPath} />
    );
    expect(container.querySelector('[data-flow-artifact="document"]')).not.toBeNull();
    expect(container.querySelector('[title]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /已生成/ }));
    expect(onOpenPath).toHaveBeenCalledWith('docs/纪要.md');
  });
});
