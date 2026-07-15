import { beforeEach, describe, expect, it, vi } from 'vitest';

// 必须在 layoutStore 导入前安装 localStorage（vitest node 环境无 DOM）
vi.hoisted(() => {
  if (typeof globalThis.localStorage !== 'undefined') return;
  const map = new Map<string, string>();
  const ls = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true });
});

import { useLayoutStore } from '../store/layoutStore';
import type { FileDiff } from '../store/types';
import { publishToolDiffs } from './publishToolDiffs';
import { resolveToolDiffs } from './toolFeedback';

function sampleDiff(path: string): FileDiff {
  return {
    filePath: path,
    additions: 1,
    deletions: 0,
    changes: [{ type: 'addition', content: 'x' }],
  };
}

describe('publishToolDiffs (collaborator success path)', () => {
  beforeEach(() => {
    useLayoutStore.setState({
      diffFiles: [],
      activeDiffSource: null,
    });
  });

  it('updates store.diffFiles when called outside immer set', () => {
    const files = resolveToolDiffs({
      name: 'search_replace',
      args: JSON.stringify({
        path: 'src/collab.ts',
        old_string: 'a',
        new_string: 'b',
      }),
      output: 'OK',
    });
    expect(files.length).toBe(1);

    // 与 AgentCard / InlineAgentPanel / ChatCard 修正后的顺序一致
    publishToolDiffs(files);

    const st = useLayoutStore.getState();
    expect(st.diffFiles.some((f) => f.filePath === 'src/collab.ts')).toBe(true);
    expect(st.activeDiffSource?.filePath).toBe('src/collab.ts');
  });

  it('nested pushDiffFile inside immer set is discarded (regression guard)', () => {
    useLayoutStore.setState(() => {
      const resolved = [sampleDiff('src/nested-bug.ts')];
      const push = useLayoutStore.getState().pushDiffFile;
      resolved.forEach((d) => push(d));
    });
    expect(useLayoutStore.getState().diffFiles.some((f) => f.filePath === 'src/nested-bug.ts')).toBe(
      false,
    );

    publishToolDiffs([sampleDiff('src/nested-bug.ts')]);
    expect(useLayoutStore.getState().diffFiles.some((f) => f.filePath === 'src/nested-bug.ts')).toBe(
      true,
    );
  });

  it('no-ops on empty list', () => {
    publishToolDiffs([]);
    publishToolDiffs(null);
    expect(useLayoutStore.getState().diffFiles).toEqual([]);
  });
});
