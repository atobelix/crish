/**
 * apps/crish-mobile/src/adapters/tools/toolRegistry.ts
 *
 * 端侧通用工具注册表（MobileToolRegistry）与路由调度分发器
 * 严格对齐《04-分维-移动端本地Agent循环与通用端侧工具体系方案.md》§4
 *
 * 核心特性：
 * 1. 单例 MobileToolRegistry，支持工具动态注册、注销、查询与清空；
 * 2. 动态能力过滤：支持按需启用/禁用、根据线程上下文及 isEnabled 动态生效；
 * 3. 协议适配导出：提供 toOpenAiFunctionSchemas() 导出标准 OpenAI tools 契约；
 * 4. 健壮自愈路由执行器 executeToolCall：
 *    - 入参自愈容错反序列化（去除 markdown 包装、单引号替换、尾部逗号清洗、Python 关键字兼容）；
 *    - 级联 AbortSignal 与硬超时控制；
 *    - 未知工具、已禁用工具与执行期异常刚性隔离，永不打崩 Agent Loop。
 */

import type {
  MobileToolContext,
  MobileToolDefinition,
  OpenAiFunctionToolSchema,
  ToolCallInput,
  ToolExecutionResult,
} from './types';
import { recordToolExecutionBreadcrumb } from '@/domain/store/toolExecutionBreadcrumbs';

/**
 * 健壮的自愈 JSON 入参解析器
 * 容错处理大模型输出的各种常见格式缺陷：
 * 1. Markdown 代码块包裹：```json ... ```
 * 2. 空白字符串 -> {}
 * 3. 尾部逗号（Trailing commas）
 * 4. 单引号代替双引号（Python 式字典字符串）
 * 5. Python 关键字：True -> true, False -> false, None -> null
 * 6. 未加引号的键名：{ query: "foo" } -> { "query": "foo" }
 */
export function repairAndParseJsonArguments(raw: string | unknown): {
  success: boolean;
  data: Record<string, unknown>;
  error?: string;
} {
  if (raw === null || raw === undefined) {
    return { success: true, data: {} };
  }
  if (typeof raw === 'object') {
    return { success: true, data: raw as Record<string, unknown> };
  }
  if (typeof raw !== 'string') {
    return {
      success: false,
      data: {},
      error: 'Arguments must be a string or object',
    };
  }

  let text = raw.trim();
  if (text === '') {
    return { success: true, data: {} };
  }

  // 1. 去除 Markdown 代码块包裹
  if (text.startsWith('```')) {
    text = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
  }

  // 2. 尝试标准解析
  try {
    const parsed = JSON.parse(text);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
    ) {
      return { success: true, data: parsed as Record<string, unknown> };
    }
    if (Array.isArray(parsed)) {
      return { success: true, data: { items: parsed } };
    }
    return { success: true, data: { value: parsed } };
  } catch (initialErr) {
    // 3. 进入自愈修复管线
    try {
      let repaired = text;

      // 3.1 替换 Python 特殊字面量
      repaired = repaired
        .replace(/:\s*True\b/g, ': true')
        .replace(/:\s*False\b/g, ': false')
        .replace(/:\s*None\b/g, ': null');

      // 3.2 移除尾部多余逗号：, } 或 , ]
      repaired = repaired.replace(/,(\s*[}\]])/g, '$1');

      // 3.3 替换未加双引号的键名：{ name: "..." } 或 , name: "..."
      repaired = repaired.replace(/([{,]\s*)([a-zA-Z0-9_$]+)\s*:/g, '$1"$2":');

      // 3.4 替换单引号为双引号
      repaired = repaired.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"');

      // 3.5 再次尝试解析
      const parsed = JSON.parse(repaired);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed)
      ) {
        return { success: true, data: parsed as Record<string, unknown> };
      }
      if (Array.isArray(parsed)) {
        return { success: true, data: { items: parsed } };
      }
      return { success: true, data: { value: parsed } };
    } catch (_repairErr: unknown) {
      const msg =
        initialErr instanceof Error ? initialErr.message : String(initialErr);
      return {
        success: false,
        data: {},
        error: `JSON parse error: ${msg}`,
      };
    }
  }
}

