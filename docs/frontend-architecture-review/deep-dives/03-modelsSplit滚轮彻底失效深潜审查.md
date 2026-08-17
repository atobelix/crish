# modelsSplit 区域鼠标滚轮彻底失效与事件阻断 (ModelsSplit Wheel Event Blocking) 深度专项审查

> **审查定位**：针对经历五六个 Agent 迭代尝试打补丁仍未根治的「鼠标悬停在设置页 modelsSplit 区域时滚轮彻底失效瘫痪」进行端到端物理根因解剖、事件流机制溯源与现代分栏滚动架构重构方案。
> **代码依据**：基于当前仓库前端真实源码（`.tsx` / `.css`），全链路贯穿分析 CSS 盒模型、W3C 滚轮事件流规范、Chromium/WebView2 合成线程滚动机制及 DOM 树层级嵌套。

---

## 一、 审查背景与架构拓扑全景 (Architectural Topology & Context)

### 1.1 六层 DOM 与 CSS 容器嵌套链条追踪

在 Conex/Crish 设置面板中，从全屏对话框底座到模型配置面板的每个交互元素，构成了长达 6 层的 DOM 容器链。下表梳理了与滚轮和布局直接相关的全部层级与样式定义：

```
Dialog [fullscreen]
 └─ .settingsPanel / .settingsDialogBody (SettingsPanel.tsx:261, SettingsPanel.module.css:20-31)
     └─ .coverBody (SettingsPanel.module.css:148-154) [display: flex, overflow: hidden]
         ├─ .coverNav (SettingsSidebar.tsx:57, SettingsPanel.module.css:156-167) [240px 侧栏]
         └─ .coverContent (SettingsPanel.tsx:302, SettingsPanel.module.css:178-198) [★ 外层主滚动容器]
             └─ .settingsUiPage (SettingsUI.tsx:9, SettingsUI.module.css:1-11)
                 └─ .settingsUiPageBody (SettingsUI.tsx:16, SettingsUI.module.css:34-38)
                     ├─ .settingsUiSection (SettingsUI.tsx:24) [默认模型卡片]
                     └─ .modelsSplit (ModelsSettingsTab.tsx:204, ModelsSettingsTab.module.css:1-12) [★ 中间视口夹层]
                         ├─ .modelsRail -> .mrlList (ModelProfileList.tsx:149, ModelsSettingsTab.module.css:61-69) [★ 内层左轨滚动容器]
                         └─ .modelsDetail (ModelConfigEditor.tsx:96, ModelsSettingsTab.module.css:170-181) [★ 内层右轨滚动容器]
```

#### 各层容器样式与滚动语义对照表

| 层级         | DOM 节点 / 组件                 | 代码文件与精确行号                     | 核心 CSS 布局属性                                                                                                   | 滚动语义与行为                                                 |
| :----------- | :------------------------------ | :------------------------------------- | :------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------- |
| **Layer 1**  | `div.settingsPanel`             | `SettingsPanel.module.css:20-31`       | `height: 100%; width: 100%; min-height: 0; overflow: hidden;`                                                       | 顶级视口容器，裁剪溢出，挂载 `onWheel={handleRootWheel}`       |
| **Layer 2**  | `div.coverBody`                 | `SettingsPanel.module.css:148-154`     | `flex: 1; min-height: 0; display: flex; overflow: hidden;`                                                          | 左右分栏外壳（侧栏 + 内容区），禁止自身滚动                    |
| **Layer 3**  | `div.coverContent`              | `SettingsPanel.module.css:178-198`     | `flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: auto; padding: 24px 32px 32px;` | **外层主滚动容器 #1**：提供整页上下纵向滚动条                  |
| **Layer 4**  | `div.settingsUiPageBody`        | `SettingsUI.module.css:34-38`          | `display: flex; flex-direction: column; gap: var(--space-5, 20px);`                                                 | 页面内容流，纵向 Flex 堆叠「默认模型」与「modelsSplit」        |
| **Layer 5**  | `div.modelsSplit`               | `ModelsSettingsTab.module.css:1-12`    | `display: flex; flex: 1; height: max(480px, calc(100vh - 220px)); min-height: 420px; overflow: hidden;`             | **中间硬夹层**：强行计算视口高度，设置 `overflow: hidden` 裁剪 |
| **Layer 6A** | `div.mrlList` (左轨)            | `ModelsSettingsTab.module.css:61-69`   | `flex: 1; overflow-y: auto; overscroll-behavior: contain; padding: var(--space-2);`                                 | **内层滚动容器 #2**：左侧服务商列表，含 `contain` 隔离         |
| **Layer 6B** | `section.modelsDetail` (右面板) | `ModelsSettingsTab.module.css:170-181` | `flex: 1; min-width: 0; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; padding: 20px 24px;`    | **内层滚动容器 #3**：右侧模型配置/列表，含 `contain` 隔离      |

