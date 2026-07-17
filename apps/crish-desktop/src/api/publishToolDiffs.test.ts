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
import {
  coalescePublishableDiffs,
  diffPublishScore,
  extractPublishablePaths,
  filterPublishableDiffs,
  isMissingBaseDiff,
  isPublishableDiff,
  normalizeDiffFilePath,
  preparePublishableDiff,
  publishToolDiffs,
  resolvePublishDiffConflict,
} from './publishToolDiffs';
import { resolveToolDiffs } from './toolFeedback';

function sampleDiff(path: string, extra?: Partial<FileDiff>): FileDiff {
  return {
    filePath: path,
    additions: 1,
    deletions: 0,
    changes: [{ type: 'addition', content: 'x' }],
    ...extra,
  };
}

function placeholderDiff(path: string): FileDiff {
  return {
    filePath: path,
    additions: 0,
    deletions: 0,
    changes: [{ type: 'normal', content: '文件已更新' }],
  };
}

function emptyDiff(path: string): FileDiff {
  return {
    filePath: path,
    additions: 0,
    deletions: 0,
    changes: [],
  };
}

describe('normalizeDiffFilePath / extract paths', () => {
  it('normalizes backslash, ./, duplicate slashes, trailing slash', () => {
    expect(normalizeDiffFilePath('src\\foo\\bar.ts')).toBe('src/foo/bar.ts');
    expect(normalizeDiffFilePath('./src/foo.ts')).toBe('src/foo.ts');
    expect(normalizeDiffFilePath('src//foo///bar.ts')).toBe('src/foo/bar.ts');
    expect(normalizeDiffFilePath('src/foo.ts/')).toBe('src/foo.ts');
    expect(normalizeDiffFilePath('  src/a.ts  ')).toBe('src/a.ts');
  });

  it('rejects empty, null byte, traversal, placeholders', () => {
    expect(normalizeDiffFilePath('')).toBeNull();
    expect(normalizeDiffFilePath(null)).toBeNull();
    expect(normalizeDiffFilePath(undefined)).toBeNull();
    expect(normalizeDiffFilePath('a\0b.ts')).toBeNull();
    expect(normalizeDiffFilePath('../escape.ts')).toBeNull();
    expect(normalizeDiffFilePath('foo/../bar.ts')).toBeNull();
    expect(normalizeDiffFilePath('变更')).toBeNull();
    expect(normalizeDiffFilePath('unknown')).toBeNull();
  });

  it('keeps drive and posix absolute shapes', () => {
    expect(normalizeDiffFilePath('C:\\proj\\a.ts')).toBe('C:/proj/a.ts');
    expect(normalizeDiffFilePath('/abs/path/a.ts')).toBe('/abs/path/a.ts');
  });

  it('strips shell quotes and rejects reserved / nested placeholders', () => {
    expect(normalizeDiffFilePath('"src/quoted.ts"')).toBe('src/quoted.ts');
    expect(normalizeDiffFilePath("'src/quoted.ts'")).toBe('src/quoted.ts');
    expect(normalizeDiffFilePath('CON')).toBeNull();
    expect(normalizeDiffFilePath('src/nul.txt')).toBeNull();
    expect(normalizeDiffFilePath('dir/unknown')).toBeNull();
    expect(normalizeDiffFilePath('C:/')).toBeNull();
    expect(normalizeDiffFilePath('.')).toBeNull();
  });

  it('extractPublishablePaths returns unique normalized paths in order', () => {
    const paths = extractPublishablePaths([
      sampleDiff('src\\a.ts'),
      sampleDiff('./src/b.ts'),
      sampleDiff('src/a.ts'), // same key as first
      emptyDiff('src/c.ts'),
      sampleDiff('src/d.ts'),
    ]);
    expect(paths).toEqual(['src/a.ts', 'src/b.ts', 'src/d.ts']);
  });
});

