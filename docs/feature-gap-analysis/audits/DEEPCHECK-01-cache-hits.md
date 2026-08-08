# DEEPCHECK-01 缓存命中域疑点深查报告

- 日期：2026-08-09
- 范围：10 项疑点逐项读码验证（历史回流前缀漂移 / tieredPricing / peakPricing / TTL 30m / models.dev / DeepSeek v4-pro Responses / 真实 API 测试 / ToolUpdate 实时性 / catalog 文档一致性 / C14 摘要缓存隔离）
- 性质：只读分析，未改动任何代码

## 结论速览

| # | 疑点 | 结论 | 影响等级 | 关键证据 |
|---|------|------|----------|----------|
| 1 | 历史回流前缀漂移（100 条尾部窗口） | **成立** | 🔴 高 | ConnectionLifecycle.ts:59,88-123；core_run_commands.rs:91,607-611,2390 |
| 2 | tieredPricing 消费面 | **成立**（只存未消费） | 🟡 中 | catalog.json 28 处；catalog.rs:90 无查询函数；pricingStore.ts:40-41 |
| 3 | peakPricingSchedule 消费面 | **成立**（无消费方） | 🟢 低（待接线） | catalog.json:446-451；catalog.rs:85-87 仅 serde/测试 |
| 4 | TTL 30m wire 层 | **部分成立** | 🟢 低 | ttl.rs:97-99；request/cache.rs:39-45,396-398,430-433 |
| 5 | models.dev 远程源接入 | **成立**（未接入） | 🟡 中 | catalog.rs:291-295 include_str!；catalog_commands.rs 仅扫描上送 |
| 6 | DeepSeek v4-pro Responses 刷新 | **不成立**（现状正确） | 🟢 低 | 官方文档实抓（2026-08-09）仍未上线；catalog.json:495,501 |
| 7 | 真实 API 探测测试 | **不成立**（无） | 🟡 中 | #[ignore] 9 处全为压力测试；无 env 门控 API 测试 |
| 8 | ToolUpdate 实时性 | **不成立**（已是批事件统一出站） | 🟢 低 | executing_tools.rs:82-88 |
| 9 | catalog 与文档一致性 | **不成立**（抽查 5 条一致） | 🟢 低 | 04-master-model-list.md 逐条对照 |
| 10 | C14 摘要缓存隔离 | **部分成立**（策略就绪、实现未落） | 🟡 中 | cache.rs:305-312；engine.rs:709-711 |

统计：成立 4 / 部分 2 / 不成立 4。最严重 = **#1 历史回流前缀漂移**（跨 run 自动前缀缓存系统性失配）。

---

## 1. 历史回流前缀漂移（重点项，详细分析）

### 1a. 截断语义确认：前端尾部窗口 ✅

`apps/crish-desktop/src/api/chat-bridge/ConnectionLifecycle.ts:59`：

```ts
/** 历史回流长度上限：最近 N 条（T-31；窗口内预算兜底在引擎侧，前端只截尾部） */
export const HISTORY_CAP = 100;
```

- `buildHistoryMessages`（:88-123）从会话存储读全部完成态 user/assistant 消息后执行 `history.slice(Math.max(0, history.length - cap))`（:121）——**纯尾部窗口**，取最近 100 条。
- 组装点在每次 run 派发前（:451-456），即**每轮 run 都重新取尾部 100 条**；消息总数超过 100 后，每完成一轮 run 窗口就向前滑动（丢最老 N 条、添新 N 条），跨 run 请求前缀整体改变。
- 前端 history 恒优先于引擎缓存（resolve_history_source，core_run_commands.rs:888-896：Frontend 非空即用 Frontend），故滑窗行为在运行期恒生效。

### 1b. Rust 侧同样尾部截断 ✅

- `SessionHistoryCache::store`（apps/agent-workbench/src-tauri/src/core_run_commands.rs:607-611）：`messages.drain(..messages.len() - keep)`，`max_messages = SESSION_HISTORY_MAX_MESSAGES = 200`（:91）——尾部保留最近 200 条，同样滑动。
- 写入时机：每 run 收口原子替换（:2390 `state.session_history.store(...)`）。
- 前端 100 与引擎 200 **双卡不一致**：引擎缓存只在前端 history 为空/未传时才回退（:3241-3256），正常运行路径前端 100 条窗口生效，引擎 200 条窗口不生效。
- hydrate.rs（crates/session-loop/src/hydrate.rs）本身**无条数截断**，只做尾部 user 收尾约束（:289-294）；截断全部发生在壳层/前端，水合层只是消费者。

