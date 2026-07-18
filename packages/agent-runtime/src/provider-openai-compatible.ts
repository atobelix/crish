import { Buffer } from "node:buffer";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deepEqual, errorMessage } from "@crish/shared-utils";
import type {
  JsonObject,
  JsonValue,
  ProviderDiagnostic,
  ProviderErrorKind
} from "@crish/shared-types";
import {
  createProviderCacheHintPlan,
  type OpenAICompatibleCacheHints,
  type ProviderCacheHintPlan
} from "./provider-cache-hints";
import type {
  AgentProvider,
  AgentProviderRequest,
  ProviderUsage,
  ProviderStreamEvent
} from "./types";
import {
  authHeaderObject,
  compactObject,
  maxTokensObject,
  reasoningEffortObject,
  textContent,
  toChatMessages,
  toChatToolChoice,
  toOpenAITool,
  toResponsesInput,
  toResponsesTool,
  toResponsesToolChoice,
  type OpenAICompatibleAuthHeader,
  type OpenAICompatibleMaxTokensField,
  type OpenAICompatibleReasoningContentMode,
  type OpenAICompatibleReasoningEffort,
  type OpenAICompatibleReasoningEffortFormat,
  type OpenAICompatibleToolChoice,
  type ResolvedOpenAICompatibleEndpoint,
  type SystemPromptWireMode
} from "./openai-request-build";
import {
  delay,
  normalizeRetryOptions,
  parseRetryAfterMs,
  retryDelayMs,
  withinRetryBudget,
  type OpenAICompatibleRetryOptions
} from "./openai-retry";
import {
  isSseReadDiagnostic,
  readSseJson,
  type SseDiagnosticsOptions
} from "./openai-stream-parse";

// 公共类型：从纯模块再导出，保持 package 对外 API 不变
export type { OpenAICompatibleRetryOptions } from "./openai-retry";
export type {
  OpenAICompatibleAuthHeader,
  OpenAICompatibleMaxTokensField,
  OpenAICompatibleReasoningContentMode,
  OpenAICompatibleReasoningEffort,
  OpenAICompatibleReasoningEffortFormat,
  OpenAICompatibleToolChoice,
  SystemPromptWireMode
} from "./openai-request-build";

export interface OpenAICompatibleProviderOptions {
  id?: string;
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv?: string;
  apiKeyFile?: string;
  model: string;
  endpoint?: OpenAICompatibleEndpoint;
  authHeader?: OpenAICompatibleAuthHeader;
  maxTokensField?: OpenAICompatibleMaxTokensField;
  reasoningContent?: OpenAICompatibleReasoningContentMode;
  toolChoice?: OpenAICompatibleToolChoice;
  stream?: boolean;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  reasoningEffort?: OpenAICompatibleReasoningEffort;
  reasoningEffortFormat?: OpenAICompatibleReasoningEffortFormat;
  requestTimeoutMs?: number;
  firstByteTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  diagnostics?: boolean | OpenAICompatibleDiagnosticsOptions;
  systemPromptWireMode?: SystemPromptWireMode;
  headers?: Record<string, string>;
  retry?: OpenAICompatibleRetryOptions;
  transport?: OpenAICompatibleTransport;
  rustReqwestCommand?: string;
  rustReqwestArgs?: string[];
  rustReqwestCwd?: string;
  rustReqwestFetch?: typeof fetch;
  fetch?: typeof fetch;
}

export interface OpenAICompatibleDiagnosticsOptions {
  enabled?: boolean;
  headers?: string[];
}

export interface OpenAICompatibleProviderFileConfig {
  provider: OpenAICompatibleProviderConfig;
}

export interface OpenAICompatibleProviderConfig {
  id?: string;
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv?: string;
  apiKeyFile?: string;
  model: string;
  endpoint?: OpenAICompatibleEndpoint;
  authHeader?: OpenAICompatibleAuthHeader;
  maxTokensField?: OpenAICompatibleMaxTokensField;
  reasoningContent?: OpenAICompatibleReasoningContentMode;
  toolChoice?: OpenAICompatibleToolChoice;
  stream?: boolean;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  reasoningEffort?: OpenAICompatibleReasoningEffort;
  reasoningEffortFormat?: OpenAICompatibleReasoningEffortFormat;
  requestTimeoutMs?: number;
  firstByteTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  diagnostics?: boolean | OpenAICompatibleDiagnosticsOptions;
  systemPromptWireMode?: SystemPromptWireMode;
  headers?: Record<string, string>;
  retry?: OpenAICompatibleRetryOptions;
  transport?: OpenAICompatibleTransport;
  rustReqwestCommand?: string;
  rustReqwestArgs?: string[];
  rustReqwestCwd?: string;
}

export type OpenAICompatibleEndpoint = "auto" | "chat-completions" | "responses";
export type OpenAICompatibleTransport = "fetch" | "rust-reqwest" | "auto";

export interface OpenAICompatibleProviderConfigLoadOptions {
  env?: Record<string, string | undefined>;
  resolveApiKey?: boolean;
}

export interface OpenAICompatibleModel {
  id: string;
  object?: string;
  created?: number;
  ownedBy?: string;
}

/**
 * 请求构建上下文：把 request / endpoint / wireMode / cacheHintPlan / attempt
 * 集中流入 buildRequestBody，避免散落参数与接线断裂。
 */
interface RequestBuildContext {
  request: AgentProviderRequest;
  endpoint: ResolvedOpenAICompatibleEndpoint;
  wireMode: SystemPromptWireMode;
  cacheHintPlan?: ProviderCacheHintPlan;
  attempt: number;
}

interface PendingToolCall {
  id: string;
  name: string;
  argumentsText: string;
}

interface ResponsePendingToolCall {
  id: string;
  callId: string;
  name: string;
  argumentsText: string;
  argumentsDone?: boolean;
  itemDone?: boolean;
}

const DEFAULT_DIAGNOSTIC_HEADERS = [
  "cf-ray",
  "cf-cache-status",
  "x-request-id",
  "x-openrouter-provider",
  "x-openrouter-model",
  "x-openrouter-id",
  "x-vercel-id",
  "cf-mitigated",
  "retry-after",
  "content-type",
  "via",
  "server"
];

interface ProviderHttpRequest {
  method: "POST" | "GET";
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

interface ProviderFetchResult {
  response: Response;
  diagnostics?: Array<Omit<ProviderDiagnostic, "providerId" | "endpoint" | "url" | "attempt" | "maxAttempts">>;
}

interface RustReqwestProcessOptions {
  command: string;
  args: string[];
  cwd?: string;
}

interface RustReqwestRequest {
  method: string;
  url: string;
  headers: Array<[string, string]>;
  body?: string;
  timeoutMs?: number;
  streamBody?: boolean;
}

interface RustReqwestResponseHeader {
  status: number;
  statusText?: string;
  headers?: Array<[string, string]>;
  error?: string;
  /**
   * daemon 模式下响应 body 的字节数（header JSON 行之后紧跟的 body 长度）。
   * 单次 spawn 模式（旧协议）下不存在此字段，body 流式跟随至 stdout EOF。
   * 旧 daemon 协议使用此字段；新 daemon 协议使用 chunked 分帧，不再发送此字段。
   */
  bodyLength?: number;
  /**
   * 新 daemon 协议标记：header 行之后跟随分块帧流（<len>\n<bytes> 帧序列，0\n 结束，-1\n<msg>\n 错误）。
   * 客户端据此进入流式解析模式，逐帧推入 ReadableStream，避免全量缓冲。
   */
  chunked?: boolean;
}

// undici keep-alive Agent 类型定义：仅描述我们用到的子集，避免直接依赖 @types/undici
interface UndiciAgentOptions {
  keepAliveTimeout?: number;
  keepAliveMaxTimeout?: number;
  connections?: number;
}

interface UndiciModule {
  Agent: new (options: UndiciAgentOptions) => unknown;
  fetch: typeof fetch;
}

// 默认 fetch 实现：优先使用 undici Agent（带 keep-alive 连接池），不可用时降级到 globalThis.fetch
// 单例缓存：整个进程内只创建一次 Agent，所有 provider 实例共享同一个连接池
//
// 测试兼容性：返回的函数在每次调用时检查 globalThis.fetch 是否被替换（如 vi.stubGlobal）。
// 若被替换则走 mock，否则走 undici fetch + Agent。这样既保留生产环境的连接池复用，
// 又让测试的 fetch mock 能正常注入。
let cachedDefaultFetch: typeof fetch | undefined;
let defaultFetchInitialized = false;
// 在模块加载时立即记录原生 globalThis.fetch 引用，避免测试 vi.stubGlobal 后记录到 mock 值
const originalGlobalFetch: typeof fetch | undefined = globalThis.fetch;

function defaultKeepAliveFetch(): typeof fetch | undefined {
  if (defaultFetchInitialized) return cachedDefaultFetch;
  defaultFetchInitialized = true;

  // 尝试加载 undici 并创建 Agent（带 keep-alive 连接池）
  let undiciAgent: unknown | undefined;
  let undiciFetch: typeof fetch | undefined;
  try {
    const require = createRequire(import.meta.url);
    const undici = require("undici") as UndiciModule;
    undiciAgent = new undici.Agent({
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000
    });
    undiciFetch = undici.fetch;
  } catch {
    // undici npm 包不可用（旧 Node 或未安装）：降级到 globalThis.fetch
  }

  // 返回一个每次调用时检查 globalThis.fetch 是否被替换的函数。
  // 测试场景（vi.stubGlobal）：走 mock 保证隔离；生产场景：走 undici fetch + Agent。
  cachedDefaultFetch = (((input: RequestInfo | URL, init?: RequestInit) => {
    const globalFetch = globalThis.fetch;
    if (globalFetch !== originalGlobalFetch) {
      return globalFetch(input, init);
    }
    if (undiciFetch && undiciAgent) {
      return undiciFetch(input, { ...init, dispatcher: undiciAgent } as RequestInit);
    }
    return globalFetch(input, init);
  }) as unknown) as typeof fetch;

  return cachedDefaultFetch;
}

// === Rust reqwest daemon 客户端 ===
// 长驻 daemon 进程管理：跨请求复用 reqwest::Client 连接池，避免每次请求重新 spawn 进程。
// 通信协议（行分隔）：
//   请求 (stdin) : 单行 JSON + \n
//   响应 (stdout): header 单行 JSON + \n + bodyLength 字节 body
// 进程级单例（按 command+args+cwd 键），在 process exit 时统一 kill。
// 请求串行化：同一 daemon 一次只处理一个请求，避免 stdout 多路响应交错。

interface RustReqwestDaemon {
  child: ChildProcess;
  /** 串行化请求：同一 daemon 一次只处理一个请求 */
  busy: boolean;
  /** 等待独占权的请求队列 */
  queue: Array<() => void>;
  /** 当前请求的 stdout 读取回调；daemon 的 data 事件统一转发到此 */
  reader: ((chunk: Buffer) => void) | null;
  stderrBuffer: Buffer;
  /** 进程已退出时的错误信息（供后续请求 fail-fast，不再尝试 spawn 新 daemon） */
  deadError: string | null;
}

const rustReqwestDaemons = new Map<string, RustReqwestDaemon>();

function daemonKey(options: RustReqwestProcessOptions): string {
  return JSON.stringify([options.command, options.args, options.cwd ?? null]);
}

/**
 * 检测命令是否支持长驻 daemon 模式。
 * --stdio 标志表示命令会运行 stdin/stdout 行协议主循环（而非单次请求后退出）。
 * 测试用的一次性脚本（如 process.execPath -e）不含此标志，走单次 spawn 回退。
 */
function isDaemonCapable(options: RustReqwestProcessOptions): boolean {
  return options.args.includes("--stdio");
}

function spawnRustReqwestDaemon(options: RustReqwestProcessOptions): RustReqwestDaemon {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  const daemon: RustReqwestDaemon = {
    child,
    busy: false,
    queue: [],
    reader: null,
    stderrBuffer: Buffer.alloc(0),
    deadError: null
  };
  child.stderr.on("data", (chunk: Buffer) => {
    daemon.stderrBuffer = Buffer.concat([daemon.stderrBuffer, chunk]).subarray(0, 16_000);
  });
  // stdout：单个 data 监听器，转发到当前请求的 reader（串行化保证只有一个活跃 reader）
  child.stdout.on("data", (chunk: Buffer) => {
    const reader = daemon.reader;
    if (reader) reader(chunk);
  });
  child.on("error", (cause) => {
    daemon.deadError = daemon.deadError ?? (cause instanceof Error ? cause.message : String(cause));
    const reader = daemon.reader;
    if (reader) reader(Buffer.alloc(0));
  });
  child.on("exit", (code, processSignal) => {
    daemon.deadError = daemon.deadError ?? `Rust reqwest daemon exited with ${processSignal ?? `code ${code ?? "unknown"}`}`;
    const reader = daemon.reader;
    if (reader) reader(Buffer.alloc(0));
    rustReqwestDaemons.delete(daemonKey(options));
  });
  return daemon;
}

function getOrCreateRustReqwestDaemon(options: RustReqwestProcessOptions): RustReqwestDaemon {
  const key = daemonKey(options);
  const existing = rustReqwestDaemons.get(key);
  if (existing && !existing.child.killed && !existing.deadError) {
    return existing;
  }
  // 上一次 daemon 已死或不存在：清理后重新 spawn
  rustReqwestDaemons.delete(key);
  const daemon = spawnRustReqwestDaemon(options);
  rustReqwestDaemons.set(key, daemon);
  return daemon;
}

/** 获取 daemon 独占访问权（串行化请求，避免 stdout 响应交错） */
function acquireRustReqwestDaemon(daemon: RustReqwestDaemon): Promise<void> {
  if (!daemon.busy) {
    daemon.busy = true;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    daemon.queue.push(() => {
      daemon.busy = true;
      resolve();
    });
  });
}

