# 审计报告：第五部分 前端状态管理质量提升（5.1-5.5）

> 基于 `refactor_plan.md` 第 603-745 行，结合代码库实际扫描结果生成。
> 审计日期：2026-07-23

---

## 5.1 清除僵尸代码：`store/actions/` 目录

### 5.1.1 无引用确认

**结论：方案结论成立，但 actions/settings.ts 有特殊之处。**

全代码库 grep 以下 pattern 均未命中：

| Pattern | 结果 |
|---|---|
| `from '.*store/actions/chat'` | 0 匹配 |
| `from '.*store/actions/agent'` | 0 匹配 |
| `from '.*store/actions/composer'` | 0 匹配 |
| `from '.*store/actions/settings'` | 0 匹配 |
| `from '.*store/actions/terminal'` | 0 匹配 |
| `import.*create(Chat\|Agent\|Composer\|Terminal)Actions` | 0 匹配 |

**特别说明**（方案遗漏）：

- **`store/actions/settings.ts`** (`refactor_plan.md:611`) 不导出自包含的 action factory，而是导出 **5 个具名函数**（`setUiSize`、`setShellChromeMode`、`setChatMainSurface`、`setSidebarCollapsed`、`setAppSettings`）。这些函数直接调用 `useSettingsUiStore.setState(...)`。它们**确实也没有外部 import 引用**，清理无风险。

- **`store/actions/terminal.ts`** 导出的 `addTerminalLine` / `clearTerminalLines` **没有 import 引用**，同样安全。

### 5.1.2 代码漂移检查

方案要求逐项比对 `actions/chat.ts` 与 `sessionActions.ts`。扫描结果：

| 函数 | `actions/chat.ts` | `sessionActions.ts` | 差异分析 |
|---|---|---|---|
| `addMessage` | 完整实现 (`chat.ts:27-51`) | 完整实现 (`sessionActions.ts:385-440`) | `sessionActions` 有额外 `maxMessages` 保护和 `pinnedMessageIds` 清理；**`chat.ts` 版更简单（缺 pruning）** |
| `updateMessageText` | 含完整实现 (`chat.ts:87-105`) + `batchUpdateMessageText` (`chat.ts:107-126`) | 含完整实现 + `precomputedHtml` 参数 (`sessionActions.ts:549-587`) | **`chat.ts` 无 `precomputedHtml` 处理**，有 `batchUpdateMessageText` 专属实现 |
| `addMessageToolCall` | 完整实现 (`chat.ts:136-164`) | 完整实现 (`sessionActions.ts:599-652`) | 逻辑等价 |
| `updateMessageToolCall` | 完整实现 (`chat.ts:166-179`) | 完整实现 (`sessionActions.ts:654-677`) | 逻辑等价 |
| `setSessionMessageStatus` | 签名含 `status: any` (`chat.ts:181`) | 签名含 `status` 具体类型 | `chat.ts` 类型安全退化 |
| `respondToApproval` | 有 (`chat.ts:76-84`) | 有 (`sessionActions.ts:460-469`) | 等价 |
| `withdrawMessage` | 有 (`chat.ts:53-74`) | 有 (`sessionActions.ts:473-507`) | `sessionActions.ts` 有额外快照保护 |
| `batchUpdateMessageText` | 有 (`chat.ts:107-126`) | **缺失** | sessionActions 无双参数版 `updateMessageText` 已覆盖相同能力 |

**结论**：`chat.ts` 代码逻辑均在 `sessionActions.ts` 中覆盖，无独有逻辑。删除安全。

对于 `agent.ts`：

| 函数 | `actions/agent.ts` | `sessionActions.ts` | 差异 |
|---|---|---|---|
| `setActiveAgentId` | 有 (`agent.ts:10-13`) | 有 (`sessionActions.ts:770-780`) | 等价 |
| `setPanelAgentId` | 有 (`agent.ts:15-17`) | 有 (`sessionActions.ts:782-785`) | 等价 |
| `upsertSessionAgent` | 有 (`agent.ts:19-26`) | 有 (`sessionActions.ts:787-805`) | 等价 |
| `patchSessionAgent` | 有 (`agent.ts:28-34`) | 有 (`sessionActions.ts:807-814`) | 等价 |
| `appendSessionAgentMessage` | 有 (`agent.ts:36-45`) | 有 (`sessionActions.ts:829-843`) | 等价 |

