/**
 * P1-D2（T3.6）懒水合分页拉全红测试。
 *
 * 复现缺陷（R2 §6）：hydrateSessionMessagesFromEngine 只拉单页 800 事件，
 * hasMore 透出后无人消费——长会话（>800 事件）被截断。
 * 本文件断言修复后契约：
 * 1. 消费 hasMore 按 nextAfterSequence 翻页直至 hasMore=false（拉全）；
 * 2. 单页即可拉全时只请求 1 次（不引入多余开销）；
 * 3. 页数上限保护：超限按 ok:true + 截断标记（truncated）返回，防死循环；
 * 4. 防御：hasMore=true 但游标不前进 → 终止翻页并标记截断。
 *
 * mock 边界：仅替换 transport 数据源（fakeTransport.request 按游标返回事件页），
 * fetchSessionEvents 的协议解析与 hydrate 分页循环全部真实执行——
 * 不 mock 被验证的分页逻辑（防作弊 B4）。
 *
 * 修复前（单页实现）：用例 1/3/4 断言必红（请求次数与 truncated 字段）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fakeTransport } = vi.hoisted(() => ({
  fakeTransport: {
    isReady: vi.fn(() => true),
    waitUntilConnected: vi.fn(async () => true),
    request: vi.fn(async () => ({ events: [], nextAfterSequence: 0, hasMore: false })),
  },
}));

vi.mock('./transport', () => ({
  getTransport: () => fakeTransport,
}));

import { hydrateSessionMessagesFromEngine } from './sessionEventHydrate';

/** 构造 message-end 用户消息事件（每条事件经投影生成 1 条消息） */
function mkEvents(fromSeq: number, count: number): unknown[] {
  return Array.from({ length: count }, (_, i) => {
    const seq = fromSeq + i + 1;
    return {
      type: 'message-end',
      sequence: seq,
      message: { role: 'user', content: `message-${seq}` },
    };
  });
}

/** 断言一次 core_read_session_events 请求的游标参数 */
function cursorOf(call: unknown[], index: number): number {
  return (call[index] as { afterSequence?: number })?.afterSequence ?? -1;
}

beforeEach(() => {
  fakeTransport.request.mockReset();
  fakeTransport.request.mockResolvedValue({
    events: [],
    nextAfterSequence: 0,
    hasMore: false,
  });
});

describe('hydrateSessionMessagesFromEngine 分页拉全（P1-D2 T3.6）', () => {
  it('800+ 事件会话：消费 hasMore 翻页，两次请求（游标 0 → 800）拉全 1000 条', async () => {
    fakeTransport.request
      .mockResolvedValueOnce({
        events: mkEvents(0, 800),
        nextAfterSequence: 800,
        hasMore: true,
      })
      .mockResolvedValueOnce({
        events: mkEvents(800, 200),
        nextAfterSequence: 1000,
        hasMore: false,
      });

    const res = await hydrateSessionMessagesFromEngine('sess-1');

    // 修复前：只请求一次单页，本断言红（请求次数与第二页游标）
    expect(fakeTransport.request).toHaveBeenCalledTimes(2);
    expect(cursorOf(fakeTransport.request.mock.calls[0]!, 1)).toBe(0);
    expect(cursorOf(fakeTransport.request.mock.calls[1]!, 1)).toBe(800);
    expect(res.ok).toBe(true);
    expect(res.messages).toHaveLength(1000);
    expect(res.nextAfterSequence).toBe(1000);
    expect(res.hasMore).toBe(false);
    // 拉全成功：无截断标记
    expect(res.truncated).toBeUndefined();
  });

  it('单页即拉全（hasMore=false）：只请求 1 次，不额外翻页', async () => {
    fakeTransport.request.mockResolvedValueOnce({
      events: mkEvents(0, 10),
      nextAfterSequence: 10,
      hasMore: false,
    });

    const res = await hydrateSessionMessagesFromEngine('sess-1');

    expect(fakeTransport.request).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
    expect(res.messages).toHaveLength(10);
    expect(res.hasMore).toBe(false);
  });

  it('页数上限保护：hasMore 恒真时翻页 50 次后返回截断标记 truncated=true（防死循环）', async () => {
    fakeTransport.request.mockImplementation(
      async (_cmd: string, args: unknown) => {
        const after = (args as { afterSequence?: number })?.afterSequence ?? 0;
        return {
          events: mkEvents(after, 1),
          nextAfterSequence: after + 1,
          hasMore: true,
        };
      }
    );

    const res = await hydrateSessionMessagesFromEngine('sess-1');

    // 修复前：无分页循环 → 1 次请求即返回，本断言红
    expect(fakeTransport.request).toHaveBeenCalledTimes(50);
    expect(res.ok).toBe(true);
    expect(res.hasMore).toBe(true);
    expect(res.truncated).toBe(true);
    expect(res.messages).toHaveLength(50);
    // 最终游标随翻页推进到第 50 页
    expect(res.nextAfterSequence).toBe(50);
  });

  it('防御：hasMore=true 但游标不前进 → 终止翻页并标记截断（防无限循环）', async () => {
    fakeTransport.request
      .mockResolvedValueOnce({
        events: mkEvents(0, 1),
        nextAfterSequence: 1,
        hasMore: true,
      })
      .mockResolvedValue({
        events: [],
        nextAfterSequence: 1,
        hasMore: true,
      });

    const res = await hydrateSessionMessagesFromEngine('sess-1');

    // 修复前：1 次请求即返回（无续拉）；修复后第 2 次游标停滞 → 终止 + 截断
    expect(fakeTransport.request).toHaveBeenCalledTimes(2);
    expect(res.ok).toBe(true);
    expect(res.hasMore).toBe(true);
    expect(res.truncated).toBe(true);
    expect(res.messages).toHaveLength(1);
  });

  it('not_connected：fetch 失败返回 ok:false + error 透出（回归）', async () => {
    fakeTransport.request.mockRejectedValueOnce(new Error('transport down'));

    const res = await hydrateSessionMessagesFromEngine('sess-1');

    expect(res.ok).toBe(false);
    expect(res.error).toBe('not_connected');
    expect(res.messages).toEqual([]);
  });
});
