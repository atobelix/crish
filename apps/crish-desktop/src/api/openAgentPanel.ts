/**
 * 子 agent 只在侧栏打开，永不覆盖主对话列。
 * 命令式 store 访问集中在本 api 层（组件勿直接 getState 开面板）。
 *
 * 契约：
 * - openAgentInSidePanel / openAgentPanelBrowse → 始终 setActiveAgentId(null)
 * - closeAgentSidePanel → 清焦点 + 关 agent tab，绝不 handleTabClick('chat')
 * - 主列 activeAgentId 恒为 null；侧栏焦点只用 panelAgentId
 *
 * 本文件分两层：
 * 1) 纯函数（无 store / 无 window / 无事件）— 标题、id、reuse vs focus 决策
 * 2) 命令式写路径 — 只写 panelAgentId，强制主列 null
 */

import { getSessionStoreState } from '../store/sessionStore';
import { getWorkspaceStoreState } from '../store/workspaceStore';
import { emitUiEvent } from './uiEvents';

/** 侧栏「聊天」面板 card id（关 tab 用；禁止当主对话 chat 处理） */
export const AGENT_SIDE_PANEL_CARD_ID = 'agent' as const;

/** 侧栏列表/空态默认标签（浏览态） */
export const DEFAULT_AGENT_PANEL_LABEL = '协作体';

/** 单 agent 详情标题兜底（description/mode 皆空时） */
export const DEFAULT_AGENT_PANEL_TITLE = '协作体对话';

/** 打开侧栏 agent 时的可选参数 */
export type AgentPanelOpenOpts = {
  /** 若与当前会话不同则先切换（切会话会清 panel，随后立刻重设） */
  sessionId?: string;
};

/** 侧栏 agent 焦点快照（命令式只读） */
export type AgentSidePanelFocus = {
  panelAgentId: string | null;
  /** 契约上应始终为 null */
  activeAgentId: string | null;
  /** 是否侧栏有焦点（且主列未非法挂 agent） */
  focused: boolean;
};

/** 纯函数可读的最小 agent 形状（勿耦合 SessionAgent 全量） */
export type AgentPanelAgentLike = {
  id?: string | null;
  description?: string | null;
  mode?: string | null;
  status?: string | null;
};

// ─── 纯函数层（无 store / 无 DOM / 无事件）────────────────────────────────

/**
 * 规范化 agent id：trim；空/空白 → null。
 * 不生成 id、不写 store。
 */
export function normalizeAgentPanelAgentId(
  id: string | null | undefined,
): string | null {
  if (id == null) return null;
  const t = String(id).trim();
  return t ? t : null;
}

/** 单调序号，保证同毫秒 generateAgentPanelClientId 仍唯一 */
let agentPanelClientIdSeq = 0;

/**
 * 生成客户端唯一 agent/panel 相关 id（测试、本地草稿用）。
 * 引擎侧 agent 已有稳定 id，勿用此函数覆盖。
 * 格式：`{prefix}-{base36time}-{base36seq}`，同前缀连发不碰撞。
 */
export function generateAgentPanelClientId(prefix = 'agent'): string {
  const p = (prefix || 'agent').trim() || 'agent';
  agentPanelClientIdSeq = (agentPanelClientIdSeq + 1) >>> 0;
  const t = Date.now().toString(36);
  const s = agentPanelClientIdSeq.toString(36);
  return `${p}-${t}-${s}`;
}

/** 测试钩子：重置序号（仅 vitest；生产勿用） */
export function __resetAgentPanelClientIdSeqForTests(): void {
  agentPanelClientIdSeq = 0;
}

/**
 * 侧栏标题：description → mode → fallback。
 * 空串/纯空白 description|mode 跳过，避免空 title 污染 UI。
 */
export function resolveAgentPanelTitle(
  agent: AgentPanelAgentLike | null | undefined,
  opts?: { fallback?: string },
): string {
  const fallback = (opts?.fallback ?? DEFAULT_AGENT_PANEL_TITLE).trim() || DEFAULT_AGENT_PANEL_TITLE;
  if (!agent) return fallback;
  const desc = (agent.description ?? '').trim();
  if (desc) return desc;
  const mode = (agent.mode ?? '').trim();
  if (mode) return mode;
  return fallback;
}

