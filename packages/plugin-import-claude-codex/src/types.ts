/**
 * 官方导入插件（Claude Code / Codex）中立载荷类型。
 *
 * 设计约束：本文件不依赖宿主 store/types 或任何 UI 层——插件包内定义
 * 「中立载荷」（SessionImportPayload / ImportMessageDraft 等），宿主侧
 * 再做 draft → SessionMessage 适配。fixtures 只使用合成文本，绝不记录
 * 消息正文（隐私约束与宿主层一致）。
 */

/** 支持的来源；`'codex-cli'` 为别名，解析层接受、规范化为 `'codex'`。 */
export type ExternalSessionSource = 'claude-code' | 'codex' | 'codex-cli';

/** 规范来源（解析结果只用两种）。 */
export type ImportSource = 'claude-code' | 'codex';

/** 规范化别名 → 规范来源。 */
function canonicalSource(source: ExternalSessionSource): ImportSource {
  return source === 'claude-code' ? 'claude-code' : 'codex';
}

/** 来源展示文案（宿主 UI 直接消费）。 */
export function externalSourceLabel(source: ExternalSessionSource): string {
  return canonicalSource(source) === 'claude-code'
    ? 'Claude Code'
    : 'Codex CLI';
}

// ---------------------------------------------------------------------------
// 解析层载荷（parse* → map）
// ---------------------------------------------------------------------------

/** 工具调用草稿（中立，无宿主字段）。 */
export type ImportToolCallDraft = {
  id: string;
  name: string;
  arguments?: string;
  output?: string;
  isError?: boolean;
  status?: 'success' | 'error' | 'running';
};

/** 可嵌入预览的图片（http(s) 或 data URL）。 */
export type ImportImageDraft = {
  id: string;
  url: string;
  mime?: string;
};

/** 原文顺序片段：思考 / 正文 / 工具锚点。 */
export type ImportTurnSegment =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string };

/** 单轮消息草稿（角色 + 文本/思考/工具调用 + 时间线块）。 */
export type ImportMessageDraft = {
  id: string;
  role: 'user' | 'assistant';
  text?: string;
  thinking?: string;
  timestampMs: number;
  toolCalls?: ImportToolCallDraft[];
  images?: ImportImageDraft[];
  blocks?: Array<{
    type: 'text' | 'tool_call' | 'thought';
    id?: string;
    content?: string;
  }>;
};

/** 规范化的外部会话单轮（解析层中间形态）。 */
export type NormalizedImportTurn = {
  id: string;
  role: 'user' | 'assistant';
  text?: string;
  thinking?: string;
  timestampMs: number;
  /** 思考、正文、工具的原文顺序。缺省时映射层仍按旧字段兜底。 */
  segments?: ImportTurnSegment[];
  images?: ImportImageDraft[];
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments?: string;
    output?: string;
    isError?: boolean;
    status?: 'success' | 'error' | 'running';
  }>;
};

/** 解析后的外部会话（源格式无关的中间载荷）。 */
export type ParsedExternalConversation = {
  source: ImportSource;
  sourceSessionId: string;
  title?: string;
  cwd?: string;
  createdAtMs?: number;
  turns: NormalizedImportTurn[];
  warnings: string[];
  lineCount: number;
  skippedLineCount: number;
};

/** mapToCrishSession 选项（纯函数，无宿主依赖）。 */
export type MapToCrishSessionOptions = {
  sourcePath: string;
  sessionId?: string;
  title?: string;
  folder?: string;
  nowMs?: number;
  idFactory?: () => string;
};

/**
 * 会话导入载荷（插件工具的标准出参，E3 中立契约）。
 * 消息为 ImportMessageDraft[]，宿主侧经适配转为 SessionMessage[] 后写库。
 */
export type SessionImportPayload = {
  source: ImportSource;
  sourcePath: string;
  sourceSessionId: string;
  sessionId: string;
  title: string;
  folder: string;
  timestamp: string;
  messages: ImportMessageDraft[];
  createdAtMs?: number;
  warnings: string[];
};

// ---------------------------------------------------------------------------
// 探测层载荷（detect 纯函数 + FS 注入面）
// ---------------------------------------------------------------------------

/** 路径环境提示（home / 自定义根目录 / 平台分隔符），可注入便于测试。 */
export type ImportPathEnv = {
  home?: string;
  claudeConfigDir?: string;
  codexHome?: string;
  platform?: string;
  sep?: '\\' | '/';
};

/** 默认探测根目录集合。 */
export type ExternalImportRoots = {
  home: string;
  claudeConfig: string;
  claudeProjects: string;
  codexHome: string;
  codexSessions: string;
};

/** 目录条目（宿主 FS 适配层返回）。 */
export type ImportDirEntry = {
  name: string;
  isDir: boolean;
  size?: number;
  modified?: string | number;
  path: string;
};

/**
 * 只读 FS 注入面（探测层不直接碰 Tauri；宿主实现注入）。
 * 遵守「依赖全注入」原则：插件包不 import 任何宿主 FS。
 */
export type ImportFs = {
  listDir: (dirPath: string, allowRoot: string) => Promise<ImportDirEntry[]>;
  readText: (
    filePath: string,
    allowRoot: string,
    opts?: { maxBytes?: number; maxLines?: number }
  ) => Promise<{ content: string; truncated: boolean; path: string }>;
  exists?: (path: string, allowRoot: string) => Promise<boolean>;
};

/** 探测结果元数据（比 UI 行更丰富）。 */
export type ExternalSessionMeta = {
  source: ImportSource;
  path: string;
  sourceSessionId: string;
  titlePreview: string;
  projectLabel?: string;
  cwd?: string;
  mtimeMs?: number;
  createdAtMs?: number;
  fileSize?: number;
  messageCountEstimate: number;
};

/** detectExternalSessions 选项。 */
export type DetectExternalSessionsOptions = {
  fs: ImportFs;
  env?: ImportPathEnv;
  limit?: number;
  liteReadBytes?: number;
  sources?: Array<'claude-code' | 'codex'>;
  maxFileSizeBytes?: number;
};

/** detectExternalSessions 结果。 */
export type DetectExternalSessionsResult = {
  roots: ExternalImportRoots;
  sessions: ExternalSessionMeta[];
  errors: string[];
  warnings: string[];
};
