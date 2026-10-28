import { describe, it, expect } from 'vitest';
import {
  isContextStateInjection,
  formatContextStateDisplayText,
  dedupeStateCarrierMessages,
} from '../contextStateUtils';
import type {
  MessageContextInjection,
  SessionMessage,
} from '../../../store/types';
import { permissionModeLabel } from '../../../api/permissionModes';

describe('contextStateUtils', () => {
  it('isContextStateInjection correctly identifies state injections', () => {
    expect(
      isContextStateInjection({
        id: 'inj-1',
        metadata: { mode: 'context-state' },
      } as Partial<MessageContextInjection>)
    ).toBe(true);

    expect(
      isContextStateInjection({
        id: 'inj-2',
        title: '上下文状态切换',
      } as Partial<MessageContextInjection>)
    ).toBe(true);

    expect(
      isContextStateInjection({
        id: 'inj-3',
        title: '附件: test.txt',
      } as Partial<MessageContextInjection>)
    ).toBe(false);
  });

  it('formatContextStateDisplayText formats structured metadata with zero emojis', () => {
    const text = formatContextStateDisplayText({
      id: 'inj-1',
      metadata: {
        mode: 'context-state',
        model: 'deepseek-chat',
        permission: 'ask',
        thinking: 'high',
      },
    } as Partial<MessageContextInjection>);

    expect(text).toBe(
      `已切换到 deepseek-chat · 权限 ${permissionModeLabel('ask')} · 思考 high`
    );
    // Strict assertion: zero emoji in output
    expect(/[\u{1F300}-\u{1F9FF}]/u.test(text)).toBe(false);
  });

  it('formatContextStateDisplayText formats raw fallback text cleanly', () => {
    const text = formatContextStateDisplayText(
      undefined,
      '[系统上下文注入 · 状态切换] 当前已切换到模型 deepseek-chat。 权限模式: full'
    );
    expect(text).toBe(
      `已切换到 deepseek-chat · 权限 ${permissionModeLabel('full')}`
    );
    expect(/[\u{1F300}-\u{1F9FF}]/u.test(text)).toBe(false);
  });

  it('dedupeStateCarrierMessages eliminates consecutive carrier duplicates', () => {
    const m1: Partial<SessionMessage> = {
      id: 'm1',
      sender: 'assistant',
      blocks: [
        {
          type: 'context_injection',
          injection: {
            id: 'inj1',
            kind: 'workspace_env',
            title: '上下文状态切换',
            metadata: { mode: 'context-state' },
          },
        },
      ],
    };
    const m2: Partial<SessionMessage> = {
      id: 'm2',
      sender: 'assistant',
      blocks: [
        {
          type: 'context_injection',
          injection: {
            id: 'inj2',
            kind: 'workspace_env',
            title: '上下文状态切换',
            metadata: { mode: 'context-state' },
          },
        },
      ],
    };
    const m3: Partial<SessionMessage> = {
      id: 'm3',
      sender: 'assistant',
      text: '你好！',
    };

    const res = dedupeStateCarrierMessages([
      m1 as SessionMessage,
      m2 as SessionMessage,
      m3 as SessionMessage,
    ]);

    expect(res).toHaveLength(2);
    expect(res[0].id).toBe('m2');
    expect(res[1].id).toBe('m3');
  });

  it('formatContextStateDisplayText shows only changed fields, joined without a trailing period', () => {
    const text = formatContextStateDisplayText({
      id: 'inj-changed',
      metadata: {
        mode: 'context-state',
        model: 'ornith-1.5-9b',
        permission: 'full',
        thinking: 'High',
        changed: ['model', 'thinking'],
      },
    } as Partial<MessageContextInjection>);

    expect(text).toBe('已切换到 ornith-1.5-9b · 思考 High');
    expect(text.startsWith('系统')).toBe(false);
    expect(text.endsWith('。')).toBe(false);
  });

  it('formatContextStateDisplayText maps permission full to the shared label', () => {
    const text = formatContextStateDisplayText({
      metadata: {
        mode: 'context-state',
        permission: 'full',
        changed: ['permission'],
      },
    } as Partial<MessageContextInjection>);
    expect(text).toBe(`权限 ${permissionModeLabel('full')}`);
  });
});