### 1c. 影响量化

| 维度 | 数值 |
|------|------|
| 滑窗触发点 | 会话消息 > 100 条（前端）；典型 agentic 会话 2-4 轮即达（每轮 10-40 条消息） |
| 滑动量 | = 每 run 新增消息数（10-40 条/轮），**每轮都滑** |
| 失配机制 | DeepSeek/GLM/Gemini 自动前缀缓存按"当前请求前缀 vs 历史请求前缀"字节匹配；滑窗后新请求开头 = 旧窗口**中部**消息，该前缀从未作为任何请求的前缀出现过 → 整段缓存 miss + 全量重写 |
| 单轮成本（deepseek-v4-flash） | 100 条含工具结果 ≈ 30K-100K token；未命中输入价 $0.14/1M → 每轮额外 $0.004-0.014（读价仅 $0.0028，命中价差 50 倍，全 miss 即放大 50 倍） |
| 会话生命周期累计 | 会话越长亏损越大；且**每轮都重写**，非一次性 |
| 例外 | Anthropic 显式断点（4 个断点锚定 tools/system/尾部消息）大部分锚点逐轮稳定，滑窗损伤有限；OpenAI/Grok/Kimi Key 机制同受前缀失配影响 |
| 兜底为何不救 | compaction 是"唯一前缀重写点"（hydrate.rs:309-311），但 1M 上下文模型（deepseek-v4-flash contextWindow=1M）在真实会话中几乎不触发压缩（handlers/mod.rs:306-313 `should_compact` 按窗口比例判定）——压缩兜底形同虚设，滑窗才是实际截断机制 |

### 1d. 修复方向评估（建议，不实现）

按优先级：

1. **统一到 token 预算 + compaction 稳定锚点（首选，架构级）**
   废除按条数滑窗：前端 HISTORY_CAP / 引擎 200 条双卡合并为"token 预算"（如 200K），超预算先走 compaction——L2 摘要 stub 带固定 block id（`compacted-summary-{gen}-{fold}`），stub 前内容逐轮稳定、stub 后增量 append-only，前缀字节稳定，自动缓存命中最大化。这正是 P4 已规划但未对 1M 窗口模型生效的路径，缺口在"压缩阈值按 token 预算而非窗口比例"。
2. **稳定头部锚点（无 compaction 时的过渡）**
   截断保留头部 N 条（首 user + 首个工具轮）+ 尾部最近 N 条，中间段才允许丢——保证请求前缀（头部）跨 run 字节稳定，失配点收敛到尾部增量。
3. **只截最老 tool result（最后手段）**
   窗口超限时仅把最老 tool result 的 output 替换为占位/截断文本，user/assistant 骨架与 tool call 保留——失配面从"整窗滑动"缩小为"单消息内容变更"（任一字节变更仍是缓存重写点，但重写面小一个数量级）。
4. 配套：`resolve_history_source` 应优先用引擎缓存（Cache）而非前端滑窗载荷，消除 100/200 双卡不一致；SessionHistoryCache 的 `ensure_safe_prefix` 已保证首条 user 的协议合法性，可在其基础上扩展锚点保留。

## 2. tieredPricing 消费面：只存未消费（成立）

- 数据面：catalog.json 共 28 处 `tieredPricing`（GLM CNY 32K+ 档如 glm-5-cny 6.0/22.0/1.5、Gemini 200K+ 2x 如 gemini-3-1-pro-preview 4.0/18.0/0.4、gpt-5.6-sol 272K 档 10.0/45.0/1.0/12.5 等）。
- Rust 查询面：catalog.rs 定义字段（:90）+ `TieredPriceTier` 结构（:168-187），**没有任何运行时查询函数**消费 tiered_pricing（对照四价 `input_price_for` 等 :355-393，其生产调用方为零——全库 grep 仅测试引用）。`apply_override_item` 白名单（:611-622）也不含 tieredPricing 覆盖。
- 前端：pricingStore.ts:40-41 明文"长度分档（tieredPricing）不入前端：估算统一按基础四价（首档），档位匹配归 P5/服务端 catalog 层"（另 :121、:1396 重申）。
- 影响：长上下文场景成本被低估（Gemini 3.1 Pro >200K 全 token 2x、gpt-5.6 >272K 2x/1.5x 未体现）；属"数据先行、P5 待接线"，非计算错误。

## 3. peakPricingSchedule 消费面：无消费方（成立）

