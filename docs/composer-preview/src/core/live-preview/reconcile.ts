/**
 * reconcile — 把「文本」重新解析成「marks + 语法标记」的核心同步器
 *
 * 不变式：**块内的 marks 永远是块内文本的纯函数**。
 * 用户每敲一个字符，本模块就对受影响的文本块重跑 parseInline，
 * 把结果写回 ProseMirror 的 mark 上。
 *
 * 三个关键设计：
 *
 * 1. **只改 mark，一个字符都不动。**
 *    因为语法字符本来就在文档里，重解析不需要插入/删除任何文本，
 *    于是光标位置天然稳定，不需要任何坐标映射——这是本架构相对
 *    「整块切换源码模式」方案最大的优势。
 *
 * 2. **不进 undo 历史**（`addToHistory: false`）。
 *    marks 既然是文本的纯函数，撤销时文本回滚会再次触发重解析，
 *    marks 自动跟着回到正确状态，不需要也不应该单独占一步。
 *
 * 3. **输入法保护。**
 *    中文/日文输入法组合期间修改文档会打断候选词，
 *    因此 `view.composing` 为真时整个重解析跳过，组合结束后再补。
 */

import type { EditorState, Transaction } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { parseBlock, resolveBlockRetype } from './blockSyntax';
import { OWNED_MARKS, SYNTAX_MARK_NAME } from './syntaxMark';

/** 行内 atom 节点（公式、提及…）在解析文本里占位用的字符，保证偏移与 PM 位置 1:1 对齐 */
const ATOM_PLACEHOLDER = '￼';

export interface ChangedRange {
  from: number;
  to: number;
}

/* ────────────────────────────────────────────
 * 变更范围收集
 * ──────────────────────────────────────────── */

/**
 * 求出一批事务在**新文档坐标系**下改动到的范围。
 *
 * 标准做法：已有范围先随当前事务的 mapping 平移，
 * 再把当前事务每一步新增的范围经由「该步之后的剩余 mapping」映射到终态坐标。
 */
export function getChangedRanges(transactions: readonly Transaction[]): ChangedRange[] {
  let ranges: ChangedRange[] = [];

  for (const tr of transactions) {
    if (!tr.docChanged) continue;

    ranges = ranges.map((r) => ({
      from: tr.mapping.map(r.from, -1),
      to: tr.mapping.map(r.to, 1),
    }));

    tr.mapping.maps.forEach((stepMap, i) => {
      const rest = tr.mapping.slice(i + 1);
      stepMap.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
        ranges.push({
          from: rest.map(newStart, -1),
          to: rest.map(newEnd, 1),
        });
      });
    });
  }

  return mergeRanges(ranges);
}

function mergeRanges(ranges: ChangedRange[]): ChangedRange[] {
  if (ranges.length <= 1) return ranges;
  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  const out: ChangedRange[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    if (sorted[i].from <= last.to) {
      last.to = Math.max(last.to, sorted[i].to);
    } else {
      out.push(sorted[i]);
    }
  }
  return out;
}

/* ────────────────────────────────────────────
 * 块级判定
 * ──────────────────────────────────────────── */

/**
 * 该节点是否应当参与行内实时预览。
 *
 * 排除：非文本块、代码块（`spec.code`，内部内容是字面量）、
 * 以及 schema 上根本不允许 bold 之类 mark 的块。
 */
export function isLivePreviewTextblock(node: PMNode, state: EditorState): boolean {
  if (!node.isTextblock) return false;
  if (node.type.spec.code) return false;
  const boldType = state.schema.marks.bold;
  if (!boldType) return false;
  return node.type.allowsMarkType(boldType);
}

/* ────────────────────────────────────────────
 * 块文本提取
 * ──────────────────────────────────────────── */

/**
 * 取出块的解析用文本。
 *
 * 行内 atom 节点用 U+FFFC 占位（它在 PM 里也恰好占 1 个位置），
 * 保证解析结果的偏移可以直接加上块起点得到文档绝对位置。
 */
export function getBlockText(node: PMNode): string {
  let text = '';
  node.forEach((child) => {
    text += child.isText ? (child.text ?? '') : ATOM_PLACEHOLDER.repeat(child.nodeSize);
  });
  return text;
}

/* ────────────────────────────────────────────
 * 目标 / 现状签名
 * ──────────────────────────────────────────── */

function markKey(name: string, attrs?: Record<string, unknown>): string {
  return name === 'link' ? `link:${String(attrs?.href ?? '')}` : name;
}

/** 按 parseBlock 的结果算出「每个偏移应该带哪些 mark」 */
function buildTargetSignature(text: string): string[] {
  const { marks, syntax } = parseBlock(text);
  const acc: string[][] = Array.from({ length: text.length }, () => []);

  for (const mk of marks) {
    const key = markKey(mk.name, mk.attrs);
    for (let i = mk.from; i < mk.to && i < text.length; i++) acc[i].push(key);
  }
  for (const sp of syntax) {
    for (let i = sp.from; i < sp.to && i < text.length; i++) acc[i].push(SYNTAX_MARK_NAME);
  }

  return acc.map((names) => names.sort().join('|'));
}

