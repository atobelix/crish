// 本地对话客户端（适配层）：手机直连供应商的传输与编排。
//
// 流式方案（查实结论）：仓内无任何 SSE/流式 fetch 先例；RN 的全局 fetch
// 为 whatwg-fetch（全文缓冲、无 ReadableStream body），且本机 expo 包无
// expo/fetch 导出——故流式走 XMLHttpRequest：RN 的 XHR 实现支持
// onprogress 增量读取 responseText（原生网络栈分块回调），配合
// domain/pure 的 SseFrameBuffer 分帧，是 RN 生态的通行 SSE 手法。
// 传输面以接口注入（StreamTransport / JsonFetch），jest 用假传输验链路；
// 非流式调用（模型列表 / 连通性自检 / Ping 探测）走普通 fetch（JSON 全文即可）。
import {
  SseFrameBuffer,
  StreamingToolCallAccumulator,
  applyChatChunk,
  buildChatCompletionsUrl,
  buildChatHeaders,
  buildChatRequestBody,
  buildJsonHeaders,
  buildModelsUrl,
  classifyHttpError,
  networkError,
  normalizeBaseUrl,
  parseModelsList,
  streamInterruptedError,
  withErrorMessage,
  type LocalWireMessage,
} from '@/domain/pure/localChatProtocol';
import type {
  LocalChatError,
  LocalConnectivityResult,
  LocalThinkingFormat,
  LocalThinkingTier,
} from '@/domain/types/localChat';
import {
  PROVIDER_PRESETS,
  detectVendorKey,
  type LocalModelSpec,
  type LocalVendorKey,
} from './providerPresets';

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

/** JSON 请求注入面（模型列表 / 自检 / Ping）：返回状态码与文本，网络失败抛错 */
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
  try {
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
        const retryAfter = parseRetryAfter(
          xhr.getResponseHeader('Retry-After')
        );
        done(() => handlers.onHttpError(xhr.status, text, retryAfter));
      }
    };
    xhr.onerror = () => done(() => handlers.onNetworkError());
    xhr.send(req.body);
  } catch {
    done(() => handlers.onNetworkError());
  }
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

// ── 模型列表解析与注水管道 ──

export interface RawModelItem {
  id: string;
  name?: string;
  created?: number;
  ownedBy?: string;
}

/**
 * 鲁棒解析各类供应商 /models 响应体：
 * 兼容标准 OpenAI { data: [...] }、平铺数组 [{ id }]、Ollama { models: [...] }、纯字符串数组。
 * 纯函数，去重保序，自动过滤非法与空 ID。
 */
export function parseModelsListRobust(json: unknown): RawModelItem[] {
  if (json === null || typeof json !== 'object') return [];

  const seen = new Set<string>();
  const out: RawModelItem[] = [];

  const add = (
    id: unknown,
    extra?: { name?: unknown; created?: unknown; ownedBy?: unknown }
  ) => {
    if (typeof id !== 'string') return;
    const trimmed = id.trim();
    if (trimmed === '' || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push({
      id: trimmed,
      name:
        typeof extra?.name === 'string' && extra.name.trim() !== ''
          ? extra.name.trim()
          : undefined,
      created: typeof extra?.created === 'number' ? extra.created : undefined,
      ownedBy: typeof extra?.ownedBy === 'string' ? extra.ownedBy : undefined,
    });
  };

  // 1. 标准 OpenAI: { data: [...] }
  if (Array.isArray((json as { data?: unknown }).data)) {
    for (const item of (json as { data: unknown[] }).data) {
      if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        add(obj.id ?? obj.name, {
          name: obj.name ?? obj.id,
          created: obj.created,
          ownedBy: obj.owned_by ?? obj.ownedBy,
        });
      } else {
        add(item);
      }
    }
    return out;
  }

  // 2. Ollama 原生 /api/tags: { models: [...] }
  if (Array.isArray((json as { models?: unknown }).models)) {
    for (const item of (json as { models: unknown[] }).models) {
      if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        add(obj.name ?? obj.model ?? obj.id, {
          name: obj.name ?? obj.model ?? obj.id,
        });
      } else {
        add(item);
      }
    }
    return out;
  }

  // 3. 直接平铺数组: [{ id }, ...] 或 ["model-a", "model-b"]
  if (Array.isArray(json)) {
    for (const item of json) {
      if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        add(obj.id ?? obj.name, {
          name: obj.name ?? obj.id,
        });
      } else {
        add(item);
      }
    }
    return out;
  }

  return out;
}

