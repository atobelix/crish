# 00 · 汇总索引 · review.md 全维度审计 + 修复战役（2026-08-13-wave）

> **终版**：本文件已更新为战役收口状态（2026-08-14）。完整收口汇总见 `execution/ROUND8-收口汇总.md`。

| 元数据         | 值                                                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **轮次**       | R1 审计轮（7 维度并行）→ R2 方案轮 → R3-1…8 执行轮 · 内部审计模式（仅针对 `docs/agent-roles/review/review.md`，不参考外部） |
| **日期**       | 2026-08-13 — 2026-08-14                                                                                                     |
| **HEAD**       | `fbc62326`（收口终态；工作区剩余 125 项为并行域在途，不属本战役）                                                           |
| **产出目录**   | `docs/review-md-audit/2026-08-13-wave/`（audit/ + plans/ + execution/）                                                     |
| **审计 Agent** | 7 个（①a 目的性 / ①b 结构 / ①c 连通 / 并发锁性能 / 错误可观测 / 安全构建 / 测试契约）                                       |
| **执行**       | 8 轮 60+ 子 Agent 任务 · ~50 提交 · 主控统一 `git commit --only`                                                            |
| **MSVC**       | 按用户指示重装（VS Build Tools 17.14 → `D:\BuildTools`），全量 cargo test 真跑验证恢复                                      |

---

## 〇、战役结果（终态）

| 维度                  | 轮 1 基线 | 收口终态                                                               |
| --------------------- | --------- | ---------------------------------------------------------------------- |
| crate-size FAIL       | 88        | **37**（全并行域在途回涨；G-01 语义硬化在轨拦截，我方 133 登记带行数） |
| line-counts HARD/VIOL | 4 / 9     | **0 / 0**（全绿）                                                      |
| depcruise             | 3         | **0**                                                                  |
| 结构债红级（>900）    | 29        | **0**（我方域；core_run 17510→49 门面 + run/ 9 模）                    |
| 毒丸观测化            | 87 处静默 | 50+ 处已观测化（B1 各片）                                              |
| 问题池 25 项          | —         | **13 项闭环 + 12 项有交付**（剩余归并行域收口/环境）                   |
| EL-01…10              | 未关闭    | **未关闭（诚实保持）**                                                 |

---

## 一、总判色汇总

| #   | 报告                       | 总判色        | 一句话                                                                                                                                   |
| --- | -------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 01  | 目的性/伪完成（①a）        | 🟩 **绿偏黄** | 无假关 EL / 去 `-S` / fixture 伪装 / hydrate 抬关 / CSS 假互斥 / 库测抬 e2e；X-05、provisional→kind 钉测真跑绿（82 passed）              |
| 02  | 结构/上帝文件/长逻辑（①b） | 🟨 **黄**     | block 域九面零回涨；**壳层/引擎域红级巨石复发**（core_run_commands **15101** 行，豁免盲区 6 倍回涨）+ 双门禁 HEAD 实红                   |
| 03  | 交叉连通（①c）             | 🟢 **绿**     | 七链无回退；CONN-E2′ 本轮合入升通；R-EL 假关硬门 7 条点名；A 链仍诚实半连通                                                              |
| 04  | 并发锁/性能/背压           | 🟡 **黄**     | 无跨 await 持锁/死锁环/无界缓冲/禁模式回潮；store 锁粒度过粗 + 同步 IO 直跑 async 线程 + 34+ 静默毒丸无观测                              |
| 05  | 错误治理/可观测性          | 🟡 **黄**     | 基建在轨（Error Boundary/健康端点/结构化 tracing/DOM 诚实属性）；**分布式追踪完全缺失（红）** + 批写 Fail-Open 降级无感知 + 性能埋点缺口 |
| 06  | 安全/输入验证/构建治理     | 🟡 **黄**     | 安全设施全绿+测锁定、无禁模式回潮；**CSP 缺失**（中危配置缺口）；双门禁脚本实跑红                                                        |
| 07  | 测试真实性/契约/可维护性   | 🟡 **黄**     | mock 纪律/失败分支/测试资产全绿；持久层**无 CAS**（rev LWW 单调）、生产 400ms 裸延迟、3 BOM 文件、3 处 api→store 分层违规                |

**总判：🟨 黄偏红** —— 功能诚实面（①a/①c）绿，结构/门禁/并发/可观测面黄，其中**构建门禁（crate-size / line-counts）在 HEAD 即红**、**core_run_commands 巨石 6 倍豁免盲区回涨**、**分布式追踪完全缺失**为三个最深问题。

