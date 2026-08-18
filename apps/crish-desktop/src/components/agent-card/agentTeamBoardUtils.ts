/**
 * AgentTeamBoard 纯函数 / 常量 / 标题计算工具。
 * 从 AgentTeamBoard.tsx 拆出以收敛单文件行数。
 * agentTitle 保留 export 供测试（AgentTeamBoard.title.test.ts）消费。
 */
import type { SessionAgent } from '../../store/types';
import { humanizeAgentSummary } from '../../api/toolPresentation';

export const STATUS_LABEL: Record<SessionAgent['status'], string> = {
  running: '运行中',
  completed: '完成',
  failed: '失败',
  stopped: '已停止',
};

/** compact 侧栏：摘要更短，避免挤掉工具 hint */
export const SNIPPET_MAX = { full: 72, compact: 48 } as const;

/** 规范化 agent id：trim；空 → null（防幽灵选项） */
export function normalizeAgentId(id: string | null | undefined): string | null {
  if (id == null) return null;
  const t = String(id).trim();
  return t ? t : null;
}

/** 展示名：displayLabel → description → mode → id → 中文兜底（T-D-05 label 优先）；
 * 空白候选跳过（对齐 openAgentPanel 的空串跳过语义，防空白标签阻塞兜底链） */
export function agentTitle(agent: SessionAgent): string {
  for (const candidate of [
    agent.displayLabel,
    agent.description,
    agent.mode,
    agent.id,
  ]) {
    const t = (candidate || '').trim();
    if (t) return t;
  }
  return '子智能体';
}

/** 运行中优先 → 失败 → 已停止 → 完成；同组新在前 */
export function rankAgentStatus(st: SessionAgent['status']): number {
  if (st === 'running') return 0;
  if (st === 'failed') return 1;
  if (st === 'stopped') return 2;
  return 3;
}

export function toolProgress(agent: SessionAgent): {
  total: number;
  done: number;
  running: number;
  pending: number;
} {
  const tools = (agent.messages || []).flatMap((m) => m.toolCalls || []);
  let done = 0;
  let running = 0;
  let pending = 0;
  for (const t of tools) {
    if (t.status === 'success' || t.status === 'error') done += 1;
    else if (t.status === 'running') running += 1;
    else pending += 1;
  }
  return { total: tools.length, done, running, pending };
}

/** 紧凑时长：12秒 / 3分 / 1时2分（空则 null） */
export function formatCompactDuration(agent: SessionAgent): string | null {
  const start = agent.startedAt;
  if (!start || !Number.isFinite(start)) return null;
  const end =
    agent.endedAt && Number.isFinite(agent.endedAt) ? agent.endedAt : Date.now();
  const sec = Math.max(0, Math.round((end - start) / 1000));
  if (sec < 60) return `${sec}秒`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s > 0 ? `${m}分${s}秒` : `${m}分`;
  }
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return m > 0 ? `${h}时${m}分` : `${h}时`;
}

export function isNoiseAgentLine(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/^（?主\s*agent/i.test(t) || /已拉起协作/.test(t)) return true;
  if (/^mode=\w+/i.test(t) || /turns=\d+.*tools=\d+/i.test(t)) return true;
  return false;
}

export function summarySnippet(agent: SessionAgent, maxLen: number): string {
  const clip = (raw: string) => {
    const t = raw.trim().replace(/\s+/g, ' ');
    return t.length > maxLen ? `${t.slice(0, maxLen - 1)}…` : t;
  };
  // 1) 清洗后的 summary（去掉 mode=/turns=）
  if ((agent.summary || '').trim()) {
    const h = humanizeAgentSummary(agent.summary, agent.status);
    if (h && !isNoiseAgentLine(h) && h !== '暂无摘要') return clip(h);
  }
  // 2) 最近助手正文
  const msgs = agent.messages || [];
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (m!.sender === 'assistant' && (m!.text || '').trim()) {
      const t = m!.text!.trim();
      if (isNoiseAgentLine(t)) continue;
      return clip(t);
    }
  }
  // 3) 用户任务句（跳过系统灌入）
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (m!.sender === 'user' && (m!.text || '').trim()) {
      const t = m!.text!.trim();
      if (isNoiseAgentLine(t)) continue;
      return clip(t);
    }
  }
  return humanizeAgentSummary('', agent.status);
}

/** 工具进度：完成态隐藏「工具 n/n」，只在运行/待批时展示 */
export function formatToolsHint(
  agent: SessionAgent,
  prog: ReturnType<typeof toolProgress>,
  compact: boolean,
): string {
  if (prog.total <= 0) {
    return agent.status === 'running' ? '执行中…' : '';
  }
  // 已结束：时长/状态已够，不再刷「工具 9/9」
  if (agent.status === 'completed' || agent.status === 'stopped') {
    return '';
  }
  if (agent.status === 'failed') {
    return compact ? `工具 ${prog.done}/${prog.total}` : `工具 ${prog.done}/${prog.total}`;
  }
  if (compact) {
    let h = `工具 ${prog.done}/${prog.total}`;
    if (prog.pending) h += ` · 待批${prog.pending}`;
    else if (prog.running) h += ` · 执行${prog.running}`;
    return h;
  }
  return `工具 ${prog.done}/${prog.total}${
    prog.running ? ` · ${prog.running} 执行中` : ''
  }${prog.pending ? ` · ${prog.pending} 待批` : ''}`;
}

export function progressPercent(
  agent: SessionAgent,
  prog: ReturnType<typeof toolProgress>,
): number {
  if (prog.total > 0) return Math.round((prog.done / prog.total) * 100);
  if (agent.status === 'completed') return 100;
  if (agent.status === 'running') return 35;
  if (agent.status === 'failed') return 100;
  return 0;
}
