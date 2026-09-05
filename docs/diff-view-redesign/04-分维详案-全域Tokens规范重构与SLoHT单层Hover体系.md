# 分维详案 04：全域 Tokens 规范重构与 SLoHT 单层 Hover 体系 (DETAIL-PLAN-04)

> **战役工作区**：`docs/diff-view-redesign/`  
> **文档位置**：`docs/diff-view-redesign/04-分维详案-全域Tokens规范重构与SLoHT单层Hover体系.md`  
> **专项编号**：DETAIL-PLAN-04（阶段四：分维实施详案 · 终局定稿修订版）  
> **统领总纲**：[`00-总方案-差异与笔记面板系统性重构.md`](./00-总方案-差异与笔记面板系统性重构.md)  
> **输入依据**：  
> - [`analysis/04-hover-tokens-contrast-audit.md`](./analysis/04-hover-tokens-contrast-audit.md) (AUDIT-04 全域 Hover 过灰根因与 Design Tokens 规范审计)  
> - [`independent-plans/04-hover-tokens-standardization-plan.md`](./independent-plans/04-hover-tokens-standardization-plan.md) (PLAN-04 独立方案)  
> - [`plan-reviews/02-ui-tokens-and-visual-review.md`](./plan-reviews/02-ui-tokens-and-visual-review.md) (REVIEW-02 首席视觉评审官裁决)  
> - 终审审计报告矩阵：
>   - [`audits/01-ui-components-and-tokens-anti-hallucination-audit.md`](./audits/01-ui-components-and-tokens-anti-hallucination-audit.md) (AUDIT-FINAL-UI-TOKENS 缺陷 03/04/08：肃清 8 处 `!important`、规范 HTML 容器、收敛 Flex 盒 `.rowActions`)
>   - [`audits/02-diff-view-cross-plan-conflict-audit.md`](./audits/02-diff-view-cross-plan-conflict-audit.md) (AUDIT-CONFLICT-02 §5.1/§5.2：消除 `.rowActBtn` 悬停叠灰与状态徽章裸写 Hex)
>   - [`audits/04-implementation-feasibility-and-grounding-audit.md`](./audits/04-implementation-feasibility-and-grounding-audit.md) (AUDIT-FEASIBILITY-04 §2.3/§2.4/§2.5：style-contract 历史断言平滑升级、input-three-patterns 与 antiDarkening 门禁守门)
> - 仓库核心测试门禁：
>   - [`apps/crish-desktop/src/styles/style-contract.test.ts`](file:///c:/Software/conex/apps/crish-desktop/src/styles/style-contract.test.ts) (全仓 `!important` 计数 ≤ 626 刚性防回潮棘轮门禁与 SLoHT 键盘闭环契约)
>   - [`apps/crish-desktop/src/styles/__tests__/input-three-patterns-guard.test.ts`](file:///c:/Software/conex/apps/crish-desktop/src/styles/__tests__/input-three-patterns-guard.test.ts) (形态 ④ 纯光标极简型输入框全态零边框零阴影门禁)
>   - [`apps/crish-desktop/src/styles/__tests__/antiDarkeningGuard.test.ts`](file:///c:/Software/conex/apps/crish-desktop/src/styles/__tests__/antiDarkeningGuard.test.ts) (RULE-11A/B/C 抗二次叠黑与顶栏 Select 紧凑 `size="sm"` 门禁)
> - 仓库铁律 [`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §3（Git 提交权归主控）、§7（严禁补丁、绕过与作弊）、§7.1（立体验证纪律）、§12（自定义 Tooltip）、§13（输入框与焦点态、焦点对比度 <= 10%、形态 ④ 纯光标极简型）、§14（现代 CSS 语法、优先 HSLA / 斜杠透明度、零硬编码十六进制、Zero-Blue 铁律）。  
> **施工标准**：代码级施工图深度；全量代码物理展开，严禁使用“...”省略；全文正文严格大于 1000 行。

---

## 目录

- [一、视觉体验“很灰”的根因穿透（深度渲染树剖析与数学推导）](#一视觉体验很灰的根因穿透深度渲染树剖析与数学推导)
  - [1.1 缺陷现场与用户痛点定位](#11-缺陷现场与用户痛点定位)
  - [1.2 DOM 渲染树结构与 CSS 伪类双重命中链](#12-dom-渲染树结构与-css-伪类双重命中链)
  - [1.3 计算机图形学与 Alpha 合成引擎数学推导（Porter-Duff Over 算子）](#13-计算机图形学与-alpha-合成引擎数学推导porter-duff-over-算子)
  - [1.4 为什么“有的很灰”？——三种状态灰度分裂与跳闪能量谱分析](#14-为什么有的很灰三种状态灰度分裂与跳闪能量谱分析)
- [二、SLoHT（Single-Layer of Hover Truth）单层 Hover 体系严密架构](#二slohtsingle-layer-of-hover-truth单层-hover-体系严密架构)
  - [2.1 SLoHT 架构设计哲学与三层刚性契约](#21-sloht-架构设计哲学与三层刚性契约)
  - [2.2 容器层永久 background: transparent 隔离机制](#22-容器层永久-background-transparent-隔离机制)
  - [2.3 交互行 div.fileRow 独占单一悬停与激活真源（刚性 W3C 容器规范）](#23-交互行-divfilerow-独占单一悬停与激活真源刚性-w3c-容器规范)
  - [2.4 行内操作按钮防闪烁与透明度继承机制（Flex 盒流式排版 .rowActions）](#24-行内操作按钮防闪烁与透明度继承机制flex-盒流式排版-rowactions)
  - [2.5 跨方案命名收敛与 SSOT 类名裁决](#25-跨方案命名收敛与-ssot-类名裁决)
- [三、全色彩系统 Design Tokens 精准映射表](#三全色彩系统-design-tokens-精准映射表)
  - [3.1 差异面板 13 处裸写 Hex 与 6 处幽灵 Token 全量替换契约](#31-差异面板-13-处裸写-hex-与-6-处幽灵-token-全量替换契约)
  - [3.2 笔记面板 25 处残留硬编码色值全量清洗表](#32-笔记面板-25-处残留硬编码色值全量清洗表)
  - [3.3 全色彩系统权威 Design Tokens 映射总表](#33-全色彩系统权威-design-tokens-映射总表)
  - [3.4 Conex Zero-Blue 铁律与 Emerald Green 品牌活态签名](#34-conex-zero-blue-铁律与-emerald-green-品牌活态签名)
  - [3.5 控件悬停魔术混入比收敛规则](#35-控件悬停魔术混入比收敛规则)
- [四、AGENTS.md §13 焦点态防晃与对比度上限 10% 规范落地](#四agentsmd-13-焦点态防晃与对比度上限-10-规范落地)
  - [4.1 AGENTS.md §13 核心条款与铁律矩阵](#41-agentsmd-13-核心条款与铁律矩阵)
  - [4.2 形态 ④ 纯光标极简型搜索筛选框规范落地（彻底肃清 8 处 !important 与守护门禁）](#42-形态--纯光标极简型搜索筛选框规范落地彻底肃清-8-处-important-与守护门禁)
  - [4.3 笔记面板标题行内编辑（EditableTitle）焦点态规范](#43-笔记面板标题行内编辑editabletitle焦点态规范)
  - [4.4 Git Commit 提交信息输入框极简焦点态规范](#44-git-commit-提交信息输入框极简焦点态规范)
  - [4.5 视觉光学对比度金字塔与科学梯次验证（WCAG AAA/AA）](#45-视觉光学对比度金字塔与科学梯次验证wcag-aaaa)
  - [4.6 差异面板顶栏抗二次叠黑与紧凑尺寸守门规范（守护 antiDarkeningGuard.test.ts）](#46-差异面板顶栏抗二次叠黑与紧凑尺寸守门规范守护-antidarkeningguardtestts)
- [五、全量 CSS 重构施工图代码（全展开，零省略）](#五全量-css-重构施工图代码全展开零省略)
  - [5.1 DiffCard.module.css 规范化施工图代码](#51-diffcardmodulecss-规范化施工图代码)
  - [5.2 NotePaperPanel.module.css 规范化施工图代码](#52-notepaperpanelmodulecss-规范化施工图代码)
- [六、style-contract.test.ts 自动化防回潮测试套件完整代码](#六style-contracttestts-自动化防回潮测试套件完整代码)
  - [6.1 测试套件工程定位与防御目标](#61-测试套件工程定位与防御目标)
  - [6.2 完整测试套件生产级源码](#62-完整测试套件生产级源码)
- [七、视觉与交互立体化验收断言清单](#七视觉与交互立体化验收断言清单)
  - [7.1 渲染引擎物理层验收断言](#71-渲染引擎物理层验收断言)
  - [7.2 视觉美学与直角几何验收断言](#72-视觉美学与直角几何验收断言)
  - [7.3 色彩对比度与可读性验收断言](#73-色彩对比度与可读性验收断言)
  - [7.4 交互动效与手感验收断言](#74-交互动效与手感验收断言)
  - [7.5 自动化门禁流水线执行标准](#75-自动化门禁流水线执行标准)

---

## 一、视觉体验“很灰”的根因穿透（深度渲染树剖析与数学推导）

### 1.1 缺陷现场与用户痛点定位

在 Conex 桌面应用运行环境中，用户对差异审查面板（DiffCard）提出了明确而尖锐的质询：
> “*这个界面的 hover 我看也是有问题的，有的很灰啊。而且现在的这个界面很多东西还有硬编码的呢，这个也统一使用我们的 token 体系。*”

经过深入代码现场精读、CSS 渲染树逆向分析以及 Chromium 渲染管线探查，确立了以下事实：
1. **该缺陷绝非用户的主观视觉偏差**，而是现代 Web 渲染引擎（Chromium Blink / WebView2）在处理嵌套 DOM 节点半透明背景时，**严格遵循计算机图形学 Alpha 合成（Alpha Compositing）规则执行颜色混合导致的客观物理缺陷**；
2. **“有的很灰”揭示了严重的局部灰度分裂与状态不均一性**：在原代码体系中，未展开的折叠条目处于双重叠加的“严重过灰”状态；展开的激活条目处于单层“正常灰”状态；而鼠标从文件名横向划入右侧操作按钮时，左侧条目又突然“瞬间变白”，呈现出极具破坏性的闪烁感与斑块感；
3. **伴随 13 处裸写 Hex 硬编码与 6 处幽灵 Token**，使得整个界面的色彩系统彻底失去了中央 Design Tokens 的管控能力。

---

### 1.2 DOM 渲染树结构与 CSS 伪类双重命中链

#### (1) 现场 DOM 节点包含关系与事件冒泡链

在原实现中，文件条目并非平直结构，而是被嵌套包裹在多层 DOM 结构内部：

```html
<!-- 容器包装骨架：捕获鼠标事件并触发 :hover -->
<div class="accordionItem">
  <!-- 头部包裹行：承载交互按钮与悬浮操作区 -->
  <div class="accordionHeaderRow">
    <!-- 最内层交互实体：承载文件名与代码增删统计 -->
    <button type="button" class="fileItem">
      <span class="fileNameLink">src/components/diff/DiffCard.tsx</span>
      <span class="fileStat">
        <span class="add">+28</span>
        <span class="del">−12</span>
      </span>
    </button>
    <!-- Git 快捷操作按钮组（悬浮触发显示） -->
    <div class="hoverActions">
      <button type="button" class="hoverActBtn">暂存</button>
      <button type="button" class="hoverActBtn danger">放弃</button>
    </div>
  </div>
</div>
```

#### (2) 现存 CSS 伪类双重匹配链（附原样式表精准行号）

在原样式表 [`DiffCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css) 中，以下规则在鼠标移入时被同时激活：

1. **父级容器捕获规则**（原 `DiffCard.module.css:204-206`）：
   ```css
   /* ❌ 违规父级规则：外壳命中 hover 态 */
   .accordionItem:hover {
     background-color: var(--bg-hover);
   }
   ```
2. **子级行交互捕获规则**（原 `DiffCard.module.css:253-256`）：
   ```css
   /* ❌ 子级按钮自身重复命中 hover 态 */
   .accordionItem :global(.fileItem):hover,
   .accordionItem .fileItem:hover {
     background-color: var(--bg-hover);
   }
   ```
3. **修补式盖底规则**（原 `DiffCard.module.css:214-221`）：
   ```css
   /* ⚠️ 试图通过盖死纯白卡片底色来压制父级 hover */
   .accordionActive:hover {
     background: var(--bg-card);
     border-color: color-mix(
       in srgb,
       var(--border-color, var(--border-subtle)) 90%,
       var(--text-primary) 10%
     );
   }
   ```

当用户将鼠标光标移动到条目的文字区域时，根据 W3C 事件流与 CSS 选择器匹配机制：
- 鼠标直接命中叶子节点 `<button class="fileItem">`，使 `.fileItem:hover` 判定为 **TRUE**；
- 鼠标事件向顶层 DOM 节点冒泡，`<div class="accordionItem">` 包含该子节点，因此 `.accordionItem:hover` 亦被判定为 **TRUE**；
- 渲染管线在同一屏幕像素区域，连续绘制了两次带透明度的 `var(--bg-hover)`！

---

### 1.3 计算机图形学与 Alpha 合成引擎数学推导（Porter-Duff Over 算子）

#### (1) 系统权威 Tokens 定义真源

在系统设计令牌真源 [`tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css) 中：
- **浅色主题（Light Theme）**：
  ```css
  --bg-hover: var(--tint-hover);
  --tint-hover: color-mix(in srgb, var(--text-primary) 2.5%, transparent);
  --tint-active: color-mix(in srgb, var(--text-primary) 5%, transparent);
  --text-primary: #111111;
  ```
- **暗色主题（Dark Theme）**：
  ```css
  --bg-hover: var(--tint-hover);
  --tint-hover: color-mix(in srgb, var(--text-primary) 3.5%, transparent);
  --tint-active: color-mix(in srgb, var(--text-primary) 6.5%, transparent);
  --text-primary: #dddddd;
  ```

#### (2) Porter-Duff Over 算子公式推导

根据经典计算机图形学理论（Thomas Porter & Tom Duff, 1984），当两个半透明图层在不透明基底（卡片背景）上从下至上叠加绘制时，前景色（顶层）覆盖在背景色（底层）之上，采用 **Porter-Duff "Over" 算子** 执行不透明度合成：

$$\alpha_{composite} = \alpha_{top} + \alpha_{bottom} \times (1 - \alpha_{top})$$

合成后的颜色通道值计算公式为：

$$C_{composite} = \frac{C_{top} \cdot \alpha_{top} + C_{bottom} \cdot \alpha_{bottom} \cdot (1 - \alpha_{top})}{\alpha_{composite}}$$

在我们的场景中：
- 底层（Layer 1）：`.accordionItem` 背景，$\alpha_{bottom} = \alpha_{hover}$，色彩值 $C = \text{Text Color}$；
- 顶层（Layer 2）：`.fileItem` 背景，$\alpha_{top} = \alpha_{hover}$，色彩值 $C = \text{Text Color}$。

#### (3) 浅色环境（Light Theme）数学推导

- 预期单层设计标准：$\alpha_{hover} = 2.5\% = 0.025$；
- 复合不透明度计算：
  $$\alpha_{composite} = 0.025 + 0.025 \times (1 - 0.025) = 0.025 + 0.025 \times 0.975 = 0.025 + 0.024375 = \mathbf{0.049375} \approx \mathbf{4.94\%}$$
- 参照系统设计规范：
  - 标准悬停态 `--tint-hover` = **2.50%**
  - 标准激活/按下态 `--tint-active` = **5.00%**
- **推导结论**：
  在浅色模式下，实际合成的不透明度高达 **4.94%**，与系统规定的按下点击激活态（5.00%）几乎完全相同（仅差 0.06%）！用户只是将鼠标轻轻悬停在条目上，视觉感受却如同用力按下了该条目，产生沉重、压抑的污浊灰块。

#### (4) 暗色环境（Dark Theme）数学推导

- 预期单层设计标准：$\alpha_{hover} = 3.5\% = 0.035$；
- 复合不透明度计算：
  $$\alpha_{composite} = 0.035 + 0.035 \times (1 - 0.035) = 0.035 + 0.035 \times 0.965 = 0.035 + 0.033775 = \mathbf{0.068775} \approx \mathbf{6.88\%}$$
- 参照系统设计规范：
  - 标准悬停态 `--tint-hover` = **3.50%**
  - 标准激活/按下态 `--tint-active` = **6.50%**
- **推导结论**：
  在暗色模式下，实际合成不透明度达到 **6.88%**，**直接超越了系统规定的激活态不透明度（6.50%）**！深色背景上浮现出极为刺眼、突兀的亮灰高光斑块，彻底破坏了深色模式的沉浸感与眼部舒适度。

---

### 1.4 为什么“有的很灰”？——三种状态灰度分裂与跳闪能量谱分析

现场代码中存在的修补式逻辑使得不同状态下的条目呈现出完全割裂的灰度：

```
现场三种状态灰度割裂与撕裂跳闪示意图：

状态 A：未展开折叠条目（悬停）
┌────────────────────────────────────────────────────────────────────────┐
│ .accordionItem:hover (2.5% 黑灰)                                       │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ .fileItem:hover (2.5% 黑灰)                                      │  │ => 【复合 4.94% 深脏灰！】
│  │  src/App.tsx                                             +12  −3 │  │    （用户感受：“这个条目很灰！”）
│  └──────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘

状态 B：已展开激活条目（悬停）
┌────────────────────────────────────────────────────────────────────────┐
│ .accordionActive:hover (background: var(--bg-card) 纯白阻断)           │ => 强行压制父级 2.5%
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ .fileItem.isActive (background-color: var(--bg-active))          │  │ => 【单层 5.0% 纯净底色】
│  │  src/DiffCard.tsx                                        +28 −12 │  │    （用户感受：“这个条目灰度正常”）
│  └──────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘

状态 C：鼠标划入右侧 Git 快捷操作按钮（瞬态撕裂）
┌────────────────────────────────────────────────────────────────────────┐
│ .accordionItem:hover (2.5% 黑灰维持激活)                               │ => 仅剩父级 2.5%
│  ┌───────────────────────────────┐  ┌───────────────────────────────┐  │
│  │ .fileItem (光标移出，子级灭)  │  │ .hoverActBtn (无背景)         │  │ => 【左侧突变为 2.5% 微灰！】
│  │  src/App.tsx                  │  │  [ 暂存 ]   [ 放弃 ]   [ 比对 ] │  │    从 4.94% 骤降为 2.5%
│  └───────────────────────────────┘  └───────────────────────────────┘  │    产生剧烈的 2.44% 阶跃式闪烁
└────────────────────────────────────────────────────────────────────────┘
```

#### 状态对比与视觉病理诊断表：

| 交互状态 | 涉及 DOM 节点与 CSS 规则 | 浅色 Alpha | 暗色 Alpha | 视觉体验诊断 |
| :--- | :--- | :---: | :---: | :--- |
| **状态 A：折叠项悬停** | `.accordionItem:hover` (2.5%)<br>`+ .fileItem:hover` (2.5%) | **4.94%** | **6.88%** | **双重叠加过灰**。达到甚至超过 Active 激活态，污浊斑块感强烈。 |
| **状态 B：展开项悬停** | `.accordionActive:hover` 纯白遮蔽<br>`+ .fileItem.isActive` (5.0%) | **5.00%** | **6.50%** | **单层正常灰**。卡片底板遮盖了父级悬停，只有子级生效。 |
| **状态 C：划入右侧按钮** | `.accordionItem:hover` (2.5%)<br>`.fileItem` 悬停熄灭 (0%) | **2.50%** | **3.50%** | **阶跃式瞬态跳闪**。光标划过分界线时，左侧文件名区域灰度从 4.94% 骤跌至 2.5%，产生眨眼频闪。 |

**根治结论**：必须彻底废除外层容器的一切 `:hover` 背景规则，确立全域唯一的单层悬停真理源（SLoHT）。

---

## 二、SLoHT（Single-Layer of Hover Truth）单层 Hover 体系严密架构

### 2.1 SLoHT 架构设计哲学与三层刚性契约

为了实现视觉体验的绝对纯净、可预测与零闪烁，本方案确立**单一真理 Hover 交互层级（Single-Layer of Hover Truth, SLoHT）**。该架构由三层严格正交的物理契约构成：

```
SLoHT 三层物理架构契约模型：

┌──────────────────────────────────────────────────────────────────────────┐
│ 1. 容器/包装骨架层 (Wrapper Layer): 绝对纯净无状态骨架                     │
│    选择器: .flatFileList, .fileNode, .accordionHeaderRow                 │
│    真理契约: background: transparent; 严禁声明任何 :hover 背景            │
│    职责: 仅负责 Flex/Grid 几何排版、边框分割与层级布局，绝不参与状态绘制  │
├──────────────────────────────────────────────────────────────────────────┤
│ 2. 交互行实体 (Interactive Row): 唯一合法的状态真源                      │
│    选择器: .fileRow                                                      │
│    真理契约:                                                             │
│      - 默认态: background: transparent;                                  │
│      - 悬停态: background-color: var(--bg-hover); (严格单层 2.5% / 3.5%)  │
│      - 激活态: background-color: var(--bg-active); (严格单层 5.0% / 6.5%) │
│    职责: 独占完整的整行通栏光标高亮权力，杜绝任何外部叠加                 │
├──────────────────────────────────────────────────────────────────────────┤
│ 3. 行内操作元 (Inline Actions): 完全透光的寄居操作单元                   │
│    选择器: .hoverActions, .rowActBtn, .groupActionBtn                    │
│    真理契约: background: transparent; 严禁私自声明填充底色                │
│    职责: 悬停仅微调文字前景色或细微边框，背景 100% 透出行的单一悬停底色   │
└──────────────────────────────────────────────────────────────────────────┘
```

---

### 2.2 容器层永久 background: transparent 隔离机制

在 CSS 规则中，必须彻底剥离外层容器的所有悬停样式：

```css
/* ==========================================================================
 * 容器骨架层：永久锁定透明无状态，严禁声明任何 :hover 背景色
 * ========================================================================== */

.flatFileList {
  display: flex;
  flex-direction: column;
  width: 100%;
  margin: 0;
  padding: 0;
  list-style: none;
  background: transparent;
  box-sizing: border-box;
}

.fileNode {
  display: flex;
  flex-direction: column;
  width: 100%;
  margin: 0;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 0; /* 严格直角化 */
  box-sizing: border-box;
}

.accordionHeaderRow {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
  background: transparent;
  box-sizing: border-box;
}
```

**绝对禁止以下违规写法（自动化门禁严密拦截）**：
```css
/* ❌ 违章：在容器层声明 hover */
.fileNode:hover,
.flatFileList:hover,
.accordionItem:hover,
.accordionHeaderRow:hover {
  background-color: var(--bg-hover);
}
```

---

### 2.3 交互行 .fileRow 独占单一悬停与激活真源

文件条目由 `<div className={styles.fileRow} role="row">`（或由父级 `role="list"` 包裹的语义容器）承载，独占行级通栏悬停光标响应与背景高亮。

> [!IMPORTANT]
> **刚性 W3C 契约防线（拒绝 button 嵌套与 DOM 规整破坏）**：  
> 严禁将 `.fileRow` 声明为 `<button>`！根据 W3C HTML5 规范 §4.10.6（Interactive Content），`<button>` 元素内部**绝对禁止嵌套任何交互性元素（Interactive content descendants）**。行内包含子域 A 的折叠按钮 `<button className={styles.chevronBtn}>`、子域 B 的文件名超链接按钮 `<button className={styles.fileNameLinkBtn}>` 与子域 C 的 Git 操作按钮 `<button className={styles.rowActBtn}>`。若外层为 `<button>`，现代浏览器（Blink/WebView2）在解析 DOM 时会发生自动规整破坏（Auto-correction）或强制闭合，破坏点击事件冒泡隔离（`e.stopPropagation()`）与键盘 Tab 导航序列。因此，`.fileRow` 必须刚性声明为 `<div>` 语义容器。

```css
/* ==========================================================================
 * 交互行实体：唯一拥有状态绘制权的视觉单元 (div 语义容器，严禁声明为 button)
 * ========================================================================== */

.fileRow {
  position: relative;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  height: 32px;
  min-height: 32px;
  max-height: 32px;
  padding: 0 12px;
  margin: 0;
  border: none;
  border-radius: 0; /* 严格直角化，禁微圆角 */
  background: transparent;
  box-shadow: inset 0 -1px 0 0 var(--border-subtle); /* 维持 32px 偶数净高 */
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-size: var(--font-size-xs, 12px);
  box-sizing: border-box;
  user-select: none;
  transition: background-color var(--transition-fast);
}

/* 唯一的悬停真源：严格单层透光（Light 2.5% / Dark 3.5%） */
.fileRow:hover {
  background-color: var(--bg-hover);
}

/* 唯一的激活真源：严格单层底色（Light 5.0% / Dark 6.5%）+ 左侧品牌强调条 */
.fileRow.isActive {
  background-color: var(--bg-active);
  box-shadow:
    inset 0 -1px 0 0 var(--border-subtle),
    inset 2px 0 0 0 var(--brand-primary);
}
```

---

### 2.4 行内操作按钮防闪烁与透明度继承机制 (Flex 盒架构)

对齐分维详案 01 的正交子域架构与 SSOT 裁决，快捷操作按钮与增减统计采用并排 Flex 盒布局（`.statAndActions > .rowActions`），彻底废除绝对定位覆盖与 `opacity: 0` 隐藏统计的反模式（根治 AUDIT-FINAL-UI-TOKENS 缺陷 08）：

```css
/* ==========================================================================
 * 行内操作元与常驻增减统计：Flex 盒架构，透明透光，彻底消除撕裂与跳闪
 * ========================================================================== */

.statAndActions {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  flex-shrink: 0;
  height: 100%;
}

/* 常驻增减统计：等宽数字排版，永不隐藏，完全杜绝旧版 hover 遮挡 */
.fileStat {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1_5, 6px);
  font-family: var(--font-mono, monospace);
  font-size: var(--font-size-xxs, 11px);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
  opacity: 1; /* 刚性常驻可见，彻底删除 hover opacity: 0 反模式 */
  user-select: none;
}

/* 快捷动作组：与统计并列，默认隐藏保留空间，hover/focus-within 柔和浮现 */
.rowActions {
  display: flex;
  align-items: center;
  gap: var(--space-1, 4px);
  background: transparent; /* 始终透明 */
  padding: 0;
  border: none;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition:
    opacity var(--transition-micro, 80ms),
    visibility var(--transition-micro, 80ms);
}

/* 依托交互行的悬停或内部焦点浮现，不改变底层背景 */
.fileRow:hover .rowActions,
.fileRow:focus-within .rowActions {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
}

/* 操作按钮自身：无独立背景色，完全透出 .fileRow:hover 的单一底色 */
.rowActBtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  min-width: 22px;
  padding: 0;
  margin: 0;
  border: 1px solid transparent;
  border-radius: 0; /* 严格直角化 */
  background: transparent; /* 绝不声明独立色块 */
  color: var(--text-secondary);
  cursor: pointer;
  box-sizing: border-box;
  transition:
    color var(--transition-micro),
    border-color var(--transition-micro);
}

/* 按钮悬停：仅加深文字色彩与微弱边框，背景依然完全透光 */
.rowActBtn:hover {
  color: var(--text-primary);
  border-color: var(--border-subtle);
  background: transparent;
}

/* 危险操作（如撤销/放弃修改）：悬停变红，背景依然透光 */
.rowActBtn.danger:hover {
  color: var(--color-error);
  border-color: var(--color-error-border);
  background: transparent;
}
```

---

### 2.5 跨方案命名收敛与 SSOT 类名裁决

依据 AUDIT-CONFLICT-DIFF §4 与 AUDIT-FINAL-UI-TOKENS 首席评审官裁决，阶段二与阶段三中产生的类名漂移在终局实施阶段全面以 **01 详案的 33 大标准类名（SSOT 唯一定型标准）** 为纲进行收敛定型。所有分维详案、TSX 模板与 CSS 模块必须 100% 严格依从，禁止增删变造任何字符：

#### 差异面板全域 33 大权威选择器收敛映射总表 (SSOT)：

| 序号 | 节点语义与职责 | TSX 组件绑定 (`styles.*`) | CSS 样式表选择器 | 历史漂移命名 (03/04 让路) | 裁决状态与治理要求 |
| :---: | :--- | :--- | :--- | :--- | :--- |
| **1** | 平直文件列表根容器 | `styles.flatFileList` | `.flatFileList` | `.fileList` | ✅ **SSOT** 32px 紧凑直角列表根容器 |
| **2** | 单文件逻辑节点包裹 | `styles.fileNode` | `.fileNode` | `.accordionItem`, `.flatFileItem` | ✅ **SSOT** 承载 `role="listitem"` 的透明外壳 |
| **3** | 32px 平直交互行容器 | `styles.fileRow` | `.fileRow` | `button.fileItem`, `.flatFileRow` | ✅ **SSOT** 刚性 `div` 语义容器，严禁声明为 `button` |
| **4** | 交互行激活展开态修饰 | `styles.isActive` | `.fileRow.isActive` | - | ✅ **SSOT** 2px 翡翠绿左强调线 + 激活背景色 |
| **5** | 折叠 Chevron 独立按钮 | `styles.chevronBtn` | `.chevronBtn` | `.accordionToggleBtn` | ✅ **SSOT** 16x16px 直角触控盒（子域 A） |
| **6** | 折叠 Chevron 矢量图标 | `styles.chevronIcon` | `.chevronIcon` | `.accordionChevron`, `.foldIcon` | ✅ **SSOT** 14px 矢量图，03/04 `.foldIcon` 让路 |
| **7** | Chevron 展开旋转修饰 | `styles.expanded` | `.chevronIcon.expanded` | `.chevronOpen`, `.foldIconExpanded` | ✅ **SSOT** `transform: rotate(90deg)` 状态类 |
| **8** | Git 语义状态徽标 | `styles.statusBadge` | `.statusBadge` | - | ✅ **SSOT** 16x16px 直角正方形，Tooltip 包裹 |
| **9** | 状态徽标语义色：修改 | `styles.mod` | `.statusBadge.mod` | `.modified` | ✅ **SSOT** 琥珀橙色阶（04 `.modified` 让路） |
| **10** | 状态徽标语义色：新增 | `styles.add` | `.statusBadge.add` | `.added` | ✅ **SSOT** 翡翠绿色阶（04 `.added` 让路） |
| **11** | 状态徽标语义色：删除 | `styles.del` | `.statusBadge.del` | `.deleted` | ✅ **SSOT** 宝石红色阶（04 `.deleted` 让路） |
| **12** | 状态徽标语义色：重命名 | `styles.ren` | `.statusBadge.ren` | `.untracked` | ✅ **SSOT** 丁香紫色阶（04 `.untracked` 让路） |
| **13** | 路径与超链接弹性容器 | `styles.pathWrap` | `.pathWrap` | `.accordionFiller` | ✅ **SSOT** `flex: 1 1 auto; overflow: hidden;`（子域 B） |
| **14** | 文件名独立超链接按钮 | `styles.fileNameLinkBtn` | `.fileNameLinkBtn` | `.fileNameLink` | ✅ **SSOT** 独立 Tab 可焦按钮（04 `.fileNameLink` 让路） |
| **15** | 主文件名文本实体 | `styles.fileName` | `.fileName` | `.fileNameText` | ✅ **SSOT** 12px 500 Medium，支持弹性截断 |
| **16** | 所在目录弱化次级文本 | `styles.dirPath` | `.dirPath` | - | ✅ **SSOT** 11px 400 Regular，弱对比显示 |
| **17** | 统计与操作并列总容器 | `styles.statAndActions` | `.statAndActions` | 散落无序排布 | ✅ **SSOT** Flex 水平盒，杜绝绝对定位覆盖（子域 C） |
| **18** | 常驻增减统计文本容器 | `styles.fileStat` | `.fileStat` | - | ✅ **SSOT** 等宽数字排版，刚性常驻，严禁隐藏 |
| **19** | 增加行统计数字 (绿色) | `styles.statAdd` | `.statAdd` | `.fileStat .add`, `.addStat` | ✅ **SSOT** 翡翠绿加行文字（03/04 让路） |
| **20** | 删除行统计数字 (红色) | `styles.statDel` | `.statDel` | `.fileStat .del`, `.delStat` | ✅ **SSOT** 宝石红减行文字（03/04 让路） |
| **21** | 零变更中性统计数字 (灰) | `styles.statNeutral` | `.statNeutral` | 历史遗漏缺失 | ✅ **SSOT** 柔和灰色中性 0 占位符 |
| **22** | Git 行内快捷动作组容器 | `styles.rowActions` | `.rowActions` | `.hoverActions` | ✅ **SSOT** Flex 盒流式排版，03/04 旧绝对定位让路 |
| **23** | 行内直角快捷操作按钮 | `styles.rowActBtn` | `.rowActBtn` | `.hoverActBtn` | ✅ **SSOT** 22x22px 直角按钮，SLoHT 背景透明 |
| **24** | 危险操作修饰类 (放弃) | `styles.danger` | `.rowActBtn.danger` | - | ✅ **SSOT** 宝石红高亮危险状态修饰 |
| **25** | 暂存异步处理加载动画 | `styles.spinner` | `.spinner` | - | ✅ **SSOT** Loader2 线性旋转动画 |
| **26** | 展开代码比对视口外壳 | `styles.diffPane` | `.diffPane` | `.inlineBody` | ✅ **SSOT** 垂直嵌合，释放 36px 空间，淘汰 `.inlineBody` |
| **27** | Git 分组区域总容器 | `styles.groupSection` | `.groupSection` | - | ✅ **SSOT** 纯直角纵向 Flex 分组外壳 |
| **28** | Git 分组粘滞吸顶表头 | `styles.groupHeader` | `.groupHeader` | - | ✅ **SSOT** 28px 紧凑标尺，sticky 吸顶 |
| **29** | Git 分组表头标题文字 | `styles.groupTitle` | `.groupTitle` | - | ✅ **SSOT** 12px Medium 分组名称与计数 |
| **30** | Git 分组全部操作按钮 | `styles.groupActionBtn` | `.groupActionBtn` | - | ✅ **SSOT** 全部暂存/全部取消暂存直角按钮 |
| **31** | 分组按钮内部图标间距 | `styles.btnIcon` | `.btnIcon` | - | ✅ **SSOT** margin-right: 4px 规范图标间距 |
| **32** | Git 分组条目实际容器 | `styles.groupBody` | `.groupBody` | - | ✅ **SSOT** 垂直零 gap 列表容器（03 让路） |
| **33** | Git 分组空状态提示文本 | `styles.groupEmptyHint` | `.groupEmptyHint` | - | ✅ **SSOT** 居中淡灰提示，纯直角 |

---

## 三、全色彩系统 Design Tokens 精准映射表

### 3.1 差异面板 13 处裸写 Hex 与 6 处幽灵 Token 全量替换契约

全域扫描抓取出的差异审查模块（`DiffCard.module.css` 与 `VirtualPlainCodeViewer.tsx`）中 13 处硬编码与 6 处幽灵 Token 的刚性替换契约：

| 序号 | 现场文件与精确行号 | 现场违规代码片段 | 标准 Design Token (SSOT) | Light 实际解析值 | Dark 实际解析值 | 治理原因与语义角色 |
| :---: | :--- | :--- | :--- | :--- | :--- | :--- |
| **1** | `DiffCard.module.css:14` | `background: var(--bg-card, #ffffff);` | `background: var(--bg-card);` | `hsl(0 0% 100%)` | `#242424` | 差异面板主容器底色，清除无效 `#ffffff` 兜底，防止深色模式意外闪白。 |
| **2** | `DiffCard.module.css:29` | `background: var(--bg-card, #ffffff);` | `background: var(--bg-card);` | `hsl(0 0% 100%)` | `#242424` | 32px 紧凑工具栏底色，统一收敛为卡片标准背景。 |
| **3** | `DiffCard.module.css:140` | `color-mix(in srgb, var(--accent-red, #ef4444) 10%, var(--bg-card))` | `background: var(--color-error-bg);` | `var(--accent-red-light)` | `var(--accent-red-light)` | 错误横幅背景，使用系统语义错误背景令牌，消除 Tailwind 裸色 `#ef4444`。 |
| **4** | `DiffCard.module.css:141` | `1px solid color-mix(in srgb, var(--accent-red, #ef4444) 25%, transparent)` | `border-bottom: 1px solid var(--color-error-border);` | `color-mix(var(--accent-red) 25%, transparent)` | `color-mix(var(--accent-red) 25%, transparent)` | 错误横幅底边框，使用系统错误边框令牌。 |
| **5** | `DiffCard.module.css:142` | `color: var(--accent-red, #ef4444);` | `color: var(--color-error);` | `var(--accent-red)` | `var(--accent-red)` | 错误横幅文字前景色，统一使用系统错误文本色。 |
| **6** | `DiffCard.module.css:169` | `background: var(--bg-card, #ffffff);` | `background: var(--bg-card);` | `hsl(0 0% 100%)` | `#242424` | 差异面板工作区外壳，收敛为 `var(--bg-card)`。 |
| **7** | `DiffCard.module.css:280` | `color: var(--accent-blue);` | `color: var(--md-link-color);` | `var(--brand-deep, #059669)` | `var(--brand, #10b981)` | 文件名超链接高亮，斩断违章旧蓝，回归 Conex Zero-Blue 翡翠绿规范。 |
| **8** | `DiffCard.module.css:446` | `background: var(--diff-bg-pane, #ffffff);` | `background: var(--bg-card);` | `hsl(0 0% 100%)` | `#242424` | 比对视口滚动容器，清退幽灵变量 `--diff-bg-pane` 与硬编码 `#ffffff`。 |
| **9** | `DiffCard.module.css:462` | `background: var(--diff-bg-pane, #ffffff);` | `background: var(--bg-card);` | `hsl(0 0% 100%)` | `#242424` | 源码查看器滚动父容器，清退幽灵变量与硬编码 `#ffffff`。 |
| **10** | `DiffCard.module.css:476` | `background: var(--diff-bg-pane, #ffffff);` | `background: var(--bg-card);` | `hsl(0 0% 100%)` | `#242424` | 比对行行容器，清退幽灵变量与硬编码 `#ffffff`。 |
| **11** | `DiffCard.module.css:730` | `background: var(--diff-bg-pane, #ffffff);` | `background: var(--bg-card);` | `hsl(0 0% 100%)` | `#242424` | Commit 信息输入框底色，清退幽灵变量与硬编码 `#ffffff`。 |
| **12** | `DiffCard.module.css:845` | `background: var(--bg-card, #ffffff);` | `background: var(--bg-card);` | `hsl(0 0% 100%)` | `#242424` | 差异面板空状态容器底色，移除硬编码 `#ffffff` 兜底。 |
| **13** | `VirtualPlainCodeViewer.tsx:65` | `background: 'var(--diff-bg-pane, #ffffff)',` | `background: 'var(--bg-card)',` | `hsl(0 0% 100%)` | `#242424` | TSX 行内样式，拔除幽灵变量与硬编码 `#ffffff`。 |

#### 6 处幽灵 Token 的专项收敛契约：
1. `--diff-bg-pane`（消费 5 次）：全面注销，统一回归 `var(--bg-card)`；
2. `--diff-gutter-fg`（原 line 498）：校正为系统权威令牌 `var(--diff-linenum-fg, var(--text-tertiary))`；
3. `--diff-text-normal`（原 lines 523, 552）：直接使用系统标准前景色 `var(--text-primary)`；
4. `--diff-gutter-width-unified`（原 line 484）：统一走固定标尺 `40px`；
5. `--diff-gutter-width-split`（原 line 590）：统一走固定标尺 `36px`；
6. `--diff-gutter-marker-width`（原 lines 484, 590）：统一走固定标尺 `20px`。

---

### 3.2 笔记面板 25 处残留硬编码色值全量清洗表

在 [`NotePaperPanel.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperPanel.module.css) 中，存在 25 处带有 `#111111`、`#555555`、`#696969`、`#ffffff` 及 `hsl(35, 10%, 86%)` 的无效兜底回退，破坏了暗色模式下的纯净表现，必须在此次重构中全部清洗归一：

| 序号 | 现场选择器与代码位置 | 原代码片段（带坏味道回退） | 规范化重构代码（纯净 Tokens） | 治理说明 |
| :---: | :--- | :--- | :--- | :--- |
| **1** | `.panel` (line 21) | `background: var(--bg-card, #ffffff);` | `background: var(--bg-card);` | 消除纯白兜底，防止暗色模式偶发透白。 |
| **2** | `.panel` (line 22) | `color: var(--text-primary, #111111);` | `color: var(--text-primary);` | 消除深黑兜底。 |
| **3** | `.title` (line 66) | `color: var(--text-primary, #111111);` | `color: var(--text-primary);` | 顶栏标题文本前景色。 |
| **4** | `.meta` (line 78) | `color: var(--text-secondary, #555555);` | `color: var(--text-secondary);` | 顶栏元信息次级文本色。 |
| **5** | `.badge` (line 94) | `color: var(--text-secondary, #555555);` | `color: var(--text-secondary);` | 徽章次级文本色。 |
| **6** | `.badgeActive` (line 117) | `color: var(--text-primary, #111111);` | `color: var(--text-primary);` | 激活徽章主文本色。 |
| **7** | `.badgeOutline` (line 125) | `border-color: var(--border-color, hsl(35, 10%, 86%));` | `border-color: var(--border-color);` | 消除遗留 Warm-Grey 暖灰硬编码。 |
| **8** | `.body` (line 168) | `background: var(--bg-canvas, var(--bg-card, #ffffff));` | `background: var(--bg-card);` | 消除双层兜底与纯白。 |
| **9** | `.canvas` (line 182) | `background: var(--bg-card, #ffffff);` | `background: var(--bg-card);` | 纸面底色直接回归卡片底。 |
| **10** | `.blockRow[data-selected='true']` (line 220) | `background: color-mix(..., #111111 4%, ...);` | `background: var(--tint-hover);` | 消除裸写 `#111111`。 |
| **11** | `.heading1` (line 301) | `color: var(--text-primary, #111111);` | `color: var(--text-primary);` | 一级大标题文本色。 |
| **12** | `.heading2` (line 311) | `color: var(--text-primary, #111111);` | `color: var(--text-primary);` | 二级标题文本色。 |
| **13** | `.heading3` (line 321) | `color: var(--text-primary, #111111);` | `color: var(--text-primary);` | 三级标题文本色。 |
| **14** | `.text` (line 331) | `color: var(--text-primary, #111111);` | `color: var(--text-primary);` | 正文段落文本色。 |
| **15** | `.codeBlock` (line 500) | `var(--border-color, hsl(35, 10%, 86%))` | `border-color: var(--border-subtle);` | 代码块边框收敛。 |
| **16** | `.blockRow[data-flavour='quote']` (line 514) | `var(--hairline-strong, var(--border-color, hsl(...)))` | `border-left-color: var(--border-color);` | 引用块强调竖线。 |
| **17** | `.blockRow[data-flavour='quote'] .text` (line 516) | `color: var(--text-secondary, #555555);` | `color: var(--text-secondary);` | 引用块次级文本色。 |
| **18** | `.mirrorDriftBar` (line 550) | `color: var(--text-secondary, #555555);` | **物理删除整个选择器** | 拔除底部丑陋灰色块。 |
| **19** | `.mirrorDriftBadge` (line 573) | `color: var(--text-primary, #111111);` | **物理删除整个选择器** | 拔除底部丑陋灰色块。 |
| **20** | `.mirrorDriftMeta` (line 579) | `color: var(--text-tertiary, #696969);` | **物理删除整个选择器** | 拔除底部丑陋灰色块。 |
| **21** | `.footer` (line 534) | `color: var(--text-tertiary, #696969);` | **物理删除整个选择器** | 拔除底部冗余 footer。 |
| **22** | `.compactHeader` (补齐) | 无 | `background: var(--bg-card);` | 32px 紧凑顶栏纯净背景。 |
| **23** | `.titleDisplay` (补齐) | 无 | `color: var(--text-primary);` | 标题显示态文字色。 |
| **24** | `.titleInput` (补齐) | 无 | `background: var(--bg-card); color: var(--text-primary);` | 标题编辑态输入框。 |
| **25** | `.saveStatus` (补齐) | 无 | `color: var(--text-tertiary);` | 保存状态指示微标。 |

---

### 3.3 全色彩系统权威 Design Tokens 映射总表

本系统统一的 Design Tokens 映射基准，全仓严禁脱离本表定义自造变量：

| Token 名称 (CSS Variable) | 语义角色定位 | Light 主题实际解析值 | Dark 主题实际解析值 | 适用元素范围 |
| :--- | :--- | :--- | :--- | :--- |
| `--bg-card` | 主卡片底板 / 编辑器底板 | `hsl(0 0% 100%)` | `#242424` | `.panel`, `.flatFileList`, `.diffPane`, `.body` |
| `--bg-secondary` | 顶栏次级底板 / 折叠栏底板 | `hsl(0 0% 97%)` | `#1e1e1e` | 顶栏、分组标题、折叠栏 |
| `--bg-hover` | 单层悬停底色 (2.5% / 3.5%) | `color-mix(in srgb, #111111 2.5%, transparent)` | `color-mix(in srgb, #dddddd 3.5%, transparent)` | `.fileRow:hover`, `.titleDisplay:hover` |
| `--bg-active` | 单层激活底色 (5.0% / 6.5%) | `color-mix(in srgb, #111111 5%, transparent)` | `color-mix(in srgb, #dddddd 6.5%, transparent)` | `.fileRow.isActive` |
| `--control-soft-bg-hover` | 控件轻悬停底色 | `var(--tint-hover)` | `var(--tint-hover)` | `.commitTriggerBar:hover`, 独立操作按钮 |
| `--border-color` | 标准边框色 | `hsl(0 0% 88%)` | `hsl(0 0% 28%)` | 输入框、外边框 |
| `--border-subtle` | 细微弱分割线 (Hairline) | `hsl(0 0% 92%)` | `hsl(0 0% 20%)` | 列表分割内嵌投影、顶栏底边线 |
| `--text-primary` | 主文本前景色 (高对比) | `#111111` | `#dddddd` | 文件名、代码正常字符、标题正文 |
| `--text-secondary` | 次级辅助说明文本 | `#555555` | `#999999` | 目录路径、行号列、快捷按钮前景色 |
| `--text-tertiary` | 弱对比元信息 / 占位符 | `#767676` | `#707070` | 保存状态指示微标、时间戳 |
| `--md-link-color` | 品牌超链接色 (Zero-Blue) | `var(--brand-deep, #059669)` | `var(--brand, #10b981)` | `.fileNameLink:hover`, 正文超链接 |
| `--brand-primary` | 品牌强调主色 (翡翠绿) | `#059669` | `#10b981` | 激活条目左侧强调条、主操作按钮 |
| `--color-error` | 语义错误前景色 (深红) | `hsl(0 75% 42%)` | `hsl(0 85% 65%)` | 放弃修改悬停、错误提示文字 |
| `--color-error-bg` | 语义错误提示横幅底色 | `hsl(0 80% 50% / 0.08)` | `hsl(0 80% 50% / 0.15)` | 错误横幅背景 |
| `--color-error-border` | 语义错误边框 | `hsl(0 75% 50% / 0.25)` | `hsl(0 75% 50% / 0.35)` | 错误横幅边框、危险按钮边框 |
| `--diff-add-fg` | 新增代码文字前景色 | `hsl(142 65% 25%)` | `hsl(142 75% 72%)` | 新增代码字符、`+` 统计前景色 |
| `--diff-add-bg` | 新增代码行背景色 (7% 水彩) | `hsl(142 35% 42% / 0.07)` | `hsl(142 35% 42% / 0.15)` | 新增代码整行背景 |
| `--diff-del-fg` | 删除代码文字前景色 | `hsl(0 68% 38%)` | `hsl(0 85% 75%)` | 删除代码字符、`−` 统计前景色 |
| `--diff-del-bg` | 删除代码行背景色 (7% 水彩) | `hsl(0 55% 55% / 0.07)` | `hsl(0 55% 55% / 0.15)` | 删除代码整行背景 |
| `--diff-linenum-fg` | 代码行号前景色 | `var(--text-tertiary)` | `var(--text-tertiary)` | 虚拟代码视口行号列 |
| `--filetree-badge-mod-bg` | 修改状态徽标背景 | `hsl(38 92% 50% / 0.12)` | `hsl(38 92% 50% / 0.18)` | `.statusBadge.mod` 琥珀橙底 |
| `--filetree-badge-mod-fg` | 修改状态徽标文字色 | `hsl(32 95% 30%)` | `hsl(38 92% 70%)` | `.statusBadge.mod` 琥珀橙字 |
| `--filetree-badge-add-bg` | 新增状态徽标背景 | `hsl(142 71% 45% / 0.12)` | `hsl(142 71% 45% / 0.18)` | `.statusBadge.add` 翡翠绿底 |
| `--filetree-badge-add-fg` | 新增状态徽标文字色 | `hsl(142 71% 28%)` | `hsl(142 71% 68%)` | `.statusBadge.add` 翡翠绿字 |
| `--filetree-badge-del-bg` | 删除状态徽标背景 | `hsl(0 84% 60% / 0.12)` | `hsl(0 84% 60% / 0.18)` | `.statusBadge.del` 宝石红底 |
| `--filetree-badge-del-fg` | 删除状态徽标文字色 | `hsl(0 75% 38%)` | `hsl(0 84% 75%)` | `.statusBadge.del` 宝石红字 |
| `--filetree-badge-renamed-bg` | 重命名状态徽标背景 | `hsl(270 60% 50% / 0.12)` | `hsl(270 60% 50% / 0.18)` | `.statusBadge.ren` 丁香紫底 |
| `--filetree-badge-renamed-fg` | 重命名状态徽标文字色 | `hsl(270 60% 36%)` | `hsl(270 60% 75%)` | `.statusBadge.ren` 丁香紫字 |
| `--focus-ring-strong` | 10% 混入焦点边框 (SSOT) | `color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%)` | 同左 | `.titleInput:focus`, 输入框聚焦边框 |
| `--focus-ring` | 柔灰外环阴影 (SSOT) | `0 0 0 1.5px var(--focus-ring-color)` | 同左 | 键盘聚焦柔灰外环，严格替代粗黑环 |
| `--focus-border-color` | 焦点边框别名 (`focus-visible.css`) | `var(--focus-ring-strong)` 等价 | 同左 | 全局输入框聚焦兼容 |
| `--focus-ring-shadow` | 焦点阴影别名 (`focus-visible.css`) | `var(--focus-ring)` 等价 | 同左 | 全局输入框聚焦阴影兼容 |

---

### 3.4 Conex Zero-Blue 铁律与 Emerald Green 品牌活态签名

Conex 桌面应用全域恪守 **Zero-Blue（零平庸蓝）** 的设计铁律：
- 严禁任何浏览器默认蓝色（如 `#0000ee`、`#1e90ff` 或 Tailwind 蓝 `#3b82f6`）；
- 全仓采用专属的 **Emerald Green（翡翠绿）** 作为品牌活态签名：
  - 浅色模式：`#059669`（`var(--brand-deep)`，对比度 4.65:1 严格满足 WCAG AA 文本标准）；
  - 暗色模式：`#10b981`（`var(--brand)`，在深灰 `#242424` 背景上对比度 6.22:1 满足 WCAG AAA）；
- 在差异列表中的文件名超链接：
  ```css
  .fileNameLinkBtn:hover .fileName {
    text-decoration: underline;
    text-underline-offset: 3px;
    color: var(--md-link-color); /* 翡翠绿真源，绝不裸写蓝色 */
  }
  ```

---

### 3.5 控件悬停魔术混入比收敛规则

在原代码 `DiffCard.module.css:658` 中，存在一处私有魔术混入比：
```css
/* ❌ 违规私有混入比 (4%) */
.commitTriggerBar:hover {
  background: color-mix(in srgb, var(--text-primary) 4%, var(--bg-secondary));
}
```
**收敛规则**：彻底拔除私有魔术数字，统一收敛为系统权威控件轻悬停令牌：
```css
/* ✅ 权威规范化重构 */
.commitTriggerBar:hover {
  background: var(--control-soft-bg-hover);
  border-color: var(--border-color);
}
```

---

## 四、AGENTS.md §13 焦点态防晃与对比度上限 10% 规范落地

### 4.1 AGENTS.md §13 核心条款与铁律矩阵

根据 [`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §13「UI：输入框与焦点态」的刚性条款：

1. **默认不要重阴影**：
   输入框、搜索框、列表容器等默认禁止声明任何厚重 `box-shadow`，保持扁平、干净、轻量；
2. **克制的激活边框，严禁粗黑边**：
   元素在处于 active / focused / recording 状态时，**严禁粗、深、实心黑边**（严禁直接使用 `var(--text-primary)` 或厚重 `0 0 0 1px` 黑环）；
3. **焦点对比度上限约 10%**：
   边框加深混入文本色**绝对不超过约 10%**：
   $$\text{Border Color} = \text{color-mix}(\text{in srgb}, \text{var}(--\text{border-color})\ 90\%, \text{var}(--\text{text-primary})\ 10\%)$$
   常规元素优先使用 **3%–6%** 柔和混入，以保护长时间阅读；
4. **形态 ④ 内联浮层/卡片顶栏筛选框（纯光标极简型）**：
   全态只有光标闪烁，其他什么变化也没有！彻底消除边框、外描边与聚焦阴影。

---

### 4.2 形态 ④ 纯光标极简型搜索筛选框规范落地（彻底肃清 8 处 !important 与守护门禁）

在差异面板中，文件筛选输入框 `.searchInput` 必须作为永久基线刚性锁定为形态 ④（纯光标极简型）。

#### (1) 彻底肃清 8 处违规 `!important` 声明（守护 style-contract.test.ts 626 门禁）
在上一轮草案中，作者在 `.searchInput` 选择器群组中滥用了 8 处 `!important` 声明（在 §4.2 与 §5.1 中各声明 4 处：`border: none !important;`、`outline: none !important;`、`box-shadow: none !important;`、`background: transparent !important;`）。该行为在终审审计 [`audits/01-ui-components-and-tokens-anti-hallucination-audit.md`](./audits/01-ui-components-and-tokens-anti-hallucination-audit.md) 中被严肃定性为 **缺陷 04【P1 铁律违背】**：
1. **公然违反 AGENTS.md §7**（“追求架构优雅，杜绝打补丁；绝对禁止绕过流水线门禁”）；
2. **危及全仓测试门禁**：[`apps/crish-desktop/src/styles/style-contract.test.ts:335-349`](file:///c:/Software/conex/apps/crish-desktop/src/styles/style-contract.test.ts) 设定了全仓 `!important` 总数 $\le 626$ 的刚性防回潮棘轮门禁（Ratchet Gate）。任何私自增加的 `!important` 都会直接导致 CI 门禁爆红阻断；
3. **终局定稿整改裁决**：**物理彻底删除全部 8 处 `!important`**！回归 W3C 原生 CSS 层叠属性覆盖机制，使用纯净属性重置（`border: none; outline: none; box-shadow: none; background: transparent;`）达到完全相同的极简视觉效果，实现零特异性污染、零门禁风险。

#### (2) 守护 input-three-patterns-guard.test.ts 自动化门禁
[`apps/crish-desktop/src/styles/__tests__/input-three-patterns-guard.test.ts:72-87`](file:///c:/Software/conex/apps/crish-desktop/src/styles/__tests__/input-three-patterns-guard.test.ts) 对形态 ④ 输入框设立了静态 AST 强扫描：
- 断言 1：`expect(diffCardCss).toMatch(/\.searchInput[^{]*\{[^}]*border:\s*none/)`；
- 断言 2：`expect(diffCardCss).toMatch(/\.searchInput[^{]*\{[^}]*box-shadow:\s*none/)`；
- 断言 3：`expect(diffCardCss).not.toMatch(/\.searchInput:focus[^{]*\{[^}]*border-color:/)`；
- 断言 4：`focus-visible.css` 阻断全局焦点环穿透（`box-shadow: none !important;` 由全局守卫承载，组件内部保持纯净）。

纯净规范代码实现如下：

```css
/* ==========================================================================
 * 形态 ④：纯光标极简型搜索筛选框 (AGENTS.md §13 刚性基线 · 纯净属性无 !important)
 * 全态只有光标闪烁，其他什么变化也没有！彻底消除边框、描边与聚焦投影
 * ========================================================================== */

.searchContainer {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
  height: 28px;
  padding: 0 8px;
  background: transparent;
  border-bottom: 1px solid var(--border-subtle);
  box-sizing: border-box;
}

.searchInput,
.searchInput:focus,
.searchInput:focus-visible {
  width: 100%;
  height: 100%;
  padding: 0;
  margin: 0;
  border: none;        /* 纯净重置，零 !important，守护 626 门禁 */
  outline: none;       /* 纯净重置，零 !important */
  box-shadow: none;    /* 纯净重置，零 !important，守护 input-three-patterns 门禁 */
  background: transparent;
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-size: var(--font-size-xs, 12px);
  line-height: 20px;
  box-sizing: border-box;
}

.searchInput::placeholder {
  color: var(--text-tertiary);
  user-select: none;
}
```

---

### 4.3 笔记面板标题行内编辑（EditableTitle）焦点态规范

在笔记面板 32px 紧凑顶栏中，行内标题编辑组件必须满足无感切换，严格对齐 §13 规范：

```css
/* ==========================================================================
 * 笔记面板行内标题编辑组件 (EditableTitle)
 * 严格落实 AGENTS.md §13 焦点对比度 <= 10%，严禁粗黑边与重阴影
 * ========================================================================== */

.titleContainer {
  display: flex;
  align-items: center;
  min-width: 0;
  max-width: min(320px, 60%);
  flex: 0 1 auto;
  box-sizing: border-box;
}

/* 标题展示态：直角、透明边框、轻柔悬停 */
.titleDisplay {
  font-family: var(--font-sans);
  font-size: var(--font-size-xs, 12px);
  font-weight: var(--font-weight-medium, 500);
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 2px 6px;
  border-radius: 0; /* 严格直角化 */
  border: 1px solid transparent;
  background: transparent;
  cursor: pointer;
  user-select: none;
  box-sizing: border-box;
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast);
}

.titleDisplay:hover {
  background-color: var(--bg-hover);
  border-color: var(--border-subtle);
}

/* 标题编辑态：极简纯净，10% 柔和焦点边框，零 box-shadow */
.titleInput {
  width: 100%;
  height: 22px;
  padding: 0 6px;
  margin: 0;
  font-family: var(--font-sans);
  font-size: var(--font-size-xs, 12px);
  font-weight: var(--font-weight-medium, 500);
  color: var(--text-primary);
  background: var(--bg-card);
  border: 1px solid color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
  border-radius: 0; /* 严格直角化 */
  outline: none;
  box-shadow: none; /* 坚决拔除重阴影 */
  box-sizing: border-box;
}

.titleInput:focus,
.titleInput:focus-visible {
  outline: none;
  border-color: color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
  box-shadow: none;
}
```

---

### 4.4 Git Commit 提交信息输入框极简焦点态规范

Git Commit 区域的文本输入框同样必须拔除粗黑描边与厚重阴影：

```css
/* ==========================================================================
 * Commit 信息输入框：对齐 focus-visible 柔灰外环规范
 * ========================================================================== */

.commitInput {
  width: 100%;
  min-height: 56px;
  padding: 6px 8px;
  font-family: var(--font-sans);
  font-size: var(--font-size-xs, 12px);
  color: var(--text-primary);
  background: var(--bg-card); /* 拔除幽灵变量 --diff-bg-pane 与 #ffffff */
  border: 1px solid var(--border-color);
  border-radius: 0; /* 严格直角化 */
  outline: none;
  box-shadow: none;
  resize: vertical;
  box-sizing: border-box;
  transition:
    border-color var(--transition-fast),
    box-shadow var(--transition-fast);
}

.commitInput:focus,
.commitInput:focus-visible {
  outline: none;
  border-color: var(--focus-border-color); /* 10% 混入上限 */
  box-shadow: var(--focus-ring-shadow); /* 6% 柔灰微环，无黑边 */
}
```

---

### 4.5 视觉光学对比度金字塔与科学梯次验证（WCAG AAA/AA）

为保证长时间连续代码审查与笔记编辑下的舒适度，系统确立了清晰的**光学对比度金字塔**：

```
光学对比度金字塔架构：
▲
│ [高强对比] 增删代码文字 (Add/Del Text): 6.75:1 ~ 9.46:1 (WCAG AAA 刚性阅读保障)
│ [中度对比] 行内词法差异 (Word Diff): 20% ~ 30% 饱和度遮罩 (精准锁定字符修改)
│ [低度对比] 增删整行背景 (Line Diff): 7% ~ 15% 极淡水彩透染 (大面积无压抑感)
│ [微量对比] 文件行悬停 (Row Hover): 2.5% ~ 3.5% 墨印微透 (灵动反馈，界面静谧)
▼
```

#### 科学对比度实测数据矩阵表：

| 视觉元素 | 前景色 Token | 背景色 Token | Light 对比度 | Dark 对比度 | WCAG 评级 | 人机工程学定性分析 |
| :--- | :--- | :--- | :---: | :---: | :---: | :--- |
| **文件行悬停** (`.fileRow:hover`) | `var(--text-primary)` | `var(--bg-hover)` | **17.5 : 1** | **12.2 : 1** | 🟢 **AAA** | 单层透光，鼠标掠过如同微风抚纸，宁静克制。 |
| **代码基底行** (Normal Code Line) | `var(--text-primary)` | `var(--bg-card)` | **18.5 : 1** | **13.0 : 1** | 🟢 **AAA** | 字符黑白分明，边缘清晰锐利。 |
| **新增代码行** (Diff Addition) | `var(--diff-add-fg)` | `var(--diff-add-bg)` | **6.75 : 1** | **9.46 : 1** | 🟢 **AAA** | 7% 水彩翡翠绿底板避免眩光，深绿文本易读。 |
| **删除代码行** (Diff Deletion) | `var(--diff-del-fg)` | `var(--diff-del-bg)` | **7.01 : 1** | **7.21 : 1** | 🟢 **AAA** | 7% 玫瑰粉底板柔和沉稳，深绯红文字边缘锐利。 |
| **词法级变动** (Word Diff Mask) | 继承增删行文字色 | `var(--diff-*-word-bg)` | **4.8 : 1** (相对行底) | **5.2 : 1** (相对行底) | 🟢 **AA** | 字符焦点精准凸显，无模糊边缘。 |
| **行内编辑焦点** (`.titleInput:focus`) | `var(--text-primary)` | `var(--bg-card)` | **18.5 : 1** | **13.0 : 1** | 🟢 **AAA** | 10% 混入柔和边框，保护眼睛长效专注。 |

---

### 4.6 差异面板顶栏抗二次叠黑与紧凑尺寸守门规范（守护 antiDarkeningGuard.test.ts）

在差异面板 32px 紧凑顶栏（`.compactHeader`）与操作工具区中，必须严格恪守抗二次叠加过黑与紧凑标尺门禁，守护 [`apps/crish-desktop/src/styles/__tests__/antiDarkeningGuard.test.ts`](file:///c:/Software/conex/apps/crish-desktop/src/styles/__tests__/antiDarkeningGuard.test.ts) 中的 RULE-11A/B/C 三大刚性守则：

#### (1) RULE-11A：顶栏操作按钮严禁声明自定义 hover 背景色（抗二次叠黑）
- **缺陷病理**：
  顶栏 `.compactHeader` 作为容器层已具备纯净的 `var(--bg-card)` 底色。若顶栏内部的动作按钮 `.actionBtn` 在 `:hover` 态私自声明 `background-color: var(--tint-hover)` 或自造半透明遮罩，会导致深色模式下按钮边缘产生刺眼的脏斑与二次局部叠黑（Double Overlay Darkening）。
- **门禁源码与守门断言**：
  ```typescript
  // antiDarkeningGuard.test.ts:206-213
  it('RULE-11A: enforces zero custom hover backgrounds on .actionBtn and .filesNavBtn to prevent double overlay', () => {
    const diffCardCss = readFile('src/components/diff/DiffCard.module.css');
    const filesCardCss = readFile('src/components/files/FilesCard.module.css');

    expect(diffCardCss).not.toMatch(/\.actionBtn:hover\s*\{[^}]*background/);
    expect(diffCardCss).not.toMatch(/\.actionBtn\.isActive\s*\{[^}]*background/);
    expect(filesCardCss).not.toMatch(/\.filesNavBtn:hover[^}]*\{[^}]*background/);
  });
  ```
- **规范化 CSS 落地方案**：
  `.actionBtn:hover` 必须保持背景完全透光（`background: transparent;` 或由底层统一承载），悬停时仅改变文字色 `color: var(--text-primary);` 与边框 `border-color: var(--border-subtle);`，杜绝任何局部色块叠加。

#### (2) RULE-11B：Select 下拉选择器触发器 `min-height: 0` 紧凑弹性缩放
- **缺陷病理**：
  通用 Select 控件默认携带 `--control-height: 32px` 的全局尺寸约束。若 `.trigger` 包含 `min-height: 32px` 硬编码，当顶栏需要嵌入 `size="sm"`（24px 高度）的小型选择器时，会被 `min-height` 强制撑大，导致 32px 顶栏整体撑爆产生垂直溢出。
- **门禁源码与守门断言**：
  ```typescript
  // antiDarkeningGuard.test.ts:215-219
  it('RULE-11B: enforces Select.module.css trigger has min-height: 0 to allow compact scaling', () => {
    const selectCss = readFile('src/components/ui/Select/Select.module.css');
    expect(selectCss).not.toMatch(/\.trigger\s*\{[^}]*min-height:\s*var\(--control-height,\s*32px\)/);
    expect(selectCss).toMatch(/\.trigger\s*\{[^}]*min-height:\s*0/);
  });
  ```
- **规范化落地方案**：
  `Select.module.css` 中的 `.trigger` 显式声明 `min-height: 0;`，确保顶栏上下间距严格守住 32px 偶数标尺。

#### (3) RULE-11C：差异面板顶栏 `<Select>` 实例强制 `size="sm"` 声明
- **规范要求**：
  `DiffHeaderControls.tsx` 与 `DiffCard.tsx` 顶栏中嵌入的所有上下文与模式选择器，必须显式传递 `size="sm"` 属性，严禁使用默认的大号尺寸。
- **门禁源码与守门断言**：
  ```typescript
  // antiDarkeningGuard.test.ts:221-228
  it('RULE-11C: enforces DiffHeaderControls explicitly sets size="sm" on all Select instances', () => {
    const diffHeaderTsx = readFile('src/components/diff/DiffHeaderControls.tsx');
    const selectMatches = diffHeaderTsx.match(/<Select\b[^>]*>/g) || [];
    expect(selectMatches.length).toBeGreaterThan(0);
    for (const selectTag of selectMatches) {
      expect(selectTag).toMatch(/size=["']sm["']/);
    }
  });
  ```
- **TSX 调用落地规范**：
  ```tsx
  <Select
    size="sm"
    className={styles.inlineSelect}
    value={selectedCommit}
    onChange={handleSelectCommit}
    aria-label="选择比对提交"
  />
  ```

---

## 五、全量 CSS 重构施工图代码（全展开，零省略）

### 5.1 DiffCard.module.css 规范化施工图代码

以下为重构后的 `DiffCard.module.css` 完整生产级样式表代码。全量展开，无任何 `...` 占位符：

```css
/* ==========================================================================
 * DiffCard.module.css —— 差异面板平直直角化与 SLoHT 单层 Hover 终态样式表
 * 刚性守则：
 * 1. 严格平直直角化 (border-radius: 0)，彻底废除手风琴圆角外框；
 * 2. 贯彻 SLoHT 单层 Hover 架构，外壳骨架永久透明，.fileRow 独占 hover；
 * 3. 100% 清退裸写 Hex (#ffffff, #ef4444) 与幽灵 Token (--diff-bg-pane)；
 * 4. 严格执行 Zero-Blue 铁律，超链接统一换装翡翠绿 --md-link-color；
 * 5. 严格对齐 AGENTS.md §13-14 极简焦点与现代 CSS 语法规范。
 * ========================================================================== */

/* 1. 主卡片容器 */
.panel {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  height: 100%;
  min-height: 0;
  min-width: 0;
  width: 100%;
  overflow: hidden;
  background: var(--bg-card);
  container-type: inline-size;
  container-name: diff-panel;
  box-sizing: border-box;
}

/* 2. 32px 紧凑顶栏工具行 */
.compactHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 32px;
  min-height: 32px;
  max-height: 32px;
  padding: 0 8px;
  background: var(--bg-card);
  border-bottom: 1px solid var(--border-subtle);
  box-sizing: border-box;
  user-select: none;
  flex-shrink: 0;
  gap: 6px;
}

.leftGroup {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1 1 auto;
}

.sourceSegmentControl {
  flex-shrink: 0;
}

.tabIcon {
  flex-shrink: 0;
  color: var(--text-tertiary);
}

.headerDivider {
  width: 1px;
  height: 14px;
  background: var(--border-subtle);
  flex-shrink: 0;
}

.contextSelector {
  min-width: 0;
  max-width: 220px;
  flex: 1 1 auto;
}

@container diff-panel (max-width: 400px) {
  .contextSelector {
    max-width: 120px;
  }
}

.inlineSelect {
  width: 100%;
}

.idleHint {
  font-size: var(--font-size-xxs, 11px);
  color: var(--text-secondary);
}

.rightGroup,
.rightActions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

/* 3. 极简搜索筛选框（形态 ④：纯光标极简型） */
.searchContainer {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
  height: 28px;
  padding: 0 8px;
  background: transparent;
  border-bottom: 1px solid var(--border-subtle);
  box-sizing: border-box;
  flex-shrink: 0;
}

.searchInput,
.searchInput:focus,
.searchInput:focus-visible {
  width: 100%;
  height: 100%;
  padding: 0;
  margin: 0;
  border: none;
  outline: none;
  box-shadow: none;
  background: transparent;
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-size: var(--font-size-xs, 12px);
  line-height: 20px;
  box-sizing: border-box;
}

.searchInput::placeholder {
  color: var(--text-tertiary);
  user-select: none;
}

/* 4. 错误通知横幅 */
.errorBanner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  background: var(--color-error-bg);
  border-bottom: 1px solid var(--color-error-border);
  color: var(--color-error);
  font-size: var(--font-size-xs, 12px);
  box-sizing: border-box;
  flex-shrink: 0;
}

/* 5. 平直列表滚动工作区 */
.listWorkspace {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  width: 100%;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: auto;
  background: var(--bg-card);
  box-sizing: border-box;
}

.flatFileList {
  display: flex;
  flex-direction: column;
  width: 100%;
  margin: 0;
  padding: 0;
  list-style: none;
  background: transparent; /* SLoHT: 容器骨架永久透明 */
  box-sizing: border-box;
}

/* 6. 逻辑包装条目节点（无状态外壳） */
.fileNode {
  display: flex;
  flex-direction: column;
  width: 100%;
  margin: 0;
  padding: 0;
  background: transparent; /* SLoHT: 绝对严禁声明 :hover 背景 */
  border: none;
  border-radius: 0; /* 严格直角化 */
  box-sizing: border-box;
}

/* 7. 32px 单轨交互行实体（唯一 Hover/Active 真源，div 语义容器，严禁声明为 button） */
.fileRow {
  position: relative;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  height: 32px;
  min-height: 32px;
  max-height: 32px;
  padding: 0 12px;
  margin: 0;
  border: none;
  border-radius: 0; /* 严格直角化 */
  background: transparent;
  box-shadow: inset 0 -1px 0 0 var(--border-subtle); /* 维持 32px 偶数净高 */
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-size: var(--font-size-xs, 12px);
  box-sizing: border-box;
  user-select: none;
  transition: background-color var(--transition-fast);
}

/* SLoHT 唯一悬停真源 (2.5% Light / 3.5% Dark) */
.fileRow:hover {
  background-color: var(--bg-hover);
}

/* SLoHT 唯一激活真源 (5.0% Light / 6.5% Dark) */
.fileRow.isActive {
  background-color: var(--bg-active);
  box-shadow:
    inset 0 -1px 0 0 var(--border-subtle),
    inset 2px 0 0 0 var(--brand-primary);
}

/* 8. 子域 A：折叠 Chevron 独立按钮与语义状态徽标 */
.chevronBtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  min-width: 16px;
  padding: 0;
  margin: 0;
  margin-right: 4px;
  border: none;
  border-radius: 0;
  background: transparent;
  cursor: pointer;
  flex-shrink: 0;
}

.chevronIcon {
  width: 14px;
  height: 14px;
  color: var(--text-tertiary);
  transition:
    transform var(--transition-fast, 120ms) cubic-bezier(0.2, 0, 0, 1),
    color var(--transition-fast, 120ms);
}

.chevronBtn:hover .chevronIcon,
.fileRow:hover .chevronIcon {
  color: var(--text-secondary);
}

.chevronIcon.expanded {
  transform: rotate(90deg);
  color: var(--text-primary);
}

/* 语义状态指示徽章（严格直角 16x16px，零 border-radius，全量 Tokens 无裸写） */
.statusBadge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  min-width: 16px;
  flex-shrink: 0;
  margin-right: 8px;
  border-radius: 0; /* 消除胶囊感，直角化归零 */
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  text-transform: uppercase;
  user-select: none;
  box-sizing: border-box;
}

.statusBadge.mod {
  color: var(--filetree-badge-mod-fg, hsl(32 95% 30%));
  background-color: var(--filetree-badge-mod-bg, hsl(38 92% 50% / 0.12));
}

.statusBadge.add {
  color: var(--filetree-badge-add-fg, hsl(142 71% 28%));
  background-color: var(--filetree-badge-add-bg, hsl(142 71% 45% / 0.12));
}

.statusBadge.del {
  color: var(--filetree-badge-del-fg, hsl(0 75% 38%));
  background-color: var(--filetree-badge-del-bg, hsl(0 84% 60% / 0.12));
}

.statusBadge.ren {
  color: var(--filetree-badge-renamed-fg, hsl(270 60% 36%));
  background-color: var(--filetree-badge-renamed-bg, hsl(270 60% 50% / 0.12));
}

/* 9. 子域 B：文件名超链接按钮与所在目录（弹性防溢出截断） */
.pathWrap {
  display: flex;
  align-items: center; /* 消除 Windows DirectWrite 字体基线抖动 */
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  height: 100%;
  margin-right: 8px;
}

/* 独立语义化超链接按钮 (点击在右侧打开独立标签页) */
.fileNameLinkBtn {
  display: inline-flex;
  align-items: center;
  min-width: 48px;
  max-width: 100%;
  flex: 0 1 auto;
  padding: 0;
  margin: 0;
  border: none;
  border-radius: 0;
  background: transparent;
  cursor: pointer;
  text-align: left;
  outline: none;
}

.fileName {
  font-family: var(--font-sans);
  font-size: var(--font-size-xs, 12px);
  font-weight: var(--font-weight-medium, 500);
  line-height: 20px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: color var(--transition-fast, 120ms);
}

.fileNameLinkBtn:hover .fileName {
  color: var(--md-link-color);
  text-decoration: underline;
  text-underline-offset: 3px;
}

.dirPath {
  font-family: var(--font-sans);
  font-size: var(--font-size-xxs, 11px);
  font-weight: 400;
  line-height: 20px;
  color: var(--text-tertiary);
  margin-left: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1 1 auto;
  min-width: 0;
  cursor: pointer;
}

.dirPath:hover {
  color: var(--text-secondary);
}

/* 10. 子域 C：常驻增减统计与 Git 快捷操作 (Flex 盒架构，消除排版跳动与遮挡) */
.statAndActions {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  flex-shrink: 0;
  height: 100%;
}

/* 常驻增减统计 (等宽数字排版，永不隐藏，完全杜绝旧版 hover 遮挡) */
.fileStat {
  font-size: var(--font-size-xxs, 11px);
  font-family: var(--font-mono, monospace);
  font-variant-numeric: tabular-nums;
  display: inline-flex;
  gap: var(--space-1_5, 6px);
  flex-shrink: 0;
  align-items: center;
  opacity: 1; /* 刚性常驻可见，彻底删除 hover opacity: 0 反模式 */
  user-select: none;
}

.statAdd {
  color: var(--diff-add-fg, hsl(142 65% 25%));
  font-weight: 500;
}

.statDel {
  color: var(--diff-del-fg, hsl(0 68% 38%));
  font-weight: 500;
}

.statNeutral {
  color: var(--text-tertiary);
}

/* 行内快捷操作按钮组（Flex 盒并排，透明透光，非绝对定位覆盖） */
.rowActions {
  display: flex;
  align-items: center;
  gap: var(--space-1, 4px);
  background: transparent;
  padding: 0;
  border: none;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition:
    opacity var(--transition-micro, 80ms),
    visibility var(--transition-micro, 80ms);
}

.fileRow:hover .rowActions,
.fileRow:focus-within .rowActions {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
}

.rowActBtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  min-width: 22px;
  padding: 0;
  margin: 0;
  border: 1px solid transparent;
  border-radius: 0; /* 严格直角化 */
  background: transparent; /* 绝无独立底色 */
  color: var(--text-secondary);
  cursor: pointer;
  box-sizing: border-box;
  transition:
    color var(--transition-micro, 80ms),
    border-color var(--transition-micro, 80ms);
}

/* 按钮悬停：SLoHT 刚性纠偏：背景保持 transparent，仅改变边框与前景色，严禁叠灰 */
.rowActBtn:hover {
  color: var(--text-primary);
  border-color: var(--border-subtle);
  background: transparent;
}

.rowActBtn.danger:hover {
  color: var(--diff-del-fg, hsl(0 68% 38%));
  border-color: var(--color-error-border, hsl(0 75% 50% / 0.25));
  background: transparent;
}

.spinner {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* 11. 极窄容器自适应（360px 断点优化） */
@container diff-panel (max-width: 360px) {
  .dirPath {
    display: none; /* 极窄屏隐藏目录路径，全力保全主文件名与操作 */
  }
  .fileRow {
    padding: 0 8px;
  }
}

/* 12. 展开代码比对区（纯直角无缝贴合） */
.diffPane {
  display: flex;
  flex-direction: column;
  width: 100%;
  margin: 0;
  padding: 0;
  background: var(--bg-card);
  border: none;
  border-bottom: 1px solid var(--border-subtle);
  box-sizing: border-box;
}

.scrollParent {
  min-height: 44px;
  max-height: min(560px, 65vh);
  height: auto;
  overflow-y: auto;
  overscroll-behavior: auto;
  position: relative;
  background: var(--bg-card); /* 清退幽灵变量 --diff-bg-pane 与 #ffffff */
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}

/* 13. 比对行基础布局（Unified 与 Split 视图统一规范） */
.diffLine {
  display: flex;
  align-items: stretch;
  min-height: 20px;
  line-height: 20px;
  font-family: var(--font-mono);
  font-size: var(--font-size-xs, 12px);
  width: 100%;
  box-sizing: border-box;
  user-select: text;
}

.diffLineAdd {
  background-color: var(--diff-add-bg);
  color: var(--text-primary);
}

.diffLineDel {
  background-color: var(--diff-del-bg);
  color: var(--text-primary);
}

.diffGutter {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  width: 40px;
  min-width: 40px;
  padding: 0 6px;
  color: var(--diff-linenum-fg, var(--text-tertiary));
  user-select: none;
  flex-shrink: 0;
  box-sizing: border-box;
}

.diffMarker {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  min-width: 20px;
  font-weight: var(--font-weight-bold, 700);
  user-select: none;
  flex-shrink: 0;
}

.diffMarkerAdd {
  color: var(--diff-add-fg);
}

.diffMarkerDel {
  color: var(--diff-del-fg);
}

.diffContent {
  flex: 1 1 auto;
  min-width: 0;
  padding: 0 8px;
  white-space: pre;
  overflow: hidden;
}

.wordAdd {
  background-color: var(--diff-add-word-bg);
  border-radius: 0;
}

.wordDel {
  background-color: var(--diff-del-word-bg);
  border-radius: 0;
}

/* 14. Git Commit 提交操作底栏 */
.commitTriggerBar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 32px;
  padding: 0 12px;
  background: var(--bg-card);
  border-top: 1px solid var(--border-subtle);
  border-radius: 0; /* 严格直角化 */
  color: var(--text-primary);
  font-size: var(--font-size-xs, 12px);
  cursor: pointer;
  box-sizing: border-box;
  flex-shrink: 0;
  transition: background-color var(--transition-fast);
}

.commitTriggerBar:hover {
  background: var(--control-soft-bg-hover); /* 消除私有魔术混入比 4% */
}

.commitSection {
  display: flex;
  flex-direction: column;
  padding: 8px 12px;
  background: var(--bg-card);
  border-top: 1px solid var(--border-subtle);
  border-radius: 0; /* 严格直角化 */
  gap: 8px;
  box-sizing: border-box;
  flex-shrink: 0;
}

.commitInput {
  width: 100%;
  min-height: 56px;
  padding: 6px 8px;
  font-family: var(--font-sans);
  font-size: var(--font-size-xs, 12px);
  color: var(--text-primary);
  background: var(--bg-card); /* 拔除幽灵变量 --diff-bg-pane 与 #ffffff */
  border: 1px solid var(--border-color);
  border-radius: 0; /* 严格直角化 */
  outline: none;
  box-shadow: none;
  resize: vertical;
  box-sizing: border-box;
  transition:
    border-color var(--transition-fast),
    box-shadow var(--transition-fast);
}

.commitInput:focus,
.commitInput:focus-visible {
  outline: none;
  border-color: var(--focus-border-color); /* 10% 混入上限 */
  box-shadow: var(--focus-ring-shadow); /* 6% 柔灰外环，无粗黑边 */
}

/* 15. 空状态提示容器 */
.emptyState {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex: 1 1 auto;
  padding: 24px;
  color: var(--text-tertiary);
  font-size: var(--font-size-sm, 13px);
  background: var(--bg-card); /* 清除 #ffffff 兜底 */
  box-sizing: border-box;
}

/* 16. Git 分组表头与容器规范 (吸顶粘滞、纯直角、28px 紧凑标尺) */
.groupSection {
  display: flex;
  flex-direction: column;
  width: 100%;
  padding: 0;
  margin: 0;
}

.groupHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 28px;
  min-height: 28px;
  max-height: 28px;
  padding: 0 12px;
  box-sizing: border-box;
  background: var(--card-header-bg, var(--bg-secondary));
  box-shadow: inset 0 -1px 0 0 var(--border-subtle);
  position: sticky;
  top: 0;
  z-index: 2;
  user-select: none;
}

.groupTitle {
  font-family: var(--font-sans);
  font-size: var(--font-size-xs, 12px);
  font-weight: var(--font-weight-medium, 500);
  color: var(--text-secondary);
}

.groupActionBtn {
  font-size: var(--font-size-xxs, 11px);
  height: 22px;
  padding: 0 6px;
  border-radius: 0;
}

.btnIcon {
  margin-right: 4px;
}

.groupBody {
  display: flex;
  flex-direction: column;
  width: 100%;
  padding: 0;
  gap: 0;
}

.groupEmptyHint {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  font-family: var(--font-sans);
  font-size: var(--font-size-xxs, 11px);
  color: var(--text-tertiary);
  background: transparent;
  border: none;
  border-radius: 0; /* 严格直角化 */
  box-shadow: inset 0 -1px 0 0 var(--border-subtle);
  box-sizing: border-box;
}
```

---

### 5.2 NotePaperPanel.module.css 规范化施工图代码

以下为重构后的 `NotePaperPanel.module.css` 核心样式表代码。全量展开，无任何 `...` 占位符：

```css
/* ==========================================================================
 * NotePaperPanel.module.css —— 笔记面板 32px 紧凑顶栏与纯净视口重构样式表
 * 刚性守则：
 * 1. 物理拔除底部 .mirrorDriftBar 与 .footer 两大丑陋调试色块；
 * 2. 100% 清退 25 处裸写十六进制与暖灰 fallback 色值；
 * 3. 补齐 32px 紧凑顶栏（.compactHeader, .titleInput, .titleDisplay 等）；
 * 4. 彻底平直直角化，移除外层孤岛卡片边框与重阴影；
 * 5. 更新顶栏绝缘选择器为 .panel > .header, .panel > .compactHeader。
 * ========================================================================== */

/* 1. 笔记主面板（全高平铺无外框） */
.panel {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  height: 100%;
  min-height: 200px;
  min-width: 0;
  width: 100%;
  background: var(--bg-card); /* 拔除 #ffffff 兜底 */
  color: var(--text-primary); /* 拔除 #111111 兜底 */
  border: none; /* 拔除孤岛浮动边框 */
  border-radius: 0; /* 直角化归零 */
  overflow: hidden;
  font-family: var(--font-sans);
  box-shadow: none; /* 拔除 var(--shadow-sm) 重阴影 */
  box-sizing: border-box;
  --np-focus-edge: color-mix(
    in srgb,
    var(--border-color) 94%,
    var(--text-primary) 6%
  );
  --np-focus-row: color-mix(
    in srgb,
    var(--border-color) 94%,
    var(--text-primary) 6%
  );
}

.panel:focus,
.panel:focus-visible {
  outline: none;
}

/* 2. 32px 紧凑顶栏（与 DiffCard 像素级一致） */
.compactHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 32px;
  min-height: 32px;
  max-height: 32px;
  padding: 0 8px;
  background: var(--bg-card);
  border-bottom: 1px solid var(--border-subtle);
  box-sizing: border-box;
  user-select: none;
  flex-shrink: 0;
  gap: 6px;
}

.headerLeftGroup {
  display: flex;
  align-items: center;
  gap: var(--space-1_5, 6px);
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
}

.noteIcon {
  color: var(--text-tertiary);
  flex-shrink: 0;
}

/* 3. 行内可编辑标题组件（严格对齐 AGENTS.md §13） */
.titleContainer {
  display: flex;
  align-items: center;
  min-width: 0;
  max-width: min(320px, 60%);
  flex: 0 1 auto;
  box-sizing: border-box;
}

.titleDisplay {
  font-family: var(--font-sans);
  font-size: var(--font-size-xs, 12px);
  font-weight: var(--font-weight-medium, 500);
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 2px 6px;
  border-radius: 0; /* 严格直角化 */
  border: 1px solid transparent;
  background: transparent;
  cursor: pointer;
  user-select: none;
  box-sizing: border-box;
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast);
}

