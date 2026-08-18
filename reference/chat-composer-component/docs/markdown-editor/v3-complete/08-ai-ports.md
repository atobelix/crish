# 08 · AI 端口 — rewrite / summarize / continue / review

> **路径**：`docs/markdown-editor/v3-complete/08-ai-ports.md`  
> **读者**：编辑器实现 agent、宿主 AI 编排、展示页 mock  
> **关联**：`11-system-architecture` §5.5 · `05-slash-commands` · `ui/selection-toolbar` · `06-showcase-demo` · CROSSCUTTING D16  
> **修订**：2026-08-02 v3 首版

---

## 0. 一句话

编辑器 **只做 AI 端口与交互壳**：取上下文、展示入口、应用替换策略、处理 loading/错误/禁用；**不**内置模型、不持有 API Key、不实现 RAG/Agent 运行时。

---

## 1. 目标 / 非目标

### 1.1 目标

| ID | 目标 |
|----|------|
| A1 | 冻结四类端口：`rewrite` / `summarize` / `continue` / `review` |
| A2 | 定义选区/块/文档级 **上下文包**（Context Payload） |
| A3 | 定义写回 **替换策略**（replace selection / insert below / suggest-only） |
| A4 | 定义 UI 入口：选区浮动条 · 右键 · slash；**禁止**页顶 AI 大工具条（D16） |
| A5 | 无后端：mock 与禁用态完整、可验收 |
| A6 | 可取消、可重试、进 undo 历史 |

### 1.2 非目标

| 非目标 | 原因 |
|--------|------|
| 调用 OpenAI/Claude/自建网关 | 宿主职责 |
| 流式打字机完整 UX 规格的全量动效 | 可 P1 增量；本册定最小 streaming 钩子 |
| 多轮 AI 对话面板嵌在编辑器 | 易变第二聊天产品；用外置 Agent |
| 全篇自动改写无人确认 | 安全与可控 |
| 训练数据回传 | 隐私；编辑器不采集 |
| 页顶「AI 工具条」常驻按钮群 | 违反 D16 / 产品调性 |

### 1.3 与历史文档关系

`11-system-architecture` 预留：

```js
options.ai = {
  rewrite?(selectionText, intent): Promise<string>,
  continue?(prefix): Promise<string>,
}
```

本册 **扩展为完整端口面**，并补齐 summarize/review、上下文、UI、错误态；实现时以本册为准回写 10/11/12。

---

## 2. 架构边界

```
┌──────────────────────────────────────────┐
│ Host AI Runtime                          │
│  · 鉴权 / 模型路由 / 限流 / 审计          │
│  · 实现 AiPorts 四个（或子集）方法         │
└──────────────────┬───────────────────────┘
                   │ Promise / AsyncIterable
┌──────────────────▼───────────────────────┐
│ MarkdownEditor · AiController            │
│  · 收集 AiContext                        │
│  · 入口：slash / contextmenu / float bar │
│  · 应用 AiApplyStrategy                  │
│  · history + toast + busy 态             │
└──────────────────────────────────────────┘
```

**原则**：

1. 编辑器从不 `fetch` 模型 HTTP（除非宿主把 fetch 包进 port 闭包——那是宿主的事）。  
2. 缺省 `options.ai` 为 `undefined` → 全部入口 **禁用或隐藏**。  
3. 某方法缺失（如只有 rewrite）→ 仅隐藏/禁用对应入口。

---

## 3. 端口定义

### 3.1 TypeScript 契约

