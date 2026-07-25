import { describe, expect, it } from 'vitest';
import {
  emptyReasonLabel,
  filterPathsByQuery,
  hitBasename,
  hitDirname,
  normalizeFileHit,
  normalizeFileHits,
  resolveEmptyReason,
  simpleSubsequenceScore,
  QUICK_OPEN_RESULT_LIMIT,
} from './quickOpenHelpers';

describe('normalizeFileHit', () => {
  it('accepts camelCase', () => {
    expect(
      normalizeFileHit({ path: 'src/a.ts', score: 12, matchIndices: [0, 1] }),
    ).toEqual({ path: 'src/a.ts', score: 12, matchIndices: [0, 1] });
  });

  it('accepts snake_case match_indices', () => {
    expect(
      normalizeFileHit({ path: 'b.rs', score: 3, match_indices: [1] }),
    ).toEqual({ path: 'b.rs', score: 3, matchIndices: [1] });
  });

  it('rejects empty path', () => {
    expect(normalizeFileHit({ path: '  ', score: 1 })).toBeNull();
    expect(normalizeFileHit(null)).toBeNull();
  });
});

describe('normalizeFileHits', () => {
  it('caps at limit', () => {
    const raw = Array.from({ length: 50 }, (_, i) => ({
      path: `f${i}.ts`,
      score: i,
    }));
    expect(normalizeFileHits(raw, 20)).toHaveLength(20);
    expect(normalizeFileHits(raw)).toHaveLength(QUICK_OPEN_RESULT_LIMIT);
  });
});

describe('path display', () => {
  it('basename / dirname with mixed separators', () => {
    expect(hitBasename('C:\\proj\\src\\App.tsx')).toBe('App.tsx');
    expect(hitDirname('C:\\proj\\src\\App.tsx')).toBe('C:/proj/src');
    expect(hitDirname('only.ts')).toBe('');
  });
});

describe('resolveEmptyReason', () => {
  it('idle when no query', () => {
    expect(
      resolveEmptyReason({ query: '', loading: false, hits: [] }),
    ).toBe('idle');
  });

  it('loading takes precedence', () => {
    expect(
      resolveEmptyReason({ query: 'x', loading: true, hits: [] }),
    ).toBe('loading');
  });

  it('no_match when query yields zero hits and index is ready', () => {
    expect(
      resolveEmptyReason({
        query: 'foo',
        loading: false,
        hits: [],
        indexReady: true,
      }),
    ).toBe('no_match');
  });

  it('index_not_ready only when explicitly not ready', () => {
    expect(
      resolveEmptyReason({
        query: 'foo',
        loading: false,
        hits: [],
        indexReady: false,
      }),
    ).toBe('index_not_ready');
  });

  it('unknown indexReady with zero hits is no_match (not fake index_not_ready)', () => {
    expect(
      resolveEmptyReason({
        query: 'foo',
        loading: false,
        hits: [],
      }),
    ).toBe('no_match');
    expect(
      resolveEmptyReason({
        query: 'foo',
        loading: false,
        hits: [],
        indexReady: undefined,
      }),
    ).toBe('no_match');
  });

  it('does not report index_not_ready when ready and zero hits', () => {
    const reason = resolveEmptyReason({
      query: 'zzz_no_such_file',
      loading: false,
      hits: [],
      indexReady: true,
    });
    expect(reason).toBe('no_match');
    expect(reason).not.toBe('index_not_ready');
    expect(emptyReasonLabel(reason!)).toBe('无匹配文件');
  });

  it('null when hits present', () => {
    expect(
      resolveEmptyReason({
        query: 'a',
        loading: false,
        hits: [{ path: 'a.ts', score: 1, matchIndices: [] }],
      }),
    ).toBeNull();
  });

  it('unavailable / no_workspace', () => {
    expect(
      resolveEmptyReason({
        query: 'a',
        loading: false,
        hits: [],
        unavailable: true,
      }),
    ).toBe('unavailable');
    expect(
      resolveEmptyReason({
        query: '',
        loading: false,
        hits: [],
        hasWorkspace: false,
      }),
    ).toBe('no_workspace');
  });

  it('unavailable takes precedence over index_not_ready', () => {
    expect(
      resolveEmptyReason({
        query: 'foo',
        loading: false,
        hits: [],
        unavailable: true,
        indexReady: false,
      }),
    ).toBe('unavailable');
  });
});

describe('emptyReasonLabel', () => {
  it('returns 索引未就绪', () => {
    expect(emptyReasonLabel('index_not_ready')).toBe('索引未就绪');
  });
});

describe('simpleSubsequenceScore / filterPathsByQuery', () => {
  it('scores subsequence matches', () => {
    expect(simpleSubsequenceScore('app', 'src/App.tsx')).not.toBeNull();
    expect(simpleSubsequenceScore('zzz', 'src/App.tsx')).toBeNull();
  });

  it('filters and limits', () => {
    const paths = ['src/App.tsx', 'src/api/foo.ts', 'README.md', 'lib/bar.rs'];
    const hits = filterPathsByQuery(paths, 'app', 2);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(2);
    expect(hits[0].path.toLowerCase()).toContain('app');
  });
});
