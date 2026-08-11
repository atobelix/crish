# `@crish/block-paper`

块纸面 **呈现层**：W3-C chrome（静默假数据 / 把手 / slash）+ W3-D 叶子写路径 Intent 骨架 + W3-E CM6 代码叶骨架 + W3-F 结构 Intent（mock apply）。

> **本包是呈现层，不是文档权威。**  
> 写路径必须走 **Intent → sink → RS apply**。  
> **禁止** 把 DOM / ProseMirror doc / 本包假数据当作真相源持久化。  
> **W3-D 完成 = Intent 通路绿**；**W3-E 完成 = 代码叶可聚焦 + Intent 通路绿**；≠ EL-01 / A-BLK 全表关闭。  
> **W3-E ≠ 全语言高亮完成**（language 字段与 host 钩子就位即可）。

## 边界

| 本包 **做**                                      | 本包 **不做**                        |
| ------------------------------------------------ | ------------------------------------ |
| 静默 L0 chrome 状态（把手/折叠/多选高亮）        | 真实 DocSession / RS / 协同接线      |
| Slash 打开/过滤/关闭（composing 禁开）           | 完整 PM/CM6 编辑器（仅 Intent 接口） |
| N 块假投影（`ProjectionDiff` / `MemoryBlock`）   | 结构 Op 真正落地到真实 collab        |
| 叶子 `TextEditIntent` 产出 + mock sink           | 接 `apps/crish-desktop` 业务         |
| 代码叶可聚焦 + `text_edit` + 真 CM6 host（W3-E） | 全语言 SyntaxHighlight / 主题完成    |
| V6 行/字符窗口计算（A-HUGE-03 呈现侧）           | 数据层超长分段（W1-B）               |

依赖：

- `@crish/block-paper-contract` — W0 类型（`ProjectionDiff` / `Intent` / `BlockId` …）
- `@crish/editor-kit` — `ImeMachine` / `structureKeyGuard` / `MemoryBlock` / 投影 diff

## 导出一览

```ts
import {
  BlockChromeModel,
  SlashMenuModel,
  createSilentFixture,
  listSilentBlocks,
  DEFAULT_SLASH_CATALOG,
  // W3-D
  TextLeafModel,
  submitIntent,
  createMockIntentSink,
  computeLineWindow,
  // W3-E
  CodeLeafModel,
  createMockCodeLeafHost,
  Cm6CodeLeafHost,
  mountCodeLeaf,
} from '@crish/block-paper';
```

## 静默假数据（A-SIL 子集）

```ts
const fixture = createSilentFixture(32, { docId: 'demo' });
// fixture.state 已 apply 增量 Diff；fullRemountCount === 0
// fixture.blocks / fixture.order 符合 MemoryBlock 形状
const blocks = listSilentBlocks(fixture);
```

假数据 **仅供 chrome 原型与单测**；接真实键入必须等 01+04 投影通道。

## BlockChromeModel

| API                                       | 语义                                      |
| ----------------------------------------- | ----------------------------------------- |
| `setHovered` / `setFocused`               | 按需露出把手                              |
| `getHandleVisibility(id)`                 | `hidden` \| `hover` \| `focus` \| `multi` |
| `setCollapsed` / `toggleCollapsed`        | 折叠呈现态                                |
| `setMultiSelected` / `clearMultiSelected` | 多选高亮（逻辑 id）                       |
| `resetToSilent`                           | 清 hover/focus/多选/命令 → L0 纸面        |

默认 **L0**：无交互时所有把手 `hidden`（A-SIL-01：无常驻噪声）。

## SlashMenuModel + IME

```ts
const imeComposing = { current: false };
const slash = new SlashMenuModel({
  isComposing: () => imeComposing.current,
});

imeComposing.current = true;
slash.open('b-0001', 0); // → { ok: false, code: 'composing' }

imeComposing.current = false;
slash.open('b-0001', 0); // → ok
slash.setQuery('标');
slash.close(); // A-SIL-02：关闭后宿主保持选区
```

对齐 editor-kit `structureKeyGuard` / A-IME-02：**composing 时禁止打开 slash**。

