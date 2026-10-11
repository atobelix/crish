import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  if (
    typeof globalThis.localStorage !== 'undefined' &&
    typeof globalThis.localStorage?.getItem === 'function'
  ) {
    return;
  }
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
  });
});

import type { SessionMessage, SessionState } from '../store/layoutStore';
import {
  DEFAULT_SESSION_FOLDER,
  SESSION_ACTIVE_KEY,
  SESSION_AGENTS_PREFIX,
  SESSION_AGENTS_SAVE_CAP,
  SESSION_BODY_PREFIX,
  SESSION_FOLDER_KEY,
  SESSION_INDEX_KEY,
  deleteSessionBody,
  filterPersistableSessions,
  hydrateSessionAgents,
  hydrateSessionsFromDisk,
  loadActiveSessionId,
  loadFolderOrder,
  loadSessionAgents,
  loadSessionBody,
  loadSessionIndex,
  normalizePinnedMessageIds,
  parseFolderOrder,
  parseSessionAgent,
  parseSessionAgents,
  parseSessionIndexEntry,
  parseSessionIndexList,
  parseSessionMessage,
  parseSessionMessages,
  persistAllSessions,
  safeParseJson,
  sanitizeMessagesForHydrate,
  saveActiveSessionId,
  saveFolderOrder,
  saveSessionIndex,
  sessionsToIndex,
  type SessionIndexEntry,
} from './sessionPersistence';
import { EMPTY_SESSION_TITLE } from './sessionTitle';
import { PENDING_DRAFT_SESSION_ID } from '../store/draftSession';

/** 测试内联 LS 写口（D-F06 后生产无 saveSessionBody/Agents；仅测历史键行为）。 */
function seedLsBody(id: string, messages: SessionMessage[]): void {
  if (!id || id === PENDING_DRAFT_SESSION_ID) return;
  try {
    localStorage.setItem(SESSION_BODY_PREFIX + id, JSON.stringify(messages));
  } catch {
    /* swallow */
  }
}
function seedLsAgents(
  id: string,
  agents: Array<{ id: string; [k: string]: unknown }>
): void {
  if (!id || id === PENDING_DRAFT_SESSION_ID) return;
  if (!agents?.length) {
    try {
      localStorage.removeItem(SESSION_AGENTS_PREFIX + id);
    } catch {
      /* swallow */
    }
    return;
  }
  try {
    localStorage.setItem(
      SESSION_AGENTS_PREFIX + id,
      JSON.stringify(
        agents.length > SESSION_AGENTS_SAVE_CAP
          ? agents.slice(0, SESSION_AGENTS_SAVE_CAP)
          : agents
      )
    );
  } catch {
    /* swallow */
  }
}

function baseMsg(
  partial: Partial<SessionMessage> & Pick<SessionMessage, 'id' | 'sender'>
): SessionMessage {
  return {
    timestamp: 1_700_000_000_000,
    text: '',
    ...partial,
  };
}

function baseSession(
  partial: Partial<SessionState> & Pick<SessionState, 'id'>
): SessionState {
  return {
    title: EMPTY_SESSION_TITLE,
    folder: DEFAULT_SESSION_FOLDER,
    isPinned: false,
    isArchived: false,
    timestamp: new Date(1_700_000_000_000).toISOString(),
    messages: [],
    ...partial,
  };
}

describe('safeParseJson', () => {
  it('returns fallback for null / empty / corrupt JSON', () => {
    expect(safeParseJson(null, 42)).toBe(42);
    expect(safeParseJson(undefined, [])).toEqual([]);
    expect(safeParseJson('', { a: 1 })).toEqual({ a: 1 });
    expect(safeParseJson('{not-json', [])).toEqual([]);
    expect(safeParseJson('null', 'fb' as unknown)).toBe(null);
  });

  it('parses valid JSON', () => {
    expect(safeParseJson('{"x":1}', null)).toEqual({ x: 1 });
    expect(safeParseJson('[1,2]', [])).toEqual([1, 2]);
  });
});

