# 01 Core Blocks + Line Source — Feature Catalog

> **分册**：`docs/markdown-editor/feature-catalog/01-core-blocks-and-line-source.md`  
> **产品**：Conex Markdown Editor（Markdown 原生 · Notion 式块 UX · AI 端口；**不是** Notion Database CRM）  
> **权威关系**：本目录为功能与金标准权威；`../v3-complete/*` 为历史算法草稿；`js/markdown-editor/*` 为半 demo 现状，**不得反向定义产品**  
> **日期**：2026-08-02  
> **语言**：中文（UTF-8）  
> **禁止**：上帝文件；核心路径挂载 `mdx-sel-bar`；代码块双壳（高亮预览 + textarea 并列）；整页 raw MD 编辑；激活行厚描边/底色跳变

---

## 0. Scope & Non-goals

### 0.1 本册职责（必须交付的思考面）

本册冻结 **核心块** 与 **Typora 式行源码（Line Source）** 交互契约，覆盖：

1. **通用焦点/失焦契约**：未聚焦 = 精致渲染；聚焦 = 该行/段的源码结构可见（标记灰显 + 正文可编）。
2. **块类型全集（基础）**：段落、H1–H6、无序/有序/嵌套列表、任务列表、引用 + GitHub Alerts、分割线。
3. **行内 marks 基线**：粗体、斜体、删除线、下划线、高亮、行内代码、链接、标签（tag）。
4. **键盘与降级**：Enter / Shift+Enter、Backspace 降级阶梯、Tab 缩进、软换行 vs 硬换行。
5. **前缀提升**：键入 `*`+空格、`#`+空格、`>`+空格、`1.`+空格、`---` 等 → 块类型转换。
6. **Slash 插入 / 块类型转换 / 空块 placeholder**。
7. **剪贴板**：纯文本 / 富文本 / Markdown 往返。
8. **IME 中文组字**（关键路径，不可破坏）。
9. **Focus ring 政策**与**高度稳定（不跳动）**。

### 0.2 产品定位（写死）

| 维度 | Conex 选择 | 不是 |
|------|------------|------|
| 底层格式 | Markdown / GFM + 分层扩展 | 私有二进制文档为主 |
| 编辑 UX | 块级调度 + 行源码聚焦 | 整页 source-only 或整页 contenteditable 裸源 |
| 参考系 | Typora 行源 + Notion 块手感 + Obsidian Live Preview 部分 | 完整 Notion Database / 属性引擎 |
| AI | 端口（mock → 真模型） | 本册实现模型调用 |
| 选区工具条 | **默认关闭**；可选扩展 | 核心路径依赖 `mdx-sel-bar` |

### 0.3 本册非目标（明确不做 / 后置）

| 非目标 | 归属 |
|--------|------|
| 表格合并、框选、TSV、列宽 | 分册 03 |
| 代码语法高亮引擎细节、Diff、Mermaid、公式 | 分册 02（本册仅定义代码块 **行源码/单表面** 契约） |
| 图片/视频/TOC/wiki 完整 | 分册 04 |
| AI 改写、导入导出、协同 OT/CRDT | 分册 05 |
| 动效 token 全集、reduced-motion 矩阵 | 分册 06（本册只写与高度/焦点相关的稳定契约） |
| 扩展层协议全文 | 分册 07 |
| `packages/conex-mdx` 目录迁移细则 | 分册 08 |
| Database / 看板 / CRM | **永不**作为本编辑器 P0 |

### 0.4 与历史文档的冲突仲裁

| 议题 | v3-complete 旧表述 | **本册冻结（以本册为准）** |
|------|-------------------|---------------------------|
| 文本块聚焦 | focus-render：整段像渲染，`**x**` 折叠显示粗体，默认不露 `#`/`*` | **行源码**：聚焦显示结构前缀源（`##`、`*`、`1.`、`>`）+ 正文；正文内 marks 可折叠渲染 |
| 代码块 | 可 textarea，但禁双壳 | **同一卡片** contenteditable/pre 显示 **完整 fence 源**（含 ` ```lang `），禁上下双壳 |
| 选区条 | 部分文档仍写 toolbar | **核心不挂**；F-CORE-08 |
| 激活样式 | `is-active` 全行描边常见于 demo | **禁止**全行 thick border / 强底色 |

### 0.5 现状一句话（半 demo）

`js/markdown-editor/` 已有：

- `ui/line-source.js`：`toSourceLine` / `parseSourceLine` / `renderEditSurface` / `renderCodeSourceSurface` 雏形  
- `editor.js`：`enterEdit` / `exitEdit`、部分 demote、composition 监听、slash、表 chrome  
- `ui/selection-toolbar.js`：存在且可挂载（**产品上应默认禁用**）  
- 读态 `inlineHtml`、写态仍大量「半 raw / 半双路径」混用  

**判定**：行源码 **模型方向对、完成度 partial**；高度锁定、退格阶梯完备性、IME 边界、无激活描边、代码单表面金标准 **均未达标**。

### 0.6 成功判据（本册出口）

用户在中等文档（50–200 块）中连续操作时：

1. 未点任何块：全文像导出后的精致 MD 预览。  
2. 点标题：同行出现灰色 `##`（或对应级别）+ 可编辑正文，**文档不上下跳**。  
3. 点列表圆点：标记还原为 `*`（或 `-`/`+` 源），空格与正文规则符合 F-CORE-05。  
4. Backspace 在空正文时按阶梯降级，**不**突然整块消失（除非段落空且再退格合并）。  
5. 点代码块：同一卡片内出现含围栏的完整源码；**看不到**「上彩色下灰框」。  
6. 中文拼音组字全程不丢字、不跳光标、不拆块。  
7. 无默认 `mdx-sel-bar`；格式靠快捷键 / 源码 / slash。  
8. 实现落在分模块目录，**不**继续膨胀 `editor.js` 上帝文件。

---

## 1. Gold standard reference products

对照目的：借他山之石定「做到最好」；**不是**逐像素抄袭。

### 1.1 Typora（行源码黄金参照）

| 能力 | Typora 做法 | Conex 采纳 |
|------|-------------|------------|
| 未聚焦 | 实时渲染 | **采纳**：idle = 渲染 |
| 聚焦行 | 该行显示源码结构（`#`、列表标记等） | **采纳为核心** |
| 源/渲染切换 | 以行为粒度，非整页 | **采纳** |
| 代码块 | 聚焦可看 fence；高亮与源切换 | **采纳单表面完整 fence** |
| 选区格式条 | 有限 | **默认不做浮条** |
| 文件模型 | 单文件 MD | **采纳** MD 为序列化真相 |

**Conex 增强**：块把手、slash、任务勾选控件、GitHub Alerts、AI 端口；块级 DnD（他册）。

### 1.2 Obsidian Live Preview

| 能力 | Obsidian | Conex |
|------|----------|-------|
| 混合预览 | 源与渲染混排，caret 附近偏源 | 更接近 Typora「聚焦行源」 |
| `[[wiki]]` | 一等公民 | 扩展层（04），本册仅预留 inline tag/link 槽 |
| 插件 | 生态巨大 | 分层扩展（07），本册不展开 |

### 1.3 Notion

| 能力 | Notion | Conex |
|------|--------|-------|
| 块 | 一等公民、slash、DnD | **采纳块 UX** |
| 数据底层 | 私有块 JSON | **MD/GFM 可往返优先** |
| 聚焦 | 无 MD 源标记 | **叠加行源码**，不学 Notion 隐藏 `#` |
| Database | 核心卖点 | **明确非目标** |
| 空块 placeholder | 精致 | **采纳** |

### 1.4 VS Code Markdown / Markdown Preview Enhanced

| 能力 | VS Code | Conex |
|------|---------|-------|
| 编辑 | 纯源码 | 仅代码块与「查看源」特例接近 |
| 预览 | 侧栏/同步滚动 | 可选只读宿主；编辑器内联预览是主路径 |
| 快捷键 | 源码友好 | 快捷键映射需兼容 Ctrl+B 等，但视觉是块编辑器 |

### 1.5 GitHub Flavored Markdown（规范参照）

| 能力 | GFM | Conex |
|------|-----|-------|
| 任务列表 | `- [ ]` / `- [x]` | **必须往返** |
| 表格 | pipe table | 03 册 |
| 删除线 | `~~` | 行内 P0 |
| Autolink | 部分 | P1 |
| Alerts | `> [!NOTE]` 等（GitHub） | **P0 引用扩展** |

### 1.6 对照总结表

| 维度 | 金标准合成 |
|------|------------|
| 阅读 | GitHub 渲染观感 + Notion 留白与块感 |
| 编辑结构 | Typora 行源 |
| 块操作 | Notion slash / 空块 / 转换 |
| 规范 | GFM + CommonMark 子集 + Conex 分层扩展 |
| 禁止学 | Notion 隐藏所有 MD 语法导致导出惊喜；VS Code 强制双栏；半成品双壳代码框 |

---

## 2. Universal interaction contract

> 所有文本类块共享本节状态机与键盘语义。块分册 F-BLK-* 只写差异。

### 2.1 术语

| 术语 | 定义 |
|------|------|
| **Render unit** | 文档块 `blockId`；焦点调度最小单位 |
| **Idle / Read** | 未聚焦：精致渲染 DOM |
| **Line-source / Focus** | 聚焦：显示该块结构源标记 + 可编辑正文（或代码完整 fence） |
| **Structural mark** | 结构前缀：`#`×n、`*`/`-`/`+`、`1.`、`- [ ]`、`>`、fence 行 |
| **Body** | 标记之后的正文；承载 inline marks |
| **Soft mark** | 列表失焦/未点标记时显示 `·`，源仍为 `*` |
| **Hard mark** | 标记被聚焦或「显示源」时显示真实 `*` |
| **Promote** | 段落正文前缀匹配 → 升为标题/列表等 |
| **Demote** | Backspace 阶梯：正文 → gap → mark → 类型降级 → 段落 |
| **Height lock** | 进入/退出 focus 时锁定块最小高度，避免文档跳动 |
| **Composition** | IME `compositionstart`…`compositionend` 区间 |
| **Commit** | surface → model 补丁（text/runs/type/props） |
| **Leave** | focus → idle，commit + 重绘 read |

### 2.2 块 UI 状态（本册）

```
idle ──pointerenter──► hover ──pointerleave──► idle
  │                      │
  └── click/focus ───────┴──► line-source (文本类)
                              focus-source-fence (代码类，完整围栏)
                                    │
                         Esc / blur / 切块
                                    ▼
                                  idle
```

**全局不变量**

1. 任意时刻至多 **一个** 块处于 line-source 或 focus-source-fence。  
2. `viewOnly` 时禁止进入编辑态（任务勾选等只读控件除外，可配置）。  
3. line-source 时：**禁止**同时显示「另一套」整段裸 MD 与渲染双层并列（标记+正文是 **单一编辑表面内的分区**，不是双壳）。  
4. 代码 focus-source-fence 时：高亮 pre **不可见**（`display:none` 或 unmount），仅源表面可见。  
5. 切换状态 **不** 更换 `data-block-id` 根节点 id（morph 优先）。

### 2.3 Focus 进入（enterLineSource）

**触发**：pointerdown 块体（非 no-edit 控件）、键盘导航聚焦、程序 `focusBlock(id)`、slash 插入后、Enter 创建后。

**步骤（必须）**

1. 若存在旧 `activeId` 且 ≠ 新 id：`leave(old)`（commit + paint read）。  
2. `composing === true` 时 **禁止** leave 旧块到一半；等 compositionend 或取消策略见 F-CORE-09。  
3. 读取当前块模型 → `renderEditSurface` / `renderCodeSourceSurface`。  
4. **Height lock**：在替换 inner 前记录 `getBoundingClientRect().height`，设 `min-height` 为 max(旧, 新估算)。  
5. 放置 caret：  
   - 点击命中：尽量映射到对应 grapheme offset；  
   - 键盘进入：默认正文末尾（列表/标题）或源码原 caret 策略；  
   - 点在 soft bullet 上：caret 进标记交互（显示 hard `*`）或进正文首（产品默认：**点标记 → 显示源标记；点正文 → caret 在正文**）。  
