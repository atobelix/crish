// @vitest-environment jsdom
/**
 * Stage 5b ACT-502 / AAI-03：懒水合 + Generation Token 契约测试。
 *
 * 契约锚点：
 *   1. 冷启动仅水合活跃会话（IPC 常数上界 K=5 思路：body/agents 各 1 次）；
 *   2. 历史会话 → messagesHydrated: false 懒壳，不发起 load_session_body/agents；
 *   3. 默认标题且 messageCount>0 的懒壳不被 prepareSessionsForUi 误剪（keepIds 方案 A）；
 *   4. ensureSessionBodyHydrated JIT 拉取单会话正文；
 *   5. Generation Token 单调递增，过期响应由 isHydrateGenerationCurrent 判定丢弃。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockTauriCommand } from '../../test-setup';
import type { SessionState } from '../../store/layoutStore';
import {
  DEFAULT_SESSION_FOLDER,
  SESSION_ACTIVE_KEY,
  SESSION_INDEX_KEY,
  type SessionIndexEntry,
} from './sessionPersistenceTypes';
import {
  bumpHydrateGeneration,
  currentHydrateGeneration,
  ensureSessionBodyHydrated,
  hydrateSessionsFromRust,
  isHydrateGenerationCurrent,
} from './sessionRustDbHydrate';

function indexEntry(
  id: string,
  title: string,
  messageCount: number,
  updatedAt: number
): SessionIndexEntry {
  return {
    id,
    title,
    folder: DEFAULT_SESSION_FOLDER,
    isPinned: false,
    isArchived: false,
    timestamp: new Date(1_700_000_000_000).toISOString(),
    updatedAt,
    messageCount,
  };
}

/** 安装假库：记录 load_session_body / load_session_agents 调用次数 */
function installLazyFakeDb(opts?: {
  active?: string | null;
  bodies?: Record<string, unknown[]>;
}): { bodyCalls: () => string[]; agentCalls: () => string[] } {
  const bodyCalls: string[] = [];
  const agentCalls: string[] = [];
  const bodies = opts?.bodies ?? {
    active: [
      { id: 'm-active', sender: 'user', text: 'active body', timestamp: 1_700_000_000_001 },
    ],
    hist: [
      { id: 'm-hist', sender: 'user', text: 'history body', timestamp: 1_700_000_000_002 },
    ],
  };
  if (opts?.active != null) {
    localStorage.setItem(SESSION_ACTIVE_KEY, opts.active);
  }
  mockTauriCommand('list_sessions', async () => []);
  mockTauriCommand('load_session_body', async (args) => {
    const id = (args as { sessionId: string }).sessionId;
    bodyCalls.push(id);
    return bodies[id] ?? [];
  });
  mockTauriCommand('load_session_agents', async (args) => {
    const id = (args as { sessionId: string }).sessionId;
    agentCalls.push(id);
    return [];
  });
  mockTauriCommand('get_session_meta', async (args) => {
    const key = (args as { key: string }).key;
    if (key === 'active_session_id') return opts?.active ?? null;
    return null;
  });
  return { bodyCalls: () => bodyCalls, agentCalls: () => agentCalls };
}

beforeEach(() => {
  localStorage.clear();
});

