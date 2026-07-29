/**
 * D2-5 silent-complete pure helper tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMessage } from '../store/layoutStore';
import {
  getControlMetrics,
  resetControlMetrics,
} from './controlMetrics';
import {
  projectSessionMessagesToUserView,
  type UserViewMessage,
} from './messageUserProjection';
import {
  alertSilentComplete,
  checkAndAlertSilentComplete,
  isSilentComplete,
  isSilentCompleteFromSessionMessage,
  isSilentCompleteFromUserView,
  isSilentCompleteUserViewMessage,
  resetSilentCompleteWarned,
} from './silentComplete';

function userMsg(id: string, text: string): SessionMessage {
  return { id, sender: 'user', text, timestamp: 1 };
}

function asstMsg(
  id: string,
  partial: Partial<SessionMessage> = {}
): SessionMessage {
  return {
    id,
    sender: 'assistant',
    text: '',
    timestamp: 2,
    status: 'completed',
    ...partial,
  };
}

function uvAsst(
  partial: Partial<UserViewMessage> & { id: string }
): UserViewMessage {
  return {
    sender: 'assistant',
    visibleText: '',
    thinkingHidden: true,
    tools: [],
    ...partial,
  };
}

describe('isSilentComplete (pure)', () => {
  it('empty assistant UserView message → silent empty_visible', () => {
    const r = isSilentCompleteUserViewMessage(
      uvAsst({ id: 'a1', visibleText: '' })
    );
    expect(r.silent).toBe(true);
    expect(r.reason).toBe('empty_visible');
    expect(r.messageId).toBe('a1');
  });

  it('thinking-only (preview, no text/tools) → silent thinking_only', () => {
    const r = isSilentCompleteUserViewMessage(
      uvAsst({
        id: 'a1',
        visibleText: '  ',
        thinkingPreview: 'I will plan…',
        thinkingHidden: true,
      })
    );
    expect(r.silent).toBe(true);
    expect(r.reason).toBe('thinking_only');
  });

  it('has visible text → not silent', () => {
    const r = isSilentCompleteUserViewMessage(
      uvAsst({ id: 'a1', visibleText: 'Hello' })
    );
    expect(r.silent).toBe(false);
    expect(r.reason).toBe('not_silent');
  });

  it('has tools only (no text) → not silent', () => {
    const r = isSilentCompleteUserViewMessage(
      uvAsst({
        id: 'a1',
        tools: [
          {
            id: 't1',
            name: 'bash',
            summary: 'ran ls',
            hasRaw: false,
            status: 'success',
          },
        ],
      })
    );
    expect(r.silent).toBe(false);
    expect(r.reason).toBe('not_silent');
  });

  it('user message → not silent', () => {
    const r = isSilentCompleteUserViewMessage({
      id: 'u1',
      sender: 'user',
      visibleText: '',
      thinkingHidden: true,
      tools: [],
    });
    expect(r.silent).toBe(false);
    expect(r.detail).toBe('not_assistant');
  });

  it('null / undefined → not silent', () => {
    expect(isSilentComplete(null).silent).toBe(false);
    expect(isSilentComplete(undefined).silent).toBe(false);
  });
});

describe('isSilentComplete from SessionMessage / projection', () => {
  it('empty session assistant → silent', () => {
    const r = isSilentCompleteFromSessionMessage(asstMsg('a1'));
    expect(r.silent).toBe(true);
    expect(r.reason).toBe('empty_visible');
  });

  it('placeholder thinking only → silent empty_visible (placeholder stripped)', () => {
    // projectSessionMessageToUserView skips placeholder thinking
    const r = isSilentCompleteFromSessionMessage(
      asstMsg('a1', { thinking: '正在处理…' })
    );
    expect(r.silent).toBe(true);
    expect(r.reason).toBe('empty_visible');
  });

  it('real thinking only → silent thinking_only', () => {
    const r = isSilentCompleteFromSessionMessage(
      asstMsg('a1', { thinking: '先分析一下需求……' })
    );
    expect(r.silent).toBe(true);
    expect(r.reason).toBe('thinking_only');
  });

  it('assistant with text → not silent', () => {
    const r = isSilentCompleteFromSessionMessage(
      asstMsg('a1', { text: '答案在此' })
    );
    expect(r.silent).toBe(false);
  });

  it('assistant with toolCalls → not silent', () => {
    const r = isSilentCompleteFromSessionMessage(
      asstMsg('a1', {
        toolCalls: [
          {
            id: 'tc1',
            name: 'read_file',
            status: 'success',
            arguments: '{}',
            output: 'ok',
          },
        ],
      })
    );
    expect(r.silent).toBe(false);
  });

  it('unified isSilentComplete(SessionMessage)', () => {
    expect(isSilentComplete(asstMsg('a1')).silent).toBe(true);
    expect(isSilentComplete(asstMsg('a1', { text: 'x' })).silent).toBe(false);
  });

  it('UserView DTO last assistant', () => {
    const dto = projectSessionMessagesToUserView([
      userMsg('u1', '问'),
      asstMsg('a1', { thinking: 'hidden plan only' }),
    ]);
    const r = isSilentCompleteFromUserView(dto);
    expect(r.silent).toBe(true);
    expect(r.reason).toBe('thinking_only');
    expect(r.messageId).toBe('a1');
  });

  it('UserView DTO by messageId', () => {
    const dto = projectSessionMessagesToUserView([
      userMsg('u1', '问'),
      asstMsg('a1', { text: '有内容' }),
      asstMsg('a2'),
    ]);
    expect(isSilentComplete(dto, { messageId: 'a1' }).silent).toBe(false);
    expect(isSilentComplete(dto, { messageId: 'a2' }).silent).toBe(true);
  });

  it('thought placeholders in text strip to silent', () => {
    // stripThoughtPlaceholders may leave empty when only placeholders
    const r = isSilentCompleteFromSessionMessage(
      asstMsg('a1', { text: '' })
    );
    expect(r.silent).toBe(true);
  });
});

describe('alertSilentComplete / checkAndAlertSilentComplete', () => {
  beforeEach(() => {
    resetControlMetrics();
    resetSilentCompleteWarned();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records silent_complete metric when silent', () => {
    const r = isSilentComplete(asstMsg('a1'));
    alertSilentComplete(r, { silentConsole: true });
    expect(getControlMetrics().silent_complete).toBe(1);
  });

  it('does not record metric when not silent', () => {
    const r = isSilentComplete(asstMsg('a1', { text: 'ok' }));
    alertSilentComplete(r, { forceConsole: true });
    expect(getControlMetrics().silent_complete).toBe(0);
  });

  it('checkAndAlertSilentComplete wires session message', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = checkAndAlertSilentComplete(asstMsg('a-silent'), {
      sessionId: 's1',
      forceConsole: true,
    });
    expect(r.silent).toBe(true);
    expect(getControlMetrics().silent_complete).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('silent-complete');
    expect(String(warn.mock.calls[0]?.[0])).toContain('a-silent');
  });

  it('console.warn once per messageId', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = isSilentComplete(asstMsg('same-id'));
    alertSilentComplete(r, { messageId: 'same-id', forceConsole: true });
    alertSilentComplete(r, { messageId: 'same-id', forceConsole: true });
    expect(getControlMetrics().silent_complete).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
