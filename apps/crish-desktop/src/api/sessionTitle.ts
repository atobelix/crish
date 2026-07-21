/**
 * 会话标题工具：默认标题识别 + 从首条用户消息推导 + 空壳会话判定。
 * 自动改名仅在标题仍为默认时触发，保留用户手动 rename。
 *
 * 空壳（ghost）：无实质消息、无子 agent、标题仍为默认、未置顶。
 * 来源：点「新建」未发送、daemon list-sessions 插入、落盘脏数据。
 *
 * 空会话标题规则：只用清晰的「新会话」占位，不发明幽灵标签；
 * 实质标题由首条用户消息 sanitize + 长度截断推导，中文 UTF-8/CJK 安全。
 */

/** 仅依赖消息形状，避免与 layoutStore 循环引用 */
type TitleMessage = {
  sender?: string;
  text?: string;
  /** 有工具调用亦视为实质内容（空 text 的 tool 回合） */
  toolCalls?: unknown[] | null;
  /** 仅有思考内容亦视为实质（水合半成品勿当空壳剪掉） */
  thinking?: string | null;
};
type TitleSession = { title?: string | null; messages?: TitleMessage[] | null };

/** 空壳判定所需的最小会话形状 */
export type ShellSessionLike = {
  id?: string;
  title?: string | null;
  folder?: string;
  messages?: TitleMessage[] | null;
  agents?: unknown[] | null;
  isPinned?: boolean;
  isArchived?: boolean;
};

/**
 * 空壳 / 新建会话的清晰占位标题。
 * 统一用此常量，禁止散落「未命名」「Untitled 会话」等幽灵标签。
 */
export const EMPTY_SESSION_TITLE = '新会话';

/** 侧栏短标题默认最大码点数（与 deriveSessionTitle 默认一致） */
export const SESSION_TITLE_MAX_LEN = 28;

/** 英文/引擎常见占位标题（小写比较） */
const DEFAULT_TITLE_EN = new Set([
  'new session',
  'new chat',
  'new conversation',
  'untitled',
  'untitled session',
  'untitled chat',
  'untitled conversation',
  'session',
  'chat',
  'conversation',
  'no title',
]);

/**
 * 中文默认占位 + 可选编号后缀（` 2` / `-1` / `#3` / `(1)` / `（2）`）。
 * 后缀须含数字，避免「新会话记录」「未命名方案」被 startsWith 误伤。
 * 含「未命名*」幽灵标签，与 Untitled 英文占位对称。
 */
