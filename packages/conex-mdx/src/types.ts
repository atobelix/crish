/**
 * @conex/mdx 公共类型契约（脚手架）
 *
 * 权威规格：
 * - Doc/Block：reference/.../docs/markdown-editor/10-data-format.md
 * - 挂载/Handle：feature-catalog/08-package-modules.md §4
 * - AI 端口：v3-complete/08-ai-ports.md
 *
 * 本文件只冻结宿主集成所需形状；实现迁移时按域拆到 src/types/*（见 ARCHITECTURE.md）。
 */

// ---------------------------------------------------------------------------
// Doc / Block（Doc schema v2）
// ---------------------------------------------------------------------------

/** 稳定块 id，约定 `b_` + base36 */
export type BlockId = string;

export type BlockType =
  | 'paragraph'
  | 'heading'
  | 'bullet_item'
  | 'ordered_item'
  | 'task_item'
  | 'quote'
  | 'code'
  | 'table'
  | 'divider'
  | 'callout'
  | 'file_chip'
  | 'image'
  | 'math'
  | 'mermaid'
  | 'embed';

/** 行内 mark 名（扩展见 10-data-format / 07-extension） */
export type InlineMark =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'code'
  | 'link'
  | string;

export interface TextRun {
  text: string;
  marks?: InlineMark[];
  /** link / wiki 等扩展属性 */
  href?: string;
  title?: string;
}

export interface DocMeta {
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  locale?: string;
  pureGfm?: boolean;
  host?: Record<string, unknown>;
}

/**
 * 统一块形状。类型专有字段扁平挂在 block 上（与 reference vanilla 一致）。
 * 迁移阶段 B 起可再拆 TableBlock 等窄类型。
 */
export interface Block {
  id: BlockId;
  type: BlockType;
  /** 列表嵌套层级，0 起；非列表恒 0 */
  indent: number;
  text?: string;
  runs?: TextRun[];
  level?: 1 | 2 | 3 | 4 | 5 | 6;
  checked?: boolean;
  lang?: string;
  rows?: string[][];
  cells?: unknown[][];
  hasHeader?: boolean;
  align?: Array<'left' | 'center' | 'right' | null>;
  callout?: 'note' | 'tip' | 'important' | 'warning' | 'caution';
  path?: string;
  src?: string;
  alt?: string;
  [key: string]: unknown;
}

/** 文档根（schema version 与包 semver 解耦） */
export interface Doc {
  version: 2;
  blocks: Block[];
  meta?: DocMeta;
}

// ---------------------------------------------------------------------------
// AI 端口（包内不实现模型）
// ---------------------------------------------------------------------------

export type AiApplyStrategy =
  | 'replace_selection'
  | 'insert_below'
  | 'suggest_only';

export interface AiContext {
  selectionText?: string;
  blockIds?: BlockId[];
  markdownSnippet?: string;
  fullMarkdown?: string;
}

export interface AiTextResult {
  text: string;
  strategy?: AiApplyStrategy;
}

export interface AiReviewFinding {
  message: string;
  severity?: 'info' | 'warn' | 'error';
  blockId?: BlockId;
  range?: { start: number; end: number };
}

export interface AiReviewResult {
  findings: AiReviewFinding[];
  summary?: string;
}

export interface AiRewriteRequest {
  context: AiContext;
  intent?: string;
  signal?: AbortSignal;
}

export interface AiSummarizeRequest {
  context: AiContext;
  signal?: AbortSignal;
}

export interface AiContinueRequest {
  context: AiContext;
  prefix?: string;
  signal?: AbortSignal;
}

export interface AiReviewRequest {
  context: AiContext;
  signal?: AbortSignal;
}

/**
 * 宿主注入的 AI 能力。缺省 `undefined` → 相关 UI 隐藏/禁用。
 * 编辑器不 fetch 模型 HTTP。
 */
export interface AiPort {
  rewrite?: (req: AiRewriteRequest) => Promise<AiTextResult>;
  summarize?: (req: AiSummarizeRequest) => Promise<AiTextResult>;
  continue?: (req: AiContinueRequest) => Promise<AiTextResult>;
  review?: (req: AiReviewRequest) => Promise<AiReviewResult>;
}

/** 与规格文档 AiPorts 同义别名 */
export type AiPorts = AiPort;

// ---------------------------------------------------------------------------
// 媒体 / 上传端口
// ---------------------------------------------------------------------------

export interface UploadImageRequest {
  file: File | Blob;
  /** 建议文件名 */
  name?: string;
  signal?: AbortSignal;
  onProgress?: (ratio: number) => void;
}

export interface UploadImageResult {
  /** 写入 MD/块的 URL 或相对路径 */
  url: string;
  alt?: string;
  width?: number;
  height?: number;
}

/**
 * 图片上传端口：包内只做占位与进度钩子，实际上传与鉴权归宿主。
 */
export type UploadImagePort = (
  req: UploadImageRequest,
) => Promise<UploadImageResult>;

export interface MediaPorts {
  uploadImage?: UploadImagePort;
}

// ---------------------------------------------------------------------------
// 挂载选项 / Handle
// ---------------------------------------------------------------------------

export interface EditorFeatures {
  slash?: boolean;
  dnd?: boolean;
  selectionToolbar?: boolean;
  asYouTypeMarks?: boolean;
  tableMerge?: boolean;
  ai?: boolean;
}

export interface EditorExtensions {
  codeHighlight?: boolean;
  math?: boolean;
  mermaid?: boolean;
}

export interface MountOptions {
  /** 初始 Markdown；与 doc 同时存在时 doc 优先（与 reference 一致） */
  markdown?: string;
  initialMarkdown?: string;
  doc?: Doc;
  viewOnly?: boolean;
  readOnly?: boolean;
  density?: 'comfortable' | 'compact';
  autosaveMs?: number;
  placeholder?: string;
  features?: EditorFeatures;
  extensions?: EditorExtensions;
  /** 内容变更（编辑态）；viewOnly 下通常不触发 */
  onChange?: (markdown: string, doc: Doc) => void;
  onAutosave?: (markdown: string, doc: Doc) => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** 文件 chip / 路径链 */
  onOpenPath?: (path: string) => void;
  /** wiki-link 双链标题 */
  onOpenDoc?: (title: string) => void;
  ai?: AiPort | null;
  media?: MediaPorts | null;
  /** 上传简写：等价 media.uploadImage */
  uploadImage?: UploadImagePort;
  /** 兼容 reference：selectionToolbar 顶层旗标 */
  selectionToolbar?: boolean;
  onDebug?: (event: string, payload?: unknown) => void;
}

export interface SetContentOptions {
  /** 是否触发 onChange；宿主外部回写时常用 false */
  emit?: boolean;
  keepHistory?: boolean;
}

/**
 * mount 返回的实例面。W10 scaffold 阶段方法可抛 not-implemented；
 * 契约形状冻结供 Desktop 适配器提前 import type。
 */
export interface MarkdownEditorHandle {
  getMarkdown(): string;
  setMarkdown(md: string, opts?: SetContentOptions): void;
  getDoc(): Doc;
  setDoc(doc: Doc, opts?: SetContentOptions): void;
  flush(): void;
  destroy(): void;
  focus(blockId?: BlockId): void;
  blur(): void;
  isDirty(): boolean;
  undo(): boolean;
  redo(): boolean;
  setReadOnly(ro: boolean): void;
  readonly viewOnly: boolean;
  readonly el: HTMLElement;
}

/** 稳定公共符号名（与 catalog 08 对齐） */
export type MarkdownEditorMountOptions = MountOptions;
