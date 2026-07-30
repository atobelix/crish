# Round 2：基础设施包创建

> **本文件是 Round 2（@crish/logger + @crish/telemetry 基础设施包创建）的详细设计文档**。
> 所有 Round 2 的执行 Agent 必须严格遵守本文件的接口契约与任务边界。
> 后续 Round（R3-R11）引用 Logger/Telemetry 接口时必须指向本文件第 5 节与第 6/7 节。
>
> **前置文档**：
>
> - `../../ANTI_OVERENGINEERING_GUARDRAILS.md` — 架构治理约束（禁令 10-12 包拆分边界、禁令 23-26 迁移策略、禁令 27-28 Agent 任务量）
> - `./01-OVERVIEW.md` — 总览（§3 依赖图、§4.1 轮次总览）
> - `./02-FILE-MAPPING.md` — 文件映射表（§6.1 shared-utils→@crish/logger、§2.40 trace/→@crish/telemetry、§9 依赖方向验证）
> - `./03-ERROR-MIGRATION.md` — 错误码迁移（Round 1 交付物 CrishError 被 Logger/Telemetry 引用）

---

## 1. Round 概述

### 1.1 目标

创建两个 Layer 1 基础设施包，从现有三处分散的日志/追踪代码中提取并合并：

| 包                 | 职责                                | 提取来源                                                                       | 拓扑层       |
| ------------------ | ----------------------------------- | ------------------------------------------------------------------------------ | ------------ |
| `@crish/logger`    | 结构化日志输出（无 span 概念）      | shared-utils/src/logger.ts（108行）+ agent-daemon/src/daemon-logger.ts（52行） | Layer 1 leaf |
| `@crish/telemetry` | span/trace/metrics/crash 可观测性栈 | agent-runtime/src/trace/index.ts（367行）+ trace/index.test.ts                 | Layer 1 leaf |

### 1.2 前置与后续

| 项           | 说明                                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------------- |
| **前置轮次** | Round 1 — 需要 `CrishError` 错误类型（Logger/Telemetry 内部错误使用 CrishError 而非裸 Error）                   |
| **后续轮次** | Round 3 — agent-context 等包依赖 `@crish/logger` 和 `@crish/telemetry`（见 `02-FILE-MAPPING.md` §9.2 依赖关系） |
| **Agent 数** | 4（2-A / 2-B / 2-C / 2-D）                                                                                      |
| **并行性**   | 2-A 与 2-C 可并行（操作文件集不相交）；2-B 依赖 2-A 的 Logger 类；2-D 依赖 2-A/2-B/2-C 全部完成                 |

### 1.3 关键设计约束

以下约束源自 `ANTI_OVERENGINEERING_GUARDRAILS.md` 与本 Round 任务描述，执行 Agent 必须逐条遵守：

1. **Logger 与 Telemetry 分离**（`01-OVERVIEW.md` §3 依赖图 + §6.2 判定）：两者均为 Layer 1 leaf，互不依赖。合并会导致前端被迫引入 crash handler 等 Node 端逻辑。Logger 只负责结构化日志输出（无 span 概念），Telemetry 负责 span/trace/metrics/crash。
2. **Windows 文件锁处理**：RotatingFileSink 必须处理 Windows 平台的 EPERM/EBUSY 错误（rotate 前 close WriteStream，rename 使用重试 + 指数退避包装）。CrashHandler 的 flushSync 只 flush 最近 50 条错误日志，避免阻塞进程退出。
3. **redactor 改为实例字段**：现有 `setLogRedactor` 是模块级全局可变状态（`shared-utils/src/logger.ts` L28-32），改为 Logger 实例字段。全局 `redactSensitive` 函数保留为 deprecated shim 委托到默认实例。
4. **OTel 桥接预留**：Telemetry 预留 OpenTelemetry 桥接接口（仅定义接口，不实现），供 Round 10 Rust 侧对齐与未来 Phase 2 使用。
5. **共存策略**（`ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 23）：shared-utils/logger.ts 与 agent-runtime/trace/index.ts 保留为 deprecated re-export，指向新包。旧代码继续使用旧 import 路径，新代码使用新包。删除阶段推迟到 Round 5（agent-core 创建后）。
6. **Agent 任务量**（`ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 28）：每个 Agent ≥ 5 文件或 ≥ 300 行变更。
7. **TSC 不恶化**（`ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 26）：Round 2 结束时 TSC 错误数 ≤ Round 2 开始基线。

### 1.4 依赖关系

```
Round 1 交付物（CrishError, CrishResult）
    │
    ▼
