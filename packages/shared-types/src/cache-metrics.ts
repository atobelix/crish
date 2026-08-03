// 缓存计量契约类型（P6 S2 §3.3.1；T-42 交付）
//
// 与 `./events` 中 `RunCacheStats`（T-38 已同步，Rust `RunCacheStats`
// camelCase 镜像）的关系：本文件 **re-export 复用** `RunCacheStats`，
// 不重复定义 run 级聚合形状（该形状以 events.ts 为唯一定义）；本文件只定义
// 消息级/展示级派生契约（CacheUsage / CacheBreakdown / CacheMetrics /
// SessionCacheSnapshot / UsageMetadataShape / MessageCacheState），
// 与 Rust 侧 `CacheBreakdown`（agent-provider events.rs，camelCase）对齐。
//
// 口径约束（C9）：`inputTotal = miss + read + write`；
// `hitRatio = cacheRead / inputTotal`——与 P2 `CacheBreakdown` /
// P5 `CacheBreakdownMath::derive` / shared-utils R4 同源，禁止另算一套。

export type { RunCacheStats } from './events';

/** 缓存计量原始面（P6 §3.3.1：`metadata.usage` 挂载点形状，与
 * `ProviderUsage`（tool.ts）对齐；P2 在 Rust 侧补齐字段后双向一致；
 * `cacheMissTokens` 为 R4 解析链的直报值/推导值，区别于 ProviderUsage） */
export interface CacheUsage {
  promptTokens?: number;
  completionTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheMissTokens?: number;
  reasoningTokens?: number;
}

/** 归一化派生缓存拆分（Rust `CacheBreakdown` camelCase 镜像；
 * 恒等式 `inputTotal = read + write + miss`，C9 口径唯一真源） */
export interface CacheBreakdown {
  /** 缓存命中读取 */
  read?: number;
  /** 缓存写入 */
  write?: number;
  /** 未缓存输入（= 计费输入；服务端直报优先，否则按口径推导） */
  miss?: number;
  /** 归一化输入总量 = miss + read + write */
  inputTotal?: number;
}

/** 会话累计快照（P5 `cache-stats-updated` 事件就绪后填充；
 * P6 阶段恒 null。P6 §3.3.1 原稿字段名 `hitRate` 随顶层统一为
 * `hitRatio`，口径不变：read / inputTotal） */
export interface SessionCacheSnapshot {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  inputTokens: number;
  hitRatio: number;
}

/**
 * 派生缓存指标（P6 §3.3.1；字段与 Rust `RunCacheStats` camelCase 对齐，全可选）。
 *
 * null 语义（P6 §3.6.1，C15）：`null` = 未上报/无可展示数据 → 渲染层**隐藏**
 * 而非显示 0%（0% 会误导——可能只是厂商未上报）；`0` 仅表示"确已上报且为 0"，
 * 两种状态必须可区分（`hitRatio: null` vs `hitRatio: 0`）。
 *
 * 字段名说明：`hitRatio`/`writeRatio` 为与 Rust `RunCacheStats` 对齐的正式名
 * （C9 口径：hitRatio = cacheRead / inputTotal，inputTotal = miss + read + write）；
 * `hitRate` 为 P6 §3.3.1 原稿与 shared-utils `computeCacheMetrics`（T-41）使用的
 * 兼容别名（同口径），消费方优先读 `hitRatio`，缺失时回退 `hitRate`。
 */
export interface CacheMetrics {
  /** 缓存命中读取（R4 read） */
  cacheReadTokens?: number;
  /** 缓存写入（R4 write） */
  cacheWriteTokens?: number;
  /** 缓存未命中输入（R4 miss；DeepSeek 顶层直报优先，否则按口径推导） */
  cacheMissTokens?: number;
  /** 归一化输入总量 = miss + read + write（C9 恒等式） */
  inputTotal?: number;
  /** 命中率 = cacheRead / inputTotal；null = 未上报 → 隐藏（非 0% 误导） */
  hitRatio?: number | null;
  /** 兼容别名（P6 §3.3.1 原稿 / T-41 `computeCacheMetrics` 字段名，同口径） */
  hitRate?: number | null;
  /** 写入占比 = cacheWrite / inputTotal；null = 未上报 */
  writeRatio?: number | null;
  /** 本 run 审计出的浪费量（对齐 RunCacheStats.missedTokens） */
  missedTokens?: number;
  /** 有真实 usage 的样本数（0 = 无样本，隐藏而非 0%） */
  sampleCount?: number;
  /** 缓存温暖截止（now + TTL）；null = 无 TTL 数据（跳过冷缓存提示） */
  warmUntilMs?: number | null;
  /** 会话累计快照（P5 `cache-stats-updated` 就绪后填充；P6 阶段恒 null） */
  session?: SessionCacheSnapshot | null;
  /** 省钱估算（消费 pricingStore.estimateSavingsUsd）；null 时隐藏金额（0 与 null 区分） */
  savingsUsd?: number | null;
}

/** `AgentMessage.metadata` 下的 usage 挂载点（Rust 侧
 * `build_assistant_message` 已产出 `metadata.usage`） */
export interface UsageMetadataShape {
  usage?: CacheUsage;
}

/** 消息级缓存状态（UI store 消息上挂载，P6 只定义类型，不强制写 store） */
export interface MessageCacheState {
  /** null = 老数据/无 cache 字段/解析失败 → 不渲染（隐藏而非 0%，C15） */
  metrics: CacheMetrics | null;
  /** 数据来源：引擎 message-end / 降级直连 / 未知（老数据） */
  source: 'engine-message-end' | 'degraded-direct' | null;
}
