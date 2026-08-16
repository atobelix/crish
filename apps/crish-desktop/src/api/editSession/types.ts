/**
 * 编辑会话抽象 · 类型（R2-a① · 统一输入流收敛战役）
 *
 * 语义对齐（只读参考后端先例，不写 Rust）：
 * - **CT-01 doc.rev 版本契约**：会话携带对象级 rev；commit 带 expectRev，
 *   不符 → 冲突上报，不静默 LWW（对齐 conex-doc-collab/persistence.rs
 *   `PersistError::Conflict`「CAS = 检测并报错，不自动合并」）。
 * - **write_paths_state.rs 声明记账 / Rail 模式**：编辑持有去中心化
 *   （对象 id → 会话状态），**非全局锁**。
 * - **lease_guard.rs 编辑租约**：open 声明持有 → commit/invalidate 释放。
 *
 * 事件总线为**前端内存态独立带**：open/commit/invalidate 是必达生命周期
 * 事件，**不进消息时间线 seq**（17 审计纪律：编辑/定制状态属独立带）。
 */

/** 外部失效原因（R2-b 接线：撤回 / 截断 / collab conflict → invalidate） */
export type EditSessionInvalidateReason =
  | 'withdraw' // 消息撤回
  | 'truncate' // R1 timeline-truncate 截断（boundary 覆盖）
  | 'collab-conflict' // collab 远端合并冲突（CAS 版本不符）
  | 'external'; // 其它外部变更

/** 单条编辑会话（对象 id → 会话状态记账） */
export type EditSessionState = {
  /** 可编辑物 id（笔记块正文叶 / 草稿 / 设置表单项） */
  objectId: string;
  /** 打开时的对象级 rev（CT-01 对齐；未知可缺省，真实 rev 由宿主接线时传入） */
  baseRev?: number;
  /** 会话建立时刻（epoch ms，对齐全仓惯例） */
  openedAtMs: number;
};

/** open 结果：无竞态建立；已持有 → already_open（保留原会话，不覆盖 baseRev） */
export type EditSessionOpenResult =
  | { ok: true; session: EditSessionState }
  | { ok: false; code: 'already_open'; session: EditSessionState };

/** commit 选项：期望版本（CT-01 CAS 对齐；不符 → rev_conflict） */
export type EditSessionCommitOptions = {
  expectRev?: number;
};

/** commit 结果：成功推进 rev 并清会话；未持有 / 版本冲突上报 */
export type EditSessionCommitResult =
  | { ok: true; session: EditSessionState; committedRev: number }
  | { ok: false; code: 'not_open' }
  | {
      ok: false;
      code: 'rev_conflict';
      expectRev: number;
      baseRev: number | undefined;
    };

/** invalidate 结果：hadSession 标记该 id 是否原本持有会话 */
export type EditSessionInvalidateResult = {
  ok: true;
  hadSession: boolean;
};

/**
 * 编辑会话事件（前端事件总线载荷）。
 * - `opened`：会话建立
 * - `committed`：提交并失效——推进 rev、清会话、广播失效（订阅方刷新）
 * - `invalidated`：外部失效（撤回/截断/conflict）→ 编辑面立即失效
 */
export type EditSessionEvent =
  | { type: 'opened'; objectId: string; baseRev?: number }
  | { type: 'committed'; objectId: string; committedRev: number }
  | {
      type: 'invalidated';
      objectId: string;
      reason: EditSessionInvalidateReason;
      hadSession: boolean;
    };

export type EditSessionListener = (event: EditSessionEvent) => void;
