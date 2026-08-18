# 07 — 格式面残留盘点（表 / 代码 / 图公式 / 媒体）

> **日期**：2026-08-03  
> **角色**：分析 agent · 只读盘点 · **无代码**  
> **范围**：W2 代码单表面 · W3 表格专业面 · W6 媒体结构 · W7 Mermaid+公式  
> **权威输入**：  
> - `feature-catalog/02-code-math-diagram.md`  
> - `feature-catalog/03-tables.md`  
> - `feature-catalog/04-media-structure.md`  
> - 旧块规格 `blocks/code.md` · `blocks/table.md`  
> - 实现：`js/markdown-editor/{blocks,table,media,ui,serialize,editor}.js`  
> - harness：`tests/w2-code-surface-harness.js` · `w3-table-harness.js` · `w7-math-mermaid-harness.js`  
> **政策**：本文件优先于「波次 **done (verify)**」乐观标注；以用户可感知「好用」为准。  
> **编码**：UTF-8

---

## 0. 结论先行

| 能力面 | 波次台账 | 诚实现状 | 能否称「好用」 |
|--------|----------|----------|----------------|
| **代码单表面** | W2 done (verify) | **主路径可用**：失焦高亮、聚焦含围栏源、无双壳、复制 body | **接近好用**；卡在语言菜单空、围栏边界、无行号/折叠 |
| **表格** | W3 done (verify) | **专业骨架在**：网格锁、框选、合并拆分、悬停 +、右键分套、TSV、align 序列化 | **半好用**；卡在合并导出诚实 UX、列操作、迷你条、格内 marks |
| **媒体+结构** | W6 done | **图片+粘贴拖放+上传端口**主路径有；TOC/file_chip/wiki 片段有 | **不够好用**；占位点选无 picker、无端口时静默 blob、视频/附件/灯箱缺 |
| **Mermaid+公式** | W7 done | **壳+往返+可选 peer 渲染**；无库时干净 fallback | **依赖宿主 CDN**；图/公式失败态与主题弱，六类图未产品化 |

**总判断**：W2–W7 把「模型方向」和「演示主路径」立住了，但 **金标准 P0 的边界与诚实失败态大量仍是半成品**。台账 `done` ≠ 用户感知完成。下文按面列 **P0 / P1 残留**，并单独写清：合并导出诚实度、代码单表面边角、图片上传 **仅端口** 边界。

---

## 1. 盘点方法与证据级别

| 级别 | 含义 |
|------|------|
| **E1 代码直读** | 打开实现文件可见行为 |
| **E2 harness** | w2/w3/w7 验收脚本覆盖范围（**不等于**产品金标准全绿） |
| **E3 规格对照** | feature-catalog 验收项 vs 实现缺口 |
| **E4 推断** | 无自动化证明；标为推断，实施前应人工点验 |

本册 **不编造** harness 运行结果；若未在本机跑通 HTML harness，状态以代码与规格差分为准。

---

## 2. 表格面（W3 · `03-tables` · `blocks/table` · `table/*`）

### 2.1 已落地（勿重复造）

| 能力 | 证据（实现） | 对应 F-ID（摘要） |
|------|--------------|-------------------|
| 网格编辑锁定、无整表 pipe textarea | `editor.js` 表编辑走 DOM 网格；无 `table-source` 默认路径 | F-T-0001 |
| 单元格点击编辑 | 格 contenteditable / 提交 `commitTable` | F-T-0002（WYSIWYG 基线） |
| 悬停 `+` 加行/列（无「加行」「加列」文案） | `ui/table-chrome.js` | F-T-0004 |
| 框选 / 多选矩形 | `table/selection.js` | F-T-0006 |
| 合并 / 拆分 + 中文 reason | `table/merge.js` + `schema.js` | F-T-0008 / 0009 |
| 表头/表体右键分套 IA | `table/context-menu.js` + chrome | F-T-0010 / 0011 |
| 列对齐 + GFM 分隔行 `:` | `serialize.js` sepParts | F-T-0012 |
| TSV 复制粘贴基础 | `table/clipboard-tsv.js` | F-T-0016（P0 子集） |
| 合并 → GFM **expand-blank** | `serialize.js` `flattenTableRowsExpandBlank` | F-T-0017 **仅一种 mode** |
| 增删行列、清空、删表（菜单） | chrome + editor handlers | F-T-0019 子集 |
| harness 模块存在性 | `tests/w3-table-harness.js` | E2 |