```ts
/** 挂载选项 */
interface MountOptions {
  // ...existing
  ai?: AiPorts | null;
  features?: {
    ai?: boolean; // 总开关；false 时等同无端口
  };
}

interface AiPorts {
  rewrite?: (req: AiRewriteRequest) => Promise<AiTextResult>;
  summarize?: (req: AiSummarizeRequest) => Promise<AiTextResult>;
  continue?: (req: AiContinueRequest) => Promise<AiTextResult>;
  review?: (req: AiReviewRequest) => Promise<AiReviewResult>;
  /**
   * 可选：统一入口；若提供，编辑器可优先走 route
   * 便于宿主单一网关
   */
  route?: (req: AiRouteRequest) => Promise<AiRouteResult>;
}

type AiIntent =
  | 'shorter'
  | 'longer'
  | 'formal'
  | 'casual'
  | 'fix_typos'
  | 'translate_zh'
  | 'translate_en'
  | 'custom';

interface AiRewriteRequest {
  text: string;
  intent?: AiIntent | string;
  customInstruction?: string;
  context: AiContext;
  signal?: AbortSignal;
}

interface AiSummarizeRequest {
  text: string;
  /** selection | block | document */
  scope: 'selection' | 'block' | 'document';
  context: AiContext;
  signal?: AbortSignal;
}

interface AiContinueRequest {
  /** 光标前文本（可截断） */
  prefix: string;
  /** 光标后文本（可选，帮助连贯） */
  suffix?: string;
  context: AiContext;
  signal?: AbortSignal;
}

interface AiReviewRequest {
  text: string;
  scope: 'selection' | 'block' | 'document';
  context: AiContext;
  signal?: AbortSignal;
}

interface AiTextResult {
  /** Markdown 或纯文本；编辑器按策略写入 */
  text: string;
  /** 提示 UI：模型是否当 MD 解析 */
  format?: 'markdown' | 'plain';
  meta?: { model?: string; usage?: unknown };
}

interface AiReviewResult {
  /** 不强制写回正文 */
  comments: AiReviewComment[];
  /** 可选：总体结论 */
  summary?: string;
  meta?: { model?: string };
}

interface AiReviewComment {
  /** 相对 req.text 的区间；无法定位可省略 */
  start?: number;
  end?: number;
  severity?: 'info' | 'warn' | 'error';
  message: string;
  /** 可选建议替换片段 */
  suggestion?: string;
}

interface AiRouteRequest {
  action: 'rewrite' | 'summarize' | 'continue' | 'review';
  payload: AiRewriteRequest | AiSummarizeRequest | AiContinueRequest | AiReviewRequest;
}

type AiRouteResult = AiTextResult | AiReviewResult;
```

### 3.2 能力语义

| 端口 | 用户意图 | 默认写回 | 典型失败 |
|------|----------|----------|----------|
| **rewrite** | 改写已选文本（语气/长短/纠错） | **替换选区** | 空选区禁用 |
| **summarize** | 总结选区/块/文 | **插入到选区后** 或替换（可配置） | 文本过短提示 |
| **continue** | 自光标续写 | **在光标处插入** | 只读模式禁用 |
| **review** | 审阅建议 | **不直接改文**；侧栏/popover 列表；用户点「应用建议」才改 | 无 comments 显示空态 |

### 3.3 为何是端口而不是功能开关堆砌

- 宿主可对同一 UI 换模型。  
- Desktop / Web / 展示页 mock 实现同一接口。  
- 测试可注入 fake ports，无需网络。

---

## 4. 选区与上下文（AiContext）

### 4.1 上下文包

```ts
interface AiContext {
  /** 文档标题（宿主传入 mount title） */
  title?: string;
  /** 当前 mode */
  mode?: 'conex' | 'pure-gfm';
  /** 主选区纯文本 */
  selectionText: string;
  /** 选区是否折叠（光标） */
  selectionCollapsed: boolean;
  /** 选区所在块 */
  blocks: AiBlockSlice[];
  /** 光标前缀/后缀（continue 用，可截断） */
  prefix: string;
  suffix: string;
  /** 周围块纯文本（前后各 N 块，默认 2） */
  neighborhood: { before: string[]; after: string[] };
  /** 全文字符数；是否截断全文摘要 */
  docStats: { blockCount: number; charCount: number };
  /** 可选：宿主业务标签 */
  hostMeta?: Record<string, unknown>;
}

interface AiBlockSlice {
  id: BlockId;
  type: string;
  text: string;
  level?: number; // heading
}
```

