/**
 * UserView 投影（中控 C1）：ModelView / 会话消息 → 用户可见 DTO。
 *
 * 边界：
 * - 纯函数，不写 store / 不回流 ModelView（I-PROJ）。
 * - AI「多看」的内容（thinking、tool raw、system/nudge）进 hiddenBuckets，差集可分类。
 * - UI 消费 visibleText + tool.summary；raw 仅作展开/调试。
 *
 * D2-5：终态「无 visibleText 且无 tools」→ silent complete（见 `silentComplete.ts`）。
 */

import type { MessageToolCall, SessionMessage } from '../store/layoutStore';
import { stripThoughtPlaceholders } from './markdownRenderLite';
import {
  fullToolOutput,
  isPlaceholderToolOutput,
  isTrivialToolOutput,
  toolHumanLabel,
  toolResultPreview,
} from './tool-presentation/toolCardPresenter';

// ── 隐藏桶（ModelView − UserView 差集分类）──────────────────────────

/** 差集桶种类：与中控 §8.4 对齐 */
export type HiddenBucketKind =
  | 'thinking'
  | 'tool_raw'
  | 'system'
  | 'nudge'
  | 'system_nudge';

/** 单条被隐藏内容的可解释记录 */
export type HiddenBucket = {
  kind: HiddenBucketKind;
  /** 关联会话消息 id（若有） */
  sourceMessageId?: string;
  /** 关联 toolCall id（tool_raw 时） */
  sourceToolCallId?: string;
  /** 短预览（便于调试，不进 UserView 正文） */
  preview: string;
  /** 原始字符数 */
  charCount: number;
};

// ── UserView DTO ────────────────────────────────────────────────────

/** 工具卡片：默认摘要；raw 可选（展开 / 调试） */
export type UserViewToolCard = {
  id: string;
  name: string;
  /** 折叠行可见摘要 */
  summary: string;
  /** 是否另有可展开原始输出 */
  hasRaw: boolean;
  /** 原始输出（默认不进可见层；opts.includeToolRaw 时带上） */
  raw?: string;
  status?: MessageToolCall['status'];
};

/** 单条用户可见消息 */
export type UserViewMessage = {
  id: string;
  sender: 'user' | 'assistant';
  /** 用户可见正文（已剥思考占位） */
  visibleText: string;
  /**
   * thinking 是否对用户默认隐藏。
   * true = 仅折叠/桶内；false = UI 可展开展示 preview。
   */
  thinkingHidden: boolean;
  /** 有 thinking 时的预览（截断）；无则省略 */
  thinkingPreview?: string;
  tools: UserViewToolCard[];
  status?: SessionMessage['status'];
  timestamp?: number;
};

/** 投影统计：验收 ModelView ≥ UserView 可见块 */
export type UserViewStats = {
  /** 模型侧块计数（text/thinking/tool/system/nudge） */
  modelBlockCount: number;
  /** 用户可见块计数（消息正文 + 工具摘要卡） */
  userVisibleBlockCount: number;
  /** hiddenBuckets 条数 */
  hiddenCount: number;
};

/** UserView 根 DTO */
export type UserViewDto = {
  messages: UserViewMessage[];
  hiddenBuckets: HiddenBucket[];
  stats: UserViewStats;
};

// ── 引擎侧输入（比 SessionMessage 更宽，含 system/nudge）────────────

/**
 * 引擎/ModelView 风格块：投影输入，不落 store。
 * 与 SessionMessage 并存，便于「给定 engine messages → user DTO」单测。
 */
export type EngineLikeBlock =
  | { type: 'user'; id?: string; text: string }
  | { type: 'assistant_text'; id?: string; text: string }
  | { type: 'thinking'; id?: string; text: string }
  | {
      type: 'tool';
      id: string;
      name: string;
      arguments?: string;
      output?: string;
      status?: MessageToolCall['status'];
      explanation?: string;
      messageId?: string;
    }
  | { type: 'system'; id?: string; text: string }
  | { type: 'nudge'; id?: string; text: string };

export type ProjectToUserViewOptions = {
  /** 默认 true：thinking 进 hidden，不并入 visibleText */
  hideThinking?: boolean;
  /** 默认 true：工具仅摘要；raw 进 tool_raw */
  toolSummaryOnly?: boolean;
  /** 默认 false：DTO.tools 不附带 raw 字符串（仍记 hasRaw / bucket） */
  includeToolRaw?: boolean;
  /** 默认 false：system/nudge 不进 messages，只进 hidden */
  includeSystem?: boolean;
  /** thinking 预览最大字符（默认 240） */
  thinkingPreviewMax?: number;
  /** bucket preview 最大字符（默认 120） */
  bucketPreviewMax?: number;
};

