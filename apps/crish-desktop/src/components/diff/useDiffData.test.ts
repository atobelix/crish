// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDiffData } from './useDiffData';
import type { FileDiff, SessionMessage } from '../../store/types';

describe('useDiffData - session-merged & AI turn routing (Task 4)', () => {
  it('properly resolves session-merged diffs in computedChangesByFile and unifiedRenderCache', async () => {
    const fileTurn1: FileDiff = {
      filePath: 'src/app.ts',
      additions: 2,
      deletions: 0,
      changes: [
        { type: 'addition', content: 'const a = 1;' },
        { type: 'addition', content: 'const b = 2;' },
      ],
    };

    const fileTurn2: FileDiff = {
      filePath: 'src/app.ts',
      additions: 1,
      deletions: 1,
      changes: [
        { type: 'deletion', content: 'const b = 2;' },
        { type: 'addition', content: 'const b = 20;' },
      ],
    };

    const session = {
      messages: [
        {
          id: 'msg-turn-1',
          sender: 'assistant' as const,
          status: 'done' as const,
          timestamp: 1000,
          toolCalls: [
            {
              id: 'call-1',
              name: 'edit_file',
              diffs: [fileTurn1],
            },
          ],
        },
        {
          id: 'msg-turn-2',
          sender: 'assistant' as const,
          status: 'done' as const,
          timestamp: 2000,
          toolCalls: [
            {
              id: 'call-2',
              name: 'edit_file',
              diffs: [fileTurn2],
            },
          ],
        },
      ] as SessionMessage[],
    };

    // diffFiles originally has only turn 2 or minimal diff
    const initialFiles = [fileTurn2];

    const { result } = renderHook(() =>
      useDiffData({
        session,
        diffFiles: initialFiles,
        activeDiffSource: null,
        diffSearchQuery: '',
        diffViewMode: 'unified',
        sourceMode: 'session',
      })
    );

    // In session mode, default compare mode is 'session-merged'
    expect(result.current.getFileCompareMode('src/app.ts')).toBe('session-merged');

    // getFileDiffData must return merged session diff
    const mergedDiff = result.current.getFileDiffData(initialFiles[0]!);
    expect(mergedDiff).not.toBeNull();
    expect(mergedDiff?.filePath).toBe('src/app.ts');

    // computedChangesByFile must contain changes from merged session (not 0/empty, not collapsed)
    const computed = result.current.computedChangesByFile.get('src/app.ts');
    expect(computed).toBeDefined();
    expect(computed!.length).toBeGreaterThan(0);

    // unifiedRenderCache must also contain rendered items from merged session
    const unified = result.current.unifiedRenderCache.get('src/app.ts');
    expect(unified).toBeDefined();
    expect(unified!.length).toBeGreaterThan(0);

    // Switch compare mode to turn 1
    await act(async () => {
      await result.current.changeFileCompareMode('src/app.ts', 'turn-msg-turn-1');
    });

    expect(result.current.getFileCompareMode('src/app.ts')).toBe('turn-msg-turn-1');
    const turn1Computed = result.current.computedChangesByFile.get('src/app.ts');
    expect(turn1Computed).toBeDefined();
    expect(turn1Computed!.length).toBe(2);
    expect(turn1Computed![0]?.change.content).toBe('const a = 1;');
  });
});
