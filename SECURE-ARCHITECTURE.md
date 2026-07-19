# Conex/Crish 安全架构终极方案

> **原则**: 安全不是约束，是性能的前提。没有安全，极致性能没有意义。

---

## A) CSP 终极策略

### 生产 CSP (tauri.conf.json)

```json
{
  "security": {
    "csp": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob: asset:; media-src 'self' data: blob:; connect-src 'self' ipc: http://ipc.localhost; worker-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; require-trusted-types-for 'script'"
  }
}
```

| 指令 | 值 | 说明 |
|---|---|---|
| `default-src` | `'self'` | 所有未显式列出的资源类型默认只允许同源 |
| `script-src` | `'self' 'wasm-unsafe-eval'` | 移除 `unsafe-inline`；Web Worker/CSS 中的 wasm 需要 `wasm-unsafe-eval` |
| `style-src` | `'self' 'unsafe-inline'` | CSS-in-JS 需要 inline style；这是唯一保留的 unsafe 指令 |
| `font-src` | `'self' data:` | 移除 fonts.googleapis.com / fonts.gstatic.com（自行托管或禁用 Google Fonts） |
| `img-src` | `'self' data: blob: asset:` | 仅保留必需源 |
| `media-src` | `'self' data: blob:` | 移除 asset: http://asset.localhost 等宽放源 |
| `connect-src` | `'self' ipc: http://ipc.localhost` | **关键变更**: 移除 `http://localhost:* http://127.0.0.1:* ws://* https:`。IPC 只需 `ipc:` 和 `http://ipc.localhost` |
| `worker-src` | `'self'` | blob: 仅当 Worker 需要 |
| `frame-src` | `'self'` | 移除 asset:/http/https/blob/data: 等宽放源 |
| `object-src` | `'none'` | 禁止插件 |
| `base-uri` | `'self'` | 限制 `<base>` 篡改 |
| `form-action` | `'self'` | 禁止表单提交到外部 |
| `require-trusted-types-for` | `'script'` | Trusted Types 强制 innerHTML 安全 |

### 开发 CSP

```json
"csp": "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; connect-src 'self' ipc: http://ipc.localhost http://localhost:* ws://localhost:*; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: asset:; media-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'"
```

开发模式保留 `'unsafe-inline'` 用于 HMR，`connect-src` 放宽到 `localhost:*` 用于 Vite dev server。

---

## B) IPC 权限模型

### 权限分组 (capabilities/default.json)

```json
{
  "identifier": "main-capability",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:event:default",
    "core:event:allow-listen",
    "core:event:allow-emit",
    "core:window:default",
    "core:window:allow-minimize",
    "core:window:allow-maximize",
    "core:window:allow-close",
    "core:window:allow-start-dragging",
    "core:window:allow-set-title",
    "core:window:allow-set-size",
    "core:window:allow-set-position",
    "core:window:allow-is-maximized",
    "core:window:allow-toggle-maximize",
    "core:webview:default",
    "dialog:default",
    "dialog:allow-open",
    "dialog:allow-save"
  ]
}
```

### 命令访问控制

每个 Rust IPC 命令需要显式声明其安全域：

```rust
// 安全域注解宏（设计提案）
#[tauri::command]
#[security(domain = "fs", permission = "workspace:read")]
pub(crate) fn read_file_content(...) { ... }

#[tauri::command]
#[security(domain = "net", permission = "extern:only")]
pub(crate) async fn workbench_http_request(...) { ... }
```

### 命令分类与默认拒绝矩阵

| 命令 | 域 | 默认放行? | 条件 |
|---|---|---|---|
| `read_file_content` | fs | No | 路径必须在 workspace 内 |
| `write_file_content` | fs | No | 路径必须在 workspace 内 |
| `list_directory` | fs | No | 路径必须在 workspace 内 |
| `workbench_http_request` | net | No | 仅允许外网 (非 RFC1918) |
| `workbench_run_shell` | process | No | 仅交互式终端，超时 60s |
| `workbench_open_host_target` | shell | No | 路径必须在 workspace 内 |
| `workbench_open_path_default` | shell | No | 路径必须在 workspace 内 |
| `save_api_config` | config | Yes | 无敏感参数 |
| `get_api_config` | config | Yes | 返回脱敏数据 |
| `sidecar:*` | sidecar | Yes | 仅转发到 daemon WS |