6. 宣布 `aria`：`aria-label` 含块类型；live region 不刷屏。  
7. **不** 给块根加厚 border；仅 caret + 可选 1px 极淡 ring（见 F-CORE-10）。

### 2.4 Blur / Leave（leaveLineSource）

**触发**：点编辑器外、点另一块、Esc（可配置是否 blur 窗口）、宿主 `blur()`。

**步骤**

1. 若 `composing`：设 `pendingLeave=true`，**不**拆 DOM。  
2. `readFromLineEdit` / fence 解析 → `model.updateBlock`（必要时 type 变更）。  
3. paint read；释放 min-height（下一帧 rAF 双帧后再清，避免闪跳）。  
4. 清除 `activeId`；把手回 hover 策略。

### 2.5 Source ↔ Render 视觉规则

| 区域 | Idle | Line-source |
|------|------|-------------|
| 结构标记 | 不显示源字符（标题用 h1–h6 样式；列表用 bullet 圆点） | 灰色 monospaced/半透明源（`##`、`*`…） |
| 正文 | 最终渲染（含 marks） | 默认可继续渲染 marks；**定界符**在 caret 邻近可显示（as-you-type 策略见 F-INL） |
| 代码 | 高亮 pre | **整段** fence 源文本 |
| 块间距 | 稳定 | 稳定（height lock） |

### 2.6 Backspace 降级阶梯（全局算法）

适用于标题、列表、任务、引用等 **有结构标记** 的块。段落见 F-BLK-P 合并规则。

```
状态假设：caret 在 body 内

1) body 非空且 caret>0
   → 删除 body 前一 grapheme（标准）

2) body 非空且 caret==0
   → 若允许与上块合并：合并到上块末尾；否则 no-op 或按产品「不允许跨类型合并」

3) body 空且存在 gap（标记与正文间的源空格）
   → 删除 gap；标记变「将死」灰态（更淡）；仍保持类型

4) body 空且无 gap，标记仍在
   → 删除标记 / 降级类型：
      heading level>1 → level-1（## → #）
      heading level==1 → paragraph
      bullet/ordered/task → paragraph（去标记）
      quote → paragraph
      callout → quote 或 paragraph（见 F-BLK-Q）

5) 已是 paragraph 且 body 空且非文档唯一块
   → 删除块并 focus 上一块末尾

6) 文档唯一空段落
   → 保留空段落 + placeholder
```

**反模式**：空列表项一次 Backspace 直接删块且无降级动画/阶梯；或删成非法半标记残留无法序列化。

### 2.7 Enter / Shift+Enter

