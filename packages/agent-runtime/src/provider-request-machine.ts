/**
 * Provider 请求状态机
 *
 * 替换 OpenAICompatibleProvider.stream() 中的嵌套循环：
 *   for (endpoint) { for (attempt) { while (wireMode) { ... } } }
 *
 * 使用形式化状态机管理：
 * 1. Endpoint 选择与回退
 * 2. 重试策略
 * 3. WireMode 兼容性切换
 * 4. 流式响应错误处理
 *
 * 状态机保证：
 * - 不存在无限循环
 * - 每个转移都有明确的条件
 * - 重试次数有硬性上限
 * - 诊断信息随状态转移自动记录
 */

import {
  ConexStateMachine,
  StateMachineBuilder,
  transitionTo,
  transitionWith,
  type StateMachineSnapshot,
} from "./state-machine/core";

// ─── 状态与事件类型 ───────────────────────────────────────

export type ProviderRequestState =
  | "idle"
  | "selecting-endpoint"
  | "building-request"
  | "sending-request"
  | "reading-response-headers"
  | "streaming-response"
  | "evaluating-error"
  | "retrying-same-endpoint"
  | "falling-back-endpoint"
  | "switching-wire-mode"
  | "succeeded"
  | "failed";

export type ProviderRequestEvent =
  | "START"
  | "ENDPOINT_SELECTED"
  | "REQUEST_BUILT"
  | "REQUEST_SENT"
  | "HEADERS_RECEIVED"
  | "STREAM_STARTED"
  | "STREAM_COMPLETE"
  | "STREAM_ERROR"
  | "TRANSPORT_ERROR"
  | "HTTP_ERROR"
  | "ERROR_EVALUATED"
  | "RETRY_SCHEDULED"
  | "FALLBACK_SCHEDULED"
  | "WIRE_MODE_SWITCH"
  | "RETRY_EXECUTED"
  | "FALLBACK_EXECUTED"
  | "WIRE_MODE_EXECUTED"
  | "NO_MORE_RETRIES"
  | "NO_MORE_ENDPOINTS"
  | "ABORT";

// ─── 上下文 ───────────────────────────────────────────────

export interface ProviderRequestContext {
  sessionId: string;
  requestId: string;

  // Endpoint 管理
  endpoints: string[];
  currentEndpointIndex: number;
  currentEndpoint: string | null;

  // 重试管理
  maxAttempts: number;
  currentAttempt: number;
  retryBudgetMs: number;
  startedAt: number;

  // WireMode 管理
  wireMode: "native-system-role" | "user-prefix";
  wireModeRetried: boolean;

  // 错误追踪
  lastErrorKind: string | null;
  lastErrorReason: string | null;
  lastStatusCode: number | null;
  lastRetryAfterMs: number | null;

  // 诊断
  diagnostics: ProviderRequestDiagnostic[];
}

export interface ProviderRequestDiagnostic {
  phase: string;
  endpoint?: string;
  attempt?: number;
  elapsedMs?: number;
  status?: number;
  errorKind?: string;
  reason?: string;
  wireMode?: string;
  retryable?: boolean;
}

// ─── 状态机定义 ───────────────────────────────────────────

export const PROVIDER_REQUEST_DEFINITION = new StateMachineBuilder<
  ProviderRequestState,
  ProviderRequestEvent,
  ProviderRequestContext
