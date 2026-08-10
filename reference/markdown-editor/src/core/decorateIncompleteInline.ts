import type { CodeState } from './parser';

/**
 * 显示层乐观补全（P3 波 3，plan-A2 方案 B 样式预演）：
 * 流式末行「未闭合行内标记」检测纯函数。
 *
 * 背景：流式输出中未闭合的 `**text` / `` `code `` / `$eq` 在解析器
 * （scanTokens）下整段按 text token 渲染（含标记字符原文）——闭合瞬间
 * 才出现加粗/代码/数学样式，产生「整行切换」的跳动观感。本函数在渲染
 * 期派生出「预演样式提示」：未闭合标记后的文本段在显示层加预演类
 * （is-preview-*），视觉上「看起来已加粗」；闭合时同一 DOM 节点由
 * 预演类切换为真实样式类（class 微调，无跳动）。
 *
 * 契约（与数据层严格隔离）：
 * - 纯函数、只读入参，不写 store、不产新 token、无假偏移——undo/编辑/
 *   序列化/光标测量（data-token 映射）零影响；
 * - 仅「流式会话进行中的末行」预演（isStreamingTail）——编辑态是用户
 *   主动输入，无「即将闭合」预期，不预演；
 * - 代码语义行（codeState ≠ 'none'）不预演——围栏/缩进代码/数学块/
 *   HTML 块内行内标记是字面量（由调用方传入 codeState 排除）；
 * - 误判防护：`foo*bar`（词中 `*`）不预演——围挡判定复用 CommonMark
 *   Rule 13 词边界语义（计划 A2 明示）；`**text**x` 只预演「最后未
 *   配对开标记」之后的文本（本实现：配对栈顶 = 最后未配对开标记，
 *   全部配对 → 不预演）。
 *
 * 实现：单趟 O(行长) 扫描。开标记候选按围挡判定（`*`/`_`/`~~` 词边界
 * + flanking，`` ` ``/`$` 仅要求后随非空白——镜像 matchCodeSpan 与
 * math 正则的首字符约束）；闭合候选与 parser 起止符规则同构（同型
 * 精确 run 配对，弹「最内层」同型开标记）。栈顶（最后入栈、未被配对）
 * 即「最后未配对开标记」。
 *
 * 诚实边界（与 parser 的差异登记）：parser 的扫描是「首个后续等型
 * 闭合贪婪配对」，本函数是栈式配对——在病态混排强调（如 `*a **b* c*`
 * 中 `**` 已死在斜体内容内）下预演判定可能异于解析结果；预演仅是
 * 展示层提示（可丢弃），不构成渲染契约。run ≥ 4（`****` 等 parser
 * 的 doubled 例外）不预演（超稀有，登记偏差）。
 */

/** 预演样式类别（对应渲染层 is-preview-* 类；含 plan-A2 的 math） */
export type IncompleteInlineHint =
  | 'bold'
  | 'italic'
  | 'bold_italic'
  | 'code'
  | 'strike'
  | 'math';

/** 未闭合行内标记检测结果（空对象 = 无预演） */
export interface IncompleteInlineDecoration {
  /** 预演段起点（行内字符偏移；从此起至行尾的文本按 hint 预演） */
  previewStart?: number;
  /** 预演样式类别 */
  hint?: IncompleteInlineHint;
}

// Unicode 空白 / 标点（与 parser 的 IS_UNICODE_WS / IS_UNICODE_PUNCT 同口径）
const IS_WS = /\s/;
const IS_PUNCT = /[\p{P}\p{S}]/u;

/** 开标记栈条目 */
interface OpenMarker {
  /** 预演类别（`*`/`_` 族按规则长度映射；code/math 同型异长配对） */
  hint: IncompleteInlineHint;
  /** 标记 run 结束位置（行内偏移，即预演段起点） */
  end: number;
  /** 标记 run 长度（反引号/美元符按等长 run 配对，matchCodeSpan 语义） */
  runLen: number;
}

/**
 * 围挡判定（CommonMark Rule 9/10，与 parser.underscoreFlanking 同构）：
 * 左围挡 = 后非空白 且（后非标点 或 前空白/标点）；
 * 右围挡 = 前非空白 且（前非标点 或 后空白/标点）。
 * 行首/行尾视为空白。
 */
function flankingOf(
  raw: string,
  start: number,
  runLen: number
): { left: boolean; right: boolean; prev: string } {
  const prev = start > 0 ? raw[start - 1] : ' ';
  const next = start + runLen < raw.length ? raw[start + runLen] : ' ';
  const left =
    !IS_WS.test(next) &&
    (!IS_PUNCT.test(next) || IS_WS.test(prev) || IS_PUNCT.test(prev));
  const right =
    !IS_WS.test(prev) &&
    (!IS_PUNCT.test(prev) || IS_WS.test(next) || IS_PUNCT.test(next));
  return { left, right, prev };
}

