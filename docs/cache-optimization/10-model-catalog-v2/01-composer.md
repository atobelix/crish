# Composer（Cursor / Anysphere）模型目录与定价调研（v2 专项 R1）

> 本文件是「模型目录与定价 v2」专项 Composer 厂商调研产出，供主 Agent 与后续 R2/R3 使用。
> 背景确认：**composer 2.5 不是 OpenAI 模型**（OpenAI 调研已交叉排除），是 Cursor（Anysphere）自研的编程模型线，基于 Moonshot Kimi K2.5 开源权重继续训练。
> 数据获取日期：**2026-08-03**（全部为当日抓取）。价格单位为 **USD/百万 tokens**。
> 未核实条目一律标注「未获取」/「社区口径」，**不编造数字**。

## 1. 来源 URL 清单（获取日期：2026-08-03）

| #   | 来源                                 | URL                                                                          | 用途                                                                                                       |
| --- | ------------------------------------ | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | 官方模型页（Composer）               | https://cursor.com/composer                                                  | 定位语、发布公告索引、基准表、FAQ（定价/基座/可用范围）                                                    |
| 2   | 官方定价与模型文档                   | https://cursor.com/docs/models-and-pricing                                   | **主数据源**：两个用量池、订阅档位、第三方模型价表、Cursor Token Rate                                      |
| 3   | Composer 2.5 模型文档                | https://cursor.com/docs/models/cursor-composer-2-5                           | Strengths/Tools/Pricing（标准价与 fast 价）                                                                |
| 4   | Grok 4.5 模型文档（对照）            | https://cursor.com/docs/models/grok-4-5                                      | 同池另一模型定价格式对照                                                                                   |
| 5   | 发布公告：Introducing Composer 2.5   | https://cursor.com/blog/composer-2-5                                         | 2026-05-18；定价、fast 变体、基座确认、训练方法                                                            |
| 6   | 发布公告：Introducing Composer 2     | https://cursor.com/blog/composer-2                                           | 2026-03-19；定价、四代基准对照                                                                             |
| 7   | Composer 2 技术报告博客              | https://cursor.com/blog/composer-2-technical-report                          | Kimi K2.5 继续预训练 + RL；arXiv 2603.24477；Fireworks 合作                                                |
| 8   | Composer 1 发布博客                  | https://cursor.com/blog/composer-1                                           | 2025-10-29；1T MoE、RL 特化、长上下文                                                                      |
| 9   | 订阅定价页                           | https://cursor.com/pricing                                                   | Hobby/Pro/Pro+/Ultra/Teams/Enterprise 档位                                                                 |
| 10  | Cursor SDK 文档（TypeScript）        | https://cursor.com/docs/sdk/typescript                                       | **模型 ID `composer-2.5`、fast 参数、TokenUsage（cacheRead/cacheWrite）、composer-2 退役重路由、计费规则** |
| 11  | 官方定价政策（法律页）               | https://cursor.com/terms/pricing                                             | Total Tokens 定义（input/output/cache read/write）                                                         |
| 12  | CursorBench 3.2 页面                 | https://cursor.com/cursorbench                                               | Composer 2.5 评分/成本/步数；成本计算口径注释                                                              |
| 13  | 官方文档索引                         | https://cursor.com/llms.txt                                                  | 全部文档路由发现                                                                                           |
| 14  | 官方社区论坛（Composer2.5 max mode） | https://forum.cursor.com/t/composer2-5-max-mode/162423                       | **社区口径：Composer 固定 200K 上下文，Max Mode 无法扩展**                                                 |
| 15  | DuckDuckGo 检索                      | https://html.duckduckgo.com/html/?q=%22composer+2.5%22+context+window+cursor | 上下文窗口交叉验证                                                                                         |
| 16  | Kimi 调研文档（同专项）              | `docs/cache-optimization/10-model-catalog-v2/01-kimi.md`                     | K2.5 基座规格（256K 上下文、17.5% 命中）                                                                   |

---

## 2. 核心结论（先读这里）