/**
 * 列表行短标签：description → mode → id → 默认「子智能体」。
 * 与 AgentBrowsePad 展示优先级对齐；id 仅作最后可辨识兜底。
 */
export function resolveAgentPanelLabel(
  agent: AgentPanelAgentLike | null | undefined,
  opts?: { fallback?: string },
): string {
  const fallback = (opts?.fallback ?? DEFAULT_AGENT_PANEL_LABEL).trim() || DEFAULT_AGENT_PANEL_LABEL;
  if (!agent) return fallback;
  const desc = (agent.description ?? '').trim();
  if (desc) return desc;
  const mode = (agent.mode ?? '').trim();
  if (mode) return mode;
  const id = normalizeAgentPanelAgentId(agent.id);
  if (id) return id;
  return fallback;
}

/** 状态徽标文案（与 AgentCard / InlineAgentPanel 一致） */
export function resolveAgentPanelStatusLabel(
  status: string | null | undefined,
): string {
  switch (status) {
    case 'running':
      return '运行中';
    case 'failed':
      return '失败';
    case 'stopped':
      return '已停止';
    case 'completed':
      return '完成';
    default:
      return '完成';
  }
}

/**
 * 在列表中按 id 查找 agent（纯；trim 后严格相等）。
 * 缺 id / 空列表 → undefined（missing agent）。
 */
export function findAgentPanelAgent(
  agents: ReadonlyArray<AgentPanelAgentLike> | null | undefined,
  agentId: string | null | undefined,
): AgentPanelAgentLike | undefined {
  const id = normalizeAgentPanelAgentId(agentId);
  if (!id || !agents?.length) return undefined;
  for (const a of agents) {
    if (normalizeAgentPanelAgentId(a?.id) === id) return a;
  }
  return undefined;
}

/**
 * 当前侧栏是否已聚焦同一 agent（可 reuse，无需换 id）。
 * activeAgentId 非空视为主列脏态 → 不可 reuse（须走 focus 强制清主列）。
 */
export function shouldReuseAgentPanelFocus(
  panelAgentId: string | null | undefined,
  targetAgentId: string | null | undefined,
  activeAgentId?: string | null,
): boolean {
  if (activeAgentId != null && String(activeAgentId).trim() !== '') return false;
  const cur = normalizeAgentPanelAgentId(panelAgentId);
  const next = normalizeAgentPanelAgentId(targetAgentId);
  return Boolean(cur && next && cur === next);
}

/**
 * 从本会话 agents 决定打开策略：
 * - 恰好 1 个且有 id → focus 该 agent
 * - 0 个或多个 → browse 列表
 * 纯决策，不写 store。
 */
export function resolveAgentPanelOpenTarget(
  agents: ReadonlyArray<AgentPanelAgentLike> | null | undefined,
): { mode: 'focus'; agentId: string } | { mode: 'browse' } {
  if (!agents || agents.length !== 1) return { mode: 'browse' };
  const only = agents[0];
  const id = normalizeAgentPanelAgentId(only?.id);
  if (!id) return { mode: 'browse' };
  return { mode: 'focus', agentId: id };
}

/** 纯规划结果：调用方再决定是否执行；永不要求写 activeAgentId */
export type AgentPanelOpenPlan =
  | {
      action: 'focus';
      agentId: string;
      sessionId?: string;
      title: string;
      label: string;
      /** 已聚焦同一 agent 且主列干净 → reuse（仍可 re-emit 确保 tab） */
      reused: boolean;
      /** 契约：永远 false，防主列挂 agent */
      setActiveAgentId: false;
      clearActiveAgentId: true;
      emitOpenEvent: true;
    }
  | {
      action: 'browse';
      sessionId?: string;
      title: string;
      label: string;
      setActiveAgentId: false;
      clearActiveAgentId: true;
      emitOpenEvent: true;
    }
  | {
      action: 'reject';
      reason: 'empty-agent-id' | 'missing-agent';
      setActiveAgentId: false;
      clearActiveAgentId: false;
      emitOpenEvent: false;
    };