/**
 * 弹「最内层」同型开标记（闭合配对）。
 * equalLenOnly 时要求 run 长度也相同（反引号/美元符的等长 run 配对）。
 * 返回是否命中。
 */
function closeInnermost(
  stack: OpenMarker[],
  hint: IncompleteInlineHint,
  runLen: number,
  equalLenOnly: boolean
): boolean {
  for (let k = stack.length - 1; k >= 0; k--) {
    if (stack[k].hint !== hint) continue;
    if (equalLenOnly && stack[k].runLen !== runLen) continue;
    stack.splice(k, 1);
    return true;
  }
  return false;
}

/**
 * 检测流式末行行内未闭合标记。
 *
 * @param raw           行文本（含行内标记字符原文）
 * @param isStreamingTail 是否流式进行中的末行（false → 恒不预演）
 * @param codeState     行块级代码状态（非 'none' → 不预演；缺省视为 none）
 */
export function decorateIncompleteInline(
  raw: string,
  isStreamingTail: boolean,
  codeState?: CodeState | null
): IncompleteInlineDecoration {
  // 编辑态/非末行不预演；代码语义行内标记是字面量不预演
  if (!isStreamingTail) return {};
  if (codeState && codeState !== 'none') return {};

  const n = raw.length;
  const stack: OpenMarker[] = [];
  let i = 0;
  while (i < n) {
    const c = raw[i];
    // 转义字符：`\*` 等标记按字面量跳过（不参与配对/开闭判定）
    if (c === '\\') {
      i += 2;
      continue;
    }
    // run 长度（连续同字符段）
    let run = 1;
    while (i + run < n && raw[i + run] === c) run++;
    const runEnd = i + run;

    if (c === '*' || c === '_') {
      // run 3 → bold_italic、2 → bold、1 → italic（与 parser 起止符
      // 规则同构；run ≥ 4 无精确规则，不预演）
      if (run >= 1 && run <= 3) {
        const hint: IncompleteInlineHint =
          run === 3 ? 'bold_italic' : run === 2 ? 'bold' : 'italic';
        const { left, right, prev } = flankingOf(raw, i, run);
        // 开围挡：`_` 族沿用 parser 的 underscoreFlanking 开规则
        // （intraword `_` 不能开）；`*`/`~` 族词边界防护（plan-A2：
        // `foo*bar` 不预演——CommonMark Rule 13 语义）
        const canOpen =
          c === '_'
            ? left && (!right || IS_PUNCT.test(prev))
            : left && !(right && !IS_PUNCT.test(prev));
        if (!closeInnermost(stack, hint, run, false) && canOpen) {
          stack.push({ hint, end: runEnd, runLen: run });
        }
      }
    } else if (c === '~') {
      // 删除线：仅 `~~` 双波浪 run（单 `~` 是 sub 正则规则，plan 范围外）
      if (run === 2) {
        const { left, right, prev } = flankingOf(raw, i, run);
        const canOpen = left && !(right && !IS_PUNCT.test(prev));
        if (!closeInnermost(stack, 'strike', run, false) && canOpen) {
          stack.push({ hint: 'strike', end: runEnd, runLen: run });
        }
      }
    } else if (c === '`') {
      // 反引号等长 run 配对（matchCodeSpan 语义）：
      // - 已有开 code 标记：等长 run 弹「最内层」同长开标记；异长 run
      //   是已开 code span 的内容（字面量），不得新开——`` `a``b` ``
      //   整体是一个闭合 code span（spec 例 330/331 语义）；
      // - 未开 code 标记：左围挡（后随非空白）才可作为开标记
      //   （`` ` `` 行尾/后随空白按字面量，不预演）。
      if (stack.some((m) => m.hint === 'code')) {
        closeInnermost(stack, 'code', run, true);
      } else if (!IS_WS.test(i + run < n ? raw[i + run] : ' ')) {
        stack.push({ hint: 'code', end: runEnd, runLen: run });
      }
    } else if (c === '$') {
      // 行内/显示数学：单 `$` 与双 `$$`（run 长度配对；run ≥ 3 无规则）。
      // 与 math 正则同约束：开标记后随字符必须非空白（`$ ` 按字面量）。
      // 0 KaTeX 纪律：预演只产样式提示（is-preview-math 等宽/斜体类），
      // 不调用渲染器——闭合后才走真实 KaTeX 路径。
      if (run === 1 || run === 2) {
        if (stack.some((m) => m.hint === 'math')) {
          closeInnermost(stack, 'math', run, true);
        } else if (!IS_WS.test(i + run < n ? raw[i + run] : ' ')) {
          stack.push({ hint: 'math', end: runEnd, runLen: run });
        }
      }
    }

    i += run;
  }

  if (stack.length === 0) return {};
  // 栈顶 = 最后未配对开标记（plan-A2：只预演其后的文本）
  const top = stack[stack.length - 1];
  return { previewStart: top.end, hint: top.hint };
}
