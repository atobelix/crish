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

import type { SessionState } from '../../store/layoutStore';
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
import { logger, toErrMeta } from '../../services/LoggerService';

/**
 * 判断是否为未水合的远程懒壳（未访问、未水合、无消息）。
 * 仅对此类真实未水合懒壳跳过 save_session_body，避免覆盖底层历史。
 * 当会话处于活跃状态、已从 SQLite/Engine 水合、或被显式清空时，必须正常下发持久化指令（即使为空数组）。
 */
export function isLazySessionShell(
  session: Pick<
    SessionState,
    'id' | 'messages' | 'messagesHydrated' | 'hydratedFromEngine'
  >,
  activeSessionId?: string | null
): boolean {
  if (session.messages && session.messages.length > 0) return false;
  if (session.messagesHydrated === false) return true;
  if (session.messagesHydrated === true) return false;
  if (session.hydratedFromEngine === true) return false;
  if (activeSessionId && session.id === activeSessionId) return false;
  return true;
}

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
 * 单调递增 Generation Token（AAI-03 / ACT-502）：会话切换 / 懒水合竞态防线。
 * 每次显式切换自增；过期异步响应对比 token 不一致即丢弃，严禁写主视口。
 */
let activeSwitchGeneration = 0;

/** 领取新一代切换 token（单调递增） */
export function bumpHydrateGeneration(): number {
  activeSwitchGeneration += 1;
  return activeSwitchGeneration;
}

/** 当前最新 token（测试钩子 / 调用方对账用） */
export function currentHydrateGeneration(): number {
  return activeSwitchGeneration;
}

/** token 是否仍是最新（true=可提交；false=过期响应必须丢弃） */
export function isHydrateGenerationCurrent(gen: number): boolean {
  return gen === activeSwitchGeneration;
}

/**
 * 会话切换 / 懒水合 JIT 拉取：仅加载指定会话的 body + agents。
 * 调用方负责 Generation Token 对账——本函数只做 IO，不碰 store。
 */