/**
 * 通用端侧工具注册表类
 */
export class MobileToolRegistry {
  private tools = new Map<string, MobileToolDefinition>();
  private enabledOverrides = new Map<string, boolean>();

  /**
   * 注册单个端侧工具
   */
  register(tool: MobileToolDefinition): void {
    if (!tool || !tool.name) {
      throw new Error('Tool definition must provide a valid non-empty name');
    }
    this.tools.set(tool.name, tool);
  }

  /**
   * 批量注册端侧工具
   */
  registerMany(tools: readonly MobileToolDefinition[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /**
   * 注销指定工具
   */
  unregister(name: string): boolean {
    this.enabledOverrides.delete(name);
    return this.tools.delete(name);
  }

  /**
   * 获取指定名称的工具
   */
  get(name: string): MobileToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * 检查指定工具是否存在
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * 获取所有已注册工具
   */
  getAll(): MobileToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * 清空所有已注册工具与启用覆盖状态
   */
  clear(): void {
    this.tools.clear();
    this.enabledOverrides.clear();
  }

  /**
   * 显式开启工具
   */
  enable(name: string): void {
    this.enabledOverrides.set(name, true);
  }

  /**
   * 显式禁用工具
   */
  disable(name: string): void {
    this.enabledOverrides.set(name, false);
  }

  /**
   * 设置工具的显式开启/禁用状态
   */
  setEnabled(name: string, enabled: boolean): void {
    this.enabledOverrides.set(name, enabled);
  }

  /**
   * 重置指定工具的显式覆盖状态（恢复由工具定义自身的 isEnabled 判定）
   */
  resetEnabledOverride(name: string): void {
    this.enabledOverrides.delete(name);
  }

  /**
   * 判断指定工具是否处于启用状态
   */
  isEnabled(name: string, context?: MobileToolContext): boolean {
    const tool = this.tools.get(name);
    if (!tool) return false;

    // 1. 显式覆盖优先
    if (this.enabledOverrides.has(name)) {
      return this.enabledOverrides.get(name) === true;
    }

    // 2. 工具内置判定
    if (typeof tool.isEnabled === 'function') {
      try {
        return tool.isEnabled(context);
      } catch {
        return true;
      }
    }

    return true;
  }

  /**
   * 获取当前所有处于启用状态的工具列表
   */
  getEnabledTools(context?: MobileToolContext): MobileToolDefinition[] {
    return this.getAll().filter((tool) => this.isEnabled(tool.name, context));
  }

  /**
   * 导出为 OpenAI Function Calling 标准兼容 Schema 数组
   */
  toOpenAiFunctionSchemas(
    context?: MobileToolContext
  ): OpenAiFunctionToolSchema[] {
    const enabledTools = this.getEnabledTools(context);
    return enabledTools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  /**
   * 执行单个端侧工具调用（统一路由分发入口）
   * 内置入参自愈、Aborted 信号联动、硬超时保护与全局异常捕获
   */
  async executeToolCall(
    call: ToolCallInput,
    context: MobileToolContext = {}
  ): Promise<ToolExecutionResult> {
    const toolCallId = call.id || `call_${Date.now()}`;
    const toolName = call.name;

    // 1. 基本参数完整性校验
    if (!toolName) {
      return {
        toolCallId,
        toolName: '',
        ok: false,
        output: JSON.stringify({
          status: 'error',
          error: 'Missing tool name in tool call.',
        }),
        error: 'missing_tool_name',
      };
    }

    // 2. 取消信号前置拦截
    if (context.signal?.aborted) {
      return {
        toolCallId,
        toolName,
        ok: false,
        output: JSON.stringify({
          status: 'aborted',
          error: 'Tool execution cancelled by AbortSignal before start.',
        }),
        error: 'aborted',
      };
    }

    // 3. 查询工具定义
    const tool = this.get(toolName);
    if (!tool) {
      return {
        toolCallId,
        toolName,
        ok: false,
        output: JSON.stringify({
          status: 'error',
          error: `Tool "${toolName}" is not registered in the mobile tool registry.`,
          system_note: `Tool "${toolName}" does not exist. Please check the available tools or respond to the user directly without tool calling.`,
        }),
        error: 'tool_not_found',
      };
    }

    // 4. 检查工具是否启用
    if (!this.isEnabled(toolName, context)) {
      return {
        toolCallId,
        toolName,
        ok: false,
        output: JSON.stringify({
          status: 'error',
          error: `Tool "${toolName}" is currently disabled.`,
          system_note: `Tool "${toolName}" has been disabled. Do not invoke it in this turn.`,
        }),
        error: 'tool_disabled',
      };
    }

    // 5. 参数自愈反序列化
    const parseResult = repairAndParseJsonArguments(call.arguments);
    if (!parseResult.success) {
      return {
        toolCallId,
        toolName,
        ok: false,
        output: JSON.stringify({
          status: 'error',
          error: `Malformed JSON arguments: ${parseResult.error}`,
          raw_arguments: call.arguments,
          system_note:
            'Failed to parse tool arguments as valid JSON. ' +
            'Please retry with strictly valid JSON format conforming to the tool schema.',
        }),
        error: 'malformed_json_arguments',
      };
    }

    // 6. 执行超时与取消保护
    const timeoutMs = tool.timeoutMs ?? 10000;
    let timer: ReturnType<typeof setTimeout> | null = null;

    try {
      const execPromise = tool.execute(parseResult.data, context);

      // 落败兜底（波 1 要点 3）：race 落败（超时/取消先行获胜）后工具
      // 仍可能迟到 reject，无人接收会成 unhandled rejection；预先给
      // 原 promise 挂一条 no-op catch 消费迟到失败。race 订阅的仍是
      // 原 promise，本兜底不改变胜负与结果。
      void execPromise.catch(() => undefined);

      // 执行面包屑（波 1 要点 3）：开始一条、终局一条，进程若在执行
      // 中闪退，落盘面留「有 start 无终局」的悬空调用供波 7 对齐。
      recordToolExecutionBreadcrumb({
        toolName,
        toolCallId,
        stage: 'start',
        atMs: Date.now(),
      });

      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Tool execution timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      });

      const abortPromise = new Promise<never>((_, reject) => {
        if (context.signal) {
          if (context.signal.aborted) {
            reject(new Error('Tool execution cancelled by AbortSignal'));
          } else {
            context.signal.addEventListener(
              'abort',
              () =>
                reject(new Error('Tool execution cancelled by AbortSignal')),
              { once: true }
            );
          }
        }
      });

      const rawResult = await Promise.race([
        execPromise,
        timeoutPromise,
        abortPromise,
      ]);

      if (timer) clearTimeout(timer);

      recordToolExecutionBreadcrumb({
        toolName,
        toolCallId,
        stage: rawResult.ok ? 'success' : 'error',
        atMs: Date.now(),
      });

      return {
        ...rawResult,
        toolCallId,
        toolName,
      };
    } catch (err: unknown) {
      if (timer) clearTimeout(timer);
      const errMsg = err instanceof Error ? err.message : String(err);
      const isTimeout = errMsg.includes('timed out');
      const isAborted =
        errMsg.includes('cancelled') || Boolean(context.signal?.aborted);

      recordToolExecutionBreadcrumb({
        toolName,
        toolCallId,
        stage: isTimeout ? 'timeout' : isAborted ? 'aborted' : 'error',
        atMs: Date.now(),
      });

      return {
        toolCallId,
        toolName,
        ok: false,
        output: JSON.stringify({
          status: isTimeout ? 'timeout' : isAborted ? 'aborted' : 'error',
          error: errMsg,
          system_note: `Tool execution failed: ${errMsg}. Do not retry with identical parameters.`,
        }),
        error: isTimeout
          ? 'timeout'
          : isAborted
            ? 'aborted'
            : 'execution_error',
      };
    }
  }
}

/**
 * 默认端侧工具注册表单例
 */
export const mobileToolRegistry = new MobileToolRegistry();