function releaseRustReqwestDaemon(daemon: RustReqwestDaemon): void {
  daemon.busy = false;
  const next = daemon.queue.shift();
  if (next) next();
}

async function fetchWithRustReqwestDaemon(
  daemon: RustReqwestDaemon,
  url: string,
  request: ProviderHttpRequest,
  signal: AbortSignal
): Promise<Response> {
  if (daemon.deadError) throw new Error(daemon.deadError);
  await acquireRustReqwestDaemon(daemon);
  // acquire 后再检查一次：可能在排队期间 daemon 已退出
  if (daemon.deadError) {
    releaseRustReqwestDaemon(daemon);
    throw new Error(daemon.deadError);
  }
  try {
    return await sendRustReqwestDaemonRequest(daemon, url, request, signal);
  } finally {
    releaseRustReqwestDaemon(daemon);
  }
}

function sendRustReqwestDaemonRequest(
  daemon: RustReqwestDaemon,
  url: string,
  request: ProviderHttpRequest,
  signal: AbortSignal
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    if (daemon.deadError) {
      reject(new Error(daemon.deadError));
      return;
    }

    const payload: RustReqwestRequest = {
      method: request.method,
      url,
      headers: Object.entries(request.headers),
      body: request.body,
      timeoutMs: request.timeoutMs,
      streamBody: true
    };

    let buffer = Buffer.alloc(0);
    let headerParsed = false;
    let header: RustReqwestResponseHeader | null = null;
    let responseResolved = false;
    // chunked 流式状态
    let streamDone = false;
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let bodyClosed = false;
    let stdoutPaused = false;
    // 分块帧解析状态机：length → body → length（循环）；length==0 结束；length==-1 错误
    let parseState: "length" | "body" | "error" = "length";
    let expectedBodyBytes = 0;
    // 旧 bodyLength 协议回退状态
    let remaining = 0;

    // 中止/取消时 kill daemon：避免 daemon 写入阻塞在已满管道上导致后续请求死锁
    const killDaemon = (): void => {
      if (!daemon.child.killed) {
        try {
          daemon.child.kill();
        } catch {
          // 忽略 kill 错误（进程可能已退出）
        }
      }
    };
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
      daemon.reader = null;
    };
    const pauseStdout = (): void => {
      if (!stdoutPaused && daemon.child.stdout) {
        daemon.child.stdout.pause();
        stdoutPaused = true;
      }
    };
    const resumeStdout = (): void => {
      if (stdoutPaused && daemon.child.stdout && !bodyClosed) {
        daemon.child.stdout.resume();
        stdoutPaused = false;
      }
    };
    const enqueueBodyChunk = (chunk: Buffer | Uint8Array): void => {
      if (!bodyController || bodyClosed || chunk.byteLength === 0) return;
      bodyController.enqueue(new Uint8Array(chunk));
      if ((bodyController.desiredSize ?? 1) <= 0) {
        pauseStdout();
      }
    };
    const closeBody = (): void => {
      if (bodyController && !bodyClosed) {
        bodyClosed = true;
        bodyController.close();
      }
    };
    const errorBody = (error: Error): void => {
      if (bodyController && !bodyClosed) {
        bodyClosed = true;
        bodyController.error(error);
      }
    };
    const failStream = (error: Error): void => {
      if (streamDone) return;
      streamDone = true;
      errorBody(error);
      cleanup();
    };
    const onAbort = (): void => {
      const error = new Error("aborted");
      if (!responseResolved) {
        responseResolved = true;
        streamDone = true;
        cleanup();
        killDaemon();
        reject(error);
      } else if (!streamDone) {
        failStream(error);
        killDaemon();
      }
    };

    // chunked 分块帧解析：从 buffer 中提取帧并推入 ReadableStream
    // 遇到 backpressure（stdoutPaused）时暂停，待 pull 回调恢复后继续
    const parseChunkFrames = (): void => {
      while (!streamDone) {
        if (parseState === "length") {
          const sep = buffer.indexOf(0x0a);
          if (sep === -1) return;
          const lenStr = buffer.subarray(0, sep).toString("utf8").trim();
          buffer = buffer.subarray(sep + 1);
          const len = Number.parseInt(lenStr, 10);
          if (len === 0) {
            // 结束帧：正常关闭流
            streamDone = true;
            closeBody();
            cleanup();
            return;
          } else if (len === -1) {
            // 错误帧：下一行为错误信息
            parseState = "error";
          } else if (Number.isNaN(len) || len < 0) {
            streamDone = true;
            failStream(new Error(`Invalid chunk length from daemon: ${lenStr}`));
            return;
          } else {
            parseState = "body";
            expectedBodyBytes = len;
          }
        }
        if (parseState === "body") {
          if (buffer.length < expectedBodyBytes) return;
          const chunkData = buffer.subarray(0, expectedBodyBytes);
          buffer = buffer.subarray(expectedBodyBytes);
          enqueueBodyChunk(chunkData);
          parseState = "length";
          // backpressure：消费者慢时暂停解析，待 pull 恢复
          if (stdoutPaused) return;
        }
        if (parseState === "error") {
          const sep = buffer.indexOf(0x0a);
          if (sep === -1) return;
          const errMsg = buffer.subarray(0, sep).toString("utf8");
          buffer = buffer.subarray(sep + 1);
          streamDone = true;
          failStream(new Error(errMsg || "Response stream interrupted"));
          return;
        }
      }
    };

    signal.addEventListener("abort", onAbort, { once: true });

    daemon.reader = (chunk: Buffer) => {
      if (streamDone) return;
      if (daemon.deadError) {
        const error = new Error(daemon.deadError);
        if (!responseResolved) {
          responseResolved = true;
          streamDone = true;
          cleanup();
          reject(error);
        } else if (!streamDone) {
          failStream(error);
        }
        return;
      }
      if (chunk.length > 0) {
        buffer = Buffer.concat([buffer, chunk]);
      }
      if (!headerParsed) {
        const sep = buffer.indexOf(0x0a);
        if (sep === -1) return;
        const headerBytes = buffer.subarray(0, sep);
        const rest = buffer.subarray(sep + 1);
        let parsed: RustReqwestResponseHeader;
        try {
          parsed = JSON.parse(headerBytes.toString("utf8")) as RustReqwestResponseHeader;
        } catch (cause) {
          responseResolved = true;
          streamDone = true;
          cleanup();
          reject(new Error(`Rust reqwest daemon returned an invalid response header: ${errorMessage(cause)}`));
          return;
        }
        header = parsed;
        headerParsed = true;
        buffer = rest;
        if (header.error) {
          responseResolved = true;
          streamDone = true;
          cleanup();
          reject(new Error(header.error));
          return;
        }
        if (header.chunked) {
          // 新协议：chunked 分帧流式 body —— 创建 ReadableStream 并立即 resolve Response，
          // 后续分块帧由 parseChunkFrames 逐帧推入流，实现端到端流式转发
          const h = header;
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              bodyController = controller;
            },
            pull() {
              resumeStdout();
              // 消费者拉取后恢复解析 buffer 中可能残留的帧
              parseChunkFrames();
            },
            cancel() {
              streamDone = true;
              cleanup();
              killDaemon();
            }
          });
          responseResolved = true;
          resolve(
            new Response(stream, {
              status: h.status,
              statusText: h.statusText ?? "",
              headers: new Headers(h.headers ?? [])
            })
          );
          // 继续解析 header 行之后已缓冲的分块帧（fall through 到 parseChunkFrames）
        } else {
          // 旧协议回退：bodyLength 固定长度，缓冲完整 body 后 resolve
          remaining = header.bodyLength ?? 0;
        }
      }
      if (!headerParsed) return;
      const h = header as RustReqwestResponseHeader;
      if (h.chunked) {
        parseChunkFrames();
      } else if (buffer.length >= remaining) {
        responseResolved = true;
        streamDone = true;
        cleanup();
        const body = remaining > 0 ? buffer.subarray(0, remaining) : Buffer.alloc(0);
        resolve(
          new Response(body, {
            status: h.status,
            statusText: h.statusText ?? "",
            headers: new Headers(h.headers ?? [])
          })
        );
      }
    };

    // 写请求行到 daemon stdin（不 end stdin —— daemon 需要保持 stdin 打开接收后续请求）
    // stdio 配置为 ["pipe","pipe","pipe"]，stdin 必非 null
    const stdin = daemon.child.stdin;
    if (!stdin) {
      responseResolved = true;
      streamDone = true;
      cleanup();
      reject(new Error("Rust reqwest daemon stdin is not available"));
      return;
    }
    const line = JSON.stringify(payload) + "\n";
    stdin.write(line, "utf8", (err) => {
      if (err && !responseResolved) {
        responseResolved = true;
        streamDone = true;
        cleanup();
        reject(new Error(`Failed to write to Rust reqwest daemon stdin: ${errorMessage(err)}`));
      }
    });
  });
}

function killAllRustReqwestDaemons(): void {
  for (const daemon of rustReqwestDaemons.values()) {
    if (!daemon.child.killed) {
      try {
        daemon.child.kill();
      } catch {
        // 忽略 kill 错误（进程可能已退出）
      }
    }
  }
  rustReqwestDaemons.clear();
}

// 进程退出时统一清理所有 daemon，避免孤儿进程
process.on("exit", killAllRustReqwestDaemons);