| 上下文 | Enter | Shift+Enter |
|--------|-------|-------------|
| 段落 | 新段落（或 soft-break 策略见 F-BRK） | 软换行 `<br>` / MD 两空格或 `\`（序列化策略统一） |
| 标题 | 退出标题 → 下方新段落（标题本身单行） | 忽略或同 Enter（标题不鼓励多行） |
| 列表项 body 非空 | 同级新列表项，继承 indent | 项内软换行 |
| 列表项 body 空 | 退出列表 → 段落 | 软换行（少用） |
| 引用 | 引用内新行（带 `>`）或空行退出 | 软换行 |
| 代码 fence 源 | 源内换行 | 源内换行（可相同） |

### 2.8 Tab / Shift+Tab

| 上下文 | Tab | Shift+Tab |
|--------|-----|-----------|
| 列表/任务 | indent+1（上限如 6） | indent-1 或退出嵌套 |
| 段落/标题 | 插入空格或 focus 下一控件（产品：**列表外 Tab 不劫持页面** 时可 insert 2 spaces / 或交给宿主） | — |
| 代码源 | 插入缩进空格/制表 | 删除行首缩进 |
| Slash 打开时 | 面板导航 | — |

### 2.9 前缀 Promote（段落内 as-you-type）

在 **paragraph** body 行首（或唯一行）检测：

| 输入完成 | 结果 |
|----------|------|
| `#` + 空格 … `######` + 空格 | heading 1–6 |
| `*` / `-` / `+` + 空格 | bullet_item |
| `1.` / `2.` … + 空格 | ordered_item |
| `- [ ]` / `* [ ]` + 可选空格 | task_item unchecked |
| `- [x]` + 空格 | task_item checked |
| `>` + 空格 | quote |
| `> [!NOTE]` 等 | callout/alert |
| `---` / `***` / `___` 独占行 | divider（替换该段） |
| `` ```lang `` 独占 | 代码块（交 02，本册契约） |
| `/` 行首 | slash 面板 |

**IME**：composition 期间 **不** promote；end 后一次性扫描。

### 2.10 Debounce 与调度

| 事件 | 策略 |
|------|------|
| input（非 composition） | 本地 DOM 立即；model commit debounce 50–100ms；history 合并 |
| promote 检测 | 空格键 path 同步；其它 input debounce ≤1 帧 |
| leave | 同步 commit |
| 高度测量 | 同步 lock；unlock 双 rAF |
| 高亮代码 read | idle 时；leave 后 requestIdleCallback 可接受 |
| 滚动锚点 | 切块时保持 visual viewport 稳定（scroll anchoring / 补偿 delta） |

### 2.11 无障碍（a11y）基线

- 标题 read 必须 `h1`–`h6`，禁止纯 div 假标题。  
- 编辑 surface：`role="textbox"` + `aria-multiline`（多行时）+ 可见 label/placeholder。  
- 结构标记 `contenteditable="false"` + `aria-hidden="true"`（装饰）或可读 `aria-label="二级标题标记"`。  
- 键盘可达：仅鼠标可编 = **不合格**。  
- 对比度：灰标记仍 ≥ WCAG AA 于背景（可偏淡但不能消失）。  
- `prefers-reduced-motion`：降级动画，逻辑不变。

---

## 3. Feature catalog

> **模板字段说明**  
> - **Priority**：P0 阻塞主路径 / P1 强体验 / P2 增强 / P3 可后置  
> - **Current status**：相对 `js/markdown-editor` 半 demo 的判定：`stub` \| `partial` \| `wrong-model` \| `missing`  
> - **做到最好**：产品金标准，不是「能跑」  
> - **Module owner**：建议路径，**禁止**堆回 `editor.js`

---

### F-CORE-01 失焦 = 渲染态（Idle Render）

- **Priority**：P0  
- **Category**：core|render  
- **Markdown baseline**：任意块序列化结果与阅读视觉一致（GFM 子集）  
- **Current status**：partial（有 `readContentHtml`，精致度与一致性不足；代码读态高亮弱）

- **做到最好 (Gold)**：  
  - 文档加载后全部块默认 idle，无「编辑中」壳、无 textarea 残留。  
  - 阅读视觉接近 GitHub/Typora 预览：标题层级、列表缩进、引用条、hr 优雅。  
  - 行内 marks 全部生效（粗斜删代码链）。  
  - 任务列表显示可点 checkbox（viewOnly 可禁用写入）。  
  - 链接可点策略：默认修饰键+点击 or 直接打开可配置，避免误进编辑。  
  - 无块显示 raw `**` 除非用户处于 line-source 且定界符策略要求。  
  - 空段落显示 placeholder，不显示「null」。  
  - 打印/只读宿主复用同一 read 渲染路径。  
  - 对比度、字体、行高使用 design tokens，不写死魔数散落。  
  - 大数据文档：只渲染视口附近可后置，但 API 预留，不阻塞正确性。  
  - 与导出 MD 往返：read 所见 ⊆ 可解释的 MD 语义（无幻影 UI 状态）。  
  - 错误块（未知 type）降级为段落或「未知块」只读卡，不白屏。

- **Acceptance criteria**：  
  - [ ] 挂载 SAMPLE 文档后 0 个 `contenteditable=true`（除宿主例外）。  
  - [ ] 标题为真实 `h1`–`h6`。  
  - [ ] `**a**` 显示粗体而非星号。  
  - [ ] 代码 idle 有 token 着色（至少 1 语言）。  
  - [ ] 任务 `[x]` 显示勾选态。  
  - [ ] 引用有左侧条或等价视觉。  
  - [ ] HR 为短/中装饰线，非 ASCII `---` 字面。  
  - [ ] viewOnly 下无 enterLineSource。  
  - [ ] 未知 type 不抛未捕获异常。  
  - [ ] 切换主题 token 后无对比度崩坏（抽检）。  
  - [ ] 序列化再 parse 后 read 视觉主路径一致。  
  - [ ] 无默认 `mdx-sel-bar` DOM。

- **Motion**：无；idle 静态。块首次挂载可 0–100ms fade（可选，06）。  
- **Data model notes**：`Block{id,type,props,text|runs,children?}`；read 优先 `runs`，无则 parse `text`。  
- **Module owner**：`render/read-view.js`、`blocks/*/read.js`  
- **Dependencies**：schema、inline renderer、code-highlight（02）  
- **Anti-patterns**：整页 `innerHTML=render(all)` 每次 input；read 用 `<pre>` 显示全文 MD；依赖选区条才能看到格式。

---

### F-CORE-02 聚焦 = 行源码态（Line Source Focus）

- **Priority**：P0  
- **Category**：core|line-source  
- **Markdown baseline**：聚焦时可见结构 token 与 GFM 源一致  
- **Current status**：partial（`renderEditSurface` 有标记灰显；与 editor 接线不完整；部分路径仍 `innerText` 裸源）

- **做到最好 (Gold)**：  
  - 点击段落：无结构标记，仅 body 编辑（可含实时 marks）。  
  - 点击标题：同行左侧灰 `##`（级别对应）+ 空格 gap + 正文；正文字体仍接近标题权重。  
  - 点击无序列表：默认 soft `·`；交互标记后 hard `*`（见 F-CORE-05）。  
  - 点击有序：显示 `1.` 或实际序号源策略（序列化可重编号）。  
  - 点击任务：显示 `- [ ]` / `- [x]` 灰标 + 正文；checkbox 与源同步。  
  - 点击引用：灰 `>` + 正文；多行时每行逻辑 `>` 或统一块引用 UI+源一致。  
  - 标记 `contenteditable=false`，caret 不拆进标记字符内部乱序。  
  - 同一时刻仅一块 line-source。  
  - Esc 离开并 commit。  
  - 程序化 focus 与点击 focus 视觉一致。  
  - 与读态切换无闪白、无整页重排。  
  - 屏幕阅读器能获知「正在编辑二级标题」。  
  - 触控：点按稳定，无 300ms 误双击放大破坏。  
  - 嵌套列表 indent 以 padding/源缩进表达，不丢层级。

- **Acceptance criteria**：  
  - [ ] H2 聚焦可见 `##` 文本节点或等价 mark span。  
  - [ ] 段落聚焦不可见假 `#`。  
  - [ ] 切块 A→B：A 回 read，B 进 line-source。  
  - [ ] Esc 后无残留 `is-editing`。  
  - [ ] 标记不可被选中删除半个 `#`（应走 demote API）。  
  - [ ] gap 空格可被 backspace 阶梯处理。  
  - [ ] 刷新 model 后 source 与 type 一致。  
  - [ ] 快速连点 10 块无抛错、无双 active。  
  - [ ] 高度与 F-CORE-03 联测通过。  
  - [ ] 无 textarea 冒充标题编辑。  
  - [ ] `data-block-id` 切换前后不变。  
  - [ ] 文档滚动位置不因 focus 跳到顶。

- **Motion**：标记 80–120ms 淡入；禁位移动画导致跳动。  
- **Data model notes**：编辑态 DOM 分区 `data-mdx-mark` / `data-mdx-gap` / `data-mdx-edit`；commit 时 mark→type/props，body→text/runs。  
- **Module owner**：`edit/line-source/`、`edit/enter-exit.js`  
- **Dependencies**：F-CORE-01、F-CORE-03、F-CORE-10、parse/serialize  
- **Anti-patterns**：聚焦整段变 raw MD 灰墙；用 input 替换块；双壳。

---

### F-CORE-03 高度锁定 / 无布局跳动（Height Stability）

- **Priority**：P0  
- **Category**：core|ux-stability  
- **Markdown baseline**：N/A（交互）  
- **Current status**：missing / wrong-model（`is-active` 边框与 edit 结构变化易导致跳）

- **做到最好 (Gold)**：  
  - enter/leave 前后，被聚焦块下方内容的 viewport 位移 ≤ 2px（测量中位）。  
  - 使用 min-height lock：`lock = max(readHeight, editHeightEstimate)`。  
  - 字体 metric：标题 read 用 h2 字号，edit 时 body 保持同字号/行高，标记绝对或 flex 不挤爆。  
  - 列表 bullet soft/hard 切换宽度用固定 slot（tabular / 固定 min-width），避免 `·`↔`*` 抖动。  
  - 禁止用厚 border 做 active（border 会改变 box 尺寸除非 box-sizing+透明占位）。  
  - 图片/代码高块 leave 后高亮异步插入不得把文档拽动（预留高度或 skeleton）。  
  - 浏览器 scroll anchoring 友好：不在视口上方插入不可预期节点。  
  - ResizeObserver 可选校准，防字体加载后二次跳。  
  - 自动化：playwright 截 diff y 坐标。  
  - 快速上下键穿越多块仍稳定。

- **Acceptance criteria**：  
  - [ ] 标题 enter/leave 下方段落 y 变化 ≤2px。  
  - [ ] 列表 soft/hard 标记切换宽度 slot 固定。  
  - [ ] active 样式不增加 border-width（或始终透明 border 占位）。  
  - [ ] 代码块 enter 完整 fence 后卡片宽度不把页面横跳。  
  - [ ] 中文 IME 组字不改变块高异常抖动（换行除外）。  
  - [ ] 空段落 placeholder 显隐不改行高。  
  - [ ] 双 rAF unlock min-height 无闪烁。  
  - [ ] 10 次连续 focus 往返无累计漂移。  
  - [ ] `scrollTop` 在 enter 时不被重置为 0。  
  - [ ] 视口上方块异步高亮不拖动下方 caret 块。  
  - [ ] reduced-motion 下仍满足位移阈值。  
  - [ ] 文档有测量注释或测试用例名 `height-stability`。

- **Motion**：禁止高度相关 spring；仅 opacity。  
- **Data model notes**：runtime `heightLockPx?: number` 挂 chrome state，不入序列化。  
- **Module owner**：`edit/height-lock.js`、`css/markdown-editor/focus-stability.css`  
- **Dependencies**：enter-exit、各 block edit surface  
- **Anti-patterns**：靠 margin 切换；read/edit 字号差 4px+；用 outline 4px 当 focus。

---

### F-CORE-04 Backspace 降级阶梯（Demotion Ladder）

- **Priority**：P0  
- **Category**：core|keyboard  
- **Markdown baseline**：降级结果可序列化为合法 GFM  
- **Current status**：partial（editor 有 demote reason；阶梯不全、与 line-source 标记未完全统一）

- **做到最好 (Gold)**：  
  - 严格按 §2.6 阶梯，用户可预测。  
  - 标题：空正文连续 Backspace → 去 gap → 降 level → 变段落（保留曾有文本则合并规则清晰）。  
  - 列表：空项 Backspace → 变段落同 indent 或 indent 清零（写死一种并文档化；推荐 **变段落 indent=0**）。  
  - 有序/任务与无序对称。  
  - 引用空 Backspace → 段落。  
  - 不在 composition 中 demote。  
  - 每次 demote 可撤销（undo 栈）。  
  - 视觉：标记将死态更淡 + 微缩放（可选）。  
  - 与上块合并时 caret 落在正确 offset（含 marks）。  
  - 跨块合并保留 inline marks。  
  - 合法边界：文档首块空段落 Backspace no-op。  
  - 代码块：源内 Backspace 不走到标题 demote；fence 删空策略见 02。  
  - 分割线：Backspace 删块 → 段落。  
  - 无「半个标记」非法 block 残留。

- **Acceptance criteria**：  
  - [ ] H3 空正文 3 次 Backspace 路径：gap→H2→H1→P（或等价文档化阶梯）可测。  
  - [ ] 空 bullet → paragraph。  
  - [ ] 空 task → paragraph，checked 状态丢弃合理。  
  - [ ] 合并上段后 undo 恢复两块。  
  - [ ] composition 中 Backspace 只影响组字。  
  - [ ] 首块空 P Backspace 仍保留一块。  
  - [ ] demote 后序列化无残留 `#` 正文。  
  - [ ] 列表 indent>0 空项 Shift+Tab 与 Backspace 行为不冲突（有文档）。  
  - [ ] 自动化用例 ≥8。  
  - [ ] 读屏可感知类型变化（可选 polite live）。  
  - [ ] 快速连按不崩。  
  - [ ] 与 F-CORE-05 列表标记状态机兼容。

- **Motion**：标记淡出 80ms；类型变更可 cross-fade 文本样式。  
- **Data model notes**：`edit/backspace-demote.js` 纯函数 `demote(block, caret) → Patch`。  
- **Module owner**：`edit/backspace-demote.js`  
- **Dependencies**：line-source read、model history  
- **Anti-patterns**：keydown 里巨石 if-else 复制多份；直接 `outerHTML=''`。

---

### F-CORE-05 列表 `*` + 空格与标记显隐

- **Priority**：P0  
- **Category**：list|line-source  
- **Markdown baseline**：`* ` / `- ` / `+ ` 均识别；默认序列化 `*` 或 `-`（二选一写死，推荐 `-` 或 `*` 可配置，**往返不丢**）  
- **Current status**：partial（line-source soft `·` + data-src；promote 接线不完整）

- **做到最好 (Gold)**：  
  - 段落键入 `*` 立刻显示 `*` 字符。  
  - 再键入空格：promote 为 bullet；`*` 变为 soft 圆点 `·`（或保持源至 leave——**本产品：promote 后 soft ·，聚焦标记 hard \***）。  
  - caret 在正文时标记为 soft ·。  
  - 点击/焦点到标记 slot：显示 hard `*`，可 Backspace 删标记走 demote。  
  - `-`/`+` 同源策略；序列化统一风格可配置 `bulletMarker`。  
  - 嵌套：行首 2 spaces 或 Tab → indent。  
  - 连续项 Enter 创建同级；空项 Enter 退出。  
  - 与任务列表前缀冲突：`- [` 优先 task 规则。  
  - 中文 IME 后空格 promote 正确。  
  - 粘贴 `* item` 多行 → 多 bullet。  
  - 只读态仅圆点，无 `*` 闪烁。  
  - 固定标记列宽，防跳（F-CORE-03）。

- **Acceptance criteria**：  
  - [ ] `*`+Space 成 bullet。  
  - [ ] `-`+Space 成 bullet。  
  - [ ] soft · 在 body 聚焦时显示。  
  - [ ] 聚焦标记显示 `*`。  
  - [ ] `*[` 不成错误 task。  
  - [ ] `- [ ] ` 成 task 而非 bullet。  
  - [ ] 序列化稳定 marker。  
  - [ ] indent 2 级视觉与 MD 往返。  
  - [ ] IME「星」后空格不误触发（仅 ASCII `*`）。  
  - [ ] undo promote 恢复段落含 `* `。  
  - [ ] 宽度 slot 稳定。  
  - [ ] 无序列表与有序互转 slash 可用。

- **Motion**：·↔* cross-fade 极短。  
- **Data model notes**：`bullet_item{indent,text,runs}`；marker 可放 props 或全局 serialize 选项。  
- **Module owner**：`blocks/list/`、`edit/promote-prefix.js`  
- **Dependencies**：F-CORE-02/04、F-BLK-UL  
- **Anti-patterns**：用 Unicode bullet 写入 MD 文件；soft 圆点被序列化进 MD。

---

### F-CORE-06 代码块单表面完整围栏源

- **Priority**：P0  
- **Category**：code|line-source  
- **Markdown baseline**：GFM fenced code `` ```lang \n … \n ``` ``  
- **Current status**：partial / wrong-model（存在 textarea 路径与 line-source `renderCodeSourceSurface` 雏形；读态高亮弱；易双壳）

- **做到最好 (Gold)**：  
  - **Idle**：语法高亮渲染；lang 标签可显示；复制按钮不进编辑。  
  - **Focus**：同一卡片内 **仅** 源码表面；内容 = 完整 fence（首行 `` ```ts `` + body + 尾 `` ``` ``）。  
  - **禁止**：上方高亮 + 下方 textarea 同时可见。  
  - **禁止**：聚焦后只给 body 不给 fence（除非高级「仅内容模式」且默认关闭）。  
  - 编辑 lang：改首行 fence 即可，leave 时 parse lang。  
  - Tab 在源内缩进。  
  - 等宽字体、行号可选（P1）。  
  - leave 后重新高亮，高度 lock。  
  - 空代码块 placeholder：`` ```\n\n``` ``。  
  - 长代码：块内滚动，不撑破编辑器无限制（max-height 可配）。  
  - 复制按钮复制 **内容** 不含围栏；选区复制可含围栏（焦点在源时按选区）。  
  - 与 02 册高亮引擎对接，本册只锁交互契约。

- **Acceptance criteria**：  
  - [ ] idle 可见高亮（至少 js/ts/py/md 之一）。  
  - [ ] focus 后 DOM 无双层可见预览+输入。  
  - [ ] focus 文本包含开头 ``` 。  
  - [ ] 修改 lang 后 leave 读态 lang 更新。  
  - [ ] Esc leave 高亮恢复。  
  - [ ] composition 在代码中不损坏（英文为主仍测）。  
  - [ ] 复制按钮不含 fence。  
  - [ ] height lock 联测。  
  - [ ] 不会出现原生 textarea 默认外观（若用 textarea 必须 skin 成单表面且仍禁双壳）。  
  - [ ] parse 残缺 fence 有容错。  
  - [ ] undo 恢复 text+lang。  
  - [ ] 与 slash「代码块」插入后自动 focus 源。

- **Motion**：高亮↔源 cross-fade ≤150ms，互斥可见。  
- **Data model notes**：`code{lang,text}`；源解析 `parseSourceLine` fence。  
- **Module owner**：`blocks/code/`、`edit/code-source.js`、`ui/code-highlight.js`  
- **Dependencies**：F-CORE-03、02 册高亮  
- **Anti-patterns**：双壳；focus 只用 textarea 且外挂第二预览；lang 单独 input 造成二次壳（lang 可 toolbar 但预览层仍互斥）。

---

### F-CORE-07 表格保持网格（本册边界说明）

- **Priority**：P0（能力在 03，本册只约束 **不要** 用整表 raw MD 当默认编辑）  
- **Category**：table|boundary  
- **Markdown baseline**：GFM table  
- **Current status**：partial（有 table-chrome；无合并；易误走源码整表）

- **做到最好 (Gold)**：  
  - 默认永远网格编辑，不是聚焦变整表 MD。  
  - 格内可 line-source **行内**内容（marks），不是整表 fence。  
  - 本册验收仅：**不存在**「点表 → 整表变 pipe source」作为唯一路径。  
  - 细节交给 03。

- **Acceptance criteria**：  
  - [ ] 点击单元格进入单元格编辑而非整表 raw。  
  - [ ] 序列化仍为 GFM pipe。  
  - [ ] 与 F-CORE-02 不冲突（表块状态机独立）。  
  - [ ] 文档注明详见 03。  
  - [ ] 无双壳表。  
  - [ ] 空表可编辑。  
  - [ ] 键盘导航不落到整表源模式。  
  - [ ] viewOnly 网格只读。  
  - [ ] 与 DnD 块拖拽句柄不抢单元格选区（基线）。  
  - [ ] 回归：SAMPLE 含表可点。

- **Motion**：见 03/06  
- **Data model notes**：table 二维 cells；非 line-source 文本块  
- **Module owner**：`blocks/table/`、`ui/table-chrome.js`  
- **Dependencies**：03 册  
- **Anti-patterns**：`enterEdit(table)` → `innerText = markdownTable`。

---

### F-CORE-08 无核心选区工具条（No Selection Toolbar）

- **Priority**：P0  
- **Category**：core|policy  
- **Markdown baseline**：格式由 MD 源与快捷键表达  
- **Current status**：wrong-model（存在 `ui/selection-toolbar.js` / `mdx-sel-bar`）

- **做到最好 (Gold)**：  
  - 默认构建 **不** 挂载 sel-bar。  
  - 粗体/斜体：Ctrl/Cmd+B/I 与 as-you-type `**` `*`。  
  - 链接：Ctrl+K 或键入 `[]()` / slash。  
  - 可选扩展 `extensions/selection-toolbar` 默认 off。  
  - 文档与 showcase 不展示为「主 UI」。  
  - 移除 demo 中强制调用。  
  - 可访问性不依赖悬浮条。  
  - 触控长按不弹出自研条（可用系统/扩展）。  
  - 与 Notion 差异明确写进产品说明。  
  - 代码审查黑名单：核心 package 不得 import sel-bar。

- **Acceptance criteria**：  
  - [ ] 默认 demo 无 `.mdx-sel-bar`。  
  - [ ] 选中文本不自动出条。  
  - [ ] Ctrl+B 仍可用。  
  - [ ] slash 可插链接。  
  - [ ] 扩展开启后才出现条。  
  - [ ] 核心 bundle 可 tree-shake 掉 toolbar。  
  - [ ] README 声明默认无条。  
  - [ ] 无 execCommand 依赖作为唯一路径。  
  - [ ] 回归截图无条。  
  - [ ] a11y 快捷键表文档化。

- **Motion**：N/A  
- **Data model notes**：N/A  
- **Module owner**：`extensions/selection-toolbar/`（可选）；核心 `edit/keymap.js`  
- **Dependencies**：F-INL-*  
- **Anti-patterns**：editor.js 强制 createToolbar；用条掩盖行源码缺失。

---

### F-CORE-09 IME 中文组字（Composition Safety）

- **Priority**：P0  
- **Category**：core|ime  
- **Markdown baseline**：N/A  
- **Current status**：partial（有 compositionstart/end 监听；promote/demote/leave 边界未全挡）

- **做到最好 (Gold)**：  
  - `compositionstart` → `composing=true`；一切 promote、mark fold、leave、整块 morph、debounce commit **暂停**。  
  - `compositionend` → 提交一次；处理 pendingLeave/pendingPromote。  
  - 拼音中间态下划线不被 `inlineHtml` 重渲清掉。  
  - 组字中禁止 `innerHTML` 赋值。  
  - 中文后空格再 promote（如英文 `*` 已存在）。  
  - Safari / Chrome / Edge / 微信内置浏览器抽检。  
  - 日文/韩文同样遵守（通用 composition）。  
  - 候选窗不导致滚动跳动。  
  - 组字中点另一块：pendingLeave 或取消组字策略写死（推荐：**等 end 再 leave**，或 blur 强制 end）。  
  - 自动化：模拟 composition 事件套件。  
  - 文档写清「IME 神圣」原则给所有 agent。

- **Acceptance criteria**：  
  - [ ] 组字中 input 不触发 parseSourceLine promote。  
  - [ ] 组字中 leave 不发生（或安全策略测试固定）。  
  - [ ] 组字中 Backspace 不 demote 块类型。  
  - [ ] end 后「你好」完整。  
  - [ ] end 后 `**你好**` 可折叠。  
  - [ ] 无控制台错误。  
  - [ ] 列表项中组字稳定。  
  - [ ] 标题中组字稳定。  
  - [ ] 代码源中组字不打散 fence。  
  - [ ] 快速 start/end 不丢 pending。  
  - [ ] 双 rAF 重渲不在 composing 中。  
  - [ ] 文档含 IME 测试步骤（人工）。

- **Motion**：无  
- **Data model notes**：runtime `composing:boolean`；`pendingLeave?: BlockId`  
- **Module owner**：`edit/ime-guard.js`  
- **Dependencies**：enter-exit、promote、demote、inline fold  
- **Anti-patterns**：input 防抖里直接 innerHTML；compositionend 前 updateBlock 换 type。

---

### F-CORE-10 Focus ring 政策（无丑陋全行描边）

- **Priority**：P0  
- **Category**：core|visual  
- **Markdown baseline**：N/A  
- **Current status**：wrong-model（`is-active` 常配整行高亮/描边）

- **做到最好 (Gold)**：  
  - **禁止** 激活块全宽 2px+ 实线边框包围。  
  - **禁止** 激活块强背景填充（如整行灰蓝底）。  
  - 允许：caret；极淡左侧 2px 指示（opacity≤0.35）；块把手显现。  
  - 键盘 focus-visible 可有 outline，但 outline-offset 不挤布局；优先 `outline` 在 gutter。  
  - 与 height lock 兼容：任何 ring 用 box-shadow inset 或伪元素不占 layout。  
  - hover 与 active 区分：hover 只显把手。  
  - 暗色/亮色 token 分离。  
  - 对比 Notion「几乎无框」与 Typora「无块框」。  
  - 截图验收列入 UI review。  
  - 代码块 focus 时卡片边框可轻微，但 **不要** 再套一层编辑框。

- **Acceptance criteria**：  
  - [ ] 激活段落 computed border-width 上下左右为 0 或透明占位恒定。  
  - [ ] 无整行 background 突变 > 4% 亮度（主观+工具）。  
  - [ ] 把手 hover 可见。  
  - [ ] 键盘导航 focus-visible 可辨。  
  - [ ] 不导致 F-CORE-03 失败。  
  - [ ] CSS 无 `.is-active{border:1px solid}` 之类。  
  - [ ] 代码块无双框。  
  - [ ] 高对比主题仍可辨 caret。  
  - [ ] 文档含 before/after 说明。  
  - [ ] showcase 不宣传「选中行高亮条」为特色。

- **Motion**：把手 opacity 120ms。  
- **Data model notes**：N/A  
- **Module owner**：`css/markdown-editor/focus.css`  
- **Dependencies**：F-CORE-03  
- **Anti-patterns**：`outline: 2px solid blue` 包整行；用 margin 假缩进当 focus。

---

### F-BLK-P 段落（Paragraph）

- **Priority**：P0  
- **Category**：paragraph  
- **Markdown baseline**：CommonMark paragraph；空行分段  
- **Current status**：partial

- **做到最好 (Gold)**：  
  - idle：舒适行高、链接与 marks 正确。  
  - focus：无结构标记；placeholder「输入正文，或键入 / 插入块…」。  
  - 空段不崩、可点。  
  - 多段之间间距稳定。  
  - 软换行 vs 硬分段见 F-BRK。  
  - 粘贴纯文本智能分段。  
  - 与上段合并 Backspace 在段首。  
  - 段首 promote 全表见 §2.9。  
  - 极长段落性能可接受（1 万字输入不卡死主线程 >50ms/key 需优化）。  
  - 选区跨段：浏览器默认 + 块模型后续增强（P1）。  
  - 拖拽把手可拖整段（04/他册）。  
  - 只读复用。

- **Acceptance criteria**：  
  - [ ] 空文档 1 空段 placeholder。  
  - [ ] Enter 新段。  
  - [ ] 段首 Backspace 合并。  
  - [ ] `/` 打开 slash。  
  - [ ] `**x**` 可生效（F-INL）。  
  - [ ] promote 标题/列表。  
  - [ ] 序列化空段策略（吞/留）文档化且测试。  
  - [ ] 粘贴两段文本产生两块或含硬换行策略一致。  
  - [ ] undo 粒度可接受。  
  - [ ] 无默认 sel-bar。  
  - [ ] a11y textbox。  
  - [ ] IME 安全。

- **Motion**：新段插入微位移可选。  
- **Data model notes**：`paragraph{text,runs?}`  
- **Module owner**：`blocks/paragraph/`  
- **Dependencies**：F-CORE-*、F-BRK、F-INL、F-SLASH  
- **Anti-patterns**：段落用 `<h1>` 样式；空段直接删到 0 块。

---

### F-BLK-H 标题 H1–H6

- **Priority**：P0（H1–H3）；P1（H4–H6 同等实现但 TOC 权重低）  
- **Category**：heading  
- **Markdown baseline**：ATX `#{1,6} `；不写 Setext  
- **Current status**：partial

- **做到最好 (Gold)**：  
  - idle：语义 `h1`–`h6`，字号阶梯优雅，可锚点 `id`。  
  - focus：灰 `######` 级标记 + gap + 正文；正文字重接近标题。  
  - 单行：Enter → 下方新段落。  
  - Backspace 阶梯降 level。  
  - slash「标题 1…6」转换保留正文。  
  - 从段落 `# ` promote。  
  - 不允许空格缺失的 `#Title` 误伤（可容忍解析但 promote 需空格）。  
  - TOC 他册消费 heading 大纲。  
  - 关闭文档级多 h1 警告可选。  
  - marks：允许粗斜代码链；避免颜色 mark 过度。  
  - 粘贴 `# Title` 成 heading 块。  
  - 与折叠标题（toggle）后置 P2。

- **Acceptance criteria**：  
  - [ ] H1–H6 聚焦标记 `#` 数量正确。  
  - [ ] demote H2→H1→P。  
  - [ ] Enter 后新段落。  
  - [ ] 序列化 ATX。  
  - [ ] read 用真实 heading 标签。  
  - [ ] slash 转换保留 text。  
  - [ ] promote `# ` 空格规则。  
  - [ ] 锚点 id 稳定可测。  
  - [ ] 字号阶梯 CSS token。  
  - [ ] height lock。  
  - [ ] IME。  
  - [ ] 无整行 active 底。

- **Motion**：level 变更字号 transition ≤120ms 且 height lock。  
- **Data model notes**：`heading{level:1-6,text,runs?}`  
- **Module owner**：`blocks/heading/`  
- **Dependencies**：F-CORE-02/04、serialize  
- **Anti-patterns**：全部 `div.mdx-h1`；focus 显示 `## 标题` 整段 raw 含正文星号墙。

---

### F-BLK-UL 无序列表（含嵌套）

- **Priority**：P0  
- **Category**：list  
- **Markdown baseline**：`*`/`-`/`+` + 缩进嵌套  
- **Current status**：partial

- **做到最好 (Gold)**：  
  - 多级嵌套视觉缩进清晰（推荐 1.25em/级）。  
  - Enter 续项；空项 Enter 退出。  
  - Tab / Shift+Tab 调整 indent。  
  - 与 F-CORE-05 标记显隐一致。  
  - 子列表序列化缩进 2 spaces。  
  - 从中间 Backspace 合并项文本。  
  - 与有序/任务互转。  
  - 粘贴多行 `* a\n* b`。  
  - 嵌套上限（如 6）有反馈。  
  - 选中多项批量缩进 P1。  
  - 列表项内软换行保持 marker 不重复。  
  - 只读圆点精致。  
  - DnD 调序他册，本册不拦。

- **Acceptance criteria**：  
  - [ ] 三级嵌套往返 MD。  
  - [ ] Tab 增加 indent。  
  - [ ] 空项 Enter → 段落。  
  - [ ] soft/hard 标记。  
  - [ ] 序列化无 Unicode `•`。  
  - [ ] promote/demote。  
  - [ ] 合并项。  
  - [ ] IME。  
  - [ ] height slot。  
  - [ ] slash 插入。  
  - [ ] 与 task 前缀不冲突。  
  - [ ] undo。

- **Motion**：indent 变化 padding transition 可选。  
- **Data model notes**：`bullet_item{indent,text,runs}` 扁平兄弟+indent 或树；**选一种**写死（推荐扁平+indent 易 MD）。  
- **Module owner**：`blocks/list/bullet.ts` 或 `blocks/list/`  
- **Dependencies**：F-CORE-05、F-BLK-OL、F-BLK-TASK  
- **Anti-patterns**：用原生 `<ul contenteditable>` 整表编辑导致浏览器列表地狱。

---

### F-BLK-OL 有序列表

- **Priority**：P0  
- **Category**：list  
- **Markdown baseline**：`1. ` 形式；显示序号与源可分离  
- **Current status**：partial

- **做到最好 (Gold)**：  
  - idle 显示正确递增序号（同层重排）。  
  - focus 标记显示 `1.` 或实际数字（推荐显示 **重排后序号**，序列化可统一 `1.` 以减 diff，**配置项** `orderedSerialize: 'always-1' | 'display-n'`）。  
  - Enter/Tab 同 UL。  
  - 嵌套有序/无序混合。  
  - 删除中间项后重编号视觉立即正确。  
  - promote `1. `–`99. `。  
  - 与 UL 转换保留 text。  
  - 大列表 200 项重编号 ≤16ms。  
  - 自定义起始序号 P2（HTML ol start；MD 有限）。  
  - 零宽问题与 marker slot 宽度按最大位数预留（两位数列表不抖）。

- **Acceptance criteria**：  
  - [ ] 三项显示 1.2.3。  
  - [ ] 删第 2 项后变 1.2。  
  - [ ] focus 标记可见。  
  - [ ] 序列化策略测试锁定。  
  - [ ] 嵌套。  
  - [ ] Tab indent。  
  - [ ] 空项退出。  
  - [ ] promote。  
  - [ ] 与 bullet 互转。  
  - [ ] height 稳定（序号 9→10 宽度）。  
  - [ ] IME。  
  - [ ] undo 重编号正确。

- **Motion**：序号变更 cross-fade 可选。  
- **Data model notes**：`ordered_item{indent,text,runs}`；display index 派生。  
- **Module owner**：`blocks/list/ordered/`  
- **Dependencies**：F-BLK-UL  
- **Anti-patterns**：把显示序号写死进 text 字段导致双份真相。

---

### F-BLK-TASK 任务列表

- **Priority**：P0  
- **Category**：task  
- **Markdown baseline**：GFM `- [ ]` / `- [x]`  
- **Current status**：partial

- **做到最好 (Gold)**：  
  - idle：精致 checkbox + 文本；checked 删除线可选 token。  
  - 点击 checkbox **不**强制进 line-source（toggle 立即序列化）。  
  - focus 文本：源标记 `- [ ]` 灰显 + body。  
  - 空格在 checkbox 可 toggle（a11y）。  
  - Enter 续 task；空退出。  
  - 与 bullet 互转丢/留 checked 规则写死。  
  - 动画勾选 06 册，本册要有状态正确。  
  - 只读可禁用 toggle。  
  - 嵌套 task。  
  - 粘贴 GFM 任务多行。  
  - 不要用 emoji ✅ 代替 checkbox 除非主题。  
  - 键盘：在标记上 Space toggle。

- **Acceptance criteria**：  
  - [ ] toggle 改变 checked 且序列化 `[x]`。  
  - [ ] 点 box 不丢失光标到错误块。  
  - [ ] focus 显示 `- [ ]` 源。  
  - [ ] Enter 新 task。  
  - [ ] 空 Backspace → 段落。  
  - [ ] a11y checkbox role。  
  - [ ] viewOnly 不可 toggle（配置）。  
  - [ ] 嵌套 indent。  
  - [ ] undo toggle。  
  - [ ] IME 在 body。  
  - [ ] 与 `- [ ]` promote。  
  - [ ] 无双重点击进编辑误 toggle 两次（防抖）。

- **Motion**：勾选弹跳极轻（06）。  
- **Data model notes**：`task_item{indent,checked,text,runs}`  
- **Module owner**：`blocks/task/`  
- **Dependencies**：F-BLK-UL、F-CORE-04  
- **Anti-patterns**：checked 只改 class 不改 model；序列化丢状态。

---

### F-BLK-Q 引用 + GitHub Alerts

- **Priority**：P0  
- **Category**：quote  
- **Markdown baseline**：`>`；Alerts：`> [!NOTE]` `TIP` `IMPORTANT` `WARNING` `CAUTION`  
- **Current status**：partial（callout parse 有雏形）

- **做到最好 (Gold)**：  
  - idle quote：左侧条 + 衬文色。  
  - idle alert：图标+语义色（NOTE 蓝 / WARNING 黄等 token）。  
  - focus：灰 `>`；alert 首行可显示 `[!NOTE]` 源。  
  - 多行引用：Enter 继续 `>`；空行退出。  
  - slash 插入各 alert。  
  - 从段落 `> ` promote。  
  - 序列化标准 GH。  
  - 嵌套引用 P1。  
  - 内含列表 P1。  
  - 颜色不仅靠色：图标+标题文本。  
  - 暗色主题可读。  
  - 未知 ` [!FOO] ` 降级 quote 或 generic callout。

- **Acceptance criteria**：  
  - [ ] `>` promote。  
  - [ ] NOTE/WARNING 渲染差异。  
  - [ ] 序列化往返 kind。  
  - [ ] focus 可见 `>`。  
  - [ ] 空 Backspace → 段落。  
  - [ ] slash。  
  - [ ] 图标 a11y 有文本替代。  
  - [ ] 无整行丑陋边框（可用左侧条）。  
  - [ ] IME。  
  - [ ] height lock。  
  - [ ] 正文 marks。  
  - [ ] 错误 kind 不白屏。

- **Motion**：无强制。  
- **Data model notes**：`quote{text}`；`callout{callout:kind,text}` 或 `quote{alert?:kind}`——**选一种 schema 写死**（现状 callout 分离可保留）。  
- **Module owner**：`blocks/quote/`、`blocks/callout/`  
- **Dependencies**：line-source、serialize  
- **Anti-patterns**：alert 只改颜色无序列化；focus 整块 raw 多行 `>` 墙无编辑分区。

---

### F-BLK-HR 分割线

- **Priority**：P0  
- **Category**：hr  
- **Markdown baseline**：`---` / `***` / `___` 独占行  
- **Current status**：partial

- **做到最好 (Gold)**：  
  - idle：精致细线，最大宽度受限，居中或全宽 token。  
  - 不 focus 成文本（atom 块）：点击选中块，Backspace 删除变空段或删块。  
  - 段落输入 `---` + Enter 转换。  
  - slash 插入。  
  - 不与 Setext 下划线标题冲突（不支持 Setext 写入）。  
  - 选中态用把手/极淡 ring，非厚框。  
  - 序列化统一 `---`。  
  - 连续多 HR 允许。  
  - 打印可见。  
  - 触摸可点选。

- **Acceptance criteria**：  
  - [ ] `---` Enter 成 HR。  
  - [ ] 序列化 `---`。  
  - [ ] Backspace 删除。  
  - [ ] slash。  
  - [ ] 非 contenteditable 文本。  
  - [ ] 视觉非 ASCII 三个破折号字面。  
  - [ ] 与列表 `---` 误触规则（独占行）。  
  - [ ] undo。  
  - [ ] 键盘可 focus 块并删除。  
  - [ ] 无双击进入 raw `---` 编辑（除非强制源模式扩展）。

- **Motion**：插入淡入。  
- **Data model notes**：`divider` atom，无 text 或忽略 text  
- **Module owner**：`blocks/divider/`  
- **Dependencies**：promote-prefix  
- **Anti-patterns**：HR 当空段落边框伪造成；可编辑 `---` 字符。

---

### F-INL-BOLD 粗体

- **Priority**：P0  
- **Category**：inline  
- **Markdown baseline**：`**bold**` 或 `__bold__`（序列化偏好 `**`）  
- **Current status**：partial（read `inlineHtml`；无完备 as-you-type；依赖 toolbar/execCommand 风险）

- **做到最好 (Gold)**：  
  - 输入闭合 `**` 后内容变粗，定界符折叠（caret 邻近可显）。  
  - Ctrl/Cmd+B 切换 mark（基于 runs，非 execCommand）。  
  - 跨标点规则合理。  
  - 与斜体嵌套 `***` 可解析。  
  - 序列化稳定。  
  - line-source 下仍可见效果。  
  - 撤销正确。  
  - 中文无空格边界仍可加粗。  
  - 选区加粗不吞邻接空格。  
  - 代码 span 内不加粗。

- **Acceptance criteria**：  
  - [ ] `**a**` 显示粗体。  
  - [ ] Ctrl+B。  
  - [ ] 序列化 `**`。  
  - [ ] undo。  
  - [ ] 嵌套 italic。  
  - [ ] composition 安全。  
  - [ ] 无 sel-bar 依赖。  
  - [ ] runs 模型优先。  
  - [ ] 代码 span 不受影响。  
  - [ ] 往返 parse。

- **Motion**：折叠定界符 opacity。  
- **Data model notes**：`runs[{text,marks:['bold']}]`  
- **Module owner**：`inline/marks/bold`、`inline/fold-md.js`  
- **Dependencies**：F-CORE-09、keymap  
- **Anti-patterns**：`document.execCommand('bold')` 作为主路径。

---

### F-INL-ITALIC 斜体

- **Priority**：P0  
- **Category**：inline  
- **Markdown baseline**：`*italic*` / `_italic_`（注意与列表 `*` 冲突：仅非行首或已闭合规则）  
- **Current status**：partial

- **做到最好 (Gold)**：  
  - 同粗体级体验。  
  - 行首 `* ` 优先列表 promote，不进斜体。  
  - Ctrl+I。  
  - 序列化偏好 `*` 或 `_` 可配，默认 `*`。  
  - 中文斜体字体回退可读（部分字体无 italic → 轻度倾斜 transform 慎用，优先 font-style）。  
  - 与 bold 组合。  
  - 不在 word 中部误触发规则可测。  
  - leave 后 read 正确。  
  - 粘贴 HTML `<em>` 转 mark。  
  - a11y 不单靠视觉。

- **Acceptance criteria**：  
  - [ ] `*a*` 斜体（非列表上下文）。  
  - [ ] 行首 `* ` → 列表。  
  - [ ] Ctrl+I。  
  - [ ] 与 bold。  
  - [ ] 序列化。  
  - [ ] IME。  
  - [ ] 无 execCommand 必需。  
  - [ ] 往返。  
  - [ ] undo。  
  - [ ] 代码 span 内忽略。

- **Motion**：同 bold  
- **Data model notes**：mark `italic`  
- **Module owner**：`inline/marks/italic`  
- **Dependencies**：F-CORE-05 行首规则  
- **Anti-patterns**：全局看见 `*` 就斜体。

---

### F-INL-STRIKE 删除线

- **Priority**：P0  
- **Category**：inline  
- **Markdown baseline**：GFM `~~del~~`  
- **Current status**：partial / missing as-you-type

- **做到最好 (Gold)**：  
  - 闭合即生效。  
  - 快捷键 Ctrl+Shift+X（可配）。  
  - 任务完成态样式与 strike mark 可区分（不要强制共用）。  
  - 序列化 `~~`。  
  - 嵌套其他 marks。  
  - 清晰视觉。  
  - undo。  
  - 粘贴。  
  - 与搜索高亮不冲突。  
  - 测试往返。

- **Acceptance criteria**：  
  - [ ] `~~a~~` 删除线。  
  - [ ] 快捷键。  
  - [ ] 序列化。  
  - [ ] 嵌套 bold。  
  - [ ] IME。  
  - [ ] undo。  
  - [ ] 往返。  
  - [ ] 无 toolbar 依赖。  
  - [ ] 代码 span 忽略。  
  - [ ] leave/read 一致。

- **Motion**：同 marks  
- **Data model notes**：`strike`  
- **Module owner**：`inline/marks/strike`  
- **Dependencies**：inline pipeline  
- **Anti-patterns**：用 CSS 全段 text-decoration 冒充单字 strike。

---

### F-INL-ULINE 下划线

- **Priority**：P1  
- **Category**：inline  
- **Markdown baseline**：非标准 GFM；Conex 扩展可用 `<u>` 或 `++`（**写死一种**，推荐 HTML `<u>` 在 MD 中受限接受，或扩展 `++text++`）  
- **Current status**：missing / stub

- **做到最好 (Gold)**：  
  - 扩展层声明（07）。  
  - 快捷键 Ctrl+U。  
  - 与链接下划线视觉区分（链接用主题色）。  
  - 序列化策略明确，GitHub 预览可降级。  
  - 可关闭扩展。  
  - as-you-type 若用 `++`。  
  - a11y 不只靠颜色。  
  - 不影响导出严格 GFM 模式（条带化选项）。  
  - 测试。  
  - 文档警告非通用 MD。

- **Acceptance criteria**：  
  - [ ] Ctrl+U 生效。  
  - [ ] 序列化策略测试。  
  - [ ] 严格 GFM 导出可剥除。  
  - [ ] 与 link 可辨。  
  - [ ] 扩展可关。  
  - [ ] undo。  
  - [ ] IME。  
  - [ ] 无 sel-bar 依赖。  
  - [ ] read/edit 一致。  
  - [ ] 文档声明。

- **Motion**：同 marks  
- **Data model notes**：mark `underline`  
- **Module owner**：`inline/marks/underline` + extensions  
- **Dependencies**：07 扩展模型  
- **Anti-patterns**：当 GFM 核心谎称全平台支持。

---

### F-INL-MARK 高亮

- **Priority**：P1  
- **Category**：inline  
- **Markdown baseline**：扩展 `==highlight==`（Obsidian 风）或 `<mark>`  
- **Current status**：missing

- **做到最好 (Gold)**：  
  - `==a==` 高亮。  
  - 主题色 token，暗色可读。  
  - 严格导出可剥除或转 HTML。  
  - 快捷键可选。  
  - 与搜索命中高亮分层 z/类名。  
  - slash 无必需。  
  - 嵌套 marks。  
  - IME。  
  - 性能：大段高亮不卡。  
  - 文档化。

- **Acceptance criteria**：  
  - [ ] `==a==` 渲染。  
  - [ ] 往返。  
  - [ ] 暗色对比。  
  - [ ] 剥除选项。  
  - [ ] IME。  
  - [ ] undo。  
  - [ ] 与 selection 可辨。  
  - [ ] 扩展可关。  
  - [ ] 无双渲染。  
  - [ ] 测试。

- **Motion**：无  
- **Data model notes**：`highlight`  
- **Module owner**：`inline/marks/highlight`  
- **Dependencies**：07  
- **Anti-patterns**：用浏览器 Find 高亮冒充。

---

### F-INL-CODE 行内代码

- **Priority**：P0  
- **Category**：inline  
- **Markdown baseline**：`` `code` ``  
- **Current status**：partial

- **做到最好 (Gold)**：  
  - 闭合 backtick 生效；等宽+底色 token。  
  - 内部不解析其他 marks。  
  - 可含 `*` 等字符。  
  - 双反引号边界边缘用例。  
  - 快捷键 Ctrl+E 可选。  
  - 序列化正确转义。  
  - 与代码块区别清晰。  
  - 换行策略：行内代码尽量单行。  
  - 粘贴。  
  - IME 少见但安全。

- **Acceptance criteria**：  
  - [ ] `` `a` `` 样式。  
  - [ ] 内部 `*` 不斜体。  
  - [ ] 序列化。  
  - [ ] 往返。  
  - [ ] undo。  
  - [ ] 与 fenced 块区分。  
  - [ ] leave/read。  
  - [ ] 无 toolbar 依赖。  
  - [ ] 空 `` `` 处理。  
  - [ ] 测试边界双 backtick。

- **Motion**：无  
- **Data model notes**：mark `code`  
- **Module owner**：`inline/marks/code`  
- **Dependencies**：inline pipeline  
- **Anti-patterns**：行内代码用块级 pre。

---

### F-INL-LINK 链接

- **Priority**：P0  
- **Category**：inline  
- **Markdown baseline**：`[text](url)` 标题可选  
- **Current status**：partial

- **做到最好 (Gold)**：  
  - 渲染可点；编辑不丢 url。  
  - 键入完整 md 链即折叠为链。  
  - Ctrl+K 设置链接（**迷你 popover 可**，非 sel-bar 整条）。  
  - 自动识别 URL 可选 P1。  
  - 相对/绝对/锚点。  
  - 危险 javascript: 过滤。  
  - tooltip 显示 url。  
  - 修改 text 保留 href。  
  - 序列化转义。  
  - 图链 `![alt](src)` 归 04，本册不混。  
  - 键盘可编辑链接属性。

- **Acceptance criteria**：  
  - [ ] `[a](https://b.com)` 往返。  
  - [ ] Ctrl+K。  
  - [ ] 危险协议剥离。  
  - [ ] focus 不丢 href。  
  - [ ] 点击策略可配。  
  - [ ] tooltip。  
  - [ ] undo。  
  - [ ] IME 于 text。  
  - [ ] 无 sel-bar。  
  - [ ] 空 url 处理。  
  - [ ] 空格 url 编码策略。  
  - [ ] 测试。

- **Motion**：popover 06  
- **Data model notes**：mark `link{href,title?}`  
- **Module owner**：`inline/marks/link`、`ui/link-popover.js`  
- **Dependencies**：keymap、sanitize  
- **Anti-patterns**：链接只存文本丢 href；用 window.prompt 简陋唯一方案可暂存但非金标准。

---

### F-INL-TAG 标签（Tag）

- **Priority**：P1  
- **Category**：inline  
- **Markdown baseline**：扩展 `#tag` 或 `#tag/`；非 GFM 核心  
- **Current status**：missing / stub（产品有 InlineTag 组件于 composer，编辑器未闭环）

- **做到最好 (Gold)**：  
  - 输入 `#标签` 完成后 chip 化（空格/标点结束）。  
  - 与标题 `# ` 行首规则冲突：仅行首+空格为 heading；词中 `#tag` 为标签。  
  - 点击 tag 搜索/过滤为宿主端口。  
  - 序列化策略：保留 `#tag` 明文。  
  - 可删除 chip。  
  - 自动补全 P2。  
  - 严格 GFM 模式仍明文。  
  - 中文 tag 支持。  
  - a11y。  
  - 与 wiki `[[` 区分（04）。

- **Acceptance criteria**：  
  - [ ] 词中 `#abc` chip。  
  - [ ] 行首 `# ` 标题。  
  - [ ] 序列化明文。  
  - [ ] 删除。  
  - [ ] 宿主 click 回调。  
  - [ ] 中文。  
  - [ ] IME（# 后中文）。  
  - [ ] 不误伤。  
  - [ ] 扩展可关。  
  - [ ] 测试。

- **Motion**：chip 生成微缩放。  
- **Data model notes**：mark `tag{name}` 或 inline node  
- **Module owner**：`inline/marks/tag`  
- **Dependencies**：promote 行首规则、宿主 port  
- **Anti-patterns**：所有 `#` 变 tag。

---

### F-BRK 软换行 vs 硬换行 / Enter 策略

- **Priority**：P0  
- **Category**：paragraph|keyboard  
- **Markdown baseline**：两空格+`\n` 或 `\`+`\n` 软换行；空行分段  
- **Current status**：partial / 未统一

- **做到最好 (Gold)**：  
  - **Enter**：块级硬分（新块）— 段落/列表策略见上。  
  - **Shift+Enter**：块内软换行，序列化统一为 `  \n` 或 `\\\n`（**写死一种**，推荐 two-space）。  
  - read 显示 `<br>`。  
  - 不产生意外空块。  
  - 与中文输入法 Enter 上屏不冲突（composition 中 Enter 交给 IME）。  
  - 复制到纯文本保留换行。  
  - 粘贴多行策略：多段落 vs 软换行启发式（单换行软？双换行段？——推荐 **双换行分段，单换行软/或段** 写死）。  
  - 标题禁止软换行或转义为 space。  
  - 代码块 Enter 仅源内 `\n`。  
  - 文档+测试锁定。

- **Acceptance criteria**：  
  - [ ] Shift+Enter → 软换行可见。  
  - [ ] 序列化格式锁定。  
  - [ ] Enter 新段。  
  - [ ] composition Enter 不上屏拆块。  
  - [ ] 粘贴启发式测试。  
  - [ ] 标题 Enter 新段。  
  - [ ] 列表 Enter 新项。  
  - [ ] 代码 Enter 源内。  
  - [ ] 往返。  
  - [ ] 复制纯文本。  
  - [ ] undo。  
  - [ ] 文档说明。

- **Motion**：无  
- **Data model notes**：text 内 `\n`；块边界为数组分割  
- **Module owner**：`edit/keymap-enter.js`、`serialize/breaks.js`  
- **Dependencies**：F-CORE-09、各块  
- **Anti-patterns**：Enter 行为每块复制粘贴不一致且无表。

---

### F-KEY-TAB Tab 缩进

- **Priority**：P0  
- **Category**：keyboard|list  
- **Markdown baseline**：列表嵌套缩进  
- **Current status**：partial

- **做到最好 (Gold)**：  
  - 列表/任务：Tab indent+1；Shift+Tab-1。  
  - 到 0 再 Shift+Tab：变段落或保持（写死：变段落更 Notion）。  
  - 代码源：插入 2 spaces（可配）。  
  - 非列表段落：不抢走浏览器焦点循环——`editor` 内 Tab 插空格或 focus 下一块可配，默认 **插 2 spaces** 或 **忽略** 需写死（推荐列表外 **不拦截** 除非 code）。  
  - slash 打开时 Tab 走面板。  
  - 可访问性：提供快捷键替代。  
  - 多选块缩进 P1。  
  - 与 demote 不打架。  
  - 可视化缩进导轨可选 P2。  
  - 测试。

- **Acceptance criteria**：  
  - [ ] 列表 Tab 嵌套。  
  - [ ] Shift+Tab 反嵌套。  
  - [ ] 代码缩进。  
  - [ ] slash 面板优先。  
  - [ ] 段落策略符合文档。  
  - [ ] 上限 indent。  
  - [ ] undo。  
  - [ ] 序列化 spaces。  
  - [ ] 不丢 text。  
  - [ ] IME 无关。  
  - [ ] 与任务列表。  
  - [ ] 自动化。

- **Motion**：padding transition 可选  
- **Data model notes**：`indent` int  
- **Module owner**：`edit/keymap-tab.js`  
- **Dependencies**：list blocks  
- **Anti-patterns**：Tab 永远 preventDefault 破坏无障碍。

---

### F-SLASH Slash 插入

- **Priority**：P0  
- **Category**：slash|insert  
- **Markdown baseline**：N/A → 插入块再序列化  
- **Current status**：partial

- **做到最好 (Gold)**：  
  - 行首 `/` 或空段 `/` 打开面板。  
  - 模糊搜索中英文。  
  - 键盘上下+Enter。  
  - 插入后 focus 正确块。  
  - 替换掉 `/query`。  
  - 分类：基础块 / 媒体 / 高级。  
  - 空状态「无匹配」。  
  - Esc 关闭恢复 `/` 或删除可配。  
  - 不与行内 `/` 路径冲突（仅行首）。  
  - 性能：列表本地。  
  - a11y listbox。  
  - 与 registry 驱动（非写死 editor 巨石）。  
  - 插代码/标题/列表/引用/hr/task 全覆盖本册。  
  - 触控可点。

- **Acceptance criteria**：  
  - [ ] `/` 打开。  
  - [ ] 过滤「标题」。  
  - [ ] Enter 插入 H1。  
  - [ ] 插入代码 focus fence。  
  - [ ] Esc 关闭。  
  - [ ] 非行首不打开。  
  - [ ] registry 词条。  
  - [ ] a11y。  
  - [ ] 不出现在 viewOnly。  
  - [ ] 中文搜索。  
  - [ ] 插入 undo。  
  - [ ] 面板定位不遮 caret 致命（可翻）。

- **Motion**：面板 scale/fade 06  
- **Data model notes**：commands registry  
- **Module owner**：`ui/slash-menu/`、`registry.js`  
- **Dependencies**：blocks、F-CORE-02  
- **Anti-patterns**：slash 逻辑写在 editor.js 200 行；硬编码重复 schema。

---

### F-CONV 块类型转换

- **Priority**：P0  
- **Category**：block|convert  
- **Markdown baseline**：转换后序列化变目标 type  
- **Current status**：partial

- **做到最好 (Gold)**：  
  - slash「转为…」或命令：P↔H↔列表↔引用等。  
  - **保留正文 runs**。  
  - 丢失 props 有规则（heading level 默认 1；task checked false）。  
  - 转换后 line-source 标记立即正确。  
  - height lock。  
  - undo。  
  - 多块转换 P1。  
  - atom HR → 转段落变空。  
  - 代码 ↔ 段落：代码转段可保留 text 丢 lang；段转码进 fence。  
  - 不经 raw 整页。  
  - 快捷键映射表（ux/keyboard-map）。  
  - 测试矩阵 type×type。

- **Acceptance criteria**：  
  - [ ] P→H2 保留 text。  
  - [ ] H→bullet。  
  - [ ] bullet→task。  
  - [ ] quote→P。  
  - [ ] code→P。  
  - [ ] P→code。  
  - [ ] undo。  
  - [ ] runs 保留 bold。  
  - [ ] 标记 UI 正确。  
  - [ ] 高度稳定。  
  - [ ] 序列化 type 正确。  
  - [ ] 矩阵测试 ≥10 对。

- **Motion**：样式 cross-fade  
- **Data model notes**：`convertBlock(id, toType, props?)`  
- **Module owner**：`edit/convert.js`、`blocks/*/transform.js`  
- **Dependencies**：schema、line-source  
- **Anti-patterns**：转换靠序列化整篇再 parse。

---

### F-PH 空块 Placeholder

- **Priority**：P0  
- **Category**：ux  
- **Markdown baseline**：N/A  
- **Current status**：partial（有 data-placeholder）

- **做到最好 (Gold)**：  
  - 空段/空标题/空列表不同文案。  
  - 仅 focus 或始终淡显可配，默认 focus 显。  
  - 不进入序列化。  
  - 不占复制内容。  
  - 多语言宿主可注入。  
  - 与 `/` 提示结合。  
  - 对比度 AA。  
  - 不导致高度跳。  
  - 伪元素实现优先，不影响 DOM 文本。  
  - 只读无 placeholder 或「空」。

- **Acceptance criteria**：  
  - [ ] 空段 focus 见提示。  
  - [ ] 输入后消失。  
  - [ ] 不进 MD。  
  - [ ] 复制空。  
  - [ ] 标题/列表文案不同。  
  - [ ] 高度稳定。  
  - [ ] 可配置文案。  
  - [ ] viewOnly 策略。  
  - [ ] a11y 不把 placeholder 当内容读两次（注意）。  
  - [ ] CSS 伪元素。

- **Motion**：opacity  
- **Data model notes**：无  
- **Module owner**：`css/.../placeholder.css` + 各 block placeholder 字符串模块  
- **Dependencies**：F-CORE-03  
- **Anti-patterns**：placeholder 真文本塞进 model。

---

### F-CLIP 剪贴板（纯文本 / 富文本 / MD）

- **Priority**：P0  
- **Category**：clipboard  
- **Markdown baseline**：复制优先 MD；粘贴智能  
- **Current status**：partial / missing 多格式

- **做到最好 (Gold)**：  
  - **复制块/选区**：`text/plain` 为 MD 源；`text/html` 为语义 HTML。  
  - **粘贴 plain**：按断行启发式变块。  
  - **粘贴 html**（来自 Word/浏览器）：清洗后转 runs/blocks，剥脚本。  
  - **粘贴 MD**：识别标题列表代码。  
  - 单格表粘贴归 03。  
  - 安全：无 script、无 on*。  
  - 大粘贴：进度/分片防卡死 P1。  
  - 与系统撤销栈协同。  
  - 代码块内粘贴保持字面。  
  - 不从复制丢 marks。  
  - 测试 fixtures。  
  - 中文编码。

- **Acceptance criteria**：  
  - [ ] 复制段落得 MD。  
  - [ ] 复制含 bold 的 HTML 含 strong。  
  - [ ] 粘贴 `## x` 成标题。  
  - [ ] 粘贴 `* a` 成列表。  
  - [ ] 粘贴 HTML bold 成 mark。  
  - [ ] 危险 HTML 被洗。  
  - [ ] 代码块内字面。  
  - [ ] undo 整贴。  
  - [ ] 不崩超长 100KB 文本（可截断策略）。  
  - [ ] 无双份粘贴（浏览器默认+自处理）。  
  - [ ] IME 无关。  
  - [ ] 文档说明格式优先级。

