/**
 * sessionRustDb 旧 localStorage 清理（从 sessionRustDbSql 拆出）
 *
 * 职责：孤儿会话清理 + 30 天 LS 清理安全护栏（P0-1 / N0-1）。
 * - cleanupOrphanSessions：清理不在 activeIds 中的会话（孤儿清理）
 * - cleanupLegacyLocalStorageSessionsGuarded：30 天 LS 清理前逐 key 校验 SQLite 存在性
 */

import {
  type RustSessionIndexEntry,
  type RustSessionMessage,
  type RustSessionAgent,
} from './sessionRustDbWire';
import {
  hasNonEmptyLegacySessionAgents,
  hasNonEmptyLegacySessionBody,
} from './sessionRustDbFallback';
import {
  SESSION_ACTIVE_KEY,
  SESSION_AGENTS_PREFIX,
  SESSION_BODY_PREFIX,
  SESSION_INDEX_KEY,
  SESSION_FOLDER_KEY,
} from './sessionPersistenceTypes';
import { invokeResult } from '../tauriInvoke';
import { parseSessionIndexList, safeParseJson } from './sessionHydration';
import { toast } from '../../services/toast';

/**
 * RUN-07：孤儿清理产出回收结果事件（Rust session-outputs-cleanup 载荷，
 * camelCase 对齐 SessionOutputsCleanupEvent）。
 */
interface SessionOutputsCleanupEventPayload {
  sessionId: string;
  cleaned: boolean;
  skippedOutside: boolean;
  trashRoot: string;
  notice: string;
}

/** 事件名（与 session_commands.rs emit 侧一致） */
const SESSION_OUTPUTS_CLEANUP_EVENT = 'session-outputs-cleanup';

let cleanupToastListenerBound = false;

/**
 * RUN-07：订阅 Rust 侧产出目录清理结果事件 → 可见 toast。
 *
 * 通知由真实清理结果驱动（notice 文案来自 Rust 清理链，不硬编码成功）；
 * 非 Tauri 环境（纯浏览器 / 测试未 mock）静默降级不订阅。
 * 幂等：首次 cleanupOrphanSessions 调用时懒订阅，进程内仅一次。
 */
function ensureCleanupToastListener(): void {
  if (cleanupToastListenerBound) return;
  cleanupToastListenerBound = true;
  void (async () => {
    try {
      const mod = await import('@tauri-apps/api/event');
      if (typeof mod?.listen !== 'function') return;
      await mod.listen<{ payload?: SessionOutputsCleanupEventPayload[] }>(
        SESSION_OUTPUTS_CLEANUP_EVENT,
        (e) => {
          for (const r of e?.payload ?? []) {
            if (!r?.notice) continue;
            if (r.cleaned) toast.info(r.notice);
            else toast.warning(r.notice);
          }
        }
      );
    } catch {
      cleanupToastListenerBound = false;
      /* swallow-ok: 非 Tauri 环境 toast 事件桥不可用，静默降级 */
    }
  })();
}

/**
 * 清理不在 activeIds 中的会话（孤儿清理）。
 *
 * N1-2 守卫：空 keepIds 默认拒绝清理，与 Rust 侧 guard_cleanup_keep
 * 语义对齐（session_commands.rs:93-101 默认拒绝空 keepIds）。JS 回退分支
 * 此前无守卫——Rust 拒绝后错误码落入此分支，等于「守卫被绕过」，boot
 * 窗口一次 persist 即清空全部 LS 会话镜像；keep 为空时直接返回 0 不删。
 *
 * RUN-08：confirmEmpty 传真实意图（显式参数，对齐 Rust 命令的
 * confirm_empty: Option<bool>）——已水合 + 用户「删除全部会话」场景由
 * 调用方（persistAllSessionsRust）显式传 true，Rust 守卫放行后执行全库
 * 清空；boot 未水合空列表仍由调用方跳过，永不带 confirmEmpty。
 */
export async function cleanupOrphanSessions(
  activeIds: string[],
  confirmEmpty = false
): Promise<number> {
  if (!activeIds || activeIds.length === 0) {
    if (!confirmEmpty) return 0;
    // 显式清空：交由 Rust guard_cleanup_keep(active_ids, confirm_empty)
    // 放行；invoke 缺失（missing）时落 LS 回退分支，同样清空镜像键。
  }
  // RUN-07：懒订阅产出清理结果事件（删除数 > 0 时 Rust 会清理产出目录
  // 并推送 session-outputs-cleanup，toast 由真实结果驱动）
  ensureCleanupToastListener();
  const res = await invokeResult<number>('cleanup_orphan_sessions', {
    activeIds: activeIds || [],
    confirmEmpty,
  });
  if (res.status === 'ok') return res.data || 0;
  // localStorage 回退：扫描 body/agents key，删除不在 keep 集合中的
  // （keep 为空时仅 confirmEmpty=true 才会到达此处，清空全部镜像键）
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
    // D-F06 收尾：护栏用键非空判定，不再解析 LS 全文（无 lsLoad* 读面）
    const hasLsData =
      hasNonEmptyLegacySessionBody(id) || hasNonEmptyLegacySessionAgents(id);
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
    const bodyRisk = hasNonEmptyLegacySessionBody(id) && !sqliteBodyOk;
    const agentsRisk = hasNonEmptyLegacySessionAgents(id) && !sqliteAgentsOk;
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