const DEFAULT_OPTS: Required<ProjectToUserViewOptions> = {
  hideThinking: true,
  toolSummaryOnly: true,
  includeToolRaw: false,
  includeSystem: false,
  thinkingPreviewMax: 240,
  bucketPreviewMax: 120,
};

// ── 小工具 ──────────────────────────────────────────────────────────

function resolveOpts(
  opts?: ProjectToUserViewOptions
): Required<ProjectToUserViewOptions> {
  return { ...DEFAULT_OPTS, ...opts };
}

/** 截断预览，避免桶/调试刷屏 */
export function clipPreview(text: string, max: number): string {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)) + '…';
}

function emptyStats(): UserViewStats {
  return { modelBlockCount: 0, userVisibleBlockCount: 0, hiddenCount: 0 };
}

function makeBucket(
  kind: HiddenBucketKind,
  text: string,
  max: number,
  extra?: Pick<HiddenBucket, 'sourceMessageId' | 'sourceToolCallId'>
): HiddenBucket {
  const raw = text || '';
  return {
    kind,
    preview: clipPreview(raw, max),
    charCount: raw.length,
    ...extra,
  };
}

/** 列表身份：返回重复的 message.id（空 = 满足 I-MSG-ID） */
export function listDuplicateMessageIds(
  messages: readonly { id: string }[]
): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const m of messages) {
    const id = (m?.id || '').trim();
    if (!id) continue;
    if (seen.has(id)) dups.add(id);
    else seen.add(id);
  }
  return [...dups];
}

// ── 工具摘要 vs raw ─────────────────────────────────────────────────

/**
 * 从 MessageToolCall 生成 UserView 工具卡 + 可选 tool_raw 桶。
 * 摘要走现有 tool 展示纯函数；raw 仅在「有实质输出且与摘要不同」时计入差集。
 */
export function projectToolCallToUserView(
  tc: MessageToolCall,
  opts?: ProjectToUserViewOptions,
  sourceMessageId?: string
): { card: UserViewToolCard; rawBucket?: HiddenBucket } {
  const o = resolveOpts(opts);
  const summaryParts = [toolHumanLabel(tc), toolResultPreview(tc)].filter(
    (s) => (s || '').trim()
  );
  const summary = summaryParts.join(' · ') || tc.name || 'tool';
  const rawBody = fullToolOutput(tc.output || '');
  const hasSubstantialRaw =
    !!rawBody &&
    !isPlaceholderToolOutput(tc.output) &&
    !isTrivialToolOutput(tc.output) &&
    rawBody.trim() !== summary.trim();

  const card: UserViewToolCard = {
    id: tc.id,
    name: tc.name || 'tool',
    summary,
    hasRaw: hasSubstantialRaw,
    status: tc.status,
  };
  if (o.includeToolRaw && hasSubstantialRaw) {
    card.raw = rawBody;
  }

  let rawBucket: HiddenBucket | undefined;
  if (o.toolSummaryOnly && hasSubstantialRaw) {
    rawBucket = makeBucket('tool_raw', rawBody, o.bucketPreviewMax, {
      sourceMessageId,
      sourceToolCallId: tc.id,
    });
  }
  return { card, ...(rawBucket ? { rawBucket } : {}) };
}

// ── SessionMessage → UserView ───────────────────────────────────────

/**
 * 将单条 SessionMessage 投影为 UserView 消息 + 隐藏桶。
 * 不写回 msg；thinking 默认 hidden。
 */
