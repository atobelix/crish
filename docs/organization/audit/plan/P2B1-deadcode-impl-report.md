# P2 批 1 实现报告——死代码与未接线面清理（审计 P2 类）

- 执行日期：2026-08-08
- 执行角色：实现员（P2 批 1）
- 遵守：`00-EXECUTION-CODE-OF-CONDUCT.md`（红绿纪律 / 禁止清单 / 实跑报告义务 / 诚实边界）
- 执行期并发：P2 批 2 / 批 4 / 批 5 / 批 6 并行在飞（提交 4f8e0dc9、20db524d、83f3ed84、d47e16f1 等），多处重叠与让渡见 §5。

---

## 一、执行总览

| 项 | 判定 | 处置 |
| --- | --- | --- |
| 死代码删除 | 6 项真死 → 删除 | 提交 ca70da84 / 9b52c754 / e4be5cfe |
| 未接线面 | 2 项可接线（C7、deadlock detector）→ 评估为依赖引擎侧缺失基础设施，**不硬接** → 注释待接 + 登记 | 提交 8c831309 + F-017/F-018 |
| 未接线面 | 1 项小接线（F8-23 batcher signal）→ 完成（红绿两段） | 提交 da275519 / 4c79cea4 |
| 死 CSS | 3 个 module.css 真死 → 删除；tool-calls.css 已不存在（旧架构已删） | 提交 e4be5cfe |
| knip 长尾 | 597 项未用导出 → 本批只清理审计直接相关项（3 项），其余 590+ 登记长尾 | F-020 |
| 存疑 | F3-02 with_idempotency（审计断言过时，存在测试消费）→ 保留 | F-021 |

## 二、逐项明细（来源 F 编号 | 判定 | 证据 | 产出 | 验证输出）

### 1. F1-报告 F3-04：`escape_watch_config()` getter（loop/mod.rs:556-566）

- **判定**：真死（生产零消费，注释自认「生产零消费现状保持」，唯一消费 = mod.rs 测试 :1397）
- **证据**：`rg escape_watch_config crates/` → 仅定义处 + 测试一处；壳层经 `spawn_escape_watch` 自身构造配置（escape_watch.rs:17-24），不依赖 getter
- **产出**：删除 getter；测试改 `loop_.state.options.escape_watch.clone()` 直读（同模块子测试可访问私有字段）
- **验证**：`cargo test -p session-loop escape` → 13 passed / 0 failed；`cargo check --workspace` EXIT=0

### 2. F1-报告 F3-05：`StreamResult` 类型别名（provider.rs:49 + lib.rs:82 re-export）

- **判定**：真死（全仓零消费，含测试与下游 crate）
- **证据**：`rg StreamResult` → 仅 provider.rs 定义 + lib.rs re-export，无任何引用方
- **产出**：删除别名与 re-export
- **验证**：`cargo check --workspace` EXIT=0；session-loop 321 passed（全量绿，见 §3）

### 3. F1-报告 F3-06：`SteeringPhase::AfterCompaction` 占位变体（steering/mod.rs:58-60）

- **判定**：真死（上下文压缩能力已删除 T06.2.3 → 无评估点、无策略消费、无产生路径；serde 侧 Rust 永不发射该 wire 值，TS 侧无对应引用）
- **证据**：`rg AfterCompaction` → 仅定义处；strategy.rs `phases()` 恒返回 AfterTools/EmptyResponse；`evaluate` 有 `_ => None` 兜底不需改
- **产出**：删除变体；`BeforeTurn` 保留 + 补「待接：依赖未来 GoalAudit 策略」标注（有评估点无策略，与 T06.3 Q12 一致）
- **验证**：`cargo check --workspace` EXIT=0；session-loop 321 passed

### 4. F1-报告 F3-03：`CacheStatsTracker::set_ttl`（cache_tracker.rs:145）

- **判定**：预留接口（全 crate 零消费，T-40 接线点未到）——非删除项
- **产出**：补「**待接**（F1 审计 F3-03）：T-40 跨 run 缓存基线持久化落地后由 engine 侧调用」注释
- **验证**：`cargo check --workspace` EXIT=0