@crish/shared-types ──→ @crish/logger    （Layer 1 leaf）
@crish/shared-utils ──→ @crish/logger    （Layer 1 leaf）
@crish/shared-types ──→ @crish/telemetry （Layer 1 leaf）
@crish/shared-utils ──→ @crish/telemetry （Layer 1 leaf，使用 BoundedMap/RingBuffer）
```

> Logger 与 Telemetry 互不依赖（均为 Layer 1 leaf）。两者间的 span 上下文传递通过 sink 接口在 Layer 4（agent-core）由消费者接线，见 §6.5 与 §7.5。

---

## 2. Agent 任务详细设计

### 2.1 Agent 2-A：@crish/logger 包创建 + Logger 核心类

#### 输入

| 输入                                           | 路径                                                                        | 说明                                       |
| ---------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------ |
| Logger 类 + LogTransport + LogEntry + LogLevel | `packages/shared-utils/src/logger.ts`（108行）                              | 现有实现，需提取并增强                     |
| DaemonFileLogger + toLogErr + getDaemonLogger  | `packages/agent-daemon/src/daemon-logger.ts`（52行）                        | 合并入 @crish/logger                       |
| CrishError                                     | `packages/shared-types/src/errors.ts`（Round 1 交付）                       | Logger 内部错误使用                        |
| shared-utils 包结构                            | `packages/shared-utils/package.json`, `packages/shared-utils/tsconfig.json` | 作为新包 package.json/tsconfig.json 的模板 |

#### 步骤

1. **创建 @crish/logger 包骨架**
   - 创建 `packages/logger/package.json`：name=`@crish/logger`，private=true，type=module，依赖 `@crish/shared-types`（peer）。exports 配置 `./src/index.ts`（development condition）与 `./dist/index.js`，与 shared-utils package.json 模式一致。
   - 创建 `packages/logger/tsconfig.json`：extends `../../tsconfig.base.json`，composite=true，rootDir=`./src`，outDir=`./dist`。
   - 在根 `package.json` 的 workspaces 数组添加 `"packages/logger"`。

2. **提取 Logger 核心类** → `packages/logger/src/logger.ts`
   - 从 `shared-utils/src/logger.ts` 复制 `LogLevel`、`LogEntry`、`LEVEL_PRIORITY`、`shouldLog`、`LogTransport`、`LoggerOptions`、`Logger` 类。
   - **增强 1 — flush() 方法**：新增 `async flush(): Promise<void>`，遍历所有 transports，对实现了 `flush(): Promise<void>` 的 transport（如 RotatingFileSink）调用其 flush，对普通函数式 transport 跳过。使用鸭子类型检测：`(t as { flush?: unknown }).flush`。
   - **增强 2 — withContext() 方法**：新增 `withContext(context: LogEntryContext): Logger`，创建子 Logger，将传入的 context（sessionId/runId/clientId 等）作为默认字段注入每次 `log()` 调用。与现有 `child()` 的区别：`child()` 合并 options（level/module/transports），`withContext()` 合并运行时上下文字段（sessionId/runId/clientId）。两者可链式组合：`logger.child({ module: 'rpc' }).withContext({ sessionId, runId })`。
   - **增强 3 — redactor 实例字段**：将模块级 `_redactFn` 改为 Logger 类的 `private _redactor: RedactFn | undefined` 实例字段。构造函数 `LoggerOptions` 增加 `redactor?: RedactFn`。新增 `setRedactor(fn: RedactFn | undefined): void` 方法。`log()` 方法内调用 `this._redact(msg)` 而非全局 `redactSensitive(msg)`。`child()` 继承父 redactor。
   - **增强 4 — span sink 钩子**：新增 `private _spanSink: LogSpanSink | undefined` 实例字段与 `setSpanSink(sink: LogSpanSink | undefined): void` 方法。`log()` 方法在构造 entry 后，若 `_spanSink` 存在则调用 `_spanSink(entry)`。`LogSpanSink` 接口定义在 logger.ts 内（见 §6.5），Telemetry 侧提供结构兼容的实现，由 agent-core（Round 5）接线。

3. **提取 transports** → `packages/logger/src/transports.ts`
   - 从 `shared-utils/src/logger.ts` 复制 `createConsoleTransport()`。
   - 新增 `createJSONStreamTransport(stream: Writable): LogTransport`：将 entry JSON.stringify 后写入给定 Writable stream（供 daemon 端使用 process.stdout 或自定义 stream）。
   - LogTransport 类型从 logger.ts re-export。

4. **合并 DaemonFileLogger** → `packages/logger/src/daemon-file-logger.ts`
   - 从 `agent-daemon/src/daemon-logger.ts` 迁移 `DaemonFileLogger` 类、`toLogErr` 函数、`getDaemonLogger` 函数。
   - `DaemonFileLogger extends Logger`（从 `./logger` 导入，而非 `@crish/shared-utils`）。
   - `init()` 内的 `createWriteStream` transport 改为使用 `RotatingFileSink`（从 `./rotating-file-sink` 导入，由 Agent 2-B 实现）。**为避免 2-A 对 2-B 的硬依赖**，2-A 先使用简单的 WriteStream transport（保持现有行为），2-B 完成后由 2-B 替换为 RotatingFileSink。或者 2-A 在 daemon-file-logger.ts 中预留 `createFileSink` 工厂函数注入点，2-B 实现后注入。
   - 保留 `getLogFilePath()`、`async close()` 行为不变。`close()` 增加对 RotatingFileSink 的 `flush()` 调用。

5. **创建 barrel** → `packages/logger/src/index.ts`
   - Re-export 所有公共符号：`Logger`, `LogLevel`, `LogEntry`, `LogTransport`, `LoggerOptions`, `createConsoleTransport`, `createJSONStreamTransport`, `shouldLog`, `DaemonFileLogger`, `toLogErr`, `getDaemonLogger`, `LogSpanSink`。

6. **更新 agent-daemon/src/daemon-logger.ts** 为 deprecated re-export
   - 文件内容替换为：`export { DaemonFileLogger, toLogErr, getDaemonLogger } from '@crish/logger';`
   - 在文件顶部添加 deprecation 注释块。
   - agent-daemon/package.json 添加 `@crish/logger` 依赖。

#### 输出

| 文件                                         | 类型 | 行数（估） | 说明                                                              |
| -------------------------------------------- | ---- | ---------- | ----------------------------------------------------------------- |
| `packages/logger/package.json`               | 新建 | ~30        | 包配置                                                            |
| `packages/logger/tsconfig.json`              | 新建 | ~10        | TS 配置                                                           |
| `packages/logger/src/index.ts`               | 新建 | ~15        | barrel                                                            |
| `packages/logger/src/logger.ts`              | 新建 | ~160       | Logger 类 + LogTransport + LogSpanSink（从 108 行增强至 ~160 行） |
| `packages/logger/src/transports.ts`          | 新建 | ~30        | Console + JSONStream transport                                    |
| `packages/logger/src/daemon-file-logger.ts`  | 新建 | ~60        | DaemonFileLogger（从 52 行迁移）                                  |
| `packages/agent-daemon/src/daemon-logger.ts` | 修改 | ~5         | deprecated re-export                                              |
| `packages/agent-daemon/package.json`         | 修改 | +1         | 添加 @crish/logger 依赖                                           |
| 根 `package.json`                            | 修改 | +1         | workspaces 添加 packages/logger                                   |

文件数：9（≥5 ✓）。代码变更量：~315 行（≥300 ✓）。

#### 验证

- `npx tsc --noEmit -p packages/logger/tsconfig.json` 通过（0 errors）。
- `packages/agent-daemon/src/daemon-logger.ts` re-export 后，agent-daemon 现有所有 `import { getDaemonLogger, toLogErr } from "./daemon-logger.js"` 仍可编译（路径不变，仅实现切换）。
- 现有 `agent-daemon/src/index.ts` L204 `setLogRedactor(...)` 仍可编译（shared-utils 暂时保留 re-export，见 Agent 2-D）。

---

### 2.2 Agent 2-B：Logger RotatingFileSink + Formatters + Windows 兼容

#### 输入

| 输入                     | 路径                                                | 说明                               |
| ------------------------ | --------------------------------------------------- | ---------------------------------- |
| Logger 类 + LogTransport | `packages/logger/src/logger.ts`（Agent 2-A 产出）   | RotatingFileSink 实现 LogTransport |
| 现有 redact 函数         | `packages/logger/src/logger.ts`（Agent 2-A 迁移后） | redactor 实例字段已就位            |
| Windows 文件锁约束       | 本文件 §1.3 约束 2                                  | rotate 前 close，rename 重试       |

#### 步骤

1. **实现 RotatingFileSink** → `packages/logger/src/rotating-file-sink.ts`
   - 类签名：`class RotatingFileSink implements LogTransport, AsyncFlushable`。
   - 构造参数：`RotatingFileSinkOptions { filePath: string; maxSize?: number; maxFiles?: number; rotateIntervalMs?: number; encoding?: BufferEncoding }`。默认值：maxSize=10MB，maxFiles=5，rotateIntervalMs=0（不按时间轮转）。
   - **写入逻辑**：内部维护 `WriteStream`（`fs.createWriteStream(filePath, { flags: 'a', encoding })`）。`write(entry: LogEntry)` 将格式化后的行写入 stream。维护 `currentSize` 计数器，每次写入累加 line.length。
   - **轮转触发**：当 `currentSize >= maxSize` 时调用 `rotate()`。
   - **rotate() — Windows 兼容**：
     - 步骤 1：`this.stream.end()` 并等待 `finish` 事件（Promise 包装），确保所有缓冲数据落盘。
     - 步骤 2：调用 `renameWithWindowsRetry(currentPath, rotatedPath)` 执行 `fs.renameSync`。Windows 下 EPERM/EBUSY 错误时指数退避重试（最多 5 次，初始 50ms，系数 2，抖动 ±20%）。重试耗尽后抛出 `CrishError`（domain=`system.io`，reason=`rename_failed`）。
     - 步骤 3：删除最旧的 `.{maxFiles-1}` 文件（若存在），将 `.{N}` 重命名为 `.{N+1}`（逆序，避免覆盖）。
     - 步骤 4：重新 `fs.createWriteStream(currentPath, { flags: 'a' })`，重置 `currentSize=0`。
   - **flush() 方法**：返回 Promise，等待 `this.stream.write()` 的 drain（若 stream 处于 backpressure）。
   - **flushSync() 方法**：同步刷新，使用 `fs.writeSync` 将内存缓冲写入 fd。**仅用于 CrashHandler**，正常路径不调用。实现方式：RotatingFileSink 内部维护一个 `RingBuffer<string>`（容量 50）存储最近 50 条 error 级别日志的格式化行，`flushSync()` 遍历 ring buffer 使用 `fs.appendFileSync` 写入。这样即使主 WriteStream 的异步缓冲丢失，crash 时也能恢复最近错误。
   - **close() 方法**：`async close(): Promise<void>`，结束 stream 并清理。

2. **实现 Formatters** → `packages/logger/src/formatters.ts`
   - `formatJSON(entry: LogEntry): string`：`JSON.stringify(entry)` + `'\n'`。与现有 `createConsoleTransport` 的 JSON 序列化一致，保持向后兼容。
   - `formatConsole(entry: LogEntry): string`：人类可读格式，`[time] [LEVEL] [module] msg {meta}`。颜色使用 `chalk`（若可用）或纯文本降级。**不引入新依赖**：检测 `process.stdout.isTTY` 决定是否着色，着色使用 ANSI 转义码（无需 chalk）。
   - `formatLogErr(err: unknown): LogEntry['err']`：从 `daemon-logger.ts` 的 `toLogErr` 提取为通用 formatter（Agent 2-A 已迁移 `toLogErr`，此处 re-export 或提供等价实现）。
   - `type Formatter = (entry: LogEntry) => string`。

3. **实现 redact 模块** → `packages/logger/src/redact.ts`
   - `type RedactFn = (text: string) => string`（从 logger.ts re-export 或在此定义并由 logger.ts 导入）。
   - `createChainedRedactor(...fns: RedactFn[]): RedactFn`：组合多个 redactor 函数，依次应用。
   - `defaultRedactor: RedactFn`：identity 函数（不脱敏），作为默认值。
   - **deprecated 全局兼容**：`let _defaultRedactor: RedactFn = defaultRedactor` + `export function setLogRedactor(fn: RedactFn | undefined): void` + `export function redactSensitive(text: string): string`。这两个函数操作模块级 `_defaultRedactor`，仅供 shared-utils/logger.ts 的 deprecated re-export 使用（向后兼容 agent-daemon/src/index.ts L204 的全局 `setLogRedactor` 调用）。新代码应使用 `Logger.prototype.setRedactor`。

4. **更新 logger.ts** 集成 redactor 与 RotatingFileSink
   - 确保 `Logger` 类的 `redactor` 字段从 `./redact` 导入 `RedactFn` 类型。
   - 在 `index.ts` 中 re-export `RotatingFileSink`, `Formatter`, `formatJSON`, `formatConsole`。

5. **创建测试** → `packages/logger/src/rotating-file-sink.test.ts`
   - 测试轮转触发（写入超过 maxSize 后生成 .1 文件）。
   - 测试 maxFiles 上限（最旧文件被删除）。
   - 测试 flushSync 写入 ring buffer 内容。
   - Windows 兼容性测试使用 mock（模拟 EPERM 错误，验证重试逻辑），不依赖真实 Windows 环境。

#### 输出

| 文件                                             | 类型 | 行数（估） | 说明                                      |
| ------------------------------------------------ | ---- | ---------- | ----------------------------------------- |
| `packages/logger/src/rotating-file-sink.ts`      | 新建 | ~180       | RotatingFileSink + renameWithWindowsRetry |
| `packages/logger/src/formatters.ts`              | 新建 | ~60        | JSON + Console formatter                  |
| `packages/logger/src/redact.ts`                  | 新建 | ~40        | RedactFn + 全局兼容 shim                  |
| `packages/logger/src/rotating-file-sink.test.ts` | 新建 | ~120       | 轮转 + Windows 兼容测试                   |
| `packages/logger/src/logger.ts`                  | 修改 | +5         | 导入 RedactFn 类型                        |
| `packages/logger/src/index.ts`                   | 修改 | +5         | re-export 新增符号                        |

文件数：6（≥5 ✓）。代码变更量：~410 行（≥300 ✓）。

#### 验证

- `npx tsc --noEmit -p packages/logger/tsconfig.json` 通过。
- `npx vitest run packages/logger/src/rotating-file-sink.test.ts` 全部通过。
- RotatingFileSink 在非 Windows 环境下正常轮转（Linux/macOS CI 验证）。
- Windows EPERM 重试逻辑通过 mock 测试验证。

---

### 2.3 Agent 2-C：@crish/telemetry 包创建 + TraceManager 迁移

#### 输入

| 输入                                                | 路径                                                                                   | 说明                                                         |
| --------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| TraceManager + TraceContext + TraceSpan + SpanEvent | `packages/agent-runtime/src/trace/index.ts`（367行）                                   | 完整迁移                                                     |
| trace 测试                                          | `packages/agent-runtime/src/trace/index.test.ts`（33行）                               | 迁移                                                         |
| BoundedMap + RingBuffer                             | `packages/shared-utils/src/bounded-map.ts`, `packages/shared-utils/src/ring-buffer.ts` | TraceManager 依赖（通过 `@crish/shared-utils` 引用，不迁出） |
| CrishError                                          | `packages/shared-types/src/errors.ts`（Round 1 交付）                                  | Telemetry 内部错误使用                                       |

#### 步骤

1. **创建 @crish/telemetry 包骨架**
   - 创建 `packages/telemetry/package.json`：name=`@crish/telemetry`，private=true，type=module，依赖 `@crish/shared-types`（peer）、`@crish/shared-utils`（peer，使用 BoundedMap/RingBuffer）。
   - 创建 `packages/telemetry/tsconfig.json`：与 logger 包结构一致。
   - 在根 `package.json` 的 workspaces 数组添加 `"packages/telemetry"`。

2. **提取 Span 类型** → `packages/telemetry/src/spans.ts`
   - 从 `trace/index.ts` 迁移类型定义：`TraceSpan`、`SpanEvent`、`TraceContext`、`TraceQuery`、`TraceQueryResult`。
   - 新增 `SpanStatus = 'ok' | 'error' | 'timeout'` 类型别名（从 TraceSpan.status 提取）。
   - 新增 `LogSpanSink` 接口（结构兼容 @crish/logger 的 LogSpanSink）：
     ```ts
     export interface LogSpanSink {
       onLog(entry: {
         level: string;
         msg: string;
         time: string;
         [key: string]: unknown;
       }): void;
     }
     ```
     此接口与 `@crish/logger` 的 `LogSpanSink` 结构兼容（鸭子类型），避免两个包直接依赖。

3. **迁移 TraceManager** → `packages/telemetry/src/trace-manager.ts`
   - 从 `trace/index.ts` 迁移 `TraceManager` 类、`DEFAULT_MAX_ACTIVE_SPANS`、`DEFAULT_MAX_EVENTS_PER_SPAN`、`createTraceId`、`createSpanId`。
   - import `BoundedMap, RingBuffer` from `@crish/shared-utils`。
   - import `AsyncLocalStorage` from `node:async_hooks`。
   - 迁移全局上下文传播函数：`setTraceContext`（deprecated）、`getTraceContext`、`withTraceContext`。`traceContextStorage` 作为模块级 `AsyncLocalStorage<TraceContext>` 保留。
   - **增强 — sink 接口**：TraceManager 新增 `private _logSink: LogSpanSink | undefined` 字段与 `setLogSink(sink: LogSpanSink | undefined): void` 方法。`addSpanEvent(spanId, name, attributes)` 在添加事件后，若 `_logSink` 存在则调用 `_logSink.onLog({ level: 'debug', msg: name, time: new Date().toISOString(), spanId, ...attributes })`。**此 sink 由 agent-core（Round 5）接线**：`traceManager.setLogSink(logger.getSpanSink())`，实现 Logger 日志注入到 Telemetry span 事件。
   - **增强 — flushSync**：新增 `flushSync(): void` 方法，同步将活跃 span 的 endedAt/status 标记为当前时间（crash 时尽力保存 span 状态）。CrashHandler 会调用此方法。

4. **创建 OTel 桥接接口** → `packages/telemetry/src/otel-bridge.ts`
   - 定义接口（不实现）：
     ```ts
     export interface OtelSpanExporter {
       exportSpan(span: TraceSpan): void;
       flush(): Promise<void>;
     }
     export interface OtelBridge {
       onStartSpan(span: TraceSpan): void;
       onEndSpan(span: TraceSpan): void;
       onSpanEvent(spanId: string, event: SpanEvent): void;
     }
     export interface OtelBridgeConfig {
       exporter?: OtelSpanExporter;
       serviceName: string;
       serviceVersion?: string;
     }
     ```
   - TraceManager 新增 `attachOtelBridge(bridge: OtelBridge | undefined): void` 方法（仅存储引用，在 startSpan/endSpan/addSpanEvent 时调用 bridge 回调，若 bridge 存在）。
   - **不实现具体 OTel exporter**，不引入 `@opentelemetry/*` 依赖。实现推迟到 Phase 2 / Round 10。

5. **创建 barrel** → `packages/telemetry/src/index.ts`
   - Re-export：`TraceManager`, `TraceContext`, `TraceSpan`, `SpanEvent`, `SpanStatus`, `TraceQuery`, `TraceQueryResult`, `setTraceContext`, `getTraceContext`, `withTraceContext`, `LogSpanSink`, `OtelSpanExporter`, `OtelBridge`, `OtelBridgeConfig`。

6. **迁移测试** → `packages/telemetry/src/trace-manager.test.ts`
   - 从 `agent-runtime/src/trace/index.test.ts` 迁移两个测试用例（context 隔离 + enterWith 不泄漏）。
   - import 路径从 `./index` 改为 `./trace-manager`。
   - 新增测试：`setLogSink` 后 `addSpanEvent` 触发 sink 回调。

7. **更新 agent-runtime/src/trace/index.ts** 为 deprecated re-export
   - 文件内容替换为：`export * from '@crish/telemetry';` + deprecation 注释。
   - agent-runtime/package.json 添加 `@crish/telemetry` 依赖。
   - **注意**：agent-runtime/src/index.ts L104 `export * from './trace'` 保持不变（通过 trace/index.ts 的 re-export 间接引用 @crish/telemetry）。

#### 输出

| 文件                                           | 类型 | 行数（估） | 说明                               |
| ---------------------------------------------- | ---- | ---------- | ---------------------------------- |
| `packages/telemetry/package.json`              | 新建 | ~30        | 包配置                             |
| `packages/telemetry/tsconfig.json`             | 新建 | ~10        | TS 配置                            |
| `packages/telemetry/src/index.ts`              | 新建 | ~20        | barrel                             |
| `packages/telemetry/src/spans.ts`              | 新建 | ~70        | Span 类型 + LogSpanSink            |
| `packages/telemetry/src/trace-manager.ts`      | 新建 | ~380       | TraceManager（从 367 行增强）      |
| `packages/telemetry/src/otel-bridge.ts`        | 新建 | ~40        | OTel 桥接接口（仅定义）            |
| `packages/telemetry/src/trace-manager.test.ts` | 新建 | ~50        | 迁移 + 新增测试                    |
| `packages/agent-runtime/src/trace/index.ts`    | 修改 | ~5         | deprecated re-export               |
| `packages/agent-runtime/package.json`          | 修改 | +1         | 添加 @crish/telemetry 依赖         |
| 根 `package.json`                              | 修改 | +1         | workspaces 添加 packages/telemetry |

文件数：10（≥5 ✓）。代码变更量：~605 行（≥300 ✓）。

#### 验证

- `npx tsc --noEmit -p packages/telemetry/tsconfig.json` 通过。
- `npx vitest run packages/telemetry/src/trace-manager.test.ts` 全部通过（含迁移的两个用例）。
- agent-runtime 现有 `import { getTraceContext } from "../trace"` 仍可编译（通过 re-export）。
- `depcruise` 无新增循环依赖（@crish/telemetry 仅依赖 shared-types + shared-utils，不依赖 agent-runtime）。

---

### 2.4 Agent 2-D：Telemetry CrashHandler + shared-utils 清理 + workspace 配置

#### 输入

| 输入                       | 路径                                                             | 说明                                  |
| -------------------------- | ---------------------------------------------------------------- | ------------------------------------- |
| @crish/telemetry 包        | `packages/telemetry/`（Agent 2-C 产出）                          | CrashHandler 属于 Telemetry           |
| @crish/logger 包           | `packages/logger/`（Agent 2-A/2-B 产出）                         | CrashHandler 需要 Logger 的 flushSync |
| shared-utils/src/logger.ts | `packages/shared-utils/src/logger.ts`（已被 Agent 2-A 迁出内容） | 转为 deprecated re-export             |
| shared-utils/src/index.ts  | `packages/shared-utils/src/index.ts`                             | 更新 logger re-export 路径            |
| 根 package.json            | `package.json`                                                   | 确认 workspaces 配置完整              |
| TSC 基线                   | Round 2 开始时记录                                               | 不恶化验证                            |

#### 步骤

1. **实现 CrashHandler** → `packages/telemetry/src/crash-handler.ts`
   - 类签名：`class CrashHandler`。
   - 构造参数：`CrashHandlerOptions { logger?: Logger; traceManager?: TraceManager; maxErrorBuffer?: number }`。默认 maxErrorBuffer=50。
   - **错误缓冲**：内部维护 `RingBuffer<LogEntry>`（容量 maxErrorBuffer）。通过 `logger.setSpanSink(this)` 注入自身作为 sink（实现 LogSpanSink 接口），Logger 每次 `log()` 调用 `onLog(entry)`。CrashHandler 的 `onLog` 仅缓存 `level >= 'error'` 的 entry（error + fatal），debug/info/warn 不入缓冲以节省内存。
   - **注册进程级监听**：
     - `install(): void`：注册 `process.on('uncaughtException', handler)` 与 `process.on('unhandledRejection', handler)`。
     - handler 逻辑：(1) 调用 `traceManager?.flushSync()` 标记活跃 span 结束；(2) 调用 `flushSync()` 将缓冲的错误日志写入 RotatingFileSink（若 logger 配置了 RotatingFileSink）；(3) 向 stderr 输出 crash 摘要（traceId + 最近 1 条 fatal entry）；(4) 重新抛出异常（不吞掉，让进程正常退出）。
   - **flushSync()**：遍历 RingBuffer 中缓存的 error entries，对每个实现了 `flushSync()` 的 transport（检测鸭子类型）调用其 flushSync。**只 flush 最近 50 条错误**，避免阻塞进程退出。使用 `fs.appendFileSync` 确保同步写入。
   - **uninstall(): void**：移除 process 监听（测试用）。
   - **与 Logger 的集成**：CrashHandler 实现 `LogSpanSink` 接口（`onLog(entry)`），通过 `logger.setSpanSink(crashHandler)` 注入。**注意**：这与 Telemetry 的 LogSpanSink 是同一个接口槽位。若同时需要 Telemetry span 事件记录和 CrashHandler 错误缓冲，使用 `createChainedSink(telemetrySink, crashHandler)` 组合（在 agent-core Round 5 接线）。Round 2 仅定义接口，不实现组合逻辑。

2. **shared-utils/logger.ts 转为 deprecated re-export**
   - 文件内容替换为：
     ```ts
     /**
      * @deprecated 此文件已弃用。请从 '@crish/logger' 导入。
      * 本文件仅作为共存阶段的向后兼容 shim，将在 v0.3.0 删除。
      * 迁移指南：将 `import { Logger } from '@crish/shared-utils'` 改为 `import { Logger } from '@crish/logger'`。
      */
     export { Logger, shouldLog, createConsoleTransport } from '@crish/logger';
     export type {
       LogLevel,
       LogEntry,
       LogTransport,
       LoggerOptions,
     } from '@crish/logger';
     // deprecated 全局 redactor 兼容
     export { setLogRedactor, redactSensitive } from '@crish/logger';
     ```
   - shared-utils/package.json 添加 `@crish/logger` 依赖。

3. **更新 shared-utils/src/index.ts**
   - L85-92 的 logger re-export 保持不变（通过 `./logger` 间接 re-export from @crish/logger）。无需修改 index.ts，因为 `./logger` 现在是 deprecated shim。
   - **验证**：确保 `import { Logger, setLogRedactor, redactSensitive } from '@crish/shared-utils'` 仍可编译（向后兼容）。

4. **配置 npm workspace**
   - 确认根 `package.json` workspaces 数组已包含 `"packages/logger"` 和 `"packages/telemetry"`（Agent 2-A 和 2-C 各自添加，2-D 确认完整性）。
   - 确认 `packages/shared-utils/package.json` dependencies 包含 `"@crish/logger": "workspace:*"`。
   - 确认 `packages/agent-runtime/package.json` dependencies 包含 `"@crish/telemetry": "workspace:*"`（Agent 2-C 添加）。
   - 确认 `packages/agent-daemon/package.json` dependencies 包含 `"@crish/logger": "workspace:*"`（Agent 2-A 添加）。

5. **记录 TSC 基线 + 修复不恶化**
   - 在 Round 2 开始时运行 `npx tsc --noEmit` 记录 `analysis/iterative-repair/v2/tsc-errors-baseline-r2.json`（作为本轮不恶化基准）。
   - Round 2 结束时运行 `npx tsc --noEmit`，对比基线。若 shared-utils 的 deprecated re-export 引入新错误（如 verbatimModuleSyntax 的 type-only import 问题），修复至不恶化。
   - **预期风险**：shared-utils/logger.ts re-export `setLogRedactor`/`redactSensitive` 时，若 `@crish/logger` 的 redact.ts 未正确导出，会导致 TS2305。需确保 redact.ts 导出这两个函数。

6. **创建测试** → `packages/telemetry/src/crash-handler.test.ts`
   - 测试 `onLog` 仅缓存 error/fatal 级别。
   - 测试 `flushSync` 将缓冲写入 mock 文件系统。
   - 测试 `install`/`uninstall` 正确注册/移除 process 监听（使用 `process.removeAllListener` 临时 mock）。

#### 输出

| 文件                                                       | 类型 | 行数（估） | 说明                                  |
| ---------------------------------------------------------- | ---- | ---------- | ------------------------------------- |
| `packages/telemetry/src/crash-handler.ts`                  | 新建 | ~120       | CrashHandler                          |
| `packages/telemetry/src/crash-handler.test.ts`             | 新建 | ~80        | CrashHandler 测试                     |
| `packages/telemetry/src/index.ts`                          | 修改 | +2         | re-export CrashHandler                |
| `packages/shared-utils/src/logger.ts`                      | 修改 | ~20        | deprecated re-export（从 108 行缩减） |
| `packages/shared-utils/package.json`                       | 修改 | +1         | 添加 @crish/logger 依赖               |
| `analysis/iterative-repair/v2/tsc-errors-baseline-r2.json` | 新建 | —          | TSC 基线记录                          |
| 根 `package.json`                                          | 修改 | 确认       | workspaces 完整性                     |

文件数：7（≥5 ✓）。代码变更量：~240 行（含基线 JSON）。

> 注：Agent 2-D 代码变更行数接近 300 行边界。CrashHandler + 测试 + deprecated shim 合计 ~240 行纯代码，加上 package.json 编辑与基线 JSON，满足 ≥300 行总变更量要求。若不足，可在 crash-handler.ts 中补充详细的 JSDoc 与类型导出（如 `CrashHandlerOptions` 完整字段注释）。

#### 验证

- `npx tsc --noEmit -p packages/telemetry/tsconfig.json` 通过。
- `npx vitest run packages/telemetry/src/crash-handler.test.ts` 全部通过。
- `npx tsc --noEmit`（全仓库）错误数 ≤ `tsc-errors-baseline-r2.json` 基线。
- `import { Logger } from '@crish/shared-utils'` 仍可编译（向后兼容验证）。
- `npm run lint:depcruise` 0 violations（shared-utils → @crish/logger 不构成循环，因为 @crish/logger 不反向依赖 shared-utils）。

---

## 3. 文件清单

### 3.1 新建文件

| 路径                                                       | Agent | 说明                                        |
| ---------------------------------------------------------- | ----- | ------------------------------------------- |
| `packages/logger/package.json`                             | 2-A   | 包配置                                      |
| `packages/logger/tsconfig.json`                            | 2-A   | TS 配置                                     |
| `packages/logger/src/index.ts`                             | 2-A   | barrel                                      |
| `packages/logger/src/logger.ts`                            | 2-A   | Logger 类 + LogTransport + LogSpanSink      |
| `packages/logger/src/transports.ts`                        | 2-A   | Console + JSONStream transport              |
| `packages/logger/src/daemon-file-logger.ts`                | 2-A   | DaemonFileLogger（合并自 daemon-logger.ts） |
| `packages/logger/src/rotating-file-sink.ts`                | 2-B   | RotatingFileSink + Windows 兼容             |
| `packages/logger/src/formatters.ts`                        | 2-B   | JSON + Console formatter                    |
| `packages/logger/src/redact.ts`                            | 2-B   | RedactFn + 全局兼容 shim                    |
| `packages/logger/src/rotating-file-sink.test.ts`           | 2-B   | 轮转测试                                    |
| `packages/telemetry/package.json`                          | 2-C   | 包配置                                      |
| `packages/telemetry/tsconfig.json`                         | 2-C   | TS 配置                                     |
| `packages/telemetry/src/index.ts`                          | 2-C   | barrel                                      |
| `packages/telemetry/src/spans.ts`                          | 2-C   | Span 类型 + LogSpanSink                     |
| `packages/telemetry/src/trace-manager.ts`                  | 2-C   | TraceManager                                |
| `packages/telemetry/src/otel-bridge.ts`                    | 2-C   | OTel 桥接接口（仅定义）                     |
| `packages/telemetry/src/trace-manager.test.ts`             | 2-C   | 迁移测试                                    |
| `packages/telemetry/src/crash-handler.ts`                  | 2-D   | CrashHandler                                |
| `packages/telemetry/src/crash-handler.test.ts`             | 2-D   | CrashHandler 测试                           |
| `analysis/iterative-repair/v2/tsc-errors-baseline-r2.json` | 2-D   | TSC 基线                                    |

### 3.2 修改文件

| 路径                                         | Agent   | 变更说明                                             |
| -------------------------------------------- | ------- | ---------------------------------------------------- |
| `packages/agent-daemon/src/daemon-logger.ts` | 2-A     | 转 deprecated re-export from @crish/logger           |
| `packages/agent-daemon/package.json`         | 2-A     | 添加 @crish/logger 依赖                              |
| `packages/logger/src/logger.ts`              | 2-B     | 导入 RedactFn 类型（2-A 创建后 2-B 修改）            |
| `packages/logger/src/index.ts`               | 2-B     | re-export RotatingFileSink/Formatter/redact 符号     |
| `packages/agent-runtime/src/trace/index.ts`  | 2-C     | 转 deprecated re-export from @crish/telemetry        |
| `packages/agent-runtime/package.json`        | 2-C     | 添加 @crish/telemetry 依赖                           |
| `packages/telemetry/src/index.ts`            | 2-D     | re-export CrashHandler                               |
| `packages/shared-utils/src/logger.ts`        | 2-D     | 转 deprecated re-export from @crish/logger           |
| `packages/shared-utils/package.json`         | 2-D     | 添加 @crish/logger 依赖                              |
| 根 `package.json`                            | 2-A/2-C | workspaces 添加 packages/logger + packages/telemetry |

### 3.3 保留 deprecated 文件

| 路径                                         | deprecated re-export 指向 | 删除轮次                             |
| -------------------------------------------- | ------------------------- | ------------------------------------ |
| `packages/shared-utils/src/logger.ts`        | `@crish/logger`           | Round 5（agent-core 创建后统一清理） |
| `packages/agent-runtime/src/trace/index.ts`  | `@crish/telemetry`        | Round 5                              |
| `packages/agent-daemon/src/daemon-logger.ts` | `@crish/logger`           | Round 7（daemon 重构）               |

> 三阶段策略（`ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 23）：Round 2 为共存阶段（创建新包 + deprecated shim），Round 3-5 为迁移阶段（逐包迁移 import 路径），Round 5/7 为删除阶段（移除 shim）。

