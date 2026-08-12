/**
 * MD 前缀快路径匹配（W3-H · A-BLK-09 方向）。
 *
 * 对齐：
 * - `plans/05` §1.6 / §5：idle 下 `# ` / `- ` 等转块；composing **禁止**
 * - `plans/09` **W3-H**：MD 前缀快路径；**≠** A-BLK 全表 e2e；**≠** EL-01
 * - A-IME-02 / structureKeyGuard：`turn_into` 属结构键，合成期不得触发
 *
 * 本模块 **纯函数**，不写盘、不碰 DOM、不接 RS apply。
 * 产出匹配结果后由 `turnInto.ts` 组装 `TurnIntoIntent`。
 *
 * ## 触发约定
 * - 仅识别**行首** MD 前缀（块 plain 文本从 offset 0 起）
 * - 推荐在「空格/Tab 刚把前缀补全」时调用（caret = prefixLength）
 * - 多行文本仅看**第一行**（至 `\n` 前）
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 已识别的 MD 前缀规则 id（稳定可测） */
export type MdPrefixRuleId =
  | 'heading-1'
  | 'heading-2'
  | 'heading-3'
  | 'heading-4'
  | 'heading-5'
  | 'heading-6'
  | 'bullet'
  | 'ordered'
  | 'quote'
  | 'code_fence'
  | 'task_todo'
  | 'task_done'
  | 'divider';

/**
 * 行首 MD 前缀匹配结果。
 * - `flavour`：纸面 flavour / slash catalog 对齐 id（heading-1、bullet…）
 * - `prefixLength`：须从块首剥离的 UTF-16 长度（含尾随空格/开围栏）
 * - `matched`：命中的原文前缀（调试 / 审计）
 */
export type MdPrefixMatch = {
  ruleId: MdPrefixRuleId;
  flavour: string;
  prefixLength: number;
  matched: string;
};

// ---------------------------------------------------------------------------
// 规则表（顺序敏感：更长 / 更具体优先）
// ---------------------------------------------------------------------------

type PrefixRule = {
  ruleId: MdPrefixRuleId;
  flavour: string;
  /**
   * 匹配第一行行首；返回命中串长度，未命中返回 null。
   * 允许消费尾随一个空格（标准 MD 块标记）。
   */
  tryMatch: (line: string) => string | null;
};

/**
 * 内置规则（与 DEFAULT_SLASH_CATALOG / flavourToCollabKind 方向对齐）。
 * 任务列表优先于普通 bullet（`- [ ] ` 长于 `- `）。
 */
const MD_PREFIX_RULES: readonly PrefixRule[] = [
  // 任务列表（todo / done）
  {
    ruleId: 'task_todo',
    flavour: 'task',
    tryMatch: (line) => {
      const m = line.match(/^(?:[-*+])\s+\[ \]\s/);
      return m ? m[0]! : null;
    },
  },
  {
    ruleId: 'task_done',
    flavour: 'task',
    tryMatch: (line) => {
      const m = line.match(/^(?:[-*+])\s+\[[xX]\]\s/);
      return m ? m[0]! : null;
    },
  },
  // 标题 # … ######（须带尾随空格）
  {
    ruleId: 'heading-6',
    flavour: 'heading-6',
    tryMatch: (line) => (line.startsWith('###### ') ? '###### ' : null),
  },
  {
    ruleId: 'heading-5',
    flavour: 'heading-5',
    tryMatch: (line) => (line.startsWith('##### ') ? '##### ' : null),
  },
  {
    ruleId: 'heading-4',
    flavour: 'heading-4',
    tryMatch: (line) => (line.startsWith('#### ') ? '#### ' : null),
  },
  {
    ruleId: 'heading-3',
    flavour: 'heading-3',
    tryMatch: (line) => (line.startsWith('### ') ? '### ' : null),
  },
  {
    ruleId: 'heading-2',
    flavour: 'heading-2',
    tryMatch: (line) => (line.startsWith('## ') ? '## ' : null),
  },
  {
    ruleId: 'heading-1',
    flavour: 'heading-1',
    tryMatch: (line) => (line.startsWith('# ') ? '# ' : null),
  },
  // 引用
  {
    ruleId: 'quote',
    flavour: 'quote',
    tryMatch: (line) => {
      const m = line.match(/^>\s/);
      return m ? m[0]! : null;
    },
  },
  // 有序：`1. ` / `1) `
  {
    ruleId: 'ordered',
    flavour: 'ordered',
    tryMatch: (line) => {
      const m = line.match(/^\d+[.)]\s/);
      return m ? m[0]! : null;
    },
  },
  // 无序：`- ` / `* ` / `+ `
  {
    ruleId: 'bullet',
    flavour: 'bullet',
    tryMatch: (line) => {
      const m = line.match(/^[-*+]\s/);
      return m ? m[0]! : null;
    },
  },
  // 代码围栏开：``` 可选 lang + 可选尾空格/换行已由 firstLine 截断
  {
    ruleId: 'code_fence',
    flavour: 'code',
    tryMatch: (line) => {
      const m = line.match(/^```[\w-]*\s?$/);
      // 仅当整行就是围栏开（无后续正文）时命中；` ```js ` 也接受
      if (!m) return null;
      // 要求至少 ``` ；若有语言后缀可不带尾空格
      if (line === '```' || line.startsWith('```')) {
        // 行内仅围栏：整行都是前缀
        if (/^```[\w-]*$/.test(line) || /^```[\w-]*\s$/.test(line)) {
          return line;
        }
      }
      return null;
    },
  },
  // 分隔线：--- / *** / ___（整行）
  {
    ruleId: 'divider',
    flavour: 'divider',
    tryMatch: (line) => {
      const t = line.trimEnd();
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(t) && t.length >= 3) {
        return line.endsWith('\n') ? line : t;
      }
      return null;
    },
  },
];

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/** 取 plain 文本第一行（不含换行符本身；前缀匹配用） */
export function firstLineOf(text: string): string {
  const i = text.indexOf('\n');
  return i < 0 ? text : text.slice(0, i);
}

