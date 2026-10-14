/**
 * apps/crish-desktop/src/api/compositeSessionKeys.ts
 *
 * 会话维度复合键唯一权威（SSOT）。
 *
 * ## 为什么存在
 * 历史上 `${sessionId}::${messageId}` 形状的复合键在 streamTextBatcher /
 * streamingStoreCore / streamDirectDomEngine / dualLatchProtocol 等 4+ 个
 * 文件里各自实现了一遍（构造、前缀清理、反解各一份），每新增一个使用方
 * 都要在 check-provider-single-track.mjs 的 D5_WHITELIST 登记一次（打地鼠）。
 * 本模块把**形状契约**收敛为唯一定义：构造 / 反解 / 前缀清理三件套，
 * 各域经具名函数引用；D5 门禁据此以「身份形状黑名单」判定——
 * 含 provider/model/profile 语义变量的 `::` 拼接才会被判为身份键违规。
 *
 * ## 与 modelRefKey 的边界（D5 契约）
 * - 模型身份键唯一权威 = modelRefKey（JSON 二元组，modelsCatalogTypes.ts），
 *   严禁 `${providerId}::${modelId}` 形状；
 * - 本模块的键全部是**会话/消息/工具/子代理维度**的运行时索引键，
 *   不承载模型身份，不进 localStorage（纯内存 Map 索引）。
 */

/** 分隔符（本模块唯一权威；各域不得自拼字面量） */
export const COMPOSITE_KEY_SEPARATOR = '::';

/** 空会话兜底标识（dualLatch / streamDirectDom 既有语义） */
export const DEFAULT_SESSION_ID = '__default__';

/**
 * 会话 + 消息复合键（纯拼接；等价原 streamStoreKey / streamBatchKey）。
 * 注意：不做空值归一——空 sessionId 产出 `::messageId` 形状，
 * 与既有 streamTextBatcher/streamingStoreCore 行为逐字节一致。
 */
export function sessionMessageKey(
  sessionId: string,
  messageId: string
): string {
  return `${sessionId}${COMPOSITE_KEY_SEPARATOR}${messageId}`;
}

/**
 * 会话 + 消息复合键（空会话归一为 '__default__'；
 * 等价原 makeSlotKey / makeDualLatchKey 的 `sessionId || '__default__'` 语义）。
 */
export function sessionMessageKeyOrDefault(
  sessionId: string,
  messageId: string
): string {
  return sessionMessageKey(sessionId || DEFAULT_SESSION_ID, messageId);
}

/** 会话前缀（`${sessionId}::`；用于 startsWith 批量清理/匹配） */
export function sessionMessageKeyPrefix(sessionId: string): string {
  return `${sessionId}${COMPOSITE_KEY_SEPARATOR}`;
}

/** 会话 + 消息 + 工具三段复合键（等价原 streamToolBatchKey） */
export function sessionMessageToolKey(
  sessionId: string,
  messageId: string,
  toolId: string
): string {
  return `${sessionId}${COMPOSITE_KEY_SEPARATOR}${messageId}${COMPOSITE_KEY_SEPARATOR}${toolId}`;
}

export interface ParsedSessionMessageToolKey {
  sessionId: string;
  messageId: string;
  toolId: string;
}

/**
 * 解析三段工具复合键（首个 `::` 分离会话，最后一个 `::` 分离工具——
 * messageId 允许含 `::` 的调用方语义保留）；缺任一段返回 null。
 * 等价原 parseStreamToolBatchKey。
 */
export function parseSessionMessageToolKey(
  key: string
): ParsedSessionMessageToolKey | null {
  const first = key.indexOf(COMPOSITE_KEY_SEPARATOR);
  const last = key.lastIndexOf(COMPOSITE_KEY_SEPARATOR);
  if (first < 0 || last <= first) return null;
  const sessionId = key.slice(0, first);
  const messageId = key.slice(first + COMPOSITE_KEY_SEPARATOR.length, last);
  const toolId = key.slice(last + COMPOSITE_KEY_SEPARATOR.length);
  if (!sessionId || !messageId || !toolId) return null;
  return { sessionId, messageId, toolId };
}

/** 子代理运行时增量键（sessionId::agentId；子代理维度聚合索引） */
export function subagentDeltaKey(sessionId: string, agentId: string): string {
  return `${sessionId}${COMPOSITE_KEY_SEPARATOR}${agentId}`;
}