1. **Composer 是 Cursor（Anysphere）自研编程模型线，与 Cursor 产品强绑定**：官方 FAQ 原文「Composer 2.5 is only available in Cursor」，可用载体为桌面 App / Web / CLI / 移动端 / Cursor SDK；**不向第三方开放独立 API**（SDK 是 agent SDK，非 raw chat-completions API）。
2. **Composer 2.5 是现役唯一版本，Composer 2 已退役**：SDK 中 `composer-2` / `composer-2-fast` 请求在认证时自动重路由到 2.5；Composer 1（2025-10-29）/ 1.5（2026-02-09）/ 2（2026-03-19）/ 2.5（2026-05-18）四代演进，2 代起基于 Moonshot Kimi K2.5 开源 checkpoint。
3. **定价形态 =「订阅额度池 + 按量 on-demand」双轨，非纯 API 按量**：Composer 与 Grok 4.5 同属 **Cursor Models 池**（订阅内「慷慨用量」，无公开数字）；超出后按 on-demand 费率计费：**Standard $0.50/$2.50，Fast $3.00/$15.00（fast 为产品默认）**。
4. **上下文窗口官方未公布**：官方模型页/文档/博客均无数字；官方论坛口径为 **固定 200K 且 Max Mode 无法扩展**（基座 Kimi K2.5 原生 256K，Cursor 侧存在裁剪）。第三方 llmreference.com 声称 1M，与本权重、论坛口径矛盾，**不可信**。
5. **缓存机制存在但价格不透明**：Cursor 平台整体有缓存计量（SDK `TokenUsage.cacheReadTokens/cacheWriteTokens`、定价政策 Total Tokens 含 cache read/write），但 **Composer/Grok 的 cache_read/cache_write 单价官方未公开**；Moonshot 自动 Context Caching（K2.5 命中 17.5%、写免费）是 Moonshot API 侧行为，Composer 走 Cursor 自托管推理（Fireworks 合作），**不能直接套用 Moonshot 缓存价**。
6. **与 Moonshot 的关系**：仅基座权重同源（Kimi K2.5 开源 checkpoint，1T MoE），85% 训练算力用于 Cursor 自有继续预训练与 RL；推理由 Cursor 自托管（技术报告致谢 Fireworks/Colfax），**不经 Moonshot API，API base 非 moonshot 系**。

---

## 3. 模型清单与规格表

### 3.1 全系版本（发布历史，官方博客确认）

| 版本                     | 发布日         | 基座                                      | 关键信息                                                                                                                                                  |
| ------------------------ | -------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Composer 1               | 2025-10-29     | 自研（未公开基座）                        | 首个版本；1T 参数 MoE；RL 特化软件工程；长上下文生成与理解；速度约为同类 4 倍；原生 MXFP8 训练/推理                                                       |
| Composer 1.5             | 2026-02-09     | 未公开                                    | 中间版本；CursorBench 44.2 / Terminal-Bench 2.0 47.9 / SWE-bench Multilingual 65.9                                                                        |
| Composer 2               | 2026-03-19     | **Moonshot Kimi K2.5（开源 checkpoint）** | 首次继续预训练 + 大规模 RL（Cursor 真实会话环境）；arXiv 2603.24477 技术报告；CursorBench 61.3 / TB 2.0 61.7 / SWE-M 73.7；**已退役**（SDK 重路由到 2.5） |
| **Composer 2.5（现役）** | **2026-05-18** | **Moonshot Kimi K2.5（同 checkpoint）**   | 25x 合成任务、targeted textual feedback RL、effort calibration；CursorBench 3.2 56.1% / TB 2.0 69.3% / SWE-M 79.8%                                        |

### 3.2 现役模型规格（Composer 2.5，官方 + 社区口径）

| 项目                      | 值                                                                                        | 来源/可信度                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 官方模型 ID（SDK）        | `composer-2.5`（fast 变体：参数 `{id:"fast", value:"true"}`）                             | SDK 文档（来源 10），**官方**                                        |
| 官方模型 ID（IDE 产品内） | Composer 2.5（标准 / Fast 两档速度）                                                      | 模型文档（来源 3），**官方**                                         |
| 基座权重                  | Moonshot Kimi K2.5 开源 checkpoint（Composer 2 同款）                                     | 博客/FAQ（来源 5/1），**官方确认**                                   |
| 参数量                    | 1T 参数 MoE（博客原文「on the 1T model」）                                                | 来源 5，**官方**（K2.5 基座本身即 1T MoE，与 Moonshot 公开口径一致） |
| 上下文窗口                | **官方未公布**；社区/官方论坛口径 **固定 200K，Max Mode 不可扩展**                        | 来源 14（论坛，非官方文档），**社区口径**                            |
| 输出上限                  | 未获取                                                                                    | —                                                                    |
| 权重来源上下文            | 基座 K2.5 原生 262,144（256K，Moonshot API 口径，见 01-kimi.md）                          | 来源 16 交叉参考；**非 Composer 实际值**                             |
| 长上下文支持              | 官方称「long-context generation and understanding」（Composer 1 博客）                    | 来源 8，方向性描述                                                   |
| Tool use                  | 全部 Cursor agent 工具（文件编辑/终端/语义搜索等）；RL 训练即以 Cursor harness 工具为环境 | 来源 3/5/7，**官方**                                                 |
| Coding 特化               | 是——长程 agentic 任务 RL 特化、effort calibration（按任务复杂度自动调节工作量）           | 来源 1/3/5，**官方**                                                 |
| 实时更新                  | 实时 RL 管线，每日可多次发布改进 checkpoint                                               | 来源 5 相关博客，**官方**                                            |

