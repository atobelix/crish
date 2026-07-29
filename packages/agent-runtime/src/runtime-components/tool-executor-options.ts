import type { ToolBatchFailurePolicy } from '@crish/shared-types';
import type { LifecycleHookRegistry } from '../hooks';
import type { ToolMiddlewareHook } from './single-tool-executor';

export interface ToolExecutorOptions {
  timeoutMs: number;
  parallelFailurePolicy: ToolBatchFailurePolicy;
  /**
   * 可选：LifecycleHookRegistry — 默认 execute 路径会经薄适配发出 tool.pre/tool.post。
   * session-loop 真路径走自定义 executeOne，自行 emit（含 terminate → L2）。
   */
  lifecycleHooks?: LifecycleHookRegistry;
  /** 发出 tool.* 时的 turnIndex（默认 0；session-loop 路径不依赖此项） */
  lifecycleTurnIndex?: number;
  /** 直接注入的 middleware hooks（与 lifecycleHooks 合并） */
  middlewareHooks?: ToolMiddlewareHook[];
}
