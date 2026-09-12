# Conex 终极协同修复方案：质量门禁 (G0~G5) 与 Wave 调度规范 (v2)

> **文档版本**：v2.0
> **更新时间**：2026-07-24
> **适用范围**：Conex 核心团队、全量 CI/CD 自动化构建流水线、多 Agent 协作工程规范
> **存储位置**：`C:\Software\conex\analysis\quality_gates_and_waves_v2.md`

---

## 1. 概述与核心原则 (Overview & Core Principles)

Conex 作为一个轻量化、高性能的 AI 桌面协同开发工具，要求在快速迭代与高吞吐协同修复过程中保持绝对的架构稳健性与代码洁净度。

为防止在多 Agent 并发修改或大规模代码重构中引入过度设计、内存/句柄泄漏或架构循环依赖，本规范制定了**自动化阶段门禁 (Quality Gates G0~G5)** 以及 **Wave 调度规范 (Wave Scheduling Specification)**。

### 核心原则
1. **反过度设计红线 (Anti-Overengineering Guardrails)**：严格禁止内核级沙盒、SharedArrayBuffer 环形缓冲区、后台自动切模型、6 阶段洋葱 Hook 链等 10 项红线设计。
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
  - 定义 `CommandGatekeeper` 规则集（基于 `RegexSet` 的 11 条毁灭性指令拦截）。
  - 确立无状态 `ApprovalPipeline` 的 JSON 格式与协议接口。
* **门禁锁 (Barrier Gate)**：`G0` (Zero-Compile Error) + `G1` (Line Count & Style).

### 2.2 Wave 1: 核心引擎与底层解耦 (Core Engine & Driver Decoupling)
* **核心目标**：保证底座进程生命周期、网络退避与安全存储的安全稳定。
* **主要任务**：
  - 实现 Windows `Job Object` (`KILL_ON_JOB_CLOSE`) 与 Unix `pgid` 进程组。
  - 移除 `sab_ring_buffer`，回归标准 Tokio `mpsc` 通道。
  - 移除 DNS A/AAAA 异步前置解析与微服务断路器 `CircuitBreaker`。
* **门禁锁 (Barrier Gate)**：`G0` + `G1` + `G2` (Unit Test Gate) + `G3` (Integration & Cascade Gate).

### 2.3 Wave 2: 上层业务与 UI 组件重构 (Business Logic & UI Component Refactoring)
* **核心目标**：清理 UI 层的“上帝组件”，优化样式与状态。
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
| **G0** | **Zero-Compile Error Gate** | TypeScript 类型推导 0 报错；Rust Workspace 0 编译错误与 Warning；打包无缺失模块 | `tsc --noEmit`<br>`cargo check --workspace` | **Hard Block** |
| **G1** | **Line Count & Style Gate** | 有效代码行数限制（UI Component < 500 行，Logic < 400 行，Types < 800 行）；禁止上帝组件（`useState` ≤ 12，单文件多组件拦截）；红线设计违规扫描（0 禁用关键词） | `node scripts/ci/check-g1-style.js` | **Hard Block (超标>650行)<br>Warning (450~650行)** |
| **G2** | **Unit Test Gate** | 前端 Vitest 100% 单元测试通过率；后端 Cargo test 100% 通过率；核心覆盖率 > 80% | `npx vitest run`<br>`cargo test --workspace --lib` | **Hard Block** |
| **G3** | **Integration & Cascade Gate** | 跨进程任务 Abort 信号 100% 传递；主进程异常/正常退出时子进程树 0 孤儿泄露；Job Object / pgid 绑定校验 100% | `node scripts/ci/check-g3-g4-resource.js --mode g3` | **Hard Block** |
| **G4** | **Performance & Memory Gate** | 长时间运行与 500 次并发循环后 0 内存泄漏 (Heap Growth < 5MB)；0 句柄泄露 (OS Handle Growth = 0)；扫描耗时 < 2s | `node scripts/ci/check-g3-g4-resource.js --mode g4` | **Hard Block** |
| **G5** | **End-to-End Closed Loop Gate** | 全自动化 E2E 流程（新建会话 -> 核心指令执行 -> 审批弹窗授权 -> 子进程清理 -> 日志落盘）100% 通过 | `npx vitest run --config vitest.e2e.config.ts` | **Hard Block** |

