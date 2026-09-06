/**
 * sessionId → ptyId 注册表 + 终端 PTY 生命周期。
 *
 * 产品规则：
 * 1. 打开终端坞 / TerminalCard 挂载：ensure（已有则复用）— **唯一 spawn 入口**
 * 2. 折叠右坞 / 卸载 TerminalCard：保留 PTY（不 kill）— 策略 A
 * 3. 关闭会话 tab / 摘 unit：kill 该 session 的 PTY
 * 4. 多 unit 多 PTY：各 session 独立绑定，kill A 不影响 B
 * 5. App 退出：前端 killAllPtys（compositionRoot.pty.killAll / bootstrap pagehide）；
 *    权威路径为 Rust `RunEvent::Exit` → `kill_all_sessions`（PTY 不在 daemon Job Object 内）
 *
 * C2 的 ptySessionApi 落地后可 registerPtyHandlers 注入 spawn/kill；
 * 未注入时 ensure 返回已绑定 id 或 null，kill 仍会解绑并尝试 Tauri 回退。
 */

// ── 纯 map 操作（可单测、无副作用） ─────────────────────────────────

/** sessionId → ptyId；只读视图 */
export type PtyMap = ReadonlyMap<string, string>;

/** 规范化 sessionId；空串 → null */
export function normalizeSessionId(sessionId: string | null | undefined): string | null {
  const s = (sessionId ?? '').trim();
  return s ? s : null;
}

/** 规范化 ptyId；空串 → null */
export function normalizePtyId(ptyId: string | null | undefined): string | null {
  const s = (ptyId ?? '').trim();
  return s ? s : null;
}

/**
 * 绑定 session ↔ pty。返回新 Map（不改入参）。
 * 同 session 重绑覆盖；空 id 返回原 map。
 */
export function bindSessionPty(
  map: PtyMap,
  sessionId: string,
  ptyId: string,
): Map<string, string> {
  const sid = normalizeSessionId(sessionId);
  const pid = normalizePtyId(ptyId);
  if (!sid || !pid) return new Map(map);
  const next = new Map(map);
  next.set(sid, pid);
  return next;
}

/** 查绑定 */
export function getSessionPty(
  map: PtyMap,
  sessionId: string | null | undefined,
): string | undefined {
  const sid = normalizeSessionId(sessionId);
  if (!sid) return undefined;
  return map.get(sid);
}

/**
 * 解绑并取出 ptyId。返回 { map, ptyId }；无绑定则 map 同构拷贝、ptyId undefined。
 */
export function takeSessionPty(
  map: PtyMap,
  sessionId: string | null | undefined,
): { map: Map<string, string>; ptyId: string | undefined } {
  const sid = normalizeSessionId(sessionId);
  const next = new Map(map);
  if (!sid) return { map: next, ptyId: undefined };
  const ptyId = next.get(sid);
  if (ptyId !== undefined) next.delete(sid);
  return { map: next, ptyId };
}

export function hasSessionPty(
  map: PtyMap,
  sessionId: string | null | undefined,
): boolean {
  return getSessionPty(map, sessionId) !== undefined;
}

export function listBoundSessionIds(map: PtyMap): string[] {
  return [...map.keys()];
}

/** 按 ptyId 反查 session（O(n)；测试/调试用） */
export function findSessionByPtyId(
  map: PtyMap,
  ptyId: string | null | undefined,
): string | undefined {
  const pid = normalizePtyId(ptyId);
  if (!pid) return undefined;
  for (const [sid, id] of map) {
    if (id === pid) return sid;
  }
  return undefined;
}

// ── 可变单例注册表 ────────────────────────────────────────────────

export class PtyRegistry {
  private map = new Map<string, string>();

  /** 当前绑定数 */
  get size(): number {
    return this.map.size;
  }

  bind(sessionId: string, ptyId: string): void {
    this.map = bindSessionPty(this.map, sessionId, ptyId);
  }

  get(sessionId: string | null | undefined): string | undefined {
    return getSessionPty(this.map, sessionId);
  }

  has(sessionId: string | null | undefined): boolean {
    return hasSessionPty(this.map, sessionId);
  }

  /** 解绑并返回 ptyId；无绑定 → undefined */
  take(sessionId: string | null | undefined): string | undefined {
    const { map, ptyId } = takeSessionPty(this.map, sessionId);
    this.map = map;
    return ptyId;
  }

  /** 只解绑不 kill（测试 / 外部已 kill） */
  unbind(sessionId: string | null | undefined): string | undefined {
    return this.take(sessionId);
  }