### 2.2 P0 残留（挡「好用」 / 挡诚实）

| ID | 残留项 | 为何 P0 | 证据 / 缺口 | 用户感知 |
|----|--------|---------|-------------|----------|
| **T-R01** | **合并导出策略不完整 + UX 不诚实** | F-T-0017 要求五种 mode + 存在 merge 时提示；禁止假装 GFM 无损 | 仅硬编码 **expand-blank**；注释写明 expand-repeat / html-table / conex-fence「host opts later」；**无**导出前轻提示；JSON Doc 无损但 MD 路径静默丢 merge | 用户合并表头后「导出给同事」→ 打开 MD 合并没了，**不知道发生了什么** |
| **T-R02** | expand 后再 import **不**恢复 merge（规格正确）但 **无任何说明** | 诚实降级必须可感知 | 无 UI、无 `meta.repaired` 用户文案、无 toast | 像 bug 不像策略 |
| **T-R03** | 增删行列 × 合并交叉：智能扩展未做；split-on-seam 是否全路径一致 | F-T-0020 不变量破坏 = 网格崩 | schema mutator 有 merge 字段；需确认所有 chrome 插删都先 split（E4 建议 fuzz） | 偶发「格对不齐 / 双 cover」 |
| **T-R04** | 格内行内 marks 读态/编态 | F-T-0022 P0 读 · P1 live | 表格仍偏 plain text；全局 marks 管道未完全进格 | 表内不能像段落一样粗体往返 |
| **T-R05** | 粘贴扩表与已有 merge 相交的 **先 split** 策略 | F-T-0016 安全 | TSV 写入路径需与 merge 交叉（E4） | 粘贴 Excel 打烂合并 |
| **T-R06** | 性能：单格输入禁止全文 re-render | F-T-0026 | editor 有局部优化注释，大表未金标准验收 | 20×30 编辑卡顿即失败 |
| **T-R07** | 撤销粒度：结构一步 / 输入 debounce | F-T-0021 | model history 通用；表专用未逐项验收 | 合并 undo 丢选区或一步过多 |

### 2.3 P1 残留（专业补齐，不做也能 demo）

| ID | 项 | F-ID | 状态 |
|----|-----|------|------|
| T-R10 | 列宽拖拽 + `colWidths` JSON 持久 / GFM 丢弃 | F-T-0013 | **缺失** |
| T-R11 | 列拖拽换序（merge 约束） | F-T-0014 | **缺失** |
| T-R12 | 行列选择手柄 | F-T-0007 | **缺失 / 弱** |
| T-R13 | 多选浮动迷你条（合并/对齐/清空） | F-T-0028 | **缺失** — 发现合并依赖右键，新手难发现 |
| T-R14 | 表头行切换 + pure-gfm 策略写死 | F-T-0018 | **半成品** |
| T-R15 | HTML table 导入含 rowspan/colspan | F-T-0023 | **缺失** |
| T-R16 | a11y grid 角色与读屏摘要 | F-T-0025 | **半成品** |
| T-R17 | 排序/筛选视图层 | F-T-0015 / 0029 | **P2 规格占位** |
| T-R18 | `table.*` 命令端口给 AI | F-T-0034 | **缺失** |

### 2.4 合并导出诚实度（专节 · 强制写清）

#### 现状（E1）

```
serialize table 路径（pure-gfm 默认）:
  cells → flattenTableRowsExpandBlank
    · anchor 保留 text
    · covered → 空串
  → 标准 GFM pipe（无 rowspan/colspan 语法）
```