- **Motion**：无  
- **Data model notes**：clipboard pipeline 纯函数  
- **Module owner**：`edit/clipboard/`（`from-plain.js`/`from-html.js`/`to-md.js`）  
- **Dependencies**：parse、sanitize、blocks  
- **Anti-patterns**：只 `e.preventDefault` 后 `insertText` 丢结构；上帝文件一个 paste 2000 行。

---

### F-IME-DOC （文档化 + 回归套件，从属于 F-CORE-09）

- **Priority**：P0  
- **Category**：ime|process  
- **Markdown baseline**：N/A  
- **Current status**：missing 完备文档

- **做到最好 (Gold)**：  
  - 本仓 `ux/ime-checklist.md` 或本册附录人工步骤。  
  - 每 PR 改 enter/leave/promote 必须跑 IME 套件。  
  - CI 模拟 composition 事件。  
  - 失败即挡 W1 出口。  
  - 列出已知浏览器差异。  
  - 录屏附件可选。  
  - agent 指南引用「IME 神圣」。  
  - 与 F-CORE-09 验收交叉。  
  - 中文/日文各 1 例。  
  - 列表/标题/段落/代码四面。

- **Acceptance criteria**：  
  - [ ] 清单文件存在。  
  - [ ] CI 含 composition mock。  
  - [ ] 四面场景。  
  - [ ] 与 demote 交叉。  
  - [ ] 与 promote 交叉。  
  - [ ] leave pending。  
  - [ ] 浏览器矩阵表。  
  - [ ] agent briefing 链接。  
  - [ ] W1 出口勾选。  
  - [ ] 无已知 P0 泄漏。

