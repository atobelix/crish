# 02：缓存命中率最大化设计——固定折叠边界 + 前缀稳定三角 + 注入卫生

- 撰写日期：2026-08-08
- 文档性质：分析方案（只读研究 + 本文件；未修改任何源代码）
- 所属系列：`docs/cache-optimization/05-memory-resilience/`（10-analysis 分析层）
- 前置事实（均经实读核实，行号以 2026-08-08 实读为准）：
  - P1（前缀稳定性）/ P4（历史回流 + compaction 接线）/ P5（缓存遥测）已全部落地：`tools_snapshot` 快照锁定（handlers/mod.rs:84、streaming.rs:54）、`apply_compaction` 单一广播点（handlers/mod.rs:314-414）、`CacheStatsTracker` 全套（cache_tracker.rs）、`conex-telemetry::cache` 纯函数（signature.rs / miss.rs / math.rs / cold.rs）、`context.compact.*` 钩子（hooks.rs:484-496 附近）。
  - 本分析聚焦 P1/P4/P5 交汇后的**剩余最大命中率漏洞**：压缩（compaction）作为唯一前缀重写点，其"摘要消息被反复重写"的行为使每次压缩都作废全部 system 之后的前缀，旧摘要与旧保留区永远无法跨压缩命中。

> **姊妹分析导航（同组并行产出，2026-08-08）**：
> - `01-compression-recoverable.md`（压缩可追溯/可恢复）：聚焦"摘要块落库 + 块 id + 回放"，与本文 §2 折叠链是同一问题的两面——01 解决"丢了的原文去哪找"，本文解决"留下的字节能不能命中"；两稿独立发现同一缺陷（摘要 id = `compacted-summary-{dropped_ids.len()}` 可重复，见 01 §1.1 与本文 §1.2 根因 B/T-09）。实施顺序建议：先 A02 折叠链（命中率），后 01 压缩块（可持续性），block_id 可直接复用折叠链的 fold_index 语义。
> - `04-summary-evolution.md`（摘要层演化）：L2 摘要文档化（JSON 规范面）、句柄 stub、existing 迭代合并升级。与本文交汇点：D5 对 `existing`（lib.rs:459-464）的"取链尾文本"与 A02 T-07 一致；L1 静态占位符删除决策（D2）不影响折叠链（链 = AgentMessage 面 compacted-summary 消息，占位符与链共存不冲突）。

## 结论先行

1. **压缩的命中率问题不在"压缩本身"，而在"摘要消息被反复重建"**：现行 `compact_agent_messages` 每次压缩都把既有 `compacted-summary` 消息丢弃并重建（lib.rs:448-464、496-516），摘要字节随压缩代数变化 → system 之后的所有前缀每压缩一次就整体作废，跨压缩命中率恒为零。把摘要改为 **append-only 冻结折叠链**（fold chain）后，每次压缩只破坏"链尾之后新增区"，链本身成为跨压缩稳定的可命中前缀——这是最大化命中率的关键杠杆。
2. **折叠边界 = 链尾 + 1，必须单调前进**：`find_cut_point` 的尾部倒推、`min_recent_turns` 扩展、tool 配对扩展三条路径都要以链尾为下界钳制，保证同一块（摘要链消息）永不二次压缩；遍历序保证每个原始消息至多被折叠一次。
3. **时间戳/动态内容全部走"尾部注入"卫生清单**；目录树信息必须工具化（结果落为固定 tail 消息，mtime 失效才重抓），每轮注入会让树字节永远停留在 miss 区、纯浪费。
4. **测量增强**：压缩后"预测性签名重建"（把我方压缩后的前缀作为新签名基线，防 harness 二次改写不可见）+ muted 归因细化（定位首个差异点） + 压缩后命中率恢复曲线观测（验证服务端真的缓存了链）。

---

## 一、现状评估

### 1.1 已落地且良好的（本方案的基准）

