/**
 * OpenAI 兼容 SSE / chunk 解析纯工具。
 * 从 provider-openai-compatible.ts 拆出：读流、分帧、解析 data: JSON。
 */

import type { JsonObject, ProviderDiagnostic } from "@crish/shared-types";
import type { ResolvedOpenAICompatibleEndpoint } from "./openai-request-build";

/** SSE 读取诊断选项 */
export interface SseDiagnosticsOptions {
  enabled: boolean;
  providerId: string;
  endpoint: ResolvedOpenAICompatibleEndpoint;
  url: string;
  attempt: number;
  maxAttempts: number;
  configuredModel?: string;
  firstByteTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
}

/** 流内夹带的诊断事件标记 */
export interface SseReadDiagnostic {
  __kind: "diagnostic";
  diagnostic: ProviderDiagnostic;
}

/** 从 ReadableStream 按 SSE 帧产出 JSON 或诊断事件 */
export async function* readSseJson(
  body: ReadableStream<Uint8Array>,
  diagnostics?: SseDiagnosticsOptions,
  signal?: AbortSignal
): AsyncIterable<JsonObject | SseReadDiagnostic> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const startedAt = Date.now();
  let chunks = 0;
  let bytes = 0;
  let emittedFirstByte = false;
  let completed = false;

  let cancelledError: Error | undefined;

  // 1. 单次绑定 Abort 监听器，取消 reader 并抛出异常
  const abortHandler = () => {
    const error = createSseAbortError(signal);
    cancelledError = error;
    reader.cancel(error).catch(() => undefined);
  };
  if (signal) {
    if (signal.aborted) {
      reader.releaseLock();
      throw createSseAbortError(signal);
    }
    signal.addEventListener("abort", abortHandler, { once: true });
  }

  // 2. 超时控制单例化
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const resetTimeout = (ms: number | undefined, label: string) => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
    const effective = normalizeStreamTimeoutMs(ms);
    if (effective === undefined) return;
    timeoutId = setTimeout(() => {
      const err = new Error(`${label} timed out after ${effective}ms`);
      cancelledError = err;
      reader.cancel(err).catch(() => undefined);
    }, effective);
  };

  try {
    while (true) {
      // 动态更新超时检测
      resetTimeout(
        emittedFirstByte ? diagnostics?.streamIdleTimeoutMs : diagnostics?.firstByteTimeoutMs,
        emittedFirstByte ? "stream idle" : "streaming first byte"
      );

      const { done, value } = await reader.read();

      // 读取成功，立即取消当前超时定时器
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }

      if (cancelledError) {
        throw cancelledError;
      }

      if (done) {
        completed = true;
        break;
      }
      chunks += 1;
      bytes += value.byteLength;
      if (!emittedFirstByte) {
        emittedFirstByte = true;
        if (diagnostics?.enabled) {
          yield {
            __kind: "diagnostic",
            diagnostic: {
              phase: "sse-first-byte",
              providerId: diagnostics.providerId,
              endpoint: diagnostics.endpoint,
              url: diagnostics.url,
              attempt: diagnostics.attempt,
              maxAttempts: diagnostics.maxAttempts,
              elapsedMs: Date.now() - startedAt,
              chunks,
              bytes
            }
          };
        }
      }
      buffer += decoder.decode(value, { stream: true });

      let separatorIndex = findSseSeparator(buffer);
      while (separatorIndex !== -1) {
        const sepLen = sseSeparatorLength(buffer, separatorIndex) || 2;
        const frame = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + sepLen);
        const parsed = parseSseFrame(frame);
        if (parsed === "[DONE]") {
          completed = true;
          yield* sseStreamEndDiagnostic(diagnostics, startedAt, chunks, bytes);
          return;
        }
        if (parsed) yield parsed;
        separatorIndex = findSseSeparator(buffer);
      }
    }
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    if (signal) {
      signal.removeEventListener("abort", abortHandler);
    }
    if (!completed) {
      await reader.cancel(createSseAbortError(signal)).catch(() => undefined);
    }
    reader.releaseLock();
  }

  if (buffer.trim().length > 0) {
    const parsed = parseSseFrame(buffer);
    if (parsed && parsed !== "[DONE]") {
      yield parsed;
    }
  }
  completed = true;
  yield* sseStreamEndDiagnostic(diagnostics, startedAt, chunks, bytes);
}

function* sseStreamEndDiagnostic(
  diagnostics: SseDiagnosticsOptions | undefined,
  startedAt: number,
  chunks: number,
  bytes: number
): Iterable<SseReadDiagnostic> {
  if (!diagnostics?.enabled) return;
  yield {
    __kind: "diagnostic",
    diagnostic: {
      phase: "stream-end",
      providerId: diagnostics.providerId,
      endpoint: diagnostics.endpoint,
      url: diagnostics.url,
      attempt: diagnostics.attempt,
      maxAttempts: diagnostics.maxAttempts,
      elapsedMs: Date.now() - startedAt,
      chunks,
      bytes
    }
  };
}

