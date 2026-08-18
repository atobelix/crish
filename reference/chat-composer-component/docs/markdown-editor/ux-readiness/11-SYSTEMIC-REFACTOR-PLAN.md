# 11 — 系统性重构方案：从「按行换壳」到「融合实时编辑」

> **日期**：2026-08-03  
> **触发**：用户对当前体验的否决（全行激活感、点一下跳源码、公式乱码、待办不可点、代码不能编、跨行选区缺失、切行卡键乱跳、语法半实时等）  
> **结论先行**：**继续在 block-per-row + enterEdit 换壳上堆补丁，无法达成产品目标。** 必须换编辑内核模型。  
> **硬禁令**：[BANNED-VISUAL-UX.md](../BANNED-VISUAL-UX.md)  
> **执行真源（千行级 · 多 Agent 派单）**：**[12-FUSED-EDITOR-REFACTOR-SPEC.md](./12-FUSED-EDITOR-REFACTOR-SPEC.md)**  
> **现状代码**：`reference/chat-composer-component/js/markdown-editor/*`（尤其 `editor.js` 4k+ 行）

---

## 0. 产品目标（一句话）

**实时预览编辑 = 融合交互**：用户始终在「像最终文档」的表面上工作；Markdown 语法可自由键入与修改；鼠标能完成勾选、改 callout 类型、进代码、改公式；跨行选区与键盘导航像正常编辑器——**不是**「阅读模式 / 源码模式」两套皮，也不是「点某一行才临时变成可编岛」。

对照：

| 对标 | 要学的 | 不学的 |
|------|--------|--------|
| **Typora** | 源码与渲染融合；跨行选；as-you-type | 整页单 textarea 的全部实现细节 |
| **Notion** | 块把手、slash、流畅感 | 无 MD 源码、私有块污染 |
| **VS Code MD 预览** | — | 左右分栏硬切换（D3 已禁） |

---

## 1. 用户问题 → 根因映射（诚实）

| # | 用户现象 | 根因（架构层，不是「少写一行 if」） |
|---|----------|-----------------------------------|
| 1 | 激活时有全行「激活感」 | 块岛 `is-active`/`is-editing` + 切行 DOM 换壳带来的**模式切换感**（即便 CSS 已禁底色，心理上仍是「进了另一模式」） |
| 2 | 渲染结果不能操作（待办一点跳源码） | idle = 只读 DOM；click → `enterEdit` 整块换成 line-source 表面，checkbox 路径被编辑岛吃掉 |
| 3 | 代码块打头不能编 / 幺蛾子 | 代码走独立 `focus-source` 分支；与文本软编、fold、lang 菜单、enter 路径交叉，状态机不统一 |
| 4 | `**demo**` 有时不变粗 | live-marks 只挂在**当前 contenteditable 岛**；换壳/多区/composition/防闪指纹导致漏刷或整段 innerHTML 闪 |
| 5 | 「有的能编有的只能看」 | 产品语义被实现成 **read 表面 vs edit 表面** 两套 HTML，不是同一文档模型上的交互 |
| 6 | 跨行选区、键盘只能行内 | **每块独立 contenteditable 岛**；浏览器 Selection 无法跨岛；块级 multi 不是字符级 range |
| 7 | Callout 顶部类型不能改 | 软编把 kind 做成 `contenteditable=false` 灰标，没有类型切换 UI |
| 8 | 公式一点乱码（截图） | 块级 math 进源码或**行内公式在段落软编时被 htmlToInlineMd 拆烂**；换壳丢失 KaTeX DOM |
| 9 | 切行乱跳、卡键 | `exitEdit`→`enterEdit` 销毁重建 + height-lock 抬高 + live-marks 整段替换 + 焦点争夺 + IME 边界 |

**总根因一句话**：

> 调度单元 = **块岛**；编辑单元 = **单块 contenteditable**；呈现 = **read/edit 两套 DOM**。  
> 这与「融合文档流」在结构上冲突。补丁只能减轻症状，不能消除跨行选区与切行跳变。

---

