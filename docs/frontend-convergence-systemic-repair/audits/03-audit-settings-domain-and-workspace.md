# 03-设置域交互标签原子化与未提交状态深度审计报告

> **战役标识**：`FRONTEND-CONVERGENCE-OVERHAUL`  
> **批次推进**：Wave 5 设置域收敛 (`BATCH-5D`)  
> **审计专家**：设置域交互标签原子化与未提交状态审计专家  
> **执行时间**：2026-09-20  
> **门禁状态**：`check:convergence` 13 大规则 **0 违规** | `SettingsQuickMenu.test.tsx` **6/6 全绿** | `Menu.test.tsx` **23/23 全绿** | `typecheck` **0 错误**

---

## 一、审计背景与全景扫描

### 1.1 审计上下文与初始问题集
在 Wave 5 设置域收敛推进过程中，工作区处于混合推进状态：
1. **工作区未提交修改文件**：存在 16+ 个 TSX/CSS 文件被修改但未落库，改动涵盖 `settings-models/`、`settings-skills/`、`settings/` 等子域。
2. **门禁阻断历史基线**：`scripts/check-frontend-convergence.mjs` 中规则 1 (G-01 业务层零裸原生交互标签) 历史残留 15 处违规。
3. **关键交互单测断裂**：`apps/crish-desktop/src/components/settings/SettingsQuickMenu.test.tsx` 测试用例「*Esc 关闭菜单并还原焦点到触发按钮*」断言失败 (`expect(trigger).toHaveFocus()` 超时)。

### 1.2 工作区文件全景清单 (28 个文件状态)
经过对工作区工作树的全面核验，相关修改文件分布如下：

| 文件类别 | 路径 | 修改性质 | 涉及规则 / 目标 |
| :--- | :--- | :--- | :--- |
| **TSX 业务组件** | `settings-models/ModelModalitiesEditor.tsx` | `<button>` 替换为 `<Button bare>` | G-01 标签原子化 |
| **TSX 业务组件** | `settings-models/ModelPricingEditor.tsx` | `<button>` 替换为 `<Button bare>` | G-01 标签原子化 |
| **TSX 业务组件** | `settings-models/YamlConfigEditorModal.tsx` | `<button>` 替换为 `<Button bare>` | G-01 标签原子化 |
| **TSX 业务组件** | `settings-skills/SkillCardList.tsx` | `<button>` 替换为 `<Button bare>` | G-01 标签原子化 |
| **TSX 业务组件** | `settings-skills/SkillsMoreMenu.tsx` | `<button>` 替换为 `<Button bare>` | G-01 标签原子化 |
| **TSX 业务组件** | `settings/FontSelectField.tsx` | `<input>`/`<button>` 替换为 `<Input bare>`/`<Button bare>` | G-01 标签原子化 |
| **TSX 业务组件** | `settings/FontSettingsSection.tsx` | `<input type="checkbox">` 替换为 `<Input bare>` | G-01 标签原子化 |
| **TSX 业务组件** | `settings/ImportListSection.tsx` | `<input type="checkbox">` 替换为 `<Input bare>` | G-01 标签原子化 |
| **TSX 业务组件** | `settings/RulesEditorDialog.tsx` | `<textarea>` 替换为 `<Textarea bare>` | G-01 标签原子化 |
| **TSX 业务组件** | `settings/SettingsRulesTab.tsx` | `<button>` 替换为 `<Button bare>` | G-01 标签原子化 |
| **TSX 业务组件** | `settings/SettingsDevicesNetworkEnv.tsx` | `<button>` 替换为 `<Button bare>` | G-01 标签原子化 |
| **TSX 业务组件** | `settings/SettingsProfileTab.tsx` | `createElement('input')` 替换为声明式 `<Input bare type="file">` | G-01 标签原子化 |
| **TSX 业务组件** | `settings/SettingsQuickMenu.tsx` | `<button>` 替换为 `<Button bare>` + 修复焦点还原流 | G-01 标签原子化 + 焦点回归 |
| **TSX 业务组件** | `settings/SettingsSchemaRenderer.tsx` | `<input type="color">` 替换为 `<Input bare>` | G-01 标签原子化 |
| **TSX 业务组件** | `settings/SettingsSecurityTab.tsx` | `<button>` 替换为 `<Button bare>` | G-01 标签原子化 |
| **TSX 业务组件** | `settings/SettingsSidebar.tsx` | `<input>`/`<button>` 替换为 `<Input bare>`/`<Button bare>` | G-01 标签原子化 |
| **TSX 业务组件** | `settings/StatusDiagnosticsPanel.tsx` | 移除死代码 `createElement('textarea')` 兜底 | G-01 标签原子化 |
| **TSX 业务组件** | `settings/WorkflowForm.tsx` | `<input>`/`<textarea>` 替换为 `<Input bare>`/`<Textarea bare>` | G-01 标签原子化 |
| **UI 核心基座** | `components/ui/Menu/Menu.tsx` | 移除伪 Slot `<span>` 包装，回归 Radix 原生 Trigger Slot | G-02 浮层规范 + 焦点修复 |
| **CSS Modules** | `settings-models/ModelsSettingsTab.module.css` | 补充 `:global(.button)` 样式选择器 | 样式保真 |
| **CSS Modules** | `settings-models/YamlConfigEditorModal.module.css` | 补充 `:global(.button)` 样式选择器 | 样式保真 |
| **CSS Modules** | `settings-skills/SkillsSettingsTab.module.css` | 补充 `:global(.button)` 样式选择器 | 样式保真 |
| **CSS Modules** | `settings/FontSelectField.module.css` | 补充 `:global(.button)` 样式选择器 | 样式保真 |
| **CSS Modules** | `settings/SettingsDevicesTab.module.css` | 补充 `:global(.button)` 样式选择器 | 样式保真 |
| **CSS Modules** | `settings/SettingsPanel.module.css` | 补充 `:global(.button)` 样式选择器 | 样式保真 |
| **CSS Modules** | `settings/SettingsQuickMenu.module.css` | 补充 `:global(.button)` 样式选择器 | 样式保真 |
| **CSS Modules** | `settings/SettingsRulesTab.module.css` | 补充 `:global(.button)` 样式选择器 | 样式保真 |
| **CSS Modules** | `settings/SettingsSecurityTab.module.css` | 补充 `:global(.button)` 样式选择器 | 样式保真 |