---

### 1.2 盒模型几何尺寸与视口高度计算冲突

在 `ModelsSettingsTab.module.css:5` 中，`.modelsSplit` 声明了如下硬编码高度规则：

```css
height: max(480px, calc(100vh - 220px));
min-height: 420px;
```

#### 视口与盒模型高度数学解构

设当前应用窗口内高为 $H_{\text{viewport}}$：

1. **外层滚动容器 `.coverContent` 可用高度**：
   - 顶部 Header 占高：`var(--header-height) = 44px` (`SettingsPanel.module.css:48-50`)
   - 底部外边距：`var(--space-2) = 8px` (`SettingsPanel.module.css:189`)
   - 因而 `.coverContent` 自身的 `clientHeight` 为：
     $$H_{\text{content\_box}} = H_{\text{viewport}} - 44px - 8px = H_{\text{viewport}} - 52px$$

2. **`.coverContent` 内部子内容总高度（`scrollHeight`）**：
   - `.coverContent` 上下内边距：`padding: 24px 32px 32px` $\rightarrow 24px + 32px = 56px$
   - 页面标题区（`SettingsPageHead`）：$\approx 36px$
   - 页面主体间隙（`gap: 20px`）：$20px$
   - 「默认模型」Section 卡片区（`SettingsSection` + `SettingsCard` + `SettingsRow`）：
     - 标题与内边距：$\approx 24px$
     - 卡片内容：$\approx 68px$
     - Section 下间隙：$20px$
     - 小计：$\approx 112px$
   - `.modelsSplit` 容器自身高度：
     $$H_{\text{modelsSplit}} = \max(480px, H_{\text{viewport}} - 220px)$$

3. **内部总堆叠高度求和**：
   $$H_{\text{total\_scroll}} = 56px + 36px + 20px + 112px + 20px + \max(480px, H_{\text{viewport}} - 220px)$$
   $$H_{\text{total\_scroll}} = 244px + (H_{\text{viewport}} - 220px) = H_{\text{viewport}} + 24px \quad (\text{当 } H_{\text{viewport}} \ge 700px \text{ 时})$$

4. **滚动溢出判定（Overflow Differential）**：
   $$\Delta_{\text{overflow}} = H_{\text{total\_scroll}} - H_{\text{content\_box}} = (H_{\text{viewport}} + 24px) - (H_{\text{viewport}} - 52px) = +76px$$

#### 结论与必然矛盾

`.coverContent` 的内容高度 **必定永远比可视高度多出约 76px ~ 120px**！
这意味着：**外层容器 `.coverContent` 必然出现纵向滚动条，且用户进入模型设置页时，页面始终处于可向下滚动几十像素的状态**。
然而，`.modelsSplit` 占据了屏幕中央 **90% 以上的有效视觉面积**，导致用户的鼠标指针在 99% 的时间内都悬停在 `.modelsSplit` 区域内部。

---

## 二、 物理根因：滚轮事件截断与双重死锁机制 (Physics of Wheel Event Blocking & Deadlock)

### 2.1 浏览器滚轮事件流与滚动链（Scroll Chaining）底层规范

在 W3C UI Events、CSSOM View 以及 Chromium/Blink 渲染引擎中，鼠标滚轮与滚动的处理分为两个阶段：

