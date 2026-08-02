# Conex 终极协同修复方案：质量门禁 (G0~G5) 与 Wave 调度规范 (v2) — 校正版本

> **文档版本**：v2.0-CORRECTED  
> **更新时间**：2026-07-24  
> **校正时间**：2026-07-25  
> **校正基准**：`v2_path_audit.json` / `v2_remediation_review.json`  
> **原始文档**：`analysis/master_repair_plan_v2/quality_gates_and_waves_v2.md`  
> **适用范围**：Conex 核心团队、全量 CI/CD 自动化构建流水线、多 Agent 协作工程规范  
> **存储位置**：`C:\Software\conex\docs\v2_plan_review\quality_gates_and_waves_v2_CORRECTED.md`

---

## 1. 概述与核心原则 (Overview & Core Principles)

Conex 作为一个轻量化、高性能的 AI 桌面协同开发工具，要求在快速迭代与高吞吐协同修复过程中保持绝对的架构稳健性与代码洁净度。

为防止在多 Agent 并发修改或大规模代码重构中引入过度设计、内存/句柄泄漏或架构循环依赖，本规范制定了**自动化阶段门禁 (Quality Gates G0~G5)** 以及 **Wave 调度规范 (Wave Scheduling Specification)**。

### 核心原则
1. **反过度设计红线 (Anti-Overengineering Guardrails)**：严格禁止内核级沙盒、SharedArrayBuffer 环形缓冲区、后台自动切模型、6 阶段洋葱 Hook 链等 9 项红线设计（原始文档误为 10 项，审查确认 sab_ring_buffer 仍在仓库中存在为空壳——`crates/conex-ipc/src/sab_ring_buffer.rs` 约 200 行——待 Wave 1 移除，不计入有效红线项）。
2. **强制 Wave 同步屏障 (Mandatory Wave Sync Barriers)**：任何代码包或 Agent 任务在跨越 Wave 阶段时，必须 100% 通过当前阶段对应的 Quality Gate，不允许带病进入下一阶段。
3. **零盲目容忍 (Zero Tolerance)**：G0（零编译报错）、G2（单元测试 100% 通过）、G3（子进程零孤儿泄露）硬阻断 PR 提交。

---

## 2. Wave 调度规范与同步屏障 (Wave Scheduling Specification)

Wave 调度是一种按层级依赖关系划分的并发开发与合并机制。通过将并行任务划分为 Waves，并在每个 Wave 之间设立 Quality Gate 锁，确保底层基础稳固后方可推进上层业务。

```
+-----------------------------------------------------------------------------------+
| Wave 0: 基础设施与契约重构 (Infrastructure & Contract Foundations)                 |
| - Rust 全局类型契约、CommandGatekeeper 基础规则、IPC Protocol 序列化                  |
+-----------------------------------------------------------------------------------+
                                         │  [Lock: G0 + G1 + G2]
                                         ▼
+-----------------------------------------------------------------------------------+
| Wave 1: 核心引擎与底层解耦 (Core Engine & Driver Decoupling)                        |
| - ProcessTree (Job Object/pgid) 生命管理, Tokio Channels, Keyring 双层存储         |
+-----------------------------------------------------------------------------------+
                                         │  [Lock: G0 + G1 + G2 + G3]
                                         ▼
+-----------------------------------------------------------------------------------+
| Wave 2: 上层业务与 UI 组件重构 (Business Logic & UI Component Refactoring)          |
| - React 状态解耦、自定义 <Tooltip> 治理、输入框 10% 聚焦对比度控制、Prompt 批处理        |
+-----------------------------------------------------------------------------------+
                                         │  [Lock: G0 + G1 + G2 + G3 + G4]
                                         ▼
+-----------------------------------------------------------------------------------+
| Wave 3: 集成联调与性能收敛 (Integration & Performance Convergence)                 |
| - 虚拟列表渲染收敛、全链路 Abort 信号传递、E2E 自动化测试闭环                          |
+-----------------------------------------------------------------------------------+
                                         │  [Lock: G5 全量闭环测试]
                                         ▼
                               [发布准备 Release Candidate]
```

### 2.1 Wave 0: 基础设施与契约重构 (Infrastructure & Contract Foundations)
* **核心目标**：统一 TypeScript 契约与 Rust 架构数据结构。
* **主要任务**：
  - 清理跨包循环依赖 (`no-circular`)。
  - 定义 `CommandGatekeeper` 规则集（基于 `RegexSet` 的 **17 条**毁灭性指令拦截——原始文档误为 11 条，审查确认 `crates/conex-sandbox/src/gatekeeper.rs` 实际包含 17 条正则模式）。
  - 确立无状态 `ApprovalPipeline` 的 JSON 格式与协议接口。
