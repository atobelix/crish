/**
 * 斜杠命令解析：纯函数，无 store / 网络副作用。
 * useChatStream 只负责执行副作用（开面板、写规则、开流）。
 *
 * 路径分层：
 * - navigation（schedule/teamwork/browser）：只开面板/切标签；不建会话、不进对话流、成功不 toast
 * - local side-effect（learn）：校验通过后写规则 + 时间线；缺参/失败才 toast，不 setRunNotice
 * - conversation（goal/grill-me/skill）：改写 modelText 后走正常流；失败只 toast，不 setRunNotice
 *
 * 本模块只做解析与分类；绝不 createSession / 不写 store（防幽灵会话）。
 */

export type SlashCommandKind =
  | 'schedule'
  | 'teamwork-preview'
  | 'browser'
  | 'learn'
  | 'goal'
  | 'grill-me'
  | 'skill'
  | 'compact'
  | 'none';

/** none 细分：纯文本 / 空斜杠 / 未注册命令（kind 仍为 none，保持调用方兼容） */
export type SlashNoneReason = 'plain' | 'empty' | 'unknown';

export type ResolvedSlashCommand =
  | { kind: 'none'; raw: string; noneReason?: SlashNoneReason }
  | { kind: 'schedule' }
  | { kind: 'teamwork-preview' }
  | { kind: 'browser'; url: string }
  | { kind: 'learn'; rule: string; missingArg?: boolean }
  | { kind: 'goal'; goal: string; missingArg?: boolean }
  | { kind: 'grill-me'; topic: string; missingArg?: boolean }
  | {
      kind: 'skill';
      raw: string;
      /** `name` + 可选参数，原样（trim 后） */
      skillRest: string;
      /** 技能名（第一个空白前的 token） */
      skillName?: string;
      /** 技能参数（name 之后） */
      skillArgs?: string;
    }
  | {
      kind: 'compact';
      /** 可选目标 token 数（缺省 = window - reserve，与引擎预检同口径） */
      tokens?: number;
      /** 参数非法（非正整数）→ 前端 toast 用法，不调引擎 */
      invalidArg?: boolean;
    };

// ─── 命令表（英文主 token + 中文/别名）────────────────────────────────────

type ArgField = 'none' | 'url' | 'rule' | 'goal' | 'topic' | 'tokens';

type SlashSpec = {
  kind: Exclude<SlashCommandKind, 'none' | 'skill'>;
  /** 菜单/文档主 token（不含 /） */
  token: string;
  /** 额外别名（不含 /；含中文） */
  aliases: readonly string[];
  arg: ArgField;
};

/**
 * 已实现的斜杠规格（skill 用冒号语法，单独处理）。
 * aliases 按「更长短语优先」在构建时排序匹配。
 */
export const SLASH_COMMAND_SPECS: readonly SlashSpec[] = [
  {
    kind: 'schedule',
    token: 'schedule',
    aliases: ['定时', '定时任务'],
    arg: 'none',
  },
  {
    kind: 'teamwork-preview',
    token: 'teamwork',
    aliases: ['teamwork-preview', '协作', '看板'],
    arg: 'none',
  },
  {
    kind: 'browser',
    token: 'browser',
    aliases: ['浏览', '浏览器'],
    arg: 'url',
  },
  {
    kind: 'learn',
    token: 'learn',
    aliases: ['学习', '记住'],
    arg: 'rule',
  },
  {
    kind: 'goal',
    token: 'goal',
    aliases: ['目标'],
    arg: 'goal',
  },
  {
    kind: 'grill-me',
    token: 'grill-me',
    aliases: ['grillme', '拷问', '对齐'],
    arg: 'topic',
  },
  // E2 F4：手动压缩（可选目标 token 数；缺省 = window - reserve）
  {
    kind: 'compact',
    token: 'compact',
    aliases: ['压缩', 'compress'],
    arg: 'tokens',
  },
] as const;

/** 英文主 token 列表（菜单过滤等） */
export const KNOWN_SLASH_TOKENS: readonly string[] = [
  ...SLASH_COMMAND_SPECS.map((s) => s.token),
  'skill',
];