describe('parseSessionIndexEntry / parseSessionIndexList', () => {
  it('rejects non-objects and missing id', () => {
    expect(parseSessionIndexEntry(null)).toBeNull();
    expect(parseSessionIndexEntry('s1')).toBeNull();
    expect(parseSessionIndexEntry([])).toBeNull();
    expect(parseSessionIndexEntry({})).toBeNull();
    expect(parseSessionIndexEntry({ id: '  ' })).toBeNull();
    expect(parseSessionIndexEntry({ id: 9 })).toBeNull();
  });

  it('I-DRAFT: rejects PENDING_DRAFT sentinel id', () => {
    expect(
      parseSessionIndexEntry({ id: PENDING_DRAFT_SESSION_ID, title: 'draft' })
    ).toBeNull();
    expect(
      parseSessionIndexList([
        { id: PENDING_DRAFT_SESSION_ID, title: 'draft' },
        { id: 'real', title: 'R' },
      ]).map((e) => e.id)
    ).toEqual(['real']);
  });

  it('fills migration defaults for partial entries', () => {
    const e = parseSessionIndexEntry({ id: 's1' });
    expect(e).toMatchObject({
      id: 's1',
      title: EMPTY_SESSION_TITLE,
      folder: DEFAULT_SESSION_FOLDER,
      isPinned: false,
      isArchived: false,
      updatedAt: 0,
      messageCount: 0,
      timestamp: '',
    });
    expect(e?.pinnedMessageIds).toBeUndefined();
    expect(e?.engineCursor).toBeUndefined();
    expect(e?.titleSource).toBeUndefined();
  });

  it('titleSource round-trips and missing field stays absent', () => {
    const user = parseSessionIndexEntry({ id: 'u', title: '手改', titleSource: 'user' });
    expect(user?.titleSource).toBe('user');
    const trivial = parseSessionIndexEntry({
      id: 't',
      title: 'hi',
      titleSource: 'auto-trivial',
    });
    expect(trivial?.titleSource).toBe('auto-trivial');
    const junk = parseSessionIndexEntry({ id: 'j', title: 'x', titleSource: 'manual' });
    expect(junk?.titleSource).toBeUndefined();

    const s = baseSession({
      id: 's-user',
      title: '手改',
      titleSource: 'user',
      messages: [baseMsg({ id: 'm1', sender: 'user', text: 'hi', timestamp: 50 })],
    });
    const idx = sessionsToIndex([s]);
    expect(idx[0]?.titleSource).toBe('user');
    saveSessionIndex(idx);
    const hydrated = hydrateSessionsFromDisk();
    expect(hydrated.sessions[0]?.titleSource).toBe('user');
    expect(hydrated.sessions[0]?.title).toBe('手改');

    const legacy = baseSession({ id: 'legacy', title: '旧标题' });
    const legacyIdx = sessionsToIndex([legacy]);
    expect(legacyIdx[0]?.titleSource).toBeUndefined();
    saveSessionIndex(legacyIdx);
    const legacyHydrated = hydrateSessionsFromDisk();
    expect(legacyHydrated.sessions).toHaveLength(1);
    expect(legacyHydrated.sessions[0]?.titleSource).toBeUndefined();
  });

  it('normalizes numbers / pins / engine fields', () => {
    const e = parseSessionIndexEntry({
      id: 's2',
      title: '  标题  ',
      folder: ' 工作 ',
      isPinned: true,
      isArchived: 1 as unknown as boolean,
      timestamp: 1700000000000,
      updatedAt: '123',
      messageCount: 2.9,
      pinnedMessageIds: ['m1', ' m1 ', '', 3, 'm2'],
      engineCursor: 4.2,
      engineLastRunId: ' run-1 ',
      hydratedFromEngine: true,
      branchParentId: ' parent ',
    });
    expect(e).toMatchObject({
      id: 's2',
      title: '标题',
      folder: '工作',
      isPinned: true,
      isArchived: false,
      updatedAt: 123,
      messageCount: 2,
      timestamp: '1700000000000',
      engineCursor: 4,
      engineLastRunId: 'run-1',
      hydratedFromEngine: true,
      branchParentId: 'parent',
    });
    expect(e?.pinnedMessageIds).toEqual(['m1', 'm2']);
  });

  it('list guard: non-array → []; drops invalid; first-wins dedupe', () => {
    expect(parseSessionIndexList(null)).toEqual([]);
    expect(parseSessionIndexList({ id: 'x' })).toEqual([]);
    const list = parseSessionIndexList([
      { id: 'a', title: 'A' },
      null,
      { id: 'a', title: 'A2' },
      { title: 'no-id' },
      { id: 'b', title: 'B' },
    ]);
    expect(list.map((x) => x.id)).toEqual(['a', 'b']);
    expect(list![0]!.title).toBe('A');
  });
});

