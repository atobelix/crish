# 工作区路径越界与 Windows 盘符规范化深度分析报告

**分析师角色**：工作区路径越界与 Windows 盘符规范化分析师  
**被分析模块**：`crates/agent-tools/`、`crates/conex-tools/`、`crates/session-loop/`、`crates/conex-fs/`、`apps/agent-workbench/src-tauri/`  
**核心现象**：
用户在让 AI 读写 `c:/Software/conex/temp_ai_test_workspace` 时，工具报错：
`[tool.path_escape] Path escapes workspace: c:/Software/conex/temp_ai_test_workspace`

---

## 一、代码定位与防护机制梳理

- **错误码定义**：`crates/conex-types/src/error.rs:103` (`pub const TOOL_PATH_ESCAPE: &str = "tool.path_escape";`)
- **抛错核心函数**：`crates/agent-tools/src/tools/mod.rs:320-383` 的 `pub(crate) fn resolve_workspace_path(workspace_root: &Path, input: &str) -> Result<PathBuf, ToolError>`
- **4 处报错分支**：
  1. `mod.rs:343-346`：组件扫描发现 `Component::ParentDir` (`..`) 尝试向上越界；
  2. `mod.rs:351-354`：组件深度超过 `MAX_PATH_DEPTH` (40)；
  3. `mod.rs:367-370`：包含性校验失败 `if !path_within_root(&canonical, &canonical_root)`；
  4. `mod.rs:377-380`：符号链接双保险检测命中 `if has_symlink_below_root(&canonical, &canonical_root)`。

---

## 二、Windows 平台下的路径比较逻辑与根因分析

### 根因 1：`workspace_root` 回退到进程 CWD 导致的根错位（最普遍根因）

- 当前端在无项目/全局对话模式下，`cwd` 为 `None`；
- 后端回退至 `std::env::current_dir()`；
- 在 Tauri / 本地调试环境下，进程工作目录往往是 `C:\Software\conex\apps\agent-workbench\src-tauri`；
- AI 按照用户指令访问绝对路径 `c:/Software/conex/temp_ai_test_workspace`；
- 目标目录位于 `src-tauri` 外部，判定为越界（`path_within_root` 返回 `false`）。
- **AI 随后发现标准文件工具被阻断，因此自动选择改用 PowerShell 脚本绕过文件工具直接写盘**。

### 根因 2：`normalize_for_compare` 遗漏 Windows `\\?\` 长路径前缀剥离

- `crates/conex-fs/src/lib.rs:159` 的 `safe_canonicalize` 调用 Windows 原生 `std::fs::canonicalize`，返回带 `\\?\` 前缀的 UNC 长路径；
- `crates/agent-tools/src/tools/mod.rs:576-587` 的 `normalize_for_compare` 没有剥离 `\\?\` 和 `\\.\` 前缀；
- 一旦一侧带前缀而另一侧不带，字符串前缀包含比较 `c.starts_with(&format!("{r}{sep}"))` 立即失败。

### 根因 3：`has_symlink_below_root` 对 Windows 目录联接（NTFS Junction）的误杀拦截

- Windows 下测试目录常由脚本通过 `mklink /J`（NTFS Junction）创建；
- `symlink_metadata` 对 NTFS Junction 同样返回 `is_symlink() == true`；
- 无条件拒绝根下任何 symlink/junction 组件，导致合法的联接点被当场判为 `tool.path_escape`。

---

## 三、修复方案建议

1. **统一 Windows 路径归一化**：在 `normalize_for_compare` 中剥离 `\\?\UNC\`、`\\?\`、`\\.\` 前缀，并统一小写；
2. **纯对话无工作区状态显式建模**：当 AI 需要新建/操作工作区目录时，提示用户授权并动态设定 `workspace_root`；
3. **治理进程 CWD 回退**：无 `cwd` 时回退到应用真实根目录，而非内部进程路径。
