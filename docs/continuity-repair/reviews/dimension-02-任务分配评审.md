# dimension-02 — 任务分配与维度划分合理性评审

> 目录:docs/continuity-repair/reviews/
> 日期:2026-08-11
> 定位:维度文档轮(D1-D8)的三份评审之一。本份视角 = **任务分配与维度划分合理性**——维度粒度是否适合派单、文件域是否互斥可并行、有没有拆太小/太大、任务书下发时每维度工作量是否均衡。
> 输入:00-总纲-维度设计.md、01-敲定方案.md、dimensions/D1~D8(8 份维度文档)。
> 方法:按「粒度 → 文件域互斥 → 工作量均衡 → 任务书要素完备性 → 问题清单 → 推荐派单」六步核查;所有结论附证据(文档名:章节),代码行号引用以各维度文档核证为准。
> 本文件为只读评审产出(唯一写面);未修改代码、未执行 git 操作。

---

## 0. 结论速览

1. **粒度**:8 个维度**无「15-30 行」过小维度**(最小 D2 也约 350-500 行含测试);有**两个过大候选——D4(11 文件、两个正交子域)与 D8(三簇横切、跨三个批次)**,建议派单前拆分;D5 虽为最大但内部强内聚(收口 RoundAssessment 单写方纪律),**不拆**。
2. **文件域**:最大的派单障碍是 **D1↔D7 对「流中断结构化标注」四文件(stream.rs / consume/mod.rs / streaming.rs / engine.rs-to_loop_event)双认领**,两文档互相矛盾,不仲裁无法派单;其次 core_run_commands.rs 为 D1/D2/D3/D4/D5/D6/D7 七维度汇聚面,**实际并行度由「不碰该文件的面」决定**,维度划分与派单粒度之间有一层未标注的「壳层面 / 独立面」切分缺口。
3. **均衡**:工作量排序 D5 ≈ D4 > D3 ≈ D8 > D6 > D1 > D2 ≈ D7;无维度需「砍范围」,但 D4/D8 需按子域拆单,D1+D2+D5 的壳层面建议合并为单 Agent 一体化(00 总纲同批约束的最忠实落地)。
4. **要素完备性**:8/8 维度八要素(验收/基线/设计/数据面/测试/风险/接口/动态决策)齐备,无缺失要素维度;唯一瑕疵 = D5 事件登记「六处改动面」与 D8 实测「九处」不一致(严重项 2)。
5. **派单方案**:3 轮,agent 数 5/4/2(均 ≤12、不强制占满);轮 1 核心同批簇 + 独立面并行,轮 2 恢复执行面(core_run_commands 串行链),轮 3 观测收尾 + 门禁。

---

## 1. 维度粒度核查(每维度的文件面 / 代码量 / 子域 / 判定)

> 代码量估计 = 各文档自述量级 + 01 敲定裁决中的行数评估 + 测试量推算;含测试代码。粒度判定标准:15-30 行为拆太小、单维度 >8 文件或含两个无耦合子域为拆太大。