export type PlanOpenAgentInSidePanelInput = {
  /** 目标 agent；browse 模式可省略 */
  agentId?: string | null;
  /** 默认 focus；显式 browse 忽略 agentId */
  mode?: 'focus' | 'browse';
  sessionId?: string | null;
  /** 当前侧栏焦点 */
  panelAgentId?: string | null;
  /** 主列 agent（契约应 null；非空时 focus 强制清） */
  activeAgentId?: string | null;
  /** 可选：已解析 agent（标题优先用它） */
  agent?: AgentPanelAgentLike | null;
  /** 可选：会话 agents 列表（missing / 标题查找） */
  agents?: ReadonlyArray<AgentPanelAgentLike> | null;
  /**
   * true：agents 已提供且找不到 id → reject missing-agent。
   * false/缺省：乐观 focus（流式 agent 可能尚未入列）。
   * 仅当 `agents` 为数组时生效。
   */
  requireAgentExists?: boolean;
  /** 显式标题覆盖（仍会 trim；空则回落 resolve） */
  title?: string | null;
};

/**
 * 纯规划：打开侧栏 agent / 浏览 / 拒绝。
 * - 永不规划 setActiveAgentId=true（主会话无副作用）
 * - 空 id → reject
 * - requireAgentExists + 列表中无 id → reject missing-agent
 * - 已聚焦同一 id 且主列干净 → focus + reused
 * - 否则 → focus（create 新侧栏焦点）
 */
export function planOpenAgentInSidePanel(
  input: PlanOpenAgentInSidePanelInput,
): AgentPanelOpenPlan {
  const sessionId = normalizeAgentPanelAgentId(input.sessionId) ?? undefined;

  if (input.mode === 'browse') {
    return {
      action: 'browse',
      sessionId,
      title: DEFAULT_AGENT_PANEL_LABEL,
      label: DEFAULT_AGENT_PANEL_LABEL,
      setActiveAgentId: false,
      clearActiveAgentId: true,
      emitOpenEvent: true,
    };
  }

  const agentId = normalizeAgentPanelAgentId(input.agentId);
  if (!agentId) {
    return {
      action: 'reject',
      reason: 'empty-agent-id',
      setActiveAgentId: false,
      clearActiveAgentId: false,
      emitOpenEvent: false,
    };
  }

  const listed =
    input.agents !== undefined && input.agents !== null
      ? findAgentPanelAgent(input.agents, agentId)
      : undefined;

  if (
    input.requireAgentExists &&
    Array.isArray(input.agents) &&
    !listed &&
    !(input.agent && normalizeAgentPanelAgentId(input.agent.id) === agentId)
  ) {
    return {
      action: 'reject',
      reason: 'missing-agent',
      setActiveAgentId: false,
      clearActiveAgentId: false,
      emitOpenEvent: false,
    };
  }

  const agentForTitle =
    input.agent && normalizeAgentPanelAgentId(input.agent.id) === agentId
      ? input.agent
      : listed ?? input.agent ?? { id: agentId };

  const explicit = (input.title ?? '').trim();
  const title = explicit || resolveAgentPanelTitle(agentForTitle);
  const label = resolveAgentPanelLabel(agentForTitle);

  const reused = shouldReuseAgentPanelFocus(
    input.panelAgentId,
    agentId,
    input.activeAgentId,
  );

  return {
    action: 'focus',
    agentId,
    sessionId,
    title,
    label,
    reused,
    setActiveAgentId: false,
    clearActiveAgentId: true,
    emitOpenEvent: true,
  };
}

/**
 * 规划不变量：任何合法 plan 都不得要求写主列 activeAgentId。
 * 供单测与调用方防御断言。
 */
export function assertAgentPanelPlanSideOnly(plan: AgentPanelOpenPlan): void {
  if (plan.setActiveAgentId !== false) {
    throw new Error('agent panel plan must never set activeAgentId (main column)');
  }
}

// ─── 命令式写路径（store / 事件；主列恒 null）──────────────────────────────

function normalizeId(id: string | undefined | null): string {
  return normalizeAgentPanelAgentId(id) ?? '';
}

/**
 * 统一写路径：主列永不挂 agent，侧栏焦点只写 panelAgentId。
 * 先清主列再写侧栏，并再断言主列 null（防脏状态残留）。
 */
function applySidePanelFocus(panelAgentId: string | null): void {
  const st = getSessionStoreState();
  st.setActiveAgentId(null);
  st.setPanelAgentId(panelAgentId);
  // 防御：任何遗留路径若把 active 写脏，强制再清
  if (getSessionStoreState().activeAgentId !== null) {
    st.setActiveAgentId(null);
  }
}

