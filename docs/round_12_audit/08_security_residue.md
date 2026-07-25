# Round 6 安全修复残留风险审计

> Agent 8 · 2026-07-24

---

## 1. CSP：`unsafe-eval` 移除 & connect-src 白名单

| 项目 | 状态 | 证据 |
|------|------|------|
| 移除 `'unsafe-eval'` | ✅ 已修复 | `index.html:7` → `script-src 'self' 'unsafe-inline'`，无 `'unsafe-eval'` |
| connect-src 白名单 | ✅ 已修复 | 白名单：`'self' ipc: https://api.openai.com https://api.deepseek.com https://opencode.ai https://api.flowbit.me https://portal.qwen.ai wss://opencode.ai wss://api.openai.com ws://127.0.0.1:` |
| `ws://127.0.0.1:` 尾缀缺端口 | ⚠️ 低风险 | 尾随冒号无端口号时匹配 `ws://127.0.0.1:*` 语义，实际无安全含义 |

**结论**：CSP 正确移除 `unsafe-eval`，connect-src 严格白名单化，无泛域名通配。

---

## 2. localStorage API Key 清除

| 项目 | 状态 | 证据 |
|------|------|------|
| `saveProfiles()` 写入前清除 `apiKey` | ✅ 已修复 | `providerProfiles.ts:519-523` → `list.map(normalizeProfile).map(stripApiKey)` |
| `stripApiKey()` 实现 | ✅ 正确 | `providerProfiles.ts:514-517` → 解构 `{ apiKey: _, ...rest }` 完全剥离 |
| `normalizeProfile()` 也设置 `apiKey: undefined` | ✅ 纵深防御 | `providerProfiles.ts:323` |

**结论**：localStorage 永不持久化 `apiKey`。密钥经 Tauri `profile_secret_set` 命令写入 OS DPAPI/加密存储。

---

## 3. Master Key 与 Vault 路径分离

| 项目 | 状态 | 证据 |
|------|------|------|
| Vault 路径 | ✅ 可配置 | `encrypted-file-store.ts:29` → `basePath/.crish-secrets.enc`（调用方传入） |
| Master Key 路径 | ✅ 分离 | `encrypted-file-store.ts:30-39` → 固定在平台应用数据目录（`~/.config/crish/agent-workbench/.crish-master-key` 等） |
| Master Key fallback 不含 vault 泄漏 | ✅ 安全 | `loadOrGenerateMasterKey()` 读写独立文件，vault 无法推导 master key |

**结论**：Master key 与加密 vault 物理路径分离，符合最佳实践。

---

## 4. MCP env 白名单

| 项目 | 状态 | 证据 |
|------|------|------|
| 白名单定义 | ✅ | `mcp-stdio-adapter.ts:141` → `new Set(['PATH', 'HOME'])` |
| 仅合并 PATH + HOME + config 声明 | ✅ 白名单模式 | `mergeProcessEnv()` at lines 143-160 |
| 声明键从 `process.env` 继承 | ⚠️ 设计说明 | 第 153-158 行：config 中声明的键也会从当前 `process.env` 继承值，最后 `{...base, ...extra}` 以显式值覆盖。如果 config 声明了一个敏感环境变量名，其当前进程值会泄漏到 MCP 子进程。 |
| **安全边界** | ✅ 可接受 | 该行为是"声明即授权"——只有 config 主动提及的键才会被继承；非声明键永不泄漏。 |

**结论**：白名单机制正确，非白名单 + 非声明环境变量不会被继承。建议在文档中明确声明键的继承语义。

---

## 5. DOMPurify 检查：MessageContent.tsx

| 项目 | 状态 | 证据 |
|------|------|------|
| `containerRef.current.innerHTML = wrappedHtml` | ❌ **未修复** | `MessageContent.tsx:96-98` → 直接赋值 innerHTML，无 DOMPurify |
| 项目中已使用 DOMPurify | ✅ | `InlineAgentPanel.tsx:73`, `SkillDetail.tsx:101`, `FilePreview.tsx:142`, `DiffCard*.tsx` |
| `dompurify` 是依赖 | ✅ | `package.json:50` → `"dompurify": "^3.4.12"` |
| 上游 escapeHtml 防御 | ⚠️ 缓解 | `IncrementalMarkdownParser.ts:304-312` 对用户内容做 `& < > " '` 转义；但若 parser 有漏洞，存在 XSS 风险 |

**风险等级**：中。上游 markdown parser 对用户内容做了 escapeHtml，但缺少 DOMPurify 纵深防御。与本项目其他 `dangerouslySetInnerHTML` 用法*不一致*（其他位置均过 DOMPurify）。