describe('normalizePinnedMessageIds', () => {
  it('filters and dedupes; empty → undefined', () => {
    expect(normalizePinnedMessageIds(null)).toBeUndefined();
    expect(normalizePinnedMessageIds([])).toBeUndefined();
    expect(normalizePinnedMessageIds(['', '  '])).toBeUndefined();
    expect(normalizePinnedMessageIds(['a', 'a', ' b '])).toEqual(['a', 'b']);
  });
});

describe('parseSessionMessage / parseSessionMessages / jsonl', () => {
  it('rejects missing id/sender', () => {
    expect(parseSessionMessage(null)).toBeNull();
    expect(parseSessionMessage({ sender: 'user', timestamp: 1 })).toBeNull();
    expect(
      parseSessionMessage({ id: 'm', sender: 'system', timestamp: 1 })
    ).toBeNull();
  });

  it('accepts user/assistant and coerces toolCalls', () => {
    const m = parseSessionMessage({
      id: 'm1',
      sender: 'assistant',
      timestamp: '99',
      text: 'hi',
      status: 'processing',
      toolCalls: [
        { id: 't1', name: 'bash', arguments: { x: 1 }, status: 'running' },
        { name: 'no-id' },
        null,
      ],
      blocks: [
        { type: 'text', content: 'a' },
        { type: 'tool_call', id: 't1' },
        { type: 'unknown' },
      ],
    });
    expect(m).toMatchObject({
      id: 'm1',
      sender: 'assistant',
      timestamp: 99,
      text: 'hi',
      status: 'processing',
    });
    expect(m?.toolCalls).toHaveLength(1);
    expect(m?.toolCalls?.[0]).toMatchObject({
      id: 't1',
      name: 'bash',
      status: 'running',
      arguments: '{"x":1}',
    });
    expect(m?.blocks).toEqual([
      { type: 'text', content: 'a' },
      { type: 'tool_call', id: 't1' },
    ]);
  });

  it('parseSessionMessages drops non-array and bad rows', () => {
    expect(parseSessionMessages(null)).toEqual([]);
    expect(
      parseSessionMessages([
        baseMsg({ id: 'ok', sender: 'user' }),
        { id: 'bad' },
      ])
    ).toHaveLength(1);
  });
});

describe('sanitizeMessagesForHydrate', () => {
  it('closes processing streams and interrupted tools', () => {
    const out = sanitizeMessagesForHydrate([
      baseMsg({
        id: 'a1',
        sender: 'assistant',
        status: 'processing',
        text: '',
        toolCalls: [
          {
            id: 't1',
            name: 'bash',
            arguments: '{}',
            status: 'running',
          },
          {
            id: 't2',
            name: 'bash',
            arguments: '{}',
            status: 'pending_approval',
            output: 'partial',
          },
          {
            id: 't3',
            name: 'bash',
            arguments: '{}',
            status: 'success',
            output: 'ok',
          },
        ],
      }),
    ]);
    expect(out![0]!.status).toBe('completed');
    expect(out![0]!.text).toBe('');
    expect(out![0]!.toolCalls?.[0]!.status).toBe('error');
    expect(out![0]!.toolCalls?.[0]!.output).toContain('中断');
    expect(out![0]!.toolCalls?.[1]!.output).toBe('partial');
    expect(out![0]!.toolCalls?.[2]!.status).toBe('success');
  });

  it('strips legacy 已结束。 assistant text', () => {
    const out = sanitizeMessagesForHydrate([
      baseMsg({ id: 'a', sender: 'assistant', text: '已结束。' }),
    ]);
    expect(out![0]!.text).toBe('');
  });

  it('empty input stays empty', () => {
    expect(sanitizeMessagesForHydrate([])).toEqual([]);
  });
});

