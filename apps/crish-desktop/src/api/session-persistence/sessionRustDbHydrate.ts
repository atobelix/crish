/**
 * sessionRustDb 子模块 · Hydrate/Persist：复合 API 面
 *
 * 职责：
 *   - hydrateSessionsFromRust：boot 时一次性加载全部会话（index + bodies + agents）
 *     （T2-1 剥镜像：正文直连 SQLite，不再有降级戳分叉恢复读面）
 *   - persistAllSessionsRust：全量持久化（per-session invoke，写队列 + 版本戳 CAS）
 *   - persistAllSessionsSyncViaLocalStorage：beforeunload 同步镜像（禁止 await）
 */

import type { SessionState } from '../../store/layoutStore';
import {
  SESSION_AGENTS_PREFIX,
  SESSION_BODY_PREFIX,
  type SessionIndexEntry,
} from './sessionPersistenceTypes';
import { isPendingDraftSessionId as isPendingDraft } from '@crish/shared-types';
import { type RustSessionIndexEntry } from './sessionRustDbWire';
import {
  lsLoadSessionIndex,
  lsSaveActiveSessionId,
  lsSaveFolderOrder,
  lsSaveSessionAgents,
  lsSaveSessionBody,
  lsSaveSessionIndex,
  markDegradedSession,
} from './sessionRustDbFallback';
import {
  cleanupOrphanSessions,
  enqueuePersist,
  getSessionMeta,
  isHydrateTruncated,
  listSessions,
  loadSessionAgents,
  loadSessionBody,
  nextBatchVersion,
  saveSessionAgents,
  saveSessionBody,
  setSessionMeta,
} from './sessionRustDbSql';
import { invokeResult } from '../tauriInvoke';
import { logInternalError } from '../userFacingErrors';
import { errorStore } from '../../services/ErrorStore';
import {
  parseFolderOrder,
  safeParseJson,
  sanitizeMessagesForHydrate,
} from './sessionHydration';
import { coerceSessionTimestamp } from '../sessionTime';
import { prepareSessionsForUi } from '../sessionTitle';
import { normalizeAssistantTimeline } from '../toolPresentation';

// ── 复合 API：hydrateSessionsFromRust ──────────────────────────────────────

/**
 * 从存储层加载全部会话（index + bodies + agents），构造 SessionState[]。
 *
 * 索引加载策略（Stream D 过渡期）：
 *   1. 优先读 localStorage 索引（侧栏元数据真相源，由 persistAllSessionsRust 维护）
 *   2. localStorage 为空时回退到 SQLite list_sessions（30 天清理后或新装机场景）
 *   3. 两者都为空 → 返回空会话列表
 *
 * bodies / agents 加载策略：
 *   - 优先 SQLite（load_session_body / load_session_agents）
 *   - invoke 缺失时回退 localStorage
 *
 * 注意：此 API 在 boot 时调用一次。为兼容现有 store 初始化（同步 seedSessions），
 * seedSessions 仍调用同步回退路径；此 async 版本供 store-persistence 使用。
 */
