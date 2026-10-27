import { describe, it, expect, beforeEach } from 'vitest';
import { CompositionPatchBuffer } from './CompositionPatchBuffer';
import type { ProjectionDiff } from '@crish/block-paper-contract';

describe('CompositionPatchBuffer', () => {
  let buffer: CompositionPatchBuffer;

  beforeEach(() => {
    buffer = new CompositionPatchBuffer();
  });

  it('初始状态为 idle，无活动块，队列为空', () => {
    expect(buffer.getIsComposing()).toBe(false);
    expect(buffer.getActiveBlockId()).toBeNull();
    expect(buffer.getQueueLength()).toBe(0);
    expect(buffer.getQueue()).toEqual([]);
  });

  it('beginComposition 成功开启合成态并记录活动块', () => {
    buffer.beginComposition('blk-1', 'doc-1');
    expect(buffer.getIsComposing()).toBe(true);
    expect(buffer.getActiveBlockId()).toBe('blk-1');
    expect(buffer.getActiveDocId()).toBe('doc-1');
    expect(buffer.isBlockComposing('blk-1')).toBe(true);
    expect(buffer.isBlockComposing('blk-2')).toBe(false);
  });

  it('beginComposition 空 blockId 或 docId 抛出异常', () => {
    expect(() => buffer.beginComposition('', 'doc-1')).toThrow('不可为空');
    expect(() => buffer.beginComposition('blk-1', '')).toThrow('不可为空');
  });

  it('活跃合成重复 start 会拒绝且保留已暂存补丁', () => {
    buffer.beginComposition('blk-active', 'doc-1');
    const diff: ProjectionDiff = {
      docId: 'doc-1',
      rev: 2,
      upserts: [],
      removes: [],
      textTouches: ['blk-active'],
    };
    buffer.intercept(diff);

    expect(() => buffer.beginComposition('blk-next', 'doc-2')).toThrow(
      '仍在合成'
    );
    expect(buffer.getActiveBlockId()).toBe('blk-active');
    expect(buffer.getActiveDocId()).toBe('doc-1');
    expect(buffer.getQueue()).toHaveLength(1);
    expect(buffer.endComposition().map((patch) => patch.diff)).toEqual([diff]);
  });

  it('非合成态时 intercept 一律直接放行', () => {
    const diff: ProjectionDiff = {
      docId: 'doc-1',
      rev: 1,
      upserts: [{ id: 'blk-1', props: {} }],
      removes: [],
      textTouches: ['blk-1'],
    };

    const result = buffer.intercept(diff);
    expect(result.passThrough).toBe(true);
    expect(result.buffered).toBe(false);
    expect(buffer.getQueueLength()).toBe(0);
  });

  it('合成态时对异块 diff 直接放行', () => {
    buffer.beginComposition('blk-active', 'doc-1');

    const diffOther: ProjectionDiff = {
      docId: 'doc-1',
      rev: 2,
      upserts: [{ id: 'blk-other', props: { text: 'hello' } }],
      removes: ['blk-deleted'],
      textTouches: ['blk-other'],
    };

    const result = buffer.intercept(diffOther);
    expect(result.passThrough).toBe(true);
    expect(result.buffered).toBe(false);
    expect(buffer.getQueueLength()).toBe(0);
  });

  it('合成态时对当前活动块的 textTouches 拦截并暂存', () => {
    buffer.beginComposition('blk-active', 'doc-1');

    const diffTouch: ProjectionDiff = {
      docId: 'doc-1',
      rev: 3,
      upserts: [],
      removes: [],
      textTouches: ['blk-active'],
    };

    const result = buffer.intercept(diffTouch);
    expect(result.passThrough).toBe(false);
    expect(result.buffered).toBe(true);
    expect(buffer.getQueueLength()).toBe(1);

    const queue = buffer.getQueue();
    expect(queue[0]!.id).toBe('blk-active');
    expect(queue[0]!.type).toBe('text_edit');
    expect(queue[0]!.diff).toBe(diffTouch);
    expect(typeof queue[0]!.timestamp).toBe('number');
  });

  it('合成态时对当前活动块的 upsert 拦截并暂存', () => {
    buffer.beginComposition('blk-active', 'doc-1');

    const diffUpsert: ProjectionDiff = {
      docId: 'doc-1',
      rev: 4,
      upserts: [{ id: 'blk-active', props: { title: 'updated' } }],
      removes: [],
      textTouches: [],
    };

    const result = buffer.intercept(diffUpsert);
    expect(result.passThrough).toBe(false);
    expect(result.buffered).toBe(true);
    expect(buffer.getQueueLength()).toBe(1);
    expect(buffer.getQueue()[0]!.type).toBe('text_edit');
  });

  it('合成态时对当前活动块的 removes 拦截并暂存为 structure 结构补丁', () => {
    buffer.beginComposition('blk-active', 'doc-1');

    const diffRemove: ProjectionDiff = {
      docId: 'doc-1',
      rev: 5,
      upserts: [],
      removes: ['blk-active'],
      textTouches: [],
    };

    const result = buffer.intercept(diffRemove);
    expect(result.passThrough).toBe(false);
    expect(result.buffered).toBe(true);
    expect(buffer.getQueueLength()).toBe(1);
    expect(buffer.getQueue()[0]!.type).toBe('structure');
  });

  it('endComposition 结束合成并清空返回全部暂存补丁', () => {
    buffer.beginComposition('blk-active', 'doc-1');

    const diff1: ProjectionDiff = {
      docId: 'doc-1',
      rev: 6,
      upserts: [],
      removes: [],
      textTouches: ['blk-active'],
    };
    const diff2: ProjectionDiff = {
      docId: 'doc-1',
      rev: 7,
      upserts: [{ id: 'blk-active', props: {} }],
      removes: [],
      textTouches: [],
    };

    buffer.intercept(diff1);
    buffer.intercept(diff2);
    expect(buffer.getQueueLength()).toBe(2);

    const flushed = buffer.endComposition();
    expect(flushed).toHaveLength(2);
    expect(flushed[0]!.diff).toBe(diff1);
    expect(flushed[1]!.diff).toBe(diff2);

    // 状态复位
    expect(buffer.getIsComposing()).toBe(false);
    expect(buffer.getActiveBlockId()).toBeNull();
    expect(buffer.getActiveDocId()).toBeNull();
    expect(buffer.getQueueLength()).toBe(0);
  });

  it('取消合成会交还缓冲补丁，下一文档不会继承旧队列', () => {
    buffer.beginComposition('blk-active', 'doc-1');
    const diff: ProjectionDiff = {
      docId: 'doc-1',
      rev: 8,
      upserts: [],
      removes: ['blk-active'],
      textTouches: [],
    };
    buffer.intercept(diff);
    expect(buffer.getQueueLength()).toBe(1);

    expect(buffer.cancelComposition().map((patch) => patch.diff)).toEqual([
      diff,
    ]);
    expect(buffer.getIsComposing()).toBe(false);
    expect(buffer.getActiveBlockId()).toBeNull();
    expect(buffer.getQueueLength()).toBe(0);

    buffer.beginComposition('blk-active', 'doc-2');
    expect(buffer.getQueueLength()).toBe(0);
    expect(
      buffer.intercept({
        docId: 'doc-1',
        rev: 9,
        upserts: [],
        removes: ['blk-active'],
        textTouches: [],
      })
    ).toMatchObject({ passThrough: true, buffered: false });
    expect(buffer.getQueueLength()).toBe(0);
  });

  it('相同 blockId 的异文档 diff 不会污染当前合成队列', () => {
    buffer.beginComposition('blk-shared', 'doc-active');
    const otherDocDiff: ProjectionDiff = {
      docId: 'doc-other',
      rev: 10,
      upserts: [],
      removes: ['blk-shared'],
      textTouches: [],
    };
    expect(buffer.intercept(otherDocDiff)).toMatchObject({
      passThrough: true,
      buffered: false,
    });
    expect(buffer.getQueueLength()).toBe(0);
  });

  it('clear 结束会话时返回暂存补丁而不是丢弃', () => {
    buffer.beginComposition('blk-active', 'doc-1');
    const diff: ProjectionDiff = {
      docId: 'doc-1',
      rev: 11,
      upserts: [],
      removes: [],
      textTouches: ['blk-active'],
    };
    buffer.intercept(diff);

    expect(buffer.clear().map((patch) => patch.diff)).toEqual([diff]);
    expect(buffer.getIsComposing()).toBe(false);
    expect(buffer.getQueueLength()).toBe(0);
  });
});