describe('parseSessionAgent / hydrateSessionAgents', () => {
  it('requires core ids', () => {
    expect(parseSessionAgent({ id: 'a' })).toBeNull();
    expect(
      parseSessionAgent({
        id: 'a',
        subagentRunId: 'r',
        parentSessionId: 'p',
        parentRunId: 'pr',
      })
    ).toMatchObject({
      id: 'a',
      status: 'stopped',
      messages: [],
      description: '',
      mode: '',
    });
  });

  it('hydrate converts running → stopped with summary', () => {
    const agents = hydrateSessionAgents([
      {
        id: 'ag1',
        subagentRunId: 'r1',
        parentSessionId: 's1',
        parentRunId: 'pr1',
        description: 'd',
        mode: 'research',
        status: 'running',
        messages: [
          baseMsg({
            id: 'm',
            sender: 'assistant',
            status: 'processing',
            text: 'half',
          }),
        ],
        startedAt: 1,
        depth: 0,
        subagentPath: ['ag1'],
      },
    ]);
    expect(agents![0]!.status).toBe('stopped');
    expect(agents![0]!.summary).toContain('中断');
    expect(agents![0]!.messages[0]!.status).toBe('completed');
    expect(agents![0]!.messages[0]!.text).toBe('half');
  });

  it('parseSessionAgents dedupes and filters', () => {
    const list = parseSessionAgents([
      {
        id: 'a',
        subagentRunId: 'r',
        parentSessionId: 'p',
        parentRunId: 'pr',
      },
      {
        id: 'a',
        subagentRunId: 'r2',
        parentSessionId: 'p',
        parentRunId: 'pr',
      },
      { id: 'bad' },
    ]);
    expect(list).toHaveLength(1);
    expect(list![0]!.subagentRunId).toBe('r');
  });
});

describe('parseFolderOrder', () => {
  it('null for non-array / all-invalid; keeps empty array', () => {
    expect(parseFolderOrder(null)).toBeNull();
    expect(parseFolderOrder('x')).toBeNull();
    expect(parseFolderOrder([1, null, ''])).toBeNull();
    expect(parseFolderOrder([])).toEqual([]);
    expect(parseFolderOrder([' a ', 'a', 'b', 3])).toEqual(['a', 'b']);
  });
});

