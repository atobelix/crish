# 独立方案 03 · Agent 主动探查工具链健壮性与 PowerShell 语法防护方案

> **战役工作区**：`docs/active-exploration-architecture/`  
> **文档路径**：`docs/active-exploration-architecture/independent-plans/03-active-exploration-toolchain-plan.md`  
> **文档性质**：独立总方案（分维深入详案），供主控合并定稿。  
> **设计纪律**：纯逻辑编排（无工期/人员/优先级）、禁止波次/批次编号命名、禁止魔术数字黑盒重写、禁止回退被动监控、UTF-8 无 BOM 中文编写。

---

## 〇、方案定位与核心使命

在 Conex 多 Agent 协同与自主研发架构中，Agent 的探查与执行能力是整个自动化循环的地基。然而在近期的真实会话（如 `sess-1786855835905`）中暴露出两大核心断层：

1. **探查路径倒错与工具链闲置**：Agent 频繁绕过系统内置的高性能结构化探查工具（`read_file`、`list_dir`、`grep_search`、`project_tree`、`file_stat`），错误地退化为通过 `shell_command` 调用终端命令（如 `cat`、`grep -rn`、`head`、`find`、`dir /s /b`）来进行代码和目录探查；
2. **Windows PowerShell 解释器与包装器脆弱**：底层外壳执行环境由于默认硬编码选用 Windows PowerShell 5.1（而非现代 `pwsh7`），且通过 `[scriptblock]::Create($__conexCmd)` 裸解析命令，当面对 CMD 连接符（`&`、`&&`）、重定向符（`2>nul`）、环境变量语法（`set VAR=val`）以及 Unix 管道工具（`grep|head`）时，直接触发 .NET `ParseException`、`CommandNotFoundException` 与 `ParameterBindingException`，导致 Agent 陷入反复试错的死循环。

本方案旨在从**「工具链设计与 Schema 指引」、「PowerShell 执行包装与前置诊断防护」、「Prompt 体系铁律约束」**三大维度彻底解决上述问题，确立「主动结构化工具探查为唯一合法探查路径」的不变式，并在完全遵循反过度设计与反黑盒魔术数字原则的前提下，为 Windows 环境下的命令执行构建坚固、友好的防护与自愈体系。

---

## 一、现状审计与 `sess-1786855835905` 根因深度剖析

### 1.1 主动探查工具链现状与能力审计

在 `crates/agent-tools/src/tools/` 中，系统已经实现了完整且高性能的内置探查工具集，但在 Agent 实际交互中存在明显的认知与使用脱节：