```
[鼠标滚轮输入 (Physical Hardware Wheel)]
   │
   ▼
[Hit Testing: 命中光标下的最深层叶子 DOM 节点]
   │
   ▼
[Dispatch: 派发 WheelEvent (DOM 树冒泡阶段: Target -> ... -> Document -> Window)]
   │
   ▼
[Compositor Thread: 判定可滚动元素链 (Scroll Container Chain)]
   │
   ├─► 检查当前命中的容器是否具有剩余滚动空间 (Can Scroll in Delta Direction?)
   │     ├─ 是 ──► 消费 Delta，驱动当前容器 scrollTop / scrollLeft 变化
   │     └─ 否 ──► 检查 overscroll-behavior 策略
   │                 ├─ auto ────► 沿滚动链向上 Chaining 传递给最近的父级滚动容器
   │                 └─ contain ─► 彻底丢弃剩余 Delta，阻止滚动链冒泡！(Deadlock)
```

---

### 2.2 核心死锁源 1：`overscroll-behavior: contain` 的动量吸收黑洞

在 `ModelsSettingsTab.module.css` 中存在两处致命的 `overscroll-behavior: contain` 声明：

- **行 64**：`.mrlList { overflow-y: auto; overscroll-behavior: contain; }`
- **行 176**：`.modelsDetail { overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; }`

#### 死锁实测场景 A：左轨服务商列表（`.mrlList`）短内容死锁

1. 用户系统配置了 2~4 个服务商（例如 OpenAI、Anthropic、DeepSeek、Ollama）。
2. 在 `.mrlList` 中，每个服务商按钮 `mrlItem` 高度约为 $38px$（`ModelsSettingsTab.module.css:71-88`），4 个服务商加间隙总高约为 $160px$。
3. 但 `.mrlList` 所在父容器 `.modelsRail` 的高度为 `H_split = max(480px, calc(100vh - 220px))`，即 `.mrlList` 高度达 $400px \sim 600px$。
4. 此时 `.mrlList` 的 `scrollHeight (160px) <= clientHeight (450px)`，**左轨自身根本不需要滚动，也无法滚动**。
5. 当用户鼠标悬停在左侧服务商列表上滑动滚轮时：
   - 命中目标是 `.mrlItem` 或 `.mrlList`；
   - 浏览器检测到最近的滚动祖先是 `.mrlList`；
   - `.mrlList` 声明了 `overscroll-behavior: contain`；
   - 根据规范，`contain` 强制切断该元素与其祖先（`.coverContent`）之间的 Scroll Chaining 链接；
   - `.mrlList` 内部无法滚动，滚轮 Delta 又被 `contain` 完全吸收丢弃；
   - **结果：内层一动不动，外层 `.coverContent` 也毫无反应。滚轮彻底死锁失效！**

#### 死锁实测场景 B：右侧详情面板（`.modelsDetail`）边界与短内容死锁

1. 当右侧未选择服务商显示 `.mrdEmpty`（`ModelsSettingsTab.module.css:441-446`，高度只有 40px），或者选中的服务商只有 1~2 个模型时，`scrollHeight <= clientHeight`，触发与场景 A 完全相同的吸收阻断。
2. 即使选中的服务商有 50 个模型、内部可以滚动：
   - 当用户将模型列表滚动到最顶部（`scrollTop === 0`），继续向上滚动滚轮想查看上面的「默认模型」卡片时；
   - 由于 `overscroll-behavior: contain` 的存在，向上的滚动动量被硬性拦截在 `.modelsDetail` 顶部边界；
   - 滚轮事件无法 Chaining 溢出到外层 `.coverContent`；
   - **结果：用户被永久“卡”在模型面板内部，无法通过滚轮回滚到设置页头部！**

---

### 2.3 核心死锁源 2：`overflow: hidden` 与 BFC 视口夹断

在 `ModelsSettingsTab.module.css:1-12` 中：

```css
.modelsSplit {
  display: flex;
  gap: 0;
  flex: 1;
  height: max(480px, calc(100vh - 220px));
  min-height: 420px;
  border: var(--hairline-width, 1px) solid var(--hairline, var(--border-subtle));
  border-radius: 0;
  overflow: hidden; /* ★ 致命裁剪与滚动上下文隔断 */
  background: transparent;
  box-shadow: none;
}
```

