# R1 安全类高严重度发现独立复核报告

- 复核日期：2026-08-07
- 复核模式：只读（未修改任何源码；临时实证测试运行后已删除）
- 复核对象：Round 1 审计中的 6 组安全发现（F9-01/F3-01、F3-02/F5-01、F3-03、F6-01、F6-02、F5-02）
- 复核方法：① 逐行重读全部相关源码（独立于原报告）；② 对可运行项加临时测试实证（conex-sandbox 门禁 8 形态、conex-search 折叠越界，实测后删除）；③ 无法运行项（Tauri 壳 / Windows 特有路径）做代码路径推演
- 结论总览：**6 组全部确认可触发**，无「不可复现」项；其中 2 组（红线绕过链、Unicode 折叠 panic）经实测实证；原报告整体结论可信，个别描述有精度修正（见各项"与原报告的差异"）

---

## 一、红线绕过链（F9-01 / F3-01，P0）

### 原结论

`echo "$(rm -rf -- /)"`、`printf x\n/bin/rm -rf -- /`、PowerShell `Write-Output x\nri C:\ -Recurse -Force` 等形态绕过命令门禁（红线先行只对段首命令名生效、静态正则被 `--` 阻断、换行不拆段），在任意权限模式下无审批直接执行。Unix 平台 P0，Windows P1。

### 独立验证过程（关键代码路径）

**① 拆段不认换行** — `split_segments`（crates/conex-sandbox/src/semantics.rs:147-198）的 `match c` 只处理 `;`/`&`/`|`（:177-189），`\n`/`\r` 落入 `_ =>`（:190）被原样收入当前段。引号状态（:151、165-171）只影响引号内不拆，不影响换行拆段——换行在引号外也不拆。

**② 命令替换/反引号不递归下沉** — `classify`（semantics.rs:563-634）对 `$(...)` / 反引号包裹的内容不提取：`echo` 不在 `INDIRECT_COMMANDS`（semantics.rs:61-64 = eval/source/./bash/sh/cmd/pwsh/powershell/sudo/xargs/node/python/python3/find/foreach-object），故 :565-580 的递归分支不触发，`echo "$(rm -rf -- /)"` 直接按 echo 判 Normal。`split_command_args`（semantics.rs:230-289）只取**首 token** 为命令名（:286），其余全当参数。

**③ 静态正则被 `--` 阻断** — `blocked_patterns`（lib.rs:24-44）核心条目 `(?i)\brm\s+(-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\s+(/|/\*|\*)`（lib.rs:27）要求 `-rf` 后紧跟 `/`；`rm -rf -- /` 中 `-rf` 与 `/` 之间隔 `--`，不命中。`rm\s+--no-preserve-root`（lib.rs:28）也不命中。

**④ 间接命令清单缺 PowerShell 全家** — `iex`/`Invoke-Expression`/`Start-Process` 不在 INDIRECT_COMMANDS；`analyze_indirect`（semantics.rs:439-546）只提取 `-c`/`-Command`/`/c`/`-e` 之后的内容（:449），`-EncodedCommand <base64>` 提取不到 → inner=None → powershell 按自身判 Normal。

**⑤ 执行面原样透传** — 门禁通过后：Unix `bash -lc <command>`（crates/agent-tools/src/tools/shell.rs:613-618），Windows PowerShell `[scriptblock]::Create($__conexCmd)`（shell.rs:660，整命令 base64 包装），换行/命令替换/iex 均原样执行。门禁调用形态为 `check_command_with_context(&command, &[], ...)`（shell.rs:213，整行作 cmd、args 空），与静态正则 `is_match(&full_line)`（lib.rs:88-90）只比对整行文本。

### 实测实证（临时测试，已删除）

`CommandGatekeeper::check_command` 对以下 8 形态**全部返回 Allowed**（含 cwd 在工作区内的 `check_command_with_context`）：

```
[cmd-subst] "echo "$(rm -rf -- /)""        => Allowed（对照基线 rm -rf -- / = Blocked）
[backtick]  "echo `rm -rf -- /`"           => Allowed
[newline-printf] "printf x\n/bin/rm -rf -- /" => Allowed
[ps-alias-newline] "Write-Output x\nri C:\ -Recurse -Force" => Allowed
[iex]       "iex 'rm -rf -- /'"            => Allowed
[invoke-expression] "Invoke-Expression 'rm -rf -- /'" => Allowed
[start-process] "Start-Process cmd ..."    => Allowed
[ps-encoded] "powershell -EncodedCommand …" => Allowed
```

