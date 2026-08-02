# V2 审查全景概览

> 生成日期：2026-07-25 | 审查轮次：R1~R4 Agent 多轮协同
>
> **⚠️ HISTORICAL (OPT-E8 / W4-2):** 本目录下 JSON/矩阵中的 `apps/crish-desktop/src/store/session-actions/**` 为审查时路径快照；该目录已于 W4-2 **物理删除**。现行 session store actions：`sessionCrudActions.ts` / `sessionMessageActions.ts` / `sessionOrderingActions.ts` / `sessionAgentActions.ts` / barrel `sessionActions.ts`。JSON 审计原文保留不改，仅作历史机器记录。

---

## 1. 审查轮次执行统计

| 审查轮次 | 参与 Agent 数 | 处理条目数 | 审查内容 |
|----------|:-------------:|:----------:|----------|
| R1 — 交叉索引 Agent | 12 | 1859 行 entries (含 orphan) | 三套 ID 体系映射 (ledger/topology/write_set_matrix) |
| R2 — 路径审计 Agent | 12 | 502 条路径 | 代码路径存在性验证、wrong_path 自动纠偏 |
| R3 — 根因审计 Agent | 8 | 65 条 (含 ledge + orphan) | 证据级根因验证、偏差分析 |
| R4 — 修复方案评估 Agent | 8 | 58 条 (含 ledger + 治理项) | 校正修复策略、遗漏分析、副作用评估 |

---

## 2. Ledger 问题分类汇总 (37 项)

| 分类 | 数量 | 占比 |
|------|:----:|:----:|
| ✅ **verified** (根因真实，证据确凿) | 32 | 86.5% |
| ⚠️ **partial** (根因基本真实，有偏差) | 5 | 13.5% |
| ❌ **hallucinated** (根因虚假) | 0 | 0% |

**partial 明细：**

| ID | 偏差说明 |
|----|----------|
| GAP-CS-07 | 实际风险路径非 StreamRecoveryError 直接触发 pool 错误记录，而是 surface-error 丢失原始错误类型信息 |
| GAP-TC-03 | 仅 openai-request-build.ts 的 stringifyToolOutput 有 bug；tool-output-budget.ts 版使用 typeof 检查无此问题 |
| GAP-PM-02 | Unix 分支已具备两阶段终止 (SIGTERM→5s→SIGKILL) 和进程组 leader，描述不准确 |
| GAP-SE-02 | Rust `safe_drop_end` 并非完全"缺乏工具对绑定"——有 role 级邻接保护，缺少的是 ID 级跨消息配对 |
| GAP-UI-04 | localStorage 明文存储 apiKey 的描述与当前代码不符（已剥除），但非 Windows 加密缺位属实 |

---

## 3. 路径审计统计 (37 项 ledger 问题 + 引用文件)

| 状态 | 数量 | 说明 |
|------|:----:|------|
| ✅ **exists** | ~75 条 | 所有生产文件均存在 |
| 🔀 **wrong_path** | 1 条 | GAP-ST-01 的测试文件 StreamRenderBuffer.test.ts (实际位于 `packages/shared-utils/src/__tests__/`) |
| ❌ **hallucinated** | 1 条 | GAP-ST-01 的 StreamRenderBuffer.test.ts (原路径不存在) |

> 注：hallucinated 仅为测试文件路径，不影响问题本身的真实性。所有 37 项 ledger 问题的源代码文件均真实存在。

---

## 4. 根因审计结果分布

| 域 | verified | partial | hallucinated | 合计 |
|----|:--------:|:-------:|:------------:|:----:|
| 流式/Token 域 (ST) | 10 | 0 | 0 | 10 |
| 并发与状态机域 (CS) | 8 | 1 | 0 | 9 |
| Tool Call 容错域 (TC) | 3 | 1 | 0 | 4 |
| 进程/内存域 (PM) | 5 | 1 | 0 | 6 |
| 代码编辑/Patch 域 (SE) | 3 | 1 | 0 | 4 |
| 桌面/UI 域 (UI) | 3 | 1 | 0 | 4 |
| **合计** | **32** | **5** | **0** | **37** |

---

## 5. 修复方案可行性统计

| 域 | feasible | partial | not feasible | 合计 |
|----|:--------:|:-------:|:------------:|:----:|
| 流式/Token 域 (ST) | 9 | 1 | 0 | 10 |
| 并发与状态机域 (CS) | 9 | 0 | 0 | 9 |
| Tool Call 容错域 (TC) | 4 | 0 | 0 | 4 |
| 进程/内存域 (PM) | 5 | 1 | 0 | 6 |
| 代码编辑/Patch 域 (SE) | 4 | 0 | 0 | 4 |
| 桌面/UI 域 (UI) | 3 | 1 | 0 | 4 |
| **合计** | **34** | **3** | **0** | **37** |

---

## 6. 夸轮次综合大表

