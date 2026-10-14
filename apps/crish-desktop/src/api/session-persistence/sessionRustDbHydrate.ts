/**
 * sessionRustDb 子模块 · Hydrate/Persist：复合 API 面
 *
 * 职责：
 *   - hydrateSessionsFromRust：boot 时索引 + 仅活跃会话 body/agents 懒水合
 *     （Stage 5b ACT-502：IPC 常数上界 K=5，历史会话保持轻量懒壳）
 *   - ensureSessionBodyHydrated：会话切换 JIT 懒水合（配合 Generation Token）
 *   - persistAllSessionsRust：全量持久化（per-session invoke，写队列 + 版本戳 CAS）
 *   - persistAllSessionsSyncViaLocalStorage：beforeunload 同步镜像（禁止 await）
 */

import type { SessionState } from '../../store/types';
import {
  SESSION_AGENTS_PREFIX,
  SESSION_BODY_PREFIX,
  type SessionIndexEntry,
} from './sessionPersistenceTypes';
import { isPendingDraftSessionId as isPendingDraft } from '@crish/shared-types';
import { type RustSessionIndexEntry } from './sessionRustDbWire';
import {
  cleanupDegradedMarkerKeys,
  lsLoadSessionIndex,
  lsSaveActiveSessionId,
  lsSaveFolderOrder,
  lsSaveSessionIndex,
} from './sessionRustDbFallback';
import {
  cleanupOrphanSessions,
  enqueuePersist,
  getSessionMeta,
  listSessions,
  nextBatchVersion,
  saveSessionAgents,
  saveSessionBody,
  setSessionMeta,
} from './sessionRustDbSql';
import { invokeResult } from '../tauriInvoke';
import { logInternalError } from '../userFacingErrors';
import { errorStore } from '../../services/ErrorStore';
import { parseFolderOrder, safeParseJson } from './sessionHydration';
import { normalizeAssistantTimeline } from '../toolPresentation';
import { logger } from '../../services/LoggerService';
import {
  sessionDeltaWriteBarrier,
  reconcileLateArrivalSnapshot,
  SessionDeltaWriteBarrier,
  DeltaWriteBarrier,
} from './sessionDeltaWriteBarrier';
import { omitExternallyDeletedSessions } from '../import/externalSessionTombstone';

export {
  reconcileLateArrivalSnapshot,
  sessionDeltaWriteBarrier,
  SessionDeltaWriteBarrier,
  DeltaWriteBarrier,
};

import {
  isLazySessionShell,
  bumpHydrateGeneration,
  currentHydrateGeneration,
  isHydrateGenerationCurrent,
} from './sessionHydrationTokens';

export {
  isLazySessionShell,
  bumpHydrateGeneration,
  currentHydrateGeneration,
  isHydrateGenerationCurrent,
};

import {
  assembleWindowedHydratedSessions,
  loadActiveWindowedBundle,
  prepareWindowedSessionsForUi,
  shouldBlockWindowedSessionBodySave,
} from './sessionWindowedPagination';

export * from './sessionWindowedPagination';

// ── 复合 API：hydrateSessionsFromRust ──────────────────────────────────────

/**
 * 只读检查某会话是否残留降级戳标记（crish_degraded_<id>）。
 * 降级戳写面已在维度 1（T2-1）删除，但用户环境中可能仍有历史残留键。
 * hydrate 路径不做清理（清理在 persist 路径的 cleanupDegradedMarkerKeys 中），
 * 仅用于一致性校验时区分「降级期空 body（设计内）」与「索引-body 不一致（异常）」。
 */
function hasDegradedMarker(sessionId: string): boolean {
  try {
    return localStorage.getItem('crish_degraded_' + sessionId) !== null;
  } catch {
    return false;
  }
}

