# δ 轮通用执行规范

> 实现子 Agent = `00-总方案.md` + 你的维 `plans/04` 或 `plans/05` + `execution/γ-轮次报告.md` + 本文件 + `execution/δ-派单.md` 你那一行。  
> 轮次：δ。对应维：S4 ∥ S5。禁止 git commit / restore / reset / checkout。禁止派生子 Agent。

## 本轮鼓励

- S4：出站 JSON 的思考键值 = yaml 字典 **value** 原文（`ultra_wire_param` / `max` / `7777` / `HIGH`），不是前缀表、不是 `to_openai_str` 折叠。
- S4：`request_options` **每次** `live_catalog().find(provider_id, model)`。`provider_id` 空 → fail-closed（无思考键、`supports_image=false`），禁止 URL 猜。
- S4：四条 builder 只走 `assemble_thinking_dialect`。Chat else 枝删除。
- S4：纯文本+图在 `HttpProviderCall::stream`、HTTP 之前 `InvalidRequest`；禁止静默剥图。
- S5：唯一算费 `PricingEngine::calculate_cost`。cacheRead 从 prompt 扣、cacheWrite 不扣。前端只渲染 `formatted_total` / 「未定价」/「免费」。
- 本会话真跑你文件域测试。断言对象是将要 POST 的 JSON 或 `RunUsage.cost` 字符串，不是「函数已导出」。
- 中文注释，UTF-8 无 BOM。用编辑工具写文件，禁止 shell 重定向写中文。

## 本轮禁止

- `..Default::default()` / `..ChatCompletionsRequestOptions::default()` 而不写 `thinking_map`/`thinking_format`。
- 热路径 `bundled_catalog()`、`infer_reasoning_vendor`、`infer_thinking_capability`、`url.contains`、`is_openai_o_series`、`MODEL_SERIES_CAPABILITIES`。
- 生产 `to_chat_messages` 灌 `WireCompat::default()`。
- 无 yaml 声明仍发 `x-deepseek-harness-session-id`。
- 保留 Chat 84-150 兜底枝；无删除日期的 fallback。
- JS `estimateCostUsd*` / `input * 0.1` / 硬编码 `$` + `toFixed` 当会话账。
- `ModelPricingSpec::calculate_cost` 继续返回独立 f64。
- `From<ModelPricingSpec>` 继续 `tiers: Vec::new()` 静默丢阶梯。
- session-loop 新增 `agent-provider` 依赖。
- 改 Composer / Picker / `useModelConfigSession` / 设置 CSS。
- 提交或「顺手修」`modelCatalog*` 旧岛。
- 宣称 4000 用户路径已过（本轮默认未跑）。
- 新增 TODO / 临时 / 双轨读 / 无日期降级。
- 界面 Emoji。内核沙箱、动态换模、环形缓冲。

## 阅读集（禁止要求聊天记录）

1. `docs/model-config-product-chain/00-总方案.md` §0–§5、L 锁、M2/M6/M7
2. 你的维：`plans/04-出站方言与多模态产品闭环.md` **或** `plans/05-计费入账与费用呈现.md` 全文
3. `docs/model-config-product-chain/00-调度与执行纪律.md` L5–L9
4. `execution/γ-轮次报告.md` 第七节
5. 本文件 + `execution/δ-派单.md` 你那一行与互斥表

## 并行纪律

- 只改派单写集。必须动他人文件 → 写入汇总「遗留」，停手上报。
- 先读互斥表。`engine_provider.rs` 只有 δ-1；`engine_build.rs` 只有 δ-9；`dialect.rs` 只有 δ-3。
- Anthropic/Gemini options 缺字段：δ-5/δ-6 开工先加；δ-1 可只加字段声明两行。
- 不要删除 `bundled_catalog()` 符号，只停止自己热路径调用。

## 验证

- 源码形状：你负责的 grep 反例必须本会话跑过。
- 真跑测：完整命令、是否本会话真跑、绿/红。没跑就写没跑。
- 用户路径：本轮默认未跑 4000。S4 用 yaml 夹具 + `reload_live_catalog` + builder/`stream` 体断言仍算本维可检查请求体。
- S4 至少钉 W1（自定义 wire 值）或 M1（纯文本+图硬拒）之一，禁止只改 dialect 纯函数测冒充宿主。
- S5 至少钉「同一 usage，改 live 单价，`formatted_total` 变」或「无 pricing → 未定价且不调用 estimateCostUsd」。

## 轮末汇总格式

```
## 轮末汇总：<Agent 编号> / <任务单元>
- 目标：
- 完成：<路径:行号>
- 未完成：
- 新发现：
- 遗留：
- 验证-源码形状：
- 验证-本会话真跑测：<命令 + 出口>
- 验证-用户路径：本轮未跑 4000
- 新引入 fallback/TODO/双轨：必须 0
```