/** 读出文档里「每个偏移当前带哪些受管 mark」 */
function buildCurrentSignature(node: PMNode, length: number): string[] {
  const owned = new Set<string>(OWNED_MARKS);
  const sig: string[] = new Array(length).fill('');
  let offset = 0;

  node.forEach((child) => {
    const size = child.nodeSize;
    const names = child.marks
      .filter((mk) => owned.has(mk.type.name))
      .map((mk) => markKey(mk.type.name, mk.attrs))
      .sort()
      .join('|');
    for (let i = 0; i < size && offset + i < length; i++) sig[offset + i] = names;
    offset += size;
  });

  return sig;
}

/* ────────────────────────────────────────────
 * 单块重解析
 * ──────────────────────────────────────────── */

/**
 * 对单个文本块做重解析，必要时把节点类型与 mark 变更写进事务。
 *
 * 两件事：
 *   1. **块级** —— 根据行首前缀切换 paragraph ⇄ heading 并同步标题级别；
 *   2. **行内** —— 重铺 bold / italic / code / link 与 mdSyntax。
 *
 * 两者都不改变任何文档位置：`setNodeMarkup` 保持节点尺寸不变，
 * mark 操作本身就不影响位置。因此光标全程稳定。
 *
 * @returns 是否产生了实际改动
 */
export function reconcileBlock(
  tr: Transaction,
  state: EditorState,
  blockPos: number,
  node: PMNode,
): boolean {
  const text = getBlockText(node);
  const contentStart = blockPos + 1;

  const target = buildTargetSignature(text);
  const current = buildCurrentSignature(node, text.length);

  let marksDirty = false;
  for (let i = 0; i < text.length; i++) {
    if (target[i] !== current[i]) {
      marksDirty = true;
      break;
    }
  }

  // ── 块级：行首前缀决定节点类型 ──
  const retype = resolveBlockRetype(node, text, state.schema);
  if (retype) {
    tr.setNodeMarkup(blockPos, retype.type, retype.attrs, node.marks);
  }

  // 绝大多数击键（在无语法的纯文本里打字）都会在这里提前返回
  if (!marksDirty) return retype !== null;

  const { schema } = state;
  const contentEnd = contentStart + node.content.size;

  // 1) 清掉本模块托管的所有 mark（textStyle / color 等他人管辖的原样保留）
  for (const name of OWNED_MARKS) {
    const type = schema.marks[name];
    if (type) tr.removeMark(contentStart, contentEnd, type);
  }

  // 2) 按解析结果重新铺上
  const { marks, syntax } = parseBlock(text);
  for (const mk of marks) {
    const type = schema.marks[mk.name];
    if (!type) continue;
    tr.addMark(contentStart + mk.from, contentStart + mk.to, type.create(mk.attrs));
  }
  const syntaxType = schema.marks[SYNTAX_MARK_NAME];
  if (syntaxType) {
    for (const sp of syntax) {
      tr.addMark(contentStart + sp.from, contentStart + sp.to, syntaxType.create());
    }
  }

  return true;
}

/* ────────────────────────────────────────────
 * 批量重解析
 * ──────────────────────────────────────────── */

/**
 * 对给定范围内的所有可预览文本块做重解析。
 *
 * 分两阶段：先在**未被修改的文档快照**上收集目标块，再统一应用 mark 变更。
 * 之所以不边遍历边改，是因为 `reconcileBlock` 会写入 `tr`、进而替换 `tr.doc`，
 * 在遍历途中换掉被遍历的文档是很容易出错的写法。
 *
 * 注意：本模块只产生 mark 类的 step，不改变任何位置，
 * 因此阶段一收集到的 pos 在阶段二依然有效。
 */
export function reconcileRanges(
  tr: Transaction,
  state: EditorState,
  ranges: ChangedRange[],
): boolean {
  const doc = tr.doc;
  const targets: Array<{ pos: number; node: PMNode }> = [];
  const visited = new Set<number>();

  // ── 阶段一：收集 ──
  for (const range of ranges) {
    const from = Math.max(0, Math.min(range.from, doc.content.size));
    const to = Math.max(from, Math.min(range.to, doc.content.size));

    doc.nodesBetween(from, to, (node, pos) => {
      if (!isLivePreviewTextblock(node, state)) return true;
      if (!visited.has(pos)) {
        visited.add(pos);
        targets.push({ pos, node });
      }
      return false; // 文本块内部不再下钻
    });
  }

  // ── 阶段二：应用 ──
  let changed = false;
  for (const { pos, node } of targets) {
    if (reconcileBlock(tr, state, pos, node)) changed = true;
  }

  return changed;
}

/** 对整篇文档做一次重解析（载入内容、导入 Markdown 后调用） */
export function reconcileAll(tr: Transaction, state: EditorState): boolean {
  return reconcileRanges(tr, state, [{ from: 0, to: tr.doc.content.size }]);
}
