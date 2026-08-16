/**
 * sessionRustDb 子模块 · Sql：SQLite invoke API 面 + 写竞态防线
 *
 * 职责：
 *   - 14 个 API 中 SQLite 路径的实现（invoke → Tauri → spawn_blocking → SQLite），
 *     命令缺失（浏览器 / 旧壳 / 测试环境）→ 回退到 localStorage 同步路径（Fallback 子模块）
 *   - PS-03 T3.2 D6 写竞态防线：模块级串行队列（writeChain）+ 批次版本戳 CAS
 *   - P0-1/N0-1 30 天 LS 清理安全护栏（cleanupLegacyLocalStorageSessionsGuarded）
 *   - P18（AA-07）子代理超软上限 meta 留痕（readAgentsOverCapMeta）
 */

import type { SessionAgent, SessionMessage } from '../../store/layoutStore';
import { isPendingDraftSessionId as isPendingDraft } from '@crish/shared-types';
import {
  fromRustSessionAgents,
  fromRustSessionIndexEntries,
  fromRustSessionMessages,
  toRustSessionAgent,
  toRustSessionMessage,
  type RustImportStats,
  type RustSessionAgent,
  type RustSessionIndexEntry,
  type RustSessionMessage,
} from './sessionRustDbWire';
import {
  lsLoadActiveSessionId,
  lsLoadFolderOrder,
  lsLoadSessionAgents,
  lsLoadSessionBody,
  lsLoadSessionIndex,
  lsSaveActiveSessionId,
  lsSaveFolderOrder,
  lsSaveSessionAgents,
} from './sessionRustDbFallback';
import {
  SESSION_ACTIVE_KEY,
  SESSION_AGENTS_OVER_CAP_META_PREFIX,
  SESSION_AGENTS_PREFIX,
  SESSION_AGENTS_SAVE_CAP,
  SESSION_BODY_PREFIX,
  SESSION_FOLDER_KEY,
  SESSION_INDEX_KEY,
  type AgentsTruncationRecord,
  type SessionIndexEntry,
} from './sessionPersistenceTypes';
import { invokeResult } from '../tauriInvoke';
import { logInternalError } from '../userFacingErrors';
import { hasQuotaTruncation } from './sessionQuota';
import { readAgentsTruncation } from './sessionAgentsTruncation';
import {
  hydrateSessionAgents,
  parseFolderOrder,
  parseSessionIndexList,
  safeParseJson,
} from './sessionHydration';

// ── 写竞态防线（PS-03 T3.2 D6）：模块级串行队列 + 批次版本戳 CAS ────────────

/**
 * 模块级写串行队列（主防线）。
 *
 * 问题背景（R2 §5 / F5-02）：persist 批次间无队列、无版本戳；store 层 350ms
 * debounce（store-persistence.ts:136-145）只保证「调度串行」，不保证「IPC
 * 飞行期互斥」——store 高频变更时两个 persist 周期可并发飞行，旧批次晚完成
 * 整体覆盖新批次（sessionRustDbWriteModel.test.ts 曾把回滚固化为契约，
 * T3.2 已翻转）。本队列把每个 persist 批次整体串入 promise 链：
 *
 * - 新批次执行前先 await 上一轮 promise → 同一时刻至多一个批次在飞行期，
 *   同会话写任务严格按发起顺序落库（后发批次最后写，最终 = 最新快照）；
 * - 单轮失败吞掉，不影响链上后续批次（对齐 persistAllSessionsRust 既有
 *   「内部 allSettled、不对外抛错」语义）；
 * - 队列语义 = 每会话保留最新快照：过期批次被后续批次覆盖，不产生回滚。
 */
let writeChain: Promise<void> = Promise.resolve();

/**
 * 批次版本计数器（CAS 防线 2）。
 *
 * 裁决 R9：CAS 哨兵用单调递增版本号（替代任务书原方案的 batchAt 时间戳——
 * ms 粒度在快速连续 commit 下可能相同，无法区分新旧）。每个 persist 调用
 * 在发起时领取递增版本号（发起序 = 版本序，后发起 = 高版本），版本随
 * save_session_body 调用路径传递到 IPC 边界，供 Rust 侧未来 updated_at
 * CAS 消费（任务书 T3.2 ③；Rust 命令面改动不在本实现轮范围）。
 */