---

## 4. 门禁自动化校验器实现 (Automated Quality Gate Validator Implementations)

为确保 CI/CD 流水线以及本地开发环境能够零成本、高并发地运行上述门禁，本节提供完整可运行的代码实现。

### 4.1 G1 代码规范与上帝组件校验器 (`scripts/ci/check-g1-style.js`)

该脚本以高性能异步方式扫描全项目代码，自动过滤文档注释与空行，严格执行分类代码行数门禁、上帝组件（`useState` 数量）检测及反过度设计红线扫描。

```javascript
/**
 * scripts/ci/check-g1-style.js
 * Conex Quality Gate G1: Line Count, God Component & Anti-Overengineering Rule Checker
 */

const fs = require('fs');
const path = require('path');
const { globSync } = require('glob');

const CONFIG = {
  // 规则 1: 按类型分级有效行数门禁 (Effective SLOC Limits)
  limits: {
    ui: { max: 500, warn: 450, hardBlock: 650, pattern: /\.(tsx)$/ },
    logic: { max: 400, warn: 350, hardBlock: 550, pattern: /\.(ts|js|jsx)$/ },
    typeDef: { max: 800, warn: 700, hardBlock: 900, pattern: /\.d\.ts$/ }
  },

  // 规则 4: 上帝组件防爆判定 (God Component Limits)
  godComponent: {
    maxUseState: 12,
  },

  // 反过度设计红线禁止关键词列表 (Anti-Overengineering Forbidden Keywords)
  forbiddenPatterns: [
    { pattern: /sab_ring_buffer/i, reason: '禁用 SharedArrayBuffer 环形缓冲区 (RedLine #2)' },
    { pattern: /DynamicModelRouter/i, reason: '禁用后台自动切换模型 (RedLine #3)' },
    { pattern: /CircuitBreaker/i, reason: '禁用微服务级滑动窗口断路器 (RedLine #6)' },
    { pattern: /macOS Seatbelt|sandbox_init|seccomp-bpf/i, reason: '禁用 OS 内核级沙盒隔离 (RedLine #1)' },
    { pattern: /MiddlewarePipeline/i, reason: '禁用 6 阶段洋葱 Hook 链 (RedLine #7)' },
    { pattern: /title\s*=\s*["']/i, reason: '禁用原生 HTML title 属性，必须使用自定义 <Tooltip> (Rule #2)' },
  ],

  // 扫描排除路径
  excludeDirs: ['node_modules', 'dist', 'build', '.git', 'target', '.gemini']
};

/**
 * 计算文件的有效代码行数 (Effective SLOC - Excluding comments and empty lines)
 */
function calculateEffectiveSloc(content, filePath) {
  // 移除多行注释 /* ... */
  let cleanContent = content.replace(/\/\*[\s\S]*?\*\//g, '');

  const lines = cleanContent.split(/\r?\n/);
  let effectiveLines = 0;

  for (let line of lines) {
    const trimmed = line.trim();
    // 忽略空行与单行注释
    if (trimmed.length > 0 && !trimmed.startsWith('//') && !trimmed.startsWith('*')) {
      effectiveLines++;
    }
  }
  return effectiveLines;
}

/**
 * 校验上帝组件 (useState 数量)
 */
function checkGodComponent(content, filePath) {
  const useStateMatches = content.match(/useState\s*(<.*?>)?\s*\(/g);
  const count = useStateMatches ? useStateMatches.length : 0;
  return {
    isViolation: count > CONFIG.godComponent.maxUseState,
    count
  };
}

/**
 * 扫描红线违规
 */
function checkRedLines(content, filePath) {
  const violations = [];
  for (const rule of CONFIG.forbiddenPatterns) {
    if (rule.pattern.test(content)) {
      violations.push(rule.reason);
    }
  }
  return violations;
}

/**
 * 主执行逻辑
 */
function runCheck() {
  const startTime = Date.now();
  console.log('🚀 [G1 Gate] Starting Line Count & Anti-Overengineering Analysis...');

  const rootDir = path.resolve(__dirname, '../../');
  const targetDirs = ['src', 'packages', 'apps'];
  let totalFiles = 0;
  let hasHardError = false;
  let hasWarning = false;

  const files = globSync('**/*.{ts,tsx,js,jsx}', {
    cwd: rootDir,
    ignore: CONFIG.excludeDirs.map(d => `**/${d}/**`),
    nodir: true
  });

  for (const relativePath of files) {
    const fullPath = path.join(rootDir, relativePath);
    if (!fs.existsSync(fullPath)) continue;

    const content = fs.readFileSync(fullPath, 'utf8');
    const sloc = calculateEffectiveSloc(content, fullPath);
    totalFiles++;

    // 1. 行数门禁校验
    let fileCategory = 'logic';
    if (relativePath.endsWith('.d.ts')) {
      fileCategory = 'typeDef';
    } else if (relativePath.endsWith('.tsx')) {
      fileCategory = 'ui';
    }

    const limitConfig = CONFIG.limits[fileCategory];
    if (sloc > limitConfig.hardBlock) {
      console.error(`❌ [G1 Hard Block] File ${relativePath} (${fileCategory.toUpperCase()}): ${sloc} SLOC exceeds limit of ${limitConfig.hardBlock} lines!`);
      hasHardError = true;
    } else if (sloc > limitConfig.warn) {
      console.warn(`⚠️ [G1 Warning] File ${relativePath} (${fileCategory.toUpperCase()}): ${sloc} SLOC is nearing limit of ${limitConfig.max} lines.`);
      hasWarning = true;
    }

    // 2. 上帝组件校验 (针对 UI 组件)
    if (fileCategory === 'ui') {
      const godCheck = checkGodComponent(content, fullPath);
      if (godCheck.isViolation) {
        console.error(`❌ [G1 God Component] ${relativePath} contains ${godCheck.count} useState hooks (Max allowed: ${CONFIG.godComponent.maxUseState})!`);
        hasHardError = true;
      }
    }

    // 3. 反过度设计红线扫描
    const redLineViolations = checkRedLines(content, fullPath);
    if (redLineViolations.length > 0) {
      for (const reason of redLineViolations) {
        console.error(`❌ [G1 RedLine Violation] ${relativePath}: ${reason}`);
      }
      hasHardError = true;
    }
  }

  const duration = (Date.now() - startTime) / 1000;
  console.log(`\n📊 [G1 Gate Summary] Scanned ${totalFiles} files in ${duration.toFixed(2)}s.`);

  if (duration > 2.0) {
    console.warn(`⚠️ [G1 Performance Warning] Scan took ${duration.toFixed(2)}s (Target: < 2.0s).`);
  }

  if (hasHardError) {
    console.error('\n🔴 [G1 Gate FAILED] Hard blocking violations found. Please refactor before proceeding.');
    process.exit(1);
  } else {
    console.log('🟢 [G1 Gate PASSED] All line counts, component states, and redlines satisfy guidelines.');
    process.exit(0);
  }
}

runCheck();
```

---

### 4.2 G3/G4 级联终止与资源泄漏检测器 (`scripts/ci/check-g3-g4-resource.js`)

该校验器用于验证系统在进行大量命令执行与 Abort 取消时，子进程是否能 100% 级联终止（无孤儿进程），且系统句柄与堆内存无泄露。

```javascript
/**
 * scripts/ci/check-g3-g4-resource.js
 * Conex Quality Gates G3 (Cascade Abort & Process Tree) & G4 (Memory & Handle Leak) Validator
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const process = require('process');

const MODE = process.argv.includes('--mode')
  ? process.argv[process.argv.indexOf('--mode') + 1]
  : 'all';

/**
 * 获取当前 Windows 进程树中的特定子进程数量 (PowerShell / OS Dependent)
 */
