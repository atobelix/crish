# Round 4 小结 · 校验面（G8-b 请求拒绝 + G6 改名/头 + G5-c 方言 + 一致性闸）

> 战役：`docs/provider-adapter-campaign/` · 定稿方案 §三 轮次 4
> 日期：2026-08-14 · 主控收束

## 一、完成项（含测试证据）

| 单元 | 任务                                                                                                               | 结果 | 测试证据                                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------------------- |
| A1   | vendor 一体改造：T4.1 拒绝校验（三态分流 + 降级开关）+ T4.2 模型级改名 + T4.4 beta 头跳过 + T4.5 方言/off disabled | ✅   | `request::vendor` 35 passed（+14 新）；vendor.rs 397 行（≤400 门禁，拆 reject.rs/dialect.rs）；deepseek_invariants 6 passed 保持 |
| A2   | catalog.json 模型级档位数据补录                                                                                    | ✅   | `models::catalog` 42 passed；deepseek-v4-flash/pro → `{high,max}`；glm-5-2 → `{low:"high",medium:"high",...}` 改名               |
| A3   | 描述面↔校验一致性回归闸                                                                                            | ✅   | `consistency_gate_tests` 6 passed（白名单≡接受集 / 坏配置不藏 / wire 一致 / 三态分流）                                           |
| A5   | anthropic/gemini 轨跨层集成验证                                                                                    | ✅   | `tests/wire_integration.rs` 13 passed（思考档位链路 / beta 头 / INV-07 交替 / 路由跨层）                                         |

**主控全量核验（真跑）**：agent-provider **661 passed; 0 failed; 0 ignored**（lib + 全部集成二进制）；`cargo check --workspace` 干净。

## 二、契约登记（引用 A1 详档 `execution/round4-校验面-vendor一体.md` 的 C17-C20）

- **C17 拒绝语义**：`ReasoningReject.kind=InvalidRequest`（复用既有分类）；三态 `ReasoningEffortState{Omitted/Default/Explicit}`；`DegradePolicy`（默认 Reject，`AllowDegrade` 兼容开关）。
- **C18 模型级改名**：`wire_effort_for` 命中 → 模型级 wire 拼写（`{medium:"high"}` → `reasoning_effort:"high"`）；隐藏档（None）→ 拒绝（unsupported）。
- **C19 头策略**：`reasoning_effort_headers_for_model` 模型感知版（adaptive 新代际跳过 beta 头）；既有 2 参签名保留（生产调用点兼容）。
- **C20 方言**：`ReasoningFormat` 扩展 qwen `enable_thinking` / zai `thinking:{type}` / openrouter `reasoning:{effort}`；deepseek off → `thinking:{type:"disabled"}`。

**A1 设计约束（R5 承接）**：

1. 未新增 `ReasoningVendor` 变体（避免破坏壳层 `protocol.rs` 穷举 match）——方言经 `ReasoningFormat` 承载；
2. **生产请求面 I/O 前拒绝的接线未落**（`build_chat.rs` 请求构建入口 / engine_provider 装配不在 A1 文件域）——**R5 T5.4 复核链核查**；
3. `reasoning_effort_headers_for_model` 供 R5 切换消费。

## 三、主控裁决与记录

1. **A5 上报：catalog mode 数据缺口**——`bundled_catalog()` 的 anthropic/gemini 条目 `mode` 仍为 `"chat"`，四轨专轨路由在**目录数据层未激活**（C12 消费面真实缺口）。→ **派 A6 数据补录**（anthropic 系/gemini 系条目 mode 补 `"anthropic"/"gemini"`），R5 前完成。
2. **A2 宁缺毋滥**：hy3 无目录条目、qwen3-8-max 无 pi-ai thinkingLevelMap（保留旧数组）、kimi-k3 数据分裂未写——记录，不强行补。
3. **并行波动**：A1 in-flight 期间多 Agent 编译波动（自愈）；各 Agent 绿窗口独立验证，最终 661 全绿。
4. **历史溢出**：consume/mod.rs 891、messages.rs 531（R3 已登记）——R6 决定是否另开。

## 四、基线变化

- 轮前：R3 674 passed
- 轮后：**661 passed**（净变化：+14 vendor +6 consistency +13 wire_integration +3 catalog 相关调整，部分既有断言随行为变更更新——行为变更随行为变更，禁删测试纪律保持）

## 五、对下一轮（R5 边缘协议 + 前端收敛 + 全量回归）的输入

- 依赖：C17-C20（拒绝/改名/头/方言）+ A6（mode 数据补录）+ C9-C16（前轮契约）
- R5 任务：T5.1 边缘协议解析器（≥1 先例）、T5.2a/b 前端 profile 收敛（引擎服务 opencode-go profile + 档位面板单源）、T5.3 全量门禁回归、T5.4 回归复核（含 **A1 遗留的请求面拒绝接线核查** + A5 的 C12 数据激活验证）
- 注意：T5.2 依赖 C2（多提供方配置）+ C9（描述接口）接线到前端（apps/crish-desktop）；T5.4 是复核不改码（发现断链报主控裁决）