### 4.2 收集规则

| 字段 | 规则 |
|------|------|
| `selectionText` | 当前 EditorSelection 映射到纯文本；跨块用 `\n\n` 拼接 |
| `prefix` | 自文档开头或自当前块起向前取，**最多 4000 字符**（可配置 `ai.contextMaxChars`） |
| `suffix` | 向后最多 1000 字符 |
| `neighborhood` | 选区首块 index±2 的 serialize 纯文本 |
| 代码块 | 可整块纳入；**不要**把未聚焦代码的「高亮 HTML」塞进上下文 |
| 表格 | 序列化为 GFM pipe 文本 |

### 4.3 隐私与体积

- 编辑器 **默认不**把全文 10 万字无截断上传；`summarize` scope=document 时：  
  - 优先 `getMarkdown()` 截断至 `ai.documentMaxChars`（默认 12000）+ 省略标记；或  
  - 宿主 port 内自行读存储。  
- 不在上下文中附带本地绝对路径以外的密钥。  
- `hostMeta` 禁止放 token。

### 4.4 API 辅助

```ts
interface MarkdownEditorAPI {
  getAiContext?(opts?: { scope?: 'selection' | 'block' | 'document' }): AiContext;
  /** 供宿主外部按钮调用（仍无页顶条） */
  runAi?(action: 'rewrite' | 'summarize' | 'continue' | 'review', opts?: AiRunOpts): Promise<void>;
}

interface AiRunOpts {
  intent?: AiIntent | string;
  customInstruction?: string;
  scope?: 'selection' | 'block' | 'document';
  apply?: AiApplyStrategy;
}
```

---

## 5. 替换策略（Apply Strategy）

### 5.1 策略枚举

```ts
type AiApplyStrategy =
  | 'replace_selection'   // 用结果替换选区（rewrite 默认）
  | 'insert_below'        // 在选区/块后插入新块（summarize 默认）
  | 'insert_at_cursor'    // 折叠选区时在光标插入（continue 默认）
  | 'preview_then_apply'  // 先预览浮层，用户确认（可选增强）
  | 'suggest_only';        // 只展示，不写文档（review 默认）
```

### 5.2 默认映射

| action | selection 非空 | selection 空（仅光标） |
|--------|----------------|------------------------|
| rewrite | `replace_selection` | **禁用** 或改用「当前块全文 rewrite」（产品二选一；**推荐禁用并 toast「请先选中文本」**） |
| summarize | `insert_below` | scope=block：总结当前块并 `insert_below` |
| continue | 若误选非空：可先折叠到 focus 末尾再续写；**推荐**忽略选区当 prefix 末端 | `insert_at_cursor` |
| review | `suggest_only` | scope=block/document |

### 5.3 写回实现要点

```ts
async function applyTextResult(
  editor: EditorCore,
  action: string,
  result: AiTextResult,
  strategy: AiApplyStrategy,
  ctx: AiContext,
) {
  const md = result.format === 'plain'
    ? escapeAsParagraph(result.text)
    : result.text;

  switch (strategy) {
    case 'replace_selection':
      // 1) 删选区 2) 在 anchor 处 parseInline 或 parseBlocks 插入
      // 单行 → 更新 runs；多段 → 拆块
      editor.replaceSelectionWithMarkdown(md, { addToHistory: true, reason: 'ai.' + action });
      break;
    case 'insert_below': {
      const blocks = editor.parseMarkdown(md);
      editor.insertBlocksAfter(ctx.blocks[ctx.blocks.length - 1]?.id, blocks, {
        addToHistory: true,
        reason: 'ai.' + action,
      });
      break;
    }
    case 'insert_at_cursor':
      editor.insertMarkdownAtCursor(md, { addToHistory: true, reason: 'ai.' + action });
      break;
    case 'suggest_only':
      // no-op on doc
      break;
  }
}
```

### 5.4 Undo / Redo

- 一次 AI 成功写回 = **一条**历史记录（可内部多 step，合并为一 transaction meta.reason=`ai.*`）。  
- 生成中用户继续输入：不合并进 AI transaction。  
- 失败不写历史。