describe('ACT-502：活跃优先懒水合', () => {
  it('多会话：仅活跃会话拉 body/agents，历史 → messagesHydrated=false 懒壳', async () => {
    localStorage.setItem(
      SESSION_INDEX_KEY,
      JSON.stringify([
        indexEntry('active', '活跃会话', 3, 300),
        indexEntry('hist', '新会话', 5, 200), // 默认标题 + messageCount>0 → 须 keep
        indexEntry('empty', '新会话', 0, 100),
      ])
    );
    const io = installLazyFakeDb({ active: 'active' });

    const res = await hydrateSessionsFromRust();

    // IPC 面：仅 active 各 1 次 body/agents
    expect(io.bodyCalls()).toEqual(['active']);
    expect(io.agentCalls()).toEqual(['active']);

    const byId = new Map(res.sessions.map((s) => [s.id, s]));
    expect(byId.get('active')?.messagesHydrated).toBe(true);
    expect(byId.get('active')?.messages?.length).toBe(1);
    expect(byId.get('hist')?.messagesHydrated).toBe(false);
    expect(byId.get('hist')?.messages).toEqual([]);
    // hist（默认标题 + messageCount>0）不得被 pruneEmptyShellSessions 误剪
    expect(byId.has('hist')).toBe(true);
    // empty（默认标题 + messageCount=0 + 未水合）可被剪
    expect(byId.has('empty')).toBe(false);
    expect(res.activeSessionId).toBe('active');
  });

  it('无 active meta：ordered[0]（最近更新）成为活跃并水合', async () => {
    localStorage.setItem(
      SESSION_INDEX_KEY,
      JSON.stringify([
        indexEntry('a', 'A', 1, 200),
        indexEntry('b', 'B', 1, 100),
      ])
    );
    const io = installLazyFakeDb({ active: null });

    const res = await hydrateSessionsFromRust();
    expect(io.bodyCalls()).toEqual(['a']);
    expect(res.activeSessionId).toBe('a');
    expect(
      res.sessions.find((s) => s.id === 'b')?.messagesHydrated
    ).toBe(false);
  });

  it('ISO 时间戳：coerceSessionTimestamp 归一为合法 ISO 串', async () => {
    localStorage.setItem(
      SESSION_INDEX_KEY,
      JSON.stringify([indexEntry('active', '会话', 1, 100)])
    );
    installLazyFakeDb({ active: 'active' });
    const res = await hydrateSessionsFromRust();
    const ts = res.sessions[0]?.timestamp;
    expect(ts).toBeTruthy();
    expect(Number.isNaN(Date.parse(ts as string))).toBe(false);
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('ensureSessionBodyHydrated（JIT 懒水合）', () => {
  it('拉取指定会话 body + agents 并 sanitize', async () => {
    const io = installLazyFakeDb({});
    const loaded = await ensureSessionBodyHydrated('hist');
    expect(io.bodyCalls()).toEqual(['hist']);
    expect(io.agentCalls()).toEqual(['hist']);
    expect(loaded.messages.length).toBe(1);
    expect(loaded.agents).toEqual([]);
  });

  it('PENDING_DRAFT / 空 id → 空结果不发起 IPC', async () => {
    const io = installLazyFakeDb({});
    const a = await ensureSessionBodyHydrated('__pending_draft__');
    const b = await ensureSessionBodyHydrated('');
    expect(a).toEqual({ messages: [], agents: [] });
    expect(b).toEqual({ messages: [], agents: [] });
    expect(io.bodyCalls()).toEqual([]);
  });
});

describe('AAI-03：Generation Token 防竞态', () => {
  it('bump 单调递增；isCurrent 仅对最新 token 为 true', () => {
    const g1 = bumpHydrateGeneration();
    expect(isHydrateGenerationCurrent(g1)).toBe(true);
    const g2 = bumpHydrateGeneration();
    expect(g2).toBe(g1 + 1);
    expect(isHydrateGenerationCurrent(g1)).toBe(false);
    expect(isHydrateGenerationCurrent(g2)).toBe(true);
    expect(currentHydrateGeneration()).toBe(g2);
  });

  it('快速连续切换模拟：过期响应 token 判定丢弃，仅最新可提交', async () => {
    // 模拟 store 层：切换 A → B → C；A 的慢响应返回时 gen 已过期
    const genA = bumpHydrateGeneration(); // 切 A
    const genB = bumpHydrateGeneration(); // 切 B
    const genC = bumpHydrateGeneration(); // 切 C

    // A 的 IO 后完成：token 过期 → 不得提交
    expect(isHydrateGenerationCurrent(genA)).toBe(false);
    // B 过期
    expect(isHydrateGenerationCurrent(genB)).toBe(false);
    // C 最新 → 可提交
    expect(isHydrateGenerationCurrent(genC)).toBe(true);
  });
});