### 5.1.3 删除方案

**补充前置步骤**（原方案未提及）：

1. 先将 `store/actions/composer.ts` 中 `setComposerDraft` 的逻辑确认已在 `sessionActions.ts:373-383` 中存在（已确认存在，等价）
2. 删除前确认 `store/index.ts` 无 `export * from './actions/...'` — 已确认无
3. 删除后清理 `actions/` 目录空壳

---

## 5.2 修正 Immer 中的 `Object.assign` 原位突变

### 5.2.1 问题影响范围

**结论：影响范围比方案所述更广。**

#### 在 `sessionActions.ts` 中的 8 处

| 行号 | 代码 | 风险 |
|---|---|---|
| 414 | `Object.assign(existing, prepared)` — `addMessage` 内，对已有消息做字段合并 | Immer draft 的 `existing` 是从数组 `find` 出来的，`Object.assign` 不替换数组槽位引用，**但 Immer 能跟踪 draft 属性的 m**→ 实际 Immer 代理会捕获写操作。此处的**真正问题是**：`existing` 的分量属性（如 `toolCalls`）仍是旧引用，外部 `useShallow` / 选择器若仅引用 `msg.toolCalls`，可能因引用不变而跳过 re-render。中等风险。 |
| 621 | `Object.assign(target, toolCall)` — `addMessageToolCall` 的 `mergeInto` 内 | 同上。更严重：`target` 由 `find` 获得，field-level mutations 对 `target.status` 等 Immer 追踪没有问题，但**对象引用未变**，如果外部有 `Object.is` 或 `React.memo` 依赖整个 `toolCalls` 数组项引用，会无法检测变化。 |
| 675 | `Object.assign(tc, effective)` — `updateMessageToolCall` 内 | 同上。已有 `toolCallPatchHasChanges` guard，但 mutation 模式仍不替换引用。 |
| 757 | `Object.assign(tc, rest)` — `patchAgentTool` 内 终态保护分支 | 同上。 |
| 759 | `Object.assign(tc, patch)` — `patchAgentTool` 内 常规分支 | 同上。 |
| 813 | `Object.assign(ag, patch)` — `patchSessionAgent` 内 | 对 agent 对象做原位突变。同样，**Immer draft 写可追踪，但引用不变**。 |
| 838 | `Object.assign(existing, message)` — `appendSessionAgentMessage` 内 | 同上。 |

#### 在 `providerStore.ts` 中的 4 处（方案未充分覆盖）

这是一个完全独立的 Zustand store（非 layoutStore 门面），但同样使用 `immer` 中间件：

| 行号 | 代码 | 风险 |
|---|---|---|
| 61 | `Object.assign(p, patch, { updatedAt: ... })` — `updateProvider` | 独立 store 独立影响，风险模式相同 |
| 75 | `Object.assign(m, patch)` — `updateModel` | 同上 |
| 86 | `Object.assign(r, patch)` — `updateRoute` | 同上 |
| 94 | `Object.assign(a, patch)` — `updateAccount` | 同上 |

#### 非 Immer 环境（无风险，应排除）

- `agent-daemon/src/task-snapshot-projection.ts:402` — 非 Zustand/Immer
- `ConnectionManager.ts:424` — 普通类、非 Zustand
- `SessionRuntimeRegistry.ts:75` — 普通类、非 Zustand

### 5.2.2 正确替换模式

方案给出的替换模式正确（`findIndex` → 扩展运算符替换数组槽位）。**需补充一个边界情况**：当数组元素是嵌套复杂对象时，`{ ...tc, output, status }` 是浅拷贝，嵌套对象（如 `tc.args` 对象字段）仍共享引用。如果 `output` 以外的字段不会变化，浅拷贝是安全的。但如果其他嵌套字段在两处同时被修改，需要改用 `structuredClone` 或递归合并。

**建议补充**：

```typescript
// 需要深度拷贝的场景（tc 有嵌套对象且上下游共享写）
const tc = msg.toolCalls[tcIndex]!;
if (tc.output !== output || tc.status !== 'completed') {
  msg.toolCalls[tcIndex] = structuredClone(tc);
  msg.toolCalls[tcIndex]!.output = output;
  msg.toolCalls[tcIndex]!.status = 'completed';
}
```