## 2. 否决与保留

### 2.1 否决（终局禁止再当作目标架构）

| 项 | 原决策 | 现结论 |
|----|--------|--------|
| **D2 block-per-row 换壳** | 未聚焦 readView / 聚焦 editView | **终局否决**作为融合编辑方案；仅可作只读查看器或过渡兼容层 |
| 默认 full-source monospaced 行 | 曾作为「MD 原生」 | **否决**（已部分改 soft，仍不够） |
| 激活行描边/底色 | 业余编辑器习惯 | **硬禁** BAN-01 |
| 在 `editor.js` 继续堆 5k 行 | 现实 | **否决**；新内核旁路生长 |

### 2.2 保留（仍正确）

| 项 | 说明 |
|----|------|
| Markdown / GFM + Conex 扩展为序列化真相 | 不变 |
| 扁平 `Block[]` 可作 **持久化/导出** 模型 | 可与运行时 ProseMirror doc 双向映射 |
| 无页顶格式条、slash、`/`/`、` | 不变 |
| AI 仅宿主端口 | 不变 |
| 禁 Database/CRM | 不变 |
| 代码**单表面**（不要双壳） | 语义保留，实现并入文档流 |
| 表网格编辑 | 可继续作为嵌入节点 |

---

## 3. 目标架构（推荐）

### 3.1 推荐引擎：**文档流 ProseMirror（或 TipTap 薄封装）+ MD 序列化层**

```
┌─────────────────────────────────────────────────────────┐
│  Host (Tauri / Workbench)                                │
│    MarkdownEditor.mount({ get/setMarkdown, ports… })     │
└───────────────────────────┬─────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────┐
│  Runtime: 单一 EditorView（连续可编辑文档）                │
│    · 原生跨节点 Selection（跨行/跨块字符级）               │
│    · Schema: paragraph / heading / list / code_block /   │
│      blockquote / callout / math / table / image…        │
│    · InputRules: ** * ` ~~ → marks；``` → code_block…    │
│    · NodeViews: code(高亮+可编)、math(KaTeX+源码切换)、    │
│      callout(类型下拉)、task item(checkbox 真交互)        │
│    · 插件: slash、keymap、history、drop、IME 安全         │
└───────────────────────────┬─────────────────────────────┘
                            │ parse / serialize
┌───────────────────────────▼─────────────────────────────┐
│  Persistence: Markdown 字符串  或  扁平 Block[] (导出)     │
│    现有 parse.js / serialize.js 可演进为 pm↔md 适配器      │
└─────────────────────────────────────────────────────────┘
```

**为什么不是继续自研 contenteditable 岛？**

- 跨行选区、IME、Undo、组合输入、无障碍：浏览器 + 成熟编辑内核已解决  
- 自研成本已经证明会变成 `editor.js` 上帝文件 + 无穷边角  

**为什么不是「整页一个 textarea + 侧预览」？**  
违反融合与 D3。

### 3.2 融合交互细则（产品规格冻结草案）

| 场景 | 目标行为 |
|------|----------|
| 键入 `**demo**` | 闭合后 **demo** 立即粗体；定界符按 caret 邻域灰显（ux-D2） |
| 待办 | 点击 checkbox **切换 checked**，不进入「源码块」；文字区正常 caret |
| 代码块 | 文档流中的 `code_block` 节点：默认高亮+可聚焦编辑（或点击后同节点内源码，**不换整页模式**） |
| 公式块 | 显示 KaTeX；点击 → **同节点** 源码编辑（`$$…$$` 或纯 latex）；失焦回渲染；**禁止**拆成乱码行 |
| Callout | 卡片内正文可编；**类型**用下拉/点击循环 note/tip/warning… |
| 跨行拖选 | 浏览器原生 range 跨 paragraph/list；复制为 GFM |
| 键盘 | ↑↓ 在文档流中跨块连续移动，**无** exitEdit/enterEdit 闪白 |
| 激活反馈 | **仅 caret + 可选极淡把手**；BAN-01 |

### 3.3 与现有 Block[] 的关系