/** skill 冒号前缀别名（/skill:… 与 /技能:…） */
const SKILL_COLON_ALIASES = ['skill', '技能'] as const;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isAsciiToken(token: string): boolean {
  // eslint-disable-next-line no-control-regex -- 有意按 ASCII 范围校验 token
  return /^[\x00-\x7F]+$/.test(token);
}

/** 全角斜杠 → 半角，便于中文输入法 */
function normalizeSlashInput(input: string): string {
  const t = (input ?? '').trim();
  if (!t) return '';
  if (t[0] === '／') return `/${t.slice(1)}`;
  return t;
}

type AliasEntry = {
  alias: string;
  kind: Exclude<SlashCommandKind, 'none' | 'skill'>;
  arg: ArgField;
};

/** 长别名优先，避免「定时」抢先于「定时任务」 */
const ALIAS_ENTRIES: readonly AliasEntry[] = (() => {
  const entries: AliasEntry[] = [];
  for (const spec of SLASH_COMMAND_SPECS) {
    const names = [spec.token, ...spec.aliases];
    for (const alias of names) {
      entries.push({ alias, kind: spec.kind, arg: spec.arg });
    }
  }
  entries.sort((a, b) => b.alias.length - a.alias.length);
  return entries;
})();

/**
 * 尝试匹配一条别名，返回剩余参数串；未匹配返回 null。
 * - ASCII：`\b` 边界（与历史 `/goal` 不吞 `/goals` 一致；允许 `/goal:x` 类后继）
 * - 中文：后继须为空白 / 结尾 / 半角或全角冒号（IME 常出「目标：xxx」）；
 *   禁止 `/目标foo` 半截匹配；前导 `:`/`：` 作分隔剥掉
 */
function matchAlias(raw: string, alias: string): string | null {
  const esc = escapeRegExp(alias);
  if (isAsciiToken(alias)) {
    const re = new RegExp(`^/${esc}\\b`, 'i');
    if (!re.test(raw)) return null;
    return raw.replace(re, '').trim();
  }
  // 中文 token 无 \b；允许空白、结尾、冒号分隔（含全角：）
  const re = new RegExp(`^/${esc}(?=\\s|$|[:：])`);
  if (!re.test(raw)) return null;
  let rest = raw.replace(re, '').trim();
  rest = rest.replace(/^[:：]+/, '').trim();
  return rest;
}

function splitSkillRest(rest: string): {
  skillName: string;
  skillArgs: string;
} {
  const t = rest.trim();
  if (!t) return { skillName: '', skillArgs: '' };
  const sp = t.search(/\s/);
  if (sp < 0) return { skillName: t, skillArgs: '' };
  return { skillName: t.slice(0, sp), skillArgs: t.slice(sp).trim() };
}

function withArg(
  kind: 'browser' | 'learn' | 'goal' | 'grill-me' | 'compact',
  args: string
): ResolvedSlashCommand {
  if (kind === 'browser') {
    return { kind: 'browser', url: args };
  }
  if (kind === 'learn') {
    return args
      ? { kind: 'learn', rule: args }
      : { kind: 'learn', rule: '', missingArg: true };
  }
  if (kind === 'goal') {
    return args
      ? { kind: 'goal', goal: args }
      : { kind: 'goal', goal: '', missingArg: true };
  }
  if (kind === 'compact') {
    // 可选参数：正整数 → tokens；非法值 → invalidArg（前端 toast 用法）
    const trimmed = args.trim();
    if (!trimmed) return { kind: 'compact' };
    const tokens = Number(trimmed);
    if (!Number.isSafeInteger(tokens) || tokens <= 0) {
      return { kind: 'compact', invalidArg: true };
    }
    return { kind: 'compact', tokens };
  }
  // grill-me
  return args
    ? { kind: 'grill-me', topic: args }
    : { kind: 'grill-me', topic: '', missingArg: true };
}

/**
 * 解析用户输入中的 slash 命令（不含技能正文注入与异步发现）。
 * 空串 / 非 / 开头 → none(plain)。
 * 仅 `/` → none(empty)。
 * `/未知` → none(unknown)（仍 kind=none，发送路径可当普通文本，不在此建会话）。
 */
