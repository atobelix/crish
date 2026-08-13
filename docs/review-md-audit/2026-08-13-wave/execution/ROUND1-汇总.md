# 轮 1 汇总 · 2026-08-13-wave 修复战役（先行不变量 + 无依赖小修）

| 元数据            | 值                                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **轮次**          | 执行轮 1（R3-1）· 按 `plans/00-执行方案定稿.md` §四 轮 1                                                                               |
| **派单**          | 9 单元（合单后 9 槽）· 全部完成                                                                                                        |
| **提交**          | 8 个提交（见下表）· 主控统一 `git commit --only`                                                                                       |
| **HEAD**          | `f467f04a`                                                                                                                             |
| **子 Agent 异常** | CT-03+04 首次返回缺最终消息（代码已落盘）→ 主控核查确认完成 + 修复其遗留的 storeAccess.ts 类型错误（LayoutStore→SettingsStore 误改回） |

---

## 一、单元完成状态

| 单元           | 内容                                                                                                                                                      | 验证结果（真跑）                                                                             | 提交       |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------- |
| **G-00+CT-05** | 门禁双口径快照（crate-size FAIL 88 / line-counts HARD 4+VIOL 9 / depcruise 3 error）+ 责任域登记表（88 项三分类）+ CT-05 保真复验清单（17 钉测）          | 脚本全真跑；快照基线落盘                                                                     | `6aad4c0e` |
| **CONN-00+05** | R-EL 硬门 7 条可 grep 否决清单 + D×G2′ 抽检（commit 实为 d0822a56 非转引 c323c839，已登记）                                                               | not-claimed 锚 6 处生产 + 29 测断言行确认在库                                                | `6aad4c0e` |
| **CT-03+04**   | depcruise 3 违规改走 storeAccess（补 session 只读面 getSessionById）+ intentBridge:202 诚实句 + structureIntents 分层边界头注释                           | depcruise **0 error** + typecheck 全绿（主控修复 storeAccess 类型后）                        | `dddced9f` |
| **CT-02**      | 3 个 BOM 文件字节级去 BOM（ttfb_measure / multi_agent / strategy.rs，逐字节等价）                                                                         | agent-provider 536+12 / orchestrator 230+12 全绿；session-loop steering 42/42                | `0ee39263` |
| **S5**         | streaming.rs session_id 占位接线（注入真实值）+ RequestSnapshot 补字段 + 契约测钉                                                                         | run_loop 32/32 + 新测钉 1/1；`rg "session_id: None"` streaming.rs 零命中                     | `59852b03` |
| **S1+S4**      | 批写降级可感知化（setPersistenceStatus warning/healthy 接线 + logInternalError 进 errorStore/telemetry + RuntimePanel 降级徽标）+ bootstrap 空 catch 收口 | vitest 29/29 + 回归组 136/136；吞错基线 1→0；既有闭环测 :922-1002 核验绿                     | `dd643ef1` |
| **CONN-02**    | C2′/C-prod PaperList 产品默开（策略常量经宿主显式传参，组件默认 false 保持）                                                                              | conn_c2_prod_* 3/3 + 既有 conn_c2_* 不回退；workspace 域 295 测全绿；line-counts 未新增 HARD | `cf0c0c5a` |
| **B1-3**       | note_memory 家族 12 处毒丸观测化（error! 成对 + 每文件 AtomicU64 计数）+ 4 毒化测                                                                         | agent-tools 721+14 全绿；rg 12/12 全部带 error!+计数                                         | `1c2a2f72` |
| **B1-4+B1-6**  | explore_quota 生产 4 处 + telemetry file.rs 毒丸观测化（保留 error_reported 去重）+ 3 毒化测                                                              | agent-tools 720+14 / telemetry 94+9 全绿；parallel_writes 不回退                             | `f467f04a` |

## 二、主控介入记录

1. **CT-03 遗留类型错误**：Agent 把 `storeAccess.ts:159 selectSettingsActiveTab` 的 `Pick<LayoutStore,...>` 误改为 `Pick<SettingsStore,...>`（settingsActiveTab 属布局域）→ 主控精确 edit 改回 → typecheck exit 0。
2. **S1 遗留 lint**：`sessionRustDbWriteModel.test.ts:672/:703` 未使用 `db` 变量（eslint no-unused-vars 2 errors 阻塞 pre-commit）→ 主控精确 edit 移除 → 提交通过。
3. **并行域测试失败归属**：session-loop lib 15 failed（stream_error/handlers/invariants/summary_dispatch 域）——涉及文件 conex-compaction/lib.rs、handlers/mod.rs、summary_coordinator.rs 均为**并行 Agent 工作区 M 状态**，归并行域中间态，非本战役回归（S5 域 run_loop 32/32 全绿佐证）；收口轮复核。

## 三、快照基线关键数字（G-00 · 轮 1 权威）

- crate-size：超限 154 / 登记 66 / **FAIL 88**（core_run_commands 17510 仍豁免盲区）
- line-counts：Scanned 739 / **HARD 4**（eventParser 958 并行域 / noteApi 704 / BrowserImportSection 751 / useStreamCallbacks 945）/ **VIOL 9** / Baselined 47
- depcruise：**3 error → 轮 1 后 0 error**（CT-03 已修）✅
- git status：101 条（60 M + 41 ??，并行域在途）

## 四、下一轮（轮 2 · 门禁根因 + 结构首刀）

按定稿 §四 轮 2：G-01（crate-size 语义硬化）/ G-03a（noteApi 拆分）/ G-03b（BrowserImportSection 拆分）/ G-03d（VIOL 处置）/ G-05A（index.html 内联外链化）/ SR-06a×2（agent-tools 巨石）/ SR-06c（session-loop）/ CONN-01（真 WebView e2e 基建）。

_2026-08-13 · 主 Agent · 轮 1 收口 · 全部单元完成并提交_