export class OpenAICompatibleProvider implements AgentProvider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly fetchImpl?: typeof fetch;
  // apiKey 在 provider 生命周期内不变，构造时一次性解析（保留原优先级）
  private readonly resolvedApiKey: string | undefined;
  // headers 同样在生命周期内不变（content-type / accept / auth / 自定义 headers）
  private readonly resolvedHeaders: Record<string, string>;
  // wireMode 探测结果提升为实例字段，跨多次 stream() 调用（同一 provider 实例的多次 run）复用
  private readonly wireModeCache = new Map<ResolvedOpenAICompatibleEndpoint, SystemPromptWireMode>();

  constructor(private readonly options: OpenAICompatibleProviderOptions) {
    this.id = options.id ?? "openai-compatible";
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetch ?? defaultKeepAliveFetch();
    if (!this.fetchImpl && (options.transport ?? "fetch") === "fetch") {
      throw new Error("A fetch implementation is required for OpenAICompatibleProvider");
    }
    this.resolvedApiKey = resolveApiKey(this.options);
    this.resolvedHeaders = freezeHeaders(this.options, this.resolvedApiKey);
  }

  async *stream(request: AgentProviderRequest): AsyncIterable<ProviderStreamEvent> {
    const retry = normalizeRetryOptions(this.options.retry);
    const startedAt = Date.now();
    const endpoints = this.resolvedEndpoints();
    const diagEnabled = this.diagnosticsEnabled();
    // cache hint plan 只依赖 request.promptAssembly，整个 stream() 调用内不变，提前算一次
    const cacheHintPlan = this.buildCacheHintPlan(request);
    // body 字符串缓存：同一 request + endpoint + wireMode + cacheHintPlan 重试时复用序列化结果，
    // 避免对相同 body 反复 JSON.stringify
    let lastBodyObject: JsonObject | undefined;
    let lastBodyString: string | undefined;

    // 多 endpoint 重试结构（三层，避免用 attempt=maxAttempts 等副作用跳出）：
    // 1) endpoint 层：当前 endpoint 不可用时 fall through 到下一个
    // 2) attempt 层：可重试的传输/HTTP 错误，递增 attempt
    // 3) wireMode 内循环：同一 attempt 内因 system-role 兼容问题切换 wireMode 后原地重试
    for (let endpointIndex = 0; endpointIndex < endpoints.length; endpointIndex++) {
      const endpoint = endpoints[endpointIndex]!;
      const url = `${this.baseUrl}${this.requestPath(endpoint)}`;
      attemptLoop: for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
        let wireMode = this.wireModeCache.get(endpoint) ?? this.defaultSystemPromptWireMode();
        let retriedSystemPromptCompatibility = false;
        // wireMode 兼容重试：continue 留在本 attempt；break 进入下一 attempt；break attemptLoop 换 endpoint
        while (true) {
          const attemptStartedAt = Date.now();
          yield* this.diagnostic({
            phase: "request-start",
            endpoint,
            url,
            attempt,
            maxAttempts: retry.maxAttempts,
            elapsedMs: attemptStartedAt - startedAt,
            configuredModel: this.options.model,
            reason: wireMode === "user-prefix" ? "system-prompt-user-prefix" : undefined,
            ...(diagEnabled ? requestDiagnosticFields(request, wireMode, this.options.stream !== false) : {})
          });

          const bodyObject = this.buildRequestBody({ request, endpoint, wireMode, cacheHintPlan, attempt });
          let bodyString: string;
          if (lastBodyObject && deepEqual(lastBodyObject, bodyObject)) {
            bodyString = lastBodyString!;
          } else {
            bodyString = JSON.stringify(bodyObject);
            lastBodyObject = bodyObject;
            lastBodyString = bodyString;
          }

          let fetchResult: ProviderFetchResult;
          let response: Response;
          try {
            fetchResult = await this.fetchOnce(request, url, bodyString);
            for (const diagnostic of fetchResult.diagnostics ?? []) {
              yield* this.diagnostic({
                ...diagnostic,
                endpoint,
                url,
                attempt,
                maxAttempts: retry.maxAttempts
              });
            }
            response = fetchResult.response;
          } catch (cause) {
            const reason = errorMessage(cause);
            const error = classifyTransportProviderError(reason);
            const retryable = attempt < retry.maxAttempts && error.retryable && withinRetryBudget(startedAt, retry.totalBudgetMs);
            yield* this.diagnostic({
              phase: "request-error",
              endpoint,
              url,
              attempt,
              maxAttempts: retry.maxAttempts,
              elapsedMs: Date.now() - attemptStartedAt,
              retryable,
              errorKind: error.kind,
              reason
            });
            if (!retryable) throw cause;
            yield* this.retryDiagnostic(endpoint, url, attempt, retry.maxAttempts, reason, undefined, undefined, error.kind);
            await delay(retryDelayMs(retry, attempt), request.signal);
            break;
          }

          yield* this.diagnostic({
            phase: "response-start",
            endpoint,
            url,
            attempt,
            maxAttempts: retry.maxAttempts,
            elapsedMs: Date.now() - attemptStartedAt,
            status: response.status,
            statusText: response.statusText,
            headers: this.diagnosticHeaders(response)
          });

          if (!response.ok) {
            const error = await readError(response);
            const providerError = classifyHttpProviderError(response, error);
            const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
            if (this.shouldRetryWithSystemPromptUserPrefix(request, wireMode, retriedSystemPromptCompatibility, response.status, error)) {
              wireMode = "user-prefix";
              retriedSystemPromptCompatibility = true;
              this.wireModeCache.set(endpoint, wireMode);
              yield* this.diagnostic({
                phase: "request-error",
                endpoint,
                url,
                attempt,
                maxAttempts: retry.maxAttempts,
                elapsedMs: Date.now() - attemptStartedAt,
                status: response.status,
                statusText: response.statusText,
                retryable: true,
                errorKind: providerError.kind,
                reason: "Provider rejected system-role messages; retrying this endpoint with the system prompt as a stable user-prefix instruction."
              });
              continue;
            }
            if (this.shouldFallbackEndpoint(endpoint, endpointIndex, endpoints, providerError.kind, response.status, error)) {
              yield* this.diagnostic({
                phase: "endpoint-fallback",
                endpoint,
                url,
                attempt,
                maxAttempts: retry.maxAttempts,
                elapsedMs: Date.now() - attemptStartedAt,
                status: response.status,
                statusText: response.statusText,
                retryable: true,
                errorKind: providerError.kind,
                reason: trimDiagnosticReason(error)
              });
              // 放弃当前 endpoint 的剩余 attempt，直接切换到下一 endpoint
              break attemptLoop;
            }
            const retryable = attempt < retry.maxAttempts && providerError.retryable && withinRetryBudget(startedAt, retry.totalBudgetMs);
            yield* this.diagnostic({
              phase: "request-error",
              endpoint,
              url,
              attempt,
              maxAttempts: retry.maxAttempts,
              elapsedMs: Date.now() - attemptStartedAt,
              status: response.status,
              statusText: response.statusText,
              retryable,
              errorKind: providerError.kind,
              retryAfterMs,
              reason: trimDiagnosticReason(error)
            });
            if (!retryable) throw new Error(formatProviderError(error, providerError.kind));
            yield* this.retryDiagnostic(endpoint, url, attempt, retry.maxAttempts, error, response.status, response.statusText, providerError.kind, retryAfterMs);
            await delay(retryAfterMs ?? retryDelayMs(retry, attempt), request.signal);
            break;
          }

          const contentType = response.headers.get("content-type") ?? "";
          const streamRequested = this.options.stream !== false;
          if (streamRequested && contentType.includes("text/event-stream")) {
            let emittedModelEvent = false;
            let retrySystemPromptCompatibilityAfterStreamError = false;
            try {
              const stream =
                endpoint === "responses"
                  ? parseResponsesStreamingResponse(response, this.sseDiagnostics(endpoint, url, attempt, retry.maxAttempts), request.signal)
                  : parseChatCompletionsStreamingResponse(response, this.sseDiagnostics(endpoint, url, attempt, retry.maxAttempts), request.signal);
              for await (const event of stream) {
                if (
                  event.type === "stop" &&
                  event.reason === "error" &&
                  !emittedModelEvent &&
                  this.shouldRetryWithSystemPromptUserPrefix(
                    request,
                    wireMode,
                    retriedSystemPromptCompatibility,
                    response.status >= 400 ? response.status : 400,
                    event.error ?? ""
                  )
                ) {
                  wireMode = "user-prefix";
                  retriedSystemPromptCompatibility = true;
                  retrySystemPromptCompatibilityAfterStreamError = true;
                  this.wireModeCache.set(endpoint, wireMode);
                  yield* this.diagnostic({
                    phase: "request-error",
                    endpoint,
                    url,
                    attempt,
                    maxAttempts: retry.maxAttempts,
                    elapsedMs: Date.now() - attemptStartedAt,
                    status: response.status,
                    statusText: response.statusText,
                    retryable: true,
                    errorKind: "schema",
                    reason: "Provider emitted a streaming system-role rejection; retrying this endpoint with the system prompt as a stable user-prefix instruction.",
                    ...(diagEnabled ? requestDiagnosticFields(request, "native-system-role", streamRequested) : {})
                  });
                  break;
                }
                if (event.type !== "provider-diagnostic") emittedModelEvent = true;
                yield event;
              }
              if (retrySystemPromptCompatibilityAfterStreamError) continue;
              return;
            } catch (cause) {
              const reason = errorMessage(cause);
              const error = classifyStreamProviderError(reason, cause);
              const retryable =
                !request.signal.aborted &&
                !emittedModelEvent &&
                error.retryable &&
                attempt < retry.maxAttempts &&
                withinRetryBudget(startedAt, retry.totalBudgetMs);
              yield* this.diagnostic({
                phase: "request-error",
                endpoint,
                url,
                attempt,
                maxAttempts: retry.maxAttempts,
                elapsedMs: Date.now() - attemptStartedAt,
                retryable,
                errorKind: error.kind,
                reason
              });
              if (emittedModelEvent) {
                yield { type: "stop", reason: "error", error: formatProviderError(reason, error.kind) };
                return;
              }
              if (!retryable) throw cause;
              yield* this.retryDiagnostic(endpoint, url, attempt, retry.maxAttempts, reason, undefined, undefined, error.kind);
              await delay(retryDelayMs(retry, attempt), request.signal);
              break;
            }
          }

          if (streamRequested) {
            const streamFallbackReason = `Provider returned ${contentType || "unknown content type"} for a streaming request; parsing the response as non-streaming JSON.`;
            yield* this.diagnostic({
              phase: "transport-fallback",
              endpoint,
              url,
              attempt,
              maxAttempts: retry.maxAttempts,
              elapsedMs: Date.now() - attemptStartedAt,
              retryable: false,
              errorKind: "invalid-stream",
              reason: streamFallbackReason
            });
          }

          const body = (await response.json()) as JsonObject;
          const bodyError = providerBodyError(body);
          if (
            this.shouldRetryWithSystemPromptUserPrefix(
              request,
              wireMode,
              retriedSystemPromptCompatibility,
              response.status >= 400 ? response.status : 400,
              bodyError ?? ""
            )
          ) {
            wireMode = "user-prefix";
            retriedSystemPromptCompatibility = true;
            this.wireModeCache.set(endpoint, wireMode);
            yield* this.diagnostic({
              phase: "request-error",
              endpoint,
              url,
              attempt,
              maxAttempts: retry.maxAttempts,
              elapsedMs: Date.now() - attemptStartedAt,
              status: response.status,
              statusText: response.statusText,
              retryable: true,
              errorKind: "schema",
              reason: "Provider returned a JSON system-role rejection; retrying this endpoint with the system prompt as a stable user-prefix instruction.",
              ...(diagEnabled ? requestDiagnosticFields(request, "native-system-role", streamRequested) : {})
            });
            continue;
          }
          yield* this.modelMismatchDiagnostic(endpoint, url, attempt, retry.maxAttempts, body);
          yield* (endpoint === "responses" ? parseResponsesJsonResponse(body) : parseChatCompletionsJsonResponse(body));
          return;
        }
      }
    }
  }

  private endpoint(): OpenAICompatibleEndpoint {
    return this.options.endpoint ?? "auto";
  }

  private resolvedEndpoints(): ResolvedOpenAICompatibleEndpoint[] {
    const endpoint = this.endpoint();
    if (endpoint === "auto") return ["responses", "chat-completions"];
    return [endpoint];
  }

  private buildHeaders(): Record<string, string> {
    // headers 在构造时已 resolve（apiKey + content-type + accept + auth + 自定义），
    // 生命周期内不变，直接返回实例字段
    return this.resolvedHeaders;
  }

  /**
   * 基于 RequestBuildContext 构建请求体，集中接入 cache hint plan。
   * cache hint 是"提示"性质，provider 可能不支持：仅当 plan.providerHints 为
   * openai-compatible 形态时注入 prompt_cache_key，其余情况优雅降级为 no-op。
   */
  private buildRequestBody(context: RequestBuildContext): JsonObject {
    const body =
      context.endpoint === "responses"
        ? this.buildResponsesRequestBody(context)
        : this.buildChatCompletionsRequestBody(context);
    return this.withCacheHint(body, context.cacheHintPlan);
  }

  private buildChatCompletionsRequestBody(context: RequestBuildContext): JsonObject {
    const { request, wireMode } = context;
    return compactObject({
      model: this.options.model,
      stream: this.options.stream !== false,
      temperature: this.options.temperature,
      top_p: this.options.topP,
      ...maxTokensObject(this.chatMaxTokensField(), this.options.maxTokens),
      ...reasoningEffortObject("chat-completions", this.options.model, this.options.reasoningEffort, this.options.reasoningEffortFormat),
      messages: toChatMessages(request.systemPrompt, request.messages, this.options.reasoningContent ?? "omit", wireMode),
      tools: request.tools.length > 0 ? request.tools.map(toOpenAITool) : undefined,
      tool_choice: request.tools.length > 0 ? toChatToolChoice(this.options.toolChoice ?? "auto") : undefined,
      stream_options: this.options.stream !== false ? { include_usage: true } : undefined
    });
  }

  private buildResponsesRequestBody(context: RequestBuildContext): JsonObject {
    const { request, wireMode } = context;
    return compactObject({
      model: this.options.model,
      stream: this.options.stream !== false,
      temperature: this.options.temperature,
      top_p: this.options.topP,
      max_output_tokens: this.options.maxTokens,
      ...reasoningEffortObject("responses", this.options.model, this.options.reasoningEffort, this.options.reasoningEffortFormat),
      input: toResponsesInput(request.systemPrompt, request.messages, wireMode),
      tools: request.tools.length > 0 ? request.tools.map(toResponsesTool) : undefined,
      tool_choice: request.tools.length > 0 ? toResponsesToolChoice(this.options.toolChoice ?? "auto") : undefined
    });
  }

  /**
   * 把 OpenAI 风格 cache hint 注入到请求体：
   * Chat Completions / Responses API 均支持 prompt_cache_key 字段作为缓存亲和性提示。
   * 非 openai-compatible hint（anthropic/gemini/unknown）直接返回原 body，不报错。
   */
  private withCacheHint(body: JsonObject, plan: ProviderCacheHintPlan | undefined): JsonObject {
    if (!plan) return body;
    const hints = plan.providerHints as OpenAICompatibleCacheHints | { kind: string };
    if (hints.kind !== "openai-compatible") return body;
    const affinityKey = (hints as OpenAICompatibleCacheHints).stablePromptCacheAffinityKey;
    if (!affinityKey) return body;
    return { ...body, prompt_cache_key: affinityKey };
  }

  /**
   * 从 request.promptAssembly 生成 cache hint plan。
   * promptAssembly 缺失或生成失败时返回 undefined（优雅降级，不报错）。
   */
  private buildCacheHintPlan(request: AgentProviderRequest): ProviderCacheHintPlan | undefined {
    if (!request.promptAssembly) return undefined;
    try {
      return createProviderCacheHintPlan(request.promptAssembly);
    } catch {
      return undefined;
    }
  }

  private requestPath(endpoint: ResolvedOpenAICompatibleEndpoint): string {
    return endpoint === "responses" ? "/responses" : "/chat/completions";
  }

  private async fetchOnce(
    request: AgentProviderRequest,
    url: string,
    bodyString: string
  ): Promise<ProviderFetchResult> {
    const httpRequest: ProviderHttpRequest = {
      method: "POST",
      headers: this.resolvedHeaders,
      body: bodyString,
      timeoutMs: this.options.requestTimeoutMs
    };
    const transport = this.options.transport ?? "fetch";

    if (transport === "rust-reqwest") {
      return {
        response: await this.fetchWithRustReqwest(url, httpRequest, request.signal)
      };
    }

    try {
      const fetchImpl = this.fetchImpl ?? defaultKeepAliveFetch();
      if (!fetchImpl) {
        return {
          response: await this.fetchWithRustReqwest(url, httpRequest, request.signal),
          diagnostics: [
            {
              phase: "transport-fallback",
              retryable: true,
              errorKind: "network",
              reason: "Fetch transport is unavailable; using Rust reqwest transport."
            }
          ]
        };
      }
      const response = await fetchWithTimeout(fetchImpl, url, httpRequest, request.signal);
      if (transport !== "auto" || response.ok) {
        return { response };
      }

      const error = await readError(response.clone());
      const providerError = classifyHttpProviderError(response, error);
      if (providerError.kind !== "gateway-challenge") {
        return { response };
      }

      return {
        response: await this.fetchWithRustReqwest(url, httpRequest, request.signal),
        diagnostics: [
          {
            phase: "transport-fallback",
            status: response.status,
            statusText: response.statusText,
            retryable: true,
            errorKind: providerError.kind,
            reason: trimDiagnosticReason(error)
          }
        ]
      };
    } catch (cause) {
      if (transport !== "auto" || request.signal.aborted) throw cause;
      const reason = errorMessage(cause);
      const response = await this.fetchWithRustReqwest(url, httpRequest, request.signal).catch((fallbackCause) => {
        const fallbackMsg = errorMessage(fallbackCause);
        const hint = fallbackMsg.includes("agent-provider-http") ? " (提示: 请运行 cargo build -p agent-provider-http 构建传输层)" : "";
        throw new Error(`Fetch transport failed: ${reason}; Rust reqwest fallback failed: ${fallbackMsg}${hint}`);
      });
      return {
        response,
        diagnostics: [
          {
            phase: "transport-fallback",
            retryable: true,
            errorKind: "network",
            reason: trimDiagnosticReason(reason)
          }
        ]
      };
    }
  }

  private async fetchWithRustReqwest(url: string, request: ProviderHttpRequest, signal: AbortSignal): Promise<Response> {
    if (this.options.rustReqwestFetch) {
      return fetchWithTimeout(this.options.rustReqwestFetch, url, request, signal);
    }
    return fetchWithRustReqwestProcess(url, request, signal, {
      command: this.rustReqwestCommand(),
      args: this.rustReqwestArgs(),
      cwd: this.rustReqwestCwd()
    });
  }

  private rustReqwestCommand(): string {
    return this.options.rustReqwestCommand ?? readEnv("AGENT_PROVIDER_HTTP_COMMAND") ?? "cargo";
  }

  private rustReqwestArgs(): string[] {
    if (this.options.rustReqwestArgs) return this.options.rustReqwestArgs;
    // --stdio 标志：激活 TS 侧 daemon 客户端 + Rust 侧行循环主循环
    // （Rust binary 忽略未知 args，--stdio 仅作为 TS 侧 daemon 模式检测信号）
    if (readEnv("AGENT_PROVIDER_HTTP_COMMAND")) return ["--stdio"];
    // cargo run 需要 -- 分隔 cargo 参数与 binary 参数
    return ["run", "-p", "agent-provider-http", "--quiet", "--", "--stdio"];
  }

  private rustReqwestCwd(): string | undefined {
    return this.options.rustReqwestCwd ?? readEnv("AGENT_PROVIDER_HTTP_CWD") ?? defaultWorkspaceRoot();
  }

  private *retryDiagnostic(
    endpoint: ResolvedOpenAICompatibleEndpoint,
    url: string,
    attempt: number,
    maxAttempts: number,
    reason: string,
    status?: number,
    statusText?: string,
    errorKind?: ProviderErrorKind,
    retryAfterMs?: number
  ): Iterable<ProviderStreamEvent> {
    yield* this.diagnostic({
      phase: "retry",
      endpoint,
      url,
      attempt,
      maxAttempts,
      status,
      statusText,
      retryable: true,
      errorKind,
      retryAfterMs,
      reason
    });
  }

  private sseDiagnostics(
    endpoint: ResolvedOpenAICompatibleEndpoint,
    url: string,
    attempt: number,
    maxAttempts: number
  ): SseDiagnosticsOptions | undefined {
    if (!this.diagnosticsEnabled() && !this.options.firstByteTimeoutMs && !this.options.streamIdleTimeoutMs) return undefined;
    return {
      enabled: this.diagnosticsEnabled(),
      providerId: this.id,
      endpoint,
      url,
      attempt,
      maxAttempts,
      configuredModel: this.options.model,
      firstByteTimeoutMs: this.options.firstByteTimeoutMs,
      streamIdleTimeoutMs: this.options.streamIdleTimeoutMs
    };
  }

  private *modelMismatchDiagnostic(
    endpoint: ResolvedOpenAICompatibleEndpoint,
    url: string,
    attempt: number,
    maxAttempts: number,
    body: JsonObject
  ): Iterable<ProviderStreamEvent> {
    const actualModel = actualModelFromPayload(body);
    if (!actualModel || actualModel === this.options.model) return;
    yield* this.diagnostic({
      phase: "model-mismatch",
      endpoint,
      url,
      attempt,
      maxAttempts,
      configuredModel: this.options.model,
      actualModel,
      modelMismatch: true,
      reason: "Provider response model differed from the configured request model; keeping the configured model for session state."
    });
  }

  private *diagnostic(input: Omit<ProviderDiagnostic, "providerId">): Iterable<ProviderStreamEvent> {
    if (!this.diagnosticsEnabled()) return;
    yield { type: "provider-diagnostic", diagnostic: compactObject({ providerId: this.id, ...input }) as unknown as ProviderDiagnostic };
  }

  private diagnosticsEnabled(): boolean {
    if (this.options.diagnostics === true) return true;
    if (this.options.diagnostics && typeof this.options.diagnostics === "object") {
      return this.options.diagnostics.enabled !== false;
    }
    return false;
  }

  private diagnosticHeaders(response: Response): Record<string, string> | undefined {
    if (!this.diagnosticsEnabled()) return undefined;
    const configured = typeof this.options.diagnostics === "object" ? this.options.diagnostics.headers : undefined;
    const names = configured?.length ? configured : DEFAULT_DIAGNOSTIC_HEADERS;
    const headers: Record<string, string> = {};
    for (const name of names) {
      const value = response.headers.get(name);
      if (value) headers[name.toLowerCase()] = value.slice(0, 160);
    }
    return Object.keys(headers).length > 0 ? headers : undefined;
  }

  private chatMaxTokensField(): OpenAICompatibleMaxTokensField {
    if (this.options.maxTokensField) return this.options.maxTokensField;
    return isMimoModel(this.options.model) ? "max_completion_tokens" : "max_tokens";
  }

  private shouldFallbackEndpoint(
    endpoint: ResolvedOpenAICompatibleEndpoint,
    endpointIndex: number,
    endpoints: ResolvedOpenAICompatibleEndpoint[],
    errorKind: ProviderErrorKind,
    status: number,
    error: string
  ): boolean {
    if (this.endpoint() !== "auto") return false;
    if (endpoint !== "responses") return false;
    if (endpointIndex >= endpoints.length - 1) return false;
    if (errorKind !== "endpoint-unavailable") return false;
    return isResponsesEndpointUnavailable(status, error);
  }

  private shouldRetryWithSystemPromptUserPrefix(
    request: AgentProviderRequest,
    wireMode: SystemPromptWireMode,
    alreadyRetried: boolean,
    status: number,
    error: string
  ): boolean {
    if (alreadyRetried || wireMode !== "native-system-role") return false;
    if (!hasSystemRoleWireContent(request)) return false;
    return isSystemRoleUnsupported(status, error);
  }

  private defaultSystemPromptWireMode(): SystemPromptWireMode {
    return this.options.systemPromptWireMode ?? "native-system-role";
  }
}

