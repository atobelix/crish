// buildLocalTimeline 身份纪律：本地消息对象引用不变 → 其投影块
// （正文 + 停止 / 工具标注）保持同一引用；消息对象换新（流式追加 /
// 收尾）→ 仅该消息的块换新，未触碰消息的块零重建。
import { buildLocalTimeline } from './buildLocalTimeline';
import type { LocalChatMessage } from '@/domain/types/localChat';

const msg = (
  overrides: Partial<LocalChatMessage> & Pick<LocalChatMessage, 'id' | 'role'>
): LocalChatMessage => ({ content: '', ...overrides });

describe('buildLocalTimeline 身份纪律', () => {
  it('同一批消息对象重复投影 → 全部块逐个同引用', () => {
    const u1 = msg({ id: 'u1', role: 'user', content: '你好' });
    const a1 = msg({
      id: 'a1',
      role: 'assistant',
      content: '你好，我在。',
      stopped: true,
      toolCalls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'web_search', arguments: '{"query":"test"}' },
          status: 'success',
          state: 'success',
        },
      ],
    });
    const first = buildLocalTimeline([u1, a1]);
    const second = buildLocalTimeline([u1, a1]);
    expect(second).toHaveLength(4);
    for (let i = 0; i < first.length; i += 1) {
      expect(second[i]).toBe(first[i]);
    }
  });

  it('流式消息换新对象 → 仅其块换新；前序消息块保持引用', () => {
    const u1 = msg({ id: 'u1', role: 'user', content: '讲个故事' });
    const a1 = msg({
      id: 'a1',
      role: 'assistant',
      content: '从前',
      streaming: true,
    });
    const first = buildLocalTimeline([u1, a1]);
    const a1Next: LocalChatMessage = {
      ...a1,
      content: '从前有座山',
      streaming: true,
    };
    const second = buildLocalTimeline([u1, a1Next]);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect(second[1]).toMatchObject({ text: '从前有座山', streaming: true });
  });

  it('收尾换新（streaming 落定 + 标注出现）→ 该消息全部块换新且标注齐全', () => {
    const a1 = msg({
      id: 'a1',
      role: 'assistant',
      content: '一半',
      streaming: true,
    });
    const first = buildLocalTimeline([a1]);
    const a1Done: LocalChatMessage = {
      ...a1,
      streaming: false,
      stopped: true,
    };
    const second = buildLocalTimeline([a1Done]);
    expect(second).toHaveLength(2);
    expect(second[0]).not.toBe(first[0]);
    expect(second[0]).toMatchObject({ text: '一半', streaming: false });
    expect(second[1]).toMatchObject({ id: 'a1:stopped', kind: 'notice' });
  });

  it('前缀折叠弱缓存：已封口历史消息在末尾 Assistant 流式生长时不重复投影，直接复用前缀 blocks 引用', () => {
    const u1 = msg({ id: 'u1', role: 'user', content: '第一问' });
    const a1 = msg({ id: 'a1', role: 'assistant', content: '第一答' });
    const u2 = msg({ id: 'u2', role: 'user', content: '第二问' });
    const a2Step1 = msg({
      id: 'a2',
      role: 'assistant',
      content: '字',
      streaming: true,
    });

    const first = buildLocalTimeline([u1, a1, u2, a2Step1]);
    expect(first).toHaveLength(4);

    // 模拟逐字流式推进：仅最后一条 Assistant 消息换新
    const a2Step2: LocalChatMessage = {
      ...a2Step1,
      content: '字句生长中',
      streaming: true,
    };
    const second = buildLocalTimeline([u1, a1, u2, a2Step2]);

    expect(second).toHaveLength(4);
    // 前缀 3 条已封口消息的 block 引用完全恒等复用
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(second[2]).toBe(first[2]);
    // 仅最后一条生长的 Assistant 构造新 block
    expect(second[3]).not.toBe(first[3]);
    expect(second[3]).toMatchObject({ text: '字句生长中', streaming: true });

    // 再次流式推进
    const a2Step3: LocalChatMessage = {
      ...a2Step2,
      content: '字句生长中，推导完毕。',
      streaming: true,
    };
    const third = buildLocalTimeline([u1, a1, u2, a2Step3]);
    expect(third[0]).toBe(first[0]);
    expect(third[1]).toBe(first[1]);
    expect(third[2]).toBe(first[2]);
    expect(third[3]).not.toBe(second[3]);
    expect(third[3]).toMatchObject({
      text: '字句生长中，推导完毕。',
      streaming: true,
    });
  });

  it('流式收尾后 Assistant 进入封口前缀，新一轮消息继续享受前缀增量缓存', () => {
    const u1 = msg({ id: 'u1', role: 'user', content: '问' });
    const a1 = msg({
      id: 'a1',
      role: 'assistant',
      content: '答中',
      streaming: true,
    });
    const t1 = buildLocalTimeline([u1, a1]);

    // a1 结束流式，封口
    const a1Done: LocalChatMessage = {
      ...a1,
      content: '答毕',
      streaming: false,
    };
    const t2 = buildLocalTimeline([u1, a1Done]);
    expect(t2[0]).toBe(t1[0]); // u1 引用保持

    // 开启第二轮对话
    const u2 = msg({ id: 'u2', role: 'user', content: '第二轮问' });
    const a2 = msg({
      id: 'a2',
      role: 'assistant',
      content: '第二轮答',
      streaming: true,
    });
    const t3 = buildLocalTimeline([u1, a1Done, u2, a2]);

    // u1 与 a1Done 已固化在 sealedBlocks 中，完全恒等
    expect(t3[0]).toBe(t2[0]);
    expect(t3[1]).toBe(t2[1]);
    expect(t3[2]).toMatchObject({ id: 'u2' });
    expect(t3[3]).toMatchObject({ id: 'a2', streaming: true });
  });

  it('前缀分歧（历史消息被替换或删除）时主动失效并重新全量投影', () => {
    const u1 = msg({ id: 'u1', role: 'user', content: '原始首条' });
    const u2 = msg({ id: 'u2', role: 'user', content: '第二条' });
    const first = buildLocalTimeline([u1, u2]);

    // 首条不变，但中间第二条被替换
    const u2New = msg({ id: 'u2', role: 'user', content: '被修改的第二条' });
    const second = buildLocalTimeline([u1, u2New]);

    expect(second[0]).toBe(first[0]); // 首条仍复用
    expect(second[1]).not.toBe(first[1]);
    expect((second[1] as any).text).toBe('被修改的第二条');
  });
});