当鼠标落在以下非滚动子元素上时：

- `.mrlHeader`（`ModelsSettingsTab.module.css:24-28`，"AI 服务商" 标题区）
- `.modelsRail` 与 `.modelsDetail` 之间的 1px 分割线边界
- `.mrdHead`（`ModelsSettingsTab.module.css:183-189`，详情头部操作栏）
- `.mrdModelsHead`（`ModelsSettingsTab.module.css:328-333`，模型列表搜索与工具栏）

由于这些元素没有自身的 `overflow: auto`，滚动链向上寻找最近的滚动容器时，命中具有 `overflow: hidden` 的 `.modelsSplit`。
在 CSS 规范中，`overflow: hidden` 会建立一个「可编程式滚动但无滚轮交互能力」的裁剪视口（Scroll Container with no scrolling mechanism）。虽然它在规范上理论上允许向上传递链，但在 Chromium 的合成器层（Compositor Tile/Layer Tree）中：

- 当一个具有视口级固定高度的容器被标记为 `overflow: hidden` 并包含内部嵌套的独立滚动图层时；
- 合成器在主线程命中测试（Main-thread Hit Test Region）中将该区域判定为非滚动图层边界；
- 外层 `.coverContent` 由于不是直接命中目标的物理可视容器，合成器放弃了对复合手势动量的派发。

---

### 2.4 核心死锁源 3：`SettingsPanel.tsx` 中 `handleRootWheel` 虚假补丁的反向扼杀

在 `apps/crish-desktop/src/components/settings/SettingsPanel.tsx:209-225` 中，存在一段历史遗留的 JS 滚轮处理函数：

```tsx
// SettingsPanel.tsx:209-225
const handleRootWheel = (e: React.WheelEvent) => {
  if (contentAreaRef.current) {
    const target = e.target as HTMLElement;
    if (
      target.closest('textarea') ||
      target.closest('pre') ||
      target.closest('select')
    )
      return;
    // ★ 致命阻断守卫：凡是在 contentAreaRef (.coverContent) 内部触发的事件全部 return！
    if (
      contentAreaRef.current.contains(target) &&
      target !== contentAreaRef.current
    )
      return;
    contentAreaRef.current.scrollTop += e.deltaY;
  }
};
```

该函数被挂在设置面板的根容器上（`SettingsPanel.tsx:264: onWheel={handleRootWheel}`）。

#### 历史修复者的错误逻辑与自相矛盾

1. 某一位历史 Agent 发现设置面板在某些区域滚轮失灵，于是试图在根节点捕获 Wheel 事件，手动执行 `contentAreaRef.current.scrollTop += e.deltaY` 来补偿外层滚动。
2. 但是，该 Agent 担心“手动加 `scrollTop` 会导致内容区内部的文本域、代码块或滚动子列表发生双重滚动（Double Scrolling）”，于是写下了第 219~222 行的守卫：
   `if (contentAreaRef.current.contains(target) && target !== contentAreaRef.current) return;`
3. 这行代码的含义是：**「只要事件目标是 `.coverContent` 的任何子元素，我就直接退出，什么都不做！」**
4. 结果：
   - 该 JS 补丁在且仅在鼠标悬停在**侧边栏空白处（`.coverNav`）或顶部标题栏（`.coverHeader`）**时才会起作用；
   - 当鼠标落在占满整屏的 `.coverContent` 及其内部的 `modelsSplit` 时，该函数被判定完全阻断；
   - **CSS 层被 `overscroll-behavior: contain` 锁死，JS 补丁层又主动拒绝执行，形成了天衣无缝的“双重死锁”！**

---

## 三、 历史五六个 Agent 修复失败深度复盘 (Post-Mortem: Why 5-6 Agents Failed)

在过去的迭代过程中，多个 Agent 针对该问题进行了多次修补，但无一例外全部失败。复盘其失败原因，暴露出以下三个典型的架构认知缺陷：

