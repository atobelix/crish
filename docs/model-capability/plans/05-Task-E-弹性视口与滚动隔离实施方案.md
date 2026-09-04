# Task-E 弹性视口与滚动隔离实施方案

> **文档标识**：`docs/model-capability/plans/05-Task-E-弹性视口与滚动隔离实施方案.md`  
> **任务代号**：`Task-E`（弹性视口与滚动隔离工程师）  
> **制定时间**：2026-09-03  
> **输入基线**：
> - [`00-AI服务商与模型管理全面重构终极方案.md`](file:///c:/Software/conex/docs/model-capability/00-AI服务商与模型管理全面重构终极方案.md)
> - [`01-多Agent协同实现方案与任务分工总纲.md`](file:///c:/Software/conex/docs/model-capability/01-多Agent协同实现方案与任务分工总纲.md)
> - [`05-DOM几何渲染与滚动隔离深度审计.md`](file:///c:/Software/conex/docs/model-capability/plan-reviews/05-DOM几何渲染与滚动隔离深度审计.md)
> - [`05-视口弹性布局与滚动穿透根治方案.md`](file:///c:/Software/conex/docs/model-capability/analysis/05-视口弹性布局与滚动穿透根治方案.md)  
> **物理文件域白名单（本任务严格限写以下 3 个文件）**：
> 1. `apps/crish-desktop/src/components/settings/SettingsPanel.module.css`
> 2. `apps/crish-desktop/src/components/settings/SettingsPanel.tsx`
> 3. `apps/crish-desktop/src/components/settings-models/ModelConfigEditor.tsx`  
> **执行纪律**：遵循 `AGENTS.md` §1 反退避原则与 §7 严禁打补丁；只修改白名单内文件；不执行 git 提交。

---

## 一、 方案执行目标与核心攻坚点

本方案旨在从根本上解决用户反馈的 **“鼠标滚动滑动，整个界面跟着滑动，很奇怪”** 以及在设置面板「模型」标签页下的滚动穿透、2x 加速度双倍速狂飙、搜索框随列表滚走、极端扁平视口下按钮截断等严重视觉与交互体验缺陷。

### 1.1 核心攻坚交付物清单
1. **彻底拔除魔术数字与锁定外层视口**：
   - 阐明 `calc(100vh - 220px)` 的病态机理并与 Task-D 协同拔除；
   - 在 `SettingsPanel.module.css` 中针对 `[data-settings-tab="models"]` 实施刚性视口锁定，从物理层抹除外层 `.coverContent` 的垂直滚动行程（scrollport），根除页面整体向上滑动。
2. **修复 `handleRootWheel` 逻辑缺陷与双倍速狂飙漏洞**：
   - 在 `SettingsPanel.tsx` 的 `handleRootWheel` 中设立 `safeActiveTab === 'models'` 入口守卫，工作区视口型 Tab 零干预；
   - 修复内边距空白判定（`target === contentAreaRef.current`），根除浏览器原生滚动与 JS 手动累加叠加造成的 2x 双倍速滚动狂飙。
3. **`ModelConfigEditor.tsx` 重构为三段式流式架构**：
   - **第一段：置顶固定头部**（`ProfileHeader` + `ProviderProfileForm`）：声明 `max-height: min(45%, 240px); overflow-y: auto;` 弹性上限，彻底化解 DEF-GEO-01 审计指出的极小视口/高 DPI 下按钮被物理裁切死锁缺陷；
   - **第二段：置顶固定操作栏**（`ModelListHeader` + `ManualAddForm`）：保证搜索框、检测/扫描按钮永远吸顶可见，手填抽屉具备弹性上限与滚动自保底；
   - **第三段：局部独立模型滚动视口**（`mrdModelListScroll` 包裹 `ModelList`）：声明 `flex: 1 1 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain;`，并在外层挂载 `onWheel={(e) => e.stopPropagation()}`，实现动量吸收与事件阻断双重防护。

---

## 二、 根因穿透分析与几何力学证明

### 2.1 `calc(100vh - 220px)` 导致 88px~188px 恒定溢出的数学推导

在当前历史实现中，外层 `.coverContent` 始终具备一个不应存在的纵向滚动行程。这是由于历史代码试图用魔术数字 `calc(100vh - 220px)` 猜测视口剩余空间，但**220px 严重少估了顶部的真实物理占位**：

| 垂直层级 / DOM 节点 | CSS 规则 / 物理占用 | 实际高度占用 |
| :--- | :--- | :--- |
| 顶栏窗口控制区 | `.coverHeader` | **36px** |
| 内容容器上下内边距 | `.coverContent` (`padding: 24px 32px 32px`) | 24 + 32 = **56px** |
| 设置页根容器底部边距 | `.settingsUiPage` (`padding-bottom: 24px`) | **24px** |
| 页面主标题行高与间距 | `.settingsUiPageHead` + gap | 约 **36px** |
| 标题与卡片外间距 | `.settingsUiPage` (`gap: 16px`) | **16px** |
| “默认模型”卡片小标题 | `.settingsUiSectionTitle` | 约 **22px** |
| “默认模型”卡片本体 | `.settingsUiCard` + `.settingsUiRow` | 约 **62px** |
| 卡片与工作区外间距 | `.settingsUiPageBody` (`gap: 20px`) | **20px** |
| **上方物理占位总计** | **Σ (Top Elements & Paddings)** | **至少 272px** |

#### 溢出物理推导：
- 窗口视口总可用高：$H_{\text{avail}} = 100\text{vh} - 36\text{px}$（扣除顶栏）。
- 内容实际占用总高：$H_{\text{content}} = 272\text{px} + \max(480\text{px}, 100\text{vh} - 220\text{px})$。
- **在大屏/高分辨率（$100\text{vh} \ge 768\text{px}$）下**：
  $$H_{\text{content}} = 272 + (100\text{vh} - 220) = 100\text{vh} + 52\text{px}$$
  $$\Delta H = H_{\text{content}} - H_{\text{avail}} = (100\text{vh} + 52) - (100\text{vh} - 36) = \mathbf{88\text{px}} \quad (\text{恒定溢出！})$$
- **在中小屏/扁平视口（$100\text{vh} = 600\text{px}$）下**：
  $$\Delta H = (272 + 480) - (600 - 36) = 752 - 564 = \mathbf{188\text{px}} \quad (\text{严重溢出！})$$

**结论**：外层 `.coverContent` 在任何分辨率下都存在 $88\text{px}$ 以上的多余滚动行程！当用户在内层滚动触顶/底、或者在空白处拨动滚轮时，浏览器触发 Scroll Chaining 链式滚动，外层容器立刻接盘向上滚动，造成界面被整体推走的严重 Bug。

---

### 2.2 `handleRootWheel` 2x 双倍速狂飙漏洞机理

审查当前 `SettingsPanel.tsx` 第 215-231 行：
```tsx
const handleRootWheel = (e: React.WheelEvent) => {
  if (contentAreaRef.current) {
    const target = e.target as HTMLElement;
    if (
      target.closest('textarea') ||
      target.closest('pre') ||
      target.closest('select')
    )
      return;
    if (
      contentAreaRef.current.contains(target) &&
      target !== contentAreaRef.current // ⚠️ 漏洞根源：空白与内边距误判
    )
      return;
    contentAreaRef.current.scrollTop += e.deltaY;
  }
};
```

#### 漏洞逻辑拆解：
1. 当用户鼠标悬停在 `.coverContent` 的 padding 内边距空白区（上 24px、下 32px、左右 32px）或组件间的 gap 空隙时，事件目标 `target === contentAreaRef.current`。
2. 条件 `target !== contentAreaRef.current` 判定为 **`false`**！
3. 条件分支未命中，函数不会 `return`，而是继续向下执行了：
   `contentAreaRef.current.scrollTop += e.deltaY;`
4. 与此同时，浏览器底层的原生渲染引擎（GPU Compositor 线程）也基于 `deltaY` 对该元素执行原生滚动。
5. **两者叠加，位移直接放大为 2 倍（Double Scroll Acceleration）！并且伴随剧烈的视觉跳跃与加速度失控。**
6. 此外，即使在 CSS 中给 `.coverContent` 设置了 `overflow: hidden`，DOM 规范中直接修改 `element.scrollTop += deltaY` 依然会生效！因此必须在 JS 函数入口彻底阻断。

---

### 2.3 【DEF-GEO-01 审计加固】极扁视口/高 DPI 下固定头物理截断破局

在深度审计报告 `05-DOM几何渲染与滚动隔离深度审计.md` §1.2 & §2.2 中，审计专家指出了方案 05 早期规划的重大缺陷：
- 在小屏笔记本（$1366 \times 768$ @ 150% 缩放，逻辑高度 $H = 500\text{px}$）或桌面分屏窗口中，可用高度仅约 $244\text{px}$。
- 如果简单地将右侧整个头部（服务商信息 40px + 自定义凭证 72px + 搜索工具栏 36px + 手填抽屉 156px + 间距 36px = 340px）包裹在一个 `flex-shrink: 0` 的固定容器中，头部总高高达 $340\text{px}$，远超视口净高 $244\text{px}$。
- 若父级声明 `overflow: hidden`，**`ManualAddForm` 底部的「取消」与「确认添加」按钮将被物理切除出屏幕外，且没有任何滚动条可以滑到该位置，用户陷入既无法确认也无法退出的死锁！**

#### 加固方案：
将右侧面板彻底解耦为 **“三段式流式结构”**，并在第一段与第二段上赋予 **弹性上限（`max-height: min(...)`）+ 局部自愈滚动（`overflow-y: auto`）**，在极限小高视口下释放弹性，确保任何控件 100% 可见、可滚动、可交互。

---

## 三、 架构设计与三段式流式布局拓扑

### 3.1 垂直高度传导与滚动隔离架构图

```
[SettingsPanel.tsx] (Dialog variant="fullscreen", height: 100vh)
 └── .settingsPanel (height: 100%, display: flex, flex-direction: column)
      ├── .coverHeader (WindowControls, H = 36px, flex-shrink: 0)
      └── .coverBody (flex: 1 1 0, min-height: 0, overflow: hidden)
           ├── SettingsSidebar (width: 240px, flex-shrink: 0)
           └── .coverContent[data-settings-tab="models"]
                ├── CSS: overflow: hidden; overscroll-behavior: none;  <── [防线 1：抹除外层滚动行程]
                ├── JS: handleRootWheel safeActiveTab === 'models' ➔ return;  <── [防线 2：阻断 JS 篡改]
                └── ModelsSettingsTab (fillViewport)
                     ├── 页面标题与操作区 (flex-shrink: 0)
                     ├── "默认模型"配置卡片区 (flex-shrink: 0)
                     └── .modelsSplit (flex: 1 1 0, min-height: 0, height: 100%)
                          ├── .modelsRail (左侧服务商列表, flex-shrink: 0)
                          └── ModelConfigEditor (.modelsDetail, flex: 1 1 0, min-height: 0)
                               └── .mrdBody (flex: 1 1 0, min-height: 0, display: flex, flex-direction: column)
                                    │
                                    ├── [段一：置顶固定头部] (flex-shrink: 0, max-height: min(45%, 240px), overflow-y: auto)
                                    │    ├── ProfileHeader (服务商标题、编辑、删除)
                                    │    └── ProviderProfileForm (自定义 API Key/URL 凭证输入)
                                    │
                                    ├── [段二：置顶固定操作栏] (flex-shrink: 0, max-height: min(50%, 280px), overflow-y: auto)
                                    │    ├── ModelListHeader (搜索过滤框常驻、扫描模型、新增按钮)
                                    │    └── ManualAddForm (手填新增抽屉，展开时受弹性上限保护)
                                    │
                                    └── [段三：局部独立模型滚动视口] (.mrdModelListScroll)
                                         ├── flex: 1 1 0; min-height: 0; overflow-y: auto;  <── [独立视口]
                                         ├── overscroll-behavior: contain;  <── [Compositor 硬件动量吸收]
                                         ├── onWheel={e => e.stopPropagation()}  <── [防线 3：阻断合成事件]
                                         └── ModelList (模型卡片列表，专属滚动，展开配置抽屉时不撑大外层)
```

---

## 四、 精确代码变更实施规范（执行 Agent 直接落地指南）

### 4.1 文件一：`apps/crish-desktop/src/components/settings/SettingsPanel.module.css`

#### 修改位置与意图：
在 `.coverContent` 基础样式后追加针对 `[data-settings-tab="models"]` 的特定覆盖规则，从渲染层抹除外层纵向滚动条。

#### 变更前后对照：

**修改前（第 184-205 行）**：
```css
/* 5. 主内容功能区：与主对话卡片 100% 共享纯正卡底纸面 */
.coverContent {
  flex: 1;
  min-width: 0;
  min-height: 0;
  height: 100%;
  margin: 0;
  border-radius: 0;
  border: none;
  box-shadow: none;
  padding: 24px 32px 32px;
  display: flex;
  flex-direction: column;
  gap: var(--space-3_5, 14px);
  position: relative;
  background: var(--bg-elevated, var(--bg-card, hsl(0 0% 100%)));
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: auto;
  contain: strict;
  align-items: stretch;
}
```

**修改后（追加后代码）**：
```css
/* 5. 主内容功能区：与主对话卡片 100% 共享纯正卡底纸面 */
.coverContent {
  flex: 1;
  min-width: 0;
  min-height: 0;
  height: 100%;
  margin: 0;
  border-radius: 0;
  border: none;
  box-shadow: none;
  padding: 24px 32px 32px;
  display: flex;
  flex-direction: column;
  gap: var(--space-3_5, 14px);
  position: relative;
  background: var(--bg-elevated, var(--bg-card, hsl(0 0% 100%)));
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: auto;
  contain: strict;
  align-items: stretch;
}

/* ─────────────────────────────────────────────────────────────
 * 【Task-E 核心锁定】工作区视口型 Tab 强约束（模型管理页）：
 * 1. overflow: hidden 物理抹除外层 scrollport，彻底根除整个界面被滚走
 * 2. overscroll-behavior: none 阻断任何向外溢出的动量
 * 3. padding-bottom 收口为 24px，确保工作区紧凑对称
 * ───────────────────────────────────────────────────────────── */
.coverContent[data-settings-tab="models"] {
  overflow: hidden;
  overscroll-behavior: none;
  padding: 20px 32px 24px;
}
```

---

### 4.2 文件二：`apps/crish-desktop/src/components/settings/SettingsPanel.tsx`

#### 修改位置与意图：
重构 `handleRootWheel`（第 215-231 行）：
1. 增加 `safeActiveTab === 'models'` 入口守卫，工作区视口页零干预；
2. 将 `contentAreaRef.current.contains(target) && target !== contentAreaRef.current` 修正为 `contentAreaRef.current.contains(target)` 直接 `return;`，消除空白处 2x 双倍速滚动狂飙。

#### 变更前后对照：

**修改前（第 215-231 行）**：
```tsx
  const handleRootWheel = (e: React.WheelEvent) => {
    if (contentAreaRef.current) {
      const target = e.target as HTMLElement;
      if (
        target.closest('textarea') ||
        target.closest('pre') ||
        target.closest('select')
      )
        return;
      if (
        contentAreaRef.current.contains(target) &&
        target !== contentAreaRef.current
      )
        return;
      contentAreaRef.current.scrollTop += e.deltaY;
    }
  };
```

**修改后（第 215-240 行）**：
```tsx
  const handleRootWheel = (e: React.WheelEvent) => {
    // 【Task-E 核心阻断 1】：模型工作区等视口型 Tab 硬性拦截，严禁以任何 JS 形式篡改 scrollTop
    if (safeActiveTab === 'models') {
      return;
    }

    if (contentAreaRef.current) {
      const target = e.target as HTMLElement;

      // 文本输入框、代码块与下拉框原生自滚动，豁免外层干预
      if (
        target.closest('textarea') ||
        target.closest('pre') ||
        target.closest('select')
      ) {
        return;
      }

      // 【Task-E 核心阻断 2】：修复内边距空白误判导致的 2x 双倍速狂飙滚动
      // 只要 target 属于 contentAreaRef.current（包括自身内边距空白区及其所有子元素），
      // 100% 交由浏览器原生渲染管线接管，JS 不得叠加 scrollTop！
      if (contentAreaRef.current.contains(target)) {
        return;
      }

      // 仅当用户在侧栏空白处、顶栏拖拽条空白处滚动时，才辅助滚动常规设置页
      contentAreaRef.current.scrollTop += e.deltaY;
    }
  };
```

---

### 4.3 文件三：`apps/crish-desktop/src/components/settings-models/ModelConfigEditor.tsx`

#### 修改位置与意图：
重构 `ModelConfigEditor` 组件渲染部分（第 68-159 行）：
1. 在选中有服务商时，将原平铺结构重构为 **清晰的三段式流式结构**：
   - **段一：置顶固定头部**（`mrdPinnedHeader`）：服务商标题栏（`ProfileHeader`）+ 凭证输入（`ProviderProfileForm`），注入弹性上限 `max-height: min(45%, 240px); overflow-y: auto;`；
   - **段二：置顶固定操作栏**（`mrdActionBar`）：搜索与工具栏（`ModelListHeader`）+ 手填抽屉（`ManualAddForm`），注入弹性上限 `max-height: min(50%, 280px); overflow-y: auto;`，确保搜索框永远常驻视口顶端；
   - **段三：局部独立模型滚动视口**（`mrdModelListScroll`）：包裹 `ModelList`，声明 `flex: 1 1 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain;`，挂载 `onWheel={(e) => e.stopPropagation()}` 阻止冒泡。
2. 同时对外层 `<section>` 和 `.mrdBody` 注入防御性内联样式（Defensive Inline Styles），即便 CSS Modules 样式表在并行重构中发生漂移，也能 100% 锁死几何受力。

#### 完整重构代码（覆盖第 68-160 行）：

```tsx
export const ModelConfigEditor: React.FC<ModelConfigEditorProps> = ({
  providerConfig: pc,
  modelConfig: mc,
  capConfig: cc,
}) => {
  return (
    <section
      className={`${styles.modelsDetail} models-detail`}
      aria-label={pc.selected ? `服务商 · ${pc.selectedLabel}` : '服务商'}
      style={{
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
      }}
    >
      {!pc.selected ? (
        <div className={`${styles.mrdEmpty} mrd-empty`}>
          {pc.profiles.length === 0
            ? '从左侧添加服务商以开始'
            : '在左侧选择一个服务商'}
        </div>
      ) : (
        <div
          className={`${styles.mrdBody} mrd-body`}
          style={{
            display: 'flex',
            flexDirection: 'column',
            flex: '1 1 0',
            minHeight: 0,
            height: '100%',
            gap: 'var(--space-3, 12px)',
          }}
        >
          {/* ─────────────────────────────────────────────────────────────
           * 段一：置顶固定头部（服务商名称、编辑、删除与 API Key 凭证）
           * 注入弹性上限 min(45%, 240px) 与局部滚动，防极小视口物理截断按钮 (DEF-GEO-01)
           * ───────────────────────────────────────────────────────────── */}
          <div
            className={`${styles.mrdPinnedHeader || ''} mrd-pinned-header`}
            style={{
              flexShrink: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-3, 12px)',
              maxHeight: 'min(45%, 240px)',
              overflowY: 'auto',
              scrollbarWidth: 'thin',
            }}
          >
            {/* Detail header */}
            <ProfileHeader
              selected={pc.selected}
              selectedLabel={pc.selectedLabel}
              editingName={pc.editingName}
              nameDraft={pc.nameDraft}
              setNameDraft={pc.setNameDraft}
              setEditingName={pc.setEditingName}
              confirmDeleteId={pc.confirmDeleteId}
              setConfirmDeleteId={pc.setConfirmDeleteId}
              refresh={pc.refresh}
              notify={pc.notify}
              setProfiles={pc.setProfiles}
              setSelectedId={pc.setSelectedId}
            />

            {/* Credentials */}
            {pc.selected.id.startsWith('custom-') && (
              <ProviderProfileForm
                selected={pc.selected}
                hasKeySelected={pc.hasKeySelected}
                keyDraft={pc.keyDraft}
                setKeyDraft={pc.setKeyDraft}
                saveKey={pc.saveKey}
                notify={pc.notify}
                refresh={pc.refresh}
              />
            )}
          </div>

          {/* ─────────────────────────────────────────────────────────────
           * 段二：置顶固定操作栏（搜索框常驻、检测/扫描按钮及手填新增抽屉）
           * 无论模型列表如何滚动，搜索工具栏永远吸顶可见，无需滑回顶部
           * ───────────────────────────────────────────────────────────── */}
          <div
            className={`${styles.mrdActionBar || ''} mrd-action-bar`}
            style={{
              flexShrink: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-2_5, 10px)',
              maxHeight: 'min(50%, 280px)',
              overflowY: 'auto',
              scrollbarWidth: 'thin',
            }}
          >
            {/* Model list header (包含搜索过滤、扫描与新增按钮) */}
            <ModelListHeader
              checkBusy={mc.checkBusy}
              scanBusy={mc.scanBusy}
              runCheck={mc.runCheck}
              runScan={mc.runScan}
              modelFilter={mc.modelFilter}
              setModelFilter={mc.setModelFilter}
              manualOpen={mc.manualOpen}
              setManualOpen={mc.setManualOpen}
              setAddDraft={mc.setAddDraft}
              emptyAddDraft={mc.emptyAddDraft}
            />

            {/* Manual add form (手动添加抽屉，展开时弹性自适应) */}
            {mc.manualOpen && (
              <ManualAddForm
                addDraft={mc.addDraft}
                setAddDraft={mc.setAddDraft}
                handleManualAdd={mc.handleManualAdd}
                setManualOpen={mc.setManualOpen}
              />
            )}
          </div>

          {/* ─────────────────────────────────────────────────────────────
           * 段三：局部独立模型滚动视口（专属独立滚动条）
           * 1. 吸收右侧全部剩余纵向空间 (flex: 1 1 0; min-height: 0)
           * 2. overscroll-behavior: contain 硬件层吸收滚轮动量，杜绝链式穿透
           * 3. onWheel.stopPropagation 阻断 React 合成事件向外冒泡
           * ───────────────────────────────────────────────────────────── */}
          <div
            className={`${styles.mrdModelListScroll || ''} mrd-model-list-scroll`}
            style={{
              flex: '1 1 0',
              minHeight: 0,
              overflowY: 'auto',
              overflowX: 'hidden',
              overscrollBehavior: 'contain',
              scrollbarGutter: 'stable',
              paddingRight: '2px',
            }}
            onWheel={(e) => {
              // 阻断 React 合成事件冒泡到外层 SettingsPanel 的 handleRootWheel
              e.stopPropagation();
            }}
          >
            <ModelList
              providerId={pc.selected.id}
              modelsList={mc.modelsList}
              modelsCount={mc.modelsCount}
              modelFilter={mc.modelFilter}
              configOpenId={cc.configOpenId}
              cfgDraft={cc.cfgDraft}
              setCfgDraft={cc.setCfgDraft}
              openConfigFor={cc.openConfigFor}
              closeConfig={cc.closeConfig}
              saveConfig={cc.saveConfig}
              runTest={cc.runTest}
              testBusy={cc.testBusy}
              refresh={pc.refresh}
            />
          </div>
        </div>
      )}
    </section>
  );
};
```

---

## 五、 跨 Task 协同契约与样式对接标准

为确保 Task-E 与负责 `ModelsSettingsTab.module.css` 的 Task-D 完美协同且互不干扰，定义如下类名契约：

| 类名（CSS Class） | 归属容器与语义 | Task-E 行为 | Task-D 预期样式规范 |
| :--- | :--- | :--- | :--- |
| `.mrdBody` | 详情面板主体容器 | 挂载于最外层 div，注入 flex 列布局 | `display: flex; flex-direction: column; flex: 1 1 0; min-height: 0; height: 100%; gap: var(--space-3, 12px);` |
| `.mrdPinnedHeader` | 置顶固定头部容器 | 承载 ProfileHeader 与 Credentials，内置内联 style 保底 | `display: flex; flex-direction: column; gap: var(--space-3, 12px); flex-shrink: 0; max-height: min(45%, 240px); overflow-y: auto;` |
| `.mrdActionBar` | 置顶固定操作栏容器 | 承载 ModelListHeader 与 ManualAddForm，内置内联 style 保底 | `display: flex; flex-direction: column; gap: var(--space-2_5, 10px); flex-shrink: 0; max-height: min(50%, 280px); overflow-y: auto;` |
| `.mrdModelListScroll` | 局部独立模型滚动视口 | 承载 ModelList，挂载 onWheel.stopPropagation，内置内联 style 保底 | `flex: 1 1 0; min-height: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; scrollbar-gutter: stable;` |

> **防御性设计价值**：由于 Task-E 在 TSX 元素上直接声明了关键布局与滚动隔离样式（`flex`, `overflow`, `overscrollBehavior`），即使 Task-D 尚未合入新 CSS 规则，Task-E 的滚动隔离与弹性视口也能 **100% 独立稳定生效**，绝不产生时序依赖！

---

## 六、 极端边界与退化态鲁棒性审计（Resilience Matrix）

根据 `AGENTS.md` §7.1 立体验证要求，针对以下极限场景实施几何与事件推演：

### 6.1 场景一：极小高度视口退化（窗口高度 $H = 480\text{px}$）
- **现象**：在超小屏或分屏模式下，用户展开自定义服务商并点击「+」展开 `ManualAddForm`。
- **力学表现**：
  1. 第一段 `mrdPinnedHeader` 占用约 112px，未达到 240px 上限，正常呈现；
  2. 第二段 `mrdActionBar` 因手填表单展开高度增至约 192px，未达到 280px 上限；
  3. 第三段 `mrdModelListScroll` 自动压缩至约 $80\text{px} \sim 100\text{px}$，保持可用；
  4. 若用户进一步拉扁窗口至 $400\text{px}$，第二段自动激活局部纵向滚动条，**「保存」与「取消」按钮 100% 可滚动见并可点击，彻底杜绝 DEF-GEO-01 按钮截断死锁**！

### 6.2 场景二：极少模型条目（0 ~ 1 个模型）
- **现象**：新添加服务商无模型，或搜索过滤无结果。
- **力学表现**：
  1. `mrdModelListScroll` 内部内容小于容器高度，自身无滚动条；
  2. 用户在右侧大片空白区疯狂上下拨动滚轮；
  3. Compositor 层的 `overscroll-behavior: contain` 阻断原生向上传递；
  4. 外层 `.coverContent` 拥有 `overflow: hidden`，无滚动行程；
  5. 根部 `handleRootWheel` 遇到 `safeActiveTab === 'models'` 直接 return；
  6. **三层物理锁死：页面整体 0 像素位移，彻底根除“无模型时页面乱晃”**！

### 6.3 场景三：海量长列表（100+ 模型）与无阻尼滚轮冲击
- **现象**：用户使用罗技 MX Master 开启自由滚轮剧烈飞速滚动。
- **力学表现**：
  1. 列表以 60/120fps 原生流畅滚动；
  2. 抵达列表最底端（或最顶端）时，巨大的动量被硬件层 `overscroll-behavior: contain` 完全吸收；
  3. React 层的 `e.stopPropagation()` 阻断合成事件派发；
  4. 顶部的「默认模型」卡片与搜索框岿然不动，无任何撕裂或跳跃。

---

## 七、 立体验证断言与门禁检查清单（Verification Checklist）

### 7.1 刚性自动化验收断言（Automated Invariants）

| 断言编号 | 验证目标 | 验证方法与手段 | 验收合格断言 |
| :--- | :--- | :--- | :--- |
| **AST-E01** | 外层滚动行程归零 | 在 `models` Tab 下检查外层容器属性 | `getComputedStyle(coverContent).overflowY === 'hidden'` 且 `coverContent.scrollTop === 0` |
| **AST-E02** | 滚轮事件全域阻断 | 在模型列表区派发 `wheel` 事件 | 外层 `SettingsPanel` 的 `handleRootWheel` 不触发 `scrollTop` 修改 |
| **AST-E03** | 搜索工具栏常驻吸顶 | 模型列表滚动至第 50 项 | `ModelListHeader` 的 `getBoundingClientRect().top` 相对父级容器恒定不变 |
| **AST-E04** | 2x 双倍速狂飙消除 | 在普通 Tab（如 `profile`）的 `.coverContent` 内边距空白区滚动 | `handleRootWheel` 命中 `contains(target)` 并立即 `return`，不产生二次叠加 |
| **AST-E05** | 极限扁平窗口无截断 | 设置窗口高度为 $480\text{px}$ 并展开 `ManualAddForm` | `ManualAddForm` 内的保存/取消按钮在可视区域内，或通过操作栏局部滚动条可平滑滑入可视区 |
| **AST-E06** | 零破坏性向后兼容 | 切换到 `general`、`appearance`、`shortcuts` 等表单页 | 普通设置页的正常纵向滚动条完全保留，滚动逻辑 100% 正常 |

### 7.2 执行 Agent 自检命令门禁

在落地修改上述 3 个文件后，执行 Agent 必须在仓库根目录下运行以下命令并确保 100% 通过：

```powershell
# 1. 静态类型检查（0 报错）
npm run typecheck

# 2. 单文件行数门禁（0 违规，SettingsPanel < 500 行，ModelConfigEditor < 500 行）
npm run check:line-counts

# 3. 运行设置面板相关单元测试
npm run test:coverage -- --project=unit
```

### 7.3 真实桌面验收（4000 Tauri MCP 通道）
依据 `AGENTS.md` §15~16 调试通道唯一合法口径：
1. 启动应用后进入设置中心「模型」页；
2. 鼠标悬停在模型列表右侧，连续快速向上、向下滑动滚轮，目测观察页面大标题与「全局默认模型」卡片：**位移必须为 0px**；
3. 将模型列表向下滚动到底部，确认搜索框依然常驻在顶部，在搜索框中键入关键词即时过滤模型；
4. 切换到其他服务商（包括 0 模型或 1 模型的服务商），在空白区域拨动滚轮，确认界面稳定无抖动。

---

## 八、 总结与执行交接

本方案完成了从病因数学证明、几何受力推演、CSS/JS 双层阻断到 TSX 三段式重构的完整设计闭环，严格受限于 Task-E 的 3 个物理文件域内，兼顾了对 Task-D 样式的解耦兼容与自保底。执行 Agent 可依据第四章给出的精准代码对照直接落盘实施。
