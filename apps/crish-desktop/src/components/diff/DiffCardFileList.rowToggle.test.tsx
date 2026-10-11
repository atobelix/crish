// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DiffCardFileList } from './DiffCardFileList';
import type { FileDiff } from '../../store/types';

const file: FileDiff = {
  filePath: 'src/components/Button.tsx',
  oldPath: 'src/components/Button.tsx',
  status: 'modified',
  additions: 12,
  deletions: 3,
  changes: [],
};

function setup(sourceMode: 'git' | 'session' = 'git') {
  const onSetActiveDiffSource = vi.fn();
  const onStageFile = vi.fn();
  const onOpenFileViewer = vi.fn();
  render(
    <DiffCardFileList
      files={[file]}
      sourceMode={sourceMode}
      current={null}
      applyBusy={false}
      stagingPaths={{}}
      onSetActiveDiffSource={onSetActiveDiffSource}
      onStageFile={onStageFile}
      onUnstageFile={vi.fn()}
      onDiscardChanges={vi.fn()}
      onStageAll={vi.fn()}
      onUnstageAll={vi.fn()}
      onOpenFileViewer={onOpenFileViewer}
      renderInlineDiffContent={() => <div>diff</div>}
    />,
  );
  return { onSetActiveDiffSource, onStageFile, onOpenFileViewer, row: screen.getByTestId('diff-file-row') };
}

describe('差异面板文件行：整行点击切换展开（heson 2026-10-11）', () => {
  it('点行内空白处切换展开', () => {
    const { row, onSetActiveDiffSource } = setup();
    fireEvent.click(row);
    expect(onSetActiveDiffSource).toHaveBeenCalledTimes(1);
    expect(onSetActiveDiffSource).toHaveBeenCalledWith(file);
  });

  it('点文件名切换展开（不打开独立标签页）；Ctrl+单击才打开', () => {
    const { onSetActiveDiffSource, onOpenFileViewer } = setup();
    fireEvent.click(screen.getByText('Button.tsx'));
    expect(onSetActiveDiffSource).toHaveBeenCalledTimes(1);
    expect(onOpenFileViewer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Button.tsx'), { ctrlKey: true });
    expect(onOpenFileViewer).toHaveBeenCalledWith(file.filePath);
    expect(onSetActiveDiffSource).toHaveBeenCalledTimes(1);
  });

  it('点 +/- 统计切换展开', () => {
    const { onSetActiveDiffSource } = setup('session');
    fireEvent.click(screen.getByText('+12'));
    expect(onSetActiveDiffSource).toHaveBeenCalledTimes(1);
  });

  it('点功能按钮（暂存）不触发切换', () => {
    const { onSetActiveDiffSource, onStageFile, row } = setup('git');
    const stageBtn = Array.from(row.querySelectorAll('button')).find((b) => /暂存/.test(b.getAttribute('aria-label') ?? '') && !/取消/.test(b.getAttribute('aria-label') ?? ''));
    expect(stageBtn).toBeTruthy();
    fireEvent.click(stageBtn!);
    expect(onStageFile).toHaveBeenCalled();
    expect(onSetActiveDiffSource).not.toHaveBeenCalled();
  });

  it('行聚焦时 Enter / Space 切换', () => {
    const { row, onSetActiveDiffSource } = setup();
    row.focus();
    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.keyDown(row, { key: ' ' });
    expect(onSetActiveDiffSource).toHaveBeenCalledTimes(2);
  });

  it('展开按钮保留，点击只切换一次（不与整行重复触发）', () => {
    const { row, onSetActiveDiffSource } = setup();
    const toggle = row.querySelector('button[aria-expanded]') as HTMLButtonElement;
    fireEvent.click(toggle);
    expect(onSetActiveDiffSource).toHaveBeenCalledTimes(1);
  });
});
