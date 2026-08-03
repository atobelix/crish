# DeepSeek 模型目录与定价 v2

> 「模型目录与定价 v2 专项」R1 调研产物：DeepSeek 最新（2026-08）完整模型清单、四指标价格、缓存机制（前缀单元制/写价/峰谷定价）、Responses API 支持现状与特化优化线索。
> 数据获取日期：**2026-08-03**。所有数字均来自下方官方来源 URL（webfetch 实抓），未编造；未获取项明确标注。
> 关联核对：`docs/cache-optimization/00-vendor-model-pricing-catalog.md` §3（下称 00-catalog）、`01-reference-research/vendor-cache-mechanisms.md` §1（下称机制文档）、`00-gap-audit.md` §3.3/§5.2-C（R1 任务书）。

## 0. 来源 URL

| 来源                     | URL                                                | 用途                                                                                                   |
| ------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 官方模型与定价页         | https://api-docs.deepseek.com/quick_start/pricing  | 模型清单、版本号、上下文/输出上限、四指标价格、Responses 支持表、峰谷定价公告、并发限制                |
| 官方缓存文档（KV Cache） | https://api-docs.deepseek.com/guides/kv_cache      | 磁盘前缀缓存机制、前缀单元、持久化时机、命中规则、计量字段、写价核实                                   |
| 官方 Responses API 文档  | https://api-docs.deepseek.com/guides/responses_api | v4-flash/pro 支持范围、reasoning_content 回放、无状态参数表、计量字段                                  |
| 官方 Change Log          | https://api-docs.deepseek.com/updates              | V4-Flash-0731 发布（2026-07-31）、V4 上线（2026-04-24）、deepseek-chat/reasoner 停用预告（2026-07-24） |
| models.dev（交叉验证）   | https://models.dev/api.json                        | 模型 ID/上下文/能力/价格交叉验证（含 legacy 条目残留）                                                 |

## 1. 完整模型表（2026-08-03 官方口径，USD/1M tokens）

| 模型                         | API ID              | 上下文窗口 | 输出上限 | input  | output | cache_read | cache_write                 | 币种 | 备注                                                                                                                                                     |
| ---------------------------- | ------------------- | ---------- | -------- | ------ | ------ | ---------- | --------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DeepSeek V4 Flash（0731 版） | `deepseek-v4-flash` | 1,000,000  | 384,000  | $0.14  | $0.28  | $0.0028    | **0（写免费，无写价概念）** | USD  | 版本号 DeepSeek-V4-Flash-0731（public beta）；命中 = 未命中的 2%（50 倍差价）；Responses/Anthropic API 均支持；并发 2500                                 |
| DeepSeek V4 Pro              | `deepseek-v4-pro`   | 1,000,000  | 384,000  | $0.435 | $0.87  | $0.003625  | **0（写免费，无写价概念）** | USD  | 版本号 DeepSeek-V4-Pro（无后缀）；命中 ≈ 未命中的 0.83%（120 倍差价）；Anthropic API 支持；Responses API 官方计划 2026 年 8 月初加入（未上线）；并发 500 |

**在售模型 2 个，四指标（input/output/cache_read/cache_write）全部完整**（写价语义 = 官方无写价、写免费，对应 catalog 条目 `cacheWritePrice: 0` + `cacheWriteFree: true`，与 00-catalog §12.4.2 #7 一致）。

### 1.1 legacy 模型（已停用，2026-07-24 到期）

| 模型                | 状态                     | 上下文窗口                   | input | output | cache_read | 币种 | 备注                                                                                                                                                                                 |
| ------------------- | ------------------------ | ---------------------------- | ----- | ------ | ---------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `deepseek-chat`     | **已停用**（2026-07-24） | 未获取（停用后官方不再列出） | —     | —      | —          | USD  | 2026-04-24 changelog 预告「三个月后（2026-07-24）停用」；过渡期指向 v4-flash 非思考模式；models.dev 残留条目价格为 0.14/0.28/0.0028（last_updated 2026-02-28，**旧数据，不作价源**） |
| `deepseek-reasoner` | **已停用**（2026-07-24） | 未获取（停用后官方不再列出） | —     | —      | —          | USD  | 同上；过渡期指向 v4-flash 思考模式                                                                                                                                                   |

- 结论：**v3/chat 系已全部下线**，官方定价页（2026-08-03）仅列 v4-flash / v4-pro 两个模型；deepseek-chat / deepseek-reasoner 均于 2026-07-24 按预告停用，过渡期内两者分别映射 v4-flash 的非思考/思考模式。
- 未获取项：停用后调用这两个名字的具体行为（返回 404 或提示改用新名）官方未在 changelog 说明，未实测。