let batchVersionCounter = 0;

/**
 * 各会话已落库正文的最高批次版本（CAS 比较基准）。
 * 串行队列下单上下文内写序已确定，本表是第二道防线：任何路径下旧版本
 * 批次在落库前被识别并直接丢弃（不覆盖已落库的新版本）。
 */
const writtenBodyBatchVersions = new Map<string, number>();

/**
 * 把持久化任务串入模块级写队列。
 * 返回任务自身 promise（调用方可 await 感知完成）；链尾由 writeChain 承接，
 * 单轮失败由 catch 吞掉，保证链永不因单轮异常而断裂。
 */
export function enqueuePersist(task: () => Promise<void>): Promise<void> {
  const run = writeChain
    .then(() => task())
    .catch(() => {
      /* 单轮失败吞掉：不影响链上后续批次 */
    });
  writeChain = run;
  return run;
}

/** 领取下一批次版本号（发起序 = 版本序，R9 CAS 防线 2）。 */
export function nextBatchVersion(): number {
  return ++batchVersionCounter;
}

/** 读取某会话已落库正文的最高批次版本（无记录返回 -1）。 */
export function writtenBodyVersion(sessionId: string): number {
  return writtenBodyBatchVersions.get(sessionId) ?? -1;
}

/** 记录某会话已落库正文的批次版本（CAS 比较基准更新）。 */
export function recordWrittenBodyVersion(
  sessionId: string,
  version: number
): void {
  writtenBodyBatchVersions.set(sessionId, version);
}

/**
 * P1-D2（T3.6）persist 熔断判定：引擎懒水合「未完整」的会话禁止回写正文。
 *
 * 根因（R2 §6）：hydrate 单页截断 → hydratedFromEngine=true 封死重试 → 350ms
 * debounce → save_session_body 先删后插 → 截断正文不可逆覆盖 SQLite。
 * 修复后 hydrate 已分页拉全；但引擎异常（超页数上限/游标停滞）仍可能产生
 * 截断态，store 以 hydrateTruncated 标记刻画，此处为兜底防线：任何 persist
 * 周期（主路径 / LS 降级镜像 / beforeunload 同步）对未完整会话一律跳过
 * 正文回写——截断态永不固化；分页拉全后标记清除，熔断自然解除。
 */
export function isHydrateTruncated(s: {
  hydratedFromEngine?: boolean;
  hydrateTruncated?: boolean;
}): boolean {
  return s.hydratedFromEngine === true && s.hydrateTruncated === true;
}

// ── 14 个 async API（invoke + localStorage 回退） ──────────────────────────

/**
 * 加载会话索引列表。
 * 命令缺失 → 回退 localStorage。
 */
export async function listSessions(): Promise<SessionIndexEntry[]> {
  const res = await invokeResult<RustSessionIndexEntry[]>('list_sessions');
  if (res.status === 'ok') return fromRustSessionIndexEntries(res.data || []);
  return lsLoadSessionIndex();
}

/**
 * 加载会话正文消息。
 * 命令缺失 → 回退 localStorage。
 */
export async function loadSessionBody(
  sessionId: string
): Promise<SessionMessage[]> {
  if (!sessionId?.trim() || isPendingDraft(sessionId)) return [];
  const res = await invokeResult<RustSessionMessage[]>('load_session_body', {
    sessionId,
  });
  // P1-F3（F5-03）：LS quota 截断标志 → 数据面日志提示（提示 UI 最小化，仅日志；
  // 数据面暴露走 sessionQuota.hasQuotaTruncation）。标志存在意味着某次
  // LS 写入因 quota 超限被截断为最后 100 条，旧消息静默丢失——必须留痕。
  if (hasQuotaTruncation(sessionId)) {
    logInternalError('ls-quota-truncated', { sessionId });
  }
  if (res.status === 'ok') return fromRustSessionMessages(res.data || []);
  return lsLoadSessionBody(sessionId);
}

