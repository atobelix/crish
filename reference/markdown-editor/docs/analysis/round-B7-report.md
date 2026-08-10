# B7 轮次报告（P2 收尾清理）

> 输入：plan-P2（B7 批次：占位清理 + A1 回修 4-7）+ review-P1 回修清单。
> 输出：收尾清理完成说明 + 已知项登记（Up/Down 全文 getText）。
> 执行：B7 Agent（P2 轮 1，与 B1/B8a 并行，文件域互斥）。

## 清理清单（四项）

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 占位清理：删除已落地类占位 | ✅ G6/G9/G10 占位已删；G1-G5/G7/G8 未落地，保留并注释 | `tests/gate/placeholder.test.ts`（现仅 7 个 describe） |
| 2 | 2b 测试补全 streamTailCodeState | ✅ 补 `streamTailCodeState: new Array(3000).fill('none')`，行/状态数匹配 | `tests/unit/arrow-perf.test.ts:191-198` |
| 3 | 注释措辞：Object.create vs setPrototypeOf | ✅ 改为准确描述（字面量构造 → delete 视图字段 → setPrototypeOf） | `src/core/EditorStore.ts:1374-1380` |
| 4 | Up/Down 全文 getText 优化登记 | ✅ 见下节「已知项登记」 | 本文档 |

### 1. 占位清理明细

- **已删**（真实测试已落地，coverage-tracker.md 已勾选）：
  - G6 CSS 契约 → `tests/unit/css-contract.test.ts`
  - G9 内存门禁 → `tests/unit/memory-bounds.test.ts`
  - G10 交叉矩阵 → `tests/unit/cross-matrix.test.ts`
- **保留**（真实断言未落地，coverage-tracker 均为 0 勾选）：G1-G5/G7/G8，
  共 7 个 describe 占位，文件头注释已更新为「仅未落地类别」口径并说明
  落地后删除约定；文件头保留类别映射依据（03 文档 + 09 修正）。
- 占位文件顶部注释已同步更新（P2-B7 清理说明），不再声称「G1-G10 各一」。

### 2. 2b 测试补全明细

`arrow-perf.test.ts` 2b（append 基准）原构造只设 `streamTail` 未设
`streamTailCodeState`（3000 行尾段 vs 空 codeState，物化视图
`codeBlockState` 长度与 `lines` 不匹配——A1 回修 6）。已补
`streamTailCodeState: new Array(3000).fill('none')`，与
`materializeViews` 的拼接口径（主数组 `.slice(0,-1)` + 尾段）对齐后
`codeBlockState.length === lines.length`，测试构造如实反映双段存储语义。
性能断言（append 耗时 <0.6ms）不受影响。

### 3. 注释措辞明细

`EditorStore.ts:1374` 原注释「初始 state 经 `Object.create(lazyViewProto)`
挂惰性视图原型」与实现不符（实现为字面量对象 + `Object.setPrototypeOf`，
见 2406-2412）。已改为准确描述：字面量构造（含视图占位字段满足类型推断）
→ delete 视图字段 → setPrototypeOf 挂原型。纯注释改动，无行为变化。

## 已知项登记（供后续轮次）

### Up/Down 垂直导航仍走全文 getText（review-P1 回修 8）

- **现状**：`src/core/measure.ts`（navigateOffscreenLine）垂直导航仍读
  `store.lines`（惰性 getter：尾段空时零拷贝，尾段非空流式期间每键
  O(全文) concat 物化）；`HiddenInput.tsx` Up/Down 分支保留全文
  `getText()`（snapToGraphemeBoundary 定位）与 DOM 测量——1M 行文档下
  仍有毫秒级延迟。P1 只根治 Left/Right，声明范围如实。
- **后续优化方向**（不属 P2 各批次现有范围）：
  1. `measure.ts` 视口外导航改 `getLineCount()` + `getLine(i)` 访问器
     （review-P1 回修 1，B1 已计划处理）；
  2. Up/Down 的 `snapToGraphemeBoundary` 落点经 LineOffsetTree
     行定位 + 行内 grapheme 移动（复用 P1 行文本模式），消除全文
     `getText()` 依赖；
  3. `src/main.tsx:28` 调试指标 `getLineCount` 可顺手改访问器。
- **登记时间**：2026-08-10（B7），来源 review-P1 §5 隐藏消费者清单。

### subscribe 同步窗口（review-P1 回修 7）

- rawSetState 同步触发 listeners 时 setPrototypeOf 尚未执行，非 React
  订阅者若在回调内同步读 `state.lines` 得 undefined——建议在
  lazyViewProto 注释登记。**B7 任务书未分配该项**（文件域限定
  EditorStore.ts 1374 行附近注释），留待后续轮次或并入 B1 处理。

## 测试结果

- `npx tsc -b`：0 错误（见验证记录）
- `npm run test:gate`：全绿（占位文件变更后计数变化记录）
- 编码：UTF-8 无 BOM；中文注释；未 commit（按任务书）。

## 结论

四项清理全部完成：无已落地类占位残留；2b 构造完整；注释措辞与实现一致；
Up/Down 已知项已登记供后续轮次。0 回归。
