# `@crish/editor-kit`

块纸面 **投影控制面**（W3-A + W3-B）：Viewport 窗口、HeightMap、pin、mock `ProjectionDiff` 应用、逻辑选区、IME 状态机。

## 边界

| 本包 **做**                            | 本包 **不做**                |
| -------------------------------------- | ---------------------------- |
| 展开序列上的可见窗口 + overscan        | 完整 PM / CE 叶子（W3-D）    |
| 预估高度 + 实测回填 + prefix sum       | 真实 DocSession / RS 接线    |
| 焦点 + composing pin 不变量            | 行级 `Doc` store / `lines[]` |
| 内存态增量 Diff + `fullRemountCount`   | CSS `hidden` 假虚拟化        |
| 逻辑选区 `blockId+offset` / 块多选     | 像素测距选块                 |
| IME Idle/Composing + 结构键/slash 守卫 | 真实 composition DOM 绑定    |

**禁止** 与 `reference/markdown-editor` 共享行级文档模型；可共享的是 IME/虚拟化 **纪律**，不是 store。

## 导出一览

```ts
import {
  queryViewport,
  queryViewportByScroll,
  HeightMap,
  buildPinSet,
  assertUnmountAllowed,
  applyProjectionDiff,
  createDiffApplyState,
  // W3-B
  SelectionStore,
  ImeMachine,
  guardStructureIntent,
  filterStructureIntents,
} from '@crish/editor-kit';
```

类型契约（`ProjectionDiff` / `MountSpec` / `BlockId` / `Intent`）依赖 `@crish/block-paper-contract`。

## SelectionStore（逻辑选区）

权威坐标 = `{ blockId, offset }` 或块多选 `blockIds[]`。**不**读像素、**不**以 `getBoundingClientRect` 选块。

| API                         | 语义                                   |
| --------------------------- | -------------------------------------- |
| `setCaret(blockId, offset)` | 折叠光标                               |
| `setRange(anchor, head)`    | 有方向文本选；重合 → caret             |
| `setBlockMulti(blockIds)`   | 块多选（逻辑 id）                      |
| `clear()` / `getSnapshot()` | 清空 / 只读快照（含 `pinnedBlockIds`） |

快照 `pinnedBlockIds` 供 `buildPinSet({ extraPinned })` 合并。

## IME 状态机 + 结构键守卫

```ts
const ime = new ImeMachine();
ime.startComposition(blockId);   // → Composing；块进入 pin
ime.updateComposition('候选');
ime.tryAcceptIntent({ type: 'op', ops: [...], intentId }); // composing → reject
ime.assertUnmount(blockId, { focusId }); // composing/焦点 → PinViolationError
ime.endComposition('最终文本');  // → Idle；结构键恢复放行
```

| 相位          | 允许                          | 禁止                                                                   |
| ------------- | ----------------------------- | ---------------------------------------------------------------------- |
| **Idle**      | 结构键、slash、非 pin unmount | —                                                                      |
| **Composing** | 文本缓冲 / preview            | 结构 `op` / `structure_key` / `request_slash`；卸载焦点或 composing 块 |

`structureKeyGuard` 可独立用于 keymap 过滤：`guardStructureIntent(composing, intent)` / `filterStructureIntents`。

## 脚本

```bash
npm run typecheck -w @crish/editor-kit
# 单测由 monorepo vitest unit 项目拾取 packages/*/src/**/*.test.ts
npx vitest run packages/editor-kit/src
```

## 不变量速查

1. `composing` 块必须在 `pinned`（用 `buildPinSet` / `ImeMachine.buildPinned` 自动并入）
2. 卸载焦点块 / composing 块 → `PinViolationError`
3. 默认 Diff 路径 `fullRemountCount === 0`（A-IME-07）
4. 未知块不推断变更（仅 `upserts` / `removes` / `textTouches`）
5. 选区权威在逻辑坐标；禁止像素测距选块（A-SEL-01）
6. 合成中禁 slash / 结构键 / 结构 Op（A-IME-02）