### 3.3 基准分（官方发布口径，对比模型为官方自报分）

| 基准                        | Composer 2.5                              | Opus 4.7                | GPT-5.5                    | Composer 2 |
| --------------------------- | ----------------------------------------- | ----------------------- | -------------------------- | ---------- |
| Terminal-Bench 2.0          | 69.3%                                     | 69.4%                   | 82.7%                      | 61.7%      |
| SWE-bench Multilingual      | 79.8%                                     | 80.5%                   | 77.8%                      | 73.7%      |
| CursorBench 3.1（较难任务） | 63.2%                                     | 64.8% max / 61.6% xhigh | 64.3% xhigh / 59.2% medium | 52.2%      |
| CursorBench 3.2             | 56.1%（$0.44/任务，14,286 tokens，33 步） | —                       | —                          | —          |

---

## 4. 定价与订阅说明

### 4.1 Composer 2.5 按量费率（on-demand，官方多源一致）

| 档位                 | input       | output       | 说明                                              |
| -------------------- | ----------- | ------------ | ------------------------------------------------- |
| **Standard**         | **$0.50/M** | **$2.50/M**  | 模型页/FAQ/博客/论坛四源一致（来源 1/2/3/5/14）   |
| **Fast**（产品默认） | **$3.00/M** | **$15.00/M** | 与标准版同智力、更快；fast 为默认选项（来源 3/5） |

> 定价换算参考：Kimi K2.5 官方 API ¥4.00/¥0.70/¥21.00（约 $0.55/$0.10/$2.90，按 2026-08 汇率粗算）——Composer 2.5 标准价略低于 Moonshot API 同权重模型，且 Cursor 侧含 agent 工具链。

### 4.2 订阅档位与额度池（官方 docs/models-and-pricing + pricing 页）

Cursor 有两个独立用量池，按月结算周期重置：

| 池                   | 内容                                                               | 计费                                                                                       |
| -------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| **Cursor Models 池** | Composer 2.5 + Grok 4.5（Cursor 自家/联合模型）                    | 订阅内「**Generous included usage**」（**官方未公布具体额度数字**）；超出走 on-demand 费率 |
| **Other Models 池**  | 第三方模型（OpenAI/Anthropic/Google/Moonshot 等，按各模型 API 价） | Pro 起每月含 $20 / $70 / $400 额度（按档位），超出按量                                     |

| 订阅档          | 月费            | 含第三方模型额度 | Cursor Models                                     |
| --------------- | --------------- | ---------------- | ------------------------------------------------- |
| Start（仅印度） | ₹649/月（含税） | $0（无此池）     | 慷慨用量；仅非 fast 模式、Grok 固定 medium effort |
| Hobby           | 免费            | —                | 有限 agent 请求、含 Composer 访问（定价页）       |
| Pro             | $20/月          | $20              | 慷慨用量                                          |
| Pro+            | $60/月          | $70              | 慷慨用量                                          |
| Ultra           | $200/月         | $400             | 慷慨用量                                          |
| Teams Standard  | $40/用户/月     | —                | 同上（另有 Premium $120/用户/月，5x Agent 限额）  |
| Enterprise      | 定制            | —                | 池化用量、发票/PO 结算、SCIM 等                   |

> 重要规则：
>
> - **超量 on-demand**：按同一 API 费率后付结算（月度账单，来源 2）；「Requests are never downgraded」。
> - **Cursor Token Rate**：Teams/Enterprise 上第三方模型每 M tokens 加收 $0.25；**Composer 2.5 与 Grok 4.5（所有第一方 Cursor 模型）豁免**。
> - **Max Mode**：仅 legacy 按请求计费计划上可用，将上下文扩展到模型上限并按 API 价 +20% 计费；**对 Composer 无效**（Composer 固定窗口，Max Mode 无法扩展，来源 14 社区口径 + 来源 2「Max Mode is for other models that support expanded context, like Grok」）。
> - Composer 2.5 发布首周提供双倍用量（来源 5）。