| 面 | 落地证据 | 与本方案的关系 |
|---|---|---|
| 请求前缀字节稳定（P1） | tools 排序 + 快照（registry.rs `list_definitions` 排序；streaming.rs:54 `ensure_tools_snapshot`）；system 透传（`build_system_prompt`，agent-provider/request/build.rs）；消息构造确定性（messages.rs:76-103 固定插入序） | 本方案的**必要前提**（无稳定前缀则折叠链也救不回命中率） |
| 历史回流 + 压缩接线（P4） | `with_initial_conversation_arc`（loop/mod.rs:300-303）；`maybe_compact_preflight`（handlers/mod.rs:266-301）；`apply_compaction`（handlers/mod.rs:314-403）；`estimate_context_tokens` 双源（lib.rs:347-356）；时间戳护栏与单run计数（handlers/mod.rs:107-110、351-352） | 本方案改的就是这个面的**压缩产物形态** |
| 测量（P5） | `CacheStatsTracker`：capture_signature（cache_tracker.rs:158-165）、record_usage（:178-235）、on_compaction（:239-242）；`MissDetector`/`classify`（miss.rs）；C9 口径（math.rs） | 本方案增强其**压缩后归因与恢复曲线** |
| 事件面 | `ContextCompressionStart/End` 已广播（handlers/mod.rs:342-402）；`ContextCompressionRecord.cache_boundary` 字段已存在但恒为 None（handlers/mod.rs:380，tool.rs:486-489） | 本方案填充 `cache_boundary` |

### 1.2 压缩折断的全部根因（证据链）

**根因 A：摘要消息随代数重写**。`compact_agent_messages`（lib.rs:420-534）执行：

1. 丢弃区间 `messages[..cut]` 内全部非 system 消息（lib.rs:448-452）——**包含上一轮生成的 `compacted-summary-*`**；
2. `existing` 取 "messages[..cut] 中第一个 compacted-summary 文本"（lib.rs:459-464）；
3. 生成新的摘要消息（lib.rs:496-516），id = `compacted-summary-{dropped_ids.len()}`（lib.rs:502-503）。

后果：压缩存在产物的字节 = 压缩代数的函数。请求前缀（system → 摘要 → 保留区）在每次压缩后都与上一次完全不同（摘要字节不同 = 前缀第一个字节起就分叉），**服务端 LCP 缓存只能命中到 system 为止**。旧摘要、旧保留区永远无法命中。

**根因 B：摘要 id 与丢弃数耦合**（lib.rs:502-503）：两次压缩丢弃相同条数时 id 相同（`compacted-summary-5` 两次出现），链检测与事件、审计混淆。

**根因 C：预算倒推把摘要计入 keepRecentTokens**（lib.rs:560-568）：摘要链 token 若大，会挤占保留预算，甚至导致压缩后仍超预算、压缩失败（cut 前移到摘要区内）。

**根因 D：tool 配对保护与 min_recent_turns 可能回到摘要区**（lib.rs:577-636）：孤儿 tool result 回扫可越过摘要区，使"保留段"包含摘要消息——摘要不是 tail 的一部分，不该进保留段。

### 1.3 测量面的现状与盲点

- 压缩代数 +1 / 基线作废（cache_tracker.rs:237-242）正确：压缩后不计 miss（新内容非重放），首请求后重建基线——已有。
- **盲点 1**：压缩与首请求之间的"二次前缀改写"不可见。`on_compact_` 直接抹 baseline；若 harness 在压缩后、下一请求前又改写了前缀（bug / 另一处压缩），不会被检测（`classify(None,...)` 返回 Unknown，miss.rs:88-98）。
- **盲点 2**：压缩后首请求应归因 Compaction（planned dip）不按 Cold，`classify_miss` 的 `Compaction` 分支是"正常不可达的防御分支"（cache_tracker.rs:319-324）。
- **盲点 3**：prefix 归因只有"某类变了"（system/tools/messages 之一，miss.rs:88-98），无"第几条消息变了"的定位——修 harness 自伤时查证困难。
- **盲点 4**：压缩后链究竟有没有被服务端缓存（DeepSeek LRU 容量、TTL），测量层无恢复曲线观测。

---

## 二、固定边界机制设计

### 2.1 核心：append-only 冻结折叠链（fold chain）

**折叠块 = 一条摘要消息。折叠边界 = 两条相邻摘要消息之间的位置（即摘要消息与下一非摘要消息之间）。**

不变式（后续测试钉死）：

- **B1（冻结）**：摘要链消息一经写入，永不修改、永不丢失、永不折叠——它是"长期记忆的字节冻结层"。
- **B2（单调）**：第 K 次压缩的折叠点（`cut`）严格 ≥ 第 K−1 次压缩的折叠点；折叠点永不越过链尾（`fold_start`）。即"同一个 block 永不二次压缩"。
- **B3（只增）**：每次压缩**至多新增 1 条**摘要消息，id 递增（`compacted-summary-{fold_index}`，fold_index = 链长+1，统计状态从单词消息数推导，跨 run 天然恢复——不需要额外持久化）。
- **B4（形状）**：链紧邻 system 之后；链后为保留区（含 tail）；保留区以 user 收尾的协议约束由 P4 水合尾部截断保证（P4 §3.2.3）。

