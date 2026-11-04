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
      toolCallCount: 2,
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
});