---

## C) 路径安全框架

### 零信任路径解析 (Rust 侧)

```
┌──────────────────────────────────────────────────────┐
│                  前端用户输入路径                       │
└──────────┬───────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────┐
│  层1: 前端白名单校验（防止显而易见的攻击）               │
│  - 检测 ../ 路径穿越                                  │
│  - 检测 NUL 字节注入                                  │
│  - 检测长度上限 (4096)                                 │
│  - 检测非法字符 (<>|?*)                               │
└──────────┬───────────────────────────────────────────┘
           │ 通过
           ▼
┌──────────────────────────────────────────────────────┐
│  层2: Rust 侧 canonicalize()                         │
│  - 符号链接解析                                       │
│  - 环境变量展开                                       │
│  - 短路径名展开 (Windows 8.3)                         │
│  - 统一大小写 (Windows)                               │
└──────────┬───────────────────────────────────────────┘
           │ canonical path
           ▼
┌──────────────────────────────────────────────────────┐
│  层3: 路径前缀校验                                    │
│  - canonical_path.starts_with(workspace_canonical)    │
│  - 零拷贝比较 (无额外分配)                             │
└──────────────────────────────────────────────────────┘
```

### 关键实现 (Rust)

```rust
/// 零信任路径校验：不信任词法、不信任相对路径、必须 canonicalize
fn resolve_workspace_path(requested: &str, workspace: &Path) -> Result<PathBuf, SecurityError> {
    // 层1: 拒绝空路径/NUL 字节
    if requested.is_empty() || requested.contains('\0') {
        return Err(SecurityError::InvalidPath);
    }

    // 层2: 解析为绝对路径
    let path = Path::new(requested);
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        workspace.join(path)
    };

    // 层3: canonicalize 消除 ../../、符号链接、Windows 短路径
    let canonical = candidate.canonicalize()
        .map_err(|_| SecurityError::NotFound)?;

    // 层4: 校验在 workspace 内
    let ws_canonical = workspace.canonicalize()
        .map_err(|_| SecurityError::Internal)?;

    if !canonical.starts_with(&ws_canonical) {
        return Err(SecurityError::OutsideWorkspace);
    }

    Ok(canonical) // 零拷贝: borrow 已存在的分配
}
```

### 前端辅助校验

```typescript
// 前端轻量级预校验（非安全边界，仅用于 UX + 减少无效 IPC）
function isLikelySafePath(path: string): boolean {
  if (!path || path.length > 4096) return false;
  if (path.includes('\0') || /[<>|?*]/.test(path)) return false;
  // 检测编码后的 ../ (%2e%2e%2f)
  if (decodeURIComponent(path).includes('../')) return false;
  return true;
}
```

---

## D) 命令执行安全 — 零 Shell 拼接

### 核心原则

**永不拼接命令字符串**。全部使用 `Command::new(...).args([...])`。

### 1. Git 命令 (sidecar commands.rs → 转发到 daemon)

当前：所有 git 命令通过 JSON 转发到 daemon WebSocket。**该设计已经是安全的**。

需要确认: daemon 侧是否也使用参数数组而非 shell 字符串。

### 2. Shell 执行 (process.rs → workbench_run_shell)

当前设计已经是安全的:
- `build_shell_invocation` 使用 `-EncodedCommand` (PowerShell) 或 `-lc` (bash)
- 命令经 base64 编码传输
- 无法注入额外参数

需修复: 确认 daemon 侧 `shell_command` 工具也使用 `Command::args()` 而非 shell 字符串。

### 3. 系统默认打开 (host_openers.rs)

**当前问题**: `open_path_with_default_app` 使用 `cmd /C start "" "{path}"`。虽然 `path` 是 CI 变量，但 Windows `cmd /C` 仍可被注入。

**修复方案**:

```rust
#[cfg(windows)]
fn open_path_with_default_app(path: &str) -> Result<(), HostOpenerError> {
    // 使用 AssocShellExecute 或 ShellExecuteW API
    // 避免 cmd.exe 作为中间层
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = std::ffi::OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        let result = ShellExecuteW(
            std::ptr::null_mut(),
            w!("open"),
            wide.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        );
        // ...
    }
}
```

### 4. PowerShell 回退命令注入 (host_openers.rs)

**当前问题**: `open_with_shortcut` 使用字符串拼接的 PowerShell 脚本:

```rust
let script = format!(
    "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{}'); ...",
    lnk_path.replace('\'', "''"),
    file_arg.replace('\'', "''"),
);
```

尽管有 `'` 转义，PowerShell 的 `-Command` 参数解析器可能有绕过方式。

**修复方案**: 使用 PowerShell 的安全参数传递:

```rust
// 方案1: 参数通过 stdin 发送，而非 -Command
let payload = serde_json::json!({
    "lnkPath": lnk_path,
    "fileArg": file_arg,
});
let script = format!(
    "$payload = @'{}'@ | ConvertFrom-Json; ...",
    payload.to_string()
);

// 方案2: 改用 Rust 的 lnk 解析库 (lnk-rs)
use lnk::ShellLink;
let lnk = ShellLink::new(lnk_path)?;
let target = lnk.link_info().unwrap().local_base_path().unwrap();
Command::new(target).args([&file_arg]).spawn()?;
```

**推荐方案2**: 使用 `lnk-rs` 库直接解析 `.lnk` 文件，完全避免 PowerShell。

### 5. terminate_process_tree (process.rs)

当前使用:
```rust
Command::new("taskkill")
    .args(["/PID", &pid.to_string(), "/T", "/F"])
```

这已经是安全的参数数组形式。

---

## E) ReDoS 防护清单

### 漏洞位置与修复

#### 1. `command-classifier.ts` — `SAFE_READ_PATTERNS` (41 条正则)

**风险**: 用户输入的 shell 命令与 41 条正则逐一测试。虽然每条正则本身不太可能导致灾难性回溯，但 41 条 × 每个命令执行 = 性能浪费。

**修复**:

```typescript
// 前置长度限制
const MAX_COMMAND_LENGTH = 32_000;
if (command.length > MAX_COMMAND_LENGTH) {
    return { risk: "unknown", reason: "Command too long" };
}

// 使用首词分派表 (已实现: SAFE_READ_DISPATCH)
// 将 41 条缩小到 2-7 条
const firstWord = extractFirstWord(raw);
const candidates = SAFE_READ_DISPATCH.get(firstWord) ?? [];
// 仅测试候选集
```

#### 2. `markdownRender.ts` — `stripThoughtPlaceholders`

```typescript
// 风险行 L192: /^(正在思考中[….\s]*|正在处理[….\s]*)+/gm
// 问题: (...) 内的字符类包含重叠匹配
// 攻击输入: "正在思考" + 大量空格/句点
```

**修复**:
```typescript
// 使用非回溯量词 + 长度上限
const MAX_THOUGHT_LENGTH = 200;
source
  .slice(0, MAX_THOUGHT_LENGTH)
  .replace(/^(正在思考中[….\s]{0,100}|正在处理[….\s]{0,100})/gm, '')
```

#### 3. `markdownRender.ts` — 多个 `new RegExp(zh/en)` 拼接

```typescript
// 风险行 L194-L210: 6 处 new RegExp 拼接 zh
// 问题: zh = '本(?:轮|回合)(?:工作|内容|完成)?(?:总结|小结|回顾)'
// 在 `gim` 模式下可能触发灾难性回溯
```

**修复**:
```typescript
// 全局长度上限
const MAX_INPUT_LENGTH = 100_000;
if (source.length > MAX_INPUT_LENGTH) {
    source = source.slice(0, MAX_INPUT_LENGTH);
}

// 所有正则添加长度锚定
const MAX_LINE_LENGTH = 200;
// 在 stripThoughtPlaceholders 入口做长度截断
```

