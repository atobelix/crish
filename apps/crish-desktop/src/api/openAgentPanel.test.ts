import { beforeEach, describe, expect, it, vi } from 'vitest';
// 会话域（sessions / activeAgentId / panelAgentId / createSession）已从 layoutStore
// 物理拆分到独立 SessionStore 实例（sessionStore.ts:24-36）；本文件断言的是会话域状态。
import { useSessionStore } from '../store/sessionStore';
// 布局域（workspaces / togglePanel / setTabModeEnabled）在 workspaceStore；
// closeAgentSidePanel 同时改会话域焦点与工作区卡片，故两域都要读。
import { useWorkspaceStore } from '../store/workspaceStore';
// setTabModeEnabled 属壳层 chrome（layoutStore），togglePanel 属布局域（workspaceStore）
import { useLayoutStore } from '../store/layoutStore';
import {
  AGENT_SIDE_PANEL_CARD_ID,
  DEFAULT_AGENT_PANEL_LABEL,
  DEFAULT_AGENT_PANEL_TITLE,
  __resetAgentPanelClientIdSeqForTests,
  assertAgentPanelPlanSideOnly,
  browseAgentSidePanel,
  clearAgentPanelFocus,
  closeAgentSidePanel,
  findAgentPanelAgent,
  generateAgentPanelClientId,
  getAgentSidePanelFocus,
  isAgentSidePanelFocused,
  normalizeAgentPanelAgentId,
  openAgentInSidePanel,
  openAgentPanelBrowse,
  planOpenAgentInSidePanel,
  resolveAgentPanelLabel,
  resolveAgentPanelOpenTarget,
  resolveAgentPanelStatusLabel,
  resolveAgentPanelTitle,
  shouldReuseAgentPanelFocus,
} from './openAgentPanel';

