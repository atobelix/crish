# 08 — 决策日志（UX 就绪开放项）

> **日期**：2026-08-03  
> **用途**：集中登记「不拍板就不能安心写代码」的决策；实现 agent **只消费 status=closed** 的条目。  
> **名空间**：本文件决策 ID 写作 **ux-D1 / ux-D2 / ux-D3…**，避免与 `CROSSCUTTING.md` 的 cross-D* 混淆。  
> **权威**：关闭后的结论高于 feature-catalog 中未同步的旧表述；关闭时必须回写 [00-MASTER](./00-MASTER-READINESS.md) §4。

---

## 0. 使用约定

### 0.1 状态枚举

| status | 含义 | 实现许可 |
|--------|------|----------|
| `open` | 讨论中，仅有推荐默认 | **不得**写依赖该决策的生产路径 |
| `recommended` | 合成层已给默认，待人确认 | 可写 **spike / 特性开关后** 原型，不可删旧路径 |
| `closed` | 产品/架构已确认 | 可按结论实现并删冲突代码 |
| `conflict` | 分册 01–07 与默认冲突 | 停工该主题，升级调度 |
| `superseded` | 被更新决策替代 | 只读历史 |

### 0.2 条目模板（新增决策时复制）

```markdown
### ux-Dn — 标题
- **status**：open | recommended | closed | conflict | superseded
- **关闭门禁**：挡住哪条 U 波次
- **问题**：一句话
- **选项**：A/B/C…
- **推荐默认**：…
- **理由**：…
- **影响面**：模块 / API / 文档
- **验收挂钩**：成功判据 # / F-ID
- **确认人 / 日期**：（closed 时填）
- **备注**
```

### 0.3 当前总表

| ID | 标题 | status | 挡住 | 推荐 |
|----|------|--------|------|------|
| **ux-D1** | 多选 / 跨块选区模型 | `superseded` | — | 由 **ux-D10 文档流** 覆盖；岛上 Selection 状态机不再作为终局 |
| **ux-D2** | 行内源码（定界符）可见策略 | `recommended` | 内核 marks | **A** Caret 邻域显源（在 PM marks 上重做） |
| **ux-D3** | 粘贴 HTML / 富文本策略 | `recommended` | 内核 paste | **A** MD 优先，HTML→MD 消毒 |
| **ux-D10** | 终局编辑内核 | `closed`（产品方向 2026-08-03） | **整仓重写** | **ProseMirror 系单一文档流**；否决 block-island 换壳终局 |
| **ux-D11** | 默认交互形态 | `closed` | 同上 | **Typora 式融合实时预览**；无默认整页 raw；无全行激活 chrome |

---

## ux-D10 — 终局编辑内核（融合文档流）

- **status**：`closed`  
- **问题**：block-per-row + enterEdit 换壳无法提供跨行选区、无跳切行、全语法可编。  
- **结论**：新内核 = **单一 EditorView 文档流（ProseMirror / TipTap）** + MD 序列化 + NodeView（code/math/callout/task）。  
- **旧 IIFE**：仅维护到 v2 可演示；禁止再作为大功能主战场。  
- **规格**：[11-SYSTEMIC-REFACTOR-PLAN.md](./11-SYSTEMIC-REFACTOR-PLAN.md)  
- **禁令**：[BANNED-VISUAL-UX.md](../BANNED-VISUAL-UX.md)

## ux-D11 — 默认交互形态

- **status**：`closed`  
- **结论**：融合实时编辑；激活反馈仅 caret（+ hover 把手）；禁止全行底色/描边。

---

## 1. ux-D1 — 多选 / 跨块选区模型

- **status**：`recommended`  
- **关闭门禁**：U1 编码开工前必须 → `closed`  
- **问题**：运行时只有 `activeId: BlockId | null`（见 `editor.js` 与 catalog 01 §4.1），无法表达跨块字符选区与整块多选，导致复制/删除/格式像「玩具编辑器」。

### 1.1 选项

#### 选项 A — 扩展 Selection 状态机（**推荐**）

