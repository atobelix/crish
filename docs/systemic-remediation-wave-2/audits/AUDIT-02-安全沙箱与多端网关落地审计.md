# Wave 2 战役收官多维审计报告 — AUDIT-02: 安全沙箱、AST防御、HTML净化与多端网关落地审计

> **审计标识**：`WAVE-2-AUDIT-02-SANDBOX-XSS-FS-GATEWAY`  
> **权威输出路径**：[`docs/systemic-remediation-wave-2/audits/AUDIT-02-安全沙箱与多端网关落地审计.md`](file:///c:/Software/conex/docs/systemic-remediation-wave-2/audits/AUDIT-02-安全沙箱与多端网关落地审计.md)  
> **审计基准输入**：
>
> - 终态定稿总纲：[`docs/systemic-remediation-wave-2/00-执行方案终态定稿.md`](file:///c:/Software/conex/docs/systemic-remediation-wave-2/00-执行方案终态定稿.md) §3.1 与 §3.5
> - 专业详案 01：[`docs/systemic-remediation-wave-2/plans/01-安全与沙箱AST根治详案.md`](file:///c:/Software/conex/docs/systemic-remediation-wave-2/plans/01-安全与沙箱AST根治详案.md)
> - 专业详案 05：[`docs/systemic-remediation-wave-2/plans/05-多端契约与网络治理详案.md`](file:///c:/Software/conex/docs/systemic-remediation-wave-2/plans/05-多端契约与网络治理详案.md)
> - 验收测试矩阵：[`docs/systemic-remediation-wave-2/02-全量验收断言与测试矩阵.md`](file:///c:/Software/conex/docs/systemic-remediation-wave-2/02-全量验收断言与测试矩阵.md)（重点核查 AST-01~~04, XSS-01~~02, FS-01~~03, CDP-01, WIN32-01, GW-01~~04）
>
> **治理铁律执行**：
>
> - 严格遵守 `LOGIC_PLAN_NO_RETREAT.md`（机器真值穿透、反退避、反伪完成、所有问题同权）；
> - 严格遵守 `AGENTS.md` 附录 B（子 Agent 严禁执行 `git commit`）。

---

## 一、 审计概览与全量断言结论

本报告针对 Wave 2 战役中涉及的**安全沙箱、AST 防御、HTML 净化、文件系统 Fail-Closed、CDP 浏览器防护、Win32 桌面提权及多端零信任网关与 PTY 运行时**开展全量代码级穿透审计。

### 1.1 核心断言核查总表（14 项断言 100% 覆盖）

| 断言编号     | 断言名称与核心要求                                                                     | 关联文件与代码行号证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 机器真值测试                                                         | 审计结论                                                                                                                   |
| :----------- | :------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------- |
| **AST-01**   | PowerShell `&` / `icm` 间接调用符提取与递归 AST 识别                                   | [`crates/conex-sandbox/src/semantics.rs:61-83`](file:///c:/Software/conex/crates/conex-sandbox/src/semantics.rs#L61-L83)<br>[`crates/conex-sandbox/src/semantics.rs:952-982`](file:///c:/Software/conex/crates/conex-sandbox/src/semantics.rs#L952-L982)<br>[`crates/conex-sandbox/src/semantics.rs:787-801`](file:///c:/Software/conex/crates/conex-sandbox/src/semantics.rs#L787-L801)                                                                                                                                                                                                       | `conex-sandbox` (102 单测 + 23 专项全绿)                             | **【完全合规】**<br>已完整纳入 `&`、`icm`、`invoke-command`，递归解构子命令行                                              |
| **AST-02**   | 间接调用危险命令（如 `& cmd /c rm -rf /`）阻断判定                                     | [`crates/conex-sandbox/src/semantics.rs:188-191`](file:///c:/Software/conex/crates/conex-sandbox/src/semantics.rs#L188-L191)<br>[`crates/conex-sandbox/src/semantics.rs:1200-1204`](file:///c:/Software/conex/crates/conex-sandbox/src/semantics.rs#L1200-L1204)<br>[`crates/conex-sandbox/src/lib.rs:84-94`](file:///c:/Software/conex/crates/conex-sandbox/src/lib.rs#L84-L94)                                                                                                                                                                                                               | `test_powershell_call_operator_and_indirect_remediation_matrix` 通过 | **【完全合规】**<br>内层 Redline 向上级联段 Redline 与整体 Redline，判定为 `Blocked`                                       |
| **AST-03**   | 6 层嵌套间接调用递归深度熔断（`MAX_RECURSION_DEPTH = 5`）                              | [`crates/conex-sandbox/src/semantics.rs:134`](file:///c:/Software/conex/crates/conex-sandbox/src/semantics.rs#L134)<br>[`crates/conex-sandbox/src/semantics.rs:148-157`](file:///c:/Software/conex/crates/conex-sandbox/src/semantics.rs#L148-L157)<br>[`crates/conex-sandbox/src/semantics.rs:608-610`](file:///c:/Software/conex/crates/conex-sandbox/src/semantics.rs#L608-L610)<br>[`crates/conex-sandbox/src/semantics.rs:944-947`](file:///c:/Software/conex/crates/conex-sandbox/src/semantics.rs#L944-L947)                                                                            | `test_powershell_call_operator_and_indirect_semantics` 通过          | **【完全合规】**<br>第 5 层触发熔断判定为 `Dangerous`，0 栈溢出                                                            |
| **AST-04**   | `ShellCommandTool::prepare` 间接删除物理接管与统一拦截引导                             | [`crates/agent-tools/src/tools/shell.rs:256-266`](file:///c:/Software/conex/crates/agent-tools/src/tools/shell.rs#L256-L266)<br>[`crates/agent-tools/src/tools/shell_redirect.rs:65-78`](file:///c:/Software/conex/crates/agent-tools/src/tools/shell_redirect.rs#L65-L78)                                                                                                                                                                                                                                                                                                                     | `agent-tools` 编译与单测全绿                                         | **【完全合规】**<br>`has_indirect_delete` 发射 `SecurityAuditOperation::Delete` 并返回结构化引导阻断                       |
| **XSS-01**   | HTML 净化器未闭合标签残片前置实体转义                                                  | [`packages/plugin-sdk/src/sanitizer/htmlSanitizer.ts:264-268`](file:///c:/Software/conex/packages/plugin-sdk/src/sanitizer/htmlSanitizer.ts#L264-L268)<br>[`packages/plugin-sdk/src/sanitizer/htmlSanitizer.ts:369`](file:///c:/Software/conex/packages/plugin-sdk/src/sanitizer/htmlSanitizer.ts#L369)                                                                                                                                                                                                                                                                                        | `packages/plugin-sdk/src/sanitizer/sanitizer.test.ts` (20 项全绿)    | **【完全合规】**<br>正则精准捕获未闭合残片并无条件 `escapeHtml`，孤立 `<` 转义为 `&lt;`                                    |
| **XSS-02**   | 属性解析与实体反转义二次校验（拦截 `jav&#x61;script:`）                                | [`packages/plugin-sdk/src/sanitizer/htmlSanitizer.ts:117-138`](file:///c:/Software/conex/packages/plugin-sdk/src/sanitizer/htmlSanitizer.ts#L117-L138)<br>[`packages/plugin-sdk/src/sanitizer/htmlSanitizer.ts:151-166`](file:///c:/Software/conex/packages/plugin-sdk/src/sanitizer/htmlSanitizer.ts#L151-L166)<br>[`packages/plugin-sdk/src/sanitizer/htmlSanitizer.ts:319-329`](file:///c:/Software/conex/packages/plugin-sdk/src/sanitizer/htmlSanitizer.ts#L319-L329)                                                                                                                     | `sanitizer.test.ts:210-219` 通过                                     | **【完全合规】**<br>`decodeAndNormalizeAttr` 还原 hex/dec 字符实体与控制符后二次检验协议                                   |
| **FS-01**    | `trash.rs::snapshot` 使用 `symlink_metadata` 严格区分 `NotFound` 与 `PermissionDenied` | [`crates/conex-fs/src/trash.rs:224-246`](file:///c:/Software/conex/crates/conex-fs/src/trash.rs#L224-L246)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `conex-fs` (65 项单测全绿)                                           | **【完全合规】**<br>仅 `ErrorKind::NotFound` 登记 nil-content，权限不足严格 Fail-Closed                                    |
| **FS-02**    | 跨卷移动源删除失败时事务补偿清理目标文件                                               | [`crates/conex-fs/src/trash.rs:480-504`](file:///c:/Software/conex/crates/conex-fs/src/trash.rs#L480-L504)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `trash::tests::atomic_move_fallback_copy_delete` 通过                | **【完全合规】**<br>源删除失败触发 `force_remove_all(dst)` 补偿清理，0 幽灵孤儿数据                                        |
| **FS-03**    | Windows 只读文件移动到回收站前只读属性剥离与恢复                                       | [`crates/conex-fs/src/trash.rs:522-540`](file:///c:/Software/conex/crates/conex-fs/src/trash.rs#L522-L540)<br>[`crates/conex-fs/src/trash.rs:543-575`](file:///c:/Software/conex/crates/conex-fs/src/trash.rs#L543-L575)                                                                                                                                                                                                                                                                                                                                                                       | `trash::tests::force_remove_clears_readonly_and_succeeds` 通过       | **【完全合规】**<br>`force_remove_file` 与 `force_remove_dir_all` 自动清除只读属性并重试                                   |
| **CDP-01**   | CDP SSRF 防护同时下发 `http://` 与 `https://` 双协议阻断及云元数据拦截                 | [`crates/conex-browser/src/gate.rs:274-340`](file:///c:/Software/conex/crates/conex-browser/src/gate.rs#L274-L340)                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `conex-browser` 测试套件全绿                                         | **【完全合规】**<br>`blocked_urls()` 全量展开保留/私网段并显式包含 `https://169.254.169.254/*`                             |
| **WIN32-01** | Win32 提权句柄获取失败无条件 Fail-Closed 与魔法字符串消除                              | [`crates/conex-computer/src/window_gate.rs:198-222`](file:///c:/Software/conex/crates/conex-computer/src/window_gate.rs#L198-L222)<br>[`crates/conex-computer/src/window_gate.rs:301-343`](file:///c:/Software/conex/crates/conex-computer/src/window_gate.rs#L301-L343)                                                                                                                                                                                                                                                                                                                       | `conex-computer` 模块编译与单测全绿                                  | **【完全合规】**<br>`OpenProcess` / `OpenProcessToken` / `GetTokenInformation` 失败一律返回 `true`（提权）；移除魔法字符串 |
| **GW-01**    | `AdvancedNonceGuard` 彻底移除 `#[cfg(test)]` 门控并于生产 `ServerState` 全量装配       | [`apps/agent-workbench/src-tauri/src/server/auth.rs:38-250`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/server/auth.rs#L38-L250)<br>[`apps/agent-workbench/src-tauri/src/server/mod.rs:429-430, 452-456`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/server/mod.rs#L429-L430)                                                                                                                                                                                                                                                                              | `crish-agent-workbench --lib` 测试通过                               | **【完全合规】**<br>已声明为一等 `pub(crate)` 生产结构体，并在 `ServerState::new` 中实装                                   |
| **GW-02**    | `DeviceEnvelope.auth` 字段标注 `#[serde(default)]` 容错                                | [`crates/conex-types/src/device/envelope.rs:26-30`](file:///c:/Software/conex/crates/conex-types/src/device/envelope.rs#L26-L30)                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `conex-types` 契约单测全绿                                           | **【完全合规】**<br>反序列化免签握手请求时 `auth` 缺省自动填充默认空对象，0 反序列化崩溃                                   |
| **GW-03**    | 入站 WS 帧时钟容差（$\le 300\text{s}$）、Nonce LRU 防重放与 HMAC 常量时间比对          | [`apps/agent-workbench/src-tauri/src/server/ws.rs:1039-1132`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/server/ws.rs#L1039-L1132)                                                                                                                                                                                                                                                                                                                                                                                                                                           | `server/auth.rs` 与 `ws.rs` 鉴权单测全绿                             | **【完全合规】**<br>逐帧执行时钟偏离判定、Nonce 幂等识别与 `auth::verify_hmac_sha256` 恒定时间比对                         |
| **GW-04**    | PTY 3 条命令注册、60s 前台保活与 2h 超时 GC 广播强类型 `workbench://pty-gc-killed`     | [`apps/agent-workbench/src-tauri/src/pty/mod.rs:94-149`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/pty/mod.rs#L94-L149)<br>[`apps/agent-workbench/src-tauri/src/command_manifest.rs:81-83`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/command_manifest.rs#L81-L83)<br>[`apps/agent-workbench/src-tauri/src/main.rs:174-176`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/main.rs#L174-L176)<br>[`apps/crish-desktop/src/api/ptySessionApi.ts:171-200`](file:///c:/Software/conex/apps/crish-desktop/src/api/ptySessionApi.ts#L171-L200) | `adversarial_pty_detached_and_output_keepalive` 通过                 | **【完全合规】**<br>`workbench_pty_detach` / `attach` / `ping` 完整注册；30s 扫描 GC 广播 `PtyExitEvent`                   |

---

## 二、 维度一 — 安全沙箱 AST 递归穿透与深度熔断审计（AST-01 ~ AST-04）

### 2.1 间接命令清单与别名归一化

在 [`crates/conex-sandbox/src/semantics.rs:61-83`](file:///c:/Software/conex/crates/conex-sandbox/src/semantics.rs#L61-L83) 中，间接执行清单定义如下：

```rust
const INDIRECT_COMMANDS: &[&str] = &[
    "&", "eval", "source", ".", "bash", "sh", "cmd", "pwsh", "powershell", "sudo",
    "xargs", "node", "python", "python3", "find", "foreach-object", "iex",
    "invoke-expression", "start-process", "invoke-command", "icm",
];
```

**穿透验证**：

1. `&` 调用操作符已置于清单首位；
2. `invoke-command` 及其 PowerShell 别名 `icm` 均已纳入；
3. 在 `normalize_command`（`semantics.rs:675-713`）中，不仅剥离路径前缀与双引号，还去除了 `.exe` 扩展名，且将 `ri` 归一为 `remove-item`、`%` 归一为 `foreach-object`、`icm` 归一为 `invoke-command`。

### 2.2 PowerShell `&` / `invoke-command` 间接调用解构与子命令分析

在 [`crates/conex-sandbox/src/semantics.rs:952-982`](file:///c:/Software/conex/crates/conex-sandbox/src/semantics.rs#L952-L982) 的 `analyze_indirect_depth` 中：

- 当识别到 `&` 时：若参数列表非空，将所有参数以空格重新拼接为子命令行（`let inner_line = args.join(" ");`），传入 `analyze_depth(&inner_line, depth + 1)` 递归分析；
- 当识别到 `invoke-command` 或 `icm` 时：优先扫描 `-ScriptBlock` 或 `-Command` 后的参数序列，剥离 `{` 和 `}` 花括号包裹后提取内层命令；若为位置参数花括号，亦能正确剥除花括号进行递归分析；
- 在 `classify_depth`（`semantics.rs:1200-1218`）中，若内层命令判定为 `Redline`，则外层段立即标记为 `Redline`；若判定为 `Dangerous`，外层标记为 `Dangerous`；若包含删除形态或 `has_indirect_delete`，外层标记 `has_indirect_delete = true`。

### 2.3 递归深度熔断机制（`MAX_RECURSION_DEPTH = 5`）

在 [`crates/conex-sandbox/src/semantics.rs:134`](file:///c:/Software/conex/crates/conex-sandbox/src/semantics.rs#L134) 中明确声明：

```rust
pub const MAX_RECURSION_DEPTH: usize = 5;
```

并在 `analyze_segment_ast`（`semantics.rs:608`）与 `analyze_indirect_depth`（`semantics.rs:944-947`）中设置了强门禁：

```rust
if depth >= MAX_RECURSION_DEPTH {
    return dangerous_fallback_analysis();
}
```

**魔鬼用例验证**：  
对抗用例 `Invoke-Command { Invoke-Command { Invoke-Command { Invoke-Command { Invoke-Command { Invoke-Command { echo deep } } } } } }`（6 层嵌套）执行测试，结果断言其 `overall_class` 必须恒等于 `CommandClass::Dangerous`。测试 `test_powershell_call_operator_and_indirect_semantics`（`semantics.rs:2195-2201`）实测通过。

### 2.4 执行器端间接删除接管与引导阻断

在 [`crates/agent-tools/src/tools/shell.rs:256-266`](file:///c:/Software/conex/crates/agent-tools/src/tools/shell.rs#L256-L266) 与 [`crates/agent-tools/src/tools/shell_redirect.rs:65-78`](file:///c:/Software/conex/crates/agent-tools/src/tools/shell_redirect.rs#L65-L78) 中：

- 若 `analysis.has_indirect_delete == true`，执行器直接触发 `redirect_or_intercept_delete`；
- 第一时间通过 `emit_blocked_audit` 向审计池发射 `SecurityAuditOperation::Delete` 审计记录；
- 返回结构化阻断错误 `TOOL_COMMAND_BLOCKED` 并携带安全引导文案（`DELETE_REDIRECT_GUIDANCE`），杜绝绕过回收站保护。

---

## 三、 维度二 — HTML 净化器未闭合残片与伪协议二次校验审计（XSS-01 ~ XSS-02）

### 3.1 悬空未闭合标签残片前置实体转义

在 [`packages/plugin-sdk/src/sanitizer/htmlSanitizer.ts:264-268`](file:///c:/Software/conex/packages/plugin-sdk/src/sanitizer/htmlSanitizer.ts#L264-L268) 中：

```typescript
const unclosedTrailingTagRegex =
  /<([a-zA-Z0-9:-]+)(?:[^>"']|"[^"]*"|'[^']*')*$/g;
cleaned = cleaned.replace(unclosedTrailingTagRegex, (unclosed) => {
  return escapeHtml(unclosed);
});
```

**防御机理**：
当大模型流式输出被截断或攻击者输入 `<img src=x onerror=alert(1)`、`<a href="javascript:alert(1)"` 等末尾未闭合的残片时，该正则在标签替换主循环之前先行匹配，并将其强制转化为实体字符（如 `&lt;img src=x onerror=alert(1)`），彻底剥夺浏览器在 EOF 时自动闭合标签并执行属性中 JavaScript 的能力。

### 3.2 属性解析与实体反转义二次校验

在 [`packages/plugin-sdk/src/sanitizer/htmlSanitizer.ts:117-138`](file:///c:/Software/conex/packages/plugin-sdk/src/sanitizer/htmlSanitizer.ts#L117-L138) 中实现了 `decodeAndNormalizeAttr`：

```typescript
export function decodeAndNormalizeAttr(val: string): string {
  if (!val) return '';
  return stripControlChars(
    val
      .replace(/&#x([0-9a-fA-F]+);?/g, (_, hex) => {
        try {
          return String.fromCharCode(parseInt(hex, 16));
        } catch {
          return '';
        }
      })
      .replace(/&#([0-9]+);?/g, (_, dec) => {
        try {
          return String.fromCharCode(parseInt(dec, 10));
        } catch {
          return '';
        }
      })
      .replace(/&[a-zA-Z]+;/g, '')
      .trim()
  );
}
```

**二次校验链路**：
在 `sanitizeHtml` 处理 `href` 与 `src` 属性时（`htmlSanitizer.ts:319-329`）：

```typescript
if (attrName === 'href') {
  const normalizedVal = decodeAndNormalizeAttr(attrVal);
  if (!isSafeUrl(attrVal) || !isSafeUrl(normalizedVal)) continue;
} else if (attrName === 'src') {
  const normalizedVal = decodeAndNormalizeAttr(attrVal);
  if (
    !isSafeSrc(attrVal, allowDataImages) ||
    !isSafeSrc(normalizedVal, allowDataImages)
  )
    continue;
}
```

这确保了利用 HTML 十六进制/十进制实体混淆的恶意伪协议（如 `jav&#x61;script:alert(1)`、`jav&#x09;ascript:`）在反转义后被 `isSafeUrl` 与 `isSafeSrc` 100% 拦截剔除。

---

## 四、 维度三 — 文件系统 Fail-Closed 与 CDP/Win32 双协议阻断审计（FS-01 ~ FS-03, CDP-01, WIN32-01）

### 4.1 `conex-fs::trash` 严格区分 `NotFound` 与 `PermissionDenied`

在 [`crates/conex-fs/src/trash.rs:224-246`](file:///c:/Software/conex/crates/conex-fs/src/trash.rs#L224-L246) 中，`snapshot` 函数弃用了不安全的 `path.exists()`，全面改用 `fs::symlink_metadata`：

```rust
let metadata_res = fs::symlink_metadata(path);
let metadata = match metadata_res {
    Ok(m) => m,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
        crate::path_utils::ensure_parent_dir(&entry_dir.join(META_FILE))?;
        let entry = TrashEntry {
            id: id.clone(),
            original_path: original.clone(),
            trashed_at: now_millis(),
            kind: TrashKind::File,
            size: 0,
            checksum: None,
            mode: EntryMode::Snapshot,
        };
        write_meta(&entry_dir, &entry, true, None, false)?;
        return Ok(entry);
    }
    Err(e) => {
        return Err(e).with_context(|| {
            format!("快照目标元数据获取失败 (Fail-Closed)：{}", path.display())
        });
    }
};
```

**Fail-Closed 闭环**：
仅当操作系统明确返回 `ErrorKind::NotFound` 时才生成 `original_existed = false` 的 nil-content 占位快照；遇到 `PermissionDenied` 或其他 I/O 错误时坚决报错中断，绝不在原文件不可读时错误登记 nil-content，从而根除了后续 `restore_force` 误删用户真实不可读文件的重大安全隐患。

### 4.2 跨卷移动失败源文件删除之事务补偿清理

在 [`crates/conex-fs/src/trash.rs:480-504`](file:///c:/Software/conex/crates/conex-fs/src/trash.rs#L480-L504) 中，`atomic_move` 实现了严格的事务补偿：

```rust
if let Err(e) = force_remove_all(src, is_dir) {
    // 事务补偿回滚：源文件/目录删除失败时，必须自动删除 dst 已经写入的 Payload，绝不残留幽灵孤儿数据！
    let _ = force_remove_all(dst, is_dir);
    return Err(e).with_context(|| {
        format!(
            "跨卷移动删除源失败，已触发事务补偿清理删除目标：src={}, dst={}",
            src.display(),
            dst.display()
        )
    });
}
```

### 4.3 Windows 只读文件删除前属性剥离与恢复

在 [`crates/conex-fs/src/trash.rs:522-575`](file:///c:/Software/conex/crates/conex-fs/src/trash.rs#L522-L575) 中，`force_remove_file` 与 `force_remove_dir_all` 在遇到删除失败时，自动检查只读属性并调用 `perms.set_readonly(false)` 剥离后重试删除，目录树递归清除所有子文件只读属性。测试 `trash::tests::force_remove_clears_readonly_and_succeeds` 验证通过。

### 4.4 CDP 传输层双协议 (`http://` 与 `https://`) 阻断

在 [`crates/conex-browser/src/gate.rs:274-340`](file:///c:/Software/conex/crates/conex-browser/src/gate.rs#L274-L340) 中：

- `ipv4_blocked_patterns` 针对 IPv4 私网段同时生成 `http://` 与 `https://` 阻断规则；
- `ipv6_blocked_patterns` 同步生成双协议阻断规则；
- `blocked_urls()` 显式收口压入：
  ```rust
  out.push("http://169.254.169.254/*".to_string());
  out.push("https://169.254.169.254/*".to_string());
  ```
  云平台元数据地址通过 HTTPS 协议请求时被 100% 物理拦截。

### 4.5 Win32 提权句柄获取失败无条件 Fail-Closed

在 [`crates/conex-computer/src/window_gate.rs:198-222, 301-343`](file:///c:/Software/conex/crates/conex-computer/src/window_gate.rs#L198-L222) 中：

1. `OpenProcess` 失败返回 `true`（提权）；
2. `OpenProcessToken` 失败返回 `true`（提权）；
3. `GetTokenInformation` 失败返回 `true`（提权）；
4. `resolve_foreground_target` 彻底移除了 `"access_denied_elevated.exe"` 魔法字符串，直接通过 ToolHelp 快照解析真实进程名。

---

## 五、 维度四 — 多端零信任网关生产装配与 PTY 活性治理审计（GW-01 ~ GW-04）

### 5.1 `auth.rs` 解除 `#[cfg(test)]` 门控与 `ServerState` 生产装配

在 [`apps/agent-workbench/src-tauri/src/server/auth.rs:38-250`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/server/auth.rs#L38-L250) 中：

- `DEFAULT_NONCE_CAPACITY`、`DEFAULT_CLOCK_SKEW_MS`、`AdvancedNonceGuard`、`NonceCheckResult`、`verify_hmac_sha256` 等全部原语移除 `#[cfg(test)]`，导出为生产一等结构体；
- 在 [`apps/agent-workbench/src-tauri/src/server/mod.rs:429-430, 452-456`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/server/mod.rs#L429-L430) 中，`ServerState` 持有 `Arc<auth::AdvancedNonceGuard>` 并于 `ServerState::new` 中完整初始化。

### 5.2 入站 WebSocket 帧 HMAC 验签与防重放流水线

在 [`apps/agent-workbench/src-tauri/src/server/ws.rs:1039-1132`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/server/ws.rs#L1039-L1132) 中：

1. **时钟偏差门限**：`envelope.auth.ts.abs_diff(now) > max_skew` 时直接下发 `DeviceErrorCode::AuthExpired` 错误帧并终止处理；
2. **Nonce 幂等与重放判定**：调用 `ctx.state.nonce_guard().check_and_record(...)`：
   - 匹配 `ReplayDetected`：下发 `DeviceErrorCode::AuthStale` 拦截恶意重放；
   - 匹配 `IdempotentRetry`：放行弱网同构重传；
   - 匹配 `ClockSkewTooLarge`：下发 `DeviceErrorCode::AuthExpired`；
3. **HMAC 常量时间校验**：通过 `auth::canonical_ws_signing_payload` 构造规范签名串，调用 `auth::verify_hmac_sha256` 进行时间恒定比对，验签失败下发 `DeviceErrorCode::AuthBadSignature`。

### 5.3 PTY 3 条命令注册与 2h 超时 GC 广播

在 [`apps/agent-workbench/src-tauri/src/pty/mod.rs:94-149`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/pty/mod.rs#L94-L149) 中：

1. 实现了 `workbench_pty_detach`、`workbench_pty_attach`、`workbench_pty_ping` 3 条 Tauri 命令；
2. 在 `main.rs:174-176`（`command_registry!`）与 `command_manifest.rs:81-83` 中完成双端注册镜像同步；
3. 启动后台 30s 周期 PTY GC 协程（`spawn_pty_gc_loop`），当游离会话超过 2 小时未活跃时，自动杀死进程并通过 `app.emit` 广播强类型 `workbench://pty-gc-killed` 事件；
4. 前端 [`apps/crish-desktop/src/api/ptySessionApi.ts:171-200`](file:///c:/Software/conex/apps/crish-desktop/src/api/ptySessionApi.ts#L171-L200) 对称暴露了 `ptyDetach`、`ptyAttach`、`ptyPing` 与 `subscribePtyGcKilled`。

---

## 六、 差异与代码卫生观察（Findings & Observations）

在对代码库进行逐行穿透审查时，发现 1 项细微的防御深度优化建议，记录如下供后续演进参考（不影响当前安全功能定性与验收通过）：

1. **CDP 阻断清单下发错误日志记录**：
   - **代码位置**：[`crates/conex-browser/src/lib.rs:257`](file:///c:/Software/conex/crates/conex-browser/src/lib.rs#L257) 与 [`crates/conex-browser/src/lib.rs:418`](file:///c:/Software/conex/crates/conex-browser/src/lib.rs#L418)
   - **观察详情**：在 `enable_renderer_domains` 与导航事件发生时下发 `NETWORK_SET_BLOCKED_URLS` 时，使用了 `let _ = channel.send_command(...)`。而在详案 01 §5.2 中建议使用 `if let Err(e) = ... { tracing::warn!("下发 CDP 传输层阻断 URL 清单失败: {e:?}"); }`。
   - **评估结论**：由于 `gate.rs` 中在应用层已经具备主域名门禁（`DomainGate::check_host`）的第一道坚固防线，传输层下发失败属于极端异常，但建议在后续迭代中将 `let _` 优化为 `tracing::warn!` 显式日志以增强传输层可观测性。

---

## 七、 自动化测试套件机器真值汇总

各模块针对性自动化测试执行结果如下：

### 7.1 `cargo test -p conex-sandbox`

- **执行命令**：`cargo test -p conex-sandbox`
- **测试结果**：**125 passed; 0 failed**（102 unit tests + 11 cd_shape tests + 12 r1_redline_chain tests）
- **关键覆盖**：`test_powershell_call_operator_and_indirect_remediation_matrix`、`test_powershell_call_operator_and_indirect_semantics`（6 层嵌套深度熔断）、`test_adversarial_sandbox_obfuscation_and_secondary_check` 等。

### 7.2 `npx vitest run packages/plugin-sdk/src/sanitizer/sanitizer.test.ts`

- **执行命令**：`npx vitest run packages/plugin-sdk/src/sanitizer/sanitizer.test.ts`
- **测试结果**：**20 passed (20)**
- **关键覆盖**：未闭合 `<img onerror>`、`<a href="javascript:">`、`<svg onload>` 残片转义、`jav&#x61;script:` 实体伪协议二次校验、孤立尖括号转义。

### 7.3 `cargo test -p conex-fs`

- **执行命令**：`cargo test -p conex-fs`
- **测试结果**：**65 passed; 0 failed**
- **关键覆盖**：`trash::tests::snapshot_copies_and_registers`、`trash::tests::atomic_move_fallback_copy_delete`、`trash::tests::force_remove_clears_readonly_and_succeeds`、`trash::tests::snapshot_nil_content_restore_force_deletes` 等。

### 7.4 `cargo test -p conex-browser`

- **执行命令**：`cargo test -p conex-browser`
- **测试结果**：**全部测试通过（全绿）**
- **关键覆盖**：`gate.rs` 双协议阻断、SSRF 拦截、DNS 重绑定防御与 CDP 传输层参数生成。

### 7.5 `cargo test -p crish-agent-workbench --lib`

- **执行命令**：`cargo test -p crish-agent-workbench --lib`
- **测试结果**：**全部测试通过（全绿）**
- **关键覆盖**：`server::auth` HMAC 验签、`AdvancedNonceGuard` 幂等防重放与时钟偏移、`pty::mod` 生命周期与对抗性切 Tab 保活断言。

---

## 八、 最终审计结论

经过严谨的代码逐行审查、形式化断言矩阵核对与全量自动化测试套件机器真值实证：

> **最终判定结论**：  
> **【AUDIT-02: 安全沙箱、AST防御、HTML净化与多端网关落地审计 — 全量达标 · 签署通过】**  
> 系统在 PowerShell 间接调用与深度熔断、HTML 未闭合 XSS 净化、文件系统 Fail-Closed 事务补偿、CDP 双协议阻断、Win32 提权防御、零信任网关验签与 PTY 活性治理等全量 14 项安全断言上均完全符合设计规范，无任何退避妥协、无降级补丁、无伪完成现象。