export async function ensureSessionBodyHydrated(sessionId: string): Promise<{
  messages: SessionState['messages'];
  agents: NonNullable<SessionState['agents']>;
}> {
  if (!sessionId || isPendingDraft(sessionId))
    return { messages: [], agents: [] };
  const [messages, agents] = await Promise.all([
    loadSessionBody(sessionId),
    loadSessionAgents(sessionId),
  ]);
  return {
    messages: sanitizeMessagesForHydrate(messages),
    agents: Array.isArray(agents) ? agents : [],
  };
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
export async function hydrateSessionsFromRust(): Promise<{
  sessions: SessionState[];
  activeSessionId: string | null;
  folderOrder: string[] | null;
}> {
  // 1. 索引：localStorage 优先（真相源），回退 SQLite
  let index = lsLoadSessionIndex();
  if (!index.length) index = await listSessions();
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

  // 2. 解析首屏活跃会话（meta ×1）
  const activeRaw = await getSessionMeta('active_session_id');
  const active = activeRaw && !isPendingDraft(activeRaw) ? activeRaw : null;
  const targetActiveId =
    active && ordered.some((e) => e.id === active)
      ? active
      : ordered[0]?.id || null;

  // 3. 仅活跃会话拉 body + agents（K=5 收口；历史懒壳零 IPC）
  let activeMessages: SessionState['messages'] = [];
  let activeAgents: NonNullable<SessionState['agents']> = [];
  if (targetActiveId) {
    try {
      const loaded = await ensureSessionBodyHydrated(targetActiveId);
      activeMessages = loaded.messages;
      activeAgents = loaded.agents;
    } catch (err) {
      logger.error('[hydrate] active session bundle load failed', {
        module: 'hydrate',
        sessionId: targetActiveId,
        err: toErrMeta(err),
      });
    }
  }

  // 4. 单遍内存装配：活跃全量 + 历史懒壳
  const sessions: SessionState[] = ordered.map((e) => {
    const isActive = e.id === targetActiveId;
    const safeTimestamp = coerceSessionTimestamp(
      e.id,
      e.timestamp,
      isActive ? activeMessages : []
    );
    return {
      id: e.id,
      title: e.title,
      folder: e.folder,
      isPinned: e.isPinned,
      isArchived: e.isArchived,
      timestamp: safeTimestamp,
      messages: isActive ? activeMessages : [],
      messagesHydrated: isActive,
      agents: isActive ? activeAgents : [],
      messageCount: e.messageCount,
      ...(e.branchParentId !== undefined
        ? { branchParentId: e.branchParentId }
        : {}),
      ...(e.pinnedMessageIds?.length
        ? { pinnedMessageIds: e.pinnedMessageIds }
        : {}),
      ...(e.engineCursor !== undefined ? { engineCursor: e.engineCursor } : {}),
      ...(e.engineLastRunId !== undefined
        ? { engineLastRunId: e.engineLastRunId }
        : {}),
      ...(isActive && e.hydratedFromEngine !== undefined
        ? { hydratedFromEngine: e.hydratedFromEngine }
        : {}),
      // importMeta / titleSource 仅存 localStorage 索引；SQLite 行无此列，从 LS 索引水合时带回
      ...(e.importMeta ? { importMeta: e.importMeta } : {}),
      ...(e.titleSource ? { titleSource: e.titleSource } : {}),
    };
  });

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

  // 6. 剪枝兼容（方案 A）：未水合但 messageCount>0 的懒壳并入 keepIds，
  //    防止 prepareSessionsForUi 将其当幽灵空壳误剪（侧栏丢会话）。
  const lazyKeepIds = sessions
    .filter((s) => s.messagesHydrated === false && (s.messageCount ?? 0) > 0)
    .map((s) => s.id);
  const prepared = prepareSessionsForUi(sessions, targetActiveId, {
    keepIds: [...lazyKeepIds, ...(targetActiveId ? [targetActiveId] : [])],
  });
  const activeSessionId =
    targetActiveId && prepared.some((s) => s.id === targetActiveId)
      ? targetActiveId
      : null;
  const folderOrder = parseFolderOrder(
    safeParseJson<unknown>(await getSessionMeta('folder_order'), null)
  );

  return { sessions: prepared, activeSessionId, folderOrder };
}

// ── 复合 API：persistAllSessionsRust ────────────────────────────────────────

/** 上次成功 saveSessionBody 的消息指纹（D3-4 dirty 检测） */
const lastSavedBodyFingerprint = new Map<string, string>();

function bodyFingerprint(msgs: SessionState['messages']): string {
  // 引用优先：同数组引用直接命中
  // 内容级：id + status + text 长度 + thinking 长度（避免全量 stringify）
  const parts: string[] = [String(msgs.length)];
  for (const m of msgs || []) {
    parts.push(
      m.id,
      m.status ?? '',
      String(m.text?.length ?? 0),
      String(m.thinking?.length ?? 0)
    );
  }
  return parts.join('|');
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
      // 双重硬守卫：消息为空且未明确完成水合（messagesHydrated !== true）时，严禁调用 saveSessionBody 向 SQLite 写入空数组 []
      const isUnconfirmedEmptyShell =
        msgs.length === 0 && s.messagesHydrated !== true;
      const shouldSaveBody =
        !isUnconfirmedEmptyShell &&
        (msgs.length > 0 || !isLazySessionShell(s, activePersistable));
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
    // Rust 壳层对空 keepIds 默认拒绝（guard_cleanup_keep），此处直接不发起，
    // 避免错误码触发 JS 回退分支清空 LS 镜像（N1-2 双保险）；
    // 部分 keepIds 的 boot 窗口风险由 Rust 库层护栏兜底（引擎子代理会话豁免
    // + 活动 run 豁免 + 宽限期，见 conex-db sessions.rs cleanup_orphan_sessions）。
    if (keepIds.size > 0) await cleanupOrphanSessions(Array.from(keepIds));

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
