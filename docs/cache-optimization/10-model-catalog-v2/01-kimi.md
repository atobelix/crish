# Kimi（月之暗面 Moonshot）模型目录与定价 v2

> 调研子代理 R1 产出：Kimi 全系模型清单与定价核实（2026-08 快照）。
> 本文档是对 `00-vendor-model-pricing-catalog.md` §5（原仅 K3 一条）的补全；未核实项一律标注「未获取/未确认」，不编造数字。

## 文档信息

- **获取日期**：2026-08-03
- **来源 URL**（均为官方文档，经 `platform.kimi.com/docs/llms.txt` 索引发现）：
  - 模型列表：https://platform.kimi.com/docs/models.md
  - 定价总览：https://platform.kimi.com/docs/pricing/chat.md
  - K3 定价：https://platform.kimi.com/docs/pricing/chat-k3.md
  - K2.7 Code 定价：https://platform.kimi.com/docs/pricing/chat-k27-code.md
  - K2.6 定价：https://platform.kimi.com/docs/pricing/chat-k26.md
  - K2.5 定价：https://platform.kimi.com/docs/pricing/chat-k25.md
  - Moonshot V1 定价：https://platform.kimi.com/docs/pricing/chat-v1.md
  - Batch 定价：https://platform.kimi.com/docs/pricing/batch.md
  - 上下文缓存指南：https://platform.kimi.com/docs/guide/use-context-caching-feature-of-kimi-api.md
  - Chat API（含 prompt_cache_key / usage.cached_tokens）：https://platform.kimi.com/docs/api/chat.md
  - 模型参数参考（含 reasoning_effort 与缓存关系）：https://platform.kimi.com/docs/api/models-overview.md
  - K2.7 Code 快速开始：https://platform.kimi.com/docs/guide/kimi-k2-7-code-quickstart.md
- **币种说明**：月之暗面官方仅以人民币（CNY）计价，所有价格为 ¥/1M tokens；官方文档无美元定价，无需换算。

---

## 1. 官方模型清单（已核实，models.md 原表）

### 1.1 现行模型（5 个主模型 + 2 个变体）

| 官方模型名                 | 类型              | 说明                                                                                          |
| -------------------------- | ----------------- | --------------------------------------------------------------------------------------------- |
| `kimi-k3`                  | 旗舰              | 2.8 万亿参数，原生视觉，1M 上下文；始终推理，`reasoning_effort` low/high/max（默认 max）      |
| `kimi-k2.7-code`           | Coding 模型       | 面向代码场景；256K 上下文；**仅思考模式**（不可关闭），Preserved Thinking 固定开启            |
| `kimi-k2.7-code-highspeed` | Coding 模型高速版 | 与 k2.7-code 同模型、参数完全一致，仅输出速度约 180 token/s（短上下文可达 260 token/s）       |
| `kimi-k2.6`                | 通用              | 视觉 + 文本/视频输入；思考可开关（`thinking.type`）；Preserved Thinking 可选（`keep: "all"`） |
| `kimi-k2.5`                | 通用              | 视觉 + 文本输入；思考可开关；**已停止向新注册用户开放，8 月 31 日全平台下线**                 |

### 1.2 Moonshot V1（生成模型，即将下线）

| 官方模型名                        | 上下文  | 说明     |
| --------------------------------- | ------- | -------- |
| `moonshot-v1-8k`                  | 8,192   | 短文本   |
| `moonshot-v1-32k`                 | 32,768  | 长文本   |
| `moonshot-v1-128k`                | 131,072 | 超长文本 |
| `moonshot-v1-8k-vision-preview`   | 8,192   | 视觉     |
| `moonshot-v1-32k-vision-preview`  | 32,768  | 视觉     |
| `moonshot-v1-128k-vision-preview` | 131,072 | 视觉     |

> V1 系列与 k2.5 一样：停止向新注册用户开放，**预计 8 月 31 日全平台下线**（pricing/chat.md 与 models.md 均标注）。

### 1.3 已下线模型（不提供价格）

| 模型名                                                                                                                    | 下线时间   |
| ------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `kimi-k2-0905-preview` / `kimi-k2-0711-preview` / `kimi-k2-turbo-preview` / `kimi-k2-thinking` / `kimi-k2-thinking-turbo` | 2026-05-25 |
| `kimi-latest`                                                                                                             | 2026-01-28 |
| `kimi-thinking-preview`                                                                                                   | 2025-11-11 |

> 另：OpenAPI discriminator 中仍保留 `moonshot-v1-auto` 映射，但模型列表页与定价页均未收录，视为遗留别名（未确认可否调用）。

