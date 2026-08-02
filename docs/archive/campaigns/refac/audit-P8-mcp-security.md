# 审计报告：第八部分 MCP 配置与安全加固（8.1-8.3）

> 审计人：Conex 架构师
> 审计日期：2026-07-23
> 版本：针对 `refactor_plan.md:922-966` 的逐项审计

---

## 8.1 MCP Server 环境变量敏感信息泄露防护

### 8.1.1 当前代码状态

| 位置 | 内容 |
|------|------|
| `packages/agent-daemon/src/types.ts:342-352` | `DaemonMcpServerConfig` 接口定义，`env?: Record<string, string>` 明文存储所有环境变量 |
| `packages/agent-daemon/src/mcp-config.ts:59` | `stringRecordField(o.env)` 从配置中读取 env，无脱敏处理 |
| `packages/agent-daemon/src/mcp-stdio-adapter.ts:123-132` | `mergeProcessEnv()` 将完整的 `process.env` + 配置 env 注入子进程 |
| `packages/agent-daemon/src/server-runtime-factory.ts:1233-1247` | `configuredServersFromDefinitions()` 将 server definition 转为 `JsonObject` 暴露到状态快照 |

### 8.1.2 关键发现：`toJSON` 方案尚未实现

**当前 `DaemonMcpServerConfig` 没有 `toJSON` 方法。** 全文 grep 无任何 `toJSON` 定义。这意味着：

- 如果 `config.env` 被序列化进诊断日志、错误报告或 WebSocket 状态响应，所有 API Key / Secret 等敏感字段会明文暴露。
- `DaemonMcpStatusSnapshot.servers`（`types.ts:945`）是 `JsonObject[]`，当前 `configuredServersFromDefinitions` 构造时只包含 `id/name/label/state/transport/cachedToolCount/updatedAt`，暂时未泄露 env。但后续扩展若有代码将整个 config 序列化进去，立即存在泄露风险。

### 8.1.3 `toJSON` 屏蔽被 `JSON.stringify` replacer 绕过？—— 深度分析

**结论：标准情况下「不可绕过」，但有三个例外路径需要考虑。**

| 场景 | 是否可绕过 | 说明 |
|------|-----------|------|
| `JSON.stringify(obj)` | 否 | `toJSON` 先于 replacer 调用，replacer 处理的是 toJSON 返回的已脱敏对象 |
| `JSON.stringify(obj, ['env'])` 数组白名单 | 否 | 数组 replacer 只筛选顶级 key，toJSON 对顶级 key 仍然生效 |
| `JSON.stringify(obj.env)` **直接对 env 子对象调用** | **是** | `toJSON` 定义在 `DaemonMcpServerConfig` 上，不是 `Record<string, string>`。直取 `.env` 可以绕过。 |
| `structuredClone(config)` | **是** | `structuredClone` 不调用 `toJSON`，会直接复制 `env` 所有字段 |
| Node.js `util.inspect(config)` / `console.log(config)` | **部分** | 默认不调用 `toJSON`，按深度展开对象属性 |

**改进方案：**

1. **双重防线**：除了在 `DaemonMcpServerConfig` 上实现 `toJSON`，还应创建一个 `SafeMcpServerConfig` 类型，并在所有序列化路径中显式转换后再输出。
2. **在 `env` 字段本身上实现 `toJSON`**（或使用 **Proxy** 封装 `env` 对象），使得即便直接访问 `config.env` 也会返回脱敏视图。
3. **在日志/诊断出口做统一拦截**：在 `server-runtime-factory.ts` 的 `mcpStatusSnapshot()` 和 `mcpStatusFromDiagnostics()` 中，对任何可能包含 env 数据的对象添加显式脱敏层。

```typescript
// 方案：SafeEnv Proxy
function createSafeEnv(env: Record<string, string>): Record<string, string> {
  const SENSITIVE_KEYS = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH|APIKEY/i;
  return new Proxy(env, {
    get(target, prop) {
      if (typeof prop === 'string' && SENSITIVE_KEYS.test(prop)) {
        return '[REDACTED]';
      }
      return Reflect.get(target, prop);
    },
    ownKeys(target) {
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, prop) {
      const desc = Reflect.getOwnPropertyDescriptor(target, prop);
      if (desc && typeof prop === 'string' && SENSITIVE_KEYS.test(prop)) {
        desc.value = '[REDACTED]';
      }
      return desc;
    },
  });
}
```