### 5. F1-报告 F3-08：`ProviderRequest.session_id: None`（streaming.rs:306）

- **判定**：T-17 未接线占位（缓存键不含会话维度）——非删除项
- **产出**：补「**待接**（F1 审计 F3-08）：T-17 落地前该字段恒 None」注释（原注释已含 T-17 归属）
- **验证**：`cargo check --workspace` EXIT=0

### 6. F1-报告 F3-02：`with_idempotency`（tool_exec.rs:212）——**存疑**

- **判定**：**存疑（审计断言与现状不符）**——F1 报告称「grep 确认无任何测试调用」，实测存在测试消费
- **证据**：`crates/session-loop/tests/e01_multi_replace_integration.rs:308` `ToolExecutor::new(...).with_idempotency(guard)`
- **产出**：不改代码（按规则「不能确证 → 存疑跳过」）；登记 F-021
- **验证**：e01_multi_replace_integration 4 passed（§3 全量）

### 7. F1-报告 F3-07 / F3-09：`should_stop_after_turn`、`end_reason`/`write_inject_messages`/`ring_for_kind`

- **判定**：保留。F3-07 字段在 turn_complete.rs:157 有完整消费逻辑（设计扩展点，无注入方即无行为）；F3-09 三项已 `#[cfg(test)]` 标注（测试专用，生产不编译）
- **证据**：`rg should_stop_after_turn` → 定义 + 消费（turn_complete.rs:157）+ 测试断言；safe_point.rs:105/161/195 已 cfg(test)
- **产出**：无改动

### 8. F2-08：C7 恢复阶梯生产未接线（recovery.rs）——**无法接线，登记待接**

- **判定**：无法接线（依赖引擎侧缺失基础设施，非本批可硬接）
- **证据**：`rg RecoveryCoordinator apps/agent-workbench/src-tauri/src` → 零引用；`rg on_subagent_run_failure` → 仅 recovery.rs 自身与 tests；接线需 ① 每会话 RecoveryCoordinator 生命周期（RecoveryStore 适配 + SessionTree 装配 + SubagentSpawnerImpl 复用）② provider 流错误分类钩子 ③ F2-27 要求的 spawn_blocking（RecoveryStore 为同步 SQLite trait）。multi_agent.rs 注释自述「I6 遗留 L1–L3 登记」、task_event_consumer.rs「C7 与阶梯 2 衔接留 v2 登记」
- **产出**：recovery.rs 模块头补「**待接（F2 审计 F2-08）**」标注（含接线清单）；登记 F-017
- **验证**：`cargo check --workspace` EXIT=0

### 9. F9-05：死锁防护 detector 生产未接线（core_run_commands.rs:2806）——**无法接线，登记待接**

- **判定**：无法接线（detector 信号源 = orchestrator 子代理跟踪器 await 态标记，引擎无该跟踪器）
- **证据**：`with_deadlock_detector`（core_run_commands.rs:210-216）仅测试 helper 注入；生产构造点 :2806 无注入；approval_router.rs:41-45 自述「F11 T-D-13 引擎接线落地——未落地」；全仓 grep 无 wait_subagents await 态登记面（subagent_wait_channel 恒 None）；PS-04 任务书已将该域列为「不修邻域登记项」
- **产出**：生产构造点补「F9-05 待接」注释（缺省 None = 120s 超时兜底，行为与现状一致）；登记 F-018
- **验证**：`cargo check --workspace` EXIT=0

### 10. F5-05/F5-06：StreamRenderBuffer 拆帧死代码——**重叠让渡给 P2 批 5**

- **判定**：真死（类方法 flushFrame 的「batch.length===0 拆块」分支不可达；与纯函数双实现漂移）——**红测试已存在且实测红**（framing.test.ts:88-110，提交 58ebaa93 入库；实测 `expected 1 to be greater than 1`）
- **处置**：执行期发现并行 P2 批 5 正在修复同一文件（83f3ed84 绿提交已入库：委托纯函数拆帧）。按同文件冲突让渡原则不重复修改；登记 F-022
- **验证**（对方产出）：`npx vitest run StreamRenderBuffer.framing.test.ts` → **13 passed**（含单块超限拆帧用例）

