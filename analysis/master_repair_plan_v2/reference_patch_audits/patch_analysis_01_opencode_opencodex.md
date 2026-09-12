# AI Coding Agent 核心缺陷与补丁深度分析报告
> **目标项目**: `reference/opencode` 与 `reference/opencodex`
> **报告生成时间**: 2026-07-24
> **审计范围**: Git 真实提交历史、漏洞/崩溃修正 Commit、网络与流式层、并发状态机、SQLite 存储、进程生命周期及跨平台兼容性源码。

---

## 一、 核心修补 Commit 清单与 Bug 根因剖析 (RCA)

经过对 `opencode` 与 `opencodex` 项目 Git 历史的检索与对比审计，挑选出 **16 个最具代表性的关键 Bug 修正 Commit**。下表汇总了其 Commit Hash、所在子系统、故障现象及根因剖析：

| 序号 | 项目 | Commit Hash | 子模块 / 文件 | 故障现象 | 根因剖析 (Root Cause Analysis) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1** | `opencode` | `3033afba513` | `provider/transform.ts` | 自定义/OpenAI兼容代理下 Mistral 衍生模型工具调用失败 | 未识别以 `codestral` / `pixtral` / `mixtral` / `devstral` 为 ID 缀的非官方 Mistral 规范模型，导致工具调用 ID 中的 `toolu_` 前缀未被归一化剥离，直接报 API schema 格式错误。 |
| **2** | `opencode` | `2a097f3af70` | `llm/provider-error.ts` | Context Overflow 被误判为通用的 HTTP 500 或 429 导致重试死循环 | 供应商（如 Z.AI GLM / DeepSeek / Moonshot）返回的 Token 超限错误文本缺少严格正则表达式匹配；且将限流（Rate Limit / Throttling）误归类为 Context 超限，导致上下文裁剪逻辑混乱。 |
| **3** | `opencode` | `cc3615b535d` | `app/server-session.ts` | 历史消息向回追溯（Backfill）时遭遇已删除的父节点，会话崩溃无法加载 | 递归追溯 Parent ID 时，若后端返回 404 Not Found，前端状态机抛出未捕获的 Unhandled Rejection 异常，阻塞整个会话树渲染。 |
| **4** | `opencode` | `67caf894e08` | `provider/provider.ts` | 深度思考/长 reasoning 场景下，OpenAI 客户端抛出 Header Timeout | 默认 `headerTimeout` 仅设定为 10,000ms（10秒），在大模型（如 o1 / o3-mini / DeepSeek R1）进行长达几十秒的 Reasoning 首 Token 渲染前，连接被客户端主动掐断。 |
| **5** | `opencode` | `285d315b4e5` | `core/task.ts` | Subagent 递归无限制自我派生，导致 CPU/Token 消耗暴涨与死循环 | `TaskTool` 未对子 Agent 的嵌套深度做层级校验，允许 Subagent 再次调用 `task` 工具创建递归子树，导致内存泄露与配额瞬间耗耗尽。 |
| **6** | `opencode` | `656f2990173` | `core/fs-util.ts` | Windows 平台上 Bun 运行时创建目录时频繁抛出 `EEXIST (AlreadyExists)` | Bun 运行时的 `fs.makeDirectory(path, { recursive: true })` 在 Windows 某些底层路径下即使设置了 `recursive: true` 仍可能同步抛出 `AlreadyExists` 异常。 |
| **7** | `opencode` | `e7e7a97621f` | `app/permission.tsx` | 自动授权（Auto-Accept）状态在多 Server / 多目录切换时相互污染 | 权限状态机将 Permission 规则绑定在全局 Session 上，缺少 Server 实例隔离与 Directory 命名空间隔离，导致项目 A 的授权逃逸到项目 B。 |
| **8** | `opencode` | `3a1c6df9e24` | `app/timeline/summary-diffs.ts` | 频繁生成工具调用时，Git Diff Summary 重复渲染导致 UI 严重卡顿与内存浪费 | Timeline 视图在整理 Diff 列表时使用了全量的 `reduceRight` 翻转与数组操作，在多轮工具修改同一文件时产生了暴增的冗余 Diff 节点。 |
| **9** | `opencodex` | `0de138aa61a` | `oauth/store.ts` | Anthropic OAuth Token 刷脸被重放，导致账号被永久标记为 `needsReauth` | Anthropic OAuth Refresh Token 属于单次消费型 Token（Single-use token）。当并发请求或进程异常重试时，重用上一次 Generation 导致服务端返回 `invalid_grant`，账号触发死锁。 |
| **10**| `opencodex` | `87be0d8761f` | `codex/affinity.ts` | 流式传输中途连接重置（Mid-stream reset）被误识别为永久失效，触发账号禁售 | 掉线/网络抖动引起的 TCP Reset 在流式中途断开，系统未区分 transient 错误，直接将账号放入 Escalating Cooldown 惩罚池，导致可用池迅速耗耗尽。 |
| **11**| `opencodex` | `fbd96c12f33` | `lib/winsw.ts` | 韩语/德语/葡萄牙语等非英文 Windows OS 下 `sc.exe query` 服务不存在探测失效 | 代码写死了正则 `/FAILED 1060/i` 匹配 `sc.exe` 的控制台输出。在非英文 Windows 系统中输出为 `FALHA 1060` 或 `1060: 지정된 서비스가...`，且 Bun 将退出码截断为 36，导致诊断逻辑误报为 `"error"`。 |
| **12**| `opencodex` | `e8a48a608fd` | `codex/routing.ts` | 延迟到达的失败请求误删了新绑定的 Account Affinity | 线程 T 在账号 A 失败后 Failover 绑定到了账号 B，随后账号 A 滞后的异步 Failure 回调被触发，直接调用 `threadAccountMap.delete(T)`，误删了账号 B 的有效绑定。 |
| **13**| `opencodex` | `45c87614f34` | `storage/scanner.ts` | 只读诊断扫描 SQLite 数据库时，意外触发 `.sqlite-wal` / `.sqlite-shm` 文件写入 | Bun 运行时的 `new Database(path, { readonly: true })` 默认仍会尝试初始化 WAL 模式的 Checkpoint，在只读文件系统或共享目录中引发 File Access Error，并改变目录哈希。 |
| **14**| `opencodex` | `d04846308f` | `adapters/cursor/request-builder.ts` | 工具数量过多时，Cursor Protobuf 序列化超限导致 400 `tool_catalog_too_large` 错误 | 未预先计算所有注册 MCP 工具在 Protobuf 编码后的字节大小，直接将全量 Schema 打包发送，超出 Upstream 80KB 硬性限制。 |
| **15**| `opencodex` | `e84e3aa1930` | `server/index.ts` | 热更新后服务监听端口漂移，依赖该端口的后台 Agent 失去连接 | 启动服务时若配置 `port: 0`（随机动态端口），更新或重启后未记录并固定实际分配的监听端口，导致客户端 HTTP 请求发送至死端口。 |
| **16**| `opencodex` | `f07234f072` | `proxy/index.ts` | DeepSeek R1 / Claude 3.5 思考流长时间停顿导致 90s 超时强制中断 | 代理层的 `stallTimeoutSec` 默认预设为 90s，在大模型进行长文本推理或复杂的 Web Search 思考时，停顿超过 90 秒即被误杀。 |

