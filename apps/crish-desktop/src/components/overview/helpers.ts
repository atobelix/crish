import { backgroundTaskStateLabel, type BackgroundTaskInfo } from '../../api/backgroundTasksApi';

export function basename(p: string): string {
  return p.replace(/^.*[\\/]/, '') || p;
}

export function agentOneLineLabel(description: string | undefined, id: string): string {
  const raw = (description || id || '').replace(/\s+/g, ' ').trim();
  return raw || id;
}

export function agentStatusLabel(status: string): string {
  if (status === 'running') return '运行中';
  if (status === 'failed') return '失败';
  if (status === 'stopped') return '已停止';
  return '完成';
}

export function formatElapsed(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m} 分 ${r} 秒`;
  const h = Math.floor(m / 60);
  return `${h} 时 ${m % 60} 分`;
}

export function formatBgTaskMeta(opts: {
  state: unknown;
  command?: string | undefined;
  opening?: boolean | undefined;
}): string {
  if (opts.opening) return '打开中…';
  const label = backgroundTaskStateLabel(opts.state);
  const cmd = (opts.command || '').trim();
  if (!cmd) return label;
  return `${label} · ${cmd.slice(0, 40)}`;
}

export function getGitStatusColor(status: string): string {
  if (status === 'A' || status === '?') return 'var(--accent-green, #22c55e)';
  if (status === 'D') return 'var(--accent-red, #ef4444)';
  if (status === 'U') return 'var(--accent-red, #ef4444)';
  return 'var(--accent-orange, #f97316)';
}
