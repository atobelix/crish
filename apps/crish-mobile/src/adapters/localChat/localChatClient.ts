// 本地对话客户端（适配层）：手机直连供应商的传输与编排。
//
// 流式方案（查实结论）：仓内无任何 SSE/流式 fetch 先例；RN 的全局 fetch
// 为 whatwg-fetch（全文缓冲、无 ReadableStream body），且本机 expo 包无
// expo/fetch 导出——故流式走 XMLHttpRequest：RN 的 XHR 实现支持
// onprogress 增量读取 responseText（原生网络栈分块回调），配合
// domain/pure 的 SseFrameBuffer 分帧，是 RN 生态的通行 SSE 手法。
// 传输面以接口注入（StreamTransport / JsonFetch），jest 用假传输验链路；
// 非流式调用（模型列表 / 连通性自检）走普通 fetch（JSON 全文即可）。
import {
  SseFrameBuffer,
  applyChatChunk,
  buildChatCompletionsUrl,
  buildChatHeaders,
  buildChatRequestBody,
  buildJsonHeaders,
  buildModelsUrl,
  classifyHttpError,
  networkError,
  parseModelsList,
  streamInterruptedError,
  withErrorMessage,
  type LocalWireMessage,
} from '@/domain/pure/localChatProtocol';
import type {
  LocalChatError,
  LocalConnectivityResult,
} from '@/domain/types/localChat';

// ── 传输注入面 ──

export interface StreamRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface StreamHandlers {
  /** 新到达的响应文本块（增量，非全文） */
  onChunk: (text: string) => void;
  /** HTTP 错误（状态码 + 错误体全文；连接已结束） */
  onHttpError: (
    status: number,
    bodyText: string,
    retryAfterSec?: number
  ) => void;
  /** 2xx 正常结束 */
  onDone: () => void;
  /** 网络层失败（无响应） */
  onNetworkError: () => void;
}

export interface StreamHandle {
  abort: () => void;
}

export type StreamTransport = (
  req: StreamRequest,
  handlers: StreamHandlers
) => StreamHandle;

/** JSON 请求注入面（模型列表 / 自检）：返回状态码与文本，网络失败抛错 */
export type JsonFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }
) => Promise<{ status: number; text: string; retryAfterSec?: number }>;

/** 默认流式传输：XMLHttpRequest onprogress 增量读 */
export const xhrStreamTransport: StreamTransport = (req, handlers) => {
  const xhr = new XMLHttpRequest();
  let lastIndex = 0;
  let settled = false;
  const done = (fn: () => void) => {
    if (settled) return;
    settled = true;
    fn();
  };
  xhr.open('POST', req.url, true);
  for (const [name, value] of Object.entries(req.headers)) {
    xhr.setRequestHeader(name, value);
  }
  xhr.onprogress = () => {
    const text = xhr.responseText ?? '';
    if (text.length > lastIndex) {
      const slice = text.slice(lastIndex);
      lastIndex = text.length;
      handlers.onChunk(slice);
    }
  };
  xhr.onreadystatechange = () => {
    if (xhr.readyState !== 4 || settled) return;
    const text = xhr.responseText ?? '';
    if (xhr.status >= 200 && xhr.status < 300) {
      if (text.length > lastIndex) {
        const slice = text.slice(lastIndex);
        lastIndex = text.length;
        handlers.onChunk(slice);
      }
      done(() => handlers.onDone());
    } else if (xhr.status === 0) {
      done(() => handlers.onNetworkError());
    } else {
      const retryAfter = parseRetryAfter(xhr.getResponseHeader('Retry-After'));
      done(() => handlers.onHttpError(xhr.status, text, retryAfter));
    }
  };
  xhr.onerror = () => done(() => handlers.onNetworkError());
  xhr.send(req.body);
  return {
    abort: () => {
      settled = true;
      try {
        xhr.abort();
      } catch {
        // 已结束的请求 abort 静默
      }
    },
  };
};

/** 默认 JSON 传输：全局 fetch */
export const defaultJsonFetch: JsonFetch = async (url, init) => {
  const res = await fetch(url, init);
  const text = await res.text();
  const retryAfter = parseRetryAfter(res.headers.get('Retry-After'));
  return {
    status: res.status,
    text,
    ...(retryAfter !== undefined ? { retryAfterSec: retryAfter } : {}),
  };
};