| 维度 | 文件面(crate 数) | 代码量估计(含测试) | 内部子域 | 粒度判定 |
|---|---|---|---|---|
| **D1** 传输层与断网重试硬化 | 10 文件 / 4 crate(stream_error.rs、handlers/mod.rs、loop/mod.rs、end.rs、stream.rs、streaming.rs、engine.rs、core_run_commands.rs、consume/mod.rs、conex-types);**其中标注三文件 + engine.rs 映射与 D7 冲突(§5 严重 1)** | 300-500 行(退避 B≈180-270 行、熔断 80-120 行、连接配置 ~20 行、数据面 ~30 行、标注 40-60 行 + 测试 T1-T18) | 退避 / 熔断 / 连接配置 / provider_error 数据面 / 流中断标注(争议) | **中偏大,跨 crate 最广**;标注归 D7 后收敛为 7 文件,可整派 |
| **D2** 主 run error 收场自动续 run | 3 文件(核心 = core_run_commands.rs 一处 + recovery.rs 单函数 + 消费 D1 面) | 350-500 行(分支 ~60-80、helper 三件 ~80-100、指纹 ~15、mode 参数化、退避、测试 T1-T12 + 4 集成) | 判定分支 / 预算 / 退避 / 条目(单点集中) | **最小维度,不过小**;可并入 D1 同批(见 §6) |
| **D3** C7 恢复阶梯生产接线 | core_run_commands.rs(装配/触发/restore)+ 测试域;recovery.rs/session.rs/restore.rs 零改动(调用面) | 400-600 行(装配 ~60、收口触发 ~60、ctx 装配 ~50、blocking helper ~20、树重建 ~50、计数 ~30、测试 T1-T7 重场景编排) | 装配 / 收口触发 / 重启重排 / F2-27(单点集中) | **中偏大,复杂度最高**(收口链时序 + 12/5/1 + 重启语义) |
| **D4** 子代理恢复与关闭命令面 | **11 文件 / 4 crate**(core_run_commands.rs、main.rs、command_manifest.rs、commandManifest.ts、commandMap.ts、lifecycle.rs、kill_subagent.rs 新、tools/mod.rs、wait_channel.rs、engine.rs、conex-db 引用) | 450-700 行(kill_subagent ~50、命令壳 ×3 ~90、工具 100-200、通道 ~40、wait 真适配 80-120、prepare_resume 拆分 ~40、双端登记小、测试 T1-T10) | **子域 A:命令面/工具面;子域 B:wait 真适配**——两子域文件域零重叠 | **过大候选(§3)**,建议拆 D4a/D4b |
| **D5** goal 引擎化与完成契约 | ~7 文件 + 前端 1(orchestrator 新模块、core_run_commands.rs、normalize.rs、events.rs 系、useStreamCallbacks.ts)+ 测试 U1-U12/I1-I10 | 500-800 行(RoundAssessment ~150-200、goal_state ~40、四源 ~40、注入 ~50、事件发射 ~60、CompletionRequirement ~40) | 字段链 / 状态键 / 纯函数 / 四源 / 事件 / 模式切换(强内聚单写方) | **最大维度,但不拆**——goal_state 唯一写方 = 收口 RoundAssessment,拆开破坏数据面纪律(00 总纲 §5-12) |
| **D6** 无人值守唤醒链路 | 5 文件 + 新模块(timers.rs、sched.rs、engine.rs、core_run_commands.rs、wake_watcher.rs 新) | 400-600 行(真适配 350-500 两 store、watcher ~120、恢复条目 ~60、drain 上限 ~20、空转 ~15、user_stopped ~20) | 真适配 / watcher / 恢复条目 / 计数(①→②→③ 依赖序) | **中偏大**;①(store 真适配)可先行独立派(00 总纲 §4 并行集已含) |
| **D7** checkpoint 闭环与恢复质量 | ~10 文件 / 4 crate(core_run_commands.rs、safe_point.rs、hydrate.rs、recovery.rs、subagent.rs、subagent_spawner.rs、lifecycle.rs、consume/mod.rs、stream.rs、streaming.rs) | 350-500 行(采集 ~30、注入 ~30、树访问器 ~30、history 跨 4 文件 ~60-80、水合 15-30、标注 40-60 争议)+ 测试 T1-T9 | 采集注入 / history 传递 / 水合 / 标注(散布面大、单点小) | **中**;散布面最大但单点均小,按「独立面/壳层面」分轮派(§6) |
| **D8** 观测、UI 与口径 | ~12 文件(conex-types 全家 7、core_query_commands.rs、hydrate.rs 契约、crish-desktop 组件族 3、AGENTS.md、生成产物)+ 前端测试 | 400-700 行(事件登记九处 ~200 机械、parse_envelopes ~12、状态结构 ~60、前端卡片 ~250、投影 ~100、口径 2 行) | **簇 A:事件登记+检索;簇 B:UI/前端;簇 C:口径+?? 5**——三簇分属三个批次 | **过大候选 + 横切**(00 总纲 §3 D8 行「事件面随 D3/D5、UI 面随 D4」自证无法单次派发),§3 拆法 |

**判定小结**:无拆太小维度;D4、D8 两处过大需拆(§3);D5 最大但不拆;D1-D3、D6、D7 粒度适合派单。

---

## 2. 文件域互斥核查与串行派单分组

### 2.1 汇聚文件 × 维度矩阵(× = 触碰)

