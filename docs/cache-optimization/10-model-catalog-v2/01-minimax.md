# 模型目录 v2 — MiniMax（M2/M2.1/M2.5/M2.7/M3 全系）R1 调研

- 调研日期：2026-08-03
- 调研方式：webfetch 官方文档与定价页（国内站 platform.minimaxi.com + 国际站 platform.minimax.io 双站），models.dev/api.json 交叉验证，GitHub 开源仓库核实模型变体
- 调研范围：MiniMax-M3 / M2.7 / M2.5 / M2.1 / M2 全系 + highspeed 变体 + M2-her 对话模型 + 双轨缓存机制（被动 512 起 / Anthropic 主动 4 断点 20 块回溯 5min TTL）+ 特化优化线索
- 内容约定：所有数字标注来源站与币种；未获取项明确标注「未获取/未确认」，不编造
- 关联文档：`docs/cache-optimization/00-vendor-model-pricing-catalog.md` §7（旧口径，本次有价格差异见 §8）；`docs/cache-optimization/01-reference-research/vendor-cache-mechanisms.md` §5

## 1. 来源 URL 清单

| 来源                                    | URL                                                                             | 币种            | 获取日期   |
| --------------------------------------- | ------------------------------------------------------------------------------- | --------------- | ---------- |
| 国内站按量计费页                        | https://platform.minimaxi.com/docs/guides/pricing-paygo                         | CNY             | 2026-08-03 |
| 国际站按量计费页                        | https://platform.minimax.io/docs/guides/pricing-paygo                           | USD             | 2026-08-03 |
| 被动缓存（Prompt 缓存）文档             | https://platform.minimaxi.com/docs/api-reference/text-prompt-caching            | —               | 2026-08-03 |
| Anthropic 主动缓存文档（含 CNY 价目表） | https://platform.minimaxi.com/docs/api-reference/anthropic-api-compatible-cache | CNY             | 2026-08-03 |
| 模型清单与上下文窗口（模型调用）        | https://platform.minimaxi.com/docs/guides/text-generation                       | —               | 2026-08-03 |
| 模型发布动态                            | https://platform.minimaxi.com/docs/release-notes/models                         | —               | 2026-08-03 |
| M3 工具使用 & 交错思维链                | https://platform.minimaxi.com/docs/guides/text-m3-function-call                 | —               | 2026-08-03 |
| 模型列表 API（OpenAI 兼容）             | https://platform.minimaxi.com/docs/api-reference/models/openai/list-models      | —               | 2026-08-03 |
| models.dev（交叉验证）                  | https://models.dev/api.json                                                     | USD（直连口径） | 2026-08-03 |
| 开源仓库 MiniMax-AI/MiniMax-M2.5        | https://github.com/MiniMax-AI/MiniMax-M2.5                                      | —               | 2026-08-03 |

## 2. 完整模型清单（官方口径）

**来源**：https://platform.minimaxi.com/docs/guides/text-generation（2026-08-03）＋ 发布动态页；输出上限官方未公布，标 models.dev 口径。

| 模型                   | 上下文窗口 | 输出上限（models.dev 口径） | 发布       | 备注                                                                                                                 |
| ---------------------- | ---------- | --------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------- |
| MiniMax-M3             | 1,000,000  | 128,000                     | 2026-06-01 | 最新旗舰：原生多模态 Chat 输入（image_url/video_url）、Interleaved Thinking、Agent/代码/长上下文优化；**仅被动缓存** |
| MiniMax-M2.7           | 204,800    | 131,072                     | 2026-03-18 | 输出速度约 60 TPS；主动+被动缓存                                                                                     |
| MiniMax-M2.7-highspeed | 204,800    | 131,072                     | 2026-03-18 | 极速版约 100 TPS，效果不变                                                                                           |
| MiniMax-M2.5           | 204,800    | 131,072                     | 2026-02    | 60 TPS；成本效率旗舰（官方 README：100 TPS 连续运行 $1/小时）                                                        |
| MiniMax-M2.5-highspeed | 204,800    | 131,072                     | 2026-02    | 极速版约 100 TPS                                                                                                     |
| MiniMax-M2.1           | 204,800    | 131,072                     | 2025-12-22 | 60 TPS；多语言编程                                                                                                   |
| MiniMax-M2.1-highspeed | 204,800    | 131,072                     | 2025-12-22 | 极速版约 100 TPS                                                                                                     |
| MiniMax-M2             | 204,800    | 128,000                     | 2025-10-27 | 编码与 Agent 工作流（models.dev 记 196,608，旧口径，见 §6）                                                          |
| M2-her                 | 64,000     | 未获取                      | 未获取     | 对话场景专用（角色扮演/多轮对话），走独立 text-chat 接口；**按量计费页无价格，未获取**                               |

