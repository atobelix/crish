/**
 * TableIdentity —— 表格**稳定身份**（战役 table-systemic-remediation · T2）
 *
 * 权威文档：docs/table-systemic-remediation/03-分维-表格语义模型与身份SSOT.md
 *          docs/table-systemic-remediation/00-总方案-表格子系统端到端重构.md（ADR-3 / §13 裁决 R18）
 *
 * 要解决的问题（根因断层 D2/D3）：
 *   此前表格身份 = `table-<首个表格行行号>`，由**逐行向上探测**生成
 *   （`MarkdownEngine.tsx:548-562`）。后果：
 *     ① 表格**上方**任何插入/删除都会改变身份 → 列宽 / 列对齐 / 滚动 / 选区
 *        落到错误目标（症状 S7）；
 *     ② 每个渲染行都要做一次 O(rows) 的向上探测；
 *     ③ 渲染层被迫解码身份字符串（`BlockRenderer.tsx:1574` 的 `/^table-(\d+)$/`）。
 *
 * 本模块的解法（ADR-3 的落地形态）：
 *   - 身份改为**内容寻址 + 序位**的稳定 id，**与行号解耦**：
 *       匹配键 = `(签名, 序位)`，其中
 *         签名 = 表头单元格文本 + 分隔行声明的列数（只读局部两行，可廉价重算）；
 *         序位 = 本表在「同签名表格」中的文档次序。
 *     由此：表格**上方**插入/删除任意行、表格**内部**增删数据行、改列对齐，
 *     都**不改变身份**（序位与签名均不变）。
 *   - 渲染层不再需要知道身份的内部格式：表头判定 / 分隔行 / 列对齐一律**经身份查询**。
 *
 * **已知限制（登记，T8 收敛）**：编辑**表头单元格文本**会改变签名 → 换新身份 →
 *   该表的列宽/对齐被重置（下次测量自愈）。曾尝试用「列数相同 + 上次位置最近」
 *   兜底匹配来覆盖此场景，但实测它会**把身份偷给邻近的另一张表**——后果比它要解决的
 *   问题更严重，故弃用，改为确定性匹配。相对重构前「表格上方任何编辑都重置列宽」
 *   已是严格改善；T8 随表格岛落地后，身份可由岛的稳定节点直接承载，届时彻底消除。
 *
 * 与 ADR-3 原始设计的偏差（**已裁决 R18**）：
 *   ADR-3 初稿要求「由 `EditorStore` 维护 lineIndex→blockId 映射并在编辑操作中重映射」。
 *   但 `EditorStore.ts` 在 `scripts/check-file-length.mjs` 的例外名单内（ceiling 3060 冻结），
 *   T2 不得为其增加行数；且 `MarkdownEngine.tsx` / `BlockRenderer.tsx` 同样 ceiling 冻结。
 *   故改为**本模块承载注册表**（惰性重建、无编辑期重映射），并以「内容签名 + 位置兜底」
 *   达成同一效果。**已知代价**：表头单元格文本被编辑时，若同文档内存在列数相同的其它表格，
 *   兜底匹配可能把身份绑到邻近表；该场景下的后果仅为列宽/对齐的偶发错配（下次测量自愈），
 *   登记为 T8 的收敛项（届时随表格岛落地，身份可由岛的稳定节点直接承载）。
 *
 * 纪律：
 *   - 纯逻辑 + 模块级注册表，不依赖 React / DOM；`getLine` 由调用方注入。
 *   - 表区间探测的**文本口径**与 `MarkdownEngine.tsx:548-562` 原实现**逐字一致**
 *     （`trim().startsWith('|')`），保证 T2 不改变既有行为（裁决 R2 的偏差登记见 C16）。
 */
import type { ColumnAlignment } from './tableModel';
import { splitRowCells } from './tableModel';

/** 表头判定 / 列对齐消费所需的身份条目。 */
export interface TableIdentityEntry {
  id: string;
  /** 上次观测到的表区间（行号会随编辑变化，仅作位置兜底与调试用）。 */
  startLine: number;
  endLine: number;
  /** 分隔行行号；无分隔行时 `null`。 */
  separatorLine: number | null;
  /** 是否存在表头（分隔行紧跟在首行之后）。 */
  hasHeader: boolean;
  /** 列数。 */
  cols: number;
  /** 列对齐（已投影为 TableStore 的三值契约：`none → left`，裁决 R4）。 */
  alignments: ColumnAlignment3[];
  /** 一级匹配签名 = 表头单元格文本 + 分隔行声明的列数（只读局部两行）。 */
  signature: string;
  /** 同签名表格在文档中的序位（区分「签名完全相同的多张表」的稳定线索）。 */
  rank: number;
}

/** TableStore 的三值列对齐契约（`none` 在边界处投影为 `left`，裁决 R4）。 */
export type ColumnAlignment3 = 'left' | 'center' | 'right';