/**
 * Normalize timeout: non-finite / ≤0 → undefined (no timeout).
 * Avoids setTimeout(0) races and Infinity hangs.
 */
export function normalizeStreamTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined || timeoutMs === null) return undefined;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined;
  return Math.floor(timeoutMs);
}

/** 带 first-byte / idle 超时与 abort 的 read (仅用作备用) */
export function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number | undefined,
  timeoutLabel: string,
  signal?: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal?.aborted) {
    const error = createSseAbortError(signal);
    void reader.cancel(error);
    return Promise.reject(error);
  }
  const effectiveTimeout = normalizeStreamTimeoutMs(timeoutMs);
  if (!effectiveTimeout && !signal) return reader.read();
  return new Promise((resolveRead, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abortFromSignal: (() => void) | undefined;
    const cleanup = (): void => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (abortFromSignal) signal?.removeEventListener("abort", abortFromSignal);
    };
    const rejectAfterCancel = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      void reader.cancel(error).finally(() => reject(error));
    };
    abortFromSignal = (): void => {
      rejectAfterCancel(createSseAbortError(signal));
    };
    if (effectiveTimeout !== undefined) {
      timeout = setTimeout(() => {
        rejectAfterCancel(
          new Error(`${timeoutLabel} timed out after ${effectiveTimeout}ms`)
        );
      }, effectiveTimeout);
    }
    signal?.addEventListener("abort", abortFromSignal, { once: true });
    if (signal?.aborted) {
      abortFromSignal();
      return;
    }
    reader.read().then(
      (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolveRead(result);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }
    );
  });
}

export function createSseAbortError(signal: AbortSignal | undefined): Error {
  const reason = signal?.aborted ? signal.reason : undefined;
  if (reason instanceof Error) return reason;
  if (typeof reason === "string" && reason.length > 0) return new Error(reason);
  return new Error(signal?.aborted ? "aborted" : "stream consumer cancelled");
}

export function isSseReadDiagnostic(value: JsonObject | SseReadDiagnostic): value is SseReadDiagnostic {
  return (value as SseReadDiagnostic).__kind === "diagnostic";
}

/**
 * 定位 SSE 帧分隔符（\n\n 或 \r\n\r\n）。
 * 注意：`\r\n\n` 会被 lf 命中在 index+1 处；slice 时仍用 2 字节会吃掉半帧，
 * 这里优先返回真正的 CRLF 四字节边界（若两者重叠取更早且合法的）。
 */
export function findSseSeparator(input: string): number {
  const lf = input.indexOf("\n\n");
  const crlf = input.indexOf("\r\n\r\n");
  if (lf === -1) return crlf;
  if (crlf === -1) {
    // lf hit at i may be the trailing `\n\n` of `\r\n\n` — prefer treating as 2-byte sep only
    // when not preceded by bare `\r` that would leave a dangling CR on the next frame.
    return lf;
  }
  return Math.min(lf, crlf);
}

/** Frame separator byte length at `index` (from findSseSeparator). */
export function sseSeparatorLength(input: string, index: number): number {
  if (index < 0 || index >= input.length) return 0;
  if (input.startsWith("\r\n\r\n", index)) return 4;
  if (input.startsWith("\n\n", index)) return 2;
  return 0;
}

/** SSE data 行看起来像 JSON 对象/数组，但 parse 失败（流损坏，非 keep-alive） */
export class MalformedSseFrameError extends Error {
  readonly raw: string;

  constructor(raw: string) {
    const preview = raw.length > 160 ? `${raw.slice(0, 160)}…` : raw;
    super(`Malformed SSE JSON data frame: ${preview}`);
    this.name = "MalformedSseFrameError";
    this.raw = raw;
  }
}

/**
 * 解析单帧：聚合 data: 行；[DONE] 为结束哨兵。
 * - 非 JSON keep-alive / 注释：返回 null（不炸流）
 * - 看起来像 JSON（`{` / `[`）但 parse 失败：抛 MalformedSseFrameError（invalid-stream）
 * - 合法 JSON 但非 object（string/array/null）：返回 null
 */
export function parseSseFrame(frame: string): JsonObject | "[DONE]" | null {
  const data = frame
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("\n");
  if (!data) return null;
  if (data === "[DONE]") return "[DONE]";

  const looksLikeJson = data.startsWith("{") || data.startsWith("[");
  try {
    const parsed = JSON.parse(data) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as JsonObject;
  } catch {
    if (looksLikeJson) {
      // Corrupted JSON payload mid-stream — surface as typed invalid-stream upstream.
      throw new MalformedSseFrameError(data);
    }
    // Providers occasionally emit keep-alive / non-JSON data: lines; skip frame.
    return null;
  }
}