describe('localStorage load/save shape guards', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('loadSessionIndex: empty / corrupt / non-array → [] (no invented shells)', () => {
    expect(loadSessionIndex()).toEqual([]);
    localStorage.setItem(SESSION_INDEX_KEY, '{broken');
    expect(loadSessionIndex()).toEqual([]);
    localStorage.setItem(SESSION_INDEX_KEY, '{"id":"x"}');
    expect(loadSessionIndex()).toEqual([]);
    localStorage.setItem(
      SESSION_INDEX_KEY,
      JSON.stringify([{ id: 'ok', title: 'T' }, { no: 'id' }])
    );
    const idx = loadSessionIndex();
    expect(idx).toHaveLength(1);
    expect(idx![0]!.id).toBe('ok');
  });

  it('saveSessionIndex re-guards and round-trips', () => {
    saveSessionIndex([
      {
        id: 's1',
        title: 'A',
        folder: 'F',
        isPinned: false,
        isArchived: false,
        timestamp: '',
        updatedAt: 1,
        messageCount: 0,
      },
      {
        id: '',
        title: 'drop',
        folder: 'F',
        isPinned: false,
        isArchived: false,
        timestamp: '',
        updatedAt: 1,
        messageCount: 0,
      } as SessionIndexEntry,
    ]);
    const loaded = loadSessionIndex();
    expect(loaded).toHaveLength(1);
    expect(loaded![0]!.title).toBe('A');
  });

  it('loadSessionBody: missing / JSON array / corrupt', () => {
    expect(loadSessionBody('')).toEqual([]);
    expect(loadSessionBody('missing')).toEqual([]);

    const msgs = [baseMsg({ id: 'm1', sender: 'user', text: 'hi' })];
    localStorage.setItem(SESSION_BODY_PREFIX + 's1', JSON.stringify(msgs));
    expect(loadSessionBody('s1')).toEqual(msgs);

    localStorage.setItem(SESSION_BODY_PREFIX + 's1', '{not-json-array');
    expect(loadSessionBody('s1')).toEqual([]);

    seedLsBody('s2', msgs);
    expect(loadSessionBody('s2')).toEqual(msgs);
  });

  it('deleteSessionBody removes body + agents', () => {
    seedLsBody('d1', [baseMsg({ id: 'm', sender: 'user' })]);
    seedLsAgents('d1', [
      {
        id: 'ag',
        subagentRunId: 'r',
        parentSessionId: 'd1',
        parentRunId: 'pr',
        description: '',
        mode: 'research',
        status: 'completed',
        messages: [],
        startedAt: 1,
        depth: 0,
        subagentPath: ['ag'],
      },
    ]);
    deleteSessionBody('d1');
    expect(loadSessionBody('d1')).toEqual([]);
    expect(loadSessionAgents('d1')).toEqual([]);
  });

  it('loadSessionAgents: corrupt → []; running hydrated to stopped', () => {
    expect(loadSessionAgents('x')).toEqual([]);
    localStorage.setItem(SESSION_AGENTS_PREFIX + 's', 'not-json');
    expect(loadSessionAgents('s')).toEqual([]);

    localStorage.setItem(
      SESSION_AGENTS_PREFIX + 's',
      JSON.stringify([
        {
          id: 'ag',
          subagentRunId: 'r',
          parentSessionId: 's',
          parentRunId: 'pr',
          description: 'd',
          mode: 'research',
          status: 'running',
          messages: [],
          startedAt: 1,
        },
      ])
    );
    const agents = loadSessionAgents('s');
    expect(agents![0]!.status).toBe('stopped');
  });

  it('seedLsAgents removes key when empty; caps length', () => {
    const make = (i: number) => ({
      id: `ag${i}`,
      subagentRunId: `r${i}`,
      parentSessionId: 's',
      parentRunId: 'pr',
      description: '',
      mode: 'research' as const,
      status: 'completed' as const,
      messages: [],
      startedAt: i,
      depth: 0,
      subagentPath: [`ag${i}`],
    });
    seedLsAgents('s', [make(1)]);
    expect(localStorage.getItem(SESSION_AGENTS_PREFIX + 's')).toBeTruthy();
    seedLsAgents('s', []);
    expect(localStorage.getItem(SESSION_AGENTS_PREFIX + 's')).toBeNull();

    const many = Array.from({ length: SESSION_AGENTS_SAVE_CAP + 10 }, (_, i) =>
      make(i)
    );
    seedLsAgents('s', many);
    const stored = JSON.parse(
      localStorage.getItem(SESSION_AGENTS_PREFIX + 's')!
    );
    expect(stored).toHaveLength(SESSION_AGENTS_SAVE_CAP);
  });

  it('active session id trim / clear empty', () => {
    expect(loadActiveSessionId()).toBeNull();
    saveActiveSessionId('  s1  ');
    expect(loadActiveSessionId()).toBe('s1');
    saveActiveSessionId('');
    expect(loadActiveSessionId()).toBeNull();
    localStorage.setItem(SESSION_ACTIVE_KEY, '   ');
    expect(loadActiveSessionId()).toBeNull();
  });

  it('folder order corrupt recovery', () => {
    expect(loadFolderOrder()).toBeNull();
    localStorage.setItem(SESSION_FOLDER_KEY, '{bad');
    expect(loadFolderOrder()).toBeNull();
    localStorage.setItem(SESSION_FOLDER_KEY, JSON.stringify([1, 2]));
    expect(loadFolderOrder()).toBeNull();
    saveFolderOrder([' 常规会话 ', '常规会话', '工作']);
    expect(loadFolderOrder()).toEqual(['常规会话', '工作']);
    saveFolderOrder([]);
    expect(loadFolderOrder()).toEqual([]);
  });
});