/**
 * 全量保存会话正文（先删后插，事务原子）。
 * T2-1 剥镜像：SQLite 为唯一落点，命令缺失/错误不改写 LS、不打降级戳，
 * 失败经 errorStore 数据面带呈现（persist-degraded-ls，非静默回退）。
 * I-DRAFT：PENDING_DRAFT 哨兵永不写 body。
 *
 * @param batchVersion 批次版本戳（CAS 防线 2，裁决 R9 单调递增版本号）。
 * 落库前检查该会话已落库的最高版本，陈旧批次（版本 ≤ 已落库版本）直接
 * 丢弃不覆盖；版本随 IPC 参数传递，Rust 侧可据此实现 updated_at CAS
 * （任务书 T3.2 ③，Rust 命令面改动不在本实现轮范围）。
 */
export async function saveSessionBody(
  sessionId: string,
  messages: SessionMessage[],
  batchVersion: number
): Promise<void> {
  if (!sessionId?.trim() || isPendingDraft(sessionId)) return;
  const msgs = messages || [];
  const rustMessages = msgs.map(toRustSessionMessage);

  // CAS：该会话已有更高版本批次落库 → 本批次为陈旧批次，直接丢弃不覆盖
  //（任何并发窗口下旧批次晚到都不得回滚新批次）。
  const written = writtenBodyVersion(sessionId);
  if (batchVersion <= written) {
    console.warn(
      `[sessionPersistence] 丢弃陈旧写批次 v${batchVersion}（会话 ${sessionId} 已落库 v${written}）`
    );
    return;
  }

  const res = await invokeResult<void>('save_session_body', {
    sessionId,
    messages: rustMessages,
    batchVersion,
  });
  if (res.status === 'ok') {
    recordWrittenBodyVersion(sessionId, batchVersion);
    // T2-1 剥镜像：SQLite 落库成功 = 唯一落点，不再镜像到 LS，
    // 也不再清除降级戳（无镜像即无降级戳语义）。
    return;
  }
  // T2-1 剥镜像：缺/错命令不再回退写 LS 正文、不再打降级戳。失败改走 errorStore 数据面带
  //（I1/T5 衔接：persist-degraded-ls 经 logInternalError 推入 errorStore → 可感知降级，非静默）。
  logInternalError('persist-degraded-ls', {
    command: 'save_session_body',
    sessionId,
    batchVersion,
    status: res.status,
  });
}

/**
 * 加载会话下的协作子 agent。
 */
export async function loadSessionAgents(
  sessionId: string
): Promise<SessionAgent[]> {
  if (!sessionId?.trim() || isPendingDraft(sessionId)) return [];
  // P18（AA-07）：LS 镜像截断标志 → 数据面日志留痕（与 P1-F3 quota 截断同款
  // 暴露口径）。标志存在意味着某次 LS 镜像写入被配额保护线截断（saved < total），
  // 回退 LS 展示时数据不完整；SQLite 主路径为全量保存，不属于永久丢失。
  const trunc = readAgentsTruncation(sessionId);
  if (trunc) {
    logInternalError('ls-agents-truncated', {
      sessionId,
      cap: trunc.cap,
      total: trunc.total,
      saved: trunc.saved,
    });
  }
  const res = await invokeResult<RustSessionAgent[]>('load_session_agents', {
    sessionId,
  });
  if (res.status === 'ok')
    return hydrateSessionAgents(fromRustSessionAgents(res.data || []));
  return lsLoadSessionAgents(sessionId);
}

/**
 * 保存会话下的协作子 agent。
 * I-DRAFT：PENDING_DRAFT 哨兵永不写 agents。
 *
 * P18（AA-07）语义变更：SQLite 主路径全量保存，不再 slice——
 * Rust 侧 save_session_agents 无数量上限，第 41 个起的子代理及其消息不再
 * 静默丢失；SESSION_AGENTS_SAVE_CAP 退化为「软提示」阈值，超过时写
 * session_meta 留痕（agents_over_cap:<id>），供数据面提示。
 */
