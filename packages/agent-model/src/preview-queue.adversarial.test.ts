/**
 * PreviewQueue 对抗性测试套件
 *
 * 目标：暴露 preview-queue.ts 在 TTL 边界、payload cloning、状态转换、
 * 并发安全、Unicode 处理、BoundedMap eviction 下的隐藏 bug。
 *
 * 覆盖维度：
 *  - PQ1: TTL 边界（Infinity / NaN / 0 / 负数 / MAX_SAFE_TTL_MS）
 *  - PQ2: payload cloning（函数 / Symbol / circular / non-serializable）
 *  - PQ3: 状态转换（pending → applied/discarded/expired）
 *  - PQ4: 并发安全（operation queue serialization）
 *  - PQ5: Unicode 处理（emoji / CJK / surrogate pairs）
 *  - PQ6: BoundedMap eviction（FIFO / 上限触发）
 *  - PQ7: 时间戳溢出（nowMs + ttlMs 溢出为 Infinity）
 *  - PQ8: 空值与非法输入安全
 *  - PQ9: ID 冲突与生成器异常
 *  - PQ10: artifact 构建一致性
 *  - PQ11: 大规模压力测试
 */

import { describe, expect, it } from 'vitest';
import { PreviewQueue } from './preview-queue';

function manualClock(initial: number): {
  now: () => number;
  advance: (ms: number) => void;
  set: (ms: number) => void;
} {
  let current = initial;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
    set: (ms: number) => {
      current = ms;
    },
  };
}

