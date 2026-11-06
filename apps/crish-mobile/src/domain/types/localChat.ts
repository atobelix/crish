// 本地 AI 对话（手机直连供应商）领域类型。
//
// 与桌面统一模型配置同构（crates/agent-provider/src/models/catalog_types.rs
// 的 UnifiedModelsConfig / ProviderSpec / ModelSpec / ModelRef）：
// - 同字段名（camelCase）、同语义：providers 以 providerId 为键、activeModel
//   为 { providerId, modelId } 二元身份、protocol 为线网协议标识字符串；
// - 凭据同纪律：配置只保存 apiKeyRef（引用），密钥材料本身不进配置——
//   桌面是 dpapi:<槽> / env:<变量名>，移动端对应 secure:<providerId>，
//   实际密钥存 expo-secure-store（src/db/secureStore.ts 的驱动面）；
// - 完整能力规格同构：包含 contextWindow、maxOutputTokens、modalities、
//   thinking、pricing、compat 等全量能力，支持无损落盘与双向编辑。
import type { ComposerAttachment } from '../pure/attachments';

/**
 * 线网协议标识（桌面 ProtocolKind 的线网字符串）：
 * - 'openai/chat'：OpenAI 兼容 HTTP/SSE（手机直连供应商）；
 * - 'ondevice/gguf'：端侧本机推理（llama.rn + GGUF，O3 落地）——无网络
 *   端点、无密钥，由接线层分发到端侧客户端（onDeviceChatClient）。
 */
export type LocalProtocolKind = 'openai/chat' | 'ondevice/gguf';

/**
 * 官方预置 AI 供应商标识枚举（与桌面及矢量图标库统一规范）。
 * 本处是该类型的唯一声明（O4 收敛：providerPresets 与 vendorLogosData
 * 的独立同名声明已删）。语义边界（O4 裁决）：成员必须是带官方端点、
 * 密钥占位与品牌徽标的「预置厂商」——它键控 PROVIDER_PRESETS /
 * VENDOR_LOGOS_DATA / PRESET_DESCRIPTIONS 三份 Record 全量字典。
 * 端侧内置条目（providerId 'ondevice'）无端点、无密钥、无预置，
 * **不**加入本枚举：加入将被迫给预置字典造空端点假条目（会漏进
 * 供应商向导），或把三份 Record 的完备性契约打穿。端侧条目的
 * vendor 恒为 undefined，路由只认 protocol 'ondevice/gguf'。
 */
export type LocalVendorKey =
  | 'deepseek'
  | 'siliconflow'
  | 'ollama'
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'custom';

/** 结算货币种类强类型（对齐桌面 CurrencyKind） */
export type LocalCurrencyKind = 'CNY' | 'USD';

/** 价格计算基础单位（对齐桌面 PricingUnit） */
export type LocalPricingUnit = 'per_1m_tokens' | 'token';

/**
 * 模型定价规格（对齐桌面 ModelPricingSpec）
 * 数值采用 number 存储；0 代表免费，undefined 代表未配置，严格区分。
 */
export interface LocalPricingSpec {
  /** 结算币种 */
  currency: LocalCurrencyKind;
  /** 计价单位（缺省为 per_1m_tokens） */
  unit?: LocalPricingUnit;
  /** 每单位输入价格（如 1.00 代表 1.0 元 / 1M tokens） */
  input?: number;
  /** 每单位输出价格（如 2.00 代表 2.0 元 / 1M tokens） */
  output?: number;
  /** 每百万 Tokens 输入价格（别名，与 input 等价） */
  inputPricePerMillion?: number;
  /** 每百万 Tokens 输出价格（别名，与 output 等价） */
  outputPricePerMillion?: number;
  /** 每单位缓存命中读取价格 */
  cacheRead?: number;
  /** 每单位缓存创建写入价格 */
  cacheWrite?: number;
}

/**
 * 模态能力规范（对齐桌面 ModalitiesSpec）
 * 输入与输出模态独立声明。
 */
export interface LocalModalitiesSpec {
  /** 输入模态（如 ['text', 'image', 'file']） */
  input: string[];
  /** 输出模态（如 ['text'] 或 ['text', 'image']） */
  output: string[];
}