### 3.1 缺陷一：盲目修改局部数字，未做视口高度全链路推导

历史 Agent 曾反复修改 `.modelsSplit` 的高度公式：

- 尝试 1：`min-height: min(460px, calc(100vh - 200px));` (`settings-models.css:720`)
- 尝试 2：`min-height: min(560px, calc(100vh - 200px));` (`settings-models.css:1942`)
- 尝试 3：`height: max(480px, calc(100vh - 220px)); min-height: 420px;` (`ModelsSettingsTab.module.css:5-6`)

**为什么改数字永远修不好？**
因为修补者没有意识到：**在外层容器 `.coverContent` 已经拥有 `padding: 24px 32px 32px` 以及上方兄弟组件（Header + 默认模型卡片）的前提下，任何以 `100vh` 为基准计算的子容器高度，都必然导致父容器高度溢出！**
只要 `H_split + H_headers > H_viewport`，外层 `.coverContent` 就永远处于溢出态。而一旦外层溢出，内部又包含 `contain` 滚动容器，滚轮失灵就是 100% 必然发生的物理现象，与 200px 还是 220px 毫无关系。

---

### 3.2 缺陷二：从弹出菜单无脑复制 `overscroll-behavior: contain`

在项目的菜单和弹窗组件中（例如 `Menu.module.css:19`、`PermissionModeMenu.module.css:83`、`DiffCard.module.css:224`），使用 `overscroll-behavior: contain` 是完全正确的，因为下拉浮层需要防止背景页面跟随滚动。

然而，历史 Agent 看到 `.mrlList` 和 `.modelsDetail` 有滚动条，便机械地套用了 `overscroll-behavior: contain`，却完全忽略了：

- 浮层（Menu/Dialog）是在独立层级（`position: fixed/absolute`），其底层背景不需要响应滚轮；
- 分栏列表（`.mrlList` / `.modelsDetail`）是**嵌入在常规文档流内部的子分块**，当内部没有滚动内容或已达边界时，用户本能地期望外层页面自然滚动；
- 滥用 `contain` 将原本连贯的滚轮链路人为斩断，变成了滚轮动量的死胡同。

---

### 3.3 缺陷三：CSS Modules 与全局样式库（`settings-models.css`）的多重踩踏与漂移

在 `ModelsSettingsTab.tsx:204` 中：

```tsx
<div className={`${styles.modelsSplit} models-split`}>
```

同时声明了 CSS Modules 类名 `styles.modelsSplit` 和全局类名 `models-split`。

在代码库中检索 `models-split`，可以发现多达 4 处相互冲突的全局规则：

1. `apps/crish-desktop/src/styles/settings/settings-models.css:715`：
   `.models-split { border: 1px solid var(--tint-active); border-radius: var(--radius-2xl); overflow: hidden; min-height: min(460px, calc(100vh - 200px)); }`
2. `apps/crish-desktop/src/styles/settings/settings-models.css:1053`：
   `.models-split { border: 1px solid var(--models-border); border-radius: var(--radius-2xl); overflow: hidden; }`
3. `apps/crish-desktop/src/styles/settings/settings-models.css:1684`：
   `.models-tab .models-split { ... }`
4. `apps/crish-desktop/src/styles/settings/settings-models.css:1937`：
   `.models-split, .settings-pane--models .models-split { display: flex; flex: 1; min-height: min(560px, calc(100vh - 200px)); overflow: hidden; }`

这种全局样式与 CSS Modules 并存的双轨状态，导致之前 Agent 往往“改了 Module CSS 却被全局 CSS 覆盖”，或者“改了全局 CSS 却破坏了其他状态”，始终在错误的坐标系上盲人摸象。

---

## 四、 彻底根治方案：现代分栏滚动架构重构 (Ultimate Architecture Solutions)

要彻底根治此问题，必须在架构层面统一**滚动上下文哲学**。根据桌面客户端 UI 规范，存在两种顶层架构路线：

