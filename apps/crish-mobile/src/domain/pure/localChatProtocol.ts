// 本地对话协议纯函数层（jest 直测，无 IO）：
// 与桌面 crates/agent-provider 的 wire 口径逐项对齐——
// - 端点归一：request/wire_protocol.rs 的 build_endpoint_url（openai/chat 轨）；
// - 请求体：request/build/build_chat.rs 的 compactObject 口径（只写已设字段）；
// - 鉴权头：crates/conex-run engine_provider/headers.rs（chat 轨
//   Authorization: Bearer <key>，key 为空不发头；供应商声明头本地无对应面）；
// - SSE 解析：events/stream.rs + parse/chat/chat_core.rs（data: 帧、
//   choices[0].delta.content、delta.tool_calls 增量、finish_reason、[DONE]）；
// - 错误分类：error.rs classify_provider_error 的优先级子集（见 classifyHttpError）；
// - 思考方言：对齐桌面 dialect.rs 与 thinking_format，支持 OpenAI / DeepSeek / Anthropic / Qwen 等；
// - 草稿无损往返：草稿携带完整 LocalModelSpec[]，消除模型能力抹平与顺序副作用。
import {
  emptyLocalModelsConfig,
  type LocalChatError,
  type LocalChatErrorKind,
  type LocalChatMessage,
  type LocalModelRef,
  type LocalModelSpec,
  type LocalModelsConfig,
  type LocalProviderDraft,
  type LocalProviderSpec,
  type LocalThinkingFormat,
  type LocalThinkingTier,
  type LocalVendorKey,
  type LocalWireToolCall,
  type ProviderDraftIssue,
  type ResolvedSelection,
} from '../types/localChat';
import { markdownPreviewText } from './markdown/plainText';

/** 本地对话系统提示（定位：通用智能助手，当未启用外部工具时的纯文字对话指引） */
export const LOCAL_CHAT_SYSTEM_PROMPT =
  '你是 Crish 手机本地助手。当前未启用外部工具，请使用已有知识与上下文进行文字对话。回答简洁、直接。';

export interface SystemPromptContext {
  /** 当前客户端本地时间 ISO 字符串或本地格式 */
  nowIsoString?: string;
  /** 本地时区名（例如 "Asia/Shanghai"） */
  timeZone?: string;
  /** 网络状态描述（例如 "WiFi", "Cellular", "Offline"） */
  networkKind?: string;
  /** 已启用的工具摘要列表（若为空则退化为纯文本助手） */
  enabledTools?: ReadonlyArray<{ name: string; description: string }>;
}

export function buildLocalChatSystemPrompt(
  context?: SystemPromptContext
): string {
  const parts: string[] = [];

  // 1. 核心定位
  parts.push(
    '你是 Crish 手机端本地智能助理。你具备高度自主的问题解决能力，在用户提问时根据需要直接利用端侧工具获取信息或执行计算。回答保持专业、严谨、排版清晰。'
  );

  // 2. 环境与时间感知
  const now = context?.nowIsoString ?? new Date().toISOString();
  const tz =
    context?.timeZone ??
    (typeof Intl !== 'undefined'
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : 'UTC');
  const net = context?.networkKind
    ? `，网络环境：${context.networkKind}。`
    : '。';
  parts.push(`当前设备时间：${now}，时区：${tz}${net}`);

  // 3. 工具使用规范
  if (context?.enabledTools && context.enabledTools.length > 0) {
    const toolListStr = context.enabledTools
      .map((t) => `- ${t.name}: ${t.description}`)
      .join('\n');
    parts.push(
      `你可以使用以下端侧工具来辅助完成任务：\n${toolListStr}\n` +
        '工具调用准则：\n' +
        '1. 遇到需要即时信息、新闻事实、精确数学计算、日期推算、格式转换时，优先调用对应工具，不要凭空编造；\n' +
        '2. 如果无需工具即可确切回答的问题（如通识知识、语言润色），直接作答，不要发起非必要的工具调用；\n' +
        '3. 支持单轮内发起多个工具调用（例如同时搜索多个关键词或并行获取多个网页）。'
    );

    // 4. 联网搜索与引用规范
    const hasWeb = context.enabledTools.some(
      (t) => t.name === 'web_search' || t.name === 'web_fetch'
    );
    if (hasWeb) {
      parts.push(
        '【引用格式规范】：当你根据 web_search 或 web_fetch 的结果作答时，引用的事实必须使用 [cite:id] 格式紧跟在陈述后（id 必须与工具返回结果中的 id 完全一致，例如 [cite:3f2a-1]）。禁止自行发明不存在的引用标识。'
      );
    }

    // 5. 错误熔断与自愈
    parts.push(
      '【容错与熔断纪律】：若工具调用返回错误或未查到结果，绝对禁止在下一轮使用相同的参数再次盲目重试！你应该向用户解释获取信息失败的原因，并基于已有知识和上下文尽可能给出有价值的分析。'
    );
  } else {
    parts.push(
      '当前未启用任何外部工具。请直接使用已有知识与上下文进行文字对话，回答简洁直接。'
    );
  }

  return parts.join('\n\n');
}

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