但在当前代码中，`MessageToolCall` 的分量字段（`output` / `status` / `arguments` / `explanation`）都是 `string` 或简单联合类型，浅拷贝足够安全。

### 5.2.3 ESLint 规则补充实现

当前 `eslint.config.js`（根级 + `crish-desktop/eslint.config.js`）均无自定义规则。需要新增一个 no-restricted-syntax 或自定义 rule。

**具体实现**（放在顶层 `eslint.config.js` 或 `apps/crish-desktop/eslint.config.js`）：

```javascript
// 在 crish-desktop/eslint.config.js 中增加
{
  files: ['**/*.{ts,tsx}'],
  plugins: {
    'custom-store': {
      rules: {
        'no-object-assign-in-immer': {
          meta: {
            type: 'suggestion',
            docs: { description: '禁止在 Immer produce/set 回调中使用 Object.assign' },
            schema: [],
          },
          create(context) {
            let inImmerCallback = false;
            return {
              'CallExpression[callee.name="set"] > ArrowFunctionExpression, CallExpression[callee.name="set"] > FunctionExpression': () => {
                inImmerCallback = true;
              },
              'CallExpression[callee.name="set"] > ArrowFunctionExpression:exit, CallExpression[callee.name="set"] > FunctionExpression:exit': () => {
                inImmerCallback = false;
              },
              'CallExpression[callee.object.name="Object"][callee.property.name="assign"]'(node) {
                if (inImmerCallback) {
                  context.report({
                    node,
                    message: '勿在 Immer set 回调中用 Object.assign — 不替换引用，React 可能无法检测变更。使用扩展运算符替换数组/对象槽位。',
                  });
                }
              },
            };
          },
        },
      },
    },
  },
  rules: {
    'custom-store/no-object-assign-in-immer': 'warn',
  },
}
```

但上述实现有缺陷：`set((state) => { ... })` 内嵌套的普通函数不一定是 Immer draft。更准确的检测方式是：

```javascript
module.exports = {
  meta: { /* ... */ },
  create(context) {
    return {
      CallExpression(node) {
        // 检测 immer produce 或 zustand set 回调中的 Object.assign
        const isSetOrProduce =
          node.callee.name === 'set' &&
          (node.arguments[0]?.type === 'ArrowFunctionExpression' ||
           node.arguments[0]?.type === 'FunctionExpression');
        if (!isSetOrProduce) return;
        const callback = node.arguments[0];
        const assignNodes = [];
        // 递归遍历 callback body 找 Object.assign
        const walk = (node) => {
          if (
            node.type === 'CallExpression' &&
            node.callee.type === 'MemberExpression' &&
            node.callee.object.name === 'Object' &&
            node.callee.property.name === 'assign'
          ) {
            assignNodes.push(node);
          }
          for (const key in node) {
            if (key === 'parent') continue;
            if (typeof node[key] === 'object' && node[key] !== null) {
              walk(node[key]);
            }
          }
        };
        walk(callback.body);
        for (const n of assignNodes) {
          context.report({ node: n, message: '...' });
        }
      },
    };
  },
};
```

**方案建议**：使用 `@typescript-eslint/no-restricted-syntax` selector 更简单：

```javascript
rules: {
  '@typescript-eslint/no-restricted-syntax': [
    'warn',
    {
      selector:
        'CallExpression[callee.property.name="set"] CallExpression[callee.object.name="Object"][callee.property.name="assign"]',
      message:
        '勿在 Immer set 回调中用 Object.assign — 不替换引用。用扩展运算符 { ...obj, ...patch } 替换槽位。',
    },
  ],
}
```

**注意**：此选择器仅匹配 `set(...Object.assign(...))` 的嵌套模式。需验证 AST 遍历器是否匹配多级嵌套。若验证不通过，可降级为：
```javascript
selector: 'CallExpression[callee.name="set"] CallExpression MemberExpression[object.name="Object"][property.name="assign"]'
```

---

## 5.3 解耦 `streamTextOffset` 游标与 `SessionMessage` 实体

### 5.3.1 问题确认

**结论：方案问题描述准确，影响面需要精确到文件级别。**

`streamTextOffset` 当前定义在 `types.ts:257` 的 `SessionMessage` 接口上：