describe('openAgentPanel pure helpers', () => {
  beforeEach(() => {
    __resetAgentPanelClientIdSeqForTests();
  });

  describe('normalizeAgentPanelAgentId', () => {
    it('trims and rejects empty/blank', () => {
      expect(normalizeAgentPanelAgentId('  a1  ')).toBe('a1');
      expect(normalizeAgentPanelAgentId('')).toBeNull();
      expect(normalizeAgentPanelAgentId('   \t')).toBeNull();
      expect(normalizeAgentPanelAgentId(null)).toBeNull();
      expect(normalizeAgentPanelAgentId(undefined)).toBeNull();
    });
  });

  describe('generateAgentPanelClientId uniqueness', () => {
    it('produces unique ids even in tight loops', () => {
      const n = 200;
      const ids = new Set<string>();
      for (let i = 0; i < n; i++) {
        ids.add(generateAgentPanelClientId('ag'));
      }
      expect(ids.size).toBe(n);
    });

    it('uses prefix and never collides across prefixes in same batch', () => {
      const a = generateAgentPanelClientId('panel');
      const b = generateAgentPanelClientId('panel');
      expect(a.startsWith('panel-')).toBe(true);
      expect(b.startsWith('panel-')).toBe(true);
      expect(a).not.toBe(b);
    });

    it('falls back prefix when empty/blank', () => {
      expect(generateAgentPanelClientId('').startsWith('agent-')).toBe(true);
      expect(generateAgentPanelClientId('   ').startsWith('agent-')).toBe(true);
    });
  });

  describe('title / label', () => {
    it('empty title falls back to default', () => {
      expect(resolveAgentPanelTitle(null)).toBe(DEFAULT_AGENT_PANEL_TITLE);
      expect(resolveAgentPanelTitle(undefined)).toBe(DEFAULT_AGENT_PANEL_TITLE);
      expect(resolveAgentPanelTitle({})).toBe(DEFAULT_AGENT_PANEL_TITLE);
      expect(resolveAgentPanelTitle({ description: '', mode: '' })).toBe(
        DEFAULT_AGENT_PANEL_TITLE,
      );
      expect(resolveAgentPanelTitle({ description: '   ', mode: '\t' })).toBe(
        DEFAULT_AGENT_PANEL_TITLE,
      );
    });

    it('prefers description over mode over fallback', () => {
      expect(
        resolveAgentPanelTitle({ description: '查 bug', mode: 'explore' }),
      ).toBe('查 bug');
      expect(resolveAgentPanelTitle({ description: '  ', mode: 'explore' })).toBe(
        'explore',
      );
      expect(
        resolveAgentPanelTitle({ description: '', mode: '' }, { fallback: '自定义' }),
      ).toBe('自定义');
    });

    it('label uses description → mode → id → 默认子智能体', () => {
      expect(resolveAgentPanelLabel(null)).toBe(DEFAULT_AGENT_PANEL_LABEL);
      expect(resolveAgentPanelLabel({ description: '任务 A' })).toBe('任务 A');
      expect(resolveAgentPanelLabel({ mode: 'research' })).toBe('research');
      expect(resolveAgentPanelLabel({ id: '  x-9  ' })).toBe('x-9');
      expect(resolveAgentPanelLabel({ id: '  ' })).toBe(DEFAULT_AGENT_PANEL_LABEL);
    });

    it('status labels cover all known statuses', () => {
      expect(resolveAgentPanelStatusLabel('running')).toBe('运行中');
      expect(resolveAgentPanelStatusLabel('failed')).toBe('失败');
      expect(resolveAgentPanelStatusLabel('stopped')).toBe('已停止');
      expect(resolveAgentPanelStatusLabel('completed')).toBe('完成');
      expect(resolveAgentPanelStatusLabel(undefined)).toBe('完成');
      expect(resolveAgentPanelStatusLabel('weird')).toBe('完成');
    });
  });

  describe('findAgentPanelAgent / missing agent', () => {
    const agents = [
      { id: 'a1', description: 'One' },
      { id: '  a2  ', description: 'Two' },
    ];

    it('finds by trimmed id', () => {
      expect(findAgentPanelAgent(agents, 'a1')?.description).toBe('One');
      expect(findAgentPanelAgent(agents, '  a2 ')?.description).toBe('Two');
    });

    it('missing agent returns undefined', () => {
      expect(findAgentPanelAgent(agents, 'nope')).toBeUndefined();
      expect(findAgentPanelAgent([], 'a1')).toBeUndefined();
      expect(findAgentPanelAgent(null, 'a1')).toBeUndefined();
      expect(findAgentPanelAgent(agents, '')).toBeUndefined();
      expect(findAgentPanelAgent(agents, '   ')).toBeUndefined();
    });
  });

  describe('shouldReuseAgentPanelFocus', () => {
    it('reuses only when same id and main column clean', () => {
      expect(shouldReuseAgentPanelFocus('a1', 'a1', null)).toBe(true);
      expect(shouldReuseAgentPanelFocus('  a1 ', 'a1', null)).toBe(true);
      expect(shouldReuseAgentPanelFocus('a1', 'a2', null)).toBe(false);
      expect(shouldReuseAgentPanelFocus(null, 'a1', null)).toBe(false);
      // 主列脏 → 不可 reuse，须强制清
      expect(shouldReuseAgentPanelFocus('a1', 'a1', 'a1')).toBe(false);
      expect(shouldReuseAgentPanelFocus('a1', 'a1', '  ')).toBe(true);
    });
  });

  describe('resolveAgentPanelOpenTarget', () => {
    it('single agent with id → focus; empty/multi/blank id → browse', () => {
      expect(resolveAgentPanelOpenTarget([{ id: 'solo', description: 'S' }])).toEqual({
        mode: 'focus',
        agentId: 'solo',
      });
      expect(resolveAgentPanelOpenTarget([])).toEqual({ mode: 'browse' });
      expect(resolveAgentPanelOpenTarget(null)).toEqual({ mode: 'browse' });
      expect(
        resolveAgentPanelOpenTarget([
          { id: 'a' },
          { id: 'b' },
        ]),
      ).toEqual({ mode: 'browse' });
      expect(resolveAgentPanelOpenTarget([{ id: '  ' }])).toEqual({ mode: 'browse' });
      expect(resolveAgentPanelOpenTarget([{}])).toEqual({ mode: 'browse' });
    });
  });

  describe('planOpenAgentInSidePanel', () => {
    it('rejects empty agent id', () => {
      const p = planOpenAgentInSidePanel({ agentId: '' });
      expect(p).toEqual({
        action: 'reject',
        reason: 'empty-agent-id',
        setActiveAgentId: false,
        clearActiveAgentId: false,
        emitOpenEvent: false,
      });
      expect(planOpenAgentInSidePanel({ agentId: '  \t' }).action).toBe('reject');
      expect(planOpenAgentInSidePanel({ mode: 'focus' }).action).toBe('reject');
    });

    it('rejects missing agent when requireAgentExists + agents list', () => {
      const p = planOpenAgentInSidePanel({
        agentId: 'ghost',
        agents: [{ id: 'live', description: 'L' }],
        requireAgentExists: true,
      });
      expect(p.action).toBe('reject');
      if (p.action === 'reject') {
        expect(p.reason).toBe('missing-agent');
        expect(p.setActiveAgentId).toBe(false);
        expect(p.emitOpenEvent).toBe(false);
      }
    });

    it('optimistic focus when agent not listed and requireAgentExists off', () => {
      const p = planOpenAgentInSidePanel({
        agentId: 'streaming-soon',
        agents: [],
        requireAgentExists: false,
      });
      expect(p.action).toBe('focus');
      if (p.action === 'focus') {
        expect(p.agentId).toBe('streaming-soon');
        expect(p.reused).toBe(false);
        expect(p.setActiveAgentId).toBe(false);
        expect(p.clearActiveAgentId).toBe(true);
        expect(p.title).toBe(DEFAULT_AGENT_PANEL_TITLE);
      }
    });

    it('duplicate open marks reused when already focused', () => {
      const p = planOpenAgentInSidePanel({
        agentId: 'same',
        panelAgentId: 'same',
        activeAgentId: null,
        agent: { id: 'same', description: '复用我' },
      });
      expect(p.action).toBe('focus');
      if (p.action === 'focus') {
        expect(p.reused).toBe(true);
        expect(p.title).toBe('复用我');
        expect(p.label).toBe('复用我');
        expect(p.setActiveAgentId).toBe(false);
      }
    });

    it('duplicate open is not reuse when main column dirty', () => {
      const p = planOpenAgentInSidePanel({
        agentId: 'same',
        panelAgentId: 'same',
        activeAgentId: 'same',
      });
      expect(p.action).toBe('focus');
      if (p.action === 'focus') {
        expect(p.reused).toBe(false);
        expect(p.clearActiveAgentId).toBe(true);
      }
    });

    it('create focus (not reuse) when switching agents', () => {
      const p = planOpenAgentInSidePanel({
        agentId: 'b',
        panelAgentId: 'a',
        agents: [
          { id: 'a', description: 'A' },
          { id: 'b', description: 'B 任务' },
        ],
      });
      expect(p.action).toBe('focus');
      if (p.action === 'focus') {
        expect(p.reused).toBe(false);
        expect(p.agentId).toBe('b');
        expect(p.title).toBe('B 任务');
      }
    });

    it('browse plan never touches main column', () => {
      const p = planOpenAgentInSidePanel({ mode: 'browse', sessionId: '  s1  ' });
      expect(p).toMatchObject({
        action: 'browse',
        sessionId: 's1',
        setActiveAgentId: false,
        clearActiveAgentId: true,
        emitOpenEvent: true,
        title: DEFAULT_AGENT_PANEL_LABEL,
      });
    });

    it('empty title override falls back; whitespace title ignored', () => {
      const p = planOpenAgentInSidePanel({
        agentId: 't1',
        title: '   ',
        agent: { id: 't1', description: '', mode: '' },
      });
      expect(p.action).toBe('focus');
      if (p.action === 'focus') {
        expect(p.title).toBe(DEFAULT_AGENT_PANEL_TITLE);
      }
      const p2 = planOpenAgentInSidePanel({
        agentId: 't1',
        title: '显式标题',
        agent: { id: 't1', description: 'desc' },
      });
      if (p2.action === 'focus') {
        expect(p2.title).toBe('显式标题');
      }
    });

    it('every plan sets setActiveAgentId false (main-session side-effect guard)', () => {
      const plans = [
        planOpenAgentInSidePanel({ agentId: '' }),
        planOpenAgentInSidePanel({
          agentId: 'x',
          requireAgentExists: true,
          agents: [],
        }),
        planOpenAgentInSidePanel({ agentId: 'x', panelAgentId: 'x' }),
        planOpenAgentInSidePanel({ agentId: 'y', panelAgentId: 'x' }),
        planOpenAgentInSidePanel({ mode: 'browse' }),
      ];
      for (const plan of plans) {
        expect(plan.setActiveAgentId).toBe(false);
        expect(() => assertAgentPanelPlanSideOnly(plan)).not.toThrow();
      }
    });

    it('assertAgentPanelPlanSideOnly throws if setActiveAgentId corrupted', () => {
      const bad = {
        action: 'reject' as const,
        reason: 'empty-agent-id' as const,
        setActiveAgentId: true as unknown as false,
        clearActiveAgentId: false as const,
        emitOpenEvent: false as const,
      };
      expect(() => assertAgentPanelPlanSideOnly(bad)).toThrow(/activeAgentId/);
    });
  });

  describe('pure helpers do not touch session store', () => {
    it('plan / title / id gen leave activeAgentId & panelAgentId unchanged', () => {
      const st = useSessionStore.getState();
      if (!st.sessions.length) {
        st.createSession({ title: 'pure-guard', id: `pure-${Date.now()}` });
      }
      const sid = useSessionStore.getState().sessions[0]?.id;
      if (sid) st.setActiveSessionId(sid);
      useSessionStore.setState({ panelAgentId: 'keep-me', activeAgentId: null });

      // 纯路径
      planOpenAgentInSidePanel({
        agentId: 'other',
        panelAgentId: 'keep-me',
        agents: [{ id: 'other', description: 'O' }],
      });
      resolveAgentPanelTitle({ description: 'x' });
      resolveAgentPanelLabel({ id: 'y' });
      generateAgentPanelClientId('z');
      findAgentPanelAgent([{ id: 'a' }], 'a');
      shouldReuseAgentPanelFocus('keep-me', 'keep-me', null);
      resolveAgentPanelOpenTarget([{ id: 'solo' }]);

      const after = useSessionStore.getState();
      expect(after.panelAgentId).toBe('keep-me');
      expect(after.activeAgentId).toBeNull();
    });
  });
});