/** 标准思考强度档位（与桌面 ReasoningEffort.as_str() 纯英文小写严格一致） */
export type LocalThinkingTier =
  'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** 模型级思考能力规范 */
export interface LocalThinkingSpec {
  /** 模型是否支持深度推理 */
  supported: boolean;
  /** 允许用户选择的档位清单（升序排布） */
  availableTiers: LocalThinkingTier[];
  /** 默认思考档位（进入对话时的缺省值） */
  defaultTier: LocalThinkingTier;
}

/** 思考参数 Wire 组装方言（对齐桌面 ThinkingFormat） */
export type LocalThinkingFormat =
  | 'openai' // reasoning_effort: "low" | "medium" | "high"
  | 'deepseek' // thinking: { type: "enabled" | "disabled" }
  | 'qwen' // enable_thinking: boolean
  | 'zai' // thinking: { type: "enable" }
  | 'anthropic' // thinking: { type: "enabled", budget_tokens: number }
  | 'gemini'; // thinkingConfig: { thinkingLevel: ... }

/** Wire 最大 Token 输出字段名方言（对齐桌面 MaxTokensField） */
export type LocalMaxTokensField = 'max_tokens' | 'max_completion_tokens';

/** 网关方言兼容性矩阵（对齐桌面 CompatSpec） */
export interface LocalCompatSpec {
  /** 思考推理参数方言 */
  thinkingFormat?: LocalThinkingFormat;
  /** 生成长度字段名方言 */
  maxTokensField?: LocalMaxTokensField;
  /** 是否支持 developer 角色（不支持时自动降级为 system） */
  supportsDeveloperRole?: boolean;
}

/** 模型条目完整规范（全面扩充，与桌面 ModelSpec 同构） */
export interface LocalModelSpec {
  /** 模型真实 ID（供应商线网标识，如 'deepseek-chat', 'gpt-4o'） */
  id: string;
  /** 展示名（缺省由 id 替代） */
  displayName?: string;
  /** 是否启用（缺省 true；禁用模型不出现在活动选择列表） */
  enabled?: boolean;
  /** 排序权重（数值越小越靠前） */
  order?: number;
  /** 上下文窗口容量（Tokens，如 131072） */
  contextWindow?: number;
  /** 最大输出生成长度（Tokens，如 8192；必须 <= contextWindow） */
  maxOutputTokens?: number;
  /** 模态支持能力（缺省为纯文本） */
  modalities?: LocalModalitiesSpec;
  /** 深度思考能力配置（为 undefined 时代表不支持思考） */
  thinking?: LocalThinkingSpec;
  /** 定价信息（用于估算消耗与展示单价卡片） */
  pricing?: LocalPricingSpec;
  /** 模型级协议方言覆盖（优先级高于供应商级 compat） */
  compat?: LocalCompatSpec;
}

/** 供应商配置（与桌面 ProviderSpec 深度对齐） */
export interface LocalProviderSpec {
  /** 厂商预置标识（驱动官方矢量 Logo 渲染与预置端点映射） */
  vendor?: LocalVendorKey;
  /** 展示名（用户自填；缺省时由 baseUrl 主机名派生） */
  displayName?: string;
  /** OpenAI 兼容根地址（如 https://api.openai.com/v1；端点归一规则见 localChatProtocol） */
  baseUrl?: string;
  /** 凭据引用：固定形态 secure:<providerId>；密钥材料在 SecureStore 同名槽位 */
  apiKeyRef?: string;
  /** 线网协议（openai/chat = 直连供应商；ondevice/gguf = 端侧本机推理） */
  protocol: LocalProtocolKind;
  /** 是否流式响应（桌面同名字段，缺省 true） */
  stream?: boolean;
  /** 是否启用（缺省 true） */
  enabled?: boolean;
  /** 排序权重 */
  order?: number;
  /** 网关兼容性方言矩阵（供应商级默认值） */
  compat?: LocalCompatSpec;
  /**
   * 供应商默认模型 ID
   * 必须对应 models 中的某个模型；切换供应商或新建对话时作为首选
   */
  defaultModelId?: string;
  /** 上次网络连通性测速耗时（ms；null 代表测速失败，undefined 代表未测） */
  latencyMs?: number | null;
  /** 上次测速更新时间戳（毫秒） */
  latencyUpdatedAt?: number;
  /** 模型清单（携带完整能力规格） */
  models: LocalModelSpec[];
}

