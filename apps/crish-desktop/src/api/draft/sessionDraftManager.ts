/**
 * apps/crish-desktop/src/api/draft/sessionDraftManager.ts
 * 会话与分栏复合隔离三级草稿流转核心管理器（Level 2 Active Pool，全系统草稿唯一主路径）。
 *
 * 设计（详案 03 §2.1 & 定时任务战役 03 §5.1 INT-01 & Stage 05 §6 复合键隔离 & 审计 03 §7.1）：
 * - 以 makeDraftScopeKey(sessionId, leafId) 为寻址键的内存草稿池（Map<ScopeKey, DraftRecord>），
 *   多会话 + 多分栏窗格物理隔离，杜绝同会话双开分栏或全局单键的跨窗格污染；
 * - 每作用域键一张历史撤销栈（DraftHistoryStack，深度 20），外部模板覆盖前自动压入旧快照；
 * - INT-01 输入态保护屏障（Typing Protection Barrier）：按作用域键维护活跃输入焦点锁与最近编辑时间戳；
 * - 审计 03 §7.1 多键独立防抖计时器（pendingTimers: Map<ScopeKey, Timeout>）：消除单标量计时器在多窗格并发输入时的互相覆盖；
 * - evictLeaf(leafId)：分栏叶节点销毁时精确清理关联防抖计时器、内存草稿与打字焦点锁，防止内存泄漏。
 *
 * CI Guardrail: Max 400 lines of effective code, UTF-8 无 BOM.
 */

import { getSessionStoreState, setComposerDraft } from '../storeAccess';

/** 草稿注入模式 */
export type DraftInjectionMode =
  | 'replace' // 替换当前内容（非空覆盖前记录撤销栈）
  | 'append' // 追加至尾部（自动补空行分隔）
  | 'safe_seed'; // 当前为空直接注入；非空则记录撤销栈并按输入屏障采用安全保留策略

/** 定向种子注入载荷（必须携带 targetSessionId，禁止广播式注入；可选携带 targetLeafId 精准定位分栏） */
export interface SessionSeedPayload {
  targetSessionId: string;
  targetLeafId?: string | null;
  content: string;
  mode?: DraftInjectionMode;
  /** 是否遵循 INT-01 正在打字保护屏障（缺省 true） */
  respectTypingBarrier?: boolean;
  metadata?: {
    source:
      'schedule_panel' | 'settings_tab' | 'slash_command' | 'skill_editor';
    title?: string;
  };
}

/** 单会话/单窗格草稿记录 */
export interface DraftRecord {
  sessionId: string;
  leafId?: string | null;
  scopeKey?: string;
  content: string;
  /** 历史撤销栈（最大深度 DRAFT_HISTORY_LIMIT=20） */
  historyStack: string[];
  updatedAt: number;
  /** 最近一次用户编辑草稿的时间戳（INT-01 打字保护屏障时间窗判定） */
  lastUserTypingAt?: number;
}

/** 后台流式事件守护元信息（INT-01） */
export interface BackgroundStreamActivityMeta {
  source?: 'scheduled_task' | 'agent_stream';
  runId?: string;
}

/** 后台流式事件守护回执（INT-01） */
export interface BackgroundStreamGuardResult {
  barrierActive: boolean;
  draftContent: string;
}

/** 订阅者载荷：命中活跃会话/窗格的注入 / 撤销事件 */
export interface DraftNotifyPayload {
  sessionId: string;
  leafId?: string | null;
  scopeKey?: string;
  content: string;
  hasUndo: boolean;
}

/** 撤销栈最大深度（不变量：模板覆盖可 100% 撤销，栈满按 FIFO 截断） */
export const DRAFT_HISTORY_LIMIT = 20;

/** 持久化防抖窗口（毫秒） */
export const DRAFT_PERSIST_DEBOUNCE_MS = 300;

/** INT-01 默认打字保护屏障时间窗（毫秒） */
export const TYPING_BARRIER_WINDOW_MS = 1500;

/**
 * 构造复合草稿隔离键 `(sessionId, leafId)`：
 * - 当未传 leafId 或 leafId 为 'default' 时退化为纯 sessionId，100% 向后兼容单窗格调用；
 * - 当传入有效 leafId 时生成 `${safeSession}::${safeLeaf}`，保证同会话多分栏草稿互不踩踏。
 */