## 2. 缓存机制（kv_cache 文档，2026-08-03 实抓确认）

- **自动磁盘前缀缓存（Context Caching on Disk）**：全用户默认启用、零代码改动；每次请求触发磁盘缓存构建，后续请求与先前请求前缀重叠部分走缓存，计为 cache hit。
- **缓存前缀单元制（关键差异）**：SWA（滑动窗口注意力）下缓存存储与匹配以**独立完整的「缓存前缀单元」**为单位，后续请求必须**完整匹配某个单元**才能命中——不再逐 token 匹配任意前缀（与 OpenRouter/Anthropic 式任意前缀命中不同）。
- **三种持久化时机**：
  1. 请求边界：每次请求在「用户输入末尾」与「模型输出末尾」各生成一个单元；
  2. 公共前缀检测：检测到多请求公共前缀时持久化为独立单元（例：请求 A+B 与 A+C 共享前缀 A，第三次 A+D 可命中 A）；
  3. 固定 token 间隔：长输入/长输出按固定间隔切出单元，避免长前缀永远到不了末尾而无法缓存。
- **构建与清除**：磁盘缓存构建需数秒；不再使用时**数小时到数天内自动清除**（官方原话 "usually within a few hours to a few days"）；命中为 **best-effort，不保证 100%**。
- **输出随机性保留**：缓存只匹配输入前缀，输出仍按当前参数全新生成（受 temperature 影响）。
- **写价核实（任务问题 2）**：官方 kv_cache 与定价页**均无任何缓存写入收费条目**（无 cache_control 断点、无创建费、无存储费）——缓存写入免费；四指标表 cache_write = 0 即此语义。
- **无手动控制**：不支持 cache_control、`prompt_cache_key` / `prompt_cache_retention`（静默忽略，缓存全自动管理）。
- **最低可缓存 token**：官方未给出数字（旧版 V3 时代「64 token 块」表述已废弃，2026 版为前缀单元 + 固定 token 间隔），无明确下限。
- **计量字段**：
  - Chat Completions：`usage.prompt_cache_hit_tokens` / `usage.prompt_cache_miss_tokens`（DeepSeek 专用，非 OpenAI details 结构）；
  - Responses API：`usage.input_tokens_details.cached_tokens`。

## 3. 峰谷定价（当前状态）

- 官方定价页（2026-08-03 实抓）原文口径：「DeepSeek API service will **soon** adopt a peak/off-peak pricing policy」——**尚未生效，生效日期待官方公告**（与 00-catalog §3.1 / catalog.json `peakPricing2x: true` 一致，该标记保持，日期无法落值）。
- 规则：高峰时段（**北京时间 9:00–12:00、14:00–18:00**）价格 2 倍，**适用于所有计费项**（输入/输出/缓存命中均含）。
- 影响：全天候服务成本估算必须预留该因子；命中价 2 倍后仍远低于未命中价（flash $0.0056 vs $0.14、pro $0.00725 vs $0.435），缓存价值不因峰谷定价消失。

## 4. Responses API 支持现状与特化优化线索

- **支持范围**：官方定价页与 Responses 文档（2026-08-03 实抓）均明确「目前仅支持 `deepseek-v4-flash`；`deepseek-v4-pro` 尚不支持，将于 **2026 年 8 月初**加入」——**截至抓取日 v4-pro 仍未上线**，00-gap-audit §3.3 的 `supportsResponses` 翻转暂不成立，维持 false 待下一次刷新确认。
- **base_url**：`https://api.deepseek.com`（OpenAI SDK `client.responses.create` 直连；Codex 官方适配）。
- **reasoning_content 回放（特化线索）**：
  - Responses 输入项支持 `reasoning` 类型：**纯文本 `content` 会被合并进相邻的 assistant 消息**（即链式思考回放/保留，可跨轮次传给下轮请求）；`summary` 与 `encrypted_content` 不支持。
  - 输出侧 `output_tokens_details.reasoning_tokens` 报告链式思考 token 数；流式事件 `response.reasoning_text.delta/.done` 增量推送思考文本。
  - models.dev 交叉确认：interleaved 字段 `reasoning_content`；两模型 reasoning_options 均为 toggle + effort（high/max）。
  - 缓存含义：思考块随历史轮次进入缓存前缀（命中按输入价计），v4 系列无「剥离 thinking 块」类失效行为说明（官方未提及，**未确认项**）。
