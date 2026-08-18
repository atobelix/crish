# 12 — Conex 融合实时 Markdown 编辑器 · 系统性重构规格书（全文）

> **版本**：1.0.0  
> **日期**：2026-08-03  
> **状态**：**执行真源**（多 Agent 必须按本文件实现，禁止缩水、禁止口头替代）  
> **配套摘要**：[11-SYSTEMIC-REFACTOR-PLAN.md](./11-SYSTEMIC-REFACTOR-PLAN.md)  
> **硬禁令**：[BANNED-VISUAL-UX.md](../BANNED-VISUAL-UX.md)  
> **决策**：[08-decision-log.md](./08-decision-log.md) · **ux-D10 / ux-D11 closed**  
> **现状代码根**：`reference/chat-composer-component/js/markdown-editor/`  
> **目标包**：`packages/conex-mdx`（过渡旁路允许 `js/markdown-editor-v2/`）  
> **宿主 API 兼容**：`MarkdownEditor.mount` 形状见 §13 与 `12-integration-contract.md`

---

## 0. 文档导航与使用方式

### 0.1 谁必须读什么

| 角色 | 必读章节 | 可后读 |
|------|----------|--------|
| 调度 / 产品 | §0–§3, §15, §18, §24, §33 | §9 伪代码细节 |
| 内核 Agent（schema / runtime） | §4–§7, §10, §13, §16 R1 工单 | §8 个别 NodeView 像素 |
| NodeView Agent | §8 对应节点, §11, §12, §16 R2 | §5 选型辩论 |
| 序列化 Agent | §6, §9, §14, §37 | §8 动效 |
| CSS / 动效 Agent | §3, §12, §16-CSS | §7 选区算法 |
| 测试 Agent | §14, §24, §33, 各工单 DoD | — |
| 遗留维护 Agent | §17 LEGACY, BANNED 全文 | 新内核可后读 |

### 0.2 冲突裁决顺序（高 → 低）

1. 本文件 **§3 硬禁令** 与 **ux-D10 / ux-D11 closed**  
2. 本文件 **Schema / PublicApi 签名**（§6 / §13）  
3. `BANNED-VISUAL-UX.md`  
4. `11-SYSTEMIC-REFACTOR-PLAN.md`（方向摘要）  
5. `v3-complete/*` 中未标明 superseded 的段落  
6. 旧 `CROSSCUTTING.md` **D2**（终局已否决，仅历史）  
7. 任何 Agent「我觉得更好」但未改本规格的行为  

### 0.3 禁止偷懒条款（多 Agent 强制 · 违反即打回）

- **禁止**只改 CSS / 文案 / SAMPLE 勾选框宣称「重构完成」。  
- **禁止**在旧 `editor.js` 再增加超过 **80 行**新业务（仅允许 `// LEGACY-ISLAND: remove in R4` 崩溃热修）。  
- **禁止**把「按块 `enterEdit` + `innerHTML` 换壳」实现为 **v2 默认主路径**。  
- **禁止**用块级 `selectedIds` 冒充**字符级跨行选区**并标 Done。  
- **禁止**省略 roundtrip / 跨选 / checkbox / 公式往返测试。  
- **禁止** mock AI `complete`。  
- **禁止**引入 Notion Database / 看板 / CRM 默认块类型。  
- 每个 Agent 交付必须附：**改动文件列表 + DoD 勾选表 + 可复现命令 + 波次标签（R0–R4）**。  
- 未列入 §15 本波范围却偷偷做的功能：要么先合规格补丁，要么撤销。  
- Reviewer 发现 §22 反模式 → **直接打回**，不讨论「差不多能用」。

### 0.4 术语表（全文统一，禁止自创同义名）

| 术语 | 定义 |
|------|------|
| 融合编辑 / Fused editing | 单一可编辑文档表面；渲染与 Markdown 语义一体，非「预览模式/源码模式」硬切换 |
| 文档流 / Doc stream | 连续 ProseMirror `Node` 树 + 单一 `EditorView`，而非块岛列表 |
| 岛模型 / Island model | 现状：每 block 独立 contenteditable + `enterEdit` 换 HTML |
| NodeView | ProseMirror 自定义节点 DOM；用于 code / math / callout / image 等 |
| Mark | 行内样式：bold / italic / code / strike / link / highlight / underline |
| InputRule | 键入模式触发变换，如 `**x**` → bold mark |
| Plugin | PM 插件：keymap、history、slash、drop、IME |
| LEGACY | 旧 IIFE 路径；R4 删除或迁入 `legacy/` |
| DoD | Definition of Done，验收标准；未勾完 = 未完成 |
| R0–R4 | 重构波次编号，见 §15 |
| PublicApi | `mount` 返回对象，宿主集成契约 |
| Transaction | PM 文档变更唯一合法通道 |
| attrs.latex | 公式节点的源码真相字段；禁止用渲染 DOM 文本反推 |

### 0.5 本规格与 11 号摘要的关系

- **11** = 决策与方向（为什么否决岛模型）。  
- **12** = 可执行工程规格（做什么文件、什么类型、什么测例）。  
- **只读 11 就开始写代码 = 未充分阅读**；实现争议以 12 为准。

### 0.6 阅读路线（建议 90 分钟）

1. §1 问题（15 min）  
2. §2 产品原则 + §3 禁令（15 min）  
3. §4 架构 + §6 Schema 表（25 min）  
4. 自己负责的 §8 节点或 §16 工单（20 min）  
5. §14 测试 + §33 总 DoD（15 min）  

---

## 1. 问题陈述与根因

### 1.1 用户否决清单（验收反例 · 永久回归集）

| ID | 用户现象 | 架构根因 | 重构后必须 |
|----|----------|----------|------------|
| U-01 | 全行激活效果像垃圾 | 岛切换心智 + `is-active` 类残留/联想 | **仅 caret**；无底色/描边/阴影 |
| U-02 | 渲染不能操作；待办一点跳源码 | idle 只读 DOM → 整块 `enterEdit` | checkbox → `setAttrs`；不换模式 |
| U-03 | 代码块不好编 / 行为怪 | code 与文本分叉状态机 | `code_block` 在文档流内可编 |
| U-04 | `**demo**` 匹配后不变粗 | 岛内 live-marks 漏刷/闪 | InputRule 或等价 transaction |
| U-05 | 有的能编有的只能看 | read HTML vs edit HTML 两套皮 | 统一 doc 交互 |
| U-06 | 无跨行选取；键盘像锁在一行 | 多 contenteditable 根 | 单一 PM Selection |
| U-07 | callout 顶部类型不能改 | kind 灰标 `contenteditable=false` | kind 选择器写 attrs |
| U-08 | 公式一点乱码（E=mc / 2 分行） | 渲染 DOM 当源码往返 | **attrs.latex** 为真相 |
| U-09 | 切行乱跳、卡键 | `exitEdit`+`enterEdit` 销毁重建 | 无换壳主路径 |

### 1.2 现状代码锚点（Agent 必须打开看过再改）

| 路径 | 角色 | 重构命运 |
|------|------|----------|
| `editor.js` | 上帝调度 `activeId` / enterEdit / exitEdit | **禁止**作为 v2 主实现；R4 legacy |
| `ui/line-source.js` | 软编/全源码 HTML 字符串工厂 | 主路径删除 |
| `inline/live-marks.js` | 岛内 as-you-type 整段 HTML | 由 inputrules + decorations 替代 |
| `inline/delim-edit.js` | 成对 Backspace | 迁 keymap 命令 |
| `inline/marks-model.js` | runs 解析 | 迁 markdown marks 或 PM mark |
| `util.js` | esc / inlineHtml / htmlToInlineMd | 部分逻辑进 serialize/parse |
| `model.js` | Block[] + history + mergeKey | PM history plugin |
| `parse.js` / `serialize.js` | MD ↔ Block[] | MarkdownBridge |
| `schema.js` | createBlock | PM Schema + 可选 DTO |
| `blocks/code-*.js` | 代码读/源 | `nodeViews/codeBlock.ts` |
| `blocks/math.js` | 公式 | `nodeViews/math*.ts` |
| `blocks/text-read.js` | 读 HTML | toDOM / 默认节点 |
| `blocks/image.js` | 图+灯箱 | `nodeViews/image.ts` |
| `selection/*` | 块 multi | PM Selection + 可选 block multi plugin |
| `edit/height-lock.js` | 换壳防跳 | **终局删除** |
| `edit/demotion.js` / `promote.js` | BS 阶梯 / 行首提升 | keymap + inputrules |
| `edit/clipboard/*` | 粘贴复制 | clipboard plugin |
| `table/*` | 表 | prosemirror-tables 或 NodeView |
| `ui/slash-menu.js` | slash | slash plugin |
| `ai/*` | 端口 | 策略保留，禁 mock |
| `index.js` | mount API | **形状保持** adapters |
| `demo/showcase-sample.js` | 验收样本 | 继续用 |

### 1.3 现状控制流（必须消灭的主路径）

```text
click .mdx-block[data-block-id]
  → exitEdit(prevActiveId)
       commitActiveFromDom()
       destroy IME / table chrome / code edit state
       content.innerHTML = readContentHtml(block)   // 换回读皮
  → enterEdit(id)
       content.innerHTML = softSurface | codeSource | mathSource | ...
       querySelector([data-mdx-edit]).focus()
keydown ArrowUp at start of island
  → exitEdit + enterEdit(prev block)   // U-09 根源
```

**v2 对照**：`EditorView` 内一次 `dispatch(tr)` 改 doc 或 selection；**没有** enterEdit。

### 1.4 为什么「再堆 island 补丁」经济失败

