// @vitest-environment jsdom
/**
 * S-3 契约（FINAL-PLAN §2）：!isRenderableAssistantMessage(m) 当且仅当 MessageContent 渲染为 null。
 * 锁住 partitionTimelineSegments 不会对非空 timeline 产出空分段（否则两处判空分叉）。
 */
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { MessageContent } from './MessageContent';
import type { SessionMessage } from '../../store/types';
import { isRenderableAssistantMessage } from '../../api/toolPresentation';
import { DOMAIN_MESSAGES } from '../../api/userFacingErrors';

vi.mock('../../api/markdownRenderAsync', () => ({
  useAsyncMarkdownHtml: (markdown: string) => ({
    html: markdown ? `<p>${markdown}</p>` : '',
    loading: false,
  }),
  useStreamingMarkdownHtml: (markdown: string) => (markdown ? `<p>${markdown}</p>` : ''),
  parseMarkdownToHtmlAsync: vi.fn(async (m: string) => `<p>${m}</p>`),
}));

const mk = (id: string, p: Partial<SessionMessage>): SessionMessage => ({
  id,
  sender: 'assistant',
  text: '',
  timestamp: 1,
  status: 'completed',
  ...p,
});

const FIXTURES: SessionMessage[] = [
  mk('empty', {}),
  mk('s7-legacy', { thinking: DOMAIN_MESSAGES.S7 }),
  mk('s7-block', { blocks: [{ type: 'thought', id: 'b', content: DOMAIN_MESSAGES.S7 } as never] }),
  mk('placeholder', { thinking: '正在思考中...' }),
  mk('ended', { text: '   ' }),
  mk('text', { text: '你好' }),
  mk('thought', { thinking: '先想一想' }),
  mk('s7+text', { thinking: DOMAIN_MESSAGES.S7, text: '答案' }),
  mk('tool', { toolCalls: [{ id: 't1', name: 'read_file', status: 'success' } as never] }),
  mk('carrier', {
    injections: [{ id: 'i1', title: '上下文状态切换', metadata: { mode: 'context-state', model: 'm' } } as never],
    blocks: [{ type: 'context_injection', id: 'i1' } as never],
  }),
];

describe('MessageContent ⇔ isRenderableAssistantMessage', () => {
  for (const msg of FIXTURES) {
    it(`${msg.id}`, () => {
      const { container } = render(
        <MessageContent msg={msg} isThinkingMsg={false} toolStackProps={{ activeSessionId: 's' }} />
      );
      const renderedNull = container.innerHTML === '';
      expect(renderedNull).toBe(!isRenderableAssistantMessage(msg));
    });
  }
});