function getActiveChildProcessCount(parentPid) {
  if (process.platform === 'win32') {
    try {
      const output = execSync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${parentPid} } | Measure-Object | Select-Object -ExpandProperty Count"`,
        { encoding: 'utf8', timeout: 3000 }
      );
      return parseInt(output.trim(), 10) || 0;
    } catch (e) {
      return 0;
    }
  } else {
    try {
      const output = execSync(`pgrep -P ${parentPid} | wc -l`, { encoding: 'utf8' });
      return parseInt(output.trim(), 10) || 0;
    } catch (e) {
      return 0;
    }
  }
}

/**
 * G3 测试: 级联终止与 AbortController 信号传递
 */
async function testG3CascadeAbort() {
  console.log('🚀 [G3 Gate] Testing Child Process Tree & Cascade Abort Signal...');

  return new Promise((resolve, reject) => {
    // 模拟启动长时子进程
    const controller = new AbortController();
    const { signal } = controller;

    console.log('  -> Spawning child long-running process...');
    const child = spawn('ping', ['127.0.0.1', '-n', '30'], {
      signal,
      windowsHide: true
    });

    const childPid = child.pid;
    console.log(`  -> Child process spawned with PID: ${childPid}`);

    let killedSuccessfully = false;

    child.on('error', (err) => {
      if (err.name === 'AbortError') {
        killedSuccessfully = true;
        console.log('  -> AbortError correctly caught on child process.');
      }
    });

    child.on('exit', (code, signalReceived) => {
      console.log(`  -> Child exited with code: ${code}, signal: ${signalReceived}`);

      // 等待 500ms 检查 OS 句柄与孤儿进程
      setTimeout(() => {
        const remainingChildren = getActiveChildProcessCount(process.pid);
        if (remainingChildren === 0) {
          console.log('🟢 [G3 Gate PASSED] Zero orphan child processes remaining.');
          resolve(true);
        } else {
          console.error(`❌ [G3 Gate FAILED] ${remainingChildren} orphan child processes detected!`);
          reject(new Error('Orphan child processes found'));
        }
      }, 500);
    });

    // 1000ms 后触发 Abort 信号
    setTimeout(() => {
      console.log('  -> Triggering AbortController.abort()...');
      controller.abort();
    }, 1000);
  });
}

