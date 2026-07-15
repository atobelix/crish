/**
 * 引擎会话列表 → 本地 UI 的尽力合并。
 * 本地消息正文始终是真相源；引擎只补全缺失的标题 / id，并登记远程仅有的会话壳。
 */

import { getDesktopDaemonClient } from './daemonClient';
import { logInternalError } from './userFacingErrors';
import type { SessionState } from '../store/layoutStore';
import { GENERAL_FOLDER, listProjects } from './projectStore';
import { isDefaultSessionTitle, maybeAutoTitleFromMessages } from './sessionTitle';

type DaemonSession = {
  id?: string;
  sessionId?: string;
  title?: string;
  name?: string;
  cwd?: string;
  updatedAt?: string | number;
  createdAt?: string | number;
};

function asId(s: DaemonSession): string | null {
  const id = s.id || s.sessionId;
  return typeof id === 'string' && id ? id : null;
}

function asTitle(s: DaemonSession): string {
  const raw =
    (typeof s.title === 'string' && s.title.trim()) ||
    (typeof s.name === 'string' && s.name.trim()) ||
    '';
  // 引擎无标题时用「新会话」，避免侧栏长期卡在空的「会话」
  if (!raw || raw === '会话') return '新会话';
  return raw;
}

/** 远程 cwd 映射到用户项目 id；匹配不上则归入对话区 */
function folderForRemote(r: DaemonSession): string {
  const cwd = typeof r.cwd === 'string' ? r.cwd.replace(/\\/g, '/').replace(/\/+$/, '') : '';
  if (!cwd) return GENERAL_FOLDER;
  const projects = listProjects();
  const hit = projects.find((p) => {
    const path = p.path.replace(/\\/g, '/').replace(/\/+$/, '');
    return path.toLowerCase() === cwd.toLowerCase() || cwd.toLowerCase().startsWith(path.toLowerCase() + '/');
  });
  return hit?.id || GENERAL_FOLDER;
}

function formatRemoteTime(r: DaemonSession): string {
  const raw = r.updatedAt ?? r.createdAt;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    try {
      return new Date(raw).toLocaleString();
    } catch {
      return '远程';
    }
  }
  if (typeof raw === 'string' && raw.trim()) return raw;
  return '远程';
}

export async function fetchDaemonSessions(): Promise<DaemonSession[]> {
  const client = getDesktopDaemonClient();
  try {
    if (!client.isConnected()) {
      const ok = await client.waitUntilConnected(8_000);
      if (!ok) return [];
    }
    const res = (await client.request(
      { type: 'list-sessions', includeArchived: false },
      'sessions-listed',
      10_000,
    )) as Record<string, unknown>;
    const list = res.sessions;
    return Array.isArray(list) ? (list as DaemonSession[]) : [];
  } catch (e) {
    logInternalError('fetchDaemonSessions', e);
    return [];
  }
}

/**
 * 合并策略：
 * - 已有本地 id：只补空标题，不覆盖消息
 * - 仅远程：追加空壳（便于从引擎侧恢复会话入口），folder 按 cwd 绑定项目
 */
export function mergeDaemonSessions(
  local: SessionState[],
  remote: DaemonSession[],
): SessionState[] {
  if (!remote.length) return local;
  const byId = new Map(local.map((s) => [s.id, { ...s, messages: s.messages || [] }]));

  for (const r of remote) {
    const id = asId(r);
    if (!id) continue;
    const existing = byId.get(id);
    if (existing) {
      // 仅补默认标题；本地已有用户消息时优先从消息推导
      if (isDefaultSessionTitle(existing.title)) {
        const fromMsgs = maybeAutoTitleFromMessages(existing.title, existing.messages);
        const remoteTitle = asTitle(r);
        existing.title = fromMsgs || (isDefaultSessionTitle(remoteTitle) ? existing.title || '新会话' : remoteTitle);
      }
      // 本地仍是 GENERAL 且远程能映射到项目时，补绑定
      if (
        (existing.folder === GENERAL_FOLDER || !existing.folder) &&
        folderForRemote(r) !== GENERAL_FOLDER
      ) {
        existing.folder = folderForRemote(r);
      }
      byId.set(id, existing);
    } else {
      byId.set(id, {
        id,
        title: asTitle(r),
        folder: folderForRemote(r),
        isPinned: false,
        isArchived: false,
        timestamp: formatRemoteTime(r),
        messages: [],
      });
    }
  }

  const localIds = new Set(local.map((s) => s.id));
  const merged = local.map((s) => byId.get(s.id)!).filter(Boolean);
  for (const [id, s] of byId) {
    if (!localIds.has(id)) merged.push(s);
  }
  // 合并后：默认标题 + 本地消息 → 再推导一次
  return merged.map((s) => {
    const t = maybeAutoTitleFromMessages(s.title, s.messages);
    return t ? { ...s, title: t } : s;
  });
}

export async function syncSessionsFromDaemon(
  getLocal: () => SessionState[],
  setLocal: (sessions: SessionState[]) => void,
): Promise<number> {
  const remote = await fetchDaemonSessions();
  if (!remote.length) return 0;
  const local = getLocal();
  const next = mergeDaemonSessions(local, remote);
  // 无实质变化则不写 store，避免无意义持久化抖动
  if (next.length === local.length) {
    let same = true;
    for (let i = 0; i < local.length; i++) {
      const a = local[i];
      const b = next.find((s) => s.id === a.id);
      if (!b || b.title !== a.title || b.folder !== a.folder) {
        same = false;
        break;
      }
    }
    const remoteOnly = next.filter((s) => !local.some((l) => l.id === s.id));
    if (same && remoteOnly.length === 0) return remote.length;
  }
  setLocal(next);
  return remote.length;
}