```ts
type BlockId = string;

type Point = { blockId: BlockId; offset: number }; // offset 为块内 grapheme/UTF 策略需另冻

type EditorSelection =
  | { kind: 'caret'; point: Point }
  | { kind: 'range'; anchor: Point; focus: Point }      // 可跨块
  | { kind: 'block-multi'; ids: BlockId[]; pivot: BlockId }; // 把手/点击多选

type EditorChromeRuntime = {
  selection: EditorSelection;
  /** 派生：当前允许键入的 line-source 块；range 拖选中可为 null */
  activeEditId: BlockId | null;
  composing: boolean;
  // ...
};
```

| 维度 | 内容 |
|------|------|
| **行为** | 拖选跨块 → `range`；Shift+把手 → `block-multi`；单击正文 → caret + 可 enter line-source |
| **与 activeId** | 旧 `activeId` **降级为派生字段** `activeEditId`，兼容期可双写 |
| **键入** | 仍保证至多一个 line-source 表面；存在非坍缩 range 时优先「选区操作」而非隐式 enter |
| **剪贴板** | range / block-multi → model 切片 → MD / plain / 可选 HTML |
| **优点** | 保住块模型与行源码；可分期；可测试 |
| **缺点** | 要实现 Point↔DOM 映射；与原生 Selection 同步成本 |
| **工期感** | U1a 块 multi + 块内 range；U1b 跨块 range |

#### 选项 B — 整文档单一 contenteditable 根

| 维度 | 内容 |
|------|------|
| **行为** | 浏览器原生跨行选区；块变成装饰 |
| **优点** | 选区「免费」 |
| **缺点** | 与 per-block line-source、表网格、代码单表面、块 DnD **剧烈冲突**；等同换引擎 |
| **结论** | **默认否决**（除非单独立项「引擎重写」） |

#### 选项 C — 仅块级 multi，不做跨块字符 range

| 维度 | 内容 |
|------|------|
| **行为** | `selectedIds: BlockId[]`；字符选仅限 `activeId` 块内 |
| **优点** | 实现快；立刻改善「多段删除/移动」 |
| **缺点** | 无法满足「从句中拖到下段句中」的 Word/Typora 预期 |
| **结论** | 允许作为 **U1a 地板**，但 **不得** 标好用完成；须承诺 U1b 升 A |

### 1.2 推荐默认

**采用选项 A，分期落地（A = C 作为地板 + 跨块 range 为 U1b）。**

分期门禁：

| 子阶段 | 必须交付 | 可宣称 |
|--------|----------|--------|
| **U1a** | `block-multi` + 单块内 `range` + 复制/删除 | 「多段块操作可用」 |
| **U1b** | 跨块 `range` + 切片序列化 | 「跨行选择好用」达标（成功判据 #1） |

### 1.3 必须同时冻结的不变量（随 D1 关闭写入 CROSSCUTTING 附录）

1. 任意时刻 ≤1 个 **可键入** line-source / focus-source-fence。  
2. `pointerdown→pointerup` 拖选过程中 **禁止** 对途经块执行 leave+拆 DOM。  
3. 选区真相在 **model 层 Selection**，DOM `window.getSelection` 仅作输入同步，不以 HTML 为真相。  
4. IME `composing===true` 时禁止改变 selection kind（可队列 pending）。  
5. 表单元格选区（既有 `table/selection`）是 **嵌套子选区**：焦点在表内时块级 range 让位；焦点出表时清除格选。  
6. 序列化到剪贴板必须可测：纯函数 `sliceDoc(doc, selection) → { md, text, html? }`。

### 1.4 影响面

| 区域 | 动作 |
|------|------|
| `editor.js` | 拆出 selection 编排；双写 activeId→activeEditId |
| 新模块 | `edit/selection/types` · `state` · `dom-map` · `commands` |
| CSS | `mdx-block--selected`、range 高亮层（非厚描边 active） |
| 测试 | harness：跨块 copy、block-multi delete、IME 中不撕选区 |
| 文档 | 02 分册算法；00 §4；catalog 01 §2.2 修订「仅一块 line-source」表述（选区可跨块） |

### 1.5 验收挂钩

- 00 成功判据 **#1、#2**  
- 01 inventory 中「跨块多选」「多行源码」两行 ≥4  
- 反例：拖选时块闪回 read 导致选区坍塌 → 否决出口  

### 1.6 确认栏

| 字段 | 值 |
|------|-----|
| 确认人 | _（待填）_ |
| 日期 | _（待填）_ |
| 最终选项 | _A 分期 / 其它_ |
| 备注 | |

