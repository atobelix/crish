# CODEBASE-03：并行阵营成果核对与门禁全局实测

- 子代理：A3（只读核对）
- 核对窗口：2026-08-04 起全部提交（至 HEAD e0be7f58，refactor/architecture 分支）
- 核对方式：git log/diff/blame 全量扫描 + 门禁本地实跑（含临时 worktree 隔离验证）
- 日期：2026-08-08

---

## 一、提交面核对（2026-08-04 以来）

### 1.1 总量与主题分组

实测提交总数 **183**（`git log --since=2026-08-04`，含 08-05 起 F1-F16 批次）：

| 主题分组 | 数量 | 占比 | 说明 |
|---|---|---|---|
| 修复（fix） | 64 | 35% | P0×4/P1/P2 各批绿提交、flaky 根因修复、CI 修复 |
| 红测试（test） | 39 | 21% | F-xxx/T3.x/PS 各批红测试 + RECOVERY 恢复 |
| 新功能（feat） | 36 | 20% | F1-F16 功能批次、编辑器 M3/M4 重写 |
| 重构/清理 | 17 | 9% | 死代码删除、knip 收敛、audit 批次清理 |
| docs(audit) 登记 | 13 | 7% | 99-EXECUTION-FINDINGS / AC 验收 / 总结落盘 |
| docs 其他 | 13 | 7% | 方案、计划、回合报告 |
| 其他 | 1 | 1% | 中文裸提交（红测试两段合并） |

按日期分布：08-05 功能批次 30 提交 → 08-06 修复/清理 21 → 08-07 编辑器+修复 45 → 08-08 红测试 28 + 修复 30 + 登记 13（修复轮主战场，全量回归收口日）。

### 1.2 触及文件分布

总触及 3368 次（去重后 2031 文件）；单提交平均 18.4 文件。Top 分布：

| 路径 | 触及次数 | 说明 |
|---|---|---|
| reference/markdown-editor | 1855 | 两个 "save state" 提交各 844/835 文件（整目录重写级）；M3/M4 工程化 379 文件 |
| apps/crish-desktop | 255 | P1-D/F、P2 批4/5、tiptap 批次 |
| docs/composer-preview | 190 | 08-06 前并行域文档源码（超窗口内但仍相关） |
| apps/agent-workbench | 131 | PS-04、F-013、spawner、恢复阶梯 |
| crates/agent-tools | 67 | F3 域、写配额 TOCTOU、流协议 |
| crates/session-loop | 58 | F1-03/F2-01/F2-02、T4.1/T4.2 |
| docs/organization | 54 | 审计计划/登记/验收 |
| docs/feature-gap-analysis | 50 | 方案文档（本审计所在目录） |
| tests/e2e | 46 | 5 保护 spec 恢复 + PS-02 门禁 |
| crates/orchestrator | 36 | T3.4 D4、F-005 touch、C7 阶梯 |
| crates/conex-types | 35 | 事件/错误码注册 |
| packages/shared-types | 27 | 生成类型对齐、F8 域 |

### 1.3 docs(audit) 登记类提交（只登记不修的洞）

13 个登记提交全部落盘在 `docs/organization/audit/`：

- **99-EXECUTION-FINDINGS.md**（15 次修改，最新 17:28）：F-001~F-033 执行发现登记
- **00-REMEDIATION-SUMMARY.md**（08-08 16:21）：P0×4/P1×29/P2 约 70 总结
- **AC-01/02/03**（独立验收报告）：红线 22 变体 / CI 5 项 / 壳前端 7 项
- **P2B1-deadcode-impl-report.md**：批 1 死代码实现报告

登记为"待接/让渡/不修"且**当前仍存在**的洞（详见 §5 问题清单）：