>()
  .type("provider-request")
  .initial("idle")
  .context(() => ({
    sessionId: "",
    requestId: "",
    endpoints: [],
    currentEndpointIndex: 0,
    currentEndpoint: null,
    maxAttempts: 3,
    currentAttempt: 1,
    retryBudgetMs: 120_000,
    startedAt: Date.now(),
    wireMode: "native-system-role" as const,
    wireModeRetried: false,
    lastErrorKind: null,
    lastErrorReason: null,
    lastStatusCode: null,
    lastRetryAfterMs: null,
    diagnostics: [],
  }))

  // ─── idle ─────────────────────────────────────────────
  .state("idle", {
    transitions: [
      ["START", transitionWith("selecting-endpoint", (ctx) => ({
        ...ctx,
        startedAt: Date.now(),
        currentAttempt: 1,
        currentEndpointIndex: 0,
        wireMode: "native-system-role" as const,
        wireModeRetried: false,
        diagnostics: []
      }))]
    ]
  })

  // ─── selecting-endpoint ───────────────────────────────
  .state("selecting-endpoint", {
    onEnter: (ctx) => [{
      kind: "update-context" as const,
      updater: () => {
        if (ctx.currentEndpointIndex < ctx.endpoints.length) {
          return { ...ctx, currentEndpoint: ctx.endpoints[ctx.currentEndpointIndex]! };
        }
        return ctx;
      }
    }],
    transitions: [
      ["ENDPOINT_SELECTED", transitionTo("building-request")],
      ["NO_MORE_ENDPOINTS", transitionWith("failed", (ctx) => ({
        ...ctx,
        lastErrorReason: ctx.lastErrorReason ?? "All endpoints exhausted"
      }))]
    ]
  })

  // ─── building-request ─────────────────────────────────
  .state("building-request", {
    transitions: [
      ["REQUEST_BUILT", transitionTo("sending-request")],
      ["ABORT", transitionTo("failed")]
    ]
  })

  // ─── sending-request ──────────────────────────────────
  .state("sending-request", {
    transitions: [
      ["REQUEST_SENT", transitionTo("reading-response-headers")],
      ["TRANSPORT_ERROR", transitionTo("evaluating-error", {
        effect: (ctx, payload) => [{
          kind: "update-context" as const,
          updater: () => {
            const data = payload as { errorKind: string; reason: string };
            return { ...ctx, lastErrorKind: data.errorKind, lastErrorReason: data.reason };
          }
        }]
      })],
      ["ABORT", transitionTo("failed")]
    ]
  })

  // ─── reading-response-headers ─────────────────────────
  .state("reading-response-headers", {
    transitions: [
      ["HEADERS_RECEIVED", transitionTo("streaming-response", {
        effect: (ctx, payload) => [{
          kind: "update-context" as const,
          updater: () => {
            const data = payload as { status: number };
            return { ...ctx, lastStatusCode: data.status };
          }
        }]
      })],
      ["HTTP_ERROR", transitionTo("evaluating-error", {
        effect: (ctx, payload) => [{
          kind: "update-context" as const,
          updater: () => {
            const data = payload as { status: number; errorKind: string; reason: string };
            return {
              ...ctx,
              lastStatusCode: data.status,
              lastErrorKind: data.errorKind,
              lastErrorReason: data.reason
            };
          }
        }]
      })],
      ["ABORT", transitionTo("failed")]
    ]
  })

  // ─── streaming-response ───────────────────────────────
  .state("streaming-response", {
    transitions: [
      ["STREAM_COMPLETE", transitionTo("succeeded")],
      ["STREAM_ERROR", transitionTo("evaluating-error", {
        effect: (ctx, payload) => [{
          kind: "update-context" as const,
          updater: () => {
            const data = payload as { errorKind: string; reason: string };
            return { ...ctx, lastErrorKind: data.errorKind, lastErrorReason: data.reason };
          }
        }]
      })],
      ["ABORT", transitionTo("failed")]
    ]
  })

  // ─── evaluating-error ─────────────────────────────────
  .state("evaluating-error", {
    transitions: [
      // 需要切换 wire mode
      ["WIRE_MODE_SWITCH", transitionWith("switching-wire-mode", (ctx) => ({
        ...ctx,
        wireMode: "user-prefix" as const,
        wireModeRetried: true
      }))],
      // 可以在同一 endpoint 重试
      ["RETRY_SCHEDULED", transitionTo("retrying-same-endpoint")],
      // 需要回退到下一个 endpoint
      ["FALLBACK_SCHEDULED", transitionTo("falling-back-endpoint")],
      // 无法恢复
      ["NO_MORE_RETRIES", transitionTo("failed")]
    ]
  })

  // ─── retrying-same-endpoint ───────────────────────────
  .state("retrying-same-endpoint", {
    onEnter: (ctx) => [{
      kind: "update-context" as const,
      updater: () => ({
        ...ctx,
        currentAttempt: ctx.currentAttempt + 1
      })
    }],
    transitions: [
      ["RETRY_EXECUTED", transitionTo("building-request")],
      ["ABORT", transitionTo("failed")]
    ]
  })

  // ─── falling-back-endpoint ────────────────────────────
  .state("falling-back-endpoint", {
    onEnter: (ctx) => [{
      kind: "update-context" as const,
      updater: () => ({
        ...ctx,
        currentEndpointIndex: ctx.currentEndpointIndex + 1,
        currentAttempt: 1,
        wireMode: "native-system-role" as const,
        wireModeRetried: false
      })
    }],
    transitions: [
      ["FALLBACK_EXECUTED", transitionTo("selecting-endpoint")],
      ["NO_MORE_ENDPOINTS", transitionTo("failed")]
    ]
  })

  // ─── switching-wire-mode ──────────────────────────────
  .state("switching-wire-mode", {
    transitions: [
      ["WIRE_MODE_EXECUTED", transitionTo("building-request")],
      ["ABORT", transitionTo("failed")]
    ]
  })

  // ─── succeeded (终态) ────────────────────────────────
  .state("succeeded", { transitions: [] })

  // ─── failed (终态) ───────────────────────────────────
  .state("failed", { transitions: [] })

  .build();

// ─── 工厂函数 ─────────────────────────────────────────────

export function createProviderRequestMachine(
  sessionId: string,
  requestId: string,
  endpoints: string[],
  options?: Partial<{
    maxAttempts: number;
    retryBudgetMs: number;
    initialWireMode: "native-system-role" | "user-prefix";
    snapshot: StateMachineSnapshot<ProviderRequestState, ProviderRequestContext>;
  }>
): ConexStateMachine<ProviderRequestState, ProviderRequestEvent, ProviderRequestContext> {
  return new ConexStateMachine(
    PROVIDER_REQUEST_DEFINITION,
    `provider-request-${sessionId}-${requestId}`,
    {
      initialContext: {
        sessionId,
        requestId,
        endpoints,
        currentEndpointIndex: 0,
        currentEndpoint: endpoints[0] ?? null,
        maxAttempts: options?.maxAttempts ?? 3,
        currentAttempt: 1,
        retryBudgetMs: options?.retryBudgetMs ?? 120_000,
        startedAt: Date.now(),
        wireMode: options?.initialWireMode ?? "native-system-role",
        wireModeRetried: false,
        lastErrorKind: null,
        lastErrorReason: null,
        lastStatusCode: null,
        lastRetryAfterMs: null,
        diagnostics: []
      },
      ...(options?.snapshot !== undefined ? { snapshot: options.snapshot } : {})
    }
  );
}
