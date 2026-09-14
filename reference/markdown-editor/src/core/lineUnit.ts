/**
 * LineUnit —— 逐行渲染数据的**共享派生单元**（战役 table-systemic-remediation · T4）
 *
 * 权威文档：docs/table-systemic-remediation/04-分维-单容器渲染与测量时序.md
 *          docs/table-systemic-remediation/00-总方案-表格子系统端到端重构.md（ADR-2 / ADR-5）
 *
 * 为什么需要本模块（T4 的第 ① 步，SSOT 硬约束）：
 *   表格岛渲染每一行都需要「行内 token + 行起始偏移 + 活动态（光标/选区）」。
 *   这三者在旧路径里由 `MarkdownEngine.LineItem` 逐行派生。若岛内**重新实现**
 *   一遍派生，就会出现第二套行解析与装饰派生口径——同一源码行在两条路径下
 *   可能得到不同的 token / 活动态（ADR-2 明令禁止）。
 *   故把派生提为**唯一入口**：旧路径（`LineItem`）与岛路径（`TableIslandRow`）
 *   都调用本模块，差别只在「谁提供 decorations / store」。
 *
 * 派生内容（与迁移前 `LineItem` 逐分支等价）：
 *   ① `decorations.query(offset, offset + 行长)` → 行级装饰集；
 *   ② `activeState`：selection 装饰 → `{cursor, selStart, selEnd}`；active 装饰
 *      → `{cursor}`；无 → `null`（旧 selector 输出的结构兼容）；
 *   ③ 搜索命中标记（行级 class 用）；
 *   ④ callout 上下文 → `MarkdownParser.parseLine` 的行内 token；
 *   ⑤ 流式末行预演提示（`decorateIncompleteInline`，非末行恒 `null` 引用稳定）；
 *   ⑥ 表格稳定身份（`resolveTableId`，I10 唯一入口）。
 *
 * 纯逻辑：零 React / 零 DOM；`getLine` 由调用方注入（惰性访问器）。
 * `rowDecorationVersion` 不在本模块消费——它是**调用方的 memo 依赖**（R6-C
 * 行级版本：本行装饰内容变化才重派生），此处只作为入参契约显式化。
 */
import type { InlineNode, LineNode } from './ast';
import { getCalloutContext } from './calloutContext';
import {
  decorateIncompleteInline,
  type IncompleteInlineDecoration,
} from './decorateIncompleteInline';
import type { Decoration, DecorationSet } from './DecorationSet';
import type { EditorState } from './EditorStore';
import type { ActiveState } from './measure';
import { MarkdownParser, type CodeState } from './parser';
import { resolveTableId } from './tableIdentity';

/**
 * 行状态访问器（双段惰性读取；**逐字迁移**自 `MarkdownEngine.tsx:167-173`）。
 *
 * 实现：尾段为空 → 直接读主数组；非空 → 尾段「接管」主数组末行
 * （i ≥ boundary = main.length - 1 时从尾段相对下标 i - boundary 取）。
 * - 尾段为空（常规编辑/加载路径）：直接读主状态数组（全量，零额外开销）；
 * - 尾段非空（append 流式期间）：按边界取尾段状态，全程不触读物化
 *   `codeBlockState` 视图（尾段非空时物化会执行 concat 过渡成本）。
 *
 * 提升到 core 的唯一动因：岛路径（`TableBlock` / `TableIslandRow`）与旧路径
 * （`LineItem` / `estimateSize` / 批量测量）必须共用同一访问器口径。
 */
export function getLineState(s: EditorState, i: number): CodeState {
  if (s.streamTailCodeState.length === 0) return s.mainCodeState[i];
  const boundary = s.mainLines.length - 1;
  return i < boundary
    ? s.mainCodeState[i]
    : s.streamTailCodeState[i - boundary];
}

/** 逐行渲染数据（旧路径与岛路径共用的唯一形状）。 */
export interface LineUnit {
  /** parser 产物（行类型 + 行内 token）；表头/分隔行判定同样来自它 */
  lineNode: LineNode;
  /** 活动态（光标 / 选区）；非活动行 `null` */
  activeState: ActiveState | null;
  /** 该行是否命中搜索高亮（行级 class） */
  hasSearchDecoration: boolean;
  /** 流式末行预演提示；非预演恒 `null`（引用稳定，不破坏 memo） */
  previewHint: IncompleteInlineDecoration | null;
  /** 表格稳定身份（非表格行 `undefined`） */
  tableId: string | undefined;
}

