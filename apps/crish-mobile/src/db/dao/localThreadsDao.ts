// local_threads / local_messages DAO：本地对话多线程历史的持久化真源（CON-4/L2）。
//
// 为什么在 SQLite：本地对话历史是「泄漏仅损失隐私」型数据（M5 §6.1 分层
// 原则，与 approval outbox 同层），且多线程全量 JSON 进 kv/SecureStore 会
// 撞 iOS Keychain 单值上限与 kv 读改写竞态；逐行落 SQLite 是仓内既有口径。
// 凭据纪律：本 DAO 只存 provider/model 二元身份，**不存 apiKeyRef、更不存
// 密钥材料**——发送瞬间经 localChatStore.readApiKey 从 SecureStore 读取。
import type { SqlDriver } from '../driver';
import type {
  LocalChatMessage,
  LocalThreadMeta,
  LocalThreadTitleSource,
} from '@/domain/types/localChat';
import type { ComposerAttachment } from '@/domain/pure/attachments';

// ======================== v6 领域类型定义与模块扩充 ========================

/** 工具执行生命周期状态机 */
export type LocalToolStatus = 'pending' | 'running' | 'success' | 'error';

/** 支持的内置工具类型 */
export type LocalToolType = 'web_search' | 'fetch_url' | 'quickjs_sandbox';

/** 单个工具调用规范（对齐 OpenAI tool_calls 并注入执行态） */
export interface LocalToolCall {
  /** 工具调用唯一标识（如 call_12345 或 native_search_01） */
  id: string;
  /** 工具调用类型，通常为 function */
  type: 'function';
  function: {
    /** 调用的函数名称（如 web_search, fetch_url, run_javascript） */
    name: string;
    /** 入参 JSON 字符串（如 {"query":"React Native 性能优化"}） */
    arguments: string;
  };
  /** 客户端执行状态（用于驱动卡片 Loader 与状态徽章） */
  status: LocalToolStatus;
  /** 工具开始执行时间戳（毫秒） */
  startedAt?: number;
  /** 工具执行完成时间戳（毫秒） */
  completedAt?: number;
  /** 错误信息（status === 'error' 时非空） */
  error?: string;
  /** 工具名称快捷别名 */
  name?: string;
  /** 入参字符串快捷别名 */
  arguments?: string;
  /** 解析后的参数对象（容错） */
  parsedArgs?: Record<string, unknown>;
  /** 兼容执行状态枚举 */
  state?: 'pending' | 'executing' | 'success' | 'failed' | 'denied';
  /** 执行输出结果 */
  result?: string;
  /** 耗时（ms） */
  durationMs?: number;
}

/** 工具执行结果规范 */
export interface LocalToolResult {
  /** 关联的工具调用 ID */
  toolCallId: string;
  /** 工具名称（如 web_search） */
  name: string;
  /** 产出的文本或清洗后的 Markdown/HTML 摘要 */
  content: string;
  /** 是否为执行错误结果 */
  isError?: boolean;
  /** 耗时（毫秒） */
  timingMs?: number;
}

/** 搜索执行阶段枚举 */
export type SearchPhase =
  | 'idle' // 未触发
  | 'searching' // 正在检索关键词（向 Tavily / Google / DuckDuckGo 发起请求）
  | 'reading' // 正在深度抓取与清洗正文（fetch_url 或 Jina Reader）
  | 'analyzing' // 正在整理提炼搜索结果
  | 'done' // 检索与提取完成
  | 'error'; // 搜索异常中断

/** 细粒度搜索状态机 */
export interface LocalSearchState {
  /** 当前阶段 */
  phase: SearchPhase;
  /** 当前正在执行检索的主关键词 */
  currentQuery?: string;
  /** 本轮生成的全部关键词检索历史（用于展示多重检索标签） */
  queryHistory: string[];
  /** 正在抓取或已抓取的网页 URL 清单 */
  fetchedUrls: string[];
  /** 当前正在提供服务的引擎/服务商标识（如 tavily, brave, duckduckgo） */
  activeEngine?: string;
  /** 是否触发了客户端瀑布流降级 */
  isFallback?: boolean;
  /** 降级原因说明（如 "Tavily 配额超限，已自动切换为 DuckDuckGo"） */
  fallbackReason?: string;
  /** 错误信息 */
  error?: string;
  /** 搜索总往返延迟（毫秒） */
  latencyMs?: number;
  /** 命中的有效结果条目数 */
  totalResults?: number;
}

