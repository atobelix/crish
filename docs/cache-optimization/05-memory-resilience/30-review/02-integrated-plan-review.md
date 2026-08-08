# 02 整合方案评审：记忆韧性与缓存命中（架构合理性 + 不变量安全 + 缓存机制正确性）

- 评审对象：`docs/cache-optimization/05-memory-resilience/20-plan/00-integrated-plan.md`（v0.1，364 行）
- 输入精读：`10-analysis/01~04` 四份分析稿、`03-plans/P1-prefix-stability.md`、`P4-history-context-management.md`、`P5-cache-telemetry.md`，并对关键代码（conex-compaction/src/lib.rs、session-loop/cache_tracker.rs、session-loop/loop/handlers/mod.rs、orchestrator/src/events.rs、restore.rs、agent-tools/context.rs、wait_subagents.rs、conex-db/events.rs、lib.rs、conex-types/tests/events_schema_version.rs 等）实读核验
- 评审日期：2026-08-08
- 性质：只读评审，未修改任何源码与方案文件；评审结论写入本文件

---

## ① 总体结论（核心判断）

1. **架构整体成立，折叠链是正确的主杠杆**："append-only 冻结链 + 切割点链下界钳制"能真正把服务端前缀缓存从"每压缩一次全作废"变为"链累计命中"，与 P1/P4/P5 的既有不变量体系自洽（钳制点均在 `find_cut_point_inner` 内部，lib.rs:544-639 实读核实五处路径确实存在改造余地，T-01~T-05 可执行）。**但方案在 4 处关键位置存在必须修正的缺陷**（见 P0 清单），其中"block_id 与消息 id 合一"的数据模型错误（P0-A）与"摘要调度器生命周期绑定 run"（P0-C）若不改，落地即产生跨会话主键冲突与跨 run 单飞失效。

2. **不变量网（B1-B4）语义自洽，但三处缺口**：(a) B1 的"链永不修改"与 §12 风险 1"计划级重建"（整链折叠成一条全量摘要）是直接冲突，方案未把逃生舱登记为 B1 的显式例外；(b) fold_index（=链长+1，R-B）在新旧摘要格式混会话及"链丢失重建"路径下无法保证 id 唯一，会污染链路 id 唯一性与块表主键；(c) B2 单调在"前端 history 兜底水合"（P4 混合路线 B）路径下不成立——该路径回传的可能是未压缩历史，链整体丢失重建。主链路（引擎缓存水合）下 B2 成立，但必须声明前提。

3. **摘要调度器是方案中最弱的一环**：任务生命周期绑定 run 级 LoopState（跨 run 即断）、`context-summary-ready` 未纳入既有事件注册纪律（events_schema_version.rs 基线 41 变体 + fixture 覆盖测试会失败）、R-C"stub 永不改写"与其" ⏳ 摘要生成中"文案在 committed 后构成语义死锁、以及"会话级单飞"跨 run 不成立的实现缺口——这些与折叠链无关，属于摘要层重设计遗留问题（04 稿是纯 stub 替换面、无"链冻结"约束，R-C 裁决后没有重新走查摘要面）。

---

## ② 不变量核验（B1-B4 / I1 逐条）

### B1 冻结——**成立（两处前置条件需要登记）**

- 语义自洽：链消息（compacted-summary 前缀）一经写入永不修改/丢失/折叠，T-06（dropped_arcs 排除前缀，lib.rs:448-452）与 T-08（组装保留链全查，lib.rs:496-516）使当前实现中"链消息被当作普通消息丢弃"（现有代码确实把 `messages[..cut]` 内 compacted-summary 消息丢弃，lib.rs:448-452 无过滤）的行为被修正。
- **缺口 1：与逃生舱冲突**。§12 风险 1 的"计划级重建（整链折叠为一条新全量摘要、受控一次性 break）"本质是**批量删除全部链消息并新写摘要**——这是"链丢失"操作。B1 的文字（§4.1："摘要链消息一经写入永不修改/丢失/折叠"）如果被测试钉死为无条件断言（§11 测试 1"链内消息逐字节相同"），逃生舱将同时违反 B1 与测试。需要在不变量层把逃生舱登记为 **B1 的唯一显式例外（chain reset）**，且定义触发计算（60% 窗口由谁计算、何时检查）、执行路径（专门代码路径）、与 `compression_blocks` 的衔接（重建块需 prev_block_id 指向链尾，保留可追溯）。方案现状 → 逃生舱只有一句话（§12 行 344），这是不变量网上的洞。
- **缺口 2（stub 的"永不改写"与链冻结）**：R-C（§2 行 48）"stub 永不改写（B1 优先）"成立且正确（04 的"壳层收口替身"确实破坏链冻结，改掉是对的）。但注意 stub 消息本身（`compacted-summary-{block_id}` 前缀）也属于链一部分吗？方案 §5.2 的 stub 消息 id = `compacted-summary-{blockId}`，属于链成员检测集（starts_with "compacted-summary"）—— T-08 链全查会把它保留 ✓ B1 覆盖 stub ✓。闭合。

### B2 单调——**成立有条件，跨 run 水合路径有条件不成立（P1）**

- run 内与引擎缓存水合路径：cut 钳制下界 = fold_start（T-03/T-04/T-05 三处 `cut <= fold_start → None`），加 T-06 链不入 dropped → 链只增，fold_start 单调 → 第 2 次压缩的 cut ≥ 第 1 次 ✓。证据：现有 `find_cut_point_inner` 的 `cut==0→None` 语义（lib.rs:570-575）改为 `cut<=fold_start→None` 结构上可直接落地，无副作用面。
- **跨 run 水合重建路径的例外（2-验证路径）**：P4 混合路线（01 分析 §3.2.3 与 P4 §3.2.2 风险"前端 store 与引擎在压缩后产生两份正文真源"）下，`SessionHistoryCache` 是权威（RunOutcome 原子替换，P4 §3.2.3 行 168），它是压缩后形态 → 链在水合后完整存在 → B2 成立。**但当冷启动走"前端 history 兜底"且前端 store 未感知引擎压缩（任务书 B 一致性风险，P4 `with_initial_conversation_arc` 语义在 P1 固定)时，水合回传的是未压缩历史 → 对话中无链 → fold_start 重新从首个非 system 起算 → "第 K 次压缩"实际是对无链状态的第 1 次** → B2 的"单调"断言失效（但这不破坏缓存正确性——是"链不存在"的一次性 miss，服务端 LCP 退回到 system 之后——应记录为已知降级，而不是宣称 B2 无条件成立）。**建议**：文档声明 B2 适用域 = "水合上下文包含完整链"；测试覆盖"无链水合"场景并断言其行为是合法降级（首压缩 id 从 1 起）。
- 另外 B2 与 generation 脱钩：链重建后 fold_index 从 1 重计，但 generation（会话级代数）持续 +1。方案 §4.4 说 "fold_index 跨 run 天然恢复（统计状态从消息数推导，不需要额外持久化）"——只在链完整时不额外持久化；链重建时需要 generation 落库来区分轮次（见 P0-1/P0-2 块 id 派生）。