### 5.5 Streaming（可选 P1）

```ts
interface AiTextStreamResult {
  stream: AsyncIterable<string>; // 增量纯文本
  format?: 'markdown' | 'plain';
}
```

- continue/rewrite 可显示 ghost 预览或临时 block。  
- 完成后再 commit 一条历史；中途 Abort 删除临时预览。  
- v3-a **不强制** streaming；ports 返回 `Promise` 即可。

---

## 6. UI 入口（无页顶大工具条）

### 6.1 总原则

| 允许 | 禁止 |
|------|------|
| 选区浮动条上的「AI」分组 | 页顶 sticky「改写｜续写｜总结｜审阅」四键 |
| 块/选区 **右键** 菜单 AI 子菜单 | 右侧永久 AI 侧栏占编辑器内核（宿主可做） |
| slash 分区 `AI`（features.ai） | 每个空段自动弹 AI |
| 键盘快捷键（可选） | 打断 IME 的激进热键 |

### 6.2 选区浮动条（Selection Toolbar）

现有 `ui/selection-toolbar.js` 扩展：

```
[ B ] [ I ] [ ` ] [ 链接 ]  |  [ AI ▾ ]
```

**AI ▾ 菜单**：

| 项 | 条件 | 调用 |
|----|------|------|
| 改写 | `ai.rewrite` 存在且选区非空 | rewrite |
| 改写 ▸ 更短 / 更正式 / 纠错… | 同上 | rewrite + intent |
| 总结选区 | `ai.summarize` | summarize scope=selection |
| 审阅选区 | `ai.review` | review |

- 无任一 port：不渲染 AI 按钮。  
- 部分 port：只显示可用项。  
- busy 时按钮 spinner，禁用重复点击。

### 6.3 右键菜单（Context Menu）

在编辑表面 `contextmenu`（与表格右键协调：表格单元格优先表菜单；无表逻辑时用通用菜单）。

**通用菜单片段**：

```
撤销 / 重做
———
剪切 / 复制 / 粘贴
———
AI
  改写…
  总结
  续写
  审阅