export function resolveSlashCommand(input: string): ResolvedSlashCommand {
  const raw = normalizeSlashInput(input);
  if (!raw) {
    return { kind: 'none', raw: '', noneReason: 'plain' };
  }
  if (raw[0] !== '/') {
    return { kind: 'none', raw, noneReason: 'plain' };
  }

  // 空斜杠：`/` 或 `/` + 空白
  if (raw === '/' || /^\/\s+$/.test(raw)) {
    return { kind: 'none', raw: '/', noneReason: 'empty' };
  }

  // /skill:name args 与 /技能:name args（半角/全角冒号，IME 常出全角：）
  for (const sk of SKILL_COLON_ALIASES) {
    const re = new RegExp(`^/${escapeRegExp(sk)}[:：]`, 'i');
    if (re.test(raw)) {
      const skillRest = raw.replace(re, '').trim();
      const { skillName, skillArgs } = splitSkillRest(skillRest);
      return { kind: 'skill', raw, skillRest, skillName, skillArgs };
    }
  }

  for (const entry of ALIAS_ENTRIES) {
    const args = matchAlias(raw, entry.alias);
    if (args === null) continue;
    if (entry.arg === 'none') {
      // 导航类忽略尾参，纯开面板
      if (entry.kind === 'schedule') return { kind: 'schedule' };
      return { kind: 'teamwork-preview' };
    }
    return withArg(
      entry.kind as 'browser' | 'learn' | 'goal' | 'grill-me' | 'compact',
      args
    );
  }

  return { kind: 'none', raw, noneReason: 'unknown' };
}

/**
 * 纯导航 slash：只开面板 / 切标签。
 * 调用方必须：不 createSession、不进主对话流、成功路径不 toast。
 * （维度三 §2.6：/schedule 移出导航——对话流编排助手命令，见 isConversationSlash）
 */
export function isNavigationSlash(kind: SlashCommandKind): boolean {
  return kind === 'teamwork-preview' || kind === 'browser';
}

/**
 * 本地副作用 slash（含导航 + learn）：不进 runNotice 错误流。
 * 其中导航子类见 isNavigationSlash（绝不建会话）。
 */
export function isSideEffectSlash(kind: SlashCommandKind): boolean {
  return isNavigationSlash(kind) || kind === 'learn';
}

/**
 * 是否为「对话内」命令（schedule/goal/grill-me/skill），而非纯导航。
 * （维度三 §2.6：/schedule 归入对话流——助手卡片派发 + Grill-Me 对齐）
 */
export function isConversationSlash(kind: SlashCommandKind): boolean {
  return (
    kind === 'schedule' ||
    kind === 'goal' ||
    kind === 'grill-me' ||
    kind === 'skill'
  );
}

/**
 * 解析结果在校验阶段是否已缺参（应 toast 用法后直接 return，且不建会话）。
 * skill 异步发现失败不在此列。
 */
export function slashMissingArg(cmd: ResolvedSlashCommand): boolean {
  if (cmd.kind === 'learn' || cmd.kind === 'goal' || cmd.kind === 'grill-me') {
    return Boolean(cmd.missingArg);
  }
  return false;
}

/**
 * 发送路径上「仅解析结果即可判定」不应建会话的命令：
 * 纯导航、缺参；skill 无技能名（解析期即可知，等同缺参）。
 * skill 关闭/异步发现失败与 learn 写失败仍由调用方另判。
 * 本函数纯读 cmd，绝不 createSession。
 */
export function isSessionlessSlash(cmd: ResolvedSlashCommand): boolean {
  if (cmd.kind === 'none') return false;
  if (isNavigationSlash(cmd.kind)) return true;
  // E2 F4：compact 为会话级副作用命令——不写对话、不建会话（纯引擎命令）
  if (cmd.kind === 'compact') return true;
  // 解析期可知的 skill 空名：勿建幽灵会话（异步未找到仍归调用方）
  if (cmd.kind === 'skill' && !cmd.skillName) return true;
  return slashMissingArg(cmd);
}