```typescript
// types.ts:256-257
/** 上一工具插入时 text 的长度，用于把累计正文切成段 */
streamTextOffset?: number;
```

**序列化路径证实**（方案所担忧的）：

1. **sessionPersistence.ts:291-295** — 从 `localStorage` 反序列化时，显式读入 `streamTextOffset`：
   ```typescript
   if (typeof o.streamTextOffset === 'number' && Number.isFinite(o.streamTextOffset)) {
     msg.streamTextOffset = o.streamTextOffset;
   }
   ```

2. **MessageSnapshot** — `saveMessageSnapshot` 保存完整消息对象（包含 `streamTextOffset`），随 Undo/History 记录

3. **WebSocket 广播** — `sessionEventHydrate.ts:185,204,219` 读写该字段；`subagentTimeline.ts:170` 读写

4. **Undo/History** — `messageSnapshotsBridge.ts` 保存完整 `SessionMessage` 数组，含 `streamTextOffset`

### 5.3.2 解耦方案评估

**方案合理**：创建 `StreamingMessageRenderState` 存放到运行态 Map。但需注意以下问题：

**问题 A：`streamTextOffset` 不只用于流式渲染**

读 `sessionEventHydrate.ts:185,204`：

```typescript
// sessionEventHydrate.ts:185（事件投影路径）
a.streamTextOffset = text.length;
// sessionEventHydrate.ts:204
const offset = typeof a.streamTextOffset === 'number' ? a.streamTextOffset : 0;
```

事件投影（`sessionEventHydrate`）是服务端事件的**一次性投影构建**，并不依赖 UI store。它使用 `streamTextOffset` 做 blocks 重建的逻辑。如果将该字段移到 UI-only 的 `StreamingMessageRenderState`，事件投影路径需要改变策略：

**方案**：`sessionEventHydrate.ts` 和 `subagentTimeline.ts` 是**只读投影**，它们不需要与 UI 交互。对于这些纯数据转换路径，应在局部变量中维护偏移量，而不是在消息对象上读写。重构策略：

1. 在 `sessionEventHydrate.ts` 中将 `streamTextOffset` 提取为 `Map<string, number>`（局部变量）或在函数体内用闭包变量
2. 在 `subagentTimeline.ts` 同样改为局部变量
3. 最终成品消息不再携带该字段

**问题 B：`addMessageToolCall` 中 `streamTextOffset` 的写入逻辑**

```typescript
// sessionActions.ts:639
msg.streamTextOffset = (msg.text || '').length;
```

在 `StreamingMessageRenderState` 方案下，此处应改为：

```typescript
// 解耦后：写入 layoutStore 的 streamingRenderStates Map
const streamingStates = state.streamingRenderStates || (state.streamingRenderStates = new Map());
streamingStates.set(messageId, {
  messageId,
  streamTextOffset: (msg.text || '').length,
  currentActiveBlockIndex: msg.blocks?.length ?? 0,
  isStreaming: true,
});
```

**问题 C：`updateMessageText` 中的偏移量使用**

`sessionActions.ts:565` 以及 `sessionEventHydrate.ts:204` 的读取：
```typescript
let offset = typeof msg.streamTextOffset === 'number' ? msg.streamTextOffset : 0;
```

应改为：
```typescript
const renderState = state.streamingRenderStates?.get(messageId);
let offset = renderState?.streamTextOffset ?? 0;
```

### 5.3.3 改进后的实现路径

**建议修改的文件**（共 8 个）：

| 文件 | 操作 |
|---|---|
| `store/types.ts:257` | 删除 `streamTextOffset?: number` |
| `store/layoutStore.ts` | 在 LayoutStore 类型中新增 `streamingRenderStates?: Map<string, StreamingMessageRenderState>` |
| `store/sessionActions.ts` (行 565, 576, 639) | 读取从 `msg.streamTextOffset` 改为从 `state.streamingRenderStates.get(messageId)`；写入改为 `state.streamingRenderStates.set(messageId, { ... })` |
| `store/actions/chat.ts` (行 96, 98, 117, 119, 159) | 删除前无 import 引用，不处理 |
| `api/sessionEventHydrate.ts` (行 185, 204, 219) | 改为局部 `Map<string, number>` 或函数内变量 `offsetTracker` |
| `api/subagentTimeline.ts` (行 170) | 改为局部变量 |
| `api/sessionPersistence.ts` (行 291-295) | 删除 `streamTextOffset` 的序列化/反序列化 |
| `api/sessionEventHydrate.ts:185` 注释 | 更新「抹掉已有 tool_call 块」注释 |

