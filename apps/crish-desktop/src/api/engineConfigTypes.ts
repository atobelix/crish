/**
 * Engine config 类型定义（从 engineConfig 拆出，纯结构性）。
 *
 * 保留与原 engineConfig.ts 完全一致的类型导出面，消费方经 hub re-export 消费。
 */

export type EngineLastErrorEntry = {
  kind: string;
  detail: string;
  ts: number;
};

/** 最近诊断条目（wire 形状 F2：ts/level/message） */
export type EngineDiagnosticEntry = {
  ts: number;
  level: string;
  message: string;
};

export type EngineStatus = {
  /**
   * 产品可用性：true = UI 不当作「引擎离线」。
   * 正式版默认 keep-alive：短暂断连 / 重连中仍为 true（永不恐吓离线）。
   */
  ok: boolean;
  /** 底层 WebSocket 当前是否 OPEN（诊断用；不直接驱动 soft-hint） */
  connected?: boolean;
  /** 正在 keep-alive 重连（ok 仍可为 true） */
  reconnecting?: boolean;
  model?: string;
  baseUrl?: string;
  hasApiKey?: boolean;
  credentialMode?: string;
  raw?: Record<string, unknown>;
  error?: string;
  // ── T04.5-2 诊断段（core_get_status wire 形状，缺省 undefined）──
  /** 引擎（session-loop）就绪 */
  engineReady?: boolean;
  /** 会话数据库就绪 */
  dbReady?: boolean;
  /** 搜索索引就绪（文件数 > 0 推断） */
  searchIndexReady?: boolean;
  /** 当前生效日志级别 */
  logLevel?: string;
  /** 日志文件层目录 */
  logDir?: string;
  /** 最近错误（AtomicSlot；None = 无错误记录） */
  lastError?: EngineLastErrorEntry;
  /** 最近诊断（环形 20，最旧在前；展示层自行 reverse） */
  diagnostics?: EngineDiagnosticEntry[];
};

export type EngineConfigUpdate = {
  /**
   * @deprecated PE-07 T07.4（K-01）：明文 key 下线后仅接受 undefined——
   * normalizeEngineConfigUpdate 会剥离任何 apiKey 值（兼容层剥离），
   * 密钥一律经 config_secret_set / config_profile_apply 走 DPAPI。
   * @see config_secret_set / config_profile_apply（DPAPI 凭据槽）
   */
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model?: string | undefined;
  credentialMode?: string | undefined;
  endpoint?: string | undefined;
  stream?: boolean | undefined;
};

/** OpenAI-compatible endpoint kind (daemon-aligned aliases). */
export type EngineEndpointKind = 'auto' | 'responses' | 'chat-completions';

/** Credential modes accepted by desktop → daemon update-config. */
export type EngineCredentialMode = 'direct' | 'auto' | 'account-center';

/**
 * Normalized engine config shell.
 * Optional fields stay undefined when unset — **no** default remote model id.
 */
export type NormalizedEngineConfig = {
  /** @deprecated 明文 key 已下线（K-01）：规范化输出恒不含本字段。@see config_secret_set / config_profile_apply */
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  credentialMode?: EngineCredentialMode;
  endpoint?: EngineEndpointKind;
  stream?: boolean;
};

export type EngineBaseUrlValidation =
  | { ok: true; url: string }
  | { ok: false; error: string };

export type EngineConfigReadiness = {
  hasModel: boolean;
  hasBaseUrl: boolean;
  baseUrlValid: boolean;
  hasApiKey: boolean;
  /** model present and baseUrl either empty or valid http(s) */
  usable: boolean;
  /** model + valid baseUrl + apiKey (or credential that may supply key) */
  ready: boolean;
  empty: boolean;
  partial: boolean;
};