/** none 原因；非 none 返回 null */
export function getSlashNoneReason(
  cmd: ResolvedSlashCommand
): SlashNoneReason | null {
  if (cmd.kind !== 'none') return null;
  return cmd.noneReason ?? 'plain';
}

/** 是否为未注册的 `/xxx`（非空斜杠、非纯文本） */
export function isUnknownSlash(cmd: ResolvedSlashCommand): boolean {
  return cmd.kind === 'none' && getSlashNoneReason(cmd) === 'unknown';
}

/** 是否为空斜杠 `/` */
export function isEmptySlash(cmd: ResolvedSlashCommand): boolean {
  return cmd.kind === 'none' && getSlashNoneReason(cmd) === 'empty';
}

/**
 * 缺参/用法提示（中文）。无提示的 kind 返回 null。
 * 供 toast 文案单源；解析层不 toast。
 */
export function slashUsageHint(kind: SlashCommandKind): string | null {
  switch (kind) {
    case 'learn':
      return '用法：/learn <要记住的规则>';
    case 'goal':
      return '用法：/goal <要完成的目标>';
    case 'grill-me':
      return '用法：/grill-me <要对齐的主题>';
    case 'browser':
      return '用法：/browser <url>';
    case 'skill':
      return '用法：/skill:<技能名> [参数]';
    case 'compact':
      return '用法：/compact [目标 token 数]';
    default:
      return null;
  }
}

/** 主 token → 规范 fill 文本（尾空格表示待续参） */
export function canonicalSlashFill(
  kind: Exclude<SlashCommandKind, 'none'>
): string {
  switch (kind) {
    case 'schedule':
      return '/schedule ';
    case 'teamwork-preview':
      return '/teamwork';
    case 'browser':
      return '/browser ';
    case 'learn':
      return '/learn ';
    case 'goal':
      return '/goal ';
    case 'grill-me':
      return '/grill-me ';
    case 'skill':
      return '/skill:';
    case 'compact':
      return '/compact ';
    default:
      return '/';
  }
}

/**
 * 斜杠菜单点选后的输入策略（与 resolveSlashCommand kind 对齐）。
 * - schedule：直接开定时面板（不落输入）
 * - teamwork：填 `/teamwork`（发送时由解析打开看板）
 * - 需参命令：尾部空格便于续写
 * - 中文别名点选 → 规范英文 token fill（菜单一致）
 * - skill / 演示命令：同样尾空格
 * （维度三 §2.6：/schedule 菜单点选改为填入对话模板，不再 open-schedule 跳面板）
 */
export type SlashMenuPickResult = { action: 'fill'; text: string };

function ensureSlashPrefix(token: string): string {
  const t = token.trim();
  if (!t) return '/';
  if (t.startsWith('/') || t.startsWith('／')) {
    return normalizeSlashInput(t);
  }
  return `/${t}`;
}

export function slashMenuPick(menuCmd: string): SlashMenuPickResult {
  const token = (menuCmd || '').trim();
  if (!token) return { action: 'fill', text: '/' };

  const prefixed = ensureSlashPrefix(token);
  const r = resolveSlashCommand(prefixed);

  switch (r.kind) {
    case 'schedule':
      return { action: 'fill', text: canonicalSlashFill('schedule') };
    case 'teamwork-preview':
      return { action: 'fill', text: canonicalSlashFill('teamwork-preview') };
    case 'browser':
      return { action: 'fill', text: canonicalSlashFill('browser') };
    case 'learn':
      return { action: 'fill', text: canonicalSlashFill('learn') };
    case 'goal':
      return { action: 'fill', text: canonicalSlashFill('goal') };
    case 'grill-me':
      return { action: 'fill', text: canonicalSlashFill('grill-me') };
    case 'skill': {
      // 保留用户/菜单给出的 skill 前缀与名，仅保证尾空格
      const base = prefixed;
      return { action: 'fill', text: base.endsWith(' ') ? base : `${base} ` };
    }
    default: {
      // demo `/simulate` 等未注册 kind：统一尾空格
      const base = prefixed;
      return { action: 'fill', text: base.endsWith(' ') ? base : `${base} ` };
    }
  }
}