**压缩后的前缀结构**：

```
[system 消息 * s] (字节冻结)
[摘要链：摘要1][摘要2]...[摘要K]       ← 累计记忆，永不变更
[保留区：tail 原文]  ← 追加+每次折叠截短一次
```

**命中率收益论证**：压缩 K 后的请求前缀与 K+1 之间的任意请求的 LCP = "system + 全部链"（字节不变）；只有折叠点之后的部分（新摘要 + 新 tail）需要重写。跨 K 次压缩，累计可命中字节 = 链总字节 ≈ "历史记忆总长"，它持续增长而从不作废。对比现状（每次压缩 LCP 退回到 system 之后 0）：同样的压缩动作，跨压缩命中从"新增量"变为"近乎全量accumulate"。

**代价**：链 token 占有（每次 ≤ `max_summary_tokens`=1024 默认，P4 §3.4.2 同上），100 次压缩 ≤ 100K token 的链。加上 B2 保证，链作为"永久前缀"可接受；服务端 LRU 容量风险见 §七。

**逃生舱（登记）**：当链总长超过某阈值（如 60% 窗口）或服务端观测到链命中率下跌，做一次"计划级重建"：把链折叠成**一条新的全量摘要消息**（trace 追溯合并）+ 精整（受控的一次性前缀大破坏）。这与 appendable 机制并行，是"全量重置 vs 轴增量"的两个档位（对齐 Reasonix compaction 分级 + compactStuck 锁存，comparison.md:218 ）。列入未来演进。

### 2.2 find_cut_point 协同修正（要改的行号）

`find_cut_point_inner`（conex-compaction/src/lib.rs）现有三条路径全部需要"链下界钳制"：

| # | 位置 | 现状 | 修正 |
|---|---|---|---|
| 0 | lib.rs:544（函数体开头，counts 之前） | 无链概念 | 计算 `fold_start` = 扫描 `messages`，跳过前置 system 消息后，连续 `id.starts_with("compacted-summary")` 的段之后的首个下标；链为空时 `fold_start = 首个非 system 消息下标`（在 messages 中 system 之后的第 0 个 else 0） |
| 1 | lib.rs:559-568（尾部倒推预算） | 从 `messages.len()` 起倒推到 0 | 倒推下界改为 `fold_start`：`for i in (fold_start..messages.len()).rev()`；该区间内累计未达 `keep_recent_tokens` → 无可丢内容 → 返回 None（不改动 `cut==0` 语义，即"保留全段"；需保留"cut==len → 0"的兼容分支？称为 `(cut == messages.len()) → None` 保持） |
| 2 | lib.rs:570-575（cut 归一与 None） | `cut == 0 → None` | `cut <= fold_start → None`（已过 epoch；无害零） |
| 3 | lib.rs:577-592（min_recent_turns 扩展） | `while ... && cut > 0` 且 `cut == 0 → None` | `while ... && cut > fold_start`；`cut <= fold_start → None` |
| 4 | lib.rs:594-636（tool 配对回扫） | `for j in (0..cut).rev()`；`cut == 0 → None` | 回扫下界 `fold_start`（链内理论上无 tool call，防御性钳制）；`needed <= fold_start`（即目标 tool call 进入链或链前）→ 判定孤儿不可满足 → 返回 None（**不得把链拉进保留区**） |
| 5 | lib.rs:638 | `Some(cut)` | 不变（此时 cut ∈ [fold_start, len]） |

### 2.3 compact_agent_messages 修正（要改的行号）

