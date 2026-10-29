import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  cleanAllImportedExternalSessions,
  deleteImportedSession,
  getDeletedExternalSessionKeys,
} from './importSessions';
import { listSessions, replaceSessions } from '../../store/sessionIndex';
import type { SessionState } from '../../store/types';

const { mockState } = vi.hoisted(() => {
  const mockState = {
    sessionsById: {} as Record<string, SessionState>,
    sessionOrder: [] as string[],
    deleteSession: vi.fn((id: string) => {
      const idx = mockState.sessionOrder.indexOf(id);
      const inMap = Object.prototype.hasOwnProperty.call(
        mockState.sessionsById,
        id
      );
      if (idx < 0 && !inMap) return false;
      if (idx >= 0) mockState.sessionOrder.splice(idx, 1);
      if (inMap) delete mockState.sessionsById[id];
      return true;
    }),
  };
  return { mockState };
});

vi.mock('../../store', async () => {
  const { selectSessionList } = await import('../../store/sessionIndex');
  return {
    getSessionStoreState: () => mockState,
    selectSessionList,
  };
});

function shell(
  id: string,
  title: string,
  importMeta?: SessionState['importMeta']
): SessionState {
  return {
    id,
    title,
    folder: '',
    isPinned: false,
    isArchived: false,
    timestamp: '2026-08-01T00:00:00.000Z',
    messages: [],
    ...(importMeta ? { importMeta } : {}),
  };
}

describe('importSessions cleanup and tombstone management', () => {
  beforeEach(() => {
    localStorage.clear();
    mockState.deleteSession.mockClear();
    replaceSessions(mockState, []);
  });

  it('cleanAllImportedExternalSessions cleans only imported sessions and records tombstones', async () => {
    replaceSessions(mockState, [
      shell('user-sess-1', '用户正常对话'),
      shell('imported-sess-1', '外部空会话 1', {
        source: 'claude-code',
        sourceSessionId: 'claude-uuid-1',
      }),
      shell('imported-sess-2', '外部空会话 2', {
        source: 'codex',
        sourceSessionId: 'codex-uuid-2',
      }),
    ]);

    const count = await cleanAllImportedExternalSessions();
    expect(count).toBe(2);
    expect(mockState.deleteSession).toHaveBeenCalledTimes(2);
    expect(mockState.deleteSession).toHaveBeenCalledWith('imported-sess-1');
    expect(mockState.deleteSession).toHaveBeenCalledWith('imported-sess-2');

    // 用户正常会话应保留
    const left = listSessions(mockState);
    expect(left).toHaveLength(1);
    expect(left[0]?.id).toBe('user-sess-1');

    // 检查 tombstone 永久写入
    const tombstones = getDeletedExternalSessionKeys();
    expect(tombstones.has('claude-code::claude-uuid-1')).toBe(true);
    expect(tombstones.has('codex::codex-uuid-2')).toBe(true);
  });

  it('cleanAllImportedExternalSessions returns 0 if no imported sessions exist', async () => {
    replaceSessions(mockState, [shell('user-sess-1', '用户正常对话')]);

    const count = await cleanAllImportedExternalSessions();
    expect(count).toBe(0);
    expect(mockState.deleteSession).not.toHaveBeenCalled();
  });

  it('deleteImportedSession removes single imported session and writes tombstone', () => {
    replaceSessions(mockState, [
      shell('imported-sess-3', '单个已接续会话', {
        source: 'claude-code',
        sourceSessionId: 'claude-single-3',
      }),
    ]);

    const ok = deleteImportedSession('imported-sess-3');
    expect(ok).toBe(true);
    expect(mockState.deleteSession).toHaveBeenCalledWith('imported-sess-3');

    const tombstones = getDeletedExternalSessionKeys();
    expect(tombstones.has('claude-code::claude-single-3')).toBe(true);
  });
});
