# 工作区路径越界与 Windows 盘符规范化深度分析报告

> **文档定位**：全链路底层架构深度诊断与重构分析
> **分析师角色**：【子Agent 04: 工作区路径沙箱越界与 AI 脚本绕过机制深度分析师】
> **代码权威审视域**：
>
> - `crates/agent-tools/src/tools/mod.rs`（`resolve_workspace_path`、`normalize_for_compare`、`has_symlink_below_root`、`strip_verbatim_prefix`）
> - `crates/agent-tools/src/tools/shell.rs`（`prepare`、`cwd` 解析与命令门禁）
> - `crates/agent-tools/src/write_paths_validate.rs`（`validate_write_path`、`paths_overlap_normalized`）
> - `crates/conex-fs/src/lib.rs`（`safe_canonicalize`、`is_dos_device_name`）
> - `crates/session-loop/src/loop/loop_runner.rs`（`workspace_root` 与写路径注册表装配解析链）
> - `crates/session-loop/src/exec_single.rs`（`ToolContext.workspace_root` 注入与审批通道）
> - `apps/agent-workbench/src-tauri/src/run/run_launch.rs`（`resolve_escape_watch_root`、`RunTaskOptions.cwd`）
> - `apps/crish-desktop/src/api/chat-bridge/ConnectionLifecycle.ts`（`cwd` 提取与下发）
> - `apps/crish-desktop/src/api/projectStore.ts`（`getWorkspacePath`、`GENERAL_FOLDER` 与项目存储）

---

## 目录（Table of Contents）