---

## 二、 代码级修复实现指引 (Code-Level Implementation Guide)

以下针对上述 16 个核心 Commit，给出具体的文件路径、函数签名变动、修改前后代码对比（Before vs After）以及防御设计模式解析。

### 1. `3033afba513` - Mistral 家族工具调用 ID 规范化
- **源码文件**: `packages/opencode/src/provider/transform.ts`
- **关键函数签名**: `function normalizeMessages(messages: Message[], model: ModelInfo): Message[]`
- **修改前后对比**:

```typescript
// ==================== BEFORE ====================
if (
  model.providerID === "mistral" ||
  model.api.id.toLowerCase().includes("mistral") ||
  model.api.id.toLowerCase().includes("devstral")
) {
  const scrub = (id: string) => id.replace(/^toolu_/, "")
  // ...
}

// ==================== AFTER ====================
const modelID = model.api.id.toLowerCase()
if (
  model.providerID === "mistral" ||
  ["mistral", "devstral", "codestral", "pixtral", "mixtral"].some((family) => modelID.includes(family))
) {
  const scrub = (id: string) => id.replace(/^toolu_/, "")
  // ...
}
```

- **防御模式解析 (Defensive Pattern)**:
  **家族别名匹配模式 (Family Prefix Pattern)**。避免简单硬编码具体模型名，采用基于核心衍生家族词库（Family Array）的字符串包含校验，防止自定义/私有 OpenAI 代理转换时遗漏新模型（如 `codestral-latest`）。

---

### 2. `2a097f3af70` - 上下文溢出 (Context Overflow) 识别与误判排除
- **源码文件**: `packages/llm/src/provider-error.ts`
- **关键函数签名**: `export const isContextOverflow = (message: string): boolean`
- **修改前后对比**:

```typescript
// ==================== BEFORE ====================
const patterns = [
  /prompt is too long/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  // ...
]

export const isContextOverflow = (message: string) =>
  patterns.some((pattern) => pattern.test(message)) || /^4(00|13)\s*(status code)?\s*\(no body\)/i.test(message)

// ==================== AFTER ====================
const patterns = [
  /prompt is too long/i,
  /request_too_large/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i,
  /input length.*exceeds.*context length/i,
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i,
  /model_context_window_exceeded/i,
  /token limit exceeded/i,
]

// 显式排除限流与服务不可用错误
const exclusions = [/^(throttling error|service unavailable):/i, /rate limit/i, /too many requests/i]

export const isContextOverflow = (message: string) =>
  !exclusions.some((pattern) => pattern.test(message)) &&
  (patterns.some((pattern) => pattern.test(message)) || /^4(00|13)\s*(status code)?\s*\(no body\)/i.test(message))
```