**不可抬关声明**：本次审计 ≠ 任何 EL-01…10 关闭；≠ 块工作区完成；≠ 结构债清零。

---

## 二、报告清单

| 文件                                                               | 行数 | 摘要                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [01-目的性-伪完成审计.md](./01-目的性-伪完成审计.md)               | ~110 | ①a：9 条检查全绿（假关/去-S/fixture/hydrate/CSS 假互斥/库测抬 e2e 均未发现）；半连通五态按链 A–G 写调用序全通或诚实断点；维度外低严重度发现（19/00 行数口径差、19 HEAD 锚陈旧）；5 组 cargo 82 passed 真跑                                                        |
| [02-结构规范-上帝文件-长逻辑.md](./02-结构规范-上帝文件-长逻辑.md) | 310  | ①b：全仓红级（>900）**29 个**上帝文件表 + 壳层巨型函数表（run_task_impl 656 / execute_single 470 / drive_run_loop 385）；SD-26…31 + SD-22 债包；双门禁 HEAD 快照真跑记录（crate-size 88 FAIL / line-counts 3 HARD+7 VIOL）                                        |
| [03-交叉连通性审计.md](./03-交叉连通性审计.md)                     | 501  | ①c：七链五段式（调用序→色→断点→测→缺测）；E2′ 升通已关账；Top3 断点（R-EL 假关硬门 7 条 / A 半连通 / 产品默开余量）；CONN 余量 1–2（C2′ 产品默开须新 ID）                                                                                                         |
| [04-并发锁-性能-背压.md](./04-并发锁-性能-背压.md)                 | 151  | §2/§3/§12：无生产跨 await 持锁；毒丸 34+ 静默（store_backend 7 / summary_coordinator 9 / note_memory 12 / explore_quota 4 / engine:2083 / telemetry file:147）；锁粒度粗（全文档单锁 + Mutex<Connection>）；零 spawn_blocking；并行工具组无并发上限；B1–B5 建议包 |
| [05-错误治理-可观测性.md](./05-错误治理-可观测性.md)               | ~110 | §6/§10：空 catch 余 1 处基线内；Error Boundary/健康端点/DOM 属性绿；**Trace ID 全仓零命中（红）**；sessionRustDb.ts:1367-1379 批写 Fail-Open 降级 localStorage 无 UI 感知；性能三热点无埋点；S1–S5 建议包                                                         |
| [06-安全-输入验证-构建治理.md](./06-安全-输入验证-构建治理.md)     | ~130 | §9/§14：命令门禁/路径校验/权限矩阵/批写令牌/日志脱敏/渲染 sanitize 全绿+测锁定；**index.html 无 CSP meta、tauri.conf.json 无 security.csp**；门禁脚本实跑红；CSP-1/门禁-2 建议包                                                                                  |
| [07-测试真实性-契约-可维护性.md](./07-测试真实性-契约-可维护性.md) | ~130 | §7/§8/§13：过度 mock/原生 API 篡改/类型断言/快乐路径/测试资产全绿；**persist_plugin.rs:70-80 rev 仅 LWW 无 CAS**；useStreamCallbacks.ts:519 生产 400ms 裸延迟；3 BOM 文件；depcruise 3 违规确认；line-counts 4 HARD（工作区口径）                                 |

---

## 三、问题池（跨报告去重 · 同权 · 供方案轮消费）

> 以下问题全部同权，**不按业务重要性排序**；方案轮须全量覆盖，禁止砍项。

### 门禁 / 治理（CI 实红）

1. **crate-size 门禁 HEAD 实红**：88 个超限文件未登记豁免（02 §6.1 / 06 实跑确认）；`conex-browser/lib.rs` 1224 超入口 800 未豁免；ci-mid.yml:165 执行该脚本
2. **line-counts 门禁 HEAD 实红**：3 HARD（noteApi 704 / BrowserImportSection 751 / useStreamCallbacks 950 超基线 915）+ 7 VIOLATION（02 §6.2 / 07 确认）；eventParser 为工作区增量（并行域责任）
3. **depcruise 3 分层违规**：continuityHandlers.ts:16/:22、subagentHandlers.ts:15 直连 store 内部绕 storeAccess（02 / 07 双确认）
4. **CSP 缺失**：index.html 无 CSP、tauri.conf.json 无 security.csp、首屏内联 script（06）

### 结构（壳层/引擎域巨石）

