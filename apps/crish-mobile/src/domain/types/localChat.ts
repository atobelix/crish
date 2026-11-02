// 本地 AI 对话（手机直连供应商）领域类型。
//
// 与桌面统一模型配置同构（crates/agent-provider/src/models/catalog_types.rs
// 的 UnifiedModelsConfig / ProviderSpec / ModelSpec / ModelRef）：
// - 同字段名（camelCase）、同语义：providers 以 providerId 为键、activeModel
//   为 { providerId, modelId } 二元身份、protocol 为线网协议标识字符串；
// - 凭据同纪律：配置只保存 apiKeyRef（引用），密钥材料本身不进配置——
//   桌面是 dpapi:<槽> / env:<变量名>，移动端对应 secure:<providerId>，
//   实际密钥存 expo-secure-store（src/db/secureStore.ts 的驱动面）。
// 本地裁剪（与桌面的差异，均为有意收敛）：
// - protocol 本期仅落地 'openai/chat'（OpenAI 兼容 Chat Completions，桌面
//   默认协议）；其余三值（openai/responses、anthropic/messages、
//   google/generate-content）是桌面全量协议面，移动端本地对话暂不实现，
//   类型上不预置假值域——落地时按桌面同名扩展；
// - 不含 proxyUrl / headers / compat / pricing / thinking 等桌面进阶面：
//   本地对话定位为「只能对话的助手」，请求侧不声明 tools、不做方言适配。

/** 线网协议标识（桌面 ProtocolKind 的线网字符串；本期仅 openai/chat 落地） */
export type LocalProtocolKind = 'openai/chat';

/** 模型条目（桌面 ModelSpec 的本地子集：身份 + 展示 + 启用位） */
export interface LocalModelSpec {
  /** 模型 id（供应商侧 wire 名，如 gpt-4o、deepseek-chat） */
  id: string;
  /** 展示名（缺省 = id） */
  displayName?: string;
  /** 是否启用（禁用模型不出现在可选列表；缺省视为启用，对齐桌面 enabled 缺省 true） */
  enabled?: boolean;
}

/** 供应商配置（桌面 ProviderSpec 的本地子集） */
export interface LocalProviderSpec {
  /** 展示名（用户自填；缺省时由 baseUrl 主机名派生，见 validateProviderDraft） */
  displayName?: string;
  /** OpenAI 兼容根地址（如 https://api.openai.com/v1；端点归一规则见 localChatProtocol） */
  baseUrl?: string;
  /** 凭据引用：固定形态 secure:<providerId>；密钥材料在 SecureStore 同名槽位 */
  apiKeyRef?: string;
  /** 线网协议（本期恒为 openai/chat；保留字段与桌面同构） */
  protocol: LocalProtocolKind;
  /** 是否流式（桌面同名字段，缺省 true） */
  stream?: boolean;
  /** 是否启用（缺省视为启用） */
  enabled?: boolean;
  /** 模型清单（手填或经 /models 拉取合并） */
  models: LocalModelSpec[];
}

/** 活动模型二元身份（桌面 ModelRef 同形） */
export interface LocalModelRef {
  providerId: string;
  modelId: string;
}

/** 本地模型配置根（桌面 UnifiedModelsConfig 同构，version 同为 2） */
export interface LocalModelsConfig {
  version: 2;
  providers: Record<string, LocalProviderSpec>;
  activeModel: LocalModelRef | null;
}

export function emptyLocalModelsConfig(): LocalModelsConfig {
  return { version: 2, providers: {}, activeModel: null };
}

/** 本地对话消息（OpenAI wire 形态的最小子集：纯文本多轮） */
export interface LocalChatMessage {
  id: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** 流式生成中（assistant 占位消息） */
  streaming?: boolean;
  /** 被用户停止（保留已生成部分，UI 标注「已停止」） */
  stopped?: boolean;
  /** 供应商返回了 tool_calls 但本地不执行（仅计数提示，不伪造结果） */
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

/** 供应商编辑草稿（表单面：models 以 id 列表 + 默认模型表达） */
export interface LocalProviderDraft {
  /** 展示名 */
  name: string;
  /** Base URL 原文（保存时归一） */
  baseUrl: string;
  /** API Key 输入（编辑既有供应商时留空 = 保持原密钥） */
  apiKey: string;
  /** 模型 id 清单（有序、去重） */
  modelIds: string[];
  /** 默认模型 id（须在 modelIds 内或单独手填） */
  defaultModelId: string;
}

/** 草稿校验问题（字段 → 代码；UI 映射中文文案） */
export type ProviderDraftIssue =
  'nameEmpty' | 'baseUrlEmpty' | 'baseUrlInvalid' | 'modelEmpty';

/** 连通性自检结果（最小 chat 请求实测；如实呈现，不伪造） */
export interface LocalConnectivityResult {
  ok: boolean;
  /** 往返耗时（ms） */
  latencyMs: number;
  /** 失败时的分类错误（ok 时为 null） */
  error: LocalChatError | null;
}