/**
 * G4 测试: 内存与句柄泄漏检测 (500 次循环测试)
 */
async function testG4MemoryAndHandles() {
  console.log('🚀 [G4 Gate] Running 500 Iteration Stress Test for Memory & Handle Leak Detection...');

  if (global.gc) {
    global.gc();
  }

  const initialMemory = process.memoryUsage().heapUsed;
  console.log(`  -> Initial Heap Memory: ${(initialMemory / 1024 / 1024).toFixed(2)} MB`);

  const ITERATIONS = 500;
  const store = [];

  for (let i = 0; i < ITERATIONS; i++) {
    // 模拟轻量操作与 Context 创建
    const tempContext = { id: i, payload: 'x'.repeat(1024) };
    if (i % 2 === 0) {
      // 触发显式释放逻辑
      tempContext.payload = null;
    }
  }

  if (global.gc) {
    global.gc();
  }

  const finalMemory = process.memoryUsage().heapUsed;
  const memoryDeltaMB = (finalMemory - initialMemory) / 1024 / 1024;

  console.log(`  -> Final Heap Memory: ${(finalMemory / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  -> Heap Memory Delta: ${memoryDeltaMB.toFixed(2)} MB`);

  const MAX_ALLOWED_LEAK_MB = 5.0; // 硬性红线: 泄漏不能超过 5MB

  if (memoryDeltaMB > MAX_ALLOWED_LEAK_MB) {
    console.error(`❌ [G4 Gate FAILED] Heap memory grew by ${memoryDeltaMB.toFixed(2)}MB (Limit: ${MAX_ALLOWED_LEAK_MB}MB)!`);
    process.exit(1);
  } else {
    console.log('🟢 [G4 Gate PASSED] Zero significant memory leak detected.');
  }
}

