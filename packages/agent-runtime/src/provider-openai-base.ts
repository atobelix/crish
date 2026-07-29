/**
 * @deprecated 旧版 OpenAI Provider 基类，部分功能已迁移至引擎体系
 * @see OpenAICompatibleEngine @removeWhen provider-openai-chat.ts / provider-openai-responses.ts 等消费者迁移完成后
 */
import { Buffer } from "node:buffer";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { errorMessage } from "@crish/shared-utils";
import type { ProviderErrorKind } from "@crish/shared-types";
import { ProviderError } from "@crish/shared-types";
import type { AgentProviderRequest } from "./types";
import {
  type OpenAICompatibleAuthHeader,
  type OpenAICompatibleMaxTokensField,
  type OpenAICompatibleReasoningContentMode,
  type OpenAICompatibleReasoningEffort,
  type OpenAICompatibleReasoningEffortFormat,
  type OpenAICompatibleToolChoice,
  type ResolvedOpenAICompatibleEndpoint,
  type SystemPromptWireMode
} from "./openai-request-build";
import { authHeaderObject } from "./openai-request-build";
import { type OpenAICompatibleRetryOptions } from "./openai-retry";
import { type ProviderCacheHintPlan } from "./provider-cache-hints";

// ── Re-export public types for backward compatibility ──
export type { OpenAICompatibleRetryOptions } from "./openai-retry";
export type {
  OpenAICompatibleAuthHeader, OpenAICompatibleMaxTokensField,
  OpenAICompatibleReasoningContentMode, OpenAICompatibleReasoningEffort,
  OpenAICompatibleReasoningEffortFormat, OpenAICompatibleToolChoice, SystemPromptWireMode
} from "./openai-request-build";

// ── Public option / config types ──

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
  paths?: { chatCompletions?: string; responses?: string };
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

export interface OpenAICompatibleModel {
  id: string;
  object?: string;
  created?: number;
  ownedBy?: string;
}

// ── Internal types ──

/** 请求构建上下文*/
export interface RequestBuildContext {
  request: AgentProviderRequest;
  endpoint: ResolvedOpenAICompatibleEndpoint;
  wireMode: SystemPromptWireMode;
  cacheHintPlan?: ProviderCacheHintPlan;
  attempt: number;
}

interface ProviderHttpRequest {
  method: "POST" | "GET";
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
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
  bodyLength?: number;
  chunked?: boolean;
}

interface UndiciAgentOptions {
  keepAliveTimeout?: number;
  keepAliveMaxTimeout?: number;
  connections?: number;
}

interface UndiciModule {
  Agent: new (options: UndiciAgentOptions) => unknown;
  fetch: typeof fetch;
}

// ── Fetch infrastructure ──

let cachedDefaultFetch: typeof fetch | undefined;
let defaultFetchInitialized = false;
const originalGlobalFetch: typeof fetch | undefined = globalThis.fetch;

export function defaultKeepAliveFetch(): typeof fetch | undefined {
  if (defaultFetchInitialized) return cachedDefaultFetch;
  defaultFetchInitialized = true;
  let undiciAgent: unknown | undefined;
  let undiciFetch: typeof fetch | undefined;
  try {
    const require = createRequire(import.meta.url);
    const undici = require("undici") as UndiciModule;
    undiciAgent = new undici.Agent({ keepAliveTimeout: 30_000, keepAliveMaxTimeout: 60_000 });
    undiciFetch = undici.fetch;
  } catch { /* undici not available */ }
  cachedDefaultFetch = (((input: RequestInfo | URL, init?: RequestInit) => {
    const globalFetch = globalThis.fetch;
    if (globalFetch !== originalGlobalFetch) return globalFetch(input, init);
    if (undiciFetch && undiciAgent) return undiciFetch(input, { ...init, dispatcher: undiciAgent } as RequestInit);
    return globalFetch(input, init);
  }) as unknown) as typeof fetch;
  return cachedDefaultFetch;
}

// ── Rust reqwest daemon client ──