> - **不存在 M2.5.1**：官方平台清单、models.dev、开源 repo 均无此型号，未发现任何 M2.5 小版本变体（开源权重为 M2.5 与 M2.5-Lightning 两版，后者 = 平台 highspeed 的 100 TPS 档）。
> - **不存在 M3 系列变体**：M3 为单模型，无 M3.x / M3 系列高速档。
> - 历史模型 M1（2025-06-16 发布，推理模型）已不在官方支持模型表中，未收录价格。

## 3. 价格表（CNY，国内站 platform.minimaxi.com）

**来源**：https://platform.minimaxi.com/docs/guides/pricing-paygo（2026-08-03，单位 元/1M tokens）

### 3.1 标准档

| 模型                           | 上下文档位 | input                               | output                    | cache_read（缓存读取）                  | cache_write（缓存写入，1.25x） | 备注                                       |
| ------------------------------ | ---------- | ----------------------------------- | ------------------------- | --------------------------------------- | ------------------------------ | ------------------------------------------ |
| MiniMax-M3                     | ≤512k 输入 | **2.10**（原价 ~~4.20~~，永久五折） | **8.40**（原 ~~16.80~~）  | **0.42**（原 ~~0.84~~，= 现输入价 20%） | 无写入费                       | 仅被动缓存                                 |
| MiniMax-M3                     | >512k 输入 | **4.20**（原 ~~8.40~~）             | **16.80**（原 ~~33.60~~） | **0.84**（原 ~~1.68~~）                 | 无写入费                       | 长上下文价 = 2x；输入 token 含缓存命中部分 |
| MiniMax-M2.7                   | —          | 2.10                                | 8.40                      | 0.42（20%）                             | 2.625                          | 主动+被动                                  |
| MiniMax-M2.7-highspeed         | —          | 4.20                                | 16.80                     | 0.42                                    | 2.625                          | 输入/输出 2x，缓存读写价不变               |
| MiniMax-M2.5（历史）           | —          | 2.10                                | 8.40                      | 0.21（10%）                             | 2.625                          | 官方定价页折叠区                           |
| MiniMax-M2.5-highspeed（历史） | —          | 4.20                                | 16.80                     | 0.21                                    | 2.625                          |                                            |
| MiniMax-M2.1（历史）           | —          | 2.10                                | 8.40                      | 0.21（10%）                             | 2.625                          |                                            |
| MiniMax-M2.1-highspeed（历史） | —          | 4.20                                | 16.80                     | 0.21                                    | 2.625                          |                                            |
| MiniMax-M2（历史）             | —          | 2.10                                | 8.40                      | 0.21（10%）                             | 2.625                          |                                            |

### 3.2 优先服务档（`service_tier=priority`，标准价 1.5 倍，优先准入、降低失败率）

| 模型       | 上下文档位 | input | output | cache_read |
| ---------- | ---------- | ----- | ------ | ---------- |
| MiniMax-M3 | ≤512k      | 3.15  | 12.60  | 0.63       |
| MiniMax-M3 | >512k      | 6.30  | 25.20  | 1.26       |

## 4. 价格表（USD，国际站 platform.minimax.io）

**来源**：https://platform.minimax.io/docs/guides/pricing-paygo（2026-08-03，单位 $/1M tokens）

### 4.1 标准档

| 模型                             | 上下文档位 | input                               | output                    | cache_read                | cache_write | 备注            |
| -------------------------------- | ---------- | ----------------------------------- | ------------------------- | ------------------------- | ----------- | --------------- |
| MiniMax-M3                       | ≤512k 输入 | **$0.30**（原 ~~$0.60~~，永久五折） | **$1.20**（原 ~~$2.40~~） | **$0.06**（原 ~~$0.12~~） | 无写入费    | 仅被动缓存      |
| MiniMax-M3                       | >512k 输入 | **$0.60**（原 ~~$1.20~~）           | **$2.40**（原 ~~$4.80~~） | **$0.12**（原 ~~$0.24~~） | 无写入费    | 长上下文价 = 2x |
| MiniMax-M2.7                     | —          | $0.30                               | $1.20                     | $0.06（20%）              | $0.375      | 主动+被动       |
| MiniMax-M2.7-highspeed           | —          | $0.60                               | $2.40                     | $0.06                     | $0.375      |                 |
| MiniMax-M2.5（Legacy）           | —          | $0.30                               | $1.20                     | $0.03（10%）              | $0.375      |                 |
| MiniMax-M2.5-highspeed（Legacy） | —          | $0.60                               | $2.40                     | $0.03                     | $0.375      |                 |
| MiniMax-M2.1（Legacy）           | —          | $0.30                               | $1.20                     | $0.03（10%）              | $0.375      |                 |
| MiniMax-M2.1-highspeed（Legacy） | —          | $0.60                               | $2.40                     | $0.03                     | $0.375      |                 |
| MiniMax-M2（Legacy）             | —          | $0.30                               | $1.20                     | $0.03（10%）              | $0.375      |                 |

