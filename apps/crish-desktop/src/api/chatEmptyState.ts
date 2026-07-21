/**
 * Chat 主列空态契约（与 toast 策略一致：页内短文案 + 主行动，禁止灰大块/空白）。
 *
 * 三种空态（互斥，由 resolveChatEmptyKind 单一出口）：
 * - no-session：无当前会话 → CTA「新建对话」
 * - filter-empty：有消息但本会话过滤无命中 → CTA「清除过滤」
 * - session-empty：有会话、零消息（欢迎面）→ 项目条 + 快捷 prompt
 *
 * FirstRun / needsKey soft-hint / 引擎条 与空态分工：
 * - soft-hint / FirstRun 独占「配密钥」；engine-down 独占引擎引导
 * - 空态只做对话面（选项目 / 清除过滤 / 新建会话），不重复密钥/引擎引导
 * - 水合 loading 中不闪欢迎空壳（避免幽灵「开始对话」）
 * - 空会话：清晰 CTA；不渲染远程幽灵壳（由 prune + loading 抑制配合）
 */

export type ChatEmptyKind = 'no-session' | 'filter-empty' | 'session-empty';

/** 三态稳定集合（测试/枚举用，顺序即产品优先级） */
export const CHAT_EMPTY_KINDS: readonly ChatEmptyKind[] = [
  'no-session',
  'filter-empty',
  'session-empty',
] as const;

/** 三态扫视标题（固定，便于测试与 CSS 对照） */
export const CHAT_EMPTY_TITLES: Readonly<Record<ChatEmptyKind, string>> = {
  'no-session': '暂无会话',
  'filter-empty': '无匹配消息',
  'session-empty': '开始对话',
};

/** 主行动语义：与 kind 绑定；session-empty 无主行动按钮 */
export type ChatEmptyPrimaryAction = 'create-session' | 'clear-filter' | null;

/** 主行动中文标签（与 resolveChatEmptyCopy.actionLabel 同源） */
export const CHAT_EMPTY_ACTION_LABELS: Readonly<
  Record<Exclude<ChatEmptyPrimaryAction, null>, string>
> = {
  'create-session': '新建对话',
  'clear-filter': '清除过滤',
};

/** 屏幕阅读器短标签（三态互异） */
export const CHAT_EMPTY_ARIA_LABELS: Readonly<Record<ChatEmptyKind, string>> = {
  'no-session': '暂无会话',
  'filter-empty': '过滤无匹配消息',
  'session-empty': '会话为空，可以开始对话',
};

/** 运行时守卫：外部字符串 / data 属性回读 */
export function isChatEmptyKind(value: unknown): value is ChatEmptyKind {
  return (
    value === 'no-session' ||
    value === 'filter-empty' ||
    value === 'session-empty'
  );
}

/** kind → 主行动（不依赖 copy 分支，避免 UI 漏接） */
export function resolveChatEmptyPrimaryAction(
  kind: ChatEmptyKind,
  opts?: { firstRunOpen?: boolean }
): ChatEmptyPrimaryAction {
  if (kind === 'no-session') {
    // FirstRun 盖层打开时隐藏「新建对话」，避免与向导抢 CTA
    return opts?.firstRunOpen ? null : 'create-session';
  }
  if (kind === 'filter-empty') return 'clear-filter';
  return null;
}

/** 主行动 → 中文按钮文案；null 行动无标签 */
export function resolveChatEmptyActionLabel(
  action: ChatEmptyPrimaryAction
): string | undefined {
  if (!action) return undefined;
  return CHAT_EMPTY_ACTION_LABELS[action];
}

/** 屏幕阅读器短标签：三态必须可区分 */
export function chatEmptyKindAriaLabel(kind: ChatEmptyKind): string {
  return CHAT_EMPTY_ARIA_LABELS[kind];
}

export type ChatEmptyResolveInput = {
  /** 是否存在当前会话（id + 实体） */
  hasActiveSession: boolean;
  /** 会话内消息总数（未过滤） */
  messageCount: number;
  /** 过滤后可见条数 */
  displayCount: number;
  /** 本会话消息过滤关键词 */
  filterQuery?: string | null;
  /** scheduled 主面不走对话空态 */
  mainSurface?: 'chat' | 'scheduled';
  /**
   * 会话消息仍在从磁盘/引擎水合：有活动会话时抑制空壳，
   * 避免远程会话短暂 messageCount=0 闪「开始对话」幽灵欢迎面。
   */
  messagesLoading?: boolean;
};

/**
 * 解析主列空态 kind；null = 应渲染消息列表（非空）或暂不展示空态。
 * 优先级：scheduled 跳过 → loading 抑制 → 无会话 → 过滤无命中 → 有会话无消息。
 *
 * 不变量：
 * - messageCount === 0 时永不返回 filter-empty（欢迎面优先，避免「无匹配」误导）
 * - 无会话时优先 no-session，即使携带 filter / 历史计数
 * - messagesLoading + hasActiveSession → null（不闪空壳）
 * - 无会话时 loading 不掩盖 no-session（仍需「新建对话」CTA）
 */