/** OpenAI 形 content part（本地线形子集，与桌面 multimodal 输出同构） */
export type LocalWireContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail: 'auto' } };

/** 动态工具集声明（对齐 OpenAI Function Calling Wire 格式） */
export interface LocalWireTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
    strict?: boolean;
  };
  [key: string]: unknown;
}

/** wire 消息（OpenAI 形态：role + content + tool_calls / tool_call_id） */
export type LocalWireMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | LocalWireContentPart[] }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: LocalWireToolCall[];
    }
  | {
      role: 'tool';
      tool_call_id: string;
      content: string;
    };

/**
 * 时序安全守卫：检查末尾或中间是否存在孤立的 assistant(tool_calls) 尚未收到 tool 响应。
 * 若存在（例如应用异常退出后重连），自动合成 mock tool 响应，防止 API 400。
 */
export function repairOrphanedToolCalls(messages: LocalWireMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (
      msg &&
      msg.role === 'assistant' &&
      'tool_calls' in msg &&
      Array.isArray(msg.tool_calls) &&
      msg.tool_calls.length > 0
    ) {
      const expectedIds = new Set(msg.tool_calls.map((tc) => tc.id));
      let j = i + 1;
      while (j < messages.length && messages[j]?.role === 'tool') {
        const toolMsg = messages[j] as {
          role: 'tool';
          tool_call_id: string;
          content: string;
        };
        expectedIds.delete(toolMsg.tool_call_id);
        j++;
      }
      if (expectedIds.size > 0) {
        for (const missingId of expectedIds) {
          messages.splice(j, 0, {
            role: 'tool',
            tool_call_id: missingId,
            content: JSON.stringify({
              error: 'Tool execution was cancelled or interrupted',
            }),
          });
          j++;
        }
      }
    }
  }
}

/**
 * 组装出站消息序列：系统提示恒在首（本地助手定位），随后是会话多轮上下文
 * （跳过流式占位与空消息）。
 * - 允许 assistant 携带 tool_calls（即便正文 content === '' 也绝不丢弃）；
 * - 允许出站列表中包含 role: 'tool' 消息；
 * - 图片附件按 fail-closed 口径回放：消息落存了真下发的图片附件且模型具备视觉能力时组为 parts。
 */