export async function hydrateSessionsFromRust(): Promise<{
  sessions: SessionState[];
  activeSessionId: string | null;
  folderOrder: string[] | null;
}> {
  // 1. 索引：localStorage 优先（真相源），回退 SQLite
  let index = lsLoadSessionIndex();
  if (!index.length) {
    index = await listSessions();
  }
  if (!index.length) {
    return {
      sessions: [],
      activeSessionId: await getSessionMeta('active_session_id'),
      folderOrder: parseFolderOrder(
        safeParseJson<unknown>(await getSessionMeta('folder_order'), null)
      ),
    };
  }

  // I-DRAFT：索引层再滤哨兵；parseSessionIndexEntry 已拒，双保险
  const ordered = [...index]
    .filter((e) => e.id && !isPendingDraft(e.id))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  // 并行加载每个会话的 body 与 agents
  const sessions: SessionState[] = await Promise.all(
    ordered.map(async (e) => {
      const [messages, agents] = await Promise.all([
        loadSessionBody(e.id),
        loadSessionAgents(e.id),
      ]);
      const sanitized = sanitizeMessagesForHydrate(messages);
      const state: SessionState = {
        id: e.id,
        title: e.title,
        folder: e.folder,
        isPinned: e.isPinned,
        isArchived: e.isArchived,
        timestamp: coerceSessionTimestamp(e.id, e.timestamp, sanitized),
        messages: sanitized,
        agents,
        ...(e.branchParentId !== undefined
          ? { branchParentId: e.branchParentId }
          : {}),
        ...(e.pinnedMessageIds?.length
          ? { pinnedMessageIds: e.pinnedMessageIds }
          : {}),
        ...(e.engineCursor !== undefined
          ? { engineCursor: e.engineCursor }
          : {}),
        ...(e.engineLastRunId !== undefined
          ? { engineLastRunId: e.engineLastRunId }
          : {}),
        ...(e.hydratedFromEngine !== undefined
          ? { hydratedFromEngine: e.hydratedFromEngine }
          : {}),
        // importMeta 仅存 localStorage 索引；SQLite 行无此列，从 LS 索引水合时带回
        ...(e.importMeta ? { importMeta: e.importMeta } : {}),
      };
      return state;
    })
  );

  const activeRaw = await getSessionMeta('active_session_id');
  const active = activeRaw && !isPendingDraft(activeRaw) ? activeRaw : null;
  // prepareSessionsForUi：加载后 prune 非 keep 空壳
  const prepared = prepareSessionsForUi(sessions, active);
  const activeSessionId =
    active && prepared.some((s) => s.id === active) ? active : null;
  const folderOrderRaw = await getSessionMeta('folder_order');
  const folderOrder = parseFolderOrder(
    safeParseJson<unknown>(folderOrderRaw, null)
  );

  return { sessions: prepared, activeSessionId, folderOrder };
}

// ── 复合 API：persistAllSessionsRust ────────────────────────────────────────

/**
 * 全量持久化所有会话到 SQLite（per-session invoke，避免单次 IPC 携带所有数据）。
 *
 * 设计要点：
 *   - 每个会话单独 save_session_body / save_session_agents（细粒度并发）
 *   - activeSessionId / folderOrder 写入 session_meta 表
 *   - 孤儿清理走 cleanup_orphan_sessions
 *   - assistant 消息统一走 normalizeAssistantTimeline（与原 persistAllSessions 对齐）
 *   - 写竞态防线（PS-03 T3.2 D6）：批次发起时领取单调递增版本号（R9），
 *     整批任务（probe + 全部写 IPC）串入模块级写队列 writeChain——同会话写
 *     任务按发起序落库，后发批次最终落库；saveSessionBody 落库前做版本
 *     CAS，陈旧批次直接丢弃不覆盖。350ms debounce / boot 回灌 / 手动触发
 *     全部经本入口，版本戳覆盖全部 save_session_body 调用路径。
 *
 * 命令缺失时回退到 localStorage 同步路径（persistAllSessionsSync 等价行为）。
 */