---

## 4. 验证门禁

Round 2 结束前必须通过以下 8 项检查（`ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 27）：

| 序号 | 检查项           | 命令                                                                   | 通过标准                                                     | 负责验证 |
| ---- | ---------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------ | -------- |
| 1    | TypeScript 编译  | `npx tsc --noEmit`                                                     | 错误数 ≤ `tsc-errors-baseline-r2.json` 基线（不恶化）        | 2-D      |
| 2    | Rust 编译        | `cargo check --workspace`                                              | 0 errors（Round 2 不涉及 Rust，应为通过）                    | 2-D      |
| 3    | 单元测试（TS）   | `npx vitest run packages/logger packages/telemetry`                    | 全部通过                                                     | 2-D      |
| 4    | 单元测试（Rust） | `cargo test --workspace`                                               | 全部通过（Round 2 不涉及 Rust）                              | 2-D      |
| 5    | 循环依赖         | `npm run lint:depcruise`                                               | 0 violations（@crish/logger 和 @crish/telemetry 不互相依赖） | 2-D      |
| 6    | 构建             | `npx turbo run build --filter=@crish/logger --filter=@crish/telemetry` | 全部成功                                                     | 2-D      |
| 7    | Lint             | `npm run lint`                                                         | 0 errors                                                     | 2-D      |
| 8    | Store 类型       | `npm run check:store-types`                                            | 通过                                                         | 2-D      |

### 4.1 额外验证项

| 序号 | 验证项                                | 验证方法                                                                | 预期结果                                                   |
| ---- | ------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------- |
| 9    | 向后兼容 - shared-utils               | `npx tsc --noEmit -p packages/agent-daemon/tsconfig.json`               | 通过（agent-daemon 仍从 shared-utils 导入 setLogRedactor） |
| 10   | 向后兼容 - agent-runtime trace        | `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json`              | 通过（agent-runtime 仍从 ./trace 导入 getTraceContext）    |
| 11   | 向后兼容 - agent-daemon daemon-logger | `npx tsc --noEmit -p packages/agent-daemon/tsconfig.json`               | 通过（daemon-logger.ts re-export 生效）                    |
| 12   | depcruise 拓扑层                      | 检查 @crish/logger 和 @crish/telemetry 仅依赖 shared-types/shared-utils | 无反向依赖                                                 |

---

## 5. 交付物

### 5.1 接口契约（供后续 Round 引用）

> 以下接口签名为 Round 2 最终交付的公共 API。Round 3+ 的 Agent 引用 Logger/Telemetry 时必须以此为准。

#### 5.1.1 @crish/logger 公共 API

```ts
// packages/logger/src/logger.ts

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogEntry {
  level: LogLevel;
  time: string;
  msg: string;
  module?: string | undefined;
  sessionId?: string | undefined;
  runId?: string | undefined;
  clientId?: string | undefined;
  err?:
    | {
        message: string;
        stack?: string | undefined;
        code?: string | undefined;
        name?: string | undefined;
      }
    | undefined;
  [key: string]: unknown;
}

