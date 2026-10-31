// 账号域网络时序常量（单一真源）：超时与慢网分级提示阈值。
// accountApi 的请求超时与账号页面的分级文案共用本清单，禁止散落魔法数字。

/** 单次云端请求超时（海外鉴权节点的上限兜底） */
export const REQUEST_TIMEOUT_MS = 12_000;

/** 慢网一级阈值：超过后提示「正在连接海外节点」 */
export const SLOW_NET_MS = 3_000;

/** 慢网二级阈值：超过后提示「网络较慢，仍在尝试」 */
export const VERY_SLOW_NET_MS = 8_000;