describe('prepare / isPublishable / score / conflict', () => {
  it('preparePublishableDiff normalizes path and drops empty content', () => {
    const ok = preparePublishableDiff(sampleDiff('src\\x.ts'));
    expect(ok?.filePath).toBe('src/x.ts');
    expect(preparePublishableDiff(emptyDiff('src/x.ts'))).toBeNull();
    expect(preparePublishableDiff(null)).toBeNull();
  });

  it('preparePublishableDiff drops illegal changes and clamps negative stats', () => {
    const cleaned = preparePublishableDiff({
      filePath: 'src/y.ts',
      additions: -3,
      deletions: Number.NaN,
      changes: [
        { type: 'addition', content: 'ok' },
        // @ts-expect-error intentional garbage type
        { type: 'add', content: 'bad' },
        { type: 'deletion', content: 1 as unknown as string },
        null as unknown as { type: 'normal'; content: string },
      ],
    });
    expect(cleaned).toEqual({
      filePath: 'src/y.ts',
      additions: 0,
      deletions: 0,
      changes: [{ type: 'addition', content: 'ok' }],
    });
    // 全非法 change 且无统计 → 不可发布
    expect(
      preparePublishableDiff({
        filePath: 'src/z.ts',
        additions: 0,
        deletions: 0,
        changes: [{ type: 'add' as 'addition', content: 'nope' }],
      }),
    ).toBeNull();
  });

  it('isPublishableDiff requires safe path and content', () => {
    expect(isPublishableDiff(sampleDiff('a.ts'))).toBe(true);
    expect(isPublishableDiff(sampleDiff(''))).toBe(false);
    expect(isPublishableDiff(sampleDiff('../x'))).toBe(false);
    expect(isPublishableDiff(emptyDiff('ok.ts'))).toBe(false);
    expect(isPublishableDiff(placeholderDiff('ok.ts'))).toBe(true);
  });

  it('diffPublishScore ranks real edits above missing-base placeholders', () => {
    expect(diffPublishScore(sampleDiff('a.ts'))).toBeGreaterThan(
      diffPublishScore(placeholderDiff('a.ts')),
    );
    expect(isMissingBaseDiff(placeholderDiff('a.ts'))).toBe(true);
    expect(isMissingBaseDiff(sampleDiff('a.ts'))).toBe(false);
  });

  it('resolvePublishDiffConflict keeps richer base when incoming is missing base', () => {
    const base = sampleDiff('a.ts', {
      additions: 2,
      changes: [
        { type: 'deletion', content: 'old' },
        { type: 'addition', content: 'new' },
      ],
    });
    const weak = placeholderDiff('a.ts');
    expect(resolvePublishDiffConflict(base, weak)).toBe(base);
    // 后写更强 → 用后写
    const richer = sampleDiff('a.ts', {
      additions: 3,
      changes: [
        { type: 'addition', content: '1' },
        { type: 'addition', content: '2' },
        { type: 'addition', content: '3' },
      ],
    });
    expect(resolvePublishDiffConflict(base, richer)).toBe(richer);
  });
});

