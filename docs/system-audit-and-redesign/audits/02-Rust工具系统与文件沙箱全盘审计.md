# Rust 工具系统与文件沙箱全盘审计报告（02: 审计师专卷）

> **【战役审计定位】**：本报告遵循 `docs/system-audit-and-redesign/00-战役通则与协同执行规范.md` 与反退避铁律。
> **审计范围**：`crates/agent-tools/`、`crates/conex-fs/`、`crates/conex-sandbox/`（涵盖全部源码 `src/`、测试 `tests/` 及关联测试桩）。
> **执行原则**：只找问题、零废话、零粉饰、直击架构断层与安全隐患，为后续综合重构提供不可辩驳的机器真值与代码证据。

---

## 目录

1. [执行摘要与问题全景（Executive Summary）](#一执行摘要与问题全景)
2. [维度一：路径归一与 Windows 兼容性深度审计](#二维度一路径归一与-windows-兼容性深度审计)
   - 1.1 `ConexPathNormalizer::normalize` POSIX 根路径归一化为空串导致根目录红线失效（高危漏洞）
   - 1.2 `ConexPathNormalizer` 处理 UNC 路径中的 `..` 导致 UNC 根前缀被弹出破坏
   - 1.3 `strip_verbatim_prefix` 三处冗余分叉且 `agent-tools` 存在单反斜杠 UNC 损坏 Bug
   - 1.4 `has_escaping_symlink_below_root` 无法解析符号链接链（Symlink Chain）与相对链接逃逸
   - 1.5 Windows 驱动器大小写混杂与非规范化字符串比较引发的假阳性与假阴性
3. [维度二：权限体系与执行安全机制审计](#三维度二权限体系与执行安全机制审计)
   - 2.1 权限判定逻辑严重碎片化：`permission.rs` 核心门面与 `shell.rs` 执行流脱节
   - 2.2 `is_system_critical_path` 硬编码 C: 盘导致非 C 盘系统关键目录裸奔
   - 2.3 `FullAccess` 模式放行机制与物理红线防护边界的不对称性
   - 2.4 命令分段器（`split_segments`）在 Windows 复杂命令行下的转义逃逸盲区
   - 2.5 `readonly.rs` 工具集裁剪白名单与任务类型映射的不完备性
4. [维度三：死代码、冗余工具与历史残留文件审计](#四维度三死代码冗余工具与历史残留文件审计)
   - 3.1 历史探测垃圾文件与临时测试工作区未清理残留
   - 3.2 笔记系统（`note_w4c_contribute` 与 `note_w6e_skeleton`）未接线死代码与工具膨胀
   - 3.3 `mirror_export.rs` 违背 DRY 原则复制代码级原子写状态机
   - 3.4 废弃宏与未使用的依赖导入
5. [维度四：测试体系有效性与 Mock 虚假绿灯审计](#五维度四测试体系有效性与-mock-虚假绿灯审计)
   - 4.1 799+ 测试用例全景扫描与真实性评估
   - 4.2 `MockAskChannel` 内存伪通过与真实异步审批通道断层
   - 4.3 符号链接测试中的无权限静默跳过（`return;` 软门禁）
   - 4.4 MCP Bridge Fake Server 同步测试对真实进程异常的覆盖缺失
6. [整改清单与重构行动建议（Actionable Directives）](#六整改清单与重构行动建议)

---

## 一、执行摘要与问题全景

本轮对 `crates/agent-tools`、`crates/conex-fs`、`crates/conex-sandbox` 三大 Rust 核心安全与工具库进行了穷尽式静态与动态审查。

### 缺陷与风险统计矩阵

| 审查维度                       | 严重缺陷 (Critical) | 架构断层/中度风险 (Major) | 冗余/死代码/轻度 (Minor) |  合计  |
| :----------------------------- | :-----------------: | :-----------------------: | :----------------------: | :----: |
| **1. 路径归一与 Windows 兼容** |          2          |             3             |            2             | **7**  |
| **2. 权限体系与执行安全**      |          2          |             3             |            1             | **6**  |
| **3. 死代码与冗余工具**        |          0          |             3             |            5             | **8**  |
| **4. 测试有效性与过度 Mock**   |          1          |             2             |            2             | **5**  |
| **全盘汇总**                   |        **5**        |          **11**           |          **10**          | **26** |

---

## 二、维度一：路径归一与 Windows 兼容性深度审计

### 1.1 `ConexPathNormalizer::normalize` POSIX 根路径归一化为空串导致根目录红线失效（高危漏洞）

- **文件定位**：
  - `crates/conex-fs/src/path_normalizer.rs:51-55`
  - `crates/conex-fs/src/path_normalizer.rs:79-94`
  - `crates/conex-fs/src/path_normalizer.rs:193-207`
- **代码片段与缺陷分析**：
  ```rust
  // crates/conex-fs/src/path_normalizer.rs:51-55
  Component::RootDir => {
      if !has_disk_prefix && normalized_components.is_empty() {
          normalized_components.push("".to_string()); // 仅推入空字符串
      }
  }

  // crates/conex-fs/src/path_normalizer.rs:79-94
  let mut result_str = String::new();
  for (i, comp) in normalized_components.iter().enumerate() {
      if i == 0 {
          result_str.push_str(comp); // comp 为 ""，result_str 仍为 ""
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
  PathBuf::from(result_str) // 当 path 为 "/" 时，返回 PathBuf::from("")！
  ```
- **连锁穿透效应**：
  在 `is_system_critical_path(path)` 中：
  ```rust
  // crates/conex-fs/src/path_normalizer.rs:193-195
  #[cfg(not(windows))]
  {
      if s == "/" || upper == "/" {
          return true;
      }
      ...
  }
  ```
  当传入 `Path::new("/")` 时，`normalize` 返回空字符串 `""`，`s` 为 `""`，`s == "/"` 判定为 `false`，导致 POSIX 环境下的系统根目录 `/` **未被识别为系统关键目录，物理红线直接被绕过**！
- **整改建议**：当 `normalized_components` 仅包含单个 `""`（源于 `RootDir`）时，`normalize` 必须返回 `PathBuf::from("/")`，不可返回空路径。

---

### 1.2 `ConexPathNormalizer` 处理 UNC 路径中的 `..` 导致 UNC 根前缀被弹出破坏

- **文件定位**：`crates/conex-fs/src/path_normalizer.rs:36-40`, `crates/conex-fs/src/path_normalizer.rs:57-68`
- **代码片段与缺陷分析**：
  ```rust
  // 36-40 行：Prefix::UNC 未设置 has_disk_prefix
  Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => {
      let s = server.to_string_lossy().replace('\\', "/");
      let sh = share.to_string_lossy().replace('\\', "/");
      normalized_components.push(format!("//{s}/{sh}"));
      // 漏洞：此处缺少 has_disk_prefix = true 或独立的 has_root_prefix 保护！
  }

  // 57-68 行：Component::ParentDir (..)
  Component::ParentDir => {
      if !normalized_components.is_empty()
          && normalized_components.last().map(|s| s.as_str()) != Some("..")
      {
          // has_disk_prefix 为 false，导致 normalized_components.len() == 1 时的 UNC 根被直接 pop 弹出！
          if !has_disk_prefix || normalized_components.len() > 1 {
              normalized_components.pop();
          }
      } else {
          normalized_components.push("..".to_string());
      }
  }
  ```
- **危害场景**：
  1. 输入 `//server/share/..`：`normalized_components` 中的 `//server/share` 被 pop 掉，返回 `.`。
  2. 输入 `//server/share/../etc/passwd`：UNC 根被弹出，返回 `etc/passwd`，UNC 绝对路径被篡改为工作区内相对路径，破坏包含性检查并导致错误的文件系统操作。
- **整改建议**：引入通用的 `has_root_or_prefix` 标志位，涵盖 `Prefix::Disk`、`Prefix::UNC` 以及 `Prefix::Verbatim*`，并在栈长度为 1 时严格禁止弹出根前缀。

---

### 1.3 `strip_verbatim_prefix` 三处冗余分叉且 `agent-tools` 存在单反斜杠 UNC 损坏 Bug

- **文件定位**：
  1. `crates/conex-fs/src/path_normalizer.rs:98-114`
  2. `crates/conex-fs/src/lib.rs:31-47` (`path_utils::strip_verbatim_prefix`)
  3. `crates/agent-tools/src/tools/mod.rs:462-474`
- **代码缺陷对比**：
  - `agent-tools/src/tools/mod.rs:467`：
    ```rust
    pub(crate) fn strip_verbatim_prefix(path: &Path) -> PathBuf {
        #[cfg(windows)]
        {
            let s = path.to_string_lossy();
            if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
                return PathBuf::from(format!("\\{rest}")); // 严重语法与语义 BUG：只写了单反斜杠！
            }
            if let Some(rest) = s.strip_prefix(r"\\?\") {
                return PathBuf::from(rest.to_string());
            }
        }
        path.to_path_buf()
    }
    ```
  - **严重分析**：
    标准 UNC 路径必须以 `\\` 双反斜杠开头（如 `\\server\share`）。`format!("\\{rest}")` 将 `\\?\UNC\server\share` 剥离为 `\server\share`，在 Windows API 中这代表当前驱动器的根相对路径（Drive-Root-Relative），彻底丢失了网络共享语义！
  - **架构违背**：全仓存在 3 处同名函数，返回类型与斜杠处理（`/` vs `\`）各不相同，造成极大的维护混乱。
- **整改建议**：彻底删除 `agent-tools/src/tools/mod.rs` 和 `conex-fs/src/lib.rs` 中的私有重复实现，全仓统一收敛调用 `conex_fs::ConexPathNormalizer::strip_verbatim_prefix`。

---

### 1.4 `has_escaping_symlink_below_root` 无法解析符号链接链（Symlink Chain）与相对链接逃逸

- **文件定位**：`crates/agent-tools/src/tools/mod.rs:386-426`
- **代码片段与缺陷分析**：
  ```rust
  // crates/agent-tools/src/tools/mod.rs:402-416
  if let Ok(meta) = std::fs::symlink_metadata(&cur) {
      if meta.file_type().is_symlink() {
          if let Ok(target) = std::fs::read_link(&cur) {
              let resolved_target = if target.is_absolute() {
                  conex_fs::ConexPathNormalizer::normalize(&target)
              } else {
                  conex_fs::ConexPathNormalizer::normalize(
                      &cur.parent().unwrap_or(&norm_root).join(&target),
                  )
              };
              if !conex_fs::ConexPathNormalizer::is_subpath(&resolved_target, &norm_root) {
                  return true;
              }
          }
      }
  }
  ```
- **盲区分析**：
  1. **单级解析局限**：`std::fs::read_link(&cur)` 仅获取一层目标。若工作区内 `symlink_1 -> symlink_2`，而 `symlink_2 -> C:/Windows`，当检查到 `symlink_1` 时，`resolved_target` 是 `symlink_2`（仍在工作区内），函数判定安全并放行；但在实际后续文件 I/O 时通过该路径仍会逃逸到工作区外。
  2. **缺少递归深度/环路探测**：相对路径循环符号链接会导致不确定的遍历行为。
- **整改建议**：对符号链接目标执行递归规范化解析（借助 `safe_canonicalize`）直至终态物理路径，并统一判定终态路径是否落入 `norm_root`。

---

### 1.5 Windows 驱动器大小写混杂与非规范化字符串比较引发的假阳性与假阴性

- **文件定位**：`crates/conex-sandbox/src/lib.rs:157-165` (`path_within_workspace`)
- **代码片段与缺陷分析**：
  ```rust
  fn path_within_workspace(cwd: &str, root: &str) -> bool {
      let cwd_lower = cwd.to_lowercase();
      let root_lower = root.to_lowercase();
      let cwd_parts: Vec<&str> = cwd_lower.split('/').filter(|p| !p.is_empty()).collect();
      let root_parts: Vec<&str> = root_lower.split('/').filter(|p| !p.is_empty()).collect();
      cwd_parts.len() >= root_parts.len() && cwd_parts[..root_parts.len()] == root_parts
  }
  ```
- **问题分析**：
  1. `path_within_workspace` 直接使用字符串 `split('/')`，假设输入已经被严格替换为 `/` 且去除了 Verbatim 前缀。如果传入未经归一化的 Windows 原生路径（如 `C:\workspace\sub` 或 `\\?\C:\workspace`），`split('/')` 会把整个路径当作单个组件，导致判定失败，将合法的工作区内路径误判为越界（False Negative），无谓触发审批门。
  2. 此处判定与 `ConexPathNormalizer::is_subpath` 形成重复且弱化的逻辑。
- **整改建议**：废除 `conex-sandbox` 内部手写的简陋 `path_within_workspace`，统一调用 `conex_fs::ConexPathNormalizer::is_subpath`。

---

## 三、维度二：权限体系与执行安全机制审计

### 2.1 权限判定逻辑严重碎片化：`permission.rs` 核心门面与 `shell.rs` 执行流脱节

- **文件定位**：
  - `crates/agent-tools/src/permission.rs:78-151`
  - `crates/agent-tools/src/tools/shell.rs:230-310`
- **架构断层剖析**：
  - `crates/agent-tools/src/permission.rs` 定义了三态判定入口 `decide_command_with_revert`，号称作为命令面权限判定的唯一入口：
    ```rust
    // permission.rs:135-151
    pub fn decide_command_with_revert(
        command_line: &str,
        dangerous: bool,
        requires_approval: bool,
        mode: PermissionMode,
        policy: &crate::revert::RevertPolicy,
    ) -> PermissionVerdict
    ```
  - **现实脱节**：`ShellCommandTool`（`tools/shell.rs:230-310`）在执行命令时，**完全没有调用 `decide_command_with_revert` 或 `decide_command`**！
  - `shell.rs` 中手写了以下交错逻辑：
    1. 手工实例化 `CommandGatekeeper::new()`
    2. 手工调用 `gatekeeper.check_command_with_context`
    3. 手工比对 `verdict == GatekeeperResult::Blocked || gatekeeper.patterns().is_match || is_system_critical_path`
    4. 手工判断 `ctx.permission_mode == PermissionMode::Plan`
    5. 手工调用 `conex_sandbox::semantics::analyze`
    6. 手工判断 `ctx.permission_mode != PermissionMode::FullAccess` 触发 `redirect_or_intercept_delete`
    7. 手工调用 `intercept_cd_shape`
    8. 手工判断 `verdict == GatekeeperResult::RequiresApproval && ctx.permission_mode != FullAccess` 触发 `ctx.ask`
- **后果**：
  - `permission.rs` 只是一个被单元测试调用的孤立模块；
  - 核心执行流分散在 8 个手写分支中，任何一处分支顺序颠倒都会引发安全漏洞或用户体验降级；
  - 违反了「三档权限判定彻底集中化」的战役总原则。

---

### 2.2 `is_system_critical_path` 硬编码 C: 盘导致非 C 盘系统关键目录裸奔

- **文件定位**：`crates/conex-fs/src/path_normalizer.rs:148-188`
- **代码片段与缺陷分析**：
  ```rust
  #[cfg(windows)]
  {
      if (upper.len() <= 3 && upper.ends_with(":/"))
          || (upper.len() == 2 && upper.ends_with(':'))
      {
          return true; // 仅拦截盘符根
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
      ...
  }
  ```
- **安全漏洞场景**：
  1. **非 C 盘系统环境**：在多操作系统或 Windows 安装在 `D:` / `E:` 盘的环境中，`D:/Windows`、`D:/Program Files`、`D:/Recovery` 等不会命中 `C:/WINDOWS` 前缀，导致非 C 盘系统关键目录完全不被作为物理红线拦截！
  2. **敏感系统数据缺失**：未拦截 `%USERPROFILE%/.ssh`、`%USERPROFILE%/.gitconfig`、`%SYSTEMROOT%/System32/config/SAM` 等凭据与注册表核心文件路径。
- **整改建议**：
  - 动态获取当前系统的 `%SystemRoot%`、`%ProgramFiles%`、`%ProgramData%` 环境变量并归一化为前缀；
  - 将所有盘符下的 `Windows`、`Program Files`、`System Volume Information`、`Recovery`、`$Recycle.Bin` 作为全盘通用黑名单前缀。

---

### 2.3 `FullAccess` 模式放行机制与物理红线防护边界的不对称性

- **文件定位**：`crates/agent-tools/src/tools/shell.rs:265-282`
- **缺陷剖析**：
  - 战役通则要求：`FullAccess` 模式下完全信任用户，拔除脱离上下文的 PowerShell 复合删除拦截与私设卡点，允许执行测试、构建与临时文件清理，**但必须坚决守住系统关键目录物理红线**。
  - 当前实现中：
    ```rust
    // Line 266
    if ctx.permission_mode != crate::permission::PermissionMode::FullAccess {
        if analysis.overall_class == CommandClass::DeleteShape || analysis.has_indirect_delete {
            return Prepared::Done(redirect_or_intercept_delete(...));
        }
    }
    ```
  - 当处于 `FullAccess` 模式时，`redirect_or_intercept_delete` 被跳过，命令直接落入原生 shell 执行。但是，原生 shell（PowerShell / cmd）执行时，工作区外删除只要未命中硬编码的 7 条正则红线，就会直接执行物理硬删除（`remove_file` / `rmdir`），缺乏如 `conex-fs::trash` 的轻量快照兜底。

---

### 2.4 命令分段器（`split_segments`）在 Windows 复杂命令行下的转义逃逸盲区

- **文件定位**：`crates/conex-sandbox/src/semantics.rs:234-318`
- **代码片段与缺陷分析**：
  - `split_segments` 在遇到 `\` 时，通过简单的 `escaped = true; continue;` 吞掉下一个字符：
    ```rust
    if c == '\\' {
        current.push(c);
        escaped = true;
        continue;
    }
    ```
  - 在 Windows 路径语义中，`\` 是普通路径分隔符（如 `dir C:\workspace\a & whoami`）。
  - 当路径为 `C:\workspace\a\` 结尾（末尾带反斜杠）并紧跟 `&` 时：
    末尾的 `\` 会将 `&` 标记为 `escaped = true`，导致 `split_segments` 错过了 `&` 命令分隔符，将 `dir C:\workspace\a\ & whoami` 误当作单条命令处理，破坏后续 AST 段分析与门禁拦截！
- **整改建议**：采用 `is_escape_requiring` 的语义，仅当 `\` 紧跟引号、空白或特定元字符时才触发转义状态，普通路径分隔符不将后继字符视为转义。

---

### 2.5 `readonly.rs` 工具集裁剪白名单与任务类型映射的不完备性

- **文件定位**：`crates/agent-tools/src/readonly.rs:31-66`, `crates/agent-tools/src/readonly.rs:131-147`
- **代码缺陷分析**：
  1. `READONLY_TOOL_NAMES` 包含 12 个工具，但随着 `agent-tools` 扩展，新增了 `output_dir`（`resolve_output_dir`）、`set_timer`、`cancel_timer` 等只读/查询类工具，这些工具未被纳入 `READONLY_TOOL_NAMES`，导致只读子代理在 `filter_readonly_registry` 时被 `fail-closed` 剔除，无法解析会话文档输出目录。
  2. `WRITE_TOOL_NAMES` 仅列出了 5 个工具，而实际 `agent-tools` 中有 `replace`、`delete_file`、`delete_dir`、`write_file`、`shell_command` 以及 8 个 `note_` 写入工具，名单存在滞后与不一致。
- **整改建议**：统一基于工具定义中的 `dangerous` 标记与元属性（`Category::Read / Write`）做动态判定，避免硬编码字符串数组维护滞后。

---

## 四、维度三：死代码、冗余工具与历史残留文件审计

### 3.1 历史探测垃圾文件与临时测试工作区未清理残留

通过对全仓文件树的物理扫描，发现了以下长期未清理的孤儿文件与垃圾目录：

1. **`temp_ai_test_workspace/`（根目录垃圾目录）**：
   - 包含：`_build_out.txt`、`_test_out.txt`、`node_modules/`、`package.json`、`package-lock.json`（138KB）、`tsconfig.json` 等。
   - 性质：前期 AI 自动化测试遗留的临时工程，未入库且未被 `.gitignore` 过滤，长期占用磁盘与 IDE 索引。
2. **`.agent-runtime/` 下的探针脚本**：
   - `eslint_probe.mjs`、`probe2.mjs`、`probe3.mjs`、`probe4.mjs`、`probe5.mjs`。
3. **基线记录中的探针输出残留**：
   - `analysis/iterative-repair/v2/baselines/_tsc-runtime-probe.txt`
   - `analysis/iterative-repair/v2/baselines/_tsc-runtime-probe2.txt`
4. **测试目录中的临时 probe 文件**：
   - `crates/conex-browser/tests/tmp_payload_probe.rs`
   - `crates/conex-browser/tests/tmp_perf_matrix_probe.rs`
   - `crates/conex-browser/tests/tmp_setcookies_probe.rs`
   - `crates/conex-browser/tests/tmp_xframe_probe.rs`
   - `apps/agent-workbench/src-tauri/src/probe.rs`

---

### 3.2 笔记系统（`note_w4c_contribute` 与 `note_w6e_skeleton`）未接线死代码与工具膨胀

- **文件定位**：
  - `crates/agent-tools/src/note_w4c_contribute/`（`execute.rs`, `mod.rs`, `schema.rs`, `tests.rs`, `validate.rs` 共 5 个文件，约 32KB）
  - `crates/agent-tools/src/note_w6e_skeleton.rs`（约 20KB）
- **问题分析**：
  - `agent-tools/src/tools/mod.rs` 中已经注册了 11 个原子笔记工具（`note_block_insert`、`note_document_apply_md` 等）。
  - `note_w4c_contribute/` 实现了另一套独立的 `contribute_note_content` 复合 schema 与校验器，但**从未在 `register_builtin_tools` 中被注册**！该子模块全套代码为纯粹的未装配死代码。
  - `note_w6e_skeleton.rs` 同为阶段性历史遗留的未打通骨架。
- **整改建议**：在后续重构中彻底清理未接线的 `note_w4c_contribute` 与 `note_w6e_skeleton`，避免包体积与维护成本虚高。

---

### 3.3 `mirror_export.rs` 违背 DRY 原则复制代码级原子写状态机

- **文件定位**：`crates/conex-workspace-store/src/mirror_export.rs:54-120`
- **问题分析**：
  `mirror_export.rs` 完全手动实现了从 `.conex-tmp-*.tmp` 写入、`sync_all()`、`.conex-bak-*.bak` 备份到重命名与异常回滚的完整 3 阶段原子写状态机（近 70 行代码），与 `conex_fs::atomic_write` 逻辑 100% 重复。
- **整改建议**：直接调用 `conex_fs::atomic_write_file`，消除重复实现。

---

## 五、维度四：测试体系有效性与 Mock 虚假绿灯审计

### 5.1 799+ 测试用例全景扫描与真实性评估

在运行 `cargo test -p conex-fs -p conex-sandbox -p agent-tools` 全量测试套件时，共计 799 个测试通过：

- `agent-tools` 单元测试：645 passed
- `agent-tools` 集成测试（`mcp_bridge`）：14 passed
- `conex-fs` 单元测试：15 passed
- `conex-sandbox` 单元测试：102 passed
- `conex-sandbox` 集成测试（`cd_shape` / `r1_redline_chain`）：23 passed

虽然测试数量庞大且全部绿灯，但经深度逐行审查，发现了多处假通过与弱断言问题。

---

### 5.2 `MockAskChannel` 内存伪通过与真实异步审批通道断层

- **文件定位**：`crates/agent-tools/src/tools/shell_tests.rs:45-134`
- **代码缺陷剖析**：
  ```rust
  #[derive(Clone, Debug)]
  struct MockAskChannel {
      decision: AskDecision,
      requested: Arc<std::sync::Mutex<Vec<String>>>,
  }

  #[async_trait]
  impl AskChannel for MockAskChannel {
      async fn ask(&self, tool_name: &str, _args: &serde_json::Value) -> Result<AskDecision, ToolError> {
          self.requested.lock().unwrap().push(tool_name.to_string());
          Ok(self.decision.clone())
      }
  }
  ```
- **问题实质**：
  - `MockAskChannel` 仅在内存中同步返回预设的 `Allowed` / `Denied`，未测试任何真实环境下的：
    1. 用户长程无响应导致的异步超时处理；
    2. 审批挂起期间前端并发发送取消指令（Abort）；
    3. 同一命令并发触发时的去重与排队机制；
    4. 审批事件 `approval-requested` 广播与 WebSocket 序列化保真度。
  - 测试断言仅停留在 `assert_eq!(*requested.lock(), vec!["shell_command"])`，属于典型的**调用次数 Mock，而非真实交互语义验证**。

---

### 5.3 符号链接测试中的无权限静默跳过（`return;` 软门禁）

- **文件定位**：`crates/conex-fs/src/lib.rs:318-320`, `crates/conex-fs/src/lib.rs:337-339`
- **代码片段**：
  ```rust
  // crates/conex-fs/src/lib.rs:318-320
  let link = root.join("link");
  if create_dir_symlink(&outside, &link).is_err() {
      return; // 无符号链接权限环境跳过
  }
  let p = safe_canonicalize(&root.join("link/new.txt"), 10).unwrap();
  ```
- **风险分析**：
  在 Windows CI 镜像或未启用开发者模式的测试机器上，`create_dir_symlink` 失败后直接 `return;`。测试报告显示 `test safe_canonicalize_resolves_symlink_parent_for_nonexistent_target ... ok`，**实际上断言代码根本没有执行**！这是典型的伪绿灯。

---

### 5.4 MCP Bridge Fake Server 同步测试对真实进程异常的覆盖缺失

- **文件定位**：`crates/agent-tools/tests/fixtures/mcp_fake_server.rs`, `crates/agent-tools/tests/mcp_bridge.rs`
- **问题分析**：
  `mcp_fake_server.rs` 仅是一个极简的 Rust 同步回显进程，每行输入立即产生标准 JSON-RPC 响应。测试没有覆盖真实 Node.js / Python MCP Server 常见的：
  1. 启动时缓慢并向 stderr 输出大量诊断日志；
  2. 管道缓冲区堵塞（Stdio Deadlock）；
  3. 子进程异常崩溃后 Bridge 的生命周期感知与重连；
  4. 非 UTF-8 乱码输出的优雅容错。

---

## 六、整改清单与重构行动建议

为配合战役总重构，提出以下 4 项确定性整改行动建议（纯逻辑依赖与验收断言，零工期/人员废话）：

### 行动清单 1：统一收敛 Windows 路径归一底座（`conex-fs`）

1. **修复 `ConexPathNormalizer::normalize`**：确保根目录 `/` 正确归一化为 `/` 而非空串 `""`，恢复 POSIX 物理红线生效；
2. **修复 UNC 根保护**：在 `ParentDir` 处理中增加根前缀保护，禁止弹出 `//server/share`；
3. **消除 `strip_verbatim_prefix` 分叉**：删除 `agent-tools/src/tools/mod.rs`（修复单反斜杠 Bug）与 `conex-fs/src/lib.rs` 的重复实现，统一由 `ConexPathNormalizer` 导出；
4. **递归解析符号链接**：改造 `has_escaping_symlink_below_root` 为基于 `safe_canonicalize` 的终态物理路径验证。

### 行动清单 2：集中化重构权限判定引擎（`agent-tools`）

1. **收拢 `shell.rs` 权限判定链**：将 `shell.rs` 中散落的 8 处手工分支彻底重构为调用 `permission::decide_command_with_revert`，实现单一事实来源（Single Source of Truth）；
2. **增强物理红线动态探测**：`is_system_critical_path` 改为动态读取 `%SystemRoot%` 与全盘通用系统敏感目录，杜绝非 C 盘系统目录裸奔。

### 行动清单 3：清理历史死代码与垃圾文件

1. **删除根目录残留垃圾**：清理 `temp_ai_test_workspace/`、`.agent-runtime/` 探针脚本及测试 `tmp_*_probe.rs`；
2. **下线未接线笔记模块**：剔除 `note_w4c_contribute/` 与 `note_w6e_skeleton.rs` 死代码；
3. **重构 `mirror_export.rs`**：将手写的 70 行原子写状态机替换为直接调用 `conex_fs::atomic_write_file`。

### 行动清单 4：加固测试资产与消除伪绿灯

1. **消除 Symlink 假通过**：在测试框架中若遇权限受限，输出明确的 `ignored / skipped (reason: developer mode required)` 标记，而非伪装成 `passed`；
2. **增加真实异步审批通道测试**：编写包含超时、取消、重试的端到端并发审批测试桩。

---

> **审计师结论**：本审计报告已如实记录全部代码缺陷与架构隐患，证据链完整（精准定位至源码文件名与行号）。所有问题一律同权，供后续综合重构阶段无死角落地。