| 文件 | D1 | D2 | D3 | D4 | D5 | D6 | D7 | D8 |
|---|---|---|---|---|---|---|---|---|
| core_run_commands.rs(10278 行) | × | × | × | × | × | × | × | — |
| stream_error.rs | × | — | — | — | — | — | — | — |
| engine.rs | × | — | — | × | — | × | × | — |
| recovery.rs | — | ×(指纹) | ×(零改动调用面) | — | — | — | ×(history) | — |
| lifecycle.rs | — | — | — | × | — | — | ×(转换 helper) | — |
| subagent_spawner.rs | — | — | — | — | — | — | ×(history 装配) | — |
| **stream.rs / consume/mod.rs / streaming.rs** | **×** | — | — | — | — | — | **×** | — |
| hydrate.rs | — | — | — | — | — | — | ×(单写方) | —(仅契约) |
| events.rs + engine-events.json + fixtures + 断言 | — | — | — | — | ×(goal-* 登记) | — | — | ×(8 变体登记) |
| useStreamCallbacks.ts | — | — | — | — | ×(?? 5) | — | — | ×(?? 5) |
| timers.rs / sched.rs / wait_channel.rs | — | — | — | ×(wait) | — | ×(timer/sched) | — | — |
| main.rs / command_manifest.rs / commandManifest.ts / commandMap.ts | — | — | — | × | — | — | — | —(消费) |
| agent-tools(tools/mod.rs / subagent.rs / kill_subagent.rs) | — | — | — | ×(mod.rs+新文件) | — | — | ×(subagent.rs) | — |
| core_query_commands.rs | — | — | — | — | — | — | — | × |
| conex-types 测试面 ×4 + fixtures + changelog | — | — | — | — | ×(声明) | — | — | ×(实现) |

### 2.2 互斥冲突清单(详见 §5)

| # | 冲突 | 涉及文件 | 处置 |
|---|---|---|---|
| C1 | D1 ↔ D7 流中断标注双认领(严重) | stream.rs、consume/mod.rs、streaming.rs、engine.rs(:655-674) | 主控仲裁属主,未决前禁派该批 |
| C2 | D5 ↔ D8 事件登记改动面口径(严重) | events.rs 系 9 处 | 派单引用 D8 九处清单,防返工 |
| C3 | D5 ↔ D8 `?? 5` 单行双认领(中) | useStreamCallbacks.ts:661 | 定唯一属主 |
| C4 | recovery.rs 三写方(D2 指纹 / D7 history / D3 调用面)(中) | recovery.rs | 同文件串行;任务书注明「零改动」仅指 D3 自身 |
| C5 | D3 / D6 同改 run_restore 同函数(中) | core_run_commands.rs:2195-2254 | 串行或合并 |
| C6 | engine.rs 四写方(D1 连接配置 / D4 装配 / D6 装配 / D7 映射)(中) | engine.rs | 批内次序:先 D1,后 D4/D6/D7 |
| C7 | 事件总数 47 vs 49 口径(轻) | 00 总纲 / D5 / D8 | 统一 49(D8 D-1 已裁决) |

### 2.3 按 00 总纲 §7「同文件串行纪律」的派单分组

- **core_run_commands.rs 单写**(全期):任何时刻只有一个 Agent 持有该文件;改动面按依赖序 D1(D1 收口提取+熔断计数)→ D2(decide error 分支)→ D5(四源+发射)→ D3(装配+触发+restore)→ D4(命令壳)→ D6(watcher spawn+恢复条目+drain+空转)→ D7(采集+注入)。00 总纲 §7-3 已声明该纪律,维度文档也各自复述(如 D3 §7、D5 §7),**执行上唯一真正的瓶颈是此文件**。
- **stream_error.rs 单批**:仅 D1 触碰,同批一次改完(00 总纲 §4 同批约束),无并发风险。
- **events.rs 系单写**:仅 D8 实现(9 处),D5 只声明发射点不碰注册表;派 D8 事件簇为单写方。
- **hydrate.rs 单写**:归 D7(D8 只冻结契约不碰文件,两文档一致,D8 §3.4 边界说明)。
- **engine.rs 批内次序**:D1(轮 1)→ D4-②/D6-① 装配(轮 1 末段)→ D7 to_loop_event(轮 1,若标注仲裁归 D7)。
- **recovery.rs 串行**:D2 指纹函数(轮 1)→ D7 history 字段(轮 1/2)→ D3 仅调用面(轮 2);三者改动互不重叠但同一文件,派单时前后脚。

---

## 3. 工作量均衡与拆分建议

### 3.1 工作量排序(代码量 × 复杂度)

| 序 | 维度 | 量级 | 复杂度特征 |
|---|---|---|---|
| 1 | D5 | 最大(500-800) | 新算法 RoundAssessment 判定优先级 + 事件面 + 前端交互 |
| 2 | D4 | 最大(450-700) | 文件面最广(11)+ 新工具 + 双端四步登记 + wait 真适配 |
| 3 | D3 | 中偏大(400-600) | 复杂度最高:收口链时序、12/5/1 守卫、重启语义、F2-27 全表 |
| 4 | D8 | 中偏大(400-700) | 量大但机械(登记九处 + 前端组件) |
| 5 | D6 | 中偏大(400-600) | 新模块 watcher + 两 store 真适配 + 恢复条目 |
| 6 | D1 | 中(300-500) | 跨 crate 广但改动点明确(标注争议除外) |
| 7 | D2 | 最小(350-500) | 单点集中 |
| 8 | D7 | 最小(350-500) | 散布面大但单点小 |

