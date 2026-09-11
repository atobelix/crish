# 面包屑视觉重塑与防穿透隔离战略分析报告

> **文件标识**：`docs/file-tree-and-attachments-architecture/analysis/03-breadcrumb-and-resizer-strategy.md`
> **专题性质**：阶段一 · 多 Agent 方案生成战略分析报告（布局层级、设计系统对齐与架构边界控制）
> **面向对象**：架构评审者、后续详细方案规划 Agent（Detailed Plan Designer）、执行子 Agent（Implementation Agents）
> **核心原则**：纯逻辑规划、问题逻辑同权、严守零魔术数字、设计系统原子对齐、严禁回退与过度设计。

---

## 1. 战略定位与最高裁决对齐

### 1.1 战略定位：轻量级视口就绪补充面板
在 Conex / Crish 桌面客户端中，文件卡片顶栏的面包屑导航组件（[FileBreadcrumb.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FileBreadcrumb.tsx)）与其下拉面板（`.filesBcFlyout`）具有极为明确的产品语义：
- **瞬态观察探针（Transient Inspection Probe）**：用户在不打乱主文件树视口、不改变主工作区当前浏览焦点的前提下，点击路径中的某一父级节点，快速勘察其内部子目录与文件分布；
- **定向跃迁枢纽（Targeted Leap Hub）**：提供基于当前父节点的轻量级搜索与下钻跳转功能，既可直接打开目标文件，也可在需要时下钻该层。

面包屑下拉面板**绝非**第二个全功能文件树，也**绝非**主文件树的平替。它是一个即用即走、局部闭包、极致轻量的视口补充面板。

### 1.2 用户最高裁决铁律锁定
本战略分析完全基于用户的三项最高硬性裁决展开，后续所有方案设计与代码执行必须无条件遵守：
1. **树逻辑维持现状，严禁改动**：展开树逻辑维持现状，不用改！它是一个轻量补充面板，点击哪层就展示哪层的下级目录树，严禁重写或改动树逻辑（包括状态模型、递归渲染算法、目录缓存逻辑）；
2. **搜索框 1:1 对齐模型选择器**：全面重塑搜索框，1:1 对齐模型选择器（[ModelBadgePickerMenu.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.tsx)）的高级现代发丝下边框极简形态 ④（无外框、左侧弱灰放大镜、纯光标闪烁）；
3. **彻底根除分割线穿透 Bug**：基于 W3C CSS 标准从代数层级根除底层垂直拖拽分割线（`.filesSplitResizer`）穿透盖在下拉面板上的视觉缺陷，严禁魔术数字与粗暴补丁。

---

## 2. 缺陷剖析：`.filesSplitResizer` 穿透面板的代数根因与隔离舱方案

### 2.1 CSS 层叠上下文（Stacking Context）拓扑反演

