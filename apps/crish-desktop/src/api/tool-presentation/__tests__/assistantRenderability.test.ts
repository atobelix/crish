/**
 * S-1 / S-2 / S-3（FINAL-PLAN §2、P1-b）：历史 S7 思考行渲染期过滤 + 可渲染性单谓词。
 */
import { describe, expect, it } from 'vitest';
import type { SessionMessage } from '../../../store/types';
import { DOMAIN_MESSAGES } from '../../userFacingErrors';
import { buildAssistantTimeline, isNonContentThought } from '../timelineNormalizer';
import { isRenderableAssistantMessage } from '../assistantRenderability';

const base = (p: Partial<SessionMessage>): SessionMessage => ({
  id: p.id ?? 'a1',
  sender: 'assistant',
  text: '',
  timestamp: 1,
  status: 'completed',
  ...p,
});

describe('S-2 isNonContentThought', () => {
  it('占位与 S7 域文案（含旧变体）均为非内容思考', () => {
    expect(isNonContentThought('正在思考中...')).toBe(true);
    expect(isNonContentThought(DOMAIN_MESSAGES.S7)).toBe(true);
    expect(isNonContentThought('当前会话上一轮任务仍在收尾中…')).toBe(true);
    expect(isNonContentThought('先分析一下需求')).toBe(false);
  });
});

describe('S-3 isRenderableAssistantMessage / 历史 S7 行', () => {
  it('只有 S7 thinking（legacy 字段）的消息不可渲染', () => {
    const m = base({ thinking: DOMAIN_MESSAGES.S7 });
    expect(buildAssistantTimeline(m)).toHaveLength(0);
    expect(isRenderableAssistantMessage(m)).toBe(false);
  });

  it('只有 S7 thought block 的消息不可渲染', () => {
    const m = base({
      blocks: [{ type: 'thought', id: 't1', content: DOMAIN_MESSAGES.S7 } as never],
    });
    expect(isRenderableAssistantMessage(m)).toBe(false);
  });

  it('S7 thinking + 真实正文：正文保留、thought 消失', () => {
    const m = base({ thinking: DOMAIN_MESSAGES.S7, text: '这是回答' });
    const items = buildAssistantTimeline(m);
    expect(items.some((i) => i.kind === 'thought')).toBe(false);
    expect(items.some((i) => i.kind === 'text')).toBe(true);
    expect(isRenderableAssistantMessage(m)).toBe(true);
  });

  it('旧变体（带 …）同样被识别', () => {
    expect(
      isRenderableAssistantMessage(base({ thinking: '当前会话上一轮任务仍在收尾中…' }))
    ).toBe(false);
  });

  it('空助手行（completed、无任何内容）不可渲染；processing 空占位恒可渲染', () => {
    expect(isRenderableAssistantMessage(base({}))).toBe(false);
    expect(isRenderableAssistantMessage(base({ status: 'processing' }))).toBe(true);
  });

  it('真实思考 / 工具 / 用户消息可渲染', () => {
    expect(isRenderableAssistantMessage(base({ thinking: '先拆解问题' }))).toBe(true);
    expect(
      isRenderableAssistantMessage(
        base({ toolCalls: [{ id: 't', name: 'read_file', status: 'success' } as never] })
      )
    ).toBe(true);
    expect(
      isRenderableAssistantMessage({ id: 'u', sender: 'user', text: '', timestamp: 1 })
    ).toBe(true);
  });
});