- 数据：catalog.json deepseek v4-flash（:446-452）与 v4-pro（:482-488）各带 `peakPricing2x:true` + 时段（09:00-12:00 / 14:00-18:00，Asia/Shanghai，effectiveFrom=null 待公告）。
- Rust：catalog.rs:85-87 字段 + 单测（:1151-1222），**零运行时消费**。
- TS：全 apps 无 peakPricing/峰谷 命中。
- 影响：当前无价格计算引擎（P5 未实现），不存在"峰谷时段算错"；风险在 P5 落地时峰谷 2x 易被遗漏。effectiveFrom=null 状态本身正确。

## 4. TTL 30m wire 层：档位正确、退化路径存在但当前不触发（部分成立）

- `CacheTtl::HalfHour` 已定义（models/ttl.rs:20 re-export behavior.rs；as_str "30m" :28-35）；gpt-5.6 系路由到 HalfHour（ttl.rs:97-99，1800s 测试钉死 :131）。
- wire 层 `TtlBucket` 仅 5m/1h 双桶（request/cache.rs:39-45），`cache_control_for_ttl` 只映射这两个值（:881-886）。
- 处理路径正确：gpt-5.6 属 Key 机制，30m 是**服务端 TTL 语义**（客户端不发 TTL）；`capability_from_behavior` 把 HalfHour 归入 Short → retention "in_memory"（:430-433），wire 行为正确、不退化。
- 退化路径存在但已被文档化封存：cache.rs:396-398 注释"wire 层 TtlBucket 无 30m 桶 → 保守按 5m 桶"——目前无任何 Explicit 机制模型挂 30m 档，实际不触发。若未来 Anthropic 系厂商出现 30m 档会静默按 5m 桶（写价档位偏差），建议届时扩 `TtlBucket`。

## 5. models.dev 远程源：未接入（成立）

- `ModelCatalog::bundled()` 用 `include_str!("catalog.json")` 编译期打包（catalog.rs:291-295），离线静态表。
- T-24 命令面仅 `catalog_get` / `catalog_refresh`（catalog_commands.rs:42-71），refresh 只接收前端 `scanProviderModels` 上送（窗口/能力位合并，catalog.rs:433-500），**无任何远程拉取/合并代码**。
- models.dev 仅出现在 notes 文案、schema `dataSource` 值域预留（"remote:models.dev"，catalog.rs:145-147）与 99-closure 遗留项（99-project-closure.md:17："models.dev 远程源（登记后续专项）"）。
- 影响：数据新鲜度依赖手工转录；DeepSeek v4-pro Responses 这类"官方计划 8 月初上线"的时序性字段只能靠人工按期复查，缺自动化。

## 6. DeepSeek v4-pro Responses：官方仍未上线，catalog 现状正确（不成立）

- 官方文档实抓（2026-08-09，api-docs.deepseek.com/guides/responses_api）："The Responses API currently only supports the `deepseek-v4-flash` model, and does not yet support the `deepseek-v4-pro` model. We will add support for the `deepseek-v4-pro` model in early August 2026."
- catalog.json:495 `supportsResponses:false` + :501 notes 已标注"supportsResponses 官方计划 2026 年 8 月初加入（抓取日未上线），**8 月中旬刷新翻转**"；catalog.rs 测试同样钉死（:724-729）。
- 结论：无需紧急修正；8 月中旬按计划复查翻转即可（建议并入 #5 的远程源自动化清单）。

## 7. 真实 API 探测测试：不存在（不成立）

- crates 下全部 `#[ignore]` 共 9 处：stress_long_session.rs ×4（:143/:170/:198/:225）、stress_concurrent_runs.rs ×2（:56/:108）、stress_write.rs ×3（:109/:144/:219）——**全部为压力/性能测试**，使用内存 TestProvider/假 IO，无真实网络调用。
- 无 env 门控的真实 API 测试模式（无 REASONIX_API_KEY 类约定；config.rs:30 的 CRISH_API_KEY 等 env 是生产密钥解析，非测试门控）。
- 对齐 Reasonix realcache_test 模式：**缺失**。建议新建 `crates/agent-provider/tests/live_cache.rs`（`#[ignore]` + `CRISH_LIVE_TEST=1` 门控），实测前缀稳定性（窗口滑动 vs 命中率）与 catalog 缓存语义字段。

## 8. ToolUpdate 实时性：已是批事件统一出站（不成立）

- executing_tools.rs:80-88：`execute_batch` 完成后**单点**调用 `emit_tool_events(state, &outcome.events)`（:88），事件在 execute_batch 的 outcome 中统一组装（batch-start/end、tool-start/end、approval-requested），非逐帧外发。
- 单测锚定语义（:468"ToolUpdate 不进对话缓存前缀"）。S1 认知正确，无需改动。