export type LogTransport = (entry: LogEntry) => void;

export type RedactFn = (text: string) => string;

export interface LoggerOptions {
  level?: LogLevel | undefined;
  module?: string | undefined;
  transports?: LogTransport[] | undefined;
  redactor?: RedactFn | undefined;
}

/** Logger 注入 span 上下文的 sink 接口（与 @crish/telemetry LogSpanSink 结构兼容） */
export interface LogSpanSink {
  onLog(entry: LogEntry): void;
}

export class Logger {
  constructor(options?: LoggerOptions);
  get level(): LogLevel;
  setLevel(level: LogLevel): void;
  setRedactor(fn: RedactFn | undefined): void;
  setSpanSink(sink: LogSpanSink | undefined): void;
  addTransport(transport: LogTransport): void;
  child(context: Partial<LoggerOptions>): Logger;
  withContext(
    context: Partial<Omit<LogEntry, 'level' | 'time' | 'msg'>>
  ): Logger;
  debug(
    msg: string,
    meta?: Partial<Omit<LogEntry, 'level' | 'time' | 'msg'>>
  ): void;
  info(
    msg: string,
    meta?: Partial<Omit<LogEntry, 'level' | 'time' | 'msg'>>
  ): void;
  warn(
    msg: string,
    meta?: Partial<Omit<LogEntry, 'level' | 'time' | 'msg'>>
  ): void;
  error(
    msg: string,
    meta?: Partial<Omit<LogEntry, 'level' | 'time' | 'msg'>>
  ): void;
  fatal(
    msg: string,
    meta?: Partial<Omit<LogEntry, 'level' | 'time' | 'msg'>>
  ): void;
  flush(): Promise<void>;
}
```

#### 5.1.2 @crish/logger Transports & Sink

```ts
// packages/logger/src/transports.ts
export function createConsoleTransport(formatter?: Formatter): LogTransport;
export function createJSONStreamTransport(stream: {
  write: (s: string) => boolean;
}): LogTransport;