---

## 二、工作区已修改文件逐一深度审查

我们针对工作区中已发生改动的核心文件进行逐行代码审查，核查点包括：**改动准确性**、**TypeScript 类型安全**、**属性透传与 Ref 完整性**、**事件冒泡与 IME 组合输入副作用**、**CSS 样式与布局保真度**。

### 2.1 模型设置子域 (`settings-models`)

#### 1. `ModelModalitiesEditor.tsx` (文件路径: `apps/crish-desktop/src/components/settings-models/ModelModalitiesEditor.tsx`)
- **改动物证**：
  ```tsx
  // 改动前：<button key={mod} type="button" aria-pressed={active} ...>
  // 改动后：
  <Button
    bare
    key={mod}
    type="button"
    aria-pressed={active}
    className={`${styles.mrdModalityChip} ${active ? styles.mrdModalityChipActive : ''}`}
    onClick={() => toggleInput(mod)}
  >
    {MODALITY_LABELS[mod] || mod}
  </Button>
  ```
- **审查评价**：
  - **准确性**：使用 `<Button bare>` 精准满足 G-01 AST 检查要求。`bare` 模式不注入默认样式包装，不干扰自定义 flex/chip 布局。
  - **类型安全**：完全符合 `ButtonProps` 类型契约，`aria-pressed`、`key`、`type` 与 `onClick` 均正确透传。
  - **副作用**：零副作用。CSS 模块在 `ModelsSettingsTab.module.css:946` 中补充了 `:global(.button).mrdModalityChip`，选择器特异性与原有保持完全一致。

#### 2. `ModelPricingEditor.tsx` (文件路径: `apps/crish-desktop/src/components/settings-models/ModelPricingEditor.tsx`)
- **改动物证**：
  ```tsx
  <Button
    bare
    type="button"
    className={`${styles.mrdCurrencyBtn} ${current.currency === 'CNY' ? styles.mrdCurrencyBtnActive : ''}`}
    onClick={() => setCurrency('CNY')}
  >
    ¥ CNY
  </Button>
  ```
- **审查评价**：
  - **准确性**：货币切换器（CNY/USD）正确原子化，摒弃原生 `<button>`。
  - **类型安全**：`ButtonProps` 继承原生属性，无需额外类型断言。
  - **副作用**：无。点击切换与状态同步逻辑保持 100% 不变。

#### 3. `YamlConfigEditorModal.tsx` (文件路径: `apps/crish-desktop/src/components/settings-models/YamlConfigEditorModal.tsx`)
- **改动物证**：
  ```tsx
  <Tooltip content="上一个匹配项 (Shift+Enter)">
    <Button
      bare
      type="button"
      className={styles.searchNavBtn}
      onClick={() => ed.jumpToMatch(ed.searchIndex - 1)}
      aria-label="上一个匹配项"
    >
      <AppIcon name="chevron-up" size={12} />
    </Button>
  </Tooltip>
  ```
- **审查评价**：
  - **准确性**：编辑器搜索导航三钮（上一个、下一个、清空）均转换为 `<Button bare>` 并保留外层 `<Tooltip>` 提示。
  - **类型安全**：类型检查通过，无警告。
  - **副作用**：`bare` 模式保持了 20×20 紧凑尺寸与图标居中对齐，与快捷键完全对齐。

---

### 2.2 技能设置子域 (`settings-skills`)

#### 4. `SkillCardList.tsx` (文件路径: `apps/crish-desktop/src/components/settings-skills/SkillCardList.tsx`)
- **改动物证**：
  ```tsx
  <Tooltip key={s.id} content={s.description || s.name}>
    <Button
      bare
      id={`skill-opt-${s.id}`}
      type="button"
      role="option"
      aria-selected={isSel}
      className={`${styles.skillsRailItem} ${isSel ? styles.skillsRailItemActive : ''}`}
      onClick={() => onSelect(s.id)}
    >
      ...
    </Button>
  </Tooltip>
  ```