export function projectSessionMessageToUserView(
  msg: SessionMessage,
  opts?: ProjectToUserViewOptions
): { message: UserViewMessage; hiddenBuckets: HiddenBucket[] } {
  const o = resolveOpts(opts);
  const hiddenBuckets: HiddenBucket[] = [];

  if (msg.sender === 'user') {
    return {
      message: {
        id: msg.id,
        sender: 'user',
        visibleText: (msg.text || '').trim(),
        thinkingHidden: true,
        tools: [],
        ...(msg.status ? { status: msg.status } : {}),
        ...(msg.timestamp != null ? { timestamp: msg.timestamp } : {}),
      },
      hiddenBuckets,
    };
  }

  // 助手：可见正文 = 剥占位后的 text / blocks 文本段
  let visibleText = stripThoughtPlaceholders(msg.text || '').trim();
  if (!visibleText && msg.blocks?.length) {
    visibleText = msg.blocks
      .filter((b) => b.type === 'text' && (b.content || '').trim())
      .map((b) => stripThoughtPlaceholders(b.content || '').trim())
      .filter(Boolean)
      .join('\n\n');
  }

  const thinkingRaw = (msg.thinking || '').trim();
  const isPlaceholderThinking =
    !thinkingRaw ||
    thinkingRaw === '正在处理…' ||
    thinkingRaw === '正在思考中...';
  let thinkingPreview: string | undefined;
  const thinkingHidden = o.hideThinking;

  if (!isPlaceholderThinking) {
    thinkingPreview = clipPreview(thinkingRaw, o.thinkingPreviewMax);
    if (o.hideThinking) {
      hiddenBuckets.push(
        makeBucket('thinking', thinkingRaw, o.bucketPreviewMax, {
          sourceMessageId: msg.id,
        })
      );
    } else if (thinkingRaw && !visibleText.includes(thinkingRaw)) {
      // 显式展示时仍不把 thinking 并入 visibleText（UI 有独立折叠区）
    }
  }

  const tools: UserViewToolCard[] = [];
  for (const tc of msg.toolCalls || []) {
    if (!tc?.id) continue;
    const { card, rawBucket } = projectToolCallToUserView(tc, o, msg.id);
    tools.push(card);
    if (rawBucket) hiddenBuckets.push(rawBucket);
  }

  const message: UserViewMessage = {
    id: msg.id,
    sender: 'assistant',
    visibleText,
    thinkingHidden,
    tools,
    ...(thinkingPreview ? { thinkingPreview } : {}),
    ...(msg.status ? { status: msg.status } : {}),
    ...(msg.timestamp != null ? { timestamp: msg.timestamp } : {}),
  };

  return { message, hiddenBuckets };
}

/**
 * 会话消息列表 → UserView DTO。
 * 同 id 只保留首次（渲染身份 / I-MSG-ID 对齐）。
 */
export function projectSessionMessagesToUserView(
  messages: readonly SessionMessage[],
  opts?: ProjectToUserViewOptions
): UserViewDto {
  const seen = new Set<string>();
  const out: UserViewMessage[] = [];
  const hiddenBuckets: HiddenBucket[] = [];
  let modelBlockCount = 0;

  for (const msg of messages) {
    if (!msg?.id || seen.has(msg.id)) continue;
    seen.add(msg.id);

    // 粗算 ModelView 块：正文 + thinking + 每个 tool
    modelBlockCount += 1;
    if ((msg.thinking || '').trim()) modelBlockCount += 1;
    modelBlockCount += msg.toolCalls?.length ?? 0;

    const { message, hiddenBuckets: buckets } = projectSessionMessageToUserView(
      msg,
      opts
    );
    out.push(message);
    hiddenBuckets.push(...buckets);
  }

  const userVisibleBlockCount =
    out.filter((m) => m.visibleText.trim()).length +
    out.reduce((n, m) => n + m.tools.length, 0);

  return {
    messages: out,
    hiddenBuckets,
    stats: {
      modelBlockCount,
      userVisibleBlockCount,
      hiddenCount: hiddenBuckets.length,
    },
  };
}

// ── Engine-like blocks → UserView ───────────────────────────────────

/**
 * 将引擎风格块序列投影为 UserView。
 * system/nudge 默认进 hidden；assistant_text 聚合到同一 id 或合成 id。
 */