### 3.2 拆分建议(两条,均为「按子域拆」而非砍范围)

**建议 1:D4 拆两单**(理由:D4 §1.1/§3.8 自证两子域文件域零重叠):
- **D4a 命令面/工具面**:lifecycle.rs(kill_subagent + prepare_resume 拆分)、main.rs、command_manifest.rs、commandManifest.ts、commandMap.ts、agent-tools(kill_subagent.rs + mod.rs)、core_run_commands.rs 命令壳(约 300-450 行);
- **D4b wait 真适配**:wait_channel.rs(LocalDbWaitStore)+ engine.rs 装配 + restore 验证(约 150-200 行)——**与 D6-① 同模式同先例(workflow_commands.rs:400-478 三段式)、同文件(engine.rs),建议合并为一个「session_meta store 真适配簇」Agent 执行**(D4 §3.8 与 D6 §3.1 是同模板的两份实例化)。

**建议 2:D8 拆三单**(00 总纲 §3 D8 行「事件面随 D3/D5、UI 面随 D4」自证横切,单次派发必然跨批等待):
- **D8a 事件登记+检索簇**:conex-types 9 处 + 生成产物 + parse_envelopes(轮 1,与 D3/D5 同批语义);
- **D8b UI 簇**:失败态卡片 + 恢复状态行 + goal 投影(随 D4 批次,轮 3);
- **D8c 口径簇**:AGENTS.md 两处 + `?? 5` 一行(可并入 D8b 或 D5,见严重项 3 的属主裁决)。

**不拆 D5 的理由**:goal_state 唯一写方 = 收口 RoundAssessment(00 总纲 §6 契约表),字段链/状态键/四源/事件是同一判定闭环;拆开会产生「第二写方」「事件发射与登记脱节」等二次接线,违反禁补丁纪律(00 总纲 §1.2-4)。D5 以「纯函数侧(轮 1,独立文件)+ 壳层侧(轮 1 同批,A 后接续)」分派,但不改变维度归属。

### 3.3 均衡性结论

8 维度量级集中在 350-800 行区间,无「15-30 行」微小维度;均衡问题不在维度间而在派单单元——**若按维度原样派单,D4/D8 会显著超出一个 Agent 的合理单量,而 D2/D7 相对偏小**。按 §3.2 拆分 + §6 轮次合并后,各派单单元收敛到 300-500 行区间,均衡可接受。

---

## 4. 任务书要素完备性(对照 01 敲定方案 §6 八要素)

| 维度 | 验收断言 | 现状基线 | 改动设计 | 数据面 | 测试策略 | 风险护栏 | 接口 | 动态决策 | 判定 |
|---|---|---|---|---|---|---|---|---|---|
| D1 | A1-A9(细化到测试写法) | §2 逐表 | §3 伪代码+签名 | §4 键/字段/事件 | §5 T1-T18 | §6 | §7 | D1-D10 | ✅ 齐备 |
| D2 | A1-A8 | §2 表 | §3 伪代码+形状 | §4 | §5 T1-T12+集成 | §6 | §7 | D2-1~10 | ✅ 齐备 |
| D3 | A1-A10 | §2 缺口表 | §3 伪代码 | §4 键/事件 | §5 T1-T7 | §6 | §7 | 1-11 | ✅ 齐备 |
| D4 | A1-A7 | §2 现状表 | §3 伪代码+四步 | §4 | §5 T1-T10 | §6 | §7 | D-1~8 | ✅ 齐备 |
| D5 | A1-A10 | §2 三层分裂 | §3 伪代码 | §4 键/事件/字段 | §5 U1-U12/I1-I10 | §6 | §7 | 1-10 | ✅ 齐备(**一处瑕疵**见下) |
| D6 | A1-A6 | §2 三断点 | §3 伪代码 | §4 | §5 各面 | §6 | §7 | 1-8 | ✅ 齐备 |
| D7 | A1-A6 | §2 缺口表 | §3 伪代码 | §4 冻结/变更面 | §5 T1-T9 | §6 | §7 | 1-9 | ✅ 齐备 |
| D8 | A1-A7 | §2 现状表 | §3 逐文件清单 | §4 事件/状态 | §5 | §6 | §7 | D-1~9 | ✅ 齐备 |

