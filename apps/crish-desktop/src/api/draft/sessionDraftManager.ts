/**
 * apps/crish-desktop/src/api/draft/sessionDraftManager.ts
 * 会话隔离三级草稿流转核心管理器（Level 2 Active Pool，全系统草稿唯一主路径）。
 *
 * 设计（详案 03 §2.1 & 定时任务战役 03 §5.1 INT-01）：
 * - 以 targetSessionId 为寻址键的内存草稿池（Map<SessionId, DraftRecord>），
 *   多会话物理隔离，杜绝 sessionStorage 全局单键的跨会话污染；
 * - 每会话一张历史撤销栈（DraftHistoryStack，深度 20），外部模板覆盖前自动
 *   压入旧快照，undoDraft 100% 原位无损恢复；
 * - INT-01 输入态保护屏障（Typing Protection Barrier）：维护活跃输入焦点锁
 *   `activeTypingSessions` 与每会话最后编辑时间戳 `lastUserTypingAt`，在后台
 *   定时任务流式输出期间原样锁定保护用户草稿与撤销栈，杜绝静默冲刷；
 * - 300ms 防抖持久化到 sessionStore.setComposerDraft（Level 3），flushSession /
 *   flushAll 为原子 Barrier 强刷（清空挂起计时器后立即写盘）；
 * - subscribe 定向通知活跃视口订阅者（useChatInput），后台会话注入零视口干扰。
 *
 * CI Guardrail: Max 400 lines of effective code, UTF-8 无 BOM.
 */

import { getSessionStoreState, setComposerDraft } from '../storeAccess';

/** 草稿注入模式 */
export type DraftInjectionMode =
  | 'replace' // 替换当前内容（非空覆盖前记录撤销栈）
  | 'append' // 追加至尾部（自动补空行分隔）
  | 'safe_seed'; // 当前为空直接注入；非空则记录撤销栈并按输入屏障采用安全保留策略

/** 定向种子注入载荷（必须携带 targetSessionId，禁止广播式注入） */
export interface SessionSeedPayload {
  targetSessionId: string;
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

/** 单会话草稿记录 */
export interface DraftRecord {
  sessionId: string;
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

/** 订阅者载荷：命中活跃会话的注入 / 撤销事件 */
export interface DraftNotifyPayload {
  sessionId: string;
  content: string;
  hasUndo: boolean;
}

/** 撤销栈最大深度（不变量：模板覆盖可 100% 撤销，栈满按 FIFO 截断） */
export const DRAFT_HISTORY_LIMIT = 20;

/** 持久化防抖窗口（毫秒） */
export const DRAFT_PERSIST_DEBOUNCE_MS = 300;

/** INT-01 默认打字保护屏障时间窗（毫秒） */
export const TYPING_BARRIER_WINDOW_MS = 1500;

export class SessionDraftManager {
  private static instance: SessionDraftManager | null = null;

  private drafts = new Map<string, DraftRecord>();
  private activeTypingSessions = new Set<string>();
  private listeners = new Set<(payload: DraftNotifyPayload) => void>();
  private pendingTimer: number | null = null;
  private pendingSave: { sessionId: string; content: string } | null = null;

  static getInstance(): SessionDraftManager {
    if (!this.instance) {
      this.instance = new SessionDraftManager();
    }
    return this.instance;
  }

  /** 测试可重建实例（不污染跨用例单例） */
  static resetInstance(): void {
    this.instance = null;
  }

  /**
   * INT-01：显式标记某会话输入框是否处于用户聚焦 / IME 组合输入态。
   */
  setTypingActive(sessionId: string, isTyping: boolean): void {
    if (!sessionId) return;
    if (isTyping) {
      this.activeTypingSessions.add(sessionId);
    } else {
      this.activeTypingSessions.delete(sessionId);
    }
  }