### 11. F5-12：EventRouter sequence 死游标（EventRouter.ts:64-66, 42, 106-108）

- **判定**：真死（`getLastAppliedSequence()` 全仓零调用；`lastAppliedSequence` 字段仅被死 getter 读取）
- **证据**：`rg getLastAppliedSequence` → 仅定义处（含测试）；`extractEventSequence` 仍被 chatBridge.ts:23 消费，保留
- **产出**：删除 getter + 字段 + sequence 提取块；补顺序契约注释（引擎单通道保证顺序，前端不校验；03 §5.3-6 Delta 可丢 message-end 必达）；文件头注释同步
- **验证**：`npx vitest run EventRouter.test.ts EventRouter.terminal.test.ts` → **28/28 passed**；`tsc` EXIT=0

### 12. F5-15/F5-16：chatApi.ts 死 API 与过时注释（chatApi.ts:1-70）

- **判定**：真死（knip 证据）
- **证据**：`npx knip` Unused exports 列出 fetchSessionsApi / saveMessageToDb / withdrawMessageFromDb；实现为「读全量→改一条→全量写」热路径陷阱（F5-16 明确建议删除）；头部注释描述已随 C3.1/C3.4 删除的 daemon WS/directFetch 决策树（F5-15）
- **产出**：删除三个死 API + 随之未用的 import；头部注释重写为 C3.1 单通道终态
- **验证**：`tsc` EXIT=0；knip unused exports 597 → 592（本批删 3 + 并行批删 2）

### 13. 死 CSS：tool-calls.css 与三个孤立 module.css

- **判定**：tool-calls.css **已不存在**（旧架构 index.html 时代遗留，新 React 架构已移除——全仓 glob 无该文件，`@import` 链全部命中现存文件）；三个 module.css 真死
- **证据**：84 个 *.module.css 逐一 grep 引用 → `QuickOpen.module.css`（组件已删，仅 quickOpenHelpers.ts 残留）、`SettingsAppearanceTab.module.css`（组件不 import 任何 CSS）、`SettingsPersonalizeTab.module.css`（同上）零引用
- **产出**：删除三个文件（243 行）
- **验证**：`tsc` EXIT=0；`git diff --check` 干净

### 14. F8-23：JsonlAppendBatcher signal 未接线（jsonl-append-batcher.ts:50-51, 68-81）——**接线完成**

- **判定**：可接线（小件：signal 存储后从未使用）
- **证据**：构造器只存 `options.signal`，无 abort 监听；close() 不取消计时器不处理 signal；P2 批 5 的 F8-03 修复后该文件已稳定
- **产出**：红测试（da275519）——abort 后 pending 不落盘（红：`1 failed / 7 passed`，pendingRecords 断言失败）；绿修复（4c79cea4）——构造器挂 `{ once: true }` abort 监听：`doFlush().then(() => this.close())`，abort 即收口不丢 pending
- **验证**：`npx vitest run jsonl-append-batcher.test.ts + adversarial.test.ts` → **11/11 passed**

### 15. F8-17：logger 脱敏钩子 setLogRedactor 零接线（logger.ts:30-36）

- **判定**：预留接口（全仓零调用，仅 barrel re-export）——非删除项（安全相关面，删除即丧失脱敏入口）
- **产出**：登记 F-019（待接：依赖产品级脱敏规则决策 + meta 逐字段脱敏改造）
- **验证**：无代码改动

### 16. F8-05：assertPathWithinPluginDir 生产零调用（P1 安全项）

- **判定**：不在本批（remediation plan 排期「P1 随插件面迭代」；本批为 P2 类死代码/未接线）
- **产出**：报告说明，未改动

## 三、验证输出（实跑）

