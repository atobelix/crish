/**
 * 引擎会话列表 → 本地 UI 的尽力合并。
 * 本地消息正文始终是真相源；引擎只补全缺失的标题 / id。
 *
 * 不把「默认标题 + 无本地消息」的远程空壳塞进侧栏：
 * 引擎 list-sessions 常含大量未命名占位，盲目 merge 会刷出幽灵「新会话」。
 *
 * 离线 / 空远程 / 全幽灵远程：不得据此删除或伪造本地会话。
 */

import { getDesktopDaemonClient } from './daemonClient';
import { logInternalError } from './userFacingErrors';
import type { SessionState } from '../store/layoutStore';
import { GENERAL_FOLDER, listProjects } from './projectStore';
import {
  isDefaultSessionTitle,
  maybeAutoTitleFromMessages,
  pruneEmptyShellSessions,
} from './sessionTitle';

export type DaemonSession = {
  id?: string;
  sessionId?: string;
  title?: string;
  name?: string;
  cwd?: string;
  updatedAt?: string | number;
  createdAt?: string | number;
};

/** merge 可选行为：空壳剪枝（须配合 keepIds 保留 active） */
export type MergeDaemonSessionsOpts = {
  /**
   * 合并后剪除非保留空壳。
   * 默认 false：纯 merge 不删本地空白「新会话」（用户可能正要输入）。
   * 显式 hydrate / 调用方可传 true。
   */
  pruneEmptyShells?: boolean;
  /** prune 时保留的 id（通常含 activeSessionId / 并发后台会话） */
  keepIds?: Iterable<string> | null;
};

/**
 * 规范化远程会话 id：trim；优先 id，其次 sessionId；空白 / 非字符串 → null。
 * 匹配本地时统一用此键，避免空格 id 幽灵与 sessionId 字段不一致。
 */
export function remoteSessionId(s: DaemonSession): string | null {
  for (const raw of [s.id, s.sessionId]) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (id) return id;
  }
  return null;
}

/**
 * 远程标题清洗：空 / 默认占位一律视为无标题（返回空串，绝不伪造「新会话」）。
 * 插入决策：仅非空且非默认才追加入口。
 */
export function remoteSessionTitle(s: DaemonSession): string {
  const raw =
    (typeof s.title === 'string' && s.title.trim()) ||
    (typeof s.name === 'string' && s.name.trim()) ||
    '';
  if (!raw) return '';
  // 统一走 isDefaultSessionTitle（含 新会话 / New Session / Untitled …）
  if (isDefaultSessionTitle(raw)) return '';
  return raw;
}

/** 仅远程且标题为真实非默认时才可插入本地侧栏 */
export function shouldInsertRemoteSession(remoteTitle: string): boolean {
  const t = (remoteTitle ?? '').trim();
  return Boolean(t) && !isDefaultSessionTitle(t);
}

/**
 * 标题合并优先级（本地真相优先）：
 * 1. 本地已是真实 / 定时 / 用户改名 → 原样保留
 * 2. 本地默认 + 消息可推导 → 用消息标题
 * 3. 本地默认 + 远程真实标题 → 用远程
 * 4. 否则保持本地（含默认「新会话」，绝不发明）
 */
export function resolveMergedSessionTitle(
  existingTitle: string,
  messages: SessionState['messages'] | undefined | null,
  remoteTitleClean: string,
): string {
  if (!isDefaultSessionTitle(existingTitle)) {
    return existingTitle;
  }
  const fromMsgs = maybeAutoTitleFromMessages(existingTitle, messages ?? []);
  if (fromMsgs && fromMsgs !== existingTitle) {
    return fromMsgs;
  }
  const remote = (remoteTitleClean ?? '').trim();
  if (remote && !isDefaultSessionTitle(remote)) {
    return remote;
  }
  return existingTitle;
}

/**
 * 远程是否视为离线/不可用（null / undefined / 空数组）。
 * 离线时禁止用「空列表」推断删除本地会话。
 */
export function isOfflineOrEmptyRemote(
  remote: DaemonSession[] | null | undefined,
): boolean {
  return remote == null || remote.length === 0;
}

/**
 * 解析 daemon 时间戳为 ms；无效返回 null（调用方勿当 0 epoch 写入）。
 * 支持秒级 / 毫秒级 number 与可 parse 的 ISO 字符串。
 */
export function parseDaemonTimeMs(r: DaemonSession): number | null {
  const raw = r.updatedAt ?? r.createdAt;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw < 1e12 ? raw * 1000 : raw;
  }
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Date.parse(raw.trim());
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

/**
 * 解析本地 session.timestamp 为 ms；locale 脏串 / 相对文案 → null。
 */
export function parseLocalSessionTimeMs(s: SessionState): number | null {
  const raw = (s.timestamp ?? '').trim();
  if (!raw) return null;
  if (raw === '刚刚' || raw === '恢复' || raw === '远程') return null;
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return null;
}