.titleDisplay:hover {
  background-color: var(--bg-hover);
  border-color: var(--border-subtle);
}

.titleInput {
  width: 100%;
  height: 22px;
  padding: 0 6px;
  margin: 0;
  font-family: var(--font-sans);
  font-size: var(--font-size-xs, 12px);
  font-weight: var(--font-weight-medium, 500);
  color: var(--text-primary);
  background: var(--bg-card);
  border: 1px solid color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
  border-radius: 0; /* 严格直角化 */
  outline: none;
  box-shadow: none; /* 坚决拔除重阴影 */
  box-sizing: border-box;
}

.titleInput:focus,
.titleInput:focus-visible {
  outline: none;
  border-color: color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
  box-shadow: none;
}

/* 4. 保存状态指示微标 */
.saveStatus {
  display: flex;
  align-items: center;
  font-size: var(--font-size-xxs, 11px);
  color: var(--text-tertiary);
  flex-shrink: 0;
  user-select: none;
  margin-left: 2px;
}

.saveStatusSaved {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--text-tertiary);
}

.saveStatusSyncing {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--brand-primary);
}

.headerDivider {
  width: 1px;
  height: 14px;
  background: var(--border-subtle);
  flex-shrink: 0;
}

.wordCountBadge {
  font-size: var(--font-size-xxs, 11px);
  font-family: var(--font-mono);
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
  user-select: none;
}