## 叶子写路径：Intent → sink → RS（W3-D）

```text
键入 / IME
   │
   ▼
TextLeafModel.applyLocalEdit / flushOnCompositionEnd
   │  产出 TextEditIntent（W0 形状）
   ▼
submitIntent(intent, sink, { ime })
   │  composing 时结构 op / slash 拒绝
   ▼
IntentSink（mock 记录 或 未来 RS IPC）
   │
   ▼
RS apply → DocEvent.projection / reject
```

### TextLeafModel

| API                                  | 语义                                                |
| ------------------------------------ | --------------------------------------------------- |
| `applyLocalEdit(start, end, insert)` | 更新 plain 缓冲；非 composing 返回 `TextEditIntent` |
| `beginComposition(anchor)`           | 进入合成；之后 `applyLocalEdit` **不**发 Intent     |
| `flushOnCompositionEnd(final?)`      | 合成结束产出一条 `text_edit`                        |
| `cancelComposition()`                | 回滚缓冲，无 Intent                                 |
| `replaceFromProjection(text)`        | 权威回填；composing 期拒绝                          |

```ts
import {
  TextLeafModel,
  submitIntent,
  createMockIntentSink,
} from '@crish/block-paper';
import { ImeMachine } from '@crish/editor-kit';

const leaf = new TextLeafModel('block-1', 'Hello');
const mock = createMockIntentSink();
const ime = new ImeMachine();

// 普通键入
const intent = leaf.applyLocalEdit(5, 5, '!');
await submitIntent(intent!, mock.sink, { ime });
// mock.calls[0] === TextEditIntent

// IME
ime.startComposition('block-1');
leaf.beginComposition(6);
leaf.applyLocalEdit(6, 6, '你'); // 仅本地，无 Intent
ime.endComposition('你');
const flushed = leaf.flushOnCompositionEnd('你');
await submitIntent(flushed!, mock.sink, { ime });
```

### intentBridge

- `submitIntent`：经 `ImeMachine.tryAcceptIntent` / `structureKeyGuard` 后调用 sink
- composing 时 **结构 Intent**（`op` / `structure_key` / `request_slash`）拒绝
- `createMockIntentSink()`：默认 `{ ok: true }`，`calls` 数组可审计
- **尚未**接真实 RS；W0 冻结禁止 W3-D 接真实 apply 前本 sink 即为契约桩

### lineWindow（V6 / A-HUGE-03）

| 常量 / API                               | 默认 / 语义                         |
| ---------------------------------------- | ----------------------------------- |
| `DEFAULT_PM_NODE_SOFT_BYTES`             | **64 KiB**（UTF-8）；超阈必须窗口化 |
| `DEFAULT_EDIT_WINDOW_LINES`              | 200 行上界                          |
| `computeLineWindow(text, focus, cfg?)`   | 多行按行窗口；无换行按 char 窗口    |
| `getOffsetWindow` / `getLineWindowSlice` | HugeLeafEditorHost 纯函数形态       |

## 代码叶：CM6 host 接线（W3-E / Round8）

> **W3-E ≠ 全语言高亮完成。**  
> 已接线：可聚焦、`language` / `readOnly` / content snapshot、变更 → `text_edit` → `submitIntent`、**真 `Cm6CodeLeafHost`（`@codemirror/view` EditorView）**。  
> 语言：`plaintext` + **`javascript`（`@codemirror/lang-javascript`）** Compartment 可换；其余 id 回落 plain。  
> 默认 mount 仍用 `DomCodeLeafHost`（textarea）；真 CM6 经 `createHost: (el) => new Cm6CodeLeafHost(el, …)`。  
> 单测：`createCm6EditorState` + 真实 `EditorState` 证明依赖接线；**不接真实 RS**。

```text
focus()
   │
   ▼
CodeLeafModel.applyLocalEdit / tryApplyLocalEdit
   │  产出 TextEditIntent（W0 形状，与文本叶共用 sink）
   ▼
submitIntent(intent, sink, { ime })
   │
   ▼
IntentSink（mock 或未来 RS IPC）
```