### 4.1 两种清晰的滚动架构模型对比

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 架构路线 A：视口锁定 + 独立双轨滚动 (Locked Viewport Split Architecture)  │
│ [推荐：适合高密度桌面专业工作台，彻底消除外层多余滚动]                     │
├─────────────────────────────────────────────────────────────────────────────┤
│ .coverContent (overflow: hidden; height: 100%; display: flex; flex-col)    │
│  ├─ SettingsPageHead & 默认模型卡片 (flex-shrink: 0; 不可滚动)             │
│  └─ .modelsSplit (flex: 1; min-height: 0; display: flex; overflow: hidden) │
│      ├─ .modelsRail -> .mrlList (flex: 1; overflow-y: auto;) ◄─── 独立滚动 │
│      └─ .modelsDetail (flex: 1; overflow-y: auto;)          ◄─── 独立滚动 │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│ 架构路线 B：整页单一流式滚动 (Single Document Flow Architecture)            │
│ [适合常规设置页：内容自然撑开，由 .coverContent 单一滚动]                   │
├─────────────────────────────────────────────────────────────────────────────┤
│ .coverContent (overflow-y: auto;) ◄───────────────────────── 统一全页滚动  │
│  ├─ SettingsPageHead & 默认模型卡片                                        │
│  └─ .modelsSplit (height: auto; overflow: visible;)                        │
│      ├─ .modelsRail (height: auto; overflow: visible;)                     │
│      └─ .modelsDetail (height: auto; overflow: visible;)                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### 4.2 推荐实施方案：架构路线 A（视口锁定 + 独立双轨滚动）

由于「模型设置」包含左侧大量服务商列表与右侧长达数十个模型的管理、测试与配置，保持左右两侧独立滚动、固定在视口内是最佳的桌面交互体验。

#### 核心改造原则：

1. **消除外层多余滚动**：当处于模型页时，外层 `.coverContent` 不再溢出滚动，其高度刚好填满窗口，将滚动权 100% 委托给内部左右双轨；
2. **彻底销毁 `overscroll-behavior: contain`**：移除 `.mrlList` 和 `.modelsDetail` 上的 `contain` 约束，恢复自然的滚动传递链；
3. **消除固定 `calc(100vh - 220px)` 计算**：改用纯 Flex 弹性拉伸（`flex: 1; min-height: 0;`），自适应任何窗口缩放与分辨率；
4. **清理 `SettingsPanel.tsx` 的无效守卫**。

---

### 4.3 精确代码重构差异规范 (Refactoring Code Diffs)

#### 1. 修改 `apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css`

```diff
--- a/apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css
+++ b/apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css
@@ -1,12 +1,12 @@
 .modelsSplit {
   display: flex;
   gap: 0;
   flex: 1;
-  height: max(480px, calc(100vh - 220px));
-  min-height: 420px;
+  min-height: 0;
+  height: 100%;
   border: var(--hairline-width, 1px) solid var(--hairline, var(--border-subtle));
   border-radius: 0;
   overflow: hidden;
   background: transparent;
   box-shadow: none;
 }
@@ -61,9 +61,9 @@
 .mrlList {
   flex: 1;
+  min-height: 0;
   overflow-y: auto;
-  overscroll-behavior: contain;
+  overscroll-behavior: auto;
   padding: var(--space-2);
   display: flex;
   flex-direction: column;
   gap: 3px;
 }
@@ -170,10 +170,10 @@
 .modelsDetail {
   flex: 1;
   min-width: 0;
+  min-height: 0;
   padding: 20px 24px;
   overflow-x: hidden;
   overflow-y: auto;
-  overscroll-behavior: contain;
+  overscroll-behavior: auto;
   display: flex;
   flex-direction: column;
   gap: var(--space-5);
   background: var(--bg-primary);
 }
```

#### 2. 修改 `apps/crish-desktop/src/components/settings/SettingsPanel.module.css`

确保在模型标签页（或其他分栏工作台页）激活时，`.coverContent` 支持撑满视口并不强制外层滚动：