export async function persistAllSessionsRust(
  sessions: SessionState[],
  activeSessionId: string,
  folderOrder: string[],
  options?: {
    /** 把 SessionState[] 投影为索引条目（侧栏元数据真相源） */
    sessionsToIndex?: (sessions: SessionState[]) => SessionIndexEntry[];
  }
): Promise<void> {
  // 批次版本戳：发起时领取（发起序 = 版本序，后发起 = 高版本，R9）。
  // 整批任务串入模块级写队列，与上一批不并发飞行。
  const batchVersion = nextBatchVersion();
  await enqueuePersist(async () => {
    // I-DRAFT：persist 路径剔除 PENDING_DRAFT，永不写 sessions[]/body
    const list = (sessions || []).filter(
      (s) => Boolean(s?.id) && !isPendingDraft(s.id)
    );
    const activePersistable =
      activeSessionId && !isPendingDraft(activeSessionId)
        ? activeSessionId
        : '';

    // 索引层：始终写一份到 localStorage（侧栏元数据真相源，过渡期设计）。
    // invoke 缺失时，这就是唯一的索引落盘点。
    if (options?.sessionsToIndex) {
      try {
        const entries = options.sessionsToIndex(list);
        lsSaveSessionIndex(entries);
      } catch {
        /* swallow-ok: 索引快照回调失败不阻断索引主流程 */
      }
    }

    // 检测 invoke 可用性（用 list_sessions 作为探针）
    const probe = await invokeResult<RustSessionIndexEntry[]>('list_sessions');
    if (probe.status !== 'ok') {
      // 回退：localStorage 同步路径（索引已写入，只需写 body/agents/meta）。
      // P1-F1：整批降级必须可观测；fallback 写入的 LS 正文是 SQLite 缺失的
      // 最新快照（启动竞态期 invoke 未就绪即触发），由 fallback 打戳供 hydrate 回灌。
      logInternalError('persist-degraded-ls', {
        command: 'list_sessions(probe)',
        status: probe.status,
      });
      // D-05 S1：批级降级状态推进（Fail-Open 是设计内行为，但必须可感知）
      errorStore.setPersistenceStatus('warning');
      persistAllSessionsLocalFallback(list, activePersistable, folderOrder);
      return;
    }

    // 1. 写入每个会话的 body + agents（并发）
    // 空 messages 不调用 save_session_body：Rust 侧是先删后插，空数组会擦掉已落盘正文。
    // boot 窗口里 seed 的远程懒壳 messages=[] 很常见；等 SQLite 回灌 / 引擎 hydrate 后再写。
    const keepIds = new Set<string>();
    const bodyJobs: Promise<void>[] = [];
    for (const s of list) {
      if (!s?.id) continue;
      keepIds.add(s.id);
      const msgs = (s.messages || []).map((m) =>
        m.sender === 'assistant' ? normalizeAssistantTimeline(m) : m
      );
      if (msgs.length > 0 && !isHydrateTruncated(s)) {
        bodyJobs.push(saveSessionBody(s.id, msgs, batchVersion));
      }
      bodyJobs.push(saveSessionAgents(s.id, s.agents || []));
    }
    await Promise.allSettled(bodyJobs);

    // 2. 元数据：active_session_id / folder_order
    const metaJobs: Promise<void>[] = [];
    if (activePersistable) {
      metaJobs.push(setSessionMeta('active_session_id', activePersistable));
    }
    if (folderOrder && folderOrder.length) {
      metaJobs.push(
        setSessionMeta('folder_order', JSON.stringify(folderOrder))
      );
    }
    await Promise.allSettled(metaJobs);

    // 3. 孤儿清理
    // P0-2 防护：空会话列表（boot 窗口 hydrate 未完成 / 全删场景）跳过清理——
    // Rust 壳层对空 keepIds 默认拒绝（guard_cleanup_keep），此处直接不发起，
    // 避免错误码触发 JS 回退分支清空 LS 镜像（N1-2 双保险）；
    // 部分 keepIds 的 boot 窗口风险由 Rust 库层护栏兜底（引擎子代理会话豁免
    // + 活动 run 豁免 + 宽限期，见 conex-db sessions.rs cleanup_orphan_sessions）。
    if (keepIds.size > 0) {
      await cleanupOrphanSessions(Array.from(keepIds));
    }

    // D-05 S1：probe 成功且批收口 → 持久化降级状态回落健康（恢复点）
    errorStore.setPersistenceStatus('healthy');
  });
}

/**
 * localStorage 同步回退：仅在 invoke 不可用时使用。
 * 索引已由调用方（persistAllSessionsRust）写入 localStorage，此处仅写 body/agents/meta。
 */