const DEFAULT_TITLE_ZH =
  /^(?:新会话|新对话|会话|无标题|未命名(?:会话|对话|聊天)?)([\s\-#（(]*[\d].*)?$/;

/**
 * 控制符 / 零宽 / 双向 / BOM — 与 sanitize 不可见剥离对齐。
 * 用于「是否有可见正文」判定（firstUser 跳过纯不可见行）。
 */
const TITLE_INVISIBLE_CHARS =
  // eslint-disable-next-line no-control-regex -- intentional sanitization of C0 controls
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g;

/** 定时任务侧栏标题（与 workflowApi.scheduledSessionTitle 产出对齐） */
export function isScheduledSessionTitle(
  title: string | undefined | null
): boolean {
  const t = (title ?? '').trim();
  // 「定时 · 名称」或紧凑「定时·名称」
  return t.startsWith('定时 ·') || t.startsWith('定时·');
}

/** 是否仍是占位 / 默认标题（可安全被首条用户消息覆盖） */
export function isDefaultSessionTitle(
  title: string | undefined | null
): boolean {
  const t = (title ?? '').trim();
  if (!t) return true;
  // 定时占位永非默认（避免误覆盖 / 被当成可复用空壳）
  if (isScheduledSessionTitle(t)) return false;
  // 中文占位：新会话 / 新对话 / 无标题 / 未命名* + 编号（对齐 Untitled-1）
  if (DEFAULT_TITLE_ZH.test(t)) return true;
  const lower = t.toLowerCase();
  if (DEFAULT_TITLE_EN.has(lower)) return true;
  // New Session 1 / Untitled (2) / Chat 3 / No Title 2 / Untitled-1
  if (
    /^(new session|new chat|new conversation|untitled(?:\s+session|\s+chat|\s+conversation)?|session|chat|conversation|no title)([\s\-#（(]*[\d].*)?$/i.test(
      t
    )
  ) {
    return true;
  }
  return false;
}

/** 单条消息是否有可展示的实质内容 */
function messageHasSubstance(m: TitleMessage): boolean {
  if ((m.text || '').trim()) return true;
  if (m.toolCalls && m.toolCalls.length > 0) return true;
  if ((m.thinking || '').trim()) return true;
  return false;
}

/** 会话是否有可列表的实质内容（非空消息或协作 agent） */
export function sessionHasListableContent(s: ShellSessionLike): boolean {
  if (s.messages?.length) {
    for (const m of s.messages) {
      if (messageHasSubstance(m)) return true;
    }
  }
  if (s.agents && s.agents.length > 0) return true;
  return false;
}

/**
 * 幽灵空壳：默认标题 + 无实质消息/agent + 未置顶。
 * 置顶视为用户主动保留，不当空壳丢弃。
 * 定时标题永非空壳（后台 activate:false 占位不得被剪）。
 * 归档会话另走归档筛选，此处仍可判定为壳（hydrate 时剪掉）。
 */
export function isEmptyShellSession(s: ShellSessionLike): boolean {
  if (s.isPinned) return false;
  // 显式保护：即使未来 isDefault 误判，定时标题也不当壳
  if (isScheduledSessionTitle(s.title)) return false;
  if (!isDefaultSessionTitle(s.title)) return false;
  if (sessionHasListableContent(s)) return false;
  return true;
}

/**
 * 侧栏是否展示：
 * - 置顶 / 定时标题 / 有实质内容 / 非默认标题 → 显示
 * - 空壳默认标题 → 不显示（草稿由 PENDING_DRAFT 处理）
 * - activeSessionId 不参与判定（保留签名兼容 filterSidebarSessions）
 * 归档由 filterSidebarSessions 剔除；此处 isArchived 为双重保险。
 */
export function shouldListSessionInSidebar(
  s: ShellSessionLike & { id: string },
  activeSessionId?: string | null
): boolean {
  void activeSessionId;
  if (s.isArchived) return false;
  if (s.isPinned) return true;
  if (isScheduledSessionTitle(s.title)) return true;
  if (sessionHasListableContent(s)) return true;
  if (!isDefaultSessionTitle(s.title)) return true;
  // 空壳默认标题：不显示（草稿由 PENDING_DRAFT 处理）
  return false;
}

/**
 * 去掉非保留的空壳。keepIds 通常含 activeSessionId（当前编辑中的空白会话）。
 */
export function pruneEmptyShellSessions<
  T extends ShellSessionLike & { id: string },
>(sessions: T[], opts?: { keepIds?: Iterable<string> | null }): T[] {
  const keep = new Set(opts?.keepIds || []);
  let changed = false;
  const next = sessions.filter((s) => {
    if (keep.has(s.id)) return true;
    if (!isEmptyShellSession(s)) return true;
    changed = true;
    return false;
  });
  return changed ? next : sessions;
}

/**
 * create / setActive 共用的 keep 集合：
 * - activating=true：只保留 primary（即将成为活动的会话），旧空壳一并剪掉
 * - activating=false：保留 primary + 当前 active（后台建壳不误删用户正在看的空白）
 * - extraKeepIds：额外保留（如并发后台会话），去重后追加
 */
export function shellPruneKeepIds(
  primaryId: string | null | undefined,
  activeSessionId?: string | null,
  opts?: { activating?: boolean; extraKeepIds?: Iterable<string> | null }
): string[] {
  const ids: string[] = [];
  if (primaryId) ids.push(primaryId);
  if (!opts?.activating) {
    if (activeSessionId && activeSessionId !== primaryId) {
      ids.push(activeSessionId);
    }
  }
  if (opts?.extraKeepIds) {
    const seen = new Set(ids);
    for (const id of opts.extraKeepIds) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

// ── 标题推导：sanitize / 长度 / 碰撞 ─────────────────────────────────
// findReusableEmptyShell 已删除（Phase2 / pending-draft ADR：禁止 reuse 空壳；prune 仅 GC）

/**
 * 清洗用户输入为侧栏标题原料（不截断、不回落默认）。
 * - 去掉控制符 / 零宽字符
 * - 空白折叠（含换行、全角空格）
 * - 去掉前导 slash 命令、markdown 标题符、列表符
 * - 去掉首尾引号 / 句末标点噪声
 * 保留 CJK 与 BMP 外码点（emoji 等），UTF-8 中文安全。
 */
export function sanitizeSessionTitleText(
  text: string | null | undefined
): string {
  let s = String(text ?? '');
  // 控制符 / 零宽 / 双向 / BOM（与 firstUser 可见性判定同源）
  s = s.replace(TITLE_INVISIBLE_CHARS, '');
  // 全角空格等空白 → 普通空格再折叠
  s = s.replace(
    /[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/g,
    ' '
  );
  s = s.replace(/\s+/g, ' ').trim();
  // 连续 slash 命令：`/help` `/cmd 正文` → 正文
  s = s.replace(/^(?:\/\S+[ \t]*)+/, '').trim();
  // markdown AT1–H6
  s = s.replace(/^#{1,6}\s+/, '');
  // 有序/无序列表前缀（中文「1、」后常无空格）
  s = s.replace(/^(?:[-*•·]|\d+[.)、])\s*/, '');
  // 首尾中西引号
  s = s.replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, '').trim();
  // 句末标点（标题不必带句号）
  s = s.replace(/[。！？.!?…‥]+$/u, '').trim();
  return s;
}

/**
 * 按 Unicode 码点截断标题（避免 UTF-16 半截 emoji / 代理对）。
 * CJK 与拉丁一视同仁按码点计数；超长追加省略号。
 */
export function truncateSessionTitle(
  text: string,
  maxLen: number = SESSION_TITLE_MAX_LEN
): string {
  const limit =
    Number.isFinite(maxLen) && maxLen > 0
      ? Math.floor(maxLen)
      : SESSION_TITLE_MAX_LEN;
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  // 至少留 1 码点 + …，避免空标题
  const keep = Math.max(1, limit);
  return `${chars.slice(0, keep).join('')}…`;
}

/**
 * 从用户文本清洗出侧栏短标题。
 * 空/纯命令 → EMPTY_SESSION_TITLE（清晰新建标题，非幽灵标签）。
 */
export function deriveSessionTitle(
  text: string,
  maxLen: number = SESSION_TITLE_MAX_LEN
): string {
  const cleaned = sanitizeSessionTitleText(text);
  if (!cleaned) return EMPTY_SESSION_TITLE;
  return truncateSessionTitle(cleaned, maxLen);
}

/**
 * 在已有标题集合中分配不冲突的标题。
 * - base 空/仅空白 → EMPTY_SESSION_TITLE
 * - 无冲突原样返回；冲突则「base 2」「base 3」…（与「新会话 2」编号风格一致）
 * - 中文 base 同样追加半角空格 + 数字，UTF-8 安全
 * - existing 比较时 trim，大小写敏感（中文标题区分）
 */
export function withTitleCollisionSuffix(
  base: string,
  existingTitles: Iterable<string | null | undefined>,
  opts?: { maxAttempts?: number }
): string {
  const raw = String(base ?? '').trim();
  const title = raw || EMPTY_SESSION_TITLE;
  const taken = new Set<string>();
  for (const t of existingTitles) {
    const k = (t ?? '').trim();
    if (k) taken.add(k);
  }
  if (!taken.has(title)) return title;

  const maxAttempts = Math.max(1, opts?.maxAttempts ?? 999);
  for (let n = 2; n < 2 + maxAttempts; n++) {
    const candidate = `${title} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  // 极端耗尽：时间戳后缀，仍可读
  return `${title} ${Date.now()}`;
}

/** 从消息列表取首条用户正文（跳过空白 / 纯不可见控制符） */
export function firstUserMessageText(
  messages: TitleMessage[] | undefined
): string {
  if (!messages?.length) return '';
  for (const m of messages) {
    if (m.sender !== 'user') continue;
    const t = (m.text || '').trim();
    if (!t) continue;
    // 仅控制符 / 零宽 / 双向 → 跳过，找下一条有可见内容的用户消息
    const visible = t.replace(TITLE_INVISIBLE_CHARS, '').trim();
    if (!visible) continue;
    // 保留原文交给 derive（含 slash，由 sanitize 剥）
    return t;
  }
  return '';
}

export type MaybeAutoTitleOpts = {
  /** 若提供，推导结果会避开这些已有标题（碰撞后缀） */
  existingTitles?: Iterable<string | null | undefined> | null;
  /** 排除自身当前标题（避免「与自己碰撞」） */
  excludeTitle?: string | null;
};

/**
 * 若标题仍是默认且已有用户消息，推导新标题；否则返回 null（不改）。
 */
export function maybeAutoTitleFromMessages(
  title: string | undefined | null,
  messages: TitleMessage[] | undefined,
  opts?: MaybeAutoTitleOpts
): string | null {
  if (!isDefaultSessionTitle(title)) return null;
  const first = firstUserMessageText(messages);
  if (!first) return null;
  let next = deriveSessionTitle(first);
  // 无实质正文（纯 slash）且推导回默认 → 不写
  if (isDefaultSessionTitle(next)) return null;

  if (opts?.existingTitles) {
    const exclude = (opts.excludeTitle ?? title ?? '').trim();
    const pool: string[] = [];
    for (const t of opts.existingTitles) {
      const k = (t ?? '').trim();
      if (!k || k === exclude) continue;
      pool.push(k);
    }
    next = withTitleCollisionSuffix(next, pool);
  }

  if (next === (title ?? '').trim()) return null;
  return next;
}

export type FillDefaultTitlesOpts = {
  /** 批量补全时对推导标题去重（同文首条消息 → 「… 2」） */
  resolveCollisions?: boolean;
};

/** 批量补全默认标题（hydrate / seed 用） */
export function fillDefaultSessionTitles<T extends TitleSession>(
  sessions: T[],
  opts?: FillDefaultTitlesOpts
): T[] {
  let changed = false;
  const resolve = Boolean(opts?.resolveCollisions);
  const taken: string[] = [];
  if (resolve) {
    for (const s of sessions) {
      const t = (s.title || '').trim();
      // 仅真实标题占位；默认占位不阻塞碰撞池
      if (t && !isDefaultSessionTitle(t)) taken.push(t);
    }
  }

  const next = sessions.map((s) => {
    const title = maybeAutoTitleFromMessages(
      s.title,
      s.messages || undefined,
      resolve ? { existingTitles: taken, excludeTitle: s.title } : undefined
    );
    if (!title || title === s.title) {
      // 未改时若已是真实标题，确保在池中（多会话同名用户标题）
      if (resolve) {
        const cur = (s.title || '').trim();
        if (cur && !isDefaultSessionTitle(cur) && !taken.includes(cur)) {
          taken.push(cur);
        }
      }
      return s;
    }
    changed = true;
    if (resolve) taken.push(title);
    return { ...s, title };
  });
  return changed ? next : sessions;
}

/**
 * hydrate / setSessions / disk restore 共用：
 * 先从消息补默认标题，再按 active 剪非保留空壳（GC，非 reuse）。
 * - keepIds：显式 opts.keepIds 优先；否则仅 keep 真实 active（activating）
 * - active 为 pending draft 哨兵 `__pending_draft__` 或 null/空 → 不 keep 任何空壳
 * - 非空壳 / 置顶 / 定时真实标题 本就不会被 prune
 * 与侧栏 shouldListSessionInSidebar=false 的幽灵空壳对齐：hydrate 后尽量不残留。
 */
export function prepareSessionsForUi<
  T extends ShellSessionLike & { id: string },
>(
  sessions: T[],
  activeSessionId?: string | null,
  opts?: { keepIds?: Iterable<string> | null }
): T[] {
  const filled = fillDefaultSessionTitles(sessions) as T[];
  // pending draft 哨兵不对应 sessions[] 条目；勿当 keep id（语义收口，避免误 keep）
  // 字符串比较避免 api/sessionTitle → store 依赖；与 draftSession.PENDING_DRAFT_SESSION_ID 对齐
  const active =
    activeSessionId && activeSessionId !== '__pending_draft__'
      ? activeSessionId
      : null;
  const keepIds =
    opts?.keepIds ?? shellPruneKeepIds(active, null, { activating: true });
  return pruneEmptyShellSessions(filled, { keepIds });
}

/**
 * 侧栏展示：优先 session.title；
 * 仍为空/默认时用首条用户消息短标题；再否则 EMPTY_SESSION_TITLE。
 * 展示层兜底，不 dump 长文；默认/幽灵标签一律回落清晰「新会话」。
 */
export function sessionListDisplayTitle(s: TitleSession): string {
  const t = (s.title || '').trim();
  if (t && !isDefaultSessionTitle(t)) return t;
  const derived = maybeAutoTitleFromMessages(t || '', s.messages || undefined);
  if (derived) return derived;
  return EMPTY_SESSION_TITLE;
}