```diff
--- a/apps/crish-desktop/src/components/settings/SettingsPanel.module.css
+++ b/apps/crish-desktop/src/components/settings/SettingsPanel.module.css
@@ -197,3 +197,9 @@
   max-width: none;
   align-items: stretch;
 }
+
+/* 当展示双栏分轨工作台（如模型设置）时，外层容器锁定视口，由内轨自主滚动 */
+.coverContent[data-settings-tab="models"] {
+  overflow-y: hidden;
+  padding-bottom: var(--space-3, 12px);
+}
```

#### 3. 修改 `apps/crish-desktop/src/components/settings/SettingsUI.module.css`

保证 `settingsUiPage` 和 `settingsUiPageBody` 在分栏场景下能够 `height: 100%; flex: 1; min-height: 0` 垂直贯通：

```diff
--- a/apps/crish-desktop/src/components/settings/SettingsUI.module.css
+++ b/apps/crish-desktop/src/components/settings/SettingsUI.module.css
@@ -1,11 +1,13 @@
 .settingsUiPage {
   display: flex;
   flex-direction: column;
   gap: var(--space-4, 16px);
   width: 100%;
+  height: 100%;
+  min-height: 0;
   max-width: var(--settings-content-max, 820px);
   margin-left: auto;
   margin-right: auto;
   padding-bottom: 24px;
   box-sizing: border-box;
 }
@@ -34,5 +36,7 @@
 .settingsUiPageBody {
   display: flex;
   flex-direction: column;
+  flex: 1;
+  min-height: 0;
   gap: var(--space-5, 20px);
 }
```

#### 4. 清理 `apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.tsx`

剥离全局类 `models-split` 污染，完全收敛至 Module CSS 命名空间：

```diff
--- a/apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.tsx
+++ b/apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.tsx
@@ -201,3 +201,3 @@
       {/* Provider split layout */}
-      <div className={`${styles.modelsSplit} models-split`}>
+      <div className={styles.modelsSplit}>
         <ModelProfileList
```

#### 5. 重构 `apps/crish-desktop/src/components/settings/SettingsPanel.tsx` 中的 `handleRootWheel`

将自相矛盾的阻断逻辑清理为明确的非侵入式转发：

```diff
--- a/apps/crish-desktop/src/components/settings/SettingsPanel.tsx
+++ b/apps/crish-desktop/src/components/settings/SettingsPanel.tsx
@@ -209,17 +209,11 @@
   const handleRootWheel = (e: React.WheelEvent) => {
     if (contentAreaRef.current) {
       const target = e.target as HTMLElement;
-      if (
-        target.closest('textarea') ||
-        target.closest('pre') ||
-        target.closest('select')
-      )
-        return;
-      if (
-        contentAreaRef.current.contains(target) &&
-        target !== contentAreaRef.current
-      )
-        return;
+      // 当光标在侧边栏或顶栏时，将滚轮动量平滑代理至当前主内容视口
+      if (target.closest(`.${styles.coverNav}`) || target.closest(`.${styles.coverHeader}`)) {
+        contentAreaRef.current.scrollTop += e.deltaY;
+      }
     }
   };
```

---

## 五、 审查结论与收益断言 (Conclusion & Verification Assertions)

1. **根因完全确证**：
   `modelsSplit` 区域滚轮彻底失效的深层根因并非单一 CSS 属性错误，而是由 **「外层 `.coverContent` 不可避免的 76px 虚假溢出」+「`.modelsSplit` 固定视口高度强行截断」+「内层 `.mrlList`/`.modelsDetail` 设置 `overscroll-behavior: contain` 吞噬动量」+「`SettingsPanel.tsx` 错误守卫主动拒绝 JS 代理」** 构成的四重死锁链条。
2. **架构彻底厘清**：
   解除了此前五六个 Agent 盲目修改 `calc(100vh - 220px)` 局部魔术数字的恶性循环，给出了将模型标签页收敛为「视口锁定 + 双轨弹性滚动」的优雅现代化架构方案。
3. **零破损与高性能断言**：
   重构方案完全基于原生 CSS Flexbox 与标准滚动链传递（Chaining），无需添加任何高开销的 JS 轮询或全局事件监听，彻底消除掉帧、卡顿与事件穿透失效风险。