export function makeDraftScopeKey(
  sessionId: string | null | undefined,
  leafId?: string | null
): string {
  const safeSession =
    sessionId && sessionId.trim().length > 0 ? sessionId.trim() : 'default';
  const safeLeaf = leafId && leafId.trim().length > 0 ? leafId.trim() : '';
  if (!safeLeaf || safeLeaf === 'default') {
    return safeSession;
  }
  return `${safeSession}::${safeLeaf}`;
}

export class SessionDraftManager {
  private static instance: SessionDraftManager | null = null;

  private drafts = new Map<string, DraftRecord>();
  private activeTypingSessions = new Set<string>();
  private listeners = new Set<(payload: DraftNotifyPayload) => void>();
  /** 审计 03 §7.1：按复合作用域键独立管理防抖定时器，消除多窗格并发输入的计时器覆盖 */
  private pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingSaves = new Map<string, string>();

  static getInstance(): SessionDraftManager {
    if (!this.instance) {
      this.instance = new SessionDraftManager();
    }
    return this.instance;
  }

  /** 测试可重建实例（不污染跨用例单例） */
  static resetInstance(): void {
    if (this.instance) {
      this.instance.clearAllTimers();
    }
    this.instance = null;
  }

  /**
   * INT-01：显式标记某会话（及可选分栏窗格）输入框是否处于用户聚焦 / IME 组合输入态。
   */
  setTypingActive(
    sessionId: string,
    isTyping: boolean,
    leafId?: string | null
  ): void {
    if (!sessionId) return;
    const scopeKey = makeDraftScopeKey(sessionId, leafId);
    if (isTyping) {
      this.activeTypingSessions.add(scopeKey);
    } else {
      this.activeTypingSessions.delete(scopeKey);
    }
  }

  /**
   * INT-01：判定指定会话（及可选分栏窗格）的输入态保护屏障是否生效。
   */
  isTypingBarrierActive(
    sessionId: string,
    windowMs = TYPING_BARRIER_WINDOW_MS,
    leafId?: string | null
  ): boolean {
    if (!sessionId) return false;
    const scopeKey = makeDraftScopeKey(sessionId, leafId);
    if (this.activeTypingSessions.has(scopeKey)) {
      return true;
    }
    const record = this.drafts.get(scopeKey);
    if (record?.lastUserTypingAt !== undefined && windowMs > 0) {
      const elapsed = Date.now() - record.lastUserTypingAt;
      if (elapsed >= 0 && elapsed < windowMs) {
        return true;
      }
    }
    return false;
  }

  /**
   * INT-01：后台流式输出期间的草稿守护钩子。
   */
  onBackgroundStreamActivity(
    sessionId: string,
    _meta?: BackgroundStreamActivityMeta,
    leafId?: string | null
  ): BackgroundStreamGuardResult {
    if (!sessionId) {
      return { barrierActive: false, draftContent: '' };
    }
    const scopeKey = makeDraftScopeKey(sessionId, leafId);
    const barrierActive = this.isTypingBarrierActive(
      sessionId,
      TYPING_BARRIER_WINDOW_MS,
      leafId
    );
    const draftContent = this.getDraft(sessionId, leafId);

    if (!this.drafts.has(scopeKey) && draftContent) {
      this.drafts.set(scopeKey, {
        sessionId,
        leafId: leafId ?? null,
        scopeKey,
        content: draftContent,
        historyStack: [],
        updatedAt: Date.now(),
      });
    }

    return {
      barrierActive,
      draftContent,
    };
  }

  /** 获取指定会话（及可选分栏窗格）草稿（Level 2 内存优先，Level 3 Store 兜底） */
  getDraft(sessionId: string, leafId?: string | null): string {
    if (!sessionId) return '';
    const scopeKey = makeDraftScopeKey(sessionId, leafId);
    const memory = this.drafts.get(scopeKey);
    if (memory !== undefined) return memory.content;
    return getSessionStoreState().composerDrafts[scopeKey] || '';
  }