  /**
   * INT-01：判定指定会话的输入态保护屏障是否生效。
   * 当 `activeTypingSessions.has(sessionId)` 为 true，或者距离该会话最近一次
   * `setDraft` 用户编辑不足 `windowMs` 毫秒时，判定输入保护屏障生效。
   */
  isTypingBarrierActive(
    sessionId: string,
    windowMs = TYPING_BARRIER_WINDOW_MS
  ): boolean {
    if (!sessionId) return false;
    if (this.activeTypingSessions.has(sessionId)) {
      return true;
    }
    const record = this.drafts.get(sessionId);
    if (record?.lastUserTypingAt !== undefined && windowMs > 0) {
      const elapsed = Date.now() - record.lastUserTypingAt;
      if (elapsed >= 0 && elapsed < windowMs) {
        return true;
      }
    }
    return false;
  }

  /**
   * INT-01：当后台定时任务向目标会话推送流式消息（`chat:stream` / `workflow:run-*`）
   * 时调用的守护钩子——确保在屏障生效或任何后台流推送期间，绝不清空、绝不覆盖、
   * 绝不触发对当前用户未发送草稿 `DraftRecord.content` 的破坏，原样保护内存草稿与撤销栈。
   */
  onBackgroundStreamActivity(
    sessionId: string,
    _meta?: BackgroundStreamActivityMeta
  ): BackgroundStreamGuardResult {
    if (!sessionId) {
      return { barrierActive: false, draftContent: '' };
    }
    const barrierActive = this.isTypingBarrierActive(sessionId);
    const draftContent = this.getDraft(sessionId);

    // 若内存池尚未建档但 Level 3 Store 存在未发送草稿，立即在内存池建立受保护快照，
    // 防止后台流状态同步意外冲刷持久化层草稿。
    if (!this.drafts.has(sessionId) && draftContent) {
      this.drafts.set(sessionId, {
        sessionId,
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

  /** 获取指定会话草稿（Level 2 内存优先，Level 3 Store 兜底） */
  getDraft(sessionId: string): string {
    if (!sessionId) return '';
    const memory = this.drafts.get(sessionId);
    if (memory !== undefined) return memory.content;
    return getSessionStoreState().composerDrafts[sessionId] || '';
  }

  /**
   * 更新指定会话草稿（带 300ms 防抖写 Level 3 Store；
   * immediate=true 走 flushSession 原子 Barrier 强刷）。
   */
  setDraft(sessionId: string, content: string, immediate = false): void {
    if (!sessionId) return;
    const now = Date.now();
    let record = this.drafts.get(sessionId);
    if (!record) {
      record = {
        sessionId,
        content,
        historyStack: [],
        updatedAt: now,
        lastUserTypingAt: now,
      };
      this.drafts.set(sessionId, record);
    } else {
      record.lastUserTypingAt = now;
      if (record.content === content) return;
      record.content = content;
      record.updatedAt = now;
    }

    if (immediate) {
      this.flushSession(sessionId);
    } else {
      this.scheduleStorePersist(sessionId, content);
    }
  }

  /**
   * 定向注入种子模板（replace / append / safe_seed）。
   * 返回 { applied, targetSessionId, content }；targetSessionId 或内容为空则 applied=false。
   */
  injectSeed(payload: SessionSeedPayload): {
    applied: boolean;
    targetSessionId: string;
    content: string;
  } {
    const { targetSessionId, content, mode = 'safe_seed' } = payload;
    if (!targetSessionId || !content.trim()) {
      return { applied: false, targetSessionId, content: '' };
    }

    const current = this.getDraft(targetSessionId);
    let record = this.drafts.get(targetSessionId);
    if (!record) {
      record = {
        sessionId: targetSessionId,
        content: current,
        historyStack: [],
        updatedAt: Date.now(),
      };
      this.drafts.set(targetSessionId, record);
    }

    const barrierActive =
      payload.respectTypingBarrier !== false &&
      this.isTypingBarrierActive(targetSessionId);
    const shouldAppendUnderBarrier =
      mode === 'safe_seed' &&
      Boolean(current.trim()) &&
      barrierActive &&
      (this.activeTypingSessions.has(targetSessionId) ||
        payload.respectTypingBarrier === true);

    let nextContent = content;
    if (mode === 'append' && current.trim()) {
      nextContent = `${current.trimEnd()}\n\n${content}`;
    } else if (shouldAppendUnderBarrier) {
      // INT-01 保护屏障生效：将当前正在输入的草稿压入 historyStack 并采用安全追加保留策略
      if (current !== content) {
        this.pushHistory(record, current);
      }
      nextContent = `${current.trimEnd()}\n\n${content}`;
    } else if (mode === 'replace' || (mode === 'safe_seed' && current.trim())) {
      // 非空覆盖前压入撤销栈（同内容覆盖不产生历史噪音）
      if (current.trim() && current !== content) {
        this.pushHistory(record, current);
      }
      nextContent = content;
    }

    record.content = nextContent;
    record.updatedAt = Date.now();

    // 注入为程序性覆盖：立即原子强刷 Level 3，不落防抖窗口
    this.flushSession(targetSessionId);

    // 通知活跃视口订阅者（后台会话由订阅端自行过滤）
    this.notify(targetSessionId, nextContent, record.historyStack.length > 0);

    return { applied: true, targetSessionId, content: nextContent };
  }

  /** 撤销最近一次外部注入 / 覆盖；无历史返回 null */
  undoDraft(sessionId: string): string | null {
    const record = this.drafts.get(sessionId);
    if (!record || record.historyStack.length === 0) return null;

    const previous = record.historyStack.pop() as string;
    record.content = previous;
    record.updatedAt = Date.now();

    this.flushSession(sessionId);
    this.notify(sessionId, previous, record.historyStack.length > 0);
    return previous;
  }

  /** 判断是否存在可撤销的历史版本 */
  hasUndo(sessionId: string): boolean {
    return (this.drafts.get(sessionId)?.historyStack.length ?? 0) > 0;
  }

  /** 原子 Barrier：强刷指定会话草稿至持久化 Store（清空其挂起计时器） */
  flushSession(sessionId: string): void {
    if (
      this.pendingTimer !== null &&
      this.pendingSave?.sessionId === sessionId
    ) {
      window.clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
      this.pendingSave = null;
    }
    const record = this.drafts.get(sessionId);
    if (record) {
      setComposerDraft(sessionId, record.content);
    }
  }

  /** 原子 Barrier：全量强刷所有挂起草稿（unload / hidden 兜底） */
  flushAll(): void {
    if (this.pendingTimer !== null) {
      window.clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
      this.pendingSave = null;
    }
    for (const [sid, rec] of this.drafts.entries()) {
      setComposerDraft(sid, rec.content);
    }
  }

  /** 订阅注入 / 撤销事件，返回退订函数 */
  subscribe(fn: (payload: DraftNotifyPayload) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private pushHistory(record: DraftRecord, snapshot: string): void {
    record.historyStack.push(snapshot);
    if (record.historyStack.length > DRAFT_HISTORY_LIMIT) {
      record.historyStack.shift();
    }
  }

  private notify(sessionId: string, content: string, hasUndo: boolean): void {
    const payload: DraftNotifyPayload = { sessionId, content, hasUndo };
    this.listeners.forEach((fn) => fn(payload));
  }

  private scheduleStorePersist(sessionId: string, content: string): void {
    this.pendingSave = { sessionId, content };
    if (this.pendingTimer !== null) {
      window.clearTimeout(this.pendingTimer);
    }
    this.pendingTimer = window.setTimeout(() => {
      this.pendingTimer = null;
      const target = this.pendingSave;
      this.pendingSave = null;
      if (target) {
        setComposerDraft(target.sessionId, target.content);
      }
    }, DRAFT_PERSIST_DEBOUNCE_MS);
  }
}

/** 全系统单例（Level 2 唯一主路径） */
export const sessionDraftManager = SessionDraftManager.getInstance();