| # | 位置 | 现状 | 修正 |
|---|---|---|---|
| 6 | lib.rs:448-452 | `dropped_arcs` = messages[..cut] 内非 system 的全部 | 额外过滤 `id.starts_with("compacted-summary")`（**链永不进入将被丢弃的集合**） |
| 7 | lib.rs:459-464 | `existing` 取 messages[..cut] 中**首个匹配**的摘要文本 | 改为取**链尾最后一条**摘要文本（`existing` 语义 = "上一次状态"，供 L2 合并参考；L1 路径不消费） |
| 8 | lib.rs:496-516 | 组装 = system + 新摘要 + messages[cut..] | 组装 = **system + 链全查（按序）+ 新摘要消息 + messages[cut..]**。链全部来自 messages[..cut] 中 compacted-summary 前缀（B1 保证它们全部保留） |
| 9 | lib.rs:502-503 | 摘要 id = `compacted-summary-{dropped_ids.len()}` | 改为 `compacted-summary-{foldIndex}`，`foldIndex` = messages[..cut] 中链消息 len + 1（从会话被系统推导，跨 run 唯一）。**同时解决根因 B 的 id 碰撞**。 |
| 10 | lib.rs:505-509 | created_at 取对话末条时间戳 | 保留不变（摘要消息时间戳晚于压缩边界，杜绝 usage 作废误判） |
| 11 | lib.rs:524-533 | CompactionPlan 字段 | 可选新增 `fold_chain_prev: usize` / `fold_chain_after: usize`（压缩前 / 后链长），供事件与遥测使用（事件字段变更需走 [33-event-schema-changelog](./../rust-rewrite/33-event-schema-changelog.md) 纪律，先置于 `details` JSON 或后续扩展） |

### 2.4 压缩后新前缀的"自稳定"保证

压缩后新前缀（system + 链 + 保留区）的稳定性由**三方面共同保证**：

1. **字节确定性**：system（P1 透传后固定）、链（冻结 B1）、保留区（原始消息不动，append-only 纪律 P1 D）。L1 摘要文本是 `dropped_count` 的确定性函数（`summary_placeholder`，lib.rs:750-752），同输入同字节；L2 摘要写一次即冻结，LLM 非确定性只影响"这条写进的新摘要"一次。
2. **签名验证**：`build_request_signature`（cache_tracker.rs:469-491）逐消息哈希天然覆盖链；`messages_prefix_changed`（signature.rs:34-37）对链内改动可检出（见 §四 测量增强）。
3. **位置固定**：链紧邻 system，保留区接链后。该位置不因后续追加移动（append-only），故 LCP 匹配位置稳定。

**q 边注**：keep_recent_tokens 预算。修后侧推预算的区间为 [fold_start, len)，链 token 不计入"保留区预算"，避免根因 C（链大导致保留区变小循环压缩）。

---

## 三、前缀稳定三角（system / tools / 消息）

| 角 | 稳定性面 | 已接入措施 | 本方案新增纪律 |
|---|---|---|---|
| system | 字节不变 + 位置第 0 位 | P1：前端拼接函数化 + 单一构造点 + 四层透传；options 在 run 内不可变 | **禁止 run 中途改写**；"动态内容后置"铁律（§四）；system 与链互相独立——链被误触即检测（§3 签名） |
| tools | 字节不变 + 位置第 2 位 | P1：按名排序（registry.rs `list_definitions`）+ run 内快照（streaming.rs:54）；`tools_schema` 轮次间复用 | 工具变更（跨 run 注册表变）会令 tools_hash 变 → 触发系统识别出 `HarnessToolsChanged`（miss.rs:92-94），命中率跌一次可预期；**新工具接入应一次性引入**并期望该次 miss |
| 消息 | append-only 字节不回溯 | P1：4 个追加点纪律 + compaction 唯一例外（handlers/mod.rs:470-482 注释）；P4：合法切割点 + 时间戳护栏 | **折叠链（本次）是"唯一例外中的不可变更区域"**；切割点永不入链（§2.2） |

三角之外的第三处"前缀干扰源"：`cache_control` / `prompt_cache_key`（P2 落地后）；它们不改变消息前缀（断点标记缓存结束位置），仍遵守"注入放尾部断点之前"即可——不在本方案展开。

---

## 四、注入卫生清单（时间戳/时间线 + 目录树等动态内容）

### 4.1 通用原则

> 任何"每轮可能变化"的内容，只允许出现在**最后一个** user 消息正文尾部（含消息尾部），或作为**一条新消息追加到对话尾部**；禁止进入 system、禁止改写任何既有消息、禁止进入工具描述。判据：**该内容若被回放第二次，其字节必须与第一次完全一致，或位于 LCP 之外**。

### 4.2 时间戳 / 时间线：允许位置 ↔ 禁止位置