1. 字符级跨块需要统一 selection 模型 → 成本 ≈ 引入成熟内核。  
2. 每加块类型 = enterEdit/commit 双分支 + 回归矩阵膨胀。  
3. `editor.js` 已是多 Agent 冲突热点。  
4. 产品目标是**融合交互**，不是「更聪明的换壳」。

### 1.5 给每个 PR 的强制声明句

> 本 PR 属于波次 Rx；**不以 island enterEdit 为终局能力**；对照规格 12 §…；DoD：…

---

## 2. 产品规格冻结（FUSED-SPEC）

### 2.1 产品定位（一句）

**Markdown 为序列化真相；文档流为编辑真相；AI 为宿主端口；不做 Database 污染。**

### 2.2 融合原则 P-FUSED-01 … 10（可测）

| ID | 原则 | 可测表述 |
|----|------|----------|
| P-FUSED-01 | 始终可落点 | 打开后任意正文单击出现 caret，无需先「进入编辑模式」 |
| P-FUSED-02 | 所见即可改 | 已粗体/列表/标题可直接改文字，不先变 monospaced 源墙 |
| P-FUSED-03 | 语法自由 | 可键入 `** * \` ~~ # - ``` ` 等并得到正确结构 |
| P-FUSED-04 | 控件真交互 | checkbox / callout 类型 / 代码语言 / 公式源切换可鼠标完成 |
| P-FUSED-05 | 跨节点选区 | 拖选跨段；Shift+方向键可扩展跨块 |
| P-FUSED-06 | 无模式闪白 | ↑↓ 跨段不销毁块 DOM 树换皮 |
| P-FUSED-07 | IME 神圣 | 组字期间不折叠 marks、不改节点类型、不强制 blur 提交 |
| P-FUSED-08 | 代码单表面 | 禁止「上高亮下 textarea」双壳同时可见 |
| P-FUSED-09 | MD roundtrip | getMarkdown→setMarkdown 结构稳定 |
| P-FUSED-10 | 可迁移包 | 宿主只依赖 mount API + CSS |

### 2.3 非目标（明确不做）

- 实时多人协作 OT/CRDT（后置）  
- 页顶永久 B/I/H1 工具条  
- 默认左右分栏「源码 | 预览」  
- 完整 Office 粘贴保真  
- 视频/音频块作为 R1（R3 可选）  
- 完整 Prism 全语言（轻量高亮可迭代）  
- Notion Database / 关联属性 / 看板  

### 2.4 场景矩阵 S01–S15（手工 + 自动化挂钩）

| ID | 操作 | 期望 | 失败态（禁止交付） |
|----|------|------|-------------------|
| S01 | 键入 `**demo**` 闭合 | demo 立即粗体；可邻域见灰 `**` | 仍字面 `**demo**` |
| S02 | 粗体词首 Backspace | 拆 mark 成纯文本 | 删整词/卡死/无响应 |
| S03 | 单击 task checkbox | checked 翻转；MD `[x]`/`[ ]` | 进源码皮/点不了 |
| S04 | 拖选跨两个段落 | 连续高亮；Ctrl+C 两段 MD | 边界断开/空剪贴板 |
| S05 | 段末按 ↓ | 进入下一段；无闪白乱跳 | exit/enter 闪/丢光标 |
| S06 | 点代码块内部 | 可键入；可选中复制 | 只读/双壳 |
| S07 | 改代码语言标签 | lang+高亮+fence 同步 | 菜单空操作 |
| S08 | 点公式块再失焦 | 回 KaTeX；latex 不变 | E=mc 与 2 分行乱码 |
| S09 | callout tip→warning | 色与序列化 kind 变 | 类型锁死 |
| S10 | 空段 `/` 选标题 2 | 成 h2 | 无面板/插错 |
| S11 | 空 bullet Enter | 退出列表成段落 | 无限空 bullet |
| S12 | 粘贴 GFM 表 | table 可编 | 纯文本竖线 |
| S13 | prefers-reduced-motion | 无入场长动画 | 仍长动画 |
| S14 | viewOnly:true | 不可编；可选中复制 | 仍能改 doc |
| S15 | 无 ai.complete | 无 AI 入口 | mock 输出 |

### 2.5 信息架构（showcase 验收章节保持稳定）

沿用 `demo/showcase-sample.js` 章节编号 0–15；v2 必须仍能加载同一 MD 字符串（允许渐进：R1 对未支持节点降级为 paragraph 并 **console.warn 计数**，但不得静默丢 task checked）。

---

## 3. 硬禁令（可机器化门禁）

### 3.1 BAN 总表

| BAN | 规则 | 建议检测 |
|-----|------|----------|
| BAN-01 | 禁止全行激活 chrome（底色/描边/阴影/呼吸） | rg CSS + 截图 |
| BAN-02 | 禁止默认读/写两套皮跳变 | v2 无 enterEdit 主路径 |
| BAN-03 | 禁止半吊子可编 | task/code/math/callout 测例 |
| BAN-04 | 禁止 island 终局 | v2 默认不 import 旧 createEditor |
| BAN-05 | 禁止 mock AI | rg complete mock |
| BAN-06 | 禁止页顶永久格式条 | 组件审查 |
| BAN-07 | 禁止 box-shadow transition 装激活 | CSS lint |
| BAN-08 | 禁止 Database 类节点 | schema 审查 |

### 3.2 建议 CI 脚本（R1 起）

```bash
#!/usr/bin/env bash
# scripts/check-mdx-bans.sh
set -euo pipefail
ROOT="${1:-packages/conex-mdx}"
if command -v rg >/dev/null 2>&1; then
  if rg -n "enterEdit\s*\(|renderSoftEditSurface|renderFullSourceSurface" "$ROOT/src" 2>/dev/null; then
    echo "BAN-04 fail: island APIs in v2 src"; exit 1
  fi
  if rg -n "mockComplete|fakeAi|dummyComplete" "$ROOT" 2>/dev/null; then
    echo "BAN-05 fail"; exit 1
  fi
fi
echo "BAN checks passed"
```

### 3.3 视觉回归基线（每次发版）

1. caret 在段中 — **无**整行底色。  
2. 多选 3 块 — 仅极淡 decoration，非厚描边。  
3. 代码焦点 — 单卡片。  
4. 公式读态 — KaTeX 或清晰 fallback，**非**碎行字母。  

---

## 4. 目标架构总览

### 4.1 逻辑分层图

```text
Host (Tauri / Workbench / markdown-editor.html)
└── MarkdownEditor.mount(host, Options)          // 稳定对外 API（§13）
      ├── EditorRuntime                            // PM EditorView + EditorState
      │     ├── schema (nodes + marks)             // §6
      │     ├── plugins[]                          // §11
      │     ├── nodeViews                          // §8
      │     └── commands                           // §7 / §20
      ├── MarkdownBridge                           // §9 parse/serialize
      │     ├── parseMarkdown(md) → PM Node
      │     ├── serializeMarkdown(doc) → string
      │     └── legacyBlocks? Block[] ↔ doc        // 可选兼容
      ├── HostPorts                                // ai / upload / openPath
      └── Theme CSS                                // §12 + BAN-01
```

### 4.2 旧模块 → 新模块映射（禁止「忘掉」能力）

| 旧路径 | v2 归属 | 注意 |
|--------|---------|------|
| editor.js | 拆散；adapters/mountApi 薄封装 | 禁止平移上帝文件 |
| model.js | PM state + history plugin | mergeKey → appendTransaction 策略可选 |
| parse.js | markdown/parse.ts | 表 align、callout 必测 |
| serialize.js | markdown/serialize.ts | pure-gfm 模式可选 |
| schema.js | schema/* | VERSION 文档化为 3 |
| line-source.js | **删除主路径** | 由 schema+rules 替代 |
| live-marks / delim-edit | inputRules + keymap + decorations | 禁止整段 innerHTML |
| code-*.js | nodeViews/codeBlock.ts | 行号/fold/lang |
| math.js | nodeViews/math*.ts | attrs.latex |
| selection/* | PM Selection + 可选 block multi plugin | |
| height-lock.js | 删除 | |
| demotion/promote | keymap + inputrules | |
| clipboard/* | plugins/dropPaste.ts | |
| slash-menu | plugins/slash.ts | H1–H6 全 |
| ai/* | ports 策略原样 | 禁 mock |
| showcase-sample | 保留 | 验收剧本 |

### 4.3 技术选型（默认冻结）

| 项 | 选择 | 允许替代 | 禁止 |
|----|------|----------|------|
| 内核 | prosemirror-model/state/view/transform/commands/keymap/history/inputrules/schema-list/schema-basic | TipTap 薄封装（须同 schema） | 整页 textarea；继续 island |
| 语言 | TypeScript strict | R1 允许 JS+JSDoc 但不得超过 R1 结束 | 无类型上帝 JS 新文件 |
| 构建 | Vite library | esbuild | 无打包复制 40 个 script 标签作为终局 |
| 测试 | vitest + jsdom/happy-dom | | 无测宣称完成 |
| 高亮 | 现有轻量 tokenizer；可 lazy shiki | | 默认拖入巨型高亮包打爆首包 |
| 公式 | KaTeX peer optional | | 把渲染文本当地源 |

### 4.4 目录结构（强制 · 禁止再堆单文件）

```text
packages/conex-mdx/
  package.json                 # name: @conex/mdx
  README.md
  tsconfig.json
  vite.config.ts
  src/
    index.ts                   # 导出 mount/parse/serialize/VERSION
    types.ts                   # Options, PublicApi, HostPorts
    editor/
      createEditor.ts
      commands.ts
      keymap.ts
    schema/
      nodes.ts
      marks.ts
      index.ts
    markdown/
      parse.ts
      serialize.ts
      extensions/
        callout.ts
        wiki.ts
        fileChip.ts
        math.ts
        table.ts
    plugins/
      history.ts
      inputRules.ts
      dropPaste.ts
      slash.ts
      imeGuard.ts
      blockHandle.ts           # R3
      blockMulti.ts            # 可选块多选 decoration
      delimDecoration.ts       # ux-D2
    nodeViews/
      codeBlock.ts
      mathBlock.ts
      mathInline.ts
      callout.ts
      image.ts
      taskItem.ts
      table.ts                 # 或使用 prosemirror-tables 默认视图+chrome
    adapters/
      legacyBlocks.ts
      mountApi.ts
    style/
      editor.css
  tests/
    parse-serialize.roundtrip.test.ts
    input-rules.test.ts
    selection.cross-block.test.ts
    task-checkbox.test.ts
    math-latex.test.ts
    bans.test.ts
  scripts/
    check-mdx-bans.sh