### 4.2 优先服务档（1.5x）

| 模型       | 上下文档位 | input | output | cache_read |
| ---------- | ---------- | ----- | ------ | ---------- |
| MiniMax-M3 | ≤512k      | $0.45 | $1.80  | $0.09      |
| MiniMax-M3 | >512k      | $0.90 | $3.60  | $0.18      |

> 双站价格可互验：CNY/USD 按约 7:1 对应（如 M2.7 输入 ¥2.10 ≈ $0.30、输出 ¥8.40 ≈ $1.20、写入 ¥2.625 ≈ $0.375）。

## 5. 双轨缓存机制（已确认，两篇官方缓存文档 2026-08-03 原文）

### A. Prompt 缓存（被动/自动，OpenAI 与 Anthropic 兼容端点均生效）

| 维度       | 内容                                                                                                                 |
| ---------- | -------------------------------------------------------------------------------------------------------------------- |
| 工作方式   | 自动识别重复上下文，无需改调用；前缀匹配顺序「工具定义 → 系统提示词 → 历史对话内容」，任意模块内容变更都可能影响缓存 |
| 最低缓存量 | **≥ 512 输入 token**                                                                                                 |
| 计费       | 命中 token 按优惠价计费；**写入无额外计费**；新增输入按标准输入价                                                    |
| 过期       | 根据系统负载自动调整（具体 TTL 值未公布）                                                                            |
| 支持模型   | **MiniMax-M3、M2.7 系列、M2.5 系列、M2.1 系列**（官方对比表不含 M2）                                                 |
| 计量字段   | OpenAI 格式 `usage.prompt_tokens_details.cached_tokens`；Anthropic 格式 `usage.cache_read_input_tokens`              |

### B. Anthropic 主动缓存（显式 cache_control，完整复刻 Anthropic 语义）

| 维度     | 内容                                                                                                                                                                                    |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 工作方式 | `cache_control {"type":"ephemeral"}`；**最多 4 个断点**（超出只取从后往前最近 4 个）；**20 块回溯窗口**（每断点向前最多检查 20 个块）                                                   |
| 前缀层次 | `tools` → `system` → `messages` 累积构建，每级变更使该级及后续全部失效；可缓存 tool_use / tool_result 块；thinking 块不可直接标记                                                       |
| TTL      | **5 分钟**，命中自动续期、续期免费；首次写入按 1.25x 输入价计费                                                                                                                         |
| 支持模型 | **M2.7 系列、M2.5 系列、M2.1 系列、M2**（**M3 不支持主动缓存**，两篇官方文档对比表均确认）                                                                                              |
| 计量字段 | `cache_creation_input_tokens`（写入）/ `cache_read_input_tokens`（读取）/ `input_tokens`（最后一个断点之后的 token）；`total_input_tokens = cache_read + cache_creation + input_tokens` |
| 最佳实践 | 静态内容（工具、system、文档）放开头并标记断点；多轮对话每轮标记最后消息最后一个块实现增量缓存；未标记的旧断点在 5 分钟内仍可命中并自动续期                                             |

**推论（缓存轨矩阵）**：

| 模型                | 被动（自动）缓存                 | 主动（cache_control）缓存 |
| ------------------- | -------------------------------- | ------------------------- |
| MiniMax-M3          | ✅（命中 20%）                   | ❌ 不支持                 |
| MiniMax-M2.7        | ✅（命中 20%）                   | ✅                        |
| MiniMax-M2.5 / M2.1 | ✅（命中 10%）                   | ✅                        |
| MiniMax-M2          | ❌ 不支持（官方被动列表不含 M2） | ✅                        |

## 6. models.dev 交叉验证（2026-08-03）