---

## 5.4 修正流式 `blocks` 结构的增量更新算法

### 5.4.1 破坏性操作确认

**结论：方案指定的问题确实存在，且影响更深。**

`sessionActions.ts:578`：
```typescript
msg.blocks = msg.blocks.filter((b) => b.type === 'tool_call');
```

`actions/chat.ts:99`（僵尸代码但逻辑相同）：
```typescript
msg.blocks = msg.blocks.filter((b) => b.type === 'tool_call');
```

触发条件：`text.length < offset`（新文本比记录偏移量短）或"长度缩短且非追加关系"。

### 5.4.2 更精确的问题分析

该重置逻辑旨在处理"上游重置"场景（引擎重新生成整段文本）。但 `filter` 会丢弃所有 `type === 'text'` 的 blocks，即使文本只是"暂时缩短"（如流式中间态）。

**更深层次的 bug**：

当 `text.length < offset` 时，上述代码重置 `offset = 0; msg.streamTextOffset = 0;`，然后基于 `text.slice(offset)` 重建最后一块 text block。但如果**存在多个交错的 text/tool_call 块**（如：text → tool_call → text），`filter` 会丢弃第一个 text block，只保留 tool_call，然后重建最后一个 text block。结果是：

- **Before**: `[{text: "Hello"}, {tool_call, id: "tc1"}, {text: " world"}]`
- **After**: `[{tool_call, id: "tc1"}, {text: "Hello world"}]`

这失去了交错结构。

### 5.4.3 正确增量更新算法

方案 5.4.2 的修正方向正确，但需要补充关键细节：

**当前活跃 Block 的判定**：

```typescript
// 找到最后一个 tool_call block 之后的 text block
// 若无则追加一个新 text block
function ensureActiveTextBlock(blocks: MessageTimelineBlock[]): MessageTimelineBlock {
  // 找最后一个 tool_call 的索引
  let lastToolIdx = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].type === 'tool_call') {
      lastToolIdx = i;
      break;
    }
  }
  // 找最后一个 tool_call 之后的第一个 text block
  const afterToolBlocks = blocks.slice(lastToolIdx + 1);
  const textBlockIdx = afterToolBlocks.findIndex(b => b.type === 'text');
  if (textBlockIdx !== -1) {
    return afterToolBlocks[textBlockIdx]!;
  }
  // 不存在则追加
  const newBlock: MessageTimelineBlock = { type: 'text', content: '' };
  blocks.push(newBlock);
  return newBlock;
}
```

**完整替换后的 `updateMessageText` 核心逻辑**（`sessionActions.ts:549-587` 改为）：

```typescript
updateMessageText: (sessionId, messageId, text, precomputedHtml) =>
  set((state) => {
    const hit = getSessionMessage(state, sessionId, messageId);
    if (!hit) return;
    const msg = hit.message;
    const htmlChanged =
      precomputedHtml !== undefined &&
      msg.precomputedHtml !== precomputedHtml;
    if (htmlChanged) {
      msg.precomputedHtml = precomputedHtml;
    }
    if (msg.text === text && !htmlChanged) return;

    msg.text = text;
    if (!msg.blocks) msg.blocks = [];

    // 获取/创建当前活跃文本块（最后一个 tool_call 之后的 text block）
    let activeTextBlock: MessageTimelineBlock | null = null;
    let lastToolIdx = -1;
    for (let i = msg.blocks.length - 1; i >= 0; i--) {
      if (msg.blocks[i]!.type === 'tool_call') {
        lastToolIdx = i;
        break;
      }
    }
    for (let i = lastToolIdx + 1; i < msg.blocks.length; i++) {
      if (msg.blocks[i]!.type === 'text') {
        activeTextBlock = msg.blocks[i]!;
        break;
      }
    }
    if (!activeTextBlock) {
      activeTextBlock = { type: 'text', content: '' };
      msg.blocks.push(activeTextBlock);
    }

    // 仅更新活跃文本块内容
    activeTextBlock.content = text;
  }),
```