```

过渡：`reference/chat-composer-component/js/markdown-editor-v2/` 可镜像，**不得**写入旧 `editor.js`。

### 4.5 依赖版本策略

- 锁定 prosemirror-* **同一大版本**，在 package.json 写死范围并在 README 记录。  
- 不引入 React 作为内核必需（宿主 React 可包一层，但内核 DOM 直挂）。  

---

## 5. 运行时状态机与生命周期

### 5.1 相位

```ts
type EditorPhase = 'mounting' | 'ready' | 'destroyed';
```

### 5.2 mount 时序（禁止乱序）

1. 校验 `hostEl` 为 `HTMLElement`。  
2. 合并 Options 默认值（§26）。  
3. `parseMarkdown(initialMd)` → `doc`；失败则空 paragraph 并 log `MDX_PARSE_FAIL`。  
4. 组装 `plugins[]`（viewOnly 去掉编辑类插件）。  
5. `EditorState.create({ doc, schema, plugins })`。  
6. `new EditorView(hostEl, { state, nodeViews, dispatchTransaction, editable: () => !viewOnly })`。  
7. 绑定 onChange 防抖（`autosaveMs` 默认 280）。  
8. `phase = 'ready'`；返回 PublicApi。  

### 5.3 dispatchTransaction 规范

```ts
function dispatch(tr: Transaction) {
  const next = view.state.apply(tr);
  view.updateState(next);
  if (tr.docChanged || tr.selectionSet) scheduleEmit();
}
```

硬规则：

- **所有**文档变更必须走 `Transaction`。  
- **禁止** `view.dom.innerHTML = ...` 作为编辑手段。  
- NodeView 会话态（fold 展开）默认 **不** 进 MD。  
- `compositionstart`…`compositionend` 期间：禁止大范围 inputrules 变形。  

### 5.4 destroy

1. `flush()` 触发最后一次 onChange。  
2. `view.destroy()`。  
3. 移除 slash/lightbox/lang menu 等 portal。  
4. `phase = 'destroyed'`。  
5. 再次调用 API：文档化 no-op 或抛 `MDX_VIEW_DESTROYED`（选一种写死）。  

### 5.5 setMarkdown / getMarkdown

见 §20.1 / §20.2；`setMarkdown` 的 tr 必须 `setMeta('addToHistory', false)` 以免污染 undo。  

### 5.6 viewOnly

- `editable()` 返回 false。  
- 不注册 slash / inputrules 结构变换 / drop 上传。  
- 仍允许选择与复制。  

---

## 6. Schema 规格（节点与 Mark）

### 6.1 设计约束

- 顶层：`doc → block+`  
- 文本块：`inline*`  
- 列表用标准 `list + list_item`（便于 sink/lift）  
- callout：`attrs.kind`  
- 公式：`math_block` + `math_inline`（atom），**源码在 attrs.latex**  
- `code_block`：`text*` + `attrs.lang`  
- **禁止** attrs 塞大段 HTML  
- **禁止** database/board 节点  

### 6.2 Marks 全表

| mark | attrs | Markdown | toDOM | parseDOM 要点 |
|------|-------|----------|-------|----------------|
| bold | — | `**` / `__` | `strong` | strong, b |
| italic | — | `*` / `_` | `em` | em, i |
| strike | — | `~~` | `s` | s, del |
| code | — | `` ` `` | `code.mdx-code` | code |
| link | href, title? | `[t](u)` | `a.mdx-a` | a[href]；消毒 javascript: |
| highlight | — | `==` | `mark.mdx-mark-hl` | mark |
| underline | — | `++` | `u` | u |

**InputRule 优先级**：code > link > bold(`**`) > strike > highlight > underline > italic(`*`)，避免 `**` 被拆成斜体。

### 6.3 Nodes 全表

| node | content | attrs | Markdown 要点 |
|------|---------|-------|----------------|
| doc | block+ | — | 根 |
| paragraph | inline* | — | 默认块 |
| heading | inline* | level:1–6 | ATX `#` |
| blockquote | block+ | — | `>` |
| bullet_list | list_item+ | tight? | `-` `*` |
| ordered_list | list_item+ | order | `1.` |
| list_item | paragraph block* | — | 标准 |
| task_list | task_item+ | — | 推荐模型 A |
| task_item | paragraph block* | checked:boolean | `- [ ]` / `- [x]` |
| code_block | text* | lang:string | 围栏 |
| horizontal_rule | — | — | `---` |
| hard_break | — | — | Shift+Enter |
| callout | block+ 或 title+body | kind, title? | `> [!KIND]` |
| math_block | — | latex:string | `$$` |
| math_inline | — | latex:string | `$...$` atom |
| image | — | src,alt,title,caption? | `![]()` |
| file_chip | — | path,label? | `[[file:]]` |
| wiki_link | — | title,label? | `[[doc:]]`（可 mark 化） |
| table | table_row+ | — | GFM |
| table_row | (table_cell\|table_header)+ | — | |
| table_cell | block+ | align?,colspan?,rowspan? | |
| table_header | block+ | align? | |
| toc | — | minLevel?,maxLevel? | `@[toc]` |

**Mermaid**：优先 `code_block` + `lang=mermaid`，避免双类型漂移。

### 6.4 task 模型（默认 A）

- **A（推荐）**：`task_list` + `task_item(checked)`  
- **B**：`list_item` + `attrs.checked != null`  
- PR 必须写明 A/B；无声明视为 A。  

### 6.5 callout 内容模型

**R1 可简化**：`attrs: { kind, title?: string }` + `content: block+`。  
**R2 完整**：可选 `callout_title` 子节点。  
类型枚举：`note | tip | important | warning | caution`（`info` 归一 note）。  

### 6.6 toDOM 类名契约（CSS 依赖 · 禁止乱改）

| node | 根 class |
|------|----------|
| paragraph | `mdx-p` |
| heading | `mdx-h mdx-h{N}` |
| bullet_list | `mdx-ul` |
| ordered_list | `mdx-ol` |
| task_item | `mdx-task`（内含 `input.mdx-task-check`） |
| code_block | `mdx-code-card`（NodeView） |
| callout | `mdx-callout mdx-callout--{kind}` |
| math_block | `mdx-math` |
| blockquote | `mdx-quote` |
| hr | `mdx-hr` |

### 6.7 TypeScript 骨架（必须存在的导出）

```ts
// schema/index.ts
import { Schema } from 'prosemirror-model';
export const schema: Schema;
export type MdxSchema = typeof schema;
```

```ts
// types.ts 片段
export type CalloutKind = 'note' | 'tip' | 'important' | 'warning' | 'caution';
export interface CodeBlockAttrs { lang: string }
export interface MathAttrs { latex: string }
export interface TaskItemAttrs { checked: boolean }
```

### 6.8 Schema 变更流程

1. 改本规格 §6 表 →  
2. 改 schema 代码 →  
3. 改 parse/serialize →  
4. 加 roundtrip 测 →  
5. 更新 showcase 若用户可见。  

**禁止**只改代码不改本表。  

---

## 7. 选区、键盘与跨块（关闭 U-06）

### 7.1 选区模型

| 需求 | 实现 |
|------|------|
| 跨段落字符选区 | 默认 `TextSelection`（PM 原生） |
| 全选 | `Mod-a` → `AllSelection` 或全 doc range |
| 节点选中 | `NodeSelection`（如图） |
| 块级多选（把手） | 可选 plugin state + Decoration；**不能**替代字符 range 验收 |

### 7.2 复制策略

1. 若存在字符 range → 序列化切片为 MD。  
2. 若 block-multi 长度 > 1 → 按文档序序列化这些块。  
3. 禁止只 `window.getSelection().toString()` 作为唯一路径（会丢结构）。  

### 7.3 键盘地图（最低集 · 必须实现）

| 按键 | 行为 |
|------|------|
| Mod-b / Mod-i | toggle bold / italic |
| Mod-Shift-x | toggle strike（可配置） |
| Mod-z / Mod-Shift-z / Mod-y | undo / redo |
| Enter | split；空 list_item → lift 成 paragraph |
| Backspace | join / lift / 边界 unsetMark |
| Tab / Shift-Tab | sink / lift list |
| Mod-a | 全选 |
| / 与 、 | slash（规则 §7.4） |
| ArrowUp/Down | PM 默认跨块 |
| Shift+Arrow | 扩展选区跨块 |
| Escape | 关 slash/菜单；清 block-multi |

### 7.4 Slash 触发规则