| 位置 | 允许? | 缓存影响 | 说明 |
|---|---|---|---|
| 最新 user 消息正文尾部（注入块） | ✅ 推荐（唯一默认） | 零（纯增量在 LCP 边界之后） | 对齐 P4 I2 / Reasonix `<memory-recall>` 尾部注入；按 P4 §3.2.3 尾部 user 约束兼容"以 user 收尾" |
| 追加为对话末尾新 user 消息 | ✅ 可行 | 零 | 适合"时间线事件"（如每 60 秒注入一次）；仍保持 user 收尾 |
| 追加为对话末尾新 system 角色消息 | ⚠️ 需 provider 门控 | 零（尾部） | OpenAI 系允许 system 穿插；部分 provider 仅头部合法。**默认禁止，需能力表允许**（P3 vendor 判定） |
| 新摘要消息文本内（压缩发生时一次性并入） | ✅ 无害 | 零 | 摘要一次性冻结，携时间不影响链稳定；但因不具信息价值，不建议 |
| `AgentMessage.created_at` / `metadata.usage` 时间 | ✅ 无害（不落 wire） | 零 | 已核实：`to_chat_messages` 序列化不含 created_at / metadata，wire 无时间戳（也是 P5 投影剔除 created_at 的依据）；此类元数据不影响缓存前缀 |
| **system prompt 内部任何位置** | ❌ 禁止 | system_hash 每轮变化 → 全部前缀作废 | jcode 动态块放断点之后的教训（jcode-cache-analysis.md:38-49）；时间/会话上下文统统不进 system |
| **tools / tool schema（含 description）** | ❌ 禁止 | tools_hash 变化 | 工具描述带时间 = 非确定性工具集 |
| **既有历史消息改写**（任何位置） | ❌ 禁止 | 前缀破坏 | append-only 纪律（P1 D） |
| **摘要链既有消息** | ❌ 禁止 | 链失效（B1 违反） | 冻结层永不可写 |

### 4.3 目录树注入（project_tree）——为什么必须工具化

**结论：一律工具化（或懒注入工具），绝不进入每轮 user 文本。**

论证（两重）：

1. **缓存经济学（决定性）**：每轮注入的目录树字节位于"最新 user 消息"= 永远在 LCP 之外的 miss 区 → 树字节每轮重发按全价（1.0x）计费；而工具化后，树结果作为**历史消息**（tool-result 消息）进入前缀 → 之后每一轮按 0.1x 命中。树 1000 token、对话 100 轮：
   - 每轮注入：miss ≈ 100 × 1000 = 100k token（全价）；
   - 工具化+mtime 失效：miss ≈ 1 次抓取 + 0（未变化），命中后每轮 ≈ 0 额外。
2. **前缀纪律（hinge）**：每轮注入要求"拼接进消息文本"，天然诱惑"改造成某个中间消息/头部"，一旦有人把它放进**首条 user 消息或 system**（为了让模型总是先看到树），前缀即刻被炸。工具化把"树在消息流中的位置"固定为 tool-call+tool-result 对（追加到尾部），物理上不可能出现在 system 前缀。

**若注入前提（tool 语义）**：
- **一次性**：会话级抓取一次（或按需调用）；结果作为工具输出写入**固定位置**（对话尾部的 tool-result 消息）。
- **位置固定**：任何刷新 = 追加新的一条 tool-call+result 对，**绝不改写旧树消息**（同 B1 淋失不变式的推广）。
- **mtime 失效**：重抓条件 = 目录树 mtime / 根目录内容 hash 变化；无变化 → 零注入（对齐 Codex "diff 为空则零注入"，codex-cli-cache-analysis.md:133-156）。防抖：同一秒内多触发合并一次。
- **生命周期与压缩**：树结果被压缩折叠时作为普通消息处理（会被摘要吸收，摘要保留"关键目录/路径"；L2 模板 Critical Context 纪律已要求保留关键路径 → 摘要后树信息仍在链中不丢失）。**可选增强**：`tree-snapshot-` 前缀标记 + 压缩保留优先级（列为演进项，不阻塞）。

---

## 五、缓存命中率度量增强

### 5.1 压缩后 baseline 重建策略（现状 → 增强）

现状：`on_compaction`（cache_tracker.rs:237-242）代数 +1、`baseline = None`；下一轮 `record_usage` 无基线 → 不计 miss → 自然建立新基线。**缺点**：压缩与下一请求之间若有二次前缀改写（bug / 二次压缩），完全不可见；且首请求归因落入 `Cold/Unknown`。

增强（三步）：