4. **对所有序列化路径添加测试**：确保 `JSON.stringify`、`structuredClone`、`for...in`、`Object.entries()`、`Object.keys()` 均不泄露敏感值。

### 8.1.4 密钥管理集成（8.1.3 长期方案）的补充建议

- **Windows Credential Manager**：使用 `keytar` 或 `win32-api` 包，但注意 `keytar` 已不再维护（archive）。推荐使用 `@aspect-build/aspect-encrypt` 或 Tauri 的 `safe-storage` 插件。
- **进程注入时机**：对于 Stdio MCP Server，应做到：密钥仅从 Keychain 读取 → 直接写入 `child_process.spawn` 的 `env` 参数 → 内存中 `config.env` 保持脱敏。
- **引入「内存安全期」**：在构建 `StdioMcpAdapterOptions` 时，从 Keychain 读取的敏感值在 spawn 之后立即从运行时对象中清除（`delete options.env[key]`）。

---

## 8.2 MCP Stdio Server 进程沙箱控制

### 8.2.1 当前代码行为与计划描述严重不符

**当前代码（`mcp-stdio-adapter.ts:123-132`）：**

```typescript
function mergeProcessEnv(extra: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') base[k] = v;
  }
  return { ...base, ...extra };
}
```

**实际效果：Stdio MCP Server 子进程继承 Daemon 全部的 `process.env`**，包括所有 `CRISH_*`、`API_KEY`、`AWS_*`、`HOME`、`USERPROFILE` 等。这与计划 8.2.2 要求的「严格环境变量白名单隔离」完全相反。

**`StdioClientTransport` 的 `env` 行为**：当向 `StdioClientTransport` 构造函数传入 `env` 时，该 SDK 会直接将其作为 `child_process.spawn` 的 `env` 选项使用。Node.js 文档明确：如果指定了 `env`，子进程将使用 **指定值替代** 当前进程环境变量（不会自动继承）。因此只要能控制传入的 `env`，就能实现白名单。

### 8.2.2 环境变量白名单实现方案

**核心思路**：将 `mergeProcessEnv` 改为白名单模式，只传递三类变量：

| 类别 | 包含的变量 | 理由 |
|------|-----------|------|
| MCP 配置显式指定的 | `mcp.json` / `CRISH_MCP_SERVERS` 中 `env` 字段 | MCP Server 正常运行所需 |
| 必备系统变量 | `PATH`, `TMPDIR`/`TMP`/`TEMP`, `LANG`, `LC_ALL` | 子进程基本运行时需要 |
| 平台兼容变量 | Windows: `SystemRoot`, `COMSPEC`; Unix: `HOME`(受限) | 避免 spawn 失败 |

**新的 `buildMcpEnv` 实现：**

```typescript
const MCP_ENV_ALLOWLIST = new Set([
  // 必备系统
  'PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE',
  // Windows
  'SystemRoot', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'ALLUSERSPROFILE',
  // Unix（有选择地传递）
  'HOME', 'XDG_RUNTIME_DIR', 'DISPLAY', 'TERM',
]);

function buildMcpEnv(
  extra: Record<string, string>
): Record<string, string> {
  const result: Record<string, string> = {};
  // 白名单继承
  for (const key of MCP_ENV_ALLOWLIST) {
    const val = process.env[key];
    if (typeof val === 'string') result[key] = val;
  }
  // MCP 配置显式指定的覆盖或新增
  for (const [k, v] of Object.entries(extra)) {
    result[k] = v;
  }
  return result;
}
```

### 8.2.3 `PATH` 安全性分析

`PATH` 是必须传递的，但也是最危险的——恶意 MCP Server 可以将 `command` 设置为与系统命令同名的可执行文件路径。必须采取以下措施：

| 措施 | 实现方式 |
|------|---------|
| **使用 `command` 的绝对路径** | 在 `createStdioMcpAdapter` 中对 `command` 做 `which`/`where` 解析，若已是绝对路径则直接使用；若为相对路径，在 spawn 前解析为绝对路径后再使用 |
| **PATH 只读不可写** | 验证 `extra.env` 中不能包含 `PATH`（MCP 配置不应允许覆盖 PATH），或只允许追加 `:`/`;` 分隔的路径 |
| **路径权限检查** | 对 command 所在目录检查权限，确保不属于用户可写目录（`/tmp`, `~/Downloads` 等） |

**改进后的 `createStdioMcpAdapter` 需要在 `connect()` 内（而非在配置阶段）做路径安全检查：**

