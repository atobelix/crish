/**
 * TableIslandRow —— 表格岛内的**一行**（战役 table-systemic-remediation · T3/T4）
 *
 * 权威文档：docs/table-systemic-remediation/04-分维-单容器渲染与测量时序.md §3.1
 *          docs/table-systemic-remediation/00-总方案-表格子系统端到端重构.md（ADR-2）
 *
 * 职责边界（SSOT，不得越界）：
 *   - 行级派生（行内 token / 活动态 / 搜索命中 / 流式预演 / 表格身份）**一律**经
 *     `deriveLineUnit`（`src/core/lineUnit.ts`）——与旧路径 `MarkdownEngine.LineItem`
 *     共用同一派生单元。本组件**不**调 parser、**不**自行实现 activeState 派生，
 *     否则同一源码行在两条路径下可能得到不同 token（ADR-2 明令禁止）。
 *   - 本组件是岛内的**普通流内元素**（不是外层虚拟行）：不写 position/top/width
 *     等定位样式、不带 `virtual-row` 类、不提供 `data-index`（I8：`data-index`
 *     在全局唯一，岛内行只用 `data-line-index`）。
 *   - 列宽由岛根一次算出的 `rowStyle`（`grid-template-columns`，ADR-4 唯一列宽真源）
 *     驱动；单元格不写任何宽度——旧路径 per-cell `flex: 0 0 Npx` 的写回在岛内不被消费。
 *
 * 与旧路径 `TableRowBlock` 的差异（04-分维 §3.1 明确要求补上的接线）：
 *   活动行 class `is-active-line` 由本组件按 `activeState` 命中自行附加
 *   （`index.css:453-468` 依赖该 class 控制分隔行 0↔28px 展开；旧路径
 *   `BlockRenderer.tsx:1540` 现状未加，属岛路径的接线点）。
 */
import React from 'react';
import type { DecorationSet } from '../core/DecorationSet';
import { deriveLineUnit, lineTokens } from '../core/lineUnit';
import type { LineParseContext } from '../core/DocumentContext';
import { InlinePreviewContext, InlineRenderer } from './InlineRenderer';

/**
 * 行状态类型。与 `TableBlock` 同款，刻意用**内联** `import(...)` 类型引用而非
 * 顶层 `import type`：门禁 `tests/gate/table-invariants.test.ts` 断言岛组件
 * 不得出现 parser 的顶层导入（防「岛内出现第二套行解析」）。`CodeState` 只是
 * 类型契约，不引入运行时依赖，也不构成任何解析路径。
 */

export interface TableIslandRowProps {
  /** 源码绝对行号（岛内行的唯一标识：`key` 与 `data-line-index` 同源，I8）。 */
  index: number;
  /** 本行源码文本（由岛根经 `getLine` 惰性读取后传入）。 */
  lineText: string;
  /** 本行在文档中的起始偏移（`InlineRenderer` 需要；岛根按行序累加得出）。 */
  offset: number;
  /** 行状态（`lineUnit.getLineState` 包装产物）。 */
  context: LineParseContext;
  /** 表格稳定身份（岛根已有值，逐行透传，供单元格交互使用）。 */
  tableId: string;
  /** 是否表头行（`tableIdentity.isTableHeaderRow` 唯一入口判定，I5）。 */
  isHeader: boolean;
  /** 是否分隔行（高 0 与裁剪由 `.table-island-separator-row` 负责）。 */
  isSeparator: boolean;
  /** 共享装饰集（引擎注入）。 */
  decorations: DecorationSet;
  /** 本行**行级**装饰版本（R6-C：本行装饰内容变化才重派生）。 */
  rowDecorationVersion: number;
  /** 行内容访问器（惰性；供 callout 上下文与表格身份派生使用）。 */
  getLine: (i: number) => string;
  /** 是否流式末行（仅该行做未闭合预演）。 */
  isStreamingTail: boolean;
  /** 行容器样式（岛**一次**算出的列宽栅格模板，ADR-4 唯一列宽真源）。 */
  rowStyle: React.CSSProperties;
}

export const TableIslandRow: React.FC<TableIslandRowProps> = React.memo(
  function TableIslandRow({
    index,
    lineText,
    offset,
    context,
    tableId,
    isHeader,
    isSeparator,
    decorations,
    rowDecorationVersion,
    getLine,
    isStreamingTail,
    rowStyle,
  }: TableIslandRowProps) {
    // 逐行派生（SSOT：与 LineItem 同源）。
    // 依赖含 `rowDecorationVersion`（R6-C 行级装饰版本）——本行装饰内容变化才
    // 重派生；其他行装饰变化时依赖不变 ⇒ memo 命中、派生不重跑。
    // `tableId` **传入**（岛根已解析出身份）：`deriveLineUnit` 见到入参即短路，
    // 不再逐行触发 `resolveTableId` 的「同签名序位」扫描（O(前序行数)/行）。
    const unit = React.useMemo(
      () =>
        deriveLineUnit({
          index,
          lineText,
          offset,
          context,
          decorations,
          rowDecorationVersion,
          getLine,
          isStreamingTail,
          tableId,
        }),
      // oxlint-disable-next-line react-hooks/exhaustive-deps
      [
        decorations,
        rowDecorationVersion,
        offset,
        lineText,
        context,
        isStreamingTail,
        tableId,
        getLine,
      ]
    );

    const activeState = unit.activeState;

    return (
      // 行容器 class 拼接（04-分维 §3.1）：岛内行 → 表头 → 分隔 → 活动行 → 搜索命中。
      // `is-active-line` 是分隔行 0↔28px 展开的唯一开关（index.css:453-460），
      // 也是旧路径 `BlockRenderer.tsx:1540` 缺失、由岛路径补上的接线。
      <div
        className={`table-island-row${isHeader ? ' table-header-row' : ''}${
          isSeparator ? ' table-island-separator-row' : ''
        }${activeState !== null ? ' is-active-line' : ''}${
          unit.hasSearchDecoration ? ' is-search-line' : ''
        }`}
        data-line-index={index}
        // `data-line-start` / `data-line-length`：`src/core/measure.ts` 的容器
        // 索引按这两个属性建立「行 → 字符区间」映射（光标坐标测量依赖）。
        // `data-index` 刻意**不提供**——该属性要求全局唯一（I8），岛宿主行已占用；
        // 依赖它的上下方向键跨行导航在岛内退化为「目标行未挂载」路径（T5/T6 收敛项）。
        data-line-start={offset}
        data-line-length={lineText.length}
        style={rowStyle}
      >
        <InlinePreviewContext.Provider value={unit.previewHint}>
          <InlineRenderer
            tokens={lineTokens(unit)}
            lineOffset={offset}
            activeState={activeState}
            tableId={tableId}
            lineIndex={index}
          />
        </InlinePreviewContext.Provider>
      </div>
    );
  }
);
