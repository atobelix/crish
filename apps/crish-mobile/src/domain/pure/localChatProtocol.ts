// 本地对话协议纯函数层（jest 直测，无 IO）：
// 与桌面 crates/agent-provider 的 wire 口径逐项对齐——
// - 端点归一：request/wire_protocol.rs 的 build_endpoint_url（openai/chat 轨）；
// - 请求体：request/build/build_chat.rs 的 compactObject 口径（只写已设字段，
//   本地对话不声明 tools / 不带思考与缓存方言字段）；
// - 鉴权头：crates/conex-run engine_provider/headers.rs（chat 轨
//   Authorization: Bearer <key>，key 为空不发头；供应商声明头本地无对应面）；
// - SSE 解析：events/stream.rs + parse/chat/chat_core.rs（data: 帧、
//   choices[0].delta.content、delta.tool_calls 增量、finish_reason、[DONE]）；
// - 错误分类：error.rs classify_provider_error 的优先级子集（见 classifyHttpError）。
import type {
  LocalChatError,
  LocalChatErrorKind,
  LocalChatMessage,
  LocalModelsConfig,
  LocalProviderDraft,
  LocalProviderSpec,
  ProviderDraftIssue,
} from '../types/localChat';

/** 本地对话系统提示（定位：纯对话助手，无工具执行能力——与请求不声明 tools 一致） */
export const LOCAL_CHAT_SYSTEM_PROMPT =
  '你是 Crish 手机本地助手。只能进行文字对话：你没有可调用的工具，也无法访问用户的电脑、文件或网络服务；被要求执行操作时，请说明这一点并给出可行的文字建议。回答简洁、直接。';

/** 供应商在本机 SecureStore 的凭据引用（桌面 apiKeyRef 的移动端对应形态） */
export function apiKeyRefFor(providerId: string): string {
  return `secure:${providerId}`;
}

/** SecureStore 槽位键（apiKeyRef 去前缀即槽位全名的一部分） */
export function apiKeySlotFor(providerId: string): string {
  return `localchat.provider.${providerId}.api_key`;
}

/** 归一 Base URL 输入：去首尾空白与尾部斜杠（端点拼接在 build*Url 内完成） */
export function normalizeBaseUrl(input: string): string {
  return input.trim().replace(/\/+$/, '');
}

/**
 * Chat Completions 端点（桌面 build_endpoint_url 的 openai/chat 归一规则）：
 * - 已以 /chat/completions 结尾 → 原样；
 * - 以 /v1 结尾 → 追加 /chat/completions；
 * - 其余 → 追加 /v1/chat/completions。
 */