## 9. catalog 与文档一致性：抽查 5 条全部一致（不成立）

抽查条目（catalog.json ↔ 04-master-model-list.md，均 2026-08-03 数据日）：

| 条目 | catalog.json | master 文档 | 一致 |
|------|--------------|-------------|------|
| deepseek-v4-pro | 0.435/0.87/0.003625、RE✔（:497）、R✘+notes（:495,501） | 680 行 0.435/0.87/0.003625；689 行 RE✔、R✘+8 月中旬翻转标注 | ✅ |
| claude-sonnet-5（促销） | 2.0/10.0/0.2（catalog.rs 测试 :872-874 钉死） | 194 行 2.00/10.00/0.20，promoExpiresAt 2026-08-31 | ✅ |
| gemini-3.1-pro-preview | 2.0/12.0/0.2 + >200K 4.0/18.0/0.4 + 存储 4.5（:618-641） | 600 行 2.00/12.00/0.20 + 4.00/18.00/0.40；618 行存储 4.50 | ✅ |
| gpt-5.6-sol | 5.0/30.0/0.5、写 6.25、cacheTtl 30m、272K 档 10/45/1/12.5（:3235-3258） | 82 行 5.00/30.00/0.50/6.25；104 行 30m TTL + 272K 档 | ✅ |
| glm-5-cny / glm-5-1-cny | 4.0/18.0/1.0→[32K+) 6.0/22.0/1.5（:1958-1966）；6.0/24.0/1.3→[32K+) 8.0/28.0/2.0（:1876-1884） | 339 行 4/18/1→6/22/1.5；337 行 6/24/1.3→8/28/2 | ✅ |

R4.5 修正（99-project-closure.md:31，commit f8316a11）核销：S1（v4-pro effort true）catalog:497 已改、master 689 行 RE✔ 本就一致；S2（gpt-5.5-cyber / gpt-5-search-api 保守）catalog:3678-3681 false 已改、master 116-117 行图例"—"（§0.4 语义=保守 false）一致；M1-M4（GLM 视觉 4 条 apiModel 点号）catalog 已补（:1687/1721/1754/1788），master §4.2 无 apiModel 承载列（结构性列缺失，非数据差异；master 核心结论 300 行已覆盖点号规则）。

结论：**无已修正未回写文档的数据差异**；唯一残留是 master §4.2 缺 apiModel 列级回写（建议下轮转录时补列）。

## 10. C14 摘要缓存隔离：策略层就绪、真实实现未落（部分成立）

- 策略层：`CacheRetention::None` = "完全不参与缓存（不发任何缓存参数；摘要请求强制此档）"（request/cache.rs:25-26），`build_cache_policy` none 档整体不注入（:305-312 注释"摘要请求同款"），`retention_wire_value(None)` 不发任何 wire 键（:479-485）——**独立前缀域的隔离档位已具备**。
- 实现层：真实 L2 摘要请求路径**不存在**——`Summarizer` 生产实现仅 `RetryGuardSummarizer`（包装器，conex-compaction/src/ai_summary.rs:333-392，需注入 inner）；壳层只打通了注入通道（SummarizerFactory，engine.rs:700-713；CoreRunState.set_summarizer_factory :1604），engine.rs:709-711 明示"真实 provider 实现属产品功能：本轮只打通通道……生产侧由壳层注入"；真实实现当前只有测试桩（core_run_commands.rs:4461 FakeSummarizer）。
- 影响：当前无真实摘要调用，隔离无从生效也无风险；**落地真实 Summarizer（provider 调用）时**必须按 C14 约束接线：`CacheRetention::None` + 无 prompt_cache_key/会话亲和键 + 无断点，并建议补 `#[ignore]` 实时探测测试（见 #7）验证摘要请求不进主会话缓存前缀。

---

## 附：修复优先级建议

| 优先级 | 事项 | 归属 |
|--------|------|------|
| P0 | 历史回流滑窗改 token 预算 + compaction 稳定锚点（#1） | 前端 T-31 + 引擎 T-33/P4 收口 |
| P1 | 真实 Summarizer 落地并按 C14 隔离接线（#10）+ 真实 API 探测测试（#7） | 壳层 + agent-provider |
| P2 | tieredPricing / peakPricing 消费（P5 成本模块）（#2/#3）；models.dev 远程源（#5）；master 文档 apiModel 列回写（#9）；TtlBucket 30m 档预扩（#4） | P5 / T-24 后续专项 |
