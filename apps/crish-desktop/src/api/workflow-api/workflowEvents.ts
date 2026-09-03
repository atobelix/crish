/**
 * apps/crish-desktop/src/api/workflow-api/workflowEvents.ts
 * workflow 全域事件订阅（05 详案 §2.5）：Rust `workflow_commands.rs`
 * `emit_workflow_event` 在 create/update/delete 成功落盘后广播，
 * 前端面板经本模块订阅并刷新列表（事件是通知面，不是落盘面——
 * 收到事件后一律以 list-workflows 重读为准，payload 仅作提示）。
 *
 * 事件名冻结契约（与 Rust 侧字符串同源，禁止单侧改名）：
 * `workflow:created` / `workflow:updated` / `workflow:deleted`
 */

/** workflow:created / workflow:updated / workflow:deleted（Rust 同源冻结） */
export const WORKFLOW_CREATED_EVENT = 'workflow:created';
export const WORKFLOW_UPDATED_EVENT = 'workflow:updated';
export const WORKFLOW_DELETED_EVENT = 'workflow:deleted';

/** 事件载荷（Rust emit_workflow_event 的 json! 形状；字段均可能缺省） */
export interface WorkflowEventPayload {
  workflowId?: string;
  name?: string;
  nextRunAt?: string | null;
}

export type WorkflowEventHandler = (payload: WorkflowEventPayload) => void;

type UnlistenFn = () => void;

/** 单事件订阅（非 Tauri 环境 / 测试未 mock → noop 卸载，静默降级；
 * 对齐 browserSessionApi.listenBrowserStateEvent 同款策略） */
async function listenWorkflowEvent(
  event: string,
  handler: WorkflowEventHandler,
): Promise<UnlistenFn> {
  try {
    if (typeof window === 'undefined' || !(window as any).__TAURI_INTERNALS__) {
      return () => {};
    }
    const mod = await import('@tauri-apps/api/event');
    if (typeof mod?.listen !== 'function') return () => {};
    return await mod.listen(event, (e: { payload?: unknown }) => {
      handler((e?.payload ?? {}) as WorkflowEventPayload);
    });
  } catch {
    return () => {};
  }
}

/** 订阅 workflow 三事件（created/updated/deleted）；返回合并卸载函数 */
export async function listenWorkflowEvents(
  handler: WorkflowEventHandler,
): Promise<UnlistenFn> {
  const unlistens = await Promise.all([
    listenWorkflowEvent(WORKFLOW_CREATED_EVENT, handler),
    listenWorkflowEvent(WORKFLOW_UPDATED_EVENT, handler),
    listenWorkflowEvent(WORKFLOW_DELETED_EVENT, handler),
  ]);
  return () => {
    for (const unlisten of unlistens) unlisten();
  };
}