| # | 位置 | 改动 |
|---|---|---|
| E1 | cache_tracker.rs:237-242 + 结构体（:74-108） | `on_compaction` 置 `pending_compaction = true`（保留代数 +1 / 基线作废）；新方法 `rebuild_after_compaction(system, tools, messages)`：对压缩后的对话捕获签名 → 存入新字段 `rebuild_signature: Option<RequestSignature>`（**签名型基线，不携带 token 数**） |
| E2 | handlers/mod.rs:349-358（apply_compaction） | 对话替换后调用 `tracker.rebuild_after_compaction(system_prompt, tools_snapshot, &state.conversation)`（借用顺序：conversation 已替换/工具快照已存在，此时捕获的签名 = 压缩后真实请求前缀的预测） |
| E3 | cache_tracker.rs:178-234（record_usage） | 基线建立前先消费 `pending_compaction`：拿 `cur`（当前 pending_signature）与 `rebuild_signature` 比对——（a）相同（正常）：标记"重建成功"，本次 miss 正常不检测（与现状相同），归因走 `Compaction`（首请求的命中率下跌是计划的）；(b) 不同：**捕获 harness 二次改写**（tracing warn + 事件负载可得 `first_diff_index`），归因 `PrefixChanged` 而非静默。两种情形均完成后清 `pending` 与 `rebuild_signature` |

**归因增强（对 miss.rs / cache_tracker.rs）**：

| # | 位置 | 改动 |
|---|---|---|
| E4 | signature.rs 新增纯函数 | `prefix_diff_index(prev, cur) -> Option<PrefixDiff>`；`PrefixDiff { kind: System\|Tools\|Message, index: Option<usize> }`（逐消息 `message_hashes` 首个不等下标）。**不动 `classify` 的 8 变枚举**（miss.rs:187-203 钉死测试），细节由 tracker 消费日志/诊断 |
| E5 | cache_tracker.rs:317-362（classify_miss） | `Compaction` 分支从"正常不可达防御"升级为真路径：`pending_compaction` 且压缩后首请求 → `MissAttribution::Compaction`（替代 Cold）；保留代数不匹配兜底 |
| E6 | cache_tracker.rs record_usage 完形 | 压缩后首请求的 `input_total` 记入该 run 的"重建体积"（日志字段 + 事件可选扩展），供：a) `cold_cache_check.resend_estimate` 在重建阶段更准确；（现状 resend = 上次 input_total，重建即该值，语义自然成立——只需确认不做额外调整）；b) 下轮压缩决策参考（估计使用） |

### 5.2 链命中率恢复曲线（新增观测）

压缩后链是否真的被服务端缓存不可见当前。建议**每个 run 收口把一个轻量 KPI 进 RunCacheStats 备选字段或事件 details**：

- `post_compaction_recovery_start_idx` / 或简单做法：tracker 记录"压缩代数 K + 首请求 input_total + 之后第 N 轮命中率"，前端曲线呈现"压缩后第 1/5/10 个请求的命中率"。
- 判定：若压缩后 2-3 个请求内命中率未回到链占比（≈ 链 token / 当前 input_total），提示需查服务端缓存容量（DeepSeek LRU 高水位 / 厂商限长）——这是核心 KPI 缺口。

### 5.3 度量口径不变项

- miss 检测、恒等式、噪声地板、断裂判定全部沿用 P5（math.rs / miss.rs）；本方案不引入新恒等式。
- `messages_prefix_changed`（signature.rs:34-37）对"摘要链被改"天然可检出（链内消息 hash 变化 → 前缀 changed），是折叠机制完整的自监控。

---

## 六、改动 task 清单（可直接实施）

> 文件域覆盖：`crates/conex-compaction`、`crates/session-loop`、`crates/conex-telemetry`。所有统行号以 2026-08-08 实读为准。

### 阶段 A：折叠链核心（conex-compaction）