/**
 * 匹配行首 MD 前缀（纯函数）。
 *
 * @param text 块 plain 文本（整块；仅第一行参与）
 * @returns 命中则 `MdPrefixMatch`；否则 `null`
 *
 * **不**检查 composing / caret——那是 `tryMdPrefixFastPath` 的职责。
 */
export function matchMdPrefix(text: string): MdPrefixMatch | null {
  const line = firstLineOf(text ?? '');
  if (!line) return null;
  for (const rule of MD_PREFIX_RULES) {
    const matched = rule.tryMatch(line);
    if (matched != null && matched.length > 0) {
      return {
        ruleId: rule.ruleId,
        flavour: rule.flavour,
        prefixLength: matched.length,
        matched,
      };
    }
  }
  return null;
}

/**
 * 是否应在当前光标位置触发快路径。
 *
 * 默认策略（Notion / 常见 MD 编辑器方向）：
 * - 光标紧贴前缀末尾（`caretOffset === prefixLength`）
 * - 或 `loose=true` 时只要行首命中且 caret ≥ prefixLength 即可
 *
 * @param text 当前块文本
 * @param caretOffset 逻辑 UTF-16 offset；缺省视为文末
 * @param options.loose 宽松触发（菜单/回放）；默认 false（键入空格紧触发）
 */
export function shouldTriggerMdPrefix(
  text: string,
  caretOffset?: number,
  options: { loose?: boolean } = {}
): MdPrefixMatch | null {
  const match = matchMdPrefix(text);
  if (!match) return null;
  const caret =
    caretOffset === undefined || !Number.isFinite(caretOffset)
      ? (text ?? '').length
      : Math.max(0, Math.floor(caretOffset));
  if (options.loose) {
    return caret >= match.prefixLength ? match : null;
  }
  // 严格：caret 必须正好在前缀结束后（刚敲完触发空格/围栏）
  return caret === match.prefixLength ? match : null;
}

/**
 * 剥离已匹配前缀后的正文（保留后续行）。
 * 不修改入参；纯函数。
 */
export function stripMdPrefix(text: string, match: MdPrefixMatch): string {
  const t = text ?? '';
  if (match.prefixLength <= 0) return t;
  if (match.prefixLength >= t.length) {
    // 可能还有后续行
    const nl = t.indexOf('\n');
    if (nl < 0) return '';
    return t.slice(nl + 1);
  }
  return t.slice(match.prefixLength);
}

/** 导出规则表长度（测用 / 审计） */
export function mdPrefixRuleCount(): number {
  return MD_PREFIX_RULES.length;
}