/**
 * 从存储层加载会话索引 + 仅活跃会话 body/agents，历史会话保持轻量懒壳
 * （Stage 5b ACT-502：IPC 常数上界 K=5，消除 O(N) 正文拉取风暴）。
 *
 * 索引加载策略（Stream D 过渡期）：
 *   1. 优先读 localStorage 索引（侧栏元数据真相源，由 persistAllSessionsRust 维护）
 *   2. localStorage 为空时回退到 SQLite list_sessions（30 天清理后或新装机场景）
 *   3. 两者都为空 → 返回空会话列表
 *
 * body / agents 加载策略（ACT-502）：
 *   - 仅对 targetActiveId 发起 1 次 body + 1 次 agents（活跃会话全量水合）
 *   - 其余历史会话 → 轻量懒壳（messages: [], messagesHydrated: false）
 *   - 正常路径 IPC 常数上界 K = 5：list + meta(active) + body + agents + meta(folder)
 *   - invoke 缺失时 loadSessionAgents 与 loadSessionBody 同构（D-F06 正文 +
 *     偏离 #2 收尾 agents）：均不再回退 LS——失败经 errorStore 留痕并返回空，
 *     降级仅内存留痕
 *
 * 空壳剪枝兼容（防侧栏丢会话）：「默认标题 + messageCount>0 的未水合懒壳」
 * 会被 prepareSessionsForUi 误剪——将此类懒壳 ID 并入 keepIds（方案 A）。
 *
 * 时间戳：一律经 coerceSessionTimestamp 归一为合法 ISO 串（CON-02）。
 */
/** 已删除的外部对话不随索引或迟到快照复活。 */
function withoutDeletedExternalSessions(
  sessions: SessionState[],
  activeSessionId: string | null
): { sessions: SessionState[]; activeSessionId: string | null } {
  const next = omitExternallyDeletedSessions(sessions);
  if (next.length === sessions.length) {
    return { sessions, activeSessionId };
  }
  const activeStillPresent =
    activeSessionId != null &&
    next.some((session) => session.id === activeSessionId);
  return {
    sessions: next,
    activeSessionId: activeStillPresent
      ? activeSessionId
      : (next[0]?.id ?? null),
  };
}