- **防御模式解析**:
  **正向过滤与反向排除结合模式 (Exclusion-First Classification)**。在分类流式/网络错误时，先通过 `exclusions` 列表剔除“限流/服务忙”等临时性错误，再进行模式匹配。这防止了限流被当作 Context 超限而错误切除用户会话历史。

---

### 3. `cc3615b535d` - 容忍删除的 Parent Message 递归加载崩溃
- **源码文件**: `packages/app/src/context/server-session.ts`
- **关键函数签名**: `export function createServerSession(client: OpencodeClient, options?: { retry?: boolean })`
- **修改前后对比**:

```typescript
// ==================== BEFORE ====================
const parent = await fetchMessage(sessionID, parentID, () =>
  resetMessageLoad(sessionID, load, messageLoadBaseline(load, parentID)),
)
if (parent.message.role !== "user") throw new Error(`Assistant parent is not a user message: ${parentID}`)
parents.push(parent)

// ==================== AFTER ====================
const parent = await fetchMessage(sessionID, parentID, () =>
  resetMessageLoad(sessionID, load, messageLoadBaseline(load, parentID)),
).catch((error) => {
  const cause = error instanceof Error && typeof error.cause === "object" ? error.cause : undefined
  if (cause && "status" in cause && cause.status === 404) {
    // 捕获 404，标记为已被删除的节点，停止继续向下卡死
    load.removedMessages.add(parentID)
    return
  }
  throw error
})
if (!parent) continue
if (parent.message.role !== "user") throw new Error(`Assistant parent is not a user message: ${parentID}`)
parents.push(parent)
```

- **防御模式解析**:
  **优雅退化与局部容错模式 (Graceful Degradation for Orphan Nodes)**。在树状/链式数据结构的反序列化与同步中，允许丢失中间节点。遇到 404 时将 orphan 节点加入 `removedMessages` 集合，避免单条消息被删除破坏整个 Timeline 的加载。

---

### 4. `67caf894e08` - OpenAI 客户端 Header Timeout 调优
- **源码文件**: `packages/opencode/src/provider/provider.ts`
- **关键常数与配置**: `OPENAI_HEADER_TIMEOUT_DEFAULT`
- **修改前后对比**:

```typescript
// ==================== BEFORE ====================
const OPENAI_HEADER_TIMEOUT_DEFAULT = 10_000 // 10 秒

// ==================== AFTER ====================
const OPENAI_HEADER_TIMEOUT_DEFAULT = 300_000 // 300 秒 (5 分钟)
```

- **防御模式解析**:
  **Reasoning 适配超时策略 (Reasoning-Aware Timeout Threshold)**。传统 LLM API 的 TTFT (Time-To-First-Token) 在 2~3 秒内；但带 Reasoning 链的模型（如 o1, o3, DeepSeek R1）可能在发送第一个 HTTP SSE 响应头之前思考 30~90 秒。将客户端 Header Timeout 提高到 300 秒，可彻底消除 Reasoning 阶段的 premature abort。

---

### 5. `285d315b4e5` - Subagent 嵌套深度限制
- **源码文件**: `packages/opencode/src/tool/task.ts` & `packages/core/src/v1/config/config.ts`
- **关键函数签名**: `TaskTool.execute(params, ctx)`
- **修改前后对比**:

```typescript
// ==================== BEFORE ====================
// 在 TaskTool.execute 中直接创建子会话，没有深度检查
const parent = yield* sessions.get(ctx.sessionID)
const session = yield* sessions.create({ parentID: parent.id, ... })

// ==================== AFTER ====================
const parent = yield* sessions.get(ctx.sessionID)
let current = parent
let depth = 0
// 沿 parentID 向上回溯计算递归深度
while (current.parentID) {
  depth++
  current = yield* sessions.get(current.parentID)
}
if (depth >= (cfg.subagent_depth ?? 1)) {
  return yield* Effect.fail(
    new Error(
      `Subagent depth limit reached (${cfg.subagent_depth ?? 1}). Increase "subagent_depth" to allow nested subagents.`,
    ),
  )
}
```

- **防御模式解析**:
  **层级深度配额与回溯阻断 (Ancestor Depth Bounding Pattern)**。在允许 Agent 创建 Task/Subagent 时，必须沿 Ancestor 树计算深度。默认 `subagent_depth = 1` 强制禁止子 Agent 派生子 Agent，有效防御无线递归与配额爆破。

---

### 6. `656f2990173` - Windows 平台 Bun 运行时 `ensureDir` 容错
- **源码文件**: `packages/core/src/fs-util.ts`
- **关键函数签名**: `FSUtil.ensureDir(path: string)`
- **修改前后对比**:

```typescript
// ==================== BEFORE ====================
const ensureDir = Effect.fn("FileSystem.ensureDir")(function* (path: string) {
  yield* fs.makeDirectory(path, { recursive: true })
})

// ==================== AFTER ====================
const ensureDir = Effect.fn("FileSystem.ensureDir")(function* (path: string) {
  yield* fs.makeDirectory(path, { recursive: true }).pipe(
    // Bun on Windows can throw EEXIST here despite recursive mode.
    // https://github.com/oven-sh/bun/issues/21901
    Effect.catchIf(
      (error) => error.reason._tag === "AlreadyExists",
      (error) => isDir(path).pipe(Effect.flatMap((exists) => (exists ? Effect.void : Effect.fail(error)))),
    ),
  )
})
```

- **防御模式解析**:
  **运行时 Bug 降级补救模式 (Runtime Workaround Pattern)**。针对特定 OS 与 Runtime 组合（Windows + Bun）的底层已知 Bug（EEXIST 异常），在捕获异常后重新做二次状态校验（`isDir(path)`），若目录确实已存在则视为成功。

---

### 7. `e7e7a97621f` - 多 Server 与多 Directory 权限状态隔离
- **源码文件**: `packages/app/src/context/permission.tsx`
- **关键函数签名**: `createPermissionStore(input: { sdk: SDK; sync: ServerSync })`
- **修改前后对比**:

```typescript
// ==================== BEFORE ====================
// 使用单一全局 Map 存 AutoAccept 状态
const [store, setStore] = createStore({ autoAccept: {} })

// ==================== AFTER ====================
// 引入基于 Server 句柄与 Directory 的隔离键生成
function directoryAcceptKey(directory: string) {
  return `dir:${directory}`
}
function acceptKey(sessionID: string, directory: string) {
  return `${directory}:${sessionID}`
}

// 在 React/Solid 上下文中强制基于当前 active server 隔离状态
const permissionState = createMemo(() => permission.ensureServerState(server()))
```

- **防御模式解析**:
  **多租户/命名空间隔离模式 (Scoped Namespace Isolation)**。所有的权限状态、Auto-Accept 决策都必须带有 `serverKey` 和 `directoryPath` 组成的复合主键，严禁使用扁平 Session ID 作为全局唯一键。

---

### 8. `3a1c6df9e24` - Timeline 渲染性能线性去重
- **源码文件**: `packages/app/src/pages/session/timeline/summary-diffs.ts`
- **关键函数签名**: `export function uniqueSummaryDiffs(diffs: SnapshotFileDiff[] | undefined): SummaryDiff[]`
- **修改前后对比**:

```typescript
// ==================== BEFORE ====================
const diffs = (userMessage.summary?.diffs ?? [])
  .reduceRight<SummaryDiff[]>((result, diff) => {
    if (!isSummaryDiff(diff)) return result
    if (result.some((item) => item.file === diff.file)) return result // O(N^2) 查找!
    result.push(diff)
    return result
  }, [])
  .reverse()

// ==================== AFTER ====================
export function uniqueSummaryDiffs(diffs: SnapshotFileDiff[] | undefined) {
  const files = new Set<string>() // O(1) 查找!
  return (diffs ?? [])
    .reduceRight<SummaryDiff[]>((result, diff) => {
      if (!isSummaryDiff(diff)) return result
      const file = diff.file
      if (files.has(file)) return result
      files.add(file)
      result.push(diff)
      return result
    }, [])
    .reverse()
}
```

- **防御模式解析**:
  **哈希集合线性去重模式 (Set-Assisted O(N) Deduplication)**。在前端组件处理大量 Stream 推送或复杂 Tool Call 生成的 Diff 文件列表时，将 `Array.prototype.some` (O(N^2)) 替换为 `Set.prototype.has` (O(N))，消除几十轮工具调用后的界面假死。

---

### 9. `0de138aa61a` - Anthropic 单次 OAuth Token 刷脸持久化锁
- **源码文件**: `src/oauth/store.ts` & `src/oauth/index.ts`
- **关键函数签名**: `writeOAuthRefreshIntent(provider, accountId, generation)` / `clearOAuthRefreshIntent(...)`
- **修改前后对比**:

