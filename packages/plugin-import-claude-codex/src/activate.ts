/**
 * 插件激活入口（E2 运行时调用 activate(api)）。
 *
 * 结构契约：api 参数采用最小结构类型（observe/log），与 plugin-sdk 的
 * PluginAPI 方法签名兼容——E2 的 PluginAPI 实例结构上满足本接口。
 * 第一版只注册 session.start 的 observe 观察（使用说明语义占位）：
 * 不注册工具执行器（manifest 只声明工具名；执行体为包内纯函数，
 * 由宿主侧运行时按工具名调用——依赖全注入原则，遵守最小权限面）。
 */

import { manifest } from './manifest';

/** 激活期可用的最小插件 API（结构契约，与 plugin-sdk PluginAPI 兼容）。 */
export interface PluginActivateApi {
  /**
   * 注册 observe 处理器（容错并行，失败吞掉）。
   * 仅 session.start 在本插件声明面内。
   */
  observe(
    event: 'session.start',
    handler: (payload: { sessionId?: string }) => void | Promise<void>,
  ): unknown;
  /** 插件日志（宿主注入 logger，自动带 pluginId tag）。 */
  log(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    metadata?: Record<string, unknown>,
  ): void;
}

/** 会话开始时的注入说明文案（kimi-datasource SKILL.md 语义的 v1 占位）。 */
export const SESSION_START_USAGE_NOTE =
  'Claude/Codex 导入工具可用：parse-claude-code-jsonl / parse-codex-rollout-jsonl ' +
  '（入参 content 为 JSONL 文本，出参为结构化会话载荷）';

/**
 * 插件激活：注册 session.start observe 观察。
 * 使用说明以日志注入（第一代插件不做 UI/上下文改写回调）。
 */
export function activate(api: PluginActivateApi): void {
  api.observe('session.start', (payload) => {
    api.log('info', `${manifest.id}：${SESSION_START_USAGE_NOTE}`, {
      sessionId: payload?.sessionId ?? '',
    });
  });
}