### 4.3 是否开放 API / 按量计费

- **不开放第三方独立 API**（官方 FAQ：仅 Cursor 内可用）。
- **Cursor SDK**（`@cursor/sdk`，Node 22.13+）可按 `{id:"composer-2.5"}` 编程调用 agent（本地/云端运行时），**走同一订阅/额度池计费**，非独立 token 计费 API；SDK 明示「The Cursor SDK is an agent SDK, not a standalone model-inference or chat-completions API」。
- 对目录落地的含义：Composer 无法像 OpenAI/Anthropic 那样以独立 API 接入本项目的模型目录；若收录，应标记为「Cursor 生态内模型」并采用 Cursor 订阅/额度语义而非通用 API 计费语义。

---

## 5. 缓存机制

### 5.1 平台层缓存计量（已确认存在）

| 证据                 | 内容                                                                                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SDK `TokenUsage`     | 字段 `inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens / totalTokens / reasoningTokens?`——**所有 Cursor 模型（含 Composer）的 run 都会返回缓存读写 token 计量**（来源 10） |
| 定价政策             | 「Total Tokens means the aggregate number of tokens processed across all input, output, and cache (read and write) tasks」（来源 11）——**平台按含缓存的 token 总量计费**                  |
| CursorBench 成本口径 | 「Avg cost / task is computed by applying each model's published per-million-token pricing (**input, cache read, cache write, and output**)」（来源 12）——公开缓存价为第三方模型口径      |

### 5.2 Composer 自身缓存定价（未公开）

- `docs/models-and-pricing` 的 Composer pricing 段落**只有标题、无价格表**（HTML 与 markdown 两版均如此）；Grok 4.5 模型页同（来源 2/4）。
- **cache_read 折扣率、cache_write 费率、TTL、最低缓存前缀均未获取**。Cursor 侧未公开 Composer 的缓存单价，on-demand 计费是否对缓存命中打折无法核实。
- 因「Generous included usage」额度池内不按 token 计费，**额度池内缓存无成本概念**；仅 on-demand 超量段才涉及缓存定价，而该定价未公开。

### 5.3 与 Moonshot 自动 Context Caching 的关系（重要甄别）

- Moonshot API 侧：K2.5 全自动 Context Caching，命中 ¥0.70/¥4.00 ≈ **17.5%**、写入免费、最低缓存 256 tokens、无 cache_control（见 01-kimi.md §3.1）。
- **该机制不适用于 Composer**：Composer 推理由 Cursor 自托管（技术报告致谢 Fireworks/Colfax 合作，来源 7），请求**不经过 Moonshot API**，Moonshot 的缓存价/命中率/TTL 语义不成立。
- Cursor 平台自身是否实现「前缀缓存 + 命中折扣」、缓存参数如何控制，**官方文档未披露**；SDK 亦无缓存开关参数（仅计量字段存在）。

---

## 6. 特化优化线索

| 线索               | 内容                                                                                                                                    | 来源               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Coding 特化        | 两阶段训练：Kimi K2.5 上继续预训练（强化代码知识）→ 大规模 RL（真实 Cursor 会话、相同工具 harness、覆盖开发请求分布）                   | 来源 7（技术报告） |
| 长程任务           | 长时程 RL 任务训练，数百次工具调用下保持目标；与 OpenAI 侧 5.3-codex 同类定位                                                           | 来源 1/3           |
| Effort calibration | 按任务复杂度自动调节工作量：长任务更出力、简单任务快速响应——「不再需要手动切 thinking 档」是卖点之一                                    | 来源 1/3           |
| Fast 变体默认      | 同智力 fast 档为产品默认（$3/$15），交互循环优先                                                                                        | 来源 3/5           |
| 实时 RL            | 生产环境直接服务 checkpoints、用户交互做奖励信号，**每日可多次发布改进版本**——模型行为不稳定风险提示（版本漂移）                        | 来源 5 相关博客    |
| 上下文限制         | 固定 ~200K 窗口（社区口径），无 Max Mode 扩展 → **长上下文任务超窗后需换模型**；与基座 256K 有差距，疑为产品侧约束                      | 来源 14            |
| Cursor Router 集成 | Auto 模式由 Cursor Router 调度；Auto Cost 模式豁免 Cursor Token Rate；Composer 是路由池中的性价比档                                     | 来源 2             |
| 与 SpaceXAI 联合   | 下一代模型与 SpaceXAI 从零训练（10x 算力），Composer 2.5 是当前公开的终点                                                               | 来源 1/5           |
| 成本画像           | CursorBench 3.2 每任务 $0.44、14,286 tokens、33 步——**成本仅为同榜 frontier 模型的约 1/4~1/10**，是典型的「低 token 消耗 + 低单价」组合 | 来源 12            |