export async function saveSessionAgents(
  sessionId: string,
  agents: SessionAgent[]
): Promise<void> {
  if (!sessionId?.trim() || isPendingDraft(sessionId)) return;
  if (!agents || agents.length === 0) {
    // 空列表仍调 invoke 让 Rust 侧清空；missing 时回退到 localStorage
    const res = await invokeResult<void>('save_session_agents', {
      sessionId,
      agents: [],
    });
    if (res.status === 'ok') return;
    logInternalError('persist-degraded-ls', {
      command: 'save_session_agents',
      sessionId,
      status: res.status,
    });
    lsSaveSessionAgents(sessionId, []);
    return;
  }
  const rustAgents = agents.map(toRustSessionAgent);
  const res = await invokeResult<void>('save_session_agents', {
    sessionId,
    agents: rustAgents,
  });
  if (res.status === 'ok') {
    // 超过软上限 → session_meta 记录「子代理过多」事实（全量落盘，saved=total）。
    // 记录用 upsert 覆盖保持最新，不做删除（留痕供审计与数据面提示）。
    if (agents.length > SESSION_AGENTS_SAVE_CAP) {
      await recordAgentsOverCap(sessionId, agents.length);
    }
    return;
  }
  // P1-F1：降级可观测（agents 降级不涉及正文分叉，无需打降级戳）
  logInternalError('persist-degraded-ls', {
    command: 'save_session_agents',
    sessionId,
    status: res.status,
  });
  lsSaveSessionAgents(sessionId, agents);
}

/**
 * 写「子代理超过软上限」session_meta 留痕（P18）。
 * record 携带 cap/total/saved/at 事实；invoke 失败时静默（meta 为提示性记录，
 * 不阻塞保存主流程，日志由 setSessionMeta 降级路径兜底）。
 */
async function recordAgentsOverCap(
  sessionId: string,
  total: number
): Promise<void> {
  const record: AgentsTruncationRecord = {
    cap: SESSION_AGENTS_SAVE_CAP,
    total,
    // SQLite 主路径全量落盘：saved = total（无丢失，仅超软提示阈值）
    saved: total,
    at: Date.now(),
  };
  await setSessionMeta(
    SESSION_AGENTS_OVER_CAP_META_PREFIX + sessionId,
    JSON.stringify(record)
  );
}

/**
 * 读取「子代理超过软上限」meta 留痕（P18 数据面暴露）。
 * 返回 null = 从未超过软上限；UI 层据此展示「会话内子代理过多」提示。
 */
export async function readAgentsOverCapMeta(
  sessionId: string
): Promise<AgentsTruncationRecord | null> {
  if (!sessionId?.trim() || isPendingDraft(sessionId)) return null;
  const raw = await getSessionMeta(
    SESSION_AGENTS_OVER_CAP_META_PREFIX + sessionId
  );
  if (!raw) return null;
  return safeParseJson<AgentsTruncationRecord | null>(raw, null);
}

/**
 * 读取会话级元数据键。
 * 用于 schema_version / active_session_id / folder_order 等。
 */
export async function getSessionMeta(key: string): Promise<string | null> {
  if (!key?.trim()) return null;
  const res = await invokeResult<string | null>('get_session_meta', { key });
  if (res.status === 'ok') return res.data ?? null;
  // localStorage 回退：active / folder 有专用 key
  if (key === 'active_session_id') return lsLoadActiveSessionId();
  if (key === 'folder_order') {
    const order = lsLoadFolderOrder();
    return order ? JSON.stringify(order) : null;
  }
  if (key === 'schema_version') return null; // localStorage 时代无 schema_version
  return null;
}

/**
 * 写入会话级元数据键。
 */
export async function setSessionMeta(
  key: string,
  value: string
): Promise<void> {
  if (!key?.trim()) return;
  const res = await invokeResult<void>('set_session_meta', { key, value });
  if (res.status === 'ok') return;
  // localStorage 回退。P1-F1：降级可观测（meta 无正文分叉语义，不打降级戳）
  logInternalError('persist-degraded-meta', {
    command: 'set_session_meta',
    key,
    status: res.status,
  });
  if (key === 'active_session_id') lsSaveActiveSessionId(value);
  if (key === 'folder_order') {
    const order = parseFolderOrder(safeParseJson<unknown>(value, null));
    if (order) lsSaveFolderOrder(order);
  }
}

/**
 * 清理不在 activeIds 中的会话（孤儿清理）。
 *
 * N1-2 守卫：空 keepIds 一律拒绝清理，与 Rust 侧 guard_cleanup_keep
 * 语义对齐（session_commands.rs:94-101 默认拒绝空 keepIds）。JS 回退分支
 * 此前无守卫——Rust 拒绝后错误码落入此分支，等于「守卫被绕过」，boot
 * 窗口一次 persist 即清空全部 LS 会话镜像；keep 为空时直接返回 0 不删。
 */