### B3 只增——**自洽，但 id 推导在三个路径下不唯一（P0-2）**

- 标准路径成立：链只增，fold_index=链长+1 会话内单调 ✓。
- **新格式与旧格式混叠会话的 id 碰撞（P-2a）**：旧格式 `compacted-summary-{dropped_ids.len()}`（lib.rs:503 现实现）与新格式 `compacted-summary-{fold_index}` 同为数字后缀格式，无法区分。旧格式 id 数字是"丢弃数"（7、12、3...可能重叠与非连续），新格式 id 是"链长+1"。若一个历史会话已有 `compacted-summary-7`（7 条消息被旧的丢弃），链长为 N 时 fold_index=N+1，当 N+1==7 时新 id 与旧 id 碰撞 → 链内消息 id 不唯一（B3 的"id 递增唯一"被破坏）。摘要消息 id 唯一性是 search/block 接口的基础（丢弃区消息 id 前缀），碰撞会破坏事件与压缩块的关联。
- **链重建后 id 复用（P-2b）**：链重建（B 缺口 1 或跨 run 水合丢失）后，新链第 1 块 id 重新 = `compacted-summary-1`。若 `compression_blocks` 表中该 session 此前已有 block（重建前）→ 块 id 相同 → 幂等键（INSERT OR IGNORE）会静默"覆盖/不回插"新块。块表主键冲突与错误关联。
- **跨会话（P-2c）**：fold_index 是**会话级**计数，块 id = `compacted-summary-{fold_index}` → 两个会话各自的第 1 块 id 完全相同。若 `compression_blocks.block_id` 是全局 PRIMARY KEY（01 分析 DDL，01 §4.2 "block_id TEXT PRIMARY KEY"），跨会话第二会话第一块直接插入冲突 → 库写入失败。即使改成 (session_id, block_id) 复合主键，search_context/decompress_context 按 blockId 查询也需要 session 作用域校正。
- 结论：R-B（块 id = fold_index 派生、与消息 id 合一）在**单会话、单链生命周期内**最佳，但没有任何打开到符合条件（跨会话、链重建、新旧混格式）的 id 唯一性设计。必须至少把 block_id 改为 `{session 范围}-{generation}-{fold_index}` 派生（对齐 04 的 `run_id-seq` 思想）或将表理到复合主键 + 块 id 带代数。此为 P0-A。

### B4 形状——盒式成立，两处补充

- 成立证据：T-08 组装 = system + 链全查（按序）+ 新摘要 + messages[cut..]（lib.rs:496-516 现状组装模式可扩），链紧跟 system ✓。保留区以 user 收尾由 P4 §3.2.3:186 水合尾部约束；「首条约束」见 P1-7（无 system 会话链作为首条 assistant 的风险，方案 §12 风险 4 只有断言对策，无引擎层兜底）。

### I1 兼容——成立，边界清晰（核验结果：不触碰）

