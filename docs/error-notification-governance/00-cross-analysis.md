# 错误提示收敛 + 对话流一致性 · 主控交叉对比结论（00）

> 主控整合：`docs/error-notification-governance/10-analysis/01~04` 四份子 Agent 深度分析的交叉对比、互证与收敛。
> 日期：2026-08-09。性质：分析汇总 + 待用户裁决清单（**所有展示面保留/去掉由用户裁决**）。

---

## 0. 一句话总览

用户反馈的三个现象（秒弹错误、重复多报、对话流多输出/少显示）经四份独立分析交叉验证，收敛为 **2 个机制根因 + 1 个文案失真 + 1 个事件唯一性缺口**：
① 同一次 run 失败在**事件面收敛了但展示面三路并报**（横幅+toast+气泡）；② 引擎未就绪时**每次发送独立触发一次失败播报**且 catch 兜底**恒报网络文案**；③ 文案「正在自动恢复」与事实不符（提示出现时重试已耗尽、transport 无重连）；④ 对话流缺**事件层消费侧去重**（防重复全押在引擎单发单点）+ message-end 合并**无精确对账**（丢帧后启发式失败 → 内容追加重复）→ 多输出；子代理事件无跨 run 订阅者 + 多轮 hydrate 覆盖 → 少显示。

---

## 1. 四份文档交叉互证矩阵

| 发现 | 01 触发链 | 02 展示面 | 03 服务语义 | 04 流一致性 | 互证 |
|---|---|---|---|---|---|
| onRunError 三路并报（横幅+toast+气泡） | R2（useStreamCallbacks.ts:598-633） | §1 通道 E、§3.3-1 | §② 路径 A/B | R5（失败四源各触发 onRunError） | **强**（01/02/04 独立收敛同一分发点） |
| 秒弹 = 发送前就绪检查失效 + 恒报 network 文案 | R3/R7（ConnectionLifecycle.ts:325-343,494-500） | §3.1 路径 | §② 两级丢弃 detail | — | **强**（01/03 独立定位同一代码） |
| 「正在自动恢复」不真实 | §3.3（重试耗尽才 fatal，transport 无重连） | — | §③（唯一自动恢复=引擎内重试阶梯，80% 场景不成立） | — | **强**（01/03 独立实读同一结论） |
| 文案三处不一致 | §3.4（userFacingErrors:90 vs useStreamCallbacks:622 vs MessageContent:89） | §1 通道 D 兜底 | §④（networkUserMessage 忽略 detail） | — | **强**（01/02/03 三处实读） |
| 展示唯一性缺口（横幅无去重、无通道互斥） | R6（index.ts:35-47 无去重） | §3.3-2/3、§5.1 | — | — | **强**（01/02 独立） |
| 事件层无消费侧去重 | R5（surface 无 run 级去重） | — | — | G1/G2（EventRouter.ts:93-96 明示不校验 sequence） | **强**（01/04 独立收敛"防重复押单点"） |
| message-end 合并启发式失败 → 追加重复 | — | — | — | R1/M3（eventUtils.ts:41-54 子串判定） | 单点（04，对话流多输出主因） |
| 子代理事件无全局订阅 → 少显示 | — | — | — | M1/G5（dataPlaneRouter 不收 subagent-*） | 单点（04） |
| 多轮 hydrate 覆盖 → 少显示 | — | — | — | M2/G4（sessionEventHydrate.ts:262-268 覆盖非追加） | 单点（04） |
| toast 通道已有同文案去重（唯一已生效的收敛面） | §5.1（useToastQueue.ts:387-406） | §1 通道 A | — | — | 正面证据：现有 dedupe 有效 |
| StatusDiagnosticsPanel 死组件 | — | §1 通道 S | — | — | 与 stability 02 文档互证 |

---

## 2. 交叉提炼的 5 个机制结论

### 结论 1：事件面已收敛，展示面未收敛（"唯一性"断在展示层）
- EventRouter 四源 → surfaceStreamFailure 单一出口（BridgeErrorPolicy.ts:14-41）已收敛；但 onRunError 内部**一次错误同时推横幅(14s) + toast(5s) + 气泡错误卡(持久)**（useStreamCallbacks.ts:578-634）——展示面无"唯一性"裁决。
- **收敛点**：onRunError 按错误分类选面（network/恢复类 → 输入框上方持久条；有正文失败 → 仅气泡卡；无正文失败 → 仅横幅；可行动错误 → 横幅+一次 toast）。

### 结论 2：秒弹 = "快查 + 陈旧 latch" + 两级丢弃
- `waitUntilConnected(1.5s)` 快查 + `transport.ready` 置 true 后**永不刷新**（tauriTransport.ts:125/239）→ 引擎真实状态变化不反映；Rust 门禁 invoke 时立即拒绝 → catch 兜底**恒报 network 文案且丢弃 detail**（ConnectionLifecycle.ts:494-500）。
- **收敛点**：发送前实时 `core_get_status` 查询（不信 latch）+ catch 传 detail + 按失败域差异化文案（03 §④ 的 S1-S6 六域）。

### 结论 3：「正在自动恢复」是虚假承诺
- 提示出现时 = 引擎重试阶梯已**耗尽并 fatal**（stream_error.rs:237）；transport 无心跳无重连（tauriTransport.ts:17）；「自动恢复」唯一真实对应（引擎内瞬态重试）发生在**用户无感**阶段。
- **收敛点**：文案与事实对齐（S1-S6 分域），或先实现真恢复（03 §⑤ R1-R7 + 02 H1-H9）。