```typescript
// ==================== BEFORE ====================
export async function refreshAnthropicAccount(provider: string, accountId: string, credential: OAuthCredentials) {
  const newTokens = await api.refreshToken(credential.refresh);
  await saveCredential(provider, newTokens);
}

// ==================== AFTER ====================
export interface OAuthRefreshIntent {
  version: 1;
  provider: string;
  accountId: string;
  generation: string; // 由 hash(refresh + access + expires) 构成的防重放标识
  createdAt: number;
}

export function writeOAuthRefreshIntent(provider: string, accountId: string, generation: string): void {
  const intent: OAuthRefreshIntent = { version: 1, provider, accountId, generation, createdAt: Date.now() };
  atomicWriteFile(getAuthRefreshIntentPath(provider, accountId), `${JSON.stringify(intent)}\n`);
}

export async function refreshAnthropicAccountWithLock(provider: string, accountId: string, def: ProviderDef, credential: OAuthCredentials) {
  const currentGen = credentialGeneration(credential);
  const existingIntent = readOAuthRefreshIntent(provider, accountId);

  // 若磁盘上已经存在针对该代 Generation 的刷脸意图，说明已被消费或正在刷脸中，绝不再次发起 HTTP 请求
  if (existingIntent && existingIntent.generation === currentGen) {
    markAccountNeedsReauth(provider, accountId);
    throw new OAuthLoginRequiredError("Token refresh intent already consumed or in-flight");
  }

  writeOAuthRefreshIntent(provider, accountId, currentGen);
  try {
    const fresh = await def.refresh(credential.refresh);
    await saveCredential(provider, { ...fresh, accountId });
    clearOAuthRefreshIntent(provider, accountId, currentGen);
    return fresh.access;
  } catch (err) {
    if (isTerminalAuthError(err)) {
      markAccountNeedsReauth(provider, accountId);
    }
    throw err;
  }
}
```

- **防御模式解析**:
  **代际绑定持久化防重放锁 (Generation-Bound Intent Lock Pattern)**。由于 Anthropic 等 API 的 Refresh Token 具备严格的“单次使用即作废”特性，刷脸前必须将当前 Token 版本的 Hash (Generation) 原子化写入磁盘 Intent 文件。即使进程中途崩溃重启，也不会重复发送旧 Refresh Token 导致账号失效。

---

### 10. `87be0d8761f` - 中途连接重置 (Mid-stream reset) 容错与账号冷却
- **源码文件**: `src/codex/affinity.ts` & `src/server/responses.ts`
- **关键函数签名**: `reclassifyMidStreamReset(...)` / `httpStatusFromTerminalError(...)`
- **修改前后对比**:

```typescript
// ==================== BEFORE ====================
// SSE 流中途断开时，统一包装为 502 Bad Gateway 并判定账号故障
function handleStreamError(err: unknown) {
  recordAccountFailure(activeAccountId, 502);
  softAvoidAccount(activeAccountId);
}

// ==================== AFTER ====================
function handleStreamError(err: unknown, bytesReceived: number) {
  if (bytesReceived > 0 && isConnectionResetError(err)) {
    // 已经接收到了部分流数据，说明网络连接建立成功，中途断开属于 transient 网络故障
    logCtx.terminalHttpStatus = 503;
    recordAccountFailure(activeAccountId, 503, { transient: true });
    // 不对账号施加 15 分钟的软避让 (soft-avoid)，仅进行指数退避
    return;
  }
  logCtx.terminalHttpStatus = httpStatusFromTerminalError(err);
  recordAccountFailure(activeAccountId, logCtx.terminalHttpStatus);
}
```

- **防御模式解析**:
  **基于数据传输状态的故障再分类模式 (State-Aware Failure Reclassification)**。区分请求未发送成功与“流传输中途断开”。若 `bytesReceived > 0`，证明服务器与鉴权均正常，属于网络层连接重置，应识别为 Transient 错误，避免误删可用账号池。

---

### 11. `fbd96c12f33` - 非英文 Windows 环境下 `sc.exe 1060` 状态无偏检测
- **源码文件**: `src/lib/winsw.ts`
- **关键函数签名**: `export function probeScmRegistration(run: () => string): boolean | "error"`
- **修改前后对比**:

```typescript
// ==================== BEFORE ====================
try {
  const out = run();
  return true;
} catch (e: any) {
  const text = [e.stderr, e.stdout, e.message].join("\n");
  if (e.status === 1060 || /FAILED 1060/i.test(text)) return false;
  return "error";
}

// ==================== AFTER ====================
try {
  const out = run();
  return true;
} catch (e: any) {
  const text = [e.stderr, e.stdout, e.message].map(v => typeof v === "string" ? v : "").join("\n");
  // 1060 是 Windows SCM ERROR_SERVICE_DOES_NOT_EXIST 的无偏错误码
  // 在韩语 (1060: 지정된...)、葡萄牙语 (FALHA 1060) 中文本均包含单词边界 \b1060\b
  // Bun 在 Windows 上可能将 e.status 截断为 36 (1060 & 0xff = 36)，因此必须通过文本正则匹配 \b1060\b
  if (e.status === 1060 || /\b1060\b/.test(text)) return false;
  return "error";
}
```

- **防御模式解析**:
  **语言无关的边界错误码探测模式 (Locale-Invariant Error Code Boundary Pattern)**。在解析 CLI 工具（如 Windows `sc.exe`）控制台输出时，严禁使用英文特定前缀（如 `FAILED`）。使用数字边界正则 `/\b1060\b/` 跨越操作系统多语言方言。

---