- 仅当从**当前文本块起始**到 cursor 的文本匹配 `^[/、](.*)$` 且无其它字符时打开。  
- 选命令后：删除触发前缀 + `setBlockType` / `insert`。  
- 命令最少集：paragraph, h1–h6, bullet, ordered, task, quote, code, hr, callout(R2), math(R2), table(R2), image(R2)。  
- **H4–H6 必须存在**（历史 slash 曾缺）。  

### 7.5 禁止的选区实现

- 多个 contenteditable 根拼「伪跨块」。  
- 以 `selectedIds: string[]` 作为 **S04 唯一**实现。  
- 选区依赖 `enterEdit` 先打开。  

---

## 8. NodeView 规格

### 8.0 通用契约

```ts
interface MdxNodeView {
  dom: HTMLElement;
  contentDOM?: HTMLElement;
  update(node: Node): boolean;
  selectNode?(): void;
  deselectNode?(): void;
  stopEvent?(e: Event): boolean;
  ignoreMutation?(r: MutationRecord | { type: string }): boolean;
  destroy(): void;
}
```

硬规则：

- checkbox / 语言菜单 / 复制按钮：`stopEvent` 返回 true。  
- 高亮刷新：`ignoreMutation` 防止光标跳动。  
- `update` **禁止**无条件整树 `innerHTML` 重置导致丢焦点。  
- 销毁时解绑监听与 portal。  

### 8.1 code_block

#### 8.1.1 功能优先级

| 功能 | 波次 | 说明 |
|------|------|------|
| 可编辑文本 | R1/R2 | 与 PM doc 同步 |
| 语法高亮 | R2 | 装饰或异步层 |
| 语言菜单 | R2 | 写 `attrs.lang` |
| 复制 body | R2 | 无围栏无行号 |
| 行号 gutter | R2 | user-select:none |
| 长码折叠 | R2 | session；>24 行默认折 12 |
| 单表面 | P0 | 禁双壳 |

#### 8.1.2 文件

- `nodeViews/codeBlock.ts`  
- 可选 `plugins/codeHighlight.ts`  

#### 8.1.3 DoD

- [ ] 键入进入 doc  
- [ ] getMarkdown 含 \`\`\`lang  
- [ ] 复制无行号  
- [ ] 截图无双壳  
- [ ] S06 S07 PASS  

### 8.2 task_item

#### 8.2.1 行为

- 点击 checkbox → `tr.setNodeMarkup(pos, null, { checked: !checked })`  
- 点击文字 → 正常文本选区  
- 序列化 `- [ ]` / `- [x]`  

#### 8.2.2 DoD

- [ ] S03 PASS  
- [ ] U-02 关闭  
- [ ] 连续点击 5 次 MD 一致  

### 8.3 math_block / math_inline

#### 8.3.1 行为

- 默认 KaTeX 渲染（无 peer 则等宽 latex，**清晰可读**）  
- 点击 math_block → 同节点源码编辑 `attrs.latex`（可显示 `$$` 包装，但存储可只存 latex）  
- 失焦 / Esc → 回渲染  
- math_inline：atom；删除整颗；编辑用双击或 tooltip（R2 写死一种）  
- **永远**用 attrs.latex 往返  

#### 8.3.2 用户截图反例

禁止：`E=mc` 与 `2` 分成两行的损坏态来自「渲染结果当源」。  

#### 8.3.3 DoD

- [ ] S08 PASS  
- [ ] 点击来回 10 次 latex 不变  
- [ ] `$3` `$5` 货币不进公式（测例）  

### 8.4 callout

#### 8.4.1 行为

- 视觉：`mdx-callout--{kind}`  
- **类型选择器**（`<select>` 或按钮组）可改 kind  
- 标题与正文可编  
- 序列化 GitHub Alerts  

#### 8.4.2 DoD

- [ ] S09 PASS  
- [ ] 正文 `**x**` 保持  
- [ ] 无 monospaced `> [!TIP]` 整墙默认态  

### 8.5 image

- attrs: src, alt, title, caption?  
- 点击灯箱；Esc/遮罩关  
- 粘贴图片：`uploadImage` 端口；无端口 blob URL  
- 禁止假上传成功 URL  

### 8.6 table（R2）

- 优先 `prosemirror-tables`  
- GFM align 往返（`:---`, `:---:`, `---:`）  
- 合并单元格：可 R2.5；未做则菜单禁用并文档声明  
- 单元格内 marks：R2 目标  

### 8.7 image/toc/wiki/file

- R2–R3 按 §15；wiki/file 点击走 `onOpenDoc` / `onOpenPath`  

---

## 9. Markdown 桥接（parse / serialize）

### 9.1 原则

1. 同一 md 多次 parse **结构同构**。  
2. serialize 稳定、可测。  
3. 未知 HTML 转义/丢弃，防 XSS。  
4. 可选 `mode: 'conex' | 'pure-gfm'` 导出。  

### 9.2 结构覆盖表

| 结构 | R1 | R2 | 测试 |
|------|----|----|------|
| ATX h1–h6 | Y | Y | roundtrip |
| paragraph + 基础 marks | Y | Y | |
| highlight/underline | 可选 | Y | |
| bullet/ordered/task | Y | Y | 嵌套 |
| blockquote | Y | Y | |
| fenced code + lang | Y | Y | |
| table + align | 可选 | Y | |
| callout | 可选 | Y | |
| math $$ / $ | 可选 | Y | 货币负例 |
| image | 可选 | Y | |
| hr | Y | Y | |
| wiki/file | 可选 | R3 | |
| toc | 可选 | R3 | |
| mermaid fence | 可选 | R2–R3 | lang=mermaid |

### 9.3 从旧 parse.js 迁移纪律

Agent 必须输出表格：

| 旧分支 | 状态 | 文件 |
|--------|------|------|
| heading | done/todo | |
| table align | | |
| callout | | |
| … | | |

**未声明子集却标 R1 完成 → 打回。**

### 9.4 serialize 伪代码骨架

```ts
function serializeNode(node: Node): string {
  switch (node.type.name) {
    case 'heading':
      return '#'.repeat(node.attrs.level) + ' ' + serializeInline(node) + '\n\n';
    case 'paragraph':
      return serializeInline(node) + '\n\n';
    case 'code_block':
      return '```' + (node.attrs.lang || '') + '\n' + node.textContent + '\n```\n\n';
    case 'task_item':
      return '- [' + (node.attrs.checked ? 'x' : ' ') + '] ' + /* ... */ '';
    case 'callout':
      return serializeCallout(node);
    case 'math_block':
      return '$$\n' + node.attrs.latex + '\n$$\n\n';
    default:
      return serializeChildren(node);
  }
}
```

### 9.5 链接消毒

```ts
function sanitizeHref(href: string): string {
  if (/^\s*javascript:/i.test(href)) return '#';
  return href;
}
```

---

## 10. InputRules / 定界符 UX / as-you-type

### 10.1 必须 rules

| 触发 | 结果 | 波次 |
|------|------|------|
| `**…**` 闭合 | bold | R1 |
| `*…*` 非粗 | italic | R1 |
| `~~…~~` | strike | R1 |
| `` `…` `` | code | R1 |
| `==…==` | highlight | R2 |
| `++…++` | underline | R2 |
| 行首 `# `…`###### ` | heading | R1 |
| 行首 `- `/`* ` | bullet | R1 |
| 行首 `1. ` | ordered | R1 |
| 行首 `- [ ] ` | task | R1 |
| 行首 `> ` | quote | R1 |
| 行首 ``` | code_block | R1 |
| 独占 `---` | hr | R1 |

### 10.2 ux-D2 定界符邻域

- Decoration/widget 在 caret 所在 mark 边界显示灰 `**` 等。  
- 非邻域 mark 不显示定界符。  
- composition 期间冻结。  
- 成对 Backspace：边界 `unsetMark` 命令。  
- **禁止**重演旧 `applyLiveMarks` 整段 HTML 替换。  

### 10.3 IME

- `plugins/imeGuard.ts` 维护 `composing` 标志。  
- inputrules 在 composing 时跳过。  
- 测例：模拟 composition 期间输入 `**` 不崩溃。  

---

## 11. 插件清单

| 插件 | 文件 | 职责 | 不做什么 |
|------|------|------|----------|
| history | history.ts | undo/redo | 不跨文档 |
| keymap | keymap.ts | §7.3 | 不写 DOM |
| inputRules | inputRules.ts | §10 | 不做 slash UI |
| slash | slash.ts | 命令插入 | 不 innerHTML |
| dropPaste | dropPaste.ts | 图/MD/HTML | 不 mock 上传 |
| imeGuard | imeGuard.ts | composition | 不乱 dispatch |
| delimDecoration | delimDecoration.ts | 灰定界符 | 不改 doc 除非命令 |
| blockMulti | blockMulti.ts | 块多选装饰 | 不替代 S04 |
| blockHandle | blockHandle.ts | DnD R3 | R1 可 stub |
| ai | 可选 | 调端口 | 无 complete 不注册 |

---

## 12. 样式与 BAN-01 细则

### 12.1 允许的反馈

- 系统 caret  
- 空段 placeholder  
- hover 显示块把手  
- popover 短淡入  
- 多选极淡 decoration  

### 12.2 禁止

```css
/* 禁止出现 */
.mdx-block.is-active { background: ...; outline: ...; box-shadow: ...; }
.mdx-block.is-editing { border: 1px solid ...; }
```

### 12.3 ProseMirror 根样式要点

```css
.mdx-editor .ProseMirror {
  outline: none;
  min-height: 200px;
  white-space: pre-wrap;
  word-wrap: break-word;
}
.mdx-editor .ProseMirror-focused {
  /* 禁止整根编辑器描边假装激活行 */
  outline: none;
}
```

### 12.4 动效

- 时长 token 对齐现有 `--mdx-motion-*`  
- `prefers-reduced-motion: reduce` → 无动画  
- 禁止阴影呼吸  

---

## 13. 对外 API（宿主零感迁移）

### 13.1 Options

```ts
export interface MountOptions {
  markdown?: string;
  doc?: unknown; // 可选 legacy doc
  viewOnly?: boolean;
  onChange?: (md: string, doc?: unknown) => void;
  onOpenPath?: (path: string, meta?: object) => void;
  onOpenDoc?: (title: string) => void;
  uploadImage?: (file: File, ctx?: object) => Promise<{ url: string; alt?: string }>;
  media?: { uploadImage?: MountOptions['uploadImage']; resolveUrl?: Function };
  resolveUrl?: (ref: string, kind?: string) => string;
  maxUploadBytes?: number;
  features?: { media?: boolean; maxUploadBytes?: number };
  autosaveMs?: number; // default 280
  selectionToolbar?: boolean; // default false
  ai?: { complete: AiComplete } | AiComplete | false | null;
  commandPalette?: boolean;
  openOnCtrlP?: boolean;
  onToggleSource?: () => void;
  /** v2 调试：强制引擎 */
  engine?: 'fused' | 'legacy';
}
```

### 13.2 PublicApi

```ts
export interface PublicApi {
  getMarkdown(): string;
  setMarkdown(md: string): void;
  getDoc(): unknown;
  setDoc(doc: unknown): void;
  focus(): void;
  destroy(): void;
  flush(): void;
  openCommandPalette?(): void;
  runAi?(action: string): Promise<void>;
}
```

### 13.3 全局导出

```ts
// 浏览器
window.MarkdownEditor = {
  mount,
  parse: parseMarkdown,
  serialize: serializeMarkdown,
  VERSION: '3.0.0-fused',
};
```

### 13.4 与旧 index.js 兼容

- 旧 options 字段继续识别。  
- 未知字段忽略。  
- `viewOnly: true` 必须不可编辑。  
- AI 无 complete → 入口隐藏。  

---

## 14. 测试规格

### 14.1 层级

| 层 | 工具 | 内容 |
|----|------|------|
| 单元 | vitest | parse/serialize、rules、commands |
| 组件 | vitest+jsdom | checkbox、math attrs |
| 禁令 | vitest + rg | bans |
| 手工 | showcase | S01–S15 |

### 14.2 R1 最低用例（摘录；完整 ID 见实现仓库 tests 命名）

| ID | 断言 |
|----|------|
| T-R1-01 | parse hello → paragraph |
| T-R1-02 | `# H` → heading 1 |
| T-R1-03 | `**a**` roundtrip |
| T-R1-04 | `*a*` roundtrip |
| T-R1-05 | `~~a~~` roundtrip |
| T-R1-06 | `` `c` `` roundtrip |
| T-R1-07 | 无序列表 |
| T-R1-08 | 有序列表 |
| T-R1-09 | task checked |
| T-R1-10 | blockquote |
| T-R1-11 | code fence lang |
| T-R1-12 | inputrule bold |
| T-R1-13 | inputrule heading |
| T-R1-14 | 空 list Enter 退出 |
| T-R1-15 | 跨 paragraph selection serialize 非空 |
| T-R1-16 | Mod-b |
| T-R1-17 | undo |
| T-R1-18 | viewOnly 拒绝插入 |
| T-R1-19 | setMarkdown 替换 |
| T-R1-20 | destroy 安全 |
| T-R1-21 | BAN-01 CSS/规则 |
| T-R1-22 | slash 插 h2 |
| T-R1-23 | IME 期间 rule 跳过（模拟） |
| T-R1-24 | paste plain |
| T-R1-25 | 空文档稳定 |

