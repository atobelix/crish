/**
 * S-6 展示投影（FINAL-PLAN §2、P1-e、P2-b-2/3、G5）。
 */
import { describe, expect, it } from 'vitest';
import type { SessionMessage } from '../../../store/types';
import { DOMAIN_MESSAGES } from '../../../api/userFacingErrors';
import { projectDisplayMessages } from '../projectDisplayMessages';
import { resolveChatEmptyKind } from '../../../api/chatEmptyState';

let t = 0;
const user = (id: string, text = '问题'): SessionMessage => ({
  id,
  sender: 'user',
  text,
  timestamp: ++t,
  status: 'completed',
});
const asst = (id: string, p: Partial<SessionMessage> = {}): SessionMessage => ({
  id,
  sender: 'assistant',
  text: '',
  timestamp: ++t,
  status: 'completed',
  ...p,
});
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

describe('projectDisplayMessages', () => {
  it('滤掉空助手行与只含 S7 思考的历史行；processing 空占位保留', () => {
    const msgs = [
      user('u1'),
      asst('a-s7', { thinking: DOMAIN_MESSAGES.S7 }),
      asst('a-empty'),
      asst('a-real', { text: '答案' }),
      user('u2'),
      asst('a-live', { status: 'processing' }),
    ];
    const ids = projectDisplayMessages(msgs, '').display.map((m) => m.id);
    expect(ids).toEqual(['u1', 'a-real', 'u2', 'a-live']);
  });

  it('只隔着不可见行的相邻载体折叠为一条（保留最后一条）；隔着用户气泡的不合并', () => {
    const msgs = [
      carrier('c1', 'm1'),
      asst('a-empty'),
      carrier('c2', 'm2'),
      user('u1'),
      carrier('c3', 'm3'),
    ];
    const ids = projectDisplayMessages(msgs, '').display.map((m) => m.id);
    expect(ids).toEqual(['c2', 'u1', 'c3']);
  });

  it('先排序后折叠（E4）：乱序输入按写入序展示', () => {
    const a = user('u-a');
    const b = asst('a-b', { text: 'x' });
    const ids = projectDisplayMessages([b, a], '').display.map((m) => m.id);
    expect(ids).toEqual(['u-a', 'a-b']);
  });

  it('末尾是空行时，最后一条可见助手消息是上一条实质助手（regenerate / 撤回入口归属）', () => {
    const msgs = [
      user('u1'),
      asst('a1', { text: '实质回答' }),
      asst('a-tail-empty'),
    ];
    const display = projectDisplayMessages(msgs, '').display;
    expect(display.findLast((m) => m.sender === 'assistant')?.id).toBe('a1');
  });

  it('G5：全部不可渲染 → visibleCount=0 → 空态落 session-empty（欢迎面），不白屏', () => {
    const msgs = [asst('a1'), asst('a2', { thinking: DOMAIN_MESSAGES.S7 })];
    const p = projectDisplayMessages(msgs, '');
    expect(p.display).toHaveLength(0);
    expect(p.visibleCount).toBe(0);
    expect(
      resolveChatEmptyKind({
        mainSurface: 'chat',
        hasActiveSession: true,
        messageCount: p.visibleCount,
        displayCount: p.display.length,
        filterQuery: '',
      } as never)
    ).toBe('session-empty');
  });

  it('搜索：visibleCount 为搜索前的投影条数', () => {
    const msgs = [user('u1', '苹果'), asst('a1', { text: '香蕉' })];
    const p = projectDisplayMessages(msgs, '苹果');
    expect(p.display.map((m) => m.id)).toEqual(['u1']);
    expect(p.visibleCount).toBe(2);
  });
});