export async function loadOpenAICompatibleProviderConfig(
  filePath: string,
  options: OpenAICompatibleProviderConfigLoadOptions = {}
): Promise<OpenAICompatibleProviderConfig> {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const config = parseProviderConfig(parsed, filePath);
  return options.resolveApiKey === false ? config : resolveProviderConfigSecrets(config, filePath, options);
}

export async function createOpenAICompatibleProviderFromConfig(
  filePath: string,
  overrides: Partial<OpenAICompatibleProviderOptions> = {},
  loadOptions: OpenAICompatibleProviderConfigLoadOptions = {}
): Promise<OpenAICompatibleProvider> {
  const config = await loadOpenAICompatibleProviderConfig(filePath, loadOptions);
  return new OpenAICompatibleProvider({
    ...config,
    ...overrides
  });
}

export async function listOpenAICompatibleModels(options: {
  baseUrl: string;
  modelsUrl?: string;
  modelsPath?: string;
  apiKey?: string;
  authHeader?: OpenAICompatibleAuthHeader;
  headers?: Record<string, string>;
  requestTimeoutMs?: number;
  transport?: OpenAICompatibleTransport;
  rustReqwestCommand?: string;
  rustReqwestArgs?: string[];
  rustReqwestCwd?: string;
  rustReqwestFetch?: typeof fetch;
  fetch?: typeof fetch;
}): Promise<OpenAICompatibleModel[]> {
  const fetchImpl = options.fetch ?? defaultKeepAliveFetch();
  const transport = options.transport ?? "fetch";
  if (!fetchImpl && transport === "fetch") {
    throw new Error("A fetch implementation is required to list models");
  }
  const apiKey = options.apiKey ?? readEnv("CRISH_API_KEY") ?? readEnv("FLOWBIT_API_KEY") ?? readEnv("OPENAI_API_KEY");
  const modelsUrl = resolveModelsUrl(options);
  const signal = new AbortController().signal;
  const request: ProviderHttpRequest = {
    method: "GET",
    headers: {
      accept: "application/json",
      ...authHeaderObject(options.authHeader ?? "authorization", apiKey),
      ...options.headers
    },
    timeoutMs: options.requestTimeoutMs
  };
  let response =
    transport === "rust-reqwest" || !fetchImpl
      ? await fetchWithOptionalRustReqwestOverride(modelsUrl, request, signal, options)
      : await fetchWithTimeout(fetchImpl, modelsUrl, request, signal);
  if (transport === "auto" && !response.ok) {
    const error = await readError(response.clone());
    const providerError = classifyHttpProviderError(response, error);
    if (providerError.kind === "gateway-challenge") {
      response = await fetchWithOptionalRustReqwestOverride(modelsUrl, request, signal, options);
    }
  }
  if (!response.ok) {
    const error = await readError(response);
    const providerError = classifyHttpProviderError(response, error);
    throw new Error(formatProviderError(error, providerError.kind));
  }
  const body = (await response.json()) as { data?: unknown };
  if (!Array.isArray(body.data)) {
    return [];
  }
  return body.data
    .map((item): OpenAICompatibleModel | null => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      if (typeof record.id !== "string") return null;
      return {
        id: record.id,
        object: typeof record.object === "string" ? record.object : undefined,
        created: typeof record.created === "number" ? record.created : undefined,
        ownedBy: typeof record.owned_by === "string" ? record.owned_by : undefined
      };
    })
    .filter((model): model is OpenAICompatibleModel => model !== null);
}