export function buildWireMessages(
  history: readonly LocalChatMessage[],
  options:
    | {
        visionSupported?: boolean;
        systemPrompt?: string;
      }
    | boolean = false
): LocalWireMessage[] {
  const opts =
    typeof options === 'boolean' ? { visionSupported: options } : options;
  const systemPrompt = opts.systemPrompt ?? LOCAL_CHAT_SYSTEM_PROMPT;
  const out: LocalWireMessage[] = [{ role: 'system', content: systemPrompt }];

  for (let i = 0; i < history.length; i++) {
    const m = history[i]!;
    if (m.streaming) continue;
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool')
      continue;

    // 1. 处理用户消息（含图片视觉回放）
    if (m.role === 'user') {
      if (
        m.content.trim() === '' &&
        (!m.attachments || m.attachments.length === 0)
      ) {
        continue;
      }
      if (opts.visionSupported && m.attachments?.length) {
        const parts: LocalWireContentPart[] = [
          { type: 'text', text: m.content },
        ];
        for (const a of m.attachments) {
          if (a.kind === 'image' && a.dataUrl) {
            parts.push({
              type: 'image_url',
              image_url: { url: a.dataUrl, detail: 'auto' },
            });
          }
        }
        if (parts.length > 1) {
          out.push({ role: 'user', content: parts });
          continue;
        }
      }
      out.push({ role: 'user', content: m.content });
      continue;
    }

    // 2. 处理助手消息（支持纯文本或带 tool_calls）
    if (m.role === 'assistant') {
      const hasToolCalls = Array.isArray(m.toolCalls) && m.toolCalls.length > 0;
      if (!hasToolCalls && m.content.trim() === '') {
        continue; // 既无文字又无工具调用的空消息不发
      }

      if (hasToolCalls) {
        out.push({
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls!.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: (tc.name || tc.function?.name || '') as string,
              arguments: (tc.arguments ||
                tc.function?.arguments ||
                '') as string,
            },
          })),
        });
      } else {
        out.push({ role: 'assistant', content: m.content });
      }
      continue;
    }

    // 3. 处理工具响应消息
    if (m.role === 'tool' && m.toolCallId) {
      out.push({
        role: 'tool',
        tool_call_id: m.toolCallId,
        content: m.content || '',
      });
      continue;
    }
  }

  // 4. 时序安全兜底：自动补齐孤立的 tool_calls
  repairOrphanedToolCalls(out);

  return out;
}

/**
 * Chat Completions 请求体（compactObject：只写已设字段）：
 * { model, messages, stream }；
 * 扩展支持 tools / tool_choice（tools 存在且非空时合规序列化进请求体）；
 * 可选融入思考推理方言（OpenAI reasoning_effort、DeepSeek thinking 等）。
 */
export function buildChatRequestBody(input: {
  model: string;
  messages: readonly LocalWireMessage[];
  stream: boolean;
  maxTokens?: number;
  temperature?: number;
  thinkingFormat?: LocalThinkingFormat;
  thinkingTier?: LocalThinkingTier;
  tools?: readonly unknown[];
  toolChoice?: unknown;
  tool_choice?: unknown;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.model,
    messages: input.messages.map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: m.tool_call_id,
          content: m.content,
        };
      }
      if (m.role === 'assistant' && 'tool_calls' in m && m.tool_calls) {
        return {
          role: 'assistant',
          content: m.content,
          tool_calls: m.tool_calls,
        };
      }
      return {
        role: m.role,
        content:
          typeof m.content === 'string'
            ? m.content
            : (m.content ?? []).map((part) =>
                part.type === 'text'
                  ? { type: 'text' as const, text: part.text }
                  : {
                      type: 'image_url' as const,
                      image_url: {
                        url: part.image_url.url,
                        detail: part.image_url.detail,
                      },
                    }
              ),
      };
    }),
    stream: input.stream,
  };

  if (input.maxTokens !== undefined) body.max_tokens = input.maxTokens;
  if (input.temperature !== undefined) body.temperature = input.temperature;

  // 严格 compactObject 口径：tools 存在且非空时才写入 tools 与 tool_choice
  if (input.tools && input.tools.length > 0) {
    body.tools = input.tools;
    body.tool_choice = input.toolChoice ?? input.tool_choice ?? 'auto';
  }

  if (input.thinkingTier !== undefined) {
    const patch = buildThinkingRequestBodyPatch({
      format: input.thinkingFormat,
      tier: input.thinkingTier,
    });
    Object.assign(body, patch);
  }

  return body;
}

/** AI 标题长度上限（字符；生成侧 prompt 约束 ≤14 字，此处是消毒侧硬顶） */
export const AI_TITLE_MAX_CHARS = 16;

/** 成对引号（消毒时剥离包裹标题的外层引号，中英混排都覆盖） */
const AI_TITLE_QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
  ['「', '」'],
  ['『', '』'],
];