- **持久化**：仍可 `getMarkdown()` / `setMarkdown()`；可选 `getDoc()` 扁平块给宿主。  
- **运行时真相**：ProseMirror `EditorState`。  
- **迁移**：写 `md ↔ pm` 与 `Block[] ↔ pm` 适配；showcase 样本 MD 继续当验收剧本。

---

## 4. 实施波次（可调度）

### Wave R0 — 止血与禁令（1–2 天）✅ 进行中

| 项 | 说明 |
|----|------|
| 落地 BAN 文件 | `BANNED-VISUAL-UX.md` |
| 清激活 chrome | CSS/类名零可见激活行 |
| 文档标明 D2 终局否决 | 本文件 + CROSSCUTTING 修订注记 |
| **停止**在旧岛模型上开「大功能」新坑 | 只修崩溃级 bug |

### Wave R1 — 内核骨架（并行于旧 demo 旁路）

| 项 | 说明 |
|----|------|
| 新建包路径 | 建议 `packages/conex-mdx` 或 `js/markdown-editor-v2/`，**不**继续膨胀 `editor.js` |
| 选型落地 | ProseMirror 核心 或 TipTap（需评估包体积与 Tauri 兼容） |
| Schema v1 | paragraph, heading 1–6, bullet/ordered/task list, blockquote, code_block, hard_break, marks(bold/italic/code/strike/link) |
| md 进出 | markdown-it / 现有 parse 改造 → pm；serialize → GFM |
| 挂载 API | 与现 `MarkdownEditor.mount` **同签名适配层**，宿主无感迁移 |

**DoD**：一页只有段落+标题+列表+粗体，**跨行选区、↑↓ 不跳、无全行激活**，键入 `**x**` 变粗。

### Wave R2 — 结构节点与融合交互

| 节点 | 行为 |
|------|------|
| code_block | NodeView：高亮 + 可编；lang 标签；复制；可选折叠 |
| callout | NodeView：类型选择器 + 标题/正文 |
| math | NodeView：KaTeX 读 / 源码编；行内 math mark 或 node |
| table | 可先嵌现有表控件或 pm-tables |
| image | 灯箱 + 上传端口 |

**DoD**：showcase SAMPLE 主路径可在 **v2 内核** 上点完；待办可勾；公式不碎；代码默认可编。

### Wave R3 — 宿主能力对齐

| 项 | 说明 |
|----|------|
| slash / command palette | 插件化，不进核心 god file |
| DnD 块把手 | pm 插件或现逻辑适配 |
| 粘贴 HTML→MD | ux-D3 |
| 多选块 / 批量删 | 可在 range + node selection 上做 |
| AI ports | 仍只宿主 complete |

### Wave R4 — 退役旧岛

| 项 | 说明 |
|----|------|
| `markdown-editor.html` 切 v2 默认 | 旧 IIFE 进 `legacy/` |
| 删 enterEdit 换壳主路径 | 或仅 viewOnly 保留 read 渲染器 |
| 测试迁移 | harness → pm 集成测 |

---

## 5. 过渡期策略（旧代码还能干什么）

在 R1–R2 完成前，旧编辑器 **只允许**：

1. 崩溃级 / 数据丢失级修复  
2. 禁令落地（激活 chrome）  
3. 文档与样本诚实标注「架构待重写」  

**明确不做**（在旧岛上）：

- 再堆「字符级跨块」完整实现（成本≈半套 PM，却仍有换壳）  
- 再发明第四种 edit surface  
- 把 callout/math/code 各加一套平行状态机却共用 enterEdit  

若业务强需临时修：

| 痛点 | 临时上限 | 终局归属 |
|------|----------|----------|
| 待办勾选 | click 捕获 checkbox，**不** enterEdit | R2 task node |
| 公式乱码 | 点 math 只 mountSource 正确 `$$`；段落内联 math 点击不拆 | R2 math node |
| 代码不能编 | 确保 code 分支必 mount source + focus | R2 code NodeView |
| callout 类型 | 灰标改为 `<select>` 改 `callout` 字段 | R2 callout NodeView |