function sequentialIds(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}_${++next}`;
}

function minimalRequest(overrides: Record<string, unknown> = {}) {
  return {
    action: 'edit',
    title: 'Test preview',
    payload: { path: 'src/test.ts' },
    ...overrides,
  } as any;
}

// ============================================================================
// PQ1: TTL 边界
// ============================================================================

describe('PQ1: TTL 边界', () => {
  it('PQ1a: ttlMs=Number.MAX_VALUE 应被拒绝（避免 nowMs+ttlMs=Infinity 导致 toIso 崩溃）', async () => {
    const queue = new PreviewQueue({ now: () => Date.UTC(2026, 0, 1) });
    await expect(
      queue.createPreview({ ...minimalRequest(), ttlMs: Number.MAX_VALUE })
    ).rejects.toThrow(/ttlMs|too large|positive/i);
  });

  it('PQ1b: ttlMs=Infinity 应被拒绝', async () => {
    const queue = new PreviewQueue({ now: () => Date.UTC(2026, 0, 1) });
    await expect(
      queue.createPreview({ ...minimalRequest(), ttlMs: Infinity })
    ).rejects.toThrow(/ttlMs|positive|finite/i);
  });

  it('PQ1c: ttlMs=NaN 应被拒绝', async () => {
    const queue = new PreviewQueue({ now: () => Date.UTC(2026, 0, 1) });
    await expect(
      queue.createPreview({ ...minimalRequest(), ttlMs: NaN })
    ).rejects.toThrow(/ttlMs|positive|finite/i);
  });

  it('PQ1d: ttlMs=0 应被拒绝', async () => {
    const queue = new PreviewQueue({ now: () => Date.UTC(2026, 0, 1) });
    await expect(
      queue.createPreview({ ...minimalRequest(), ttlMs: 0 })
    ).rejects.toThrow(/ttlMs|positive/i);
  });

  it('PQ1e: ttlMs=-1 应被拒绝', async () => {
    const queue = new PreviewQueue({ now: () => Date.UTC(2026, 0, 1) });
    await expect(
      queue.createPreview({ ...minimalRequest(), ttlMs: -1 })
    ).rejects.toThrow(/ttlMs|positive/i);
  });

  it('PQ1f: ttlMs=MAX_SAFE_TTL_MS（8.64e15）应被接受且不导致 toIso 崩溃', async () => {
    const queue = new PreviewQueue({ now: () => 0 });
    const preview = await queue.createPreview({
      ...minimalRequest(),
      ttlMs: 8.64e15,
    });
    expect(preview.expiresAt).toBeDefined();
    expect(() => new Date(preview.expiresAt).getTime()).not.toThrow();
  });

  it('PQ1g: ttlMs=MAX_SAFE_TTL_MS+1 应被拒绝', async () => {
    const queue = new PreviewQueue({ now: () => 0 });
    await expect(
      queue.createPreview({ ...minimalRequest(), ttlMs: 8.64e15 + 1 })
    ).rejects.toThrow(/too large/i);
  });

  it('PQ1h: defaultTtlMs=Infinity 在构造时应被拒绝', () => {
    expect(
      () => new PreviewQueue({ defaultTtlMs: Infinity, now: () => 0 })
    ).toThrow(/defaultTtlMs|positive|finite/i);
  });

  it('PQ1i: defaultTtlMs=Number.MAX_VALUE 在构造时应被拒绝', () => {
    expect(
      () => new PreviewQueue({ defaultTtlMs: Number.MAX_VALUE, now: () => 0 })
    ).toThrow(/defaultTtlMs|too large/i);
  });
});

// ============================================================================
// PQ2: payload cloning
// ============================================================================

describe('PQ2: payload cloning', () => {
  it('PQ2a: payload 含函数应被剥离（clone fallback），不应崩溃', async () => {
    const queue = new PreviewQueue({ now: () => Date.UTC(2026, 0, 1) });
    const payload = { fn: () => 'hello', data: { value: 42 } } as any;
    const preview = await queue.createPreview({ ...minimalRequest(), payload });
    // clone 应剥离 fn，保留 data
    expect((preview.payload as any).fn).toBeUndefined();
    expect((preview.payload as any).data).toEqual({ value: 42 });
  });

  it('PQ2b: payload 含 Symbol 应被剥离', async () => {
    const queue = new PreviewQueue({ now: () => Date.UTC(2026, 0, 1) });
    const sym = Symbol('test');
    const payload = { [sym]: 'symbol-value', data: 'kept' } as any;
    const preview = await queue.createPreview({ ...minimalRequest(), payload });
    expect((preview.payload as any).data).toBe('kept');
  });

  it('PQ2c: payload 含 undefined 应被剥离（JSON roundtrip 行为）', async () => {
    const queue = new PreviewQueue({ now: () => Date.UTC(2026, 0, 1) });
    const payload = { a: undefined, b: null, c: 'kept' } as any;
    const preview = await queue.createPreview({ ...minimalRequest(), payload });
    expect((preview.payload as any).a).toBeUndefined();
    expect((preview.payload as any).b).toBeNull();
    expect((preview.payload as any).c).toBe('kept');
  });

  it('PQ2d: payload 原始值不应被修改', async () => {
    const queue = new PreviewQueue({ now: () => Date.UTC(2026, 0, 1) });
    const payload = { nested: { deep: { value: 1 } } };
    const preview = await queue.createPreview({ ...minimalRequest(), payload });
    // 修改原始 payload 不应影响已存储的 preview
    payload.nested.deep.value = 999;
    expect((preview.payload as any).nested.deep.value).toBe(1);
  });

  it('PQ2e: apply 后的 result 应被 clone，不应引用原始对象', async () => {
    const queue = new PreviewQueue({
      now: () => Date.UTC(2026, 0, 1),
      idFactory: sequentialIds('p'),
    });
    const preview = await queue.createPreview(minimalRequest());
    const result = { changed: true };
    const applied = await queue.apply(preview.id, { result });
    result.changed = false;
    expect((applied.result as any).changed).toBe(true);
  });
});

// ============================================================================
// PQ3: 状态转换
// ============================================================================

describe('PQ3: 状态转换', () => {
  it('PQ3a: 已 applied 的 preview 不能再次 apply', async () => {
    const queue = new PreviewQueue({
      now: () => Date.UTC(2026, 0, 1),
      idFactory: sequentialIds('p'),
    });
    const preview = await queue.createPreview(minimalRequest());
    await queue.apply(preview.id);
    await expect(queue.apply(preview.id)).rejects.toThrow(/applied status/);
  });

  it('PQ3b: 已 applied 的 preview 不能 discard', async () => {
    const queue = new PreviewQueue({
      now: () => Date.UTC(2026, 0, 1),
      idFactory: sequentialIds('p'),
    });
    const preview = await queue.createPreview(minimalRequest());
    await queue.apply(preview.id);
    await expect(queue.discard(preview.id)).rejects.toThrow(/applied status/);
  });

  it('PQ3c: 已 discarded 的 preview 不能 apply', async () => {
    const queue = new PreviewQueue({
      now: () => Date.UTC(2026, 0, 1),
      idFactory: sequentialIds('p'),
    });
    const preview = await queue.createPreview(minimalRequest());
    await queue.discard(preview.id);
    await expect(queue.apply(preview.id)).rejects.toThrow(/discarded status/);
  });

  it('PQ3d: 已 expired 的 preview 不能 apply', async () => {
    const clock = manualClock(Date.UTC(2026, 0, 1));
    const queue = new PreviewQueue({
      now: clock.now,
      idFactory: sequentialIds('p'),
      defaultTtlMs: 10,
    });
    const preview = await queue.createPreview(minimalRequest());
    clock.advance(11);
    await expect(queue.apply(preview.id)).rejects.toThrow(/expired status/);
  });

  it('PQ3e: 不存在的 preview id 应抛出 not found', async () => {
    const queue = new PreviewQueue({ now: () => Date.UTC(2026, 0, 1) });
    await expect(queue.apply('nonexistent')).rejects.toThrow(/not found/i);
    await expect(queue.discard('nonexistent')).rejects.toThrow(/not found/i);
  });

  it('PQ3f: 已 expired 的 preview 不能 discard', async () => {
    const clock = manualClock(Date.UTC(2026, 0, 1));
    const queue = new PreviewQueue({
      now: clock.now,
      idFactory: sequentialIds('p'),
      defaultTtlMs: 10,
    });
    const preview = await queue.createPreview(minimalRequest());
    clock.advance(11);
    await expect(queue.discard(preview.id)).rejects.toThrow(/expired status/);
  });
});

// ============================================================================
// PQ4: 并发安全
// ============================================================================

describe('PQ4: 并发安全', () => {
  it('PQ4a: 并发 apply 同一个 preview，只有一个成功', async () => {
    const queue = new PreviewQueue({
      idFactory: sequentialIds('p'),
      now: () => Date.UTC(2026, 0, 1),
    });
    const preview = await queue.createPreview(minimalRequest());

    const results = await Promise.allSettled([
      queue.apply(preview.id, { result: { src: 'a' } }),
      queue.apply(preview.id, { result: { src: 'b' } }),
      queue.apply(preview.id, { result: { src: 'c' } }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);
  });

  it('PQ4b: 并发 apply + discard，只有一个成功', async () => {
    const queue = new PreviewQueue({
      idFactory: sequentialIds('p'),
      now: () => Date.UTC(2026, 0, 1),
    });
    const preview = await queue.createPreview(minimalRequest());

    const results = await Promise.allSettled([
      queue.apply(preview.id),
      queue.discard(preview.id),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
  });

  it('PQ4c: 并发创建不同 preview 应都成功', async () => {
    const queue = new PreviewQueue({
      idFactory: sequentialIds('p'),
      now: () => Date.UTC(2026, 0, 1),
    });
    const promises = Array.from({ length: 10 }, () =>
      queue.createPreview(minimalRequest())
    );
    const previews = await Promise.all(promises);
    expect(previews).toHaveLength(10);
    const ids = new Set(previews.map((p) => p.id));
    expect(ids.size).toBe(10);
  });
});

// ============================================================================
// PQ5: Unicode 处理
// ============================================================================

describe('PQ5: Unicode 处理', () => {
  it('PQ5a: emoji 在 title/action 中应被正确保存', async () => {
    const queue = new PreviewQueue({
      now: () => Date.UTC(2026, 0, 1),
      idFactory: sequentialIds('p'),
    });
    const preview = await queue.createPreview({
      action: 'edit-🚀',
      title: '修改文件-🔥-✨',
      payload: { path: 'src/测试.ts' },
    });
    expect(preview.action).toBe('edit-🚀');
    expect(preview.title).toBe('修改文件-🔥-✨');
    expect((preview.payload as any).path).toBe('src/测试.ts');
  });

  it('PQ5b: CJK 在 metadata 中应被正确保存', async () => {
    const queue = new PreviewQueue({
      now: () => Date.UTC(2026, 0, 1),
      idFactory: sequentialIds('p'),
    });
    const preview = await queue.createPreview({
      ...minimalRequest(),
      metadata: { 用户: '张三', 描述: '测试预览' } as any,
    });
    expect((preview.metadata as any).用户).toBe('张三');
    expect((preview.metadata as any).描述).toBe('测试预览');
  });

  it('PQ5c: surrogate pair 在 payload 中应被正确保存', async () => {
    const queue = new PreviewQueue({
      now: () => Date.UTC(2026, 0, 1),
      idFactory: sequentialIds('p'),
    });
    const payload = { emoji: '👨‍👩‍👧‍👦', text: '𝕳𝖊𝖑𝖑𝖔' };
    const preview = await queue.createPreview({ ...minimalRequest(), payload });
    expect((preview.payload as any).emoji).toBe('👨‍👩‍👧‍👦');
    expect((preview.payload as any).text).toBe('𝕳𝖊𝖑𝖑𝖔');
  });
});

// ============================================================================
// PQ6: BoundedMap eviction
// ============================================================================

describe('PQ6: BoundedMap eviction', () => {
  it('PQ6a: 超过 MAX_PREVIEWS 上限应 evict 最旧的', async () => {
    const queue = new PreviewQueue({
      idFactory: sequentialIds('p'),
      now: () => Date.UTC(2026, 0, 1),
    });
    // MAX_PREVIEWS = 200
    for (let i = 0; i < 205; i++) {
      await queue.createPreview(minimalRequest());
    }
    const all = await queue.list();
    expect(all.length).toBeLessThanOrEqual(200);
  });

  it('PQ6b: 已 applied 的 preview 在 eviction 时应被保留更久（如果实现如此）', async () => {
    const queue = new PreviewQueue({
      idFactory: sequentialIds('p'),
      now: () => Date.UTC(2026, 0, 1),
    });
    const first = await queue.createPreview(minimalRequest());
    await queue.apply(first.id);
    // 创建更多 preview 触发 eviction
    for (let i = 0; i < 100; i++) {
      await queue.createPreview(minimalRequest());
    }
    const applied = await queue.get(first.id);
    // applied preview 应仍存在（不应被 evict）
    expect(applied?.status).toBe('applied');
  });
});

// ============================================================================
// PQ7: 时间戳溢出
// ============================================================================

describe('PQ7: 时间戳溢出', () => {
  it('PQ7a: now() 返回 Infinity 应被拒绝', async () => {
    const queue = new PreviewQueue({ now: () => Infinity });
    await expect(queue.createPreview(minimalRequest())).rejects.toThrow(
      /invalid timestamp|clock/i
    );
  });

  it('PQ7b: now() 返回 NaN 应被拒绝', async () => {
    const queue = new PreviewQueue({ now: () => NaN });
    await expect(queue.createPreview(minimalRequest())).rejects.toThrow(
      /invalid timestamp|clock/i
    );
  });

  it('PQ7c: now() 返回 Date 对象应被正确处理', async () => {
    const queue = new PreviewQueue({
      now: () => new Date(Date.UTC(2026, 0, 1)),
    });
    const preview = await queue.createPreview(minimalRequest());
    expect(preview.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

// ============================================================================
// PQ8: 空值与非法输入
// ============================================================================

describe('PQ8: 空值与非法输入', () => {
  it('PQ8a: 空 action 应被拒绝', async () => {
    const queue = new PreviewQueue({ now: () => Date.UTC(2026, 0, 1) });
    await expect(
      queue.createPreview({ ...minimalRequest(), action: '' })
    ).rejects.toThrow(/action/i);
    await expect(
      queue.createPreview({ ...minimalRequest(), action: '   ' })
    ).rejects.toThrow(/action/i);
  });

  it('PQ8b: 空 title 应被拒绝', async () => {
    const queue = new PreviewQueue({ now: () => Date.UTC(2026, 0, 1) });
    await expect(
      queue.createPreview({ ...minimalRequest(), title: '' })
    ).rejects.toThrow(/title/i);
  });

  it('PQ8c: 空 id 应被拒绝', async () => {
    const queue = new PreviewQueue({
      now: () => Date.UTC(2026, 0, 1),
      idFactory: () => '',
    });
    await expect(queue.createPreview(minimalRequest())).rejects.toThrow(/id/i);
  });

  it('PQ8d: 重复 id 应被拒绝', async () => {
    const queue = new PreviewQueue({
      now: () => Date.UTC(2026, 0, 1),
      idFactory: () => 'dup',
    });
    await queue.createPreview(minimalRequest());
    await expect(queue.createPreview(minimalRequest())).rejects.toThrow(
      /already exists/i
    );
  });

  it('PQ8e: payload 为 null 应被接受（null 是合法 JSON 值）', async () => {
    const queue = new PreviewQueue({
      now: () => Date.UTC(2026, 0, 1),
      idFactory: sequentialIds('p'),
    });
    const preview = await queue.createPreview({
      ...minimalRequest(),
      payload: null as any,
    });
    expect(preview.payload).toBeNull();
  });

  it('PQ8f: metadata 为 undefined 应被处理为空对象', async () => {
    const queue = new PreviewQueue({
      now: () => Date.UTC(2026, 0, 1),
      idFactory: sequentialIds('p'),
    });
    const preview = await queue.createPreview({
      ...minimalRequest(),
      metadata: undefined,
    });
    expect(preview.metadata).toEqual({});
  });
});

// ============================================================================
// PQ9: ID 冲突与生成器异常
// ============================================================================

describe('PQ9: ID 生成器异常', () => {
  it('PQ9a: idFactory 抛出异常应向上传播', async () => {
    const queue = new PreviewQueue({
      now: () => Date.UTC(2026, 0, 1),
      idFactory: () => {
        throw new Error('factory boom');
      },
    });
    await expect(queue.createPreview(minimalRequest())).rejects.toThrow(
      /factory boom/
    );
  });

  it('PQ9b: 显式 id 与已存在 id 冲突应被拒绝', async () => {
    const queue = new PreviewQueue({
      now: () => Date.UTC(2026, 0, 1),
      idFactory: sequentialIds('p'),
    });
    await queue.createPreview({ ...minimalRequest(), id: 'explicit-1' });
    await expect(
      queue.createPreview({ ...minimalRequest(), id: 'explicit-1' })
    ).rejects.toThrow(/already exists/i);
  });
});

// ============================================================================
// PQ10: artifact 构建一致性
// ============================================================================

describe('PQ10: artifact 构建', () => {
  it('PQ10a: artifact 应包含 preview 元数据', async () => {
    const queue = new PreviewQueue({
      now: () => Date.UTC(2026, 0, 1),
      idFactory: () => 'p-art',
    });
    const preview = await queue.createPreview({
      ...minimalRequest(),
      artifact: { kind: 'diff', title: 'Custom title' },
    });
    expect(preview.artifact.kind).toBe('diff');
    expect(preview.artifact.title).toBe('Custom title');
    expect(preview.artifact.metadata).toMatchObject({
      previewId: 'p-art',
      previewAction: 'edit',
      previewStatus: 'pending',
      previewKind: 'runtime-preview',
    });
  });

  it('PQ10b: apply 后 artifact 应包含 resolved 元数据', async () => {
    const queue = new PreviewQueue({
      now: () => Date.UTC(2026, 0, 1),
      idFactory: () => 'p-art',
    });
    const preview = await queue.createPreview(minimalRequest());
    const applied = await queue.apply(preview.id);
    expect(applied.artifact.metadata).toMatchObject({
      previewStatus: 'applied',
      previewResolvedAt: applied.resolvedAt,
      previewAppliedAt: applied.appliedAt,
    });
  });

  it('PQ10c: discard 后 artifact 应包含 reason', async () => {
    const queue = new PreviewQueue({
      now: () => Date.UTC(2026, 0, 1),
      idFactory: () => 'p-art',
    });
    const preview = await queue.createPreview(minimalRequest());
    const discarded = await queue.discard(preview.id, {
      reason: 'user cancelled',
    });
    expect(discarded.artifact.metadata).toMatchObject({
      previewStatus: 'discarded',
      previewDiscardReason: 'user cancelled',
    });
  });

  it('PQ10d: expired preview 的 artifact 应包含 expiredAt', async () => {
    const clock = manualClock(Date.UTC(2026, 0, 1));
    const queue = new PreviewQueue({
      now: clock.now,
      idFactory: () => 'p-art',
      defaultTtlMs: 10,
    });
    const preview = await queue.createPreview(minimalRequest());
    clock.advance(11);
    const expired = await queue.get(preview.id);
    expect(expired?.status).toBe('expired');
    if (expired?.status !== 'expired') throw new Error('expected expired');
    // previewExpiredAt 是检测到过期时的时间（clock advance 11 后 = 011Z），
    // 与 expiresAt（创建时计算的 010Z）不同——这反映"何时被发现过期"
    expect(expired.artifact.metadata).toMatchObject({
      previewStatus: 'expired',
      previewExpiredAt: expired.expiredAt,
    });
    expect(new Date(expired.expiredAt).getTime()).toBeGreaterThan(
      new Date(expired.expiresAt).getTime() - 1
    );
  });
});

// ============================================================================
// PQ11: 大规模压力测试
// ============================================================================

describe('PQ11: 大规模压力', () => {
  it('PQ11a: 大量 preview 创建应受 MAX_PREVIEWS 上限约束', async () => {
    const queue = new PreviewQueue({
      idFactory: sequentialIds('p'),
      now: () => Date.UTC(2026, 0, 1),
    });
    // 创建超过 MAX_PREVIEWS（200）的数量，触发 eviction
    const ids: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const preview = await queue.createPreview(minimalRequest());
      ids.push(preview.id);
    }
    // eviction 后 list 长度应 <= MAX_PREVIEWS
    const all = await queue.list();
    expect(all.length).toBeLessThanOrEqual(200);
    // 最早的 preview 应已被 evict（不存在）
    const earliest = await queue.get(ids[0]!);
    expect(earliest).toBeUndefined();
    // 最新的 preview 应仍存在
    const latest = await queue.get(ids[ids.length - 1]!);
    expect(latest).toBeDefined();
  });

  it('PQ11b: 大量并发操作应不崩溃', async () => {
    const queue = new PreviewQueue({
      idFactory: sequentialIds('p'),
      now: () => Date.UTC(2026, 0, 1),
    });
    const previews = await Promise.all(
      Array.from({ length: 100 }, () => queue.createPreview(minimalRequest()))
    );
    // 并发 apply 一半，discard 一半
    const applyPromises = previews.slice(0, 50).map((p) => queue.apply(p.id));
    const discardPromises = previews.slice(50).map((p) => queue.discard(p.id));
    const results = await Promise.allSettled([
      ...applyPromises,
      ...discardPromises,
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(100);
  });
});

// ============================================================================
// PQ12: list 过滤
// ============================================================================

describe('PQ12: list 过滤', () => {
  it('PQ12a: 按 status 过滤应返回正确的 preview', async () => {
    const queue = new PreviewQueue({
      idFactory: sequentialIds('p'),
      now: () => Date.UTC(2026, 0, 1),
    });
    const p1 = await queue.createPreview(minimalRequest());
    const p2 = await queue.createPreview(minimalRequest());
    const p3 = await queue.createPreview(minimalRequest());
    await queue.apply(p1.id);
    await queue.discard(p2.id);
    // p3 仍 pending

    const pending = await queue.list({ status: 'pending' });
    const applied = await queue.list({ status: 'applied' });
    const discarded = await queue.list({ status: 'discarded' });

    expect(pending.map((p) => p.id)).toEqual([p3.id]);
    expect(applied.map((p) => p.id)).toEqual([p1.id]);
    expect(discarded.map((p) => p.id)).toEqual([p2.id]);
  });

  it('PQ12b: status 为数组时应返回多个状态的 preview', async () => {
    const queue = new PreviewQueue({
      idFactory: sequentialIds('p'),
      now: () => Date.UTC(2026, 0, 1),
    });
    const p1 = await queue.createPreview(minimalRequest());
    const p2 = await queue.createPreview(minimalRequest());
    await queue.createPreview(minimalRequest());
    await queue.apply(p1.id);
    await queue.discard(p2.id);

    const result = await queue.list({ status: ['applied', 'discarded'] });
    expect(result).toHaveLength(2);
    const ids = result.map((p) => p.id).sort();
    expect(ids).toEqual([p1.id, p2.id].sort());
  });

  it('PQ12c: 无 status 参数应返回所有', async () => {
    const queue = new PreviewQueue({
      idFactory: sequentialIds('p'),
      now: () => Date.UTC(2026, 0, 1),
    });
    await queue.createPreview(minimalRequest());
    await queue.createPreview(minimalRequest());
    const all = await queue.list();
    expect(all).toHaveLength(2);
  });
});