/**
 * 远程元数据是否「足够新」可用于补 folder 等非标题字段。
 * - 无法解析任一侧时间 → 允许（未知不阻塞补全）
 * - 远程明显落后本地超过 skewMs → 视为 stale，跳过 folder 升级
 * 标题补全不依赖此守卫（默认标题仍可用引擎名；真实标题永不被覆盖）。
 */
export function isRemoteMetadataFresh(
  local: SessionState,
  remote: DaemonSession,
  skewMs = 60_000,
): boolean {
  const remoteMs = parseDaemonTimeMs(remote);
  if (remoteMs == null) return true;
  const localMs = parseLocalSessionTimeMs(local);
  if (localMs == null) return true;
  return remoteMs + Math.max(0, skewMs) >= localMs;
}

/** 远程 cwd 映射到用户项目 id；匹配不上则归入对话区 */
function folderForRemote(r: DaemonSession): string {
  const cwd =
    typeof r.cwd === 'string'
      ? r.cwd.replace(/\\/g, '/').replace(/\/+$/, '')
      : '';
  if (!cwd) return GENERAL_FOLDER;
  const projects = listProjects();
  const hit = projects.find((p) => {
    const path = p.path.replace(/\\/g, '/').replace(/\/+$/, '');
    return (
      path.toLowerCase() === cwd.toLowerCase() ||
      cwd.toLowerCase().startsWith(path.toLowerCase() + '/')
    );
  });
  return hit?.id || GENERAL_FOLDER;
}

/** 存 ISO，侧栏用 formatSessionListTime 算相对时间；勿写 locale 死字符串 */
export function formatRemoteTime(r: DaemonSession): string {
  const ms = parseDaemonTimeMs(r);
  if (ms != null) return new Date(ms).toISOString();
  const raw = r.updatedAt ?? r.createdAt;
  if (typeof raw === 'string' && raw.trim()) {
    const t = raw.trim();
    // 非时间串（历史脏值）不写入，避免侧栏永久坏标签
    if (t === '刚刚' || t === '恢复' || t === '远程') {
      return new Date().toISOString();
    }
    // 不可 parse 的原串丢弃，改用 now（避免侧栏卡死字符串）
    return new Date().toISOString();
  }
  return new Date().toISOString();
}

/**
 * 远程列表去重（同规范化 id 后者覆盖前者元数据），
 * 避免引擎偶发重复条目 / 空格 id / 缺 id 导致双插或抖动。
 */
export function dedupeRemoteSessions(remote: DaemonSession[]): DaemonSession[] {
  if (!remote.length) return remote;
  if (remote.length === 1) {
    // 单条也规范化：无 id 时返回空数组，避免下游误用
    return remoteSessionId(remote[0]!) ? remote : [];
  }
  const byId = new Map<string, DaemonSession>();
  const order: string[] = [];
  let dropped = 0;
  for (const r of remote) {
    const id = remoteSessionId(r);
    if (!id) {
      dropped += 1;
      continue;
    }
    if (!byId.has(id)) order.push(id);
    byId.set(id, r);
  }
  if (dropped === 0 && byId.size === remote.length) {
    // 无重复且无缺 id → 同一引用（id 均已非空 trim 兼容）
    let needsRebuild = false;
    for (const r of remote) {
      const id = remoteSessionId(r)!;
      if (byId.get(id) !== r) {
        needsRebuild = true;
        break;
      }
      // 若原串含首尾空格，仍重建以稳定键语义
      const raw = typeof r.id === 'string' ? r.id : r.sessionId;
      if (typeof raw === 'string' && raw !== id) {
        needsRebuild = true;
        break;
      }
    }
    if (!needsRebuild) return remote;
  }
  return order.map((id) => byId.get(id)!);
}

/**
 * 本地 id 规范化键（trim）；空 trim 时回退原 id（极端脏数据仍可定位）。
 */