export interface LineUnitInput {
  /** 源码绝对行号 */
  index: number;
  lineText: string;
  /** 该行在文档中的起始偏移 */
  offset: number;
  isCode: CodeState;
  /** 共享装饰集（引擎注入） */
  decorations: DecorationSet;
  /** 本行装饰版本（调用方 memo 依赖；本模块不消费，仅契约显式化） */
  rowDecorationVersion: number;
  getLine: (i: number) => string;
  /** 流式直刷末行标记（预演候选） */
  isStreamingTail: boolean;
  /**
   * 已知的表格身份（**岛路径必须传**）。
   *
   * 岛根已按区间解析出身份，逐行再调 `resolveTableId` 会重复触发
   * 「同签名序位」向后扫描（O(前序行数)/行）。传入即短路，零探测。
   * 缺省（旧路径 `LineItem`）由本模块自行解析，行为与迁移前一致。
   */
  tableId?: string;
}

/** 行级装饰查询（行范围 = [offset, offset + 行长)，闭区间语义由 DecorationSet 保证）。 */
export function deriveLineDecorations(
  decorations: DecorationSet,
  offset: number,
  lineLength: number
): Decoration[] {
  return decorations.query(offset, offset + lineLength);
}

/**
 * 活动态派生（结构兼容旧 selector 输出）：
 * - selection 装饰 → `{ cursor: to, selStart: from, selEnd: to }`——cursor 取
 *   选区末端（占位：有选区分支的消费方不读 cursor，与旧语义一致，值仅保持结构完整）；
 * - active 装饰（选区折叠的光标）→ `{ cursor: from }`；
 * - 无装饰 → `null`（非活动行）。
 */
export function deriveActiveState(
  lineDecorations: readonly Decoration[]
): ActiveState | null {
  const sel = lineDecorations.find((d) => d.kind === 'selection');
  if (sel) {
    return { cursor: sel.to, selStart: sel.from, selEnd: sel.to };
  }
  const active = lineDecorations.find((d) => d.kind === 'active');
  return active ? { cursor: active.from } : null;
}

/** 行内 token 派生（callout 上下文 → parser）。行解析唯一真源 = `MarkdownParser`。 */
export function deriveLineNode(input: {
  index: number;
  lineText: string;
  offset: number;
  isCode: CodeState;
  getLine: (i: number) => string;
}): LineNode {
  const { index, lineText, offset, isCode, getLine } = input;
  const calloutCtx = /^ {0,3}>\s?/.test(lineText)
    ? getCalloutContext(getLine, index)
    : null;
  return MarkdownParser.parseLine(
    lineText,
    offset,
    isCode,
    0,
    null,
    false,
    null,
    null,
    false,
    null,
    calloutCtx ? calloutCtx.type : null,
    calloutCtx ? calloutCtx.title : null,
    calloutCtx ? calloutCtx.isHeader : false
  );
}

/** 逐行渲染数据的唯一派生入口（旧路径与岛路径共用）。 */
export function deriveLineUnit(input: LineUnitInput): LineUnit {
  const {
    index,
    lineText,
    offset,
    isCode,
    decorations,
    getLine,
    isStreamingTail,
  } = input;

  const lineDecorations = deriveLineDecorations(decorations, offset, lineText.length);
  const activeState = deriveActiveState(lineDecorations);
  const hasSearchDecoration = lineDecorations.some((d) => d.kind === 'search');

  const lineNode = deriveLineNode({ index, lineText, offset, isCode, getLine });

  // 流式末行预演：单趟 O(行长) 扫描；非末行短路零开销；非预演恒 null（引用稳定）
  const preview = decorateIncompleteInline(lineText, isStreamingTail, isCode);
  const previewHint = preview.hint !== undefined ? preview : null;

  return {
    lineNode,
    activeState,
    hasSearchDecoration,
    previewHint,
    tableId: input.tableId ?? resolveTableId(getLine, index),
  };
}

/** 行内 token 的便捷取用（岛路径渲染 `InlineRenderer` 需要）。 */
export function lineTokens(unit: LineUnit): InlineNode[] {
  return unit.lineNode.inlineTokens ?? [];
}