| # | 文件:行号 | 改动 | 验收 |
|---|---|---|---|
| T-01 | conex-compaction/src/lib.rs:544-558（函数体开头） | 计算 `fold_start`（链头定位：system 后连续 `compacted-summary` 前缀消息段） | 链/无链两分支正确 |
| T-02 | lib.rs:559-568 | 尾部倒推预算扫描下界 `fold_start`；区间内不达预算 → None | 链不消耗保留区预算 |
| T-03 | lib.rs:570-575 | `cut == 0 → None` 改为 `cut <= fold_start → None` | 边界语义 |
| T-04 | lib.rs:577-592 | min_recent_turns 下界钳；`cut <= fold_start → None` | 保底 |
| T-05 | lib.rs:594-636 | tool 配对回扫下界 `fold_start`；`needed <= fold_start → None`（不拉链进保留区） | 链内孤儿不可满足返回 None |
| T-06 | lib.rs:448-452 | dropped_arcs 排除 `compacted-summary` 前缀 | 链永不入 dropped |
| T-07 | lib.rs:459-464 | `existing` 取链尾摘要文本（最后一个） | 合并语义正确 |
| T-08 | lib.rs:496-516 | 组装 = system + 链全查 + 新摘要 + messages[cut..] | 链全部保留且位置在 system 后 |
| T-09 | lib.rs:502-503 | 摘要 id = `compacted-summary-{fold_index}`（链长+1） | id 单调 + 碰撞消除 |
| T-10 | lib.rs:524-533（可选） | CompactionPlan 增加 `fold_chain_prev` / `fold_chain_after`（事件载荷后续用） | 事件字段登记（走 event schema changelog） |

### 阶段 B：测量增强（conex-telemetry + session-loop）

| # | 文件:行号 | 改动 | 验收 |
|---|---|---|---|
| T-11 | conex-telemetry/src/cache/signature.rs（新增函数） | `prefix_diff_index(system,tools,msg_hashes)` 首个差异定位（System/Tools/Message#index） | 纯函数 + 单测 |
| T-12 | session-loop/src/cache_tracker.rs:74-108（结构体） | 增字段 `pending_compaction: bool`、`rebuild_signature: Option<RequestSignature>` | 默认态向后兼容 |
| T-13 | cache_tracker.rs:237-242 | `on_compaction` 置 pending 真；保留代数 +1/基线 None | 用既有测试倒推出兼容 |
| T-14 | cache_tracker.rs（新方法） | `rebuild_after_compaction(system, tools, messages)`：压缩后签名 → rebuild_signature（不置 token 数） | 单测 |
| T-15 | cache_tracker.rs:178-234 | record_usage 流水线：首无基线 + pending → 签名比对（相同=正常；不同=诊断 + 归因）→ 清 pending/rebuild | 单测：两次改写可检出 |
| T-16 | cache_tracker.rs:317-362 | classify_miss 的 Compaction 分支接入真路径（pending 压缩 → Compaction 而非 Cold） | 单测 |
| T-17 | handlers/mod.rs:349-360 | apply_compaction 对话替换后调 `rebuild_after_compaction` | 集成测试（真实路径） |
| T-18 | handlers/mod.rs:379-381 | `cache_boundary` 填充 `ContextCompressionCacheBoundaryMetadata`（tool.rs:433-450）：`stable_prefix_hash` = 压缩后签名 messages_hash（或链尾 hash）、`first_kept_message_id` 已有同字段复用 | 事件载荷校验 |

### 阶段 C（可选）：恢复曲线 KPI 与树注入增强

| # | 文件:行号 | 改动 |
|---|---|---|
| T-19 | conex-compaction/src/lib.rs:347-397（EstimateContext） | 增加 `stable_prefix_tokens: Option<u64>`（system+链）——供遥测"预期命中地板" |
| T-20 | session-loop（未来） | 目录树工具 `project_tree`（结果消息 `tree-snapshot-` 前缀、mtime 失效、防抖）——独立方案，本文档只定约束 |

---

## 七、测试建议

### 单元测试（conex-compaction，T-01~T-10 配套）

1. `fold_chain_is_frozen_across_compaction`：带链对话二次压缩 → 断言链内每条消息的 `message_hash`（或直接比较消息对象）在压缩前后逐字节相同，且均出现在 `kept_ids`。
2. `cut_never_goes_below_fold_start`：压缩 N 与 N+1 的 `first_kept_message_id` 单调（N+1 的 cut ≥ N 的链尾）。构造多轮：①部分压缩；②再增长；③再压缩；验证链长 2、保留区正确。
3. `budget_scan_starts_after_chain`：使链 token 超过 keep_recent_tokens → 压缩仍正常（链不占预算），保留区按 20000 保留。
4. `tool_pair_protection_clamps_to_chain`：orphan ToolResult 的对应 ToolCall 位于链内（构造异常数据）→ 返回 None（放弃压缩，不拉链）。
5. `summary_ids_increase_monotonically`：压缩 3 次 → ids = compacted-summary-1/-2/-3（不再与 dropped 计数耦合）。
6. `chain_never_in_dropped_ids`：任何压缩计划 `dropped_ids ∩ 链 id = ∅`。