- models.dev 官方 provider `minimax`（minimax.io）与 `minimax-cn`（minimaxi.com）各收录 7 个模型（M3/M2.7/M2.7-highspeed/M2.5/M2.5-highspeed/M2.1/M2），USD 价格与官方定价页逐项一致 ✓
- **M3 条目无 cache_write 字段** ✓ 交叉印证 M3 无主动缓存（无写入费）
- 命中折扣交叉印证：M2.7 读 $0.06 / 输入 $0.30 = 20%；M2.5/M2.1/M2 读 $0.03 = 10%；M3 读 $0.06 = 20%
- 输出上限（models.dev 口径，官方未公布）：M3 128,000；M2.7/M2.5/M2.1 及 highspeed 131,072；M2 128,000
- 差异 1：models.dev 记 M2.5-highspeed `cache_read=0.06`，官方定价页为 0.03（highspeed 缓存读价与基础版相同）——**models.dev 疑误，以官方为准**
- 差异 2：models.dev 记 M2 上下文 196,608，官方为 204,800——**models.dev 旧口径，以官方为准**
- models.dev 另有第三方通道条目（OpenRouter `minimax/minimax-m2.5-230b` 等历史型号、D.run `public/minimax-m25`），非官方平台口径，仅供通道价参考

## 7. 特化优化线索

1. **highspeed 变体（速度杠杆）**：~100 TPS vs 标准 60 TPS，输入/输出价 2x，但**缓存读取价与缓存写入价与基础版完全相同**（如 M2.7-highspeed 读 0.42/写 2.625 与 M2.7 一致）——缓存命中比例高的场景可用 highspeed 无损提速
2. **优先服务（SLA 杠杆）**：`service_tier=priority` 按 1.5x 计费，优先准入、更快响应、降低失败率（仅 M3 列示优先档价格）
3. **M3 永久五折**：定价页标注「永久五折」（非限时），现行价 = 原价的一半；成本计算用五折后价
4. **M3 能力特化**：Interleaved Thinking + 工具使用（SWE-Bench Verified/BrowseComp/xBench SOTA）；OpenAI 兼容接口需 `reasoning_split=True`（思考进 `reasoning_details`）或保留 `<think>` 标签，**多轮必须完整回传 assistant 消息含 thinking 块**，否则思维链中断
5. **M3 多模态**：Chat Completions 支持 image_url / video_url 输入
6. **M3 长上下文**：>512k 输入适用 2x 长上下文价，且**输入 token 含缓存命中部分**——长输入场景缓存收益边界需单独核算
7. **M2-her**：对话/角色扮演场景专用模型（64K），独立接口，适合非 Agent 会话类负载
8. **Token Plan 订阅**：Claude Code / Codex / Cursor / TRAE / Hermes Agent / OpenClaw 等编程工具官方集成（另见 token-plan 文档）；编程 Agent 场景还有 Coding Plan 通道
9. 缓存杠杆（被动/主动统一）：M3/M2.7 命中 20%、M2.5/M2.1/M2 命中 10%、写入 1.25x——双轨共存时优先考虑能走被动缓存的模型（M3）或主动断点（M2.x），M2 只能主动、M3 只能被动

## 8. 未获取项与口径差异（诚实边界）

1. **M2-her 价格未获取**：官方按量计费页语言模型表未收录 M2-her（其走 text-chat 接口，非 chat-completions 计费体系）
2. **输出上限官方未公布**：仅 models.dev 口径（§6），官方 text-generation 页只给上下文窗口
3. **主动缓存页 highspeed 输入价冲突**：anthropic-api-compatible-cache 页列 M2.7-highspeed 输入 2.1 元/1M，而按量计费页为 4.2 元/1M（USD $0.60 印证 4.2）——**以按量计费页为准，主动缓存页表格疑为旧值**
4. **与 00-catalog §7 差异**：00-catalog 记录 M3 输入 4.20/读取 0.84/输出 16.80 为**原价**，本次确认「永久五折」现行价 2.10/0.42/8.40；M2.x 价格与 00-catalog 一致；00-catalog 未收录 highspeed 变体——**00-catalog 需要刷新**
5. **M2.5.1 不存在**：官方清单 / models.dev / GitHub 均无此型号（见 §2）
6. 被动缓存 TTL 具体数值未公布（「随系统负载自动调整」）
7. 百炼通道 MiniMax 折扣（M3/M2.7 20%、M2.5/M2.1 10%）与官方直连一致（00-catalog §11 已有，本次未重复核实）