#### 4. `markdownRender.ts` — `formatMarkdownTextSegment`

```typescript
// 风险行 L394-403: /(?<!\*)\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g
// 问题: 惰性量词 + lookaround 嵌套
```

**修复**:
```typescript
// 限制匹配长度
s = s.replace(
  /(?<!\*)\*(?!\s)([^*\n]{0,80}?)(?<!\s)\*(?!\*)/g,
  // ...
);
```

#### 5. `command-classifier.ts` — `WRITE_PATTERNS`

```typescript
// 风险行 L122: />{1,2}/
// 实际不是 ReDoS 风险，但可优化
// 触发条件: 超长输入重复 > 字符
```

#### 6. 所有正则通用防护

```typescript
// 安全正则包装器
function safeRegex(pattern: RegExp, input: string, timeoutMs = 10): boolean {
    if (input.length > MAX_REGEX_INPUT_LENGTH) return false;
    const start = performance.now();
    const result = pattern.test(input);
    const elapsed = performance.now() - start;
    if (elapsed > timeoutMs) {
        console.warn(`ReDoS warning: ${pattern.source} took ${elapsed}ms`);
    }
    return result;
}
```

### 完整修复清单

| 文件 | 行 | 正则 | 风险 | 修复 |
|---|---|---|---|---|
| command-classifier.ts | 21-80 | 41条 `SAFE_READ_PATTERNS` | 逐条测试超长输入 | 前置长度截断 + 首词分派 |
| markdownRender.ts | 192 | `/^(正在思考中[….\s]*\|正在处理[….\s]*)+/gm` | 量词嵌套 | 长度上限 + 去量词嵌套 |
| markdownRender.ts | 194 | `new RegExp(...zh...)` | 动态拼接 + 回溯 | 全局长度截断 |
| markdownRender.ts | 197 | `new RegExp(zh)` | 同上 | 同上 |
| markdownRender.ts | 201 | `new RegExp(zh)` | 同上 | 同上 |
| markdownRender.ts | 205 | `new RegExp(en)` | 同上 | 同上 |
| markdownRender.ts | 207 | `new RegExp(en)` | 同上 | 同上 |
| markdownRender.ts | 210 | `new RegExp(en)` | 同上 | 同上 |
| markdownRender.ts | 394 | `/(?<!\*)\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g` | lookaround + 嵌套 | 量词上限 80 |

---

## F) 敏感信息保护

### 1. API Key 日志脱敏

当前 `credentials.rs` 使用 DPAPI 加密，但在错误信息/日志中可能泄漏。

```rust
// 日志脱敏函数
fn redact_api_key(key: &str) -> String {
    if key.len() <= 8 {
        return "***".to_string();
    }
    format!("{}...{}", &key[..4], &key[key.len()-4..])
}

// 在 config/persistence.rs 中所有错误路径使用
```

### 2. 错误信息安全

```rust
// 禁止将内部路径泄漏到前端错误
// 当前 fs_commands.rs 返回 format!("Failed to read directory: {e}")
// 改为:
fn safe_error(message: &str, _internal: &dyn std::fmt::Debug) -> String {
    // _internal 仅用于日志，不返回给前端
    message.to_string()
}
```

### 3. Workspace 路径保护

```rust
// 返回给前端时只返回相对路径
fn safe_display_path(absolute: &Path, workspace: &Path) -> String {
    absolute
        .strip_prefix(workspace)
        .unwrap_or(absolute)
        .display()
        .to_string()
}
```

### 4. 日志审计拦截点

| 拦截点 | 敏感数据 | 措施 |
|---|---|---|
| `save_api_config` | API Key | 日志中 redact |
| `config::get_api_config` | API Key | 返回时永远返回 `***` |
| `sidecar:*` 错误消息 | 可能包含 prompt | 前 100 字符截断 |
| `workbench_http_request` | 可能在 body 中含 token | 不记录 body |
| `process.rs` 错误 | shell 命令 | 截断至 200 字符 |

---

## G) 攻击面缩减

### 1. assetProtocol scope

