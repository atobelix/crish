export interface CompactionSettings {
  enabled?: boolean;
  reserveTokens?: number;
  keepRecentTokens?: number;
}

export interface BranchSummarySettings {
  reserveTokens?: number;
  skipPrompt?: boolean;
}

export interface ProviderRetrySettings {
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
}

export interface RetrySettings {
  enabled?: boolean;
  maxRetries?: number;
  baseDelayMs?: number;
  provider?: ProviderRetrySettings;
}

export interface TerminalSettings {
  showImages?: boolean;
  imageWidthCells?: number;
  clearOnShrink?: boolean;
  showTerminalProgress?: boolean;
}

export interface ImageSettings {
  autoResize?: boolean;
  blockImages?: boolean;
}

export interface ThinkingBudgetsSettings {
  minimal?: number;
  low?: number;
  medium?: number;
  high?: number;
}

export interface MarkdownSettings {
  codeBlockIndent?: string;
}

export interface WarningSettings {
  anthropicExtraUsage?: boolean;
}

export interface PackageSource {
  source: string;
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
}

export interface Settings {
  customRules?: string[];
  lastChangelogVersion?: string;
  defaultProvider?: string;
  defaultModel?: string;
  /**
   * 思考档位偏好（本机设置；单源 = 描述接口，见 THINKING_LEVEL_IDS 移除说明）。
   *
   * 语义（G8-c / R4 T4.1「显式档位/默认档位区分」）：
   * - 缺省 / 'default' → 跟随引擎侧默认档位（描述接口 derived default_effort，省略不注入）；
   * - 其它字符串 → 尽量透传为显式档位，最终有效性由请求面校验
   *   （T4.1：白名单外显式档位在请求面拒绝，前端不代答）。
   *
   * 不再固化为固定档位集常量（消除前端自造档位表与 Rust 静态表双实现漂移）。
   */
  defaultThinkingLevel?: string;
  theme?: string;
  /** UI / mono font preferences (mirrored in crish_fonts) */
  fonts?: {
    uiFont?: string;
    monoFont?: string;
    monoLigatures?: boolean;
    v?: number;
  };
  compaction?: CompactionSettings;
  branchSummary?: BranchSummarySettings;
  retry?: RetrySettings;
  hideThinkingBlock?: boolean;
  shellPath?: string;
  quietStartup?: boolean;
  shellCommandPrefix?: string;
  npmCommand?: string[];
  collapseChangelog?: boolean;
  enableInstallTelemetry?: boolean;
  enableAnalytics?: boolean;
  /** 是否允许在检测到异常退出时自动收集并发送诊断日志（默认开启，可关闭） */
  enableCrashTelemetry?: boolean;
  packages?: (string | PackageSource)[];
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
  enableSkillCommands?: boolean;
  terminal?: TerminalSettings;
  images?: ImageSettings;
  enabledModels?: string[];
  thinkingBudgets?: ThinkingBudgetsSettings;
  markdown?: MarkdownSettings;
  warnings?: WarningSettings;
  sessionDir?: string;
  httpProxy?: string;
  httpIdleTimeoutMs?: number;
  /** 回答风格（本机偏好；写入 appSettings，下游可订阅） */
  responseStyle?: ResponseStyle;
  /** 发送消息快捷键：enter | ctrlEnter */
  sendShortcut?: string;
  /** 自定义快捷键（键名 → 键值组合） */
  shortcuts?: Record<string, string>;
  /** 优先合并工具标签页（与 layoutStore.tabModeEnabled 双写） */
  tabModeEnabled?: boolean;
  /** 排队发送模式：AI 回复中时，新消息进入队列而不是直接插入对话 */
  queueMode?: boolean;
  /**
   * MCP 工具禁用表：serverId → toolName[]。
   * 写入本机设置；run-task 时下发给引擎，过滤不注入的 MCP 工具。
   */
  mcpDisabledTools?: Record<string, string[]>;
}

/** 回答风格四档（设置 · 个性化） */
export type ResponseStyle = 'minimal' | 'low' | 'medium' | 'high';

/** 语义档位段（透传）——不为档位面板数据源；描述接口白名单才是单源 */
export type ThinkingLevel = string;

/** Demo / layoutStore shape; formal models use providerProfiles. */
export interface ProviderInfo {
  id: string;
  name: string;
  apiKey: string;
  models: string[];
}

/** Demo / RuntimePanel shape; formal has no invented cron list. */
export interface CronJob {
  id: string;
  cronExpression: string;
  prompt: string;
  targetSession: 'current-session' | 'new-session';
  status: 'active' | 'paused';
  nextRun: string;
}

/** Demo / McpSettingsTab mock shape; formal MCP uses mcpApi.McpServerInfo. */
export interface McpServer {
  id: string;
  name: string;
  type: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  status: 'connected' | 'disconnected' | 'connecting';
  tools: string[];
}