function parseRetryAfter(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const sec = Number(raw);
  if (Number.isFinite(sec) && sec >= 0) return Math.round(sec);
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) {
    const diff = Math.round((date - Date.now()) / 1000);
    return diff > 0 ? diff : 0;
  }
  return undefined;
}

// ── 客户端 ──

export interface LocalChatClientDeps {
  streamTransport?: StreamTransport;
  jsonFetch?: JsonFetch;
  /** 自检超时（ms，缺省 15000） */
  checkTimeoutMs?: number;
  /** 一次性补全超时（ms，缺省 15000；AI 标题生成用，超时按失败静默回退） */
  completionTimeoutMs?: number;
}

/** 一次性非流式补全入参（AI 标题等小调用；与流式同端点同错误分类） */
export interface CompleteChatInput {
  baseUrl: string;
  apiKey: string | null;
  model: string;
  messages: readonly LocalWireMessage[];
  /** 输出上限（缺省 32，标题量级） */
  maxTokens?: number;
  /** 采样温度（缺省 0.3） */
  temperature?: number;
}

export interface StreamChatInput {
  baseUrl: string;
  apiKey: string | null;
  model: string;
  messages: readonly LocalWireMessage[];
}

export interface StreamChatCallbacks {
  /** 正文增量（逐块回调，UI 追加渲染） */
  onTextDelta: (delta: string) => void;
  /** 活动信号（收到任意块，含纯思考块；供 UI 保持生成态） */
  onActivity?: () => void;
  /** 正常结束：全文 + 结束原因 + tool_calls 名称数（永不执行，仅计数） */
  onComplete: (result: {
    content: string;
    finishReason: string | null;
    toolCallCount: number;
  }) => void;
  /** 失败（分类错误，message 已补齐） */
  onError: (error: LocalChatError) => void;
}

export interface LocalChatClient {
  streamChatCompletion: (
    input: StreamChatInput,
    callbacks: StreamChatCallbacks
  ) => StreamHandle;
  /**
   * 一次性非流式补全：resolve 助手正文全文；失败 reject 分类错误
   * （LocalChatError，message 已补齐）——与 streamChatCompletion 同错误分类。
   */
  completeChatCompletion: (input: CompleteChatInput) => Promise<string>;
  fetchProviderModels: (input: {
    baseUrl: string;
    apiKey: string | null;
  }) => Promise<string[]>;
  checkConnectivity: (input: {
    baseUrl: string;
    apiKey: string | null;
    model: string;
  }) => Promise<LocalConnectivityResult>;
}

