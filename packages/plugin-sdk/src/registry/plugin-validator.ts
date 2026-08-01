// packages/plugin-sdk/src/registry/plugin-validator.ts
// 约束来源：ROUND-08-plugin-sdk.md §3.5 + 禁令 15/16/17（能力清单比对）
//
// 系统化设计：
// - Validator 职责单一：比对 activate(api) 实际注册的能力 vs manifest 声明清单
// - 不直接调用 activate（由 Loader 通过 Proxy 收集注册项后传入）
// - 纯函数校验，返回错误清单，不抛错（Loader 决定是否拒绝）
// - 错误码语义化，供测试断言与 UI 诊断

import type { PluginManifest, HookEventName } from '../manifest';

/** 插件校验结果 */
export interface PluginValidationResult {
  readonly valid: boolean;
  readonly errors: readonly PluginValidationError[];
}

/** 插件校验错误项 */
export interface PluginValidationError {
  readonly code:
    | 'manifest-invalid'
    | 'activate-registered-undeclared-hook'
    | 'activate-registered-undeclared-tool'
    | 'activate-registered-undeclared-mcp'
    | 'activate-permission-not-declared';
  readonly message: string;
  readonly detail?: unknown;
}

/**
 * activate(api) 期间通过 Proxy HookAPI 收集的注册项。
 *
 * Loader 在调用 activate 前构造 Proxy 包装 PluginAPI，
 * 拦截 observe/on/registerTool/registerMcpServer 调用并记录。
 * activate 完成后，Validator 比对 recordings vs manifest.declared* 清单。
 */
export interface RecordedRegistrations {
  /** activate 中通过 api.observe/on 注册的钩子事件名 */
  readonly hooks: readonly HookEventName[];
  /** activate 中通过 api.registerTool 注册的工具名 */
  readonly tools: readonly string[];
  /** activate 中通过 api.registerMcpServer 注册的 MCP 服务器名 */
  readonly mcpServers: readonly string[];
}

/**
 * 空注册记录（供 Loader 初始化）。
 */
export function createEmptyRecordings(): RecordedRegistrations {
  return { hooks: [], tools: [], mcpServers: [] };
}

/**
 * 插件校验器（禁令 15/16/17 能力清单比对）。
 *
 * 校验规则：
 * 1. activate 中注册的 hook 必须在 manifest.declaredHooks 内
 * 2. activate 中注册的 tool 必须在 manifest.declaredTools 内
 * 3. activate 中注册的 mcpServer 必须在 manifest.declaredMcpServers 内
 *
 * manifest 结构校验由 8-A 的 validateManifest 负责（discover 阶段已执行），
 * 此处不重复结构校验，仅做能力清单比对。
 */
export class PluginValidator {
  /**
   * 校验 activate 实际注册的能力是否在 manifest 声明清单内。
   *
   * @param manifest 插件清单
   * @param recordings activate 期间通过 Proxy 收集的注册项
   * @returns 校验结果（valid=true 表示全部注册项都在声明清单内）
   */
  validate(
    manifest: PluginManifest,
    recordings: RecordedRegistrations,
  ): PluginValidationResult {
    const errors: PluginValidationError[] = [];

    // 比对 hooks：activate 注册的每个 hook 须在 declaredHooks 内
    for (const hook of recordings.hooks) {
      if (!manifest.declaredHooks.includes(hook)) {
        errors.push({
          code: 'activate-registered-undeclared-hook',
          message: `activate registered hook '${hook}' not in manifest.declaredHooks ` +
            `(declared: [${manifest.declaredHooks.join(', ')}])`,
          detail: { hook, declared: manifest.declaredHooks },
        });
      }
    }

    // 比对 tools：activate 注册的每个 tool 须在 declaredTools 内
    for (const tool of recordings.tools) {
      if (!manifest.declaredTools.includes(tool)) {
        errors.push({
          code: 'activate-registered-undeclared-tool',
          message: `activate registered tool '${tool}' not in manifest.declaredTools ` +
            `(declared: [${manifest.declaredTools.join(', ')}])`,
          detail: { tool, declared: manifest.declaredTools },
        });
      }
    }

    // 比对 mcpServers：activate 注册的每个 mcpServer 须在 declaredMcpServers 内
    for (const mcp of recordings.mcpServers) {
      if (!manifest.declaredMcpServers.includes(mcp)) {
        errors.push({
          code: 'activate-registered-undeclared-mcp',
          message: `activate registered mcp server '${mcp}' not in manifest.declaredMcpServers ` +
            `(declared: [${manifest.declaredMcpServers.join(', ')}])`,
          detail: { mcp, declared: manifest.declaredMcpServers },
        });
      }
    }

    return { valid: errors.length === 0, errors };
  }
}