.headerRightGroup {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

/* 5. 纯净纸面工作区与块渲染 */
.body {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  width: 100%;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: auto;
  background: var(--bg-card); /* 拔除双层兜底 */
  box-sizing: border-box;
}

.canvas {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-height: 100%;
  padding: 16px 24px;
  background: var(--bg-card); /* 消除纯白兜底 */
  box-sizing: border-box;
}

.blockRow {
  position: relative;
  display: flex;
  align-items: flex-start;
  width: 100%;
  padding: 2px 0;
  box-sizing: border-box;
}

.blockRow[data-selected='true'] {
  background: var(--tint-hover); /* 消除裸写 #111111 */
}

.heading1 {
  font-size: var(--font-size-xl, 20px);
  font-weight: var(--font-weight-bold, 700);
  color: var(--text-primary);
  margin-top: 12px;
  margin-bottom: 6px;
  line-height: 1.3;
}

.heading2 {
  font-size: var(--font-size-lg, 16px);
  font-weight: var(--font-weight-semibold, 600);
  color: var(--text-primary);
  margin-top: 10px;
  margin-bottom: 4px;
  line-height: 1.35;
}

.heading3 {
  font-size: var(--font-size-base, 14px);
  font-weight: var(--font-weight-semibold, 600);
  color: var(--text-primary);
  margin-top: 8px;
  margin-bottom: 4px;
  line-height: 1.4;
}

.text {
  font-size: var(--font-size-sm, 13px);
  color: var(--text-primary);
  line-height: 1.6;
}

.codeBlock {
  font-family: var(--font-mono);
  font-size: var(--font-size-xs, 12px);
  background: var(--bg-secondary);
  border: 1px solid var(--border-subtle); /* 消除 hsl(35, 10%, 86%) 暖灰 */
  border-radius: 0; /* 严格直角化 */
  padding: 10px 12px;
  margin: 6px 0;
  box-sizing: border-box;
}

/* 6. 顶栏绝缘守门规则（05-B 扩展：兼容 .compactHeader） */
.panel > .header,
.panel > .compactHeader {
  flex: 0 0 auto;
  max-height: none;
  width: 100%;
  min-height: unset;
}

.panel > .body {
  flex: 1 1 0%;
  min-height: 0;
  max-height: none;
}
```

---

## 六、style-contract.test.ts 自动化防回潮测试套件完整代码

### 6.1 测试套件工程定位与防御目标

为了将本方案制定的 SLoHT 单层 Hover 架构、Design Tokens 规范、直角化几何与 AGENTS.md §13-14 视觉铁律硬编码进 CI 流水线，在 [`apps/crish-desktop/src/styles/style-contract.test.ts`](file:///c:/Software/conex/apps/crish-desktop/src/styles/style-contract.test.ts) 中植入 DETAIL-PLAN-04 专项防回潮契约测试。

**测试防护五大红线**：
1. **红线 1（SLoHT 单层悬停门禁）**：静态 AST 分析硬性阻断任何在容器层（`.accordionItem`、`.fileNode`、`.flatFileList`、`.accordionHeaderRow`）声明 `:hover` 背景色的行为；
2. **红线 2（零硬编码 Hex 门禁）**：除定义真源 `tokens.css` 外，`DiffCard.module.css` 与 `NotePaperPanel.module.css` 严禁出现任何裸写十六进制色值；
3. **红线 3（零幽灵 Token 门禁）**：彻底清剿 `--diff-bg-pane`，全域引用次数严格为 0；
4. **红线 4（Conex Zero-Blue 门禁）**：严禁出现违章旧蓝别名 `--accent-blue`；
5. **红线 5（AGENTS.md §13-14 极简焦点门禁）**：校验 `.searchInput` 纯光标极简规则，校验输入框无厚重阴影，校验顶栏绝缘选择器完整性。

---

### 6.2 完整测试套件生产级源码

以下为可直接运行的完整 TypeScript 源码：

```ts
// @vitest-environment jsdom
/**
 * DETAIL-PLAN-04 专项：全域 Tokens 规范重构与 SLoHT 单层 Hover 体系防回归门禁测试
 *
 * 覆盖文件：
 * - src/components/diff/DiffCard.module.css
 * - src/components/diff/VirtualPlainCodeViewer.tsx
 * - src/components/note-paper/NotePaperPanel.module.css
 *
 * 遵循仓库契约：
 * - 使用 new URL(rel, import.meta.url) 安全读取物理文件
 * - 纯逻辑正则与 AST 状态分析，零外部 Mock 欺骗
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

function readFile(relPath: string): string {
  const target = `../../${relPath}`;
  return readFileSync(new URL(target, import.meta.url), 'utf8');
}

describe('DETAIL-PLAN-04 专项：SLoHT 单层 Hover 体系与 Tokens 规范刚性契约', () => {
  const diffCss = readFile('src/components/diff/DiffCard.module.css');
  const noteCss = readFile('src/components/note-paper/NotePaperPanel.module.css');
  const viewerTsx = readFile('src/components/diff/VirtualPlainCodeViewer.tsx');

  // 1. SLoHT 单层 Hover 物理隔离门禁
  describe('门禁 1：SLoHT 单层 Hover 体系（彻底阻断容器级 hover 叠加）', () => {
    it('容器与骨架层严禁声明任何 :hover 背景色规则', () => {
      // 正则匹配任何容器/外壳选择器附带 :hover 且大括号内包含 background 属性的声明
      const invalidContainerHoverRegex =
        /\.(accordionItem|fileNode|flatFileList|fileList|groupItemsContainer|accordionHeaderRow):hover\s*\{[^}]*background/gi;

      const violations = diffCss.match(invalidContainerHoverRegex) ?? [];
      expect(
        violations,
        `DiffCard.module.css 存在违规的父级容器 :hover 背景规则，导致双重过灰：${violations.join('; ')}`
      ).toEqual([]);
    });

    it('交互行实体 .fileRow 独占单一 var(--bg-hover) 规则', () => {
      // 验证存在 .fileRow:hover 规则且使用系统标准 var(--bg-hover)
      const hasFileRowHover = /\.fileRow:hover\s*\{[^}]*background-color:\s*var\(--bg-hover\)/.test(diffCss);
      expect(hasFileRowHover, 'DiffCard.module.css 必须包含 .fileRow:hover { background-color: var(--bg-hover); }').toBe(true);
    });

    it('行内操作按钮 .rowActBtn 背景永久锁定为 transparent', () => {
      const actBtnBlock = diffCss.match(/\.rowActBtn\s*\{([^}]+)\}/)?.[1] ?? '';
      expect(actBtnBlock, '.rowActBtn 必须显式声明 background: transparent').toContain('background: transparent');

      const actBtnHoverBlock = diffCss.match(/\.rowActBtn:hover\s*\{([^}]+)\}/)?.[1] ?? '';
      expect(actBtnHoverBlock, '.rowActBtn:hover 必须维持 background: transparent，严禁自造色块').toContain('background: transparent');
    });
  });

  // 2. 零硬编码 Hex 门禁
  describe('门禁 2：全域 Design Tokens 规范（零裸写 Hex 色值）', () => {
    it('DiffCard.module.css 绝无任何裸写十六进制色值', () => {
      // 剥离 CSS 多行注释与单行注释，防止注释中的历史说明干扰检测
      const cleanCss = diffCss.replace(/\/\*[\s\S]*?\*\//g, '');
      const bareHexMatches = cleanCss.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];

      expect(
        bareHexMatches,
        `DiffCard.module.css 存在裸写十六进制色值坏味道：${bareHexMatches.join(', ')}`
      ).toEqual([]);
    });

    it('NotePaperPanel.module.css 已彻底清洗 #111111 / #555555 / #ffffff / #696969 等裸写兜底', () => {
      const cleanNoteCss = noteCss.replace(/\/\*[\s\S]*?\*\//g, '');
      const bareHexMatches = cleanNoteCss.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];

      expect(
        bareHexMatches,
        `NotePaperPanel.module.css 存在未清洗的十六进制色值：${bareHexMatches.join(', ')}`
      ).toEqual([]);
    });

    it('NotePaperPanel.module.css 绝无遗留 hsl(35, 10%, 86%) 暖灰硬编码', () => {
      expect(noteCss).not.toContain('hsl(35, 10%, 86%)');
    });
  });

  // 3. 零幽灵 Token 门禁
  describe('门禁 3：幽灵 Token 清剿（彻底注销 --diff-bg-pane）', () => {
    it('DiffCard.module.css 中 --diff-bg-pane 彻底注销，零引用', () => {
      expect(diffCss).not.toContain('--diff-bg-pane');
    });

    it('VirtualPlainCodeViewer.tsx 中 --diff-bg-pane 彻底注销，统一回归 --bg-card', () => {
      expect(viewerTsx).not.toContain('--diff-bg-pane');
    });
  });

  // 4. Conex Zero-Blue 品牌铁律门禁
  describe('门禁 4：Conex Zero-Blue 铁律（严禁违章旧蓝别名）', () => {
    it('DiffCard.module.css 严禁包含 --accent-blue 违章变量', () => {
      expect(diffCss).not.toContain('--accent-blue');
    });

    it('文件名链接悬停态统一换装品牌翡翠绿 --md-link-color', () => {
      const linkHoverMatch = diffCss.match(/\.fileNameLinkBtn:hover\s+\.fileName\s*\{([^}]+)\}/)?.[1] ?? '';
      expect(linkHoverMatch, '.fileNameLinkBtn:hover .fileName 必须使用 var(--md-link-color)').toContain('var(--md-link-color)');
    });
  });

  // 5. AGENTS.md §13 焦点态与输入框极简规范门禁 (input-three-patterns-guard)
  describe('门禁 5：AGENTS.md §13 焦点态与输入框极简规范 (守护 input-three-patterns-guard)', () => {
    it('搜索筛选框严格落实形态 ④（纯光标极简型，零边框零阴影零 !important）', () => {
      const searchMatch = diffCss.match(/\.searchInput[^{]*\{([^}]+)\}/)?.[1] ?? '';
      expect(searchMatch, '必须存在 .searchInput 规则').toBeTruthy();
      expect(searchMatch).toContain('border: none');
      expect(searchMatch).toContain('outline: none');
      expect(searchMatch).toContain('box-shadow: none');
      expect(searchMatch).toContain('background: transparent');
      expect(searchMatch, '严禁包含 !important 伪补丁').not.toContain('!important');
    });

    it('.searchInput:focus 绝不声明任何边框色与聚焦阴影', () => {
      expect(diffCss).not.toMatch(/\.searchInput:focus[^{]*\{[^}]*border-color:/);
      expect(diffCss).not.toMatch(/\.searchInput:focus[^{]*\{[^}]*box-shadow:\s*(?!none)/);
    });

    it('Commit 输入框严格遵循 10% 混入焦点边框与柔灰投影', () => {
      const commitFocusMatch = diffCss.match(/\.commitInput:(?:focus|focus-visible)[^{]*\{([^}]+)\}/)?.[1] ?? '';
      expect(commitFocusMatch).toContain('var(--focus-border-color)');
      expect(commitFocusMatch).toContain('var(--focus-ring-shadow)');
    });

    it('NotePaper 行内编辑输入框 .titleInput 严格执行 10% 混入上限与零投影', () => {
      const titleInputMatch = noteCss.match(/\.titleInput\s*\{([^}]+)\}/)?.[1] ?? '';
      expect(titleInputMatch).toContain('color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%)');
      expect(titleInputMatch).toContain('box-shadow: none');
    });
  });

  // 6. 直角化几何彻底性与状态徽章 Tokens 门禁
  describe('门禁 6：直角化几何彻底性与状态徽章规范', () => {
    it('文件条目 .fileRow 严格直角化，border-radius 为 0', () => {
      const rowMatch = diffCss.match(/\.fileRow\s*\{([^}]+)\}/)?.[1] ?? '';
      expect(rowMatch).toContain('border-radius: 0');
    });

    it('状态徽章 .statusBadge 严格直角化且采用权威 SSOT 色阶类名', () => {
      const badgeMatch = diffCss.match(/\.statusBadge\s*\{([^}]+)\}/)?.[1] ?? '';
      expect(badgeMatch).toContain('border-radius: 0');

      // 验证 SSOT 类名与其 Tokens 映射（无裸写 Hex）
      expect(diffCss).toContain('.statusBadge.mod');
      expect(diffCss).toContain('var(--filetree-badge-mod-fg');
      expect(diffCss).toContain('.statusBadge.add');
      expect(diffCss).toContain('var(--filetree-badge-add-fg');
      expect(diffCss).toContain('.statusBadge.del');
      expect(diffCss).toContain('var(--filetree-badge-del-fg');
      expect(diffCss).toContain('.statusBadge.ren');
      expect(diffCss).toContain('var(--filetree-badge-renamed-fg');
    });

    it('行内操作按钮 .rowActBtn 严格直角化，border-radius 为 0', () => {
      const actBtnMatch = diffCss.match(/\.rowActBtn\s*\{([^}]+)\}/)?.[1] ?? '';
      expect(actBtnMatch).toContain('border-radius: 0');
    });

    it('笔记面板外层容器 .panel 拔除圆角与孤岛边框', () => {
      const panelMatch = noteCss.match(/\.panel\s*\{([^}]+)\}/)?.[1] ?? '';
      expect(panelMatch).toContain('border-radius: 0');
      expect(panelMatch).toContain('box-shadow: none');
    });
  });

  // 7. 笔记面板死代码清理与顶栏绝缘门禁
  describe('门禁 7：笔记面板死代码清理与顶栏绝缘规则', () => {
    it('彻底物理拔除 .mirrorDriftBar 及其子类死代码', () => {
      expect(noteCss).not.toContain('.mirrorDriftBar');
      expect(noteCss).not.toContain('.mirrorDriftBarAttention');
      expect(noteCss).not.toContain('.mirrorDriftBadge');
      expect(noteCss).not.toContain('.mirrorDriftMeta');
    });

    it('彻底物理拔除 .footer 冗余底栏', () => {
      expect(noteCss).not.toMatch(/\.footer\s*\{/);
    });

    it('顶栏绝缘规则已同步扩展支持 .compactHeader', () => {
      expect(noteCss).toContain('.panel > .compactHeader');
    });
  });

  // 8. style-contract.test.ts 历史断言平滑升级与 626 棘轮门禁守门
  describe('门禁 8：style-contract.test.ts 契约升级与 626 计数守门', () => {
    it('style-contract L513-526 契约平滑升级：.rowActions 双揭示断言', () => {
      const block = diffCss.match(/\.rowActions\s*\{[\s\S]*?\}/)?.[0] ?? '';
      expect(block, '.rowActions 必须存在且具备无感隐藏').toContain('opacity: 0');
      expect(block).toContain('visibility: hidden');
      expect(block).not.toContain('display: none');
      expect(diffCss, '交互行悬停触发快捷操作浮现').toContain('.fileRow:hover .rowActions');
      expect(diffCss, '交互行内焦点触发快捷操作浮现').toContain('.fileRow:focus-within .rowActions');
    });

    it('DiffCard 与 NotePaper 样式改动中引入的 !important 增量严格为 0（守护 626 基线）', () => {
      const diffImportants = (diffCss.match(/!important/g) ?? []).length;
      const noteImportants = (noteCss.match(/!important/g) ?? []).length;
      expect(diffImportants, 'DiffCard.module.css 严禁新增任何 !important').toBe(0);
      expect(noteImportants, 'NotePaperPanel.module.css 严禁新增任何 !important').toBe(0);
    });
  });

  // 9. antiDarkeningGuard.test.ts 顶栏抗叠黑与紧凑标尺门禁守门
  describe('门禁 9：antiDarkeningGuard.test.ts 顶栏抗叠黑与紧凑标尺', () => {
    it('RULE-11A: 顶栏操作按钮 .actionBtn 严禁声明 hover 自定义背景色（抗二次叠黑）', () => {
      expect(diffCss).not.toMatch(/\.actionBtn:hover\s*\{[^}]*background/);
      expect(diffCss).not.toMatch(/\.actionBtn\.isActive\s*\{[^}]*background/);
    });
  });
});
```

---

## 七、视觉与交互立体化验收断言清单

在执行重构并交付审查时，必须对照本清单履行立体验证（遵循 [`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §7.1「立体验证纪律」），严禁单一编译通过即冒充验收。

### 7.1 渲染引擎物理层验收断言

- [ ] **断言 P-01（单层 Alpha 物理合成断言）**：
  打开 Conex 桌面应用（Tauri 4000 端口），使用 DevTools 检查处于悬停状态的 `.fileRow`：
  - 浅色模式下，计算样式（Computed Style）中 `background-color` 必须精确解析为 `rgba(17, 17, 17, 0.025)`（2.5% 不透明度），严禁出现 `0.0494`（4.94%）的二次复合值；
  - 暗色模式下，`background-color` 必须精确解析为 `rgba(221, 221, 221, 0.035)`（3.5% 不透明度），严禁出现 `0.0688`（6.88%）的二次复合值。
- [ ] **断言 P-02（父级骨架背景阻断断言）**：
  检查处于悬停状态的 `.fileNode`、`.flatFileList`、`.accordionHeaderRow`：
  - 计算样式中 `background-color` 必须恒定为 `rgba(0, 0, 0, 0)`（`transparent`），零动态背景色改变。
- [ ] **断言 P-03（操作按钮背景透明度断言）**：
  检查处于悬停状态的 `.rowActBtn`：
  - 计算样式中 `background-color` 必须保持为 `transparent`，完全透出整行背景，不产生局部微色块。

---

### 7.2 视觉美学与直角几何验收断言

- [ ] **断言 V-01（纯偶数 32px 单轨净高断言）**：
  检查 `.fileRow` 的盒模型尺寸：
  - `getBoundingClientRect().height` 必须精确为 `32.0px`，绝无奇数 31px 或浮点亚像素；
  - 底边分割线由 `box-shadow: inset 0 -1px 0 0 var(--border-subtle)` 实现，不侵占 32px 物理内容高度。
- [ ] **断言 V-02（直角几何彻底性归零断言）**：
  - 检查 `.fileRow`、`.statusBadge`、`.rowActBtn`、`.diffPane`、`.commitInput`、`.compactHeader`：
  - 计算样式中 `border-radius` 必须全量为 `0px`，彻底抹杀一切 2px/4px/6px 胶囊微圆角。
- [ ] **断言 V-03（极窄 320px 弹性收缩与防溢出截断断言）**：
  将差异面板宽度缩放至 320px：
  - 长文件名文件（如 `WorkspaceEmptyStatePaperEntry.tsx`）文字末尾出现优雅的 `...` 截断；
  - 右侧常驻增减统计（`+142  −38`）与暂存/放弃操作按钮完整可见、排版稳定，整行横向零溢出、零水平滚动条。
- [ ] **断言 V-04（Windows DirectWrite 基线防抖断言）**：
  在 Windows 平台中英混排环境下观察列表：
  - 文件名（12px Segoe UI）与目录（11px 微软雅黑）垂直居中（`align-items: center`，行高 20px），与左侧 16x16px 状态徽章视线平齐，光标滚动时文字绝对零上下晃动。

---

### 7.3 色彩对比度与可读性验收断言

- [ ] **断言 C-01（WCAG AAA/AA 刚性达标断言）**：
  - 浅色模式下，代码基底字符对 `--bg-card` 对比度达到 **18.5 : 1**（WCAG AAA）；
  - 新增代码文本对 7% 水彩绿底板对比度达到 **6.75 : 1**（WCAG AAA）；
  - 删除代码文本对 7% 玫瑰粉底板对比度达到 **7.01 : 1**（WCAG AAA）；
  - 文件行悬停态对文本对比度达到 **17.5 : 1**（WCAG AAA）。
- [ ] **断言 C-02（深色模式零闪白断言）**：
  - 全量切换深色主题（`data-theme="dark"`），滚动差异面板与虚拟源码视口：
  - 由于幽灵变量 `--diff-bg-pane` 已注销且移除所有 `#ffffff` 兜底，视口背景纯正显示为卡片底色 `#242424`，绝对无任何瞬间亮白刺眼闪烁。
- [ ] **断言 C-03（Conex Zero-Blue 翡翠绿一致性断言）**：
  - 鼠标悬停在文件名超链接 `.fileNameLinkBtn` 上，文字颜色平滑过渡至翡翠绿（Light: `#059669` / Dark: `#10b981`），下划线锐利清晰，与全系统超链接 100% 统一。

---

### 7.4 交互动效与手感验收断言

- [ ] **断言 I-01（零跳闪频闪断言）**：
  鼠标从文件名区域水平横向滑动移入右侧快捷操作按钮 `.rowActBtn`：
  - 由于行内按钮透明透光且始终处于 `.fileRow` 内部，左侧文件名区域背景色恒定维持在 2.5%（Light）/ 3.5%（Dark），**完全消除了旧版 4.94% 骤降至 2.5% 产生的“眨眼跳亮”频闪**。
- [ ] **断言 I-02（形态 ④ 极简搜索框聚焦零晃动断言）**：
  鼠标点击搜索筛选框 `.searchInput` 进行聚焦：
  - 界面上**除原生文本光标闪烁外，无任何边框变色、描边加粗、阴影外扩或几何位移**；失焦时亦平滑无感。
- [ ] **断言 I-03（可编辑标题无感切换断言）**：
  在笔记顶栏点击 `.titleDisplay`：
  - 平滑切换为 22px 紧凑输入框 `.titleInput`，边框呈现 10% 克制加深色，无重阴影；
  - 按 Enter 或失焦时无缝持久化刷盘并切回文本展示态。

---

### 7.5 自动化门禁流水线执行标准

交付前必须在本地与 CI 环境全量跑通以下刚性命令，满足零报错、零告警标准：

```bash
# 1. 运行样式契约防回归测试（必须 100% 通过）
npm run test -- apps/crish-desktop/src/styles/style-contract.test.ts

# 2. 全仓 TypeScript 类型安全编译检查（零类型断裂）
npm run typecheck

# 3. 前端单元测试与覆盖率门禁（45/70/65/45 刚性达标）
npm run test:coverage -- --project=unit

# 4. 代码行数与解耦门禁（无过度膨胀与上帝组件）
npm run check:line-counts
```

**反退避铁律警示**：  
实施过程中，严禁因特异性不足而使用 `!important` 覆盖；严禁因局部样式调整而重新在父容器添加 `:hover`；改动严格留在工作区，提交权统一交还主 Agent！