- **Motion**：N/A  
- **Data model notes**：N/A  
- **Module owner**：`tests/markdown-editor/ime/`、docs  
- **Dependencies**：F-CORE-09  
- **Anti-patterns**：口口相传「在我机器上中文没事」。

---

### F-A11Y-FOCUS Focus 与键盘可达（汇总项）

- **Priority**：P0  
- **Category**：a11y  
- **Markdown baseline**：N/A  
- **Current status**：partial

- **做到最好 (Gold)**：  
  - 全部主路径键盘可完成：移动、编辑、插入、转换、删除。  
  - roving tabindex 或原生 focus 流清晰。  
  - 跳过链接可选。  
  - 读屏块类型公告不刷屏。  
  - 对比度。  
  - 焦点管理 leave 后落到合理处。  
  - 无键盘陷阱（slash 除外 Esc 可出）。  
  - 与 F-CORE-10 一致。  
  - 文档 keyboard-map 同步。  
  - 自动化 axe 抽检 P1。

- **Acceptance criteria**：  
  - [ ] 仅键盘完成插入标题写字离开。  
  - [ ] slash Esc 退出。  
  - [ ] 无全行刺眼 focus。  
  - [ ] checkbox 可空格。  
  - [ ] 读屏标签。  
  - [ ] 陷阱检测。  
  - [ ] token 对比。  
  - [ ] keyboard-map 有本册键。  
  - [ ] viewOnly Tab 不进编辑。  
  - [ ] 文档。