| 工具名称             | 源码落点                                                                                                                                     | 原生能力与设计特性                                                                                                                                                 | Agent 实际使用痛点 / 误区                                                                            |
| :------------------- | :------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------- |
| **`read_file`**      | [`crates/agent-tools/src/tools/fs.rs:24-220`](file:///c:/Software/conex/crates/agent-tools/src/tools/fs.rs#L24-L220)                         | 1-indexed 闭区间行号窗口（`startLine`/`endLine`）、行粒度续读（`contentOffset`）、字符预算截断（`maxBytes` 默认 256KB）、二进制安全返回（`binary: true` 不报错）。 | 模型经常不知道支持局部切片，在大文件探查时常盲目调用终端 `head -n 20` 或 `sed`，引发命令未找到错误。 |
| **`list_dir`**       | [`crates/agent-tools/src/tools/fs.rs:471-592`](file:///c:/Software/conex/crates/agent-tools/src/tools/fs.rs#L471-L592)                       | 单层目录列举，输出 `/目录` 与 ` 文件` 清单，结构化返回 `count`（直接子项数）与 `mtime`/`size`。                                                                    | 不支持递归深度遍历；当模型需要深层结构时，误退化调用 `dir /s /b` 或 `find .`。                       |
| **`project_tree`**   | [`crates/agent-tools/src/tools/project_tree.rs:1-120`](file:///c:/Software/conex/crates/agent-tools/src/tools/project_tree.rs#L1-L120)       | 递归目录树（深度默认 3，上限 16），内置排除 `node_modules`、`.git`、`target` 等 `SKIP_DIRS`，进程级 mtime 指纹缓存。                                               | 工具存在感低，模型常在未调用 `project_tree` 建立全貌认知的情况下，通过 `ls -la` 逐层乱撞。           |
| **`grep_search`**    | [`crates/agent-tools/src/tools/search.rs:59-250`](file:///c:/Software/conex/crates/agent-tools/src/tools/search.rs#L59-L250)                 | 基于 Rust 原生 `ignore::WalkBuilder`，支持 glob 与 `excludeGlobs`，自动忽略大文件与二进制文件，支持行级与文件级（`grep -l`）模式。                                 | 模型习惯性调用 `git grep`、`grep -rn` 或 `findstr`，并在终端中尝试通过管道 `\| grep` 过滤其他命令。  |
| **`file_stat`**      | [`crates/agent-tools/src/tools/fs.rs:594-668`](file:///c:/Software/conex/crates/agent-tools/src/tools/fs.rs#L594-L668)                       | O(1) 快速查询文件/目录元数据（大小、类型、修改时间、只读权限）。                                                                                                   | 模型习惯用 `test -f` 或 `dir` 来判断文件存在性。                                                     |
| **`search_context`** | [`crates/agent-tools/src/tools/search_context.rs:39-105`](file:///c:/Software/conex/crates/agent-tools/src/tools/search_context.rs#L39-L105) | 压缩历史块检索，作用域限定当前会话，避免重复探查上下文已有内容。                                                                                                   | -                                                                                                    |

### 1.2 `sess-1786855835905` 中 PowerShell 执行崩溃根因穿透

在 `sess-1786855835905` 中，Agent 多次在执行 `shell_command` 时遭遇非预期的语法解析中断。经过对代码和执行链路的逆向追踪，定位出以下四重根因：

#### 根因 1：PowerShell 解析路径倒置，默认使用过时的 Windows PowerShell 5.1

在 [`crates/agent-tools/src/tools/shell_invoke.rs:40-60`](file:///c:/Software/conex/crates/agent-tools/src/tools/shell_invoke.rs#L40-L60) 和 [`apps/agent-workbench/src-tauri/src/process.rs:310-323`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/process.rs#L310-L323) 中，外壳路径解析逻辑如下：

```rust
fn resolve_system_powershell() -> Result<String, String> {
    if let Ok(root) = std::env::var("SystemRoot") {
        let candidate = std::path::Path::new(&root)
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
        if candidate.is_file() {
            return Ok(candidate.display().to_string());
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            if dir.join("powershell.exe").is_file() {
                return Ok("powershell.exe".into());
            }
        }
    }
    Err("system powershell.exe not found".into())
}
```

**断层分析**：

1. 代码**硬编码优先查找** `System32\WindowsPowerShell\v1.0\powershell.exe`（Windows PowerShell 5.1）；
2. 即使系统已经安装了现代跨平台的 PowerShell 7+（`pwsh.exe`），该函数也根本不会尝试去查找 `pwsh.exe`；
3. 这直接违反了 `AGENTS.md:31` 的铁律：“_子 Agent 执行命令统一使用 pwsh7（PowerShell 7+），避免 Windows PowerShell 5.1 的 GBK 默认编码与内联脚本插值问题_”；
4. Windows PowerShell 5.1 基于陈旧的 .NET Framework 4.x，语法解析器极其严格，**完全不支持** `&&`、`||` 等基本操作符。

#### 根因 2：`[scriptblock]::Create` 运行时刚性编译崩溃

在包装脚本构造函数 [`build_windows_powershell_script`](file:///c:/Software/conex/crates/agent-tools/src/tools/shell_invoke.rs#L64-L85) 中：

```powershell
$__conexCmd = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('{payload}'));
& ([scriptblock]::Create($__conexCmd));
```

`[scriptblock]::Create(string)` 是 .NET 的动态 ScriptBlock 编译 API。当 `$__conexCmd` 包含任何不符合 PowerShell 语法的 Token 时，它会在编译阶段直接抛出 `System.Management.Automation.ParseException`，且未经过任何异常捕获包装，导致整个包装脚本瞬间终止，返回晦涩的 .NET 异常堆栈，完全不给子进程启动的机会。

#### 根因 3：CMD 与 Linux 跨平台语法混淆高发类型清单

在 Agent 交互过程中，主要有 6 类语法混淆导致 `[scriptblock]::Create` 崩溃或执行报错：

| 混淆类别              | 典型错误命令示例                                     | 触发的异常 / 报错信息                                                                                               | 根因机制                                                                                                  |
| :-------------------- | :--------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------ | :-------------------------------------------------------------------------------------------------------- |
| **1. 语句连接符**     | `npm run build && npm test`                          | `ParseException: The token '&&' is not a valid statement separator in this version.`                                | 在 Windows PowerShell 5.1 中 `&&` 是非法 Token（PS7 才支持）；在 PS5.1 中应使用 `;` 或 `-and` 条件控制。  |
| **2. CMD 裸与号**     | `git status & git branch`                            | `ParseException: The ampersand (&) character is not allowed. The & operator is reserved for future use.`            | PowerShell 中 `&` 是调用操作符（Call Operator），不能作为语句分隔符。                                     |
| **3. CMD 空重定向**   | `cargo check 2>nul`、`command >nul`                  | `ParseException: The '2>nul' operator is not supported.` 或尝试写入名为 `nul` 的物理文件                            | CMD 中 `nul` 是伪设备；PowerShell 重定向空目标必须为 `$null`（如 `2>$null`）或使用 `Out-Null`。           |
| **4. 环境变量设置**   | `set NODE_ENV=test && npm start`                     | `ParseException: Unexpected token '=' in expression or statement.`                                                  | CMD 使用 `set K=V`；PowerShell 中 `set` 是 `Set-Variable` 别名，环境变量赋值应为 `$env:NODE_ENV="test"`。 |
| **5. Unix 管道工具**  | `git log \| head -n 10`<br>`cargo test \| grep FAIL` | `CommandNotFoundException: The term 'grep'/'head' is not recognized as the name of a cmdlet, function, or program.` | Windows 原生环境中不存在 `grep`、`head`、`tail`、`sed`、`awk` 等独立可执行程序。                          |
| **6. CMD 命令行开关** | `dir /s /b`、`del /f /q`                             | `ParameterBindingException: A parameter cannot be found that matches parameter name 's'.`                           | PowerShell 中 `dir` 是 `Get-ChildItem` 别名，参数以 `-` 开头，不接受 `/` 开关。                           |

#### 根因 4：探查路径与执行路径倒错，缺乏机制约束

Agent 产生上述命令的深层原因在于：**模型把本该使用只读探查工具完成的诉求，错误地路由到了 `shell_command`。**
例如模型想要“在代码库中搜索某符号”，本应调用 `grep_search(query="foo")`，但模型却生成了 `shell_command(command="git log | grep foo")`，从而在 Windows 环境下撞上 `grep` 不存在的错误。

---

## 二、主动探查工具链健壮性与易用性强化方案

为了从源头上终结 Agent 误用 `shell_command` 替代文件探查的现象，必须对主动探查工具链进行全面规范化与易用性增强。

### 2.1 主动探查工具矩阵与场景映射规范

确立系统级**「主动探查第一法则」**：凡是涉及文件系统状态、代码文本、目录结构、历史上下文的读取探查，必须 100% 走内置只读探查工具，严禁使用 `shell_command`：

```
                    ┌────────────────────────────────────────────────────────┐
                    │                   Agent 探查意图分类                    │
                    └──────────────────────────┬─────────────────────────────┘
                                               │
             ┌───────────────────┬─────────────┴────────────┬───────────────────┐
             ▼                   ▼                          ▼                   ▼
    【项目全貌与骨架】    【文本/符号精准定位】        【代码行级精准阅读】    【文件元数据快速判定】
             │                   │                          │                   │
             ▼                   ▼                          ▼                   ▼
      `project_tree`       `grep_search`               `read_file`          `file_stat`
   (depth=3, dirsOnly)  (query, glob, exclude)   (startLine, endLine)     (size, mtime)
             │                   │                          │                   │
             └───────────────────┴─────────────┬────────────┴───────────────────┘
                                               ▼
                                  【严格禁止使用 shell_command】
                           (严禁 cat, grep, find, dir/s, ls, head)
```

### 2.2 工具定义与 Tool Schema 的精细化改进

在 [`crates/agent-tools/src/tools/`](file:///c:/Software/conex/crates/agent-tools/src/tools/) 中，各探查工具的 Schema 描述需要强化场景指引与避坑说明，消除模型的模糊推测：

#### 1. `read_file` 工具描述强化

- **当前现状**：仅说明了支持 `startLine`/`endLine`。
- **强化方案**：
  - 在 `description` 中明确声明：“_工作区文本文件读取的主力工具。支持指定 1-indexed 行号闭区间（startLine/endLine）进行精准切片，支持使用 contentOffset 进行大文件分段续读。严禁在终端中运行 cat、head、tail、sed 来读取文件，直接使用本工具即可获得带行号与截断标记的高效输出。_”
  - 入参增加明确的类型校验与友好报错：若 `startLine` 超过文件实际行数，不报生硬的 execution failed，而是返回结构化的 `out_of_range` 诊断与总行数提示（`hint: "文件共 N 行，请求行号超出范围"`）。

#### 2. `grep_search` 工具描述强化

- **当前现状**：仅说明是目录递归搜索。
- **强化方案**：
  - 在 `description` 中明确声明：“_工作区文本与代码符号搜索的主力工具。底层集成 Rust 原生高速搜索，自动递归遍历并天然排除 .git、node_modules、target、dist 等构建产物目录（无需手动排除）。支持字符串子串搜索与正则表达式（regex=true），支持 glob 过滤（如 '_.rs'）与 excludeGlobs。严禁在终端中调用 grep、ripgrep、findstr 等外部命令，统一使用本工具。*”
  - 明确标出 `matchPerLine=false` 对应 `grep -l`（文件级路径清单），大幅减少模型为了“找哪些文件包含 X”而在 shell 里写管道的需求。

#### 3. `project_tree` 与 `list_dir` 协同指引

- **`project_tree`**：“_工作区目录树生成工具。快速建立项目骨架与模块认知，内置 mtime 指纹缓存（二次调用毫秒级返回）。严禁在终端运行 tree、dir /s、find 等命令。_”
- **`list_dir`**：“_单层目录探测工具。仅用于查看某特定文件夹下的直接子项清单与子目录条目数 count。需要深层树形视图时请使用 project_tree。_”

#### 4. `file_stat` 快速探活

- **`file_stat`**：“_文件与目录元数据检查工具。极速 O(1) 获取路径类型（file/directory）、字节大小、修改时间与只读属性。严禁使用 shell test 或 dir 探测文件是否存在。_”

---

## 三、PowerShell 命令执行包装与语法防护体系

对于确需执行的构建、测试、Git 操作与脚本运行（`shell_command`），必须从可执行文件解析、脚本包装器容错、以及前置语法诊断三大层面进行彻底加固。

### 3.1 外壳解释器探测优先级重构（pwsh7 优先）

彻底重构 [`crates/agent-tools/src/tools/shell_invoke.rs`](file:///c:/Software/conex/crates/agent-tools/src/tools/shell_invoke.rs) 与 [`apps/agent-workbench/src-tauri/src/process.rs`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/process.rs) 中的 `resolve_system_powershell` 逻辑，确立 **PowerShell 7 (`pwsh.exe`) 绝对优先** 的原则：

```rust
/// 解析 Windows PowerShell 可执行路径：pwsh.exe (PS7+) 绝对优先，powershell.exe (PS5.1) 作为保底回退
pub(crate) fn resolve_system_powershell() -> Result<String, String> {
    // 1. 优先通过 PATH 探测现代 pwsh.exe (PowerShell 7+)
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join("pwsh.exe");
            if candidate.is_file() {
                return Ok("pwsh.exe".into());
            }
        }
    }

    // 2. 检查标准 Program Files 安装路径下的 PowerShell 7
    if let Ok(prog_files) = std::env::var("ProgramFiles") {
        let candidate = std::path::Path::new(&prog_files)
            .join("PowerShell")
            .join("7")
            .join("pwsh.exe");
        if candidate.is_file() {
            return Ok(candidate.display().to_string());
        }
    }

    // 3. 保底回退：系统自带 Windows PowerShell 5.1
    if let Ok(root) = std::env::var("SystemRoot") {
        let candidate = std::path::Path::new(&root)
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
        if candidate.is_file() {
            return Ok(candidate.display().to_string());
        }
    }

    // 4. 最后尝试 PATH 上的 powershell.exe
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join("powershell.exe");
            if candidate.is_file() {
                return Ok("powershell.exe".into());
            }
        }
    }

    Err("未找到可用的 powershell.exe 或 pwsh.exe".into())
}
```

### 3.2 包装脚本容错与异常优雅捕获

重构 `build_windows_powershell_script`，将裸 `[scriptblock]::Create` 放入 `try-catch` 保护块中，防止未捕获的 ParseException 导致整个宿主子进程静默崩溃，并确保完整的错误信息能通过标准错误流返回给模型：

```powershell
$OutputEncoding=[System.Text.UTF8Encoding]::new($false);
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);
[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false);
$env:CI='true';
$env:GIT_TERMINAL_PROMPT='0';
$env:PIP_NO_INPUT='1';
$env:PYTHONUTF8='1';
$env:PYTHONIOENCODING='utf-8';
$env:PAGER='cat';
$global:LASTEXITCODE=$null;
$__raw = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('{payload}'));
try {
    $__sb = [scriptblock]::Create($__raw);
    & $__sb;
    $success=$?;
    $exitCode=$LASTEXITCODE;
    if ($exitCode -ne $null -and $exitCode -ne 0) { exit $exitCode };
    if (-not $success) { exit 1 };
} catch [System.Management.Automation.ParseException] {
    [Console]::Error.WriteLine("[Conex Shell Error] PowerShell 语法解析失败 (ParseException):");
    [Console]::Error.WriteLine($_.Exception.Message);
    [Console]::Error.WriteLine("提示：请检查命令中是否包含 CMD 语法（如 2>nul、& 拼接、set 赋值）或 Windows 缺失的 Unix 工具（如 grep、head）。");
    exit 2;
} catch {
    [Console]::Error.WriteLine("[Conex Shell Error] 命令执行未捕获异常:");
    [Console]::Error.WriteLine($_.Exception.Message);
    exit 1;
}
```

### 3.3 非侵入式轻量前置语法诊断与自愈提示（Pre-flight Diagnostics）

> **反过度设计红线**：禁止引入任何黑盒正则表达式对用户/模型命令进行“自动重写”（Automatic Rewriting）。自动重写容易在复杂嵌套参数、引号包含、正则表达式匹配时破坏合法命令。  
> **正确做法**：**只做只读前置诊断（Read-only Diagnostics），并在命令报错时注入精准的语法对照指引（Self-Healing Syntax Hints）**。

在 [`crates/agent-tools/src/tools/shell.rs`](file:///c:/Software/conex/crates/agent-tools/src/tools/shell.rs) 或 `shell_invoke.rs` 中增加轻量级静态语法诊断器 `diagnose_windows_shell_syntax`：

```rust
/// Windows Shell 语法前置只读诊断建议（非侵入式，不修改原命令）
pub(crate) fn diagnose_windows_shell_syntax(command: &str) -> Vec<String> {
    let mut hints = Vec::new();
    let trimmed = command.trim();

    // 1. 检测 CMD 风格空重定向
    if trimmed.contains("2>nul") || trimmed.contains(">nul") || trimmed.contains("2>NUL") || trimmed.contains(">NUL") {
        hints.push("检测到 CMD 语法 `2>nul` 或 `>nul`。PowerShell 中空重定向应使用 `2>$null` 或 `Out-Null`。".to_string());
    }

    // 2. 检测 CMD 风格环境变量赋值
    if trimmed.starts_with("set ") || trimmed.contains(" set ") {
        if trimmed.contains('=') && (trimmed.contains("&&") || trimmed.contains(';')) {
            hints.push("检测到 CMD 语法 `set VAR=val`。PowerShell 中环境变量设置应使用 `$env:VAR='val'; <command>`。".to_string());
        }
    }

    // 3. 检测 Unix 管道探查工具误用
    let unix_tools = ["grep", "head", "tail", "awk", "sed", "wc", "cat"];
    for tool in unix_tools {
        let pattern_pipe = format!("| {tool}");
        let pattern_pipe_space = format!("|  {tool}");
        if trimmed.contains(&pattern_pipe) || trimmed.contains(&pattern_pipe_space) || trimmed.starts_with(tool) {
            hints.push(format!(
                "检测到终端管道/直接调用 `{tool}`。Windows 环境原生不包含该命令。若需探查/过滤代码，请直接调用内置工具 `grep_search` 或 `read_file`。"
            ));
            break;
        }
    }

    // 4. 检测 CMD 开关风格的 dir / del
    if (trimmed.starts_with("dir ") && trimmed.contains(" /")) || (trimmed.starts_with("del ") && trimmed.contains(" /")) {
        hints.push("检测到 CMD 格式开关（如 `dir /s`、`del /f`）。PowerShell 中请使用原生参数或直接调用 `list_dir` / `project_tree` 工具。".to_string());
    }

    hints
}
```

**自愈提示消费点**：
当命令执行失败（返回非 0 exit code 或 ParseException）时，执行器将 `diagnose_windows_shell_syntax` 生成的建议自动追加到返回给模型的错误文本末尾：

```text
Command failed with exit code 2.
Stderr:
[Conex Shell Error] PowerShell 语法解析失败 (ParseException):
The '2>nul' operator is not supported.

[Conex 智能自愈提示]:
1. 检测到 CMD 语法 `2>nul`。PowerShell 中空重定向应使用 `2>$null` 或 `Out-Null`。
2. 若需过滤日志，建议改用项目内置主动探查工具 `grep_search`。
```

---

## 四、Prompt 与 Schema 协同防护体系

不仅在代码和执行层筑牢防线，还需在 System Prompt 与 Tool Schema 层面统一心智模型，建立三位一体的防护网。

### 4.1 System Prompt 中的 Windows pwsh 执行铁律

在主控与子 Agent 的通用 System Prompt / 角色指引中，注入如下标准化规范：

```markdown
### Windows PowerShell (pwsh) 命令行与主动探查铁律

1. **主动工具优先，严禁 Shell 探查**：
   - 严禁调用 `shell_command` 运行 `cat`, `type`, `head`, `tail`, `sed` 读取文件（必须使用 `read_file`）；
   - 严禁调用 `shell_command` 运行 `dir /s`, `ls -R`, `find`, `tree` 遍历目录（必须使用 `list_dir` 或 `project_tree`）；
   - 严禁调用 `shell_command` 运行 `grep`, `ripgrep`, `findstr` 搜索代码（必须使用 `grep_search`）；
   - 严禁调用 `shell_command` 运行 `test -f`, `dir` 检查文件是否存在（必须使用 `file_stat`）。

2. **PowerShell 7 (pwsh) 语法精确规范**：
   - **语句连接**：使用分号 `;` 分隔多条独立命令；在 PowerShell 7 中可使用 `&&` / `||`，但在需要兼顾环境时优先使用分号 `;` 或显式状态判断；
   - **空重定向**：严禁写 `2>nul` 或 `>nul`，必须写 `2>$null` 或 `| Out-Null`；
   - **环境变量临时赋值**：严禁写 `set VAR=val && cmd`，必须写 `$env:VAR="val"; cmd`；
   - **路径与转义**：Windows PowerShell 完全支持正斜杠 `/` 路径（如 `cargo test -p agent-tools`），包含空格的路径必须使用双引号包裹并配合调用符 `&`。
```

### 4.2 `shell_command` 的 Tool Schema 明确约束

在 [`crates/agent-tools/src/tools/shell.rs:114-132`](file:///c:/Software/conex/crates/agent-tools/src/tools/shell.rs#L114-L132) 中，将 `input_schema` 的 `command` 字段说明精确化：

```json
{
  "command": {
    "type": "string",
    "description": "要执行的 Shell 命令（Windows 下运行于 PowerShell/pwsh 环境）。\n注意：\n1. 严禁使用本工具做文件读取、代码搜索或目录遍历（必须使用 read_file、grep_search、list_dir、project_tree）；\n2. 遵循 PowerShell 语法：禁止使用 CMD 的 2>nul（改用 2>$null）、禁止使用 set VAR=val（改用 $env:VAR='val'）；\n3. 多条命令使用分号 ; 分隔。"
  }
}
```

---

## 五、本方案要删掉什么 / 收敛什么

本方案严格遵守架构收敛原则，消除历史残留的混乱路径与重复定义：

```
================================================================================
                            本方案删掉 / 收敛的旧机制清单
================================================================================

1. 【删掉】Windows PowerShell 5.1 硬编码优先解析路径
   - 现状：shell_invoke.rs 与 process.rs 硬编码优先查找 System32\WindowsPowerShell\v1.0\powershell.exe；
   - 收敛为：严格按照 pwsh.exe (PowerShell 7+) -> powershell.exe (PS5.1) 的确定性单向优先级探测，消除双重实现与版本锁定。

2. 【收敛】探查路径与执行路径彻底分离
   - 现状：Agent 既通过内置工具探查，又通过 shell_command 运行 cat/grep/dir 探查，造成大量语法崩溃与上下文污染；
   - 收敛为：文件系统、代码搜索、目录结构探查收敛为「只读结构化工具唯一合法路径」，shell_command 仅用于编译构建、Git 提交与程序运行。

3. 【禁止】黑盒魔术数字与正则命令自动重写机制
   - 现状：部分历史讨论曾设想在中间层对 shell 命令做自动正则文本替换（如自动把 2>nul 替换为 2>$null）；
   - 明确禁止：坚决不引入黑盒修改逻辑，只做「只读前置诊断 + 失败时友好自愈提示（Self-Healing Syntax Hint）」，保持系统透明与可预测。

4. 【禁止】被动监控与盲目轮询
   - 现状：部分早期测试曾依赖后台定时扫描或被动监控来察觉状态；
   - 明确禁止：坚持主动结构化探查，配合事件驱动的 Reactive Wakeup 通知机制。

================================================================================
```

---

## 六、逻辑演进与实现计划（按逻辑依赖编排）

本实现计划按纯逻辑依赖关系划分为 5 个任务单元，无工期、无人天、无波次/批次命名：

```
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ 单元 1：外壳探测重构 (pwsh7 绝对优先)                                        │
 │ (修改 shell_invoke.rs & process.rs，实现统一的 pwsh.exe 优先查找与版本感知)     │
 └──────────────────────────────────────┬──────────────────────────────────────┘
                                        │
                                        ▼
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ 单元 2：PowerShell 包装脚本与 try-catch 异常加固                            │
 │ (修改 build_windows_powershell_script，拦截 ParseException 并格式化输出)     │
 └──────────────────────────────────────┬──────────────────────────────────────┘
                                        │
                                        ▼
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ 单元 3：非侵入式轻量前置语法诊断与自愈提示器                                │
 │ (在 agent-tools 中实现 diagnose_windows_shell_syntax，在报错中注入 Syntax Hint)│
 └──────────────────────────────────────┬──────────────────────────────────────┘
                                        │
                                        ▼
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ 单元 4：主动探查工具链 Schema 与描述精细化                                  │
 │ (优化 read_file, grep_search, project_tree, list_dir 的 Schema 说明与边界提示)│
 └──────────────────────────────────────┬──────────────────────────────────────┘
                                        │
                                        ▼
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ 单元 5：System Prompt 规范同步与端到端回归断言套件                          │
 │ (更新 Agent 协作提示词，编写覆盖各类 CMD/Unix 混淆命令与 pwsh 防护的自动化测试) │
 └─────────────────────────────────────────────────────────────────────────────┘
```

### 任务单元详述：

- **单元 1：外壳探测重构（`shell_invoke.rs` 与 `process.rs`）**
  - 重构 `resolve_system_powershell()`，PATH 中的 `pwsh.exe` 及 `Program Files\PowerShell\7\pwsh.exe` 优先级高于 `System32\WindowsPowerShell\v1.0\powershell.exe`；
  - 确保 Tauri 壳与 `agent-tools` 共享同一解析逻辑或保持严格同构。

- **单元 2：PowerShell 包装脚本异常捕获**
  - 在 `build_windows_powershell_script` 中引入 `try { ... } catch [System.Management.Automation.ParseException] { ... }`；
  - 注入非交互环境变量（`$env:CI='true'`, `$env:GIT_TERMINAL_PROMPT='0'`, `$env:PIP_NO_INPUT='1'` 等）；
  - 保证非 0 退出码准确传递，且错误详情能完整输出至 Stderr。

- **单元 3：只读前置语法诊断与自愈提示**
  - 在 `agent-tools` 中实现 `diagnose_windows_shell_syntax`；
  - 在 `shell_command` 执行遇到错误时，将诊断建议作为 `hint` 附加于输出结果中，引导模型自动修正。

- **单元 4：探查工具链 Schema 与描述精细化**
  - 更新 `read_file`、`grep_search`、`project_tree`、`list_dir`、`file_stat` 的 `ToolDefinition` 与参数描述；
  - 明确标出各工具的专有能力与替代终端命令的优势。

- **单元 5：Prompt 铁律注入与回归测试套件**
  - 在 `AGENTS.md`、`docs/agent-roles/` 及前端/引擎 Prompt 组装点注入 Windows pwsh 与主动探查铁律；
  - 编写全面的单元测试与集成测试（包含 `2>nul`、`grep|head`、`set VAR=` 等各类典型混淆用例），断言自愈提示与退出码符合预期。

---

## 七、验证断言与质量门禁

本方案落地后，必须通过以下确凿的测试用例与质量门禁进行验证验收：

### 7.1 单元测试断言清单（`shell_tests.rs` & `fs_tests.rs`）

| 测试用例名                            | 测试输入 / 场景                                     | 预期断言                                                                                          |
| :------------------------------------ | :-------------------------------------------------- | :------------------------------------------------------------------------------------------------ |
| `test_pwsh_priority_resolution`       | 模拟环境存在 `pwsh.exe` 与 `powershell.exe`         | 断言 `resolve_system_powershell()` 必须返回 `pwsh.exe` 路径。                                     |
| `test_parse_exception_graceful_catch` | 运行包含严重语法错误的代码（如裸 `&` 或非法重定向） | 断言进程不发生原生崩溃，Stderr 包含 `[Conex Shell Error] PowerShell 语法解析失败`，退出码为非 0。 |
| `test_cmd_syntax_diagnostics`         | 诊断字符串 `cargo check 2>nul`                      | 断言返回包含“_检测到 CMD 语法 `2>nul`，请使用 `2>$null`_”的建议。                                 |
| `test_unix_pipe_diagnostics`          | 诊断字符串 `git log \| grep feat`                   | 断言返回包含“_检测到终端管道 `grep`，请使用 `grep_search`_”的建议。                               |
| `test_read_file_out_of_range_hint`    | `read_file` 请求 `startLine=1000`（文件仅 50 行）   | 断言返回 `hint` 字段明确指示文件总行数与超出范围，不发生 panic。                                  |
| `test_grep_search_skip_dirs`          | 在包含 `node_modules` 与 `target` 的工作区搜索      | 断言结果中绝对不包含被 `SKIP_DIRS` 忽略的目录条目。                                               |

### 7.2 全局流水线与安全门禁

1. **Rust 门禁**：`cargo test -p agent-tools` 与 `cargo test --workspace` 全绿；
2. **TypeScript 门禁**：`npm run typecheck` 全绿；
3. **零绕过铁律**：严禁使用 `--no-verify`，所有 Git 提交必须通过 pre-commit 钩子检查；
4. **编码规范**：所有产出文档与代码均使用 UTF-8 无 BOM、中文 Markdown 编写。