**结论:8/8 维度八要素齐备,无缺失要素的维度**——这是本轮文档质量的高分项。唯一瑕疵:

- **D5 §1.2 A8 事件登记「六处改动面」与实际不符**:D5 文档照抄 05 方案「六处」(events.rs 变体 / engine-events.json / V1_EVENT_TYPES+断言名 / fixtures / event_backpressure / changelog),而 D8 §0 结论 1 与 §3.1 实测为「**九处 + 生成产物**」——05 漏了 registry_drift.rs 三处断言、events_roundtrip.rs 穷举、event_hook_mapping.rs 划分断言。若按 D5 任务书派单,必漏改三处测试面 → `cargo test -p conex-types` 红 → 返工。**派单时 D5 的事件登记任务必须以 D8 九处清单为准,并建议 D5 文档 §1.2 A8 同步修订**(详见 §5 严重 2)。

---

## 5. 问题清单(按严重程度分组,每条附证据)

### 5.1 严重(未仲裁/未修订前禁派相关批次)

**S1 — D1↔D7 流中断结构化标注四文件双认领,两文档互相矛盾**
- 证据:D1 文档「3.5 流中断结构化标注」+「附:关键文件索引」将 stream.rs(build_message_metadata)、streaming.rs(:122-126 Stop 注入透传)、consume/mod.rs(标注镜像)列为 D1 改动面,验收 A9 断言标注;D7 文档「1.3 范围迁移一」单方面裁定「流中断标注的主体改动(consume/stream 两处镜像 + streaming.rs 透传 kind)归 D7;D1 只负责 RunOutcome.provider_error 数据面」,并在「3.7 流中断结构化标注」重复列同一批文件与 A6 验收断言。
- 影响:同一文件双写,D1/D7 各自的验收断言(A9/A6)完全重复,无法并行派单;D1 文档未随 D7 的迁移裁定做任何修订(D1 §4.2 数据面表、§7 接口表「D1 标注,D7/D8 消费」仍在)。
- 建议:D1 修订为「只做 provider_error 数据面」并将标注移交 D7(依据:00 总纲 D1 关键文件清单不含 stream.rs/consume,07 归属论证充分),或主控裁决标注归 D1 并让 D7 删除 §3.7。二选一,必须落笔到两份文档后才派单。

**S2 — D5 事件登记「六处」与 D8「九处」口径不一致,按 D5 派单必返工**
- 证据:D5 §1.2 A8「六处改动面一次改完」;D8 §0 结论 1「05 方案列出的『六处』漏了 registry_drift.rs 硬编码 41 断言、events_roundtrip.rs 穷举构造、event_hook_mapping.rs 划分断言三处测试面」+ §3.1 逐文件九处清单(events.rs / engine-events.json / events_schema_version.rs / fixtures ×8 / registry_drift.rs / events_roundtrip.rs / event_hook_mapping.rs / 33-changelog / 生成脚本)。
- 影响:D5 与 D8 同批登记(00 总纲 §4 集中登记纪律),若 D5 侧按「六处」执行而 D8 侧按「九处」执行,同一登记批次出现两套任务书口径,漏改即 CI 红。
- 建议:D8 §3.1 为登记派单的唯一条目清单;D5 §1.2 A8 修订为引用 D8 九处;事件登记实现统派给 D8a(轮 1 单写方),D5 只负责发射点。

### 5.2 中等(派单时需定序/定属主/拆单,不阻塞评审)

**M1 — D5↔D8 对 useStreamCallbacks.ts:661 `?? 5` 修正双认领**
- 证据:D5 §1.2 A5「前端发 /goal → 引擎 goal_state.max_rounds == 12(消除 useStreamCallbacks.ts:661 ?? 5 分叉)」+ §7 接口表「前端 ?? 5 修正 | D5(投影轮)」;D8 §1.1 ⑥「前端 ?? 5 分叉统一为 12」+ §3.6 改动落点同一行 + 验收 A7。00 总纲 D5 关键文件已含 crish-desktop(useStreamCallbacks.ts)。
- 影响:一行改动双属主,若两 Agent 都改,提交冲突概率低(幂等)但职责不清。
- 建议:按 00 总纲关键文件归属,**属主定为 D5(投影轮)**;D8 ⑥ 标注为「验收项」而非实现项,或主控倒过来(D8 做,D5 只验收)。必须明确单属主。