```typescript
// 在 spawn 前验证 command
import { which } from 'which';  // npm: which

async function resolveMcpCommand(command: string): Promise<string> {
  if (path.isAbsolute(command)) {
    // 检查绝对路径是否在系统目录中
    const dir = path.dirname(command);
    // 拒绝可写目录中的可执行文件
    if (isWritableDir(dir)) {
      throw new Error(`MCP command "${command}" is in a writable directory`);
    }
    return command;
  }
  // 从 PATH 解析
  const resolved = await which(command, { path: process.env.PATH });
  if (!resolved) {
    throw new Error(`MCP command "${command}" not found in PATH`);
  }
  return resolved;
}
```

### 8.2.4 遗漏的必要环境变量

原始 plan 只提到了 `PATH`。经审计，以下环境变量也应该纳入白名单：

| 环境变量 | 平台 | 理由 |
|---------|------|------|
| `TMPDIR` / `TMP` / `TEMP` | 全平台 | MCP Server 可能创建临时文件 |
| `LANG` / `LC_ALL` / `LC_CTYPE` | Unix | 字符编码和 locale，影响文本处理 |
| `SystemRoot` / `COMSPEC` | Windows | 基本 Windows 系统路径，某些 Node.js 包需要 |
| `PATHEXT` | Windows | 可执行文件扩展名列表 |
| `DISPLAY` / `WAYLAND_DISPLAY` | Linux | GUI 程序可能需要 |
| `TERM` | Unix | 终端类型，影响子进程输出格式 |
| `HOME` | 全平台 | 某些工具需要（但只读，不包含 `.env` 等敏感文件路径时需要额外注意） |
| `NODE_PATH` | 全平台 | 如果 MCP Server 是 Node.js 程序可能需要 |
| `SSL_CERT_FILE` / `NODE_EXTRA_CA_CERTS` | 全平台 | 自定义 CA 证书路径 |

---

## 8.3 Provider 配置格式校验

### 8.3.1 当前校验现状

有两个不同的 provider 校验文件：

| 文件 | 用途 | 校验强度 |
|------|------|---------|
| `apps/agent-workbench/src/cli/provider-validate.ts` | CLI 工具（`crish provider validate`） | 有基本 URL + auth 校验，但面向文件而非用户输入 |
| `packages/agent-runtime/src/provider/cli/provider-validate.ts` | Runtime 侧校验 | 有 `validateBaseUrl` 检查，覆盖 basic fields |
| `apps/crish-desktop/src/components/ModelsSettingsTab.tsx` | 前端 Settings UI | **完全没有联机校验**，apiKey/baseUrl 直接保存 |

**前端 UI（`ModelsSettingsTab.tsx`）中的输入验证现状**：用户输入 baseUrl、apiKey 后直接调用 `saveProfileBaseUrl` 和 `saveProfileKey` 保存，无任何格式校验。

### 8.3.2 Plan 中各规则的逐条评估

| 规则 | 当前状态 | 评估 | 改进建议 |
|------|---------|------|---------|
| `endpoint` 必须通过 `new URL(value)` 解析 | `provider-validate.ts:11-18` 已有 `isUrl` 函数做相同检查 | 可行 | 另需检查 URL 是否有 `hostname`（`new URL('localhost:11434')` 在不带协议时会抛异常，但 `new URL('http://localhost:11434')` 正常） |
| `endpoint` 必须 `http/https` | 未实现 | 必要 | 需额外检查 `url.protocol !== 'http:' && url.protocol !== 'https:'` |
| `apiKey` 非空时长度不少于 8 字符 | 未实现 | **不足够** | 8 字符太短。OpenAI 的 key 以 `sk-` 开头共 51 字符，DeepSeek 以 `sk-` 开头。建议最小长度设为 **16 字符** |
| `apiKey` 不以空格开头/结尾 | 未实现 | 必要 | 防止粘贴时引入前后空白导致认证失败。但应同时做 `.trim()` 而非仅拒绝 |
| Ollama 不需要 apiKey 的友好提示 | 未实现 | 可行 | 若 `baseUrl` 包含 `localhost` 或 `127.0.0.1` 或 `engine=ollama` 时提示 |

### 8.3.3 增加的关键校验规则

除了计划中的 4 条，还应增加：

