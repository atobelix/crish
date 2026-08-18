/**
 * Daemon stream connection lifecycle —— Tauri IPC transport 直连（C1.2 / C3.1）。
 *
 * 本文件为纯 re-export hub（T4-11 / SR-06-R4 基线清零），保持消费方 import 路径不变。
 * 实现拆分到同目录子模块：
 * - readiness.ts：就绪状态机 + contextWindow 解析
 * - streamFinishControl.ts：收尾控制 + 取消 + systemPrompt 组装
 * - streamSession.ts：流会话创建与取消入口
 *
 * ## Transport SoT
 * - 唯一通道：getTransport()（TauriTransport，进程内核心直连，03 §3.1）。
 * - run-task 经 startRunTask(transport, params) 分派 core_run_task。
 * - 事件经 transport.onMessage → router.onMsg（listen('workbench-run-event')）。
 * - 核心未就绪（waitUntilConnected 超时）→ 拒绝启动（C3.4：无 directFetch 降级）。
 */
import type { StreamCancelMode } from '../runControlClient';

export type { StreamCancelMode };

export {
  type ReadinessState,
  type ReadinessGuidance,
  type ReadinessCheckResult,
  resetReadiness,
  ensureReadinessSync,
  resolveContextWindow,
  checkEngineReadyRealtime,
  ensureEngineConnected,
} from './readiness';

export {
  type StreamCancelFn,
  composeSystemPrompt,
  createFinishController,
  createStreamCancel,
} from './streamFinishControl';

export { createStreamSession, streamViaEngine } from './streamSession';

export {
  type HistoryMessage,
  HISTORY_TOKEN_BUDGET,
  HISTORY_MESSAGE_TOKEN_OVERHEAD,
  estimateTextTokens,
  estimateHistoryMessageTokens,
  truncateHistoryWithAnchor,
  buildHistoryMessages,
} from './historyMessages';