**注意**：上述简化版本舍弃了 `streamTextOffset` 的 segment 切分逻辑——因为该方案已建议将偏移量解耦到 `StreamingMessageRenderState`（5.3节）。若 5.3 尚未实施，则需保留偏移量逻辑但改用 `streamingRenderStates` 中的值。

### 5.4.4 时间线交错顺序保护

**`addMessage` 目前格式**（`sessionActions.ts:397-408`）：

```typescript
if (prepared.blocks!.length === 0) {
  if (prepared.text) {
    prepared.blocks!.push({ type: 'text', content: prepared.text });
  }
  if (prepared.toolCalls) {
    prepared.toolCalls.forEach((tc) => {
      prepared.blocks!.push({ type: 'tool_call', id: tc.id });
    });
  }
}
```

**问题**：当消息同时包含 text 和 toolCalls 时，blocks 总是 `[text, tool_call1, tool_call2, ...]`，无法表达 tool_call 出现在 text 中间的交错场景。

**修正**：

```typescript
if (prepared.blocks!.length === 0) {
  // 按时间线顺序交错：依赖服务端传回的 blocks 或按 turnId 排序
  // 若服务端未传，最安全做法是保持 text 在前（向后兼容）
  if (prepared.text) {
    prepared.blocks!.push({ type: 'text', content: prepared.text });
  }
  if (prepared.toolCalls) {
    // 如果工具调用有排序信息，按流式到达顺序排列
    // 当前无交错数据来源，保持现有顺序
    prepared.toolCalls.forEach((tc) => {
      if (!prepared.blocks!.some((b) => b.type === 'tool_call' && b.id === tc.id)) {
        prepared.blocks!.push({ type: 'tool_call', id: tc.id });
      }
    });
  }
}
```

**方案补充**：在 `streamTextOffset` 解耦后（5.3），`addMessageToolCall` 插入 tool_call 时已有交错能力（`sessionActions.ts:639-651`），该路径不受影响。

---

## 5.5 `layoutStore` 与 `sessionStore` 的门面模式强化

### 5.5.1 当前状况确认

**结论：方案描述准确，但需要补充类型断言的边界风险。**

`sessionStore.ts:29`：
```typescript
export const useSessionStore = useLayoutStore;
```

`sessionStore.ts:187-188`：
```typescript
export function getSessionStoreState(): SessionFacade {
  return useSessionStore.getState() as unknown as SessionFacade;
}
```

`storeFacades.test.ts:37-39` 已验证三 store 为同一实例。

### 5.5.2 类型断言安全性分析

当前 `as unknown as SessionFacade` 是**双重断言**：
1. `useLayoutStore.getState()` 返回 `LayoutStore` 类型
2. `as unknown`：逃逸类型系统
3. `as SessionFacade`：假设目标类型

**风险**：如果有一天 `LayoutStore` 不再包含 `SessionFacadeState & SessionActions` 的全部字段，编译器不会报错 — 因为双重断言跳过了兼容性检查。

**方案 5.5.2 的编译时断言有效**：

```typescript
type _AssertSessionFacadeIsSubset = SessionFacade extends Pick<
  ReturnType<typeof useLayoutStore>,
  keyof SessionFacade
>
  ? true
  : 'SessionFacade has methods not present in LayoutStore';
```

但存在局限：
1. `Pick<ReturnType<typeof useLayoutStore>, keyof SessionFacade>` 只检查 **`SessionFacade` 中声明的 key** 是否存在于 `LayoutStore`。如果 `LayoutStore` 存在但字段类型与 `SessionFacade` 不兼容，这不会报错（`extends` 只检查 key 存在性）。
2. 需要**额外类型兼容性检查**：`SessionFacade` 中的各方法签名是否与 `LayoutStore` 中的同名字段兼容。

**更安全的断言**：

```typescript
// 1. 字段存在性检查（原方案）
type _AssertSessionFacadeIsSubset = SessionFacade extends Pick<
  ReturnType<typeof useLayoutStore>,
  keyof SessionFacade
>
  ? true
  : 'SessionFacade has methods not present in LayoutStore';

// 2. 类型兼容性检查：确保赋值兼容
type _AssertSessionFacadeAssignable = ReturnType<typeof useLayoutStore.getState> extends SessionFacade
  ? true
  : 'LayoutStore state is not assignable to SessionFacade — types have diverged';

// 3. 如果两个断言其一为 false，`_typeCheck` 报错（never 不会实际执行）
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _typeCheck: _AssertSessionFacadeIsSubset = true;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _typeCheck2: _AssertSessionFacadeAssignable = true;
```