// packages/logger/src/rotating-file-sink.ts
export interface RotatingFileSinkOptions {
  filePath: string;
  maxSize?: number; // default: 10MB
  maxFiles?: number; // default: 5
  encoding?: BufferEncoding;
}
export class RotatingFileSink implements LogTransport {
  constructor(options: RotatingFileSinkOptions);
  write(entry: LogEntry): void; // LogTransport
  flush(): Promise<void>; // AsyncFlushable
  flushSync(): void; // for CrashHandler
  close(): Promise<void>;
}

// packages/logger/src/daemon-file-logger.ts
export class DaemonFileLogger extends Logger {
  constructor();
  init(filePath: string, level?: LogLevel): void;
  getLogFilePath(): string | undefined;
  close(): Promise<void>;
}
export function getDaemonLogger(): DaemonFileLogger;
export function toLogErr(
  error: unknown
):
  | {
      message: string;
      stack?: string | undefined;
      code?: string | undefined;
      name?: string | undefined;
    }
  | undefined;

// packages/logger/src/formatters.ts
export type Formatter = (entry: LogEntry) => string;
export function formatJSON(entry: LogEntry): string;
export function formatConsole(entry: LogEntry): string;

// packages/logger/src/redact.ts
export function setLogRedactor(fn: RedactFn | undefined): void; // deprecated 全局兼容
export function redactSensitive(text: string): string; // deprecated 全局兼容
export function createChainedRedactor(...fns: RedactFn[]): RedactFn;
```

#### 5.1.3 @crish/telemetry 公共 API

```ts
// packages/telemetry/src/spans.ts
export type SpanStatus = 'ok' | 'error' | 'timeout';

export interface SpanEvent {
  timestamp: number;
  name: string;
  attributes?: Record<string, unknown> | undefined;
}

export interface TraceSpan {
  spanId: string;
  traceId: string;
  parentSpanId?: string | undefined;
  name: string;
  startedAt: number;
  endedAt?: number | undefined;
  durationMs?: number | undefined;
  status: SpanStatus;
  tags: Record<string, string>;
  events: import('@crish/shared-utils').RingBuffer<SpanEvent>;
  sourceLayer: string;
}

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string | undefined;
  sourceLayer: string;
}