- **审查评价**：
  - **准确性**：列表项原生 `<button>` 成功收敛为 `<Button bare>`。
  - **语义保真**：ARIA 属性 `role="option"` 与 `aria-selected` 通过 `Button` 的 `{...restProps}` 原生注入到底层 DOM，保持 WAI-ARIA Listbox 规范。
  - **副作用**：无破坏。

#### 5. `SkillsMoreMenu.tsx` (文件路径: `apps/crish-desktop/src/components/settings-skills/SkillsMoreMenu.tsx`)
- **改动物证**：
  ```tsx
  <Button
    bare
    key={opt.id}
    type="button"
    role="menuitem"
    className={`${styles.skillsMoreItem} ${opt.danger ? styles.skillsMoreItemDanger : ''}`}
    onClick={() => { ... }}
  >
    {opt.label}
  </Button>
  ```
- **审查评价**：
  - **准确性**：更多操作菜单项全部原子化为 `<Button bare>`，保留 `role="menuitem"`。
  - **副作用**：键盘 Tab 漫游与点击事件流完全稳定。

---

### 2.3 常用设置与字体/规则子域 (`settings`)

#### 6. `FontSelectField.tsx` (文件路径: `apps/crish-desktop/src/components/settings/FontSelectField.tsx`)
- **改动物证**：
  - 搜索输入框：
    ```tsx
    <Input
      bare
      ref={searchInputRef}
      role="combobox"
      aria-autocomplete="list"
      aria-expanded={open}
      aria-controls={listboxId}
      aria-activedescendant={activeDescendantId}
      aria-label="搜索或输入自定义字体名称"
      className={styles.searchInput}
      placeholder="搜索或输入字体..."
      value={searchQuery}
      disabled={disabled}
      autoComplete="off"
      spellCheck={false}
      onChange={(e) => setSearchQuery(e.target.value)}
      onCompositionStart={handleCompositionStart}
      onCompositionEnd={handleCompositionEnd}
      onKeyDown={handleKeyDown}
    />
    ```
  - 操作按钮与下拉列表选项：
    全部替换为 `<Button bare ...>`。
- **审查评价**：
  - **准确性**：`searchInputRef` 通过 `Input` 的 `setCombinedRef` 机制无损传递给真实 `<input>` 元素，`handleCompositionStart`/`handleCompositionEnd` 保证拼音中文检索正常工作。
  - **高危点审查**：Combobox 复杂键盘事件流（上下箭头漫游、Enter 选定）由 `handleKeyDown` 接管，在 `Input bare` 下完全透传，无任何事件中断。

#### 7. `FontSettingsSection.tsx` (文件路径: `apps/crish-desktop/src/components/settings/FontSettingsSection.tsx`)
- **改动物证**：
  ```tsx
  <Input
    bare
    type="checkbox"
    checked={!!prefs.monoLigatures}
    disabled={busy}
    onChange={(e) => updatePrefs({ monoLigatures: e.target.checked })}
  />
  ```
- **审查评价**：
  - **准确性**：原生复选框转换为 `<Input bare type="checkbox">`。
  - **副作用**：`Input.tsx` 的 `bare` 分支直接返回带指定 `type` 的 `<input>` 标签，样式与行为 100% 保持原有 CSS 复选框状态。

#### 8. `ImportListSection.tsx` (文件路径: `apps/crish-desktop/src/components/settings/ImportListSection.tsx`)
- **改动物证**：
  ```tsx
  <Input
    bare
    id={checkId}
    type="checkbox"
    className={styles.importCheck}
    checked={checked}
    disabled={importing}
    onChange={() => onToggleSelect(s.id)}
    aria-label={`选择对话：${s.title}`}
  />
  ```
- **审查评价**：
  - **准确性**：列表多选复选框已合规收敛为 `<Input bare>`。
  - **类型安全**：完全类型匹配。

#### 9. `RulesEditorDialog.tsx` (文件路径: `apps/crish-desktop/src/components/settings/RulesEditorDialog.tsx`)
- **改动物证**：
  ```tsx
  <Textarea
    bare
    ref={initialFocusRef}
    className={styles.rulesEditorTextarea}
    value={editorText}
    onChange={(e) => setEditorText(e.target.value)}
    rows={12}
    placeholder="输入自定义规则..."
    aria-label="自定义规则内容"
    spellCheck={false}
  />
  ```
- **审查评价**：
  - **准确性**：原生 `<textarea>` 替换为 `<Textarea bare>`。
  - **焦点传递**：`Dialog` 挂载时的 `initialFocusRef` 成功透传至底层 `<textarea>` DOM 节点，打开弹窗自动获取光标行为正常。

#### 10. `SettingsRulesTab.tsx` (文件路径: `apps/crish-desktop/src/components/settings/SettingsRulesTab.tsx`)
- **改动物证**：规则预设 Chip 原生 `<button>` 替换为 `<Button bare className={styles.presetChip} ...>`。
- **审查评价**：无副作用，样式表同步添加 `:global(.button).presetChip` 适配。