export function createLocalChatClient(
  deps: LocalChatClientDeps = {}
): LocalChatClient {
  const streamTransport = deps.streamTransport ?? xhrStreamTransport;
  const jsonFetch = deps.jsonFetch ?? defaultJsonFetch;
  const checkTimeoutMs = deps.checkTimeoutMs ?? 15000;
  const completionTimeoutMs = deps.completionTimeoutMs ?? 15000;

  return {
    streamChatCompletion(input, callbacks) {
      const url = buildChatCompletionsUrl(input.baseUrl);
      const body = JSON.stringify(
        buildChatRequestBody({
          model: input.model,
          messages: input.messages,
          stream: true,
        })
      );
      const buffer = new SseFrameBuffer();
      let content = '';
      let finishReason: string | null = null;
      let toolCallCount = 0;
      let finished = false;

      const finishOk = () => {
        if (finished) return;
        finished = true;
        callbacks.onComplete({ content, finishReason, toolCallCount });
      };
      const finishErr = (error: LocalChatError) => {
        if (finished) return;
        finished = true;
        callbacks.onError(withErrorMessage(error));
      };

      const consume = (chunkText: string) => {
        if (finished) return;
        callbacks.onActivity?.();
        for (const event of buffer.push(chunkText)) {
          if (event.type === 'done') continue;
          const delta = applyChatChunk(event.data);
          if (delta === null) continue;
          if (delta.contentDelta !== '') {
            content += delta.contentDelta;
            callbacks.onTextDelta(delta.contentDelta);
          }
          if (delta.toolCallNames.length > 0) {
            toolCallCount += delta.toolCallNames.length;
          }
          if (delta.finishReason !== null) finishReason = delta.finishReason;
        }
      };

      const handle = streamTransport(
        { url, headers: buildChatHeaders(input.apiKey), body },
        {
          onChunk: consume,
          onHttpError: (status, bodyText, retryAfterSec) => {
            // 已收到部分正文后又报错：按流中断呈现（保留已生成内容由 VM 处理）
            if (content !== '') {
              finishErr(streamInterruptedError(`HTTP ${status}`));
              return;
            }
            finishErr(classifyHttpError(status, bodyText, retryAfterSec));
          },
          onDone: () => {
            for (const event of buffer.flush()) {
              if (event.type === 'data') {
                const delta = applyChatChunk(event.data);
                if (delta !== null) {
                  if (delta.contentDelta !== '') {
                    content += delta.contentDelta;
                    callbacks.onTextDelta(delta.contentDelta);
                  }
                  if (delta.toolCallNames.length > 0) {
                    toolCallCount += delta.toolCallNames.length;
                  }
                  if (delta.finishReason !== null) {
                    finishReason = delta.finishReason;
                  }
                }
              }
            }
            finishOk();
          },
          onNetworkError: () => {
            if (content !== '') {
              finishErr(streamInterruptedError());
              return;
            }
            finishErr(networkError());
          },
        }
      );

      return {
        abort: () => {
          // 停止生成：先标记完成再断传输，迟到的回调一律忽略；
          // 已生成内容由 VM 以 stopped 形态收尾（不走 onError）。
          finished = true;
          handle.abort();
        },
      };
    },

    async completeChatCompletion(input) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), completionTimeoutMs);
      let res: { status: number; text: string; retryAfterSec?: number };
      try {
        res = await jsonFetch(buildChatCompletionsUrl(input.baseUrl), {
          method: 'POST',
          headers: buildJsonHeaders(input.apiKey),
          body: JSON.stringify(
            buildChatRequestBody({
              model: input.model,
              messages: input.messages,
              stream: false,
              maxTokens: input.maxTokens ?? 32,
              temperature: input.temperature ?? 0.3,
            })
          ),
          signal: controller.signal,
        });
      } catch {
        // 网络失败与超时（abort）在调用方同为「生成失败」——分类按 network 出口
        throw withErrorMessage(networkError());
      } finally {
        clearTimeout(timer);
      }
      if (res.status < 200 || res.status >= 300) {
        throw withErrorMessage(
          classifyHttpError(res.status, res.text, res.retryAfterSec)
        );
      }
      // 正文提取复用流式块解析的 message 兜底口径（choices[0].message.content）
      const delta = applyChatChunk(res.text);
      if (delta === null) {
        throw withErrorMessage({
          kind: 'unknown',
          status: res.status,
          message: '补全响应不是合法的对话补全结构。',
          retryable: false,
        });
      }
      return delta.contentDelta;
    },

    async fetchProviderModels(input) {
      let res: { status: number; text: string; retryAfterSec?: number };
      try {
        res = await jsonFetch(buildModelsUrl(input.baseUrl), {
          method: 'GET',
          headers: buildJsonHeaders(input.apiKey),
        });
      } catch {
        throw withErrorMessage(networkError());
      }
      if (res.status < 200 || res.status >= 300) {
        throw withErrorMessage(
          classifyHttpError(res.status, res.text, res.retryAfterSec)
        );
      }
      let json: unknown;
      try {
        json = JSON.parse(res.text) as unknown;
      } catch {
        throw withErrorMessage({
          kind: 'unknown',
          status: res.status,
          message: '模型列表响应不是合法 JSON。',
          retryable: false,
        });
      }
      return parseModelsList(json);
    },

    async checkConnectivity(input) {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), checkTimeoutMs);
      try {
        const res = await jsonFetch(buildChatCompletionsUrl(input.baseUrl), {
          method: 'POST',
          headers: buildJsonHeaders(input.apiKey),
          body: JSON.stringify(
            buildChatRequestBody({
              model: input.model,
              messages: [{ role: 'user', content: 'ping' }],
              stream: false,
              maxTokens: 1,
            })
          ),
          signal: controller.signal,
        });
        const latencyMs = Date.now() - started;
        if (res.status >= 200 && res.status < 300) {
          return { ok: true, latencyMs, error: null };
        }
        return {
          ok: false,
          latencyMs,
          error: withErrorMessage(
            classifyHttpError(res.status, res.text, res.retryAfterSec)
          ),
        };
      } catch {
        return {
          ok: false,
          latencyMs: Date.now() - started,
          error: withErrorMessage(networkError()),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