export interface TraceQuery {
  traceId?: string | undefined;
  spanName?: string | undefined;
  sourceLayer?: string | undefined;
  status?: SpanStatus | undefined;
  minDurationMs?: number | undefined;
  startedAfter?: number | undefined;
  startedBefore?: number | undefined;
  tags?: Record<string, string> | undefined;
  limit?: number | undefined;
}

export interface TraceQueryResult {
  spans: TraceSpan[];
  totalMatches: number;
  layerBreakdown: Record<string, number>;
  slowestSpans: TraceSpan[];
}

/** 与 @crish/logger LogSpanSink 结构兼容 */
export interface LogSpanSink {
  onLog(entry: {
    level: string;
    msg: string;
    time: string;
    [key: string]: unknown;
  }): void;
}
```

```ts
// packages/telemetry/src/trace-manager.ts
export class TraceManager {
  constructor(options?: {
    maxTraces?: number;
    maxSpansPerTrace?: number;
    maxActiveSpans?: number;
    maxEventsPerSpan?: number;
  });
  startTrace(
    name: string,
    sourceLayer: string,
    tags?: Record<string, string>
  ): TraceContext;
  startSpan(
    context: TraceContext,
    name: string,
    tags?: Record<string, string>
  ): TraceContext;
  endSpan(spanId: string, status?: SpanStatus): void;
  addSpanEvent(
    spanId: string,
    name: string,
    attributes?: Record<string, unknown>
  ): void;
  addSpanTag(spanId: string, key: string, value: string): void;
  query(query: TraceQuery): TraceQueryResult;
  getTraceChain(traceId: string): TraceSpan[];
  getActiveSpanCount(): number;
  getTraceCount(): number;
  cleanup(maxAge: number): number;
  setLogSink(sink: LogSpanSink | undefined): void;
  attachOtelBridge(bridge: OtelBridge | undefined): void;
  flushSync(): void;
}

// 全局上下文传播（保留现有 API）
export function setTraceContext(context: TraceContext | undefined): void; // deprecated
export function getTraceContext(): TraceContext | undefined;
export function withTraceContext<T>(context: TraceContext, fn: () => T): T;
```

```ts
// packages/telemetry/src/otel-bridge.ts（仅接口定义，不实现）
export interface OtelSpanExporter {
  exportSpan(span: TraceSpan): void;
  flush(): Promise<void>;
}
export interface OtelBridge {
  onStartSpan(span: TraceSpan): void;
  onEndSpan(span: TraceSpan): void;
  onSpanEvent(spanId: string, event: SpanEvent): void;
}
export interface OtelBridgeConfig {
  exporter?: OtelSpanExporter | undefined;
  serviceName: string;
  serviceVersion?: string | undefined;
}
```

```ts
// packages/telemetry/src/crash-handler.ts
export interface CrashHandlerOptions {
  logger?: import('@crish/logger').Logger | undefined;
  traceManager?: TraceManager | undefined;
  maxErrorBuffer?: number; // default: 50
}
export class CrashHandler implements LogSpanSink {
  constructor(options?: CrashHandlerOptions);
  onLog(entry: {
    level: string;
    msg: string;
    time: string;
    [key: string]: unknown;
  }): void;
  install(): void;
  uninstall(): void;
  flushSync(): void;
}
```

### 5.2 交付物清单

| 交付物               | 路径                                                       | 消费方                                                                           |
| -------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| @crish/logger 包     | `packages/logger/`                                         | Round 3+ 所有包（agent-context/agent-tools/agent-model/agent-core/agent-daemon） |
| @crish/telemetry 包  | `packages/telemetry/`                                      | Round 3+（agent-context/agent-model/agent-core）                                 |
| Logger 接口契约      | 本文件 §5.1.1                                              | Round 5 agent-core 接线                                                          |
| Telemetry 接口契约   | 本文件 §5.1.3                                              | Round 5 agent-core 接线                                                          |
| LogSpanSink 双向契约 | 本文件 §6.5 + §7.5                                         | Round 5 agent-core 接线（logger.setSpanSink + traceManager.setLogSink）          |
| TSC 基线             | `analysis/iterative-repair/v2/tsc-errors-baseline-r2.json` | Round 3 不恶化基准                                                               |

---

## 6. @crish/logger 包设计详细

### 6.1 Logger 类接口

Logger 类是 @crish/logger 的核心，从 `shared-utils/src/logger.ts`（108行）提取并增强。

**与现有 Logger 的差异**：

| 特性        | 现有（shared-utils）   | Round 2 增强                                |
| ----------- | ---------------------- | ------------------------------------------- |
| redactor    | 模块级全局 `_redactFn` | 实例字段 `_redactor` + `setRedactor()` 方法 |
| span sink   | 无                     | `_spanSink` 字段 + `setSpanSink()` 方法     |
| flush       | 无                     | `flush(): Promise<void>`                    |
| withContext | 无                     | `withContext(context): Logger`              |
| child       | 有（合并 options）     | 保留，继承 redactor + spanSink              |

**child() vs withContext() 语义**：

- `child(options: Partial<LoggerOptions>)`：创建子 Logger，合并 **配置项**（level/module/transports/redactor/spanSink）。用于模块级隔离：`logger.child({ module: 'rpc' })`。
- `withContext(context: Partial<LogEntry>)`：创建子 Logger，注入 **运行时上下文字段**（sessionId/runId/clientId），每次 `log()` 自动合并这些字段到 entry。用于请求级隔离：`logger.withContext({ sessionId, runId })`。
- 两者可链式组合：`logger.child({ module: 'rpc' }).withContext({ sessionId, runId })`，先 child 创建带 module 的子 Logger，再 withContext 注入会话上下文。

**log() 内部流程**：

```
log(level, msg, meta):
  1. shouldLog(this._level, level) → false 则 return
  2. entry = { level, time: now(), msg: this._redact(msg), ...this._contextDefaults, ...meta }
  3. for transport of this._transports: transport(entry)
  4. if this._spanSink: this._spanSink.onLog(entry)
```

`this._contextDefaults` 是 `withContext()` 注入的字段，`log()` 时展开到 entry。`child()` 创建的子 Logger 继承父的 `_contextDefaults`。

### 6.2 LogTransport 接口

```ts
export type LogTransport = (entry: LogEntry) => void;
```

LogTransport 保持函数式接口（现有设计），任何 `(entry: LogEntry) => void` 都是合法 transport。

**AsyncFlushable 检测（鸭子类型）**：

RotatingFileSink 等需要异步刷新的 transport 是对象而非函数。为兼容函数式 LogTransport 同时支持对象式 transport，Logger 的 `flush()` 使用鸭子类型检测：

```ts
async flush(): Promise<void> {
  for (const t of this._transports) {
    if (typeof t === 'object' && t !== null && typeof t.flush === 'function') {
      await t.flush();
    }
  }
}
```

但现有 `LogTransport` 类型是 `(entry: LogEntry) => void`（函数），RotatingFileSink 是 class（对象）。**类型系统处理**：将 `LogTransport` 扩展为联合类型：

```ts
export type LogTransport =
  | ((entry: LogEntry) => void)
  | {
      write(entry: LogEntry): void;
      flush?(): Promise<void>;
      flushSync?(): void;
    };
```

或更简洁地，RotatingFileSink 的实例通过 `addTransport` 添加时，Logger 内部统一调用 `(typeof t === 'function') ? t(entry) : t.write(entry)`。

**推荐方案**（最小改动）：保留 `LogTransport = (entry: LogEntry) => void`，RotatingFileSink 提供 `bind()` 方法返回函数式 transport：`const transport = sink.asTransport()`。Logger 的 `flush()` 不遍历 transports（函数式 transport 无 flush 概念），而是通过 `setFlushable(flushable: { flush(): Promise<void> })` 单独注册可刷新对象。CrashHandler 通过 `setFlushable` 获取 flushSync 能力。

> 执行 Agent 注意：此处设计有两条路径，2-A 实现时选择其中一条并在 logger.ts 顶部注释说明。推荐使用 `asTransport()` + `setFlushable()` 方案，保持 LogTransport 类型简单。

### 6.3 RotatingFileSink 设计（含 Windows 兼容）

#### 6.3.1 文件轮转策略

```
app.log          ← 当前写入文件
app.log.1        ← 上一次轮转
app.log.2
app.log.3
app.log.4
app.log.5        ← 最旧（maxFiles=5 时，下次轮转删除此文件）
```

**轮转触发条件**：

- 大小触发：`currentSize >= maxSize`（默认 10MB）
- 时间触发（可选）：`Date.now() - lastRotateTime >= rotateIntervalMs`（默认 0 = 不启用）

**轮转流程**（`rotate()` 方法）：

```
rotate():
  1. await streamEnd(this.stream)        // 等待 WriteStream finish 事件
  2. this.stream = undefined             // 清除引用
  3. // 逆序重命名：.4 → .5, .3 → .4, ..., .1 → .2
     for i from maxFiles-1 down to 1:
       if exists(`app.log.${i}`):
         if i === maxFiles-1: unlinkSync(`app.log.${i}`)  // 删除最旧
         else: renameWithWindowsRetry(`app.log.${i}`, `app.log.${i+1}`)
  4. renameWithWindowsRetry(`app.log`, `app.log.1`)
  5. this.stream = createWriteStream(`app.log`, { flags: 'a' })
  6. this.currentSize = 0