/** 归一化网页引用来源 */
export interface CitationSource {
  /** 引用序号（1-based，对应正文中的 [1], [2]） */
  index: number;
  /** 网页标题 */
  title: string;
  /** 网页源 URL（必须为合法 HTTP/HTTPS 链接） */
  url: string;
  /** 抓取到的核心摘要切片（Snippet） */
  snippet?: string;
  /** 来源站点 Hostname（如 github.com, wikipedia.org） */
  hostname?: string;
  /** 来源站点 Favicon 图标地址 */
  iconUrl?: string;
  /** 提供该结果的搜索引擎（如 tavily, duckduckgo, google） */
  engine?: string;
  /** 网页发布或快照时间 */
  publishedAt?: string;
  /** 正文内容切片（经过 Token 上限截断后的正文 Markdown） */
  content?: string;
}

export type ServerToolVendor = 'google' | 'anthropic' | 'openai' | 'deepseek';

export interface ServerToolDiagnostic {
  vendor: ServerToolVendor;
  /** 原生功能类型：grounding（联网接地） | web_search（原生搜索） | code_execution（云端代码沙箱） */
  capability: 'grounding' | 'web_search' | 'code_execution';
  /** 服务端返回的原始 JSON 元数据（经安全提纯后的无密字符串） */
  rawMetadataJson: string;
  /** 提取出的搜索关键词列表（供 UI 统一呈现） */
  extractedQueries?: string[];
  /** 服务端标记的置信度评分或接地率（0.0 ~ 1.0） */
  groundingScore?: number;
}

// 声明合并：为 LocalChatMessage 扩展 v6 工具调用与搜索持久化字段
declare module '@/domain/types/localChat' {
  interface LocalChatMessage {
    toolCalls?: LocalToolCall[];
    toolResults?: LocalToolResult[];
    searchState?: LocalSearchState;
    citations?: CitationSource[];
    serverToolDiagnostics?: ServerToolDiagnostic[];
  }
}

/** local_threads 行形状（snake_case，与 schema 对齐） */
export interface LocalThreadRow {
  id: string;
  title: string;
  /** 标题来源枚举原文（v4 列；读侧经 coerceTitleSource 收敛） */
  title_source: string;
  preview: string;
  provider_id: string | null;
  model_id: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * 标题来源读侧收敛：库内只应出现四个枚举值；未知值（未来扩展/脏数据）
 * 按存量口径回落 derived（截断标题语义），不让未知字符串污染来源阶梯。
 */
export function coerceTitleSource(raw: string): LocalThreadTitleSource {
  return raw === 'placeholder' || raw === 'ai' || raw === 'user'
    ? raw
    : 'derived';
}

/** local_messages 行形状（snake_case，与 schema 对齐，v6 包含 5 个扩展 JSON 列） */
export interface LocalMessageRow {
  id: string;
  thread_id: string;
  seq: number;
  role: string;
  content: string;
  stopped: number;
  tool_call_count: number | null;
  /** v5 列：图片附件 JSON（ComposerAttachment 落存子集）；NULL = 无 */
  attachments_json: string | null;
  /** v6 列：工具调用列表 JSON；NULL = 无 */
  tool_calls_json?: string | null;
  /** v6 列：工具执行结果列表 JSON；NULL = 无 */
  tool_results_json?: string | null;
  /** v6 列：引用来源列表 JSON；NULL = 无 */
  citations_json?: string | null;
  /** v6 列：细粒度搜索中间状态 JSON；NULL = 无 */
  search_state_json?: string | null;
  /** v6 列：原生服务端诊断元数据 JSON；NULL = 无 */
  server_diagnostics_json?: string | null;
}

/** 行 → 线程元数据 */
export function rowToThreadMeta(row: LocalThreadRow): LocalThreadMeta {
  return {
    id: row.id,
    title: row.title,
    titleSource: coerceTitleSource(row.title_source),
    preview: row.preview,
    modelRef:
      row.provider_id !== null && row.model_id !== null
        ? { providerId: row.provider_id, modelId: row.model_id }
        : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ======================== 健壮纯函数解码器（Robust Pure Decoders） ========================

/**
 * 健壮的 JSON 解析器：损坏数据或非字符串返回 undefined，绝不抛出异常导致整条消息或会话解析失败
 */
export function safeJsonParse<T = unknown>(
  raw: string | null | undefined
): T | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** 工具调用列表反序列化：严密校验每个条目，脏数据剔除，格式错误降级为 undefined */
export function parseToolCalls(
  raw: string | null | undefined
): LocalToolCall[] | undefined {
  const parsed = safeJsonParse<unknown>(raw);
  if (!Array.isArray(parsed)) return undefined;
  const out: LocalToolCall[] = [];
  for (const item of parsed) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as { id?: unknown }).id === 'string' &&
      (item as { function?: unknown }).function
    ) {
      const fnObj = (
        item as { function: { name?: unknown; arguments?: unknown } }
      ).function;
      const statusRaw = (item as { status?: unknown }).status;
      const status: LocalToolStatus =
        statusRaw === 'pending' ||
        statusRaw === 'running' ||
        statusRaw === 'success' ||
        statusRaw === 'error'
          ? statusRaw
          : 'success';
      const startedAt = (item as { startedAt?: unknown }).startedAt;
      const completedAt = (item as { completedAt?: unknown }).completedAt;
      const error = (item as { error?: unknown }).error;

      out.push({
        id: String((item as { id: string }).id),
        type: 'function',
        function: {
          name: String(fnObj.name ?? ''),
          arguments: String(fnObj.arguments ?? '{}'),
        },
        status,
        ...(typeof startedAt === 'number' ? { startedAt } : {}),
        ...(typeof completedAt === 'number' ? { completedAt } : {}),
        ...(typeof error === 'string' ? { error } : {}),
      });
    }
  }
  return out.length > 0 ? out : undefined;
}