### 14.3 R2 追加

- math 10 次点击往返  
- code lang menu  
- callout kind  
- task 5 次点击  
- table align roundtrip  
- image lightbox  

### 14.4 完成定义（测试）

- R1：≥20 条自动化绿 + S01/S04/S05 手工 PASS  
- R2：S01–S12 相关 PASS + U-02/03/07/08 关闭  

---

## 15. 波次计划

### 15.1 总览

```text
R0 止血/禁令/规格     ████
R1 内核+MD子集+跨选       ████████
R2 节点视图                    ████████
R3 宿主能力                          ██████
R4 退役旧岛                                ████
```

### 15.2 R0（已发生）

- BANNED 文档  
- CSS 零激活强化  
- LEGACY checkbox / data-latex 止血  
- 11 + **本 12 规格**  

### 15.3 R1 范围（冻结 · 禁止膨胀）

**包含**：paragraph, heading, lists, task, blockquote, code_block(基础可编), hr, hard_break；marks bold/italic/strike/code/link；history/keymap/inputrules/slash/ime；跨块选区；mount API；showcase 可切换 v2。  

**不包含**：table 全功能、callout 完整、math 完整、image、DnD、mermaid 精修（可降级）。  

### 15.4 R2 范围

callout+kind UI；math block/inline；image+upload；code 行号/fold/lang；table 基础；highlight/underline；delim decoration。  

### 15.5 R3 范围

DnD handle；command palette；AI ports；toc；wiki/file；mermaid peer。  

### 15.6 R4 范围

默认引擎 fused；旧 editor.js → legacy；删除 height-lock 主依赖；更新 harness 与文档。  

### 15.7 建议日历

| 周 | 目标 | 退出标准 |
|----|------|----------|
| W0 | 规格批准 + R0 | 本文生效 |
| W1 | 包骨架 + schema + parse 子集 | 空编辑器 + 基础 roundtrip |
| W2 | inputrules + 列表 + 跨选 | S01 S04 S05 |
| W3 | slash + showcase 开关 | SAMPLE 子集可写 |
| W4–5 | R2 四 NodeView | U-02/03/07/08 |
| W6 | table/image | align + 灯箱 |
| W7 | R3 | 宿主能力 |
| W8 | R4 | 默认 v2 |

---

## 16. 多 Agent 工单（防偷懒 · 可直接复制派单）

**总规则**：一 Agent 一工单；只改所有权文件；DoD 全勾才能合并；冲突串行。

### 16.1 AGEN-R1-01 — 仓库骨架与 package

| 字段 | 内容 |
|------|------|
| 所有权 | `packages/conex-mdx/**` 脚手架、package.json、vite、tsconfig、README |
| 必读 | §4.4 §13 §0.3 |
| 任务 | 创建包；vitest；导出 mount 占位；README 链到本规格 |
| DoD | `npm test` 可跑；strict TS；占位 mount 明确抛「未实现」或最小空 doc |
| 禁止 | 写旧 editor.js；mock AI |

### 16.2 AGEN-R1-02 — Schema nodes/marks

| 字段 | 内容 |
|------|------|
| 所有权 | `src/schema/**` |
| 必读 | §6 |
| 任务 | R1 节点+marks；toDOM/parseDOM；导出 schema |
| DoD | 可创建 doc；无 database 节点；类名契约符合 §6.6 |
| 禁止 | 偷加 R2 节点却不写 parse |

### 16.3 AGEN-R1-03 — Markdown parse/serialize 子集

| 字段 | 内容 |
|------|------|
| 所有权 | `src/markdown/parse.ts`, `serialize.ts` |
| 必读 | §9 旧 parse.js |
| 任务 | 移植 R1 结构；roundtrip 测；输出迁移对照表 |
| DoD | T-R1-01..11 类测例绿；对照表进 PR |
| 禁止 | 静默丢 task checked |

### 16.4 AGEN-R1-04 — createEditor + mount API

| 字段 | 内容 |
|------|------|
| 所有权 | `src/editor/**`, `adapters/mountApi.ts`, `index.ts` |
| 必读 | §5 §13 |
| 任务 | EditorView；get/setMarkdown；viewOnly；destroy/flush/onChange |
| DoD | T-R1-18..20；options 兼容表 |
| 禁止 | 调用旧 enterEdit |

### 16.5 AGEN-R1-05 — inputRules + keymap + history

| 字段 | 内容 |
|------|------|
| 所有权 | `plugins/inputRules.ts`, `keymap.ts`, `history.ts` |
| 必读 | §7 §10 |
| 任务 | §10.1 R1 rules；Mod-b/i；undo；空 list Enter |
| DoD | T-R1-12..17；IME 跳过 |
| 禁止 | innerHTML 折叠 |

### 16.6 AGEN-R1-06 — 跨块选区与复制

| 字段 | 内容 |
|------|------|
| 所有权 | selection 相关 plugin/util |
| 必读 | §7 |
| 任务 | 验证跨 paragraph TextSelection；serializeSelection |
| DoD | T-R1-15；S04 手工 |
| 禁止 | 假跨岛 |

### 16.7 AGEN-R1-07 — slash 基础

| 字段 | 内容 |
|------|------|
| 所有权 | `plugins/slash.ts` |
| 必读 | §7.4 旧命令表 |
| 任务 | `/` `、`；h1–h6 list code quote hr task；键盘 |
| DoD | T-R1-22；S10 |
| 禁止 | 页顶工具条 |

### 16.8 AGEN-R1-08 — CSS BAN-01 + 基础皮

| 字段 | 内容 |
|------|------|
| 所有权 | `src/style/editor.css` |
| 必读 | §12 BANNED |
| 任务 | typography；placeholder；reduce-motion；零激活行 |
| DoD | T-R1-21；截图 |
| 禁止 | is-active 底色 |

### 16.9 AGEN-R1-09 — 测试与 ban 脚本