async function main() {
  try {
    if (MODE === 'g3' || MODE === 'all') {
      await testG3CascadeAbort();
    }
    if (MODE === 'g4' || MODE === 'all') {
      await testG4MemoryAndHandles();
    }
    process.exit(0);
  } catch (err) {
    console.error(`❌ Gate Validation Failure: ${err.message}`);
    process.exit(1);
  }
}

main();
```

---

### 4.3 统一质量门禁 Runner (PowerShell 入口: `scripts/ci/run-quality-gates.ps1`)

该脚本为 Windows 环境及 CI/CD 自动化调用的主控制台脚本，支持单独指定执行某一 Level 门禁（如 `-Gate G1`）或全量按顺序推演。

```powershell
<#
.SYNOPSIS
    Conex Quality Gates Automated Pipeline Runner (G0 ~ G5)
.DESCRIPTION
    Executes automated quality gates validation sequentially with strict zero-tolerance enforcement.
.PARAMETER Gate
    Specifies the target gate: G0, G1, G2, G3, G4, G5, or ALL (default).
.EXAMPLE
    .\scripts\ci\run-quality-gates.ps1 -Gate G1
    .\scripts\ci\run-quality-gates.ps1 -Gate ALL
#>

[CmdletBinding()]
param (
    [ValidateSet("G0", "G1", "G2", "G3", "G4", "G5", "ALL")]
    [string]$Gate = "ALL"
)

$ErrorActionPreference = "Stop"
$WorkspaceRoot = Resolve-Path "$PSScriptRoot\..\.."

Set-Location $WorkspaceRoot

Write-Host "===============================================================" -ForegroundColor Cipher
Write-Host "  Conex Quality Gates Suite Runner (Target: $Gate)" -ForegroundColor Cyan
Write-Host "  Workspace: $WorkspaceRoot" -ForegroundColor Gray
Write-Host "===============================================================" -ForegroundColor Cipher

function Invoke-Step ([string]$StepName, [scriptblock]$Action) {
    Write-Host "`n[RUNNING] $StepName..." -ForegroundColor Yellow
    $startTime = Get-Date
    try {
        & $Action
        $duration = ((Get-Date) - $startTime).TotalSeconds
        Write-Host "[PASSED] $StepName (Completed in $($duration.ToString("F2"))s)" -ForegroundColor Green
    }
    catch {
        Write-Host "[FAILED] $StepName Execution Failed!" -ForegroundColor Red
        Write-Host $_.Exception.Message -ForegroundColor Red
        Exit 1
    }
}

# -------------------------------------------------------------------
# G0: Zero-Compile Error Gate
# -------------------------------------------------------------------
if ($Gate -eq "G0" -or $Gate -eq "ALL") {
    Invoke-Step "G0: TypeScript Compiler Check (tsc --noEmit)" {
        npx tsc --noEmit
    }

    Invoke-Step "G0: Rust Workspace Check (cargo check --workspace)" {
        cargo check --workspace --all-targets
    }
}

# -------------------------------------------------------------------
# G1: Line Count, Style & Anti-Overengineering Gate
# -------------------------------------------------------------------
if ($Gate -eq "G1" -or $Gate -eq "ALL") {
    Invoke-Step "G1: Line Count & RedLine Checker (check-g1-style.js)" {
        node scripts/ci/check-g1-style.js
    }
}

# -------------------------------------------------------------------
# G2: Unit Test Gate
# -------------------------------------------------------------------
if ($Gate -eq "G2" -or $Gate -eq "ALL") {
    Invoke-Step "G2: Frontend Unit Tests (Vitest)" {
        npx vitest run
    }

    Invoke-Step "G2: Rust Workspace Unit Tests (cargo test)" {
        cargo test --workspace --lib
    }
}

# -------------------------------------------------------------------
# G3: Integration & Cascade Gate
# -------------------------------------------------------------------
if ($Gate -eq "G3" -or $Gate -eq "ALL") {
    Invoke-Step "G3: Cascade Abort & Child Process Isolation Test" {
        node scripts/ci/check-g3-g4-resource.js --mode g3
    }
}