- **无状态 API**：`previous_response_id` / `conversation` / `store` / `background` / `include` / `prompt` / `truncation` / `service_tier` / `safety_identifier` / `prompt_cache_key` / `prompt_cache_retention` 均不支持，**静默忽略、不报错**（兼容既有 Responses 客户端）；`store` 恒为 false；请求超上下文窗口返回 400。
- **其他能力位**（官方定价页/Responses 文档）：JSON Output ✓、Tool Calls ✓（Responses 下 function/web_search 工具，custom 仅 `apply_patch`）、Chat Prefix Completion ✓（Beta）、FIM Completion ✓（Beta，**仅非思考模式**）、Thinking Mode（非思考/思考双模，**默认思考**）、web search ✓（服务端执行）；视觉/音频/文件输入不支持（input_image 静默替换为占位文本）。

## 5. models.dev 交叉验证（2026-08-03）

| 条目                              | 官方价 vs models.dev                   | 窗口           | 结论                                                                                          |
| --------------------------------- | -------------------------------------- | -------------- | --------------------------------------------------------------------------------------------- |
| deepseek-v4-flash                 | $0.14 / $0.28 / $0.0028 —— 完全一致    | 1M / 384K 一致 | 一致；models.dev 补充 release_date 2026-07-31、open_weights、structured_output                |
| deepseek-v4-pro                   | $0.435 / $0.87 / $0.003625 —— 完全一致 | 1M / 384K 一致 | 一致；release_date 2026-04-24                                                                 |
| deepseek-chat / deepseek-reasoner | 0.14 / 0.28 / 0.0028（残留）           | 1M / 384K      | **旧数据**（last_updated 2026-02-28），未反映 2026-07-24 停用——不作价源，仅佐证 legacy 同价轨 |

- models.dev 无 cache_write 字段 → 交叉印证 DeepSeek 无写价概念。

## 6. 未获取项（诚实边界）

| 项                                | 说明                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 峰谷定价生效日期                  | 官方（2026-08-03）仍为「soon」+「生效日期待公告」，无法落值                                            |
| v4-pro Responses API 实际上线时间 | 官方文档仍为「2026 年 8 月初」计划态，截至抓取日未上线；8 月内需再次刷新翻转 `supportsResponses`       |
| 最低可缓存 token 下限             | 官方 kv_cache 文档无数字（旧「64 token 块」表述已废弃）                                                |
| legacy 模型停用后调用行为         | changelog 仅预告停用；404 或报错语义未说明、未实测                                                     |
| 每模型 RPM/TPM 限速明细           | 本任务只确认并发限制（flash 2500 / pro 500），速率限额属 rate_limit 文档域未抓                         |
| 思考块缓存失效规则                | v4 系列是否随轮次保留思考块、有无失效条件，官方文档未提及（未确认）                                    |
| DeepSeek-V4-Pro-Preview           | changelog 提及 V4-Flash-Preview 同架构重后训练，但 Pro-Preview 版本细节未公布（models.dev 亦无该条目） |

## 7. crish 落地的关键提示（数据面）

1. **目录与行为已对齐**：两条在售条目四指标完整、币种 USD、`cacheWriteFree: true`，与 00-catalog §12.4 转录一致，本次 R1 无价格修正。
2. **legacy 模型名不可再用于新接入**：deepseek-chat / deepseek-reasoner 2026-07-24 停用；若有存量配置指向这两个名字需迁移到 `deepseek-v4-flash`（过渡期映射已失效）。
3. **峰谷定价**：`peakPricing2x: true` 维持；P5 成本层应实现「北京时间 9-12/14-18 全计费项 ×2」的开关位，生效日期入生命周期字段待公告落值。
4. **v4-pro Responses 翻转**：官方 8 月初窗口已开，建议 8 月中旬后刷新官方定价页，确认后翻转 `supportsResponses: false → true`（本调研当日为 false）。
5. **命中价差是全行业最大杠杆**（flash 50 倍、pro 120 倍）：自动缓存零成本，只需保持前缀稳定 + 解析 `prompt_cache_hit_tokens`（Chat）/ `input_tokens_details.cached_tokens`（Responses），无需任何断点逻辑。
6. **前缀单元制注意**：命中要求完整匹配单元，多轮请求前缀必须逐字节稳定；差异内容（新 user 消息）放末尾不影响前缀单元命中。