/** 活动模型二元身份（桌面 ModelRef 同形） */
export interface LocalModelRef {
  providerId: string;
  modelId: string;
}

/** 当前生效的供应商与模型完整选择解析结果（对齐 resolveActiveSelection） */
export interface ResolvedSelection {
  providerId: string;
  provider: LocalProviderSpec;
  modelId: string;
  model: LocalModelSpec;
}

export type ResolvedLocalSelection = ResolvedSelection;

/** 本地模型配置根（桌面 UnifiedModelsConfig 同构，version 恒为 2） */
export interface LocalModelsConfig {
  version: 2;
  providers: Record<string, LocalProviderSpec>;
  activeModel: LocalModelRef | null;
}

export function emptyLocalModelsConfig(): LocalModelsConfig {
  return { version: 2, providers: {}, activeModel: null };
}

/** 工具调用声明（对齐 OpenAI Function Calling Wire 格式） */
export interface LocalWireToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON 字符串
  };
}

/** 本地会话消息扩展字段（存储于 Session Store） */
export interface LocalChatMessageToolCall {
  id: string;
  name: string;
  arguments: string; // 原始 JSON 字符串
  parsedArgs?: Record<string, unknown>; // 解析后的对象（容错）
  state?: 'pending' | 'executing' | 'success' | 'failed' | 'denied';
  result?: string; // 工具执行输出（JSON 或纯文本）
  error?: string; // 错误信息
  durationMs?: number; // 耗时
}

/** 本地对话消息（OpenAI wire 形态：多轮对话 + 图片附件回放 + 工具调用链） */
export interface LocalChatMessage {
  id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /**
   * 随本条用户消息真以 image_url 结构化下发的图片附件（发送时模型
   * 具备视觉能力才落存）：后续轮次组 wire 时凭此回放图片 part。
   * 文本/文件附件不另存——其全部信息已由组装（domain/pure/attachments
   * 的 buildRunPayload）写进 content 的 [附件] 块；降级为元数据注记的
   * 图片同理只留 content，不在此落存（落存记录与真实下发严格一致）。
   */
  attachments?: ComposerAttachment[];
  /** 流式生成中（assistant 占位消息） */
  streaming?: boolean;
  /** 被用户停止（保留已生成部分，UI 标注「已停止」） */
  stopped?: boolean;
  /** 深度思考/思维链内容 */
  reasoning?: string;
  /** 是否正在流式思考中 */
  isThinking?: boolean;
  /** 当 role === 'tool' 时，对应的 tool_call_id */
  toolCallId?: string;
  /** 兼容旧版仅计数提示 */
  toolCallCount?: number;
}

/**
 * 本地对话错误分类（对齐桌面 crates/agent-provider ProviderError 的
 * classify_provider_error 优先级子集；按真实状态码/错误体判定，不糊成一句）。
 */
export type LocalChatErrorKind =
  /** 网络不可达（DNS/连接失败/请求未发出响应） */
  | 'network'
  /** 鉴权失败（HTTP 401/403 或 invalid api key 字样） */
  | 'auth'
  /** 配额/余额耗尽（HTTP 402 或 quota 字样） */
  | 'quota'
  /** 模型不存在（model_not_found / does not exist 等错误体） */
  | 'modelNotFound'
  /** 端点不可用（HTTP 404/405/415 且非模型错误） */
  | 'endpointUnavailable'
  /** 限流（HTTP 429） */
  | 'rateLimit'
  /** 上下文超长（400/422 且错误体命中 context length 字样） */
  | 'contextLength'
  /** 请求不合法（HTTP 400/422 其余） */
  | 'invalidRequest'
  /** 请求体过大（HTTP 413） */
  | 'payloadTooLarge'
  /** 服务端错误（HTTP 5xx） */
  | 'server'
  /** 流式中断（连接建立后流异常终止） */
  | 'stream'
  /** 未配置可用供应商/模型（本地前置校验） */
  | 'notConfigured'
  /** 兜底未知（携带原始信息摘录） */
  | 'unknown';

