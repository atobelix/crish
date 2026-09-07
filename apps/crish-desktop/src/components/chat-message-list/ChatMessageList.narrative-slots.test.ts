/**
 * 可选叙事注入：ChatMessageList 提供槽，缺省不进 Virtualizer memo。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SessionMessage } from '../../store/types';
import { isContextStateCarrierMessage } from '../../store/sessionInjectionMount';

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

describe('ChatMessageList 叙事注入槽', () => {
  it('props 含可选 renderTools / renderThought', () => {
    const src = readFileSync(join(DIR, 'chatMessageListProps.ts'), 'utf8');
    expect(src).toMatch(/renderTools\?:/);
    expect(src).toMatch(/renderThought\?:/);
  });

  it('列表用 Context 注入，不把槽写进 MessageVirtualizer props', () => {
    const list = readFileSync(join(DIR, 'ChatMessageList.tsx'), 'utf8');
    const memo = readFileSync(join(DIR, 'messageVirtualizerMemo.ts'), 'utf8');
    expect(list).toMatch(/NarrativeRenderSlotsContext\.Provider/);
    expect(memo).not.toMatch(/renderTools/);
    expect(memo).not.toMatch(/renderThought/);
  });
});

describe('ChatMessageList lastAssistantId 智能过滤测试 (DEF-07)', () => {
  it('源码契约：ChatMessageList 的 lastAssistantId 计算严格排除 isContextStateCarrierMessage', () => {
    const src = readFileSync(join(DIR, 'ChatMessageList.tsx'), 'utf8');
    expect(src).toMatch(/!isContextStateCarrierMessage\(msg\)/);
  });

  it('当会话尾部追加状态 Carrier 时，lastAssistantId 仍精准指向实质助手消息', () => {
    const messages: SessionMessage[] = [
      { id: 'user-1', sender: 'user', text: '请写一段代码' },
      { id: 'asst-real', sender: 'assistant', text: '这是代码：function foo() {}' },
      {
        id: 'carrier-state',
        sender: 'assistant',
        text: '',
        injections: [
          {
            id: 's1',
            kind: 'workspace_env',
            metadata: { mode: 'context-state', model: 'deepseek-chat' },
          },
        ],
        blocks: [
          {
            type: 'context_injection',
            id: 's1',
            injection: {
              metadata: { mode: 'context-state', model: 'deepseek-chat' },
            },
          },
        ],
      },
    ];

    let resolvedLastAssistantId: string | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg && msg.sender === 'assistant' && !isContextStateCarrierMessage(msg)) {
        resolvedLastAssistantId = msg.id;
        break;
      }
    }

    expect(resolvedLastAssistantId).toBe('asst-real');
  });

  it('当会话仅有状态 Carrier 没有实质助手时，lastAssistantId 为 null', () => {
    const messages: SessionMessage[] = [
      { id: 'user-1', sender: 'user', text: '你好' },
      {
        id: 'carrier-1',
        sender: 'assistant',
        text: '',
        injections: [{ id: 's1', metadata: { mode: 'context-state' } }],
        blocks: [{ type: 'context_injection', id: 's1', injection: { metadata: { mode: 'context-state' } } }],
      },
    ];

    let resolvedLastAssistantId: string | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg && msg.sender === 'assistant' && !isContextStateCarrierMessage(msg)) {
        resolvedLastAssistantId = msg.id;
        break;
      }
    }

    expect(resolvedLastAssistantId).toBeNull();
  });
});
