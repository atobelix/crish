import type { SessionAgent } from '../../store/layoutStore';

/** 状态芯片文案（中文唯一来源） */
export const STATUS_LABEL: Record<SessionAgent['status'], string> = {
  running: '运行中',
  completed: '完成',
  failed: '失败',
  stopped: '已停止',
};

/** 浏览列表排序：运行中 → 失败 → 已停止 → 完成；同组新在前 */
export function rankAgentStatus(st: SessionAgent['status']): number {
  if (st === 'running') return 0;
  if (st === 'failed') return 1;
  if (st === 'stopped') return 2;
  return 3;
}

export function sortAgentsForBrowse(agents: SessionAgent[]): SessionAgent[] {
  return [...agents].sort((a, b) => {
    const d = rankAgentStatus(a.status) - rankAgentStatus(b.status);
    if (d !== 0) return d;
    return (b.startedAt || 0) - (a.startedAt || 0);
  });
}

/** 紧凑时长：侧栏密度用 */
export function formatAgentDuration(agent: SessionAgent): string | null {
  const start = agent.startedAt;
  if (!start || !Number.isFinite(start)) return null;
  const end = agent.endedAt && Number.isFinite(agent.endedAt) ? agent.endedAt : Date.now();
  const sec = Math.max(0, Math.round((end - start) / 1000));
  if (sec < 60) return `${sec} 秒`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s > 0 ? `${m} 分 ${s} 秒` : `${m} 分钟`;
  }
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

export function agentDisplayName(agent: SessionAgent): string {
  return (agent.description || agent.mode || agent.id || '子智能体').trim() || '子智能体';
}

export function countPendingApprovals(agent: SessionAgent): number {
  let n = 0;
  for (const m of agent.messages || []) {
    for (const t of m.toolCalls || []) {
      if (t.status === 'pending_approval') n += 1;
    }
  }
  return n;
}

/** 新窗口打开 agent 只读快照（Blob URL，避免 document.write）；非侧栏主路径 */
export function openAgentInNewWindow(agent: SessionAgent): void {
  const w = window.open('', '_blank', 'noopener,noreferrer,width=720,height=900');
  if (!w) return;
  const esc = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const statusLabel = STATUS_LABEL[agent.status] || '完成';
  const lines: string[] = [];
  lines.push(`<h1>${esc(agent.description || '协作智能体')}</h1>`);
  lines.push(
    `<p class="meta">${esc(agent.mode || '')} · ${esc(statusLabel)}${
      agent.summary ? ' · ' + esc(agent.summary) : ''
    }</p>`,
  );
  for (const m of agent.messages || []) {
    if (m.sender === 'user') {
      lines.push(`<div class="u">${esc(m.text || '')}</div>`);
    } else {
      lines.push(`<div class="a">${esc(m.text || '')}</div>`);
      for (const tc of m.toolCalls || []) {
        const tcStatus =
          tc.status === 'success'
            ? '成功'
            : tc.status === 'error'
              ? '失败'
              : tc.status === 'running'
                ? '执行中'
                : tc.status === 'pending_approval'
                  ? '待审批'
                  : String(tc.status || '');
        lines.push(
          `<div class="t"><b>${esc(tc.name)}</b> ${esc(tcStatus)}<pre>${esc(
            (tc.output || '').slice(0, 2000),
          )}</pre></div>`,
        );
      }
    }
  }
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><title>${esc(
    agent.description || '子智能体',
  )}</title>
<style>
body{font-family:system-ui,sans-serif;padding:20px;max-width:720px;margin:0 auto;color:#222;background:#fafafa}
h1{font-size:18px;margin:0 0 8px}.meta{color:#888;font-size:12px;margin:0 0 20px}
.u{background:#e8eef8;padding:10px 12px;border-radius:12px;margin:10px 0 10px auto;max-width:85%;width:fit-content}
.a{background:#fff;border:1px solid #eee;padding:10px 12px;border-radius:12px;margin:10px 0;white-space:pre-wrap}
.t{font-size:12px;color:#666;margin:6px 0 6px 8px}pre{white-space:pre-wrap;font-size:11px;background:#f4f4f5;padding:8px;border-radius:6px}
</style></head><body>${lines.join('\n')}</body></html>`;
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const revoke = () => {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
  };
  try {
    w.addEventListener('load', revoke, { once: true });
  } catch {
    /* ignore */
  }
  // 兜底：部分环境 load 不可靠
  window.setTimeout(revoke, 60_000);
  w.location.href = url;
}