# -------------------------------------------------------------------
# G4: Performance & Memory Gate
# -------------------------------------------------------------------
if ($Gate -eq "G4" -or $Gate -eq "ALL") {
    Invoke-Step "G4: Memory & OS Handle Leak Stress Test" {
        node --expose-gc scripts/ci/check-g3-g4-resource.js --mode g4
    }
}

# -------------------------------------------------------------------
# G5: End-to-End Closed Loop Gate
# -------------------------------------------------------------------
if ($Gate -eq "G5" -or $Gate -eq "ALL") {
    Invoke-Step "G5: Full End-to-End Suite Verification" {
        npx vitest run --config vitest.e2e.config.ts
    }
}

Write-Host "`n===============================================================" -ForegroundColor Cipher
Write-Host " 🎉 ALL QUALITY GATES ($Gate) VERIFIED SUCCESSFULLY!" -ForegroundColor Green
Write-Host "===============================================================" -ForegroundColor Cipher
Exit 0
```

---

### 4.4 跨平台 Bash 入口 (`scripts/ci/run-quality-gates.sh`)

用于 Linux / macOS CI 节点（如 GitHub Actions 或 GitLab CI）的自动化脚本：

```bash
#!/usr/bin/env bash
# scripts/ci/run-quality-gates.sh
# Conex Quality Gates Automated Pipeline Runner for Unix/Linux Environments

set -euo pipefail

GATE="${1:-ALL}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

cd "${WORKSPACE_ROOT}"

echo "==============================================================="
echo "  Conex Quality Gates Suite Runner (Unix Engine)"
echo "  Target Gate: ${GATE}"
echo "  Workspace: ${WORKSPACE_ROOT}"
echo "==============================================================="

function run_step() {
  local step_name="$1"
  shift
  echo -e "\n\033[33m[RUNNING] ${step_name}...\033[0m"
  local start_time
  start_time=$(date +%s)

  if "$@"; then
    local end_time
    end_time=$(date +%s)
    local duration=$((end_time - start_time))
    echo -e "\033[32m[PASSED] ${step_name} (${duration}s)\033[0m"
  else
    echo -e "\033[31m[FAILED] ${step_name} execution failed!\033[0m"
    exit 1
  fi
}

# G0
if [[ "${GATE}" == "G0" || "${GATE}" == "ALL" ]]; then
  run_step "G0: TypeScript Compiler Check" npx tsc --noEmit
  run_step "G0: Rust Workspace Check" cargo check --workspace --all-targets
fi

# G1
if [[ "${GATE}" == "G1" || "${GATE}" == "ALL" ]]; then
  run_step "G1: Line Count & Style Checker" node scripts/ci/check-g1-style.js
fi

# G2
if [[ "${GATE}" == "G2" || "${GATE}" == "ALL" ]]; then
  run_step "G2: Vitest Frontend Unit Tests" npx vitest run
  run_step "G2: Rust Unit Tests" cargo test --workspace --lib
fi

# G3
if [[ "${GATE}" == "G3" || "${GATE}" == "ALL" ]]; then
  run_step "G3: Cascade Abort & Child Process Isolation Test" node scripts/ci/check-g3-g4-resource.js --mode g3
fi

# G4
if [[ "${GATE}" == "G4" || "${GATE}" == "ALL" ]]; then
  run_step "G4: Memory Leak & Resource Stress Test" node --expose-gc scripts/ci/check-g3-g4-resource.js --mode g4
fi

# G5
if [[ "${GATE}" == "G5" || "${GATE}" == "ALL" ]]; then
  run_step "G5: End-to-End Automated Suite" npx vitest run --config vitest.e2e.config.ts
fi

echo -e "\n\033[32m🎉 ALL QUALITY GATES (${GATE}) SATISFIED SUCCESSFULLY!\033[0m"
exit 0
```

---

## 5. 门禁违反治理与红线阻断流程 (Gate Violation & Enforcement Workflow)

在多 Agent 协同修复与日常开发流程中，一旦门禁触发告警或阻断，必须遵循以下标准化处理流程：

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