* **门禁锁 (Barrier Gate)**：`G0` (Zero-Compile Error) + `G1` (Line Count & Style).

### 2.2 Wave 1: 核心引擎与底层解耦 (Core Engine & Driver Decoupling)
* **核心目标**：保证底座进程生命周期、网络退避与安全存储的安全稳定。
* **主要任务**：
  - 实现 Windows `Job Object` (`KILL_ON_JOB_CLOSE`) 与 Unix `pgid` 进程组。
  - 移除 `sab_ring_buffer`（Wave 1 计划项，当前仍存在于 `crates/conex-ipc/src/sab_ring_buffer.rs`），回归标准 Tokio `mpsc` 通道。
  - 移除 DNS A/AAAA 异步前置解析与微服务断路器 `CircuitBreaker`。
* **门禁锁 (Barrier Gate)**：`G0` + `G1` + `G2` (Unit Test Gate) + `G3` (Integration & Cascade Gate).

### 2.3 Wave 2: 上层业务与 UI 组件重构 (Business Logic & UI Component Refactoring)
* **核心目标**：清理 UI 层的"上帝组件"，优化样式与状态。
* **主要任务**：
  - 统一替换原生 HTML `title` 属性为自定义 `<Tooltip>` 组件。
  - 实施输入框聚焦状态最大 10% 对比度微调（使用 `color-mix`）。
  - 清理无意义的 95% `React.memo` 覆盖，仅保留高频渲染叶子节点。
  - 拆分行数超过 500 行的 UI 组件与 `useState` > 12 的复杂状态。
* **门禁锁 (Barrier Gate)**：`G0` + `G1` + `G2` + `G3` + `G4` (Performance & Memory Gate).

### 2.4 Wave 3: 集成联调与性能收敛 (Integration & Performance Convergence)
* **核心目标**：全链路端到端闭环验证与极速交付。
* **主要任务**：
  - 验证跨进程 AbortController 级联取消。
  - 自动化 E2E 全链路场景闭环。
* **门禁锁 (Barrier Gate)**：`G5` (End-to-End Closed Loop Gate).

---

## 3. 阶段质量门禁 (Quality Gates G0~G5) 详细定义

| 门禁 ID | 门禁名称 | 校验重点与断言指标 | 执行命令/工具 | 阻断级别 |
| :--- | :--- | :--- | :--- | :--- |
| **G0** | **Zero-Compile Error Gate** | TypeScript 类型推导 0 报错；Rust Workspace 0 编译错误与 Warning；打包无缺失模块 | `npx tsc --noEmit`（需在项目根目录运行，非 monorepo 子包）<br>`cargo check --workspace` | **Hard Block** |
| **G1** | **Line Count & Style Gate** | 有效代码行数限制（UI Component < 500 行，Logic < 400 行，Types < 800 行）；禁止上帝组件（`useState` ≤ 12，单文件多组件拦截）；红线设计违规扫描（9 条禁用关键词） | `node scripts/ci/check-g1-style.js`（脚本已创建，可用） | **Hard Block (超标>650行)<br>Warning (450~650行)** |
| **G2** | **Unit Test Gate** | 前端 Vitest 100% 单元测试通过率；后端 Cargo test 100% 通过率；核心覆盖率 > 80%。（**校正注：实际根配置阈值仅为 statements ≥ 50 / branches ≥ 40 / functions ≥ 50 / lines ≥ 50，子包略高至 70/60/65/70。80% 为目标值尚未达到。**） | `npx vitest run`<br>`cargo test --workspace --lib` | **Hard Block** |
| **G3** | **Integration & Cascade Gate** | 跨进程任务 Abort 信号 100% 传递；主进程异常/正常退出时子进程树 0 孤儿泄露；Job Object / pgid 绑定校验 100% | `node scripts/ci/check-g3-g4-resource.js --mode g3`（脚本已创建，可用） | **Hard Block** |
| **G4** | **Performance & Memory Gate** | 长时间运行与 500 次并发循环后 0 内存泄漏 (Heap Growth < 5MB)；0 句柄泄露 (OS Handle Growth = 0)；扫描耗时 < 2s | `node scripts/ci/check-g3-g4-resource.js --mode g4`（脚本已创建，可用） | **Hard Block** |
| **G5** | **End-to-End Closed Loop Gate** | 全自动化 E2E 流程（新建会话 -> 核心指令执行 -> 审批弹窗授权 -> 子进程清理 -> 日志落盘）100% 通过 | `npx vitest run --config vitest.integration.config.ts` **（原始文档引用 vitest.e2e.config.ts 不存在；当前仓库仅存在 vitest.integration.config.ts，已修正）** | **Hard Block** |