### 单元测试（cache_tracker / telemetry，T-11~T-16 配套）

7. `prefix_diff_index_locates_system_tools_message`：三处改动各返回正确 kind + index。
8. `rebuild_after_compaction_ok_path`: pending + 相同 → 不计 miss、归因 Compaction、清理。
9. `rebuild_after_compaction_detects_rewrite`：压缩后对话又改一条 → record_usage 产出诊断（warn + PrefixChanged 归因）。
10. `on_compaction_pending_flag_cleared_after_first_usage`：状态机收口。
11. `post_compaction_first_request_not_miss`（已有测试 `on_compaction_invalidates_baseline_and_bumps_generation` 保持绿色，回归改造后 sem 兼容）。

### 集成测试（session-loop，TestProvider.requests()）

12. `two_compactions_keep_chain_bytes_stable_in_wire`：双压缩 → 第二轮 run 首请求 `requests()[0].messages` 中包含链消息，且与上一轮末尾请求的对应链消息字节一致（对齐 P1 E2 的 codex 断言模式）。
13. `compaction_end_carries_cache_boundary`：`ContextCompressionRecord.cache_boundary` 的 stable_prefix_hash 与压缩后 `build_request_signature` 一致（T-18）。

### 手工验证（真机）

- DeepSeek 连续 3 轮对话 + 压缩：观察 Usage 中 `cacheRead` 在压缩后首请求低位、第 2-3 请求快速回升（链+新 tail 命中）。
- 前端面板：压缩后命中率恢复曲线可见（T-19 扩展后）。

---

## 八、风险

| # | 风险 | 等级 | 对策 |
|---|---|---|---|
| 1 | 链增长无限（长会话多轮压缩 → 链 token 累计） | 中 | 单次 `max_summary_tokens`=1024 默认；链累计到窗口比例时启用"逃生舱"（计划级整链重写，受控一次性 break，§2.1 逃生）；观测恢复曲线（T-19） |
| 2 | 服务端缓存容量限制（DeepSeek LRU 在高水位会丢弃早期前缀 → 链头部失效） | 中 | 命中率恢复曲线 KPI 兜底；若链过长命中率下跌，触发逃生舱或主动降低 keep_recent_tokens |
| 3 | L2 摘要非确定性 → 链内文本"写一次即冻结"后被后续合并覆盖（若实现错误重走 build 丢弃链） | 低 | B1 不变量测试 + 链消息去重校验（T-06 的 dropped 断言）；`existing` 只传链尾文本，不触碰链本体 |
| 4 | 协议形状：无 system 消息时链 = 消息间第一条（assistant 开头），部分 provider 要求 user/system 首条 → 400 | 中 | 现有 P4 已固定"以 user 收尾"约束；补充"首条必须以 user/system 开头"的水合断言（收紧 P4 §3.2.3 尾部约束为"首尾"双约束）——列入 T-20 附近 |
| 5 | 旧格式摘要消息 `compacted-summary-{n}`（新旧格式混会话） | 低 | 旧格式 id 同样被 `starts_with` 检测为链成员（兼容）；新格式只增量；迁移期单一运行窗口即可 |
| 6 | `cache_boundary` 填充引入事件 schema 变更面 | 低 | 字段类型已存在（tool.rs:433-450）且 `cache_boundary` 字段already Option；只填值不改类型 → 无需事件 changelog；若增 `CompactionPlan` 字段需走登记纪律 |
| 7 | 全文引用行号随代码演进漂移 | 中 | 文档基于 2026-08-08 实读；实施时以约定注释 `P7 fold chain` 锚点复核 |

---

## 附：与既有文档的衔接

- P4 §3.6 不变量 I1（compaction 是唯一前缀改写点）：本方案是 I1 的**强化版**——"唯一改写点"内的产物本身不可改写（链冻结）。
- P5 §3.4.5 基线重置表（Compaction 行）：本方案补"压缩后签名型基线（rebuild_signature）"一行。
- comparison.md * [gap 4"压缩与缓存交互"]：本方案就是该缺口在 P4 落地后的下一步（从"压缩可用"到"压缩后仍在命中"）。
- [33-event-schema-changelog.md]：若在 T-10/T-19 扩展事件字段，须先登记。

----

（完）