export async function hydrateSessionsFromRust(
  optionsOrLive?:
    | {
        liveSessions?: SessionState[];
      }
    | SessionState[]
): Promise<{
  sessions: SessionState[];
  activeSessionId: string | null;
  folderOrder: string[] | null;
}> {
  const liveSessions = Array.isArray(optionsOrLive)
    ? optionsOrLive
    : (optionsOrLive?.liveSessions ??
      sessionDeltaWriteBarrier.getLiveSessions());

  // 1. 索引：localStorage 优先（真相源），回退 SQLite
  let index = lsLoadSessionIndex();
  if (!index.length) index = await listSessions();
  if (!index.length) {
    const emptyActiveId = await getSessionMeta('active_session_id');
    const emptyFolderOrder = parseFolderOrder(
      safeParseJson<unknown>(await getSessionMeta('folder_order'), null)
    );
    sessionDeltaWriteBarrier.setHydrated(true);
    sessionDeltaWriteBarrier.setFallbackMode(false);
    if (liveSessions && liveSessions.length > 0) {
      const rec = reconcileLateArrivalSnapshot(
        {
          sessions: [],
          activeSessionId: emptyActiveId,
          folderOrder: emptyFolderOrder,
        },
        liveSessions
      );
      const dropped = withoutDeletedExternalSessions(
        rec.sessions,
        rec.activeSessionId
      );
      return {
        sessions: dropped.sessions,
        activeSessionId: dropped.activeSessionId,
        folderOrder: rec.folderOrder,
      };
    }
    return {
      sessions: [],
      activeSessionId: emptyActiveId,
      folderOrder: emptyFolderOrder,
    };
  }

  // I-DRAFT：索引层再滤哨兵；parseSessionIndexEntry 已拒，双保险
  const ordered = [...index]
    .filter((e) => e.id && !isPendingDraft(e.id))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  // 2. 解析首屏活跃会话（meta ×1）
  const activeRaw = await getSessionMeta('active_session_id');
  const active = activeRaw && !isPendingDraft(activeRaw) ? activeRaw : null;
  const targetActiveId =
    active && ordered.some((e) => e.id === active)
      ? active
      : ordered[0]?.id || null;

  // 3. 仅活跃会话拉 body + agents（K=5 收口；历史懒壳零 IPC）
  const activeBundle = await loadActiveWindowedBundle(targetActiveId);

  // 4. 单遍内存装配：活跃窗口化 + 历史懒壳
  const sessions = assembleWindowedHydratedSessions(
    ordered,
    targetActiveId,
    activeBundle
  );

  // 5. 维度 2 一致性校验：仅对已水合（非懒壳）会话做 index-body 分叉校验
  for (const s of sessions) {
    if (s.messagesHydrated !== true) continue;
    if (s.messages.length === 0 && !hasDegradedMarker(s.id)) {
      logInternalError('hydrate-degraded-index-body-mismatch', {
        sessionId: s.id,
        title: s.title,
        scope: 'hydrate-degraded-index-body-mismatch',
        severity: 'info',
      });
    }
  }

  // 6. 剪枝兼容（方案 A）：未水合但 messageCount>0 的懒壳并入 keepIds
  const prepared = prepareWindowedSessionsForUi(sessions, targetActiveId);
  let activeSessionId =
    targetActiveId && prepared.some((s) => s.id === targetActiveId)
      ? targetActiveId
      : null;
  let folderOrder = parseFolderOrder(
    safeParseJson<unknown>(await getSessionMeta('folder_order'), null)
  );

  let finalSessions = prepared;
  // 接入写屏障与无损合并：若存在现场活跃会话（例如在水合延迟/降级期间用户已新建或交互），
  // 调用 reconcileLateArrivalSnapshot 进行集合论无损合并，杜绝冲刷丢失 (VULN-06)
  if (liveSessions && liveSessions.length > 0) {
    const rec = reconcileLateArrivalSnapshot(
      { sessions: prepared, activeSessionId, folderOrder },
      liveSessions
    );
    finalSessions = rec.sessions;
    if (rec.activeSessionId) activeSessionId = rec.activeSessionId;
    if (rec.folderOrder?.length) folderOrder = rec.folderOrder;
  }

  const dropped = withoutDeletedExternalSessions(
    finalSessions,
    activeSessionId
  );
  finalSessions = dropped.sessions;
  activeSessionId = dropped.activeSessionId;

  // 水合已完成，解除写屏障降级状态
  sessionDeltaWriteBarrier.setHydrated(true);
  sessionDeltaWriteBarrier.setFallbackMode(false);

  return { sessions: finalSessions, activeSessionId, folderOrder };
}

// ── 复合 API：persistAllSessionsRust ────────────────────────────────────────

/** 上次成功 saveSessionBody 的消息指纹（D3-4 dirty 检测） */
const lastSavedBodyFingerprint = new Map<string, string>();

function bodyFingerprint(msgs: SessionState['messages']): string {
  if (!msgs?.length) return '0';
  return `${msgs.length}|${msgs.map((m) => `${m.id}:${m.status || ''}:${m.text?.length || 0}:${m.thinking?.length || 0}`).join('|')}`;
}

/** 非 dirty 则跳过 save；首帧无快照视为 dirty。 */
function isSessionBodyDirty(
  sessionId: string,
  msgs: SessionState['messages']
): boolean {
  return lastSavedBodyFingerprint.get(sessionId) !== bodyFingerprint(msgs);
}

function markSessionBodySaved(
  sessionId: string,
  msgs: SessionState['messages']
): void {
  lastSavedBodyFingerprint.set(sessionId, bodyFingerprint(msgs));
}

