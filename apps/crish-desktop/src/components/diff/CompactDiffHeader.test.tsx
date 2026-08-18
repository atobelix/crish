/** @vitest-environment jsdom */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DiffHeaderControls } from './DiffHeaderControls';
import { formatGitPatch } from './GitPatchFormatter';
import type { FileDiff } from '../../store/types';

describe('DiffHeaderControls & GitPatchFormatter', () => {
  const sampleDiff: FileDiff = {
    filePath: 'apps/crish-desktop/src/components/A.tsx',
    additions: 1,
    deletions: 1,
    changes: [
      { type: 'normal', content: ' line1' },
      { type: 'deletion', content: '-old line' },
      { type: 'addition', content: '+new line' },
    ],
  };

  it('formats FileDiff to standard Git Unified Patch', () => {
    const patch = formatGitPatch(sampleDiff);
    expect(patch).toContain(
      'diff --git a/apps/crish-desktop/src/components/A.tsx b/apps/crish-desktop/src/components/A.tsx'
    );
    expect(patch).toContain('--- a/apps/crish-desktop/src/components/A.tsx');
    expect(patch).toContain('+++ b/apps/crish-desktop/src/components/A.tsx');
    expect(patch).toContain('@@ -1,1 +1,1 @@');
    expect(patch).toContain('-old line');
    expect(patch).toContain('+new line');
  });

  it('renders 34px compact toolbar with source toggle and copy patch', () => {
    const onCopyPatch = vi.fn();
    const onViewModeChange = vi.fn();
    const onSourceModeChange = vi.fn();

    render(
      <DiffHeaderControls
        sourceMode="session"
        diffViewMode="unified"
        searchOpen={false}
        searchActive={false}
        gitLoading={false}
        applyBusy={false}
        busy={false}
        turnKey="__all__"
        turnOptions={[{ value: '__all__', label: '本会话全部 AI 改动' }]}
        branches={['main']}
        currentBranch="main"
        commitPanelOpen={false}
        fileListLength={1}
        current={sampleDiff}
        onViewModeChange={onViewModeChange}
        onSearchOpenChange={() => {}}
        onSourceModeChange={onSourceModeChange}
        onTurnSelect={() => {}}
        onBranchChange={() => {}}
        onCommitPanelToggle={() => {}}
        onCopyPatch={onCopyPatch}
        onClear={() => {}}
      />
    );

    const toolbar = screen.getByRole('toolbar', { name: '紧凑变更工具栏' });
    expect(toolbar).toBeTruthy();

    const copyBtn = screen.getByLabelText('复制 Patch');
    expect(copyBtn).toBeTruthy();
    fireEvent.click(copyBtn);
    expect(onCopyPatch).toHaveBeenCalledTimes(1);
  });
});