### 12. `e8a48a608fd` - Pool Affinity 线程解绑竞态条件修补
- **源码文件**: `src/codex/routing.ts`
- **关键函数签名**: `unbindThreadAccount(threadId: string, accountId: string)`
- **修改前后对比**:

```typescript
// ==================== BEFORE ====================
export function unbindThreadAccount(threadId: string) {
  threadAccountMap.delete(threadId); // 盲目删除！
}

// ==================== AFTER ====================
export function unbindThreadAccount(threadId: string, accountId: string) {
  const bound = threadAccountMap.get(threadId);
  // 只有当当前存储的绑定确实为发起解绑请求的账户时，才允许删除
  if (bound?.accountId === accountId) {
    threadAccountMap.delete(threadId);
  }
}
```

- **防御模式解析**:
  **所有权保护解绑模式 (Ownership-Guarded Unbind Pattern)**。在异步并发系统中，防止延迟到达的失败清理回调（Late Failures）覆盖或删除已经由新请求建立的有效映射句柄。

---

### 13. `45c87614f34` - SQLite 读操作避让 WAL/SHM 侧车文件生成
- **源码文件**: `src/storage/scanner.ts`
- **关键函数签名**: `function countRowsReadonly(dbPath: string, table: string): number | null`
- **修改前后对比**:

```typescript
// ==================== BEFORE ====================
function countRowsReadonly(dbPath: string, table: string): number | null {
  try {
    const db = new Database(dbPath, { readonly: true });
    const row = db.query<{ n: number }>(`SELECT count(*) AS n FROM "${table}"`).get();
    db.close();
    return row?.n ?? null;
  } catch { return null; }
}

// ==================== AFTER ====================
import { pathToFileURL } from "node:url";
import { Database, constants } from "bun:sqlite";

const IMMUTABLE_READONLY_FLAGS = constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI;

function countRowsReadonly(dbPath: string, table: string): number | null {
  try {
    // 使用 file: URI 传入 immutable=1，告知 SQLite 数据库在此连接生命周期内绝对静止
    // pathToFileURL 可转义路径中的 #, ?, % 等特殊字符
    const uri = `${pathToFileURL(dbPath).href}?immutable=1`;
    const db = new Database(uri, IMMUTABLE_READONLY_FLAGS);
    try {
      const row = db.query<{ n: number }, []>(`SELECT count(*) AS n FROM "${table}"`).get();
      return row?.n ?? null;
    } finally {
      db.close();
    }
  } catch { return null; }
}
```

- **防御模式解析**:
  **Immutable URI 只读隔离模式 (Immutable SQLite Access Pattern)**。SQLite 的 `{ readonly: true }` 在 WAL 模式下如果遭遇无 SHM 侧车文件的数据库，依然会尝试写入创建 SHM 索引。通过 `SQLITE_OPEN_URI` 加 `immutable=1` 参数，确保只读扫描 0 磁盘写入。

---

### 14. `d04846308f` - Cursor 工具目录 Protobuf 序列化预算控制
- **源码文件**: `src/adapters/cursor/request-builder.ts`
- **关键函数签名**: `export function applyCursorToolBudget(tools: Tool[], mode: string)`
- **修改前后对比**:

```typescript
// ==================== BEFORE ====================
export function createCursorRequest(context: RequestContext) {
  return {
    tools: context.tools.map(transformTool), // 盲目打包全量 Tools
    // ...
  };
}

// ==================== AFTER ====================
export const CURSOR_TOOL_BYTES_LIMIT = 80_000; // 80 KB
export const CURSOR_TOOL_COUNT_LIMIT = 64;

export function applyCursorToolBudget(tools: Tool[], mode: string) {
  const accepted: Tool[] = [];
  const omitted: Tool[] = [];
  let currentBytes = 0;

  // 优先保留通过 tool_search 动态加载的工具与基础工具
  const sorted = [...tools].sort((a, b) => (b.loadedFromToolSearch ? 1 : 0) - (a.loadedFromToolSearch ? 1 : 0));

  for (const tool of sorted) {
    const bytes = estimateProtobufSize(tool);
    if (accepted.length < CURSOR_TOOL_COUNT_LIMIT && currentBytes + bytes <= CURSOR_TOOL_BYTES_LIMIT) {
      accepted.push(tool);
      currentBytes += bytes;
    } else {
      omitted.push(tool);
    }
  }
  return { tools: accepted, omitted };
}
```

- **防御模式解析**:
  **序列化配额与动态降级模式 (Serialized Budgeting with Tool Search Fallback)**。在调用严格限制 Payload 大小的 Provider 时，先在本地模拟 Protobuf/JSON 编码字节大小，超限时优雅剔除低优先级工具，并在 System Prompt 中注入 `tool_search` 提示词告知模型按需调取。

---

### 15. `e84e3aa1930` - 热更新后端口硬钉 (Hard-pin) 保持
- **源码文件**: `src/server/index.ts`
- **关键函数签名**: `export function startServer(options: ServerOptions)`
- **修改前后对比**:

```typescript
// ==================== BEFORE ====================
export function updateServer(newConfig: OcxConfig) {
  stopServer();
  startServer({ port: newConfig.port }); // 若配置中 port 是 0，则重启后又分派了一个新的随机端口！
}

// ==================== AFTER ====================
let boundPort: number | undefined;

export function startServer(options: ServerOptions) {
  const server = Bun.serve({
    port: boundPort ?? options.port ?? 0,
    // ...
  });
  boundPort = server.port; // 记住 OS 分配的物理端口号！
}

export function updateServer(newConfig: OcxConfig) {
  stopServer();
  // 保持首次绑定好的 boundPort，禁止漂移
  startServer({ port: boundPort });
}
```

- **防御模式解析**:
  **物理端口锁死模式 (Bound Port Retention Pattern)**。在服务支持 `port: 0` 动态分配端口的场景下，一旦首次 `listen` 成功，必须将 `server.port` 保存回运行时上下文。在 Reload/Update 时使用固定的物理端口重新绑定，防止客户端 Connection Refused。

---

### 16. `f07234f072` - 代理上游 Stall Timeout 延长至 300 秒
- **源码文件**: `src/proxy/index.ts` & `src/types.ts`
- **关键函数签名**: `export function resolveStallTimeoutSec(configuredSec: number | undefined): number`
- **修改前后对比**:

```typescript
// ==================== BEFORE ====================
const DEFAULT_STALL_TIMEOUT_SEC = 90; // 90 秒超时

// ==================== AFTER ====================
export const DEFAULT_STALL_TIMEOUT_SEC = 300; // 提升至 300 秒

export function resolveStallTimeoutSec(configuredSec: number | undefined): number {
  if (typeof configuredSec === "number" && Number.isFinite(configuredSec)) {
    return Math.max(1, Math.ceil(configuredSec));
  }
  return DEFAULT_STALL_TIMEOUT_SEC;
}
```

- **防御模式解析**:
  **长心跳/长时间思考容忍模式 (Long-Inactivity Watchdog Tolerance)**。代理看门狗（Watchdog）的时间限制必须覆盖大模型 Reasoning / Deep Thinking 和 Web Search 侧车的最大安全等待时间。同时，任何来自 Upstream 适配器的 `{ type: "heartbeat" }` 事件均需重置该计时器。

---

## 三、 故障域分类与模式总结 (Fault Domain Classification)

结合两个开源 Agent 项目的真实 Patch 历史，AI Coding Agent 的核心缺陷分布在以下 **5 大故障域**：

```mermaid
graph TD
    A[AI Coding Agent 缺陷故障域] --> B[1. 流式 / Token 截断]
    A --> C[2. 并发 / 状态机]
    A --> D[3. Tool Call 容错]
    A --> E[4. 进程 / 内存泄露]
    A --> F[5. 环境漂移]

    B --> B1[Reasoning 首字延迟超时]
    B --> B2[Token 超限正则表达式判定错误]

    C --> C1[OAuth Refresh Token 重放死锁]
    C --> C2[Subagent 无限递归派生]
    C --> C3[Late Failure 错删 Affinity 映射]

    D --> D1[Mistral toolu_ 前缀格式不兼容]
    D --> D2[Protobuf 序列化体积溢出]
    D --> D3[多租户 / 多项目 AutoAccept 隔离失效]

    E --> E1[SQLite 只读查询隐式创建 WAL/SHM]
    E --> E2[Electron 销毁窗口解绑定失效]
    E --> E3[Diff 视图全量计算导致的 O(N^2) 卡顿]

    F --> F1[Windows 平台 Bun 运行时 FS 报错]
    F --> F2[非英文 OS 下 CLI 文本正则失效]
    F --> F3[动态端口在热更新后漂移]
```

### 1. 流式 / Token 截断域 (Streaming & Token Truncation)
- **核心风险**: Reasoning 大模型（o1/o3/R1）使得 HTTP Header 与首个 Token 的时间拉长至数十秒；不同 LLM 厂商的 Token 溢出 Error Message 各异。
- **模式法则**:
  - 区分 **Transient 网络超时** 与 **Hard Token Overflow**。
  - Header Timeout / Stall Timeout 不得低于 **300 秒**。
  - 正则表达式归一化匹配必须先经过 **Exclusions 反向排除项**。

### 2. 并发 / 状态机域 (Concurrency & State Machine)
- **核心风险**: 多账号 Pool 轮询、OAuth 单次 Token 刷新、Subagent 递归调用、Session 消息树追溯。
- **模式法则**:
  - 单次消费 Token（如 Anthropic OAuth）必须在磁盘写入 **Generation Intent Lock**。
  - 解绑定/清理异步句柄时，必须带上 **Ownership Key** 比对。
  - Subagent 工具必须受 **Max Depth (默认 1)** 的硬性约束。