describe('multi-file coalesce / filter', () => {
  it('filterPublishableDiffs drops junk and keeps real files', () => {
    const out = filterPublishableDiffs([
      sampleDiff('src/a.ts'),
      sampleDiff('变更'),
      sampleDiff('../escape.ts'),
      emptyDiff('empty.ts'),
      placeholderDiff('placeholder.ts'),
    ]);
    expect(out.map((f) => f.filePath)).toEqual(['src/a.ts', 'placeholder.ts']);
  });

  it('coalescePublishableDiffs merges multi-file batch by normalized path', () => {
    const out = coalescePublishableDiffs([
      sampleDiff('src\\a.ts', {
        additions: 1,
        changes: [{ type: 'addition', content: 'first' }],
      }),
      sampleDiff('src/b.ts'),
      // 同 path 反斜杠形式；更强内容应胜出
      sampleDiff('./src/a.ts', {
        additions: 2,
        changes: [
          { type: 'addition', content: 'second-1' },
          { type: 'addition', content: 'second-2' },
        ],
      }),
      // 弱占位不得覆盖 b 的真实内容
      placeholderDiff('src\\b.ts'),
    ]);
    expect(out.map((f) => f.filePath)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(out[0].changes.map((c) => c.content)).toEqual(['second-1', 'second-2']);
    // b 保留真实 addition，不被 placeholder 覆盖
    expect(out[1].changes[0]?.type).toBe('addition');
  });
});

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
    const n = publishToolDiffs(files);
    expect(n).toBe(1);

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

  it('no-ops on empty list / undefined / all junk and returns 0', () => {
    expect(publishToolDiffs([])).toBe(0);
    expect(publishToolDiffs(null)).toBe(0);
    expect(publishToolDiffs(undefined)).toBe(0);
    expect(
      publishToolDiffs([
        emptyDiff('x.ts'),
        sampleDiff(''),
        sampleDiff('../nope.ts'),
      ]),
    ).toBe(0);
    expect(useLayoutStore.getState().diffFiles).toEqual([]);
  });

  it('skips unpublishable junk (empty path / traversal / placeholder)', () => {
    publishToolDiffs([
      sampleDiff(''),
      sampleDiff('变更'),
      sampleDiff('../escape.ts'),
      emptyDiff('good.ts'),
      sampleDiff('src/keep.ts'),
    ]);
    const paths = useLayoutStore.getState().diffFiles.map((f) => f.filePath);
    expect(paths).toEqual(['src/keep.ts']);
  });

  it('publishes multi-file batch with path normalize identity', () => {
    const n = publishToolDiffs([
      sampleDiff('src\\one.ts'),
      sampleDiff('./src/two.ts'),
      sampleDiff('src//three.ts'),
      // 与 one 同 key，应只保留一条（后者覆盖）
      sampleDiff('src/one.ts', {
        additions: 2,
        changes: [
          { type: 'addition', content: 'a' },
          { type: 'addition', content: 'b' },
        ],
      }),
    ]);
    expect(n).toBe(3);
    const paths = useLayoutStore.getState().diffFiles.map((f) => f.filePath).sort();
    expect(paths).toEqual(['src/one.ts', 'src/three.ts', 'src/two.ts']);
    const one = useLayoutStore.getState().diffFiles.find((f) => f.filePath === 'src/one.ts');
    expect(one?.changes).toHaveLength(2);
  });

  it('conflict with missing base: does not clobber richer store entry', () => {
    // 先推入有 base 的完整 diff
    publishToolDiffs([
      sampleDiff('src/conflict.ts', {
        additions: 1,
        deletions: 1,
        changes: [
          { type: 'deletion', content: 'old-line' },
          { type: 'addition', content: 'new-line' },
        ],
      }),
    ]);
    const before = useLayoutStore.getState().diffFiles.find((f) => f.filePath === 'src/conflict.ts');
    expect(before?.changes).toHaveLength(2);

    // 再推 missing-base 占位（同 path 反斜杠）——不得覆盖
    const n = publishToolDiffs([placeholderDiff('src\\conflict.ts')]);
    expect(n).toBe(0);
    const after = useLayoutStore.getState().diffFiles.find((f) => f.filePath === 'src/conflict.ts');
    expect(after?.changes).toEqual(before?.changes);
    expect(after?.changes.some((c) => c.type === 'deletion')).toBe(true);
  });

  it('allows richer incoming to replace missing-base already in store', () => {
    publishToolDiffs([placeholderDiff('src/upgrade.ts')]);
    expect(isMissingBaseDiff(useLayoutStore.getState().diffFiles[0])).toBe(true);

    const n = publishToolDiffs([
      sampleDiff('src\\upgrade.ts', {
        additions: 1,
        changes: [{ type: 'addition', content: 'real' }],
      }),
    ]);
    expect(n).toBe(1);
    const f = useLayoutStore.getState().diffFiles.find((x) => x.filePath === 'src/upgrade.ts');
    expect(f?.changes[0]).toEqual({ type: 'addition', content: 'real' });
  });

  it('removes raw path aliases so store does not accumulate duplicates', () => {
    // 模拟 Git / 其它路径写入反斜杠形式（未走 publish 规范化）
    useLayoutStore.getState().pushDiffFile({
      filePath: 'src\\alias.ts',
      additions: 0,
      deletions: 0,
      changes: [{ type: 'normal', content: '文件已更新' }],
    });
    expect(useLayoutStore.getState().diffFiles.map((f) => f.filePath)).toEqual([
      'src\\alias.ts',
    ]);

    const n = publishToolDiffs([
      sampleDiff('src/alias.ts', {
        additions: 1,
        changes: [{ type: 'addition', content: 'canonical' }],
      }),
    ]);
    expect(n).toBe(1);
    const paths = useLayoutStore.getState().diffFiles.map((f) => f.filePath);
    expect(paths).toEqual(['src/alias.ts']);
    expect(paths).not.toContain('src\\alias.ts');
    expect(
      useLayoutStore.getState().diffFiles.find((f) => f.filePath === 'src/alias.ts')
        ?.changes[0],
    ).toEqual({ type: 'addition', content: 'canonical' });
  });

  it('does not re-push when store already holds richer canonical entry', () => {
    publishToolDiffs([
      sampleDiff('src/stable.ts', {
        additions: 2,
        changes: [
          { type: 'addition', content: 'a' },
          { type: 'addition', content: 'b' },
        ],
      }),
    ]);
    const beforeActive = useLayoutStore.getState().activeDiffSource;
    // 较弱但仍有真实 +/- 的后写：score 更低 → 不覆盖、不重复 push
    const n = publishToolDiffs([
      sampleDiff('src/stable.ts', {
        additions: 1,
        changes: [{ type: 'addition', content: 'weaker' }],
      }),
    ]);
    expect(n).toBe(0);
    const after = useLayoutStore.getState().diffFiles.find((f) => f.filePath === 'src/stable.ts');
    expect(after?.changes).toHaveLength(2);
    expect(after?.changes.map((c) => c.content)).toEqual(['a', 'b']);
    // activeDiffSource 不应因无效覆盖被改写内容
    expect(useLayoutStore.getState().activeDiffSource?.changes).toEqual(beforeActive?.changes);
  });
});