export function localSessionKey(id: string): string {
  const t = (id ?? '').trim();
  return t || id;
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

function maybePrune(
  sessions: SessionState[],
  opts?: MergeDaemonSessionsOpts,
): SessionState[] {
  if (!opts?.pruneEmptyShells) return sessions;
  return pruneEmptyShellSessions(sessions, {
    ...(opts.keepIds !== undefined && { keepIds: opts.keepIds }),
  });
}

/**
 * 合并策略：
 * - 已有本地 id（规范化匹配）：只补空标题 / 项目 folder，不覆盖消息；不因远程默认标题覆盖本地
 * - 仅远程：仅当远程标题为「真实标题」时才追加入口（避免默认「新会话」空壳污染侧栏）
 * - 远程无标题的会话：等用户发消息 / 定时任务显式 createSession 再出现
 * - 离线 / 空远程：原样返回 local（可选 prune 不依赖远程）
 * - stale 远程：不升级 folder；标题仍按「本地优先」规则
 * - 无实质壳字段变化时返回同一 local 引用，避免 sync 抖动 / 无意义持久化
 * - 定时真实标题远程可插入；本地已有真实/定时标题不被默认远程覆盖
 * - opts.pruneEmptyShells：合并后剪非 keepIds 空壳（默认关）
 */
export function mergeDaemonSessions(
  local: SessionState[],
  remote: DaemonSession[] | null | undefined,
  opts?: MergeDaemonSessionsOpts,
): SessionState[] {
  // 离线 / 空列表：绝不发明远程壳；不把「引擎不可用」当成清空信号
  if (isOfflineOrEmptyRemote(remote)) {
    return maybePrune(local, opts);
  }

  // 去重后可能为空（全无 id）；仍走下方本地补标题路径，勿直接 return
  const remoteList = dedupeRemoteSessions(remote!);

  // 先挂本地同一引用；仅在字段真正变化时再 clone；键用规范化 id
  const byId = new Map<string, SessionState>();
  for (const s of local) {
    byId.set(localSessionKey(s.id), s);
  }

  let changed = false;
  const appended: SessionState[] = [];

  for (const r of remoteList) {
    const id = remoteSessionId(r);
    if (!id) continue;
    const existing = byId.get(id);
    const remoteTitle = remoteSessionTitle(r);

    if (existing) {
      let title = resolveMergedSessionTitle(
        existing.title,
        existing.messages,
        remoteTitle,
      );
      let folder = existing.folder;
      // folder 仅在远程元数据足够新时补绑定，避免 stale list 改项目归属
      if (isRemoteMetadataFresh(existing, r)) {
        const mappedFolder = folderForRemote(r);
        if (
          (existing.folder === GENERAL_FOLDER || !existing.folder) &&
          mappedFolder !== GENERAL_FOLDER &&
          mappedFolder !== existing.folder
        ) {
          folder = mappedFolder;
        }
      }
      if (title !== existing.title || folder !== existing.folder) {
        const next: SessionState = {
          ...existing,
          title,
          folder,
          messages: existing.messages || [],
        };
        byId.set(id, next);
        changed = true;
      }
    } else {
      // 无真实标题 / 默认占位的远程空壳：绝不插入（避免刷幽灵「新会话」）
      // 定时 · xxx 等真实标题可插入（shouldInsertRemoteSession 通过）
      if (!shouldInsertRemoteSession(remoteTitle)) {
        continue;
      }
      const created: SessionState = {
        id,
        title: remoteTitle,
        folder: folderForRemote(r),
        isPinned: false,
        isArchived: false,
        timestamp: formatRemoteTime(r),
        messages: [],
      };
      byId.set(id, created);
      appended.push(created);
      changed = true;
    }
  }

  // 无 id 级变化：仅在有默认标题时扫消息补标题；全无变化则返回同一 local 引用
  if (!changed) {
    let titledAny = false;
    const next = local.map((s) => {
      if (!isDefaultSessionTitle(s.title)) return s;
      const t = maybeAutoTitleFromMessages(s.title, s.messages);
      if (!t || t === s.title) return s;
      titledAny = true;
      return { ...s, title: t };
    });
    const result = titledAny ? next : local;
    return maybePrune(result, opts);
  }

  // 有插入/字段变更：按本地顺序 + 追加，并对默认标题再推导一次
  const merged: SessionState[] = [];
  for (const s of local) {
    const key = localSessionKey(s.id);
    const cur = byId.get(key) ?? s;
    const t = maybeAutoTitleFromMessages(cur.title, cur.messages);
    if (t && t !== cur.title) {
      const titled = { ...cur, title: t };
      byId.set(key, titled);
      merged.push(titled);
    } else {
      merged.push(cur);
    }
  }
  for (const s of appended) {
    merged.push(s);
  }
  return maybePrune(merged, opts);
}

/**
 * sync 侧「壳字段」是否一致（顺序 + id/title/folder）。
 * 仅用于决定是否 setLocal；消息正文不参与比较。
 */
export function daemonMergeShellEqual(
  a: SessionState[],
  b: SessionState[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.id !== y.id) return false;
    if (x.title !== y.title) return false;
    if ((x.folder || '') !== (y.folder || '')) return false;
  }
  return true;
}

export async function syncSessionsFromDaemon(
  getLocal: () => SessionState[],
  setLocal: (sessions: SessionState[]) => void,
  opts?: MergeDaemonSessionsOpts,
): Promise<number> {
  const remote = await fetchDaemonSessions();
  // 离线 / 空列表：不写 store（避免把失败当清空）
  if (isOfflineOrEmptyRemote(remote)) return 0;
  const local = getLocal();
  const next = mergeDaemonSessions(local, remote, opts);
  // 无实质变化则不写 store，避免无意义持久化抖动
  if (next === local || daemonMergeShellEqual(local, next)) {
    return remote.length;
  }
  setLocal(next);
  return remote.length;
}