### 3. Tool Call 容错域 (Tool Call Fault Tolerance)
- **核心风险**: 不同 Provider 对 `tool_call_id` 格式约束不同；注册工具过多导致模型 Context 溢出或 Protobuf 报文超限。
- **模式法则**:
  - 进入 LLM 边界前强制剥离非标前缀（如 `toolu_`）。
  - 在客户端进行 **Protobuf / JSON 字节预估预算**，超限时保留 `tool_search` 降级入口。
  - 授权决策必须绑定 `(ServerKey, DirectoryPath, SessionID)` 复合命名空间。

### 4. 进程 / 内存泄露域 (Process & Memory Leakage)
- **核心风险**: 后台 SQLite 只读扫描产生文件写锁；前端 Timeline 渲染长会话时数组查找退化；Electron/Worker 销毁残留。
- **模式法则**:
  - 诊断只读操作必须使用 `file: URI + immutable=1 + SQLITE_OPEN_READONLY`。
  - 数据渲染与状态去重必须保证 **O(N) 线性算法**。

### 5. 环境漂移域 (Environment Drift)
- **核心风险**: OS 语言环境（如韩语/葡萄牙语 Windows）、Bun/Node 运行时差异、动态端口漂移。
- **模式法则**:
  - 控制台文本匹配必须基于 **无偏数字边界正则**（如 `/\b1060\b/`）。
  - 处理底层 FS 操作（如 `ensureDir`）必须考虑跨平台运行时的特殊错误码（如 `EEXIST`）。
  - 服务监听端口首次绑定后需在内存硬钉。

---

## 四、 对 Conex 项目针对性加固的工程建议

根据 Conex 项目的架构规划及用户规则（包含权限管理、UI 交互、流式 Agent 执行等），提出以下 **6 条定向加固工程建议**：

### 1. 建立基于 Generation 的防重放 OAuth 令牌锁机制
- **背景**: Conex 支持多 Provider 鉴权与账号切换。
- **实施方案**:
  - 在 `c:\Software\conex` 的 OAuth 模块中引入 `OAuthRefreshIntent` 持久化锁。
  - 在发起 refresh 之前，将当前 Refresh Token 的 SHA256 签名与 PID 写入临时锁文件；刷新成功后原子删除。若发现 Intent 已存在且代际相同，直接拦截并要求用户重新登录，彻底规避 Anthropic / OpenAI 的账号失效封禁。

### 2. 增强 Agent 权限（Permission）的 Server & Directory 双重命名空间隔离
- **背景**: 用户正在配置 Agent 权限管理，需防止项目 A 的 Allow 权限逃逸至项目 B。
- **实施方案**:
  - 严禁在 Context 中存储扁平的 `autoAccept: Record<SessionID, boolean>`。
  - 权限判定必须使用 `hash(ServerId + ":" + WorkspaceDirectory + ":" + SessionId)` 作为 Key。在切换 Workspace 或断开 Server 连接时，同步销毁内存中的对应权限上下文。

### 3. 实现严格的 Subagent 递归深度门禁 (Depth Bounding)
- **背景**: Conex 允许 Agent 派生子 Task。
- **实施方案**:
  - 在 Conex 核心 Tool 调度器（`TaskTool` / `InvokeSubagent`）中，默认限制 `max_depth = 1`。
  - 递归派生子 Agent 时，在 Context 中传递 `current_depth` 字段；超过限制直接阻断并返回标准错误，防止死循环与 Token 暴涨。

### 4. 彻底改造 SQLite 只读诊断查询为 Immutable 模式
- **背景**: Conex 后台存在历史日志与状态扫描。
- **实施方案**:
  - 针对所有只读统计（如 session 空间占用、历史记录行数计算），统一使用 `node:url` 的 `pathToFileURL` 生成转义 URI，并加上 `?immutable=1`。
  - 彻底隔离 WAL/SHM 侧车文件的隐式生成，避免产生文件锁与权限冲突。

### 5. 工具注册表 Protobuf / JSON 字节预估与 Tool Search 降级
- **背景**: 当用户导入大量 MCP Server 或本地 Tool 时，Prompt 请求体极易超出 Provider 限制。
- **实施方案**:
  - 在打包 `tools` 节点发送给 LLM 之前，新增 `calculateToolCatalogBudget()` 检查。
  - 若预估字节数超过 64KB 或工具数超过 48 个，自动按优先级截断，并在系统提示词中追加 `tool_search` 说明，指导模型按需查询。

### 6. 统一上游 Stall Timeout 与 Header Timeout 为 300 秒
- **背景**: 兼容 DeepSeek R1、o3-mini 及长文本代码生成的 Reasoning 阶段。
- **实施方案**:
  - 将 Conex 代理层与 HTTP Fetch 客户端的超时时间默认设为 **300,000 ms**（5 分钟）。
  - 适配器在接收到任何中途 SSE 帧（包括 Heartbeat）时，必须主动重置 Watchdog 计时器。