export function projectEngineBlocksToUserView(
  blocks: readonly EngineLikeBlock[],
  opts?: ProjectToUserViewOptions
): UserViewDto {
  const o = resolveOpts(opts);
  const hiddenBuckets: HiddenBucket[] = [];
  const messages: UserViewMessage[] = [];
  let modelBlockCount = 0;

  // 当前未闭合的助手消息（连续 assistant_text / thinking / tool 归并）
  let openAssistant: UserViewMessage | null = null;

  const flushAssistant = () => {
    if (openAssistant) {
      messages.push(openAssistant);
      openAssistant = null;
    }
  };

  const ensureAssistant = (id?: string): UserViewMessage => {
    if (openAssistant) return openAssistant;
    openAssistant = {
      id: id || `assistant-${messages.length}`,
      sender: 'assistant',
      visibleText: '',
      thinkingHidden: o.hideThinking,
      tools: [],
    };
    return openAssistant;
  };

  for (const block of blocks) {
    modelBlockCount += 1;
    switch (block.type) {
      case 'user': {
        flushAssistant();
        messages.push({
          id: block.id || `user-${messages.length}`,
          sender: 'user',
          visibleText: (block.text || '').trim(),
          thinkingHidden: true,
          tools: [],
        });
        break;
      }
      case 'assistant_text': {
        const asst = ensureAssistant(block.id);
        if (block.id) asst.id = block.id;
        const t = stripThoughtPlaceholders(block.text || '').trim();
        asst.visibleText = asst.visibleText
          ? `${asst.visibleText}\n\n${t}`.trim()
          : t;
        break;
      }
      case 'thinking': {
        const asst = ensureAssistant(block.id);
        const th = (block.text || '').trim();
        if (!th) break;
        asst.thinkingPreview = clipPreview(th, o.thinkingPreviewMax);
        asst.thinkingHidden = o.hideThinking;
        if (o.hideThinking) {
          hiddenBuckets.push(
            makeBucket('thinking', th, o.bucketPreviewMax, {
              sourceMessageId: asst.id,
            })
          );
        }
        break;
      }
      case 'tool': {
        const asst = ensureAssistant(block.messageId || block.id);
        const tc = {
          id: block.id,
          name: block.name,
          arguments: block.arguments,
          status: block.status || 'success',
          output: block.output,
          explanation: block.explanation,
        } as MessageToolCall;
        const { card, rawBucket } = projectToolCallToUserView(
          tc,
          o,
          asst.id
        );
        asst.tools.push(card);
        if (rawBucket) hiddenBuckets.push(rawBucket);
        break;
      }
      case 'system': {
        const text = block.text || '';
        if (o.includeSystem) {
          flushAssistant();
          messages.push({
            id: block.id || `system-${messages.length}`,
            sender: 'assistant',
            visibleText: text.trim(),
            thinkingHidden: true,
            tools: [],
          });
        } else {
          hiddenBuckets.push(
            makeBucket('system', text, o.bucketPreviewMax, {
              ...(block.id ? { sourceMessageId: block.id } : {}),
            })
          );
        }
        break;
      }
      case 'nudge': {
        const text = block.text || '';
        // nudge / steering：始终记差集；includeSystem 时也可露出
        const kind: HiddenBucketKind = o.includeSystem ? 'nudge' : 'system_nudge';
        if (o.includeSystem) {
          flushAssistant();
          messages.push({
            id: block.id || `nudge-${messages.length}`,
            sender: 'assistant',
            visibleText: text.trim(),
            thinkingHidden: true,
            tools: [],
          });
          hiddenBuckets.push(
            makeBucket('nudge', text, o.bucketPreviewMax, {
              ...(block.id ? { sourceMessageId: block.id } : {}),
            })
          );
        } else {
          hiddenBuckets.push(
            makeBucket(kind, text, o.bucketPreviewMax, {
              ...(block.id ? { sourceMessageId: block.id } : {}),
            })
          );
        }
        break;
      }
      default:
        break;
    }
  }
  flushAssistant();

  const userVisibleBlockCount =
    messages.filter((m) => m.visibleText.trim()).length +
    messages.reduce((n, m) => n + m.tools.length, 0);

  return {
    messages,
    hiddenBuckets,
    stats: {
      modelBlockCount,
      userVisibleBlockCount,
      hiddenCount: hiddenBuckets.length,
    },
  };
}

// ── 差集分类（给定 ModelView 块 + 已投 UserView）────────────────────

/**
 * 独立差集分类：对比 engine 块与 UserView，产出/校验 hidden buckets。
 * 不依赖 projectEngineBlocks 内部状态，便于「差集可分类」门禁单测。
 *
 * 规则：
 * - thinking → thinking（默认不在 visibleText）
 * - tool 的 raw output（有实质且非摘要）→ tool_raw
 * - system → system
 * - nudge → system_nudge（或 nudge，当 includeSystem）
 * - user / assistant_text 不进 hidden（已是 UserView 可见）
 */
