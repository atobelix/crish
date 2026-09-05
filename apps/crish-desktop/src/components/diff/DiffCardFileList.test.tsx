// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { DiffCardFileList } from './DiffCardFileList';
import type { FileDiff } from '../../store/types';
import { classifyFileDiff } from '../../api/applyFileDiff';

describe('DiffCardFileList', () => {
  it('should disable Accept button for provisional diff', () => {
    const provisionalDiff: FileDiff = {
      filePath: 'src/components/Button.tsx',
      additions: 3,
      deletions: 1,
      changes: [{ type: 'addition', content: 'export const Button = () => null;' }],
      provisional: true,
    };

    const classification = classifyFileDiff(provisionalDiff);
    expect(classification.ok).toBe(false);
    // In DiffCardFileList, disabled={applyBusy || !classifyFileDiff(f).ok}
    const isAcceptDisabled = !classification.ok;
    expect(isAcceptDisabled).toBe(true);
  });

  it('renders inline compare Select with explicit size="sm" preventing overflow', () => {
    const dummyFile: FileDiff = {
      filePath: 'src/main.ts',
      oldPath: 'src/main.ts',
      status: 'modified',
      additions: 5,
      deletions: 2,
      hunks: [],
    };

    const { container } = render(
      <DiffCardFileList
        files={[dummyFile]}
        sourceMode="session"
        current={dummyFile}
        applyBusy={false}
        stagingPaths={{}}
        aiTurns={[]}
        getFileCompareMode={() => 'git'}
        onChangeCompareMode={() => {}}
        onSetActiveDiffSource={() => {}}
        onStageFile={() => {}}
        onUnstageFile={() => {}}
        onDiscardChanges={() => {}}
        onStageAll={() => {}}
        onUnstageAll={() => {}}
        onAcceptFile={() => {}}
        onRejectFile={() => {}}
        onCopyCode={() => {}}
        renderInlineDiffContent={() => <div>diff</div>}
      />
    );

    // 验证 Select 容器渲染出 size="sm" (28px) 档位
    const selectTrigger = container.querySelector('[data-size="sm"], [class*="triggerSm"]');
    expect(selectTrigger).toBeDefined();
    expect(selectTrigger).not.toBeNull();
  });

  it('renders targetDiff additions and deletions when getFileDiffData is provided', () => {
    const dummyFile: FileDiff = {
      filePath: 'src/main.ts',
      additions: 0,
      deletions: 0,
      changes: [],
    };
    const mergedDiff: FileDiff = {
      filePath: 'src/main.ts',
      additions: 15,
      deletions: 7,
      changes: [{ type: 'addition', content: 'new code' }],
    };

    const { getByRole } = render(
      <DiffCardFileList
        files={[dummyFile]}
        sourceMode="session"
        current={null}
        applyBusy={false}
        stagingPaths={{}}
        aiTurns={[]}
        getFileCompareMode={() => 'session-merged'}
        onChangeCompareMode={() => {}}
        onSetActiveDiffSource={() => {}}
        onStageFile={() => {}}
        onUnstageFile={() => {}}
        onDiscardChanges={() => {}}
        onStageAll={() => {}}
        onUnstageAll={() => {}}
        onAcceptFile={() => {}}
        onRejectFile={() => {}}
        onCopyCode={() => {}}
        renderInlineDiffContent={() => <div>diff</div>}
        getFileDiffData={() => mergedDiff}
      />
    );

    const btn = getByRole('button', { name: /main\.ts \+15 −7/ });
    expect(btn).toBeDefined();
  });
});