对照基线 `rm -rf -- /` 与 `sudo rm -rf /` 均为 Blocked（门禁本身有效，绕过仅发生在包裹/分隔形态）。

### 确认结论

**可复现（实测确认）**。三处缺陷（不拆换行、不递归命令替换、`--` 阻断正则）独立成立且合谋生效；`iex`/`EncodedCommand` 为同族缺口。与原报告一致。

### 与原报告的差异（精度修正）

- 原报告称"bash 下 `rm -rf -- /` 递归删根"——GNU coreutils 对 `/` 有内建保护（需 `--no-preserve-root` 才删根），`rm -rf -- /` 在多数发行版会被拒绝；但**破坏性结论不受影响**：`rm -rf -- /etc`、`rm -rf -- "$HOME"`、`rm -rf -- /bin` 等非 `/` 目标无保护，同样全链放行。建议报告表述改为"确定性毁灭目标（除 `/` 受 GNU 保护外均可删）"。
- `printf x\n...` 的 `\n` 指真实换行符（模型输出换行分隔两命令），本复核按此理解验证，成立。

### 修复建议（具体到函数）

1. `split_segments`（semantics.rs:147-198）：`match c` 增加 `'\n' | '\r'` 拆段分支（引号内不拆的 quote 状态已天然覆盖）。
2. `classify` 前置命令替换下沉（semantics.rs:563-634 之前）：新增 `extract_command_substitution(seg) -> Vec<String>`，对 `$(`…`)`、反引号、`{`…`}`（scriptblock）包裹内容提取后递归 `analyze`，任一内层 Redline → 段 Redline（对齐 `analyze_indirect` 先例 :439-546）。
3. `INDIRECT_COMMANDS`（semantics.rs:61-64）增补 `iex`、`invoke-expression`、`start-process`、`foreach-object`（后者已有 scriptblock 支持，前三个缺失）。
4. `analyze_indirect`（semantics.rs:439-546）增补 `-EncodedCommand`/`-enc` 分支：检测到即按「内层不可静态解析」整体升级（RequiresApproval 兜底，不追求解 base64）。
5. 静态正则兜底层（lib.rs:27）：补 `rm\s+-[a-z]*r[a-z]*f[a-z]*(--)?\s+(/|/\*|\*)` 类变体，缩窄 `--` 盲区。
6. 补回归测试：本次实证的 8 形态必须 Blocked + `echo "a\nb"` 引号内换行不误拆的负例。

---

## 二、safe_canonicalize 写路径 symlink 逃逸（F3-02 / F5-01，P1）

### 原结论

conex-fs `safe_canonicalize` 对不存在路径走纯文本归一、不解析父目录符号链接；workbench `resolve_for_write` 有 dangling symlink 问题；`write_file("link/new.txt")` 可写越界。

### 独立验证过程（关键代码路径）

**① conex-fs 词法兜底** — `safe_canonicalize`（crates/conex-fs/src/lib.rs:19-71）：`path.canonicalize()` 失败（:54）→ 组件级文本归一（:56-68），**不解析任何父目录 symlink**。组件级只拒 `..` 与深度（:34-51）。

**② agent-tools 侧（F3-02 主张）——确认，且比原报告更宽** — `resolve_workspace_path`（crates/agent-tools/src/tools/mod.rs:222-270）对 `root/link/new.txt`：`safe_canonicalize` 一次失败即词法归一（mod.rs:264），`path_within_root` 文本包含校验（:270）通过 → 返回 `root/link/new.txt`。**link 指向已存在的根外目录也放行**（无「最近存在祖先 canonicalize」这层）。后续 fs.rs/replace.rs 的写操作跟随 symlink → 根外写入。注意：agent-tools 侧对**任何** symlink 父目录（dangling 或非 dangling）都逃逸，比 workbench 侧宽。

**③ workbench 侧（F5-01 主张）——确认 dangling 形态** — `resolve_for_write`（apps/agent-workbench/src-tauri/src/fs_commands/types.rs:164-212）：