export function classifyHiddenBuckets(
  modelBlocks: readonly EngineLikeBlock[],
  userView: UserViewDto,
  opts?: ProjectToUserViewOptions
): HiddenBucket[] {
  const o = resolveOpts(opts);
  const buckets: HiddenBucket[] = [];

  // UserView 已展示的正文集合（用于避免误把可见正文标 hidden）
  const visibleTexts = new Set(
    userView.messages.map((m) => m.visibleText.trim()).filter(Boolean)
  );

  for (const block of modelBlocks) {
    switch (block.type) {
      case 'thinking': {
        const th = (block.text || '').trim();
        if (!th) break;
        buckets.push(
          makeBucket('thinking', th, o.bucketPreviewMax, {
            ...(block.id ? { sourceMessageId: block.id } : {}),
          })
        );
        break;
      }
      case 'tool': {
        const rawBody = fullToolOutput(block.output || '');
        if (
          rawBody &&
          !isPlaceholderToolOutput(block.output) &&
          !isTrivialToolOutput(block.output)
        ) {
          const summaryCard = userView.messages
            .flatMap((m) => m.tools)
            .find((t) => t.id === block.id);
          const summary = summaryCard?.summary || '';
          if (rawBody.trim() !== summary.trim()) {
            buckets.push(
              makeBucket('tool_raw', rawBody, o.bucketPreviewMax, {
                ...(block.messageId
                  ? { sourceMessageId: block.messageId }
                  : {}),
                sourceToolCallId: block.id,
              })
            );
          }
        }
        break;
      }
      case 'system': {
        const text = block.text || '';
        if (!text.trim()) break;
        // 若被 includeSystem 直接展示，则不记 hidden
        if (o.includeSystem && visibleTexts.has(text.trim())) break;
        buckets.push(
          makeBucket('system', text, o.bucketPreviewMax, {
            ...(block.id ? { sourceMessageId: block.id } : {}),
          })
        );
        break;
      }
      case 'nudge': {
        const text = block.text || '';
        if (!text.trim()) break;
        buckets.push(
          makeBucket(
            o.includeSystem ? 'nudge' : 'system_nudge',
            text,
            o.bucketPreviewMax,
            {
              ...(block.id ? { sourceMessageId: block.id } : {}),
            }
          )
        );
        break;
      }
      case 'user':
      case 'assistant_text':
      default:
        break;
    }
  }
  return buckets;
}

/**
 * 验收辅助：ModelView 块数应 ≥ UserView 可见块数；差集 kind 均属已知桶。
 */
export function assertUserViewDiffClassified(
  modelBlocks: readonly EngineLikeBlock[],
  userView: UserViewDto,
  opts?: ProjectToUserViewOptions
): {
  ok: boolean;
  modelCount: number;
  userVisible: number;
  kinds: HiddenBucketKind[];
  unknownKinds: string[];
} {
  const buckets = classifyHiddenBuckets(modelBlocks, userView, opts);
  const known: HiddenBucketKind[] = [
    'thinking',
    'tool_raw',
    'system',
    'nudge',
    'system_nudge',
  ];
  const kinds = buckets.map((b) => b.kind);
  const unknownKinds = kinds.filter((k) => !known.includes(k));
  const modelCount = modelBlocks.length;
  const userVisible = userView.stats.userVisibleBlockCount;
  const ok =
    modelCount >= userVisible &&
    unknownKinds.length === 0 &&
    listDuplicateMessageIds(userView.messages).length === 0;
  return { ok, modelCount, userVisible, kinds, unknownKinds };
}

// ── Dev-only 调试 export（feature flag）─────────────────────────────

/**
 * 是否启用 UserView 调试导出。
 * - 生产构建（PROD / MODE=production）永远关闭
 * - VITE_USER_VIEW_DEBUG=1 显式打开（含 DEV 预览）
 * - 或 DEV 下 localStorage['crish:userViewDebug']==='1'
 */
export function isUserViewDebugEnabled(): boolean {
  try {
    // Vite 注入；测试环境可能无完整 env 字段
    const env = (import.meta as ImportMeta & { env?: Record<string, unknown> })
      .env;
    if (env?.PROD === true || env?.MODE === 'production') return false;
    if (
      env?.VITE_USER_VIEW_DEBUG === '1' ||
      env?.VITE_USER_VIEW_DEBUG === true
    ) {
      return true;
    }
    // localStorage 开关仅 DEV（或 env 未标记生产时的测试）
    if (env && env.DEV !== true && env.MODE !== 'test') return false;
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem('crish:userViewDebug') === '1';
    }
  } catch {
    /* SSR / 无 storage */
  }
  return false;
}

/**
 * dev-only：将 UserView DTO 打到 console；生产/未开 flag 时 no-op 并原样返回。
 * 不写 ModelView，不改 DTO。
 */