| ID | 域 | 路径状态 | 根因真实 | 修复可行 | 最终结论 |
|----|----|:--------:|:--------:|:--------:|:--------:|
| GAP-ST-01 | 流式/Token 域 | wrong_path(测试) | ✅ verified | ✅ feasible | ✅ 可信，可修复 |
| GAP-ST-02 | 流式/Token 域 | ✅ exists | ✅ verified | ✅ feasible | ✅ 可信，可修复 |
| GAP-ST-03 | 流式/Token 域 | ✅ exists | ✅ verified | ✅ feasible | ✅ 可信，可修复 |
| GAP-ST-04 | 流式/Token 域 | ✅ exists | ✅ verified | ✅ feasible | ✅ 可信，可修复 |
| GAP-ST-05 | 流式/Token 域 | ✅ exists | ✅ verified | ✅ feasible | ✅ 可信，可修复 |
| GAP-ST-06 | 流式/Token 域 | ✅ exists | ✅ verified | ✅ feasible | ✅ 可信，可修复 |
| GAP-ST-07 | 流式/Token 域 | ✅ exists | ✅ verified | ✅ feasible | ✅ 可信，可修复 |
| GAP-ST-08 | 流式/Token 域 | ✅ exists | ✅ verified | ✅ feasible | ✅ 可信，可修复 |
| GAP-ST-09 | 流式/Token 域 | ✅ exists | ✅ verified | ✅ feasible | ✅ 可信，可修复 |
| GAP-ST-10 | 流式/Token 域 | ✅ exists | ✅ verified | ⚠️ partial | ✅ 可信，修复需校正 |
| GAP-CS-01 | 并发与状态机域 | ✅ exists | ✅ verified | ✅ feasible | ✅ 可信，可修复 |
| GAP-CS-02 | 并发与状态机域 | ✅ exists | ✅ verified | ✅ feasible | ✅ 可信，可修复 |
| GAP-CS-03 | 并发与状态机域 | ✅ exists | ✅ verified | ✅ feasible | ✅ 可信，可修复 |
| GAP-CS-04 | 并发与状态机域 | ✅ exists | ✅ verified | ✅ feasible | ✅ 可信，可修复 |
| GAP-CS-05 | 并发与状态机域 | ✅ exists | ✅ verified | ✅ feasible | ✅ 可信，可修复 |
| GAP-CS-06 | 并发与状态机域 | ✅ exists | ✅ verified | ✅ feasible | ✅ 可信，可修复 |
| GAP-CS-07 | 并发与状态机域 | ✅ exists | ⚠️ partial | ✅ feasible | ⚠️ 有偏差，修正后可用 |
| GAP-CS-08 | 并发与状态机域 | ✅ exists | ✅ verified | ✅ feasible | ✅ 可信，可修复 |
| GAP-CS-09 | 并发与状态机域 | ✅ exists | ✅ verified | ✅ feasible | ✅ 可信，可修复 |
| GAP-TC-01 | Tool Call 容错域 | ✅ exists | ✅ verified | ✅ feasible | ✅ 可信，可修复 |
| GAP-TC-02 | Tool Call 容错域 | ✅ exists | ✅ verified | ✅ feasible | ✅ 可信，可修复 |
| GAP-TC-03 | Tool Call 容错域 | ✅ exists | ⚠️ partial | ✅ feasible | ⚠️ 有偏差，修正后可用 |
| GAP-TC-04 | Tool Call 容错域 | ✅ exists | ✅ verified | ✅ feasible | ✅ 可信，可修复 |
| GAP-PM-01 | 进程/内存域 | ✅ exists | ✅ verified | ✅ feasible | ✅ 可信，可修复 |
| GAP-PM-02 | 进程/内存域 | ✅ exists | ⚠️ partial | ⚠️ partial | ⚠️ 部分可信，需缩小范围 |
| GAP-PM-03 | 进程/内存域 | ✅ exists | ✅ verified | ✅ feasible | ✅ 可信，可修复 |
| GAP-PM-04 | 进程/内存域 | ✅ exists | ✅ verified | ✅ feasible | ✅ 可信，可修复 |
| GAP-PM-05 | 进程/内存域 | ✅ exists | ✅ verified | ✅ feasible | ✅ 可信，可修复 |
| GAP-PM-06 | 进程/内存域 | ✅ exists | ✅ verified | ✅ feasible | ✅ 可信，可修复 |
| GAP-SE-01 | 代码编辑/Patch 域 | ✅ exists | ✅ verified | ✅ feasible | ✅ 可信，可修复 |
| GAP-SE-02 | 代码编辑/Patch 域 | ✅ exists | ⚠️ partial | ✅ feasible | ⚠️ 有偏差，修正后可用 |
| GAP-SE-03 | 代码编辑/Patch 域 | ✅ exists | ✅ verified | ✅ feasible | ✅ 可信，可修复 |
| GAP-SE-04 | 代码编辑/Patch 域 | ✅ exists | ✅ verified | ✅ feasible | ✅ 可信，可修复 |
| GAP-UI-01 | 桌面/UI 域 | ✅ exists | ✅ verified | ✅ feasible | ✅ 可信，可修复 |
| GAP-UI-02 | 桌面/UI 域 | ✅ exists | ✅ verified | ✅ feasible | ✅ 可信，可修复 |
| GAP-UI-03 | 桌面/UI 域 | ✅ exists | ✅ verified | ✅ feasible | ✅ 可信，可修复 |
| GAP-UI-04 | 桌面/UI 域 | ✅ exists | ⚠️ partial | ⚠️ partial | ⚠️ 部分可信，缩小范围 |

**图例：** ✅ = 确认通过 | ⚠️ = 部分通过/需校正 | ❌ = 不通过