- 已存在目标（:175-183）：canonicalize 后校验，安全；
- 不存在目标走词法分支（:186-211）：`lexically_normalize`（:186）→ 文本包含校验（:187-192）→ **祖先循环**（:194-202）只找最近**存在的**祖先做 canonicalize（:203-209）。
- **dangling symlink**（`root/link → C:\outside\nonexistent`）：`candidate.exists()` = false（Path::exists 跟随链接，目标不存在 → false）→ 祖先循环中 `link` 自身 `exists()` 也是 false（:195）→ 一路 pop 上溯到 `root` → 校验通过 → **返回 lexical `root/link/new.txt`**（:211）。
- 写入链（fs_commands/write.rs:38-48）：`create_dir_all(parent)` 对 dangling symlink 返回 Ok（std 语义：路径已存在即视为成功，不校验目标），`fs::write` 跟随 symlink 在 `C:\outside\nonexistent\new.txt` 落盘 → **根外写入确认**。
- 反向确认：若 `link` 指向**已存在**的根外目录，祖先循环停在 `root/link`（exists()=true）→ canonicalize 解析为根外路径 → :204 拒绝。**workbench 侧只有 dangling 形态可绕**——与原报告 F5-01 措辞完全一致。

### 确认结论

**可复现（代码推演确认；未实测——需创建 symlink 的写盘环境，Windows 下需开发者模式）**。两处入口均成立：workbench `resolve_for_write`（dangling symlink 形态）+ agent-tools `resolve_workspace_path`（任意 symlink 父目录形态，更宽）。与原报告一致，且 agent-tools 侧（F3-02）的放行面比原报告描述的还广。

### 修复建议（具体到函数）

1. **首选**：`safe_canonicalize`（conex-fs/src/lib.rs:54-69）canonicalize 失败分支改为「**最深已存在祖先** canonicalize + 剩余成分词法拼接」（best-effort canonicalize），父级 symlink 由此被解析进 canonical 结果。
2. 双保险：`resolve_workspace_path`（mod.rs:264 之后）与 `resolve_for_write`（types.rs:186-211）在返回前对词法尾部的**每一级**做 `symlink_metadata` + `is_symlink` 检查，命中即拒绝（含 dangling——symlink_metadata 不跟随，dangling 也可见）。
3. 补测试：agent-tools fs write 经 `link/new.txt` 逃逸（Unix symlink + Windows 开发者模式，F8-01 对应）；workbench `write_file_content_rejects_dangling_symlink_parent`。

---

## 三、conex-search Unicode 折叠越界 panic（F3-03，P1）

### 原结论

`score_and_indices` 用**小写化后**的索引回查**原始** Vec（lib.rs:68 `orig_t[ti]`），`İ` 等多字符小写展开使 `t.len() > orig_t.len()` → 越界 panic。

### 独立验证过程（关键代码路径）

- 折叠：`query.to_lowercase()` / `target.to_lowercase()`（crates/conex-search/src/lib.rs:24-33），`to_lowercase` 可产生多字符展开（`İ`(U+0130) → `i` + U+0307 组合点，`ẞ`(U+1E9E) → `ss`）。
- 匹配循环（:45-74）：`for (ti, &tc) in t.iter().enumerate()`，`ti` 是**折叠后**索引；:68 `orig_t[ti]` 直接以折叠索引查原始 Vec。
- 早退守卫（:35）`if q.len() > t.len()` 只比较折叠后长度，不构成 orig 侧的边界保护。

### 实测实证（临时测试，已删除）

`FuzzyMatcher::new(false).score_and_indices("i\u{307}", "x\u{130}")`（查询含折叠展开产物、目标 `xİ`）：

```
thread 'tmp_r1_unicode_fold_oom_probe' panicked at crates\conex-search\src\lib.rs:68:54:
index out of bounds: the len is 2 but the index is 2
```

**panic 实测确认**。顺带验证了两个不触发形态：`"i̇st" × "İstanbul.txt"`、`"ii̇" × "İİ.rs"` 不越界（展开的第二字符索引恰好落在 orig_t 范围内）——说明**触发需要查询串命中折叠展开的产物字符（U+0307），且目标中该字符位置逼近原串末尾**。

### 确认结论

