/**
 * P1-e：注入时只写入变化字段，并附 changed[]。
 * 无变化则不注入（文本签名去重，或结构化差分都为空）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushContextStateBeforeSend } from './slashSendQueueHelper';
import {
  recordPendingContextState,
  resetPendingContextStateForTest,
} from '../../api/provider-profiles/contextStatePending';
import {
  sessionRuntimeRegistry,
  setLastSentContextSignature,
  setLastSentContextSnapshot,
  setSessionThinkingTitle,
} from '../../api/SessionRuntimeRegistry';
import { useSessionStore } from '../../store/sessionStore';
import { usePermissionStore } from '../../store/permissionStore';
import { formatContextStateDisplayText } from '../../components/chat-message/contextStateUtils';

const SID = 'sess-diff';

function seedSession(): void {
  const session = {
    id: SID,
    title: '差分',
    messages: [
      { id: 'm0', sender: 'user' as const, text: 'hi', timestamp: 1 },
    ],
    createdAt: 1,
    updatedAt: 1,
  };
  useSessionStore.setState({
    sessions: [session],
    sessionsById: { [SID]: session },
    activeSessionId: SID,
  });
}

function messages() {
  return (
    useSessionStore.getState().sessions.find((s) => s.id === SID)?.messages ?? []
  );
}

function lastContextMetadata(): Record<string, unknown> | undefined {
  const carrier = [...messages()]
    .reverse()
    .find((m) => m.injections?.some((inj) => inj.metadata?.mode === 'context-state'));
  return carrier?.injections?.[0]?.metadata as Record<string, unknown> | undefined;
}

describe('flushContextStateBeforeSend context diff', () => {
  beforeEach(() => {
    localStorage.clear();
    resetPendingContextStateForTest();
    sessionRuntimeRegistry.clearAll();
    usePermissionStore.getState().setPermissionMode('ask');
    seedSession();
    localStorage.setItem('crish_active_model_id', 'ornith-1.5-9b');
    localStorage.setItem('crish_active_profile_id', 'local');
    setSessionThinkingTitle(SID, 'High');
  });

  afterEach(() => {
    resetPendingContextStateForTest();
    sessionRuntimeRegistry.clearAll();
    localStorage.clear();
  });

  it('first injection of a session writes every present field into changed[]', () => {
    recordPendingContextState(SID);
    const flushed = flushContextStateBeforeSend(SID);
    expect(flushed).toContain('ornith-1.5-9b');

    const metadata = lastContextMetadata();
    expect(metadata?.changed).toEqual([
      'model',
      'profile',
      'permission',
      'thinking',
    ]);
    expect(metadata?.model).toBe('ornith-1.5-9b');
    expect(metadata?.permission).toBe('ask');
    expect(metadata?.thinking).toBe('High');
    expect(formatContextStateDisplayText({ metadata })).toBe(
      '已切换到 ornith-1.5-9b · 服务商 local · 权限 需确认 · 思考 High'
    );
  });

  it('after a baseline, only the changed field is written', () => {
    expect(flushContextStateBeforeSend(SID)).toBeUndefined();
    const before = messages().length;

    setSessionThinkingTitle(SID, 'Low');
    recordPendingContextState(SID);
    const flushed = flushContextStateBeforeSend(SID);
    expect(flushed).toContain('思考档位：Low');

    expect(messages().length).toBe(before + 1);
    const metadata = lastContextMetadata();
    expect(metadata?.changed).toEqual(['thinking']);
    expect(metadata?.thinking).toBe('Low');
    expect(metadata?.model).toBeUndefined();
    expect(metadata?.permission).toBeUndefined();
    expect(metadata?.profile).toBeUndefined();
    expect(formatContextStateDisplayText({ metadata })).toBe('思考 Low');
  });

  it('permission full is stored raw and displayed with the shared Chinese label', () => {
    expect(flushContextStateBeforeSend(SID)).toBeUndefined();
    usePermissionStore.getState().setPermissionMode('full');
    recordPendingContextState(SID);
    flushContextStateBeforeSend(SID);

    const metadata = lastContextMetadata();
    expect(metadata?.changed).toEqual(['permission']);
    expect(metadata?.permission).toBe('full');
    expect(formatContextStateDisplayText({ metadata })).toBe('权限 完全访问');
  });

  it('no field change does not inject, including when the text signature would still differ', () => {
    expect(flushContextStateBeforeSend(SID)).toBeUndefined();
    const before = messages().length;

    recordPendingContextState(SID);
    expect(flushContextStateBeforeSend(SID)).toBeUndefined();
    expect(messages().length).toBe(before);

    setLastSentContextSnapshot(SID, {
      model: 'ornith-1.5-9b',
      profile: 'local',
      permission: 'ask',
      thinking: 'High',
    });
    setLastSentContextSignature(SID, 'stale-text-signature');
    recordPendingContextState(SID);
    expect(flushContextStateBeforeSend(SID)).toBeUndefined();
    expect(messages().length).toBe(before);
  });
});