export async function cleanupOrphanSessions(
  activeIds: string[]
): Promise<number> {
  if (!activeIds || activeIds.length === 0) return 0;
  const res = await invokeResult<number>('cleanup_orphan_sessions', {
    activeIds: activeIds || [],
  });
  if (res.status === 'ok') return res.data || 0;
  // localStorage 回退：扫描 body/agents key，删除不在 keep 集合中的
  // （keep 非空已由上方守卫保证——空 keep 不清除任何数据）
  try {
    const keep = new Set(activeIds || []);
    let deleted = 0;
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) keys.push(k);
    }
    for (const k of keys) {
      let id: string | null = null;
      if (k.startsWith(SESSION_BODY_PREFIX)) {
        id = k.slice(SESSION_BODY_PREFIX.length);
      } else if (k.startsWith(SESSION_AGENTS_PREFIX)) {
        id = k.slice(SESSION_AGENTS_PREFIX.length);
      }
      if (id != null && !keep.has(id)) {
        localStorage.removeItem(k);
        deleted++;
      }
    }
    return deleted;
  } catch {
    return 0;
  }
}

/**
 * P0-1（N0-1）修复：30 天 LS 清理前逐 key 校验 SQLite 存在性。
 *
 * 背景：sessions.db 打开失败会降级为内存库（main.rs 降级路径），降级期间
 * 全部写入落在内存库 + LS 镜像；磁盘恢复后若 30 天到期直接清空 LS，
 * 降级期数据（磁盘 SQLite 无对应）即永久丢失。本函数保证：
 *   - SQLite 持有该会话且正文/子代理非空 → 对应 LS key 可删（镜像已冗余）；
 *   - SQLite 无该会话，或 SQLite 正文/子代理为空而 LS 非空 → 保留
 *     （LS 为唯一副本，保留后可经 hydrate 回迁 SQLite）；
 *   - SQLite invoke 不可用（missing/error）→ 无法校验，一律保留（不删）。
 * 全部会话确认后才删除索引/active/folder 元数据 key；有保留则整体保留
 * （索引需继续承载保留会话供 hydrate 读取）。
 */
export interface LegacyCleanupGuardResult {
  /** 本次实际删除的 localStorage key */
  removed: string[];
  /** 因 SQLite 无对应数据而保留的会话 id */
  preserved: string[];
  /** 保留原因：sqlite-unavailable（invoke 不可用，无法校验）/ confirmed（已校验） */
  reason: 'sqlite-unavailable' | 'confirmed';
}

/** 收集 LS 侧会话 id（body / agents key + 索引条目三重来源） */
function collectLegacySessionIds(): Set<string> {
  const ids = new Set<string>();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (k.startsWith(SESSION_BODY_PREFIX)) {
        ids.add(k.slice(SESSION_BODY_PREFIX.length));
      } else if (k.startsWith(SESSION_AGENTS_PREFIX)) {
        ids.add(k.slice(SESSION_AGENTS_PREFIX.length));
      }
    }
    const raw = localStorage.getItem(SESSION_INDEX_KEY);
    if (raw) {
      const entries = parseSessionIndexList(safeParseJson<unknown>(raw, null));
      for (const e of entries) if (e?.id) ids.add(e.id);
    }
  } catch {
    /* swallow-ok: localStorage 不可用时回退空集合 */
  }
  return ids;
}

/** 删除一组 LS key（尽力而为；key 缺失时 removeItem 为 no-op） */
function removeLegacyKeys(keys: string[], removed: string[]): void {
  for (const k of keys) {
    try {
      localStorage.removeItem(k);
      removed.push(k);
    } catch {
      /* swallow-ok: quota/隐私模式单键删除失败跳过，尽力清理 */
    }
  }
}

/**
 * 30 天 LS 清理的安全护栏（P0-1 / N0-1 修复入口）。
 * 由 migrateFromLocalStorage.runMigrationCleanupIfNeeded 在 boot 阶段调用；
 * 返回删除/保留明细，调用方仅在 `preserved` 为空时置位清理完成标记。
 */