**M2 — recovery.rs 三写方与「recovery.rs 零改动」表述并存**
- 证据:D2 §3.6「recovery.rs 新增 fingerprint_with_source(既有两参保持)」;D7 §1.3 冲突声明 3 + §3.4 在 recovery.rs:757-780 增 history 字段并在 fork_and_reassign(:1115)透传;D3 §2.1/§附「recovery.rs 零改动(纯装配)」。三份文档各自做了「零改动精确含义」声明(D2 §1.3、D7 §8 决策 6),逻辑自洽,但任务书层面同一文件三个写方。
- 影响:派单需对 recovery.rs 串行(指纹 → history → D3 调用面);若主控按「D3 零改动」字面理解而把 D3 与 D2/D7 并行派,产生文件冲突。
- 建议:任务书明确 recovery.rs 的串行次序(轮 1 D2 指纹、轮 1 D7 字段、轮 2 D3 调用),D3 的「零改动」限定语扩写为「D3 自身不改 recovery.rs」。

**M3 — run_restore 同函数双改(D3 树重建+通知重排 vs D6 恢复条目)**
- 证据:D3 §3.3 在 run_restore 成功分支「:2227 状态回写之后、:2236 返回之前」插入树重建+重排;D6 §3.3 在「run_restore 成功路径(:2201-2236)末尾、save_snapshot_now(:2213)之后、返回前」插入恢复条目生成。D3 §7 接口表已注明「core_run_commands.rs:2195-2254 同批文件域(按文件互斥派单)」。
- 影响:同一函数两个维度写,派单串行;若顺序颠倒(先 D6 后 D3),D6 的插入点在 :2213 后、D3 在 :2227 后,行号漂移,但均在同一函数内,协调成本低。
- 建议:D3 先、D6 后(树/协调器先就位,恢复条目消费方才完整);或两处合并给同一 Agent 一次改完(同函数,推荐)。

**M4 — D7 树访问器双轨:实现方式取决于 D3 是否已落地,00 总纲 DAG 未列 D3→D7 依赖**
- 证据:D7 §8 决策 1「基线自洽路径:经 state.sessions 快照注册表临时重建…D3 的 session_trees 表落地后切换共享实例(同函数体,一行访问器差异)」。00 总纲 §4 只列 D6→D7,未列 D3→D7;但 D7 的收口采集区(:2718/:2729)与 D3 触发区(:2844)同函数,且 D7 §7 接口表「D3 装配 ctx,本维度定字段」表明 history 填充点在 D3 壳层代码。
- 影响:若 D7 派在 D3 前,实现者用基线路径,D3 落地后要切换(虽声明一行差异,仍是二次接触);若派在 D3 后,用共享实例,省切换。
- 建议:任务书把 D7 壳层面排在 D3 之后(软依赖 D3→D7),同时 D7 的独立面(水合/标注/字段定义)不受此约束,可先行。

**M5 — D6 验收 A6 跨维度测试依赖 D5 空转语义**
- 证据:D6 §5.5 测试 `goal_round_no_output_counts`「goal 续轮(有注入文本)无产出 → 计入 streak(D5 域边界,本维度测试锚定不误伤)」;D6 §3.5 语义边界引用裁决 #21 第二分支「goal 续轮无产出计入空转且按 stalled 独立计数」——该计数行为由 D5 实现(00 总纲 §5 护栏 4、D5 §3.4)。
- 影响:D6 的空注入计数测试要等 D5 落地才能全绿,或至少需要 D5 的四源分支先接线。
- 建议:D6-② 与 D5 壳层面同批或 D5 先行;任务书标注该测试为「跨维度验收,以 D5 落地为前提」。

### 5.3 轻微(一致性/表述,随修订顺带解决)

**L1 — 事件总数口径 47 vs 49 未统一**
- 证据:00 总纲 §3 D8 行与 D5 §1.2 A8 保留「41→47/49」双口径;D8 D-1 已裁决为 49(8 事件全登,「47」是 05 方案未计入 goal-round-* 时的下限)。敲定 §2.2 表列全 8 事件。
- 建议:00 总纲 D8 行、D5 A8 统一改为 49。

**L2 — D1 附:关键文件索引未随标注归属修订**
- 证据:D1「附:关键文件索引」仍列 stream.rs/streaming.rs/consume/mod.rs 为 D1 改动面;D1 §4.2 数据面表也含 metadata 两字段。
- 建议:S1 仲裁落定后同步修订 D1 文件索引与数据面表。

**L3 — D1 A9 与 D7 A6 验收断言重复**
- 证据:D1 §1.2 A9「流中断标注:部分保留消息 metadata 含 kind=Network 且消息正常 commit」与 D7 §1.2 A6「流中断结构化标注」同一语义同一测试锚点(text_then_error_stop_yields_message 扩展)。
- 建议:随 S1 归属仲裁合并为单份验收。

