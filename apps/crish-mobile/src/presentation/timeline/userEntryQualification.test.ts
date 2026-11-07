// R8 用户行一次性入场资格单测：append-only 增长资格化、首挂/恢复/切会话/
// 截断收缩一律不资格化；行级一次性守卫同 id 只消耗一次、有界 FIFO 驱逐。
import type { TimelineBlock } from './buildTimeline';
import {
  appendedUserEntryIds,
  consumeUserEntryAnimation,
  resetUserEntryAnimationForTest,
  USER_ENTRY_ANIMATED_MAX,
} from './userEntryQualification';

function userBlock(id: string): TimelineBlock {
  return {
    kind: 'message',
    id,
    role: 'user',
    text: `u-${id}`,
    streaming: false,
    atMs: 1,
  };
}

function assistantBlock(id: string): TimelineBlock {
  return {
    kind: 'message',
    id,
    role: 'assistant',
    text: `a-${id}`,
    streaming: false,
    atMs: 1,
  };
}

function ids(blocks: readonly TimelineBlock[]): string[] {
  return blocks.map((b) => b.id);
}

describe('appendedUserEntryIds（R8 append-only 资格）', () => {
  it('首挂全量（历史/恢复）：一律不资格化', () => {
    const blocks = [userBlock('m1'), assistantBlock('m2'), userBlock('m3')];
    const qualified = appendedUserEntryIds([], ids(blocks), blocks);
    expect(qualified.size).toBe(0);
  });

  it('append-only 追加：新增段中的用户行获得资格，助手行不资格', () => {
    const prev = [userBlock('m1'), assistantBlock('m2')];
    const current = [...prev, assistantBlock('m3'), userBlock('m4')];
    const qualified = appendedUserEntryIds(ids(prev), ids(current), current);
    expect(qualified.has('m4')).toBe(true);
    expect(qualified.has('m3')).toBe(false);
    expect(qualified.size).toBe(1);
  });

  it('流式重投影（无新增）：空资格', () => {
    const prev = [userBlock('m1')];
    const qualified = appendedUserEntryIds(ids(prev), ids(prev), prev);
    expect(qualified.size).toBe(0);
  });

  it('会话切换（整表替换）：不资格化', () => {
    const prev = [userBlock('a1'), assistantBlock('a2')];
    const next = [userBlock('b1')];
    const qualified = appendedUserEntryIds(ids(prev), ids(next), next);
    expect(qualified.size).toBe(0);
  });

  it('截断/重新生成（收缩或错位）：不资格化', () => {
    const prev = [userBlock('m1'), assistantBlock('m2'), userBlock('m3')];
    const truncated = [userBlock('m1')];
    expect(
      appendedUserEntryIds(ids(prev), ids(truncated), truncated).size
    ).toBe(0);
    // 错位（中途插入导致前缀断裂）
    const shifted = [userBlock('m1'), userBlock('mx'), assistantBlock('m2')];
    expect(appendedUserEntryIds(ids(prev), ids(shifted), shifted).size).toBe(0);
  });
});

describe('consumeUserEntryAnimation（R8 行级一次性守卫）', () => {
  beforeEach(() => {
    resetUserEntryAnimationForTest();
  });

  it('同 id 首次 true、此后恒 false（重挂/切回不重播）', () => {
    expect(consumeUserEntryAnimation('row-1')).toBe(true);
    expect(consumeUserEntryAnimation('row-1')).toBe(false);
    expect(consumeUserEntryAnimation('row-1')).toBe(false);
  });

  it('不同 id 互不影响', () => {
    expect(consumeUserEntryAnimation('row-a')).toBe(true);
    expect(consumeUserEntryAnimation('row-b')).toBe(true);
    expect(consumeUserEntryAnimation('row-a')).toBe(false);
  });

  it('有界 FIFO：超出上限驱逐最旧 id（该 id 可再次消耗）', () => {
    for (let i = 0; i < USER_ENTRY_ANIMATED_MAX; i += 1) {
      consumeUserEntryAnimation(`bulk-${i}`);
    }
    expect(consumeUserEntryAnimation('bulk-0')).toBe(false);
    // 再进一条触发驱逐最旧 bulk-0
    expect(consumeUserEntryAnimation('overflow-1')).toBe(true);
    expect(consumeUserEntryAnimation('bulk-0')).toBe(true);
  });
});