---

## 7. 交叉验证与差异记录

| 项                      | 官方                  | 第三方                                                                                                             | 判定                                                                |
| ----------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Standard 价 $0.50/$2.50 | ✔（模型页/FAQ/博客）  | 论坛帖一致                                                                                                         | ✔                                                                   |
| Fast 价 $3.00/$15.00    | ✔（模型页/博客）      | 论坛帖一致                                                                                                         | ✔                                                                   |
| 上下文窗口              | **官方未公布**        | 论坛 200K 固定（来源 14）；llmreference 称 1M（来源 15 检索结果）；社区文章称「用户要求 240-250K 以匹配基座 256K」 | **以论坛 200K 为社区口径**；llmreference 1M 与基座/论坛矛盾，不采信 |
| 基座权重                | Kimi K2.5（官方多源） | 与 Moonshot 开源一致                                                                                               | ✔                                                                   |
| 参数量                  | 1T MoE（博客）        | K2.5 基座公开口径 1T                                                                                               | ✔                                                                   |
| 缓存价                  | 未公开                | —                                                                                                                  | **未获取**                                                          |
| 是否 OpenAI 模型        | —                     | models.dev / OpenRouter / OpenAI 官方均无此名（01-openai.md §7.3）                                                 | **确认非 OpenAI**，归 Cursor（Anysphere）厂商                       |

---

## 8. 未获取 / 未核实项（诚实边界清单）

1. **上下文窗口官方数字**：官方文档/博客均未公布；仅论坛社区口径 200K 固定（Max Mode 不可扩展）。**落地 catalog 前建议以实测或官方确认值为准**。
2. **Composer 缓存单价（cache_read / cache_write）**：官方未公开；Cursor Models 池内按额度计费无缓存价概念，on-demand 段缓存计价方式不明。
3. **缓存 TTL / 最低前缀 / 缓存开关参数**：Cursor 平台未披露缓存机制细节（仅 SDK 有计量字段）。
4. **「Generous included usage」额度数字**：官方只写「generous」，无 token/美元数字。
5. **输出上限（max output tokens）**：官方未公布。
6. **实际 API 端点 / API base**：官方未公开 Composer 的推理端点；仅能确认非 Moonshot API（自托管），子处理器清单（trust.cursor.com/subprocessors）未抓取核实。
7. **Composer 1.5 与 Composer 1 的定价**：无官方定价记录（早期为请求制/池内）。
8. **Composer 2 的上下文窗口**：与 2.5 同基座，官方未公布；论坛「固定 200K」口径是否覆盖 2 代未知。
9. **llmreference.com 的 1M 上下文说法**：与基座权重、官方论坛矛盾，判定为不可信数据，未采信（列此备查）。

---

## 9. 对 catalog 落地的直接建议（供 R2/R3 参考）

1. **厂商归属**：独立厂商条目 **Cursor（Anysphere）**，不并入 Moonshot/Kimi，也不并入 OpenAI。
2. **收录形态**：Composer 2.5 建议收录为**「Cursor 生态内模型」**（`composer-2.5`，fast 变体作参数或独立档），计费语义 = 订阅额度池 + on-demand（Standard $0.50/$2.50；Fast $3.00/$15.00），**不要**按通用 API 四指标（input/output/cache_read/cache_write）建模——cache 两价未公开。
3. **context_window**：官方未公布，**缺省不可写死**；若必须落值，标注「社区口径 200,000，未经官方确认」或留空由 R3 实测。
4. **缓存字段**：cache_read/cache_write 标「未公开」；提示 Cursor 平台有缓存计量（SDK 字段），但无折扣价可录。
5. **特化标记**：coding 特化 / effort 自动校准 / fast 默认 / 实时 RL 版本漂移（每日可能换 checkpoint，注意目录条目的时效性风险）。
6. **可用性**：仅 Cursor 订阅内可用（IDE/Web/CLI/mobile/SDK），无独立第三方 API——若本专项目录用于「可接入代理的 API 模型」，Composer 应标记为**不可直连**。