| 字段 | 内容 |
|------|------|
| 所有权 | `tests/**`, `scripts/check-mdx-bans.sh` |
| 必读 | §14 §3.2 |
| 任务 | ≥20 测例；ban 脚本 |
| DoD | CI 绿 |
| 禁止 | 空测试充数 |

### 16.10 AGEN-R1-10 — Showcase 开关

| 字段 | 内容 |
|------|------|
| 所有权 | `markdown-editor.html` 或 v2 demo 页 |
| 必读 | §15 SAMPLE |
| 任务 | `?engine=v2` 或 localStorage；加载 showcase-sample |
| DoD | 手工段落列表粗体跨选 |
| 禁止 | 未宣布就删 legacy 默认 |

### 16.11 AGEN-R2-01 — task checkbox NodeView

所有权：`nodeViews/taskItem.ts` · 必读 §8.2 · DoD：S03、U-02  

### 16.12 AGEN-R2-02 — code_block 全功能

所有权：`nodeViews/codeBlock.ts` · 必读 §8.1 · DoD：S06 S07、单表面、复制  

### 16.13 AGEN-R2-03 — math

所有权：`nodeViews/mathBlock.ts`, `mathInline.ts` · 必读 §8.3 · DoD：S08、无乱码  

### 16.14 AGEN-R2-04 — callout

所有权：`nodeViews/callout.ts` · 必读 §8.4 · DoD：S09、kind UI  

### 16.15 AGEN-R2-05 — image + upload

所有权：`nodeViews/image.ts`, dropPaste · 必读 §8.5 · DoD：灯箱、端口  

### 16.16 AGEN-R2-06 — table 基础

所有权：table schema + view · 必读 §8.6 · DoD：align roundtrip  

### 16.17 AGEN-R2-07 — 定界符 decoration + 成对 BS

所有权：`plugins/delimDecoration.ts` + keymap · 必读 §10.2 · DoD：S01 S02  

### 16.18 工单完成 PR 模板（强制）

```markdown
## 工单 ID
## 波次
## 所有权文件
## 对照规格章节
## DoD 勾选
## 复现命令
## 截图（如 UI）
## 风险 / 后续
## 声明：未使用 enterEdit 换壳作为 v2 能力
```

---

## 17. LEGACY 岛维护政策

### 17.1 允许

- 崩溃 / 数据丢失 / 安全  
- BAN 视觉违例修复  
- 极小 UX 止血（须 `// LEGACY-ISLAND: remove in R4`）  

### 17.2 禁止

- 新块类型、协作、视频大功能  
- 扩大 enterEdit 分支  
- 无注释的「伪重构」  

### 17.3 注释格式

```js
// LEGACY-ISLAND: remove in R4 — <reason>
```

### 17.4 R4 删除候选

| 文件 | 动作 |
|------|------|
| editor.js | legacy/ 或删 |
| ui/line-source.js | 删主路径 |
| edit/height-lock.js | 删 |
| 旧 selection 主逻辑 | 被 PM 替代后删 |

---

## 18. 风险、依赖与决策

### 18.1 风险表

| 风险 | 影响 | 缓解 |
|------|------|------|
| PM 学习曲线 | 慢 | R1 范围极窄 |
| 包体积 | 加载 | lazy 高亮/图表 |
| 扩展往返丢字段 | 数据 | golden 测 |
| 双引擎并存 | 混乱 | showcase 标明 |
| Agent 假完成 | 返工 | §0.3+DoD |

### 18.2 已关闭决策

- ux-D10 文档流内核  
- ux-D11 融合默认  
- BAN-01..08  

### 18.3 不阻塞 R1 的开放决策

| ID | 议题 | 默认 |
|----|------|------|
| ux-D12 | TipTap vs 裸 PM | 裸 PM |
| ux-D13 | task A/B | A |
| ux-D14 | 表合并何时 | R2.5 可 |

---

## 19. 迁移运行手册

### 19.1 创建包

```bash
mkdir -p packages/conex-mdx/src/{editor,schema,markdown/extensions,plugins,nodeViews,adapters,style}
mkdir -p packages/conex-mdx/{tests,scripts}
```

### 19.2 依赖安装

```bash
npm i prosemirror-model prosemirror-state prosemirror-view prosemirror-transform \
  prosemirror-commands prosemirror-keymap prosemirror-history prosemirror-inputrules \
  prosemirror-schema-list prosemirror-schema-basic
npm i -D typescript vitest jsdom vite @types/node
```

### 19.3 日循环

1. 写失败测试  
2. 最小实现  
3. `npm test`  
4. 手工 `?engine=v2`  
5. 更新文末进度表  

### 19.4 进度表模板

| 日期 | Agent | 工单 | 状态 | 证据 |
|------|-------|------|------|------|
| 2026-08-03 | spec | 12 | done | 本文件 |

---

## 20. 详细伪代码（禁止自由发挥替代）

### 20.1 setMarkdown

```ts
function setMarkdown(md: string, view: EditorView) {
  const doc = parseMarkdown(md || '');
  const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content);
  tr.setMeta('addToHistory', false);
  view.dispatch(tr);
}
```

### 20.2 getMarkdown

```ts
function getMarkdown(view: EditorView) {
  return serializeMarkdown(view.state.doc);
}
```

### 20.3 toggleBold

```ts
import { toggleMark } from 'prosemirror-commands';
export const toggleBold = toggleMark(schema.marks.bold);
```

### 20.4 checkbox

```ts
function onCheckClick(
  e: MouseEvent,
  getPos: () => number | undefined,
  view: EditorView,
) {
  e.preventDefault();
  e.stopPropagation();
  const pos = getPos();
  if (pos == null) return;
  const node = view.state.doc.nodeAt(pos);
  if (!node) return;
  view.dispatch(
    view.state.tr.setNodeMarkup(pos, undefined, {
      ...node.attrs,
      checked: !node.attrs.checked,
    }),
  );
}
```

### 20.5 callout serialize 要点

```ts
function serializeCallout(node: Node): string {
  const kind = String(node.attrs.kind || 'note').toUpperCase();
  const lines = [`> [!${kind}]`];
  // 每个子块行前加 "> "
  return lines.join('\n') + '\n\n';
}
```

### 20.6 空 list Enter 退出（逻辑）

```text
if selection empty
  and parent is task_item or list_item
  and item text empty
then lift list item → paragraph
else default split
```

### 20.7 防 XSS

见 §9.5。  

---

## 21. 旧文件逐一处置表