/** 测试专用：清空 dirty 快照，避免跨用例串扰。 */
export function __resetSessionBodyDirtyForTests(): void {
  lastSavedBodyFingerprint.clear();
}

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
 *   - D3-4：非 dirty body 不重发（isSessionBodyDirty）。
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

    // 写屏障保护：在初始空数据状态或降级期间，拦截对全盘持久化的盲目冲刷 (VULN-06)
    if (sessionDeltaWriteBarrier.shouldBlockWrite('full_session_index', list)) {
      logger.warn(
        `[persistAllSessionsRust] Blocked empty full flush (${list.length}) by DeltaWriteBarrier`,
        {
          module: 'persist',
        }
      );
      return;
    }

    // 索引层：始终写一份到 localStorage（侧栏元数据真相源，过渡期设计）。
    // invoke 缺失时，这就是唯一的索引落盘点。
    if (options?.sessionsToIndex) {
      try {
        lsSaveSessionIndex(options.sessionsToIndex(list));
      } catch {
        /* swallow-ok: 索引快照回调失败不阻断索引主流程 */
      }
    }

    // 检测 invoke 可用性（用 list_sessions 作为探针）
    const probe = await invokeResult<RustSessionIndexEntry[]>('list_sessions');
    if (probe.status !== 'ok') {
      // 回退：localStorage 同步路径（索引已写入，只需写 body/agents/meta）。
      // D2：降级戳写面已删，persist 前一次性清理历史残留的 crish_degraded_* 键。
      logInternalError('persist-degraded-ls', {
        command: 'list_sessions(probe)',
        status: probe.status,
      });
      // D-05 S1：批级降级状态推进（Fail-Open 是设计内行为，但必须可感知）
      errorStore.setPersistenceStatus('warning');
      cleanupDegradedMarkerKeys();
      persistAllSessionsLocalFallback(list, activePersistable, folderOrder);
      return;
    }

    // 1. 写入每个会话的 body + agents（并发）
    // 彻底修复 msgs.length === 0 跳过 saveSessionBody 导致的“清空后刷新僵尸复活”漏洞：
    // 仅对真实未水合的懒壳跳过；当会话处于活跃/已水合状态或用户显式清空时，
    // 必须调用 saveSessionBody(s.id, msgs, batchVersion) 清空 SQLite 底层存储。
    //
    // D3-4 / 票 B：非 dirty 会话不重发 body（引用比较 + 消息指纹）。
    // 首次（无 lastSavedSnapshot）视为 dirty，确保 boot 写全量。
    const keepIds = new Set<string>();
    const bodyJobs: Promise<void>[] = [];
    for (const s of list) {
      if (!s?.id) continue;
      keepIds.add(s.id);
      const msgs = (s.messages || []).map((m) =>
        m.sender === 'assistant' ? normalizeAssistantTimeline(m) : m
      );
      // 双重硬守卫：消息为空且未明确完成水合（messagesHydrated !== true）且非活跃/未从引擎补全时，严禁调用 saveSessionBody 向 SQLite 写入空数组 []
      const isUnconfirmedEmptyShell =
        msgs.length === 0 &&
        s.messagesHydrated !== true &&
        !s.hydratedFromEngine &&
        s.id !== activePersistable;
      const shouldSaveBody =
        !isUnconfirmedEmptyShell &&
        (msgs.length > 0 || !isLazySessionShell(s, activePersistable));

      // 资产保护硬守卫（W3-4）：局部窗口化会话拦截 saveSessionBody，防止未拉取的历史记录被抹杀
      if (shouldBlockWindowedSessionBodySave(s, msgs.length)) {
        bodyJobs.push(saveSessionAgents(s.id, s.agents || []));
        continue;
      }

      if (shouldSaveBody && isSessionBodyDirty(s.id, msgs)) {
        bodyJobs.push(
          saveSessionBody(s.id, msgs, batchVersion).then(() =>
            markSessionBodySaved(s.id, msgs)
          )
        );
      }
      bodyJobs.push(saveSessionAgents(s.id, s.agents || []));
    }
    await Promise.allSettled(bodyJobs);

    // 2. 元数据：active_session_id / folder_order
    const metaJobs: Promise<void>[] = [];
    if (activePersistable)
      metaJobs.push(setSessionMeta('active_session_id', activePersistable));
    if (folderOrder && folderOrder.length)
      metaJobs.push(
        setSessionMeta('folder_order', JSON.stringify(folderOrder))
      );
    await Promise.allSettled(metaJobs);

    // 3. 孤儿清理
    // P0-2 防护：空会话列表（boot 窗口 hydrate 未完成 / 全删场景）跳过清理——
    // 写屏障保护：在降级/未水合期间拦截清理，杜绝将磁盘历史全量抹杀
    if (keepIds.size > 0) {
      if (
        sessionDeltaWriteBarrier.shouldBlockWrite('orphan_cleanup', keepIds)
      ) {
        logger.warn(
          `[persistAllSessionsRust] Blocked orphan cleanup (${keepIds.size}) by DeltaWriteBarrier`,
          {
            module: 'persist',
          }
        );
      } else {
        await cleanupOrphanSessions(Array.from(keepIds));
      }
    }

    // D-05 S1：probe 成功且批收口 → 持久化降级状态回落健康（恢复点）
    errorStore.setPersistenceStatus('healthy');
  });
}