function parseProviderConfig(input: unknown, filePath: string): OpenAICompatibleProviderConfig {
  const root = objectRecord(input, `${filePath}: root`);
  const provider = objectRecord(root.provider, `${filePath}: provider`);
  const config = compactObject({
    id: optionalString(provider.id, `${filePath}: provider.id`),
    baseUrl: requiredString(provider.baseUrl, `${filePath}: provider.baseUrl`),
    apiKey: optionalString(provider.apiKey, `${filePath}: provider.apiKey`),
    apiKeyEnv: optionalString(provider.apiKeyEnv, `${filePath}: provider.apiKeyEnv`),
    apiKeyFile: optionalString(provider.apiKeyFile, `${filePath}: provider.apiKeyFile`),
    model: requiredString(provider.model, `${filePath}: provider.model`),
    endpoint: optionalEndpoint(provider.endpoint, `${filePath}: provider.endpoint`),
    authHeader: optionalAuthHeader(provider.authHeader, `${filePath}: provider.authHeader`),
    maxTokensField: optionalMaxTokensField(provider.maxTokensField, `${filePath}: provider.maxTokensField`),
    reasoningContent: optionalReasoningContentMode(provider.reasoningContent, `${filePath}: provider.reasoningContent`),
    reasoningEffort: optionalReasoningEffort(provider.reasoningEffort, `${filePath}: provider.reasoningEffort`),
    reasoningEffortFormat: optionalReasoningEffortFormat(provider.reasoningEffortFormat, `${filePath}: provider.reasoningEffortFormat`),
    toolChoice: optionalToolChoice(provider.toolChoice, `${filePath}: provider.toolChoice`),
    stream: optionalBoolean(provider.stream, `${filePath}: provider.stream`),
    temperature: optionalNumber(provider.temperature, `${filePath}: provider.temperature`),
    topP: optionalNumber(provider.topP, `${filePath}: provider.topP`),
    maxTokens: optionalPositiveInteger(provider.maxTokens, `${filePath}: provider.maxTokens`),
    requestTimeoutMs: optionalPositiveInteger(provider.requestTimeoutMs, `${filePath}: provider.requestTimeoutMs`),
    firstByteTimeoutMs: optionalPositiveInteger(provider.firstByteTimeoutMs, `${filePath}: provider.firstByteTimeoutMs`),
    streamIdleTimeoutMs: optionalPositiveInteger(provider.streamIdleTimeoutMs, `${filePath}: provider.streamIdleTimeoutMs`),
    diagnostics: optionalDiagnostics(provider.diagnostics, `${filePath}: provider.diagnostics`),
    systemPromptWireMode: optionalSystemPromptWireMode(provider.systemPromptWireMode, `${filePath}: provider.systemPromptWireMode`),
    headers: optionalStringRecord(provider.headers, `${filePath}: provider.headers`),
    retry: optionalRetryOptions(provider.retry, `${filePath}: provider.retry`),
    transport: optionalTransport(provider.transport, `${filePath}: provider.transport`),
    rustReqwestCommand: optionalString(provider.rustReqwestCommand, `${filePath}: provider.rustReqwestCommand`),
    rustReqwestArgs: optionalStringArray(provider.rustReqwestArgs, `${filePath}: provider.rustReqwestArgs`),
    rustReqwestCwd: optionalString(provider.rustReqwestCwd, `${filePath}: provider.rustReqwestCwd`)
  });
  return config as unknown as OpenAICompatibleProviderConfig;
}

async function resolveProviderConfigSecrets(
  config: OpenAICompatibleProviderConfig,
  filePath: string,
  options: OpenAICompatibleProviderConfigLoadOptions
): Promise<OpenAICompatibleProviderConfig> {
  const apiKeyFile = config.apiKeyFile ? resolveConfigRelativePath(config.apiKeyFile, filePath) : undefined;
  const apiKey =
    config.apiKey ??
    (config.apiKeyEnv ? readEnvFrom(options.env, config.apiKeyEnv) : undefined) ??
    (apiKeyFile ? (await readFile(apiKeyFile, "utf8")).trim() : undefined);
  return compactObject({
    ...config,
    apiKeyFile,
    apiKey
  }) as unknown as OpenAICompatibleProviderConfig;
}

function resolveConfigRelativePath(filePath: string, configPath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(dirname(resolve(configPath)), filePath);
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function resolveModelsUrl(options: { baseUrl: string; modelsUrl?: string; modelsPath?: string }): string {
  if (options.modelsUrl?.trim()) return options.modelsUrl.trim();
  const path = options.modelsPath?.trim() || "/models";
  if (/^https?:\/\//i.test(path)) return path;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizeBaseUrl(options.baseUrl)}${normalizedPath}`;
}

async function* parseChatCompletionsJsonResponse(body: JsonObject): AsyncIterable<ProviderStreamEvent> {
  const error = providerBodyError(body);
  if (error) {
    yield { type: "stop", reason: "error", error };
    return;
  }

  const choice = Array.isArray(body.choices) ? (body.choices[0] as Record<string, unknown> | undefined) : undefined;
  const message = choice?.message && typeof choice.message === "object" ? (choice.message as Record<string, unknown>) : undefined;
  if (!message) {
    yield { type: "stop", reason: "error", error: "OpenAI-compatible response did not include a message" };
    return;
  }

  if (typeof message.reasoning_content === "string" && message.reasoning_content.length > 0) {
    yield { type: "thought-delta", text: message.reasoning_content };
  }

  if (typeof message.content === "string" && message.content.length > 0) {
    yield { type: "text-delta", text: message.content };
  }

  if (Array.isArray(message.tool_calls)) {
    for (const rawCall of message.tool_calls) {
      const call = parseFullToolCall(rawCall);
      if (call) {
        yield { type: "tool-call", id: call.id, toolName: call.name, input: parseArguments(call.argumentsText) };
      }
    }
  }

  yield { type: "stop", reason: finishReasonToStop(choice?.finish_reason), usage: parseUsage(body.usage) };
}

async function* parseChatCompletionsStreamingResponse(
  response: Response,
  diagnostics?: SseDiagnosticsOptions,
  signal?: AbortSignal
): AsyncIterable<ProviderStreamEvent> {
  if (!response.body) {
    yield { type: "stop", reason: "error", error: "Streaming response body is empty" };
    return;
  }

  const pending = new Map<number, PendingToolCall>();
  let finishReason: ProviderStreamEvent & { type: "stop" } = { type: "stop", reason: "stop" };
  let usage: ProviderUsage | undefined;
  let modelMismatchReported = false;

  for await (const payload of readSseJson(response.body, diagnostics, signal)) {
    if (isSseReadDiagnostic(payload)) {
      yield { type: "provider-diagnostic", diagnostic: payload.diagnostic };
      continue;
    }
    if (!modelMismatchReported) {
      const modelMismatch = modelMismatchStreamEvent(actualModelFromPayload(payload), diagnostics);
      if (modelMismatch) {
        modelMismatchReported = true;
        yield modelMismatch;
      }
    }
    const payloadError = providerBodyError(payload);
    if (payloadError) {
      yield { type: "stop", reason: "error", error: payloadError, usage };
      return;
    }
    usage = parseUsage(payload.usage) ?? usage;
    const choice = Array.isArray(payload.choices) ? (payload.choices[0] as Record<string, unknown> | undefined) : undefined;
    const delta = choice?.delta && typeof choice.delta === "object" ? (choice.delta as Record<string, unknown>) : undefined;
    if (!choice || !delta) continue;

    if (typeof delta.content === "string" && delta.content.length > 0) {
      yield { type: "text-delta", text: delta.content };
    }
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
      yield { type: "thought-delta", text: delta.reasoning_content };
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const raw of delta.tool_calls) {
        mergeToolCallDelta(pending, raw);
      }
    }

    if (choice.finish_reason) {
      finishReason = { type: "stop", reason: finishReasonToStop(choice.finish_reason) };
    }
  }

  // pending 的 key 是 tool_call 的 index（单调递增的数字），Map 插入顺序即升序，
  // 无需 sort + map：直接遍历 values() 即可。
  for (const call of pending.values()) {
    if (call.name) {
      yield { type: "tool-call", id: call.id, toolName: call.name, input: parseArguments(call.argumentsText) };
    }
  }
  yield { ...finishReason, usage };
}