---

## 6. 推荐派单方案

> 依据:00 总纲 §4 依赖 DAG + §7 轮次规则(每轮 ≤12、不强制占满、同文件串行)+ §3.2 拆分建议。核心原则:**core_run_commands.rs 全期单写;各维度「独立面」先行并行,「壳层面」按依赖串行**。

### 轮 1「核心同批簇 + 独立面」(5 个 Agent)

| Agent | 任务(派单单元) | 文件域(互斥声明) | 依赖 |
|---|---|---|---|
| A1 | **D1+D2+D5 壳层一体化**:stream_error.rs 单批(退避/熔断闸/provider_error 填充)+ end.rs 字段 + converge 移交 + core_run_commands 收口提取/熔断计数 + decide_idle_resume :2513 区 error 分支(D2)+ goal_pending 四源(D5)+ spawn_idle_resume_run mode 参数化 + build_http_client(engine.rs) | stream_error.rs 单写;core_run_commands.rs 本批首写;engine.rs 首改(连接配置) | 00 总纲 §4 同批约束(D1+D2、D2+D5 同区)的最忠实落地 |
| A2 | **D5 纯函数侧**:orchestrator 新模块 goal_state.rs + RoundAssessment 纯函数 + normalize.rs allows_auto_continue 首个生产调用 + 单测 U1-U12 | orchestrator 域(独立),不碰 core_run_commands | 无(与 A1 并行) |
| A3 | **D8a 事件登记+检索簇**:conex-types 九处(events.rs 8 变体 / engine-events.json / 4 测试面 / fixtures ×8 / changelog 1.9)+ 生成产物 + parse_envelopes 合成 + 检索单测 | conex-types 全家 + core_query_commands.rs 单写 | 载荷字段以 D8 §3.1.1 冻结表为准,不依赖发射点完成 |
| A4 | **store 真适配簇(D4b+D6-①)**:LocalDbWaitStore(wait_channel.rs)+ LocalDbTimerStore/SchedStore(timers.rs/sched.rs)+ engine.rs 装配替换与 new_with_spawner 扩参 | wait_channel/timers/sched 单写;engine.rs 待 A1 完成连接配置后接续(批内次序) | 无;同模式三段式一次完成 |
| A5 | **D7 独立面**:hydrate.rs 水合放行 + failed-turn 标记、consume/mod.rs + stream.rs + streaming.rs 流中断标注、RunFailureContext.history 字段与 SubagentSpawnRequest.history(recovery.rs/subagent.rs/subagent_spawner.rs/lifecycle.rs)、safe_point 调用面测试 | hydrate.rs/标注三文件单写;recovery.rs 本批次写(序于 D2 指纹之后) | **前置:S1 仲裁(标注属主)+ D1 修订**;字段面不依赖壳层 |

轮 1 文件互斥校验:core_run_commands.rs 仅 A1;engine.rs 次序 A1→A4;recovery.rs 仅 A5(与 D2 指纹同批,先后脚);events.rs 系仅 A3;hydrate.rs 仅 A5。无并行冲突。Agent 数 5 ≤ 12。

### 轮 2「恢复执行面」(4 个 Agent,core_run_commands.rs 串行链)

| Agent | 任务 | 文件域(互斥声明) | 依赖 |
|---|---|---|---|
| A6 | **D3 全部**:CoreRunState 两字段 + coordinator_for + 收口触发(RunFailureContext 还原 + 收口后重派)+ blocking_coordinator_call + ladder1 计数 + run_restore 树重建与通知重排 + 接线测试 T1-T7 | core_run_commands.rs 首写(轮 2);recovery.rs 仅调用面 | 轮 1 完成(provider_error 提取点);**C5:run_restore 树重建先于 D6 条目** |
| A7 | **D4a 命令面/工具面**:kill_subagent(lifecycle.rs)+ prepare_resume 拆分 + 三命令壳 + 删 :2106 dead_code 豁免 + 双端四步登记 + kill_subagent 工具 + 主 agent 注册/子代理剔除 | lifecycle.rs/main.rs/manifest 三件套/agent-tools 与 A6 并行;core_run_commands 命令壳待 A6 完成后接续 | A6(coordinator_for);轮 1 D4b 无关 |
| A8 | **D6-②③**:wake_watcher 新模块 + 会话 spawn + user_stopped 标记 + run_restore 恢复条目 + drain 合并上限 + 空转计数 | 新模块独立;core_run_commands.rs 待 A6/A7 完成后接续 | D6-①(轮 1 A4);**C5:恢复条目在 A6 树重建之后**;M5:空转计数测试依赖 D5(轮 1 已落) |
| A9 | **D7 壳层面**:收口采集 + with_session_tree + 拉起器 checkpoint 注入 + ctx.history 填充 | core_run_commands.rs 末位接续 | D3(A6,树实例 + ctx 构造点);D2 拉起器(轮 1) |