/**
 * localStorage 同步回退：仅在 invoke 不可用时使用。
 * 索引已由调用方（persistAllSessionsRust）写入 localStorage，此处仅写
 * meta。D-F06：正文写口已删；偏离 #2 收尾：agents 写口（lsSaveSessionAgents）
 * 亦已物理删除——降级时不再把 LS 当正文/agents 权威写口，两者均不落新数据
 * （仅内存 store + errorStore 留痕，persist-degraded-ls）；
 * 既有残存正文/agents 键的孤儿**删除**仍保留（删除语义：不在 keep 集合的会话
 * 其镜像键清除，与 N1-2 守卫对齐），但绝不向正文/agents 键写入/覆盖任何内容。
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

  // agents 写口已删（D-F06 偏离 #2）：SQLite save_session_agents 为唯一权威，
  // 降级仅 errorStore 留痕（由 saveSessionAgents 失败分支承担），此处不写 LS。

  // 孤儿清理（N1-2 守卫：空 keep 不清除——与 Rust guard_cleanup_keep
  // 语义对齐，boot 窗口 / 全删场景不得清空 LS 镜像）。D-F06 + 偏离 #2：仅剩删除
  // 语义（移除不在 keep 中的 body/agents 残键），不再有任何正文/agents 写入。
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
 * 同步 meta-only 持久化（beforeunload 场景，禁止 await）。
 *
 * U-PERSIST-A（D4 票 A）裁决：beforeunload 主动镜像**不再**写全量
 * messages（lsSaveSessionBody）——那是 LS 正文第二写口，与票 A「单轨
 * SQLite 正文出口」冲突。正文丢帧窗口由 350ms debounce + 异步
 * persistAllSessionsRust 承担（既有语义）。
 *
 * 本路径只写：
 *   - active_session_id / folder_order（session_meta 壳）
 *   - 可选索引壳（sessionsToIndex 投影，无 body）
 * 禁止触碰 SESSION_BODY_PREFIX / SESSION_AGENTS_PREFIX（A-3/A-4）。
 */
export function persistAllSessionsSyncViaLocalStorage(
  _sessions: SessionState[],
  activeSessionId: string,
  folderOrder: string[],
  options?: {
    sessionsToIndex?: (sessions: SessionState[]) => SessionIndexEntry[];
  }
): void {
  // I-DRAFT：sync flush 同样剔除 PENDING_DRAFT
  const list = (_sessions || []).filter(
    (s) => Boolean(s?.id) && !isPendingDraft(s.id)
  );
  const activePersistable =
    activeSessionId && !isPendingDraft(activeSessionId) ? activeSessionId : '';

  // D2：persist 前一次性清理历史残留的 crish_degraded_* 键（模块级 once 幂等）
  cleanupDegradedMarkerKeys();

  // 索引壳（仅元数据投影，不含 body）
  if (options?.sessionsToIndex) {
    try {
      lsSaveSessionIndex(options.sessionsToIndex(list));
    } catch {
      /* swallow-ok: 索引快照回调失败不阻断镜像主流程 */
    }
  }

  // meta-only：不再写 body / agents，也不再以 LS body 键做孤儿清理（A-3/A-4）
  lsSaveActiveSessionId(activePersistable);
  lsSaveFolderOrder(folderOrder || []);
}