interface RustReqwestDaemon {
  child: ChildProcess;
  busy: boolean;
  queue: Array<() => void>;
  reader: ((chunk: Buffer) => void) | null;
  stderrBuffer: Buffer;
  deadError: string | null;
}

const rustReqwestDaemons = new Map<string, RustReqwestDaemon>();

function daemonKey(options: RustReqwestProcessOptions): string {
  return JSON.stringify([options.command, options.args, options.cwd ?? null]);
}

function isDaemonCapable(options: RustReqwestProcessOptions): boolean {
  return options.args.includes("--stdio");
}

function spawnRustReqwestDaemon(options: RustReqwestProcessOptions): RustReqwestDaemon {
  const child = spawn(options.command, options.args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const daemon: RustReqwestDaemon = { child, busy: false, queue: [], reader: null, stderrBuffer: Buffer.alloc(0), deadError: null };
  child.stderr.on("data", (chunk: Buffer) => { daemon.stderrBuffer = Buffer.concat([daemon.stderrBuffer, chunk]).subarray(0, 16_000); });
  child.stdout.on("data", (chunk: Buffer) => { const reader = daemon.reader; if (reader) reader(chunk); });
  child.on("error", (cause) => { daemon.deadError = daemon.deadError ?? (cause instanceof Error ? cause.message : String(cause)); const reader = daemon.reader; if (reader) reader(Buffer.alloc(0)); });
  child.on("exit", (_code, processSignal) => {
    daemon.deadError = daemon.deadError ?? `Rust reqwest daemon exited with ${processSignal ?? `code ${_code ?? "unknown"}`}`;
    const reader = daemon.reader; if (reader) reader(Buffer.alloc(0));
    rustReqwestDaemons.delete(daemonKey(options));
  });
  return daemon;
}

function getOrCreateRustReqwestDaemon(options: RustReqwestProcessOptions): RustReqwestDaemon {
  const key = daemonKey(options);
  const existing = rustReqwestDaemons.get(key);
  if (existing && !existing.child.killed && !existing.deadError) return existing;
  rustReqwestDaemons.delete(key);
  const daemon = spawnRustReqwestDaemon(options);
  rustReqwestDaemons.set(key, daemon);
  return daemon;
}

function acquireRustReqwestDaemon(daemon: RustReqwestDaemon): Promise<void> {
  if (!daemon.busy) { daemon.busy = true; return Promise.resolve(); }
  return new Promise<void>((resolve) => { daemon.queue.push(() => { daemon.busy = true; resolve(); }); });
}

function releaseRustReqwestDaemon(daemon: RustReqwestDaemon): void {
  daemon.busy = false;
  const next = daemon.queue.shift();
  if (next) next();
}

async function fetchWithRustReqwestDaemon(daemon: RustReqwestDaemon, url: string, request: ProviderHttpRequest, signal: AbortSignal): Promise<Response> {
  if (daemon.deadError) throw new ProviderError(daemon.deadError, "DAEMON_DEAD", false);
  await acquireRustReqwestDaemon(daemon);
  if (daemon.deadError) { releaseRustReqwestDaemon(daemon); throw new ProviderError(daemon.deadError, "DAEMON_DEAD", false); }
  try { return await sendRustReqwestDaemonRequest(daemon, url, request, signal); }
  finally { releaseRustReqwestDaemon(daemon); }
}

function sendRustReqwestDaemonRequest(daemon: RustReqwestDaemon, url: string, request: ProviderHttpRequest, signal: AbortSignal): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    if (daemon.deadError) { reject(new Error(daemon.deadError)); return; }
    const payload: RustReqwestRequest = {
      method: request.method, url, headers: Object.entries(request.headers),
      ...(request.body !== undefined ? { body: request.body } : {}),
      ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
      streamBody: true
    };
    let buffer = Buffer.alloc(0);
    let headerParsed = false;
    let header: RustReqwestResponseHeader | null = null;
    let responseResolved = false;
    let streamDone = false;
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let bodyClosed = false;
    let stdoutPaused = false;
    let parseState: "length" | "body" | "error" = "length";
    let expectedBodyBytes = 0;
    let remaining = 0;

    const killDaemon = (): void => { if (!daemon.child.killed) try { daemon.child.kill(); } catch { /* silent: 进程已退出*/ } };
    const cleanup = (): void => { signal.removeEventListener("abort", onAbort); daemon.reader = null; };
    const pauseStdout = (): void => { if (!stdoutPaused && daemon.child.stdout) { daemon.child.stdout.pause(); stdoutPaused = true; } };
    const resumeStdout = (): void => { if (stdoutPaused && daemon.child.stdout && !bodyClosed) { daemon.child.stdout.resume(); stdoutPaused = false; } };
    const enqueueBodyChunk = (chunk: Buffer | Uint8Array): void => { if (bodyController && !bodyClosed && chunk.byteLength > 0) { bodyController.enqueue(new Uint8Array(chunk)); if ((bodyController.desiredSize ?? 1) <= 0) pauseStdout(); } };
    const closeBody = (): void => { if (bodyController && !bodyClosed) { bodyClosed = true; bodyController.close(); } };
    const errorBody = (error: Error): void => { if (bodyController && !bodyClosed) { bodyClosed = true; bodyController.error(error); } };
    const failStream = (error: Error): void => { if (streamDone) return; streamDone = true; errorBody(error); cleanup(); };
    const onAbort = (): void => {
      const error = new Error("aborted");
      if (!responseResolved) { responseResolved = true; streamDone = true; cleanup(); killDaemon(); reject(error); }
      else if (!streamDone) { failStream(error); killDaemon(); }
    };

    const parseChunkFrames = (): void => {
      while (!streamDone) {
        if (parseState === "length") {
          const sep = buffer.indexOf(0x0a); if (sep === -1) return;
          const lenStr = buffer.subarray(0, sep).toString("utf8").trim(); buffer = buffer.subarray(sep + 1);
          const len = Number.parseInt(lenStr, 10);
          if (len === 0) { streamDone = true; closeBody(); cleanup(); return; }
          else if (len === -1) parseState = "error";
          else if (Number.isNaN(len) || len < 0) { streamDone = true; failStream(new Error(`Invalid chunk length from daemon: ${lenStr}`)); return; }
          else { parseState = "body"; expectedBodyBytes = len; }
        }
        if (parseState === "body") {
          if (buffer.length < expectedBodyBytes) return;
          enqueueBodyChunk(buffer.subarray(0, expectedBodyBytes));
          buffer = buffer.subarray(expectedBodyBytes);
          parseState = "length";
          if (stdoutPaused) return;
        }
        if (parseState === "error") {
          const sep = buffer.indexOf(0x0a); if (sep === -1) return;
          const errMsg = buffer.subarray(0, sep).toString("utf8"); buffer = buffer.subarray(sep + 1);
          streamDone = true; failStream(new Error(errMsg || "Response stream interrupted")); return;
        }
      }
    };

    signal.addEventListener("abort", onAbort, { once: true });
    daemon.reader = (chunk: Buffer) => {
      if (streamDone) return;
      if (daemon.deadError) { const error = new Error(daemon.deadError); if (!responseResolved) { responseResolved = true; streamDone = true; cleanup(); reject(error); } else if (!streamDone) failStream(error); return; }
      if (chunk.length > 0) buffer = Buffer.concat([buffer, chunk]);
      if (!headerParsed) {
        const sep = buffer.indexOf(0x0a); if (sep === -1) return;
        const headerBytes = buffer.subarray(0, sep); buffer = buffer.subarray(sep + 1);
        try { header = JSON.parse(headerBytes.toString("utf8")) as RustReqwestResponseHeader; } catch (cause) { responseResolved = true; streamDone = true; cleanup(); reject(new Error(`Rust reqwest daemon returned an invalid response header: ${errorMessage(cause)}`)); return; }
        headerParsed = true;
        if (header.error) { responseResolved = true; streamDone = true; cleanup(); reject(new Error(header.error)); return; }
        if (header.chunked) {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) { bodyController = controller; },
            pull() { resumeStdout(); parseChunkFrames(); },
            cancel() { streamDone = true; cleanup(); killDaemon(); }
          });
          responseResolved = true;
          resolve(new Response(stream, { status: header.status, statusText: header.statusText ?? "", headers: new Headers(header.headers ?? []) }));
        } else remaining = header.bodyLength ?? 0;
      }
      if (!headerParsed) return;
      const h = header as RustReqwestResponseHeader;
      if (h.chunked) parseChunkFrames();
      else if (buffer.length >= remaining) {
        responseResolved = true; streamDone = true; cleanup();
        resolve(new Response(remaining > 0 ? buffer.subarray(0, remaining) : Buffer.alloc(0), { status: h.status, statusText: h.statusText ?? "", headers: new Headers(h.headers ?? []) }));
      }
    };
    const stdin = daemon.child.stdin;
    if (!stdin) { responseResolved = true; streamDone = true; cleanup(); reject(new Error("Rust reqwest daemon stdin is not available")); return; }
    stdin.write(JSON.stringify(payload) + "\n", "utf8", (err) => { if (err && !responseResolved) { responseResolved = true; streamDone = true; cleanup(); reject(new Error(`Failed to write to Rust reqwest daemon stdin: ${errorMessage(err)}`)); } });
  });
}

