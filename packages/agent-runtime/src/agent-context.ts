import type { AgentMessage } from "@crish/shared-types";
import type { AgentTool } from "./types";

/**
 * 不可变策略包 — Daemon 启动时初始化一次，所有子 Agent 共享引用。
 */
export interface PolicyPack {
  /**
   * 权限策略模式（如 "ask" | "unattended" | "plan" 等）
   */
  readonly permissionMode: string;
  /**
   * 以 JSON 形式携带的策略元数据（CLI flags / daemon config 产物）
   */
  readonly payload: Record<string, unknown>;
}

/**
 * AgentContextBase — 不可变基底。
 * Daemon 启动时初始化一次，所有 Agent 共享同一份引用。
 */
export interface AgentContextBase {
  readonly systemPrompt: string;
  readonly policyPack: PolicyPack;
  readonly toolSchemas: readonly AgentTool[];
}

/**
 * AgentContextView — 每个 Agent 私有的可变视图。
 * 通过扩展基类获得不可变部分 + 本 Agent 私有的消息历史与身份标识。
 */
export interface AgentContextView extends AgentContextBase {
  messages: AgentMessage[];
  cwd: string;
  sessionId: string;
  parentSessionId?: string;
}