- **Motion**：N/A  
- **Module owner**：`edit/focus-manager.js`、docs/ux/keyboard-map.md  
- **Dependencies**：F-CORE-10、slash  
- **Anti-patterns**：只做鼠标 demo。

---

### F-MOD-LINE 行源码数据模块契约

- **Priority**：P0  
- **Category**：architecture  
- **Markdown baseline**：toSource/parseSource 对称  
- **Current status**：partial（`ui/line-source.js`）

- **做到最好 (Gold)**：  
  - 纯函数：`toSourceLine(block)` / `parseSourceLine(raw)` / `renderEditSurface` / `readFromLineEdit`。  
  - 单测覆盖每块类型。  
  - 不操作全局 editor 状态。  
  - 可迁 `edit/line-source/`。  
  - TypeScript 类型预留。  
  - 错误输入返回 null/paragraph 降级。  
  - 与 serialize 全文可对齐差异文档化（行 vs 文档级）。  
  - 无 DOM 泄漏在 parse。  
  - 版本化快照测试。  
  - 禁止从 editor 反向复制逻辑分叉。

- **Acceptance criteria**：  
  - [ ] 每块 roundtrip 单测。  
  - [ ] 无 window 必需（可注入 esc）。  
  - [ ] 与 editor 接线单一。  
  - [ ] 代码 fence roundtrip。  
  - [ ] callout roundtrip。  
  - [ ] 非法输入不抛。  
  - [ ] 文件行数可控拆分。  
  - [ ] 无上帝依赖。  
  - [ ] 导出索引。  
  - [ ] 文档 API。