interface RegistryEntry extends TableIdentityEntry {
  /** 最近一次被观测的序号（LRU 淘汰用）。 */
  touched: number;
}

const registry = new Map<string, RegistryEntry>();
let nextId = 1;
let touchClock = 0;

/** 注册表容量上限（防内存无界；表格数量级远小于此）。 */
const REGISTRY_LIMIT = 512;

/**
 * 由任意一行解析其所属表格的**稳定身份**。
 *
 * 行为与旧实现（`MarkdownEngine.tsx:548-562`）保持一致的部分：
 *   - 该行不以 `|` 开头（trim 后）→ 返回 `undefined`（非表格行）；
 *   - 向上探测的判定口径同为 `trim().startsWith('|')`。
 * 改变的部分：返回值不再是 `table-<行号>`，而是与行号解耦的稳定 id（如 `t1`）。
 *
 * @param getLine 行文本访问器（须为惰性访问器，勿物化整篇）
 * @param lineIndex 目标行号
 */
export function resolveTableId(
  getLine: (i: number) => string,
  lineIndex: number
): string | undefined {
  if (lineIndex < 0) return undefined;
  const safe = nullSafe(getLine);
  const belongs = (i: number): boolean => {
    if (i < 0) return false;
    return safe(i).trim().startsWith('|');
  };
  if (!belongs(lineIndex)) return undefined;

  // ① 向上探测表格起始行（与原实现同口径；空值保护与原 `prevLine &&` 一致）
  let start = lineIndex;
  while (start > 0 && belongs(start - 1)) start--;

  // ② 向下探测表格结束行
  let end = lineIndex;
  const max = start + 10_000; // 防御：单表行数上限，避免异常文档导致长扫
  while (end < max && belongs(end + 1)) end++;

  return reconcile(start, end, safe);
}

/** 行访问器空值兜底：越界 / 未物化行返回 `''`（与原实现 `prevLine &&` 的语义一致）。 */
function nullSafe(getLine: (i: number) => string): (i: number) => string {
  return (i: number) => getLine(i) ?? '';
}

/**
 * 观测一张表并返回其稳定 id（幂等：同一次观测重复调用返回同一 id）。
 * 亦供测试与后续波次（表格岛）直接调用。
 */
export function observeTableRange(
  startLine: number,
  endLine: number,
  getLine: (i: number) => string
): string {
  return reconcile(startLine, endLine, nullSafe(getLine));
}

function reconcile(
  startLine: number,
  endLine: number,
  getLine: (i: number) => string
): string {
  const separatorLine = detectSeparatorLine(startLine, endLine, getLine);
  const hasHeader = separatorLine !== null && separatorLine === startLine + 1;
  const cols = computeCols(startLine, endLine, separatorLine, getLine);

  // 签名（**只读表头与分隔行的局部信息**，故可在「前序表格扫描」中廉价重算）：
  //   = 表头单元格文本 + 分隔行声明的列数
  // 不含数据行（表内增删数据行不换身份）、不含对齐标记（改对齐不换身份）。
  const signature = localSignature(startLine, getLine);
  // 同签名表格在文档中的**序位**：插入/删除「上方任意行」都不改变它，
  // 是区分「签名完全相同的多张表」的唯一稳定线索（仅靠签名会撞身份）。
  const rank = countPrecedingSameSignature(startLine, signature, getLine);

  // 匹配**只认 `(签名, 序位)`**（确定性、无跨表串号）。
  // 曾考虑过「列数相同 + 上次位置最近」的兜底匹配以覆盖「表头被编辑」的场景，
  // 但实测该兜底会**把身份偷给邻近的另一张表**（比它要解决的问题更严重），故弃用。
  const hit = findBySignatureRank(signature, rank);

  const id = hit ? hit.id : `t${nextId++}`;
  const entry: RegistryEntry = {
    id,
    startLine,
    endLine,
    separatorLine,
    hasHeader,
    cols,
    alignments: readAlignments(separatorLine, cols, getLine),
    signature,
    rank,
    touched: ++touchClock,
  };
  registry.set(id, entry);
  evictIfNeeded();
  return id;
}

/** 局部签名：只读表头行与分隔行（用于签名匹配与序位扫描，二者必须同口径）。 */
function localSignature(startLine: number, getLine: (i: number) => string): string {
  const sep = detectSeparatorLine(startLine, startLine + 1, getLine);
  const hasHeader = sep !== null && sep === startLine + 1;
  const headerCells = hasHeader ? splitRowCells(getLine(startLine)) : [];
  const sepCols = sep !== null ? splitRowCells(getLine(sep)).length : 0;
  return `${headerCells.join('\u0001')}\u0002${sepCols}`;
}

/**
 * 统计本表之前有多少张**同签名**的表格（= 本表在该签名组内的序位）。
 * 扫描口径：表格起始行 = 表格行且其上一行不是表格行。
 */