/**
 * 模型规格注水（Hydration）：
 * 1. 优先从已知预置字典（PROVIDER_PRESETS）中继承完整规格；
 * 2. 对未知在线模型，结合 ID 命名特征启发式推导（reasoner/r1 推导 thinking；vision/4o 推导视觉；128k/64k 推导上下文）。
 */
export function hydrateModelSpec(
  raw: string | RawModelItem,
  vendorHint?: LocalVendorKey
): LocalModelSpec {
  const rawId = typeof raw === 'string' ? raw.trim() : raw.id.trim();
  const rawName = typeof raw === 'object' ? raw.name : undefined;

  // 1. 查找已知预置字典匹配模板
  if (vendorHint && PROVIDER_PRESETS[vendorHint]) {
    const match = PROVIDER_PRESETS[vendorHint].recommendedModels.find(
      (m) => m.id.toLowerCase() === rawId.toLowerCase()
    );
    if (match) {
      return {
        ...match,
        displayName: match.displayName ?? rawName ?? rawId,
        enabled: true,
      };
    }
  }

  for (const preset of Object.values(PROVIDER_PRESETS)) {
    const match = preset.recommendedModels.find(
      (m) => m.id.toLowerCase() === rawId.toLowerCase()
    );
    if (match) {
      return {
        ...match,
        displayName: match.displayName ?? rawName ?? rawId,
        enabled: true,
      };
    }
  }

  // 2. 启发式推断未知在线模型规格
  const lower = rawId.toLowerCase();
  const isReasoner = /reasoner|r1|o1|o3|thinking/i.test(lower);
  const hasVision = /vision|4o|vl|florence|image/i.test(lower);
  const isCode = /coder|code/i.test(lower);

  let contextWindow = 131072;
  if (/2m/i.test(lower)) {
    contextWindow = 2097152;
  } else if (/1m/i.test(lower)) {
    contextWindow = 1048576;
  } else if (/200k/i.test(lower)) {
    contextWindow = 200000;
  } else if (/128k/i.test(lower)) {
    contextWindow = 131072;
  } else if (/64k/i.test(lower)) {
    contextWindow = 65536;
  } else if (/32k/i.test(lower)) {
    contextWindow = 32768;
  } else if (/16k/i.test(lower)) {
    contextWindow = 16384;
  } else if (/8k/i.test(lower)) {
    contextWindow = 8192;
  }

  const maxOutputTokens = Math.min(contextWindow, 8192);

  const tags: string[] = [];
  if (isReasoner) tags.push('深度推理');
  if (hasVision) tags.push('Vision');
  if (isCode) tags.push('代码专用');
  if (tags.length === 0) tags.push('通用对话');

  return {
    id: rawId,
    displayName: rawName ?? rawId,
    enabled: true,
    contextWindow,
    maxOutputTokens,
    modalities: {
      input: hasVision ? ['text', 'image', 'file'] : ['text', 'file'],
      output: ['text'],
    },
    thinking: isReasoner
      ? {
          supported: true,
          availableTiers: ['high'],
          defaultTier: 'high',
        }
      : {
          supported: false,
          availableTiers: ['off'],
          defaultTier: 'off',
        },
    tags,
  };
}

// ── 测速与探测契约 ──

export interface ProviderPingInput {
  baseUrl: string;
  apiKey?: string | null;
  /** 测速超时限制（默认 5000ms） */
  timeoutMs?: number;
  /** 厂商标识提示（可选） */
  vendor?: LocalVendorKey;
}

export interface ProviderPingResult {
  ok: boolean;
  latencyMs: number;
  error: LocalChatError | null;
  models?: LocalModelSpec[];
  status?: number;
}

export interface FetchProviderModelsInput {
  baseUrl: string;
  apiKey?: string | null;
  vendor?: LocalVendorKey;
  /** 拉取超时限制（默认 8000ms） */
  timeoutMs?: number;
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
  /** 动态工具声明列表（可选） */
  tools?: readonly unknown[];
  /** 工具选择策略（可选） */
  toolChoice?: any;
  tool_choice?: any;
  thinkingFormat?: LocalThinkingFormat;
  thinkingTier?: LocalThinkingTier;
  maxTokens?: number;
  temperature?: number;
}