/** 引用来源反序列化：确保 URL 为 HTTP/HTTPS 字符串且序号有效 */
export function parseCitations(
  raw: string | null | undefined
): CitationSource[] | undefined {
  const parsed = safeJsonParse<unknown>(raw);
  if (!Array.isArray(parsed)) return undefined;
  const out: CitationSource[] = [];
  for (const item of parsed) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as { url?: unknown }).url === 'string' &&
      (item as { url: string }).url.startsWith('http')
    ) {
      const i = item as {
        index?: unknown;
        title?: unknown;
        url: string;
        snippet?: unknown;
        hostname?: unknown;
        iconUrl?: unknown;
        engine?: unknown;
        publishedAt?: unknown;
        content?: unknown;
      };
      out.push({
        index: typeof i.index === 'number' ? i.index : out.length + 1,
        title: String(i.title ?? '网页引用'),
        url: i.url,
        ...(typeof i.snippet === 'string' ? { snippet: i.snippet } : {}),
        ...(typeof i.hostname === 'string' ? { hostname: i.hostname } : {}),
        ...(typeof i.iconUrl === 'string' ? { iconUrl: i.iconUrl } : {}),
        ...(typeof i.engine === 'string' ? { engine: i.engine } : {}),
        ...(typeof i.publishedAt === 'string'
          ? { publishedAt: i.publishedAt }
          : {}),
        ...(typeof i.content === 'string' ? { content: i.content } : {}),
      });
    }
  }
  return out.length > 0 ? out : undefined;
}

/** 搜索状态机反序列化 */
export function parseSearchState(
  raw: string | null | undefined
): LocalSearchState | undefined {
  const item = safeJsonParse<unknown>(raw);
  if (!item || typeof item !== 'object') return undefined;
  const i = item as {
    phase?: unknown;
    currentQuery?: unknown;
    queryHistory?: unknown;
    fetchedUrls?: unknown;
    activeEngine?: unknown;
    isFallback?: unknown;
    fallbackReason?: unknown;
    error?: unknown;
    latencyMs?: unknown;
    totalResults?: unknown;
  };

  const validPhases: SearchPhase[] = [
    'idle',
    'searching',
    'reading',
    'analyzing',
    'done',
    'error',
  ];
  const phase: SearchPhase =
    typeof i.phase === 'string' && validPhases.includes(i.phase as SearchPhase)
      ? (i.phase as SearchPhase)
      : 'done';

  return {
    phase,
    ...(typeof i.currentQuery === 'string'
      ? { currentQuery: i.currentQuery }
      : {}),
    queryHistory: Array.isArray(i.queryHistory)
      ? i.queryHistory.map(String)
      : [],
    fetchedUrls: Array.isArray(i.fetchedUrls) ? i.fetchedUrls.map(String) : [],
    ...(typeof i.activeEngine === 'string'
      ? { activeEngine: i.activeEngine }
      : {}),
    ...(i.isFallback ? { isFallback: true } : {}),
    ...(typeof i.fallbackReason === 'string'
      ? { fallbackReason: i.fallbackReason }
      : {}),
    ...(typeof i.error === 'string' ? { error: i.error } : {}),
    ...(typeof i.latencyMs === 'number' ? { latencyMs: i.latencyMs } : {}),
    ...(typeof i.totalResults === 'number'
      ? { totalResults: i.totalResults }
      : {}),
  };
}