function countPrecedingSameSignature(
  startLine: number,
  signature: string,
  getLine: (i: number) => string
): number {
  const belongs = (i: number): boolean => i >= 0 && getLine(i).trim().startsWith('|');
  let rank = 0;
  for (let i = startLine - 1; i >= 0; i--) {
    if (!belongs(i)) continue;
    if (belongs(i - 1)) continue; // 不是表格起始行
    if (localSignature(i, getLine) === signature) rank++;
  }
  return rank;
}

function findBySignatureRank(signature: string, rank: number): RegistryEntry | null {
  for (const e of registry.values()) {
    if (e.signature === signature && e.rank === rank) return e;
  }
  return null;
}

function evictIfNeeded(): void {
  if (registry.size <= REGISTRY_LIMIT) return;
  const sorted = [...registry.values()].sort((a, b) => a.touched - b.touched);
  const drop = registry.size - REGISTRY_LIMIT;
  for (let i = 0; i < drop; i++) {
    const victim = sorted[i];
    if (victim) registry.delete(victim.id);
  }
}

/** 分隔行探测（与 `tableModel.isSeparatorText` 同源语义，但只依赖行文本）。 */
function detectSeparatorLine(
  startLine: number,
  endLine: number,
  getLine: (i: number) => string
): number | null {
  const isSep = (i: number): boolean => {
    const t = getLine(i);
    if (t.length > 10_000) return false;
    return /^\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?$/.test(t);
  };
  if (endLine < startLine) return null;
  if (isSep(startLine)) return startLine;
  if (endLine > startLine && isSep(startLine + 1)) return startLine + 1;
  return null;
}

function computeCols(
  startLine: number,
  endLine: number,
  separatorLine: number | null,
  getLine: (i: number) => string
): number {
  let cols = 0;
  for (let i = startLine; i <= endLine; i++) {
    if (i === separatorLine) continue;
    cols = Math.max(cols, splitRowCells(getLine(i)).length);
  }
  if (separatorLine !== null) {
    cols = Math.max(cols, splitRowCells(getLine(separatorLine)).length);
  }
  return cols;
}

/** 列对齐（投影为三值：`none → left`，与 `parseTableAlignments` 既有行为一致）。 */
function readAlignments(
  separatorLine: number | null,
  cols: number,
  getLine: (i: number) => string
): ColumnAlignment3[] {
  const out: ColumnAlignment3[] = new Array(cols).fill('left');
  if (separatorLine === null) return out;
  const cells = splitRowCells(getLine(separatorLine));
  for (let c = 0; c < cols && c < cells.length; c++) {
    const t = cells[c].trim();
    const starts = t.startsWith(':');
    const ends = t.endsWith(':');
    if (starts && ends) out[c] = 'center';
    else if (ends) out[c] = 'right';
    else out[c] = 'left';
  }
  return out;
}

// ── 消费侧查询（渲染层不再需要知道身份格式）────────────────────────────────

/** 取身份条目（未观测过则返回 `undefined`）。 */
export function getTableIdentity(id: string | undefined): TableIdentityEntry | undefined {
  if (!id) return undefined;
  return registry.get(id);
}

/**
 * 该行是否为所属表格的**表头行**（I5：表头语义的唯一判定入口）。
 * 取代此前渲染层的 `tableId === \`table-${index}\`` 二次推导。
 */
export function isTableHeaderRow(id: string | undefined, lineIndex: number): boolean {
  const e = getTableIdentity(id);
  return Boolean(e && e.hasHeader && e.startLine === lineIndex);
}

/** 取该表的列对齐（三值；未观测过则返回空数组）。 */
export function readTableAlignments(id: string | undefined): ColumnAlignment3[] {
  const e = getTableIdentity(id);
  return e ? e.alignments : [];
}

/** 该表的分隔行行号（`null` = 无分隔行）。 */
export function getTableSeparatorLine(id: string | undefined): number | null {
  const e = getTableIdentity(id);
  return e ? e.separatorLine : null;
}

// ── 生命周期 ────────────────────────────────────────────────────────────────

/**
 * 只保留给定 id 集合（整文替换 / 文档大幅收缩后清理视图状态与注册表）。
 * @returns 被移除的 id 列表
 */
export function pruneTableIdentities(activeIds: ReadonlySet<string>): string[] {
  const removed: string[] = [];
  for (const id of [...registry.keys()]) {
    if (!activeIds.has(id)) {
      registry.delete(id);
      removed.push(id);
    }
  }
  return removed;
}

/** 清空注册表（整文替换 / 测试隔离用）。 */
export function resetTableIdentities(): void {
  registry.clear();
  nextId = 1;
  touchClock = 0;
}

/** 注册表条目数（测试与观测用）。 */
export function tableIdentityCount(): number {
  return registry.size;
}

/** 类型再导出，便于消费方只依赖本模块。 */
export type { ColumnAlignment };