```
- baseUrl 规整化：自动去除尾部空白，自动追加 /v1（如果是 OpenAI compatible）
- apiKey 格式启发式检测：
  - OpenAI 系的 key 应匹配 /^sk-[A-Za-z0-9]{32,}$/
  - Anthropic 的 key 应匹配 /^sk-ant-[A-Za-z0-9]{32,}$/
  - Azure 的 key 应匹配 /^[A-Fa-f0-9]{32}$/
  - 匹配到已知模式但格式不对时 warning（可能是误粘贴了其他内容）
- timeout 范围校验（已有）：1000-600000ms
- baseUrl 重复检测：与已配置的其他 provider 的 baseUrl 对比，防止重复添加
```

### 8.3.4 前端（Settings UI）还是后端（Daemon）执行？

**结论：前后端双校验，职责分离。**

| 层级 | 校验范围 | 优势 |
|------|---------|------|
| **前端**（`crish-desktop/src/components/ModelsSettingsTab.tsx`） | 格式校验 + 即时反馈 | 用户体验最佳，< 100ms 即时错误提示，防止无效请求发送到 daemon |
| **后端**（`agent-daemon` / `agent-runtime` ） | 语义校验 + 安全审查 | 不可绕过，防范绕过前端的攻击（如直接 WebSocket 调用 `update-config` 消息） |

**具体分工：**

```
前端（React ModelsSettingsTab.tsx）:
  ✓ baseUrl 格式 (new URL + http/https)
  ✓ apiKey 长度 + 前后空白
  ✓ apiKey 格式启发式识别
  ✓ endpoint 合法值
  ✓ 必填字段检查
  └─ 校验通过 → 发送到 daemon

后端（daemon-provider-gateway.ts / provider-validate.ts）:
  ✓ 完整的格式校验（重复校验，防御绕过）
  ✓ 敏感字段脱敏后再记录日志
  ✓ 网络可达性检查（如 ProbeProviderModelsMessage）
  ✓ baseUrl 正则化（尾部斜杠处理、/v1 追加）
  ✓ apiKey 安全存储（Keychain 集成）
  └─ 校验失败 → 返回错误消息到前端
```

**实施建议**：在前端创建 `validateProviderConfig()` 辅助函数，在 `saveProfileBaseUrl` 和 `saveProfileKey` 调用之前执行。后端在 `DaemonProviderGateway` 的 `updateConfig` / `probe-provider-models` 处理路径中重复校验。

---

## 补充：8.2 中 PATH 的专项安全方案

### 威胁模型

恶意第三方 MCP Server 可通过以下方式利用 `PATH`：

1. **命令劫持**：如果 MCP `command` 为 `node`/`python`/`git`，恶意 Server 可能在 `PATH` 前列的可写目录中放置同名脚本。
2. **PATH 覆盖**：MCP 配置中的 `env` 字段若允许覆盖 `PATH`，可指向受控目录。

### 安全策略实施顺序

```
在 createStdioMcpAdapter 的 connect() 中:

1. 检查 extra.env 是否包含 PATH → 拒绝（MCP 不应有权修改 PATH）
2. 若 command 是相对路径，使用 which/where 解析为绝对路径
3. 验证解析后的绝对路径：
   a. 不属于用户可写目录（/tmp, ~/Downloads, %TEMP% 等）
   b. 不属于 $HOME 下的配置文件目录
   c. 文件的 owner 不属于当前用户（Linux 额外检查）
4. 对 PATH 本身做过滤：
   a. 移除所有用户可写的目录
   b. 只保留系统级目录（/usr/bin, /usr/local/bin, C:\Windows\System32 等）
```

---

## 综合改进优先级

| 优先级 | 任务 | 影响范围 | 风险 |
|--------|------|---------|------|
| P0 | 修复 `mergeProcessEnv` 为白名单模式（8.2.2） | 所有 MCP Server 子进程 | 高 - 当前继承 daemon 全部 env |
| P0 | 在前端 `ModelsSettingsTab.tsx` 添加 apiKey/baseUrl 格式校验（8.3） | 设置 UI 用户体验 | 中 - 防止无效配置 |
| P1 | 实现 `DaemonMcpServerConfig.toJSON` + SafeEnv Proxy（8.1） | 日志/诊断/状态序列化 | 高 - 敏感信息泄露 |
| P1 | 后端 `provider-gateway` 添加 Provider 配置重复校验 | daemon 配置更新 | 中 |
| P2 | PATH 安全验证 + 命令解析（8.2.3） | MCP Server 启动 | 中 - 依赖第三方 MCP |
| P2 | Keychain 集成（8.1.3 长期方案） | 密钥管理架构 | 低 - 方案切换需协调 |
| P3 | 所有序列化路径（structuredClone/Object.entries）统一脱敏（8.1.3） | 安全纵深 | 低 - 防御深度 |