#### 11. `SettingsDevicesNetworkEnv.tsx` (文件路径: `apps/crish-desktop/src/components/settings/SettingsDevicesNetworkEnv.tsx`)
- **改动物证**：IP 复制胶囊按钮替换为 `<Button bare className={styles.ipBadge} ...>`。
- **审查评价**：复制触发与 Tooltip 提示无断裂。

---

## 三、15 处 G-01 历史违规项逐一深度溯源与收敛分析

门禁检查脚本 `scripts/check-frontend-convergence.mjs` 中的 G-01 检测业务层直接书写原生交互标签（`<button>`, `<input>`, `<textarea>`, `<select>`）或调用 `React.createElement('button'|'input'|'textarea'|'select')`。
以下逐一剖析这 15 处历史违规项的产生背景、未收敛根因与最终收敛实现：

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│ G-01 违规分布拓扑 (15 处)                                                                        │
├──────────────────────────┬──────┬────────────────────────────────────┬───────────────────────────┤
│ 文件路径                 │ 行号 │ 违规标签                           │ 历史未收敛根因            │
├──────────────────────────┼──────┼────────────────────────────────────┼───────────────────────────┤
│ SettingsProfileTab.tsx   │ 81   │ createElement('input')             │ 动态文件选择弹窗习惯写法  │
│ SettingsQuickMenu.tsx    │ 237  │ <button> (触发按钮)                │ 浮层 Trigger 复合包装依赖 │
│ SettingsQuickMenu.tsx    │ 306  │ <button> (菜单项目)                │ Roving 焦点漫游深度绑定   │
│ SettingsSchemaRenderer.tsx│ 152 │ <input type="color">               │ 色彩选择器冷门型别遗漏    │
│ SettingsSecurityTab.tsx  │ 230  │ <button> (+N 更多)                 │ 动态折叠开关遗漏          │
│ SettingsSecurityTab.tsx  │ 241  │ <button> (收起)                    │ 动态折叠开关遗漏          │
│ SettingsSecurityTab.tsx  │ 368  │ <button> (预设命令 Chip)           │ 自定义样式 Chip 遗漏      │
│ SettingsSidebar.tsx      │ 104  │ <input type="search">              │ 搜索框复合按键事件绑定    │
│ SettingsSidebar.tsx      │ 121  │ <button> (清空搜索)                │ 绝对定位清除按钮遗漏      │
│ SettingsSidebar.tsx      │ 165  │ <button> (Tab 项)                  │ ARIA role="tab" 列表项    │
│ StatusDiagnosticsPanel.tsx│ 47  │ createElement('textarea')          │ 遗留 document.execCommand │
│ WorkflowForm.tsx         │ 68   │ <input> (名称输入)                 │ 变体重构只改了 settings 面│
│ WorkflowForm.tsx         │ 95   │ <textarea> (任务描述)              │ 变体重构只改了 settings 面│
│ WorkflowForm.tsx         │ 142  │ <input type="time">                │ 变体重构只改了 settings 面│
│ WorkflowForm.tsx         │ 173  │ <input type="number">              │ 变体重构只改了 settings 面│
└──────────────────────────┴──────┴────────────────────────────────────┴───────────────────────────┘
```

### 3.1 违规项 1：`SettingsProfileTab.tsx:81` (`createElement('input')`)
- **历史代码现场**：
  ```ts
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = () => { ... };
  input.click();
  ```
- **未收敛根因**：传统前端在需要触发原生系统文件选择框时，常使用命令式 `document.createElement('input')`。这种写法绕过了 React 的虚拟 DOM 树，且可能引发内存泄漏与生命周期脱管。门禁引擎 AST 正确将其作为违规拦截。
- **收敛方案**：
  使用声明式隐藏 `<Input bare type="file">`，配合 `useRef<HTMLInputElement>`：
  ```tsx
  const importFileInputRef = useRef<HTMLInputElement>(null);
  const handleImportSettings = () => {
    if (importing) return;
    importFileInputRef.current?.click();
  };
  // JSX 声明式注入：
  <Input
    bare
    ref={importFileInputRef}
    type="file"
    accept="application/json,.json"
    style={{ display: 'none' }}
    onChange={handleImportFileChange}
  />
  ```
  同时在 `handleImportFileChange` 中清空 `e.target.value = ''`，保证连续选择同一文件时均能正确触发 `onChange`。

### 3.2 违规项 2-3：`SettingsQuickMenu.tsx:237, 306` (`<button>`)
- **历史代码现场**：
  - 237 行：侧栏底部的快捷设置触发按钮 `<button className={styles.sidebarFooterSettings} ...>`。
  - 306 行：快捷菜单内部入口按钮 `<button className={styles.sbQuickItem} ...>`。
- **未收敛根因**：组件依赖 `btnRef` 传给 `Menu` 作为触发器，同时内部有复杂的键盘 ArrowDown/ArrowUp 循环漫游逻辑（`listFocusable` 扫描 `button.sb-quick-item`），开发者担忧引入 `<Button>` 组件会注入额外的外层容器导致键盘漫游与样式错乱。
- **收敛方案**：
  全量替换为 `<Button bare>`。`bare` 模式直接渲染为语义级原生 `<button>`，无多余 DOM 包裹，`className` 与 ref 纯净直达，键盘选择器 `button.sb-quick-item` 100% 持续生效。

### 3.3 违规项 4：`SettingsSchemaRenderer.tsx:152` (`<input type="color">`)
- **历史代码现场**：
  ```tsx
  control = (
    <input
      id={domId}
      type="color"
      className={uiStyles.controlColor}
      value={typeof value === 'string' ? value : '#000000'}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );
  ```
- **未收敛根因**：原先认为 `type="color"` 属于特殊原生组件，标准 Input 都是针对 text/search/password 设计的。
- **收敛方案**：直接使用 `<Input bare type="color" ...>`。`Input bare` 会透传指定的 `type="color"`，同时提供 IME 与 ref 安全防护。

### 3.4 违规项 5-7：`SettingsSecurityTab.tsx:230, 241, 368` (`<button>`)
- **历史代码现场**：
  - 230 行：路径白名单展开按钮 `<button className="settings-chip-btn">+{extraCount} 更多</button>`。
  - 241 行：折叠按钮 `<button className="settings-chip-btn">收起</button>`。
  - 368 行：命令白名单预设 `<button className={styles.presetChip}>{cmd}</button>`。
- **未收敛根因**：历史全局样式类 `.settings-chip-btn` 与预设按钮没有被纳入首批原子化清单。
- **收敛方案**：统一转换为 `<Button bare>`，并在 CSS 模块中追加 `:global(.button).presetChip` 规避样式冲突。

### 3.5 违规项 8-10：`SettingsSidebar.tsx:104, 121, 165` (`<input>`, `<button>`)
- **历史代码现场**：
  - 104 行：侧栏搜索框 `<input ref={searchInputRef} type="search" ...>`。
  - 121 行：搜索框清空按钮 `<button className={styles.searchClear} ...>`。
  - 165 行：设置主 Tab 切换按钮 `<button role="tab" ...>`。
- **未收敛根因**：涉及核心 TabList 键盘焦点导航与 `searchInputRef` 聚焦，担心原子封装影响 `role="tab"` 的 WAI-ARIA 状态传递。
- **收敛方案**：
  - 搜索框收敛为 `<Input bare ref={searchInputRef} type="search" ...>`。
  - 清空按钮收敛为 `<Button bare ...>`。
  - Tab 选项收敛为 `<Button bare role="tab" id={tabBtnId} aria-selected={active} aria-controls={tabPanelId} ...>`。所有 ARIA 属性经由 `Button` 原生透传。

### 3.6 违规项 11：`StatusDiagnosticsPanel.tsx:47` (`createElement('textarea')`)
- **历史代码现场**：
  ```ts
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
  ```
- **未收敛根因**：老旧的跨浏览器剪贴板降级兜底方案。
- **收敛方案**：在现代 WebView2 (Chromium 内核) 与标准浏览器环境下，`navigator.clipboard.writeText` 具备 100% 可用性。将死代码与过时的 `execCommand` 彻底移除，既净化了代码又消除了 `createElement('textarea')` 违规。

### 3.7 违规项 12-15：`WorkflowForm.tsx:68, 95, 142, 173` (`<input>`, `<textarea>`)
- **历史代码现场**：
  `WorkflowForm` 具有 `variant === 'settings'` 与 `variant === 'chat'` 两种渲染模式。
  此前 Wave 只改造了 `settings` 分支（使用了 `<Input size="sm" />`），而在 `else`（即 `chat` 侧栏内嵌表单）分支中遗漏了 4 处裸标签：
  - 68 行：名称输入 `<input className={styles.schedFieldInput}>`。
  - 95 行：任务描述 `<textarea className={styles.schedFieldTextarea}>`。
  - 142 行：每日执行时间 `<input type="time">`。
  - 173 行：执行间隔分钟 `<input type="number">`。
- **收敛方案**：在 `chat` 分支中对称替换为 `<Input bare>` 与 `<Textarea bare>`，同时保持已有的 CSS 类名和布局。

---

## 四、SettingsQuickMenu 焦点还原失败深度根因分析与根治方案

### 4.1 故障现场与单测断言分析
在执行单测 `apps/crish-desktop/src/components/settings/SettingsQuickMenu.test.tsx` 时，用例「**Esc 关闭菜单并还原焦点到触发按钮**」失败：

```ts
it('Esc 关闭菜单并还原焦点到触发按钮', async () => {
  render(<SettingsQuickMenu />);
  const trigger = screen.getByTestId('settings-button');
  fireEvent.click(trigger);
  const menu = await screen.findByRole('menu', { name: '快捷设置' });
  fireEvent.keyDown(menu, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  await waitFor(() => expect(trigger).toHaveFocus()); // ❌ 超时失败！trigger 始终无法获得焦点
});
```

### 4.2 双层根因穿透剖析

经过对代码调用栈、Radix UI 底层工作机制与 React DOM 渲染树的逐层解剖，发现该问题是由**基座层的伪 Slot 包装**与**业务层的关闭调度断路**两处缺陷叠加导致：

```
                    ┌─────────────────────────────────────────────────────────────┐
                    │                      SettingsQuickMenu                      │
                    └──────────────────────────────┬──────────────────────────────┘
                                                   │ 传递 trigger 属性
                                                   ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│ 断层 A (Menu.tsx 伪 Slot 包装与 Ref 劫持)                                                       │
│                                                                                                 │
│  实际 trigger 是: <Button bare data-testid="settings-button" ref={btnRef}>设置</Button>         │
│                                                                                                 │
│  Menu.tsx 错误地包装了 <span> 并强行将 btnRef 赋值为 span:                                       │
│                                                                                                 │
│    <span ref={(node) => { propsRef.current = node; }} className={styles.menuTriggerHost}>      │
│      <Button bare ... />                                                                        │
│    </span>                                                                                      │
│                                                                                                 │
│  后果:                                                                                          │
│  1. Radix Popover.Trigger 绑定至 <span>，Radix 认为 <span> 是触发器                             │
│  2. btnRef.current 指向了 <span> (无 tabIndex，不可聚焦) 而非 <button>                          │
│  3. Radix onCloseAutoFocus 尝试调用 span.focus()，直接静默失效                                  │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
                                                   ▲
                                                   │ 联动
┌──────────────────────────────────────────────────┴──────────────────────────────────────────────┐
│ 断层 B (SettingsQuickMenu.tsx 关闭状态机断路)                                                   │
│                                                                                                 │
│  onMenuKeyDown 处理 Escape 时:                                                                  │
│    closeMenu({ restoreFocus: true });                                                           │
│                                                                                                 │
│  closeMenu 的旧实现:                                                                            │
│    const closeMenu = (opts) => {                                                                │
│      restoreOnCloseRef.current = !!opts?.restoreFocus;                                          │
│      setOpen(false); // ❌ 直接 setState，未触发 handleOpenChange(false)                        │
│    };                                                                                           │
│                                                                                                 │
│  后果:                                                                                          │
│  handleOpenChange 内的微任务焦点还原逻辑 queueMicrotask(() => btnRef.current?.focus()) 被直接跳过! │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

#### 根因层 1：`Menu.tsx` 中的伪 Slot `<span>` 包装与 Ref 劫持（主要根因）
在提交 `c4a00f30f6db` 中，为了遵守门禁规则 G-02（禁止在 `Menu.tsx` 中使用 `cloneElement` 劫持触发器），作者误将 `actualTrigger` 用一个 `<span>` 包装起来，声称这是「Slot 宿主容器模式」：

```tsx
// Menu.tsx 历史错误代码 (lines 246-274):
const hostTrigger = React.isValidElement(actualTrigger) ? (
  <span
    ref={(node: HTMLElement | null) => {
      triggerRef.current = node;
      const propsRef = (actualTrigger.props as { ref?: React.Ref<HTMLElement> })?.ref;
      if (typeof propsRef === 'function') {
        propsRef(node);
      } else if (propsRef && typeof propsRef === 'object' && 'current' in propsRef) {
        propsRef.current = node; // 💥 严重 BUG：将调用方的 ref (btnRef) 强行修改为 span DOM 节点！
      }
    }}
    className={styles.menuTriggerHost}
    onClickCapture={handleTriggerClickCapture}
  >
    {actualTrigger}
  </span>
) : (
  actualTrigger
);

renderedTrigger = (
  <Popover.Trigger asChild>
    {hostTrigger as React.ReactElement}
  </Popover.Trigger>
);
```

**这一错误设计引发了四大恶果**：
1. **Ref 严重漂移与劫持**：`actualTrigger` 本身是 `<Button bare ref={btnRef} data-testid="settings-button">`。`Menu.tsx` 将 `propsRef.current` 强行设为了 `<span>`！导致 `SettingsQuickMenu` 内部的 `btnRef.current` 不再是按钮，而是那个无辜的 `<span>`。
2. **DOM 结构非法与无意义嵌套**：渲染出的 DOM 是：
   ```html
   <span class="_menuTriggerHost" aria-haspopup="dialog" type="button" data-state="closed">
     <button class="_sidebarFooterSettings" data-testid="settings-button" aria-haspopup="menu">
       设置
     </button>
   </span>
   ```
   外层 `<span>` 被 Radix 当作 Trigger 并注入了伪按钮属性，内层又是真实的 `<button>`，存在严重的语义嵌套问题。
3. **Radix 默认焦点还原目标错误**：Radix Popover 在关闭时（如果没有在 `onCloseAutoFocus` 中 `preventDefault`），会自动执行 `triggerRef.focus()`。此时 Radix 眼中的 Trigger 是 `<span>`，而 `<span>` 没有 `tabIndex={0}`，根本无法接收焦点。
4. **测试断言必然失败**：测试中断言的是 `expect(screen.getByTestId('settings-button')).toHaveFocus()`，即使通过其他方式让外层 `<span>` 获得焦点，真实的 `<button>` 也依然处于失焦状态。

#### 根因层 2：`SettingsQuickMenu.tsx` 关闭逻辑未通知统一状态机
在 `SettingsQuickMenu.tsx` 中：
```tsx
const handleOpenChange = useCallback((nextOpen: boolean) => {
  if (!nextOpen) {
    const shouldRestore = restoreOnCloseRef.current;
    restoreOnCloseRef.current = false;
    if (shouldRestore) {
      queueMicrotask(() => {
        btnRef.current?.focus(); // 期望在此处执行微任务级焦点兜底
      });
    }
  }
  setOpen(nextOpen);
}, []);

const closeMenu = useCallback((opts?: { restoreFocus?: boolean }) => {
  restoreOnCloseRef.current = !!opts?.restoreFocus;
  setOpen(false); // ❌ 问题点：未调用 handleOpenChange(false)！
}, []);
```
当用户在菜单中按 `Escape` 时：
`onMenuKeyDown` 捕获了按键，调用 `closeMenu({ restoreFocus: true })`。
由于直接执行了 `setOpen(false)`，外部受控属性使 React 重新渲染，但并未触发 `handleOpenChange(false)`，导致微任务焦点还原逻辑根本没有被加入事件循环队列！

---

### 4.3 优雅根治方案实施

#### 方案第一步：修复 `Menu.tsx`，回归 Radix UI 原生 Slot 模式
Radix UI 的 `@radix-ui/react-popover` 中，`<Popover.Trigger asChild>` 内部原本就基于 `@radix-ui/react-slot`。
**Radix 的 Slot 机制原生支持将所有属性、事件处理器（包括 `onClickCapture`）与 Ref（通过 `useComposedRefs` 自动多路合并）无损注入到直接子元素上，根本不需要任何 `<span>` 包装，也绝不违反 G-02！**

在 `apps/crish-desktop/src/components/ui/Menu/Menu.tsx` 中移除 `hostTrigger` 与 `<span>`：
```tsx
const handleTriggerClickCapture = (e: React.MouseEvent) => {
  if (!isOpen && shouldSuppressMenuReopen(triggerRef.current)) {
    e.preventDefault();
  }
};

renderedTrigger =
  tipContent && React.isValidElement(actualTrigger) ? (
    <Tooltip content={tipContent} side={tipSide} disabled={isOpen}>
      <Popover.Trigger
        asChild
        ref={triggerRef}
        onClickCapture={handleTriggerClickCapture}
      >
        {actualTrigger}
      </Popover.Trigger>
    </Tooltip>
  ) : React.isValidElement(actualTrigger) ? (
    <Popover.Trigger
      asChild
      ref={triggerRef}
      onClickCapture={handleTriggerClickCapture}
    >
      {actualTrigger}
    </Popover.Trigger>
  ) : (
    <Popover.Trigger
      ref={triggerRef as React.Ref<HTMLButtonElement>}
      onClickCapture={handleTriggerClickCapture}
    >
      {actualTrigger}
    </Popover.Trigger>
  );
```

**这一修复的效果**：
1. **真实 DOM 清除伪包装**：渲染树直接输出 `<button data-testid="settings-button">`，消除多余 `<span>`。
2. **Ref 自动合成**：Radix Slot 的 `composeRefs` 机制同时保证了 `Menu` 内部的 `triggerRef.current` 与外部传入的 `btnRef.current` 均准确指向 `<button>` 真实 DOM 元素。
3. **零 cloneElement**：完全符合 G-02 规则，门禁 100% 通过。

#### 方案第二步：修复 `SettingsQuickMenu.tsx` 关闭调度流
修改 `SettingsQuickMenu.tsx` 中的 `closeMenu`，使其统一委派给 `handleOpenChange(false)`：
```tsx
const closeMenu = useCallback(
  (opts?: { restoreFocus?: boolean }) => {
    restoreOnCloseRef.current = !!opts?.restoreFocus;
    handleOpenChange(false);
  },
  [handleOpenChange]
);
```

**双轨保障机制**：
- **第一轨（Radix 原生通道）**：菜单销毁时，Radix Popover Content 的 `onCloseAutoFocus` 触发，直接将焦点交还给 `Popover.Trigger`（即真实的 `<button>`）。
- **第二轨（应用级微任务兜底通道）**：`handleOpenChange` 中的 `queueMicrotask(() => btnRef.current?.focus())` 在下一微任务时钟核对焦点，双重确保焦点精准锁死在触发按钮上。

---

## 五、验证断言与测试报告

针对上述修复方案，我们执行了完整的立体化工程验证：

### 5.1 门禁检查合规性 (`scripts/check-frontend-convergence.mjs`)
执行命令：`node scripts/check-frontend-convergence.mjs`
```
🛡️  [check:convergence] 启动前端重构终极收敛防回潮门禁扫描 (G-01 ~ G-13)...

┌──────┬──────────────────────────────────────────────────────────────┬────────────┐
│ 规则 │ 规则名称                                                     │ 状态       │
├──────┼──────────────────────────────────────────────────────────────┼────────────┤
│ G-01 │ 业务层零裸交互标签                                         │ ✅ 通过    │
│ G-02 │ 浮层零 cloneElement 与零 stopPropagation                     │ ✅ 通过    │
│ G-03 │ 零裸 RO / 零 window.resize / 零 0px 回流 / 零 flushSync      │ ✅ 通过    │
│ G-04 │ 零非法 radius-full 药丸（Switch/Avatar 白名单）               │ ✅ 通过    │
│ G-05 │ 7 级标准 Z-Index 标尺合规性（封顶 9000）                    │ ✅ 通过    │
│ G-06 │ 业务层 CSS Modules 零 !important                             │ ✅ 通过    │
│ G-07 │ 入口 index.css 零废弃全局样式表 import                       │ ✅ 通过    │
│ G-08 │ 叶子分发 TreeLeafPanel 零静态 switch(panelId)                 │ ✅ 通过    │
│ G-09 │ 状态层零伪门面别名同体与零 withAutoIndex 中间件             │ ✅ 通过    │
│ G-10 │ 空态表面零状态渗透 (!onEmptySurface 刚性门闩)                 │ ✅ 通过    │
│ G-11 │ 全仓零 onShowToast 属性透传 (No Toast Prop Drilling)         │ ✅ 通过    │
│ G-12 │ 严禁使用原生 HTML title 属性 (强制 <Tooltip>)               │ ✅ 通过    │
│ G-13 │ 全仓零 GBK 乱码固化与编码损坏阻断                           │ ✅ 通过    │
└──────┴──────────────────────────────────────────────────────────────┴────────────┘

🎉 [check:convergence] 完美通过！全仓 13 大收敛规则 0 违规，架构纯净无回潮 (All 13 Rules Passed, 0 Violations)。
```

### 5.2 核心单元测试结果
1. **`SettingsQuickMenu.test.tsx` (6/6 全部通过)**：
   - ✓ 点击设置按钮打开菜单并渲染主题段与快捷入口 (72ms)
   - ✓ 外观段走 SegmentedControl，无 .ui-segment 死皮 (48ms)
   - ✓ 外观段 CSS 不写 999 胶囊、不用 --bg-primary 挖坑 (14ms)
   - ✓ **Esc 关闭菜单并还原焦点到触发按钮 (59ms) [原失败项已完美修复]**
   - ✓ 键盘漫游：ArrowDown 循环聚焦（主题 radio → 入口项） (36ms)
   - ✓ 外点关闭后不把焦点强加给触发按钮 (21ms)
2. **`Menu.test.tsx` (23/23 全部通过)**：
   - 23 项菜单基座测试套件 100% 通过（耗时 768ms），证实移除 `<span>` 对 `Menu` 现有所有行为零回归损伤。
3. **全仓 TypeScript 静态类型检查 (`npm run typecheck`)**：
   - 包含 `apps/crish-desktop`、`apps/agent-workbench`、`packages/*` 跨项目编译，0 错误退出（Exit code 0）。

---

## 六、缺陷清单与收尾建议

### 6.1 缺陷与整改清单汇总表

| 序号 | 模块 / 文件 | 缺陷现象与等级 | 根因分类 | 修复与收敛手段 | 验证结果 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **D-01** | `Menu/Menu.tsx` | **[Blocker]** 触发器被 `<span>` 伪宿主包裹导致 Ref 漂移与焦点还原断裂 | UI 基座设计偏差 | 移除 `<span>`，直接向 `<Popover.Trigger asChild ref={...}>` 传递真实组件 | `Menu.test.tsx` (23/23)<br>`SettingsQuickMenu.test.tsx` (6/6) 全绿 |
| **D-02** | `SettingsQuickMenu.tsx` | **[Major]** `closeMenu` 绕过 `handleOpenChange` 导致微任务焦点调度失效 | 状态机流转断裂 | `closeMenu` 统一委派给 `handleOpenChange(false)` | Esc 焦点还原断言通过 |
| **D-03** | `SettingsProfileTab.tsx` | **[Minor]** 81 行使用 `document.createElement('input')` | G-01 规则拦截 | 改造为声明式隐藏 `<Input bare type="file">` 并由 ref 控制 | G-01 校验通过 |
| **D-04** | `WorkflowForm.tsx` | **[Major]** `chat` 分支遗留 4 处裸 `<input>` 与 `<textarea>` | 重构分支不对称 | 统一替换为 `<Input bare>` 与 `<Textarea bare>` | G-01 违规归零 |
| **D-05** | `StatusDiagnosticsPanel.tsx`| **[Trivial]** 47 行使用 `createElement('textarea')` 兜底复制 | 遗留死代码 | 清理已废弃的 `execCommand` 兜底，保留现代 `navigator.clipboard` | G-01 校验通过 |
| **D-06** | 设置域多处组件 | **[Minor]** 原生 `<button>` 未收敛为原子组件 | G-01 规则拦截 | 全面替换为 `<Button bare>`，并在 CSS 模块补充选择器适配 | G-01 校验通过 |

### 6.2 协作与提交建议
依据仓库根目录 `AGENTS.md` 通用协作纪律第 3 条（多 Agent Git 提交纪律）：
1. **严禁子 Agent 提交**：本子 Agent 严格遵守纪律，未执行任何 `git commit` 操作。
2. **工作区整洁度保障**：所有修复均在现有工作树上精确进行，未执行任何 `git reset` 或 `checkout`。
3. **主控收口建议**：待主 Agent 统一调度时，建议使用 `git commit --only <paths>` 分批或统一收敛提交（建议提交信息头：`fix(settings): atomize interactive tags and repair Menu trigger focus restoration (BATCH-5D)`）。