async function* parseResponsesJsonResponse(body: JsonObject): AsyncIterable<ProviderStreamEvent> {
  const output = Array.isArray(body.output) ? body.output : [];
  let sawToolCall = false;

  for (const item of output) {
    for (const event of responseOutputItemEvents(item)) {
      if (event.type === "tool-call") sawToolCall = true;
      yield event;
    }
  }

  yield compactObject({
    type: "stop",
    reason: sawToolCall ? "tool-call" : responseStatusToStop(body),
    error: responseError(body),
    usage: parseUsage(body.usage)
  }) as unknown as Extract<ProviderStreamEvent, { type: "stop" }>;
}

async function* parseResponsesStreamingResponse(
  response: Response,
  diagnostics?: SseDiagnosticsOptions,
  signal?: AbortSignal
): AsyncIterable<ProviderStreamEvent> {
  if (!response.body) {
    yield { type: "stop", reason: "error", error: "Streaming response body is empty" };
    return;
  }

  const pending = new Map<string, ResponsePendingToolCall>();
  const emitted = new Set<string>();
  let usage: ProviderUsage | undefined;
  let finalReason: "stop" | "tool-call" | "length" | "error" = "stop";
  let finalError: string | undefined;
  let sawToolCall = false;
  let sawTerminal = false;
  let modelMismatchReported = false;

  for await (const payload of readSseJson(response.body, diagnostics, signal)) {
    if (isSseReadDiagnostic(payload)) {
      yield { type: "provider-diagnostic", diagnostic: payload.diagnostic };
      continue;
    }
    if (!modelMismatchReported) {
      const modelMismatch = modelMismatchStreamEvent(actualModelFromPayload(payload), diagnostics);
      if (modelMismatch) {
        modelMismatchReported = true;
        yield modelMismatch;
      }
    }
    const type = typeof payload.type === "string" ? payload.type : "";
    usage = parseUsage(payload.usage) ?? parseUsage(recordField(payload.response, "usage")) ?? usage;

    if (type === "error") {
      yield {
        type: "stop",
        reason: "error",
        error: responseError(payload) ?? stringField(payload.message) ?? stringField(payload.code) ?? "Responses stream emitted an error event",
        usage
      };
      return;
    }

    if (type === "response.output_text.delta" && typeof payload.delta === "string" && payload.delta.length > 0) {
      yield { type: "text-delta", text: payload.delta };
      continue;
    }

    if (isResponsesThoughtDelta(type) && typeof payload.delta === "string" && payload.delta.length > 0) {
      yield { type: "thought-delta", text: payload.delta, redacted: true };
      continue;
    }

    if (type === "response.output_item.added" || type === "response.output_item.done") {
      const call = mergeResponseToolCallItem(pending, payload.item);
      if (type === "response.output_item.done") {
        if (call) call.itemDone = true;
        const event = call && (call.argumentsDone || call.argumentsText.trim()) ? emitResponseToolCall(call, emitted) : undefined;
        if (event) {
          sawToolCall = true;
          yield event;
        }
      }
      continue;
    }

    if (type === "response.function_call_arguments.delta") {
      mergeResponseToolCallArguments(pending, payload, "append");
      continue;
    }

    if (type === "response.function_call_arguments.done") {
      const call = mergeResponseToolCallArguments(pending, payload, "replace");
      if (call) call.argumentsDone = true;
      const event = emitResponseToolCall(call, emitted);
      if (event) {
        sawToolCall = true;
        yield event;
      }
      continue;
    }

    if (type === "response.completed" || type === "response.failed" || type === "response.incomplete") {
      sawTerminal = true;
      const responsePayload = recordField(payload.response, undefined);
      usage = parseUsage(recordField(responsePayload, "usage")) ?? usage;
      finalReason = responseStatusToStop(responsePayload ?? payload);
      finalError = responseError(responsePayload ?? payload);
      for (const item of responseOutputItems(responsePayload)) {
        mergeResponseToolCallItem(pending, item);
      }
    }
  }

  for (const call of pending.values()) {
    const event = emitResponseToolCall(call, emitted);
    if (event) {
      sawToolCall = true;
      yield event;
    }
  }

  if (!sawTerminal) {
    yield compactObject({
      type: "stop",
      reason: "error",
      error: formatProviderError("Responses stream ended without a terminal response event", "invalid-stream"),
      usage
    }) as unknown as Extract<ProviderStreamEvent, { type: "stop" }>;
    return;
  }

  yield compactObject({
    type: "stop",
    reason: sawToolCall ? "tool-call" : finalReason,
    error: finalError,
    usage
  }) as unknown as Extract<ProviderStreamEvent, { type: "stop" }>;
}

function* responseOutputItemEvents(item: unknown): Iterable<ProviderStreamEvent> {
  const record = recordField(item, undefined);
  if (!record) return;

  if (record.type === "message") {
    for (const part of responseContentParts(record.content)) {
      const content = recordField(part, undefined);
      if (!content) continue;
      if ((content.type === "output_text" || content.type === "text") && typeof content.text === "string" && content.text.length > 0) {
        yield { type: "text-delta", text: content.text };
      }
    }
    return;
  }

  if (record.type === "function_call") {
    const name = stringField(record.name);
    if (!name) return;
    yield {
      type: "tool-call",
      id: stringField(record.call_id) ?? stringField(record.id),
      toolName: name,
      input: parseArguments(stringField(record.arguments) ?? "")
    };
    return;
  }

  if (record.type === "reasoning") {
    for (const part of responseContentParts(record.summary)) {
      const content = recordField(part, undefined);
      const text = stringField(content?.text);
      if (text) yield { type: "thought-delta", text, redacted: true };
    }
  }
}

function responseContentParts(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.length > 0) return [{ type: "text", text: value }];
  return [];
}

function responseOutputItems(response: Record<string, unknown> | undefined): unknown[] {
  return Array.isArray(response?.output) ? response.output : [];
}

function mergeResponseToolCallItem(pending: Map<string, ResponsePendingToolCall>, item: unknown): ResponsePendingToolCall | undefined {
  const record = recordField(item, undefined);
  if (!record || record.type !== "function_call") return undefined;
  const itemId = stringField(record.id);
  const callId = stringField(record.call_id);
  const key = findResponseToolCallKey(pending, itemId, callId) ?? itemId ?? callId ?? `response_call_${pending.size}`;
  const current = pending.get(key) ?? {
    id: itemId ?? callId ?? key,
    callId: callId ?? itemId ?? key,
    name: "",
    argumentsText: ""
  };
  current.callId = callId ?? current.callId;
  current.name = stringField(record.name) ?? current.name;
  if (typeof record.arguments === "string") current.argumentsText = record.arguments;
  pending.set(key, current);
  return current;
}

function mergeResponseToolCallArguments(
  pending: Map<string, ResponsePendingToolCall>,
  payload: JsonObject,
  mode: "append" | "replace"
): ResponsePendingToolCall | undefined {
  const itemId = stringField(payload.item_id);
  const callId = stringField(payload.call_id);
  const key = findResponseToolCallKey(pending, itemId, callId) ?? itemId ?? callId;
  if (!key) return undefined;
  const current = pending.get(key) ?? {
    id: itemId ?? key,
    callId: callId ?? key,
    name: "",
    argumentsText: ""
  };
  const argumentsText = stringField(payload.arguments) ?? stringField(payload.delta);
  if (argumentsText !== undefined) {
    current.argumentsText = mode === "append" ? current.argumentsText + argumentsText : argumentsText;
  }
  pending.set(key, current);
  return current;
}

function findResponseToolCallKey(pending: Map<string, ResponsePendingToolCall>, itemId: string | undefined, callId: string | undefined): string | undefined {
  if (itemId && pending.has(itemId)) return itemId;
  if (callId && pending.has(callId)) return callId;
  if (callId) {
    for (const [key, call] of pending.entries()) {
      if (call.callId === callId) return key;
    }
  }
  return undefined;
}

function emitResponseToolCall(
  call: ResponsePendingToolCall | undefined,
  emitted: Set<string>
): Extract<ProviderStreamEvent, { type: "tool-call" }> | undefined {
  const emittedKey = call?.callId || call?.id;
  if (!call || !call.name || !emittedKey || emitted.has(emittedKey)) return undefined;
  emitted.add(emittedKey);
  return {
    type: "tool-call",
    id: call.callId || call.id,
    toolName: call.name,
    input: parseArguments(call.argumentsText)
  };
}

function isResponsesThoughtDelta(type: string): boolean {
  return (
    type === "response.reasoning_summary_text.delta" ||
    type === "response.reasoning_text.delta" ||
    type === "response.reasoning.delta"
  );
}

function responseStatusToStop(body: Record<string, unknown> | undefined): "stop" | "tool-call" | "length" | "error" {
  const status = body?.status;
  if (status === "incomplete") return "length";
  if (status === "failed" || status === "cancelled") return "error";
  return "stop";
}

function responseError(body: Record<string, unknown> | undefined): string | undefined {
  const error = recordField(body?.error, undefined);
  return stringField(error?.message) ?? stringField(body?.error);
}

function providerBodyError(body: Record<string, unknown> | undefined): string | undefined {
  const error = responseError(body);
  return (
    error ??
    stringField(body?.message) ??
    stringField(body?.error_description) ??
    stringField(body?.code)
  );
}

function mergeToolCallDelta(pending: Map<number, PendingToolCall>, raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const record = raw as Record<string, unknown>;
  const index = typeof record.index === "number" ? record.index : pending.size;
  const current = pending.get(index) ?? { id: `call_${index}`, name: "", argumentsText: "" };
  if (typeof record.id === "string") current.id = record.id;
  const fn = record.function && typeof record.function === "object" ? (record.function as Record<string, unknown>) : undefined;
  if (typeof fn?.name === "string") current.name = fn.name;
  if (typeof fn?.arguments === "string") current.argumentsText += fn.arguments;
  pending.set(index, current);
}

function parseFullToolCall(raw: unknown): PendingToolCall | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const fn = record.function && typeof record.function === "object" ? (record.function as Record<string, unknown>) : undefined;
  if (!fn || typeof fn.name !== "string") return null;
  return {
    id: typeof record.id === "string" ? record.id : `call_${fn.name}`,
    name: fn.name,
    argumentsText: typeof fn.arguments === "string" ? fn.arguments : "{}"
  };
}

function parseArguments(input: string): JsonObject {
  if (!input.trim()) return {};
  try {
    const parsed = JSON.parse(input) as JsonValue;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as JsonObject;
    }
    return { value: parsed };
  } catch (cause) {
    return {
      __rawArguments: input,
      __parseError: cause instanceof Error ? cause.message : String(cause)
    };
  }
}

function finishReasonToStop(reason: unknown): "stop" | "tool-call" | "length" | "error" {
  if (reason === "tool_calls" || reason === "function_call") return "tool-call";
  if (reason === "length") return "length";
  if (reason === "stop" || reason == null) return "stop";
  return "error";
}

function parseUsage(raw: unknown): ProviderUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as Record<string, unknown>;
  const details =
    (usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
      ? (usage.prompt_tokens_details as Record<string, unknown>)
      : undefined) ??
    (usage.input_tokens_details && typeof usage.input_tokens_details === "object"
      ? (usage.input_tokens_details as Record<string, unknown>)
      : undefined) ??
    {};
  const completionDetails =
    (usage.completion_tokens_details && typeof usage.completion_tokens_details === "object"
      ? (usage.completion_tokens_details as Record<string, unknown>)
      : undefined) ??
    (usage.output_tokens_details && typeof usage.output_tokens_details === "object"
      ? (usage.output_tokens_details as Record<string, unknown>)
      : undefined) ??
    {};
  return compactObject({
    promptTokens: numberField(usage.prompt_tokens) ?? numberField(usage.input_tokens),
    completionTokens: numberField(usage.completion_tokens) ?? numberField(usage.output_tokens),
    totalTokens: numberField(usage.total_tokens),
    cacheReadTokens: numberField(details.cached_tokens),
    reasoningTokens: numberField(completionDetails.reasoning_tokens)
  }) as unknown as ProviderUsage;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function actualModelFromPayload(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;
  return stringField(payload.model) ?? stringField(recordField(payload.response, undefined)?.model);
}