| 编号 | 内容 | 当前状态 |
|---|---|---|
| F-017 | C7 恢复阶梯生产未接线（RecoveryCoordinator 零调用） | **仍存在**（登记待接） |
| F-018 | deadlock detector 生产未接线（F9-05） | **仍存在**（登记待接） |
| F-019 | logger 脱敏 setLogRedactor 零接线 | **仍存在**（登记待接） |
| F-020 | knip 未用导出长尾 | **仍存在**（510 exports + 403 types，warn 级） |
| F-016 | matrix-navigation.spec.ts 2 用例既存失败 | **仍存在**（编辑器域登记不修） |
| F-031 | F8-07 负数断言修正（-3 是合法整数） | 已闭环（测试修正入库） |
| F-013 | load 反向校验生产数据源缺口 | **已闭环**（3b3f4805 接线落地） |

---

## 二、红测试真实性抽验

### 2.1 红→绿闭环（抽验 9 组，全部成立）

| 红测试提交 | 断言内容 | 绿提交 | 闭环判定 |
|---|---|---|---|
| 99ff5cec（F8-07/16/20） | turnIndex=1.5 拒绝、exitCode=-3 拒绝、maxAttempts 钳制、jitter 硬上限；注释明确"修复前 ok=true，红" | d18aec79 | ✅ 断言真实指向缺陷 |
| 4f8e0dc9（F1-03/F2-01/F2-02） | turn_index 溢出、length 阶梯放大、max_turns=0 边界（284 行测试） | d47e16f1 | ✅ 绿提交 saturating_add/saturating_mul/起始拦截对应实现 |
| 44bd9086（F3-03 折叠越界） | İ 多字符展开回查原始 Vec 越界 panic（4 测试） | 2608ad39 | ✅ 折叠索引映射对齐修复 |
| f59487c2（PS-01 redline） | 8/8 绕过形态必须 Blocked（9 failed as expected） | 30017c43 | ✅ AC-01 独立验收 worktree 隔离实测 3 passed/9 failed，测试未弱化 |
| 8edd7b0c（T3.1 D1 迁移幂等） | v3→v4 崩溃中间态重跑自愈 | d4d8853b | ✅ |
| bbf97172（T3.2 D6 写竞态） | 旧批次晚完成不得覆盖新批次（契约翻转） | b815efb7 | ✅ |
| 232244b7（T3.4 D4 flow 双跑） | 崩溃重启不得重复 spawn | af268550 | ✅ 双防线（spawn 即持久化 + load 反向校验） |
| 6329e1de（T3.5 D5 快照互斥） | 并发保存代数互异/无 tmp 残留 | 5a67825a | ✅ |
| 9457cfaf（F-005 touch 接线） | run 启动/中间态转移后会话 updated_at 必须刷新 | **37153189**（修复被并行批次整文件吸收，无独立绿提交） | ✅ 测试当前 3/3 绿；run.rs touch 接线在 37153189 内 |

**结论**：抽验的 9 组红测试全部真实断言缺陷且修复闭环。39 个红测试提交中，仅 F-005 touch、F8-45 schemaVersion（契约固化类，非红）无独立绿提交——前者修复被并行批次吸收（替代证据链成立），后者本就非红测试。

### 2.2 "不可复现/让渡"条目抽查

| 条目 | 登记声明 | 核对结果 |
|---|---|---|
| F-025/F-028（typecheck 被并行 WIP 破坏） | 登记→随 P2 批4 解决 | ✅ 闭环：01ef652b 修复 SidebarContextMenus/Tooltip，当前 typecheck 实测 EXIT=0 |
| F-026（MessageVirtualizer memo 契约不可复现） | 契约固化测试（非红），如实标注 | ✅ 诚实：测试在旧代码下同样通过已标注，未伪造红证据 |
| F-027（z-index 清单外残留） | 顺手 token 化，登记边界出入 | ✅ 已修复（style-contract 测试整文件断言强制） |
| F-013（生产 spawner 未落库 flow_node_id） | 登记待接 | ✅ 已闭环：3b3f4805 row_for description=flow_node_id.or(description) |
| F-004/F-008/F-011/F-033（红测试被整文件暂存吸收） | 替代证据链 | ✅ 同型事故四度复现，均以"红证据实测 + 测试入库 + 绿提交"闭环，但纪律问题未解决（见 §5） |