| API                                        | 语义                                                          |
| ------------------------------------------ | ------------------------------------------------------------- |
| `focus()` / `blur()`                       | 可聚焦；同步 `CodeLeafHost`                                   |
| `getSnapshot()`                            | `content` / `language` / `readOnly` / `focused` / `composing` |
| `applyLocalEdit(start, end, insert)`       | 只读 → null；composing → 仅本地；否则 `text_edit`             |
| `tryApplyLocalEdit(..., { requireFocus })` | 带 `read_only` / `not_focused` 拒绝码                         |
| `setLanguage` / `setReadOnly`              | 元数据 + host 钩子（CM6：`Compartment.reconfigure`）          |
| `Cm6CodeLeafHost`                          | 真 EditorView；`getEditorView()` / `onDocChanged`             |
| `createCm6EditorState`                     | 无 DOM 可构造 `EditorState`（语言/只读 Compartment）          |
| `mountCodeLeaf(el, opts)`                  | DOM 挂载；CM6 host 时 `getEditorView()` 返回真实 View         |

```ts
import {
  CodeLeafModel,
  createMockCodeLeafHost,
  Cm6CodeLeafHost,
  mountCodeLeaf,
  submitIntent,
  createMockIntentSink,
} from '@crish/block-paper';

// —— 单测 / 无 DOM：mock host ——
const host = createMockCodeLeafHost();
const leaf = new CodeLeafModel('block-code', 'const x = 1;', {
  language: 'javascript',
  host,
});
const mock = createMockIntentSink();

leaf.focus();
const intent = leaf.applyLocalEdit(12, 12, '0');
await submitIntent(intent!, mock.sink);
// mock.calls[0].type === 'text_edit'

leaf.setReadOnly(true);
expect(leaf.applyLocalEdit(0, 0, 'x')).toBeNull(); // 只读拒绝

// —— 浏览器：真 CM6 host ——
// const { model, getEditorView, unmount } = mountCodeLeaf(el, {
//   blockId: 'b-code',
//   language: 'javascript',
//   initialContent: 'const x = 1;',
//   createHost: (parent) =>
//     new Cm6CodeLeafHost(parent, {
//       language: 'javascript',
//       initialContent: 'const x = 1;',
//       onDocChanged: (content) => {
//         const old = model.getContent();
//         if (old !== content) model.applyLocalEdit(0, old.length, content);
//       },
//     }),
// });
// getEditorView(); // → EditorView
// unmount();
```

## 不变量速查

1. **DOM 不是真相** — 投影与选区逻辑坐标才是呈现源；写必须 Intent→sink→RS
2. **静默默认 L0** — chrome 按需（hover / 多选 / 命令态）
3. **composing 禁 slash / 结构 op** — 注入 `isComposing` / `ImeMachine`，与 editor-kit 一致
4. **假数据可加载不抛** — `createSilentFixture(n)` 对任意有限 n≥0 安全
5. **多选是逻辑 id 列表** — 禁止像素测距选块（A-SEL-01）
6. **超长叶必须窗口** — `≥ T_PM_NODE_SOFT` 禁止无窗口整段挂载（A-HUGE-03 骨架）
7. **代码叶可聚焦才走严格编辑** — `tryApplyLocalEdit` 默认 `requireFocus`；只读硬拒绝
8. **W3-E ≠ 高亮完成** — 真 CM6 host 已接线；当前仅 plain + javascript；其余 lang 包按需后接

## 脚本

```bash
npm run typecheck -w @crish/block-paper
npx vitest run packages/block-paper/src
# 或
npm test -w @crish/block-paper
```

## 任务索引

- 方案：`docs/block-workspace-architecture/plans/05-块呈现与交互.md`
- W0 Intent：`plans/interfaces/00-W0接口冻结.md`、`@crish/block-paper-contract`
- 超长：`plans/specs/huge-block-policy.md`（V6 呈现侧）
- IME/投影：`plans/04-投影虚拟化与IME.md`、`@crish/editor-kit`
- 验收：A-SIL 子集（W3-C）+ Intent 通路绿（W3-D）+ 代码叶可聚焦（W3-E）；**≠ EL-01 / A-BLK 全表关闭**；**W3-E ≠ 全语言高亮完成**