临时补丁必须标 `// LEGACY-ISLAND: remove in R4`。

---

## 6. 风险与决策

| 风险 | 缓解 |
|------|------|
| 包体积 | 按需 tip-tap 子集 / 自建 pm schema |
| 学习成本 | 一人主写 schema+md 适配；UI NodeView 可并行 |
| 与现 harness 分叉 | R1 起双跑：旧 harness 冻结；新 e2e 用 SAMPLE 清单 |
| 进度焦虑 | R1 DoD 极窄（段落列表粗体跨行），**先证明融合**再堆节点 |

### 必须产品确认（建议直接 closed）

| ID | 议题 | 推荐 |
|----|------|------|
| **ux-D10** | 终局编辑内核 | **ProseMirror 系文档流**（否决 block-island 终局） |
| **ux-D11** | 默认是否永远「像 Typora」 | **是**；raw 整页仅调试 |
| **ux-D12** | 旧 IIFE 退役时间 | R2 showcase 通过后启动 R4 |

---

## 7. 成功判据（重写验收，替代「功能有了」）

1. **无**全行激活底色/描边（BAN-01 自动化可截图对比）。  
2. 打开 SAMPLE，**不点「进入编辑」** 即可在正文任意处落 caret 并键入。  
3. 从段中拖选到下一段 → 复制为合法 MD。  
4. `**demo**` 键入闭合 → 粗体；Backspace 边界可拆格式。  
5. 待办 checkbox 单击切换，正文仍可编。  
6. 代码块可直接改文字；复制无行号污染。  
7. 公式点击编辑再失焦 → 仍正确渲染，**无** `E=mc`/`2` 碎行。  
8. Callout 可改 tip/important 等类型。  
9. ↑↓ 跨段落连续，**无**整块闪白/跳滚。  
10. `getMarkdown()` roundtrip 稳定。

---

## 8. 下一步立即动作（调度单）

| 优先级 | 动作 | Owner 建议 |
|--------|------|------------|
| P0 | 合并 BAN 文件 + CSS 零激活 chrome + README/CROSSCUTTING 注记 D2 否决 | 本轮 |
| P0 | 写 **ux-D10 closed** 进 08-decision-log（产品口头同意即可回写） | 调度 |
| P0 | Spike：空仓库级 pm mount + md 进出 + SAMPLE 三段（1–2 天） | 实现 |
| P1 | Schema + InputRules + history + keymap | 实现 |
| P1 | NodeView：code / task / math / callout | 可并行 2–3 agent |
| P2 | 宿主 mount 适配 + 切 showcase 默认 v2 | 集成 |
| P2 | 旧代码 legacy 化 | 收尾 |

---

## 9. 对用户批评的直接回应（文档立场）

| 批评 | 回应 |
|------|------|
| 「没梳理好软件应该怎样」 | 此前规格把 **D2 块岛**当冻结，与「融合实时编辑」冲突；**本文件纠正方向** |
| 「按行肯定不行」 | **同意**；块岛换壳不作终局 |
| 「等着干什么」 | 旧模型上继续堆跨行选区 = 错误投资；R0 止血 + R1 内核并行 |
| 「渲染不能操作」 | 设计成了 read 岛；终局 = 单一可交互文档 |

---

## 10. 相关文档更新清单

- [x] `BANNED-VISUAL-UX.md`  
- [x] 本文件 `11-SYSTEMIC-REFACTOR-PLAN.md`  
- [ ] `CROSSCUTTING.md`：D2 旁注「终局由 ux-D10 取代」  
- [ ] `08-decision-log.md`：ux-D10/D11  
- [ ] `ux-readiness/README.md`：下一刀指向重写  
- [ ] `v3-complete/02-render-model.md`：页首加 superseded 警告  

---

**一句话收束**：停止用「更好的按行换壳」假装融合编辑；用 **单一文档流编辑内核 + MD 序列化 + NodeView 承载代码/公式/callout** 重做；旧 IIFE 仅维护到 v2 可演示为止。