  /**
   * 更新指定会话（及可选分栏窗格）草稿（带 300ms 独立键防抖写 Level 3 Store；
   * immediate=true 走 flushKey 原子 Barrier 强刷）。
   */
  setDraft(
    sessionId: string,
    content: string,
    immediate = false,
    leafId?: string | null
  ): void {
    if (!sessionId) return;
    const scopeKey = makeDraftScopeKey(sessionId, leafId);
    const now = Date.now();
    let record = this.drafts.get(scopeKey);
    if (!record) {
      record = {
        sessionId,
        leafId: leafId ?? null,
        scopeKey,
        content,
        historyStack: [],
        updatedAt: now,
        lastUserTypingAt: now,
      };
      this.drafts.set(scopeKey, record);
    } else {
      record.lastUserTypingAt = now;
      if (record.content === content) return;
      record.content = content;
      record.updatedAt = now;
    }

    if (immediate) {
      this.flushKey(scopeKey);
    } else {
      this.scheduleStorePersist(scopeKey, content);
    }
  }

  /**
   * 定向注入种子模板（replace / append / safe_seed）。
   */
  injectSeed(payload: SessionSeedPayload): {
    applied: boolean;
    targetSessionId: string;
    content: string;
  } {
    const {
      targetSessionId,
      targetLeafId = null,
      content,
      mode = 'safe_seed',
    } = payload;
    if (!targetSessionId || !content.trim()) {
      return { applied: false, targetSessionId, content: '' };
    }

    const scopeKey = makeDraftScopeKey(targetSessionId, targetLeafId);
    const current = this.getDraft(targetSessionId, targetLeafId);
    let record = this.drafts.get(scopeKey);
    if (!record) {
      record = {
        sessionId: targetSessionId,
        leafId: targetLeafId,
        scopeKey,
        content: current,
        historyStack: [],
        updatedAt: Date.now(),
      };
      this.drafts.set(scopeKey, record);
    }

    const barrierActive =
      payload.respectTypingBarrier !== false &&
      this.isTypingBarrierActive(
        targetSessionId,
        TYPING_BARRIER_WINDOW_MS,
        targetLeafId
      );
    const shouldAppendUnderBarrier =
      mode === 'safe_seed' &&
      Boolean(current.trim()) &&
      barrierActive &&
      (this.activeTypingSessions.has(scopeKey) ||
        payload.respectTypingBarrier === true);

    let nextContent = content;
    if (mode === 'append' && current.trim()) {
      nextContent = `${current.trimEnd()}\n\n${content}`;
    } else if (shouldAppendUnderBarrier) {
      if (current !== content) {
        this.pushHistory(record, current);
      }
      nextContent = `${current.trimEnd()}\n\n${content}`;
    } else if (mode === 'replace' || (mode === 'safe_seed' && current.trim())) {
      if (current.trim() && current !== content) {
        this.pushHistory(record, current);
      }
      nextContent = content;
    }

    record.content = nextContent;
    record.updatedAt = Date.now();

    this.flushKey(scopeKey);
    this.notify(
      targetSessionId,
      nextContent,
      record.historyStack.length > 0,
      targetLeafId,
      scopeKey
    );

    return { applied: true, targetSessionId, content: nextContent };
  }

  /** 撤销最近一次外部注入 / 覆盖；无历史返回 null */
  undoDraft(sessionId: string, leafId?: string | null): string | null {
    if (!sessionId) return null;
    const scopeKey = makeDraftScopeKey(sessionId, leafId);
    const record = this.drafts.get(scopeKey);
    if (!record || record.historyStack.length === 0) return null;

    const previous = record.historyStack.pop() as string;
    record.content = previous;
    record.updatedAt = Date.now();

    this.flushKey(scopeKey);
    this.notify(
      sessionId,
      previous,
      record.historyStack.length > 0,
      leafId,
      scopeKey
    );
    return previous;
  }

  /** 判断是否存在可撤销的历史版本 */
  hasUndo(sessionId: string, leafId?: string | null): boolean {
    if (!sessionId) return false;
    const scopeKey = makeDraftScopeKey(sessionId, leafId);
    return (this.drafts.get(scopeKey)?.historyStack.length ?? 0) > 0;
  }