### 5.5.3 当前 `SessionFacade` 与 `LayoutStore` 对齐检查

**`SessionFacadeState`** (`sessionStore.ts:31-41`) 的字段在 `layoutStore.ts` 的 `LayoutStoreState` (`layoutStore.ts:913-950`) 中：

| `SessionFacadeState` 字段 | 在 `LayoutStoreState` 中存在 | 类型匹配 |
|---|---|---|
| `sessions` | 是 (`layoutStore.ts:922`) | `SessionState[]` |
| `sessionsById` | 是 (`layoutStore.ts:923`) | `Record<string, SessionState>` |
| `folderOrder` | 是 (`layoutStore.ts:924`) | `string[]` |
| `activeSessionId` | 是 (`layoutStore.ts:925`) | `string` |
| `activeAgentId` | 是 (`layoutStore.ts:926`) | `string \| null` |
| `panelAgentId` | 是 (`layoutStore.ts:927`) | `string \| null` |
| `composerDrafts` | 是 (`layoutStore.ts:928`) | `Record<string, string>` |
| `terminalBySession` | 是 (`layoutStore.ts:947`) | `Record<string, string[]>` |
| `terminalLines` | 是 (`layoutStore.ts:946`) | `string[]` |

**`SessionActions`** 的方法在 `layoutStore.ts` 的 create 回调中：
- `layoutStore.ts:820` 展开 `...createSessionActions(set, get)`

测试 `storeFacades.test.ts` 已验证运行时对齐。

### 5.5.4 有风险的推测性不匹配场景

以下场景可能导致门面断言失败但仍能通过编译（安全需要额外保护）：

1. **`LayoutStoreState` 中某字段重命名**：比如 `activeSessionId` 改名为 `sessionId`。断言 1 会捕获（key 不存在），但会等待下次编译。
2. **`SessionFacade` 新增方法但未补充到 `LayoutStore`**：断言 1 在新增时捕获（key 不存在）。
3. **`SessionFacade` 某字段类型收紧**：比如 `activeSessionId` 从 `string` 改为 `string & NonEmptyBrand`。断言 2 会捕获。
4. **`LayoutStore` 某字段类型与 `SessionFacade` 不兼容**：比如 `terminalLines` 从 `string[]` 改为 `readonly string[]`。断言 2 会捕获。

### 5.5.5 改进建议

在当前 `sessionStore.ts` 末尾增加：

```typescript
// ── 编译时门面断言 ──────────────────────────────────
// 字段存在性：SessionFacade 的 key 必须在 LayoutStore 中存在
type _AssertKeysExist = SessionFacade extends Pick<
  ReturnType<typeof useLayoutStore>,
  keyof SessionFacade
>
  ? true
  : 'SessionFacade key not found in LayoutStore';

// 赋值兼容性：LayoutStore 的实际 getState() 必须可赋给 SessionFacade
type _AssertAssignable = ReturnType<
  typeof useLayoutStore.getState
> extends SessionFacade
  ? true
  : 'LayoutStore state is not assignable to SessionFacade';

// 编译期常量（不被使用，仅触发类型检查）
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const __facadeKeysOk: _AssertKeysExist = true;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const __facadeAssignOk: _AssertAssignable = true;
```

---

## 总结：改进优先级与文件映射

| 优先级 | 项目 | 影响 | 最多修改文件 |
|---|---|---|---|
| P0 | 5.2 Object.assign 修正 | Bug；可能导致 UI 不更新 | 2（sessionActions.ts + providerStore.ts） |
| P0 | 5.4 blocks 增量更新算法 | Bug；流式中 blocks 被错误清空 | 1（sessionActions.ts） |
| P1 | 5.3 streamTextOffset 解耦 | 设计债；存储/网络污染 | 8 个文件 |
| P1 | 5.1 actions/ 目录清理 | 代码卫生 | 5 个文件（删除） |
| P2 | 5.5 门面断言强化 | 类型安全防线 | 1（sessionStore.ts） |
