/**
 * 智能体预设：供主 AI 参考与右侧临时分析选择。
 * 主路径仍是 AI 自动 run_subagent；此处只做本地可配置偏好。
 */

import type { CollaboratorMode } from './subagentApi';

export type AgentProfile = {
  id: string;
  name: string;
  mode: CollaboratorMode;
  /** 写给模型的角色说明 */
  hint: string;
};

const STORAGE_KEY = 'crish_agent_profiles_v1';

const DEFAULT_PROFILES: AgentProfile[] = [
  {
    id: 'research',
    name: '调研',
    mode: 'research',
    hint: '只读分析、搜索与归纳，不改仓库',
  },
  {
    id: 'implement',
    name: '实现',
    mode: 'implement',
    hint: '改代码、跑命令（遵守权限模式）',
  },
  {
    id: 'verify',
    name: '验证',
    mode: 'verify',
    hint: '检查结果、复现与对照',
  },
  {
    id: 'critique',
    name: '评议',
    mode: 'research',
    hint: '审视主 agent 改动理由、风险与替代方案',
  },
];

export function defaultAgentProfiles(): AgentProfile[] {
  return DEFAULT_PROFILES.map((p) => ({ ...p }));
}

export function loadAgentProfiles(): AgentProfile[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultAgentProfiles();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || !parsed.length) return defaultAgentProfiles();
    const list = parsed
      .map((x) => {
        if (!x || typeof x !== 'object') return null;
        const o = x as Record<string, unknown>;
        const id = typeof o.id === 'string' ? o.id : '';
        const name = typeof o.name === 'string' ? o.name : '';
        const mode = o.mode === 'implement' || o.mode === 'verify' ? o.mode : 'research';
        const hint = typeof o.hint === 'string' ? o.hint : '';
        if (!id || !name) return null;
        return { id, name, mode, hint } satisfies AgentProfile;
      })
      .filter(Boolean) as AgentProfile[];
    return list.length ? list : defaultAgentProfiles();
  } catch {
    return defaultAgentProfiles();
  }
}

export function saveAgentProfiles(list: AgentProfile[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, 24)));
  } catch {
    /* swallow-ok: agent 角色列表尽力写，quota/隐私模式失败时下次启动回退默认 */
  }
}

/** 拼进系统/任务提示，供主 AI 知道可用角色（不替代引擎工具） */
export function agentProfilesPromptHint(profiles?: AgentProfile[]): string {
  const list = profiles || loadAgentProfiles();
  if (!list.length) return '';
  const lines = list.map((p) => `- ${p.name}（${p.mode}）：${p.hint}`);
  return [
    '可用协作角色（需要分工时用 run_subagent 拉起，勿让用户手填协作者表单）：',
    ...lines,
  ].join('\n');
}