轮 2 文件互斥校验:core_run_commands.rs 串行 A6→A7→A8→A9(四个阶段,各自完成后提交再移交);recovery.rs 仅 A6 调用面;其余文件域互斥。Agent 数 4 ≤ 12。**轮 2 的实际并行度有限(主要靠 A7 非壳层面与 A6 并行),如需缩短轮次,可考虑将 A6/A7/A8/A9 壳层面按前后脚由两两接力完成,不强制四 Agent 并行。**

### 轮 3「观测收尾 + 门禁」(2 个 Agent)

| Agent | 任务 | 依赖 |
|---|---|---|
| A10 | **D8b UI 簇 + D8c 口径簇**:失败态卡片 + 恢复状态行 + goal 前端投影 + `?? 5`(若 M1 裁决归 D8)+ AGENTS.md 两处 | D4 命令登记(轮 2)、D5 事件发射与 goal_state(轮 1) |
| A11 | **全量门禁回归 + 跨维度端到端**:cargo test --workspace(73 套件)+ conex-types registry_drift 绿 + 前端 typecheck/vitest + D8 A2 检索端到端 + markdown-editor 门禁 + 5 个专项 spec | 全部前置落地 |

### 派单总则(主控派单时逐条核对)

1. 每轮 ≤12、不强制占满(本方案 5/4/2,共 11 Agent 次)。
2. core_run_commands.rs 全期单写,移交前 `git add` 提交并明确交接行号区。
3. engine.rs 批内次序:A1(轮 1)→ A4(轮 1)→ A7(轮 2,若触碰)。
4. recovery.rs 次序:轮 1 A5 内(D2 指纹 → D7 history)→ 轮 2 A6 仅调用面。
5. 事件登记只由 A3 实现(D8 九处清单为唯一条目);D5/D3 只做发射点,不碰注册表。
6. **S1 未仲裁前,A5 与 A1 均不得触碰 stream.rs/consume/mod.rs/streaming.rs 标注面**(A1 的 D1 面缩减为数据面 + 退避 + 熔断 + 连接配置,可先行)。
7. 子 Agent 空回时按 AGENTS.md 空返回无限重派纪律处理(先核查落盘,未落盘原样重派)。

---

## 附:证据索引

| 结论 | 证据位置 |
|---|---|
| 粒度无过小、D4/D8 过大 | 01-敲定方案.md §1 裁决 #15(工具 100-200 行)、D4 §3.2/§3.3/§3.8(子域)、D8 §0/§1.1(三簇)、D5 §3.3(核心纯函数) |
| D5 不拆理由 | 00-总纲 §5-12(数据面纪律)、00-总纲 §6(goal_state 唯一写方)、D5 §3.2 |
| S1 标注冲突 | D1 §3.5/§4.2/§7/附:文件索引 vs D7 §1.3 范围迁移一/§3.7/§1.2 A6;00-总纲 §3 D1 行 ⑤ |
| S2 六处 vs 九处 | D5 §1.2 A8 vs D8 §0 结论 1/§3.1/D-4 |
| M1 ?? 5 双认领 | D5 §1.2 A5/§7 vs D8 §1.1 ⑥/§3.6/§1.2 A7;00-总纲 §3 D5 行 |
| M2 recovery.rs 三写方 | D2 §1.3/§3.6 vs D7 §1.3 声明 3/§3.4 vs D3 §2.1/§附 |
| M3 run_restore 双改 | D3 §3.3 vs D6 §3.3;D3 §7 接口表 |
| M4 树访问器双轨 | D7 §8 决策 1;00-总纲 §4(DAG 无 D3→D7) |
| M5 跨维度测试依赖 | D6 §5.5 `goal_round_no_output_counts`、D6 §3.5;01-敲定 #21 |
| L1 47/49 | 00-总纲 §3 D8 行、D5 §1.2 A8 vs D8 D-1 |
| 派单依赖与同批约束 | 00-总纲 §4(DAG/并行集/同批)、§7(轮次与同文件串行)、01-敲定方案 §3(接线时序 1-6) |
| 要素完备性对照 | 01-敲定方案 §6(八要素清单) |

> 本文档为只读评审产出(唯一写面 = 本文件);未修改任何代码、未执行任何 git 操作。