  /** 原子 Barrier：按复合作用域键强刷草稿至持久化 Store（仅清理该键的挂起计时器） */
  flushKey(scopeKey: string): void {
    if (!scopeKey) return;
    const timer = this.pendingTimers.get(scopeKey);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.pendingTimers.delete(scopeKey);
      this.pendingSaves.delete(scopeKey);
    }
    const record = this.drafts.get(scopeKey);
    if (record) {
      setComposerDraft(scopeKey, record.content);
    }
  }

  /** 原子 Barrier：强刷指定会话（及可选分栏窗格）草稿至持久化 Store */
  flushSession(sessionId: string, leafId?: string | null): void {
    if (!sessionId) return;
    this.flushKey(makeDraftScopeKey(sessionId, leafId));
  }

  /** 原子 Barrier：全量强刷所有挂起草稿（unload / hidden 兜底） */
  flushAll(): void {
    this.clearAllTimers();
    for (const [scopeKey, rec] of this.drafts.entries()) {
      setComposerDraft(scopeKey, rec.content);
    }
  }

  flushAllPending(): void {
    this.flushAll();
  }

  /**
   * 分栏叶节点销毁时回收该叶节点关联的所有草稿、防抖计时器与焦点锁（Stage 05 §6.2 & 审计 §7.1）
   */
  evictLeaf(leafId: string): void {
    const safeLeaf = leafId?.trim();
    if (!safeLeaf) return;
    const suffix = `::${safeLeaf}`;

    for (const [key, timer] of this.pendingTimers.entries()) {
      if (key.endsWith(suffix) || key === safeLeaf) {
        clearTimeout(timer);
        this.pendingTimers.delete(key);
        this.pendingSaves.delete(key);
      }
    }

    for (const key of Array.from(this.drafts.keys())) {
      if (key.endsWith(suffix) || key === safeLeaf) {
        this.drafts.delete(key);
      }
    }

    for (const key of Array.from(this.activeTypingSessions)) {
      if (key.endsWith(suffix) || key === safeLeaf) {
        this.activeTypingSessions.delete(key);
      }
    }
  }

  /**
   * 会话销毁时回收该会话关联的所有草稿（含多分栏复合键）、防抖计时器与焦点锁
   * 杜绝在内存 Map 与持久化 Store 中遗留复合分栏死键
   */
  evictSession(sessionId: string): void {
    const safeSession = sessionId?.trim();
    if (!safeSession) return;
    const prefix = `${safeSession}::`;

    // 1. 取消并清除以该 session 为作用域的所有挂起防抖保存定时器
    for (const [key, timer] of this.pendingTimers.entries()) {
      if (key === safeSession || key.startsWith(prefix)) {
        clearTimeout(timer);
        this.pendingTimers.delete(key);
        this.pendingSaves.delete(key);
      }
    }

    // 2. 从内存草稿池中彻底移除
    for (const key of Array.from(this.drafts.keys())) {
      if (key === safeSession || key.startsWith(prefix)) {
        this.drafts.delete(key);
      }
    }

    // 3. 清除当前正在输入状态锁
    for (const key of Array.from(this.activeTypingSessions)) {
      if (key === safeSession || key.startsWith(prefix)) {
        this.activeTypingSessions.delete(key);
      }
    }
  }

  /** 获取当前挂起的防抖计时器数量（供测试与诊断断言） */
  getPendingTimerCount(): number {
    return this.pendingTimers.size;
  }

  /** 订阅注入 / 撤销事件，返回退订函数 */
  subscribe(fn: (payload: DraftNotifyPayload) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private clearAllTimers(): void {
    for (const timer of this.pendingTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingTimers.clear();
    this.pendingSaves.clear();
  }

  private pushHistory(record: DraftRecord, snapshot: string): void {
    record.historyStack.push(snapshot);
    if (record.historyStack.length > DRAFT_HISTORY_LIMIT) {
      record.historyStack.shift();
    }
  }

  private notify(
    sessionId: string,
    content: string,
    hasUndo: boolean,
    leafId?: string | null,
    scopeKey?: string
  ): void {
    const payload: DraftNotifyPayload = {
      sessionId,
      ...(leafId ? { leafId } : {}),
      ...(scopeKey ? { scopeKey } : {}),
      content,
      hasUndo,
    };
    this.listeners.forEach((fn) => fn(payload));
  }

  private scheduleStorePersist(scopeKey: string, content: string): void {
    this.pendingSaves.set(scopeKey, content);
    const existing = this.pendingTimers.get(scopeKey);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.pendingTimers.delete(scopeKey);
      const targetContent = this.pendingSaves.get(scopeKey);
      this.pendingSaves.delete(scopeKey);
      if (targetContent !== undefined) {
        setComposerDraft(scopeKey, targetContent);
      }
    }, DRAFT_PERSIST_DEBOUNCE_MS);
    this.pendingTimers.set(scopeKey, timer);
  }
}

export { SessionDraftManager as PartitionedSessionDraftManager };

/** 全系统单例（Level 2 唯一主路径） */
export const sessionDraftManager = SessionDraftManager.getInstance();
