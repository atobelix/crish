/**
 * ExtensionRegistry — 扩展注册中心
 *
 * 为未来的插件系统奠基。第三方可以通过 Extension 注册工具、Hook、
 * UI 组件和命令，无需修改核心代码。
 *
 * 设计原则：
 * 1. 注册/注销是幂等的 — 重复注册同名扩展会替换旧版本
 * 2. collectHooks() 合并所有扩展的 hooks，按注册顺序优先
 * 3. collectTools() 收集所有扩展的工具
 * 4. 如果没有扩展注册，collectHooks() 返回空对象，collectTools() 返回空数组
 */

import type { JsonObject, ToolOutput } from "@crish/shared-types";
import type { AgentTool } from "../types";
import type { ToolDefinition } from "../tools/tool-definition";
import type {
  AgentHooks as HooksType,
  Extension as ExtensionType,
  UIComponentRegistration,
  CommandRegistration,
} from "./hook-types";

// ─── ExtensionRegistry ────────────────────────────────────

export class ExtensionRegistry {
  private readonly extensions = new Map<string, ExtensionType>();

  /**
   * 注册扩展
   *
   * 如果同名扩展已存在，会替换为新版本。
   *
   * @param extension - 要注册的扩展
   */
  register(extension: ExtensionType): void {
    this.extensions.set(extension.name, extension);
  }

  /**
   * 注销扩展
   *
   * @param name - 要注销的扩展名称
   */
  unregister(name: string): void {
    this.extensions.delete(name);
  }

  /**
   * 列出所有已注册的扩展
   */
  listExtensions(): ExtensionType[] {
    return [...this.extensions.values()];
  }

  /**
   * 合并所有扩展的 hooks
   *
   * 按注册顺序合并。对于同一个 hook 点，多个扩展的 hook
   * 会形成管线：先注册的扩展先执行。
   *
   * 返回的 AgentHooks 中每个 hook 点是一个组合函数：
   * - beforeToolCall: 按顺序执行，如果任何一个 block=true，则阻止
   * - afterToolCall: 按顺序执行，modifiedOutput 逐层传递
   * - shouldStopAfterTurn: 如果任何一个返回 true，则停止
   * - prepareNextTurn: 按顺序执行，结果逐层合并
   * - onError: 按顺序执行，返回第一个非 undefined 结果
   *
   * 如果没有扩展注册 hooks，返回空对象。
   */
  collectHooks(): Partial<HooksType> {
    const extensionsWithHooks = [...this.extensions.values()]
      .filter((ext) => ext.hooks && Object.keys(ext.hooks).length > 0);

    if (extensionsWithHooks.length === 0) {
      return {};
    }

    // 组合 beforeToolCall
    const beforeHookEntries = extensionsWithHooks
      .filter((ext) => ext.hooks!.beforeToolCall)
      .map((ext) => ext.hooks!.beforeToolCall!);

    // 组合 afterToolCall
    const afterHookEntries = extensionsWithHooks
      .filter((ext) => ext.hooks!.afterToolCall)
      .map((ext) => ext.hooks!.afterToolCall!);

    // 组合 shouldStopAfterTurn
    const shouldStopEntries = extensionsWithHooks
      .filter((ext) => ext.hooks!.shouldStopAfterTurn)
      .map((ext) => ext.hooks!.shouldStopAfterTurn!);

    // 组合 prepareNextTurn
    const prepareNextTurnEntries = extensionsWithHooks
      .filter((ext) => ext.hooks!.prepareNextTurn)
      .map((ext) => ext.hooks!.prepareNextTurn!);

    // 组合 onError
    const onErrorEntries = extensionsWithHooks
      .filter((ext) => ext.hooks!.onError)
      .map((ext) => ext.hooks!.onError!);

    const composedHooks: Partial<HooksType> = {};

    if (beforeHookEntries.length > 0) {
      composedHooks.beforeToolCall = async (ctx) => {
        let block = false;
        let reason: string | undefined;
        let modifiedInput: JsonObject | undefined;

        for (const hook of beforeHookEntries) {
          const result = await hook(ctx);
          if (result.block) {
            block = true;
            reason = result.reason;
            break; // 一旦阻止，不再执行后续 hook
          }
          if (result.modifiedInput) {
            modifiedInput = result.modifiedInput;
            ctx = { ...ctx, input: modifiedInput }; // 传递修改后的输入给下一个 hook
          }
        }

        return { block, reason, modifiedInput };
      };
    }

    if (afterHookEntries.length > 0) {
      composedHooks.afterToolCall = async (ctx) => {
        let modifiedOutput: ToolOutput | undefined;
        let terminate = false;
        let terminateReason: string | undefined;

        for (const hook of afterHookEntries) {
          const hookCtx = modifiedOutput ? { ...ctx, output: modifiedOutput } : ctx;
          const result = await hook(hookCtx);
          if (result.modifiedOutput) {
            modifiedOutput = result.modifiedOutput;
          }
          if (result.terminate) {
            terminate = true;
            terminateReason = result.terminateReason;
            break; // 一旦终止，不再执行后续 hook
          }
        }

        return { modifiedOutput, terminate, terminateReason };
      };
    }

    if (shouldStopEntries.length > 0) {
      composedHooks.shouldStopAfterTurn = (ctx) => {
        for (const hook of shouldStopEntries) {
          if (hook(ctx)) return true; // 任何一个返回 true，则停止
        }
        return false;
      };
    }

    if (prepareNextTurnEntries.length > 0) {
      composedHooks.prepareNextTurn = async (ctx) => {
        let model: string | undefined;
        let promptOverride: string | undefined;

        for (const hook of prepareNextTurnEntries) {
          const result = await hook(ctx);
          if (result.model) model = result.model;
          if (result.promptOverride) promptOverride = result.promptOverride;
        }

        return { model, promptOverride };
      };
    }

    if (onErrorEntries.length > 0) {
      composedHooks.onError = (error, ctx) => {
        for (const hook of onErrorEntries) {
          const result = hook(error, ctx);
          if (result) return result; // 返回第一个有效策略
        }
        return "abort" as const; // 默认策略
      };
    }

    return composedHooks;
  }

  /**
   * 收集所有扩展的工具定义
   */
  collectTools(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const extension of this.extensions.values()) {
      if (extension.tools) {
        tools.push(...extension.tools);
      }
    }
    return tools;
  }

  /**
   * 收集所有扩展的 UI 组件
   */
  collectUIComponents(): UIComponentRegistration[] {
    const components: UIComponentRegistration[] = [];
    for (const extension of this.extensions.values()) {
      if (extension.uiComponents) {
        components.push(...extension.uiComponents);
      }
    }
    return components;
  }

  /**
   * 收集所有扩展的命令
   */
  collectCommands(): CommandRegistration[] {
    const commands: CommandRegistration[] = [];
    for (const extension of this.extensions.values()) {
      if (extension.commands) {
        commands.push(...extension.commands);
      }
    }
    return commands;
  }

  /**
   * 查找指定名称的扩展
   */
  getExtension(name: string): ExtensionType | undefined {
    return this.extensions.get(name);
  }
}