**可复现（实测 panic，lib.rs:68）**。但触发条件比原报告措辞更紧：原报告"磁盘文件名含 İ 即触发"不成立——**还需查询串包含折叠展开产物字符**（如 `i`+U+0307）或目标形态使折叠索引越过 orig 长度。模型/搜索接口传入的查询串是可控输入，攻击者（或注入的模型上下文）可构造；文件名含 İ 是前置环境条件。破坏面：`search_files` 单线程路径（search.rs:116 直接调用）panic 传播，搜索功能崩溃（DoS）；并行版（:168 `join().ok()`）吞掉不崩。Rust 越界索引 debug/release 均 panic（非 UB），无内存破坏。

### 修复建议（具体到函数）

1. `score_and_indices`（lib.rs:15-88）：构建折叠索引映射 `fold_to_orig: Vec<usize>`（对 `t` 的每个折叠字符记录其来源 orig 索引），:68 改为 `orig_t[fold_to_orig[ti]]`；`match_indices` 如需对外（FileHit.match_indices 被前端消费）也应按 orig 坐标映射。
2. 最小改动兜底：:68 加 `if ti < orig_t.len()` 再查（宁可丢失 case-exact bonus，不可越界）。
3. 补测试：`İ` 折叠展开越界用例（本次实证形态）、`ẞ`→ss 用例、`match_indices` 坐标语义断言。

---

## 四、git push refspec 绕过（F6-01，P1）

### 原结论

`push` 白名单（Count(2)）对位置参数零约束：`+refs/heads/main:main` 的 `+` 前缀是 git 原生 force 语义，绕过 C-04"拒绝 force push"；`origin :refs/heads/x` 可删除远端分支。

### 独立验证过程（关键代码路径）

- push 规格：`SubcommandSpec { flags: FLAGS_PUSH(=[]), positional: PositionalRule::Count(2) }`（apps/agent-workbench/src-tauri/src/git.rs:121-124）。
- `validate_git_args` 位置参数处理（:381-389）：`PositionalRule::Count(max)` 分支**只数个数**（`positionals_seen >= max` 报错），对值零约束。
- flag 面（:329-335）：`arg.starts_with('-')` 才进 flag 白名单校验——`+refs/heads/main:main` 以 `+` 开头不进此分支，直接当位置参数放行；`FLAGS_PUSH` 为空数组意味着 `--force`/`-f`/`--force-with-lease` 全被拒（:331），但 **refspec 形态完全绕过 flag 面**。
- 执行：`workbench_git_run`（:175-244）`Command::new("git").args(&validated)` 参数数组直传（:193-200），无 shell——校验是唯一防线，确认防线缺口即漏洞成立。
- 边界确认：`push -- +refs/heads/x` 形态经 `literal_pathspec`（:413-421）加 `:(literal)` 前缀 → 该串不是合法 refspec → git 拒绝 → **`--` 之后不可绕过**（绕过面限于 `--` 之前的位置参数）。
- 现有测试（:516-528 `force_flags_rejected`）只覆盖 flag 形态，无 `+refspec`/`:ref` 用例——与原报告 F8-02 一致。

### 确认结论

**可复现（代码推演确认；未实测——执行 git push 属写操作，复核只读约束不实跑）**。`git push origin +refs/heads/main:main`（force 覆盖远端历史）与 `git push origin :refs/heads/x`（删除远端分支）均通过校验。破坏面：绕过"force push 需审批"承诺，且多出远端分支删除能力。

### 修复建议（具体到函数）

1. `validate_git_args`（git.rs:278-411）新增 `PositionalRule::PushRefspec` 变体用于 push（替换 :121-124 的 Count(2)）：逐位置参数校验——拒绝 `+` 前缀（force 语义）、拒绝 `:<ref>` 空 src 删除形态（`:` 开头）、其余收窄为正则 `^[A-Za-z0-9._/-]+(:(refs/)?heads/[A-Za-z0-9._/-]+)?$`。
2. 补测试：`push_plus_refspec_rejected`、`push_delete_ref_rejected`（F8-02 对应，可先红后绿）。

---

## 五、host_openers cmd /C 注入（F6-02，P1）

### 原结论