### 结论 4：对话流多输出 = message-end 全文合并无精确对账
- 丢帧/终稿修订时 `mergeAssistantTextPiece` 四判据全不中 → `\n\n` 追加（eventUtils.ts:41-54）→ 同一内容"增量版+终稿版"两段共存（R1）。
- **收敛点**：message-end 为**终态权威**——不一致时以 p 为准（不做拼接），onChunk 按 slice(prevLen) 补差额（04 §5.1-2）。

### 结论 5：对话流少显示 = 事件无消费方 + hydrate 覆盖
- 子代理事件（subagent-*，信封 runId=父 run）仅 per-run 路由消费，父 run 收口即断（M1）→ 子代理时间线停滞；
- 多轮 run hydrate 同 clientMessageId 折叠后 `a.text = text` **覆盖**只剩末轮（M2）；
- **收敛点**：subagent-* 加全局路由面（dataPlaneRouter 模式）+ message-end 补 turnIndex 前端按段合并。

---

## 3. 展示面收敛建议总表（**待用户裁决**）

> 约定：A=保留、B=收敛（降级/合并/去重）、C=移除。⭐=与用户四条原则直接相关。

| # | 通道 | 现状问题 | 选项 | 建议 |
|---|---|---|---|---|
| 1 | **onRunError 三路并报**（横幅+toast+气泡同文案）⭐ | 一次错误三面齐报 | A 维持 / **B 分级分发**（network→持久条；有正文→仅气泡卡；无正文→仅横幅；可行动→横幅+一次toast）/ C 单通道 | **B**（核心收敛） |
| 2 | **「服务暂时不可用」**（network 文案）⭐ | 秒弹 + 三处文案不一致 + 虚假"自动恢复" | A 保留现文案 / **B 差异化六域文案 + 输入框上方持久条（恢复即消失）** / C 移除 | **B**（用户原则④：持久于输入框上方） |
| 3 | **横幅（RunNoticeBar）无去重**⭐ | 同文案重复 push 仅刷新 TTL | A 维持 / **B 加同文案去重（对齐 toast dedupe）** | **B** |
| 4 | **toast 的 network 类错误** | 与横幅/气泡重复 | A 保留 / **B network 类不进 toast（转持久条）** / C 移除 | **B**（配合 #2） |
| 5 | **气泡错误卡**（MessageContent errorDetail） | 持久 + 与横幅/toast 重复 | A 保留 / **B 保留但文案同源 + 有正文时不再弹横幅/toast** / C 移除（执行 deprecated） | **B** |
| 6 | **发送前就绪检查** | 陈旧 latch + 1.5s 快查 → 秒弹 | A 维持 / **B 发送前实时查询 core_get_status + 未就绪不产生失败 run（仅一次提示）** | **B**（秒弹根因） |
| 7 | **ToastBus 死通道** | 无渲染器的第二套 toast，3 处调用"发射即不可见" | A 保留 / **B 迁移到 useToastQueue（真错误可见、成功静默）** / C 删除 | **B 或 C** |
| 8 | **StatusDiagnosticsPanel**（死组件） | 未挂载，仅测试引用 | B 挂载到设置页 / **C 移除** | 待裁决（stability 02 建议挂载做健康展示） |
| 9 | **对话流 message-end 合并**⭐ | 丢帧后追加重复（多输出） | A 维持 / **B 终态权威（以 message-end 全文为准）** | **B**（多输出根因） |
| 10 | **子代理事件路由**⭐ | 父 run 收口即断流（少显示） | A 维持 / **B 全局 subagent 路由面** | **B**（少显示根因） |
| 11 | **多轮 hydrate 覆盖**⭐ | reload 后只剩末轮文本（少显示） | A 维持 / **B message-end 补 turnIndex + 按段合并** | **B** |
| 12 | **事件层消费侧去重** | 防重复全押引擎单发 | A 维持 / **B per-run 已消费事件集合（type+messageId+sequence 键幂等）** | **B**（唯一性兜底） |

---

## 4. 实施路线（用户裁决后派发）

```
轮次 1（提示收敛，前端为主）：
  T-1 onRunError 分级分发（#1）+ 横幅去重（#3）+ toast 门闩（#4）+ 气泡文案同源（#5）
  T-2 差异化文案六域（#2：S1-S6 + networkUserMessage 消费 detail）
  T-3 发送前就绪检查（#6：实时 core_get_status + 未就绪单次提示）
  T-4 ToastBus 迁移/清理（#7）+ StatusDiagnosticsPanel 裁决落地（#8）

轮次 2（对话流一致性，Rust+前端）：
  T-5 message-end 终态权威合并（#9：eventUtils.ts + messageHandlers.ts）
  T-6 subagent 事件全局路由（#10：dataPlaneRouter 模式）
  T-7 message-end 补 turnIndex + hydrate 按段合并（#11）
  T-8 事件层消费侧去重（#12：per-run 幂等集合）

轮次 3（回归验证）：
  T-9 全量门禁（cargo test --workspace + vitest 全量 + typecheck）
  T-10 冒烟验证：发送失败 → 单面提示、无重复；多轮对话 live vs reload 一致
```

---

## 5. 待用户裁决清单（汇总）

1. **onRunError 分级分发**（B 方案：按错误类型选展示面）— 采纳？
2. **「服务暂时不可用」**：差异化六域文案 + 输入框上方持久条（恢复即消失）+ 不再秒弹 toast — 采纳？文案选项（03 §④ 表 A/B）？
3. **ToastBus 死通道**：迁移到 useToastQueue（B）还是直接删除（C）？
4. **StatusDiagnosticsPanel**：挂载到设置页（B）还是删除（C）？
5. **对话流三项**（终态权威合并 / subagent 全局路由 / turnIndex 按段合并）— 全部采纳？
6. **事件层消费侧去重**（per-run 幂等集合）— 采纳？