export function resolveChatEmptyKind(
  input: ChatEmptyResolveInput
): ChatEmptyKind | null {
  if (input.mainSurface === 'scheduled') return null;
  if (!input.hasActiveSession) return 'no-session';

  // 有会话且消息仍在加载：不展示欢迎/过滤空态（防幽灵远程壳）
  if (input.messagesLoading) return null;

  // 防御：负计数 / NaN 按 0 处理，避免异常输入落到「有消息列表」空壳
  const messageCount = normalizeCount(input.messageCount);
  const displayCount = normalizeCount(input.displayCount);
  const q = (input.filterQuery || '').trim();

  if (q && messageCount > 0 && displayCount === 0) {
    return 'filter-empty';
  }
  if (messageCount === 0) return 'session-empty';
  return null;
}

/**
 * 是否应挂载 ChatEmptyState。
 * 与 resolveChatEmptyKind 同契约；显式命名便于调用方扫读。
 */
export function shouldShowChatEmptyShell(
  input: ChatEmptyResolveInput
): boolean {
  return resolveChatEmptyKind(input) != null;
}

function normalizeCount(n: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

export type ChatEmptyCopy = {
  kind: ChatEmptyKind;
  title: string;
  sub: string;
  /** 主行动按钮文案（无则只展示文案） */
  actionLabel?: string;
  /** 与 actionLabel 同步的行动语义；便于组件 data-action / 测试 */
  primaryAction: ChatEmptyPrimaryAction;
  /** 欢迎面：项目选择条 */
  showProjectBar: boolean;
  /** 欢迎面：快捷 prompt chips（密钥未就绪时仍可填入输入框，但不强调「发送」） */
  showQuickPrompts: boolean;
};

export type ChatEmptyCopyInput = {
  kind: ChatEmptyKind;
  filterQuery?: string | null;
  /**
   * 本地/引擎未配密钥：空态不重复密钥 CTA（soft-hint 负责）。
   * 快捷 prompt 仍可展示为草稿填入。
   */
  needsKeySetup?: boolean;
  /** 有密钥无模型：文案略收紧 */
  needsModelSetup?: boolean;
  /**
   * FirstRun 向导盖在上层时：空态极简，避免与向导抢注意力。
   * （向导关闭后 needsKey soft-hint 接管密钥引导）
   */
  firstRunOpen?: boolean;
  /**
   * engineHint.ok；false = daemon/引擎离线。
   * 离线时欢迎面改草稿口径、隐藏快捷 prompt（避免暗示可跑工具）；
   * soft-hint 的 engine-down 条独占引擎引导。
   * null/undefined = 尚未探测或未知，按就绪欢迎面处理（不误伤）。
   */
  engineOk?: boolean | null;
};

/** 过滤关键词展示截断，避免长查询撑破空态 */
export function truncateFilterPreview(q: string, max = 24): string {
  const t = q.trim();
  if (!t) return '';
  const limit = max > 0 ? Math.floor(max) : 24;
  return t.length > limit ? `${t.slice(0, limit)}…` : t;
}

/**
 * 三态短文案 + 控件显隐。禁止长段说明与「灰大块」文案。
 * 标题必须三态互不相同，便于扫视区分。
 */
export function resolveChatEmptyCopy(input: ChatEmptyCopyInput): ChatEmptyCopy {
  const {
    kind,
    firstRunOpen = false,
    needsKeySetup = false,
    needsModelSetup = false,
    engineOk = null,
  } = input;

  switch (kind) {
    case 'no-session': {
      const primaryAction = resolveChatEmptyPrimaryAction(kind, {
        firstRunOpen,
      });
      return {
        kind,
        title: CHAT_EMPTY_TITLES['no-session'],
        sub: firstRunOpen ? '完成引导后即可新建对话' : '新建一条开始对话',
        actionLabel: resolveChatEmptyActionLabel(primaryAction),
        primaryAction,
        showProjectBar: false,
        showQuickPrompts: false,
      };
    }
    case 'filter-empty': {
      const preview = truncateFilterPreview(input.filterQuery || '');
      const primaryAction = resolveChatEmptyPrimaryAction(kind);
      return {
        kind,
        title: CHAT_EMPTY_TITLES['filter-empty'],
        sub: preview ? `没有匹配「${preview}」的内容` : '没有匹配的消息',
        actionLabel: resolveChatEmptyActionLabel(primaryAction),
        primaryAction,
        showProjectBar: false,
        showQuickPrompts: false,
      };
    }
    case 'session-empty': {
      // 欢迎面；与 no-session / filter-empty 标题不同；永不暴露主行动按钮
      if (firstRunOpen) {
        return {
          kind,
          title: CHAT_EMPTY_TITLES['session-empty'],
          sub: '完成引导后即可使用',
          primaryAction: null,
          showProjectBar: false,
          showQuickPrompts: false,
        };
      }
      // daemon 未就绪（极罕见）：engine-down soft-hint；正式版 keep-alive 下 ok 多为 true
      if (engineOk === false) {
        return {
          kind,
          title: CHAT_EMPTY_TITLES['session-empty'],
          sub: '引擎未就绪，可先选项目或打草稿',
          primaryAction: null,
          showProjectBar: true,
          // 快捷 prompt 多暗示跑工具/检查服务；离线时隐藏，CTA 更干净
          showQuickPrompts: false,
        };
      }
      if (needsKeySetup) {
        return {
          kind,
          title: CHAT_EMPTY_TITLES['session-empty'],
          // soft-hint 独占密钥 CTA；此处只点拨「可先选项目 / 打草稿」
          sub: '可先选项目，或在下方打草稿',
          primaryAction: null,
          showProjectBar: true,
          showQuickPrompts: true,
        };
      }
      if (needsModelSetup) {
        return {
          kind,
          title: CHAT_EMPTY_TITLES['session-empty'],
          sub: '选好模型后，在下方输入即可',
          primaryAction: null,
          showProjectBar: true,
          showQuickPrompts: true,
        };
      }
      return {
        kind,
        title: CHAT_EMPTY_TITLES['session-empty'],
        sub: '选择项目，或直接在下方输入',
        primaryAction: null,
        showProjectBar: true,
        showQuickPrompts: true,
      };
    }
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

/**
 * 欢迎面是否展示快捷 prompt（与 copy.showQuickPrompts 对齐的单一判定）。
 * 供组件/测试在不整份 copy 时快速决策。
 */
export function shouldShowEmptyQuickPrompts(opts: {
  kind: ChatEmptyKind;
  firstRunOpen?: boolean;
  engineOk?: boolean | null;
  /** 消息水合中：即使 kind 误传 session-empty 也不出 chips */
  messagesLoading?: boolean;
}): boolean {
  if (opts.kind !== 'session-empty') return false;
  if (opts.firstRunOpen) return false;
  if (opts.messagesLoading) return false;
  if (opts.engineOk === false) return false;
  return true;
}

/** 欢迎面快捷 prompt（短 label + 填入 composer 的正文） */
export const CHAT_EMPTY_QUICK_PROMPTS: ReadonlyArray<{
  label: string;
  prompt: string;
}> = [
  {
    label: '分析项目结构',
    prompt: '分析当前工作区项目结构，梳理核心模块与依赖关系',
  },
  {
    label: '查看代码改动',
    prompt: '运行 git status 与 git diff，总结当前工作区修改',
  },
  {
    label: '检查开发服务',
    prompt: '检查本地开发服务器与相关工具是否正常运行',
  },
];

/**
 * needsKey soft-hint 是否展示。
 * FirstRun 盖层打开时由向导独占；引擎未就绪时由引擎 soft-hint 独占。
 * 禁止用 toast 做密钥引导。
 */
export function shouldShowNeedsKeySoftHint(opts: {
  needsKeySetup: boolean;
  /** engineHint.ok；false 时引擎条优先 */
  engineOk?: boolean | null;
  firstRunOpen?: boolean;
}): boolean {
  if (!opts.needsKeySetup) return false;
  if (opts.firstRunOpen) return false;
  if (opts.engineOk === false) return false;
  return true;
}

/**
 * needsModel soft-hint 是否展示。
 * 有密钥无模型时页内提示手填；向导/密钥条/引擎条优先时让位。
 * 禁止 toast 引导。
 */
export function shouldShowNeedsModelSoftHint(opts: {
  needsModelSetup: boolean;
  needsKeySetup?: boolean;
  engineOk?: boolean | null;
  firstRunOpen?: boolean;
}): boolean {
  if (!opts.needsModelSetup) return false;
  if (opts.needsKeySetup) return false;
  if (opts.firstRunOpen) return false;
  if (opts.engineOk === false) return false;
  return true;
}

/**
 * soft-hint 文案：空态主面时用更短一句，避免与欢迎标题叠成「两段引导」。
 */
export function resolveNeedsKeySoftHintText(opts: {
  /** 主列是否处于任一对空态 */
  onEmptySurface?: boolean;
}): string {
  if (opts.onEmptySurface) {
    return '请先配置服务商密钥';
  }
  return '首次使用请先配置服务商密钥与模型';
}

/**
 * 与 needsModel soft-hint 配套：空态时更短；强调手填。
 */
export function resolveNeedsModelSoftHintText(opts: {
  onEmptySurface?: boolean;
}): string {
  if (opts.onEmptySurface) {
    return '请选择或手填模型';
  }
  return '请手填或选择模型 id（默认不预置模型）';
}