5. **core_run_commands.rs 15101 行**（基线登记 2524，6 倍豁免盲区回涨；工作区已 16637 并行在堆）；run_task_impl 656 / drive_run_loop 385 / decide_idle_resume 227；~7560 行内嵌测试
6. **engine.rs 6107**（装配 263 / stream 278）、**background.rs 5188**（kill 211 / emit 172）、**tool_exec.rs 4719**（execute_single 470 / execute_batch 292）
7. **红级巨石群其余 24 个**（subagent 3305 / router 3292 / shell 3251 / session(CRDT) 2922 / ws 2845 / snapshot collect 2721 / compaction 2532 等）——大部分未登记豁免
8. **note_backend.rs 802**（impl ~307 + 内嵌测 ~495）——SD-22 沿用
9. **SD-22…25 已建议未派**：post-t8 05 遗留（hydrateProjection 449 等）

### 并发 / 性能

10. **毒丸恢复 34+ 处静默无观测**（B1）
11. **同步 IO 直跑 async 线程**：Tauri note 命令零 spawn_blocking；fs 工具同步 std::fs（B2）
12. **store 锁粒度过粗**：全文档单锁 + Mutex<Connection>，多 doc 并发写串行化（B3）
13. **并行工具组无并发上限**：join_all 无信号量（B4）
14. **前端 O(N²)/裸延迟**：useStreamCallbacks.ts:519 400ms 裸延迟、onChunk 每 token messages.find（低危）

### 可观测 / 错误治理

15. **分布式追踪完全缺失**（05 §10-8 红）：trace_id/traceId 生产零命中
16. **session 批写 Fail-Open 降级分叉**：SQLite probe 失败整批降 localStorage，无 degraded UI 感知（S1）
17. **性能指标埋点缺口**：慢序列化/长锁等待/O(N²) 渲染三热点无计数（S3）
18. **streaming.rs:310 session_id: None 契约占位未接线**（S5）

### 一致性 / 契约 / 编码

19. **持久层无乐观锁**：persist_plugin.rs rev 仅 LWW 单调递增，无期望版本比对/CAS（07 §8）
20. **3 个文件带 UTF-8 BOM**：ttfb_measure.rs / multi_agent.rs / steering/strategy.rs（07 §9）
21. **过期诚实句**：intentBridge.ts:202「IPC 尚未接线」与已接 CONN-B3 矛盾（02/07）
22. **leaves→chrome 逆向 import 2 处 gray zone**（02 §8 跨层）

### 连通余量（非回退 · 可测）

23. **C2′/C-prod**：PaperList 产品默开须新 ID（禁把 enableProductPaperList 默改 true 当 C2）
24. **B3-e2e / G2-e2e 真 WebView 未做**；D×G2′ 叶 `#` → reload → data-flavour 一体未覆盖
25. **A 链仍半连通**：产品「打开完成」（G-HYD 全条件）未交（诚实断点，非缺陷）

---

## 四、子 Agent 调度记录

| 维度          | task_id                        | 空返回处理                    |
| ------------- | ------------------------------ | ----------------------------- |
| 01 目的性     | ses_008dbdd32ffe2H6moG4o2vnfcW | 一次成功                      |
| 02 结构       | ses_008dbb2dbffeMscZCjz74ol5ca | 一次成功                      |
| 03 连通       | ses_008db8e58ffeHcd7Rd9gg5g23l | 一次成功                      |
| 04 并发锁性能 | ses_008db6f0bffe6hJS842w3tP06f | **首次缺最终产出 → 接续成功** |
| 05 错误可观测 | ses_008db55ebffeLXrUYp6fU2MxHA | **首次缺最终产出 → 接续成功** |
| 06 安全构建   | ses_008db347bffe46FPSc3yihI3o5 | 一次成功                      |
| 07 测试契约   | ses_008db105fffesnXxqTQgB5CcbM | 一次成功                      |

---

## 五、下一步（R2 方案轮入口）

- **输入**：本文件 + 01–07 报告（问题池 §三 共 25 项，同权）
- **产出**：`docs/review-md-audit/2026-08-13-wave/plans/`（独立方案 → 评审 → 总计划 → 维度详案 → 评审 → 定稿）
- **执行轮**：按定稿总方案多轮并行，每轮 5–12 Agent，子 Agent 留工作区、主 Agent 统一 `git commit --only` 提交

_2026-08-13 · 主 Agent 汇总索引 · R1 审计轮收口_