function modelMismatchStreamEvent(
  actualModel: string | undefined,
  diagnostics: SseDiagnosticsOptions | undefined
): Extract<ProviderStreamEvent, { type: "provider-diagnostic" }> | undefined {
  if (!actualModel || !diagnostics?.enabled || !diagnostics.configuredModel || actualModel === diagnostics.configuredModel) return undefined;
  return {
    type: "provider-diagnostic",
    diagnostic: {
      phase: "model-mismatch",
      providerId: diagnostics.providerId,
      endpoint: diagnostics.endpoint,
      url: diagnostics.url,
      attempt: diagnostics.attempt,
      maxAttempts: diagnostics.maxAttempts,
      configuredModel: diagnostics.configuredModel,
      actualModel,
      modelMismatch: true,
      reason: "Provider response model differed from the configured request model; keeping the configured model for session state."
    }
  };
}

function isMimoModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized === "mimo" || normalized.startsWith("mimo-") || normalized.includes("/mimo-");
}

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return `${response.status} ${response.statusText}${text ? `: ${text}` : ""}`;
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  request: ProviderHttpRequest,
  signal: AbortSignal
): Promise<Response> {
  if (!request.timeoutMs) {
    return fetchImpl(url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal
    });
  }

  const controller = new AbortController();
  const abortFromRequest = (): void => controller.abort(signal.reason);
  if (signal.aborted) {
    abortFromRequest();
  } else {
    signal.addEventListener("abort", abortFromRequest, { once: true });
  }

  const timeout = setTimeout(() => controller.abort(new Error(`Provider request timed out after ${request.timeoutMs}ms`)), request.timeoutMs);
  try {
    return await fetchImpl(url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abortFromRequest);
  }
}

async function fetchWithRustReqwestProcess(
  url: string,
  request: ProviderHttpRequest,
  signal: AbortSignal,
  options: RustReqwestProcessOptions
): Promise<Response> {
  // daemon 模式：命令带 --stdio 标志时走长驻进程，跨请求复用 reqwest::Client 连接池
  if (isDaemonCapable(options)) {
    const daemon = getOrCreateRustReqwestDaemon(options);
    return fetchWithRustReqwestDaemon(daemon, url, request, signal);
  }
  // 单次 spawn 模式（向后兼容：测试用 process.execPath -e 一次性脚本，不含 --stdio）
  return fetchWithRustReqwestSingleShot(url, request, signal, options);
}

/**
 * 单次 spawn 模式：每次请求 spawn 新进程，请求完成后进程退出。
 * 旧协议：响应 header JSON 行 + body 字节流（跟随至 stdout EOF，无长度前缀）。
 * 保留用于非 daemon 命令（如测试中的 process.execPath -e 一次性脚本）。
 */
async function fetchWithRustReqwestSingleShot(
  url: string,
  request: ProviderHttpRequest,
  signal: AbortSignal,
  options: RustReqwestProcessOptions
): Promise<Response> {
  return new Promise<Response>((resolveResponse, rejectResponse) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    let responseResolved = false;
    let stdoutEnded = false;
    let bodyClosed = false;
    let headerBuffer = Buffer.alloc(0);
    let stderrBuffer = Buffer.alloc(0);
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let stdoutPaused = false;

    const cleanupAbort = (): void => {
      signal.removeEventListener("abort", abortFromRequest);
    };
    const failBeforeResponse = (error: Error): void => {
      cleanupAbort();
      if (!child.killed) child.kill();
      rejectResponse(error);
    };
    const errorBody = (error: Error): void => {
      cleanupAbort();
      if (bodyController && !bodyClosed) {
        bodyClosed = true;
        bodyController.error(error);
      }
    };
    const closeBody = (): void => {
      if (bodyController && !bodyClosed) {
        bodyClosed = true;
        bodyController.close();
      }
    };
    const pauseStdoutForBackpressure = (): void => {
      if (!stdoutPaused) {
        child.stdout.pause();
        stdoutPaused = true;
      }
    };
    const resumeStdout = (): void => {
      if (stdoutPaused && !bodyClosed) {
        child.stdout.resume();
        stdoutPaused = false;
      }
    };
    const enqueueBodyChunk = (chunk: Buffer | Uint8Array): void => {
      if (!bodyController || bodyClosed || chunk.byteLength === 0) return;
      bodyController.enqueue(new Uint8Array(chunk));
      if ((bodyController.desiredSize ?? 1) <= 0) {
        pauseStdoutForBackpressure();
      }
    };
    const abortFromRequest = (): void => {
      const error = new Error("aborted");
      if (responseResolved) {
        errorBody(error);
      } else {
        failBeforeResponse(error);
      }
    };

    if (signal.aborted) {
      abortFromRequest();
      return;
    }
    signal.addEventListener("abort", abortFromRequest, { once: true });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer = Buffer.concat([stderrBuffer, chunk]).subarray(0, 16_000);
    });

    child.on("error", (cause) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      if (responseResolved) errorBody(error);
      else failBeforeResponse(error);
    });

    child.stdout.on("data", (chunk: Buffer) => {
      if (!responseResolved) {
        headerBuffer = Buffer.concat([headerBuffer, chunk]);
        const separator = headerBuffer.indexOf(0x0a);
        if (separator === -1) return;
        const headerBytes = headerBuffer.subarray(0, separator);
        const rest = headerBuffer.subarray(separator + 1);
        let header: RustReqwestResponseHeader;
        try {
          header = JSON.parse(headerBytes.toString("utf8")) as RustReqwestResponseHeader;
        } catch (cause) {
          failBeforeResponse(new Error(`Rust reqwest transport returned an invalid response header: ${errorMessage(cause)}`));
          return;
        }
        if (header.error) {
          failBeforeResponse(new Error(header.error));
          return;
        }

        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            bodyController = controller;
            enqueueBodyChunk(rest);
            if (stdoutEnded) closeBody();
          },
          pull() {
            resumeStdout();
          },
          cancel() {
            cleanupAbort();
            bodyClosed = true;
            if (!child.killed) child.kill();
          }
        });
        responseResolved = true;
        resolveResponse(
          new Response(body, {
            status: header.status,
            statusText: header.statusText ?? "",
            headers: new Headers(header.headers ?? [])
          })
        );
        return;
      }

      enqueueBodyChunk(chunk);
    });

    child.stdout.on("end", () => {
      stdoutEnded = true;
      closeBody();
    });

    child.on("close", (code, processSignal) => {
      cleanupAbort();
      if (code === 0) {
        if (responseResolved) closeBody();
        return;
      }

      const detail = rustReqwestExitDetail(stderrBuffer, responseResolved ? Buffer.alloc(0) : headerBuffer);
      const reason = `Rust reqwest transport exited with ${processSignal ?? `code ${code ?? "unknown"}`}${detail ? `: ${detail}` : ""}`;
      const error = new Error(reason);
      if (responseResolved) errorBody(error);
      else rejectResponse(error);
    });

    const payload: RustReqwestRequest = {
      method: request.method,
      url,
      headers: Object.entries(request.headers),
      body: request.body,
      timeoutMs: request.timeoutMs,
      streamBody: true
    };
    child.stdin.end(JSON.stringify(payload), "utf8");
  });
}

function rustReqwestExitDetail(stderrBuffer: Buffer, stdoutBuffer: Buffer): string {
  const stderr = stderrBuffer.toString("utf8").trim();
  if (stderr) return stderr;
  const stdout = stdoutBuffer.toString("utf8").trim();
  if (!stdout) return "";
  const parsed = parseRustReqwestErrorResponse(stdout);
  return parsed ?? trimRustReqwestExitOutput(stdout);
}

function parseRustReqwestErrorResponse(text: string): string | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const error = (value as { error?: unknown }).error;
    return typeof error === "string" && error.trim() ? error.trim() : undefined;
  } catch {
    return undefined;
  }
}

function trimRustReqwestExitOutput(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 500)}...`;
}

async function fetchWithOptionalRustReqwestOverride(
  url: string,
  request: ProviderHttpRequest,
  signal: AbortSignal,
  options: {
    rustReqwestFetch?: typeof fetch;
    rustReqwestCommand?: string;
    rustReqwestArgs?: string[];
    rustReqwestCwd?: string;
  }
): Promise<Response> {
  if (options.rustReqwestFetch) {
    return fetchWithTimeout(options.rustReqwestFetch, url, request, signal);
  }
  return fetchWithRustReqwestProcess(url, request, signal, {
    command: options.rustReqwestCommand ?? readEnv("AGENT_PROVIDER_HTTP_COMMAND") ?? "cargo",
    args: options.rustReqwestArgs ?? (readEnv("AGENT_PROVIDER_HTTP_COMMAND") ? ["--stdio"] : ["run", "-p", "agent-provider-http", "--quiet", "--", "--stdio"]),
    cwd: options.rustReqwestCwd ?? readEnv("AGENT_PROVIDER_HTTP_CWD") ?? defaultWorkspaceRoot()
  });
}

interface ProviderErrorClassification {
  kind: ProviderErrorKind;
  retryable: boolean;
}

/**
 * 基于错误消息字符串分类 provider 错误。
 * 供 session-loop 等上层使用，避免在多处重复正则判定瞬时错误。
 * 完整分类（带 Response 对象）仍用 classifyHttpProviderError。
 */
export function classifyProviderErrorMessage(message: string): ProviderErrorClassification {
  const m = message.toLowerCase();
  // 用户取消：不可重试（优先判定，避免被网络分类吞掉）
  if (/aborted|cancelled|canceled/.test(m)) return { kind: "cancelled", retryable: false };
  // 认证 / 配额：不可重试
  if (/401|403|unauthor|forbidden/.test(m)) return { kind: "auth", retryable: false };
  if (/402|insufficient[_\s-]*(quota|balance|credit)|余额不足|额度不足/.test(m)) return { kind: "quota", retryable: false };
  // 速率限制：可重试
  if (/429|rate.?limit/.test(m)) return { kind: "rate-limit", retryable: true };
  // 网关 / 服务端错误：可重试
  if (/\b502\b|\b503\b|\b504\b|\b520\b|\b522\b|\b523\b|\b524\b|bad gateway|gateway timeout|server error|overloaded|temporarily unavailable/.test(m)) {
    return { kind: "server", retryable: true };
  }
  // 超时：可重试
  if (/timeout|timed out/.test(m)) return { kind: "timeout", retryable: true };
  // 网络错误：可重试
  if (/econnreset|enotfound|fetch failed|network|socket/.test(m)) {
    return { kind: "network", retryable: true };
  }
  // Schema / 参数：不可重试
  if (/400|422|schema|invalid|bad request/.test(m)) return { kind: "schema", retryable: false };
  return { kind: "unknown", retryable: false };
}

function classifyTransportProviderError(reason: string): ProviderErrorClassification {
  if (/aborted|abort|cancelled|canceled/i.test(reason)) return { kind: "cancelled", retryable: false };
  return { kind: "network", retryable: true };
}

function classifyStreamProviderError(reason: string, cause: unknown): ProviderErrorClassification {
  const code = cause instanceof Error ? cause.name : "";
  if (/aborted|abort|cancelled|canceled/i.test(`${reason} ${code}`)) {
    return { kind: "cancelled", retryable: false };
  }
  if (/timeout|timed out/i.test(`${reason} ${code}`)) {
    return { kind: "timeout", retryable: true };
  }
  if (/invalid|json|parse|terminal response event|event-stream|sse/i.test(reason)) {
    return { kind: "invalid-stream", retryable: false };
  }
  return { kind: "network", retryable: true };
}

function classifyHttpProviderError(response: Response, error: string): ProviderErrorClassification {
  if (looksLikeGatewayChallenge(response, error)) return { kind: "gateway-challenge", retryable: false };
  if (response.status === 429) return { kind: "rate-limit", retryable: true };
  if (response.status === 402 || /insufficient[_\s-]*(quota|balance|credit)|余额不足|额度不足/i.test(error)) {
    return { kind: "quota", retryable: false };
  }
  if (response.status === 401 || response.status === 403) return { kind: "auth", retryable: false };
  if (isResponsesEndpointUnavailable(response.status, error)) return { kind: "endpoint-unavailable", retryable: false };
  if (response.status === 400 || response.status === 422) return { kind: "schema", retryable: false };
  if (isRetryableServerStatus(response.status)) return { kind: "server", retryable: true };
  return { kind: "unknown", retryable: false };
}

function isRetryableServerStatus(status: number): boolean {
  return status === 500 || status === 502 || status === 503 || status === 504 || status === 520 || status === 522 || status === 523 || status === 524;
}

function isResponsesEndpointUnavailable(status: number, error: string): boolean {
  if (status === 404 || status === 405 || status === 415) return true;
  if (status === 400 || status === 422) {
    return /\bresponses?\b/i.test(error) && /\b(unknown|unsupported|invalid|not found|not_found)\b/i.test(error);
  }
  return false;
}

function isSystemRoleUnsupported(status: number, error: string): boolean {
  if (status < 400 || status >= 500) return false;
  return /system\s+messages?\s+are\s+not\s+allowed|system\s+role\s+(is\s+)?(not\s+)?(allowed|supported)|role[^"'`]*system[^"'`]*(not\s+allowed|unsupported|invalid)/i.test(
    error
  );
}