| 命令 | 输出 | EXIT |
| --- | --- | --- |
| `cargo check --workspace` | `Finished dev profile`（多轮实跑） | 0 |
| `cargo test --workspace` | 87 个套件全绿（session-loop 321、agent-provider 506+、agent-tools 515 等；`test result:` 全部 `0 failed`） | 0 |
| `npx tsc --noEmit -p apps/crish-desktop/tsconfig.json` | 无输出 | 0 |
| `npx knip` | Unused exports 592（warn）/ Duplicate exports 5 / 无 error 级 | 0 |
| `npx vitest run EventRouter*.test.ts` | 28/28 passed | 0 |
| `npx vitest run StreamRenderBuffer.framing.test.ts`（对方绿验证） | 13/13 passed | 0 |
| `npx vitest run jsonl-append-batcher*.test.ts` | 11/11 passed（8+3） | 0 |
| `cargo test -p session-loop escape` | 13/13 passed | 0 |

红→绿证据：
- F8-23：红提交 da275519（`Tests 1 failed | 7 passed`，断言行 `expect(batcher.pendingRecords).toBe(0)` 失败）→ 绿提交 4c79cea4（11/11 passed）
- F5-05：红测试在 git 历史（58ebaa93，实测红 `expected 1 to be greater than 1`，2026-08-08 13:53 实跑）→ 绿修复由并行 P2 批 5 入库（83f3ed84，framing 13/13）

回归范围说明：`cargo test --workspace` 全量在树稳定窗口采集（并行批红测试入库期间有 7 项红为对方红测试，随对方绿提交转绿；最终全量 87 套件 0 failed）。

## 四、提交清单（git log 可核）

| 提交 | 内容 | 类型 |
| --- | --- | --- |
| ca70da84 | Rust 死代码删除：escape_watch_config（F3-04）/ StreamResult（F3-05）/ AfterCompaction（F3-06） | 死代码删除 |
| 8c831309 | 待接标注：C7（F2-08）/ deadlock detector（F9-05）/ set_ttl（F3-03）/ session_id（F3-08） | 未接线面登记 |
| 9b52c754 | 前端死代码：EventRouter 游标（F5-12）/ chatApi 死 API（F5-16）+ 注释（F5-15） | 死代码删除 |
| e4be5cfe | 死 CSS 删除 × 3 | 死代码删除 |
| da275519 | F8-23 红测试 | 红 |
| 4c79cea4 | F8-23 接线修复 | 绿 |
| （吸收）ef53fdbc | 99-EXECUTION-FINDINGS.md F-017~F-022 被并行批整文件暂存吸收（F-004/F-011 先例），内容已入库 | 登记 |

## 五、诚实边界与并发记录

1. **并行批重叠与让渡**：执行期发现 P2 批 2/4/5/6 并行在飞。重叠项（F5-05/06 StreamRenderBuffer、F1-03/F2-01/F2-02 session-loop 溢出、F8-02/F8-03）让渡给对应批次，本批不重复修改（登记 F-022）。让渡后对方绿提交已入库（d47e16f1、83f3ed84）。
2. **findings 吸收**：本批 F-017~F-022 登记被并行 P2 批 5 提交 ef53fdbc 整文件吸收（git show ef53fdbc 含全部条目），内容无损。
3. **文件交错**：streaming.rs / core_run_commands.rs 与并行批共用，本批改动采用「临时副本 → checkout → 仅重放本批 hunk → 提交 → 恢复合并态」外科式提交，未吞对方在途改动。
4. **knip 长尾未清**：592 项未用导出登记长尾（F-020），逐项删除需独立收敛批次（grep/typecheck/knip 三重复核 + barrel 透传/类型导出风险）。
5. **未跑**：`npm run test:e2e`（Playwright）——本批无 e2e 面改动，且 5173/5174 本地端口被并行会话占用（F-015 先例）；相关 jsdom 单测已全绿。
6. **F8-23 红线规避说明**：abort 监听为 `{ once: true }`，无监听器泄漏；`doFlush()` 与 `close()` 幂等叠加，close 后 append 抛错语义不变。