`open_path_with_default_app` 用 `cmd /C start "" <target>` 拼参（execute.rs:267-268），target 含 `&` 时 cmd 二次命令解释；红线正则只覆盖毁灭性命令，`&whoami` 等任意命令不命中 → 任意命令执行。

### 独立验证过程（关键代码路径）

- 拼串：`Command::new("cmd").args(["/C", "start", "", &target])`（apps/agent-workbench/src-tauri/src/host_openers/execute.rs:267-268）——Rust args 数组经 CreateProcess 拼接为命令行字符串后由 **cmd.exe 重新解释**（cmd /C 的本质是字符串解析执行）。
- 注入点确认：target **无空格**时不被加引号（std::process 拼接规则）→ 命令行 `cmd /C start "" C:\x&whoami` → cmd 将 `&` 作命令分隔符 → `start "" C:\x` + `whoami` 两条命令。target 含空格时被加引号、引号内 `&` 不生效——**注入需无空格文件名**（或 `"` 逃逸的复杂形态）。
- 门禁面确认：`check_command("start", [&target])`（:244）——语义层 `analyze` 对整行分段后，`start C:\x&whoami` 拆为 `start C:\x`（Normal）与 `whoami`（Normal）两段，无 Redline/Dangerous；静态正则（lib.rs:24-44）为毁灭性命令清单（rm/dd/mkfs/format/del/rd/Remove-Item 等），whoami/powershell 等不命中 → **Allowed**。`patterns().is_match(&target)` 逐参（:245）同口径不命中。
- 前置条件：`p.exists()`（:256）——target 必须是**真实存在的路径**。文件名含 `&` 是合法字符：模型可先经 shell 工具 `touch`/`New-Item` 创建 `a&whoami` 类文件（shell 门禁对普通创建命令放行），再调 `open_path_with_default_app("C:\repo\a&whoami")` → 注入链闭合。
- 现状测试（:363-397）11 条全为毁灭性红线目标，无 `&` 拼接用例——与原报告 F8-05 一致。

### 确认结论

**可复现（代码推演确认；Windows 特有路径，本环境未实跑 cmd）**。核心缺陷（cmd /C 字符串二次解释 + 门禁只覆盖毁灭性命令）成立；注入有前置条件：① 目标路径已存在；② 文件名无空格（含 `&`）。两条件均可由模型在权限内构造。破坏面：任意命令以用户权限执行（原报告表述准确）。定级 P1 合理。

### 修复建议（具体到函数）

1. **首选**：`open_path_with_default_app` Windows 分支（execute.rs:265-294）弃用 cmd /C start，改 `ShellExecuteW`（windows-sys 直调，URL/path 直接传，无 shell 解释层）或 `explorer.exe /select` 参数数组直传。
2. 过渡：门禁层对 target 增加 cmd 元字符（`& | < > ^ ( )`）拒绝（当前 gatekeeper 正则无此维度）。
3. 补 F8-05 测试：`open_path_with_default_app_rejects_metachar_suffix`（`a&whoami`、`a&&calc` 等形态）。

---

## 六、产出目录相对路径无工作区校验（F5-02，P1）

### 原结论

`cleanup_session_outputs_at` 的 `output_dir_meta` 相对路径分支无工作区校验，`workspace_root.join(p)` 直接拼接，p 含 `..` 可逃逸 → 工作区外目录被 trash。

### 独立验证过程（关键代码路径）

- 分支对照（apps/agent-workbench/src-tauri/src/outputs_config.rs:332-342）：
  - 绝对路径分支（:334-339）：`allow_outputs_outside_workspace || path_is_same_or_child(p, workspace_root)` 校验后才 push；
  - **相对路径分支（:340-341）：`workspace_root.join(p)` 直接 push，无任何校验**。
- 逃逸链：`output_dir_meta = "..\..\Users\victim\Documents\x"`（session_meta 可被 `set_session_meta` 任意写入——session_commands.rs:269-283 无 key 白名单/长度约束，F7-03 为上游注入点，本次复核确认其存在）→ `workspace_root.join` 越界 → 目标收集（:330-343）→ `target.exists()`（:360）→ `TrashService::trash_file`（:363）→ **工作区外目录移入回收站**。
- 破坏面核实：trash 删除接管（可恢复，非物理删除）——原报告"可恢复但属越权删除"准确；配合产出根越界红线的 skip 语义（:306-328，`resolve_outputs_root` 越界会跳过清理）对照，**相对分支绕过该红线**——根配置越界会被拦、meta 相对路径逃逸却不会，存在明显的校验不对称。
- 测试现状：:551-709 覆盖绝对路径逃逸（`cleanup_meta_target_outside_workspace_is_ignored`），相对路径逃逸用例缺失——与原报告 F8-07 一致。