#### 2.1.1 DOM 树与当前 CSS 拓扑结构
在 [FilesCard.tsx:287-493](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FilesCard.tsx#L287-L493) 与 [FilesCard.module.css](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FilesCard.module.css) 中，核心组件 DOM 与样式关联如下：

```html
<!-- 宿主根容器 -->
<div class="filesCard">

  <!-- Sibling 1: 顶部工具条 -->
  <div class="filesBar">
    <div class="filesCrumbs">
      <span class="filesBcSeg">
        <button class="filesBcChip">conex</button>
        <!-- 下拉弹出面板 -->
        <div class="filesBcFlyout">...</div>
      </span>
    </div>
  </div>

  <!-- Sibling 2: 内容区分栏容器 -->
  <div class="filesBody filesBodySplit">
    <div class="filesListPane">...</div>
    <!-- 垂直拖拽分割线 -->
    <div class="filesSplitResizer"></div>
    <div class="filesDetailPane">...</div>
  </div>

</div>
```

在 [FilesCard.module.css](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FilesCard.module.css) 中的关键样式规则截屏：
```css
/* [FilesCard.module.css:35-51] */
.filesBar {
  position: relative;
  z-index: var(--z-card-footer, 10);
  overflow: visible;
}

/* [FilesCard.module.css:84-99] */
.filesCrumbs {
  position: relative;
  z-index: var(--z-card-footer, 10);
  overflow: visible;
}

/* [FilesCard.module.css:263-280] */
.filesBcFlyout {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: var(--z-breadcrumb, 400);
}

/* [FilesCard.module.css:498-504] */
.filesBody {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  /* 致命缺陷：未声明 position，未声明 z-index，未声明 isolation */
}

/* [FilesCard.module.css:587-597] */
.filesSplitResizer {
  position: relative;
  flex: 0 0 7px;
  width: 7px;
  margin: 0 -3px;
  cursor: col-resize;
  z-index: 10; /* 致命缺陷：硬编码为 10 */
}
```

#### 2.1.2 W3C 规范推导：为什么 400 敌不过 10？
根据 **W3C CSS 2.1 § 9.9 (Layered presentation)** 与 **CSS Positioned Layout Level 3**，层叠上下文的建立与竞争遵循严格的代数公理：

1. **公理一（封装性原则 Encapsulation Principle）**：
   一个层叠上下文内部的所有子元素，其 `z-index` 无论多大，都只在当前层叠上下文内部比较。对外部祖先层叠上下文而言，该子元素所在的整个层叠上下文被视为一个**原子化不可分割的整体**，其在外部的实际参与层级等于其创建者的全局层级：
   $$\text{StackLevel}_{\text{global}}(\text{Child}) \equiv \text{StackLevel}_{\text{global}}(\text{Parent Context})$$
   在当前代码中，`.filesBar` 拥有 `position: relative` 且 `z-index: 10`（来自 `--z-card-footer: 10`），因此创建了层叠上下文 $\mathcal{SC}_{\text{bar}}$，其全局等级为 **10**。
   即使 `.filesBcFlyout` 在内部声明了 `z-index: var(--z-breadcrumb, 400)`，在宿主容器 `.filesCard` 的眼里，它的有效层级依然被**截断且牢牢锁定在 10**！
   $$\text{StackLevel}_{\text{global}}(\text{.filesBcFlyout}) = 10$$

2. **公理二（普通流非上下文容器的穿透冒泡）**：
   `.filesBody` 是常规 flex 容器，既无定位（`position: static`），也无 `isolation: isolate`，更无 `transform` / `filter` 等属性。根据规范，`.filesBody` **没有创建层叠上下文**。
   当其子元素 `.filesSplitResizer` 声明了 `position: relative; z-index: 10` 时，由于其直接父容器没有层叠上下文，`.filesSplitResizer` 将**直接逃逸（Escape）穿透出 `.filesBody`**，向外寻找最近的祖先层叠上下文——即外层的 `.filesCard`！

3. **公理三（平权参与者与 DOM 树顺序决胜机制 Tree Order Tie-Breaker）**：
   在祖先 `.filesCard` 的层叠树中，此时出现了两个拥有**完全相同全局层叠等级（Stack Level = 10）**的参与者：
   - 参与者 A：$\mathcal{SC}_{\text{bar}}$（内含 `.filesBcFlyout`，层级 10）；
   - 参与者 B：`.filesSplitResizer`（逃逸出的定位元素，层级 10）。

   W3C CSS 2.1 § 9.9 明确裁定：
   > *"Within each stacking context, positioned elements with the same stack level are stacked according to tree order (i.e. DOM source order)."*

   在 [FilesCard.tsx:288-485](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FilesCard.tsx#L288-L485) 中：
   ```tsx
   // DOM 树顺序：先渲染 filesBar，后渲染 filesBody（及其包含的 filesSplitResizer）
   <div className={styles.filesBar}>...</div>        <!-- DOM 顺序在前 -->
   <div className={styles.filesBody}>
     <div className={styles.filesSplitResizer} />    <!-- DOM 顺序在后！ -->
   </div>
   ```
   因为 $\text{DOM\_Order}(\text{.filesSplitResizer}) > \text{DOM\_Order}(\text{.filesBar})$，**后出现的 `.filesSplitResizer` 必然绘制在先出现的 `.filesBar` 之上**！
   当面包屑下拉面板 `.filesBcFlyout` 向下垂挂至 `.filesBody` 视口上方时，处于后方且穿透出来的 `.filesSplitResizer` 便以其蓝/灰分割线，硬生生垂直劈开并遮挡了下拉面板。

```
【穿透前：层叠上下文缺陷机理模型】

.filesCard (Stacking Context Root)
 ├── .filesBar [position: relative; z-index: 10] ---> [建立 SC_bar, Level = 10]
 │    └── .filesCrumbs [z-index: 10]
 │         └── .filesBcFlyout [z-index: 400] --------> (被困在 Level 10 内部无法逃逸!)
 │
 └── .filesBody [无 Stacking Context, 裸露通道]
      └── .filesSplitResizer [position: relative; z-index: 10]
           │
           └── 逃逸冒泡至 .filesCard！
               与 .filesBar 层级同为 10，因 DOM 顺序在后，
               直接绘制在 .filesBcFlyout 之上！======> [发生穿透事故！]
```

### 2.2 常见错误补丁方式及其危害（反模式警示）

在实际重构中，往往有子 Agent 试图采取以下“偷懒”打补丁做法，必须在战略分析中全面揭露并刚性禁止：

| 错误做法（反模式） | 做法描述 | 为什么绝对无效 / 带来严重次生灾害 |
| :--- | :--- | :--- |
| **反模式 A：滥加魔术数字** | 给 `.filesBcFlyout` 盲目加 `z-index: 99999` | **完全无效**。根据公理一，其外部被 `.filesBar`（Level 10）锁死，无论加到多少亿，在 `.filesCard` 眼中依旧只有 10。 |
| **反模式 B：盲目降级分割线** | 将 `.filesSplitResizer` 改为 `z-index: 0` 或 `-1` | **破坏核心交互**。降为 0 或负值后，分割线将被文件树的高亮行背景、选中条、预览区域的滚动条遮挡，导致鼠标 hover 命中区域失效，无法拖拽分栏。 |
| **反模式 C：随意提升 `.filesBar`** | 将 `.filesBar` 永久设为 `z-index: 999` | **污染全局层级**。如果顶栏常态过高，会遮挡全局弹出的 Modal、Toast、全局上下文菜单或顶部系统拖拽手柄。 |
| **反模式 D：滥用 React Portal** | 将 `.filesBcFlyout` 强行抽离并渲染至 `document.body` | **架构过度设计**。Portal 会导致面包屑绝对坐标计算复杂、滚动脱节、Tab 键导航与聚焦陷阱断裂，严重违背轻量化设计初衷。 |

### 2.3 原生隔离舱工程方案：`isolation: isolate` 与 Token 分层

#### 2.3.1 W3C `isolation: isolate` 规范原理与零副作用保证
根据 **CSS Compositing and Blending Level 1** 规范：
> *"The `isolation` property defines whether an element must create a new stacking context. When set to `isolate`, the element must create a new stacking context."*

`isolation: isolate` 是现代浏览器原生提供的无害层叠隔离指令：
1. **零布局副作用**：不改变任何盒模型（box-sizing、margin、padding），不影响 flex/grid 布局特征，不改变几何尺寸；
2. **零滚动副作用**：不像 `overflow: hidden` 会裁剪子元素溢出，也不会像 `transform: translateZ(0)` 引发布局计算浮点模糊或固定定位（`position: fixed`）坐标系错乱；
3. **零渲染代价**：纯合成器（Compositor）指令，不引起页面重排（Reflow），纯属层叠标记；
4. **刚性舱壁**：它在 `.filesBody` 节点上瞬间建立起一道物理级 Stacking Context 隔离舱，彻底切断舱内所有子元素向外部的逃逸通道！

#### 2.3.2 绝对层级隔离舱架构设计
结合应用全局层级定义（[apps/crish-desktop/src/styles/z-index.css](file:///c:/Software/conex/apps/crish-desktop/src/styles/z-index.css)），制定严密的层级架构：

```
[Level 0 ~ Level 3 拓扑隔离模型]

.filesCard (宿主根容器)
 │
 ├── .filesBar (顶部工具条)
 │    ├── 默认常态: position: relative; z-index: var(--z-dock, 10);
 │    └── 展开态 (.filesBar[data-flyout-open="true"]): z-index: var(--z-breadcrumb, 400);
 │         │
 │         └── .filesCrumbs (移除自身无意义的 z-index，完全透传)
 │              └── .filesBcFlyout [position: absolute; z-index: var(--z-breadcrumb, 400);]
 │                   (此时 filesBar 升级为 Level 3，彻底君临 filesBody 之上)
 │
 └── .filesBody (内容区分栏容器)
      ├── position: relative;
      ├── z-index: var(--z-base, 0);       <--- 锁定为 Level 0 底座
      └── isolation: isolate;              <--- 【关键隔离舱壁】
           │
           ├── .filesListPane
           ├── .filesSplitResizer [position: relative; z-index: 1;]  <--- 永远禁锢在 Level 0 舱内
           └── .filesDetailPane
```

#### 2.3.3 工程重构执行清单
1. **内容区隔离舱**：
   在 [FilesCard.module.css:498-504](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FilesCard.module.css#L498-L504) 对 `.filesBody` 进行改造：
   ```css
   .filesBody {
     flex: 1;
     min-height: 0;
     display: flex;
     flex-direction: column;
     overflow: hidden;
     position: relative;
     z-index: var(--z-base, 0);
     isolation: isolate; /* 建立原生层叠隔离舱，彻底截断内部元素向外溢出 */
   }
   ```
2. **顶栏层级规范化与动态升阶**：
   - 纠正 [FilesCard.module.css:35-51](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FilesCard.module.css#L35-L51) 中 `.filesBar` 的静态层级为 `--z-dock, 10`；
   - 移除 `.filesCrumbs` 上的 `z-index: var(--z-card-footer, 10);` 冗余声明，消除无效的多重层叠嵌套；
   - 增加动态升阶机制：通过 CSS `:has()` 伪类或 React 状态属性（如 `.filesBar[data-flyout-open="true"]`），在 `.filesBcFlyout` 展开时，动态将 `.filesBar` 的 `z-index` 升至 `var(--z-breadcrumb, 400)`；
3. **分割条层级局域收敛**：
   在 [FilesCard.module.css:587-597](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FilesCard.module.css#L587-L597) 中，将 `.filesSplitResizer` 的 `z-index: 10` 调整为 `z-index: 1`（局部层级），其唯一任务是保证拖拽手柄及 hover 光晕在同级 `.filesListPane` 和 `.filesDetailPane` 之上，绝不跨层溢出。

---

## 3. 面包屑搜索框 1:1 对齐 `ModelBadgePickerMenu` 规范方案

### 3.1 标杆解构：`ModelBadgePickerMenu` 视觉与交互基因
在 [ModelBadgePickerMenu.tsx:165-192](file:///c:/Software/conex/apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.tsx#L165-L192) 与 [ModelBadgePickerMenu.module.css:46-99](file:///c:/Software/conex/apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.module.css#L46-L99) 中，顶部一体化搜索栏已经确立了系统级的最高规范：

```
+---------------------------------------------------------------------------------+
| ModelBadgePickerMenu 顶部搜索一体化标杆形态                                     |
|                                                                                 |
|   [Search 14px 弱灰]  搜索模型或厂商...                      [SettingsBtn 24px] |
|                                                                                 |
| ────────────────────────────── 发丝底边 1px hairline ────────────────────────── |
+---------------------------------------------------------------------------------+
```

其核心设计标准包含四个不可动摇的维度：
1. **发丝底边一体化（Integrated Header with Hairline Divider）**：
   搜索栏不是被随意塞进浮层里的独立带边框方盒，而是作为浮层顶部的 Header 区。其四周无 border、无独立背景块，底部仅用一条极轻量发丝分割线（`1px solid var(--hairline, var(--border-subtle))`）与下方列表做物理隔离；
2. **形态 ④ 纯光标极简型（Pure Cursor Minimalist Input）**：
   输入框元素在全生命周期内（默认、hover、focus、focus-visible、active）保持**完全无边框（border: none）、完全无轮廓（outline: none）、完全无阴影投影（box-shadow: none）、完全透明背景（background: transparent）**。整个交互状态中，**只有原生的文本光标（caret）在闪烁，无任何粗黑描边或深灰光环**，杜绝任何视觉压迫；
3. **左侧弱灰矢量放大镜（Muted Search Icon）**：
   左侧固定精确尺寸为 14px 的放大镜图标（`Search`），前景色采用弱化辅助色（`var(--text-tertiary)`），不可缩放、不争夺视觉重心；
4. **右侧紧凑微动操作胶囊（Refined Action Button Group）**：
   右侧动作按钮采用 24×24px 正方形极简胶囊，`border: none; background: transparent; border-radius: var(--radius-sm, 4px)`。悬停时展现温和的高亮背景（`var(--bg-hover)`），并由项目自定义 `<Tooltip>` 刚性包裹，杜绝原生 HTML `title` 气泡。

### 3.2 真实代码对比：当前面包屑搜索栏缺陷定位

审查 [FileBreadcrumb.tsx:399-433](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FileBreadcrumb.tsx#L399-L433) 与 [FilesCard.module.css:282-328](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FilesCard.module.css#L282-L328)：

```tsx
// 当前旧代码：FileBreadcrumb.tsx
<div className={styles.filesBcFlyoutSearch}>
  <Search size={13} aria-hidden />
  <input
    ref={bcFilterRef}
    type="search"
    placeholder="筛选文件…"
    value={bcFlyout.filter}
    onChange={(e) => ...}
    onKeyDown={(e) => ...}
  />
  <Tooltip content={`在文件树中打开此目录 (${bcFlyout.anchorLabel}) (Enter)`}>
    <button type="button" className={styles.filesBcDirectOpenBtn} ...>
      <FolderOpen size={14} aria-hidden />
    </button>
  </Tooltip>
</div>
```

```css
/* 当前旧样式：FilesCard.module.css */
.filesBcFlyoutSearch {
  display: flex;
  align-items: center;
  gap: var(--space-1_5, 6px);
  padding: 4px 6px 4px 8px;
  margin-bottom: var(--space-1_5, 6px);
  border-radius: var(--radius-lg, 8px);
  border: 1px solid var(--border-subtle); /* 缺陷：粗糙外框 */
  background: var(--bg-card, #ffffff);   /* 缺陷：生硬卡片背景 */
  color: var(--text-tertiary);
  flex-shrink: 0;
}
```

**缺陷小结**：
- 采用了四周闭合的带圆角外框（`border: 1px solid var(--border-subtle)`），视觉被局限在一个方框内，显得笨重；
- 使用了 `type="search"` 原生属性，在 WebKit/Blink 内核中会触发非预期的原生清除小叉叉（`::-webkit-search-cancel-button`），破坏界面纯粹性；
- 外层 `.filesBcFlyout` 有 padding，搜索框又有 padding 和 margin-bottom，造成了“浮层嵌套方盒”的双层容器视觉包袱。

### 3.3 精确 JSX 结构重塑方案

为达到 1:1 对标效果，重塑后的 JSX 结构如下（保持无障碍属性与所有快捷键响应）：

```tsx
{/* 顶栏一体化极简发丝搜索栏 */}
<div className={styles.filesBcFlyoutHeader}>
  <Search size={14} className={styles.filesBcSearchIcon} aria-hidden />
  <input
    ref={bcFilterRef}
    type="text" /* 严禁 type="search"，避免原生 cancel 按钮污染 */
    className={styles.filesBcSearchInput}
    placeholder="筛选文件…"
    value={bcFlyout.filter}
    onChange={(e) =>
      setBcFlyout((prev) => (prev ? { ...prev, filter: e.target.value } : prev))
    }
    onKeyDown={(e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setBcFlyout(null);
        requestAnimationFrame(() => bcTriggerRef.current?.focus());
      } else if (e.key === 'Enter') {
        e.preventDefault();
        handleDirectOpenCurrentDir();
      }
    }}
  />

  {/* 动作组：有筛选内容时支持快捷清空，常驻支持 Enter 打开目录 */}
  <div className={styles.filesBcHeaderActions}>
    {bcFlyout.filter.trim() ? (
      <Tooltip content="清空筛选">
        <button
          type="button"
          className={styles.filesBcHeaderBtn}
          aria-label="清空筛选"
          onClick={() => {
            setBcFlyout((prev) => (prev ? { ...prev, filter: '' } : prev));
            bcFilterRef.current?.focus();
          }}
        >
          <X size={13} aria-hidden />
        </button>
      </Tooltip>
    ) : null}

    <Tooltip content={`在文件树中打开此目录 (${bcFlyout.anchorLabel}) (Enter)`}>
      <button
        type="button"
        className={styles.filesBcHeaderBtn}
        aria-label="在文件树中打开此目录"
        onClick={handleDirectOpenCurrentDir}
      >
        <FolderOpen size={14} aria-hidden />
      </button>
    </Tooltip>
  </div>
</div>
```

### 3.4 精确 CSS 模块化规范（对齐形态 ④）

在 [FilesCard.module.css](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FilesCard.module.css) 中对搜索栏样式进行全面重塑：

```css
/* ─────────────────────────────────────────────────────────────────────────
   面包屑下拉展开面板 (Flyout Tree View)
   ───────────────────────────────────────────────────────────────────────── */
.filesBcFlyout {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: var(--z-breadcrumb, 400);
  width: min(320px, 70vw);
  max-height: min(52vh, 400px);
  display: flex;
  flex-direction: column;
  padding: 4px; /* 从原先 8px 收敛为紧凑 4px，与 ModelBadgePickerMenu 6px/4px 统一 */
  border-radius: var(--radius-xl, 12px);
  border: 1px solid var(--border-color);
  background: var(--bg-elevated, #ffffff);
  box-shadow: var(--shadow-lg);
  overscroll-behavior: contain;
  white-space: normal;
  box-sizing: border-box;
}

/* 顶部一体化发丝下边框 Header */
.filesBcFlyoutHeader {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px 6px;
  margin-bottom: 2px;
  border-bottom: 1px solid var(--hairline, var(--border-subtle)); /* 核心发丝分割线 */
  flex-shrink: 0;
  box-sizing: border-box;
}

/* 左侧弱灰放大镜 */
.filesBcSearchIcon {
  color: var(--text-tertiary);
  flex-shrink: 0;
}

/* 形态 ④：纯光标极简 input (全态无框、无阴影、仅光标闪烁) */
.filesBcSearchInput,
.filesBcSearchInput:focus,
.filesBcSearchInput:focus-visible {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  padding: 2px 4px;
  font-family: inherit;
  font-size: var(--font-size-sm, 13px);
  color: var(--text-primary);
  outline: none;
  box-shadow: none;
  -webkit-appearance: none;
  appearance: none;
}

.filesBcSearchInput::placeholder {
  color: var(--text-tertiary);
}

/* 右侧动作按钮容器 */
.filesBcHeaderActions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

/* 24x24 极简微动胶囊按钮 */
.filesBcHeaderBtn {
  appearance: none;
  border: none;
  background: transparent;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  min-width: 24px;
  border-radius: var(--radius-sm, 4px);
  color: var(--text-secondary);
  cursor: pointer;
  padding: 0;
  transition: background var(--transition-micro, 100ms ease), color var(--transition-micro, 100ms ease);
}

.filesBcHeaderBtn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
```

---

## 4. “面包屑树逻辑维持现状”的绝对技术边界

### 4.1 用户裁决第一条的本质内涵
用户最高指示第 1 条指出：
> *“面包屑导航展开树逻辑维持现状，不用改！它是一个轻量补充面板，点击哪层就展示哪层的下级目录树，严禁重写或改动树逻辑！”*

这意味着：
- 面包屑的展开面板内部有且只有一套成熟稳定的局部树状态机与按需缓存遍历系统；
- **任何子 Agent 严禁以“抽象复用”、“代码精简”、“性能优化”、“虚拟滚动改造”等为借口，将该面板内的渲染与遍历逻辑重写**！

### 4.2 严格锁死的核心函数与状态白名单

在后续详细规划与代码实现中，以下核心逻辑与接口定义**必须原封不动维持现状**：

```
[严格不可变的核心技术资产清单]

1. 状态结构定义 FlyoutState [FileBreadcrumb.tsx:66-74]
   interface FlyoutState {
     anchorPath: string;                      // 必须保留：锚点目录绝对路径
     anchorLabel: string;                     // 必须保留：锚点标签名
     dirCache: Record<string, FsDirEntry[]>;  // 必须保留：局部目录结构按需缓存
     expandedPaths: Set<string>;              // 必须保留：展开路径集合
     loadingPaths: Set<string>;               // 必须保留：异步加载中集合
     loading: boolean;                        // 必须保留：初始加载指示
     filter: string;                          // 必须保留：当前过滤输入
   }

2. openBcFlyout 展开逻辑 [FileBreadcrumb.tsx:132-162]
   - 必须保持其针对 anchorPath 的初始化逻辑；
   - 必须保持 loadDir(dirPath) 的异步按需拉取并注入 dirCache；
   - 必须保持请求完成后的 requestAnimationFrame 焦点移动。

3. toggleExpand 逐级展开折叠逻辑 [FileBreadcrumb.tsx:164-221]
   - 必须保持已有缓存直接展开的 O(1) 逻辑；
   - 必须保持未缓存时更新 loadingPaths 并异步 fetch 目录的机制；
   - 必须保持对 expandedPaths 的 Set 更新不变量。

4. renderTreeNodes 递归渲染算法 [FileBreadcrumb.tsx:291-350]
   - 必须保持基于 depth 的动态缩进算法：paddingLeft: `${8 + depth * 14}px`；
   - 必须保持 sortEntries 对文件夹前置与字典序的排序规则；
   - 必须保持 ChevronRight 展开指示图标与旋转动画；
   - 必须保持空目录提示与加载中提示；
   - 必须保持点击目录切换展开、双击直达目录、点击文件调用 handleOpenFile。

5. filteredEntries 过滤计算属性 [FileBreadcrumb.tsx:270-289]
   - 必须保持基于已缓存 dirCache 深度优先遍历与搜索关键词匹配的纯函数算法。
```

### 4.3 严厉禁止的违规重构倾向（防过度发挥）

后续执行 Agent 必须逐条核对以下“红线禁止清单”，违者直接判定方案不合格：
1. **严禁引入外部大树 Hook**：严禁尝试将 `useTreeNavigation` 或主文件树的虚拟列表逻辑塞入 `FileBreadcrumb`。面包屑展开面板的 DOM 节点数量级极小（通常仅十几到几十项），递归 React.Fragment 足够轻快且无虚拟滚动跳动副作用；
2. **严禁改动 `dirCache` 存储结构**：严禁将其改为树状嵌套对象或外部全局 Store（如 Zustand、Redux）。局部组件 State 是实现局部闭包、避免污染外部单一真理源的最佳实践；
3. **严禁篡改外部导航协议**：`onNavigate(path)` 与 `onOpenFile(path)` 的调用契约必须保持不变；
4. **严禁破坏现存单测**：[FileBreadcrumb.test.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/files/__tests__/FileBreadcrumb.test.tsx) 中的 **11 个既有单元测试**是经过实战验证的刚性测试资产，重构后必须 100% 全部通过，绝不允许跳过或修改测试用例期望！

---

## 5. 后续详细规划文档（Detailed Plan）技术规范边界与负向清单

为确保下一阶段输出的《详细设计方案（Detailed Plan）》具备极高的严谨性与约束力，本节制定明确的技术规范边界与负向禁止清单。

### 5.1 Detailed Plan 必须写死的技术规范边界

| 维度 | 必须写死的硬性技术规范 |
| :--- | :--- |
| **文件作用域（File Scope）** | **严格限定在 3 个文件以内**：<br>1. `apps/crish-desktop/src/components/files/FilesCard.module.css`<br>2. `apps/crish-desktop/src/components/files/FileBreadcrumb.tsx`<br>3. `apps/crish-desktop/src/components/files/FilesCard.tsx`（仅限添加 `data-flyout-open` 状态标记） |
| **CSS 命名契约（BEM/Module）** | 必须采用标准统一的类名契约：<br>• `.filesBcFlyoutHeader`（顶栏发丝容器）<br>• `.filesBcSearchIcon`（14px 弱灰放大镜）<br>• `.filesBcSearchInput`（形态 ④ 纯光标输入框）<br>• `.filesBcHeaderActions`（动作按钮胶囊组）<br>• `.filesBcHeaderBtn`（24x24 极简动作按钮） |
| **层级 Token 映射契约** | 必须严格依托 `z-index.css`：<br>• `.filesBody` 绑定 `--z-base` (`0`) + `isolation: isolate`<br>• `.filesBar` 静态绑定 `--z-dock` (`10`)，展开态绑定 `--z-breadcrumb` (`400`)<br>• `.filesSplitResizer` 收敛至局部层级 `1`<br>• 严禁在任何规则中书写非规范的数字字面量 |
| **设计系统 Token 映射** | 必须依托 `tokens.css`：<br>• 发丝底边：`1px solid var(--hairline, var(--border-subtle))`；<br>• 文本与图标弱灰：`var(--text-tertiary)`；<br>• 悬停背景：`var(--bg-hover)`；<br>• 浮层容器：`var(--bg-elevated)` + `var(--border-color)` + `var(--shadow-lg)` |
| **测试刚性门禁（Quality Gate）** | 必须要求执行以下回归与验证：<br>`npx vitest run apps/crish-desktop/src/components/files/__tests__/FileBreadcrumb.test.tsx`<br>必须 11 个测试全部 Pass，无 Warning、无降级。 |

### 5.2 负向禁止清单（Negative Checklist / Guardrails）

在 Detailed Plan 中必须逐项列出并要求后续实施 Agent 严格签字遵守：

```markdown
### 实施 Agent 负向禁止清单（违规零容忍）

[CSS 布局与层叠维度]
[ ] 严禁在 .filesBcFlyout 或其子元素上随意设置超过 --z-breadcrumb (400) 的魔术数字（如 9999, 99999）。
[ ] 严禁修改 .filesSplitResizer 为 z-index: 0 或负值（防止破坏拖拽手柄命中区与 hover 态）。
[ ] 严禁对 .filesBody 使用 overflow: visible 或修改其 flex 布局尺寸（破坏分栏滚动）。
[ ] 严禁在 .filesBcSearchInput 上添加常规 border、focus border、box-shadow 或 outline（严格保持形态 ④ 纯光标）。
[ ] 严禁破坏现有 .filesBar、.filesCrumbs 的语义结构。

[组件与交互维度]
[ ] 严禁使用原生 HTML title 属性作为提示（必须使用项目自定义 <Tooltip> 组件）。
[ ] 严禁使用 type="search"（必须使用 type="text" 并自定义清空逻辑，规避原生浏览器伪元素干扰）。
[ ] 严禁改动面包屑下拉面板内的树状展示结构（openBcFlyout, toggleExpand, renderTreeNodes 维持现状）。
[ ] 严禁改动 dirCache 的缓存读写逻辑与 FsDirEntry 结构。
[ ] 严禁破坏已有的键盘快捷键逻辑（Escape 关闭恢复焦点、Enter 在文件树中打开当前目录）。

[工程与 Git 维度]
[ ] 严禁执行 git commit（提交权仅归主 Agent）。
[ ] 严禁使用 --no-verify 绕过代码格式化或类型检查。
[ ] 严禁修改除了 FilesCard.module.css、FileBreadcrumb.tsx、FilesCard.tsx 之外的无关业务文件。
```

---

## 6. 总结与后续流程推进建议

### 6.1 方案成效预期与架构增益
本战略分析通过深入 W3C CSS 规范与真实的组件源码，为后续开发明确了清晰的路径：
1. **彻底消除穿透**：通过原生 `isolation: isolate` 隔离舱与 `z-index: var(--z-base, 0)` 组合，从代数上完全封闭了 `.filesSplitResizer` 的跨层冒泡，终结了长久以来的视觉 Bug；
2. **视觉极简统一**：1:1 对齐标杆 `ModelBadgePickerMenu` 的形态 ④ 搜索框，消除粗糙边框与杂色，实现精致的一体化发丝下边框质感；
3. **架构安全收敛**：严格保护既有轻量面包屑树逻辑，杜绝过度设计与重复造轮子，使代码修改量最小化（仅聚焦样式与局部 JSX 结构），极大降低回归风险。

### 6.2 下一步行动建议
建议主 Agent 在接收本分析报告后，指示 Detailed Plan 规划者以此为蓝本编制详细实施规范，并在进入编码阶段后严格按本报告规定的白名单与负向禁止清单实施验收。