---

## 三、门禁全局实测（2026-08-08 实跑）

| 门禁 | 命令 | 结果 | 与总结声明对比 |
|---|---|---|---|
| Rust 全量 | `cargo test --workspace` | **88 套件 / 2987 通过 / 0 失败** ✅ | 总结声明 87 套件；实测 88。任务书"88 套件 1 个失败"不存在——0 失败 |
| TypeScript | `npm run typecheck` | **EXIT=0** ✅ | 一致 |
| vitest 全量（app 侧） | `npx vitest run` | **368 文件 / 5383 测试全绿** ✅ | 快层 355 文件/5341（unit 项目）与声明 356/5342 基本一致 |
| 快层覆盖率 | `npm run test:coverage -- --project=unit` | EXIT=0，coverage 55.01/77.46/72.58/55.01 ≥ 45/70/65/45 ✅ | 一致 |
| 中层 integration | `npx vitest run --config vitest.integration.config.ts` | 12 文件 / 40 测试 EXIT=0 ✅ | 一致 |
| knip | `npx knip` | EXIT=0（warn 级）：**Unused exports 510 + Unused exported types 403** | 声明"knip 收敛"；实际收敛 5 duplicates+26 项后仍剩 913 项 warn |
| **eslint** | `npx eslint .`（CI 同命令） | **EXIT=1：22 errors / 4 warnings** ❌ | **与"全量门禁绿"声称冲突**（见 §5 P1-1） |
| markdown-editor 门禁 | `npm test`（reference/markdown-editor） | 20 文件 / 103 测试全绿 ✅ | 一致（门禁铁律达标） |
| stress | `npm run stress` | 3/3 PASS EXIT=0 ✅ | 一致 |
| e2e 冒烟子集 | `npx playwright test`（5 spec） | **23 用例全失败**（beforeEach 超时）⚠️ | 本地复现失败；**根因环境端口错位**（见 §5 P1-3），非代码回归 |

任务书提及的失败集合核对：**snapshots/visual/markdownRenderAsync 类失败集合当前不存在**（MessageSnapshots.test.ts、TiptapVisualRedline.test.ts 均绿）；vitest 全量 5383 测试 0 失败，未发现"在途未修"集合。

---

## 四、审计登记闭环核对

- **新出现审计文档**：`docs/organization/audit/` 下 00-REMEDIATION-SUMMARY / 00-REMEDIATION-PLAN / F1-F10 十域审计 / R1-R3 复核 / PS-01~05 计划 / 99-EXECUTION-FINDINGS（F-001~F-033）/ AC-01/02/03 / P2B1 报告——均为 08-08 前后落盘。
- **闭环状况**：
  - 全部 P0（命令红线 22 变体、CI 中层复活、stress 真实化）有独立验收（AC-01/02）且独立验收员声称未读修复报告、worktree 隔离实测——可信度高。
  - 登记"待接"3 项（F-017/018/019）为**真未接线**（依赖缺失基础设施，非隐瞒）：grep 验证 RecoveryCoordinator 生产零调用、deadlock detector 注入点 None、setLogRedactor 零调用——登记诚实。
  - 登记"让渡"项（F-022 重叠、F-029 帧上限已修）核对属实：StreamRenderBuffer 拆帧已由 P2 批5 绿提交实现。
  - 遗留登记仍存：knip 长尾（F-020）、e2e matrix-navigation（F-016）。

---

## 五、发现的问题清单

### P1（门禁绿声称与实际不符）