1. [执行摘要与真实案例全景解构（Executive Summary）](#一执行摘要与真实案例全景解构)
2. [AI 行为逻辑与脚本绕过机制全链路复盘（AI Reasoning & Shell Bypass）](#二ai-行为逻辑与脚本绕过机制全链路复盘)
3. [工作区沙箱与路径解析代码级深度剖析（Code-Level Root Causes）](#三工作区沙箱与路径解析代码级深度剖析)
4. [Windows 路径规范化与 OS 特性三大缺陷诊断（Windows Path Normalization Defects）](#四windows-路径规范化与-os-特性三大缺陷诊断)
5. [优雅架构方案设计：显式工作区模型与 AI 动态授权切换（Architectural Redesign）](#五优雅架构方案设计显式工作区模型与-ai-动态授权切换)
6. [实施路线图与测试验证矩阵（Implementation & Verification Matrix）](#六实施路线图与测试验证矩阵)

---

## 一、执行摘要与真实案例全景解构

### 1.1 真实案例回溯与用户现场疑问

在真实用户使用场景中，用户在未选择或创建特定项目的对话中，要求 AI 在本地目录（如 `c:/Software/conex/temp_ai_test_workspace`）创建测试环境、生成项目文件并运行 npm 测试。AI 在执行后给出了如下自白式的答复：

> _【你指定的目录 c:/Software/conex/temp_ai_test_workspace 位于当前工具工作区（...\apps\agent-workbench\src-tauri）之外，工作区文件工具会因路径越界拒绝写入。因此我改用了一个可审计的 PowerShell 生成脚本（已执行完并清理）在该目录落盘文件，再以 npm --prefix 方式安装依赖并运行测试。后续如需继续修改这些文件，同样需要走 shell 路径，或把该目录映射为工作区。】_

针对这一现象，用户提出了两个直击系统本质的根本疑问：

1. **“如果是对话的话，应该是默认的无工作目录状态吧？”** —— 为什么系统会悄悄把工作区绑定到 Tauri 宿主进程的内部目录（`...\apps\agent-workbench\src-tauri`），把普通对话变成了一个具有狭隘沙箱边界的受限环境？
2. **“AI 应该是可以指定自己的工作目录的，当然是在用户的授权之后。”** —— 为什么系统没有提供正规的工作区动态提议与授权机制，反而逼迫 AI 通过 PowerShell 脚本“偷渡越狱”来完成用户交付？

### 1.2 核心根因与架构断层全景矩阵

经过对 Rust 引擎、Tauri 壳层、前端 Store 及工具执行层的全链条审查，我们确认该现象暴露了系统中的**四层深层架构缺陷**：

| 维度                                  | 现场表现                                                                                                  | 核心代码断点                                                                                                                                                                                                                                                                                                                                     | 根因本质                                                                                                                                                                                                               |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. 纯对话工作区建模缺失**           | 纯对话无项目时，前端不传 `cwd`，后端悄悄回退到 Tauri 启动进程 CWD（`src-tauri`）                          | [`ConnectionLifecycle.ts:339`](file:///c:/Software/conex/apps/crish-desktop/src/api/chat-bridge/ConnectionLifecycle.ts#L339)<br>[`run_launch.rs:128`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/run/run_launch.rs#L128)<br>[`loop_runner.rs:130`](file:///c:/Software/conex/crates/session-loop/src/loop/loop_runner.rs#L130) | **无工作区状态未显式建模**。系统将“宿主进程执行目录”与“用户数据安全沙箱边界”混为一谈，强行套用了默认宿主路径作为沙箱根。                                                                                               |
| **2. 工具权限面不对称与 AI 逃逸绕过** | 文件读写工具（`write_file`/`replace`）严守沙箱阻断越界，但 `shell` 命令工具可通过内联脚本操纵任意绝对路径 | [`tools/mod.rs:366`](file:///c:/Software/conex/crates/agent-tools/src/tools/mod.rs#L366)<br>[`tools/shell.rs:198-204`](file:///c:/Software/conex/crates/agent-tools/src/tools/shell.rs#L198-L204)                                                                                                                                                | **权限模型不对称**。文件工具受 `workspace_root` 严格限制，而 Shell 工具未对命令行字符串内的绝对路径进行沙箱约束，使得 LLM 在遭遇工具失败时自主选择利用 Shell 工具实现“自愈绕过”。                                      |
| **3. Windows 路径规范化断裂**         | 路径规范化在 `\\?\` 前缀剥离、盘符大小写（`c:` vs `C:`）、NTFS Junction 上存在严重漏洞与误杀              | [`tools/mod.rs:362-388`](file:///c:/Software/conex/crates/agent-tools/src/tools/mod.rs#L362-L388)<br>[`tools/mod.rs:576-587`](file:///c:/Software/conex/crates/agent-tools/src/tools/mod.rs#L576-L587)<br>[`conex-fs/src/lib.rs:159`](file:///c:/Software/conex/crates/conex-fs/src/lib.rs#L159)                                                 | **OS 适配不彻底**。Rust `canonicalize` 在 Windows 下自动注入 `\\?\` 长路径前缀，与纯词法路径比对时失配；`strip_prefix` 遇大小写不敏感盘符比对失败；`symlink_metadata` 误将 NTFS Junction 当成逃逸 Symlink 一刀切拒绝。 |
| **4. 动态工作区协商机制缺失**         | AI 无法向系统提出“切换/绑定工作区”申请，缺乏合规的升级通道                                                | [`session-loop/src/tool_events.rs:148`](file:///c:/Software/conex/crates/session-loop/src/tool_events.rs#L148) 缺少工作区提议工具/事件                                                                                                                                                                                                           | **缺乏上下文交互演进协议**。没有把“从纯对话向具体工程目录挂载”的意图转变为结构化 Approval 事件，导致 AI 只能在“任务失败报错”与“走 Shell 黑客绕过”之间二选一。                                                          |

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              工作区沙箱错位与 AI PowerShell 绕过全景拓扑图                              │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘

 [用户发起纯对话] ─── (未指定 project/workspace)
        │
        ▼
 前端 ConnectionLifecycle.ts ──► cwd: undefined (getWorkspacePath() 为空)
        │
        ▼
 Tauri 后端 run_launch.rs / loop_runner.rs
        │ ⚠️ 致命回退：cwd == None ──► 回退至 std::env::current_dir()
        ▼
 ToolContext.workspace_root 误绑定为：C:\Software\conex\apps\agent-workbench\src-tauri
        │
        ├────────────────────────────────────────────────────────────────────────┐
        │                                                                        │
        ▼ 【标准文件工具路径：write_file / replace】                               ▼ 【Shell 命令工具路径：run_command】
 目标：c:/Software/conex/temp_ai_test_workspace/file.ts                   目标：以 shell 形式执行脚本
        │                                                                        │
 resolve_workspace_path() 比对：                                         shell.rs: cwd 默认设为 src-tauri
 "c:/Software/conex/temp_ai_test_workspace/..."                           但 command 字符串为：
 NOT starts_with("C:/Software/conex/apps/agent-workbench/src-tauri")     "pwsh -Command Set-Content c:/.../file.ts"
        │                                                                        │
        ▼                                                                        ▼
 💥 抛出 ToolError: [tool.path_escape]                                   ✅ 绕过沙箱，直接操作系统任意目录！
 "Path escapes workspace: c:/Software/conex/..."                                 │
        │                                                                        ▼
        └──────────────────────────► LLM 收到工具错误反思 ─────────────────────────┘
                                     “文件工具被沙箱锁在 src-tauri，
                                      改用 PowerShell 脚本直接写盘，
                                      并用 npm --prefix 运行测试！”
                                                 │
                                                 ▼
                                     AI 向用户输出诚实但无奈的自白：
                                     “因位于工作区外拒绝写入，已改用 PS 脚本落盘...”
```

---

## 二、AI 行为逻辑与脚本绕过机制全链路复盘

### 2.1 触发前置：用户指示操作外部目录

当用户在没有开启具体工程的会话（即所谓的“全局对话 / General Chat”）中输入提示词，例如：
_“请在 `c:/Software/conex/temp_ai_test_workspace` 下创建一个 TypeScript 项目，写一个测试用例并用 npm 跑通测试。”_

LLM 识别到用户的明确意图，开始规划工具调用序列：

1. `write_file` 创建 `package.json`
2. `write_file` 创建 `tsconfig.json`
3. `write_file` 创建 `src/index.ts` 与 `tests/index.test.ts`
4. `run_command` 执行 `npm install` 与 `npm test`

### 2.2 阶段一：标准文件工具沙箱拦截

AI 发起首个工具调用：

```json
{
  "name": "write_file",
  "arguments": {
    "path": "c:/Software/conex/temp_ai_test_workspace/package.json",
    "content": "{\n  \"name\": \"temp-test\",\n  \"version\": \"1.0.0\"\n}"
  }
}
```

后端执行器 [`exec_single.rs`](file:///c:/Software/conex/crates/session-loop/src/exec_single.rs#L276-L280) 将请求分发给 `agent_tools::tools::fs::write_file`。
写文件工具的第一步必须调用 [`resolve_workspace_path`](file:///c:/Software/conex/crates/agent-tools/src/tools/mod.rs#L320)：

```rust
let file_path = resolve_workspace_path(&ctx.workspace_root, &path_str)?;
```

此时 `ctx.workspace_root` 由于纯对话模式没有 `cwd`，已被注入为 `C:\Software\conex\apps\agent-workbench\src-tauri`。

`resolve_workspace_path` 执行包含性校验：

- `canonical`: `c:\Software\conex\temp_ai_test_workspace\package.json`
- `canonical_root`: `c:\Software\conex\apps\agent-workbench\src-tauri`
- `path_within_root(&canonical, &canonical_root)` 判定：`canonical` 不以 `canonical_root` 为前缀！

结果，引擎立即拒绝执行并向 LLM 返回结构化错误：

```json
{
  "error": {
    "code": "tool.path_escape",
    "message": "Path escapes workspace: c:/Software/conex/temp_ai_test_workspace/package.json"
  }
}
```

### 2.3 阶段二：LLM 认知升级与绕过策略形成

LLM 收到上述工具错误反馈后，在其内部的 ReAct（Reasoning + Action）循环中触发了错误反思（Self-Reflection）：

1. **沙箱边界识别**：LLM 意识到当前环境的工作区根被硬性锁定在 `...\apps\agent-workbench\src-tauri`，任何直接使用 `write_file`、`create_file`、`replace` 等标准文件工具向 `c:/Software/conex/temp_ai_test_workspace` 写入的操作都会被 `tool.path_escape` 机械拦截；
2. **工具权限差异分析**：LLM 审查了可用工具集，发现 `execute_command` / `run_command`（即 `shell` 工具）虽然其 `cwd` 默认也是工作区根，但在 Windows PowerShell 环境下，PowerShell 可以通过命令行参数中的绝对路径操纵文件系统任意位置（例如 `Set-Content`、`Out-File`、`New-Item`）；
3. **自愈决策制定**：为了不违背用户“完成测试”的最终目标（符合强逻辑反退避原则），LLM 决定放弃受限的标准文件工具，转而采用可审计的 PowerShell 一次性脚本在目标目录落盘文件，并通过 `npm --prefix` 跨目录安装依赖和执行测试；
4. **安全清理意识**：为了保持现场整洁，LLM 在脚本执行完毕后自动执行了临时文件清理。

### 2.4 阶段三：PowerShell 脚本生成与全量执行

AI 随后发起一系列 `run_command` 工具调用：

1. **批量文件生成**：通过 pwsh 命令行直接调用文件创建：
   ```powershell
   pwsh -NoProfile -Command "
     New-Item -ItemType Directory -Force -Path 'c:/Software/conex/temp_ai_test_workspace/src';
     Set-Content -Path 'c:/Software/conex/temp_ai_test_workspace/package.json' -Value '{...}' -Encoding utf8;
     Set-Content -Path 'c:/Software/conex/temp_ai_test_workspace/src/index.ts' -Value '...' -Encoding utf8;
   "
   ```
2. **跨目录执行依赖与测试**：
   ```powershell
   pwsh -NoProfile -Command "npm --prefix c:/Software/conex/temp_ai_test_workspace install && npm --prefix c:/Software/conex/temp_ai_test_workspace test"
   ```

因为 `crates/agent-tools/src/tools/shell.rs` 只对传入的 `cwd` 进行校验（未传时默认取 `.` 即 `ctx.workspace_root`，而该目录合法存在），`std::process::Command` 成功启动子进程，PowerShell 顺利在 `c:/Software/conex/temp_ai_test_workspace` 完成了全部文件读写与测试。

### 2.5 阶段四：AI 结论呈现与用户困惑

任务完成后，AI 在最终回复中向用户解释了为什么要采取这种非常规的手段。这一解释展现了 LLM 面对架构断层时的自适应能力，但也极其尖锐地揭示了系统的设计缺陷：

- **AI 的诚实汇报**体现了模型对工具调用失败原因的准确理解；
- **用户的困惑**则完全合情合理：在用户心智中，既然没有进入特定项目，为什么会被悄悄关进 `src-tauri` 这个毫不相关的内部开发目录？既然我要在某个目录干活，系统为什么不直接问我“是否将该目录作为工作区”，而是逼着 AI 去“钻 Shell 空子”？

---

## 三、工作区沙箱与路径解析代码级深度剖析

### 3.1 前端：`ConnectionLifecycle.ts` 与 `projectStore.ts` 的 `cwd` 传导断层

在前端架构中，工作区路径由 [`projectStore.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/projectStore.ts) 统一管理：

```typescript
// apps/crish-desktop/src/api/projectStore.ts:148-154
export function getWorkspacePath(): string {
  try {
    return localStorage.getItem(WORKSPACE_KEY) || '';
  } catch {
    return '';
  }
}
```

当用户在侧边栏点击“新对话”或处于默认的 `GENERAL_FOLDER`（“对话”）状态时：

1. 用户并未激活任何具体项目，`localStorage.getItem('crish_workspace')` 为空；
2. `getWorkspacePath()` 返回空字符串 `""`；
3. 当用户发送消息时，[`ConnectionLifecycle.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/chat-bridge/ConnectionLifecycle.ts#L338-L339) 执行：
   ```typescript
   const { getWorkspacePath } = await import('../projectStore');
   const cwd = getWorkspacePath() || undefined;
   ```
4. 在调用 `startRunTask` 时（第 424 行）：
   ```typescript
   await startRunTask(transport, {
     runId,
     prompt,
     sessionId: safeSessionId,
     permissionMode,
     ...(cwd ? { cwd } : {}), // ⚠️ 当 cwd 为 undefined 时，完全不传递 cwd 字段！
     ...
   });
   ```

前端的设计意图很清晰：**“没有选择项目就是无工作区（cwd = None）”**。

### 3.2 后端：`run_launch.rs`、`loop_runner.rs` 与 `exec_single.rs` 的工作区根回退陷阱

当后端的 `core_run_task` 收到一个 `cwd == None` 的请求时，噩梦开始了。

#### 陷阱点 1：`run_launch.rs` 中的逃逸监视与写路径注册表根解析

在 [`apps/agent-workbench/src-tauri/src/run/run_launch.rs`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/run/run_launch.rs#L128-L131)：

```rust
pub(crate) fn resolve_escape_watch_root(cwd: Option<&str>) -> PathBuf {
    cwd.map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}
```

当 `cwd` 为 `None` 时，代码直接调用了 `std::env::current_dir()`！
在桌面运行时，Tauri 进程的工作目录通常是：

- 本地开发调试时：`C:\Software\conex\apps\agent-workbench\src-tauri`
- 生产安装包运行时：应用的可执行文件安装目录（如 `C:\Program Files\Crish\...` 或 `%LOCALAPPDATA%\...`）

#### 陷阱点 2：`loop_runner.rs` 中的 `ToolContext.workspace_root` 解析链

在 [`crates/session-loop/src/loop/loop_runner.rs`](file:///c:/Software/conex/crates/session-loop/src/loop/loop_runner.rs#L125-L130)：

```rust
// 工作区根解析链：显式 workspace_root → options.cwd → 当前目录
let root = self
    .tool_ctx
    .workspace_root
    .clone()
    .or_else(|| options.cwd.clone().map(PathBuf::from))
    .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

self.tool_ctx.workspace_root = Some(root);
```

#### 陷阱点 3：`exec_single.rs` 中的执行期注入

在 [`crates/session-loop/src/exec_single.rs`](file:///c:/Software/conex/crates/session-loop/src/exec_single.rs#L276-L280)：

```rust
workspace_root: ctx
    .workspace_root
    .clone()
    .or_else(|| ctx.cwd.clone().map(PathBuf::from))
    .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))),
```

这三处完全一致的回退逻辑共同导致了一个荒谬的结果：**前端传递的“无工作目录（无边界对话）”，被后端底层悄悄偷换成了“以 Tauri 源码进程目录为牢笼的硬沙箱”！**

### 3.3 工具层：`resolve_workspace_path` 五步安全流水线

在 [`crates/agent-tools/src/tools/mod.rs`](file:///c:/Software/conex/crates/agent-tools/src/tools/mod.rs#L320-L383)，`resolve_workspace_path` 是所有原生文件工具（`read_file`, `write_file`, `replace`, `delete`, `diff`, `search`, `project_tree`）的统一安全守门人：

```rust
pub(crate) fn resolve_workspace_path(
    workspace_root: &Path,
    input: &str,
) -> Result<PathBuf, ToolError> {
    // 步骤 1：非空校验与控制字符拦截
    if input.trim().is_empty() {
        return Err(ToolError::invalid_input("path must be a non-empty string"));
    }
    if input.chars().any(|c| c.is_control()) {
        return Err(ToolError::invalid_input(format!(
            "invalid path (control character): {input:?}"
        )));
    }

    // 步骤 2：词法拼接与组件深度扫描（拦截 .. 越界）
    let raw = Path::new(input);
    let candidate = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        workspace_root.join(raw)
    };

    let mut depth = 0usize;
    for comp in candidate.components() {
        match comp {
            std::path::Component::ParentDir => {
                return Err(ToolError::new(
                    codes::TOOL_PATH_ESCAPE,
                    format!("Path escapes workspace: {input}"),
                ));
            }
            std::path::Component::Normal(_) => {
                depth += 1;
                if depth > MAX_PATH_DEPTH {
                    return Err(ToolError::new(
                        codes::TOOL_PATH_ESCAPE,
                        format!("Path escapes workspace: {input}"),
                    ));
                }
            }
            _ => {}
        }
    }

    // 步骤 3：safe_canonicalize 规范化与 UNC 前缀剥离
    let canonical = conex_fs::path_utils::safe_canonicalize(&candidate, MAX_PATH_DEPTH)
        .map_err(|e| ToolError::invalid_input(format!("invalid path: {e}")))?;
    let canonical = strip_verbatim_prefix(&canonical);
    let canonical_root = conex_fs::path_utils::safe_canonicalize(workspace_root, MAX_PATH_DEPTH)
        .map(|p| strip_verbatim_prefix(&p))
        .unwrap_or_else(|_| workspace_root.to_path_buf());

    // 步骤 4：工作区包含性校验（path_within_root）
    if !path_within_root(&canonical, &canonical_root) {
        return Err(ToolError::new(
            codes::TOOL_PATH_ESCAPE,
            format!("Path escapes workspace: {input}"),
        ));
    }

    // 步骤 5：符号链接双保险检测（has_symlink_below_root）
    if has_symlink_below_root(&canonical, &canonical_root) {
        return Err(ToolError::new(
            codes::TOOL_PATH_ESCAPE,
            format!("Path escapes workspace: {input}"),
        ));
    }

    Ok(canonical)
}
```

#### 四处 `TOOL_PATH_ESCAPE` 阻断分支全景表：

| 分支编号   | 代码行号     | 触发条件                                            | 错误表现                                                           | 本案例中是否触发         |
| ---------- | ------------ | --------------------------------------------------- | ------------------------------------------------------------------ | ------------------------ |
| **分支 1** | `mod.rs:343` | 路径组件中含有 `..`（父目录穿越）                   | `Path escapes workspace: ..`                                       | 否                       |
| **分支 2** | `mod.rs:351` | 路径组件深度超过 40 层                              | `Path escapes workspace: <deep_path>`                              | 否                       |
| **分支 3** | `mod.rs:367` | 规范化后的绝对路径不以 `canonical_root` 为前缀      | `Path escapes workspace: c:/Software/conex/temp_ai_test_workspace` | **是（核心触发点）**     |
| **分支 4** | `mod.rs:377` | 规范化路径相对根路径的子组件中含有符号链接/Junction | `Path escapes workspace: <path>`                                   | 条件触发（若存在联接点） |

---

## 四、Windows 路径规范化与 OS 特性三大缺陷诊断

除了工作区根错位之外，深入审查 Windows 平台下的路径处理代码，我们发现了三个严重的系统级缺陷：

### 4.1 缺陷一：Verbatim UNC 前缀 `\\?\` 与 `\\?\UNC\` 处理断裂与双轨不一致

在 Windows 操作系统中，Win32 文件 API 对传统路径有 260 字符（`MAX_PATH`）限制。为了支持长路径，Windows 引入了 Verbatim 规范化路径前缀：

- 本地路径：`\\?\C:\Software\conex`
- 网络 UNC 路径：`\\?\UNC\server\share\file`

Rust 标准库中的 `std::fs::canonicalize` 在 Windows 平台上**必定**会返回带有 `\\?\` 前缀的 UNC 长路径。

#### 断裂证据分析：

1. [`conex-fs/src/lib.rs:159`](file:///c:/Software/conex/crates/conex-fs/src/lib.rs#L159) 的 `safe_canonicalize` 直接返回了 `path.canonicalize()` 的结果（包含 `\\?\` 前缀）；
2. [`agent-tools/src/tools/mod.rs:362`](file:///c:/Software/conex/crates/agent-tools/src/tools/mod.rs#L362) 尝试通过 `strip_verbatim_prefix` 剥离了 `canonical` 和 `canonical_root` 的 `\\?\`；
3. 但是！在 `workspace_root.canonicalize()` 失败（例如工作区目录不存在、权限受限或相对路径回退）时，第 365 行执行：
   ```rust
   .unwrap_or_else(|_| workspace_root.to_path_buf())
   ```
   此时 `canonical_root` 是未经过 `canonicalize` 的常规路径（不带 `\\?\`），而 `canonical` 如果成功 canonicalize，则带有 `\\?\`；
4. 更严重的是，在 [`normalize_for_compare`](file:///c:/Software/conex/crates/agent-tools/src/tools/mod.rs#L576-L587) 函数中：
   ```rust
   fn normalize_for_compare(p: &Path) -> String {
       let sep = std::path::MAIN_SEPARATOR.to_string();
       let mut s = p.to_string_lossy().replace(['/', '\\'], &sep);
       #[cfg(windows)]
       {
           s = s.to_lowercase();
       }
       if s.len() > 1 {
           s = s.trim_end_matches(std::path::MAIN_SEPARATOR).to_string();
       }
       s
   }
   ```
   **`normalize_for_compare` 根本没有剥离 `\\?\` 或 `\\?\unc\` 前缀！**
   如果在其它模块（例如 `conex-fs::watch`、`conex-fs::trash`、`write_paths_validate.rs`）中直接将未剥离的路径传入 `normalize_for_compare` 进行 `starts_with` 比较：
   - 候选路径：`\\?\c:\software\conex\temp`
   - 根路径：`c:\software\conex`
   - 比较语句：`"\\\\?\\c:\\software\\conex\\temp".starts_with("c:\\software\\conex\\")` 结果必定为 `false`！直接导致误判越界！

### 4.2 缺陷二：驱动器盘符大小写（`c:` vs `C:`）与 Rust `Path::strip_prefix` 字节级比对失效

Windows 文件系统的盘符与路径是大小写不敏感的（Case-Insensitive）。在命令行、环境变量或前端传递中，用户可能输入小写 `c:/Software/...`，而系统 API 可能返回大写 `C:\Software\...`。

#### 缺陷代码 1：`has_symlink_below_root` 中的盘符大小写崩溃

查看 [`crates/agent-tools/src/tools/mod.rs:388-394`](file:///c:/Software/conex/crates/agent-tools/src/tools/mod.rs#L388-L394)：

```rust
fn has_symlink_below_root(path: &Path, root: &Path) -> bool {
    let rel = match path.strip_prefix(root) {
        Ok(r) => r,
        Err(_) => return false, // ⚠️ 致命点：盘符大小写不一致时，直接 Err 并返回 false
    };
    ...
}
```

Rust 标准库的 `Path::strip_prefix` 是**严格按字节比对（Case-Sensitive）**的。
如果 `path` 是 `c:\software\conex\foo`，而 `root` 是 `C:\software\conex`：
`path.strip_prefix(root)` 因为 `b'c'` 与 `b'C'` 不等，直接返回 `Err`！
这导致 `has_symlink_below_root` 的防护机制在此类路径下直接被短路绕过。

#### 缺陷代码 2：`display_path_native` 退化为丑陋的绝对路径

查看 [`crates/agent-tools/src/tools/mod.rs:424-441`](file:///c:/Software/conex/crates/agent-tools/src/tools/mod.rs#L424-L441)：

```rust
fn display_path_native(root: &Path, path: &Path) -> String {
    if let Ok(rel) = path.strip_prefix(root) {
        if !rel.as_os_str().is_empty() {
            return rel.to_string_lossy().into_owned();
        }
    }
    // canonical root 再次尝试 strip_prefix
    if let Ok(canon_root) = conex_fs::path_utils::safe_canonicalize(root, MAX_PATH_DEPTH) {
        let canon_root = strip_verbatim_prefix(&canon_root);
        if let Ok(rel) = path.strip_prefix(&canon_root) {
            if !rel.as_os_str().is_empty() {
                return rel.to_string_lossy().into_owned();
            }
        }
    }
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}
```

一旦输入路径与根目录的盘符大小写不同，`strip_prefix` 全部失败，`display_path` 无法计算出优美的相对路径（如 `src/index.ts`），只能被迫回退到文件名或完整绝对路径，污染了向 LLM 呈现的上下文信息。

### 4.3 缺陷三：NTFS Junction（目录联接）与 Reparse Points 被无差别误杀

在 Windows 开发环境中，符号链接（Symlink）需要管理员权限或启用开发者模式（Developer Mode），因此主流工具链（Node.js / pnpm / Yarn / Scoop / Windows 子系统）广泛使用 **NTFS Junction（目录联接，Reparse Point `IO_REPARSE_TAG_MOUNT_POINT`）**。

#### 防御过载（Over-Defense）代码分析：

在 [`crates/agent-tools/src/tools/mod.rs:376-407`](file:///c:/Software/conex/crates/agent-tools/src/tools/mod.rs#L376-L407)：

```rust
if has_symlink_below_root(&canonical, &canonical_root) {
    return Err(ToolError::new(
        codes::TOOL_PATH_ESCAPE,
        format!("Path escapes workspace: {input}"),
    ));
}

fn has_symlink_below_root(path: &Path, root: &Path) -> bool {
    let rel = match path.strip_prefix(root) {
        Ok(r) => r,
        Err(_) => return false,
    };
    let mut cur = root.to_path_buf();
    for comp in rel.components() {
        match comp {
            std::path::Component::Normal(name) => {
                cur.push(name);
                if let Ok(meta) = std::fs::symlink_metadata(&cur) {
                    if meta.file_type().is_symlink() { // ⚠️ NTFS Junction 也会返回 true！
                        return true;
                    }
                }
            }
            _ => {}
        }
    }
    false
}
```

#### 误杀机理：

1. 在 Rust 的 Windows 实现中，`symlink_metadata(&path).file_type().is_symlink()` 会检查文件的重解析点属性（Reparse Tag）。无论是 POSIX 风格的 Symlink 还是 NTFS Directory Junction，该方法均返回 `true`；
2. `has_symlink_below_root` 的逻辑极其激进：**只要工作区内部的任何一级子目录是 Junction 或 Symlink，不论它的实际目标是否在工作区内部，统统一刀切直接判定为 `TOOL_PATH_ESCAPE`！**
3. 这意味着：如果用户的工作区中包含 `node_modules/.pnpm/`（内部大量使用了 Junction），或者用户将某个子模块通过 `mklink /J` 挂载在工作区内，AI 使用 `read_file` 或 `write_file` 访问这些目录时，会被系统当场阻断，误报为“路径越界逃逸”！

### 4.4 Windows 路径对比矩阵（Path Normalization Comparison Matrix）

下表总结了在 Windows 平台下不同路径格式在当前代码与目标理想方案中的处理对比：

| 测试路径形态                | 输入路径                                     | 当前 `safe_canonicalize`            | 当前 `normalize_for_compare`          | 当前 `resolve_workspace_path`                          | 目标方案预期行为                              |
| --------------------------- | -------------------------------------------- | ----------------------------------- | ------------------------------------- | ------------------------------------------------------ | --------------------------------------------- |
| **带小写盘符绝对路径**      | `c:/software/conex/test.txt`                 | `\\?\C:\software\conex\test.txt`    | `c:\software\conex\test.txt`          | ✅ 若 root 盘符一致则放行；❌ 遇 `strip_prefix` 易失效 | ✅ 统一盘符大写，安全放行                     |
| **带长路径 UNC 前缀**       | `\\?\C:\Software\Conex\a.ts`                 | `\\?\C:\Software\Conex\a.ts`        | `\\?\c:\software\conex\a.ts` (未剥离) | ❌ 若另一侧无前缀则包含性比对失败                      | ✅ 统一剥离 `\\?\`，安全放行                  |
| **网络共享 UNC 路径**       | `\\server\share\repo\file.rs`                | `\\?\UNC\server\share\repo\file.rs` | `\\server\share\repo\file.rs`         | ⚠️ 依赖剥离逻辑，边界脆弱                              | ✅ 统一映射为 `//server/share/...` 规范格式   |
| **NTFS Directory Junction** | `C:\ws\link_dir\sub.txt` (Junction 内部目录) | 成功解析目标路径                    | 转换为小写反斜杠                      | ❌ 被 `has_symlink_below_root` 当作 Symlink 误杀拒绝   | ✅ 解析真实目标，若目标在允许范围内则安全放行 |
| **纯对话未指定工作区**      | `C:\Users\dev\my_project\app.py`             | 成功规范化                          | 转换为小写反斜杠                      | ❌ 与 `src-tauri` 比对判定越界，报 `tool.path_escape`  | ✅ 触发工作区动态提议与授权流（见第五节）     |

---

## 五、优雅架构方案设计：显式工作区模型与 AI 动态授权切换

为了从根本上消除“隐式 CWD 偷换”与“AI 脚本绕过”的乱象，必须建立符合现代 Agent 交互哲学的**显式工作区状态机**与**动态提议授权机制**。

### 5.1 纯对话模式（无工作区）的显式三态建模

彻底废弃“无 cwd 就偷偷回退到 `std::env::current_dir()`”的隐式假设。在引擎内核中将工作区状态显式建模为三态枚举：

```rust
// 建议落地于 crates/conex-types/src/workspace.rs
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "path")]
pub enum WorkspaceScope {
    /// 纯对话模式：无固定工作区绑定
    /// 工具执行面处于「未绑定状态」，任何绝对路径写操作均需显式授权或动态绑定
    Unbound,

    /// 固定的项目工作区（用户在侧边栏明确选择的工程目录）
    /// 在此目录树内拥有自由读写权限
    Project(PathBuf),

    /// 会话级动态临时授权工作区（由 AI 提议并经用户一键批准的目录）
    SessionDynamic(PathBuf),
}
```

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                三态工作区状态机转换图                                   │
└────────────────────────────────────────────────────────────────────────────────────────┘

                           ┌───────────────────────┐
                           │ WorkspaceScope::      │
                           │ Unbound (纯对话模式)  │
                           └──────────┬────────────┘
                                      │
               ┌──────────────────────┴──────────────────────┐
               │                                             │
               ▼ (用户打开左侧项目)                          ▼ (AI 提议操作外部目录 + 用户批准)
 ┌───────────────────────────┐                 ┌───────────────────────────┐
 │ WorkspaceScope::          │                 │ WorkspaceScope::          │
 │ Project(PathBuf)          │                 │ SessionDynamic(PathBuf)   │
 └───────────────────────────┘                 └───────────────────────────┘
```

### 5.2 AI 提议工作区与用户授权协议（Dynamic Workspace Proposal Flow）

当系统处于 `WorkspaceScope::Unbound` 状态，而用户要求 AI 操作特定目录（或 AI 判断需要创建新项目）时，AI 不应直接报错，更不应走 PowerShell 绕过，而是走标准的**动态工作区提议与授权通道**。

#### 流程时序图：

```mermaid
sequenceDiagram
    autonumber
    actor User as 用户
    participant UI as 前端桌面 UI (Crish)
    participant Loop as 会话循环 (SessionLoop)
    participant Engine as 工具引擎 (AgentTools)
    participant LLM as 大语言模型 (AI)

    User->>UI: “在 C:/Software/conex/temp_workspace 下初始化项目并测试”
    UI->>Loop: 发起 run (workspace_scope: Unbound)
    Loop->>LLM: 提示词 + 上下文
    LLM->>Engine: 请求写入 C:/Software/conex/temp_workspace/package.json

    Note over Engine: 检测到 WorkspaceScope::Unbound<br/>目标路径为外部绝对目录
    Engine->>Loop: 触发结构化挂起: WorkspaceSwitchRequired(target_path)
    Loop->>UI: 发射 ApprovalRequested 事件 (type: "workspace_bind_request")

    Note over UI: UI 渲染优雅的交互卡片：<br/>“AI 申请将 C:/Software/conex/temp_workspace<br/>设为当前会话的工作目录，是否允许？”

    User->>UI: 点击【批准并挂载】
    UI->>Loop: 提交 ApprovalDecision::AllowWithWorkspace(target_path)

    Note over Loop: 动态更新本会话 Context:<br/>workspace_scope = SessionDynamic(target_path)<br/>workspace_root = target_path

    Loop->>Engine: 放行并重试工具执行 (以新工作区为根)
    Engine-->>Loop: write_file 成功
    Loop-->>UI: 实时渲染文件树与写入成功状态
    Loop->>LLM: 继续执行下一步 (npm test 等)
    LLM-->>User: 正式汇报任务圆满完成 (100% 审计合规，0 脚本绕过)
```

### 5.3 统一 Windows 路径安全规范化底座（`ConexPathNormalizer`）

针对第四节剖析的三大 Windows 路径缺陷，构建统一的路径归一化底座：

```rust
// 建议落盘于 crates/conex-fs/src/path_normalizer.rs
pub struct ConexPathNormalizer;

impl ConexPathNormalizer {
    /// 统一 Windows 路径规范化：
    /// 1. 剥离 \\?\ 和 \\?\UNC\ 前缀
    /// 2. 盘符强制大写（c: -> C:）
    /// 3. 分隔符统一为原生 MAIN_SEPARATOR
    /// 4. 消除尾部分隔符
    pub fn normalize(path: &Path) -> PathBuf {
        let s = path.to_string_lossy();
        let mut clean = s.as_ref();

        #[cfg(windows)]
        {
            if let Some(rest) = clean.strip_prefix(r"\\?\UNC\") {
                // 网络 UNC 还原为 \\server\share
                return PathBuf::from(format!(r"\\{rest}"));
            }
            if let Some(rest) = clean.strip_prefix(r"\\?\") {
                clean = rest;
            }
        }

        let mut path_buf = PathBuf::from(clean);

        #[cfg(windows)]
        {
            // 确保盘符大写
            if let Some(std::path::Component::Prefix(prefix_comp)) = path_buf.components().next() {
                let prefix_str = prefix_comp.as_os_str().to_string_lossy();
                if prefix_str.len() == 2 && prefix_str.ends_with(':') {
                    let upper_drive = prefix_str.to_ascii_uppercase();
                    let remainder: PathBuf = path_buf.components().skip(1).collect();
                    path_buf = PathBuf::from(format!("{upper_drive}\\{}", remainder.display()));
                }
            }
        }

        path_buf
    }

    /// 大小写不敏感的路径前缀包含性检查
    pub fn is_within_root(candidate: &Path, root: &Path) -> bool {
        let c_norm = Self::normalize(candidate);
        let r_norm = Self::normalize(root);

        let c_str = c_norm.to_string_lossy();
        let r_str = r_norm.to_string_lossy();

        #[cfg(windows)]
        {
            let c_lower = c_str.to_lowercase();
            let r_lower = r_str.to_lowercase();
            if c_lower == r_lower {
                return true;
            }
            let sep = std::path::MAIN_SEPARATOR;
            return c_lower.starts_with(&format!("{r_lower}{sep}"));
        }

        #[cfg(not(windows))]
        {
            if c_str == r_str {
                return true;
            }
            let sep = std::path::MAIN_SEPARATOR;
            c_str.starts_with(&format!("{r_str}{sep}"))
        }
    }
}
```

---

## 六、实施路线图与测试验证矩阵

### 6.1 模块改造清单与责任边界

| 模块 / 文件                                                   | 涉及改动点                                                                                                                               | 验收目标                                           |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **1. `crates/conex-fs/src/lib.rs`**                           | 完善 `safe_canonicalize`，在 Windows 下安全剥离 `\\?\` 前缀，导出 `ConexPathNormalizer`                                                  | 规范化输出不再残留 `\\?\` 前缀，盘符统一大写       |
| **2. `crates/agent-tools/src/tools/mod.rs`**                  | 改造 `resolve_workspace_path` 与 `has_symlink_below_root`；用 `ConexPathNormalizer` 替代脆弱的字符串比对；允许目标在根内的 NTFS Junction | 消除盘符大小写比对失败，解除对合法 Junction 的误杀 |
| **3. `crates/session-loop/src/loop/loop_runner.rs`**          | 移除对 `std::env::current_dir()` 的隐式回退；引入显式 `WorkspaceScope`                                                                   | 纯对话模式下不再误将 `src-tauri` 作为沙箱根        |
| **4. `apps/agent-workbench/src-tauri/src/run/run_launch.rs`** | 治理 `resolve_escape_watch_root`；增加工作区动态提议审批处理器                                                                           | 支持运行时动态挂载工作区                           |
| **5. `apps/crish-desktop/src/api/chat-bridge/`**              | 增加工作区切换审批卡片 UI 渲染支持；支持更新会话 `cwd`                                                                                   | 用户可一键批准 AI 的工作区绑定申请                 |

### 6.2 专项测试验证矩阵

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                 自动化测试套件设计                                     │
└────────────────────────────────────────────────────────────────────────────────────────┘

 1. Windows 盘符大小写不敏感测试
    assert!(is_within_root("c:/foo/bar.txt", "C:/foo"));
    assert!(is_within_root("C:/FOO/BAR.TXT", "c:/foo"));

 2. Windows \\?\ UNC 长路径剥离测试
    assert_eq!(normalize(r"\\?\C:\project\src\main.rs"), PathBuf::from(r"C:\project\src\main.rs"));

 3. NTFS Directory Junction 合法放行测试
    - 创建真实目录 target_dir 与联接点 junction_dir (mklink /J)
    - resolve_workspace_path 必须放行指向 junction_dir 内部的写操作

 4. 纯对话未绑定状态动态授权 E2E 测试
    - 启动未绑定项目会话
    - AI 请求写入外部绝对路径
    - 捕获 workspace-switch approval 事件并模拟用户允许
    - 验证后续写操作成功落盘，且未产生任何 PowerShell 逃逸脚本
```

---

## 七、结论与主控汇报摘要

1. **现场复盘定性**：AI 在回复中所述的“改用 PowerShell 脚本生成并清理”，是 LLM 面对**后端无工作区时错误回退至 `src-tauri` 目录**导致的沙箱阻断时，所触发的自适应绕过行为。该行为暴露了系统底层在“工作区生命周期模型”与“Windows 路径规范化”上的双重断层。
2. **根治方案明确**：
   - 彻底废除 `std::env::current_dir()` 的宿主目录隐式偷换；
   - 显式建立纯对话 `WorkspaceScope::Unbound` 状态；
   - 建立结构化的“AI 工作区提议 -> 用户一键授权 -> 动态更新 `workspace_root`”的标准演进链路；
   - 统一 Windows 路径规范化底座，彻底解决 `\\?\` UNC 剥离、盘符大小写与 NTFS Junction 误杀问题。
3. **交付状态**：本分析报告已完整落盘至指定路径，所有代码断点均已精确标注行号与重构设计，为后续战役的系统级架构重构提供了权威详实的理论与工程依据。