/**
 * AI 标题消毒（U4）：模型原始输出 → 可落盘标题，异常一律返回 null（视为
 * 生成失败、保留 derived 截断标题）。步骤：整体去空白 → 多行只取首个
 * 非空行 → 剥外层成对引号 → markdownPreviewText 单行纯文本化（标记不进
 * 标题，与列表面 MD3 纪律同源）→ 再剥一次引号（标记剥离后可能新暴露）
 * → 折叠空白 → 硬截断 AI_TITLE_MAX_CHARS 字；任一步骤后为空 → null。
 */
export function sanitizeAiTitle(raw: string): string | null {
  const stripQuotes = (text: string): string => {
    let out = text;
    for (let i = 0; i < 3; i++) {
      const pair = AI_TITLE_QUOTE_PAIRS.find(
        ([open, close]) =>
          out.length > open.length + close.length - 1 &&
          out.startsWith(open) &&
          out.endsWith(close) &&
          out.length > 1
      );
      if (!pair) break;
      out = out.slice(pair[0].length, out.length - pair[1].length).trim();
    }
    return out;
  };
  const firstLine =
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '') ?? '';
  if (firstLine === '') return null;
  const plain = markdownPreviewText(stripQuotes(firstLine))
    .replace(/\s+/g, ' ')
    .trim();
  const cleaned = stripQuotes(plain);
  if (cleaned === '') return null;
  return cleaned.length > AI_TITLE_MAX_CHARS
    ? cleaned.slice(0, AI_TITLE_MAX_CHARS)
    : cleaned;
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

/**
 * 校验 HTTP / HTTPS URL 字符串合法性
 */
export function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 草稿校验纯函数（保存前置守卫）
 * 覆盖根配置、默认模型存在性以及每个模型的容量与价格合法性。
 */
export function validateProviderDraft(
  draft: LocalProviderDraft
): ProviderDraftIssue[] {
  const issues: ProviderDraftIssue[] = [];

  // 1. 基础字段非空与合法性
  if (draft.name.trim() === '' && draft.baseUrl.trim() === '') {
    issues.push('nameEmpty');
  }

  const base = draft.baseUrl.trim();
  if (base === '') {
    issues.push('baseUrlEmpty');
  } else if (!isHttpUrl(base)) {
    issues.push('baseUrlInvalid');
  }

  // 2. 模型清单非空与唯一性
  const models: LocalModelSpec[] = Array.isArray(draft.models)
    ? draft.models
    : Array.isArray(draft.modelIds)
      ? draft.modelIds.map((id: string) => ({ id, enabled: true }))
      : [];

  const fallback = draft.defaultModelId ? draft.defaultModelId.trim() : '';

  // 现代草稿（明确传了 models 数组）：若为空则直接报错
  if (Array.isArray(draft.models) && draft.models.length === 0) {
    issues.push('modelsEmpty');
    issues.push('modelEmpty');
    return issues;
  }
  // 兼容草稿：模型为空且无默认兜底
  if (!Array.isArray(draft.models) && models.length === 0 && fallback === '') {
    issues.push('modelsEmpty');
    issues.push('modelEmpty');
    return issues;
  }

  const seenIds = new Set<string>();
  let hasDuplicate = false;
  for (const m of models) {
    const id = typeof m.id === 'string' ? m.id.trim() : '';
    if (id === '' || seenIds.has(id)) {
      hasDuplicate = true;
    }
    if (id !== '') {
      seenIds.add(id);
    }

    // 3. 模型规格数值合法性校验
    if (
      m.contextWindow !== undefined &&
      (!Number.isInteger(m.contextWindow) || m.contextWindow <= 0)
    ) {
      if (!issues.includes('invalidContextWindow')) {
        issues.push('invalidContextWindow');
      }
    }
    if (
      m.maxOutputTokens !== undefined &&
      (!Number.isInteger(m.maxOutputTokens) || m.maxOutputTokens <= 0)
    ) {
      if (!issues.includes('invalidMaxOutputTokens')) {
        issues.push('invalidMaxOutputTokens');
      }
    }
    if (
      m.contextWindow !== undefined &&
      m.maxOutputTokens !== undefined &&
      m.maxOutputTokens > m.contextWindow
    ) {
      if (!issues.includes('outputExceedsContext')) {
        issues.push('outputExceedsContext');
      }
    }
    if (m.pricing) {
      const inputPrice = m.pricing.inputPricePerMillion ?? m.pricing.input;
      const outputPrice = m.pricing.outputPricePerMillion ?? m.pricing.output;
      if (
        (inputPrice !== undefined && inputPrice < 0) ||
        (outputPrice !== undefined && outputPrice < 0) ||
        (m.pricing.cacheRead !== undefined && m.pricing.cacheRead < 0) ||
        (m.pricing.cacheWrite !== undefined && m.pricing.cacheWrite < 0)
      ) {
        if (!issues.includes('invalidPricing')) {
          issues.push('invalidPricing');
        }
      }
    }
  }

  if (hasDuplicate) {
    issues.push('duplicateModelId');
  }

  // 4. 默认模型必须有效存在于清单中（若清单非空且填了默认模型）
  if (fallback !== '' && models.length > 0 && !seenIds.has(fallback)) {
    issues.push('defaultModelMissing');
  }

  return issues;
}