> **校正注**：上述执行命令中，`scripts/ci/check-g1-style.js`、`scripts/ci/check-g3-g4-resource.js` 及 `run-quality-gates.ps1/sh` 已全部创建，当前可用。`vitest.e2e.config.ts` 不存在，已改为 `vitest.integration.config.ts`。

---

## 4. 门禁自动化校验器实现 (Automated Quality Gate Validator Implementations)

为确保 CI/CD 流水线以及本地开发环境能够零成本、高并发地运行上述门禁，本节提供完整可运行的代码实现。**所有脚本位于 `scripts/ci/` 目录下，已全部创建。**

### 4.1 G1 代码规范与上帝组件校验器 (`scripts/ci/check-g1-style.js`)

该脚本以高性能异步方式扫描全项目代码，自动过滤文档注释与空行，严格执行分类代码行数门禁、上帝组件（`useState` 数量）检测及反过度设计红线扫描。

> **校正注**：此脚本已创建，可用。注意 `forbiddenPatterns` 当前仅 6 条正则，需补充至 9 条以完整覆盖 ANTI_OVERENGINEERING_GUARDRAILS.md 的全部红线（含 DNS 预解析 #4、密钥降级链 #5、IpcRouter #8、React.memo 95% #9）。

```javascript
/**
 * scripts/ci/check-g1-style.js
 * Conex Quality Gate G1: Line Count, God Component & Anti-Overengineering Rule Checker
 * 注意：此文件已创建，当前为文档内嵌参考实现
 */

const fs = require('fs');
const path = require('path');
const { globSync } = require('glob');

const CONFIG = {
  limits: {
    ui: { max: 500, warn: 450, hardBlock: 650, pattern: /\.(tsx)$/ },
    logic: { max: 400, warn: 350, hardBlock: 550, pattern: /\.(ts|js|jsx)$/ },
    typeDef: { max: 800, warn: 700, hardBlock: 900, pattern: /\.d\.ts$/ }
  },
  godComponent: {
    maxUseState: 12,
  },
  forbiddenPatterns: [
    { pattern: /sab_ring_buffer/i, reason: '禁用 SharedArrayBuffer 环形缓冲区 (RedLine #2)' },
    { pattern: /DynamicModelRouter/i, reason: '禁用后台自动切换模型 (RedLine #3)' },
    { pattern: /CircuitBreaker/i, reason: '禁用微服务级滑动窗口断路器 (RedLine #6)' },
    { pattern: /macOS Seatbelt|sandbox_init|seccomp-bpf/i, reason: '禁用 OS 内核级沙盒隔离 (RedLine #1)' },
    { pattern: /MiddlewarePipeline/i, reason: '禁用 6 阶段洋葱 Hook 链 (RedLine #7)' },
    { pattern: /title\s*=\s*["']/i, reason: '禁用原生 HTML title 属性，必须使用自定义 <Tooltip> (Rule #2)' },
    // TODO: 补充 DNS 预解析(#4)、密钥降级链(#5)、IpcRouter(#8)、React.memo 95%(#9)
  ],
  excludeDirs: ['node_modules', 'dist', 'build', '.git', 'target', '.gemini']
};
// ...（完整实现见原始文档 4.1 节，上述为关键配置段）
```

### 4.2 G3/G4 级联终止与资源泄漏检测器 (`scripts/ci/check-g3-g4-resource.js`)

该校验器用于验证系统在进行大量命令执行与 Abort 取消时，子进程是否能 100% 级联终止（无孤儿进程），且系统句柄与堆内存无泄露。

> **校正注**：此脚本已创建，可用。G4 testG4MemoryAndHandles 中 store 数组声明后未使用（死代码），循环内仅创建 tempContext 但不存储，无法模拟真实内存压力。G3 child.on('exit') 回调与 setTimeout 间存在竞态——子进程可能在 setTimeout 前退出，此时 remainingChildren 读取不准确。

```javascript
/**
 * scripts/ci/check-g3-g4-resource.js
 * Conex Quality Gates G3 (Cascade Abort & Process Tree) & G4 (Memory & Handle Leak) Validator
 * 注意：此文件已创建，当前为文档内嵌参考实现
 */
// ...（完整实现见原始文档 4.2 节）
```

### 4.3 统一质量门禁 Runner (PowerShell 入口: `scripts/ci/run-quality-gates.ps1`)

> **校正注**：此文件已创建，可用。PowerShell 脚本中第 464 行 `-ForegroundColor Cipher` 拼写错误，"Cipher" 并非有效 PowerShell 颜色名，应为 "Cyan" 或 "Blue"。

```powershell
<#
.SYNOPSIS
    Conex Quality Gates Automated Pipeline Runner (G0 ~ G5)
#>
# ...（完整实现见原始文档 4.3 节；需修正 Cipher 拼写错误）
```

### 4.4 跨平台 Bash 入口 (`scripts/ci/run-quality-gates.sh`)