```json
// 当前: "scope": ["**"] → 任意文件读取
// 修复:
"assetProtocol": {
  "enable": true,
  "scope": ["$APPDATA/**", "$RESOURCE/**"]
}
```

### 2. 移除不需要的协议处理

| 协议/功能 | 是否需要 | 措施 |
|---|---|---|
| `asset://` 协议 | 是 (本地资源) | 缩小 scope |
| `blob:` URL | 是 (Worker 相关) | 保持 |
| `data:` URL | 是 (小图片) | 仅允许 image/ 类型 |
| `file://` 协议 | 否 | 在前端 CSP 中阻止 |
| `ftp://` 协议 | 否 | 在 CSP 中阻止 |
| `ws://` | 否 (外用) | 仅允许 ipc: 和 daemon localhost |
| `wss://` | 否 | 前端限制 |
| `telnet://` | 否 | CSP 阻止 |
| `javascript:` | 否 | CSP + Trusted Types |

### 3. 禁用未使用的 Tauri 插件

仅保留必需插件:
- `tauri-plugin-dialog` — 保留
- `tauri-plugin-shell` — **移除** (自行实现 Command)
- `tauri-plugin-fs` — **评估**: 当前用自定义 fs_commands.rs
- `tauri-plugin-http` — **移除** (自行实现 reqwest)

### 4. dev 命令隔离

```rust
// 当前: debug 模式注册 cli_bridge::* 命令
// 问题: release 构建可能忘记 #[cfg(debug_assertions)]
// 确保:
#[cfg(debug_assertions)]
let builder = builder.invoke_handler(register_handlers!(dev));
```

### 5. 端口/服务限制

| 服务 | 端口 | 限制 |
|---|---|---|
| Sidecar daemon | 动态 (127.0.0.1) | 仅绑定 127.0.0.1，不绑定 0.0.0.0 |
| Vite dev server | 5174 | 仅用于开发，CSP `connect-src` 限制 |
| IPC | Tauri internal | 无需额外端口 |
| MCP 服务器 | 动态 | 应绑定 127.0.0.1 并验证来源 |

### 6. SSRF 防护 (workbench_http_request)

```rust
#[tauri::command]
pub(crate) async fn workbench_http_request(
    url: String,
    method: String,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
) -> Result<Value, String> {
    // ... 现有校验 ...

    // 新增: 拒绝内网 IP
    let parsed_url = url::Url::parse(&url).map_err(|_| "Invalid URL")?;
    let host = parsed_url.host_str().ok_or("No host")?;

    // DNS 解析后校验
    let addr = tokio::net::lookup_host((host, 0))
        .await
        .map_err(|_| "DNS resolution failed")?
        .next()
        .ok_or("No address")?;

    if is_private_ip(addr.ip()) {
        return Err("Requests to private networks are not allowed".to_string());
    }

    // ...
}

fn is_private_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            v4.is_loopback() ||        // 127.0.0.0/8
            v4.is_private() ||         // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
            v4.is_link_local()         // 169.254.0.0/16
        }
        std::net::IpAddr::V6(v6) => {
            v6.is_loopback()          // ::1
        }
    }
}
```

---

## H) Function() 动态导入修复

### 当前问题

`sessionDiskMirror.ts` 和 `skillsApi.ts` 中使用:
```typescript
const fs: any = await (Function('return import("@tauri-apps/plugin-fs")')() as Promise<any>);
```

共 11 处使用 `Function()` 动态 import。

### 修复方案

```typescript
// 方案1: 条件静态 import (推荐)
let fsModule: typeof import("@tauri-apps/plugin-fs") | undefined;
try {
  fsModule = await import("@tauri-apps/plugin-fs");
} catch {
  // 降级: Web 环境
}

// 方案2: 构建时条件编译
// vite.config.ts 中使用 define 或 alias
if (import.meta.env.VITE_IS_TAURI) {
  const fs = await import("@tauri-apps/plugin-fs");
}
```

---

## I) 纵深防御架构总图