/** 由 Base URL 主机名派生展示名（名称留空时的兜底，与桌面「用户声明优先」一致） */
export function deriveProviderName(baseUrl: string): string {
  try {
    return new URL(baseUrl.trim()).host;
  } catch {
    return baseUrl.trim();
  }
}

/**
 * 从既有配置实体或厂商预置构建完整草稿（编辑入口）
 */
export function createProviderDraft(
  spec?: LocalProviderSpec | null,
  vendorFallback: LocalVendorKey = 'custom'
): LocalProviderDraft {
  if (!spec) {
    return {
      vendor: vendorFallback,
      name: '',
      baseUrl: '',
      apiKey: '',
      defaultModelId: '',
      models: [],
      modelIds: [],
    };
  }

  const models = Array.isArray(spec.models)
    ? spec.models.map((m) => ({ ...m }))
    : [];

  return {
    vendor: spec.vendor ?? vendorFallback,
    name: spec.displayName ?? '',
    baseUrl: spec.baseUrl ?? '',
    apiKey: '', // 密钥永不回填到草稿明文
    defaultModelId: spec.defaultModelId ?? spec.models[0]?.id ?? '',
    models,
    modelIds: models.map((m) => m.id),
  };
}

/**
 * 从草稿组装持久化规格（保存入口）
 * 彻底保留既有模型的各项高级能力规格，100% 无损落盘
 */
export function providerSpecFromDraft(
  draft: LocalProviderDraft,
  existingSpec?: LocalProviderSpec
): LocalProviderSpec {
  const name = draft.name.trim();

  // 优先取 models 全量规格；若无则容错兼容旧版 modelIds
  let rawModels: LocalModelSpec[];
  if (Array.isArray(draft.models) && draft.models.length > 0) {
    rawModels = draft.models;
  } else if (Array.isArray(draft.modelIds) && draft.modelIds.length > 0) {
    const fallback = draft.defaultModelId.trim();
    const modelIds = mergeModelIds(draft.modelIds, []);
    const merged =
      fallback !== '' && !modelIds.includes(fallback)
        ? [fallback, ...modelIds]
        : modelIds;
    rawModels = merged.map((id) => ({ id, enabled: true }));
  } else if (Array.isArray(draft.models)) {
    rawModels = draft.models;
  } else {
    rawModels = [];
  }

  const defId =
    draft.defaultModelId.trim() ||
    rawModels[0]?.id ||
    existingSpec?.defaultModelId;

  const cleanedModels: LocalModelSpec[] = rawModels.map((m) => ({
    ...m,
    id: m.id.trim(),
    enabled: m.enabled !== false,
  }));

  const spec: LocalProviderSpec = {
    protocol: 'openai/chat',
    stream: existingSpec?.stream ?? true,
    enabled: existingSpec?.enabled ?? true,
    displayName: name !== '' ? name : deriveProviderName(draft.baseUrl),
    baseUrl: normalizeBaseUrl(draft.baseUrl),
    models: cleanedModels,
  };

  if (draft.vendor !== undefined || existingSpec?.vendor !== undefined) {
    spec.vendor = draft.vendor ?? existingSpec?.vendor;
  }
  if (defId) {
    spec.defaultModelId = defId;
  }
  if (existingSpec?.order !== undefined) {
    spec.order = existingSpec.order;
  }
  if (existingSpec?.compat !== undefined) {
    spec.compat = existingSpec.compat;
  }
  if (existingSpec?.latencyMs !== undefined) {
    spec.latencyMs = existingSpec.latencyMs;
  }
  if (existingSpec?.latencyUpdatedAt !== undefined) {
    spec.latencyUpdatedAt = existingSpec.latencyUpdatedAt;
  }
  if (existingSpec?.apiKeyRef !== undefined) {
    spec.apiKeyRef = existingSpec.apiKeyRef;
  }

  return spec;
}