| 通道 | 合并信息 | 诚实？ |
|------|----------|--------|
| **JSON Doc / getDoc** | 保留 `rowspan/colspan/covered/anchor` | ✅ 无损 |
| **getMarkdown / pure-gfm** | **丢失** merge 结构；仅 expand-blank 文本布局 | ⚠️ 数据诚实、**体验不诚实**（静默） |
| **expand-repeat** | 未实现 | ❌ |
| **html-table** (`<table rowspan>`) | 未实现 | ❌ |
| **conex-fence** (` ```conex-table ` JSON) | 未实现 | ❌ |
| **annotate** 注释说明 | 未实现 | ❌ |
| 导出前 UI 提示「合并将按策略展开」 | 未实现 | ❌ |
| 文档/Showcase FAQ「GFM 无合并」 | 规格要求；实现侧未产品化 | ❌ |

#### 什么叫「诚实」做完（验收靶心，非本文件实现）

1. **默认 mode 写死并测五种夹具**（至少 expand-blank + expand-repeat 可切换）。  
2. **存在任意 merge 时**：`getMarkdown` 或宿主 export 可返回旁路 flag / 调用方 toast；编辑器内至少 **一次** 可理解提示（非每次按键骚扰）。  
3. **禁止**营销文案写「GFM 无损合并」。  
4. **JSON round-trip** 与 **GFM round-trip** 分测：后者断言 merge **不**恢复。  
5. 宿主 `conex` mode 若需要保真：优先 html-table 或 conex-fence，并有 re-import。

#### 挡「好用」的一句话

> 合并在编辑器里「像 Notion」，导出 MD 后「像被拆了」且 **没人告诉用户**——这是信任债，不是小缺陷。

---

## 3. 代码单表面（W2 · `02` · `blocks/code-*` · `ui/code-*`）

### 3.1 已落地（硬规则主路径）

| 规则 | 状态 | 证据 |
|------|------|------|
| R1 失焦 = 高亮渲染 | ✅ 主路径 | `code-read.js` + `code-highlight.js`（`mdx-tok-*`） |
| R2 聚焦 = **同卡**完整 fence 源（含 \`\`\`lang） | ✅ 主路径 | `code-edit.js` `sourceHtml` / `mountSource`；**无** textarea 双壳 |
| R3 禁止双壳 | ✅ 架构正确 | harness 查 `textarea` 嵌套；读/源 `data-mode` 互斥 |
| 复制 body 不含围栏、不进编辑 | ✅ | `code-chrome.js` capture 委托 + `copyBody` |
| 纯文本粘贴 / Tab 缩进 / IME 不提交 | ✅ 基线 | `code-edit.js` |
| 语言标签点击 **不**进源码 | ✅ 半截 | `editor.js` 吞事件；**菜单未做** |
| Diff 行首着色 | ✅ 轻量 | `highlightDiff` |
| harness | ✅ 存在 | `w2-code-surface-harness.js` |

### 3.2 P0 残留 · **单表面边角案例**（本册重点）

> 主路径「能点、能编、能高亮」≠ 边角不炸。下列均会让工程师用户觉得「半成品」。

| ID | 边角 / 缺陷 | 规格锚点 | 现状（E1） | 用户后果 |
|----|-------------|----------|------------|----------|
| **C-R01** | **body 含 \`\`\` 时围栏未自动加长** | F-CODE-FENCE：最长 run+1 | `serialize.js` 固定 \`\`\` + body + \`\`\`；parse 遇行内 \`\`\` 易提前闭合 | 粘贴含围栏的文档片段 → 截断/错块 |
| **C-R02** | **无围栏提交**（删掉首尾 fence） | F-CODE-SRC ⑥ toast「未检测到围栏…」可撤销 | `parseSource` 设 `_noFence`；editor **静默保留旧 lang**，**无 toast** | 用户以为语言丢了或「神秘保留」 |
| **C-R03** | 源表面 **caret 点击映射**（按 Y 落行） | F-CODE-SRC ⑤ | 多为 `placeCaretEnd` / 文首；非 hit-test 行 | 点中间却跳到末尾 |
| **C-R04** | 闭合围栏残缺 / 多闭合一截 | F-CODE-SRC 失败态 | 正则宽松吞并；无 error 卡片 | 大段代码被截断保存 |
| **C-R05** | **Shift+Tab 多行减缩进** | F-CODE-INDENT P1 但 Tab 对称预期强 | 代码注释「留给后续；此处不炸」 | 工程师刚需挫败 |
| **C-R06** | 超大 body 高亮降级（>100k / >3000 行） | F-CODE-HL ④ · F-CODE-PERF | 无明确截断/Worker | 卡死主线程 |
| **C-R07** | 恶意 / 怪异 `lang` sanitize 与展示 | F-CODE-FENCE ④ · F-SEC-XSS | 有基础；需与攻击向量表对齐 | 偶发属性注入风险（应用 escape 已部分挡） |
| **C-R08** | 读态拖选文字 **误进编辑** 策略 | 点击矩阵：拖选不进编辑 | 依赖阈值；表有 3px，代码卡 body 单击即 `enterEdit` | 想复制高亮文本却进源码 |
| **C-R09** | mermaid 与 code **共享表面**时 lang 改成非 mermaid | F-MMD-CORE | 提交统一 `type:'code'`；改首行 lang 可「脱掉」图身份 | 预期内但无确认；可能惊吓 |
| **C-R10** | 高度 morph / 零跳动 | F-CORE-03 · F-CODE-SRC ⑧ | height-lock 存在；代码卡进出未金标准 | 进出编辑页面跳 |

### 3.3 P0/P1 能力缺口（非边角、整项缺失）

| ID | 项 | P | 状态 |
|----|-----|---|------|
| C-R20 | **语言菜单**（搜索+常用+即时重高亮、可不进源码） | P1（展示 P0） | 标签可点但 **return 空操作** → 用户以为坏了 |
| C-R21 | 行号 gutter | P1 | **缺失** |
| C-R22 | 长代码折叠 | P1–P2 | **缺失** |
| C-R23 | meta 行高亮 `{2,5-7}` | P2 | **缺失** |
| C-R24 | 语言自动检测建议 | P2 | **缺失** |
| C-R25 | 主题 token / 打印样式完善 | P1 | **半成品** |
| C-R26 | 「复制为 Markdown 围栏」二级操作 | P0 可选 | **缺失** |
| C-R27 | 空块 placeholder「编写代码」 | P0 体验 | 弱 / 不统一 |

### 3.4 什么在挡代码面「好用」

1. **语言标签可点无菜单** — 最廉价的信任破坏。  
2. **围栏边角（C-R01/R02）** — 一碰真实世界粘贴就错。  
3. **无行号+折叠** — 长代码文档不可读（P1 但感知强）。  
4. 单击进编辑过猛 — 与「阅读复制」冲突（C-R08）。

**W2 出口诚实分**：主路径 **4/5**；边角与 chrome **2–3/5**。不可再宣称「金标准全集」。

---

## 4. Mermaid + 公式（W7 · `02` F-MMD / F-MATH · `blocks/mermaid.js` · `blocks/math.js`）

### 4.1 已落地

| 能力 | 状态 | 备注 |
|------|------|------|
| \`\`\`mermaid → `code`+lang 解析/序列化 | ✅ | prefer code+lang，非独立 XML |
| 读态 hydrate SVG（`window.mermaid`） | ✅ 条件 | 无库 → `mdx-mermaid-fallback` 源码，**无**「点击渲染」长文案 |
| 聚焦 = 代码同款 fence 单表面 | ✅ | 复用 code-edit |
| `securityLevel: 'strict'` | ✅ | `ensureInit` |
| `$$` 块 type=math 往返 | ✅ | serialize `$$\n…\n$$` |
| 聚焦含 `$$` 单表面 | ✅ | `math.js` sourceHtml |
| 行内 `$...$` + 货币策略 | ✅ 基线 | harness 测 `价格 $3 到 $5` |
| KaTeX `trust: false` | ✅ | 有 katex 才真排版 |
| slash mermaid/math | ✅ | slash 命令表 |
| harness | ✅ | `w7-math-mermaid-harness.js` |

### 4.2 P0 残留（随图/公式启用即安全与可信）

| ID | 项 | 说明 |
|----|-----|------|
| **M-R01** | **无 peer 时「看起来像没做」** | Demo/宿主未挂 CDN → 永远 fallback 等宽源；产品需文档化「好用依赖可选 peer」，不可宣传「内置渲染」 |
| **M-R02** | 失败态弱 | mermaid `is-error` 保留 pre；**无**「显示源码/重试」一等 UI；数学错误靠 KaTeX throwOnError:false 静默坏公式 |
| **M-R03** | 超大源 / 超时预算 | F-SEC-MMD 字符节点预算、渲染超时 kill — **未见完整门控** |
| **M-R04** | 主题跟随亮暗 | F-THEME-MMD：固定 `theme: 'neutral'`；暗色页对比度风险 |
| **M-R05** | 视口外懒渲染 | F-CODE-PERF / F-MMD：多图文档可能齐渲 | 
| **M-R06** | 尺寸跳动 | 图首次 SVG 替换 pre → 高度跳；min-height 策略未金标准 |
| **M-R07** | Math 引擎端口 | F-MATH-ENGINE MathJax 可选注入 — **缺失**；仅 window.katex |
| **M-R08** | 行内公式原子编辑 | 规格「原子选中显示源」；实现偏 HTML 替换，边界与 01 分册交界未收口 |

### 4.3 P1 残留（图种与体验）

| ID | 项 | 优先级 | 状态 |
|----|-----|--------|------|
| M-R10 | flowchart / sequence / ER / state 产品样例与验收 | P1 | 库能渲则渲；**无**分图种 UX 与中文标签专项 |
| M-R11 | timeline / class | P2 | 同上 |
| M-R12 | ASCII 图 `text` 专用样式 | P2 | 靠 plaintext code 凑合 |
| M-R13 | 错误 mermaid 样本 Showcase | P1 | 依赖展示页，非内核 |

### 4.4 挡「好用」

- **默认无 CDN = 永远源码块** → 评审误判「W7 假完成」。  
- 错误与主题弱 → 科学/架构文档场景不专业。  
- 与代码表面边角共享（改 fence 丢 mermaid 身份）。

---

## 5. 媒体与结构（W6 · `04-media-structure` · `blocks/image` · `media/drop-paste` · `toc`）

### 5.1 已落地（主路径）

| 能力 | 状态 | 证据 |
|------|------|------|
| 图片块 parse/serialize `![alt](src)` | ✅ | `blocks/image.js` |
| 读态 figure / 空占位 / loading / error | ✅ 壳 | status via `meta.status` |
| 聚焦 = 源码行编辑（`![…](…)`） | ✅ | line-source 风格，非双壳预览 |
| 协议白名单 | ✅ | 禁 javascript: 等 |
| **粘贴 / 拖放图片** | ✅ | `media/drop-paste.js` |
| **`uploadImage` / `media.uploadImage` 端口** | ✅ 接线 | `editor.js` + `index.js` 文档 |
| `resolveUrl` | ✅ 可选 | 读态 helpers |
| `maxUploadBytes` | ✅ | 默认 20MB |
| TOC `@[toc]` / 中文 slug | ✅ 基线 | `blocks/toc.js` |
| file_chip / wiki 片段 / callout 序列化 | ✅ 部分 | parse/serialize/util |
| 无上传时 blob 预览 | ✅ **且有问题** | 见下 |

### 5.2 P0 残留

| ID | 项 | 说明 |
|----|-----|------|
| **I-R01** | **占位「添加图片」无文件选择** | `data-mdx-image-pick` 仅标记；**无** `<input type=file>` / `beforePick` / picker 模块 → F-M-0130 缺口 |
| **I-R02** | **无 upload 端口时静默 blob** | 规格：明确 toast「宿主未配置上传」；实现：`URL.createObjectURL` 当 ready → **会话级可预览、持久化 MD 毒丸**（blob: 不可移植） |
| **I-R03** | AbortSignal / 删块取消上传 | F-M-0140；未见完整 abort 写回防护 |
| **I-R04** | 上传失败可重试 UI | 有 onError announce；块级 error+重试弱 |
| **I-R05** | 安全二次校验返回 URL | 端口返回 `javascript:` 等应再过白名单（部分在 parse；上传回写路径需统一） |
| **I-R06** | Callout 是否金标准交互 | F-M-1100 P0；序列化有，编辑体验未本册深挖 → 标 **半成品风险** |

### 5.3 P1 残留（媒体结构面大头）

| 域 | 项 | F-ID | 状态 |
|----|-----|------|------|
| 图 | caption/alt/align 产品化编辑（非仅源行） | F-M-0160 | 半 |
| 图 | 灯箱 | F-M-0170 | **缺失** |
| 图 | 压缩 / 标注 | F-M-0150 / 0180 | P2 缺失 |
| 视频/音频/附件块 | 本地 mp4、YouTube/B 站、附件卡 | F-M-0200–0400 | **基本缺失** |
| 提供方白名单框架 | F-M-1010 | **缺失** |
| TOC | 侧栏 `getToc` 订阅 API、交叉观察 current | F-M-0510 | **半**（有 buildItems，宿主 API 弱） |
| Wiki 补全 | F-M-0710 | **缺失** |
| 标签 #tag | F-M-0800 | **半 / 弱** |
| 出链 getOutlinks | F-M-0900 | **缺失** |
| 反链 | F-M-0910 宿主边界 | 文档有、内核正确不实现面板 | OK 边界 |

### 5.4 图片上传端口 — **仅端口**边界（专节）

> 用户要求本册诚实写清：**上传只走宿主端口**，内核不绑云。以下是契约与残留，**不**扩展为对象存储实现说明。

#### 已支持（挂载选项）

| 选项 | 作用 |
|------|------|
| `uploadImage(file, ctx?) => Promise<{ url, alt? }>` | 顶层快捷 |
| `media.uploadImage` | 同义嵌套 |
| `media.resolveUrl` / `resolveUrl` | `attachment:` / 相对路径 → 可加载 URL |
| `features.maxUploadBytes` / `maxUploadBytes` | 超限拒绝 |
| `features.media` | 规格有；实现侧需确认 false 时是否隐藏 slash/drop（E4） |

`UploadContext`（drop-paste 已传）：`kind:'image'` · `source:'paste'|'drop'` · `blockId?`。

#### 端口层 P0 残留（仍属「只端口」）

| 缺口 | 规格 | 现状 |
|------|------|------|
| `beforePick('image')` | F-M-0130/0140 权限门控 | **无** |
| `uploadVideo` / `uploadAudio` / `uploadFile` | 统一媒体端口族 | **无**（仅 image） |
| 未注入 upload 时的 **明确失败/提示策略** | 可理解 toast，不静默 | **静默 blob**（与规格冲突） |
| 类型导出供宿主 TS | F-M-0140 | 在 `packages/conex-mdx` 仍 scaffold；reference 为 JS 注释 |
| 进度 `onProgress` | 可选 | **无** |
| 替换同 blockId 上传 | F-M-0130 | 粘贴偏 **插入新块**；替换路径弱 |
| 假端口单测夹具 | 验收 | harness 未系统化 media |

#### 内核 **禁止** 承担（重申）

- S3/本地盘/IPFS 协议细节  
- 全局反链索引  
- 默认把大图 base64 写进 MD  

#### 挡媒体「好用」的一句话

> 能拖进一张图，但 **点占位不会选文件**；无宿主端口时 **blob 写入 MD 像成功**——集成方与作者两条路径都容易踩坑。

---

## 6. 「好用」阻塞矩阵（跨面）

按 **用户任务** 而非 F-ID：

| 用户任务 | 阻塞级别 | 主因 |
|----------|----------|------|
| 写技术文：贴代码、改语言、复制 | **中** | 语言菜单空；围栏边角；无行号 |
| 需求对照表：合并表头、导出给同事 MD | **高** | 合并静默展开；无提示；无 html/fence 保真 |
| 从 Excel 粘表 | **中高** | TSV 有；merge 交叉与大表性能未金标准 |
| 笔记插图（有宿主上传） | **中** | 端口 OK；缺 picker/替换/进度 |
| 笔记插图（裸 demo 无端口） | **高** | 静默 blob；文档不可迁移 |
| 架构文插 Mermaid | **中**（有 CDN）/ **高**（无 CDN） | peer 依赖；主题/失败态 |
| 公式笔记 | **中** | 依赖 KaTeX；行内原子编辑弱 |
| 长文目录跳转 | **低–中** | TOC 基线有；侧栏 API/当前节弱 |

---

## 7. 与波次台账的偏差声明

| 台账（`00-master-index`） | 本册判定 |
|---------------------------|----------|
| W2 **done (verify)** | **主路径 verify 可过**；单表面 **边角 + 语言菜单** 未金标准 |
| W3 **done (verify)** | **专业骨架 verify 可过**；**F-T-0017 导出诚实度未过**；列操作/迷你条未做 |
| W6 **done** | **图片+drop/paste+端口接线 done**；picker/端口族/音视频/结构 API **未 done** |
| W7 **done** | **模块与往返 done**；**渲染好用依赖宿主 peer**；图种/安全预算/主题未金标准 |

> 建议调度：后续台账改 **`done (mainpath)`** / **`residual open`**，避免与 ux-readiness 打架。

---

## 8. 建议修复优先级（仅排序，不实施）

### 8.1 立刻（信任 / 数据诚实）

1. **T-R01/T-R02** 合并导出：至少 UI/API 层诚实提示 + 文档；补 expand-repeat 或 conex-fence 之一作保真出口。  
2. **I-R02** 无 `uploadImage`：禁止默默持久化 blob 为「成功」；toast + 可选仅会话预览策略写死。  
3. **C-R01** body 含 fence 时围栏加长（serialize/parse 对称）。  
4. **C-R02** `_noFence` toast + 可撤销。

### 8.2 短周期（体感好用）

5. **C-R20** 语言菜单（不做等于语言标签是假按钮）。  
6. **I-R01** 占位点击 → 文件选择（仍只调端口上传）。  
7. **T-R13** 多选迷你条（合并可发现性）。  
8. **M-R01/R02** Showcase 默认带 peer 或明确降级文案；失败态可读。

### 8.3 下一波专业

9. 列宽/换序、行号/折叠、灯箱、getToc 订阅、html-table 导入。  
10. 视频/附件块与 `uploadFile` 端口族扩展（仍宿主实现存储）。

---

## 9. 模块主人（残留归属，防继续堆 `editor.js`）

| 残留簇 | 应落模块 | 禁止 |
|--------|----------|------|
| 合并导出 mode / 提示 | `serialize` 表分支 + 薄 `table/export-policy` | editor 内塞五种 mode |
| 表迷你条 / 列宽 | `ui/table-chrome` / `table/*` | |
| 代码围栏加长 / noFence toast | `blocks/code-edit` + parse/serialize | |
| 语言菜单 | `blocks/code/lang-menu` 或 `ui/code-chrome` | |
| 图片 picker | `media/picker` + 端口 | 内核直传 S3 |
| 上传契约类型 | `ports/media`（包侧） | |
| Mermaid 安全预算/主题 | `blocks/mermaid` | 首包强依赖 mermaid |
| Math 引擎端口 | `blocks/math` / render 端口 | 双引擎默认 |

`editor.js` 已是编排巨石（数千行）：本面残留 **只许挂钩，不许再堆算法**。

---

## 10. 验收时如何快速复测（人工 20 分钟）

| # | 步骤 | 期望 | 若失败 → |
|---|------|------|----------|
| 1 | 代码块失焦有着色；点 body 见 \`\`\`lang；无上下双框 | W2 主路径 | 回滚模型 |
| 2 | 复制按钮；剪贴板无围栏；仍停留读态 | F-CODE-COPY | chrome |
| 3 | 点语言标签 | **应**出菜单；现状应记录「空操作」 | C-R20 |
| 4 | body 粘贴含 \`\`\` 的文本后 blur 再开 | 不截断 | C-R01 |
| 5 | 表框选 2×2 合并；getDoc 有 rowspan；getMarkdown 无 | 结构/MD 分离 | T-R01 |
| 6 | 合并后导出 MD 再 setMarkdown | merge **不**回；用户应得到说明 | T-R02 |
| 7 | 无 uploadImage 粘贴截图 | **不应**静默当永久成功 | I-R02 |
| 8 | 有 mock uploadImage 拖图 | loading→正式 URL | 端口主路径 |
| 9 | 点「添加图片」占位 | 应选文件；现状可能无反应 | I-R01 |
| 10 | 无 mermaid CDN 打开 \`\`\`mermaid | 干净源码 fallback，不白屏 | M-R01 |
| 11 | 有 mermaid CDN | 失焦图、聚焦源 | W7 主路径 |
| 12 | `$$` 与行内 `$a$`；货币句 | 公式 vs 非公式 | harness 对齐 |

---

## 11. 非目标（本册明确不扩展）

- Notion Database / 公式列引擎 / 真 Excel  
- 内核内对象存储、转码、波形编辑  
- 反链全局索引 UI（宿主职责）  
- MathJax 全宏 / Carbon 导出海报  
- 把 W8 AI mock 塞回演示  

---

## 12. 给调度的一句话口令

> **格式面：主路径已通，诚实与边角未通。**  
> 先修 **合并导出提示 + 无上传勿毒 MD + 代码围栏边角 + 语言菜单 + 图片 picker**；再谈列宽/行号/灯箱/六类图。  
> 禁止用「W2–W7 done」关闭本文件中的 **P0** 项。

---

## 13. 修订

| 版本 | 日期 | 说明 |
|------|------|------|
| 0.1 | 2026-08-03 | 首版：对照 02/03/04 与 W2/W3/W6/W7 实现 residual；专节合并导出诚实、代码单表面边角、图片上传仅端口 |

*本文件结束。关联：`00-MASTER-READINESS.md`（若有）· `01-unfinished-inventory.md` · feature-catalog 02/03/04。*
