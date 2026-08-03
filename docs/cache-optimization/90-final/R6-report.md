# 轮次报告：R6（TS 侧协同与前端收口，P6 + P5 前端面）

## 轮次元信息

- 轮次：R6
- 本轮 Agent 数：8 / 12（T-41、T-42、T-43、T-46、T-47、T-44、T-45、T-48）
- 任务包数：8（T-41~T-48，P6 全量 + P5 前端面）
- 门禁执行结果：**通过**——typecheck 全绿、vitest 相关 59/59、**Playwright e2e 26/26 全绿**（含 cache-metrics 4/4 + cache-telemetry 5/5）
- 日期：2026-08-03

## 一、已完成

| 任务单元 | 文件域                                                                                                                                                 | 改动摘要                                                                                                                                                                                                                                                                                         | 自验证                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| T-41     | `packages/shared-utils/src/cache/`（新）                                                                                                               | R1-R5 规则纯函数：sortToolsByName（码点序禁 localeCompare）、canonicalizeJsonSchema（R2.1-R2.9 递归）、derivePromptCacheKey（码点钳 64 不拆代理对）、parseUsageFromProviderChunk（R4 三级回退+write 链）、computeCacheMetrics（C9 恒等式+null 语义）+ **rust-parity 样例表 35 项复制** + 80 测试 | vitest 103 全绿、typecheck 绿           |
| T-42     | `shared-types/cache-metrics.ts`（新）                                                                                                                  | CacheMetrics（全可选+null 语义）/MessageCacheState/CacheBreakdown/SessionCacheSnapshot；RunCacheStats **re-export 复用**（不重复定义）+ 事件类型导出收口 + 16 测试                                                                                                                               | shared-types 33 全绿                    |
| T-43     | `directFetchBridge.ts`                                                                                                                                 | 降级路径对齐：本地排序/单层 schema/内容哈希键**全部废弃** → 委托 shared-utils R1-R5（C15 非产品 SoT 保持）；prompt_cache_key 条件注入 + 12 测试                                                                                                                                                  | vitest 12/12、typecheck 绿              |
| T-46     | components 骨架（新×2 + 挂载×2）                                                                                                                       | CacheMetricsBadge（testid `cache-metrics-badge`，null 隐藏非 0%）、SessionCacheStatsPanel（testid `session-cache-stats`）+ 挂载 + 7 测试 + P6 文档核销节                                                                                                                                         | 41 测试全过                             |
| T-47     | sessionEventHydrate/useStreamCallbacks/messageHandlers/streamState/store                                                                               | run 级 4D 透出（RunUsage cache 字段）、2D→4D 成本估算回退、message-end 保留 metadata.usage 派生缓存指标、TokenUsageState 扩展、useRustCoreStore DEAD 标注 + 17 测试                                                                                                                              | vitest 141/141                          |
| T-44     | cache-rules.test.ts、eventParser.test.ts                                                                                                               | **rust-parity 35/35 双侧核对闭环**（1 处样例输入按规则真源对齐 TS 侧，Rust 零改动）；eventParser 补 message-end usage + 未知字段容忍 + 6 测试                                                                                                                                                    | 139 用例全绿                            |
| T-45     | mock-engine.ts（fixture 追加）、cache-metrics.spec.ts（新）、bench-definitions.ts、README                                                              | 4 个缓存 fixture（cacheUsageRunEvents/legacyNoUsage/zeroCacheRead/cacheStatsUpdatedEvent）+ e2e 4 用例 + 基准 2 项 + 登记                                                                                                                                                                        | ①④ 待 T-48 接线后转绿（已由 T-48 验证） |
| T-48     | components 接线/cacheEventsStore（新）/cacheEventHandlers（新）/dispatch 真实接线/pricingStore 三级费率/SettingsUsageTab/cache-telemetry.spec.ts（新） | 消息级链路（事件→store→badge，含 Included 形态 inputTotal 修正与 C15 确为 0 区分）、run 级面板（三事件 store+累计+冷缓存 tick+浪费预警条）、**三级费率**（CATALOG_CACHE_RATES 28 模型表+运行时 catalog 快照覆盖）、P5 e2e 5 用例 + playwright.config.ts 冲突修复（G15c port+url 互斥）           | vitest 59/59；**Playwright 26/26 全绿** |

提交记录：`f5e959be`（波1a）、`2e1586ea`（波1b）、`a5b44790`（波2）。

## 二、门禁执行结果

- `npm run typecheck`：全绿（7 工程）
- vitest：shared-utils cache 103、eventParser 29、stressFuzzing 7、T-48 相关 59/59
- **Playwright e2e：26/26 全绿**（cache-metrics.spec 4/4 + cache-telemetry.spec 5/5 + 既有 17 回归）
- 全量 vitest 的 31 文件失败均为既有环境问题（classic JSX 组件测试缺 React import、taskkill/wal flake），**无本方案新增失败**

## 三、发现的问题与主 Agent 裁决

| #     | 问题                                                                                                         | 裁决/处置                                                                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| R6-D1 | T-45 上报 error-path e2e 全量失败（boot 阶段 chat-input 5s 超时）                                            | T-48 修复 playwright.config.ts（G15c 引入的 port+url 互斥冲突）后全量转绿；判定为配置冲突非回归                                                     |
| R6-D2 | T-45 上报 fixture 契约（metadata.usage camelCase）与 shared-utils parseUsageFromMetadata（snake_case）不一致 | T-48 以 fixture 契约（camelCase）为准修正本地 computeCacheMetricsFromUsage（Included 兜底 inputTotal=promptTokens）；spec 按登记契约 75% 钉死已验证 |
| R6-D3 | T-48 发现 store 写入经 sessionsById 被 autoIndex 重建覆盖                                                    | 修复：经 canonical sessions[] 写入（e2e 实测发现并修复）                                                                                            |
| R6-D4 | T-44 登记：R3 键派生双侧无同一张样例表（TS 自测 vs Rust cache.rs 自有测试）                                  | 登记待 R7 复核（不动 Rust）                                                                                                                         |
| R6-D5 | T-48 移交：消息级 cacheMetrics 持久化回放面（sessionRustDb usage_json 回读→徽标回放）                        | 登记为 R7 复核项（非阻塞）                                                                                                                          |

## 四、输出为下一轮输入（R7）

1. **T-40 剩余段合并**（R5-D3 延续）：core_run_commands.rs 4 处接线（producer 装配/收口落库/run_usage 真实实现/CoreRunState db 字段）——并行阵营 I3 仍在编辑该文件，R7 用补丁技术（`git apply --cached` 只暂存我方 hunk）合并
2. R7 全量门禁：cargo test --workspace、typecheck、vitest 全量、playwright 全量、bench（bench-definitions.test.ts 结构测试缺口）
3. A1/A2/A3 遗留待办核销（§2.3 表 15 项逐条核对）
4. comparison.md "已落地"标记复核
5. R6-D4/D5 复核项