describe('sessionsToIndex / hydrate / persist edges', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('sessionsToIndex empty list → []; preserves updatedAt when meta unchanged', () => {
    expect(sessionsToIndex([])).toEqual([]);
    const s = baseSession({
      id: 's1',
      title: 'T',
      messages: [
        baseMsg({ id: 'm1', sender: 'user', text: 'hi', timestamp: 50 }),
      ],
    });
    saveSessionIndex([
      {
        id: 's1',
        title: 'T',
        folder: DEFAULT_SESSION_FOLDER,
        isPinned: false,
        isArchived: false,
        timestamp: s.timestamp,
        updatedAt: 999,
        messageCount: 1,
      },
    ]);
    const idx = sessionsToIndex([s]);
    expect(idx![0]!.updatedAt).toBe(999);
    expect(idx![0]!.messageCount).toBe(1);
  });

  it('hydrateSessionsFromDisk: empty index invents nothing', () => {
    const h = hydrateSessionsFromDisk();
    expect(h.sessions).toEqual([]);
    expect(h.activeSessionId).toBeNull();
    expect(h.folderOrder).toBeNull();
  });

  it('hydrateSessionsFromDisk: loads body, drops unknown active, no remote shells', () => {
    const id = `local-${Date.now()}`;
    const msgs = [
      baseMsg({
        id: 'm1',
        sender: 'user',
        text: 'hello world content',
        timestamp: 1_700_000_000_100,
      }),
      baseMsg({
        id: 'm2',
        sender: 'assistant',
        text: 'reply',
        status: 'processing',
        timestamp: 1_700_000_000_200,
      }),
    ];
    saveSessionIndex([
      {
        id,
        title: '真实标题',
        folder: DEFAULT_SESSION_FOLDER,
        isPinned: false,
        isArchived: false,
        timestamp: '刚刚',
        updatedAt: 10,
        messageCount: 2,
      },
    ]);
    seedLsBody(id, msgs);
    saveActiveSessionId('ghost-remote-not-in-index');
    saveFolderOrder([DEFAULT_SESSION_FOLDER]);

    const h = hydrateSessionsFromDisk();
    expect(h.sessions).toHaveLength(1);
    expect(h!.sessions[0]!.id).toBe(id);
    // must not invent remote shell for missing active
    expect(h.sessions.some((s) => s.id === 'ghost-remote-not-in-index')).toBe(
      false
    );
    expect(h.activeSessionId).toBeNull();
    expect(h!.sessions[0]!.messages[1]!.status).toBe('completed');
    expect(h.folderOrder).toEqual([DEFAULT_SESSION_FOLDER]);
    // 刚刚 → coerced away
    expect(h!.sessions[0]!.timestamp).not.toBe('刚刚');
  });

  it('hydrate keeps active empty shell when active is in index', () => {
    const id = `shell-${Date.now()}`;
    saveSessionIndex([
      {
        id,
        title: EMPTY_SESSION_TITLE,
        folder: DEFAULT_SESSION_FOLDER,
        isPinned: false,
        isArchived: false,
        timestamp: '',
        updatedAt: 1,
        messageCount: 0,
      },
    ]);
    saveActiveSessionId(id);
    const h = hydrateSessionsFromDisk();
    expect(h.sessions.some((s) => s.id === id)).toBe(true);
    expect(h.activeSessionId).toBe(id);
  });

  it('hydrate GC non-active empty shells; null active drops all shells', () => {
    const activeShell = `shell-active-${Date.now()}`;
    const ghostA = `shell-ghost-a-${Date.now()}`;
    const ghostB = `shell-ghost-b-${Date.now()}`;
    const contentId = `content-${Date.now()}`;
    const baseEntry = (id: string, title: string, messageCount: number) => ({
      id,
      title,
      folder: DEFAULT_SESSION_FOLDER,
      isPinned: false,
      isArchived: false,
      timestamp: '',
      updatedAt: messageCount > 0 ? 10 : 1,
      messageCount,
    });
    saveSessionIndex([
      baseEntry(activeShell, EMPTY_SESSION_TITLE, 0),
      baseEntry(ghostA, EMPTY_SESSION_TITLE, 0),
      baseEntry(ghostB, EMPTY_SESSION_TITLE, 0),
      baseEntry(contentId, '真实标题', 1),
    ]);
    seedLsBody(contentId, [
      baseMsg({ id: 'm1', sender: 'user', text: 'hello hydrate' }),
    ]);

    // active = 其一空壳 → 只 keep 该空壳 + 有内容（GC 其它幽灵）
    saveActiveSessionId(activeShell);
    const hActive = hydrateSessionsFromDisk();
    expect(hActive.sessions.map((s) => s.id).sort()).toEqual(
      [activeShell, contentId].sort()
    );
    expect(hActive.activeSessionId).toBe(activeShell);

    // active = null → 无默认空壳残留
    saveSessionIndex([
      baseEntry(ghostA, EMPTY_SESSION_TITLE, 0),
      baseEntry(ghostB, EMPTY_SESSION_TITLE, 0),
      baseEntry(contentId, '真实标题', 1),
    ]);
    seedLsBody(contentId, [
      baseMsg({ id: 'm1', sender: 'user', text: 'hello hydrate' }),
    ]);
    saveActiveSessionId(''); // 清除 active
    const hNull = hydrateSessionsFromDisk();
    expect(hNull.sessions.map((s) => s.id)).toEqual([contentId]);
    expect(hNull.activeSessionId).toBeNull();
  });

  it('persistAllSessions writes index/agents/meta and purges orphan keys（D-F06：不再写正文镜像）', async () => {
    localStorage.setItem(
      SESSION_BODY_PREFIX + 'orphan',
      JSON.stringify([baseMsg({ id: 'o', sender: 'user', text: 'gone' })])
    );
    localStorage.setItem(
      SESSION_AGENTS_PREFIX + 'orphan',
      JSON.stringify([{ id: 'x' }])
    );

    const s = baseSession({
      id: 'keep',
      title: 'Keep',
      messages: [
        baseMsg({ id: 'm1', sender: 'user', text: 'stay' }),
        baseMsg({
          id: 'm2',
          sender: 'assistant',
          text: 'ok',
          toolCalls: [
            { id: 't1', name: 'bash', arguments: '{}', status: 'success' },
          ],
        }),
      ],
    });
    await persistAllSessions([s], 'keep', [DEFAULT_SESSION_FOLDER]);

    expect(loadSessionIndex().map((e) => e.id)).toEqual(['keep']);
    // D-F06 剥双轨：persist 降级回退不再写 LS 正文镜像（SQLite 为正文权威）
    expect(
      localStorage.getItem(SESSION_BODY_PREFIX + 'keep')
    ).toBeNull();
    // 孤儿删除语义保留：不在 keep 集合的残键清除
    expect(loadSessionBody('orphan')).toEqual([]);
    expect(localStorage.getItem(SESSION_AGENTS_PREFIX + 'orphan')).toBeNull();
    expect(loadActiveSessionId()).toBe('keep');
    expect(loadFolderOrder()).toEqual([DEFAULT_SESSION_FOLDER]);
  });

  it('persistAllSessions with empty list clears index and does not invent sessions', async () => {
    saveSessionIndex([
      {
        id: 'old',
        title: 'Old',
        folder: DEFAULT_SESSION_FOLDER,
        isPinned: false,
        isArchived: false,
        timestamp: '',
        updatedAt: 1,
        messageCount: 0,
      },
    ]);
    seedLsBody('old', [baseMsg({ id: 'm', sender: 'user', text: 'x' })]);
    await persistAllSessions([], '', []);
    expect(loadSessionIndex()).toEqual([]);
    // N1-2 守卫：空 keep 不清除 LS 正文镜像（防 boot 窗口误删），但索引已清空，hydrate 不会凭空恢复会话
    expect(loadActiveSessionId()).toBeNull();
    const h = hydrateSessionsFromDisk();
    expect(h.sessions).toEqual([]);
  });

  // ── I-DRAFT / C3：PENDING_DRAFT 永不落盘 sessions[] ─────────────────
  it('I-DRAFT: sessionsToIndex / filterPersistableSessions drop sentinel', () => {
    const draft = baseSession({
      id: PENDING_DRAFT_SESSION_ID,
      title: 'should-not-persist',
      messages: [baseMsg({ id: 'm', sender: 'user', text: 'nope' })],
    });
    const real = baseSession({
      id: 'real-1',
      title: 'Real',
      messages: [baseMsg({ id: 'm2', sender: 'user', text: 'ok' })],
    });
    expect(filterPersistableSessions([draft, real]).map((s) => s.id)).toEqual([
      'real-1',
    ]);
    expect(sessionsToIndex([draft, real]).map((e) => e.id)).toEqual(['real-1']);
    expect(sessionsToIndex([draft])).toEqual([]);
  });

  it('I-DRAFT: persistAllSessions never writes PENDING_DRAFT to index/body/active', async () => {
    const draft = baseSession({
      id: PENDING_DRAFT_SESSION_ID,
      title: 'ghost-draft',
      messages: [baseMsg({ id: 'md', sender: 'user', text: 'draft body' })],
    });
    const real = baseSession({
      id: 'keep-real',
      title: 'Keep',
      messages: [baseMsg({ id: 'mr', sender: 'user', text: 'real body' })],
    });
    await persistAllSessions([draft, real], PENDING_DRAFT_SESSION_ID, [
      DEFAULT_SESSION_FOLDER,
    ]);

    expect(loadSessionIndex().map((e) => e.id)).toEqual(['keep-real']);
    expect(loadSessionBody(PENDING_DRAFT_SESSION_ID)).toEqual([]);
    expect(
      localStorage.getItem(SESSION_BODY_PREFIX + PENDING_DRAFT_SESSION_ID)
    ).toBeNull();
    expect(loadActiveSessionId()).toBeNull();
    // D-F06：persist 降级回退不再写 LS 正文镜像——真实会话同样不落正文键
    expect(localStorage.getItem(SESSION_BODY_PREFIX + 'keep-real')).toBeNull();
    expect(loadSessionBody('keep-real')).toEqual([]);
  });

  it('I-DRAFT: hydrate drops dirty draft index entry; prunes empty shells when active null', () => {
    const contentId = `content-${Date.now()}`;
    const ghostShell = `shell-ghost-${Date.now()}`;
    // 绕过 parse：直接写入脏索引（模拟旧 bug / 手写盘）
    localStorage.setItem(
      SESSION_INDEX_KEY,
      JSON.stringify([
        {
          id: PENDING_DRAFT_SESSION_ID,
          title: 'Draft leak',
          folder: DEFAULT_SESSION_FOLDER,
          isPinned: false,
          isArchived: false,
          timestamp: '',
          updatedAt: 99,
          messageCount: 1,
        },
        {
          id: ghostShell,
          title: EMPTY_SESSION_TITLE,
          folder: DEFAULT_SESSION_FOLDER,
          isPinned: false,
          isArchived: false,
          timestamp: '',
          updatedAt: 1,
          messageCount: 0,
        },
        {
          id: contentId,
          title: '真实标题',
          folder: DEFAULT_SESSION_FOLDER,
          isPinned: false,
          isArchived: false,
          timestamp: '',
          updatedAt: 10,
          messageCount: 1,
        },
      ])
    );
    seedLsBody(PENDING_DRAFT_SESSION_ID, [
      baseMsg({ id: 'md', sender: 'user', text: 'should not hydrate' }),
    ]);
    seedLsBody(contentId, [
      baseMsg({ id: 'm1', sender: 'user', text: 'hello hydrate' }),
    ]);
    saveActiveSessionId(PENDING_DRAFT_SESSION_ID);

    const h = hydrateSessionsFromDisk();
    expect(h.sessions.map((s) => s.id)).toEqual([contentId]);
    expect(h.sessions.some((s) => s.id === PENDING_DRAFT_SESSION_ID)).toBe(
      false
    );
    expect(h.sessions.some((s) => s.id === ghostShell)).toBe(false);
    expect(h.activeSessionId).toBeNull();
  });

  it('I-DRAFT: saveActiveSessionId / seedLsBody no-op for sentinel', () => {
    saveActiveSessionId(PENDING_DRAFT_SESSION_ID);
    expect(loadActiveSessionId()).toBeNull();
    seedLsBody(PENDING_DRAFT_SESSION_ID, [
      baseMsg({ id: 'm', sender: 'user', text: 'x' }),
    ]);
    expect(
      localStorage.getItem(SESSION_BODY_PREFIX + PENDING_DRAFT_SESSION_ID)
    ).toBeNull();
  });
});