- **Motion**：N/A  
- **Module owner**：`edit/line-source/*`  
- **Dependencies**：schema  
- **Anti-patterns**：parse 逻辑在 editor keydown 再写一份。

---

### F-MOD-OWNER 无上帝文件（实现约束项）

- **Priority**：P0  
- **Category**：architecture  
- **Markdown baseline**：N/A  
- **Current status**：wrong-model（`editor.js` 过重）

- **做到最好 (Gold)**：  
  - 遵守 `v3-complete/11-no-god-file-charter` 与分册 08。  
  - 新逻辑按目录：  
    - `edit/line-source/`  
    - `edit/backspace-demote.js`  
    - `edit/promote-prefix.js`  
    - `edit/enter-exit.js`  
    - `edit/ime-guard.js`  
    - `edit/height-lock.js`  
    - `edit/keymap-*.js`  
    - `edit/clipboard/`  
    - `blocks/paragraph|heading|list|task|quote|callout|divider|code/`  
    - `inline/`  
    - `render/read-view.js`  
    - `ui/slash-menu/`  
  - `editor-controller.js` 只编排。  
  - 单文件业务逻辑建议 <400 行。  
  - PR 检查拒绝再堆 editor.js。  
  - 测试按模块放。  
  - 多 agent 所有权清晰。  
  - 可选 eslint 边界。  
  - demo HTML 无巨石脚本。  
  - 迁移 TS 时路径同构。

- **Acceptance criteria**：  
  - [ ] 本册功能不新增 editor.js 百行级逻辑。  
  - [ ] 目录存在或规划在 08。  
  - [ ] charter 链接。  
  - [ ] code owner 表。  
  - [ ] review 清单。  
  - [ ] 无 sel-bar 进核心。  
  - [ ] 无双壳代码。  
  - [ ] 模块单测可独立跑。  
  - [ ] 文档 module owner 字段齐全（本册）。  
  - [ ] W1 实现按模块拆 agent。

- **Motion**：N/A  
- **Module owner**：`08-package-modules.md` + charter  
- **Dependencies**：全体  
- **Anti-patterns**：「先写进 editor 以后再拆」。

---

## 4. Cross-feature state machine summary

### 4.1 全局运行时

```ts
interface EditorChromeRuntime {
  activeId: BlockId | null;
  ui: Map<BlockId, 'idle' | 'hover' | 'line-source' | 'focus-source-fence' | 'viewOnly'>;
  composing: boolean;
  pendingLeave: boolean;
  heightLocks: Map<BlockId, number>;
  slashOpen: boolean;
  viewOnly: boolean;
}
```

### 4.2 事件优先级（高 → 低）