  sessionIds(): string[] {
    return listBoundSessionIds(this.map);
  }

  /** 只读快照 */
  snapshot(): PtyMap {
    return new Map(this.map);
  }

  clear(): void {
    this.map = new Map();
  }
}

/** 全局单例：多 unit 共用一张 session→pty 表 */
export const ptyRegistry = new PtyRegistry();

// ── 可选后端注入（C2 ptySessionApi） ──────────────────────────────

export type PtySpawnFn = (sessionId: string, cwd?: string) => Promise<string | null>;
export type PtyKillFn = (ptyId: string, sessionId: string) => Promise<void> | void;

let spawnHandler: PtySpawnFn | null = null;
let killHandler: PtyKillFn | null = null;

/** C2 或测试注入 spawn/kill；传 null 清除 */
export function registerPtyHandlers(opts: {
  spawn?: PtySpawnFn | null;
  kill?: PtyKillFn | null;
}): void {
  if ('spawn' in opts) spawnHandler = opts.spawn ?? null;
  if ('kill' in opts) killHandler = opts.kill ?? null;
}

/** 测试用：读当前 handler */
export function getPtyHandlers(): {
  spawn: PtySpawnFn | null;
  kill: PtyKillFn | null;
} {
  return { spawn: spawnHandler, kill: killHandler };
}

/** 测试用：重置 registry + handlers */
export function resetPtyRegistryForTests(): void {
  ptyRegistry.clear();
  spawnHandler = null;
  killHandler = null;
}

// ── 生命周期 API ──────────────────────────────────────────────────

/**
 * 注册已创建的 PTY（spawn 成功后由 bridge / ensure 调用）。
 * 同 session 重绑前不会自动 kill 旧 id — 调用方负责。
 */
export function registerPtyBinding(sessionId: string, ptyId: string): void {
  const sid = normalizeSessionId(sessionId);
  const pid = normalizePtyId(ptyId);
  if (!sid || !pid) return;
  ptyRegistry.bind(sid, pid);
}

/**
 * 确保该 session 有 PTY：已绑定则复用；否则调 spawn handler。
 * 无 handler / spawn 失败 → null（C2 未就绪时安全 no-op）。
 */
export async function ensurePtyForSession(
  sessionId: string | null | undefined,
  cwd?: string,
): Promise<string | null> {
  const sid = normalizeSessionId(sessionId);
  if (!sid) return null;

  const existing = ptyRegistry.get(sid);
  if (existing) return existing;

  if (!spawnHandler) return null;

  try {
    const ptyId = await spawnHandler(sid, cwd);
    const pid = normalizePtyId(ptyId);
    if (!pid) return null;
    ptyRegistry.bind(sid, pid);
    return pid;
  } catch {
    return null;
  }
}

/**
 * 关闭 tab / 摘 unit：解绑并 kill 该 session 的 PTY。
 * 无绑定 → no-op。永不抛。
 * @returns 被 kill 的 ptyId（若有）
 */
export async function killPtyForSession(
  sessionId: string | null | undefined,
): Promise<string | undefined> {
  const sid = normalizeSessionId(sessionId);
  if (!sid) return undefined;

  const ptyId = ptyRegistry.take(sid);
  if (!ptyId) return undefined;

  try {
    if (killHandler) {
      await killHandler(ptyId, sid);
    } else {
      // C2 未注入时：尝试 Tauri 命令（未注册则 missing，忽略）
      const { invokeResult } = await import('./tauriInvoke');
      await invokeResult('workbench_pty_kill', { ptyId, sessionId: sid });
    }
  } catch {
    /* 解绑已完成；后端 kill 失败不回滚绑定，避免幽灵复用 */
  }
  return ptyId;
}

/**
 * 批量 kill（reset 工作区 / 关窗）。返回被 kill 的 sessionId 列表。
 */
export async function killAllPtys(): Promise<string[]> {
  const ids = ptyRegistry.sessionIds();
  const killed: string[] = [];
  for (const sid of ids) {
    const ptyId = await killPtyForSession(sid);
    if (ptyId) killed.push(sid);
  }
  return killed;
}

/**
 * fire-and-forget：供 store closeTab 动态 import 后调用，避免阻塞 UI。
 */
export function killPtyForSessionBackground(
  sessionId: string | null | undefined,
): void {
  void killPtyForSession(sessionId).catch(() => {
    /* ignore */
  });
}

/** 兼容别名：killPtySession -> killPtyForSession */
export const killPtySession = killPtyForSession;

