# 00 · 汇总索引（统一输入流收敛战役 · 首轮审计收齐）

> 更新：2026-08-16 · 六维审计全部收齐，批 2（核心循环/扩展盘点/扩展机制/撤回现状）已派发。
> 纪律：本索引为快速入口；证据一律回 analysis/ 各文档，结论以主控定夺（00-总方案 §3.1）为准。

## 产出清单

| 文件                                    | 行数 | 摘要                                                                                                                                      |
| --------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 00-总方案框架.md                        | 130+ | 概念模型（节点/时间线/来源/扩展点 A/B/C/D）/ 现状映射 / §3.1 审计修正 / 核心决策 / D1–D5 框架                                             |
| analysis/01-统一时间线与消息类型审计.md | 161  | 7 层消息类型形态；LS 为活动镜像层；append_session_messages 死层；事件流骨架成立（engine 只写 events）                                     |
| analysis/02-注入文本化审计.md           | 202  | 状态切换零时间线通道；reasoning_effort 半连通；nudge 通道已成型未接线；PendingMessageQueue 为可复用注入通道                               |
| analysis/03-权限审查路径审计.md         | 141  | 前端/引擎两套发散风险分类；无 deny 绕过但有 approve 超车竞态；「按工具类别分类」代码中不存在；PermissionBehavior 死类型                   |
| analysis/04-展示投影层审计.md           | 210  | 渲染主路径 = timelineNormalizer；UserView 为旁路（虚假对位修正）；折叠行半实现；官方图标缺失                                              |
| analysis/05-插件边界审计.md             | 119  | 无统一插件运行时（≥4 条隔离路径）；Rust ContributeViewRegistry 双实现死层；A/B/C 零承载；ToolRegistry+MCP 为现成等价物                    |
| analysis/06-重复与死层横切审计.md       | 231  | 基线：波次命名 33 文件 / 未接线 2867 token·689 文件 / 无日期 fallback 71 / 被跟踪 db 6 / 多 app 重复 5 组 / 陪葬测试 8 核心 / >1500 行 38 |
| analysis/07–10                          | —    | 批 2 派发中（核心循环 / 可扩展功能盘点 / 扩展机制解耦 / 撤回截断现状）                                                                    |

## 收敛度量基线（Δ 起点，重测命令 `node scripts/check-convergence-metrics.mjs`）

| 指标                        | 基线                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------- |
| 未接线/临时标记             | 2,867 token / 689 文件                                                                                   |
| 波次命名文件                | 33                                                                                                       |
| 无日期 fallback（核心口径） | 71                                                                                                       |
| 被 git 跟踪运行产物         | 6（apps/agent-workbench：sessions.db* ×3 + workspace.db* ×3）                                            |
| 多 app 概念重复对           | 5（sessionStore/settingsStore/terminalStore/themeProjection/eventStore）+ desktop 内 storeAccess.ts 双份 |
| 陪葬测试候选                | 核心 8（宽口径约 20）                                                                                    |
| >1500 行文件                | 38（生产 31 + 测试 7；最大 core_run_commands_tests.rs 10,201）                                           |

## 关键修正（影响执行轮的定夺，详见 00-总方案 §3.1）

1. localStorage 轨是**活动镜像/回退层**——删除前必须先剥 `sessionRustDbSql.ts` 镜像接入点（01）；
2. 展示 canonical 应为 **timelineNormalizer**，messageUserProjection 是旁路候选（04）；
3. 插件现状 = **≥4 条隔离路径**，crish-desktop/src/plugins 有 settings-extensions 消费，删除需先迁移（05 + 主控亲验）；
4. 「按工具类别分类判断」**代码中不存在**——D3 详案必须新建而非合并（03）；
5. 状态注入可复用通道 = **orchestrator PendingMessageQueue**，缺 context-state 节点类型（02）；
6. 撤回（§2.4）依赖的取消/回滚/截断现状待审计 10 验证。

## 下一步

批 2 审计（07–10）收齐 → 更新本索引与 §3.1 → 生成 D1–D5 详案任务书（含删除清单）→ 用户确认核心决策后进入执行轮。