---

## 2. ux-D2 — 行内源码（定界符）可见策略

- **status**：`recommended`  
- **关闭门禁**：U2 开工前 → `closed`（可与 U1 并行讨论）  
- **问题**：用户要「编辑时仍像渲染」，又要「需要时看到 `**` / `[]()`」；W4 骨架未钉死 caret 邻域 vs 整块 raw。

### 2.1 选项

#### 选项 A — Caret 邻域显源（**推荐**）

| 维度 | 内容 |
|------|------|
| **规则** | idle：全部 marks 折叠渲染。line-source：body 默认仍渲染 marks；**仅** caret 所在 run 及相邻 ±1 个 delimiter 以灰源显示 |
| **as-you-type** | 输入闭合定界符后立即 fold 为渲染；未闭合时显示源 |
| **IME** | composition 期间 **冻结** 显隐，end 后一次性 reconcile |
| **链接** | 默认显示锚文本；caret 在链内或显式「编辑链接」时显示 `[](url)` 源或气泡（气泡非 sel-bar，可后置） |
| **优点** | 最接近 Typora；满足 H3 |
| **缺点** | 实现与 runs 模型耦合；需防闪烁 |

#### 选项 B — 聚焦块内全文 marks 源码

| 维度 | 内容 |
|------|------|
| **规则** | 进入 line-source 后 body 以 raw MD 显示 |
| **优点** | 实现简单 |
| **缺点** | 「丑」「像半成品」；违背 F-CORE-02 金标准方向 |
| **结论** | 否 |

#### 选项 C — 永不显示定界符

| 维度 | 内容 |
|------|------|
| **规则** | 纯所见即所得 + 快捷键 |
| **优点** | Notion 感 |
| **缺点** | 违背「Markdown 原生」；导出惊喜 |
| **结论** | 否作默认（可做用户设置 P3） |

### 2.2 推荐默认

**选项 A。** 补充细则：

1. 定界符样式：`mdx-delim` 灰、等宽、`contenteditable=false` 或 caret 可穿透策略二选一（关闭时写死一种；推荐 **false + 成对删除 API**）。  
2. Ctrl+B / Ctrl+I 走 runs 变换，不依赖 `document.execCommand`。  
3. 与 ux-D1：range 覆盖多 mark 时，**格式命令**作用于 model 切片，不要求全部显源。

### 2.3 影响面

| 区域 | 动作 |
|------|------|
| `inline/live-marks.js` 等 | 邻域窗口算法 |
| `inline/marks-model.js` | runs 为真相 |
| CSS | delim 对比度 AA |
| 测试 | as-you-type `**` `*` `` ` `` `~~`；IME 冻结 |

### 2.4 验收挂钩

- 00 成功判据 **#4、#5**  
- F-INL-BOLD / ITALIC / STRIKE / CODE / LINK 主路径 ≥4  

### 2.5 确认栏

| 字段 | 值 |
|------|-----|
| 确认人 | _（待填）_ |
| 日期 | _（待填）_ |
| 最终选项 | _A / 其它_ |
| 备注 | **2026-08-03**：status 仍为 `recommended`；**本波实现中**（其它 agent：定界符邻域 / live-marks）。软编辑默认已落地，但 **≠** ux-D2 关闭——关闭前不得宣称行内定界符金标准。 |

---

## 3. ux-D3 — 粘贴 HTML / 富文本策略

- **status**：`recommended`  
- **关闭门禁**：U3 开工前 → `closed`  
- **问题**：从浏览器、Office、聊天工具粘贴时，要么丢结构，要么带入脏 HTML/XSS 面。

### 3.1 选项

#### 选项 A — Markdown 优先，HTML 降级消毒（**推荐**）

**优先级（高 → 低）**

1. `text/markdown` / `text/x-markdown`（若宿主提供）  
2. 内部切片标记（本编辑器 copy 时写入的自定义 MIME 或前缀，可选）  
3. `text/html` → **白名单** 转换器 → Block[] / MD（丢 style/class/on*）  
4. `text/plain` → 按空行分块；识别 GFM 前缀（`#`、`*`、` ``` `）  

