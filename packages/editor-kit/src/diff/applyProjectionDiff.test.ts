/**
 * applyProjectionDiff：默认 fullRebuild 路径 fullRemountCount === 0
 */
import { describe, expect, it } from 'vitest';
import type { ProjectionDiff } from '@crish/block-paper-contract';
import {
  applyProjectionDiff,
  createDiffApplyState,
} from './applyProjectionDiff';

function diff(
  partial: Omit<
    ProjectionDiff,
    'docId' | 'rev' | 'upserts' | 'removes' | 'textTouches'
  > &
    Partial<
      Pick<ProjectionDiff, 'upserts' | 'removes' | 'textTouches' | 'rev'>
    > & {
      rev?: number;
    }
): ProjectionDiff {
  return {
    docId: 'doc-1',
    rev: partial.rev ?? 1,
    upserts: partial.upserts ?? [],
    removes: partial.removes ?? [],
    textTouches: partial.textTouches ?? [],
    fullRebuild: false,
  };
}

describe('applyProjectionDiff', () => {
  it('默认 fullRebuild=false 路径 fullRemountCount 保持 0', () => {
    const state = createDiffApplyState('doc-1');
    const r1 = applyProjectionDiff(
      state,
      diff({
        rev: 1,
        upserts: [
          { id: 'b1', props: { t: 'hello' } },
          { id: 'b2', props: { t: 'world' }, children: [] },
        ],
      })
    );
    expect(r1.stats.didFullRemount).toBe(false);
    expect(r1.stats.fullRemountCount).toBe(0);
    expect(r1.state.fullRemountCount).toBe(0);
    expect(r1.stats.upserted).toBe(2);
    expect(state.order).toEqual(['b1', 'b2']);

    const r2 = applyProjectionDiff(
      state,
      diff({
        rev: 2,
        upserts: [{ id: 'b1', props: { t: 'HELLO' } }],
        textTouches: ['b1'],
        removes: ['b2'],
      })
    );
    expect(r2.stats.fullRemountCount).toBe(0);
    expect(r2.state.fullRemountCount).toBe(0);
    expect(r2.stats.didFullRemount).toBe(false);
    expect(r2.stats.removed).toBe(1);
    expect(r2.stats.textTouched).toBe(1);
    expect(state.blocks.get('b1')?.textEpoch).toBe(1);
    expect(state.blocks.has('b2')).toBe(false);
    expect(state.order).toEqual(['b1']);
  });

  it('省略 fullRebuild 字段亦计为默认路径（计数 0）', () => {
    const state = createDiffApplyState('doc-1');
    const d: ProjectionDiff = {
      docId: 'doc-1',
      rev: 1,
      upserts: [{ id: 'x', props: null }],
      removes: [],
      textTouches: [],
    };
    const r = applyProjectionDiff(state, d);
    expect(r.stats.fullRemountCount).toBe(0);
    expect(r.stats.didFullRemount).toBe(false);
  });

  it('未知 textTouch 不推断新建块', () => {
    const state = createDiffApplyState('doc-1');
    applyProjectionDiff(
      state,
      diff({ rev: 1, upserts: [{ id: 'a', props: {} }] })
    );
    const r = applyProjectionDiff(
      state,
      diff({ rev: 2, textTouches: ['ghost'] })
    );
    expect(r.stats.textTouched).toBe(0);
    expect(state.blocks.has('ghost')).toBe(false);
  });

  it('灾难 fullRebuild=true（逃逸）递增 fullRemountCount', () => {
    const state = createDiffApplyState('doc-1');
    applyProjectionDiff(
      state,
      diff({
        rev: 1,
        upserts: [
          { id: 'old', props: 1 },
          { id: 'gone', props: 2 },
        ],
      })
    );
    // 类型上 fullRebuild 仅允许 false；运行时灾难逃逸用断言绕过
    const disaster = {
      docId: 'doc-1',
      rev: 2,
      upserts: [{ id: 'new', props: 3 }],
      removes: [],
      textTouches: [],
      fullRebuild: true,
    } as unknown as ProjectionDiff;

    const r = applyProjectionDiff(state, disaster);
    expect(r.stats.didFullRemount).toBe(true);
    expect(r.stats.fullRemountCount).toBe(1);
    expect(state.fullRemountCount).toBe(1);
    expect(state.order).toEqual(['new']);
    expect(state.blocks.has('old')).toBe(false);
  });

  it('rev 非单调抛错', () => {
    const state = createDiffApplyState('doc-1', 5);
    expect(() =>
      applyProjectionDiff(state, diff({ rev: 3, upserts: [] }))
    ).toThrow(/非单调/);
  });

  it('docId 不匹配抛错', () => {
    const state = createDiffApplyState('doc-a');
    expect(() =>
      applyProjectionDiff(state, {
        docId: 'doc-b',
        rev: 1,
        upserts: [],
        removes: [],
        textTouches: [],
      })
    ).toThrow(/docId/);
  });
});