export function buildChatCompletionsUrl(baseUrl: string): string {
  const base = normalizeBaseUrl(baseUrl);
  if (base.endsWith('/chat/completions')) return base;
  if (base.endsWith('/v1')) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

/**
 * 模型列表端点（与 chat 端点同归一族）：以 chat 端点为锚回退到同级 /models——
 * /chat/completions → /models；/v1 → /v1/models；其余 → /v1/models。
 */
export function buildModelsUrl(baseUrl: string): string {
  const chat = buildChatCompletionsUrl(baseUrl);
  return chat.replace(/\/chat\/completions$/, '/models');
}

/** 请求头（chat 轨）：Content-Type 恒发；Authorization 仅 key 非空时发（桌面同口径） */
export function buildChatHeaders(
  apiKey: string | null
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  if (apiKey !== null && apiKey.trim() !== '') {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }
  return headers;
}

/** 模型列表/自检请求头（Accept 为 JSON） */
export function buildJsonHeaders(
  apiKey: string | null
): Record<string, string> {
  const headers = buildChatHeaders(apiKey);
  headers.Accept = 'application/json';
  return headers;
}

/** wire 消息（OpenAI 形态：role + 纯文本 content；system 在首位由调用方拼装） */
export interface LocalWireMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * 组装出站消息序列：系统提示恒在首（本地助手定位），随后是会话多轮上下文
 * （跳过流式占位与空消息）。纯附件/工具形态不存在于本地对话。
 */
export function buildWireMessages(
  history: readonly LocalChatMessage[]
): LocalWireMessage[] {
  const out: LocalWireMessage[] = [
    { role: 'system', content: LOCAL_CHAT_SYSTEM_PROMPT },
  ];
  for (const m of history) {
    if (m.streaming) continue;
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (m.content.trim() === '') continue;
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

/**
 * Chat Completions 请求体（compactObject：只写已设字段）：
 * { model, messages, stream }；stream=false 时不写 stream 键以外的任何流式
 * 字段；本地对话永不写 tools/tool_choice（请求侧不给工具执行面）。
 */
export function buildChatRequestBody(input: {
  model: string;
  messages: readonly LocalWireMessage[];
  stream: boolean;
  maxTokens?: number;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.model,
    messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
    stream: input.stream,
  };
  if (input.maxTokens !== undefined) body.max_tokens = input.maxTokens;
  return body;
}

/** 解析 /models 响应（OpenAI 形态 { data: [{ id }] }）：提取 id 列表（保序去重） */
export function parseModelsList(json: unknown): string[] {
  if (json === null || typeof json !== 'object') return [];
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of data) {
    if (item === null || typeof item !== 'object') continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id !== 'string') continue;
    const trimmed = id.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** 合并模型 id 清单（既有在前，新增追加；去重保序） */
export function mergeModelIds(
  existing: readonly string[],
  incoming: readonly string[]
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [...existing, ...incoming]) {
    const t = id.trim();
    if (t === '' || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** 草稿校验（保存前置；问题码由 UI 映射文案） */
export function validateProviderDraft(
  draft: LocalProviderDraft
): ProviderDraftIssue[] {
  const issues: ProviderDraftIssue[] = [];
  if (draft.name.trim() === '' && draft.baseUrl.trim() === '') {
    issues.push('nameEmpty');
  }
  const base = draft.baseUrl.trim();
  if (base === '') {
    issues.push('baseUrlEmpty');
  } else if (!isHttpUrl(base)) {
    issues.push('baseUrlInvalid');
  }
  const models = mergeModelIds(draft.modelIds, []);
  const fallback = draft.defaultModelId.trim();
  if (models.length === 0 && fallback === '') issues.push('modelEmpty');
  return issues;
}

function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 由 Base URL 主机名派生展示名（名称留空时的兜底，与桌面「用户声明优先」一致） */
export function deriveProviderName(baseUrl: string): string {
  try {
    return new URL(baseUrl.trim()).host;
  } catch {
    return baseUrl.trim();
  }
}

/** 草稿 → 配置条目（apiKeyRef 由 store 层在写密钥时补齐；此处只组装非密字段） */
export function providerSpecFromDraft(
  draft: LocalProviderDraft
): LocalProviderSpec {
  const modelIds = mergeModelIds(draft.modelIds, []);
  const fallback = draft.defaultModelId.trim();
  const models =
    fallback !== '' && !modelIds.includes(fallback)
      ? [fallback, ...modelIds]
      : modelIds;
  const name = draft.name.trim();
  return {
    displayName: name !== '' ? name : deriveProviderName(draft.baseUrl),
    baseUrl: normalizeBaseUrl(draft.baseUrl),
    protocol: 'openai/chat',
    stream: true,
    enabled: true,
    models: models.map((id) => ({ id, enabled: true })),
  };
}

/** 供应商的默认模型：活动选择优先，其次清单首个启用模型 */
export function providerDefaultModelId(
  config: LocalModelsConfig,
  providerId: string
): string | null {
  const provider = config.providers[providerId];
  if (!provider) return null;
  if (
    config.activeModel?.providerId === providerId &&
    provider.models.some((m) => m.id === config.activeModel?.modelId)
  ) {
    return config.activeModel.modelId;
  }
  const first = provider.models.find((m) => m.enabled !== false);
  return first?.id ?? provider.models[0]?.id ?? null;
}

/** 当前生效的供应商 + 模型（无完整选择时返回 null，UI 走未配置态） */
export function resolveActiveSelection(config: LocalModelsConfig): {
  providerId: string;
  provider: LocalProviderSpec;
  modelId: string;
} | null {
  const active = config.activeModel;
  if (active) {
    const provider = config.providers[active.providerId];
    if (provider && provider.enabled !== false) {
      const model = provider.models.find((m) => m.id === active.modelId);
      if (model && model.enabled !== false) {
        return {
          providerId: active.providerId,
          provider,
          modelId: active.modelId,
        };
      }
    }
  }
  // 活动选择失效时不擅自替代（桌面归一同口径：失效选择清空）——返回 null 由
  // UI 引导用户重选；但仅一位供应商且模型唯一时也不自动选（诚实口径）。
  return null;
}

// ── SSE 流式解析（桌面 events/stream.rs + parse/chat 口径的 TS 形态） ──

/** SSE 帧事件：data 负载原文（'[DONE]' 单独成 done 事件） */
export type SseEvent = { type: 'data'; data: string } | { type: 'done' };

/**
 * SSE 分帧缓冲：按空行切帧，逐行取 data: 负载（多行 data 以 \n 拼接），
 * 忽略注释（: 开头）与 event:/id: 等其余字段——与桌面 sse reader 同口径。
 * push 返回本次切出的完整帧；不完整尾帧留在缓冲等下一块。
 */
export class SseFrameBuffer {
  private buffer = '';

  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    for (;;) {
      const frame = this.takeFrame();
      if (frame === null) break;
      const event = parseSseFrame(frame);
      if (event !== null) events.push(event);
    }
    return events;
  }

  /** 流结束时冲刷残余（无尾随空行的最后一帧） */
  flush(): SseEvent[] {
    const rest = this.buffer;
    this.buffer = '';
    if (rest.trim() === '') return [];
    const event = parseSseFrame(rest);
    return event !== null ? [event] : [];
  }

  private takeFrame(): string | null {
    const lf = this.buffer.indexOf('\n\n');
    const crlf = this.buffer.indexOf('\r\n\r\n');
    let idx = -1;
    let sepLen = 0;
    if (lf !== -1 && (crlf === -1 || lf < crlf)) {
      idx = lf;
      sepLen = 2;
    } else if (crlf !== -1) {
      idx = crlf;
      sepLen = 4;
    }
    if (idx === -1) return null;
    const frame = this.buffer.slice(0, idx);
    this.buffer = this.buffer.slice(idx + sepLen);
    return frame;
  }
}

function parseSseFrame(frame: string): SseEvent | null {
  const dataLines: string[] = [];
  for (const rawLine of frame.split(/\r\n|\n|\r/)) {
    if (rawLine.startsWith(':')) continue;
    if (rawLine.startsWith('data:')) {
      dataLines.push(rawLine.slice(5).replace(/^ /, ''));
    }
  }
  if (dataLines.length === 0) return null;
  const data = dataLines.join('\n');
  if (data.trim() === '[DONE]') return { type: 'done' };
  return { type: 'data', data };
}

/** 单个 chat-completions 流式块的解析产物 */
export interface ChatChunkDelta {
  /** 正文增量（delta.content） */
  contentDelta: string;
  /** 思考增量（reasoning_content 等五级探测链命中其一；本地仅作活动信号不展示） */
  reasoningDelta: string;
  /** 本块新出现的 tool_call 名称（按 index 聚合，名称常只在首块出现） */
  toolCallNames: string[];
  /** 结束原因（finish_reason，非空即终块） */
  finishReason: string | null;
}

/**
 * 解析一个 SSE data 负载（chat-completions chunk JSON）：
 * 对齐桌面 parse/chat/chat_core.rs——delta 可缺失、message 兜底（非流式
 * 形态混入流式时取 message.content / message.tool_calls）、tool_calls 只
 * 记录名称计数（本地永不执行）。非法 JSON / 无 choice → null（跳过该帧）。
 */
export function applyChatChunk(data: string): ChatChunkDelta | null {
  let json: unknown;
  try {
    json = JSON.parse(data) as unknown;
  } catch {
    return null;
  }
  if (json === null || typeof json !== 'object') return null;
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const choice = choices[0] as Record<string, unknown>;
  const out: ChatChunkDelta = {
    contentDelta: '',
    reasoningDelta: '',
    toolCallNames: [],
    finishReason:
      typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
  };
  const delta = asRecord(choice.delta);
  const message = asRecord(choice.message);
  const source = delta ?? message;
  if (source) {
    if (typeof source.content === 'string') out.contentDelta = source.content;
    for (const key of [
      'reasoning_content',
      'reasoning',
      'thinking',
      'thinking_delta',
      'thought',
    ]) {
      const v = source[key];
      if (typeof v === 'string' && v !== '') {
        out.reasoningDelta = v;
        break;
      }
    }
    const toolCalls = source.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const raw of toolCalls) {
        const call = asRecord(raw);
        const fn = call ? asRecord(call.function) : null;
        const name = fn?.name;
        out.toolCallNames.push(typeof name === 'string' ? name : '');
      }
    }
  }
  return out;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

// ── 错误分类（桌面 classify_provider_error 优先级子集） ──

const CONTEXT_LENGTH_PATTERNS = [
  'context_length_exceeded',
  'maximum context',
  'context length',
  'too long',
];
const AUTH_PATTERNS = [
  'unauthorized',
  'forbidden',
  'invalid api key',
  'invalid authentication',
  'invalid_api_key',
];
const QUOTA_PATTERNS = [
  'insufficient_quota',
  'quota exceeded',
  'out of credits',
  'insufficient balance',
  'insufficient credit',
];
const RATE_LIMIT_PATTERNS = ['rate limit', 'rate_limit', 'too many requests'];
const MODEL_PATTERNS = [
  'model_not_found',
  'model not found',
  'does not exist',
  'no such model',
  'unknown model',
];

/** 从错误体提取供应商 message 摘录（OpenAI 形态 error.message 优先，截断 200 字） */
export function extractErrorDetail(bodyText: string | null): string {
  if (bodyText === null || bodyText.trim() === '') return '';
  let message = '';
  try {
    const json = JSON.parse(bodyText) as {
      error?: { message?: unknown; code?: unknown; type?: unknown };
      message?: unknown;
    };
    const errMsg = json.error?.message;
    if (typeof errMsg === 'string') message = errMsg;
    else if (typeof json.message === 'string') message = json.message;
    const code = json.error?.code ?? json.error?.type;
    if (typeof code === 'string' && code !== '') {
      message = message !== '' ? `${message}（${code}）` : code;
    }
  } catch {
    message = bodyText;
  }
  const flat = message.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

function bodyHaystack(bodyText: string | null): string {
  if (bodyText === null) return '';
  return `${bodyText} ${extractErrorDetail(bodyText)}`.toLowerCase();
}

function containsAny(haystack: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => haystack.includes(p));
}

/**
 * HTTP 错误分类（桌面判定序的本地子集）：
 * 模型错误体 → 413 → 401/403 鉴权 → 402 配额 → 429 限流 → 404/405/415 端点 →
 * 400/422（上下文超长 / 请求不合法）→ 5xx 服务端 → 其余未知。
 * 模型错误优先于状态码：不少供应商以 404/400 返回 model_not_found，
 * 用户需要的是「模型不存在」而不是「端点不可用」（条目 2 分类口径）。
 */
export function classifyHttpError(
  status: number,
  bodyText: string | null,
  retryAfterSec?: number
): LocalChatError {
  const haystack = bodyHaystack(bodyText);
  const detail = extractErrorDetail(bodyText);
  const make = (
    kind: LocalChatErrorKind,
    retryable: boolean,
    extra?: Partial<LocalChatError>
  ): LocalChatError => ({
    kind,
    status,
    message: '',
    ...(detail !== '' ? { detail } : {}),
    retryable,
    ...extra,
  });

  if (containsAny(haystack, MODEL_PATTERNS))
    return make('modelNotFound', false);
  if (status === 413) return make('payloadTooLarge', false);
  if (
    status === 401 ||
    status === 403 ||
    containsAny(haystack, AUTH_PATTERNS)
  ) {
    return make('auth', false);
  }
  if (status === 402 || containsAny(haystack, QUOTA_PATTERNS)) {
    return make('quota', false);
  }
  if (status === 429 || containsAny(haystack, RATE_LIMIT_PATTERNS)) {
    return make('rateLimit', true, {
      ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
    });
  }
  if (status === 404 || status === 405 || status === 415) {
    return make('endpointUnavailable', false);
  }
  if (status === 400 || status === 422) {
    if (containsAny(haystack, CONTEXT_LENGTH_PATTERNS)) {
      return make('contextLength', false);
    }
    return make('invalidRequest', false);
  }
  if (status >= 500 && status <= 599) return make('server', true);
  return make('unknown', false);
}

/** 网络层失败（请求未获响应：离线/DNS/连接拒绝/超时未响应） */
export function networkError(): LocalChatError {
  return { kind: 'network', status: null, message: '', retryable: true };
}

/** 流式中断（已开始接收后连接异常终止） */
export function streamInterruptedError(detail?: string): LocalChatError {
  return {
    kind: 'stream',
    status: null,
    message: '',
    retryable: true,
    ...(detail !== undefined && detail !== '' ? { detail } : {}),
  };
}

/** 未配置错误（本地前置） */
export function notConfiguredError(): LocalChatError {
  return { kind: 'notConfigured', status: null, message: '', retryable: false };
}

/** 错误 → 用户文案（真实分类呈现；detail 由 UI 另行小字展示） */
export function localChatErrorMessage(error: LocalChatError): string {
  switch (error.kind) {
    case 'network':
      return '网络不可达：无法连接供应商服务，请检查网络与 Base URL。';
    case 'auth':
      return '鉴权失败：API Key 无效或无权限，请检查供应商配置。';
    case 'quota':
      return '配额不足：供应商账户额度或余额已耗尽。';
    case 'modelNotFound':
      return '模型不存在：该供应商下没有这个模型 id，请核对模型名称。';
    case 'endpointUnavailable':
      return '端点不可用：Base URL 路径可能不正确（需为 OpenAI 兼容地址）。';
    case 'rateLimit':
      return error.retryAfterSec !== undefined
        ? `请求过于频繁（限流）：建议等待约 ${error.retryAfterSec} 秒后重试。`
        : '请求过于频繁（限流）：请稍后重试。';
    case 'contextLength':
      return '上下文过长：本轮对话累计内容超出模型上限，请清空对话后重试。';
    case 'invalidRequest':
      return '请求不合法：供应商拒绝了本次请求参数。';
    case 'payloadTooLarge':
      return '请求体过大：供应商拒绝接收，请缩短对话内容。';
    case 'server':
      return '供应商服务端错误：请稍后重试。';
    case 'stream':
      return '连接中断：回复未完整接收，可重试。';
    case 'notConfigured':
      return '尚未配置本地供应商：请先添加供应商与模型。';
    case 'unknown':
    default:
      return error.status !== null
        ? `请求失败（HTTP ${error.status}）：请查看详情或检查配置。`
        : '请求失败：请检查配置后重试。';
  }
}

/** 确保错误带用户文案（client 层出口统一补齐 message 字段） */
export function withErrorMessage(error: LocalChatError): LocalChatError {
  return error.message !== ''
    ? error
    : { ...error, message: localChatErrorMessage(error) };
}