/** 可选会话切换；空/空白 sessionId 忽略。切会话会清 panel/active。 */
function maybeSwitchSession(sessionId?: string): void {
  const sid = normalizeId(sessionId);
  if (!sid) return;
  const st = getSessionStoreState();
  if (st.activeSessionId !== sid) {
    // 注意：setActiveSessionId 会清 panelAgentId；调用方须立刻重设
    st.setActiveSessionId(sid);
  }
}

/** 当前侧栏 agent 焦点快照（命令式；组件请用 selectPanelAgentId 订阅） */
export function getAgentSidePanelFocus(): AgentSidePanelFocus {
  const st = getSessionStoreState();
  const panelAgentId = st.panelAgentId;
  const activeAgentId = st.activeAgentId;
  return {
    panelAgentId,
    activeAgentId,
    focused: !activeAgentId && Boolean(panelAgentId),
  };
}

/** 清主栏/侧栏 agent 焦点；不切换标签、不创建对话列 */
export function clearAgentPanelFocus(): void {
  applySidePanelFocus(null);
}

/**
 * 侧栏回到「浏览本会话子 agent」列表（不关 tab、不碰主列）。
 * 与 openAgentPanelBrowse 等价；语义更明确供 AgentCard 返回钮使用。
 */
export function browseAgentSidePanel(opts?: AgentPanelOpenOpts): void {
  openAgentPanelBrowse(opts);
}

/**
 * 在侧栏 Agent 标签打开指定子 agent；主列保持主对话。
 * 空/空白 id 为 no-op（与 plan reject empty-agent-id 对齐）。
 * 不校验 agents 是否已入列（流式乐观打开）；需严格校验请先 planOpenAgentInSidePanel。
 */
export function openAgentInSidePanel(agentId: string, opts?: AgentPanelOpenOpts): void {
  const plan = planOpenAgentInSidePanel({
    mode: 'focus',
    agentId,
    sessionId: opts?.sessionId,
  });
  if (plan.action === 'reject') return;
  if (plan.action !== 'focus') return;
  assertAgentPanelPlanSideOnly(plan);
  maybeSwitchSession(plan.sessionId ?? opts?.sessionId);
  applySidePanelFocus(plan.agentId);
  emitUiEvent('open-agent-panel', { agentId: plan.agentId });
}

/** 仅打开侧栏 Agent 面板（浏览本会话已有子 agent，不指定 id） */
export function openAgentPanelBrowse(opts?: AgentPanelOpenOpts): void {
  const plan = planOpenAgentInSidePanel({
    mode: 'browse',
    sessionId: opts?.sessionId,
  });
  if (plan.action !== 'browse') return;
  assertAgentPanelPlanSideOnly(plan);
  maybeSwitchSession(plan.sessionId ?? opts?.sessionId);
  applySidePanelFocus(null);
  // 浏览态：detail 无 agentId，CardPanel 只切侧栏 agent 标签
  emitUiEvent('open-agent-panel', {});
}

/**
 * 关闭侧栏 Agent 标签：清焦点 + 关 tab（或落到同组其它工具 tab）。
 * 绝不 handleTabClick('chat') / ensureChatColumn / togglePanel(chat)，
 * 避免重复主对话列或把侧栏「重开」成 chat。
 *
 * 关闭后 active 由 closeTabInGroup → afterCardRemovedFromGroup 选左侧邻居；
 * 空组则收掉，主列 chat 原样保留。
 */
export function closeAgentSidePanel(wsId: string, groupId: string): void {
  clearAgentPanelFocus();
  const w = normalizeId(wsId);
  const g = normalizeId(groupId);
  if (!w || !g) return;
  // 单一写路径：workspace closeTab（left-neighbor active，不 ensureChat）
  getWorkspaceStoreState().closeTabInGroup(w, g, AGENT_SIDE_PANEL_CARD_ID);
}

/** 当前是否在侧栏聚焦某子 agent（非主列） */
export function isAgentSidePanelFocused(agentId?: string | null): boolean {
  const st = getSessionStoreState();
  if (st.activeAgentId) return false; // 主列路径应始终为 null
  if (agentId == null || agentId === '') return Boolean(st.panelAgentId);
  const id = normalizeAgentPanelAgentId(agentId);
  if (!id) return Boolean(st.panelAgentId);
  return st.panelAgentId === id;
}