```
┌─────────────────────────────────────────────────────────┐
│                    用户输入                               │
└──────────┬──────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────┐
│  层1: CSP  (浏览器级)                                    │
│  - script-src 'self' → 阻止任意 JS 注入                  │
│  - connect-src ipc: → 阻止数据外传                       │
│  - object-src 'none' → 阻止插件                          │
└──────────┬──────────────────────────────────────────────┘
           │ 通过 CSP 检查
           ▼
┌─────────────────────────────────────────────────────────┐
│  层2: Tauri 权限 (进程级)                                │
│  - capability 系统                                       │
│  - 每个命令的 allow/deny 规则                             │
│  - assetProtocol scope 限制                              │
└──────────┬──────────────────────────────────────────────┘
           │ 通过权限检查
           ▼
┌─────────────────────────────────────────────────────────┐
│  层3: Rust 输入校验 (后端级)                              │
│  - 路径 canonicalize  + 前缀校验                         │
│  - IP 白名单 (SSRF 防护)                                 │
│  - 命令参数数组 (无 shell 拼接)                           │
│  - ReDoS 防护 (长度上限 + 非回溯)                        │
└──────────┬──────────────────────────────────────────────┘
           │ 通过校验
           ▼
┌─────────────────────────────────────────────────────────┐
│  层4: 前端白名单 (UX 级)                                 │
│  - 路径格式预校验                                        │
│  - 命令分类 (command-classifier)                         │
│  - 敏感操作二次确认                                      │
│  - 日志脱敏                                              │
└─────────────────────────────────────────────────────────┘
```

---

## J) 实施优先级

| 优先级 | 任务 | 影响 | 复杂度 |
|---|---|---|---|
| P0 | assetProtocol scope `["**"]` → 特定路径 | **紧急**: 任意文件读取 | 低 |
| P0 | CSP 移除 `unsafe-inline` 和 `connect-src https:` | **紧急**: XSS + 数据外传 | 中 |
| P0 | SSRF 防护 (workbench_http_request + DNS 校验) | **紧急**: 内网扫描 | 低 |
| P0 | PowerShell 命令注入 (open_with_shortcut → lnk-rs) | **紧急**: 命令执行 | 中 |
| P1 | ReDoS 修复 (6 处正则) | 服务可用性 | 低 |
| P1 | Function() 动态导入移除 (11 处) | XSS 面缩减 | 低 |
| P1 | 日志脱敏 (API Key) | 凭证泄漏 | 低 |
| P1 | command-classifier 分隔符遗漏 ( `&` `|` `;` 外还有 `↵`) | 分类绕过 | 低 |
| P2 | 路径前端预校验 | UX + 减少无效 IPC | 低 |
| P2 | Trusted Types 策略 | XSS 防御 | 中 |
| P2 | Ipc 命令注解 + 自动校验生成 | 长期维护 | 高 |
| P3 | Web 平台安全策略 (Service Worker + API 代理) | 多平台覆盖 | 高 |

---

## K) 验证与测试

### 安全测试用例

```rust
#[cfg(test)]
mod security_tests {
    #[test]
    fn test_path_traversal_rejected() {
        // ../ 路径穿越
        // 符号链接逃逸
        // Windows 短路径
        // NUL 字节注入
        // 超长路径
    }

    #[test]
    fn test_ssrf_blocked() {
        // 127.0.0.1
        // 10.x.x.x
        // 192.168.x.x
        // 169.254.x.x
        // IPv6 loopback ::1
        // DNS rebinding attack
    }

    #[test]
    fn test_shell_injection_blocked() {
        // ; rm -rf /
        // | whoami
        // `malicious`
        // $(malicious)
    }

    #[test]
    fn test_csp_enforced() {
        // inline script blocked
        // eval blocked (prod)
        // connect to external blocked
    }
}
```

### 自动化检查

可在 CI 中集成:
1. `cargo audit` — Rust 依赖漏洞扫描
2. `npm audit` — JS 依赖漏洞扫描
3. `trivy` — 容器/文件系统扫描
4. ZAP — 动态安全测试
5. 自定义 lint — 检测 `Function()`、`eval()`、shell 拼接