/** 供应商的默认模型：活动选择优先，其次为显式 defaultModelId，最后为清单首个启用模型 */
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
  if (
    typeof provider.defaultModelId === 'string' &&
    provider.defaultModelId.trim() !== '' &&
    provider.models.some((m) => m.id === provider.defaultModelId)
  ) {
    return provider.defaultModelId;
  }
  const first = provider.models.find((m) => m.enabled !== false);
  return first?.id ?? provider.models[0]?.id ?? null;
}

/** 当前生效的供应商 + 模型（无完整选择时返回 null，UI 走未配置态） */
export function resolveActiveSelection(
  config: LocalModelsConfig
): ResolvedSelection | null {
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
          model,
        };
      }
    }
  }
  return null;
}

/**
 * 本地模型视觉能力判定（本地链的模态真源 = 模型 spec 的 modalities）：
 * input 模态含 'image' 才为 true；模型条目不存在、未声明 modalities
 * 或声明里没有 'image' 一律 false——fail-closed：能力未知不直发图片，
 * 由组装层降级为元数据文本（domain/pure/attachments 的 buildRunPayload）。
 */
export function localModelVisionSupported(
  provider: LocalProviderSpec,
  modelId: string
): boolean {
  const spec = provider.models.find((m) => m.id === modelId);
  return spec?.modalities?.input.includes('image') ?? false;
}

// ── 思考档位抽象与跨端方言映射（ThinkingFormat 编译） ──

/**
 * 判定模型与供应商最终生效的思考推理方言（纯函数，fail-closed）。
 *
 * 优先级梯队：
 * 1. 模型级显式覆盖：model?.compat?.thinkingFormat
 * 2. 供应商级显式覆盖：provider.compat?.thinkingFormat
 * 3. 厂商 / 模型特征推断：
 *    - provider.vendor === 'deepseek' 或 model.id 包含 'deepseek' / 'r1' -> 'deepseek'
 *    - provider.vendor === 'anthropic' 或 model.id 包含 'claude' -> 'anthropic'
 *    - provider.vendor === 'google' 或 model.id 包含 'gemini' -> 'gemini'
 *    - model.id 包含 'qwen' -> 'qwen'
 *    - model.id 包含 'glm' -> 'zai'
 *    - provider.vendor === 'openai' 或 model.id 包含 'gpt' / 'o1' / 'o3' -> 'openai'
 * 4. 兜底：'openai'（标准 openai/chat 协议默认）。
 */
export function resolveEffectiveThinkingFormat(
  provider: Pick<
    LocalProviderSpec,
    'vendor' | 'displayName' | 'baseUrl' | 'compat'
  > & { protocol?: string },
  model?: Pick<LocalModelSpec, 'id' | 'compat'> | null
): LocalThinkingFormat {
  // 优先级 1：模型级显式覆盖
  if (model?.compat?.thinkingFormat) {
    return model.compat.thinkingFormat;
  }

  // 优先级 2：供应商级显式覆盖
  if (provider.compat?.thinkingFormat) {
    return provider.compat.thinkingFormat;
  }

  // 优先级 3：厂商 / 模型特征推断
  const mid = (model?.id ?? '').toLowerCase();
  const vendor = provider.vendor;

  if (vendor === 'deepseek' || mid.includes('deepseek') || mid.includes('r1')) {
    return 'deepseek';
  }

  if (vendor === 'anthropic' || mid.includes('claude')) {
    return 'anthropic';
  }

  if (vendor === 'google' || mid.includes('gemini')) {
    return 'gemini';
  }

  if (mid.includes('qwen')) {
    return 'qwen';
  }

  if (mid.includes('glm')) {
    return 'zai';
  }

  if (
    vendor === 'openai' ||
    mid.includes('gpt') ||
    mid.includes('o1') ||
    mid.includes('o3')
  ) {
    return 'openai';
  }

  // 兜底：'openai'（标准 openai/chat 协议默认）
  return 'openai';
}