**P1-1：eslint 门禁红——22 errors / 4 warnings，CI lint job 必失败**
- 证据：`npx eslint .` EXIT=1（与 ci.yml lint job 同命令）。22 errors 分布在 16 文件：streamState.ts（7 个 unused import）、store/types.ts（3）、MessageVirtualizer.memo.test.tsx（2）、ast-block-tables.spec.ts（2 @ts-ignore）、composerTypes.ts、BgTaskActions.test.tsx、usePreviewNavigation.ts、session-workspace.ts、debug-style.spec.ts、matrix-ime-selection.spec.ts 等。
- 归属：部分为 08-03 "eslint 251->0"（d82f7468）**之后的回归**——streamState.ts 的 StreamCallbacks 等 7 个 import 在 d82f7468 时仍有使用点（L31 callbacks: StreamCallbacks），当前仅剩 import 无使用点，属使用点删除后未清 import（3eb3a417/414ee34a closure 批次涉及）；MessageVirtualizer.memo.test.tsx（P2 批4 新增）自带 unused 引入。
- 影响：快层 CI lint job 若触发即失败；"全量门禁绿"总结未列 eslint 门禁表，存在盲区。

**P1-2：并行"整文件暂存吸收"纪律事故四度复现仍未根治**
- 证据：F-004（T3.3 红测试被 7e2cde0f 吸收）、F-008（amend 碰撞 + lint-staged 备份恢复）、F-011（types.rs 修复被 cb23d38c 吸收）、F-033（F-013 红测试被 37153189 吸收）——同型事故 4 次，均靠"替代证据链"补救；F-007 建议的 `git diff --check` 收窄 `--cached` 至 08-08 仍未落实（F-010 再提）。
- 影响：红绿两段提交无法字面核对（本报告 §2.1 中 F-005 即此型），长期腐蚀验收可信度。

**P1-3：e2e 冒烟本地 23 失败——环境端口错位，非代码回归**
- 证据：实测 `playwright test` 5 spec 23 用例全失败（waitForSelector 30s 超时）；端口探测：**5174 被 markdown-editor dev server 占用（title=markdown-editor），5173 为 Conex Composer**——与配置预期相反（playwright baseURL=5174 应为 crish-desktop）。cache-metrics 页面快照内容为 markdown-editor 渲染页（"高性能 Markdown 渲染引擎…"）佐证。且工作树存在 41 个未提交 markdown-editor WIP（Excel 表格功能在途）。
- 影响：本地无法复现 CI e2e 绿；总结声明"test:e2e:smoke EXIT=0"无法在本环境复核（F-015 同类问题再现）。CI 全新 checkout 不受影响，但本地门禁可复现性未达标。

**P1-4：工作树 41 个未提交 WIP 持续干扰门禁**
- 证据：`git status` 41 文件（markdown-editor 引擎/表编辑 17 个 + crish-desktop api 域 18 个 + docs）。当前门禁实测（cargo/typecheck/vitest 全绿）是在含 WIP 的树上通过；此前多批红测试/修复曾被他人在途 WIP 破坏编译（F-009/F-010/F-023/F-024/F-025）。
- 影响：门禁结果受并行会话时序影响，验收以"收尾时刻"为准的口径无法独立复核。

### P2（登记存在但未修/收敛未完成）

**P2-1：knip 未用导出长尾 913 项（510 exports + 403 types）**
- 证据：`npx knip` warn 级 EXIT=0（rules exports/types 未收紧为 error，收敛后才收紧）；F-020 登记"按域分批收敛"，08-08 仅收敛 5 duplicates + 26 项。
- 影响：死代码面仍大，收敛承诺未兑现到 error 门禁级。

**P2-2：F-017/F-018/F-019 三个"待接"面仍未接线**
- 证据：RecoveryCoordinator 生产零调用（grep 全壳无构造点）；deadlock detector 依赖 wait_subagents await 态信号源（引擎侧无跟踪器）；setLogRedactor 零调用。
- 影响：C7 恢复阶梯、子代理死锁防护、日志脱敏在**生产形态均未生效**（测试域/接口面就绪）。总结文档已如实标注"待接"，非隐瞒，但属实质性未完成项。