function persistAllSessionsLocalFallback(
  sessions: SessionState[],
  activeSessionId: string,
  folderOrder: string[]
): void {
  // 调用方已 filter；再拒一次 draft
  const list = (sessions || []).filter(
    (s) => Boolean(s?.id) && !isPendingDraft(s.id)
  );
  const keep = new Set(list.map((s) => s.id).filter(Boolean) as string[]);

  // 写入 keep 集合中的 body / agents（空 body 不覆盖，防懒壳擦掉已有 LS 正文）
  for (const s of list) {
    if (!s?.id) continue;
    const msgs = (s.messages || []).map((m) =>
      m.sender === 'assistant' ? normalizeAssistantTimeline(m) : m
    );
    if (msgs.length > 0 && !isHydrateTruncated(s)) {
      lsSaveSessionBody(s.id, msgs);
      // P1-F1：本次降级落 LS 的正文是 SQLite 缺失的最新快照，打戳供 hydrate
      // 单向修复（以 LS 为真源回灌回写 SQLite）
      markDegradedSession(s.id);
    }
    lsSaveSessionAgents(s.id, s.agents || []);
  }

  // 清理孤儿（N1-2 守卫：空 keep 不清除——与 Rust guard_cleanup_keep
  // 语义对齐，boot 窗口 / 全删场景不得清空 LS 镜像）
  if (keep.size > 0) {
    try {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k) keys.push(k);
      }
      for (const k of keys) {
        let id: string | null = null;
        if (k.startsWith(SESSION_BODY_PREFIX))
          id = k.slice(SESSION_BODY_PREFIX.length);
        else if (k.startsWith(SESSION_AGENTS_PREFIX))
          id = k.slice(SESSION_AGENTS_PREFIX.length);
        if (id != null && !keep.has(id)) localStorage.removeItem(k);
      }
    } catch {
      /* swallow-ok: 清理孤儿键失败时残留无害键，下次清理重试 */
    }
  }

  lsSaveActiveSessionId(activeSessionId || '');
  lsSaveFolderOrder(folderOrder || []);
}

// ── 同步辅助：供 beforeunload flush 使用 ───────────────────────────────────

/**
 * 同步持久化全部会话（beforeunload 场景，禁止 await）。
 *
 * 此函数始终走 localStorage（同步），因为 beforeunload 事件中无法 await IPC。
 * Rust 侧数据由后续 persistAllSessionsRust 在正常生命周期内同步。
 * 注（PS-03 T3.2）：本路径不调用 save_session_body（无 IPC），故无需批次
 * 版本戳；SQLite 侧由后续异步 persist 带版本写入（版本戳覆盖全部
 * save_session_body 调用路径：350ms debounce / boot 回灌 / 手动触发）。
 */
export function persistAllSessionsSyncViaLocalStorage(
  sessions: SessionState[],
  activeSessionId: string,
  folderOrder: string[],
  options?: {
    sessionsToIndex?: (sessions: SessionState[]) => SessionIndexEntry[];
  }
): void {
  // I-DRAFT：sync flush 同样剔除 PENDING_DRAFT
  const list = (sessions || []).filter(
    (s) => Boolean(s?.id) && !isPendingDraft(s.id)
  );
  const keep = new Set(list.map((s) => s.id).filter(Boolean) as string[]);
  const activePersistable =
    activeSessionId && !isPendingDraft(activeSessionId) ? activeSessionId : '';

  if (options?.sessionsToIndex) {
    try {
      lsSaveSessionIndex(options.sessionsToIndex(list));
    } catch {
      /* swallow-ok: 索引快照回调失败不阻断镜像主流程 */
    }
  }

  for (const s of list) {
    if (!s?.id) continue;
    const msgs = (s.messages || []).map((m) =>
      m.sender === 'assistant' ? normalizeAssistantTimeline(m) : m
    );
    // beforeunload 同步路径：仅镜像非空正文，避免把未 hydrate 懒壳写成 [];
    // P1-D2 熔断：未完整（截断）会话同样跳过，防截断态固化 LS 镜像
    if (msgs.length > 0 && !isHydrateTruncated(s)) {
      lsSaveSessionBody(s.id, msgs);
    }
    lsSaveSessionAgents(s.id, s.agents || []);
  }

  // 清理孤儿（N1-2 守卫：空 keep 不清除——beforeunload 同步路径同样
  // 对齐 Rust guard_cleanup_keep 语义，boot 窗口不得清空 LS 镜像）
  if (keep.size > 0) {
    try {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k) keys.push(k);
      }
      for (const k of keys) {
        let id: string | null = null;
        if (k.startsWith(SESSION_BODY_PREFIX))
          id = k.slice(SESSION_BODY_PREFIX.length);
        else if (k.startsWith(SESSION_AGENTS_PREFIX))
          id = k.slice(SESSION_AGENTS_PREFIX.length);
        if (id != null && !keep.has(id)) localStorage.removeItem(k);
      }
    } catch {
      /* swallow-ok: 清理孤儿键失败时残留无害键，下次清理重试 */
    }
  }

  lsSaveActiveSessionId(activePersistable);
  lsSaveFolderOrder(folderOrder || []);
}