function hasSystemRoleWireContent(request: AgentProviderRequest): boolean {
  return Boolean(request.systemPrompt?.trim()) || request.messages.some((message) => message.role === "system" && textContent(message).trim().length > 0);
}

function requestDiagnosticFields(
  request: AgentProviderRequest,
  wireMode: SystemPromptWireMode,
  streamRequested: boolean
): Pick<
  ProviderDiagnostic,
  | "streamRequested"
  | "systemPromptWireMode"
  | "hasSystemRole"
  | "systemPromptPresent"
  | "systemMessageCount"
  | "rewrittenSystemMessageCount"
  | "messageCount"
  | "toolCount"
  | "messageRoleCounts"
> {
  const roleCounts = {
    system: 0,
    user: 0,
    assistant: 0,
    tool: 0
  };
  let systemMessageCount = request.systemPrompt?.trim() ? 1 : 0;
  for (const message of request.messages) {
    roleCounts[message.role] += 1;
    if (message.role === "system" && textContent(message).trim().length > 0) {
      systemMessageCount += 1;
    }
  }

  return compactObject({
    streamRequested,
    systemPromptWireMode: wireMode,
    hasSystemRole: systemMessageCount > 0,
    systemPromptPresent: Boolean(request.systemPrompt?.trim()),
    systemMessageCount,
    rewrittenSystemMessageCount: wireMode === "user-prefix" ? systemMessageCount : 0,
    messageCount: request.messages.length,
    toolCount: request.tools.length,
    messageRoleCounts: roleCounts
  }) as Pick<
    ProviderDiagnostic,
    | "streamRequested"
    | "systemPromptWireMode"
    | "hasSystemRole"
    | "systemPromptPresent"
    | "systemMessageCount"
    | "rewrittenSystemMessageCount"
    | "messageCount"
    | "toolCount"
    | "messageRoleCounts"
  >;
}

function looksLikeGatewayChallenge(response: Response, error: string): boolean {
  const mitigated = response.headers.get("cf-mitigated") ?? "";
  const server = response.headers.get("server") ?? "";
  return (
    /challenge/i.test(mitigated) ||
    (/cloudflare/i.test(server) && /challenge|just a moment|cf_chl|challenge-platform|enable javascript/i.test(error)) ||
    /cf_chl|challenge-platform|just a moment|enable javascript and cookies/i.test(error)
  );
}

function formatProviderError(error: string, kind: ProviderErrorKind): string {
  return `[${kind}] ${error}`;
}

function trimDiagnosticReason(reason: string): string {
  const normalized = reason.replace(/\s+/g, " ").trim();
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 500)}...`;
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}

function optionalEndpoint(value: unknown, label: string): OpenAICompatibleEndpoint | undefined {
  if (value === undefined) return undefined;
  const normalized = requiredString(value, label).toLowerCase().replace(/_/g, "-").replace(/\//g, "-");
  if (normalized === "auto") return "auto";
  if (normalized === "chat" || normalized === "chat-completions") return "chat-completions";
  if (normalized === "response" || normalized === "responses") return "responses";
  throw new Error(`${label} must be "auto", "chat-completions", or "responses"`);
}

function optionalTransport(value: unknown, label: string): OpenAICompatibleTransport | undefined {
  if (value === undefined) return undefined;
  const normalized = requiredString(value, label).toLowerCase().replace(/_/g, "-");
  if (normalized === "fetch" || normalized === "rust-reqwest" || normalized === "auto") return normalized;
  throw new Error(`${label} must be "fetch", "rust-reqwest", or "auto"`);
}

function optionalSystemPromptWireMode(value: unknown, label: string): SystemPromptWireMode | undefined {
  if (value === undefined) return undefined;
  const normalized = requiredString(value, label).toLowerCase().replace(/_/g, "-").replace(/\//g, "-");
  if (normalized === "native" || normalized === "native-system-role" || normalized === "system") return "native-system-role";
  if (normalized === "user-prefix" || normalized === "user" || normalized === "prefix") return "user-prefix";
  throw new Error(`${label} must be "native-system-role" or "user-prefix"`);
}

function optionalAuthHeader(value: unknown, label: string): OpenAICompatibleAuthHeader | undefined {
  if (value === undefined) return undefined;
  const normalized = requiredString(value, label).toLowerCase();
  if (normalized === "authorization" || normalized === "api-key" || normalized === "x-api-key" || normalized === "none") {
    return normalized;
  }
  throw new Error(`${label} must be "authorization", "api-key", "x-api-key", or "none"`);
}

function optionalMaxTokensField(value: unknown, label: string): OpenAICompatibleMaxTokensField | undefined {
  if (value === undefined) return undefined;
  const normalized = requiredString(value, label).toLowerCase();
  if (normalized === "max_tokens" || normalized === "max_completion_tokens" || normalized === "max_output_tokens") {
    return normalized;
  }
  throw new Error(`${label} must be "max_tokens", "max_completion_tokens", or "max_output_tokens"`);
}

function optionalReasoningContentMode(value: unknown, label: string): OpenAICompatibleReasoningContentMode | undefined {
  if (value === undefined) return undefined;
  const normalized = requiredString(value, label).toLowerCase();
  if (normalized === "omit" || normalized === "include" || normalized === "require") return normalized;
  throw new Error(`${label} must be "omit", "include", or "require"`);
}

function optionalReasoningEffort(value: unknown, label: string): OpenAICompatibleReasoningEffort | undefined {
  if (value === undefined) return undefined;
  const normalized = requiredString(value, label).toLowerCase();
  if (
    normalized === "off" ||
    normalized === "auto" ||
    normalized === "minimal" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "xhigh"
  ) {
    return normalized;
  }
  throw new Error(`${label} must be "off", "auto", "minimal", "low", "medium", "high", or "xhigh"`);
}

function optionalReasoningEffortFormat(value: unknown, label: string): OpenAICompatibleReasoningEffortFormat | undefined {
  if (value === undefined) return undefined;
  const normalized = requiredString(value, label).toLowerCase().replace(/_/g, "-");
  if (normalized === "auto" || normalized === "responses" || normalized === "chat-completions" || normalized === "none") return normalized;
  throw new Error(`${label} must be "auto", "responses", "chat-completions", or "none"`);
}

function optionalToolChoice(value: unknown, label: string): OpenAICompatibleToolChoice | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (normalized === "auto" || normalized === "none" || normalized === "required") return normalized;
    throw new Error(`${label} must be "auto", "none", "required", or a function choice object`);
  }

  const record = objectRecord(value, label);
  if (record.type !== "function") {
    throw new Error(`${label}.type must be "function"`);
  }
  const functionRecord = record.function === undefined ? undefined : objectRecord(record.function, `${label}.function`);
  const name = optionalString(record.name, `${label}.name`) ?? optionalString(functionRecord?.name, `${label}.function.name`);
  if (!name) throw new Error(`${label} function choice requires a name`);
  return { type: "function", name };
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  const number = optionalNumber(value, label);
  if (number === undefined) return undefined;
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer`);
  return number;
}

function optionalStringRecord(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const record = objectRecord(value, label);
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => {
      if (typeof item !== "string") throw new Error(`${label}.${key} must be a string`);
      return [key, item];
    })
  );
}

function optionalDiagnostics(value: unknown, label: string): boolean | OpenAICompatibleDiagnosticsOptions | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  const record = objectRecord(value, label);
  return compactObject({
    enabled: optionalBoolean(record.enabled, `${label}.enabled`),
    headers: optionalStringArray(record.headers, `${label}.headers`)
  }) as unknown as OpenAICompatibleDiagnosticsOptions;
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => requiredString(item, `${label}[${index}]`));
}

function optionalRetryOptions(value: unknown, label: string): OpenAICompatibleRetryOptions | undefined {
  if (value === undefined) return undefined;
  const record = objectRecord(value, label);
  return compactObject({
    maxAttempts: optionalPositiveInteger(record.maxAttempts, `${label}.maxAttempts`),
    initialDelayMs: optionalPositiveInteger(record.initialDelayMs, `${label}.initialDelayMs`),
    maxDelayMs: optionalPositiveInteger(record.maxDelayMs, `${label}.maxDelayMs`),
    totalBudgetMs: optionalPositiveInteger(record.totalBudgetMs, `${label}.totalBudgetMs`),
    jitterRatio: optionalNumber(record.jitterRatio, `${label}.jitterRatio`)
  }) as unknown as OpenAICompatibleRetryOptions;
}

function readEnv(name: string): string | undefined {
  const processLike = globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } };
  return processLike.process?.env?.[name];
}

function readEnvFrom(env: Record<string, string | undefined> | undefined, name: string): string | undefined {
  return env?.[name] ?? readEnv(name);
}

function readSecretFileSync(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, "utf8").trim();
  } catch {
    return undefined;
  }
}

/**
 * 按 provider 生命周期内不变的优先级解析 apiKey：
 * options.apiKey → apiKeyEnv → apiKeyFile → CRISH_API_KEY → FLOWBIT_API_KEY → OPENAI_API_KEY。
 * apiKeyFile 保持原有同步读取语义（构造函数里同步完成，不引入异步）。
 */
function resolveApiKey(options: OpenAICompatibleProviderOptions): string | undefined {
  return (
    options.apiKey ??
    (options.apiKeyEnv ? readEnv(options.apiKeyEnv) : undefined) ??
    (options.apiKeyFile ? readSecretFileSync(options.apiKeyFile) : undefined) ??
    readEnv("CRISH_API_KEY") ??
    readEnv("FLOWBIT_API_KEY") ??
    readEnv("OPENAI_API_KEY")
  );
}

/**
 * 在构造时一次性冻结请求 headers（content-type / accept / auth / 自定义 headers）。
 * 之后所有请求复用同一份 headers 对象，避免每次请求重新解析。
 */
function freezeHeaders(options: OpenAICompatibleProviderOptions, apiKey: string | undefined): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: options.stream === false ? "application/json" : "text/event-stream",
    ...authHeaderObject(options.authHeader ?? "authorization", apiKey),
    ...options.headers
  };
}

function defaultWorkspaceRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function recordField(value: unknown, key: string | undefined): Record<string, unknown> | undefined {
  const candidate = key === undefined ? value : value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  return candidate && typeof candidate === "object" && !Array.isArray(candidate) ? (candidate as Record<string, unknown>) : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
