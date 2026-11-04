/**
 * apps/crish-mobile/src/adapters/tools/types.ts
 *
 * 通用端侧工具体系类型契约与上下文定义
 * 依据方案文档：《docs/mobile-web-search-and-sandbox/04-分维-移动端本地Agent循环与通用端侧工具体系方案.md》§3 & §4
 */

/**
 * 端侧工具执行上下文
 */
export interface MobileToolContext {
  /** 级联取消信号（外部打断、用户取消或网络超时） */
  signal?: AbortSignal;
  /** 当前线程 ID（本地会话标识） */
  threadId?: string;
  /** 当前全局会话 ID */
  sessionId?: string;
  /** 进度通知回调（用于向 UI 动态推送工具执行阶段，如“正在检索网页...”） */
  onProgress?: (msg: string) => void;
  /** 扩展宿主上下文注入（如网络类型、位置、设置覆盖等） */
  extraContext?: Record<string, unknown>;
}

/**
 * 端侧工具单次执行标准输出结果
 */
export interface ToolExecutionResult {
  /** 对应大模型下发的 tool_call_id */
  toolCallId: string;
  /** 工具全局唯一名称 */
  toolName: string;
  /** 执行是否成功 */
  ok: boolean;
  /** 返回给大模型的输出内容（XML 格式化文本、Markdown 原文或 JSON 字符串） */
  output: string;
  /** 错误信息（若 ok === false 时提供） */
  error?: string;
  /** 附加元数据（如耗时、引文字典、统计指标等，供 UI 增强展示） */
  metadata?: Record<string, unknown>;
}

/**
 * 权限审批策略：
 * - 'auto': 纯只读或无副作用操作，静默自动放行
 * - 'ask-user': 有副作用或涉及隐私（如剪贴板读取、文件修改），挂起等待用户确认
 */
export type ToolApprovalPolicy = 'auto' | 'ask-user';

/**
 * 并发执行模式：
 * - 'parallel': 只读查询，支持在单轮中与其他工具并行执行
 * - 'serial': 串行互斥执行
 */
export type ToolConcurrencyMode = 'parallel' | 'serial';

/**
 * 端侧工具定义契约
 */
export interface MobileToolDefinition {
  /** 工具全局唯一名称（例如 'web_search', 'web_fetch', 'run_js_sandbox'） */
  name: string;
  /** 工具面向大模型的人类可读功能描述 */
  description: string;
  /** 入参 JSON Schema 规范定义 */
  parameters: Record<string, unknown>;
  /**
   * 工具核心执行逻辑
   * @param args 经过自愈解析后的入参字典
   * @param context 端侧工具执行上下文
   */
  execute: (
    args: Record<string, unknown>,
    context: MobileToolContext
  ) => Promise<ToolExecutionResult>;
  /**
   * 动态条件判断当前工具是否可用（可选）
   * 例如根据用户设置中心或双轨仲裁结果判断是否启用
   */
  isEnabled?: (context?: MobileToolContext) => boolean;
  /** 权限审批策略，默认 'auto' */
  approval?: ToolApprovalPolicy;
  /** 并发模式，默认 'parallel' */
  concurrency?: ToolConcurrencyMode;
  /** 单次执行硬超时时间（毫秒，默认 10000ms） */
  timeoutMs?: number;
}

/**
 * OpenAI Function Calling 标准兼容 Schema 格式
 */
export interface OpenAiFunctionToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
}

/**
 * 模型下发的待执行工具调用数据契约
 */
export interface ToolCallInput {
  id: string;
  name: string;
  arguments: string; // 原始 JSON 字符串或碎片
}