- 摘要调度器 run 外后台写 `compression_blocks` 表 + `context-summary-ready` 事件：**I1 只约束"对话消息序列前缀的写入/重写"**（P1 §3.5 与 `handlers/mod.rs:349`、`mod.rs:347-349 注释"压缩是唯一前缀重写点"），表写入与事件追加不触碰 `state.conversation` → 不违反 I1 ✓。注意 I1 的严格表述：conversation 只允许 4 个追加点 + 压缩一个例外（注释 466-469）；后台任务不调 record_message、不改 conversation → 合规 ✅。
- `decompress_context` 回放读操作：不替换对话、不动上下文前缀（方案 §6.2 行 198-199 明确「恢复就位是读操作，不替换对话、不动上下文前缀」）→ 与 I1 精神一致（恢复不是压缩的逆操作）。**补充一个前提**："inline: true"也许还是会把内容放回对话？方案 §6.2 说 `inline: true 显式接受上下文开销`——"inline" 的语义是"把恢复的文本作为工具结果返回"（仍在 wire 尾部、作为新的 tool-result 消息、append 而非替换）→ 不违反 I1 ✓。但若 inline 被实现为"改写链中 stub"则会违反——方案未定义 inline 的落点语义，建议实现验收明确"inline 只产出新消息（append），绝不改写链"（P2 提议）。
- **stub 永不改写（R-C）与承诺一致**：4 稿中"摘要就绪后壳层回写 stub 行为完整 markdown"被 R-C 否决，则 **summary_to_markdown 的角色被取消**——对话里永远是 stub 文本或（同步成功）链内摘要。但方案 §5.1 仍写"对话槽：# markdown 渲染投影（token 经济 + 历史兼容）"（行 151）→ §5.1 与 §5.2/R-C 自相矛盾，必须裁决其一（P0-4）：要么保留 R-C（对话槽永远是 stub + 摘要只入表/事件），要么放开" 同步成功路径直接进链（markdown 文本）"（= 现有链路，并且是唯一让模型"真理解"摘要的路径）。签名重建（§9）与折叠链（§4）设计上都假设链消息 = 摘要文本（T-07 existing 取链尾文本），若摘要改为永远不进链，则 existing 通道长截图："取链尾最后一条摘要文本"（T-07）链尾 = stub 文本而非文档 → 与 §5.3"existing 从 compression_blocks 解析优先"矛盾，T-07 与 §5.3 需要在实际中统一优先级：**链文本 ∈ { stub 文本 | 全摘要 markdown }，existing 来源在表有行时取表文档，无行时报链尾 stub 文本，两者并存矛盾点没有仲裁**。P0-4 覆盖此点。

---

## ③ 缓存机制正确性分析

### 3.1 结构对齐 P1 协议（成立）

P1 的协议形状结论（P1 方案 §1.1/§3.1）：请求前缀 = system（静态）+ tools（排序+快照）+ 消息序列（append-only），动态内容严格存在于尾部 user。方案 §4 的 [system 冻结][摘要1..摘要K][tail 原文] 结构：
- system 与链独立恒字节（B1）→ 与 P1 的 system/tools 字节稳定兼容 ✓；
- 链是消息序列内部的"append-only 不可变段" → 不影响消息追加点纪律（P1 D 部分，追加点不变）；
- 尾部注入纪律（§8）与 P1"动态内容放 user 尾部"（P1 3.1.3）一致 ✓；
- 以 user 收尾：P4 §3.2.2 已在水合截断保证（P4 186 行），方案 T-24"首尾双约束断言"与该约束方向一致 ✓。
- **结论：与 P1 无冲突，且是 P1 的增强（链 = 前缀内的稳定区段），不进 tools。**

### 3.2 cut 钳制到 fold_start 后 LCP 确实提升（逻辑论证成立）

服务端（DeepSeek 等）按完整请求 token 前缀匹配缓存。压缩 K 与 K+1 之间：
- 第 1 次压缩后请求前缀 = [system][链1][tail1]；第 2 次请求（同对话附加新消息 1 条） = [system][链1][tail1][u2] → LCP = 全链 [system][链1][tail1]？ 服务端缓存 = "system+链1+tail1"字节 ✓；而 tail1 之后 append → LCP = system+链1+tail1 ✓（全程命中链 + tail1，只新消息 miss）。
- 原实现（无链）：压缩后前缀 = [system][摘要X（变长字节改变）][tail1]；第二次压缩 → 摘要重建（字节全变）→ 两次压缩之间只隔"摘要的 1 次使用"。链式下，压缩 1 与压缩 5 之间的任一请求前缀的最长公共部分 = system+链（4 条摘要），随压缩次数增长而累计（02 §2.1 的数学）。**数值论证成立**：跨压缩累计可命中字节从"0（system 后全换）"变为"逐层累计的链总字节"。
- **修正点 1**：LCP 命中成立的前提是**链字节 == 服务端实际收到的请求前缀字节**。因此 §11 测试 11（two_compactions_keep_chain_bytes_stable_in_wire）的断言必须在**真实 wire 层**做（TestProvider.requests()），因为 AgentMessage 的 content 兜底字段（AgentMessage.content，lib.rs:514）不上 wire（to_chat_messages 只取 blocks），本体一致不保证 wire 一致——测试 11 的描述"逐字节相同"需明确为 "requests()[i].messages 中链消息序列化字节"。方案 §11 已齐（"P1 E2 codex 断言模式"）✓ 不需要额外。

- **修正点 2（关键）**：链的冻结是"新建的摘要消息一次写入后不改写"——但**摘要文本的确定性**：L2 摘要写一次 ✓（B3 只增）。L1 stub 文本确定性 ✓。但**链上摘要文本内容包含烂字符/截断时**什么？无问题。

- **修正点 3（真实收益的暗礁）**：链作为摘要的角色~若链尾文本内容在每次压缩后都不同（因为 L2 LLM 非确定性），那链文本它自己是 write-once ✓ 稳定。但如果" 同步先试一次"（R-F）成功 → 摘要文本 = LLM 生成的完整 JSON 文档的 markdown 渲染？ § 5.1 说"对话槽 = markdown 渲染投影"→ 渲染函数确定（输入输出固定）→ 本文写一次后稳定 ✓。但 §5.4 R-F 的同步路径写链的是"摘要文本"（不是文档 JSON）→ 链上文本形态与"下一轮 existing 从表取文档"（§5.3）存在两种来源 → **existing 语义不稳定**（见 P0-4）。

### 3.3 signature 重建（T-26~T-29）与误判风险

- **核心比较时序已核实无系统性误报**：`rebuild_after_compaction`（T-28）在 apply_compaction 对话替换后调用（`state.conversation = plan.messages.clone()`，handlers/mod.rs:349 是既有行无改），捕获的是压缩后真实对话；`capture_signature`（cache_tracker.rs:158 既有代码，build_request 前）在同一个对话上调用 → 相等（正常路径）✓；T-29 的"相同=正常、不同=harness 改写"比对在**同一对话**上成立，不误报。tools_hash 相同（快照锁定）。
- **残留误报场景（应预防）——压缩后首请求前对话被追加**：如果在 apply_compaction 之后、record_usage 之前，运行必要步骤（steering 注入 prepare_turn、overflow 阶梯）把新消息追加进对话，pending_signature（捕获于 build_request 前）包含新消息，rebuild_signature 不含 → T-29 判"不同" → 误报 harness 改写。**修正**比对规则：使用 `prefix_diff_index`（T-25 提出）做**前缀匹配**：rebuild 签名是"前缀基线"（rebuild.message_hashes 是压缩后的全部），cur 是前缀 + 追加；差异点定位在" 新增末尾"（index ≥ rebuild.message_count）→ 视为正常（追加），只有差异点出现在 rebuild 的范围内才归因 PrefixChanged。方案 T-29 原文只说"签名比对（同=正常；异=harness 二次改写）"——没有这个前缀语义，"异"会对正常的后续追加误报。评审判：**必须实现 prefix 型比对 + 差异点定位新增尾部豁免规则（P1）**。
- **L2 摘要同步成功 vs rebuild 的耦合**：R-F"同步先试一次成功 → 摘要写链（冻结）+ summary_json 写表";rebuild 捕获的是链消息本体（摘要文本）→ 链消息是这次请求的真实前缀 → rebuild 值准确 ✓。
- **stub 冻结后 rebuild_prediction 与表一致**：stub 文本确定、不重写 → 压缩后首请求 stub 字节 = rebuild 捕获字节 ✓ 一致（无匍匐页）。
- **跨 run tracker 重建**：CacheStatsTracker 是 run 级对象（P5 §3.1.2 行 269、P5 §3.4.5 跨会话行 530-531"每 run 重建"），压缩通常发生在 run 中，pending_compaction 生命周期在 run 内 ✓；若压缩发生在 run 最后一 turn（run 结束前），pending 未被消费 → 下个 run tracker 新建 → pending 丢失（无残留）→ 无挂 ✓。**addtask 不用持久化 pending**。

- **generation 双源（R4）**：cache_tracker 内部 generation 自增（P5:528 `generation += 1`，on_compaction，cache_tracker.rs:238-241 为"00 概率"，实际 on_compaction 只做 generation+1 基线作废）；方案 §3.3 要"单计数源 LoopState.compact_generation 为权威，cache_tracker 消费"。整合方案不改这个：T-26~T-31 只谈 pending/rebuild，**没有"tracker 消费 LoopState.compact_generation 替代自增"的接线任务**。01 的 R4（行 249）把单源化讲清了，整合方案没承接 → 双代数源漂移仍存在（R4 悬空）。P0-5。

### 3.4 clean_output 的 wire 副本清洗与字节一致性

- 03 §3.3 的管线契约：落库原始字节、发送 wire 面清洗（确定性单函数）。**核心矛盾**：`AgentMessage` 是 `Arc` 不可变共享单对象（record_message 事件与 db 同 Arc，handlers/mod.rs:463-464 注释"Arc::new 一次后对话+事件共享同一份内存"）——**"落库原始 + 发 AI 清洗"要求同一消息在 wire 面存在清洗副本，但消息本体没有第二副本机制**（text 只有一个）。实现必须在 to_chat_messages 级（agent-provider/message.rs:318-395，P1 §3.4 的单出口）做"清洗"，专门在请求构造时对 wire 投影应用 clean+truncate，保持消息本体 raw。整合方案 T-23 把接线点放在 **executing_tools.rs:142-176（记录消息的时刻）**——那是 record_message 点（落库也是此刻），接线在那一刻要么改共享 Arc（污染落库）要么生成新 Arc（与事件 Arc 不同 → 落库两个变体字节、事件与对话不一致，破坏"同一份内存"断言）。**接线点放错层（P1）**：清洗必须在 build_request 的 wire 映射函数内，而不是执行器记录面：
  - 理由 1：同一个工具结果，第 1 次出现在 wire 与第 N 次回放（历史消息）时若清洗点不同步 → 历史回放消息 unsigned 清洗 → 前缀字节漂移（历史链回放 = raw，当前 = clean → LCP 实际比 mid 层短的）→ 服务端只能命中到清洗前字节"S"段 → 链收益缩水。**清洗必须对所有消息在 wire 上统一应用（幂等），或者在 wire 面上只对"新记录消息"清洗而使历史消息回放"绕过"清洗（回到案发现场的一致性风险）**—— 推荐"消息入库前把清洗结果缓存于 metadata（never 污染文本），wire 映射统一取缓存"——但还要与 P0 之前 settled：更简方案：**wire 面监测（to_chat_messages）对 ToolOutput 文本统一拉 clean+truncate（确定性）→ 历史与新增一致 ✓**。判定：到 T-23 接线点描述改为"wire 映射点"（P1）。
- **演练**：若维持"executing_tools 记录时清洗"（确认 T-23 原文是"在 wire 序列化之前、消息记录之后，每次 provider 请求构造时对 tool-result 文本跑管线（在请求面做可重复计算）"——03 §3.3 原文其实已经是"请求面做可重复计算"（03 行 141-142）！03 的意图是正确的：清洗在"请求面"（per-request 重复计算），但 T-12（03）接线位置写 executing_tools.rs:142-176——这看即可理解错误：tool_result_message 是"工具结果进对话的唯一点"（wire 消息的生成点），但若在器上应用会污染记录。结论不变：**接线点应该放 wire 序列化（to_chat_messages 或 build_request 前对 tool-result 文本变换），请求面可重复计算；不应改记录点**。03 自己说"清洗发生在 wire 序列化之前、消息记录之后"（03:141）——这就是"请求时"和"记录后"两个点，执行应在序列化时。整合方案 §7.2 行 228 接线"executing_tools.rs:142-176"与自己的 §3.3 矛盾；P1）。

---

## ④ 数据模型与迁移问题

### 4.1 单表合并（R-A）——成立，但字段完备性三处

- 合并理由（块与摘要文档一对一，04 §2.1 的双表"两表同 session 同 block_id 无独立意义"）成立。合并后列 = 01 块元数据（block_id/session_id/sequence/generation/prev_block_id/summary/summary_is_llm/dropped_message_ids/first_kept_message_id/tokens_*/dropped_at_ms/created_at）+ 04 文档字段（schema_version/height/tier/state/attempts/summary_json）。
- **完备性核验（评审重点 4）**：
  - 跨 run 恢复 generation：表有 generation 列 + orchestrator 恢复路径（T-18 对齐 restore.rs:734-740 的 CONTEXT_COMPRESSION_END 重放）✓；但 compact_generation 的会话级持久化键（01 §3.3 的 SessionContextMeta 扩展）没有在方案任务里（T-18 一处统一收口）。**可**（T-18 覆盖）。
  - awaiting/committed/retired 状态机 ✓；**缺失 state 迁移面的唯一约束**：表只能有每 (session, block) 一行，state 变更走 UPDATE（mark_state）— 幂等 ✓。
  - **幂等键**（评审重点）见 P0-1：`INSERT OR IGNORE` 以 block_id 为键在单会话内有效，跨会话/重建路径冲突。
  - **缺字段 1**：`covers_up_to_turn`/`dropped_at_ms` 的表值 vs summary_json 内的 JSON 字段（04 Schema 有 coversUpToTurn、01 表有 dropped_at_ms ✓ 在）。合并后 coversUpToTurn 只在 summary_json 中，表列没有——跨会话查询（search 排序）可不依赖，P2。
  - **缺字段 2**：块的 wire 序列与 delete 语义无关——无。
  - **缺表级决策**：`dropped_message_ids` 以 JSON 数组存（TEXT），回放按 positions——按 id 回放事件需要索引（R2 接受 V1）。OK。

### 4.2 事件 details 扩展向后兼容——成立

- `details` 已是自由 JSON（tool.rs:489 `details: Option<serde_json::Value>`？01 说 :489 details 恒 None + 自由 JSON），追加 camelCase 字段不需 serde 契约变更 ✓；`record.id` 保留 ✓（校验 `ContextCompressionRecord` 的既有消费者 P4 事件测试、前端 parser 宽容归一器）。
- **但注意**：R-B 裁决"record.id 保留既有语义（事件内唯一）不再兼任块 id" → 块 id 与事件 id 分家后，`compression_blocks.block_id` 论其唯一性（见 P0-2），以及与 `record`（事实落事件）之间没有外键关联（块表 sequence 列是定位事件的关键，01 有 sequence ✓ 方案 §4.4 有 sequence 列……检查整合方案：R-A 合并列后没有明确列出 sequence？01 表 DDL 有 sequence；措施方案 §4.4 BlockMeta 里没有 sequence 类——**表没有 sequence 列 -> 块与事件行的关联只能靠 dropped_at_ms 比对，P 缺口**；评审所见方案 §4.4 BlockMeta 包含 dropped_at_ms 但未列 sequence→ 建议补（与 01 一致）。P2。

### 4.3 v7 迁移安全

- 走既有 PRAGMA user_version 逐版本独立事务、幂等（migrate.rs:12-13、lib.rs LATEST_VERSION=6 实核）✓；新表 = 零既有列改动 ✓（不触发 ERROR 全表重写/备份-DROP——P5 §3.1.4 已评述 ADD COLUMN 不触发备份-DROP；此处新建表也不触发既有 DROP ✓）。
- **迁移失败回滚**：每版本独立事务 → 失败自动回滚且不进入下一版本 ✓（migrate.rs:94-96 注释）。测试追加 v6→v7 黄金断言 ✓（11 §11 测试 16）。
- **backward 细节 1**：新代码 query 块表，若**降级回滚（版本回退）**则旧代码（v6）运行期间新表被忽略（v6 代码无查询）→ 安全 ✓；但**新代码在 v6 库上运行**（升级不完整场景）→ 查询报 SQL 错 → 工具报错 / decompress 失败 → 需要优雅降级（空结果而非失败提示）——方案未定义运行时表缺失降级路径（P2）。
- **backfill（V2）**与幂等界定（scan 旧压缩事件 → 插块行，幂等按 dropped_ids）✓ 列入 V2 不是阻塞 ✓。

---

## ⑤ 并发与安全分析

### 5.1 摘要任务全局并发上限 2 + per-session 单飞

- **上限合理性**：主请求（run 主循环）与摘要请求共享 provider 通道（04 §7.1 的要点）—— 全局 2 会把摘要背景 user 3366 的并发峰值限制到 2，+jitter 防同频，429 分类 retired（方案 §5.4）；手指在"主 run 并发不设限"前提下摘要上限 2 足以防自身打爆；若未来多 run 并行（orchestrator 多会话并发，multi_agent.rs 同测两个 run 并行），主 run 并发数为 N，摘要 2 相对安全 ✓。判：防护充分（P 级：可接受）。
- **429/5xx 分类已设**（04 §7.3 行 352），方案 §5.4 只写 429 → OK。
- **漏点：退避重复触发与单飞的会话级形态**——见 P0-C 与 P1。

### 5.2 compression_blocks 表写入幂等（多会话并发）

- conex-db LocalDb 全库单连接互斥锁（events.rs:15-19、cipt 0-21）→ 写串行 ✓；事件 sequence 原子取号（reserve_sequence，events.rs:72-99）= ✓；块写入（INSERT OR IGNORE）在锁内串行 → 幂等性只依赖幂等键（block_id/session_id）——当幂等键为 (session_id, generation) 时多会话无冲突；若单列 block_id 全局唯一 → 冲突（P0-2）。会话删除 CASCADE（FK）在删除事务内 ✓。

### 5.3 project_tree 缓存并发（同键锁）

- 实现（`static LazyLock<TreeCache>` + `Mutex<HashMap<Key, Arc<Entry>>>`，§7.1 = 03 §2.2）**线程安全成立**：std Mutex 保证同键才串行…… 不对，整个 HashMap 一把锁：**不同键的构建也互斥**（持锁执行 IO 构建）→ 线程安全 ✓，性能代价（全局串行构建）可接受（树构建 ms 级、低频）；"同键并发持锁去重"✓；跨进程不共享（manager 多 daemon）由键隔离 ✓。**风险仅为"多 daemon 多工作区"场景**双进程各自缓存无串扰 ✓。
- 一个不一致点：方案 T-25（把 SKIP_DIRS 提 pub(crate)）与 03 的 T-01 一致；`pub(crate)` 提权不违反扁平（跨 crate pub(crate) → pub 即可，因为 project_tree 跨模块引用 search.rs 的同 crate pub(crate) ✓）。

### 5.4 clean_output 的纯函数确定性 ✓（评审重点 5）

- 清洗是确定函数（同输入同输出）→ 同消息两次请求 wire 一致 ✓；**清洗对前缀字节的影响** = "清洗前后字节差" 是 deterministic → 服务端缓存按清洗后的字节前缀匹配 → 只要**历史消息的清洗路径与新增一致**（wire 面统一）→ 无前缀漂移。见 3.4 的接线点问题（P1-3）——若历史回放在不同阶段（记录时干净 vs 回放时不清洗）→ 漂移。核心裁决已在 3-4 给出：清洗必须 wire 面（单一映射点 / build_request 侧）同步对齐全部消息。

### 5.5 发送前清洗 vs 发送后原始落库的字节一致性

- **T 场景残留**：同一 AgentMessage 的落库字节 = raw；wire = clean；事件流审计 → raw；decompress 回放 → raw → 工具取回的内容 = raw（未清洗原文）→ 与"发送模型"看到的内容不一致（模型看到 clean，检索回 raw）→ 对不敏感场景（去重/空行合并只删噪音）无碍；但 R4 等语义损失（重复行等）在恢复面看到完整原文是"期望行为"（原文优先保真）✓ 合理；**需要文档约定：decompress 返回的是原始字节（不经 clean），不是 wire 字节**（避免模型预期不一致）P2。

---

## ⑥ 架构分层问题

### 6.1 agent-tools 访问 DB 面（评审重点 6：越界与否）

- **方案 §6.1/6.2 说"经注入的 LocalDb 访问（先例：wait_subagents.rs:1506、revert_guard.rs:21-23、output_dir.rs）"。实读结论——该先例是测试性伪证：**
  - `wait_subagents.rs:1506` 的 `db: conex_db::LocalDb` 在**测试模块**内（`struct DbDispatchStore` 定义于 `mod tests`，1504-1517），断言"dispatch_* 落库与重启恢复（conex-db dev-dependency）"——生产代码不在其中。
  - **agent-tools 的 Cargo.toml 生产依赖不含 conex-db**，conex-db 仅是 dev-dependency，注释明文："生产代码保持叶子依赖（不引用 conex-db），接线在引擎侧完成"（agent-tools/Cargo.toml dev-dependencies 注释）。
  - 生产注入先例是 trait 面：`ToolContext.output_dir: Option<Arc<dyn OutputDirResolver>>`（context.rs:125）、`log_root: Option<PathBuf>`（context.rs:129）、`explore_quota`（context.rs:149）——全部是"Option + dyn trait 执行期装配"。
- **结论（P0-6/P1 级）**：search_context/decompress_context 若注入**具体 LocalDb**，将把 conex-db 引入 agent-tools 生产依赖边（破坏其叶子依赖纪律），且工具拿到的是一个整库权限（读任何事件/元数据）而非会话粒度的只读视图。正确做法：**trait 注入**（如 `Option<Arc<dyn CompressionBlockStore>>` / `SessionCompressionContext`，agent-tools 定义 trait，引擎侧实现）——这与"引擎侧强化注入模式"（P4 §3.7 摘要实现）一致；或者提供"只读查询服务接口"由 session-loop/orchestrator 面实现注入。**注**：session-loop 也不依赖 conex-db（Cargo 实核无），所以"回放事件流提取原文"的实现层归属需要明确：conex-db 已有 query_events 面（events.rs:33 not via 唯一索引），orchestrator 有 LocalDbStore（persist.rs:125-）；推荐：`compression_blocks` 查询域在 conex-db（表已归属），工具侧经 trait 注入查询接口（1query）或由 orchestrator 暴露 Session 压缩上下文查询并注入（对齐 engineer 层）。

### 6.2 search_context / decompress_context 依赖注入方式（先例 wait_subagents.rs:1506 是否够先锋）

- 不成立（见 6.1）。**正确先例**是 output_dir / explore_quota / idempotency 的 trait 注入（context.rs:125、explore_quota.rs:17-22 的"由引擎侧实现 store 注入工具"注释）。且要考虑 after approval 面：只读工具进子 Agent 只读集（R9）→ **若 tools 依赖的"只读视图"本身需要 trait 注入，子 Agent 工具的注入面同样需要**（spawn 时把引擎侧 store 注入不能带 session 外数据）——注入面形态影响子 agent sandbox 全套，需在实现计划明确 trait 边界（P1）。
- **decompress_context"默认落文件"与子 Agent 只读集冲突（P1-6）**："只读注册（dangerous=false，进子 agent 只读集）"与"默认落文件"矛盾（写文件 = 副作用）。子 agent 只读集内不允许写文件（SP 既有约束），→ 子 agent 场景 decompress 必须 inline 模式（返回文本经工具结果通道），或把"落文件"限定为主 agent 权限（落文件需要 output_dir 解析服务 + 写权限面）。方案未落此边界 → P1。

### 6.3 五层划分职责越界检查（其余面）

- 引擎层（conex-compaction）新增 recovery/summary_document/clean_output 纯算法层：与现有 crate 定位一致（无运行时依赖，Cargo 实核仅 conex-types+serde+serde_json）✓；**clean_output 与 tool_output 同层是纯函数**，接线才在 session-loop ✓。
- 摘要调度器放 session-loop 新文件 summary.rs：与 04 同位置 ✓；但**单飞粒度是"会话级"而状态放在 LoopState（run 级）**（P5 行 274 `summary_state: Option<SummaryTaskState>` 挂 LoopState；T-21 又 T-21 handlers/mod.rs LoopState：summary_state）——**LoopState 每 run 新建（P4 producer produce 期）→ 摘要任务 spawn 于 run 内、状态随 run 消亡 → 跨 run（run 收口时摘要尚未完成）任务/状态丢失 → "会话级单飞 + 跨轮重试"（§5.4 退避 1/3/9s，单轮最长 13s，长于单 run 常态）不成立**。必须把 single-flight 状态 + JoinHandle 放到会话级（壳层 CoreRunState 或 engine/orchestrator 面，与 SessionHistoryCache 同生命周期——P4 §3.2.1 的缓存对象即归点）。**P0-C/P0-3**。
- 测量面 conex-telemetry：加 prefix_diff_index 纯函数 ✓（T-30）；Rebuild 属 session-loop — cache_tracker 消费 logic ✓ 分层合理。但 **cache_tracker 与 LoopState.compact_generation 的单一计数源**接线缺失 → P0-5。

---

## ⑦ 风险补充（§12 之外的遗漏）

在方案的 §12 九条基础上，补充以下遗漏/低估：

| # | 遗漏风险 | 等级 | 说明与建议 |
|---|---|---|---|
| N1.1 | **图形 cookie 数据（wire 清洗一致性）**：清洗管线若接错层（记录面 vs wire 面），则历史消息回放与新增消息清洗路径不同 → 前缀字节漂移，缓存链收益缩水；与 3.4 链/3.8 交互 | 中→高 | 明确 wire 单点（to_chat_messages/请求边界）应用 clean+truncate；落库/事件仍 raw；加"历史回放与新增同路径字节一致性"测试（golden 两次请求） |
| N2. 服务端缓存分层的链长度效应：DeepSeek 分层缓存（约 64/2048 等分界）对超长前缀的收益结构：链超过单层容纳时部分 hit/部分 miss，hit 价可能按层变化（P2 未接 price 的层面[3.5.1]） | 中 | 恢复曲线 KPI（多开序失败态观测第 5/10 请求）已有兜底；建议补充"链长 vs 命中率"随链长的拟合观测（P2） |
| N3. 多 worker（orchestrator 多会话并行）下 N 主 run + 摘要 2 并发的 provider 热载：缺"全局并发上限"只覆盖摘要任务，不覆盖主 run → 若将来 multi-worker，processor 主 run 并发本身即 provider 热点 | 中 | 明确摘要上限 2 是"摘要域"约束，主 run 并发另有既有机制；文档标注边界 |
| N4. 迁移失败回滚的降级行为：表缺失（v6 库被新代码读）→ search/decompress 空结果还是报错？方案无优雅降级定义 | 中 | 查询 API 对缺表返回空集 + warn（相容 v6 库前进）；补测试 |
| N5. subagent 只读工具集暴露面：search_context 可按 blockId 全文检索压缩历史（含容器/密码/工具输出），写入子 agent 只读集 = 子 agent 可检索主会话敏感信息 | 中 | 会话内已有审计；建议 audit 记录 search/decompress 调用（复用 middleware/permission 审计 #）；不在"工具权限面"新增批准（数据属会话自身） |
| N6. decompress 原文不 starve wire 清洗（直接返回 raw）——模型看到"未清洗"原文与 wire 不一致（见 §5）；需文档明确"decompress=原始字节" | 低 | 文档约定 + 描述在工具描述中 |
| N7. **逃生舱与 compression_blocks 的衔接**：链 reset 后旧块仍保留（可追溯 ✓），但新链的 formula_prev 如何指向前？（reset 的 prev_block_id = 旧链尾块 id）→ search/decompress 跨越 reset 的链如何追溯完整" | 中 | 规划 reset 时块链的链接规则（prev_block_id 指向旧链尾 + 语义说明"reset 合并"） |
| N8. 时间线注入卫生断言（T-24）只断言"工程面"，若未来某日 gateway/stream harness 注入点偏离尾部，链（到 system 后）直接炸——需要把注入卫生做成**运行期断言**（测试或 debug 开关）而不仅是纪律文档 | 低 | 与 §8 纪律配套：每次 build_request 前对 system/tools/链段做 hash 稳定性波动监测（现有的 capture_signature 链可以借用：system_hash 变化 → 告警） |
| N9. 链 token 预算挤压 keep_recent_tokens 时"压缩永远进行但利润递减"：若链巨大（逃生舱前），每次压缩只动新 tail，链预算占满窗口（plan 60% 触发器无实现） —— 逃生舱"列为未来演进"需有**观测触发器数据**（当前手段=恢复曲线 KPI 只能间接），建议：T-19 的 stable_prefix_tokens（02 分析）升级为 run 级 KPI 常备 | 中 | 保留 T-19(T 阶段 C) 为"非可选"或提前到估算层（02 §六 阶段 C 已列） |

---

## ⑧ 意见清单（优先级）

### P0（必须修改后才能实施）

| # | 意见 | 证据 | 修改方向 |
|---|---|---|---|
| P0-1 | **block_id 全局唯一性缺失（数据模型级冲突）**：R-B 用 fold_index 作块 id + 消息 id；(a) 跨会话 fold_index 必然重复 → `compression_blocks.block_id` 若为全局 PRIMARY KEY（01 提议单列主键）→ 第二会话块插入冲突；(b) 链重建（逃生舱或水合去链）后新链第 1 块 id 与旧块同 → 表行被幂等忽略 → 旧块断可追溯；(c) search/decompress 按 blockId 查询存在跨会话/代二义。 | 00 方案 §2 R-B 行 47、§4.4 BlockMeta（"compacted-summary-{fold_index}"）；01 分析 §4.2 DDL 行 176-177 单列 PK；lib.rs:151 消息 id 推导可重 | 块 id = 会话/参数间生成（`cb-{session_short}-{gen}-{fold}`）或表主键改 (session_id, block_id) 复合 + 工具查询强制 session 域；**链重建需周期/代数**维度区分（generation 进 id）。同步修正"消息 id = `compacted-summary-{fold_index}`"：**消息 id 唯一性本来就该满足**（历史仲裁链成员检测 starts_with），改为 `compacted-summary-{gen}-{fold}` 保持前缀兼容 |
| P0-2 | **摘要调度器任务与"会话级单飞"跨 run 断裂**：单飞状态与 JoinHandle 挂在 run 级 LoopState（T-20/T-21），run 收口即丢；退避最长 ~13s 必然跨 run（收口后任务仍在后台写库与事件），会话级单飞语义不成立 → 多 run 同触发会并发两个摘要任务（全局 2 上限兜底但不具会话语义），且任务完成时 run 已不在（写块/事件挂对象失效或错乱）。 | 00 方案 §10 轮次 3 T-20/T-21；04 分析 §5.1 行 276 `LoopState.summary_state`；P4 §3.7 会话级状态在 CoreRunState（P4 行 559`SessionHistoryCache`） | 摘要任务状态（JoinHandle/backoff_seq/attempts）挂**会话级**容器（与 SessionHistoryCache 同生命周期：壳层 CoreRunState 或 orchestrator 会话上下文），循环侧只做"触发/登记"；run 收口不摧毁任务；任务完成回调以会话元数据为目标 |
| P0-3 | **摘要面自相矛盾（R-C 与 §5.1/§5.4 及 stub 文案的死锁）**：R-C"stub 永不改写"+ stub 文案固定"⏳ 摘要生成中" → (i) 摘要异步完成后 stub 依然显示"生成中"（对话里永远骗模型）；(ii) §5.1"对话槽：summary_to_markdown 渲染投影"与 R-C 不可兼得（唯一能放 markdown 的地方被 R-C 锁死）；(iii) 4-5.4"同步先尝试成功即摘要写链"({"链文本"}) 与 §5.3"existing 优先从表取文档"并存——同一"摘要"有两个语源（链文本 ω vs 表文档 ω），后轮 existing 在链尾文本与表文档间无仲裁 | 00 方案 §2 R-C 行 48、§5.1 行 151、§5.2 行 158、§5.3 行 27-28；04 分析 D6（stub 替换成 markdown）与 R-C 冲突 | 裁决并唯一化："摘要在对话的宿=链消息文本（一次性写）+ 规范性文档在表（summary_json）"，两者内容同源但形态不同（md 渲染 vs JSON）沟通路径明确化：现有 T-07（取链尾文本）只用于 L1/stub 场景，或统一改为"链尾摘要文本始终 = 该块文档的 md 渲染"（同步成功时表单取文档渲染，失败时 stub 渲染）；**stub 文案改中性**（"摘要已生成，可用 search_context 检索" 或保持"avataring 等待"且**重试完成时 stub 文案不该改**——但这与 B1 冲突 → 干脆：stub 文案中性化,后状态语义从表单查询） |
| P0-4 | **B1 与逃生舱（计划级重建）的正向冲突未登记**：逃生舱=批量改写链（删除+重写摘要 1 条）直接违反 B1 的"链消息永不修改/丢失"，§11 测试 1（冻结断言）将锁死逃生舱；方案无例外登记、无触发计算、无执行路径 | 00 方案 §12 风险 1 行 344（一句），02 分析 §2.1 行 85；§11 测试 1 行 313 | B1 声明改"链消息在正常生命周期内不可改写；set 唯一例外 = 登记者（generate）：计划级重建（trigger 由 KPI 观测且 requirement 达窗口比例）"，并定义 reset 的块链衔接（prev_block_id 链尾）+ 测试（两次 reset 链行为） |
| P0-5 | **压缩代数双源未接线（01 R4 未落地）**：方案 §8 代数接受"从统计数推导"，cache_tracker.generation 是 tracker 自增（cache_tracker.rs:159-242 `on_compaction{ generation+=1 }` per P5 §3.4.5）；01 R4 已裁决"LoopState.compact_generation 为权威 + 消费该值"但整合 T 清单（T-19~T-31）未写"tracker 消费 LoopState 代数"的接线任务 → 两源漂移（如事件重放/重建后不一致，rebuild 签名比对 baseline 代数校验无法校准） | 00 方案 §3.3 行 27-29 vs T-26~T-31；01 分析 R4 行 20-21；P5 §3.1.2 行 280-282 generation 字段 | 增加 T 任务：apply_compaction 把 `LoopState.compact_generation`（会话级唯一源）注入 CacheStatsTracker（替代其内部自增字段）；cache_tracker.generation 只读该值 |

### P1（建议修改）

| # | 意见 |
|---|---|
| P1-1 | **fold_index 推导在旧格式混含会话的 id 碰撞**（B3 缺口）：新旧格式 id 同格式不可区分；加" 分析链最大数字后缀"派生或把 id 改为 `-{gen}-{fold}`（与 P0-2 统一） |
| P1-2 | **B2 断言需限定"水合上下文含完整链"**；无链水合（前端 history 兜底）为"已知降级"并补测试（含链 → B2 断言；无链 → 行为正常降级） |
| P1-3 | **clean_output 接线点改 wire 面**（现有 T-23 的 executing_tools 记录点会污染落库或造双子同一消息双字节）→ 改 to_chat_messages/wire 构造面；加"历史回放与新增清洗一致"测试 |
| P1-4 | **T-29 比对需前缀语义**：rebuild=前段基线与 cur 比对应允许尾部追加（prefix_diff_index 定位，差异只在追加区 → 正常），实现" 差异点在历史区才归因 PrefixChanged"，防止"压缩后首请求前尾部追加"误判 harness 改写 |
| P1-5 | **agent-tools 的 DB 访问通道改 trait 注入**（wait_subagents.rs:1506 是测试先例不构成先例；agent-tools 生产依赖不含 conex-db——dev-dep 注明"生产代码保持叶子依赖"）：`Option<Arc<dyn CompressionBlockStore>>` trait（引擎侧实现）+ session 作用域查询校验 |
| P1-6 | **decompress_context 落文件与子代理"只读"冲突**：子代理只读集无写文件权；方案需明确子代理路径默认 inline（或落 output_dir 且仅主 Agent） |
| P1-7 | **协议首条约束不完整**：无 system 会话链首条 = assistant → provider 400（02 §四风险 4）；"首尾双约束"水合断言只"拒"，引擎在无 system + tail 首条非 user 时应有兜底策略（暂不压缩或水合层游刺）明确 |
| P1-8 | **新事件类型未注册**：`context-summary-ready`（00 §5.4）与 ToolOutputCleanupRecord（00 §7.2）若都作为**新事件类型**落 events → 触发 events_schema_version.rs/V1_EVENT_TYPES（本身 41 变体 + fixture 每类 ≥1）的 3 个一致性测试失败；CLEAR 判定：Clean 记录若复用既有事件类型做字段级扩展（带 payload 类型标记）则不增类型；若新增类型必须在 33-event-schema-changelog 登记 + V1_EVENT_TYPES 追加 + fixtures 样本——**方案 T 清单无登记任务** → 单列任务 |
| P1-9 | `summary_documents → compression_blocks`（R-A）后 04 的 T15（壳层收口写 stub 行替换）被 R-C 取消耗——但 04 §2.3 的"壳层 run 收口把 stub 行清理为完整 markdown 渲染"产物取消后，前端水合展示面失去摘要文本（只渲 stub 行 + 表数据）——前端感知路径方案没有交代（UI 从块表取显示 via 新 query？）——需在收尾（§13）或前端需求中挂账 |
| P1-10 | 摘要任务墙钟预算缺失（04 的 LOOP_SUMMARY_MAX_WALL_MS 60s 上限在整合方案 §5.4 未保留）：同步先试 + 退避 3 次为 13s + 调用本身（Summarizer 就 300s 墙钟？ai_summary.rs:206-238 既有 wall-clock 300s）——一个摘要任务最长 313s 后台乘（若 429 重试序列）——重定义任务的单次调用墙钟（建议 60s，04 §5.2 行 292） |

### P2（可选/改进）

| # | 意见 |
|---|---|
| P2-1 | v6 库被新代码读的优雅降级（search/decompress 缺表返回空结果而非 SQL 报错）+ 表存在性测试 |
| P2-2 | `compression_blocks` 补 `sequence`（对应事件行定位，01 DDL 有，整合 BlockMeta 未列全显）与 `covers_up_to_turn` 列（检索与审计收益，低优先） |
| P2-3 | 增加"压缩后 stable_prefix_tokens（system+链）"作为估算扩展（T-19 不选装），供逃生舱触发与恢复曲线基线 |
| P2-4 | project_tree 大锁定改为条目级去重（如 HashMap<int, Arc<Building>> 或分段锁）避免多键构建互相阻塞（性能面，非安全面） |
| P2-5 | 工具注册（新增 3 工具）一次性上线：tools 列表变化将作废全部既有缓存一次（达成先例 jcode P1 措辞"新工具接入应一次性引入"）；计划计入该次预期 miss |
| P2-6 | decompress 输出文档化"＝原始字节（不经 clean）"，非 wire 字节，避免模型认知偏差（§5） |
| P2-7 | 手工审计点：search_context 命中详情（执行记录 + AuditSink）——R-N 敏感面（P1-0 的审计补充，可合并实现） |

---

## 附：本评审的证据引用索引（文件:行号速查）

| 证据点 | 位置 |
|---|---|
| current summary id = dropped 计数（可重名） | conex-compaction/src/lib.rs:503 |
| existing 取首个匹配文本 | conex-compaction/src/lib.rs:459-464 |
| 组装 = system + 单条摘要 + 保留段 | conex-compaction/src/lib.rs:496-516 |
| find_cut_point_inner 三路径（倒推/ turns/tool 配对） | conex-compaction/src/lib.rs:544-639 |
| cut==0→None 语义 | lib.rs:569-575 |
| summary_placeholder / truncate_summary | conex-compaction/src/lib.rs:749-752、758-775（04 §1.2 引用） |
| 对话替换 = 唯一前缀重写点 + record 构造（details:None 现状） | session-loop/handlers/mod.rs:305-307、348-349、380-381 |
| 事件 persist 面（event_class / append_event / 序列） | orchestrator/src/events.rs:47-57、188-194 |
| 压缩护栏重放 restore 模式 | orchestrator/src/restore.rs:728-744 |
| events 表 append/query（无消息 id 索引） | conex-db/src/events.rs:8-27、33-68 |
| 迁移链版本 | conex-db/src/lib.rs:49-51（v6）；migrate.rs:94-113 |
| session_sequence 原子取号 | conex-db/src/events.rs:72-101 |
| 事件注册基线（41 变体 + fixture 覆盖 + changelog 纪律） | conex-types/tests/events_schema_version.rs:35-123；tests/fixtures/README.md:26-31 |
| CacheBaseline.generation 与 on_compaction | session-loop/src/cache_tracker.rs:158-165、237-242、469-488 |
| build_request_signature 对 AgentMessage 本体哈希（干净输入） | session-loop/src/cache_tracker.rs:467-488 |
| 摘要器防护墙钟 300s | conex-compaction/src/ai_summary.rs:206-238（方案引用） |
| wait_subagents 的 LocalDb 为测试面 | agent-tools/src/tools/wait_subagents.rs:1504-1517；（测试 mod 内） |
| agent-tools 生产不依赖 conex-db | agent-tools/Cargo.toml dev-dependencies 注释 |
| 生产注入先例（trait） | agent-tools/src/context.rs:121-129、149；explore_quota.rs:17-22、284-292；idempotency.rs:110 |
| P4 水合与尾部约束 | P4 §3.2.2/3.2.3（P4文档 186-188 行）；P1 §3.5 |
| P5 事件/代数/重建 | P5 文档 §3.1.2 行 274-281、§3.4.5 行 528-531 |

（完）