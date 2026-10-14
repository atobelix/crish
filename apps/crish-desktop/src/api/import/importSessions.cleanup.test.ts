import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  cleanAllImportedExternalSessions,
  deleteImportedSession,
  getDeletedExternalSessionKeys,
} from './importSessions';
import { getSessionStoreState } from '../../store';

vi.mock('../../store', () => {
  const mockState = {
    sessions: [] as any[],
    deleteSession: vi.fn((id: string) => {
      const idx = mockState.sessions.findIndex((s) => s.id === id);
      if (idx !== -1) {
        mockState.sessions.splice(idx, 1);
        return true;
      }
      return false;
    }),
  };
  return {
    getSessionStoreState: vi.fn(() => mockState),
  };
});

describe('importSessions cleanup and tombstone management', () => {
  beforeEach(() => {
    localStorage.clear();
    const st = getSessionStoreState() as any;
    st.deleteSession.mockClear();
    st.sessions = [];
  });

  it('cleanAllImportedExternalSessions cleans only imported sessions and records tombstones', async () => {
    const st = getSessionStoreState() as any;
    st.sessions = [
      {
        id: 'user-sess-1',
        title: '用户正常对话',
        messages: [],
      },
      {
        id: 'imported-sess-1',
        title: '外部空会话 1',
        importMeta: { source: 'claude-code', sourceSessionId: 'claude-uuid-1' },
        messages: [],
      },
      {
        id: 'imported-sess-2',
        title: '外部空会话 2',
        importMeta: { source: 'codex', sourceSessionId: 'codex-uuid-2' },
        messages: [],
      },
    ];

    const count = await cleanAllImportedExternalSessions();
    expect(count).toBe(2);
    expect(st.deleteSession).toHaveBeenCalledTimes(2);
    expect(st.deleteSession).toHaveBeenCalledWith('imported-sess-1');
    expect(st.deleteSession).toHaveBeenCalledWith('imported-sess-2');

    // 用户正常会话应保留
    expect(st.sessions).toHaveLength(1);
    expect(st.sessions[0].id).toBe('user-sess-1');

    // 检查 tombstone 永久写入
    const tombstones = getDeletedExternalSessionKeys();
    expect(tombstones.has('claude-code::claude-uuid-1')).toBe(true);
    expect(tombstones.has('codex::codex-uuid-2')).toBe(true);
  });

  it('cleanAllImportedExternalSessions returns 0 if no imported sessions exist', async () => {
    const st = getSessionStoreState() as any;
    st.sessions = [
      {
        id: 'user-sess-1',
        title: '用户正常对话',
        messages: [],
      },
    ];

    const count = await cleanAllImportedExternalSessions();
    expect(count).toBe(0);
    expect(st.deleteSession).not.toHaveBeenCalled();
  });

  it('deleteImportedSession removes single imported session and writes tombstone', () => {
    const st = getSessionStoreState() as any;
    st.sessions = [
      {
        id: 'imported-sess-3',
        title: '单个已接续会话',
        importMeta: {
          source: 'claude-code',
          sourceSessionId: 'claude-single-3',
        },
        messages: [],
      },
    ];

    const ok = deleteImportedSession('imported-sess-3');
    expect(ok).toBe(true);
    expect(st.deleteSession).toHaveBeenCalledWith('imported-sess-3');

    const tombstones = getDeletedExternalSessionKeys();
    expect(tombstones.has('claude-code::claude-single-3')).toBe(true);
  });
});
