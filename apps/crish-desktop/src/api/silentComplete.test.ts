/**
 * D2-5 silent-complete pure helper tests.
 * V1-α：判定单路化为 SessionMessage 直接判定（用户视图 DTO 分支随
 * 旧旁路投影删除）；silent-complete 行为测试保留并转绿。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMessage } from '../store/layoutStore';
import { getControlMetrics, resetControlMetrics } from './controlMetrics';
import {
  alertSilentComplete,
  checkAndAlertSilentComplete,
  computeAssistantVisibility,
  isSilentComplete,
  isSilentCompleteFromSessionMessage,
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

describe('computeAssistantVisibility (V1-α 单消息直接判定)', () => {
  it('空 assistant → 无正文 / 无工具 / 无 thinking', () => {
    const v = computeAssistantVisibility(asstMsg('a1'));
    expect(v.visibleText).toBe('');
    expect(v.thinkingPreview).toBe('');
    expect(v.hasTools).toBe(false);
  });

  it('剥思考占位后正文为空（仅占位思考）→ visibleText 空', () => {
    const v = computeAssistantVisibility(
      asstMsg('a1', { thinking: '正在处理…' })
    );
    expect(v.visibleText).toBe('');
    expect(v.thinkingPreview).toBe('');
  });

  it('真实 thinking → thinkingPreview 截断预览（占位不进）', () => {
    const v = computeAssistantVisibility(
      asstMsg('a1', { thinking: '先分析一下需求……' })
    );
    expect(v.visibleText).toBe('');
    expect(v.thinkingPreview).toContain('先分析一下需求');
    expect(v.hasTools).toBe(false);
  });

  it('text 为空但 blocks 有文本段 → visibleText 回退 blocks（\n\n 连接）', () => {
    const v = computeAssistantVisibility(
      asstMsg('a1', {
        text: '',
        blocks: [
          { type: 'text', content: '第一段' },
          { type: 'tool_call', id: 't1' },
          { type: 'text', content: '第二段' },
        ],
      })
    );
    expect(v.visibleText).toBe('第一段\n\n第二段');
  });

  it('toolCalls 按 id 去重后判 hasTools', () => {
    const v = computeAssistantVisibility(
      asstMsg('a1', {
        toolCalls: [
          { id: 't1', name: 'read_file', status: 'success' },
          { id: 't1', name: 'read_file', status: 'success' },
          { id: '', name: 'no_id', status: 'success' },
        ],
      })
    );
    expect(v.hasTools).toBe(true);
  });
});

describe('isSilentComplete (pure, SessionMessage 单路)', () => {
  it('empty assistant SessionMessage → silent empty_visible', () => {
    const r = isSilentCompleteFromSessionMessage(asstMsg('a1'));
    expect(r.silent).toBe(true);
    expect(r.reason).toBe('empty_visible');
    expect(r.messageId).toBe('a1');
  });

  it('thinking-only (preview, no text/tools) → silent thinking_only', () => {
    const r = isSilentCompleteFromSessionMessage(
      asstMsg('a1', { thinking: 'I will plan…' })
    );
    expect(r.silent).toBe(true);
    expect(r.reason).toBe('thinking_only');
  });

  it('placeholder thinking only → silent empty_visible (placeholder stripped)', () => {
    const r = isSilentCompleteFromSessionMessage(
      asstMsg('a1', { thinking: '正在处理…' })
    );
    expect(r.silent).toBe(true);
    expect(r.reason).toBe('empty_visible');
  });

  it('has visible text → not silent', () => {
    const r = isSilentCompleteFromSessionMessage(
      asstMsg('a1', { text: 'Hello' })
    );
    expect(r.silent).toBe(false);
    expect(r.reason).toBe('not_silent');
  });

  it('has tools only (no text) → not silent', () => {
    const r = isSilentCompleteFromSessionMessage(
      asstMsg('a1', {
        toolCalls: [
          {
            id: 't1',
            name: 'bash',
            status: 'success',
            output: 'ok',
          },
        ],
      })
    );
    expect(r.silent).toBe(false);
    expect(r.reason).toBe('not_silent');
  });

  it('user message → not silent', () => {
    const r = isSilentComplete(userMsg('u1', ''));
    expect(r.silent).toBe(false);
    expect(r.detail).toBe('not_assistant');
  });

  it('null / undefined → not silent', () => {
    expect(isSilentComplete(null).silent).toBe(false);
    expect(isSilentComplete(undefined).silent).toBe(false);
  });

  it('blocks 文本回退 → not silent', () => {
    const r = isSilentCompleteFromSessionMessage(
      asstMsg('a1', { text: '', blocks: [{ type: 'text', content: '正文' }] })
    );
    expect(r.silent).toBe(false);
  });

  it('last-assistant 语义：投影列表最后一条 assistant 空 → silent（messageId 在案）', () => {
    // 原用户视图 DTO 分支「last assistant」语义迁移：对最后一条 assistant 直判
    const a1 = asstMsg('a1', { thinking: 'hidden plan only' });
    const r = isSilentCompleteFromSessionMessage(a1);
    expect(r.silent).toBe(true);
    expect(r.reason).toBe('thinking_only');
    expect(r.messageId).toBe('a1');
  });

  it('isSilentComplete 按 messageId 直判（原 DTO by-messageId 语义迁移）', () => {
    const a1 = asstMsg('a1', { text: '有内容' });
    const a2 = asstMsg('a2');
    expect(isSilentComplete(a1, { messageId: 'a1' }).silent).toBe(false);
    expect(isSilentComplete(a2, { messageId: 'a2' }).silent).toBe(true);
    // messageId 不匹配 → not_silent(message_id_mismatch)
    expect(isSilentComplete(a1, { messageId: 'a2' }).silent).toBe(false);
  });

  it('unified isSilentComplete(SessionMessage)', () => {
    expect(isSilentComplete(asstMsg('a1')).silent).toBe(true);
    expect(isSilentComplete(asstMsg('a1', { text: 'x' })).silent).toBe(false);
  });

  it('thought placeholders in text strip to silent', () => {
    const r = isSilentCompleteFromSessionMessage(asstMsg('a1', { text: '' }));
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