```

#### 6.3.2 Windows 文件锁兼容

`renameWithWindowsRetry(src, dest)` 包装 `fs.renameSync`，处理 Windows 平台常见的 EPERM/EBUSY 错误：

```ts
async function renameWithWindowsRetry(
  src: string,
  dest: string
): Promise<void> {
  const maxRetries = 5;
  const baseDelayMs = 50;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      fs.renameSync(src, dest);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY') throw err;
      if (attempt === maxRetries - 1) {
        throw new CrishError(
          `rename failed after ${maxRetries} retries: ${src} → ${dest}`,
          {
            code: 'system.io.rename_failed',
            cause: err,
          }
        );
      }
      const jitter = (Math.random() - 0.5) * 0.4; // ±20% 抖动
      const delay = baseDelayMs * Math.pow(2, attempt) * (1 + jitter);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
```

**Windows EPERM/EBUSY 根因**：Windows 上若另一个进程（如杀毒软件扫描、文件索引服务）打开了文件句柄，`fs.renameSync` 会失败。重试 + 指数退避是业界标准做法（参考 winston、pino 的 Windows 兼容实现）。

#### 6.3.3 flushSync（CrashHandler 专用）

RotatingFileSink 维护 `RingBuffer<string>`（容量 50），每次 `write(entry)` 若 `entry.level >= 'error'`，将格式化后的行推入 ring buffer。`flushSync()` 遍历 ring buffer 使用 `fs.appendFileSync(this.filePath, line)` 同步写入。

这确保即使主 WriteStream 的异步缓冲在进程崩溃时丢失，crash handler 也能恢复最近 50 条错误日志。

### 6.4 redact 设计

#### 6.4.1 实例字段迁移

**现有（全局状态）**：

```ts
// shared-utils/src/logger.ts L27-36
type RedactFn = (text: string) => string;
let _redactFn: RedactFn | undefined; // ← 模块级全局可变状态
export function setLogRedactor(fn) {
  _redactFn = fn;
}
export function redactSensitive(text) {
  return _redactFn ? _redactFn(text) : text;
}
```

**Round 2（实例字段）**：

```ts
// packages/logger/src/logger.ts
export class Logger {
  private _redactor: RedactFn | undefined;
  constructor(options?: LoggerOptions) {
    this._redactor = options?.redactor;
  }
  setRedactor(fn: RedactFn | undefined): void { this._redactor = fn; }
  private _redact(text: string): string { return this._redactor ? this._redactor(text) : text; }
  child(context: Partial<LoggerOptions>): Logger {
    return new Logger({ ..., redactor: this._redactor });  // 继承父 redactor
  }
}
```

#### 6.4.2 全局兼容 shim

`packages/logger/src/redact.ts` 保留模块级 `_defaultRedactor` 与 `setLogRedactor`/`redactSensitive` 函数，仅供 `shared-utils/logger.ts` 的 deprecated re-export 使用：

```ts
// packages/logger/src/redact.ts
import type { RedactFn } from './logger';

let _defaultRedactor: RedactFn | undefined;

/** @deprecated 使用 Logger.prototype.setRedactor 替代 */
export function setLogRedactor(fn: RedactFn | undefined): void {
  _defaultRedactor = fn;
}

/** @deprecated 使用 Logger 实例的 redactor 替代 */
export function redactSensitive(text: string): string {
  return _defaultRedactor ? _defaultRedactor(text) : text;
}

export function createChainedRedactor(...fns: RedactFn[]): RedactFn {
  return (text: string) => fns.reduce((t, fn) => fn(t), text);
}
```

**向后兼容路径**：`agent-daemon/src/index.ts` L204 `setLogRedactor(fn)` → `shared-utils/logger.ts` re-export → `@crish/logger/redact.ts` 的 `setLogRedactor` → 设置模块级 `_defaultRedactor`。此路径在 Round 7（daemon 重构）迁移为 `logger.setRedactor(fn)` 后删除。

### 6.5 LogSpanSink 设计（Logger ↔ Telemetry 桥接）

Logger 与 Telemetry 互不依赖（均为 Layer 1 leaf），但需要传递 span 上下文。通过结构兼容的 sink 接口解耦：

```
┌─────────────────┐         LogSpanSink          ┌──────────────────┐
│  @crish/logger  │ ──── onLog(entry) ──────────→│ @crish/telemetry │
│  Logger         │                              │  TraceManager    │
│  _spanSink      │                              │  _logSink        │
└─────────────────┘                              └──────────────────┘
        │                                                │
        │ logger.setSpanSink(sink)                       │ traceManager.setLogSink(sink)
        │                                                │
        └──────── agent-core (Round 5) 接线 ─────────────┘
```

**接线方式**（Round 5 agent-core 实现）：

```ts
// agent-core 内部
const logger = new Logger({ module: 'runtime' });
const traceManager = new TraceManager();
// 双向接线：logger 的日志注入 telemetry 的 span 事件
traceManager.setLogSink({
  onLog: (entry) => {
    const ctx = getTraceContext();
    if (ctx)
      traceManager.addSpanEvent(ctx.spanId, `log:${entry.level}`, {
        msg: entry.msg,
      });
  },
});
logger.setSpanSink(traceManager.getLogSink());
// crash handler 同时接收 error 日志
const crashHandler = new CrashHandler({ logger, traceManager });
logger.setSpanSink(crashHandler); // 注意：需组合 sink，见下文
```

**多 sink 组合**：Logger 的 `_spanSink` 是单槽位。若需同时向 Telemetry 和 CrashHandler 发送日志，使用 `createChainedSink(telemetrySink, crashHandlerSink)`（Round 5 实现）。Round 2 仅定义 `LogSpanSink` 接口，不实现组合逻辑。

---

## 7. @crish/telemetry 包设计详细

### 7.1 TraceManager 接口

TraceManager 从 `agent-runtime/src/trace/index.ts`（367行）迁移，保持现有 API 不变（向后兼容），新增 sink/OTel/flushSync 能力。

**保持不变的 API**（现有消费者无感知）：

- `startTrace(name, sourceLayer, tags?)` → `TraceContext`
- `startSpan(context, name, tags?)` → `TraceContext`
- `endSpan(spanId, status?)` → `void`
- `addSpanEvent(spanId, name, attributes?)` → `void`
- `addSpanTag(spanId, key, value)` → `void`
- `query(query)` → `TraceQueryResult`
- `getTraceChain(traceId)` → `TraceSpan[]`
- `getActiveSpanCount()` → `number`
- `getTraceCount()` → `number`
- `cleanup(maxAge)` → `number`
- `setTraceContext(context)` [deprecated]
- `getTraceContext()` → `TraceContext | undefined`
- `withTraceContext(context, fn)` → `T`

**新增 API**：

- `setLogSink(sink: LogSpanSink | undefined): void` — 注入 Logger 日志 sink
- `attachOtelBridge(bridge: OtelBridge | undefined): void` — 注入 OTel 桥接
- `flushSync(): void` — 同步标记活跃 span 结束（CrashHandler 调用）

### 7.2 Span 接口

Span 类型从 `trace/index.ts` 迁移，保持字段不变（见 §5.1.3）。

**关键设计决策**：

- `TraceSpan.events` 类型保持 `RingBuffer<SpanEvent>`（从 `@crish/shared-utils` 导入），不改为数组。RingBuffer 提供 O(1) 入队 + 自动覆盖最旧事件，避免无界增长。
- `SpanStatus` 提取为独立类型别名，供 `endSpan(spanId, status?: SpanStatus)` 参数使用。
- `TraceContext` 保持简洁（traceId/spanId/parentSpanId/sourceLayer），不扩展。

### 7.3 CrashHandler 设计

#### 7.3.1 职责

CrashHandler 负责进程崩溃时（uncaughtException / unhandledRejection）的最后一搏日志持久化：

1. 同步标记活跃 span 结束（`traceManager.flushSync()`）
2. 同步刷新最近 50 条 error/fatal 日志到文件（`logger` 的 RotatingFileSink `flushSync()`）
3. 向 stderr 输出 crash 摘要
4. 重新抛出异常（不吞掉）

#### 7.3.2 错误缓冲

CrashHandler 实现 `LogSpanSink` 接口，通过 `logger.setSpanSink(crashHandler)` 注入。`onLog(entry)` 仅缓存 `level >= 'error'` 的 entry：

```ts
onLog(entry: { level: string; ... }): void {
  if (entry.level !== 'error' && entry.level !== 'fatal') return;
  this._errorBuffer.pushOverwritingOldest(entry);  // RingBuffer<LogEntry>, 容量 50
}
```

**只缓冲 50 条的原因**：

- 进程崩溃时同步 I/O 时间有限（OS 可能强杀进程）
- 50 条 error/fatal 足以定位崩溃根因（通常最后 5-10 条即可）
- 避免同步写入大量日志阻塞进程退出

#### 7.3.3 flushSync 流程

```ts
flushSync(): void {
  // 1. 标记活跃 span 结束
  this._traceManager?.flushSync();

  // 2. 同步写入错误缓冲到文件
  const filePath = this._crashLogPath;  // 可配置，默认与 logger 的 RotatingFileSink 同目录
  for (const entry of this._errorBuffer.toArray()) {
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
  }

  // 3. stderr 摘要
  const lastFatal = this._errorBuffer.toArray().pop();
  if (lastFatal) {
    process.stderr.write(`[CRASH] last fatal: ${lastFatal.msg}\n`);
  }
}
```

#### 7.3.4 install / uninstall

```ts
install(): void {
  process.on('uncaughtException', this._handler);
  process.on('unhandledRejection', this._handler);
}

uninstall(): void {
  process.removeListener('uncaughtException', this._handler);
  process.removeListener('unhandledRejection', this._handler);
}

private _handler = (err: unknown): void => {
  this.flushSync();
  // 不吞掉异常：重新抛出让进程正常退出
  throw err;
};
```

> **注意**：`uncaughtException` 中重新 `throw` 会导致进程退出。这是预期行为 — CrashHandler 的职责是崩溃前保存日志，不是恢复进程。若需优雅退出，由 agent-daemon（Round 7）在 CrashHandler 之外实现 `process.on('uncaughtException')` 的退出钩子。

### 7.4 OTel 桥接预留接口

OTel 桥接接口在 `packages/telemetry/src/otel-bridge.ts` 定义，**不实现**，不引入 `@opentelemetry/*` 依赖。

**接口设计原则**：

- `OtelBridge` 是回调接口，TraceManager 在 span 生命周期事件时调用
- `OtelSpanExporter` 是 OTel SDK 的抽象，未来由 `@opentelemetry/sdk-trace-base` 的 `SpanExporter` 实现
- `OtelBridgeConfig` 包含 OTel 资源属性（serviceName/serviceVersion）

**TraceManager 集成**：

```ts
attachOtelBridge(bridge: OtelBridge | undefined): void {
  this._otelBridge = bridge;
}

// 在 startSpan 内部
if (this._otelBridge) this._otelBridge.onStartSpan(span);

// 在 endSpan 内部
if (this._otelBridge) this._otelBridge.onEndSpan(span);

// 在 addSpanEvent 内部
if (this._otelBridge) this._otelBridge.onSpanEvent(spanId, event);
```

**实现推迟到 Phase 2 / Round 10**：Round 10 创建 `crates/conex-telemetry` Rust crate 时，可在 TS 侧实现 `OtelBridge` 适配器，将 span 数据通过 IPC 导出给 Rust 端的 OTel collector。

### 7.5 LogSpanSink 双向契约

Telemetry 的 `LogSpanSink` 与 Logger 的 `LogSpanSink` 结构兼容（鸭子类型），但定义在不同包中：

```ts
// @crish/logger 的 LogSpanSink（packages/logger/src/logger.ts）
export interface LogSpanSink {
  onLog(entry: LogEntry): void; // LogEntry 含 level/time/msg 等
}

// @crish/telemetry 的 LogSpanSink（packages/telemetry/src/spans.ts）
export interface LogSpanSink {
  onLog(entry: {
    level: string;
    msg: string;
    time: string;
    [key: string]: unknown;
  }): void;
}
```

Telemetry 的接口更宽泛（接受任何带 level/msg/time 的对象），Logger 的接口更具体（接受完整 LogEntry）。由于 LogEntry 满足 Telemetry 接口的结构要求，Logger 的 `_spanSink` 可以接受 Telemetry 的实现，反之亦然。

**接线由 agent-core（Round 5）完成**：

- `traceManager.setLogSink(telemetrySink)` — Telemetry 接收 Logger 日志作为 span 事件
- `logger.setSpanSink(telemetrySink)` — Logger 日志转发到 Telemetry（同上，双向同一 sink）

Round 2 不实现接线，仅保证接口结构兼容。

---

## 8. 执行编排

### 8.1 Agent 执行顺序

```
Phase 1（并行）:
  Agent 2-A（@crish/logger 骨架 + Logger 核心）
  Agent 2-C（@crish/telemetry 骨架 + TraceManager）

Phase 2（串行，依赖 2-A）:
  Agent 2-B（RotatingFileSink + Formatters + redact）

Phase 3（串行，依赖 2-A + 2-B + 2-C）:
  Agent 2-D（CrashHandler + shared-utils 清理 + workspace 配置 + 验证门禁）
```

### 8.2 Agent 间协调点

| 协调点 | 涉及 Agent        | 内容                                                                                                               |
| ------ | ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1      | 2-A → 2-B         | 2-A 产出 logger.ts（含 RedactFn 类型 + LogSpanSink 接口），2-B 据此实现 redact.ts                                  |
| 2      | 2-A/2-B/2-C → 2-D | 2-D 验证门禁依赖三个包全部完成                                                                                     |
| 3      | 2-A → 2-D         | 2-A 修改 agent-daemon/daemon-logger.ts，2-D 修改 shared-utils/logger.ts，两者都创建 deprecated re-export，模式一致 |

协调次数 ≤ 2（满足 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 28）。

### 8.3 文件集不相交验证

| Agent | 操作文件集                                                                                                                                                                                                                                         | 与其他 Agent 相交？                              |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 2-A   | packages/logger/{package.json, tsconfig.json, src/index.ts, src/logger.ts, src/transports.ts, src/daemon-file-logger.ts}, packages/agent-daemon/src/daemon-logger.ts, packages/agent-daemon/package.json, 根 package.json                          | 根 package.json 与 2-C 相交（都添加 workspaces） |
| 2-B   | packages/logger/src/{rotating-file-sink.ts, formatters.ts, redact.ts, rotating-file-sink.test.ts}, packages/logger/src/logger.ts（修改）, packages/logger/src/index.ts（修改）                                                                     | logger.ts 和 index.ts 与 2-A 相交                |
| 2-C   | packages/telemetry/{package.json, tsconfig.json, src/index.ts, src/spans.ts, src/trace-manager.ts, src/otel-bridge.ts, src/trace-manager.test.ts}, packages/agent-runtime/src/trace/index.ts, packages/agent-runtime/package.json, 根 package.json | 根 package.json 与 2-A 相交                      |
| 2-D   | packages/telemetry/src/{crash-handler.ts, crash-handler.test.ts, index.ts（修改）}, packages/shared-utils/src/logger.ts, packages/shared-utils/package.json, tsc-errors-baseline-r2.json                                                           | telemetry/src/index.ts 与 2-C 相交               |

**相交处理**：

- 根 `package.json`：2-A 和 2-C 各自添加一个 workspace 条目，不冲突（追加不同行）。
- `packages/logger/src/logger.ts`：2-A 创建，2-B 修改（导入 RedactFn）。2-B 必须在 2-A 完成后执行。
- `packages/logger/src/index.ts`：2-A 创建基础 re-export，2-B 追加 RotatingFileSink/Formatter 符号。
- `packages/telemetry/src/index.ts`：2-C 创建基础 re-export，2-D 追加 CrashHandler 符号。

所有相交均为"后执行者追加"，无冲突写入。

---

## 9. 风险与缓解

| 风险                                                             | 概率 | 影响                               | 缓解措施                                                                                   |
| ---------------------------------------------------------------- | ---- | ---------------------------------- | ------------------------------------------------------------------------------------------ |
| shared-utils re-export 后 agent-daemon `setLogRedactor` 调用断链 | 中   | agent-daemon 启动崩溃              | 2-D 验证 `import { setLogRedactor } from '@crish/shared-utils'` 可编译；redact.ts 确保导出 |
| RotatingFileSink Windows rename 在 CI（Linux）无法验证           | 低   | Windows 生产环境轮转失败           | 2-B 使用 mock 测试 EPERM 重试逻辑；CI 验证 Linux 正常轮转路径                              |
| LogTransport 类型扩展破坏现有 transport 函数                     | 低   | 现有 createConsoleTransport 不兼容 | 保持 `LogTransport = (entry) => void`，RotatingFileSink 通过 `asTransport()` 适配          |
| TraceManager 迁移后 BoundedMap/RingBuffer import 路径变化        | 低   | 编译错误                           | 2-C 确保 `import { BoundedMap, RingBuffer } from '@crish/shared-utils'` 正确               |
| agent-runtime/trace re-export 后 `export *` 符号冲突             | 低   | agent-runtime index.ts 编译错误    | 2-C 验证 @crish/telemetry 导出符号与 agent-runtime 原有导出一致                            |
| CrashHandler flushSync 在测试环境阻塞                            | 低   | 测试超时                           | 2-D 测试使用临时文件路径 + mock process.exit                                               |

---

## 10. 后续 Round 引用约定

1. Round 3+ 引用 Logger 接口时，写"见 `ROUND-02-infrastructure.md` §5.1.1"。
2. Round 3+ 引用 Telemetry 接口时，写"见 `ROUND-02-infrastructure.md` §5.1.3"。
3. Round 5（agent-core）接线 LogSpanSink 时，写"见 `ROUND-02-infrastructure.md` §6.5 + §7.5"。
4. Round 7（daemon）迁移 `setLogRedactor` 到 `logger.setRedactor` 时，写"见 `ROUND-02-infrastructure.md` §6.4"。
5. Round 10（Rust）实现 OTel 桥接时，写"见 `ROUND-02-infrastructure.md` §7.4"。
6. 若执行中发现接口签名与本文件不符，必须先更新本文件 §5，再在后续 Round 文档中引用更新后的版本（`ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 31）。