/** 工具执行结果反序列化 */
export function parseToolResults(
  raw: string | null | undefined
): LocalToolResult[] | undefined {
  const parsed = safeJsonParse<unknown>(raw);
  if (!Array.isArray(parsed)) return undefined;
  const out: LocalToolResult[] = [];
  for (const item of parsed) {
    if (item && typeof item === 'object') {
      const i = item as {
        toolCallId?: unknown;
        name?: unknown;
        content?: unknown;
        isError?: unknown;
        timingMs?: unknown;
      };
      out.push({
        toolCallId: String(i.toolCallId ?? ''),
        name: String(i.name ?? ''),
        content: String(i.content ?? ''),
        ...(typeof i.isError === 'boolean' ? { isError: i.isError } : {}),
        ...(typeof i.timingMs === 'number' ? { timingMs: i.timingMs } : {}),
      });
    }
  }
  return out.length > 0 ? out : undefined;
}

/** 服务端诊断元数据反序列化 */
export function parseServerDiagnostics(
  raw: string | null | undefined
): ServerToolDiagnostic[] | undefined {
  const parsed = safeJsonParse<unknown>(raw);
  if (!Array.isArray(parsed)) return undefined;
  const out: ServerToolDiagnostic[] = [];
  const validVendors: ServerToolVendor[] = [
    'google',
    'anthropic',
    'openai',
    'deepseek',
  ];
  const validCapabilities = ['grounding', 'web_search', 'code_execution'];

  for (const item of parsed) {
    if (item && typeof item === 'object') {
      const i = item as {
        vendor?: unknown;
        capability?: unknown;
        rawMetadataJson?: unknown;
        extractedQueries?: unknown;
        groundingScore?: unknown;
      };
      if (
        typeof i.vendor === 'string' &&
        validVendors.includes(i.vendor as ServerToolVendor) &&
        typeof i.capability === 'string' &&
        validCapabilities.includes(i.capability)
      ) {
        out.push({
          vendor: i.vendor as ServerToolVendor,
          capability: i.capability as ServerToolDiagnostic['capability'],
          rawMetadataJson: String(i.rawMetadataJson ?? '{}'),
          ...(Array.isArray(i.extractedQueries)
            ? { extractedQueries: i.extractedQueries.map(String) }
            : {}),
          ...(typeof i.groundingScore === 'number'
            ? { groundingScore: i.groundingScore }
            : {}),
        });
      }
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * 图片附件 JSON 读侧收敛：只接受「图片 + dataUrl 非空」的条目（与落存
 * 口径一致），损坏/异形数据一律视为无附件——历史可读性优先，绝不因
 * 一条脏附件让整线程消息读不出来。
 */
export function parseMessageAttachments(
  raw: string | null | undefined
): ComposerAttachment[] | undefined {
  const parsed = safeJsonParse<unknown>(raw);
  if (!Array.isArray(parsed)) return undefined;
  const out: ComposerAttachment[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== 'object') continue;
    const a = item as Partial<ComposerAttachment>;
    if (a.kind !== 'image') continue;
    if (typeof a.dataUrl !== 'string' || a.dataUrl === '') continue;
    out.push({
      id: typeof a.id === 'string' ? a.id : '',
      name: typeof a.name === 'string' ? a.name : '',
      kind: 'image',
      dataUrl: a.dataUrl,
      ...(typeof a.sizeBytes === 'number' ? { sizeBytes: a.sizeBytes } : {}),
      ...(typeof a.mime === 'string' ? { mime: a.mime } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

/** 行 → 消息（可选字段按缺省纪律还原：0/null 不写出键） */
export function rowToLocalMessage(row: LocalMessageRow): LocalChatMessage {
  const attachments = parseMessageAttachments(row.attachments_json);
  const toolCalls = parseToolCalls(row.tool_calls_json);
  const toolResults = parseToolResults(row.tool_results_json);
  const citations = parseCitations(row.citations_json);
  const searchState = parseSearchState(row.search_state_json);
  const serverToolDiagnostics = parseServerDiagnostics(
    row.server_diagnostics_json
  );

  return {
    id: row.id,
    role: row.role as LocalChatMessage['role'],
    content: row.content,
    ...(row.stopped === 1 ? { stopped: true } : {}),
    ...(row.tool_call_count !== null
      ? { toolCallCount: row.tool_call_count }
      : {}),
    ...(attachments !== undefined ? { attachments } : {}),
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    ...(toolResults !== undefined ? { toolResults } : {}),
    ...(citations !== undefined ? { citations } : {}),
    ...(searchState !== undefined ? { searchState } : {}),
    ...(serverToolDiagnostics !== undefined ? { serverToolDiagnostics } : {}),
  };
}

/** 全量消息行（hydrate 用：携带 threadId 分组） */
export interface LocalMessageWithThread {
  threadId: string;
  seq: number;
  message: LocalChatMessage;
}

/** 本地线程持久化 DAO 接口 */
export interface LocalThreadsDao {
  /** 全部线程元数据（updated_at 降序，与列表呈现同序） */
  listThreads(): Promise<LocalThreadMeta[]>;
  /** 单线程消息（seq 升序 = 时间线序） */
  listMessages(threadId: string): Promise<LocalChatMessage[]>;
  /** 全部消息（hydrate 一次读齐；按 thread_id、seq 排序供分组） */
  listAllMessages(): Promise<LocalMessageWithThread[]>;
  /** 线程元数据新增/更新（标题/摘要/模型/更新时间） */
  upsertThread(meta: LocalThreadMeta): Promise<void>;
  /** 消息新增/更新（按 id 冲突更新内容与标记：流式收尾回写走此路） */
  saveMessage(
    threadId: string,
    seq: number,
    message: LocalChatMessage
  ): Promise<void>;
  /** 删除线程（事务内连带其全部消息） */
  deleteThread(threadId: string): Promise<void>;
  /** 清空单线程消息（线程本体保留；「清空对话」语义） */
  deleteThreadMessages(threadId: string): Promise<void>;
  /**
   * 删除单线程内 seq >= fromSeq 的消息（重新生成截断语义：丢弃某回答
   * 及其后的 tool 轮次，保留该回答之前的完整上下文）。
   */
  deleteMessagesFrom(threadId: string, fromSeq: number): Promise<void>;
}

const SELECT_THREADS_SQL =
  'SELECT id, title, title_source, preview, provider_id, model_id, created_at, updated_at ' +
  'FROM local_threads ORDER BY updated_at DESC';

const SELECT_MESSAGES_SQL =
  'SELECT id, thread_id, seq, role, content, stopped, tool_call_count, attachments_json, ' +
  'tool_calls_json, tool_results_json, citations_json, search_state_json, server_diagnostics_json ' +
  'FROM local_messages WHERE thread_id = ? ORDER BY seq ASC';

const SELECT_ALL_MESSAGES_SQL =
  'SELECT id, thread_id, seq, role, content, stopped, tool_call_count, attachments_json, ' +
  'tool_calls_json, tool_results_json, citations_json, search_state_json, server_diagnostics_json ' +
  'FROM local_messages ORDER BY thread_id ASC, seq ASC';

const UPSERT_THREAD_SQL =
  'INSERT INTO local_threads (id, title, title_source, preview, provider_id, model_id, created_at, updated_at) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
  'ON CONFLICT(id) DO UPDATE SET title = ?, title_source = ?, preview = ?, provider_id = ?, model_id = ?, updated_at = ?';

const SAVE_MESSAGE_SQL =
  'INSERT INTO local_messages (id, thread_id, seq, role, content, stopped, tool_call_count, attachments_json, ' +
  'tool_calls_json, tool_results_json, citations_json, search_state_json, server_diagnostics_json) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
  'ON CONFLICT(id) DO UPDATE SET content = ?, stopped = ?, tool_call_count = ?, attachments_json = ?, ' +
  'tool_calls_json = ?, tool_results_json = ?, citations_json = ?, search_state_json = ?, server_diagnostics_json = ?';

/** 基于 SqlDriver 的本地线程 DAO 实现 */
export class SqlLocalThreadsDao implements LocalThreadsDao {
  constructor(private readonly driver: SqlDriver) {}

  async listThreads(): Promise<LocalThreadMeta[]> {
    const rows = await this.driver.getAll<LocalThreadRow>(SELECT_THREADS_SQL);
    return rows.map(rowToThreadMeta);
  }

  async listMessages(threadId: string): Promise<LocalChatMessage[]> {
    const rows = await this.driver.getAll<LocalMessageRow>(
      SELECT_MESSAGES_SQL,
      [threadId]
    );
    return rows.map(rowToLocalMessage);
  }

  async listAllMessages(): Promise<LocalMessageWithThread[]> {
    const rows = await this.driver.getAll<LocalMessageRow>(
      SELECT_ALL_MESSAGES_SQL
    );
    return rows.map((row) => ({
      threadId: row.thread_id,
      seq: row.seq,
      message: rowToLocalMessage(row),
    }));
  }

  async upsertThread(meta: LocalThreadMeta): Promise<void> {
    await this.driver.exec(UPSERT_THREAD_SQL, [
      meta.id,
      meta.title,
      meta.titleSource,
      meta.preview,
      meta.modelRef?.providerId ?? null,
      meta.modelRef?.modelId ?? null,
      meta.createdAt,
      meta.updatedAt,
      // ON CONFLICT DO UPDATE 的 SET 参数（顺序接在 VALUES 参数之后）
      meta.title,
      meta.titleSource,
      meta.preview,
      meta.modelRef?.providerId ?? null,
      meta.modelRef?.modelId ?? null,
      meta.updatedAt,
    ]);
  }

  async saveMessage(
    threadId: string,
    seq: number,
    message: LocalChatMessage
  ): Promise<void> {
    // 图片附件落存（v5）：仅非空时写 JSON，其余一律 NULL（与读侧收敛同口径）
    const attachmentsJson =
      message.attachments !== undefined && message.attachments.length > 0
        ? JSON.stringify(message.attachments)
        : null;
    const toolCallsJson =
      message.toolCalls !== undefined && message.toolCalls.length > 0
        ? JSON.stringify(message.toolCalls)
        : null;
    const toolResultsJson =
      message.toolResults !== undefined && message.toolResults.length > 0
        ? JSON.stringify(message.toolResults)
        : null;
    const citationsJson =
      message.citations !== undefined && message.citations.length > 0
        ? JSON.stringify(message.citations)
        : null;
    const searchStateJson =
      message.searchState !== undefined
        ? JSON.stringify(message.searchState)
        : null;
    const diagnosticsJson =
      message.serverToolDiagnostics !== undefined &&
      message.serverToolDiagnostics.length > 0
        ? JSON.stringify(message.serverToolDiagnostics)
        : null;

    await this.driver.exec(SAVE_MESSAGE_SQL, [
      // VALUES 参数 (13 项)
      message.id,
      threadId,
      seq,
      message.role,
      message.content,
      message.stopped === true ? 1 : 0,
      message.toolCallCount ?? null,
      attachmentsJson,
      toolCallsJson,
      toolResultsJson,
      citationsJson,
      searchStateJson,
      diagnosticsJson,
      // ON CONFLICT DO UPDATE SET 参数 (9 项)
      message.content,
      message.stopped === true ? 1 : 0,
      message.toolCallCount ?? null,
      attachmentsJson,
      toolCallsJson,
      toolResultsJson,
      citationsJson,
      searchStateJson,
      diagnosticsJson,
    ]);
  }

  async deleteThread(threadId: string): Promise<void> {
    // 事务内先删消息后删线程：避免半途失败留下孤儿消息行
    await this.driver.withTransaction(async () => {
      await this.driver.exec('DELETE FROM local_messages WHERE thread_id = ?', [
        threadId,
      ]);
      await this.driver.exec('DELETE FROM local_threads WHERE id = ?', [
        threadId,
      ]);
    });
  }

  async deleteThreadMessages(threadId: string): Promise<void> {
    await this.driver.exec('DELETE FROM local_messages WHERE thread_id = ?', [
      threadId,
    ]);
  }

  async deleteMessagesFrom(threadId: string, fromSeq: number): Promise<void> {
    await this.driver.exec(
      'DELETE FROM local_messages WHERE thread_id = ? AND seq >= ?',
      [threadId, fromSeq]
    );
  }
}