---

## 2. 完整定价表（¥/1M tokens，官方各定价页，2026-08-03）

| 模型                              | 上下文窗口 | input（未命中） | cache_read（命中）       | output  | cache_write | 币种 | 备注                                                                                                 |
| --------------------------------- | ---------- | --------------- | ------------------------ | ------- | ----------- | ---- | ---------------------------------------------------------------------------------------------------- |
| `kimi-k3`                         | 1,048,576  | ¥20.00          | ¥2.00                    | ¥100.00 | 无（免费）  | ¥/1M | 旗舰；始终推理 + Preserved Thinking；max_completion_tokens 默认 131072、最大可设 1048576；命中 = 10% |
| `kimi-k2.7-code`                  | 262,144    | ¥6.50           | ¥1.30                    | ¥27.00  | 无（免费）  | ¥/1M | Coding 模型；仅思考模式；Preserved Thinking 固定开启；命中 = 20%                                     |
| `kimi-k2.7-code-highspeed`        | 262,144    | ¥13.00          | ¥2.60                    | ¥54.00  | 无（免费）  | ¥/1M | 与 k2.7-code 同模型，价格 2 倍；命中 = 20%                                                           |
| `kimi-k2.6`                       | 262,144    | ¥6.50           | ¥1.10                    | ¥27.00  | 无（免费）  | ¥/1M | 通用 + 视觉；命中 ≈ 16.9%                                                                            |
| `kimi-k2.5`                       | 262,144    | ¥4.00           | ¥0.70                    | ¥21.00  | 无（免费）  | ¥/1M | 通用 + 视觉；命中 = 17.5%；8/31 停用                                                                 |
| `moonshot-v1-8k`                  | 8,192      | ¥2.00           | 未提供（定价表无命中列） | ¥10.00  | —           | ¥/1M | 8/31 停用                                                                                            |
| `moonshot-v1-32k`                 | 32,768     | ¥5.00           | 未提供（定价表无命中列） | ¥20.00  | —           | ¥/1M | 8/31 停用                                                                                            |
| `moonshot-v1-128k`                | 131,072    | ¥10.00          | 未提供（定价表无命中列） | ¥30.00  | —           | ¥/1M | 8/31 停用                                                                                            |
| `moonshot-v1-8k-vision-preview`   | 8,192      | ¥2.00           | 未提供（定价表无命中列） | ¥10.00  | —           | ¥/1M | 8/31 停用                                                                                            |
| `moonshot-v1-32k-vision-preview`  | 32,768     | ¥5.00           | 未提供（定价表无命中列） | ¥20.00  | —           | ¥/1M | 8/31 停用                                                                                            |
| `moonshot-v1-128k-vision-preview` | 131,072    | ¥10.00          | 未提供（定价表无命中列） | ¥30.00  | —           | ¥/1M | 8/31 停用                                                                                            |

要点：

- **cache_write（缓存写入）**：K3 / K2.7-Code / K2.6 / K2.5 官方定价表均只有「命中 / 未命中 / 输出」三列，无写入价 → **缓存写入免费**（与 OpenAI 旧轨、DeepSeek 同属免费写入阵营）。
- **命中折扣**：K3 = 10%（¥2.00/¥20.00）；K2.7-Code 系 = 20%；K2.6 ≈ 16.9%；K2.5 = 17.5%——与 `01-reference-research/vendor-cache-gaps.md` §1.3 百炼通道口径（k3 10%、k2.6 16.9%、k2.5 17.5%）**完全一致**，可交叉验证。
- **Batch API**（标准价 60%，仅支持 k2.7-code/k2.6/k2.5）：k2.7-code ¥0.78/¥3.90/¥16.20；k2.6 ¥0.66/¥3.90/¥16.20；k2.5 ¥0.42/¥2.40/¥12.60。

---

## 3. 缓存机制说明（已核实）

### 3.1 基本机制（缓存指南 + API 文档）

- **全自动 Context Caching**：对所有模型请求自动启用；无需手动创建、无缓存 ID、无 TTL 管理（生命周期系统管理）。
- **最低缓存量**：前一请求的 prompt tokens **> 256** 才会被缓存；≤256 的请求不被缓存（直接丢弃）。
- **命中条件**：检测到重复的初始上下文（system prompt、知识文档、工具定义、历史消息）自动复用；多轮对话建议把固定大段上下文放 `messages` 数组最前面。
- **命中收益**：固定长上下文高频查询场景，首 Token 延迟平均 <5s，最高可降本 90%。
- **cache_control**：不支持（纯自动，无任何手动断点参数）。
- **计量字段**：`usage.cached_tokens`（OpenAI 兼容格式，**顶层 usage 字段**，非嵌套 details——与 OpenAI/Anthropic 系格式均不同，适配层需单独处理）。
- **命中不保证 100%**：官方为 best-effort 语义（文档未承诺确定性命中）。