export interface StreamChatCallbacks {
  /** 正文增量（逐块回调，UI 追加渲染） */
  onTextDelta: (delta: string) => void;
  /** 思考增量回调（可选） */
  onReasoningDelta?: (delta: string) => void;
  /** 活动信号（收到任意块，含纯思考块；供 UI 保持生成态） */
  onActivity?: () => void;
  /** 当流中检测并聚合出完整的工具调用时触发 */
  onToolCallsDetected?: (toolCalls: any[]) => void;
  /** 正常结束：全文 + 结束原因 + 工具调用清单 + 思考内容 */
  onComplete: (result: {
    content: string;
    finishReason: string | null;
    toolCallCount: number;
    toolCalls?: any[];
    reasoning?: string;
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
  /**
   * 供应商轻量端点即时测速（Ping）：
   * 专供向导第 1 步与卡片测速，零 Token 消耗、超快响应、鉴权一并验证。
   */
  pingProviderEndpoint: (
    input: ProviderPingInput
  ) => Promise<ProviderPingResult>;
  /**
   * 鲁棒模型拉取：
   * 兼容 OpenAI 与 Ollama 格式，结合预置模板或启发式规则做规格注水，失败容错降级。
   */
  fetchProviderModelsRobust: (
    input: FetchProviderModelsInput
  ) => Promise<LocalModelSpec[]>;
}

async function executePingProviderEndpoint(
  input: ProviderPingInput,
  jsonFetch: JsonFetch
): Promise<ProviderPingResult> {
  const started =
    typeof performance !== 'undefined' ? performance.now() : Date.now();
  const controller = new AbortController();
  const timeoutMs = input.timeoutMs ?? 5000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const getLatency = () =>
    Math.max(
      1,
      Math.round(
        (typeof performance !== 'undefined' ? performance.now() : Date.now()) -
          started
      )
    );

  try {
    const url = buildModelsUrl(input.baseUrl);
    const res = await jsonFetch(url, {
      method: 'GET',
      headers: buildJsonHeaders(input.apiKey ?? null),
      signal: controller.signal,
    });

    const latencyMs = getLatency();

    // 1. GET /models 正常响应 2xx
    if (res.status >= 200 && res.status < 300) {
      let models: LocalModelSpec[] = [];
      try {
        const json = JSON.parse(res.text) as unknown;
        const rawItems = parseModelsListRobust(json);
        const vendor = input.vendor ?? detectVendorKey(input.baseUrl);
        models = rawItems.map((item) => hydrateModelSpec(item, vendor));
      } catch {
        // 模型列表 JSON 解析失败，但连通性正常
      }
      return {
        ok: true,
        latencyMs,
        status: res.status,
        error: null,
        models,
      };
    }

    // 2. 404/405 端点未开放 /models：优雅降级到 GET 根路径连通性探测
    if (res.status === 404 || res.status === 405) {
      try {
        const rootUrl = normalizeBaseUrl(input.baseUrl);
        const fallbackRes = await jsonFetch(rootUrl, {
          method: 'GET',
          headers: buildJsonHeaders(input.apiKey ?? null),
          signal: controller.signal,
        });
        const fallbackLatency = getLatency();
        if (fallbackRes.status < 500) {
          return {
            ok: true,
            latencyMs: fallbackLatency,
            status: fallbackRes.status,
            error: null,
            models: [],
          };
        }
      } catch {
        // fallback 探测失败，继续向下进入常规错误分类
      }
    }

    // 3. 其它 HTTP 错误（401/403 鉴权失败、5xx 服务端错误等）
    return {
      ok: false,
      latencyMs,
      status: res.status,
      error: withErrorMessage(
        classifyHttpError(res.status, res.text, res.retryAfterSec)
      ),
    };
  } catch {
    // 网络层异常（超时 abort 或断网）
    return {
      ok: false,
      latencyMs: getLatency(),
      error: withErrorMessage(networkError()),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function executeFetchProviderModelsRobust(
  input: FetchProviderModelsInput,
  jsonFetch: JsonFetch
): Promise<LocalModelSpec[]> {
  const controller = new AbortController();
  const timeoutMs = input.timeoutMs ?? 8000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const vendor = input.vendor ?? detectVendorKey(input.baseUrl);

  try {
    const url = buildModelsUrl(input.baseUrl);
    let resText: string | null = null;

    try {
      const res = await jsonFetch(url, {
        method: 'GET',
        headers: buildJsonHeaders(input.apiKey ?? null),
        signal: controller.signal,
      });

      if (res.status >= 200 && res.status < 300) {
        resText = res.text;
      } else if (
        (res.status === 404 || res.status === 405) &&
        (vendor === 'ollama' || input.baseUrl.includes('11434'))
      ) {
        // Ollama 原生 /api/tags 兼容回退
        try {
          const tagsUrl = `${normalizeBaseUrl(input.baseUrl)}/api/tags`;
          const tagsRes = await jsonFetch(tagsUrl, {
            method: 'GET',
            headers: buildJsonHeaders(input.apiKey ?? null),
            signal: controller.signal,
          });
          if (tagsRes.status >= 200 && tagsRes.status < 300) {
            resText = tagsRes.text;
          }
        } catch {
          // Ollama tags 回退失败
        }
      }
    } catch {
      // 网络请求失败
    }

    if (resText !== null) {
      try {
        const json = JSON.parse(resText) as unknown;
        const rawItems = parseModelsListRobust(json);
        if (rawItems.length > 0) {
          return rawItems.map((item) => hydrateModelSpec(item, vendor));
        }
      } catch {
        // JSON 解析失败
      }
    }
  } catch {
    // 整体异常保护
  } finally {
    clearTimeout(timer);
  }

  // 失败时容错降级：返回当前供应商的预置推荐模型列表，绝不抛出不可恢复的硬崩溃
  const preset = PROVIDER_PRESETS[vendor] ?? PROVIDER_PRESETS.custom;
  if (
    preset &&
    preset.recommendedModels &&
    preset.recommendedModels.length > 0
  ) {
    return [...preset.recommendedModels];
  }

  return [];
}

/** 独立函数形式即时测速（Ping）探测 */
export async function pingProviderEndpoint(
  input: ProviderPingInput,
  deps: LocalChatClientDeps = {}
): Promise<ProviderPingResult> {
  const jsonFetch = deps.jsonFetch ?? defaultJsonFetch;
  return executePingProviderEndpoint(input, jsonFetch);
}

/** 独立函数形式鲁棒模型拉取 */
export async function fetchProviderModelsRobust(
  input: FetchProviderModelsInput,
  deps: LocalChatClientDeps = {}
): Promise<LocalModelSpec[]> {
  const jsonFetch = deps.jsonFetch ?? defaultJsonFetch;
  return executeFetchProviderModelsRobust(input, jsonFetch);
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
          tools: input.tools,
          toolChoice: input.toolChoice ?? input.tool_choice,
          thinkingFormat: input.thinkingFormat,
          thinkingTier: input.thinkingTier,
          maxTokens: input.maxTokens,
          temperature: input.temperature,
        })
      );
      const buffer = new SseFrameBuffer();
      const accumulator = new StreamingToolCallAccumulator();
      let content = '';
      let reasoning = '';
      let finishReason: string | null = null;
      let toolCallCount = 0;
      let finished = false;

      const finishOk = () => {
        if (finished) return;
        finished = true;
        const toolCalls = accumulator.hasToolCalls()
          ? accumulator.finalize()
          : [];
        if (toolCalls.length > 0) {
          callbacks.onToolCallsDetected?.(toolCalls);
        }
        callbacks.onComplete({
          content,
          finishReason,
          toolCallCount: Math.max(toolCallCount, toolCalls.length),
          toolCalls,
          reasoning: reasoning || undefined,
        });
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
          if (delta.reasoningDelta && delta.reasoningDelta !== '') {
            reasoning += delta.reasoningDelta;
            callbacks.onReasoningDelta?.(delta.reasoningDelta);
          }
          if (delta.toolCallDeltas && delta.toolCallDeltas.length > 0) {
            accumulator.pushDeltas(delta.toolCallDeltas);
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
                  if (delta.reasoningDelta && delta.reasoningDelta !== '') {
                    reasoning += delta.reasoningDelta;
                    callbacks.onReasoningDelta?.(delta.reasoningDelta);
                  }
                  if (delta.toolCallDeltas && delta.toolCallDeltas.length > 0) {
                    accumulator.pushDeltas(delta.toolCallDeltas);
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

    pingProviderEndpoint(input) {
      return executePingProviderEndpoint(input, jsonFetch);
    },

    fetchProviderModelsRobust(input) {
      return executeFetchProviderModelsRobust(input, jsonFetch);
    },
  };
}