export async function cleanupLegacyLocalStorageSessionsGuarded(): Promise<LegacyCleanupGuardResult> {
  const removed: string[] = [];
  const preserved: string[] = [];

  // 1. 收集 LS 侧会话 id；无会话数据时仅清理元数据 key
  // （active/folder/index 已冗余于 SQLite session_meta，删除无风险）
  const lsIds = collectLegacySessionIds();
  if (lsIds.size === 0) {
    removeLegacyKeys(
      [SESSION_INDEX_KEY, SESSION_ACTIVE_KEY, SESSION_FOLDER_KEY],
      removed
    );
    return { removed, preserved, reason: 'confirmed' };
  }

  // 2. SQLite 可用性校验：invoke 不可用（missing/error）→ 无法校验，全保留
  const listRes = await invokeResult<RustSessionIndexEntry[]>('list_sessions');
  if (listRes.status !== 'ok') {
    return { removed, preserved: [...lsIds], reason: 'sqlite-unavailable' };
  }
  const sqliteIds = new Set((listRes.data || []).map((e) => e.id));

  // 3. 逐会话校验：LS 有数据且 SQLite 无对应（缺会话 / 正文空）→ 保留
  for (const id of lsIds) {
    const lsBody = lsLoadSessionBody(id);
    const lsAgents = lsLoadSessionAgents(id);
    const hasLsData = lsBody.length > 0 || lsAgents.length > 0;
    if (!hasLsData) {
      // LS 镜像为空：删除无风险（key 缺失时 removeItem 为 no-op）
      removeLegacyKeys(
        [SESSION_BODY_PREFIX + id, SESSION_AGENTS_PREFIX + id],
        removed
      );
      continue;
    }
    if (!sqliteIds.has(id)) {
      // 降级窗口期唯一副本：SQLite 无该会话 → 保留，待 hydrate 回迁
      preserved.push(id);
      continue;
    }
    const [bodyRes, agentsRes] = await Promise.all([
      invokeResult<RustSessionMessage[]>('load_session_body', {
        sessionId: id,
      }),
      invokeResult<RustSessionAgent[]>('load_session_agents', {
        sessionId: id,
      }),
    ]);
    // invoke 异常按「未校验」处理 → 保留（无法确认则不删）
    const sqliteBodyOk =
      bodyRes.status === 'ok' && (bodyRes.data || []).length > 0;
    const sqliteAgentsOk =
      agentsRes.status === 'ok' && (agentsRes.data || []).length > 0;
    const bodyRisk = lsBody.length > 0 && !sqliteBodyOk;
    const agentsRisk = lsAgents.length > 0 && !sqliteAgentsOk;
    if (bodyRisk || agentsRisk) {
      preserved.push(id);
      continue;
    }
    // 4. SQLite 确认持有数据 → 删除该会话的 LS 镜像 key
    removeLegacyKeys(
      [SESSION_BODY_PREFIX + id, SESSION_AGENTS_PREFIX + id],
      removed
    );
  }

  // 5. 元数据 key：全部会话确认后才删；有保留则整体保留（索引承载保留会话）
  if (preserved.length === 0) {
    removeLegacyKeys(
      [SESSION_INDEX_KEY, SESSION_ACTIVE_KEY, SESSION_FOLDER_KEY],
      removed
    );
  }

  return { removed, preserved, reason: 'confirmed' };
}

export interface ImportFromLocalStorageData {
  indexJson: string;
  bodies: Record<string, string>;
  agents: Record<string, string>;
  activeSessionId?: string | null;
  folderOrder: string[];
}

/**
 * 从 localStorage 历史数据一次性迁移到 SQLite。
 * 返回迁移统计；命令缺失时返回 null（调用方应直接走 localStorage 路径）。
 */
export async function importFromLocalStorage(
  data: ImportFromLocalStorageData
): Promise<RustImportStats | null> {
  const res = await invokeResult<RustImportStats>('import_from_localstorage', {
    indexJson: data.indexJson,
    bodies: data.bodies,
    agents: data.agents,
    activeSessionId: data.activeSessionId ?? null,
    folderOrder: data.folderOrder || [],
  });
  if (res.status === 'ok') return res.data;
  return null;
}