1. **composition***（最高，阻断 promote/leave/morph）  
2. **slash 键盘**（打开时）  
3. **IME 安全的 keymap**：Enter/Backspace/Tab  
4. **input** promote 检测  
5. **pointer** 切块  
6. **debounce commit**  
7. **idle 高亮/懒渲染**

### 4.3 块类型 × 焦点模式

| type | idle | focus |
|------|------|-------|
| paragraph | 渲染 runs | line-source body only |
| heading | hN | marks `##` + body |
| bullet_item | · + text | soft/hard * + body |
| ordered_item | n. + text | `n.` + body |
| task_item | checkbox + text | `- [ ]` + body；box 可独立 toggle |
| quote | 条 + text | `>` + body |
| callout | 语义卡 | `>` + `[!KIND]` 源策略 |
| divider | 线 | atom 选中，非文本源 |
| code | 高亮 | **完整 fence 源单表面** |
| table | 网格 | 格内编辑（03），非整表源 |

### 4.4 Backspace 决策树（简图）

```
composing? → 原生组字处理
caret in code fence? → 源内删除 / 空 fence 策略
caret in body offset>0? → 删字符
offset==0 && canMergePrev? → 合并
body empty && has gap? → 删 gap
body empty && has structural mark? → demote type/level
else empty paragraph? → delete block (not last)
else → no-op
```

### 4.5 Enter 决策树（简图）

```
composing? → IME
slashOpen? → 确认项
code fence? → 插入 \n
heading? → 新 paragraph 下方
list/task empty? → 退出为 paragraph
list/task non-empty? → 新 item
quote empty line rule? → 退出 or 新行
paragraph? → 新 paragraph
divider selected? → 下方新 paragraph
```

### 4.6 与历史 v3 五态映射

| v3 | 本册 |
|----|------|
| idle | idle |
| hover | hover |
| focus-render | **line-source**（结构源可见；正文 marks 仍渲染） |
| focus-source | **focus-source-fence**（代码） |
| viewOnly | viewOnly |

---

## 5. Implementation waves（仅规划，无代码）

> 对齐 `00-master-index.md`；本册相关波次细化。

### 5.1 W0 — 规格冻结（本文件）

- 完成 F-ID 金标准与验收。  
- 与 06（高度/动效）、02（代码高亮引擎）、08（目录）交叉链接。  
- **出口**：用户确认清单，不写业务大改。

### 5.2 W1 — 行源码模型 + 防跳

**目标 F-ID**：F-CORE-01…05, 08…10, F-BLK-P/H/UL/OL/TASK/Q/HR, F-BRK, F-KEY-TAB, F-MOD-*  

**Agent 拆分建议（≤12）**

| Agent | 所有权 |
|-------|--------|
| A1 enter-exit + height-lock | `edit/enter-exit.js`, `edit/height-lock.js` |
| A2 line-source 纯函数强化 | `edit/line-source/*` |
| A3 demote | `edit/backspace-demote.js` |
| A4 promote | `edit/promote-prefix.js` |
| A5 ime-guard | `edit/ime-guard.js` |
| A6 blocks heading/paragraph | `blocks/heading`, `blocks/paragraph` |
| A7 blocks list/task | `blocks/list`, `blocks/task` |
| A8 quote/callout/hr | `blocks/quote`, `callout`, `divider` |
| A9 keymap enter/tab | `edit/keymap-*.js` |
| A10 css focus + placeholder | `css/markdown-editor/*` |
| A11 禁用 sel-bar 默认 | 接线 + 扩展搬家 |
| A12 tests roundtrip+ime+height | `tests/markdown-editor/` |

**出口**：P0 金标准评分 ≥4；无 0–2。

### 5.3 W2 — 代码单表面（与 02 册）

- F-CORE-06 为主；高亮引擎 02。  
- 不穿插表格花活。

### 5.4 W4 — 行内 marks 实时

- F-INL-* P0 全过；去掉 execCommand。  
- 可与 W1 尾重叠但 **不得** 在 line-source 未稳时做。

### 5.5 W5 — 列表/标题降级完备

- F-CORE-04/05 边界矩阵；嵌套；undo。  
- 与 W1 差异：W1 主路径，W5 杀边界。

### 5.6 明确不做穿插

- 表合并、AI、Mermaid、协同、选区条美化 —— 禁止插入 W1。

### 5.7 风险

| 风险 | 缓解 |
|------|------|
| contenteditable 选区丢失 | 不整块 innerHTML；分 mark/body |
| IME 回归 | 强制套件 |
| 高度抖 | 固定 slot + lock + 禁 border |
| editor.js 继续膨胀 | charter + PR 拒 |
| 与 v3 focus-render 文档冲突 | 以本目录仲裁 |

---

## 6. Open questions

### 6.1 产品决策（需用户拍板）

| # | 问题 | 选项 | 默认建议 |
|---|------|------|----------|
| Q1 | 有序序列化 `always-1` 还是 `display-n`？ | A/B | **always-1** 减 diff |
| Q2 | 无序 marker 统一 `*` 还是 `-`？ | A/B | `-`（GFM 任务一致）或保持输入原样 |
| Q3 | 软换行序列化 two-space 还是 backslash？ | A/B | two-space |
| Q4 | 段落 Tab：不拦截 / 插空格 / 下一块？ | A/B/C | **不拦截**（列表/code 除外） |
| Q5 | 空列表 Backspace：直接段落 indent0 还是先减 indent？ | A/B | 先减 indent 更安全？或 Notion 式直接段——**需选** |
| Q6 | 下划线/高亮扩展默认开？ | on/off | 高亮 off 或 on；下划线 off |
| Q7 | 链接点击：直接开还是修饰键？ | A/B | 修饰键+点击，防误触 |
| Q8 | 代码 focus 是否允许「仅内容、隐藏 fence」高级模式？ | yes/no | **默认 no**（总是完整 fence） |
| Q9 | alert 用独立 `callout` type 还是 `quote.alert`？ | A/B | 保持现状 `callout` 分离 |
| Q10 | 块数据扁平 indent vs 真树 children？ | flat/tree | **flat+indent** 易 MD |

### 6.2 技术债确认

- `editor.js` 拆除顺序：先抽 enter-exit / ime / demote，还是先 blocks？  
- `selection-toolbar.js` 删除 vs 搬迁 extensions？  
- height 测量是否用 ResizeObserver 常开？  
- runs 与 `block.text` 双写一致性协议（以 10-data-format 为准再冻结）。

### 6.3 跨册依赖

- 代码高亮 token 稳定性 → 02  
- 表不走整表源 → 03 确认  
- tag 宿主搜索 port → 04/composer  
- 动效时长 token → 06  
- 扩展剥除严格 GFM → 07  
- 包路径最终名 → 08  

### 6.4 验收工具缺口

- height ≤2px 的自动化是否进 CI？  
- IME 真机是否强制人工签字？  
- 视觉回归基线平台？

### 6.5 明确非问题（已关闭）

| 议题 | 决议 |
|------|------|
| 是否做 Notion Database | **否** |
| 核心是否挂 sel-bar | **否** |
| 代码是否允许双壳 | **否** |
| 行源码是否为本产品核心 | **是** |
| 是否继续小步只改 CSS 冒充完成 | **否**；整波能力面交付 |

---

## 附录 A — F-ID 速查表

| F-ID | 名称 | P |
|------|------|---|
| F-CORE-01 | 失焦渲染 | P0 |
| F-CORE-02 | 聚焦行源码 | P0 |
| F-CORE-03 | 高度稳定 | P0 |
| F-CORE-04 | Backspace 降级 | P0 |
| F-CORE-05 | 列表 * 与 soft/hard | P0 |
| F-CORE-06 | 代码单表面 fence | P0 |
| F-CORE-07 | 表保持网格（边界） | P0 |
| F-CORE-08 | 无核心 sel-bar | P0 |
| F-CORE-09 | IME | P0 |
| F-CORE-10 | Focus ring 政策 | P0 |
| F-BLK-P | 段落 | P0 |
| F-BLK-H | 标题 | P0 |
| F-BLK-UL | 无序列表 | P0 |
| F-BLK-OL | 有序列表 | P0 |
| F-BLK-TASK | 任务 | P0 |
| F-BLK-Q | 引用+Alert | P0 |
| F-BLK-HR | 分割线 | P0 |
| F-INL-BOLD | 粗体 | P0 |
| F-INL-ITALIC | 斜体 | P0 |
| F-INL-STRIKE | 删除线 | P0 |
| F-INL-ULINE | 下划线 | P1 |
| F-INL-MARK | 高亮 | P1 |
| F-INL-CODE | 行内代码 | P0 |
| F-INL-LINK | 链接 | P0 |
| F-INL-TAG | 标签 | P1 |
| F-BRK | 软硬换行 | P0 |
| F-KEY-TAB | Tab | P0 |
| F-SLASH | Slash | P0 |
| F-CONV | 块转换 | P0 |
| F-PH | Placeholder | P0 |
| F-CLIP | 剪贴板 | P0 |
| F-IME-DOC | IME 文档套件 | P0 |
| F-A11Y-FOCUS | 键盘与焦点 | P0 |
| F-MOD-LINE | line-source 模块 | P0 |
| F-MOD-OWNER | 无上帝文件 | P0 |

---

## 附录 B — 与现状文件映射

| 现状路径 | 本册归宿 |
|----------|----------|
| `js/markdown-editor/ui/line-source.js` | → `edit/line-source/*` 强化为 F-MOD-LINE |
| `js/markdown-editor/editor.js` | → 拆为 controller + 上表模块；禁止继续堆 |
| `js/markdown-editor/ui/selection-toolbar.js` | → extensions 或删除默认接线（F-CORE-08） |
| `js/markdown-editor/ui/code-highlight.js` | → 02 + F-CORE-06 |
| `docs/markdown-editor/v3-complete/02-render-model.md` | 算法参考；冲突以**本册行源码**为准 |
| `docs/markdown-editor/03-line-renderer.md` | 块调度参考 |
| `docs/markdown-editor/v3-complete/11-no-god-file-charter.md` | F-MOD-OWNER 强制 |

---

## 附录 C — 人工验收剧本（W1 冒烟）

1. 打开 showcase 长文；浏览不点：应全渲染、无编辑壳、无 sel-bar。  
2. 点 H2：见灰 `##`，下方内容不跳。  
3. 清空标题正文，连续 Backspace：级降→段落。  
4. 新段输入 `*` 再空格：变列表 soft ·；点 · 见 `*`。  
5. Enter 两项；空项 Enter 退出列表。  
6. 输入 `**粗体**`：生效；Ctrl+B 切换。  
7. 中文 IME 输入「你好世界」于列表：不拆块。  
8. 插入代码：leave 高亮；再点：完整 fence 单表面。  
9. `---` 成 HR；Backspace 删。  
10. `/` 插引用；`> [!WARNING]` 视觉正确。  
11. 复制一段含粗体到记事本见 MD 或合理 plain。  
12. 全键盘：进段、slash 插标题、Esc、方向键换块。

**失败任一条 ⇒ W1 未完成，禁止开媒体/AI 花活波次。**

---

## 附录 D — 反模式总表（给 Review Agent）

| 反模式 | 对应 |
|--------|------|
| 双壳代码 | F-CORE-06 |
| 聚焦整段 raw MD 灰墙 | F-CORE-02 |
| 激活全行 border/底色 | F-CORE-10 |
| 默认 mdx-sel-bar | F-CORE-08 |
| composition 中 morph | F-CORE-09 |
| editor.js 继续 +500 行 | F-MOD-OWNER |
| soft · 写入 MD 文件 | F-CORE-05 |
| 表编辑变整表 pipe 源 | F-CORE-07 |
| placeholder 进 model | F-PH |
| execCommand 主路径 | F-INL-* |
| 无 height lock | F-CORE-03 |
| 一次 Backspace 炸块无阶梯 | F-CORE-04 |

---

**分册结束。** 实现以本文件 F-ID 验收；未列 F-ID 不得擅自加核心 UX。后续分册 02–08 不得推翻 §2 通用契约，仅可扩展本册未覆盖块种。