function killAllRustReqwestDaemons(): void {
  for (const daemon of rustReqwestDaemons.values()) { if (!daemon.child.killed) try { daemon.child.kill(); } catch { /* silent: 清理阶段进程已退?*/ } }
  rustReqwestDaemons.clear();
}

process.on("exit", killAllRustReqwestDaemons);

// ── Public helpers ──

export async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, request: ProviderHttpRequest, signal: AbortSignal): Promise<Response> {
  if (!request.timeoutMs) return fetchImpl(url, { method: request.method, headers: request.headers, body: request.body ?? null, signal });
  const controller = new AbortController();
  const abortFromRequest = (): void => controller.abort(signal.reason);
  if (signal.aborted) abortFromRequest();
  else signal.addEventListener("abort", abortFromRequest, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error(`Provider request timed out after ${request.timeoutMs}ms`)), request.timeoutMs);
  try { return await fetchImpl(url, { method: request.method, headers: request.headers, body: request.body ?? null, signal: controller.signal }); }
  finally { clearTimeout(timeout); signal.removeEventListener("abort", abortFromRequest); }
}

async function fetchWithRustReqwestSingleShot(url: string, request: ProviderHttpRequest, signal: AbortSignal, options: RustReqwestProcessOptions): Promise<Response> {
  return new Promise<Response>((resolveResponse, rejectResponse) => {
    const child = spawn(options.command, options.args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let responseResolved = false, stdoutEnded = false, bodyClosed = false;
    let headerBuffer = Buffer.alloc(0), stderrBuffer = Buffer.alloc(0), stdoutPaused = false;
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;

    const cleanupAbort = (): void => { signal.removeEventListener("abort", abortFromRequest); };
    const failBeforeResponse = (error: Error): void => { cleanupAbort(); if (!child.killed) child.kill(); rejectResponse(error); };
    const errorBody = (error: Error): void => { cleanupAbort(); if (bodyController && !bodyClosed) { bodyClosed = true; bodyController.error(error); } };
    const closeBody = (): void => { if (bodyController && !bodyClosed) { bodyClosed = true; bodyController.close(); } };
    const pauseStdoutForBackpressure = (): void => { if (!stdoutPaused) { child.stdout.pause(); stdoutPaused = true; } };
    const resumeStdout = (): void => { if (stdoutPaused && !bodyClosed) { child.stdout.resume(); stdoutPaused = false; } };
    const enqueueBodyChunk = (chunk: Buffer | Uint8Array): void => { if (bodyController && !bodyClosed && chunk.byteLength > 0) { bodyController.enqueue(new Uint8Array(chunk)); if ((bodyController.desiredSize ?? 1) <= 0) pauseStdoutForBackpressure(); } };
    const abortFromRequest = (): void => { const error = new Error("aborted"); if (responseResolved) errorBody(error); else failBeforeResponse(error); };

    if (signal.aborted) { abortFromRequest(); return; }
    signal.addEventListener("abort", abortFromRequest, { once: true });
    child.stderr.on("data", (chunk: Buffer) => { stderrBuffer = Buffer.concat([stderrBuffer, chunk]).subarray(0, 16_000); });
    child.on("error", (cause) => { const error = cause instanceof Error ? cause : new Error(String(cause)); if (responseResolved) errorBody(error); else failBeforeResponse(error); });
    child.stdout.on("data", (chunk: Buffer) => {
      if (!responseResolved) {
        headerBuffer = Buffer.concat([headerBuffer, chunk]);
        const sep = headerBuffer.indexOf(0x0a); if (sep === -1) return;
        const headerBytes = headerBuffer.subarray(0, sep); const rest = headerBuffer.subarray(sep + 1);
        let header: RustReqwestResponseHeader;
        try { header = JSON.parse(headerBytes.toString("utf8")) as RustReqwestResponseHeader; } catch (cause) { failBeforeResponse(new Error(`Rust reqwest transport returned an invalid response header: ${errorMessage(cause)}`)); return; }
        if (header.error) { failBeforeResponse(new Error(header.error)); return; }
        const body = new ReadableStream<Uint8Array>({
          start(controller) { bodyController = controller; enqueueBodyChunk(rest); if (stdoutEnded) closeBody(); },
          pull() { resumeStdout(); },
          cancel() { cleanupAbort(); bodyClosed = true; if (!child.killed) child.kill(); }
        });
        responseResolved = true;
        resolveResponse(new Response(body, { status: header.status, statusText: header.statusText ?? "", headers: new Headers(header.headers ?? []) }));
      } else enqueueBodyChunk(chunk);
    });
    child.stdout.on("end", () => { stdoutEnded = true; closeBody(); });
    child.on("close", (code, processSignal) => {
      cleanupAbort();
      if (code === 0) { if (responseResolved) closeBody(); return; }
      const detail = rustReqwestExitDetail(stderrBuffer, responseResolved ? Buffer.alloc(0) : headerBuffer);
      const error = new Error(`Rust reqwest transport exited with ${processSignal ?? `code ${code ?? "unknown"}`}${detail ? `: ${detail}` : ""}`);
      if (responseResolved) errorBody(error); else rejectResponse(error);
    });
    child.stdin.end(JSON.stringify({ method: request.method, url, headers: Object.entries(request.headers), body: request.body, timeoutMs: request.timeoutMs, streamBody: true }), "utf8");
  });
}

function rustReqwestExitDetail(stderrBuffer: Buffer, stdoutBuffer: Buffer): string {
  const stderr = stderrBuffer.toString("utf8").trim();
  if (stderr) return stderr;
  const stdout = stdoutBuffer.toString("utf8").trim();
  if (!stdout) return "";
  return parseRustReqwestErrorResponse(stdout) ?? trimRustReqwestExitOutput(stdout);
}

function parseRustReqwestErrorResponse(text: string): string | undefined {
  try { const value = JSON.parse(text) as unknown; if (!value || typeof value !== "object" || Array.isArray(value)) return undefined; const error = (value as { error?: unknown }).error; return typeof error === "string" && error.trim() ? error.trim() : undefined; } catch { return undefined; }
}

function trimRustReqwestExitOutput(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 500)}...`;
}

export async function fetchWithRustReqwestProcess(url: string, request: ProviderHttpRequest, signal: AbortSignal, options: RustReqwestProcessOptions): Promise<Response> {
  if (isDaemonCapable(options)) return fetchWithRustReqwestDaemon(getOrCreateRustReqwestDaemon(options), url, request, signal);
  return fetchWithRustReqwestSingleShot(url, request, signal, options);
}

export async function fetchWithOptionalRustReqwestOverride(url: string, request: ProviderHttpRequest, signal: AbortSignal, options: { rustReqwestFetch?: typeof fetch; rustReqwestCommand?: string; rustReqwestArgs?: string[]; rustReqwestCwd?: string }): Promise<Response> {
  if (options.rustReqwestFetch) return fetchWithTimeout(options.rustReqwestFetch, url, request, signal);
  return fetchWithRustReqwestProcess(url, request, signal, {
    command: options.rustReqwestCommand ?? readEnv("AGENT_PROVIDER_HTTP_COMMAND") ?? "cargo",
    args: options.rustReqwestArgs ?? (readEnv("AGENT_PROVIDER_HTTP_COMMAND") ? ["--stdio"] : ["run", "-p", "agent-provider-http", "--quiet", "--", "--stdio"]),
    cwd: options.rustReqwestCwd ?? readEnv("AGENT_PROVIDER_HTTP_CWD") ?? defaultWorkspaceRoot()
  });
}

export function formatProviderError(error: string, kind: ProviderErrorKind): string { return `[${kind}] ${error}`; }

// ── Config parsing helpers ──

export function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProviderError(`${label} must be an object`, "CONFIG_ERROR", false);
  return value as Record<string, unknown>;
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new ProviderError(`${label} must be a non-empty string`, "CONFIG_ERROR", false);
  return value.trim();
}

export function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}

export function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new ProviderError(`${label} must be a boolean`, "CONFIG_ERROR", false);
  return value;
}

export function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ProviderError(`${label} must be a finite number`, "CONFIG_ERROR", false);
  return value;
}

export function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  const number = optionalNumber(value, label);
  if (number === undefined) return undefined;
  if (!Number.isInteger(number) || number <= 0) throw new ProviderError(`${label} must be a positive integer`, "CONFIG_ERROR", false);
  return number;
}

export function optionalStringRecord(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const record = objectRecord(value, label);
  return Object.fromEntries(Object.entries(record).map(([key, item]) => { if (typeof item !== "string") throw new ProviderError(`${label}.${key} must be a string`, "CONFIG_ERROR", false); return [key, item]; }));
}

export function optionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new ProviderError(`${label} must be an array`, "CONFIG_ERROR", false);
  return value.map((item, index) => requiredString(item, `${label}[${index}]`));
}

// ── Environment helpers ──

export function readEnv(name: string): string | undefined {
  const processLike = globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } };
  return processLike.process?.env?.[name];
}

export function readEnvFrom(env: Record<string, string | undefined> | undefined, name: string): string | undefined {
  return env?.[name] ?? readEnv(name);
}

export function readSecretFileSync(filePath: string): string | undefined {
  try { return readFileSync(filePath, "utf8").trim(); } catch { return undefined; }
}

export function resolveApiKey(options: OpenAICompatibleProviderOptions): string | undefined {
  return options.apiKey ?? (options.apiKeyEnv ? readEnv(options.apiKeyEnv) : undefined) ?? (options.apiKeyFile ? readSecretFileSync(options.apiKeyFile) : undefined) ?? readEnv("CRISH_API_KEY") ?? readEnv("FLOWBIT_API_KEY") ?? readEnv("OPENAI_API_KEY");
}

export function freezeHeaders(options: OpenAICompatibleProviderOptions, apiKey: string | undefined): Record<string, string> {
  return { "content-type": "application/json", accept: options.stream === false ? "application/json" : "text/event-stream", ...authHeaderObject(options.authHeader ?? "authorization", apiKey), ...options.headers };
}

export function defaultWorkspaceRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function recordField(value: unknown, key: string | undefined): Record<string, unknown> | undefined {
  const candidate = key === undefined ? value : value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  return candidate && typeof candidate === "object" && !Array.isArray(candidate) ? (candidate as Record<string, unknown>) : undefined;
}

export function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