| 旧文件 | R4 处置 | 完成 |
|--------|---------|------|
| util.js | 逻辑拆入 parse/serialize/style utils | ☐ |
| schema.js | 由 PM schema 替代；DTO 可选保留 | ☐ |
| model.js | 删主路径 | ☐ |
| parse.js | 迁 markdown/parse | ☐ |
| serialize.js | 迁 markdown/serialize | ☐ |
| registry.js | 迁 extension registry | ☐ |
| editor.js | legacy 或删 | ☐ |
| index.js | 变薄 re-export @conex/mdx | ☐ |
| inline/* | 删主路径 | ☐ |
| ui/line-source.js | 删主路径 | ☐ |
| ui/slash-menu.js | 迁 slash plugin | ☐ |
| ui/command-palette.js | R3 迁 | ☐ |
| ui/code-* | 迁 code NodeView | ☐ |
| ui/table-chrome.js | 迁 table | ☐ |
| blocks/* | 迁 nodeViews | ☐ |
| edit/height-lock.js | 删 | ☐ |
| edit/ime-guard.js | 迁 plugin | ☐ |
| edit/demotion.js | 迁 keymap | ☐ |
| edit/promote.js | 迁 inputrules | ☐ |
| edit/motion.js | CSS 为主 | ☐ |
| edit/clipboard/* | 迁 dropPaste | ☐ |
| selection/* | 迁 PM | ☐ |
| table/* | 迁 R2 | ☐ |
| ai/* | 迁 ports | ☐ |
| media/drop-paste.js | 迁 | ☐ |
| demo/showcase-sample.js | 保留 | ☐ |

---

## 22. 反模式图鉴（出现即打回）

| 反模式 | 例子 | 正确 |
|--------|------|------|
| 换壳编辑 | `content.innerHTML = softSurface` | Transaction |
| 双 CE 岛 | 每块 contenteditable 根 | 单一 ProseMirror |
| 假跨选 | selectedIds + innerText | TextSelection |
| 渲染当源 | katex textContent → latex | attrs.latex |
| 激活整行 | is-active background | 仅 caret |
| 上帝文件 | editor.ts 3000 行 | §4.4 拆分 |
| 静默降级 | parse 丢 checked | 测试失败 |
| 假完成 | 只改文档 | DoD 测例 |
| 假 AI | mock complete | 隐藏入口 |
| 范围偷跑 | R1 做完整协同 | 先改 §15 |

---

## 23. 扩展术语与缩写

| 缩写 | 含义 |
|------|------|
| PM | ProseMirror |
| CE | contenteditable |
| DoD | 完成定义 |
| GFM | GitHub Flavored Markdown |
| IIFE | 旧浏览器捆绑脚本 |
| R0–R4 | 波次 |

---

## 24. 手工验收剧本（完整）

测试员打开 **v2** showcase，按序执行，记录 PASS/FAIL/备注。

### 24.1 S01 `**demo**`

- 操作：空段键入 `**demo**`  
- 期望：demo 粗体  
- ☐ PASS ☐ FAIL 备注：____  

### 24.2 S02 成对拆格式

- 操作：光标在粗体词首 Backspace  
- 期望：变纯文本  
- ☐ PASS ☐ FAIL  

### 24.3 S03 待办

- 操作：单击 checkbox 5 次  
- 期望：状态与 MD 一致；不进源码墙  
- ☐ PASS ☐ FAIL  

### 24.4 S04 跨段拖选

- 操作：从段中拖到下段  
- 期望：连续选区；复制含两段  
- ☐ PASS ☐ FAIL  

### 24.5 S05 方向键跨段

- 操作：段末 ↓  
- 期望：无闪白乱跳  
- ☐ PASS ☐ FAIL  

### 24.6 S06 代码编辑

- 操作：点代码内部键入  
- 期望：可编  
- ☐ PASS ☐ FAIL  

### 24.7 S07 语言菜单

- 操作：改 js→python  
- 期望：标签与 fence 变  
- ☐ PASS ☐ FAIL  

### 24.8 S08 公式

- 操作：点公式块编辑再失焦 ×10  
- 期望：渲染正确；无碎行  
- ☐ PASS ☐ FAIL  

### 24.9 S09 callout 类型

- 操作：tip→warning  
- 期望：色与 MD kind  
- ☐ PASS ☐ FAIL  

### 24.10 S10 slash

- 操作：`/h2` 或面板选标题 2  
- 期望：成 h2  
- ☐ PASS ☐ FAIL  

### 24.11 S11 空列表 Enter

- 操作：空 bullet Enter  
- 期望：成段落  
- ☐ PASS ☐ FAIL  

### 24.12 S12 粘贴表

- 操作：粘贴 GFM 表  
- 期望：可编表  
- ☐ PASS ☐ FAIL  

### 24.13 S13 reduce-motion

- 操作：系统开启减少动态效果  
- 期望：无长动画  
- ☐ PASS ☐ FAIL  

### 24.14 S14 viewOnly

- 操作：viewOnly mount  
- 期望：不可编  
- ☐ PASS ☐ FAIL  

### 24.15 S15 无 AI 端口

- 操作：不注入 complete  
- 期望：无 AI 项、无 mock  
- ☐ PASS ☐ FAIL  

### 24.16 U-01 激活视觉

- 操作：在多段间移动 caret  
- 期望：无全行底色描边  
- ☐ PASS ☐ FAIL  

---

## 25. 附录 A — 现状调用链

```text
MarkdownEditor.mount
  → MdxEditor.createEditor (editor.js)
    → model = MdxModel
    → fullRender: buildBlockEl + readContentHtml
    → click → enterEdit(type switch)
    → exitEdit → commitActiveFromDom → readContentHtml
```

v2：`mount → EditorView`；**无** enterEdit。  

---

## 26. 附录 B — Options 默认值

| 字段 | 默认 | 说明 |
|------|------|------|
| markdown | `''` | |
| viewOnly | false | |
| autosaveMs | 280 | onChange 防抖 |
| selectionToolbar | false | |
| commandPalette | true | |
| openOnCtrlP | true | |
| ai | null | 无 complete 关闭 |
| features.media | true | |
| engine | 实现自定 | R4 前 showcase 可 legacy |

---

## 27. 附录 C — data 属性与事件

| 名称 | 说明 |
|------|------|
| `data-mdx-root` | 编辑器根（可保留） |
| `data-latex` | 公式源真相 |
| `data-kind` / callout attrs | 类型 |
| `.mdx-task-check` | checkbox |
| `.ProseMirror` | PM 根 |
| `mdx-code-lang` CustomEvent | 可选通知宿主 |

---

## 28. 安全

- 禁止 `javascript:` 链接  
- 粘贴 HTML 消毒后转 MD  
- 不执行 MD 内嵌脚本  
- 上传仅宿主端口  
- 不在 console 打印用户全文隐私到生产默认  

---

## 29. 性能预算

| 指标 | 目标 |
|------|------|
| mount 10KB md | < 100ms 量级（中端机，指导值） |
| 按键到上屏 | < 32ms 指导值 |
| 高亮 | 防抖 50–100ms |
| 1000 块 | 可滚动；虚拟化后置 |

---

## 30. 常见争论与官方默认（停止抬杠）

| 争论 | 官方默认 |
|------|----------|
| 继续优化 soft-edit？ | 否，仅 LEGACY 止血 |
| 自研整页 CE？ | 否，用 PM |
| TipTap？ | 可，schema 仍以本文为准 |
| R1 要 DnD？ | 不要 |
| 激活行一点点底色？ | **不要** |
| 要不要协同？ | 不做 |
| 表合并 R1？ | 不要 |

---

## 31. 场景 → 实现映射（禁止跳过）

### 31.1 S01 粗体 as-you-type

- 模块：inputRules、marks、delimDecoration  
- 测试：T-R1-12、S01  
- PR 必须写 verified 步骤  

### 31.2 S02 成对 Backspace

- 模块：keymap unsetMark  
- 测试：S02  

### 31.3 S03 task

- 模块：taskItem NodeView  
- 测试：S03；禁止 enterEdit  

### 31.4 S04 跨选

- 模块：PM selection + serialize slice  
- 测试：T-R1-15、S04  

### 31.5 S05 跨段方向键

- 模块：默认 PM；禁止自定义 exit/enter  
- 测试：S05  

### 31.6 S06–S07 代码

- 模块：codeBlock NodeView  
- 测试：S06 S07  

### 31.7 S08 公式

- 模块：math NodeView + attrs.latex  
- 测试：S08；对照用户乱码截图  

### 31.8 S09 callout

- 模块：callout NodeView kind UI  
- 测试：S09  

### 31.9 S10 slash

- 模块：slash plugin  
- 测试：S10  

### 31.10 S11 空列表 Enter

- 模块：keymap  
- 测试：S11  

### 31.11 S12 表粘贴

- 模块：parse + table  
- 测试：S12  

### 31.12 S13–S15

- 模块：CSS reduce-motion；viewOnly；ai ports  
- 测试：对应节  

---

## 32. 建议排期与人力

| 角色 | R1 | R2 |
|------|----|----|
| 内核 1 人 | schema+editor+keymap | 支持 NodeView 集成 |
| MD 1 人 | parse/serialize | 扩展 callout/math/table |
| NodeView 1–2 人 | code 基础 | task/code/math/callout/image |
| 测试 1 人 | 测例+ban | 场景自动化 |
| 调度 | 防范围膨胀 | 防假完成 |

---

## 33. 「重构完成」总 DoD（产品签字）

- [ ] §2.4 S01–S15 全 PASS（或书面豁免项仅限未做波次）  
- [ ] U-01..U-09 关闭  
- [ ] BAN 自动检查绿  
- [ ] 默认路径非旧 editor.js 换壳  
- [ ] `@conex/mdx` 可被宿主 mount  
- [ ] 11/12/BAN 与实现一致  
- [ ] 无 mock AI  
- [ ] 中文 IME 抽测通过  
- [ ] 文档进度表更新  

**未勾完 = 未完成重构**——与改了多少文件无关。  

---

## 34. 参考文献与路径索引

- `docs/markdown-editor/BANNED-VISUAL-UX.md`  
- `docs/markdown-editor/ux-readiness/11-SYSTEMIC-REFACTOR-PLAN.md`  
- `docs/markdown-editor/ux-readiness/08-decision-log.md`  
- `docs/markdown-editor/12-integration-contract.md`  
- `docs/markdown-editor/feature-catalog/AI-HOST-POLICY.md`  
- `docs/markdown-editor/AGENT_BRIEFING.md`  
- `js/markdown-editor/**`（LEGACY）  
- ProseMirror Guide：https://prosemirror.net/docs/guide/  

---

## 35. 规格修订记录

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0.0 | 2026-08-03 | 首版全文：融合编辑重构执行真源 |

---

## 36. Agent 每日开工检查单（复制到 PR）

```markdown
## 今日工单 ID：
## 波次：R?
## 所有权文件：
## 对照章节：
- [ ] 已读 §0.3 禁止偷懒
- [ ] 已读 §3 BAN
- [ ] 已读本工单 DoD
- [ ] 未修改所有权外文件
- [ ] 有测试或书面说明为何无测
- [ ] 无 innerHTML 换壳
- [ ] 无全行激活样式
- [ ] 无 mock AI
## 复现命令：
## 风险：
```

---

## 37. 序列化 Golden 用例集

| ID | 名称 | 要点 | 断言 |
|----|------|------|------|
| G01 | 空文档 | `""` | 至少一个空 paragraph |
| G02 | 粗体中英 | `中**英**文` | marks 不错位 |
| G03 | 嵌套列表 | 缩进子项 | 层级正确 |
| G04 | 表空单元格 | 空 cell | 不丢列 |
| G05 | code 内 ** | fence 内 | 不解析为 bold |
| G06 | callout 多行 | `> [!NOTE]` | kind+body |
| G07 | 连续 hr | 两个 --- | 两节点 |
| G08 | task 混合 | `[ ]` `[x]` | checked 正确 |
| G09 | 货币 | `$3 到 $5` | 不进 math |
| G10 | 公式 | `$E=mc^2$` | attrs.latex 正确 |
| G11 | 表 align | :--- :---: ---: | align 数组 |
| G12 | emoji | ✅ | 不损坏 |
| G13 | 硬换行 | 视规则 | 文档声明 |
| G14 | 纯 GFM 导出 | callout 降级 | 策略可测 |
| G15 | wiki/file | 扩展语法 | R3 |

---

## 38. 错误码与日志

| code | 含义 | 用户可见 |
|------|------|----------|
| MDX_MOUNT_NO_HOST | host 空 | console error |
| MDX_PARSE_FAIL | parse 异常 | 回退空文档 + log |
| MDX_VIEW_DESTROYED | destroy 后调用 | no-op 或 throw（写死） |
| MDX_AI_NO_PORT | 无 complete | 隐藏 AI |
| MDX_UPLOAD_NO_PORT | 无上传 | blob 或拒绝策略写死 |

---

## 39. 与 monorepo 关系

- 宿主（desktop/workbench）只依赖 `@conex/mdx` 的 mount + CSS。  
- 不在 Rust 侧重写编辑器。  
- tokens 可对齐 conversation/design tokens。  
- 旧 `reference/chat-composer-component` 可继续作 demo 壳。  

---

## 40. 结束语（调度者）

本规格用于结束「在错误架构上无限打补丁」。  
Agent 交付若无法对 §33 勾选，即未完成——与是否「很忙」无关。  

**下一动作**：

1. 批准本文 1.0.0  
2. 派 AGEN-R1-01 … R1-10  
3. 两周后只验收：**S01 / S04 / S05 是否在 v2 成立**  

---

## 41. 补充：enterEdit 分支责任拆除表（旧 editor.js）

以下每个分支在 v2 的归宿必须明确，禁止「遗漏类型」：

| 旧 enterEdit 分支 | v2 归宿 | 波次 |
|-------------------|---------|------|
| paragraph/heading/list/quote soft | 默认节点 + inputrules | R1 |
| fullSourceEdit 调试 | 可选只读源码面板 onToggleSource | R3 |
| code / mermaid | code_block NodeView | R1–R2 |
| math | math NodeView | R2 |
| table | table | R2 |
| image | image NodeView | R2 |
| toc | toc node/plugin | R3 |
| divider | horizontal_rule | R1 |
| callout soft | callout NodeView | R2 |
| file_chip | file_chip node | R3 |

---

## 42. 补充：commitActiveFromDom 拆除表

| 旧 commit 路径 | v2 |
|----------------|-----|
| readFromLineEdit | 不需要；doc 即真相 |
| readFromFullSource | 调试面板单独 serialize |
| parseSource code fence | code_block text+lang |
| parseSource math $$ | attrs.latex |
| table cell DOM | table plugin |
| htmlToInlineMd | 仅粘贴转换可能仍用 |

---

## 43. 补充：事件监听迁移

| 旧监听 | v2 |
|--------|-----|
| root click enterEdit | PM handleClickOn / 默认 |
| edit keydown | keymap plugin |
| input live-marks | inputrules + decorations |
| composition* | imeGuard plugin |
| pointer multi-select | blockMulti plugin 可选 |
| paste | dropPaste plugin |

---

## 44. 补充：CSS 文件迁移

| 旧 CSS | v2 |
|--------|-----|
| index.css 排版 | style/editor.css 精简迁入 |
| motion.css | 保留 token；去掉岛动画依赖 |
| selection.css | decoration 样式；BAN-01 |
| inline-marks.css | mark 样式 + delim decoration |
| line-source.css | **大部分删除** |
| table.css | table 波次迁 |

---

## 45. 补充：showcase SAMPLE 与引擎开关

```js
// demo 伪代码
const engine = new URLSearchParams(location.search).get('engine') || localStorage.mdxEngine || 'legacy';
if (engine === 'v2') {
  window.MarkdownEditorV2.mount(host, { markdown: SAMPLE, ...ports });
} else {
  window.MarkdownEditor.mount(host, { markdown: SAMPLE, ...ports });
}
```

R4：默认 `v2`；`legacy` 仅调试。  

---

## 46. 补充：AI 端口形状（保持）

```ts
type AiComplete = (req: {
  action: string;
  selection: string;
  documentMd: string;
  signal?: AbortSignal;
}) => Promise<string> | AsyncIterable<string>;
```

无 complete → 不注册 AI 命令。禁止本地假回复。  

---

## 47. 补充：上传端口形状（保持）

```ts
type UploadImage = (file: File, ctx?: object) => Promise<{ url: string; alt?: string }>;
```

失败：不写假 URL；可 toast。  

---

## 48. 补充：无障碍最低要求

- 文档大纲：heading 使用 h1–h6  
- checkbox 可键盘切换（Space）  
- slash 列表 aria  
- 灯箱 focus trap + Esc  
- 不靠颜色作为唯一状态  

---

## 49. 补充：国际化

- UI 字符串中文优先（与产品一致）  
- kind 标签：注意/提示/重要/警告/危险  
- 不强制英文命令 only；aliases 可中英  

---

## 50. 补充：版本号策略

| 版本 | 含义 |
|------|------|
| 2.x | 旧 island 文档模型 |
| 3.0.0-fused | 文档流内核 |
| Doc JSON | 若保留 Block[] 导出，version 字段文档化 |

---

## 51. 场景实现检查表（每场景 8 行强制字段）

下列模板用于 PR 附件；每个 Sxx 复制一份填写。

```text
场景ID:
波次:
实现文件:
关键命令/规则:
测试ID:
手工步骤:
截图/日志:
风险:
```

### 51.1–51.15

对 S01–S15 各保留占位：

```text
场景ID: S01
波次: R1
实现文件: plugins/inputRules.ts, schema/marks.ts
关键命令/规则: ** pair inputrule
测试ID: T-R1-12
手工步骤: 空段输入 **demo**
截图/日志: (附)
风险: italic 冲突 — 已用优先级
```

（S02–S15 在执行时按同样模板填；Agent 不得删模板字段。）

```text
场景ID: S02
波次: R1/R2
实现文件: keymap.ts / delimDecoration.ts
关键命令/规则: unsetMark at boundary
测试ID: 手工 S02
手工步骤: 词首 Backspace
截图/日志:
风险:
```

```text
场景ID: S03
波次: R2
实现文件: nodeViews/taskItem.ts
关键命令/规则: setNodeMarkup checked
测试ID: task-checkbox.test.ts
手工步骤: 连点 checkbox
截图/日志:
风险:
```

```text
场景ID: S04
波次: R1
实现文件: editor + serialize slice
关键命令/规则: TextSelection across blocks
测试ID: T-R1-15
手工步骤: 跨段拖选复制
截图/日志:
风险:
```

```text
场景ID: S05
波次: R1
实现文件: 无自定义 exit/enter
关键命令/规则: default arrow
测试ID: 手工 S05
手工步骤: 段末 ↓
截图/日志:
风险:
```

```text
场景ID: S06
波次: R1/R2
实现文件: nodeViews/codeBlock.ts
关键命令/规则: editable code_block
测试ID: 手工 S06
手工步骤: 代码内键入
截图/日志:
风险:
```

```text
场景ID: S07
波次: R2
实现文件: codeBlock lang menu
关键命令/规则: set attrs.lang
测试ID: 手工 S07
手工步骤: 改语言
截图/日志:
风险:
```

```text
场景ID: S08
波次: R2
实现文件: mathBlock.ts
关键命令/规则: attrs.latex
测试ID: math-latex.test.ts
手工步骤: 点公式 10 次
截图/日志: 对照乱码截图
风险:
```

```text
场景ID: S09
波次: R2
实现文件: callout.ts
关键命令/规则: kind select
测试ID: 手工 S09
手工步骤: 改类型
截图/日志:
风险:
```

```text
场景ID: S10
波次: R1
实现文件: slash.ts
关键命令/规则: / h2
测试ID: T-R1-22
手工步骤: 空段 /
截图/日志:
风险:
```

```text
场景ID: S11
波次: R1
实现文件: keymap.ts
关键命令/规则: lift empty list item
测试ID: T-R1-14
手工步骤: 空 bullet Enter
截图/日志:
风险:
```

```text
场景ID: S12
波次: R2
实现文件: markdown/table + table view
关键命令/规则: parse GFM table
测试ID: roundtrip align
手工步骤: 粘贴表
截图/日志:
风险:
```

```text
场景ID: S13
波次: R1
实现文件: editor.css
关键命令/规则: prefers-reduced-motion
测试ID: 手工
手工步骤: 系统设置
截图/日志:
风险:
```

```text
场景ID: S14
波次: R1
实现文件: createEditor.ts
关键命令/规则: editable() false
测试ID: T-R1-18
手工步骤: viewOnly mount
截图/日志:
风险:
```

```text
场景ID: S15
波次: R1
实现文件: ai ports
关键命令/规则: no complete → hide
测试ID: 手工
手工步骤: 不注入 AI
截图/日志:
风险:
```

---

## 52. Reviewer 检查单（合并门禁）

- [ ] 工单 ID 与所有权文件匹配  
- [ ] 无 §22 反模式  
- [ ] 有测例或豁免说明  
- [ ] 无全行激活样式  
- [ ] 无 mock AI  
- [ ] 未越波次膨胀  
- [ ] 规格引用章节正确  
- [ ] 中文注释无乱码（UTF-8）  

---

## 53. 实现进度（维护者追加）

| 日期 | Agent | 工单 | 状态 | 证据 |
|------|-------|------|------|------|
| 2026-08-03 | 规格作者 | SPEC-12 | **done** | 本文件创建 |
| | | R0-BAN | done | BANNED + CSS |
| | | R1-* | pending | — |

---

## 54. 最终检查：本文是否足以驱动多 Agent？

| 问题 | 答案位置 |
|------|----------|
| 为何重写？ | §1 |
| 做成什么样？ | §2 |
| 红线？ | §3 |
| 目录与技术？ | §4 |
| 节点字段？ | §6 |
| 谁写哪个文件？ | §16 |
| 怎么测？ | §14 §24 |
| 何时算完？ | §33 |
| 旧代码怎么办？ | §17 §21 |

若上表有空，先补规格再写代码。  

---

**文档结束 · v1.0.0 · 融合实时编辑重构执行真源**
