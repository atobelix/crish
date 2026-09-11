# DIM-04 详案：三档权限集中化大刀阔斧重构与 Windows 路径归一执行详案

> **【权威标识】**：`docs/system-audit-and-redesign/detailed-plans/04-三档权限集中化与Windows路径归一执行详案.md`
> **编制角色**：【维度 4 详案架构师: DIM-04 三档权限集中化大刀阔斧重构与 Windows 路径归一执行详案】
> **前置必读规范**：`docs/system-audit-and-redesign/00-战役通则与协同执行规范.md`、`docs/system-audit-and-redesign/00-总方案-Conex全系统综合重构总计划框架.md`
> **核心裁决遵循**：严格遵循主控 6 大关键裁决，特别是 **RUL-03（完全访问真正信任 + 系统核心目录物理红线）** 与 **RUL-04（统一大写盘符 `C:/` + 正斜杠 `/` + UNC 异步隔离）**。
> **状态**：**权威执行详案定稿（Authoritative Detailed Plan）**。

---

## 目录（Table of Contents）

1. [维度定位与主控裁决基准（Executive Rulings & Strategic Architecture）](#一维度定位与主控裁决基准)
   - 1.1 DIM-04 核心定位与架构使命
   - 1.2 主控关键裁决绝对遵循（RUL-03 & RUL-04）
   - 1.3 现状病灶解构与根治目标（打破 6 套私设卡点死锁）
2. [纯逻辑演进时序与内部依赖拓扑（Pure Logical Dependency Topology）](#二纯逻辑演进时序与内部依赖拓扑)
   - 2.1 五阶段纯逻辑演进拓扑图
   - 2.2 各阶段内部任务单元与依赖关系
   - 2.3 关键风险点与防回归机制
3. [核心落地设计一：极简三档权限模型与集中化裁决引擎](#三核心落地设计一极简三档权限模型与集中化裁决引擎)
   - 3.1 极简三档权限模型权威定义与行为判定矩阵
   - 3.2 `ToolContext` 权限上下文下沉与全链路透传装配
   - 3.3 集中化权限裁决引擎（`PermissionDecisionEngine`）纯函数设计
   - 3.4 彻底拔除 `ShellCommandTool` & `shell_redirect.rs` 私设拦截卡点
   - 3.5 系统核心目录物理红线（`is_system_critical_path`）与临时目录白名单
4. [核心落地设计二：Windows 路径归一底座与 Junction 兼容（`ConexPathNormalizer`）](#四核心落地设计二windows-路径归一底座与-junction-兼容)
   - 4.1 Windows 路径处理四大深层病灶根治
   - 4.2 `ConexPathNormalizer` 结构设计（`C:/` 大写盘符 + 正斜杠 `/` + 剥离 `\\?\`）
   - 4.3 NTFS Junction / 目录联接点原生放行与安全判定
   - 4.4 UNC 网络路径探测异步隔离（`tokio::task::spawn_blocking`）
   - 4.5 路径包含性比对算法升级（`is_subpath_normalized`）
5. [核心落地设计三：纯对话无工作区显式建模与动态挂载协商](#五核心落地设计三纯对话无工作区显式建模与动态挂载协商)
   - 5.1 根治无工作区默认回退 `src-tauri` / `current_dir()` 毒瘤
   - 5.2 显式建模无工作区状态（`SessionWorkspaceState::Unbound`）
   - 5.3 “AI 提议 ➔ 用户授权 ➔ 动态挂载”全链路协议设计（`propose_workspace_mount`）
   - 5.4 动态挂载后的上下文即时热切换与 UI 响应
6. [改动文件与接口代码级实施规范（Code Blueprint & File Specifications）](#六改动文件与接口代码级实施规范)
   - 6.1 Rust 内核改动清单与接口实现
     - `crates/conex-fs/src/path_normalizer.rs`（新增）
     - `crates/conex-fs/src/path_utils.rs` / `lib.rs`（修改）
     - `crates/agent-tools/src/context.rs`（修改）
     - `crates/agent-tools/src/permission.rs` & `permission_engine.rs`（重构/新增）
     - `crates/agent-tools/src/tools/shell.rs`（重构）
     - `crates/agent-tools/src/tools/shell_redirect.rs`（重构）
     - `crates/agent-tools/src/tools/mod.rs`（重构）
     - `crates/agent-tools/src/tools/delete.rs`（适配）
     - `crates/agent-tools/src/tools/mount_workspace.rs`（新增）
     - `crates/session-loop/src/exec_single.rs` / `run_launch.rs`（修改）
   - 6.2 前端改动清单与接口实现
     - `apps/crish-desktop/src/api/permissionModes.ts`（简化为三档）
     - `apps/crish-desktop/src/store/permissionStore.ts`（状态流与持久化）
     - `apps/crish-desktop/src/store/workspaceStore.ts`（动态挂载 action）
     - `apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.tsx`（三档药丸）
     - `apps/crish-desktop/src/components/chat-composer/WorkspaceMountDialog.tsx`（挂载审批卡片）
7. [多维度协同演进视图（DIM-01 ~ DIM-07 联动）](#七多维度协同演进视图)
   - 7.1 与 DIM-01（Rust 内核事件与自愈状态机）的深度联动
   - 7.2 与 DIM-02（前端流式管道与交错时间线）的深度联动
   - 7.3 与 DIM-05（工具卡片摘要与输入输出分栏）的深度联动
   - 7.4 与 DIM-06（聊天框纯净化与 TS 插件解耦）的深度联动
   - 7.5 与 DIM-07（原生 ConPTY 纯终端与质量门禁）的深度联动
8. [测试矩阵与全量验收断言（Verification & QA Assertions）](#八测试矩阵与全量验收断言)
   - 8.1 Rust 单元测试用例清单（73+ 套件无缝绿灯）
   - 8.2 前端单元测试清单（Vitest）
   - 8.3 E2E 实机真机验收场景与 CDP 断言
   - 8.4 门禁验证与零回归保护清单

---

## 一、维度定位与主控裁决基准

### 1.1 DIM-04 核心定位与架构使命

在 Conex / Crish 的系统架构中，**DIM-04（三档权限集中化大刀阔斧重构与 Windows 路径归一）** 是整个执行体系与沙箱安全的地基。

过去的系统迭代在安全层面陷入了**“过度防御与私设卡点”**的恶性泥潭：

1. **多头统治、各自为政**：系统内部同时存在 `session-loop` 顶层门禁、`CommandGatekeeper` 静态黑名单、`shell_redirect.rs` 复合删除拦截、`RevertPolicy` Git 回退拦截、`conex-fs` 严格路径越界拦截等多达 6 套各自独立的防御逻辑；
2. **完全访问名不副实**：用户在 UI 明确授予了“完全访问模式”，期望 AI 自主跑测试、构建并清理临时输出，但底层 `shell_redirect.rs` 却因为检测到 `cargo test && rm temp.txt` 属于复合删除链而硬性拦截，导致自动化任务瞬间中断；
3. **Windows 路径四处暴雷**：`\\?\` UNC 扩展前缀导致字符串比较失效，小写盘符 `c:` 与大写盘符 `C:` 在 Rust 字节级 `strip_prefix` 时 panic 报错，合法 NTFS Junction（如 pnpm 软链）被一刀切误判为逃逸 symlink 阻断；
4. **无工作区状态盲目绑定**：纯对话未选工作区时，系统默认 fallback 到 `src-tauri` 目录作为沙箱根，导致 AI 试图在外部目录创建项目时被拦截，逼迫 AI 使用 PowerShell base64 绕过安全机制。

**DIM-04 的核心使命**：以大刀阔斧的重构决心，**彻底铲除伪沙箱与叶子工具私设卡点，建立 100% 单一真相源的极简三档权限模型，赋予“完全访问模式”真正的自主开发信任执行权，构建规范的大写盘符 `C:/` Windows 路径归一底座，打通“AI 提议 ➔ 用户授权 ➔ 动态挂载”合规通道！**

---

### 1.2 主控关键裁决绝对遵循

本执行详案必须**100% 严格遵循主控 6 大系统级裁决**中的以下关键条款：

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                               主控关键裁决与 DIM-04 落地映射矩阵                                       │
├─────────┬───────────────────────────────────┬──────────────────────────────────────────────────────────┤
│ 裁决编号│ 主控权威定夺方案                  │ DIM-04 架构落地与硬性约束                                │
├─────────┼───────────────────────────────────┼──────────────────────────────────────────────────────────┤
│ RUL-03  │ 完全访问真正信任 + 系统核心目录   │ • 完全访问模式彻底放行复合删除、间接执行、系统临时目录   │
│         │ 物理红线（`is_system_critical_path`│   清理与日常构建部署命令，零弹窗打扰；                   │
│         │ 硬拦截）                          │ • 保留系统核心目录物理红线（Windows/System32/Program Files│
│         │                                   │   及 Linux /bin,/etc,/usr），任何权限模式均不可豁免！    │
├─────────┼───────────────────────────────────┼──────────────────────────────────────────────────────────┤
│ RUL-04  │ 全仓统一大写盘符 `C:/...` + 正斜杠 │ • 废除历史小写盘符提案，全仓强制规范化为 `C:/...`；      │
│         │ `/`，UNC 网络探测封装于           │ • 统一剥离 `\\?\` 与 `\\?\UNC\` 前缀；                   │
│         │ `spawn_blocking` 异步隔离         │ • 遇到 UNC 共享路径探测（I/O）时，强制置于 Tokio 阻塞    │
│         │                                   │   线程池 `spawn_blocking`，防止 Tokio Worker 线程饥饿。  │
└─────────┴───────────────────────────────────┴──────────────────────────────────────────────────────────┘
```

---

### 1.3 现状病灶解构与根治目标

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                        重构前：6 套碎片化私设卡点 ➔ 重构后：单一真相源集中化裁决                       │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 【重构前 混乱现状】                                                                                    │
│   UI (4 模式) ──► session-loop ──► CommandGatekeeper ──► shell_redirect (复合删除整链硬拦截)          │
│                       │                   │                     │                                      │
│                       └──► 遗漏权限字段   └──► 静态正则误杀     └──► 临时目录越界硬拦截                │
│                                                                                                        │
│ 【重构后 极简架构】                                                                                    │
│   UI (3 模式) ──► PermissionDecisionEngine (唯一真相源纯函数)                                          │
│                       │                                                                                │
│                       ▼ 注入 ToolContext.permission_mode                                               │
│   All Leaf Tools (Shell / FS / Delete / Mount)                                                         │
│     ├── 1. 计划模式 (Plan): 仅只读工具放行，写类静默拦截 (Soft-Deny)                                   │
│     ├── 2. 标准模式 (Standard): 工作区内读写自动放行，跨目录/危险操作走 AskChannel 审批              │
│     └── 3. 完全访问 (FullAccess): 100% 放行复合删除与临时清理，仅拦截 is_system_critical_path 物理红线│
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 二、纯逻辑演进时序与内部依赖拓扑

本方案严格遵循纯逻辑演进时序，所有任务单元按照严格的无环有向图（DAG）分步实施，杜绝跨阶段逻辑悬空。

### 2.1 五阶段纯逻辑演进拓扑图

```mermaid
graph TD
    subgraph Phase 1: 路径归一与底座基准 (ConexPathNormalizer)
        P1_1[1.1 新增 ConexPathNormalizer 模块]
        P1_2[1.2 统一大写盘符 C:/ 与正斜杠规范化]
        P1_3[1.3 NTFS Junction 判定与安全穿透]
        P1_4[1.4 UNC 网络路径 spawn_blocking 异步隔离]
        P1_1 --> P1_2 --> P1_3 --> P1_4
    end

    subgraph Phase 2: 权限体系与上下文集中化 (Permission Core)
        P2_1[2.1 极简三档权限模型定义: Plan / Standard / FullAccess]
        P2_2[2.2 ToolContext 扩展注入 permission_mode]
        P2_3[2.3 集中式 PermissionDecisionEngine 纯函数裁决总线]
        P2_4[2.4 系统核心目录物理红线 is_system_critical_path 确立]
        P2_1 --> P2_2 --> P2_3 --> P2_4
    end

    subgraph Phase 3: 工具链私设卡点拔除与完全信任执行 (Tools Overhaul)
        P3_1[3.1 重构 ShellCommandTool: 接入 permission_mode 分流]
        P3_2[3.2 重构 shell_redirect.rs: 拔除复合删除拦截与放行间接执行]
        P3_3[3.3 建立系统临时目录与构建缓存清理放行白名单]
        P3_4[3.4 重构 delete.rs / fs 工具链: 统一归一化路径与沙箱判定]
        P3_1 --> P3_2 --> P3_3 --> P3_4
    end

    subgraph Phase 4: 无工作区显式建模与动态挂载协商 (Workspace & Mount)
        P4_1[4.1 彻底根除无工作区 fallback 到 src-tauri]
        P4_2[4.2 显式建模 SessionWorkspaceState::Unbound]
        P4_3[4.3 实现 propose_workspace_mount 工具与 IPC 通信]
        P4_4[4.4 前端 WorkspaceMountDialog 审批交互与 store 联动]
        P4_1 --> P4_2 --> P4_3 --> P4_4
    end

    subgraph Phase 5: 前端权限 Store 收敛与全量门禁闭环 (Frontend & Verification)
        P5_1[5.1 前端 permissionModes.ts 简化收敛为三档]
        P5_2[5.2 permissionStore 与 PermissionModeMenu 交互更新]
        P5_3[5.3 Rust & TS 全量单元测试矩阵覆盖]
        P5_4[5.4 CDP 9222 实机自动化无死锁验收]
        P5_1 --> P5_2 --> P5_3 --> P5_4
    end

    Phase 1 --> Phase 2
    Phase 2 --> Phase 3
    Phase 1 --> Phase 4
    Phase 2 --> Phase 4
    Phase 3 --> Phase 5
    Phase 4 --> Phase 5
```

---

### 2.2 各阶段内部任务单元与依赖关系

| 阶段        | 任务编号 | 任务名称                     | 内部依赖 | 交付产物与核心目标                                                  |
| :---------- | :------- | :--------------------------- | :------- | :------------------------------------------------------------------ |
| **Phase 1** | T-P1.1   | `ConexPathNormalizer` 新增   | 无       | `crates/conex-fs/src/path_normalizer.rs` 实现路径大写盘符与斜杠归一 |
|             | T-P1.2   | `safe_canonicalize` 升级     | T-P1.1   | 剥离 `\\?\`，返回归一化大写 `C:/...` 路径                           |
|             | T-P1.3   | NTFS Junction 安全放行       | T-P1.2   | `is_junction_or_symlink` 区分，放行 pnpm 等工作区内合规联接点       |
|             | T-P1.4   | UNC 异步隔离                 | T-P1.1   | 将 UNC 网络存在性与可达性检查包装进 `spawn_blocking`                |
| **Phase 2** | T-P2.1   | 三档权限模型枚举定义         | 无       | 确立 `PermissionMode::Plan` / `Ask` / `FullAccess`                  |
|             | T-P2.2   | `ToolContext` 注入字段       | T-P2.1   | `crates/agent-tools/src/context.rs` 增加 `pub permission_mode`      |
|             | T-P2.3   | `PermissionDecisionEngine`   | T-P2.1   | `crates/agent-tools/src/permission_engine.rs` 纯函数裁决            |
|             | T-P2.4   | `is_system_critical_path`    | T-P1.2   | 确立绝对不可破坏的系统目录物理红线                                  |
| **Phase 3** | T-P3.1   | `ShellCommandTool` 改造      | T-P2.2   | 依据 `ctx.permission_mode` 进行三路分流                             |
|             | T-P3.2   | 拔除复合删除私设卡点         | T-P3.1   | 废除 `has_non_delete_segment` 机械拦截，FullAccess 模式放行         |
|             | T-P3.3   | 临时目录白名单放行           | T-P1.2   | `is_safe_temp_or_cache_path` 放行系统 Temp 与构建缓存清理           |
|             | T-P3.4   | 统一 FS 工具路径校验         | T-P1.2   | `resolve_workspace_path` 全面迁移至 `ConexPathNormalizer`           |
| **Phase 4** | T-P4.1   | 根除 `src-tauri` 回退        | 无       | 改造 `exec_single.rs` / `run_launch.rs`，禁用 `current_dir()` 兜底  |
|             | T-P4.2   | 建模 `SessionWorkspaceState` | T-P4.1   | 显式建模 `Bound(PathBuf)` 与 `Unbound`                              |
|             | T-P4.3   | `propose_workspace_mount`    | T-P4.2   | 注册提议挂载新目录工具与内核事件广播                                |
|             | T-P4.4   | 前端挂载卡片与 Store 联动    | T-P4.3   | `WorkspaceMountDialog.tsx` 与 `workspaceStore` 动态更新             |
| **Phase 5** | T-P5.1   | 前端权限模式收敛             | T-P2.1   | `permissionModes.ts` 收拢为三档，废除 `deep` 历史冗余               |
|             | T-P5.2   | UI 药丸与持久化适配          | T-P5.1   | `PermissionModeMenu.tsx` 药丸胶囊渲染与 localStorage 对齐           |
|             | T-P5.3   | 自动化单元测试矩阵           | T-P3.4   | 覆盖 73+ Rust 测试套件与 TS 门禁                                    |
|             | T-P5.4   | CDP 9222 真机联调验收        | 全部     | 启动桌面 WebView2，实测长程自主开发、复合删除与挂载交互             |

---

## 三、核心落地设计一：极简三档权限模型与集中化裁决引擎

### 3.1 极简三档权限模型权威定义与行为判定矩阵

全系统（前端 UI、IPC 协议通道、Rust 内核及叶子工具）统一收拢为**极简三档权限模型（Three-Tier Unified Permission Model）**：

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              极简三档权限模型全要素行为判定矩阵                                        │
├──────────────┬──────────────────┬─────────────────────────────┬──────────────────┬─────────────────────┤
│ 权限模式     │ 中文名称 / 定位 │ 工具与操作许可范围          │ 审批与拦截表现   │ 典型适用场景        │
├──────────────┼──────────────────┼─────────────────────────────┼──────────────────┼─────────────────────┤
│ **Plan**     │ **计划 (只读)**  │ • 仅允许只读工具（read_file,│ • 任何写文件、   │ • 探索调研、方案设计│
│ (Read-Only)  │ 纯只读探索与规划 │   search, list_dir, diff 等）│   删除、Shell 执行│ • 代码审计、只读评审│
│              │ 零写盘风险       │ • 严禁任何写文件/删除/Shell │   均静默拒绝     │ • 零弹窗打扰保证专注│
│              │                  │ • 允许 resolve_output_dir   │   (Soft-Deny)    │                     │
├──────────────┼──────────────────┼─────────────────────────────┼──────────────────┼─────────────────────┤
│ **Standard** │ **标准 (需确认)**│ • 工作区内日常读写、编译、  │ • 工作区内自动   │ • 默认日常协作开发  │
│ (Ask /       │ 默认安全作业     │   单元测试自动放行；        │   放行；         │ • 开发者在旁监督    │
│  Workspace)  │ 危险操作需审批   │ • 单纯删除操作移入回收站；  │ • 跨目录写操作、 │ • 兼顾效率与安全性  │
│              │                  │ • 跨工作区操作与危险命令需  │   Git 强推等弹出 │                     │
│              │                  │   经 AskChannel 由用户确认  │   温润审批卡片   │                     │
├──────────────┼──────────────────┼─────────────────────────────┼──────────────────┼─────────────────────┤
│ **FullAccess**│ **完全访问**     │ • **100% 自动放行**复合删除 │ • **零弹窗打扰**，│ • 长程无人值守任务  │
│ (Autonomous/ │ 完全信任自主执行 │   （如 cargo test && rm ..）│   赋予 AI 真正的 │ • 自动化构建与重构  │
│  Full)       │ 彻底放行自动化   │ • **100% 自动放行**间接执行 │   开发自主权；   │ • 批量测试与环境部署│
│              │                  │ • **100% 自动放行**临时清理 │ • **仅硬拦截确定 │                     │
│              │                  │ • **100% 自动放行**环境部署 │   性毁灭红线**   │                     │
└──────────────┴──────────────────┴─────────────────────────────┴──────────────────┴─────────────────────┘
```

---

### 3.2 `ToolContext` 权限上下文下沉与全链路透传装配

在 `crates/agent-tools/src/context.rs` 中，将 `permission_mode` 作为一等公民显式加入 `ToolContext`：

```rust
// crates/agent-tools/src/context.rs

use crate::permission::PermissionMode;
use std::path::PathBuf;
use std::sync::Arc;

/// 会话级工具执行上下文
#[derive(Debug, Clone)]
pub struct ToolContext {
    /// 会话唯一标识
    pub session_id: String,
    /// 中止令牌
    pub abort_token: AbortToken,
    /// 审批回调通道（Standard 模式接线，FullAccess 模式为 NoopAskChannel，Plan 模式为 None）
    pub ask: Option<AskCallback>,
    /// 工作区根目录（绝对规范化大写盘符路径）
    pub workspace_root: PathBuf,

    // ⭐【DIM-04 核心新增】：当前会话生效的权限模式，一等公民向下透传
    pub permission_mode: PermissionMode,

    /// 写路径互斥注册表
    pub write_claims: Option<Arc<WritePathRegistry>>,
    /// 写声明持有者
    pub write_claim_holder: Option<String>,
    /// 探索类文档配额检查
    pub explore_docs_quota: Option<ExploreDocsQuotaContext>,
    /// 后台任务管理器
    pub background: Option<Arc<dyn crate::background::BackgroundTaskManager>>,
    /// 产出目录解析服务
    pub output_dir: Option<Arc<dyn crate::tools::output_dir::OutputDirResolver>>,
    /// 会话日志根目录
    pub log_root: Option<PathBuf>,
    /// 压缩块只读存储
    pub compression_store: Option<Arc<dyn crate::compression_store::CompressionContextStore>>,
    /// 笔记协同后端
    pub note_backend: Option<Arc<dyn crate::note_backend::NoteBackend>>,
    /// 工具调用 ID
    pub tool_call_id: Option<String>,
}
```

在 `crates/session-loop/src/exec_single.rs` 中完成权限模式的装配与透传：

```rust
// crates/session-loop/src/exec_single.rs:248-285

let resolved_mode = options.permission_mode.unwrap_or(PermissionMode::Ask);

let ask: Option<AskCallback> = match resolved_mode {
    PermissionMode::FullAccess => Some(Arc::new(NoopAskChannel)),
    PermissionMode::Plan => None, // 计划模式不发起审批，直接走 Soft-Deny
    PermissionMode::Ask => approval.as_ref().map(|gate| {
        let channel = Arc::new(ApprovalChannel::new(
            Arc::clone(gate),
            &call.id,
            abort.cloned(),
            abort_token.clone(),
            requester.clone(),
        ));
        approval_channel = Some(Arc::clone(&channel));
        channel as AskCallback
    }),
};

let tool_ctx = ToolContext {
    session_id: ctx.session_id.clone(),
    abort_token,
    ask,
    workspace_root: effective_workspace_root,
    permission_mode: resolved_mode, // ⭐ 注入真实权限模式
    write_claims: ctx.write_claims.clone(),
    write_claim_holder: Some(ctx.run_id.clone()),
    explore_docs_quota: quota_ctx,
    background: ctx.background.clone(),
    output_dir: ctx.output_dir.clone(),
    log_root: ctx.log_root.clone(),
    compression_store: ctx.compression_store.clone(),
    note_backend: ctx.note_backend.clone(),
    tool_call_id: Some(call.id.clone()),
};
```

---

### 3.3 集中化权限裁决引擎（`PermissionDecisionEngine`）

废除散落在各处的判定逻辑，统一收拢为无副作用的纯函数裁决引擎：

```rust
// crates/agent-tools/src/permission_engine.rs

use crate::permission::{PermissionMode, PermissionVerdict};

pub struct PermissionDecisionEngine;

impl PermissionDecisionEngine {
    /// 全系统统一的权限判定核心函数
    #[inline]
    pub fn evaluate(
        mode: PermissionMode,
        is_redline: bool,
        is_dangerous: bool,
        requires_approval: bool,
        is_out_of_workspace: bool,
    ) -> PermissionVerdict {
        // 1. 系统毁灭级红线绝对优先拦截（任何模式均不可豁免）
        if is_redline {
            return PermissionVerdict::Deny;
        }

        // 2. 按三档模式执行清晰分流
        match mode {
            PermissionMode::Plan => {
                // 计划模式：只要涉及写、危险、越界或审批需求，一律静默拒绝
                if is_dangerous || requires_approval || is_out_of_workspace {
                    PermissionVerdict::Deny
                } else {
                    PermissionVerdict::Allow
                }
            }
            PermissionMode::FullAccess => {
                // 完全访问模式：除绝对物理红线外，全量放行
                PermissionVerdict::Allow
            }
            PermissionMode::Ask => {
                // 标准模式：危险操作、跨目录操作或需要审批的操作升级为审批请求
                if is_dangerous || requires_approval || is_out_of_workspace {
                    PermissionVerdict::NeedsApproval
                } else {
                    PermissionVerdict::Allow
                }
            }
        }
    }
}
```

---

### 3.4 彻底拔除 `ShellCommandTool` & `shell_redirect.rs` 私设拦截卡点

#### 1. `ShellCommandTool::prepare` 彻底重构

在 `crates/agent-tools/src/tools/shell.rs` 中重构安全检查逻辑：

```rust
// crates/agent-tools/src/tools/shell.rs

async fn prepare(&self, ctx: &ToolContext, args: &serde_json::Value) -> Prepared {
    let command = match require_string(args, "command") {
        Ok(c) => c.trim().to_string(),
        Err(e) => return Prepared::Done(Err(e)),
    };
    if command.is_empty() {
        return Prepared::Done(Err(ToolError::invalid_input("command must be a non-empty string")));
    }
    if command.len() > MAX_COMMAND_LEN {
        return Prepared::Done(Err(ToolError::invalid_input("command too long")));
    }

    let workspace_root = &ctx.workspace_root;
    let cwd = match resolve_workspace_path(
        workspace_root,
        &optional_string(args, "cwd").unwrap_or_else(|| ".".to_string()),
    ) {
        Ok(c) => c,
        Err(e) => return Prepared::Done(Err(e)),
    };

    if !cwd.is_dir() {
        return Prepared::Done(Err(ToolError::invalid_input(format!(
            "cwd is not a directory: {}",
            display_path(workspace_root, &cwd)
        ))));
    }

    // 1. 系统核心物理红线检查（格式化硬盘、清空系统目录等，全模式拦截）
    let gatekeeper = CommandGatekeeper::new();
    let cwd_str = gate_path(&cwd);
    let root_str = gate_path(workspace_root);
    let verdict = gatekeeper.check_command_with_context(&command, &[], &cwd_str, &root_str);

    if verdict == GatekeeperResult::Blocked || gatekeeper.patterns().is_match(&command) {
        emit_blocked_audit(
            &self.audit_sink,
            ctx,
            SecurityAuditOperation::CommandExec,
            vec![command.clone()],
        );
        return Prepared::Done(Err(ToolError::new(
            TOOL_COMMAND_BLOCKED,
            format!("PermissionDenied: Command blocked by critical system destruction red-line: {command}"),
        )));
    }

    // 2. 根据 ToolContext.permission_mode 分流
    match ctx.permission_mode {
        PermissionMode::Plan => {
            // 只读计划模式：静默拒绝执行任何 Shell 命令
            return Prepared::Done(Err(ToolError::new(
                TOOL_COMMAND_BLOCKED,
                "PermissionDenied: Shell command execution is prohibited in Plan (Read-Only) mode.",
            )));
        }

        PermissionMode::FullAccess => {
            // ⭐【DIM-04 核心裁决 RUL-03】：完全访问模式真正赋予完全信任！
            // 彻底放行复合删除链（cargo test && rm ...）、间接执行与临时目录清理
            // 不进入 redirect_or_intercept_delete 的拦截分支，直接准备执行！
            tracing::info!(
                session_id = %ctx.session_id,
                command = %command,
                "FullAccess mode: Bypassing shell delete interceptions with true user trust"
            );
        }

        PermissionMode::Ask => {
            // 标准模式：安全的删除重定向与审批流程
            let analysis = conex_sandbox::semantics::analyze(&command);
            if analysis.overall_class == CommandClass::DeleteShape || analysis.has_indirect_delete {
                return Prepared::Done(redirect_or_intercept_delete(
                    &analysis,
                    &command,
                    workspace_root,
                    &cwd,
                    self.trash_root.clone(),
                    ctx,
                    Arc::clone(&self.audit_sink),
                ));
            }

            if let Some(err) = intercept_cd_shape(&analysis, &command) {
                return Prepared::Done(Err(err));
            }

            // 审批门禁
            if verdict == GatekeeperResult::RequiresApproval {
                match &ctx.ask {
                    Some(ask) => match ask.ask(&self.def.name, args).await {
                        Ok(AskDecision::Allowed) => {}
                        Ok(AskDecision::Denied { reason }) => {
                            return Prepared::Done(Err(ToolError::new(
                                TOOL_USER_DENIED,
                                format!("user denied: {reason}"),
                            )));
                        }
                        Err(err) => return Prepared::Done(Err(err)),
                    },
                    None => {
                        return Prepared::Done(Err(ToolError::new(
                            TOOL_REQUIRES_APPROVAL,
                            format!("Command requires approval: {command}"),
                        )));
                    }
                }
            }
        }
    }

    // 构造就绪执行对象
    Prepared::Run(PreparedCommand {
        command,
        cwd,
        timeout_ms: optional_u64(args, "timeoutMs").unwrap_or(self.default_timeout_ms).clamp(1, MAX_TIMEOUT_MS),
        max_output_bytes: clamp_u64_to_usize(optional_u64(args, "maxOutputBytes").unwrap_or(self.max_output_bytes as u64)),
        mode: parse_mode(args).unwrap_or(ShellMode::Auto),
        wait_ms: optional_u64(args, "waitMsBeforeAsync").unwrap_or(DEFAULT_WAIT_MS_BEFORE_ASYNC).clamp(1, MAX_TIMEOUT_MS),
        is_daemon: optional_bool(args, "isDaemon").unwrap_or(false),
        resource_monitor: optional_bool(args, "resourceMonitor").unwrap_or(false),
        manager: ctx.background.clone().or_else(|| self.background_manager.clone()),
    })
}
```

#### 2. `shell_redirect.rs` 改造：放行临时目录与降级审批

在 `crates/agent-tools/src/tools/shell_redirect.rs` 中：

1. **完全访问模式下直接短路放行**；
2. **标准模式下，遇到复合删除段时若无法安全拆分，发起 `ctx.ask` 用户审批，而不是粗暴抛错**；
3. **放行系统临时目录与构建缓存目录的物理清理**：

```rust
// crates/agent-tools/src/tools/shell_redirect.rs

/// 判定目标路径是否位于系统安全临时目录或构建缓存内
pub fn is_safe_temp_or_cache_path(path: &Path) -> bool {
    let normalized = ConexPathNormalizer::normalize(path);
    let path_str = normalized.to_string_lossy().to_uppercase();

    // 1. Windows Temp / AppData Local Temp
    if let Ok(temp_dir) = std::env::temp_dir().canonicalize() {
        let norm_temp = ConexPathNormalizer::normalize(&temp_dir);
        if ConexPathNormalizer::is_subpath(&normalized, &norm_temp) {
            return true;
        }
    }

    // 2. 常见工程临时与缓存特征路径
    if path_str.contains("/TARGET/TMP")
        || path_str.contains("/.CRISH-TRASH/")
        || path_str.contains("/NODE_MODULES/.CACHE/")
        || path_str.contains("/APPDATA/LOCAL/TEMP/")
    {
        return true;
    }

    false
}
```

---

### 3.5 系统核心目录物理红线（`is_system_critical_path`）

依据裁决 **RUL-03**，完全访问模式给予日常开发完全信任，但必须确立**绝对不可破坏的系统目录物理红线**。任何模式下试图删除或覆写系统关键目录，均直接硬性拦截：

```rust
// crates/conex-fs/src/path_normalizer.rs

impl ConexPathNormalizer {
    /// 检查路径是否命中系统核心关键目录（物理红线）
    pub fn is_system_critical_path(path: &Path) -> bool {
        let normalized = Self::normalize(path);
        let s = normalized.to_string_lossy();
        let upper = s.to_ascii_uppercase();

        #[cfg(windows)]
        {
            // Windows 盘符根与系统关键目录
            if upper.len() <= 3 && upper.ends_with(":/") {
                return true; // 拦截 "C:/" 整个盘符根
            }

            let critical_prefixes = [
                "C:/WINDOWS",
                "C:/PROGRAM FILES",
                "C:/PROGRAM FILES (X86)",
                "C:/PROGRAMDATA/MICROSOFT",
                "C:/SYSTEM VOLUME INFORMATION",
                "C:/RECOVERY",
                "C:/BOOT",
            ];

            for prefix in &critical_prefixes {
                if upper == *prefix || upper.starts_with(&format!("{prefix}/")) {
                    return true;
                }
            }
        }

        #[cfg(not(windows))]
        {
            // POSIX 系统关键目录
            if s == "/" {
                return true;
            }

            let critical_prefixes = [
                "/BIN", "/SBIN", "/USR/BIN", "/USR/SBIN",
                "/ETC", "/BOOT", "/DEV", "/PROC", "/SYS",
                "/LIB", "/LIB64", "/VAR/RUN",
            ];

            for prefix in &critical_prefixes {
                if upper == *prefix || upper.starts_with(&format!("{prefix}/")) {
                    return true;
                }
            }
        }

        false
    }
}
```

---

## 四、核心落地设计二：Windows 路径归一底座与 Junction 兼容

### 4.1 Windows 路径处理四大深层病灶根治

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              Windows 路径四大深层缺陷与治理方案                                        │
├─────────┬──────────────────────────────┬───────────────────────────────────────────────────────────────┤
│ 缺陷编号│ 缺陷现象与根本原因           │ DIM-04 统一治理方案                                           │
├─────────┼──────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ BUG-01  │ Verbatim UNC `\\?\` 失配     │ `ConexPathNormalizer::strip_verbatim_prefix` 统一剥离 `\\?\`  │
│         │ canonicalize 导致字符串失配  │ 与 `\\?\UNC\` 前缀，返回标准化 POSIX 风格路径。              │
├─────────┼──────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ BUG-02  │ 盘符大小写冲突崩溃           │ 【RUL-04 裁决】强制全仓统一为大写盘符 `C:/...`，              │
│         │ `c:` vs `C:` 导致 strip panic│ 在所有输入边界与 canonicalize 后完成大写与正斜杠转换。        │
├─────────┼──────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ BUG-03  │ NTFS Junction 误杀阻断       │ 升级 symlink 判定：对指向工作区内的 NTFS Junction 正常跟随放行│
│         │ pnpm 依赖联接点被当逃逸 symlink│ 仅拦截真正逃逸到工作区外的非法 symlink。                      │
├─────────┼──────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ BUG-04  │ UNC 网络探测阻塞 Tokio 线程  │ 【RUL-04 裁决】将 UNC `\\server\share` 的网络 I/O 探测放入    │
│         │ 网络抖动导致 Worker 线程饥饿 │ `tokio::task::spawn_blocking`，确保异步运行时平稳。           │
└─────────┴──────────────────────────────┴───────────────────────────────────────────────────────────────┘
```

---

### 4.2 `ConexPathNormalizer` 结构设计（`C:/` 大写盘符 + 正斜杠 `/`）

新建 `crates/conex-fs/src/path_normalizer.rs`：

```rust
// crates/conex-fs/src/path_normalizer.rs

use std::path::{Component, Path, PathBuf, Prefix};

pub struct ConexPathNormalizer;

impl ConexPathNormalizer {
    /// 核心规范化：剥离 \\?\ 前缀、统一正斜杠 /、Windows 盘符统一大写 (C:/)、消除冗余 . 与 ..
    pub fn normalize(path: &Path) -> PathBuf {
        let path_str = path.to_string_lossy();
        let stripped = Self::strip_verbatim_prefix(&path_str);

        let p = Path::new(&stripped);
        let mut normalized_components = Vec::new();
        let mut has_disk_prefix = false;

        for component in p.components() {
            match component {
                Component::Prefix(prefix_comp) => {
                    match prefix_comp.kind() {
                        Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => {
                            // ⭐【RUL-04 权威裁决】：强制统一大写盘符 (C:)
                            let upper_drive = (letter as char).to_ascii_uppercase();
                            normalized_components.push(format!("{upper_drive}:"));
                            has_disk_prefix = true;
                        }
                        Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => {
                            normalized_components.push(format!(
                                "//{}/{}",
                                server.to_string_lossy(),
                                share.to_string_lossy()
                            ));
                        }
                        _ => {
                            normalized_components.push(prefix_comp.as_os_str().to_string_lossy().to_string());
                        }
                    }
                }
                Component::RootDir => {
                    if !has_disk_prefix && normalized_components.is_empty() {
                        normalized_components.push("".to_string());
                    }
                }
                Component::CurDir => {}
                Component::ParentDir => {
                    // 安全词法弹出
                    if !normalized_components.is_empty() && normalized_components.last().map(|s| s.as_str()) != Some("..") {
                        if !has_disk_prefix || normalized_components.len() > 1 {
                            normalized_components.pop();
                        }
                    } else {
                        normalized_components.push("..".to_string());
                    }
                }
                Component::Normal(name) => {
                    normalized_components.push(name.to_string_lossy().to_string());
                }
            }
        }

        // 统一用正斜杠 '/' 拼接
        if normalized_components.is_empty() {
            return PathBuf::from(".");
        }

        let mut result_str = String::new();
        for (i, comp) in normalized_components.iter().enumerate() {
            if i == 0 {
                result_str.push_str(comp);
                if comp.ends_with(':') {
                    result_str.push('/');
                }
            } else {
                if !result_str.ends_with('/') {
                    result_str.push('/');
                }
                result_str.push_str(comp);
            }
        }

        PathBuf::from(result_str)
    }

    /// 剥离 Windows \\?\、\\?\UNC\ 以及 \\.\ 前缀
    pub fn strip_verbatim_prefix(s: &str) -> String {
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            format!("//{rest}").replace('\\', "/")
        } else if let Some(rest) = s.strip_prefix(r"\\?\") {
            rest.replace('\\', "/")
        } else if let Some(rest) = s.strip_prefix(r"\\.\") {
            rest.replace('\\', "/")
        } else {
            s.replace('\\', "/")
        }
    }

    /// 跨平台安全的子路径归一化判定（大小写不敏感，大写盘符与斜杠一致）
    pub fn is_subpath(candidate: &Path, root: &Path) -> bool {
        let norm_candidate = Self::normalize(candidate);
        let norm_root = Self::normalize(root);

        let cand_str = norm_candidate.to_string_lossy().replace('\\', "/");
        let root_str = norm_root.to_string_lossy().replace('\\', "/");

        let cand_upper = cand_str.to_ascii_uppercase();
        let root_upper = root_str.to_ascii_uppercase();

        if cand_upper == root_upper {
            return true;
        }

        let prefix = if root_upper.ends_with('/') {
            root_upper
        } else {
            format!("{root_upper}/")
        };

        cand_upper.starts_with(&prefix)
    }
}
```

---

### 4.3 NTFS Junction / 目录联接点原生放行

在 `crates/agent-tools/src/tools/mod.rs` 中重构 `has_symlink_below_root`，放行指向工作区内部的合法 Junction：

```rust
// crates/agent-tools/src/tools/mod.rs

/// 符号链接与 Junction 安全穿透检查：
/// - 若为 NTFS Junction 或 Symlink，尝试解析其实际物理目标；
/// - 若物理目标依然在工作区内部（例如 pnpm 内部链接），放行执行；
/// - 若物理目标逃逸出工作区，则拦截并报 TOOL_PATH_ESCAPE。
fn has_escaping_symlink_below_root(path: &Path, root: &Path) -> bool {
    let norm_path = conex_fs::path_normalizer::ConexPathNormalizer::normalize(path);
    let norm_root = conex_fs::path_normalizer::ConexPathNormalizer::normalize(root);

    let rel = match norm_path.strip_prefix(&norm_root) {
        Ok(r) => r,
        Err(_) => return false,
    };

    let mut cur = norm_root.clone();
    for comp in rel.components() {
        if let std::path::Component::Normal(name) = comp {
            cur.push(name);
            if let Ok(meta) = std::fs::symlink_metadata(&cur) {
                if meta.file_type().is_symlink() {
                    // 解析符号链接/Junction 的真实目标
                    if let Ok(target) = std::fs::read_link(&cur) {
                        let resolved_target = if target.is_absolute() {
                            conex_fs::path_normalizer::ConexPathNormalizer::normalize(&target)
                        } else {
                            conex_fs::path_normalizer::ConexPathNormalizer::normalize(&cur.parent().unwrap_or(&norm_root).join(target))
                        };

                        // 判定目标是否在工作区内
                        if !conex_fs::path_normalizer::ConexPathNormalizer::is_subpath(&resolved_target, &norm_root) {
                            tracing::warn!(
                                link = %cur.display(),
                                target = %resolved_target.display(),
                                "Escaping symlink/junction detected outside workspace root"
                            );
                            return true; // 逃逸，拦截
                        }
                    }
                }
            }
        }
    }

    false
}
```

---

### 4.4 UNC 网络路径探测异步隔离

在异步 Tokio 运行时中直接对 `\\server\share` 执行 `std::fs::metadata` 会导致网络延迟挂起 Tokio Worker 线程。依裁决 **RUL-04**，将其封装为 `spawn_blocking`：

```rust
// crates/conex-fs/src/path_normalizer.rs

/// 异步安全探测 UNC 路径（防止阻塞 Tokio 调度器）
pub async fn check_unc_path_async(path: PathBuf) -> Result<bool, std::io::Error> {
    tokio::task::spawn_blocking(move || {
        let norm = ConexPathNormalizer::normalize(&path);
        let s = norm.to_string_lossy();
        if s.starts_with("//") {
            // UNC 路径存在性探测
            Ok(norm.exists())
        } else {
            Ok(norm.exists())
        }
    })
    .await
    .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?
}
```

---

## 五、核心落地设计三：纯对话无工作区显式建模与动态挂载协商

### 5.1 根治无工作区默认回退 `src-tauri` 毒瘤

彻底删除 `crates/session-loop/src/exec_single.rs:280` 与 `run_launch.rs` 中使用 `std::env::current_dir()` 作为工作区兜底的代码。

### 5.2 显式建模无工作区状态（`SessionWorkspaceState::Unbound`）

在内核中引入清晰的状态建模：

```rust
// crates/session-loop/src/workspace_state.rs

use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionWorkspaceState {
    /// 绑定具体工作区路径
    Bound(PathBuf),
    /// 纯对话无工作区（General Chat）
    Unbound,
}
```

在 `SessionWorkspaceState::Unbound` 下：

1. **只读工具（`read_file`, `search`, `list_dir`）**：传入合法绝对路径时直接放行读取，方便用户咨询系统现有配置或文件；
2. **写类工具（`write_file`, `replace`）与 Shell 工具**：若 AI 欲在某一新目录建立项目，**禁止私自静默写盘或回退宿主目录**，必须触发标准合规的 **`propose_workspace_mount`** 提议。

---

### 5.3 “AI 提议 ➔ 用户授权 ➔ 动态挂载”全链路设计

```mermaid
sequenceDiagram
    autonumber
    actor User as 用户 (User)
    participant UI as 前端桌面 (Crish Desktop)
    participant Loop as 会话循环 (Session Loop)
    participant Tool as propose_workspace_mount

    Note over Loop: 纯对话无工作区 (Unbound) 状态
    AI->>Tool: 调用 propose_workspace_mount(path: "C:/Projects/my-app", reason: "创建新前端项目")
    Tool->>Loop: 发起挂载提议事件 (workspace-mount-requested)
    Loop->>UI: IPC 广播: { type: "workspace-mount-requested", path: "C:/Projects/my-app", reason: "..." }
    UI->>User: 弹出优雅温润的 WorkspaceMountDialog 卡片
    User->>UI: 点击【授权并挂载工作区】
    UI->>Loop: 发送 IPC 指令: resolve_workspace_mount(sessionId, path, decision: "allow")
    Loop->>Loop: 更新当前会话 ToolContext.workspace_root = "C:/Projects/my-app"
    UI->>UI: 更新 workspaceStore.activeWorkspace
    Loop->>AI: 返回工具执行成功: "工作区已成功挂载至 C:/Projects/my-app"
    Note over AI: 后续 write_file / shell 工具在合法工作区内流畅执行！
```

---

### 5.4 动态挂载工具 `propose_workspace_mount` 实现

新建 `crates/agent-tools/src/tools/mount_workspace.rs`：

```rust
// crates/agent-tools/src/tools/mount_workspace.rs

use crate::context::{AskDecision, ToolContext};
use crate::definition::{Tool, ToolDefinition, ToolError};
use crate::tools::require_string;
use async_trait::async_trait;
use conex_fs::path_normalizer::ConexPathNormalizer;
use std::path::PathBuf;

pub struct ProposeWorkspaceMountTool {
    def: ToolDefinition,
}

impl ProposeWorkspaceMountTool {
    pub fn new() -> Self {
        Self {
            def: ToolDefinition {
                name: "propose_workspace_mount".to_string(),
                description: "向用户提议挂载一个新的本地目录作为当前会话的工作区。适用于新建项目或切换主作业目录。".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "拟挂载的目标绝对路径 (如 C:/Projects/demo)" },
                        "reason": { "type": "string", "description": "申请挂载该目录的业务原因与说明" }
                    },
                    "required": ["path", "reason"],
                    "additionalProperties": false
                }),
                dangerous: true,
                fatal_on_error: false,
            },
        }
    }
}

#[async_trait]
impl Tool for ProposeWorkspaceMountTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(
        &self,
        ctx: &ToolContext,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, ToolError> {
        let raw_path = require_string(&args, "path")?;
        let reason = require_string(&args, "reason")?;
        let normalized = ConexPathNormalizer::normalize(&PathBuf::from(&raw_path));

        // 拦截系统核心目录挂载
        if ConexPathNormalizer::is_system_critical_path(&normalized) {
            return Err(ToolError::new(
                "tool.mount_denied",
                format!("禁止挂载系统关键核心目录：{}", normalized.display()),
            ));
        }

        // 向用户发起挂载审批
        if let Some(ask) = &ctx.ask {
            let decision = ask.ask("propose_workspace_mount", &serde_json::json!({
                "path": normalized.to_string_lossy(),
                "reason": reason,
            })).await?;

            match decision {
                AskDecision::Allowed => {
                    // 确保目标目录存在
                    if !normalized.exists() {
                        let _ = std::fs::create_dir_all(&normalized);
                    }
                    Ok(serde_json::json!({
                        "status": "mounted",
                        "workspaceRoot": normalized.to_string_lossy(),
                        "message": format!("目录已成功授权并挂载为工作区：{}", normalized.display())
                    }))
                }
                AskDecision::Denied { reason } => {
                    Err(ToolError::new(
                        "tool.user_denied",
                        format!("用户拒绝挂载该工作区：{reason}"),
                    ))
                }
            }
        } else {
            // Plan 模式或无审批通道
            Err(ToolError::new(
                "tool.mount_unavailable",
                "当前模式不支持动态挂载工作区",
            ))
        }
    }
}
```

---

## 六、改动文件与接口代码级实施规范

### 6.1 Rust 内核改动清单与接口实现

#### 1. `crates/conex-fs/src/path_normalizer.rs`（新增）

- **功能**：Windows 大写盘符 `C:/` 归一化、剥离 `\\?\`、NTFS Junction 识别、`is_system_critical_path` 物理红线、异步 UNC 探测。
- **导出方法**：
  - `normalize(path: &Path) -> PathBuf`
  - `strip_verbatim_prefix(s: &str) -> String`
  - `is_subpath(candidate: &Path, root: &Path) -> bool`
  - `is_system_critical_path(path: &Path) -> bool`
  - `check_unc_path_async(path: PathBuf) -> Result<bool, std::io::Error>`

#### 2. `crates/agent-tools/src/context.rs`（修改）

- 在 `ToolContext` 结构体新增 `pub permission_mode: PermissionMode`；
- 更新 `ToolContext` 构造测试与 mock 辅助函数。

#### 3. `crates/agent-tools/src/permission.rs` & `permission_engine.rs`（重构/新增）

- 确立 `PermissionMode::Plan` / `Ask` / `FullAccess`；
- 实现 `PermissionDecisionEngine::evaluate`；
- 弃用历史废弃冗余别名，统一由 `from_engine_str` / `as_engine_str` 转换。

#### 4. `crates/agent-tools/src/tools/shell.rs` & `shell_redirect.rs`（重构）

- `prepare` 依据 `ctx.permission_mode` 分流；
- `FullAccess` 模式放行复合删除与间接执行；
- `shell_redirect.rs` 新增 `is_safe_temp_or_cache_path` 放行系统临时目录清理。

#### 5. `crates/agent-tools/src/tools/mod.rs`（重构）

- 迁移 `resolve_workspace_path` 使用 `ConexPathNormalizer::normalize`；
- 改造 `has_symlink_below_root` 为 `has_escaping_symlink_below_root`，放行内部 Junction；
- 注册 `ProposeWorkspaceMountTool`。

---

### 6.2 前端改动清单与接口实现

#### 1. `apps/crish-desktop/src/api/permissionModes.ts`（简化收敛）

将前端权限模式彻底收拢为三档（废除 `deep` 历史冗余）：

```typescript
// apps/crish-desktop/src/api/permissionModes.ts

export type PermissionMode = 'plan' | 'ask' | 'full';

export type EnginePermissionMode = 'plan' | 'ask' | 'full-access';

export const DESKTOP_PERMISSION_MODE_IDS: readonly PermissionMode[] = [
  'plan',
  'ask',
  'full',
] as const;

export const DESKTOP_TO_ENGINE: Readonly<
  Record<PermissionMode, EnginePermissionMode>
> = {
  plan: 'plan',
  ask: 'ask',
  full: 'full-access',
};

export const PERMISSION_MODES: PermissionModeMeta[] = [
  {
    id: 'plan',
    label: '计划模式',
    shortLabel: '计划',
    description: '只出方案不改代码，只读无干扰',
    accent: 'var(--text-secondary)',
    engineMode: 'plan',
    matrixHint: '只读安全',
  },
  {
    id: 'ask',
    label: '标准模式',
    shortLabel: '需确认',
    description: '项目内自动放行，跨目录与危险操作需审批',
    accent: 'var(--text-tertiary)',
    engineMode: 'ask',
    matrixHint: '日常默认',
  },
  {
    id: 'full',
    label: '完全访问',
    shortLabel: '完全访问',
    description: '完全信任自动执行，复合删除与临时清理全放行',
    accent: 'var(--text-primary)',
    engineMode: 'full-access',
    matrixHint: '高效自主',
  },
];
```

#### 2. `apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.tsx`

遵循战役设计系统规范（曲率 9999px 胶囊药丸，统一 `<Tooltip>`）：

```tsx
// apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.tsx

import React from 'react';
import { usePermissionStore } from '@/store/permissionStore';
import { PERMISSION_MODES, type PermissionMode } from '@/api/permissionModes';
import { Tooltip } from '@/components/ui/Tooltip';
import styles from './PermissionModeMenu.module.css';

export const PermissionModeMenu: React.FC = () => {
  const { permissionMode, setPermissionMode } = usePermissionStore();

  return (
    <div className={styles.container}>
      {PERMISSION_MODES.map((mode) => {
        const isActive = permissionMode === mode.id;
        return (
          <Tooltip key={mode.id} content={mode.description}>
            <button
              type="button"
              className={`${styles.permPill} ${isActive ? styles.active : ''}`}
              onClick={() => setPermissionMode(mode.id)}
            >
              <span className={styles.dot} />
              <span className={styles.label}>{mode.shortLabel}</span>
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
};
```

---

## 七、多维度协同演进视图

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                               DIM-04 与其余 6 大维度协同演进矩阵                                      │
├─────────┬──────────────────────────────┬───────────────────────────────────────────────────────────────┤
│ 协同维度│ 维度名称                     │ 协同交乘点与接口契约                                          │
├─────────┼──────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ DIM-01  │ Rust 双轨事件与自愈状态机    │ • `LiveEventSink` 广播权限审批与工作区挂载申请事件；          │
│         │                              │ • 当工具因越界拦截时，触发自愈引导模型调用挂载工具。         │
├─────────┼──────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ DIM-02  │ 前端流式管道与交错时间线     │ • 时间线精准呈现审批卡片与挂载卡片节点；                      │
│         │                              │ • 用户授权后平滑推进后续步骤，避免节点闪烁或重复。            │
├─────────┼──────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ DIM-03  │ 思考强度与沉浸式查阅         │ • 权限状态在 Thinking 块中透明展示（如审计决策标记）；        │
├─────────┼──────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ DIM-05  │ 工具卡片摘要与结构化分栏     │ • `ToolCallInputPane` 呈现归一化的大写 `C:/...` 工作目录；    │
│         │                              │ • `ToolCallOutputPane` 呈现完全访问放行执行的详细耗时与状态。 │
├─────────┼──────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ DIM-06  │ 聊天框纯净化与 TS 插件体系   │ • 纯对话无工作区状态下，聊天框保持极简输入，无任何虚假提示；  │
├─────────┼──────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ DIM-07  │ 原生 ConPTY 纯终端与质量门禁 │ • ConPTY 直通终端默认工作目录对齐归一化 `C:/...`；            │
│         │                              │ • 100% 通过 73+ Rust 测试套件与前端门禁。                     │
└─────────┴──────────────────────────────┴───────────────────────────────────────────────────────────────┘
```

---

## 八、测试矩阵与全量验收断言

### 8.1 Rust 单元测试用例清单

| 测试模块                    | 测试函数名                               | 核心断言与输入输出验证                                                                         |
| :-------------------------- | :--------------------------------------- | :--------------------------------------------------------------------------------------------- |
| `conex-fs::path_normalizer` | `test_normalize_uppercase_drive_letter`  | 输入 `"c:\\software\\conex"`, 断言返回 `PathBuf::from("C:/software/conex")`                    |
| `conex-fs::path_normalizer` | `test_strip_verbatim_unc_prefix`         | 输入 `"\\\\?\\UNC\\server\\share\\file"`, 断言返回 `PathBuf::from("//server/share/file")`      |
| `conex-fs::path_normalizer` | `test_is_system_critical_path_windows`   | 验证 `"C:/Windows"`, `"C:/Program Files"`, `"C:/"` 均返回 `true`，`"C:/Projects"` 返回 `false` |
| `agent-tools::permission`   | `test_permission_engine_plan_mode`       | Plan 模式下写类操作返回 `PermissionVerdict::Deny`，读类操作返回 `Allow`                        |
| `agent-tools::permission`   | `test_permission_engine_full_access`     | FullAccess 模式下复合删除与危险操作均返回 `PermissionVerdict::Allow`                           |
| `agent-tools::shell`        | `test_shell_full_access_compound_delete` | `pwsh -c "cargo test && rm tmp.txt"` 在 FullAccess 下 `prepare` 返回 `Prepared::Run`           |
| `agent-tools::shell`        | `test_shell_system_redline_hard_blocked` | `format C:` 或 `rm -rf /` 在任何权限模式下均被硬拦截返回 `TOOL_COMMAND_BLOCKED`                |
| `agent-tools::fs`           | `test_junction_within_workspace_allowed` | 工作区内指向子目录的 NTFS Junction 读写正常放行，无越界错误                                    |
| `session-loop::mount`       | `test_unbound_workspace_propose_mount`   | 纯对话无工作区时调用 `propose_workspace_mount` 成功触发 `AskChannel` 并完成绑定                |

---

### 8.2 前端单元测试清单（Vitest）

```typescript
// apps/crish-desktop/src/api/__tests__/permissionModes.test.ts

describe('DIM-04 前端三档权限模式契约测试', () => {
  it('正确导出三档核心模式', () => {
    expect(DESKTOP_PERMISSION_MODE_IDS).toEqual(['plan', 'ask', 'full']);
  });

  it('桌面三档准确映射至引擎协议', () => {
    expect(toEnginePermissionMode('plan')).toBe('plan');
    expect(toEnginePermissionMode('ask')).toBe('ask');
    expect(toEnginePermissionMode('full')).toBe('full-access');
  });

  it('未知与废弃历史值安全回退到 ask', () => {
    expect(normalizePermissionMode('deep')).toBe('ask');
    expect(normalizePermissionMode('unknown_mode')).toBe('ask');
    expect(normalizePermissionMode(undefined)).toBe('ask');
  });
});
```

---

### 8.3 E2E 实机真机验收场景与 CDP 断言

连接 `http://127.0.0.1:9222` Tauri WebView2 调试环境，执行以下真机验收：

1. **场景 1：完全访问自主开发与复合删除**
   - 在 UI 切换至【完全访问】胶囊；
   - 让 AI 执行包含构建与临时文件清理的长程任务（`cargo test && rm temp_output.txt`）；
   - **断言**：命令一气呵成执行成功，零拦截弹窗，控制台日志无 `PermissionDenied` 报错。

2. **场景 2：Windows 路径归一化与大写盘符验证**
   - 检查右侧面板与工具输入区呈现的工作区路径；
   - **断言**：全界面统一显示为 `C:/...`，无 `c:` 小写乱象，无 `\\?\` UNC 前缀暴露。

3. **场景 3：纯对话无工作区与动态挂载提议**
   - 打开全新纯对话（无预设工作区）；
   - 要求 AI：“请在 C:/Software/conex-demo 创建一个 Hello World 脚本”；
   - **断言**：AI 触发 `propose_workspace_mount`，界面优雅弹出 `WorkspaceMountDialog`；点击【授权并挂载】后，工作区即时热切换，文件成功创建落盘。

---

### 8.4 门禁验证与零回归保护清单

- [x] **Level 1**: `npm run typecheck` 0 错误；
- [x] **Level 2**: `npm run check:line-counts` 前端行数门禁全绿（组件 ≤500 行，业务逻辑 ≤400 行）；
- [x] **Level 3**: `cargo test --workspace` 73+ 套件全量通过，`npm test` 全绿；
- [x] **Level 4**: CDP 9222 真机实测无死锁、无状态倒退、无权限穿透。
