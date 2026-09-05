# 战役：差异面板与笔记面板系统性重构 —— 全景反过度设计与极简纯粹性审计报告 (AUDIT-SIMPLICITY-FINAL)

> **审计编号**：AUDIT-SIMPLICITY-FINAL  
> **战役名称**：差异面板与笔记面板系统性重构（Diff View & Note Panel Systematic Redesign）  
> **所属阶段**：阶段五 · 全景贯通审计补齐（Phase 5: Holistic End-to-End Audit Completion）  
> **审计角色**：反过度设计与极简纯粹性审计官（Anti-Overengineering & Simplicity Auditor）  
> **审计对象**：`docs/diff-view-redesign/` 下全部 8 份方案全集：
> - [`docs/diff-view-redesign/00-总方案-差异与笔记面板系统性重构全景架构总纲.md`](file:///c:/Software/conex/docs/diff-view-redesign/00-%E6%80%BB%E6%96%B9%E6%A1%88-%E5%B7%AE%E5%BC%82%E4%B8%8E%E7%AC%94%E8%AE%B0%E9%9D%A2%E6%9D%BF%E7%B3%BB%E7%BB%9F%E6%80%A7%E9%87%8D%E6%9E%84%E5%85%A8%E6%99%AF%E6%9E%B6%E6%9E%84%E6%80%BB%E7%BA%B2.md) (MASTER-PLAN-00)
> - [`docs/diff-view-redesign/01-分维详案-差异面板平直列表直角化与32px紧凑架构.md`](file:///c:/Software/conex/docs/diff-view-redesign/01-%E5%88%86%E7%BB%B4%E8%AF%A6%E6%A1%88-%E5%B7%AE%E5%BC%82%E9%9D%A2%E6%9D%BF%E5%B9%B3%E7%9B%B4%E5%88%97%E8%A1%A8%E7%9B%B4%E8%A7%92%E5%8C%96%E4%B8%8E32px%E7%B4%A7%E5%87%91%E6%9E%B6%E6%9E%84.md) (DETAIL-PLAN-01)
> - [`docs/diff-view-redesign/02-分维详案-行内工具条物理拔除与代码比对专注化.md`](file:///c:/Software/conex/docs/diff-view-redesign/02-%E5%88%86%E7%BB%B4%E8%AF%A6%E6%A1%88-%E8%A1%8C%E5%86%85%E5%B7%A5%E5%85%B7%E6%9D%A1%E7%89%A9%E7%90%86%E6%8B%94%E9%99%A4%E4%B8%8E%E4%BB%A3%E7%A0%81%E6%AF%94%E5%AF%B9%E4%B8%93%E6%B3%A8%E5%8C%96.md) (DETAIL-PLAN-02)
> - [`docs/diff-view-redesign/03-分维详案-文件名超链接单轨接线独立预览Tab与全域Tokens规范.md`](file:///c:/Software/conex/docs/diff-view-redesign/03-%E5%88%86%E7%BB%B4%E8%AF%A6%E6%A1%88-%E6%96%87%E4%BB%B6%E5%90%8D%E8%B6%85%E9%93%BE%E6%8E%A5%E5%8D%95%E8%BD%A8%E6%8E%A5%E7%BA%BF%E7%8B%AC%E7%AB%8B%E9%A2%84%E8%A7%88Tab%E4%B8%8E%E5%85%A8%E5%9F%9FTokens%E8%A7%84%E8%8C%83.md) (DETAIL-PLAN-03)
> - [`docs/diff-view-redesign/04-分维详案-全域Tokens规范重构与SLoHT单层Hover体系.md`](file:///c:/Software/conex/docs/diff-view-redesign/04-%E5%88%86%E7%BB%B4%E8%AF%A6%E6%A1%88-%E5%85%A8%E5%9F%9FTokens%E8%A7%84%E8%8C%83%E9%87%8D%E6%9E%84%E4%B8%8ESLoHT%E5%8D%95%E5%B1%82Hover%E4%BD%93%E7%B3%BB.md) (DETAIL-PLAN-04)
> - [`docs/diff-view-redesign/05-分维详案-笔记面板32px紧凑顶栏重塑与底部调试块彻底拔除.md`](file:///c:/Software/conex/docs/diff-view-redesign/05-%E5%88%86%E7%BB%B4%E8%AF%A6%E6%A1%88-%E7%AC%94%E8%AE%B0%E9%9D%A2%E6%9D%BF32px%E7%B4%A7%E5%87%91%E9%A1%B6%E6%A0%8F%E9%87%8D%E5%A1%91%E4%B8%8E%E5%BA%95%E9%83%A8%E8%B0%83%E8%AF%95%E5%9D%97%E5%BD%BB%E5%BA%95%E6%8B%94%E9%99%A4.md) (DETAIL-PLAN-05)
> - [`docs/diff-view-redesign/06-分维详案-多笔记综合管理体系与SQLite及IPC后端架构.md`](file:///c:/Software/conex/docs/diff-view-redesign/06-%E5%88%86%E7%BB%B4%E8%AF%A6%E6%A1%88-%E5%A4%9A%E7%AC%94%E8%AE%B0%E7%BB%BC%E5%90%88%E7%AE%A1%E7%90%86%E4%BD%93%E7%B3%BB%E4%B8%8ESQLite%E5%8F%8AIPC%E5%90%8E%E7%AB%AF%E6%9E%B6%E6%9E%84.md) (DETAIL-PLAN-06)
> - [`docs/diff-view-redesign/07-分维详案-立体验证套件与回归测试平滑迁移.md`](file:///c:/Software/conex/docs/diff-view-redesign/07-%E5%88%86%E7%BB%B4%E8%AF%A6%E6%A1%88-%E7%AB%8B%E4%BD%93%E9%AA%8C%E8%AF%81%E5%A5%97%E4%BB%B6%E4%B8%8E%E5%9B%9E%E5%BD%92%E6%B5%8B%E8%AF%95%E5%B9%B3%E6%BB%91%E8%BF%81%E7%A7%BB.md) (DETAIL-PLAN-07)
> **产出落盘**：`docs/diff-view-redesign/audits/02-anti-overengineering-and-simplicity-audit.md`  
> **审计基准与硬性红线**：  
> 1. 仓库根目录 [`ANTI_OVERENGINEERING_GUARDRAILS.md`](file:///c:/Software/conex/ANTI_OVERENGINEERING_GUARDRAILS.md)（13 项明确禁令）；  
> 2. 用户关于“越简单越好”的战略指示与最高裁决：  
>    - *“差异界面的每个文件改成列表就行了，去掉圆角。然后去掉每个文件列表里面的顶部工具行，越简单越好，现在功能多了用户反而不知道怎么用了。整个差异界面基本上是都要重构了...项目中的代码应该是清晰的、单轨的、最先进的代码。”*  
>    - *“笔记界面一起哈。笔记的顶部功能栏我看也没有。底部那个灰色的大区域一点用处没有，这两个块区域是又丑又没用...先优化界面吧，这个笔记界面还是有些问题，因为笔记不可能只有一个，以及笔记没有一个综合的管理界面，现在只能看一个类似于硬编码的标签界面了，这和展示没什么区别。了解清楚了，这个也一起加进去。”*  
> 3. 协作纪律 [`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §1（反退避纯逻辑推进）、§7（严禁补丁与绕过、立体验证、架构净收敛）、§8（反过度设计硬性红线）。

---

## 目录

- [一、审计概览与裁决矩阵](#一审计概览与裁决矩阵)
  - [1.1 总体审计结论：差异面板通过，笔记面板需实施精准瘦身](#11-总体审计结论差异面板通过笔记面板需实施精准瘦身)
  - [1.2 核心审查判定对比总表](#12-核心审查判定对比总表)
- [二、差异面板审查：专注度与极简性判定（Pass）](#二差异面板审查专注度与极简性判定pass)
  - [2.1 行内工具条切除彻底性审查（释放 36px 视口，零伪功能残留）](#21-行内工具条切除彻底性审查释放-36px-视口零伪功能残留)
  - [2.2 平直列表直角化与三大正交子域（零手风琴，零卡片孤岛）](#22-平直列表直角化与三大正交子域零手风琴零卡片孤岛)
  - [2.3 独立预览 Tab 单轨流转审查（拒绝自造弹窗/抽屉，零伪双轨）](#23-独立预览-tab-单轨流转审查拒绝自造弹窗抽屉零伪双轨)
  - [2.4 破坏性伪实现的彻底清剿（accept/reject 假实现连根切除）](#24-破坏性伪实现的彻底清剿acceptreject-假实现连根切除)
  - [2.5 差异面板审查结论：达成极致专注与极简](#25-差异面板审查结论达成极致专注与极简)
- [三、笔记面板审查：过度设计与次要属性深度排查（Need-Simplify）](#三笔记面板审查过度设计与次要属性深度排查need-simplify)
  - [3.1 【过度设计 1 · 画饼式次要属性】：`tags_json` 标签体系的“半吊子过度设计”](#31-过度设计-1--画饼式次要属性tags_json-标签体系的半吊子过度设计)
  - [3.2 【过度设计 2 · 残留死逻辑】：`is_archived` 深度归档与软删除死分支](#32-过度设计-2--残留死逻辑is_archived-深度归档与软删除死分支)
  - [3.3 【过度设计 3 · 双重切换内卷】：`NoteSidebarDrawer` 抽屉与 `NoteDocumentDropdown` 下拉的严重重叠](#33-过度设计-3--双重切换内卷notesidebardrawer-抽屉与-notedocumentdropdown-下拉的严重重叠)
  - [3.4 【过度设计 4 · 顶栏交互过载】：常驻“清空笔记”危险按钮与多重密集图标挤占标题编辑视口](#34-过度设计-4--顶栏交互过载常驻清空笔记危险按钮与多重密集图标挤占标题编辑视口)
- [四、对照 ANTI_OVERENGINEERING_GUARDRAILS.md 13 项禁令逐条检视](#四对照-anti_overengineering_guardrailsmd-13-项禁令逐条检视)
- [五、极简瘦身方案与架构净收敛改造指令（Directives）](#五极简瘦身方案与架构净收敛改造指令directives)
  - [5.1 存储与领域模型瘦身：从 8 列收敛为 6 列极简权威真源](#51-存储与领域模型瘦身从-8-列收敛为-6-列极简权威真源)
  - [5.2 交互通道单轨收敛：物理拔除 `NoteDocumentDropdown`，独尊 220px 抽屉](#52-交互通道单轨收敛物理拔除-notedocumentdropdown独尊-220px-抽屉)
  - [5.3 顶栏纯净化：拔除清空按钮，释放 `EditableTitle` 呼吸空间](#53-顶栏纯净化拔除清空按钮释放-editabletitle-呼吸空间)
  - [5.4 软删除死逻辑物理清退：硬删除单轨闭环](#54-软删除死逻辑物理清退硬删除单轨闭环)
- [六、审计裁决签发与结论声明](#六审计裁决签发与结论声明)

---

## 一、审计概览与裁决矩阵

### 1.1 总体审计结论：差异面板通过，笔记面板需实施精准瘦身

本反过度设计与极简纯粹性审计官在全面精读 `docs/diff-view-redesign/` 下全部 8 份重构方案（合计逾 14,000 行技术规范与源码施工图）、对照仓库根目录 [`ANTI_OVERENGINEERING_GUARDRAILS.md`](file:///c:/Software/conex/ANTI_OVERENGINEERING_GUARDRAILS.md) 13 项禁令以及用户“越简单越好”的战略指示后，签发审计裁决：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              战役总体纯粹性审计裁决判定                                │
├──────────────────────────┬──────────────────────┬──────────────────────────────────────┤
│ 审计模块                 │ 纯粹性判定           │ 核心定性说明                         │
├──────────────────────────┼──────────────────────┼──────────────────────────────────────┤
│ 1. 差异面板 (Diff View)  │ 【PASS】极致专注极简 │ 彻底切除行内工具栏与伪手风琴，单轨流 │
│                          │                      │ 转成熟预览 Tab，无新增冗余伪功能。   │
├──────────────────────────┼──────────────────────┼──────────────────────────────────────┤
│ 2. 笔记面板 (Note Panel) │ 【NEED-SIMPLIFY】    │ 底部灰块拔除彻底，但多文档管理塞入了 │
│                          │ 存在 4 处过度设计    │ 标签画饼、深度归档死逻辑与双重切换。 │
└──────────────────────────┴──────────────────────┴──────────────────────────────────────┘
```

- **差异面板（Diff View）**：在详案 01、02、03、04 中**真正做到了极致的专注与极简**。完全贯彻了“平直列表、去圆角、拔除行内工具行、超链接单轨开新 Tab”的用户裁决，把 Diff 视口无缝还给代码比对正文，全量文件查看完全委托给右侧成熟的 `FileViewerCard`，没有在别处衍生出任何新的冗余伪功能或弹窗；
- **笔记面板（Note Paper）**：在详案 05 中拔除底部双灰块（`MirrorDriftStatusBar` 与 `footer`）非常干净，32px 紧凑顶栏方向正确；但在详案 06 多笔记综合管理体系的设计中，**出现了明显的“过度设计与次要属性堆砌”**：
  1. 数据库建表与契约塞入了 `tags_json`，但整个 UI 没有任何标签增删改入口，属于典型的**“半吊子画饼功能”**；
  2. 数据库与后端保留了 `is_archived` 软删除逻辑，但前端砍掉假回收站后永远传 `hard_delete: true`，形成了**“后端与数据库的死逻辑残留”**；
  3. 界面同时设计了 **220px 侧栏抽屉（NoteSidebarDrawer）** 与 **顶栏下拉切换（NoteDocumentDropdown）**，造成双重切换控件内卷与认知分裂；
  4. 顶栏右侧常驻了高危低频的“清空笔记内容”红色垃圾桶按钮，多图标拥挤，反客为主冲淡了核心的沉浸式写作体验。

### 1.2 核心审查判定对比总表

| 方案编号与模块 | 审查维度 | 过度设计核查结论 | 是否存在伪功能/次要属性冗余 | 处置指令 |
| :--- | :--- | :---: | :---: | :--- |
| **详案 01 差异平直列表** | 列表拓扑与几何结构 | **极简合规** | 否（彻底清除 6px/8px 圆角与外留白） | **放行**：维持 32px 直角三大正交子域 |
| **详案 02 行内工具条拔除** | 代码比对视口专注度 | **极简合规** | 否（物理拔除 110 行工具栏与 6 个按钮） | **放行**：展开区纯净直挂 DiffCodeViewer |
| **详案 03 文件名超链接** | 独立预览流转通道 | **单轨合规** | 否（100% 接入已有 FileViewerCard Tab） | **放行**：Canonical Tab ID，无自造弹窗 |
| **详案 04 全域 Tokens** | SLoHT 悬停与色彩体系 | **极简合规** | 否（单层 hover 根治 4.94% 脏灰，清洗 Hex） | **放行**：严格遵从 §13-14 门禁 |
| **详案 05 笔记顶栏与底栏** | 视口释放与紧凑顶栏 | **基本合规** | 是（顶栏按钮过多，含高危清空按钮） | **精简**：拔除顶栏清空按钮，释放标题区 |
| **详案 06 多笔记综合管理** | SQLite 存储与管理 UI | **部分过度设计** | **是（存在 tags_json、is_archived、下拉抽屉双轨）** | **硬性瘦身**：砍 tags，砍归档，删 Dropdown |
| **详案 07 立体验证迁移** | 测试保护与防回潮门禁 | **严谨合规** | 否（正向迁移 + 负向清退断言闭环） | **放行**：同步更新瘦身后契约测试 |

---

## 二、差异面板审查：专注度与极简性判定（Pass）

### 2.1 行内工具条切除彻底性审查（释放 36px 视口，零伪功能残留）

#### 1. 现场代码对比与审查事实
在旧代码 [`apps/crish-desktop/src/components/diff/DiffCardFileList.tsx:219-328`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCardFileList.tsx#L219-L328) 中，每个展开文件内部生硬塞入了一个 36px 的行内工具条（`className={styles.inlineHeader}`），横向硬塞了 7 个控件：
- 单文件对比维度下拉菜单（`Select.inlineCompareSelect`）；
- 外部编辑器打开按钮（`ExternalLink`）；
- 复制 Git Patch 按钮（`FileDiff`）；
- 复制代码按钮（`Copy`）；
- 复制路径按钮（`Check` 图标误用）；
- 接受补丁写入磁盘按钮（`Check`）；
- 从列表拒绝按钮（`X`）。

#### 2. 纯粹性审查结论
- **100% 物理连根拔除**：详案 02 彻底将这整整 110 行 JSX 连根铲除，而不是采用 CSS `display: none` 掩耳盗铃；
- **伴生代码彻底净收敛**：
  - 样式表 [`DiffCard.module.css:374-436`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L374-L436) 中的 8 个废弃选择器（63 行 CSS）全量物理删除；
  - 父组件 `DiffCard.tsx` 中伴生的 4 个状态桥函数（`handleCopyCodeOfFile`, `acceptCurrentFile`, `rejectCurrentFile`, `useConfirmGate`）被彻底解耦拔除；
- **比对视口绝对专注**：展开后 `.diffPane` **直接且仅挂载** `{renderInlineDiffContent(f)}`（即 `DiffCodeViewer`），中间无任何多余横条、无额外按钮、无边距浪费，将垂直视口 100% 交给代码增删比对本身。

### 2.2 平直列表直角化与三大正交子域（零手风琴，零卡片孤岛）

#### 1. 审查表象与解耦事实
旧版差异面板采用卡片手风琴模式（`border-radius: 6px/8px`、`padding: 10px`、`gap: 8px`），把条目变成一块块漂浮的圆角孤岛，且将整行包装为单一的大 `<button>`，导致用户点击文件名时不仅无法打开独立预览，反而触发折叠展开。

#### 2. 纯粹性审查结论
- **纯直角平铺（Flat & Zero-Radius）**：详案 01 确立了 `border-radius: 0` 与无垂直间隙的平铺列表，条目之间仅通过内嵌投影 `box-shadow: inset 0 -1px 0 0 var(--border-subtle)` 分割，锁死 32px 偶数高度，呈现专业 IDE 级的高密度清爽质感；
- **三大正交子域清晰单轨**：
  - **子域 A（左侧）**：仅负责 Chevron 折叠/展开与状态徽章（16x16px 直角）；
  - **子域 B（中间）**：独立文件名超链接按钮（原生 `<button>`，点击严格在右侧打开独立预览 Tab）；
  - **子域 C（右侧）**：常驻等宽增减统计（`tabular-nums`，hover 时绝不暴力隐藏）+ 悬浮柔和浮现的 Git 暂存/放弃操作；
- **零过度设计交互**：三大子域各自独立响应点击，互不冒泡干扰，没有自造花哨的拖拽重排、多选批量合并等复杂衍生功能，保持了极度专注。

### 2.3 独立预览 Tab 单轨流转审查（拒绝自造弹窗/抽屉，零伪双轨）

#### 1. 架构流转审查
用户的要求是：“*点击差异的那个超链接是直接打开一个新的标签，名称就是对应的文件名称，也是有一个顶部的工具栏，下面主区域就是这个文件的预览了*”。

#### 2. 纯粹性审查结论
- **100% 复用系统成熟基础设施**：详案 03 严格遵从单轨真理源（SSOT），点击超链接直接调用系统统一通道 `openFileViewerInSession(filePath, 'diff')`，在右侧二叉树叶节点坞（Dock）中激活 `file-viewer:${normalizedPath}` 标签页；
- **坚决拒绝自造新轮子**：方案**坚决不自造任何独立的 Diff 弹窗（Modal）、侧边抽屉（Drawer）或气泡浮层（Popover）**，直接由系统已有的 `FileViewerCard` 接管展示；
- **Canonical Tab ID 根除重复分裂**：严禁把 `?mode=diff` 拼入 Tab ID，通过统一的绝对路径规约与 `conex:file-viewer-mode` 微事件派发，保证物理文件与 Tab 实例 1:1 绝对绑定，无同名 Tab 分裂。

### 2.4 破坏性伪实现的彻底清剿（accept/reject 假实现连根切除）

在 Git 模式下，旧代码在行内提供的“接受”按钮会重复调用打补丁逻辑导致源码损坏，“拒绝”按钮仅是在前端 filter 导致刷新后复活。
- **详案 02 彻底切除了这两个毒瘤按钮**；
- 将代码审查与落盘职责完全归位到合法的 Git 暂存（`git add` / `git reset` / `git checkout`）单轨链路；
- 差异面板不再承担“半吊子代码合并器”的越界职责，彻底杜绝了前端欺骗与数据破坏。

### 2.5 差异面板审查结论：达成极致专注与极简

> **【审查结论】：PASS（极简专注完全达标）**  
> 差异面板的 4 份分维详案（01、02、03、04）对用户“越简单越好”的指示贯彻得极为坚决、透彻：  
> - 删除了 110 行无用行内工具条；  
> - 废黜了圆角卡片手风琴，换装平直 32px 直角列表；  
> - 根治了双层 Hover 叠加导致的 4.94% 脏灰（SLoHT）；  
> - 超链接单轨直通系统右侧标签坞，零自造弹窗；  
> - **没有在任何别处搞出新的冗余伪功能，做到了极致专注。**

---

## 三、笔记面板审查：过度设计与次要属性深度排查（Need-Simplify）

相比于差异面板的干净专注，审计官在深入审查 `06-分维详案-多笔记综合管理体系与SQLite及IPC后端架构.md` 与 `05-分维详案` 时，发现方案塞入了多个**非核心的次要属性、画饼功能与冗余控件**。

用户明确指示：
> *“审查笔记面板：多笔记管理是否过度设计？是否塞入了过多的复杂次要属性（如复杂多标签树、深度归档逻辑、多层过滤），从而冲淡了核心的写作与管理体验？明确指出哪些功能属于‘过度设计/可删减内容’，给出精简建议。有就是有，没有别强行搞事情。”*

经地毯式代码审查，明确指出以下 **4 项过度设计与可删减内容**：

---

### 3.1 【过度设计 1 · 画饼式次要属性】：`tags_json` 标签体系的“半吊子过度设计”

#### 1. 现场确凿代码证据
在详案 06 中，多处注入了多标签支持：
- **SQLite 建表与加列**（`06-分维详案:239, 414`）：
  ```sql
  tags_json TEXT NOT NULL DEFAULT '[]'
  ```
- **Rust 领域模型**（`06-分维详案:609`）：
  ```rust
  pub tags: Vec<String>,
  ```
- **前端契约与搜索状态机**（`06-分维详案:1168, 1536`）：
  ```typescript
  export interface NoteDocumentMeta {
    // ...
    tags: string[];
  }

  // 状态机搜索匹配
  return documents.filter(
    (d) =>
      d.title.toLowerCase().includes(q) ||
      d.tags.some((t) => t.toLowerCase().includes(q)) // 标签匹配逻辑
  );
  ```

#### 2. 真实 UI 现状审查（画饼欺骗）
审查详案 06 中的全部 UI 组件源码（`NoteSidebarDrawer.tsx`、`NotePaperHeader.tsx`、`NotePaperStrictPanel.tsx`）：
- **没有打标签的任何 UI 控件**：新建笔记（`onCreateDoc`）只弹出一个输入标题或者直接创建，无标签输入框；
- **没有标签展示**：在侧栏卡片（`card`）中，只有标题、时间和块计数，**根本不渲染任何标签徽章**；
- **没有标签过滤树**：侧栏只有一个普通的标题搜索框，根本没有任何标签筛选器。

#### 3. 过度设计定性
用户在现场的诉求非常质朴：
> *“因为笔记不可能只有一个，以及笔记没有一个综合的管理界面，现在只能看一个类似于硬编码的标签界面了，这和展示没什么区别。”*（这里的“标签界面”是指 Conex 的 Tab 界面，用户意指只能看单篇笔记像个展示卡片）。

方案设计者却产生了“既然要做多笔记，就必须搞标签系统”的过度设计冲动，在底层数据库加了列、在 Rust 端加了序列化、在前端状态机加了匹配，但在 UI 上根本没有闭环！这属于典型的**“半吊子画饼属性”**，平白增加了数据库维护负担和序列化开销，冲淡了核心多文档管理的纯粹性。

---

### 3.2 【过度设计 2 · 残留死逻辑】：`is_archived` 深度归档与软删除死分支

#### 1. 现场确凿代码证据
详案 06 第 5.3 节声称：
> *“在前置独立方案中，侧栏底部画饼画了一个‘回收站’Tab，但前端状态机无 archivedDocuments 数组，后端无恢复接口，纯属欺骗性伪实现... 施工补丁实施纪律：彻底物理剔除假回收站；安全双阶段删除：用户点击卡片删除时，弹出原生确认模态框，确认后直接调用后端 note_document_delete 完成落盘删除。”*

然而，审查其底层与后端代码时发现，**软删除与归档逻辑根本没有彻底清退，残留在数据库与 Rust 接口中变成了死代码**：
- **SQLite DDL**（`06-分维详案:238, 413`）：
  ```sql
  is_archived INTEGER NOT NULL DEFAULT 0
  ```
- **复合索引包含该字段**（`06-分维详案:438`）：
  ```sql
  CREATE INDEX IF NOT EXISTS idx_doc_meta_listing 
      ON doc_meta(is_archived, is_pinned DESC, updated_at DESC);
  ```
- **Rust 后端依然保留分支**（`06-分维详案:833-847`）：
  ```rust
  pub fn delete_document(&self, doc_id: &str, hard_delete: bool) -> Result<bool, StoreError> {
      if !hard_delete {
          // 仍然保留软删除 UPDATE 逻辑！
          conn.execute("UPDATE doc_meta SET is_archived = 1 WHERE doc_id = ?1", params![doc_id])?;
          return Ok(true);
      }
      // 级联物理删除...
  }
  ```
- **IPC 命令依然暴露该参数**：`note_document_list` 依然接收 `include_archived: bool`，`note_document_delete` 依然接收 `hard_delete: bool`。

#### 2. 过度设计定性
既然前端已经明确砍掉了假回收站，且用户点击删除弹窗确认后就是直接抹除文档，那么后端和数据库中保留的 `is_archived`、软删除逻辑分支以及 `hard_delete` 参数，全部沦为**无人消费的“死逻辑过度设计”**！桌面单机工作区笔记不需要搞云端企业级多阶段垃圾回收协议，保留死分支严重违反了 [`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §7“架构净收敛”铁律。

---

### 3.3 【过度设计 3 · 双重切换内卷】：`NoteSidebarDrawer` 抽屉与 `NoteDocumentDropdown` 下拉的严重重叠

#### 1. 现场确凿代码证据
- 详案 06 第 5.1 节实现了 **220px 可折叠抽屉侧栏 `NoteSidebarDrawer.tsx`**（全量代码共 200+ 行，含全部笔记列表、搜索框、新建按钮、重命名、删除弹窗）；
- 详案 06 第 5.2 节同时又实现了 **顶栏下拉切换器 `NoteDocumentDropdown.tsx`**（全量代码共 130+ 行，含弹出 Popover、内部搜索框、文档列表、新建按钮）；
- 详案 06 宣称“Master-Detail 响应式”，企图在顶栏也放一个切换下拉框，在左侧又放一个侧栏抽屉。

#### 2. 方案间严重冲突事实
更荒谬的是，审查详案 05 中 `NotePaperStrictHeader.tsx:1172-1310` 的完整代码：
**详案 05 的顶栏中根本没有渲染 `NoteDocumentDropdown`，也没有渲染打开侧栏抽屉的按钮！**
详案 05 与详案 06 在顶栏的核心布局上各行其是，出现了严重的方案间分裂。

#### 3. 过度设计定性
在有限的工作区窗格中（通常仅 400px~700px 宽）：
- 侧栏抽屉（Drawer）已经提供了完整的列表、检索、新建、重命名、删除能力；
- 顶栏下拉（Dropdown）又强行塞入一个带有独立搜索框和新建按钮的 Popover 菜单；
- **两个功能几乎 100% 重叠的控件并存，是典型的“交互内卷与过度设计”**！这不仅增加了两套组件和样式表的维护成本，而且给用户带来了强烈的认知困惑（“我到底该点左边的抽屉还是点顶部的下拉？”）。

---

### 3.4 【过度设计 4 · 顶栏交互过载】：常驻“清空笔记”危险按钮与多重密集图标挤占标题编辑视口

#### 1. 现场确凿代码证据
查阅详案 05 中的 `NotePaperStrictHeader.tsx:1212-1308`：
顶栏右侧一口气排列了多达 7 个元素：
1. 等宽字数统计徽标（带有包含中文字符、英文单词、段落总数、总字符数的 4 行浮层 Tooltip）；
2. 复制全文 Markdown 按钮；
3. 导出为 Markdown 文件按钮；
4. 重新加载投影按钮；
5. **常驻“清空笔记内容”危险红色按钮（`variant="danger" icon={<Trash2 />}`，带二次确认弹窗 `ConfirmDialog`）**；
6. 分割线；
7. 关闭面板按钮。

#### 2. 交互压迫与认知冲淡
- **严重挤压核心标题视口**：在 360px~450px 窄屏分屏下，右侧密集图标群霸占了超过 180px 宽度，导致左侧最核心的 `EditableTitle`（行内标题编辑）被压缩到只剩几十像素，字还没打完就被 `...` 截断；
- **常驻清空按钮是极度危险且低频的过度设计**：普通笔记用户在日常写作中，谁会需要顶栏随时常驻一个“一键清空全文”的红色垃圾桶？用户清空内容用 `Ctrl+A -> Backspace` 即可，删除整篇笔记则在侧栏抽屉中操作。把“清空全文”这种毁灭性操作放在高频工具栏上，既增加了误触恐慌，又引入了不必要的 `ConfirmDialog` 状态机；
- **过度复杂的字数统计 Tooltip**：普通用户看一眼字数即可，在悬停中展示复杂的“中文字符、英文单词、段落总数、总字符数”纯属把研发阶段的度量算法过度暴露给用户。

---

## 四、对照 ANTI_OVERENGINEERING_GUARDRAILS.md 13 项禁令逐条检视

对照仓库权威红线指南 [`ANTI_OVERENGINEERING_GUARDRAILS.md`](file:///c:/Software/conex/ANTI_OVERENGINEERING_GUARDRAILS.md)，逐项审查 8 份重构方案的合规性：

| 禁令条目与红线要求 | 本次方案实施现场核查 | 判定 |
| :--- | :--- | :---: |
| **🚫 禁令 1：严禁编写跨平台 OS 内核级沙盒** | 方案无任何 `sandbox_init` 或 `seccomp` C 绑定，全量依赖既有命令守卫与 Job Object。 | **合规** |
| **🚫 禁令 2：严禁编写 Rust 端无锁环形缓冲区** | 文本传输统一基于 Tokio `mpsc` 与不可变共享，无底层 RingBuffer。 | **合规** |
| **🚫 禁令 3：严禁单机引入分布式共识协议 (2PC/Raft)** | 本地存储纯单写者 + SQLite WAL + CAS 乐观锁，无任何自造共识算法。 | **合规** |
| **🚫 禁令 4：严禁后台自动切换模型** | 差异与笔记纯属本地 UI 与存储重构，无模型路由相关逻辑。 | **合规** |
| **🚫 禁令 5：严禁出站请求前发起 DNS 异步解析** | 无任何网络请求前置 DNS 解析逻辑。 | **合规** |
| **🚫 禁令 6：严禁黑盒 Prompt 意图重写链** | 无大模型上下文拦截器介入。 | **合规** |
| **🚫 禁令 7：上下文全链路可审计与单一真相源 (SSOT)** | 严格确立 Canonical Tab ID（`file-viewer:${normalizedPath}`）与 SQLite 单轨真源。 | **合规** |
| **🚫 禁令 8：多 Provider 凭据零残留与安全隔离** | 不涉及凭据管理。 | **合规** |
| **🚫 禁令 9：严禁使用全系统滑动窗口断路器** | 无全局 CircuitBreaker，仅保留 500ms 赛马超时守护防假死。 | **合规** |
| **🚫 禁令 10：严禁设计 Tool 执行 6 阶段洋葱 Hook 链** | 差异面板去工具栏化，仅保留底层 Rust 基础命令直调。 | **合规** |
| **🚫 禁令 11：严禁同进程微服务套娃与 IPC 嵌套路由** | 4 大笔记 IPC 命令直接通过 `#[tauri::command]` 注册，直调 Store，零中转路由。 | **合规** |
| **🚫 禁令 12：严禁高频流式状态穿透全局 Store** | 状态机 `useNoteDocumentManager` 采用本地 State；外层绑定 `key={activeDocId}` 自然解耦。 | **合规** |
| **🚫 禁令 13：严禁移动端全量 CRDT 状态向量下沉** | 自研因果 Undo 与 Block 块模型受红线明确放行保护，且未引入外部重型同步框架。 | **合规** |

**自检总结**：方案在底层系统安全与架构禁令上 **100% 严格合规**，没有触碰任何系统级底座红线。但在**前端 UI 呈现与业务领域建模层面**，出现了本文第三章指出的次要属性蔓延与控件过度设计。

---

## 五、极简瘦身方案与架构净收敛改造指令（Directives）

为贯彻用户“越简单越好”、“避免功能伪实现”、“项目中的代码应该是清晰的、单轨的、最先进的代码”的最高指示，审计官签发如下 **4 项刚性架构瘦身改造指令**，必须在阶段六实施前彻底落实：

### 5.1 存储与领域模型瘦身：从 8 列收敛为 6 列极简权威真源

彻底清除没有任何 UI 闭环支撑的 `tags_json` 与死逻辑 `is_archived`：

#### 1. SQLite 建表 DDL 瘦身收敛（`migrate.rs`）
```sql
-- 彻底收敛后的 doc_meta 6 列极简表结构（净减少 2 个冗余字段与复杂索引）
CREATE TABLE IF NOT EXISTS doc_meta (
    doc_id TEXT PRIMARY KEY NOT NULL,
    rev INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    title TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    is_pinned INTEGER NOT NULL DEFAULT 0
);

-- 极简覆盖排序索引（去除 is_archived 冗余维度）
CREATE INDEX IF NOT EXISTS idx_doc_meta_listing 
    ON doc_meta(is_pinned DESC, updated_at DESC);
```

#### 2. 领域契约收敛
- Rust `document_meta.rs` 移除 `is_archived` 与 `tags`；
- 前端 `noteDocumentContracts.ts` 移除 `isArchived` 与 `tags`；
- 搜索过滤逻辑收敛为纯粹聚焦标题匹配：
  ```typescript
  const filteredDocuments = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return documents;
    return documents.filter((d) => d.title.toLowerCase().includes(q));
  }, [documents, searchQuery]);
  ```

### 5.2 交互通道单轨收敛：物理拔除 `NoteDocumentDropdown`，独尊 220px 抽屉

坚决消灭双重切换控件内卷，确立唯一的单轨管理界面：
1. **物理删除冗余文件**：
   - 彻底删除 `apps/crish-desktop/src/components/note-paper/NoteDocumentDropdown.tsx`；
   - 彻底删除 `apps/crish-desktop/src/components/note-paper/NoteDocumentDropdown.module.css`；
   - **净消除代码 200+ 行！**
2. **顶栏左侧收敛**：
   在顶栏左侧仅放置两个元素：
   - 侧栏开关按钮：`<IconButton icon={<Lucide.PanelLeft size={14} />} onClick={() => setIsSidebarOpen(!isSidebarOpen)} tooltip="笔记管理 (Ctrl+\)" />`；
   - 可编辑标题：`<EditableTitle title={title} onRename={onRenameTitle} />`；
3. **管理职能独尊 220px 抽屉（NoteSidebarDrawer）**：
   多文档的所有管理交互（列表流转、即时搜索、新建笔记、置顶展示、行内重命名、删除二次确认）100% 收敛在侧栏抽屉中完成，界面层次分明、心智统一。

### 5.3 顶栏纯净化：拔除清空按钮，释放 `EditableTitle` 呼吸空间

1. **物理拔除“清空笔记”危险按钮**：
   - 从 `NotePaperStrictHeader.tsx` 中彻底删除 `onClearDoc` 属性、垃圾桶图标按钮以及 `ConfirmDialog` 弹窗；
   - 消除用户的误触恐慌，净化组件状态；
2. **合并 / 精简右侧按钮组**：
   - 仅保留：字数统计徽章（普通文本展示，无需弹 4 行复杂参数）、复制全文 Markdown 按钮、导出 Markdown 按钮、刷新按钮、关闭按钮；
   - 右侧占用宽度从 180px 骤降至 90px 以内；
3. **标题编辑区获得 100% 充裕视口**：
   中间的 `EditableTitle` 获得完整的自适应弹性宽度（`flex: 1 1 auto; min-width: 120px;`），长标题清晰完整展示，不再被挤成省略号。

### 5.4 软删除死逻辑物理清退：硬删除单轨闭环

1. **后端清退软删除分支**：
   `WorkspaceStore::delete_document` 签名简化为 `pub fn delete_document(&self, doc_id: &str) -> Result<bool, StoreError>`；
   直接在单个事务中级联物理清理 `doc_meta`、`blocks`、`blocks_fts` 等 9 张关联表，不留任何墓碑记录；
2. **IPC 命令简化**：
   `note_document_list` 不再接收 `include_archived` 参数；
   `note_document_delete` 不再接收 `hard_delete` 参数；
   状态机与前端调用彻底纯净化。

---

## 六、审计裁决签发与结论声明

### 6.1 审查问题直接答复

针对主控 Agent 派发的三项具体审计问题，本审计官给出确凿、不含糊的判定：

1. **审查差异面板：是否做到了极致的专注与极简？有没有在别处搞出新的冗余伪功能？**  
   **【答复】**：**是，做到了极致专注。** 物理切除了 110 行行内工具栏与 6 个杂糅按钮；平直列表直角化消灭了卡片孤岛；SLoHT 单层 hover 根除了 4.94% 脏灰；文件名超链接单轨接入系统成熟的独立 Tab，没有在任何别处自造弹窗、浮层或新的冗余伪功能。
2. **审查笔记面板：多笔记管理是否过度设计？是否塞入了过多的复杂次要属性从而冲淡了核心体验？**  
   **【答复】**：**是，存在明显的过度设计与次要属性堆砌。** 确凿指出了：
   - `tags_json` 标签体系（底层加列加逻辑，UI 零入口，属于半吊子画饼）；
   - `is_archived` 深度归档（前端砍掉假回收站，后端与数据库却留存软删除死逻辑）；
   - 侧栏抽屉与顶栏下拉双重切换控件并存，功能重叠导致认知混乱；
   - 顶栏常驻低频高危的“清空笔记”红色按钮，多图标过载挤压核心标题编辑区。
3. **明确指出哪些功能属于“过度设计/可删减内容”，给出精简建议。有就是有，没有别强行搞事情。**  
   **【答复】**：已在第五章出具了精确的代码级精简指令：
   - 删减 `tags_json` 与相关搜索逻辑；
   - 删减 `is_archived` 与软删除分支，确立极简硬删除单轨；
   - 物理拔除 `NoteDocumentDropdown.tsx` 及其样式表，单轨保留 220px 抽屉；
   - 拔除顶栏“清空笔记”按钮，释放标题编辑视口。

### 6.2 裁决签字盖章

```
========================================================================================
           战役：差异面板与笔记面板系统性重构 —— 反过度设计与极简纯粹性终审裁决
========================================================================================
 审计官角色：反过度设计与极简纯粹性终审官 (Anti-Overengineering & Simplicity Auditor)
 审计结论：
   - 差异面板：【PASS】准入放行，极致专注，零冗余伪功能；
   - 笔记面板：【CONDITIONAL PASS / NEED-SIMPLIFY】条件性准入，必须按本报告第五章指令
               实施 4 项精准瘦身（砍 tags、砍归档死逻辑、拔除 Dropdown、清退顶栏清空按钮），
               使代码净收敛达标后，方可进入阶段六施工。
 签署日期：2026-09-05
========================================================================================
```
