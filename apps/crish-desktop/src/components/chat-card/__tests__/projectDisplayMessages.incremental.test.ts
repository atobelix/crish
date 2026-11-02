/**
 * R6：展示投影增量化回归（性能审计 P2-1）。
 *
 * 断言口径：
 * - 单条消息被替换（流式提交）后，未受影响消息在 display 中的条目引用不变；
 * - 展示无关的变化（被过滤掉的消息被替换）→ 整个投影结果对象复用；
 * - 载体折叠的增量续算与全量折叠结果逐项一致（含载体 run 中段变化）；
 * - 追加消息时前缀条目引用不变；搜索路径同样保持引用稳定。
 */
import { describe, expect, it } from 'vitest';
import type { SessionMessage } from '../../../store/types';
import { projectDisplayMessages } from '../projectDisplayMessages';

let t = 0;
const user = (id: string, text = '问题'): SessionMessage =>
  ({
    id,
    sender: 'user',
    text,
    timestamp: ++t,
    status: 'completed',
  }) as SessionMessage;
const asst = (id: string, p: Partial<SessionMessage> = {}): SessionMessage =>
  ({
    id,
    sender: 'assistant',
    text: '',
    timestamp: ++t,
    status: 'completed',
    ...p,
  }) as SessionMessage;
const carrier = (id: string, model: string): SessionMessage =>
  asst(id, {
    injections: [
      {
        id: `inj-${id}`,
        title: '上下文状态切换',
        metadata: { mode: 'context-state', model },
      } as never,
    ],
    blocks: [{ type: 'context_injection', id: `inj-${id}` } as never],
  });

describe('R6 projectDisplayMessages 增量化', () => {
  it('单条替换后未受影响条目引用不变，受影响条目为新对象', () => {
    const u1 = user('u1');
    const a1 = asst('a1', { text: '甲' });
    const a2 = asst('a2', { text: '乙' });
    const u2 = user('u2');
    const first = projectDisplayMessages([u1, a1, a2, u2], '');
    expect(first.display.map((m) => m.id)).toEqual(['u1', 'a1', 'a2', 'u2']);

    const a2Next = { ...a2, text: '乙（已更新）' };
    const second = projectDisplayMessages([u1, a1, a2Next, u2], '');
    expect(second.display[0]).toBe(u1);
    expect(second.display[1]).toBe(a1);
    expect(second.display[2]).toBe(a2Next);
    expect(second.display[3]).toBe(u2);
    expect(second.visibleCount).toBe(4);
  });

  it('被过滤消息的替换不改变投影结果对象（整表复用）', () => {
    const u1 = user('u1');
    const hidden = asst('a-hidden'); // 空助手行，不可渲染
    const a1 = asst('a1', { text: '答案' });
    const first = projectDisplayMessages([u1, hidden, a1], '');
    expect(first.display.map((m) => m.id)).toEqual(['u1', 'a1']);

    const hiddenNext = { ...hidden };
    const second = projectDisplayMessages([u1, hiddenNext, a1], '');
    expect(second).toBe(first);
  });

  it('载体 run 中段变化时增量折叠与全量语义一致（保留最后一条）', () => {
    const c1 = carrier('c1', 'm1');
    const c2 = carrier('c2', 'm2');
    const c3 = carrier('c3', 'm3');
    const u1 = user('u1');
    const first = projectDisplayMessages([c1, c2, c3, u1], '');
    expect(first.display.map((m) => m.id)).toEqual(['c3', 'u1']);
    expect(first.display[0]).toBe(c3);

    // 替换 run 中段（非幸存者）：幸存者仍为 c3 且引用不变
    const c2Next = { ...carrier('c2', 'm2-next'), timestamp: c2.timestamp };
    const second = projectDisplayMessages([c1, c2Next, c3, u1], '');
    expect(second.display.map((m) => m.id)).toEqual(['c3', 'u1']);
    expect(second.display[0]).toBe(c3);
    expect(second.display[1]).toBe(u1);

    // 替换幸存者本身：新对象成为幸存者
    const c3Next = { ...carrier('c3', 'm3-next'), timestamp: c3.timestamp };
    const third = projectDisplayMessages([c1, c2Next, c3Next, u1], '');
    expect(third.display[0]).toBe(c3Next);
    expect(third.display[1]).toBe(u1);
  });

  it('追加消息时前缀条目引用不变', () => {
    const u1 = user('u1');
    const a1 = asst('a1', { text: '甲' });
    const first = projectDisplayMessages([u1, a1], '');
    const u2 = user('u2');
    const a2 = asst('a2', { text: '乙' });
    const second = projectDisplayMessages([u1, a1, u2, a2], '');
    expect(second.display.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(second.display[0]).toBe(first.display[0]);
    expect(second.display[1]).toBe(first.display[1]);
  });

  it('搜索路径：命中条目引用稳定，visibleCount 为搜索前条数', () => {
    const u1 = user('u1', 'hello world');
    const a1 = asst('a1', { text: 'foo bar' });
    const a2 = asst('a2', { text: 'hello again' });
    const first = projectDisplayMessages([u1, a1, a2], 'hello');
    expect(first.display.map((m) => m.id)).toEqual(['u1', 'a2']);
    expect(first.visibleCount).toBe(3);

    const a1Next = { ...a1, text: 'foo baz' };
    const second = projectDisplayMessages([u1, a1Next, a2], 'hello');
    expect(second.display[0]).toBe(u1);
    expect(second.display[1]).toBe(a2);
    expect(second.visibleCount).toBe(3);
  });
});