export function debugExportUserView(
  dto: UserViewDto,
  label = 'UserView'
): UserViewDto {
  if (!isUserViewDebugEnabled()) return dto;
  try {
    // eslint-disable-next-line no-console
    console.debug(`[${label}]`, {
      stats: dto.stats,
      hiddenKinds: dto.hiddenBuckets.map((b) => b.kind),
      messageIds: dto.messages.map((m) => m.id),
      dto,
    });
  } catch {
    /* ignore */
  }
  return dto;
}

// ── Debug panel helpers（纯函数；不写 store / ModelView）────────────

/** 各 hidden kind 计数（缺省 kind 不出现） */
export type HiddenBucketKindCounts = Partial<Record<HiddenBucketKind, number>>;

/** 调试面板用摘要（只读投影结果） */
export type UserViewDebugSummary = {
  sessionId?: string;
  sessionTitle?: string;
  /** 投影前会话消息条数（含可能被 dedupe 跳过的） */
  sessionMessageCount: number;
  /** UserView 可见消息条数 */
  userViewMessageCount: number;
  stats: UserViewStats;
  kindCounts: HiddenBucketKindCounts;
  /** 出现过的 kind（稳定排序） */
  hiddenKinds: HiddenBucketKind[];
  /** 验收：ModelView 块 ≥ UserView 可见块 */
  modelGeUser: boolean;
};

const HIDDEN_KIND_ORDER: readonly HiddenBucketKind[] = [
  'thinking',
  'tool_raw',
  'system',
  'nudge',
  'system_nudge',
] as const;

/** 按 kind 统计 hiddenBuckets */
export function countHiddenBucketsByKind(
  buckets: readonly HiddenBucket[]
): HiddenBucketKindCounts {
  const counts: HiddenBucketKindCounts = {};
  for (const b of buckets) {
    if (!b?.kind) continue;
    counts[b.kind] = (counts[b.kind] ?? 0) + 1;
  }
  return counts;
}

/**
 * 从 UserView DTO 生成调试摘要。
 * 纯读；不改 DTO / 不写 ModelView。
 */
export function summarizeUserViewProjection(
  dto: UserViewDto,
  meta?: {
    sessionId?: string;
    sessionTitle?: string;
    sessionMessageCount?: number;
  }
): UserViewDebugSummary {
  const kindCounts = countHiddenBucketsByKind(dto.hiddenBuckets);
  const hiddenKinds = HIDDEN_KIND_ORDER.filter((k) => (kindCounts[k] ?? 0) > 0);
  // 未知 kind 追加在后（防御）
  for (const k of Object.keys(kindCounts) as HiddenBucketKind[]) {
    if (!hiddenKinds.includes(k) && (kindCounts[k] ?? 0) > 0) {
      hiddenKinds.push(k);
    }
  }
  return {
    ...(meta?.sessionId ? { sessionId: meta.sessionId } : {}),
    ...(meta?.sessionTitle ? { sessionTitle: meta.sessionTitle } : {}),
    sessionMessageCount: meta?.sessionMessageCount ?? dto.messages.length,
    userViewMessageCount: dto.messages.length,
    stats: { ...dto.stats },
    kindCounts,
    hiddenKinds,
    modelGeUser:
      dto.stats.modelBlockCount >= dto.stats.userVisibleBlockCount,
  };
}

/** JSON 导出契约标识 */
export const USER_VIEW_PROJECTION_EXPORT_FORMAT =
  'crish-user-view-projection' as const;
export const USER_VIEW_PROJECTION_EXPORT_VERSION = 1 as const;

/**
 * 序列化投影调试 JSON（含摘要 + UserView DTO）。
 * 仅导出 UserView 侧；不回流 ModelView。
 */
export function serializeUserViewProjectionExport(
  dto: UserViewDto,
  meta?: {
    sessionId?: string;
    sessionTitle?: string;
    sessionMessageCount?: number;
    exportedAt?: string;
  }
): string {
  const summary = summarizeUserViewProjection(dto, meta);
  const payload = {
    format: USER_VIEW_PROJECTION_EXPORT_FORMAT,
    version: USER_VIEW_PROJECTION_EXPORT_VERSION,
    exportedAt: meta?.exportedAt ?? new Date().toISOString(),
    sessionId: meta?.sessionId ?? null,
    sessionTitle: meta?.sessionTitle ?? null,
    summary,
    stats: dto.stats,
    hiddenBuckets: dto.hiddenBuckets,
    messages: dto.messages,
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}