**P2-3：F-016 matrix-navigation.spec.ts 2 用例既存失败未修**
- 证据：登记"编辑器域适配任务回归"；当前 e2e 冒烟未含该 spec，本地端口错位无法复核其状态。
- 影响：编辑器域回归债转移，非本修复轮可闭环。

**P2-4：任务书基线数字漂移**
- 证据：任务书称"88 套件 1 个失败"，实测 88 套件 0 失败（该失败可能已随 0a85d8fc flaky 根因修复消失）；总结文档称 87 套件、vitest 快层 356/5342，实测 88 套件、355/5341——数字口径在收尾轮前后仍有 ±1 漂移（新测试持续入库所致，非问题，但验收锚点需固定提交）。

---

## 六、并行阵营成果可信度评估 + 残留洞清单

### 可信度评估

**总体结论：成果基本可信，"全量门禁绿"声称大体成立但有 1 处明确虚标（eslint）。**

| 维度 | 判定 | 依据 |
|---|---|---|
| 红测试真实性 | **高** | 抽验 9 组红→绿全部闭环，断言直指缺陷；AC-01 独立验收 worktree 隔离复核红证据（3 passed/9 failed 与提交声明一致）；F-026 不可复现项如实标注非红，无伪造红证据 |
| 修复完整性 | **高** | P0×4 有独立验收（AC-01/02/03 未读报告实跑）；cargo 88 套件 2987 测试 0 失败；typecheck/vitest/stress/integration 全绿 |
| 登记诚实度 | **高** | F-017/018/019"待接"经 grep 验证确未接线；F-020 knip 长尾如实登记；让渡项（F-022/F-029）核对属实 |
| "全量门禁绿"声明 | **中（有瑕疵）** | **eslint 22 errors 使 CI lint job 必失败**，总结门禁表未列 eslint——声明覆盖了部分门禁，未覆盖全部；e2e 本地无法复核（环境错位，非代码问题） |
| 并行纪律 | **低（持续风险）** | 整文件暂存吸收四度复现、41 个 WIP 未提交、钩子建议未落实——流程债严重但结果经替代证据链基本可复核 |

### 残留洞清单

| 级别 | 洞 | 状态 | 证据 |
|---|---|---|---|
| P1 | eslint 22 errors（CI lint 必红） | 未修 | streamState.ts:1-7 unused import 等 16 文件；`npx eslint .` EXIT=1 |
| P1 | 并行整文件暂存吸收纪律（4 次） | 未根治 | F-004/F-008/F-011/F-033；F-007 建议未落实 |
| P1 | e2e 本地 5173/5174 端口错位 + WIP 干扰 | 环境债 | 端口 title 探测：5174=markdown-editor、5173=Conex Composer |
| P1 | 41 个未提交 WIP 文件 | 在途 | git status 41 文件（markdown-editor 表编辑 + desktop api 域） |
| P2 | knip 长尾 913 项（exports+types） | 未收敛 | `npx knip` 510+403，warn 级 |
| P2 | F-017 C7 恢复阶梯未接线 | 待接 | RecoveryCoordinator 生产零调用 |
| P2 | F-018 deadlock detector 未接线 | 待接 | 信号源缺失（wait_subagents await 态无登记面） |
| P2 | F-019 logger 脱敏零接线 | 待接 | setLogRedactor 零调用 |
| P2 | F-016 matrix-navigation 2 用例失败 | 登记不修 | tests/e2e/matrix-navigation.spec.ts |
| P2 | 门禁数字口径漂移（87 vs 88 套件等） | 口径债 | 总结文档 87 / 实测 88 |

**结论一句话**：并行阵营 183 提交、P0×4/P1×29/P2 约 70 的修复总量与红→绿证据链经抽验基本真实可信，Rust/TS/vitest/stress/markdown-editor 门禁全绿，但 "全量门禁绿" 声明未覆盖 eslint（22 errors，CI lint 必失败），且并行纪律债（整文件吸收 4 次、41 个 WIP 未提交、端口错位）使门禁可复现性与验收锚点仍有实质缺口。