describe('openAgentPanel — 侧栏 only，无主列覆盖', () => {
  beforeEach(() => {
    const st = useSessionStore.getState();
    if (!st.sessions.length) {
      st.createSession({ title: 'agent-panel-test', id: `apt-sess-${Date.now()}` });
    }
    const sid = useSessionStore.getState().sessions[0]?.id;
    if (sid) st.setActiveSessionId(sid);
    // 经 API 清焦点（setActiveAgentId(null) 仅清主列字段）
    clearAgentPanelFocus();
  });

  it('openAgentInSidePanel 只写 panelAgentId，activeAgentId 恒 null', () => {
    openAgentInSidePanel('agent-x');
    const st = useSessionStore.getState();
    expect(st.panelAgentId).toBe('agent-x');
    expect(st.activeAgentId).toBeNull();
    expect(isAgentSidePanelFocused('agent-x')).toBe(true);
  });

  it('openAgentPanelBrowse 清 panel 焦点且不开主列 agent', () => {
    openAgentInSidePanel('agent-x');
    openAgentPanelBrowse();
    const st = useSessionStore.getState();
    expect(st.panelAgentId).toBeNull();
    expect(st.activeAgentId).toBeNull();
  });

  it('browseAgentSidePanel 与 browse 等价', () => {
    openAgentInSidePanel('agent-y');
    browseAgentSidePanel();
    expect(useSessionStore.getState().panelAgentId).toBeNull();
    expect(useSessionStore.getState().activeAgentId).toBeNull();
  });

  it('clearAgentPanelFocus 同时清 panel/active', () => {
    useSessionStore.setState({ panelAgentId: 'a1', activeAgentId: null });
    clearAgentPanelFocus();
    const st = useSessionStore.getState();
    expect(st.panelAgentId).toBeNull();
    expect(st.activeAgentId).toBeNull();
  });

  it('openAgentInSidePanel 空 id 不写 store', () => {
    clearAgentPanelFocus();
    openAgentInSidePanel('');
    expect(useSessionStore.getState().panelAgentId).toBeNull();
  });

  it('openAgentInSidePanel 空白 id 不写 store（trim）', () => {
    clearAgentPanelFocus();
    openAgentInSidePanel('   \t  ');
    expect(useSessionStore.getState().panelAgentId).toBeNull();
    expect(useSessionStore.getState().activeAgentId).toBeNull();
  });

  it('openAgentInSidePanel trim agentId', () => {
    openAgentInSidePanel('  agent-trim  ');
    expect(useSessionStore.getState().panelAgentId).toBe('agent-trim');
    expect(isAgentSidePanelFocused('agent-trim')).toBe(true);
    expect(isAgentSidePanelFocused('  agent-trim  ')).toBe(true);
  });

  it('duplicate open 同一 agent 仍保持侧栏焦点且主列 null', () => {
    openAgentInSidePanel('dup-1');
    openAgentInSidePanel('dup-1');
    openAgentInSidePanel('  dup-1  ');
    const st = useSessionStore.getState();
    expect(st.panelAgentId).toBe('dup-1');
    expect(st.activeAgentId).toBeNull();
    expect(isAgentSidePanelFocused('dup-1')).toBe(true);
  });

  it('closeAgentSidePanel 清焦点（不强制 chat）', () => {
    const ws = useWorkspaceStore.getState().workspaces[0];
    expect(ws).toBeTruthy();
    const group = ws!.columns[0]?.groups[0];
    expect(group).toBeTruthy();
    openAgentInSidePanel('agent-z');
    closeAgentSidePanel(ws!.id, group!.id);
    const st = useSessionStore.getState();
    expect(st.panelAgentId).toBeNull();
    expect(st.activeAgentId).toBeNull();
  });

  it('closeAgentSidePanel 在多工具组落到左侧邻居，不重开/不切主列 chat', () => {
    const st = useWorkspaceStore.getState();
    const ws = st.workspaces[0];
    expect(ws).toBeTruthy();
    // 合并工具标签，保证 files/agent/terminal 同组
    useLayoutStore.getState().setTabModeEnabled(true);
    st.togglePanel(ws!.id, 'files', true);
    st.togglePanel(ws!.id, 'agent', true);
    st.togglePanel(ws!.id, 'terminal', true);

    const live = useWorkspaceStore.getState().workspaces.find((w) => w.id === ws!.id)!;
    const toolCol = live.columns.find((c) => !c.id.includes('chat'));
    expect(toolCol).toBeTruthy();
    // 找到含 agent 的组
    const group = toolCol!.groups.find((g) => g.cards.some((c) => c.id === 'agent'));
    expect(group).toBeTruthy();
    // 强制同组为 files|agent|terminal 且 active=agent
    useWorkspaceStore.setState((draft: any) => {
      const w = draft.workspaces.find((x: any) => x.id === ws!.id);
      const col = w?.columns.find((c: any) => !c.id.includes('chat'));
      if (!col) return;
      const order = ['files', 'agent', 'terminal'];
      col.groups = [
        {
          id: 'group-tools',
          cards: order.map((id) => ({ id, title: id })),
          activeCardId: 'agent',
        },
      ];
    });

    const chatColBefore = useWorkspaceStore
      .getState()
      .workspaces.find((w) => w.id === ws!.id)!
      .columns.find((c) => c.id.includes('chat'));
    const chatActiveBefore = chatColBefore?.groups[0]?.activeCardId;
    const chatCardsBefore = chatColBefore?.groups[0]?.cards.map((c) => c.id) ?? [];
    openAgentInSidePanel('agent-close-side');
    const groupId = useWorkspaceStore
      .getState()
      .workspaces.find((w) => w.id === ws!.id)!
      .columns.find((c) => !c.id.includes('chat'))!
      .groups.find((g) => g.cards.some((c) => c.id === 'agent'))!.id;

    closeAgentSidePanel(ws!.id, groupId);

    const after = useSessionStore.getState();
    expect(after.panelAgentId).toBeNull();
    expect(after.activeAgentId).toBeNull();

    const wsAfter = useWorkspaceStore.getState().workspaces.find((w) => w.id === ws!.id)!;
    const toolAfter = wsAfter.columns.find((c) => !c.id.includes('chat'));
    const gAfter = toolAfter?.groups.find((g) => g.id === groupId) ?? toolAfter?.groups[0];
    // agent tab 已关
    expect(gAfter?.cards.map((c) => c.id) ?? []).not.toContain('agent');
    // 落到左侧 files，绝不 chat
    expect(gAfter?.activeCardId).toBe('files');
    expect(gAfter?.activeCardId).not.toBe('chat');
    // 主列 chat 原样
    const chatAfter = wsAfter.columns.find((c) => c.id.includes('chat'));
    expect(chatAfter?.groups[0]?.activeCardId).toBe(chatActiveBefore);
    expect(chatAfter?.groups[0]?.cards.map((c) => c.id)).toEqual(chatCardsBefore);
  });

  it('closeAgentSidePanel 关唯一 agent 收空组，不把 chat 注入工具列', () => {
    const st = useWorkspaceStore.getState();
    const ws = st.workspaces[0];
    expect(ws).toBeTruthy();
    useLayoutStore.getState().setTabModeEnabled(true);
    st.togglePanel(ws!.id, 'agent', true);

    // 工具列只留 agent
    useWorkspaceStore.setState((draft) => {
      const w = draft.workspaces.find((x) => x.id === ws!.id);
      const col = w?.columns.find((c) => !c.id.includes('chat'));
      if (!col) return;
      col.groups = [
        {
          id: `group-agent-only-${ws!.id}`,
          activeCardId: AGENT_SIDE_PANEL_CARD_ID,
          cards: [{ id: AGENT_SIDE_PANEL_CARD_ID, title: 'agent' }],
          heightRatio: 1,
        },
      ];
    });

    const groupId = useWorkspaceStore
      .getState()
      .workspaces.find((w) => w.id === ws!.id)!
      .columns.find((c) => !c.id.includes('chat'))!
      .groups[0]!.id;

    const chatBefore = useWorkspaceStore
      .getState()
      .workspaces.find((w) => w.id === ws!.id)!
      .columns.find((c) => c.id.includes('chat'))!;
    const chatCardsBefore = chatBefore.groups[0]?.cards.map((c) => c.id) ?? [];
    const chatActiveBefore = chatBefore.groups[0]?.activeCardId;
    const colCountBefore = useWorkspaceStore
      .getState()
      .workspaces.find((w) => w.id === ws!.id)!.columns.length;

    openAgentInSidePanel('solo-agent');
    closeAgentSidePanel(ws!.id, groupId);

    const after = useWorkspaceStore.getState().workspaces.find((w) => w.id === ws!.id)!;
    expect(useSessionStore.getState().panelAgentId).toBeNull();
    expect(useSessionStore.getState().activeAgentId).toBeNull();

    // 空工具列应收掉；绝不在工具位塞 chat
    const toolCols = after.columns.filter((c) => !c.id.includes('chat'));
    for (const col of toolCols) {
      for (const g of col.groups) {
        expect(g.cards.map((c) => c.id)).not.toContain('chat');
        expect(g.activeCardId).not.toBe('chat');
      }
    }
    // 主列 chat 原样
    const chatAfter = after.columns.find((c) => c.id.includes('chat'))!;
    expect(chatAfter.groups[0]?.activeCardId).toBe(chatActiveBefore);
    expect(chatAfter.groups[0]?.cards.map((c) => c.id)).toEqual(chatCardsBefore);
    // 列数不因「重开 chat」膨胀
    expect(after.columns.filter((c) => c.id.includes('chat')).length).toBe(1);
    expect(after.columns.length).toBeLessThanOrEqual(colCountBefore);
  });

  it('closeAgentSidePanel 空/空白 wsId|groupId 仍清焦点且不抛', () => {
    openAgentInSidePanel('keep-clear');
    expect(() => closeAgentSidePanel('', 'g1')).not.toThrow();
    expect(useSessionStore.getState().panelAgentId).toBeNull();

    openAgentInSidePanel('keep-clear-2');
    expect(() => closeAgentSidePanel('ws1', '  ')).not.toThrow();
    expect(useSessionStore.getState().panelAgentId).toBeNull();
    expect(useSessionStore.getState().activeAgentId).toBeNull();
  });

  it('isAgentSidePanelFocused 在 activeAgentId 非空时返回 false（主列路径非法）', () => {
    // 直接写 store 模拟脏状态（API 路径不会出现）
    useSessionStore.setState({ panelAgentId: 'a1', activeAgentId: 'a1' });
    expect(isAgentSidePanelFocused('a1')).toBe(false);
  });

  it('isAgentSidePanelFocused 无参时表示任意侧栏焦点', () => {
    clearAgentPanelFocus();
    expect(isAgentSidePanelFocused()).toBe(false);
    openAgentInSidePanel('any-focus');
    expect(isAgentSidePanelFocused()).toBe(true);
    expect(isAgentSidePanelFocused(null)).toBe(true);
    expect(isAgentSidePanelFocused('other')).toBe(false);
  });

  it('getAgentSidePanelFocus 反映侧栏/主列契约', () => {
    clearAgentPanelFocus();
    expect(getAgentSidePanelFocus()).toEqual({
      panelAgentId: null,
      activeAgentId: null,
      focused: false,
    });
    openAgentInSidePanel('snap-1');
    expect(getAgentSidePanelFocus()).toEqual({
      panelAgentId: 'snap-1',
      activeAgentId: null,
      focused: true,
    });
  });

  it('openAgentInSidePanel 经 setActiveAgentId 改写后仍保持主列 null', () => {
    // sessionActions.setActiveAgentId(非 null) 会改写到 panel
    useSessionStore.getState().setActiveAgentId('legacy-agent');
    expect(useSessionStore.getState().activeAgentId).toBeNull();
    expect(useSessionStore.getState().panelAgentId).toBe('legacy-agent');
    // 再用正式 API 打开另一 agent
    openAgentInSidePanel('side-only');
    expect(useSessionStore.getState().activeAgentId).toBeNull();
    expect(useSessionStore.getState().panelAgentId).toBe('side-only');
  });

  it('openAgentInSidePanel 切会话后重设 panel（setActiveSessionId 会清 panel）', () => {
    const st = useSessionStore.getState();
    const a = st.createSession({ title: 'sess-a', id: `apt-a-${Date.now()}` });
    const b = st.createSession({ title: 'sess-b', id: `apt-b-${Date.now()}` });
    st.setActiveSessionId(a);
    openAgentInSidePanel('on-a');
    expect(useSessionStore.getState().panelAgentId).toBe('on-a');

    openAgentInSidePanel('on-b', { sessionId: b });
    const after = useSessionStore.getState();
    expect(after.activeSessionId).toBe(b);
    expect(after.panelAgentId).toBe('on-b');
    expect(after.activeAgentId).toBeNull();
  });

  it('openAgentPanelBrowse 可带 sessionId 切换且 panel 为浏览态', () => {
    const st = useSessionStore.getState();
    const a = st.createSession({ title: 'browse-a', id: `apt-ba-${Date.now()}` });
    const b = st.createSession({ title: 'browse-b', id: `apt-bb-${Date.now()}` });
    st.setActiveSessionId(a);
    openAgentInSidePanel('will-clear');
    openAgentPanelBrowse({ sessionId: b });
    const after = useSessionStore.getState();
    expect(after.activeSessionId).toBe(b);
    expect(after.panelAgentId).toBeNull();
    expect(after.activeAgentId).toBeNull();
  });

  it('空白 sessionId 不切会话', () => {
    const st = useSessionStore.getState();
    const sid = st.activeSessionId;
    openAgentInSidePanel('keep-sess', { sessionId: '   ' });
    expect(useSessionStore.getState().activeSessionId).toBe(sid);
    expect(useSessionStore.getState().panelAgentId).toBe('keep-sess');
  });

  it('open 派发 open-agent-panel 事件（含 agentId）；browse 无 agentId', () => {
    const events: Array<{ type: string; detail: unknown }> = [];
    const spy = vi.spyOn(window, 'dispatchEvent').mockImplementation((ev: Event) => {
      const ce = ev as CustomEvent;
      events.push({ type: ce.type, detail: ce.detail });
      return true;
    });
    try {
      openAgentInSidePanel('evt-agent');
      openAgentPanelBrowse();
      const agentEv = events.filter((e) => e.type === 'crish-open-agent-panel');
      expect(agentEv.length).toBeGreaterThanOrEqual(2);
      expect(agentEv.some((e) => (e.detail as { agentId?: string })?.agentId === 'evt-agent')).toBe(
        true,
      );
      // browse 的 detail 为空对象或无 agentId
      const browse = agentEv[agentEv.length - 1];
      expect((browse!.detail as { agentId?: string } | undefined)?.agentId).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('所有公开写路径后 activeAgentId 恒 null（侧栏 only）', () => {
    const ops = [
      () => openAgentInSidePanel('p1'),
      () => openAgentPanelBrowse(),
      () => browseAgentSidePanel(),
      () => openAgentInSidePanel('p2'),
      () => clearAgentPanelFocus(),
    ];
    for (const op of ops) {
      op();
      expect(useSessionStore.getState().activeAgentId).toBeNull();
    }
  });

  it('empty id open 不派发事件（与 plan reject 对齐）', () => {
    const events: Event[] = [];
    const spy = vi.spyOn(window, 'dispatchEvent').mockImplementation((ev: Event) => {
      events.push(ev);
      return true;
    });
    try {
      openAgentInSidePanel('');
      openAgentInSidePanel('  ');
      const agentEv = events.filter((e) => e.type === 'crish-open-agent-panel');
      expect(agentEv.length).toBe(0);
      expect(useSessionStore.getState().activeAgentId).toBeNull();
      expect(useSessionStore.getState().panelAgentId).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