———
（块）复制链接锚点…
```

- 续写：选区空时可用。  
- 改写：选区空时灰显 + 说明。

### 6.4 Slash 命令

在 `05-slash-commands` 增 section（order 靠后，如 45）：

| id | title | aliases | 行为 |
|----|-------|---------|------|
| `ai.continue` | AI 续写 | 续写, continue, 接着写 | 删触发符 → continue |
| `ai.summarize-block` | AI 总结本块 | 总结, summarize | 当前块 summarize + insert_below |
| `ai.review-doc` | AI 审阅全文 | 审阅, review | review scope=document |
| `ai.rewrite` | AI 改写（需选区） | 改写, rewrite | 无选区 toast |

`when: (ctx) => features.ai !== false && hasAnyAiPort(ctx)`  

**注意**：slash v1 曾写「不做 AI section」；**v3 显式撤销该限制**，以本册为准。

### 6.5 可选快捷键

| 快捷键 | 动作 | 备注 |
|--------|------|------|
| `Ctrl+Shift+Space` | AI 续写 | 可配置；与系统冲突则改 |
| `Ctrl+Shift+J` | 改写选区 | 可选 |

写入 `ux/keyboard-map.md` 时标注可选。

### 6.6 Review 结果 UI（编辑器最小集）

- Popover 锚定选区或右上角面板（**非**页顶条）。  
- 列表：severity + message +「应用建议」。  
- 应用建议：对应该 comment 的 replace；无区间则插入 callout 批注块（可选）。  
- 关闭不写文档。

更重的「AI 审阅侧栏」归 **宿主**。

### 6.7 Loading / 错误 / 取消

| 态 | UI |
|----|-----|
| loading | 入口 spinner；`aria-busy`；toast 可选「生成中…」 |
| 可取消 | Esc 或按钮 → `AbortController.abort()` |
| 成功 | 弱 toast「已改写」类；focus 保持合理位置 |
| 失败 | toast `error.message` 或「AI 请求失败」；文档不变 |
| 超时 | 宿主 port 应用 Promise.race；编辑器可设默认 60s abort |

---

## 7. 无后端：Mock 与禁用态

### 7.1 三种挂载形态

| 形态 | `options.ai` | `features.ai` | UI |
|------|--------------|---------------|-----|
| **生产宿主已接** | 真实实现 | true | 全开可用项 |
| **Demo Mock** | `createDemoAiPort()` | true | 全开，假数据 |
| **禁用** | null/undefined 或全方法缺 | false 或默认 | 隐藏入口 |

### 7.2 Mock 实现（展示页）

```js
function createDemoAiPort(opts) {
  opts = opts || {};
  var enabled = opts.mock !== false;

  function delay(ms, signal) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(resolve, ms);
      if (signal) {
        signal.addEventListener('abort', function () {
          clearTimeout(t);
          reject(new DOMException('Aborted', 'AbortError'));
        });
      }
    });
  }

  if (!enabled) return null;

  return {
    rewrite: async function (req) {
      await delay(350, req.signal);
      var intent = req.intent || 'custom';
      return {
        text: '（Mock 改写·' + intent + '）' + req.text.trim(),
        format: 'plain',
      };
    },
    summarize: async function (req) {
      await delay(400, req.signal);
      return {
        text:
          '### 摘要（Mock）\n\n' +
          '- 原文约 ' + req.text.length + ' 字\n' +
          '- 范围：' + req.scope + '\n' +
          '- 要点：' + req.text.trim().slice(0, 40) + '…\n',
        format: 'markdown',
      };
    },
    continue: async function (req) {
      await delay(400, req.signal);
      return {
        text: '\n\n（Mock 续写）基于上文，下一步可以补充验收标准与风险说明。',
        format: 'markdown',
      };
    },
    review: async function (req) {
      await delay(300, req.signal);
      return {
        summary: 'Mock 审阅完成',
        comments: [
          {
            severity: 'info',
            message: '可考虑增加前置条件说明。',
            suggestion: undefined,
          },
          {
            severity: 'warn',
            message: '存在较长句子，可读性可优化。',
            start: 0,
            end: Math.min(12, req.text.length),
            suggestion: req.text.slice(0, 12),
          },
        ],
      };
    },
  };
}
```

展示页 `··· → AI 端口：Mock 开/关`：

- 关：`ai: null` 重挂载 → 入口消失。  
- 开：注入 mock。

### 7.3 禁用态细则

| 场景 | 表现 |
|------|------|
| 无 ai 对象 | 浮动条无 AI；slash 无 AI section；右键无 AI 子菜单 |
| 只读 `viewOnly` | 所有写回类禁用；review 可只读展示（若宿主仍传 ai） |
| 生成中 | 相关入口 disabled |
| AbortError | 静默或 toast「已取消」，不算失败风暴 |
| 选区不合法 | 菜单项灰显，hover title 说明 |

### 7.4 无网络「真」宿主

宿主可实现：

```js
ai: {
  rewrite: async () => { throw new Error('当前环境未登录 AI 服务'); },
}
```

编辑器仍显示入口，点击后 toast 错误——与「完全隐藏」由宿主选：`features.ai: false` 隐藏。

---

## 8. 状态机

```
idle
  │ open menu / slash / runAi
  ▼
confirm?（可选 preview）
  │
  ▼
collect context ──► empty selection for rewrite? ──► toast → idle
  │
  ▼
calling  (AbortController alive)
  │ success                │ fail/abort
  ▼                        ▼
apply strategy            toast → idle
  │
  ▼