/**
 * 将任意外部/原型输入的档位字串归一化为标准 LocalThinkingTier
 * 规则：
 * - 'ultra' 归一为 'max'（顶级档位映射为最高上限）
 * - 'x-high' / 'x_high' 归一为 'xhigh'
 * - 'disabled' / 'none' / 'false' 归一为 'off'
 * - 非法输入回退为 'off'
 */
export function normalizeThinkingTier(raw: unknown): LocalThinkingTier {
  if (typeof raw !== 'string') return 'off';
  const s = raw.trim().toLowerCase();
  switch (s) {
    case 'off':
    case 'none':
    case 'disabled':
    case 'false':
      return 'off';
    case 'minimal':
      return 'minimal';
    case 'low':
      return 'low';
    case 'medium':
    case 'auto':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
    case 'x-high':
    case 'x_high':
      return 'xhigh';
    case 'max':
    case 'ultra':
      return 'max';
    default:
      return 'off';
  }
}

export interface ThinkingBuildInput {
  format?: LocalThinkingFormat;
  tier: LocalThinkingTier;
}

/**
 * 根据方言与思考档位编译请求体补丁（纯函数，fail-closed）
 * 支持对象调用 { format, tier } 或双参数调用 (tier, format)
 */
export function buildThinkingRequestBodyPatch(
  tierOrInput: LocalThinkingTier | ThinkingBuildInput,
  formatArg?: LocalThinkingFormat | string
): Record<string, unknown> {
  let format: LocalThinkingFormat | undefined;
  let tier: LocalThinkingTier;

  if (typeof tierOrInput === 'object' && tierOrInput !== null) {
    format = tierOrInput.format;
    tier = tierOrInput.tier;
  } else {
    tier = tierOrInput;
    format = formatArg as LocalThinkingFormat | undefined;
  }

  if (!format || tier === 'off') {
    if (format === 'deepseek') return { thinking: { type: 'disabled' } };
    if (format === 'qwen') return { enable_thinking: false };
    return {};
  }

  switch (format) {
    case 'openai': {
      let effort = 'medium';
      if (tier === 'minimal' || tier === 'low') effort = 'low';
      else if (tier === 'high' || tier === 'xhigh' || tier === 'max')
        effort = 'high';
      return { reasoning_effort: effort };
    }
    case 'deepseek':
      return { thinking: { type: 'enabled' } };
    case 'qwen':
      return { enable_thinking: true };
    case 'zai':
      return { thinking: { type: 'enable' } };
    case 'anthropic': {
      const budgetMap: Record<LocalThinkingTier, number> = {
        off: 0,
        minimal: 1024,
        low: 2048,
        medium: 8192,
        high: 16384,
        xhigh: 32768,
        max: 64000,
      };
      return {
        thinking: {
          type: 'enabled',
          budget_tokens: budgetMap[tier] ?? 8192,
        },
      };
    }
    case 'gemini':
      return {
        thinkingConfig: {
          thinkingLevel: tier === 'low' || tier === 'minimal' ? 'low' : 'high',
        },
      };
    default:
      return {};
  }
}

/**
 * 配置解码纯函数（支持从持久化 JSON / 对象中容错解码出包含全量规格的模型配置）
 * 非法输入回退为空配置，活动模型若指向不存在的供应商或模型则清空为 null
 */