### 3.2 prompt_cache_key（API 请求参数，已核实）

`/v1/chat/completions` 请求体支持 `prompt_cache_key`（string，默认 null），官方原文：

- 用于缓存相似请求的响应以优化缓存命中率；
- 对于 **Coding Agent**：通常是代表单个会话的 session id 或 task id，**退出并恢复会话时应保持不变**；
- 对于 **Kimi Code Plan：此字段为必填**以提高缓存命中率；
- 对于其他多轮对话 Agent，也建议使用此字段。

即：路由辅助（会话级粘性）而非显式断点；Coding 场景必填。

### 3.3 与推理参数的缓存关系（已核实，models-overview.md）

- `kimi-k3` 的 `reasoning_effort`：**切换档位会破坏前缀缓存命中**，建议在会话开始前确定档位、中途不切换。
- K3 与 K2.7-Code 始终开启 Preserved Thinking（历史轮 `reasoning_content` 保留在上下文中）；K2.6 可用 `thinking.keep: "all"` 显式开启。多轮对话必须把每轮 assistant 消息的 `reasoning_content` 原样回传，否则丢推理上下文——这也意味着推理块是缓存前缀的一部分，前缀必须稳定。

---

## 4. 特化优化线索（Coding 与缓存的关系，已核实）

1. **官方命名核实**：Coding 特化模型官方名为 **`kimi-k2.7-code`**（及高速版 `kimi-k2.7-code-highspeed`）；**不存在** `kimi-k2.7` 通用版（官方模型列表只有 code 变体）；**不存在**「kimi-for-coding」之类的命名。第三方通道（阿里云百炼）使用的 `kimi-k2.7-code` 与官方命名一致（见 vendor-cache-gaps.md §1.2）。
2. **K2.7 Code 是「Coding 主打」的官方定位**：长上下文指令遵循与编程成功率提升（Kimi Code Bench v2 +21.8%、Program-Bench +11%、MLS Bench Lite +31.5% 对比 K2.6）；同时支持视觉与工具调用（多步工具调用必须保留 `reasoning_content`）。
3. **Coding 场景缓存收益结构**：K2.7-Code 输入 ¥6.50、命中 ¥1.30（20% 折扣）+ 写入免费 + `prompt_cache_key` 必填（Kimi Code Plan）+ Preserved Thinking 固定开启（上下文前缀稳定）→ 官方给 coding agent 的降本组合拳就是「稳定前缀 + 会话级 key」。
4. K2.7-Code 的「仅思考模式 + 固定保留推理」意味着输出侧 `reasoning_content` 也进入上下文参与前缀计算，工具循环中前缀增长可控、命中延续性好；切换 `temperature`/`top_p`/`n` 等参数会报错（固定值），客观上强制了前缀稳定。
5. 与既有目录对照：`00-vendor-model-pricing-catalog.md` §5 的 K3 价格（¥20/¥2/¥100、1,048,576）本次复核无误；§12.3 刷新清单中「Kimi K2.x 待补」项已由本文档补全（K2.5/2.6/2.7-code + highspeed）。

---

## 5. 未获取 / 未确认项（诚实边界）

1. **moonshot-v1 系列是否有缓存命中价**：定价表（chat-v1.md）只有「输入 / 输出」两列、无命中列；缓存指南称「对所有模型请求自动启用」——两处口径并存，V1 能否享受命中折扣**未确认**，建议实测（对比 `usage.cached_tokens` 计费）。
2. **`moonshot-v1-auto`**：OpenAPI 中有映射、列表页无收录，状态与可调用性**未确认**。
3. **K3 的 1M 上下文计费细分**：官方定价页只给 1M 总窗口 1,048,576，输入超长段的阶梯价未提及（按当前文档即为单一价）。
4. **命中率/缓存 TTL 具体时长**：官方未公布（只说明生命期系统自动管理、首 token 延迟平均 <5s），无数字可引。
5. **K2.5/K2.6 下线后的 API 行为**：8/31 全平台下线后是否继续可用、价格是否维持，官方未公告（以 models.md 下线声明为准）。
6. 全系无官方美元定价；如需 USD 口径须自行按汇率换算（本文档不换算）。