export interface LocalChatError {
  kind: LocalChatErrorKind;
  /** HTTP 状态码（网络类错误为 null） */
  status: number | null;
  /** 给用户看的中文说明（localChatErrorMessage 生成） */
  message: string;
  /** 供应商错误体摘录（截断后；便于用户自查，不含请求头/密钥） */
  detail?: string;
  /** 是否值得重试（限流/服务端/网络/流中断为 true） */
  retryable: boolean;
  /** 限流建议等待秒数（Retry-After 解析，可空） */
  retryAfterSec?: number;
}

/**
 * 本地线程标题来源（U4 AI 标题，2026-11-02）：来源阶梯
 * placeholder（占位）< derived（首条消息截断派生）< ai（AI 生成）< user（用户改名）。
 * 纪律与桌面 sessionTitle.ts 对齐并扩一个来源值：自动机制只许「升」不许
 * 「降」——user 封顶，AI 迟到结果撞上用户改名必须丢弃；远端会话标题真源在
 * 桌面，移动端不给远端会话起标题，本来源只属于本地线程。
 */
export type LocalThreadTitleSource = 'placeholder' | 'derived' | 'ai' | 'user';

/**
 * 本地线程元数据（L2 多线程形态，2026-11-02 用户裁决推翻 v1「单线程、
 * 历史仅内存」范围）：线程身份 + 列表呈现 + 每线程模型选择。
 * 线程与消息持久化于本机 SQLite（db/dao/localThreadsDao）；API key 材料
 * 永不进线程/消息存储——密钥纪律不变，只存 SecureStore（见 LocalProviderSpec）。
 */
export interface LocalThreadMeta {
  id: string;
  /** 标题（来源见 titleSource；尚无消息时为占位标题） */
  title: string;
  /** 标题来源阶梯（自动标题只升不降，user 封顶永不被覆盖） */
  titleSource: LocalThreadTitleSource;
  /** 末条消息摘要（列表行呈现；尚无消息时为空串） */
  preview: string;
  /** 每线程模型选择（创建时快照全局活动模型；null = 跟随全局活动模型） */
  modelRef: LocalModelRef | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * 供应商编辑草稿（UI 表单与向导交互的真实模型载体）
 * 完整保留每个模型的规格实体，杜绝数据在编辑过程中降级丢失
 */
export interface LocalProviderDraft {
  /** 厂商标识 */
  vendor?: LocalVendorKey;
  /** 展示名 */
  name: string;
  /** Base URL 原文（保存时归一） */
  baseUrl: string;
  /** API Key 输入（编辑时为空代表沿用 SecureStore 原密钥） */
  apiKey: string;
  /** 默认模型 ID（必须在 models 中） */
  defaultModelId: string;
  /** 完整模型规格清单 */
  models?: LocalModelSpec[];
  /**
   * @deprecated 旧草稿过渡兼容字段，新代码一律使用 models
   * @see models
   */
  modelIds: string[];
}

/**
 * 草稿精细化校验问题编码（UI 逐项映射友好文案）
 */
export type ProviderDraftIssueCode =
  | 'nameEmpty'
  | 'baseUrlEmpty'
  | 'baseUrlInvalid'
  | 'modelsEmpty'
  | 'modelEmpty'
  | 'defaultModelMissing'
  | 'duplicateModelId'
  | 'invalidContextWindow'
  | 'invalidMaxOutputTokens'
  | 'outputExceedsContext'
  | 'invalidPricing';

export type ProviderDraftIssue = string;

/** 连通性自检结果（最小 chat 请求实测；如实呈现，不伪造） */
export interface LocalConnectivityResult {
  ok: boolean;
  /** 往返耗时（ms） */
  latencyMs: number;
  /** 失败时的分类错误（ok 时为 null） */
  error: LocalChatError | null;
}