**建议修复**：

```typescript
// MessageContent.tsx:95-98 改为：
import DOMPurify from 'dompurify';
// ...
containerRef.current.innerHTML = DOMPurify.sanitize(wrappedHtml);
// 或将 ref 赋值改为 dangerouslySetInnerHTML 以对齐项目风格
```

---

## 6. Rust unsafe SAFETY 注释

### `apps/agent-workbench/src-tauri/src/process.rs`

| 行号 | unsafe 位置 | 有 SAFETY 注释? |
|------|------------|----------------|
| 199 | `GetCurrentProcess()` | ❌ |
| 204-213 | `OpenProcess / CloseHandle` | ❌ |
| 217-236 | `GetProcessMemoryInfo` | ❌ |
| 287-316 | `CreateToolhelp32Snapshot / Process32FirstW/NextW` | ❌ |
| 701 | `unsafe impl Send for DaemonJobHandle` | ❌ |
| 704 | `unsafe impl Sync for DaemonJobHandle` | ❌ |
| 716-738 | `CreateJobObjectW / SetInformationJobObject` | ❌ |
| 746 | `CloseHandle(dup)` | ❌ |
| 762-766 | `AssignProcessToJobObject` | ❌ |
| 772-778 | `setpgid` | ❌ |
| 785-792 | `killpg` | ❌ |
| **总计 11 处** | **全部缺少 SAFETY 注释** | ❌ |

### 其他 Rust 文件（对照）

| 文件 | unsafe 数 | 有 SAFETY 注释? |
|------|----------|----------------|
| `credentials.rs` | 6 | ✅ 全部（Lines 236, 256, 262, 290, 310, 316） |
| `process_tree.rs` | 2 | ✅ 全部（Lines 11, 61） |
| `process.rs` | 11 | ❌ 全部缺失 |

**结论**：`process.rs` 中 11 处 unsafe 块全部缺失 `// SAFETY:` 注释，不符合 unsafe Rust 最佳实践。其他文件已逐步添加，`process.rs` 尚未清理。

---

## 极端场景：OS Keychain 初始化失败降级路径

| 场景 | 状态 | 实现细节 |
|------|------|---------|
| 非 Windows 平台 OS Keychain 不可用 | ✅ 优雅降级 | `credentials.rs:171-173` → `os_secret_store_available()` 返回 `Err` |
| `CredentialStore::new()` 构造 | ✅ 无 crash | `credentials.rs:50-65` → match `Ok/Err`，Err 时 `mode: MemoryOnly, unavailable: true` |
| 写入失败后降级 | ✅ | `credentials.rs:109-113` → OS write 失败后切到 `MemoryOnly` 并保留值在 `memory_key` |
| 持久化状态报告 | ✅ | `persistence_for_key()` 返回 `Degraded` / `MemoryOnly`，UI 展示诊断 |
| `EncryptedFileSecretStore` I/O | ✅ 全路径 try/catch | `encrypted-file-store.ts:43-49, 56-66, 103-113, 127-128` — 所有文件操作均有 try/catch |
| 真实降级测试 | ✅ | `provider.rs:658` → `unavailable_keychain_degrades_to_memory_only` 测试确认 |

**结论**：OS Keychain 初始化失败或不可用时，系统优雅降级到进程内内存存储，不会 crash。秘钥不持久化但进程内可用。安全降级路径完全正确。

---

## 已修复 / 未修复汇总

### ✅ 已修复（5 项）
| # | 检查项 | 备注 |
|---|--------|------|
| 1 | CSP `unsafe-eval` 移除 + connect-src 白名单 | 严格白名单 |
| 2 | localStorage API Key 清除 | `stripApiKey()` 解构剥离 |
| 3 | Master key 路径分离 | vault vs master key 不同目录 |
| 4 | MCP env 白名单机制 | PATH + HOME + config 声明键 |
| 7 | OS Keychain 降级路径 | 全路径 try/catch，无 crash |

### ❌ 未修复（2 项）
| # | 检查项 | 风险等级 | 备注 |
|---|--------|---------|------|
| 5 | MessageContent.tsx innerHTML 无 DOMPurify | **中** | 上游 escapeHtml 提供第一道防线，但缺纵深防御，与项目其他组件风格不一致 |
| 6 | process.rs 中 11 处 unsafe 无 SAFETY 注释 | **低-中** | credentials.rs 和 process_tree.rs 已补全，process.rs 滞后 |