| 维度 | 内容 |
|------|------|
| **表格** | HTML table → 简单 grid（无合并则扁平）；或 TSV 启发 |
| **图片** | `img[src]` → image 块或 `![]()`；`javascript:` 拒绝 |
| **优点** | 结构保留 + 安全 |
| **缺点** | 转换器要维护；复杂 HTML 有损 |

#### 选项 B — 仅 plain text

| 维度 | 内容 |
|------|------|
| **优点** | 安全、简单 |
| **缺点** | 用户从网页拷贝列表/标题全毁 |
| **结论** | 可作 viewOnly 或严格模式，**不作默认** |

#### 选项 C — 保留 HTML 片段进文档模型

| 维度 | 内容 |
|------|------|
| **结论** | **禁止**（模型与序列化爆炸；XSS 面） |

### 3.2 推荐默认

**选项 A。** 安全底线（关闭时一并冻结）：

1. 禁止：`script`、`iframe`、`object`、`form`、内联事件、`javascript:` URL。  
2. 链接默认 `rel="noopener noreferrer"`（只读渲染时）。  
3. 粘贴为 **一次** history 步（可整体 undo）。  
4. 与 ux-D1：若粘贴时存在 range/block-multi，先删选区再插入。  
5. 从本编辑器复制时，尽量同时写 plain + markdown（html 可选精简）。

### 3.3 影响面

| 区域 | 动作 |
|------|------|
| 新模块 | `edit/clipboard/paste-pipeline.js`、`html-to-blocks.js` |
| 表 | 复用 `table/clipboard-tsv` |
| 媒体 | `media/drop-paste` 对齐同一管道 |
| 测试 | 夹具 HTML 样本；XSS 负例 |

### 3.4 验收挂钩

- 00 成功判据 **#6**  
- 06 分册用例全绿  

### 3.5 确认栏

| 字段 | 值 |
|------|-----|
| 确认人 | _（待填）_ |
| 日期 | _（待填）_ |
| 最终选项 | _A / 其它_ |
| 备注 | |

---

## 4. 已关闭可继承决策（指针，不重复辩论）

下列在 `CROSSCUTTING` / catalog 已冻结，**本日志不重开**，除非用户明示：

| 继承项 | 结论 | 来源 |
|--------|------|------|
| 不做预览/源码硬切换 | 行/块级行源码 | cross-D3 |
| 扁平 Block[] + indent | 非真树 | cross-D1 |
| 无核心 sel-bar | 默认关 | catalog F-CORE-08 |
| 代码单表面禁双壳 | W2 金标准 | catalog 02 |
| 无激活行厚描边 | F-CORE-10 | catalog 01 |
| AI 仅宿主 complete | 无 mock | AI-HOST-POLICY |
| 引擎基座 v1 Vanilla | TipTap 仅后备 | cross-D11 |

若实现 agent 发现必须违反继承项 → **停工**，新开 ux-D4+，不得私改。

---

## 5. 决策关闭检查单（给人点确认）

### 5.1 关闭 ux-D1 时

- [ ] 选定 A 分期 / C 仅地板 / 其它（写明）  
- [ ] 确认 U1a / U1b 边界  
- [ ] 确认表选区嵌套规则  
- [ ] 00 §4.1 改为 closed 摘要  
- [ ] README 状态看板更新  
- [ ] （可选）CROSSCUTTING 增加「Selection」附录，编号勿与 cross-D1 冲突  

### 5.2 关闭 ux-D2 时

- [ ] 选定邻域规则（±N）  
- [ ] delim 是否 contenteditable  
- [ ] 链接编辑交互（源 vs 气泡）  
- [ ] 00 §4.2 更新  

### 5.3 关闭 ux-D3 时

- [ ] MIME 优先级确认  
- [ ] HTML 白名单附件或链接到实现文件  
- [ ] XSS 负例列表负责人  
- [ ] 00 §4.3 更新  

---

## 6. 变更记录

| 日期 | 变更 |
|------|------|
| 2026-08-03 | 初版：ux-D1/D2/D3 模板 + 推荐默认 A/A/A；继承决策指针 |
| （待填） | 用户确认关闭项 |
| （待填） | 01–07 合并若冲突 → status=conflict 说明 |

---

## 7. 给调度的一句话

**推荐默认已足够开讨论；唯一硬门禁是 ux-D1——不确认跨选模型，U1 代码必返工。**