### 确认结论

**可复现（代码推演确认；未实跑 trash——只读约束）**。相对分支（:340-341）确无校验，`..` 组件可逃逸；上游 meta 写入点（set_session_meta 无白名单）为触发前提，成立。定级 P1 合理（可恢复的越权删除）。

### 修复建议（具体到函数）

1. `cleanup_session_outputs_at`（outputs_config.rs:291-353）：相对分支与绝对分支同口径——`workspace_root.join(p)` 后先 `lexically_normalize`（复用 fs_commands/types.rs:215 的现成函数）再 `path_is_same_or_child`，越界走与产出根越界同款的 skip+notice 红线（对齐 :312-328）。
2. 上游封口：`set_session_meta`（session_commands.rs:269-283）加 key 白名单（允许 `session_meta_*`、`{sid}:output_*` 登记键）与长度上限 512（F7-03）。
3. 补 F8-07 测试：`cleanup_meta_relative_traversal_skipped`（`..` 组件形态）。

---

## 七、汇总表

| #   | 原编号      | 原定级 | 独立结论                                                                              | 验证方式         | 关键证据位置                                                                                  |
| --- | ----------- | ------ | ------------------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------- |
| 1   | F9-01/F3-01 | P0     | **可复现**（实测 8/8 形态 Allowed）                                                   | 实证测试（已删） | semantics.rs:147-198、61-64、439-546；lib.rs:24-45；shell.rs:213、596-667                     |
| 2   | F3-02/F5-01 | P1     | **可复现**（workbench dangling 形态 + agent-tools 任意 symlink 形态，后者更宽）       | 代码推演         | conex-fs/src/lib.rs:54-68；tools/mod.rs:264-270；fs_commands/types.rs:186-211；write.rs:38-48 |
| 3   | F3-03       | P1     | **可复现**（实测 panic lib.rs:68；触发需查询命中折叠展开产物，比原报告措辞稍紧）      | 实证测试（已删） | conex-search/src/lib.rs:24-33、45-74（:68 越界点）                                            |
| 4   | F6-01       | P1     | **可复现**（`+refspec` 等价 force、`:ref` 删远端分支；`--` 之后不可绕，边界确认）     | 代码推演         | git.rs:121-124、329-335、381-389                                                              |
| 5   | F6-02       | P1     | **可复现**（cmd /C 二次解释 + 门禁仅覆盖毁灭性命令；前置：无空格含 `&` 的已存在路径） | 代码推演         | host_openers/execute.rs:244-268、:256 前置                                                    |
| 6   | F5-02       | P1     | **可复现**（相对分支零校验；上游 set_session_meta 无白名单为触发前提）                | 代码推演         | outputs_config.rs:332-342；session_commands.rs:269-283                                        |

**复核结论**：Round 1 审计的 6 组安全发现全部真实可触发，无夸大无虚报。其中 F9-01/F3-01（P0 红线绕过链）与 F3-03（折叠 panic）经临时测试实测坐实；其余 4 项经逐行代码路径推演确认。建议按原报告优先级推进修复：P0 链（拆段/递归下沉/清单补全）优先，其次 4 项 P1（symlink 逃逸、push refspec、cmd /C、meta 相对路径）。

## 八、诚实边界声明

- 实证测试仅覆盖可独立运行的两个纯函数 crate（conex-sandbox 门禁、conex-search 折叠）；Tauri 壳侧 4 项（symlink 写逃逸、push refspec、cmd /C 注入、meta 相对路径）因写盘/执行/平台条件受限，采用代码路径推演，证据链到「门禁放行 + 执行语义」两层闭合为止。
- 临时测试文件（crates/conex-sandbox/tests/r1_recheck_tmp.rs、crates/conex-search/tests/r1_recheck_tmp.rs）已删除，`git status` 确认无残留；本次复核未修改任何源码。