用于 Linux / macOS CI 节点（如 GitHub Actions 或 GitLab CI）的自动化脚本：

> **校正注**：此文件已创建，可用。Bash 脚本中 `run_step` 函数未捕获 stderr，建议添加 2>&1 重定向。

```bash
#!/usr/bin/env bash
# scripts/ci/run-quality-gates.sh
# ...（完整实现见原始文档 4.4 节；建议添加 set -euo pipefail 已在原始脚本中实现，但 run_step 中建议捕获 stderr）
```

---

## 5. 门禁违反治理与红线阻断流程 (Gate Violation & Enforcement Workflow)

```
                              +-------------------------+
                              |   代码提交 / PR 触发    |
                              +-------------------------+
                                           │
                                           ▼
                              +-------------------------+
                              |  运行 run-quality-gates |
                              +-------------------------+
                                           │
                       ┌───────────────────┴───────────────────┐
                       ▼                                       ▼
             [ 门禁全部通过 🟢 ]                       [ 门禁失败阻断 🔴 ]
                       │                                       │
                       ▼                                       ▼
             +-------------------+                   +-------------------+
             | 允许进入下一 Wave |                   | 判定 Failure 类型 |
             | 或合并 PR 至 main |                   +-------------------+
             +-------------------+                             │
                                         ┌─────────────────────┼─────────────────────┐
                                         ▼                     ▼                     ▼
                                 [ G0/G2/G3/G5 阻断 ]     [ G1 超标 (>650行) ]     [ G1 预警 (450~650行) ]
                                         │                     │                     │
                                         ▼                     ▼                     ▼
                                 【硬阻断】立即修复      【硬阻断】强制拆分      【允许合并】自动生成
                                 编译/测试/孤儿进程      上帝组件与代码文件      Refactor Issue 挂单
```

### 1. 编译错误 (G0 Failure)
* **处理动作**：开发者/Agent 必须优先解决类型不匹配、模块缺失或 Rust lifetime/borrow 报错，禁止使用 `as any` 或 `@ts-ignore` 规避类型检查。

### 2. 行数与上帝组件违规 (G1 Failure)
* **硬性阻断 (> 650 行 / useState > 12)**：必须将文件按单一职责原则 (SRP) 拆解为多个子模块/Sub-hooks，方可继续提交。
* **预警区间 (450 ~ 650 行)**：允许通过 CI，但系统将自动触发提醒，标记该模块为技术债务。

### 3. 级联终止与内存泄露违规 (G3/G4 Failure)
* **处理动作**：检查进程创建代码是否绑定 Windows `Job Object` 或 Linux `pgid`，检查事件监听器或全局 ArrayBuffer 是否未在 `dispose()`/`unmount` 时注销。

---

## 6. 总结 (Conclusion)

通过将本规范中的 **Quality Gates (G0~G5)** 嵌入 Conex 项目的本地与 CI/CD 自动化体系，搭配 **Wave 0~3 协同调度锁**，系统能够实现：
1. **0 过度设计红线违规**：彻底拦截过度包装的模块与沙盒滥用。
2. **0 句柄/子进程泄露**：确保桌面端极速轻巧、后台干净清爽。
3. **高效高质的多 Agent 协同**：各 Agent 明确依赖边界，平滑有序地完成代码演进。

### 校正汇总

| 校正项 | 原始文档 | 校正后 | 审查来源 |
|---|---|---|---|
| G0 命令 | `tsc --noEmit`（无限制） | 需在项目根目录运行，monorepo 子包中可能无效 | v2_path_audit |
| G1 脚本路径 | `scripts/ci/check-g1-style.js` | **已创建，可用** | v2_supplement_plan |
| G3/G4 脚本路径 | `scripts/ci/check-g3-g4-resource.js` | **已创建，可用** | v2_supplement_plan |
| G5 配置 | `vitest.e2e.config.ts` | **不存在**，改为 `vitest.integration.config.ts` | v2_path_audit |
| Coverage 80% | 核心覆盖率 > 80% | 实际阈值：statements≥50/branches≥40/functions≥50/lines≥50 | v2_remediation_review |
| CommandGatekeeper 条数 | 11 条毁灭性指令拦截 | **实际为 17 条**（gatekeeper.rs:12） | v2_remediation_review |
| Anti-overengineering 条数 | 10 项红线 | **实际为 9 项**（sab_ring_buffer 仍存在但已标记移除） | v2_remediation_review |
| sab_ring_buffer 状态 | 已移除声明 | **仍存在于 crates/conex-ipc/ 中**（约 200 行），Wave 1 计划移除 | v2_remediation_review |
| PowerShell Cipher | `-ForegroundColor Cipher` | Cipher 非有效颜色名，应为 Cyan 或 Blue | v2_remediation_review |