export function decodeLocalModelsConfig(raw: unknown): LocalModelsConfig {
  if (raw === null || raw === undefined) return emptyLocalModelsConfig();
  let parsed: unknown;
  if (typeof raw === 'string') {
    if (raw.trim() === '') return emptyLocalModelsConfig();
    try {
      parsed = JSON.parse(raw);
    } catch {
      return emptyLocalModelsConfig();
    }
  } else if (typeof raw === 'object') {
    parsed = raw;
  } else {
    return emptyLocalModelsConfig();
  }

  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    typeof (parsed as Partial<LocalModelsConfig>).providers !== 'object' ||
    (parsed as Partial<LocalModelsConfig>).providers === null
  ) {
    return emptyLocalModelsConfig();
  }

  const pObj = (parsed as { providers: Record<string, unknown> }).providers;
  const providers: Record<string, LocalProviderSpec> = {};

  for (const [id, spec] of Object.entries(pObj)) {
    if (spec === null || typeof spec !== 'object') continue;
    const s = spec as LocalProviderSpec;

    // 容错清洗模型列表，保留完整能力规格字段
    const cleanedModels: LocalModelSpec[] = Array.isArray(s.models)
      ? s.models
          .filter(
            (m): m is LocalModelSpec =>
              m !== null &&
              typeof m === 'object' &&
              typeof m.id === 'string' &&
              m.id.trim() !== ''
          )
          .map((m) => ({
            ...m,
            id: m.id.trim(),
            enabled: m.enabled !== false,
          }))
      : [];

    providers[id] = {
      ...s,
      protocol: 'openai/chat',
      defaultModelId:
        typeof s.defaultModelId === 'string' && s.defaultModelId.trim() !== ''
          ? s.defaultModelId.trim()
          : cleanedModels[0]?.id,
      models: cleanedModels,
    };
  }

  const activeCandidate = (parsed as { activeModel?: unknown }).activeModel;
  let active: LocalModelRef | null = null;
  if (
    activeCandidate !== null &&
    typeof activeCandidate === 'object' &&
    typeof (activeCandidate as { providerId?: unknown }).providerId ===
      'string' &&
    typeof (activeCandidate as { modelId?: unknown }).modelId === 'string'
  ) {
    const pId = (activeCandidate as { providerId: string }).providerId;
    const mId = (activeCandidate as { modelId: string }).modelId;
    if (providers[pId]?.models.some((m) => m.id === mId)) {
      active = { providerId: pId, modelId: mId };
    }
  }

  return { version: 2, providers, activeModel: active };
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

/** 流式分片增量结构（对齐 OpenAI tool_calls delta 增量） */
export interface LocalToolCallChunkDelta {
  index: number;
  id?: string;
  name?: string;
  argumentsDelta?: string;
}

/** 单个 chat-completions 流式块的解析产物 */
export interface ChatChunkDelta {
  /** 正文增量（delta.content） */
  contentDelta: string;
  /** 思考增量（reasoning_content 等五级探测链命中其一；本地仅作活动信号不展示） */
  reasoningDelta: string;
  /** 本 chunk 包含的流式工具分片 */
  toolCallDeltas: LocalToolCallChunkDelta[];
  /** 本块新出现的 tool_call 名称（按 index 聚合，兼容旧版） */
  toolCallNames: string[];
  /** 结束原因（finish_reason，非空即终块） */
  finishReason: string | null;
}

export {
  StreamingToolCallAccumulator,
  type AccumulatedToolCall,
} from './webSearch/streamingToolCallAccumulator';

/**
 * 解析一个 SSE data 负载（chat-completions chunk JSON）：
 * 对齐桌面 parse/chat/chat_core.rs——delta 可缺失、message 兜底（非流式
 * 形态混入流式时取 message.content / message.tool_calls）。
 * 提取完整的 tool_calls 分片（index, id, name, argumentsDelta）。
 * 非法 JSON / 无 choice → null（跳过该帧）。
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
    toolCallDeltas: [],
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
      for (let i = 0; i < toolCalls.length; i++) {
        const raw = toolCalls[i];
        const call = asRecord(raw);
        if (!call) continue;
        const index = typeof call.index === 'number' ? call.index : i;
        const id = typeof call.id === 'string' ? call.id : undefined;
        const fn = asRecord(call.function);
        const name =
          fn && typeof fn.name === 'string'
            ? fn.name
            : typeof call.name === 'string'
              ? call.name
              : undefined;
        const argsDelta =
          fn && typeof fn.arguments === 'string'
            ? fn.arguments
            : typeof call.arguments === 'string'
              ? call.arguments
              : undefined;

        out.toolCallDeltas.push({
          index,
          id,
          name,
          argumentsDelta: argsDelta,
        });

        if (name) {
          out.toolCallNames.push(name);
        }
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