idle (+ history if applied)
```

并发：同一编辑器实例 **默认单飞**（第二次点击排队或直接拒绝「正在生成」）。

---

## 9. 与块类型的交叉规则

| 块 / 情境 | 规则 |
|-----------|------|
| 代码块编辑态 | rewrite 可作用于选中代码；continue 插入代码文本而非拆段（保持 code_block） |
| 表格单元格 | 选区仅格内；rewrite 不跨格合并 |
| 多选块 | v1 可仅支持「主选区」；多块 AI 后置 |
| atom（wiki/file） | 选区若仅 atom，rewrite 对其 label 文本；失败则禁用 |
| callout | 可总结；写回默认 insert_below 在 callout 外 |

---

## 10. 安全与滥用

| 项 | 要求 |
|----|------|
| 结果写回 | 与粘贴相同：走 parse + 消毒，禁止 raw script |
| 提示注入 | 宿主应在 port 内隔离 system prompt；编辑器只传用户文档上下文 |
| 频率 | 编辑器可不做；宿主限流 |
| 审计 | `onTelemetry?.('ai.run', { action, ok, ms })` |
| 密钥 | 永不进编辑器配置对象可序列化快照 |

---

## 11. a11y

- AI 菜单项有明确 accessible name（「AI 改写」「AI 续写」）。  
- loading 时 `aria-busy="true"` 于工具条或 live region。  
- 结果 toast 使用 `role="status"`。  
- 键盘：浮动条 AI 菜单方向键操作；Esc 关菜单 / 取消请求（分层：先菜单后 abort）。

---

## 12. 测试点

| ID | 用例 |
|----|------|
| AI-01 | 无 `options.ai` 时无入口 |
| AI-02 | mock rewrite 替换选区；undo 恢复 |
| AI-03 | summarize insert_below 产生新块 |
| AI-04 | continue 在光标插入 |
| AI-05 | review 不改文档，仅弹列表 |
| AI-06 | abort 中途不写文档 |
| AI-07 | rewrite 空选区 toast 且不调用 port |
| AI-08 | port throw → toast，文档不变 |
| AI-09 | viewOnly 不出现写回入口 |
| AI-10 | slash `ai.continue` 删除 `/` 触发符再续写 |

---

## 13. 展示页验收文案（对齐 06）

活文档 AI 章必须可手工验证：

1. Mock 开 → 选中句 → 浮动条改写 → 文本出现 `（Mock 改写` 前缀。  
2. `/` → AI 续写 → 下方出现 Mock 续写段落。  
3. Mock 关 → 无 AI 入口。  
4. 全程 **无** 页顶 AI 工具条。

---

## 14. 分期

| 阶段 | 交付 |
|------|------|
| **v3-a** | AiPorts 类型 + rewrite/continue + 浮动条入口 + mock + 禁用态 |
| **v3-b** | summarize/review + 右键 + slash section + Abort |
| **v3-c** | preview_then_apply、streaming ghost、runAi 外部 API |
| **P2** | 多块选区、表格感知改写、宿主审阅侧栏协议细化 |

---

## 15. 实现文件锚点（规划）

```
js/markdown-editor/
  ai/
    types.js          # 或 TS 包内 types
    context.js        # collect AiContext
    apply.js          # strategies
    controller.js     # run + abort + single-flight
  ui/
    selection-toolbar.js  # + AI 菜单
    ai-review-popover.js  # review UI
    context-menu.js       # 若拆分
```

宿主示例：

```js
MarkdownEditor.mount(el, {
  markdown,
  ai: createHostAiPorts({ gateway, docId }),
  features: { ai: true },
  onTelemetry(event, payload) { /* … */ },
});
```

---

## 16. 完成定义（DoD）

- [ ] 四端口语义与默认策略冻结  
- [ ] AiContext 字段与截断策略明确  
- [ ] UI 仅浮动条 / 右键 / slash，无页顶大工具条  
- [ ] Mock 与完全禁用可区分验收  
- [ ] 写回进 undo；失败不污染文档  
- [ ] 安全：结果走 parse 消毒  
- [ ] 与 06 展示页章节、11 旧预留接口可迁移对照  

---

## 17. 修订

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0 | 2026-08-02 | 完整 AI 端口面：上下文、策略、入口、mock/禁用、测试与分期 |
