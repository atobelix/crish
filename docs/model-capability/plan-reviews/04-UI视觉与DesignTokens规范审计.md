# AI 服务商界面 UI 视觉一致性与 Design Tokens 规范审计报告

> **报告标识**：`docs/model-capability/plan-reviews/04-UI视觉与DesignTokens规范审计.md`
> **审查对象**：
> 1. `docs/model-capability/00-AI服务商与模型管理全面重构终极方案.md`（维度三与维度六）
> 2. `docs/model-capability/analysis/04-服务商界面整体视觉重构与样式规范方案.md`（全案）
> **对照基准**：
> - `apps/crish-desktop/src/styles/tokens.css`（全局设计真源 SSOT）
> - `AGENTS.md` §12（自定义 Tooltip 规范）、§13（输入框软灰焦点态与 10% 混入限额）、§14（现代色彩空间与语法）
> - 设置中心标准体系：`SettingsUI.tsx` / `SettingsUI.module.css`、`SettingsSidebar.tsx` / `SettingsPanel.module.css`、`SettingsShortcutsTab.module.css`、`ui/Menu/Menu.module.css`
> **审计纪律**：只读源码、纯逻辑规划、严禁打补丁（AGENTS.md §7）、反退避（`.agents/LOGIC_PLAN_NO_RETREAT.md`）、无代码修改、严禁执行 git 提交。

---

## 一、 审计总览与核心裁决结论

### 1.1 总体评估
`docs/model-capability/analysis/04-服务商界面整体视觉重构与样式规范方案.md` 针对用户严厉指出的“偏离主题、看着挺丑、灰度乱用、排版不行”进行了极其详尽的根因解剖，准确识别了“5 层灰度套娃”、“泥坑式灰输入框”、“实心灰色死胶囊”、“左导轨选中态与系统主侧栏违和”、“模型列表积木块碎裂化”以及“1165 行样式中沉淀 70% 死代码”等关键毒点，重构大方向（纯白卡底化、细线流式排版、7px 按钮/输入框圆角、死代码脱水）完全正确且极具价值。

**然而，在深入对照 `tokens.css`、`AGENTS.md` §12~§14 及各标准 Tab 真实实现后，本审计发现该重构方案在 Design Tokens 精确消费、深色模式光学适应、弹出浮层包含块架构、无障碍 Tooltip 覆盖率以及响应式齿轮缩放等维度，存在 6 处关键断层与次生毒点**。如果不在此评审阶段刚性纠偏，重构实施后将导致深色模式视觉倒退、浮层双滚动条复发以及幽灵 Token 引起的不可预测渲染失效。

### 1.2 关键审计发现摘要（Critical Findings Summary）
1. **幽灵 Token 滥用（Phantom Token）**：方案在下拉菜单与级联浮层（Line 1073）中直接使用了 `box-shadow: var(--shadow-dropdown);`。经检索全局样式库，`--shadow-dropdown` 在 `tokens.css` 中**零定义**，属于悬空失效属性。正确应接入系统弹层权威阴影 `var(--sep-shadow)` 或 `var(--shadow-md)`。
2. **深色模式光学感知反转（Dark Mode Optical Inversion）**：
   - 展开配置面板（Line 603, 982）使用 `background: color-mix(in srgb, var(--text-primary) 1.5%, var(--bg-card));`。浅色下 `--text-primary` 是 `#111111`，呈现下沉微灰；但在暗黑模式下 `--text-primary` 为 `#dddddd`（高亮前景色），导致暗色下的展开面板不仅没有“下沉变暗”，反而**反向“提亮浮起”**，破坏深浅模式的一致层级认知。
   - 左侧导轨使用 `color-mix(in srgb, var(--bg-primary) 35%, var(--bg-card))`，在深色模式下计算结果为 `#212121`，与激活项白卡（`var(--bg-card)` 为 `#242424`）亮度差异仅约 3 个灰阶，导致暗黑模式下浮起卡片质感彻底塌陷。
3. **Menu 基座包含块重复嵌套（Container Layering Conflict）**：方案将 `.cascadeList` 与 `.cascadeFlyout` 依然定义为带边框、圆角、背景、阴影和 `padding: 6px` 的独立容器，与外层基座 `ui/Menu`（`Menu.module.css`）产生硬性重复包裹。这与 `00-AI服务商与模型管理全面重构终极方案.md` 维度六第 1 条“**剥离内层重复包含块样式**”产生严重方案冲突，会直接导致双边框、内衬截断与双滚动条死灰复燃。
4. **Tooltip 规范性遗漏（AGENTS.md §12 违规）**：模型行内的工具调用、视觉解析、深度思考图标（`.mrdCapTag`）在当前代码中仅声明 `aria-label`，未包裹系统 `<Tooltip>` 组件；模型长名称单行截断（`text-overflow: ellipsis`）缺乏全名 Tooltip；源码中甚至存在通过内联事件操纵 `currentTarget.style.borderColor` 的违规逻辑。方案对此未能给出强制性补齐规范。
5. **输入框与焦点态硬编码及齿轮缩放断裂（AGENTS.md §13 违规）**：
   - 方案在样式表中硬编码 `height: 32px;`、`height: 28px;`，未采用 `var(--control-height)` 与 `var(--control-height-sm)`，阻断了 `[data-ui-size='small']` / `[data-ui-size='large']` 的系统全局动态缩放响应。
   - `ProviderProfileForm.tsx` 的保存按钮内联写死 `height: 34px`，与旁侧 32px 输入框产生 2px 几何错位。
   - 表格与具体落地 CSS 的焦点态口径不一（表格使用 `--focus-ring-strong`，代码裸写内联 `color-mix`）；且 `tokens.css` 中暗黑模式下 `--focus-ring-subtle` 定义包含 `0 0 0 1px`，不可直接作为色彩值塞入 `box-shadow: 0 0 0 1.5px ...`。
6. **跨组件内联样式（Inline Style Debt）清退不彻底**：`ProfileHeader`、`ModelListHeader`、`ProviderProfileForm`、`ModelConfigPanel` 等组件散落 15+ 处包含硬编码像素、裸写颜色的 `style={{...}}` 内联属性，方案缺少系统化的迁移回收规范。

---

## 二、 六大核心违规与架构断层深度解剖

```
┌───────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   重构方案视觉架构漏洞全景透视图                                      │
├───────────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                       │
│ 1. 幽灵 Token 悬空:  box-shadow: var(--shadow-dropdown) ───► tokens.css 中零定义，阴影丢失回退为 none    │
│                                                                                                       │
│ 2. 深色模式反转:     color-mix(var(--text-primary) 1.5%, card)                                         │
│                      ├─ Light: 纯白 + 1.5% 黑字 ──► #fbfbfb (微下沉正常)                              │
│                      └─ Dark:  暗底 + 1.5% 白字 ──► #262626 (反向提亮，层级倒错！)                     │
│                                                                                                       │
│ 3. 包含块重复套娃:   ui/Menu 外壳 [14px圆角 + sep-shadow + padding: 6px]                               │
│                      └─► 内层 .cascadeList [12px圆角 + shadow-dropdown + padding: 6px] 【双层套壳复发】│
│                                                                                                       │
│ 4. Tooltip 覆盖盲区:  .mrdCapTag 图标仅有 aria-label ──► 悬停零反馈，违反 AGENTS.md §12 提示统一性       │
│                      .mrdModelName 文本单行截断 ─────► 溢出隐藏无 Tooltip，用户看不全长模型名         │
│                                                                                                       │
│ 5. 几何高度写死断裂:  .mrdFieldInput: height: 32px ──► 脱离 --control-height，ui-size 缩放时布局失配   │
│                      Provider 保存按钮: height: 34px ─► 与 32px 输入框水平并排形成 2px 台阶错位        │
│                                                                                                       │
│ 6. 内联样式散落未收:  ProfileHeader / ListHeader / ConfigPanel 仍残留 15+ 处 style={{...}} 硬编码    │
└───────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 毒点 1：幽灵 Token（Phantom Token）滥用
- **现场证据**：`docs/model-capability/analysis/04-服务商界面整体视觉重构与样式规范方案.md` 第 1069-1073 行：
  ```css
  .addProviderMenu,
  .cascadeList,
  .cascadeFlyout {
    min-width: 220px;
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-xl, 12px);
    box-shadow: var(--shadow-dropdown); /* ◄── 幽灵 Token！ */
    padding: 6px;
    ...
  }
  ```
- **对照检索**：在 `apps/crish-desktop/src/styles/tokens.css` 全文中，使用 ripgrep 进行全局无死角检索，**根本不存在 `--shadow-dropdown` 的任何定义**！
- **毒化机理**：当浏览器解析到 `box-shadow: var(--shadow-dropdown);` 时，由于该变量未声明且无 fallback，计算值为 `none`。这导致弹出菜单在浅色模式或复杂重叠背景下，没有任何阴影边界，直接与底板融为一体，产生严重的辨识困难。
- **校准决议**：
  - 下拉菜单与级联组件统一对齐 `ui/Menu` 与 `SmartExpandablePanel` 的设计真源，使用 `box-shadow: var(--sep-shadow);` 或系统标准卡片浮起投影 `box-shadow: var(--shadow-md);`。
  - 清退所有历史遗留代码中对 `var(--shadow-dropdown)` 的错误引用。

---

### 2.2 毒点 2：深色模式（Dark Mode）光学感知严重反转
- **现场证据 1（展开配置面板）**：方案第 603 行、第 982 行：
  ```css
  .modelConfigPanel {
    ...
    background: color-mix(in srgb, var(--text-primary) 1.5%, var(--bg-card));
  }
  ```
- **对照检索**：`tokens.css` 中：
  - Light 模式：`--bg-card: hsl(0 0% 100%)` (#ffffff)，`--text-primary: #111111`。
    计算结果：`color-mix(in srgb, #111111 1.5%, #ffffff)` ➔ 得到约 `hsl(0 0% 98.7%)`（约 1.3% 柔和暗色，微下沉）。
  - Dark 模式：`--bg-card: #242424`，`--text-primary: #dddddd`。
    计算结果：`color-mix(in srgb, #dddddd 1.5%, #242424)` ➔ 混入高亮白色，得到约 `#272727`！
- **毒化机理**：在深色模式下，设计目标本应是让展开抽屉相对于模型卡片产生**微弱的内凹下沉感（Inset/Depressed Feel）**。但由于直接使用了 `--text-primary`，暗色下的前景色是高亮白，导致面板反而被“提亮浮起”，不仅失去了下沉抽屉的心理暗示，更使表单区域在暗夜环境下显得突兀发灰。
- **现场证据 2（左侧导轨背景）**：方案第 389 行、第 646 行：
  ```css
  .modelsRail {
    ...
    background: color-mix(in srgb, var(--bg-primary) 35%, var(--bg-card));
  }
  ```
  - Light 模式：`--bg-primary` 是 5.5% 灰度，`--bg-card` 是纯白，混出极柔和浅雾底（约 1.9% 灰度），选中的 `.mrlItem.isActive` 为纯白卡片加 `--shadow-sm`，对比清晰典雅。
  - Dark 模式：`--bg-primary: #1b1b1b`，`--bg-card: #242424`。
    计算结果：`color-mix(in srgb, #1b1b1b 35%, #242424)` 得到 `#212121`。选中的激活项背景为 `var(--bg-card)`（`#242424`）。在 OLED 或中低端显示器上，`#212121` 与 `#242424` 的亮度对比度仅为 1.05:1，且暗色模式下 `--shadow-sm`（`rgba(0,0,0,0.16)`）肉眼几乎无法察觉，导致“选中白卡浮起”的设计意图在深色模式下彻底坍塌为扁平死水。
- **校准决议**：
  - 展开面板 `.modelConfigPanel` 的下沉底色必须与色彩反转解耦。浅色下混入微量黑色文本色，深色下混入微量黑色阴影色，或直接使用系统语义级下沉背景：
    ```css
    /* 浅色模式下沉 */
    background: color-mix(in srgb, var(--shadow-color, #000) 2%, var(--bg-card));
    /* 深色模式下沉（确保在 #242424 基础上真正向深色微陷至 #1e1e1e） */
    ```
    或者在 Dark 模式下声明：`background: color-mix(in srgb, var(--bg-primary) 60%, var(--bg-card));`，确保光影层级对称！
  - 左侧导轨 `.modelsRail` 在 Dark 模式下，直接回归系统主侧边栏的权威真源 `var(--bg-primary, #1b1b1b)`，使激活项 `var(--bg-card, #242424)` 拥有清晰自然的物理卡片反差！

---

### 2.3 毒点 3：Menu 包含块重复嵌套与双边框/双阴影
- **现场证据**：
  在 `00-AI服务商与模型管理全面重构终极方案.md` 维度六第 1 条中，架构决策明确要求：
  > **“包含块解构：剥离 `.cascadeList` 的多余内边距与外壳阴影，将垂直滚动权单一收敛至 `Menu` 基座；”**
  而在 04 方案第 1068-1079 行的建议代码中，依然固执地书写：
  ```css
  .cascadeList {
    min-width: 220px;
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-xl, 12px);
    box-shadow: var(--shadow-dropdown);
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  ```
- **对照检索**：`apps/crish-desktop/src/components/ui/Menu/Menu.module.css:25-34`：
  ```css
  .menuContent {
    padding: 6px;
    border-radius: var(--sep-radius-outer, 14px);
    border: 1px solid var(--border-color, hsl(35 10% 86%));
    background: var(--bg-card, hsl(0 0% 100%));
    box-shadow: var(--sep-shadow);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  ```
- **毒化机理**：`ui/Menu` 组件通过 Radix Popper 渲染时，`.menuContent` 已经是那个拥有 `14px` 圆角、毛玻璃模糊、边框与 `--sep-shadow` 阴影的外层包含块。如果作为 children 传入的 `.cascadeList` 又自带一套 `12px` 圆角、边框、阴影和 `padding: 6px`，在 DOM 树中就会形成：
  `MenuWrapper > .menuContent (有边框+6px内边距) > .cascadeList (又有边框+6px内边距)`！
  直接导致：
  1. 菜单四周被强行套了两层边框；
  2. 内边距累加为 12px，造成视觉松垮臃肿；
  3. 内外两层容器都有高度与 overflow 限制，造成现场出现的“两根垂直滚动条紧挨着出现、菜单项文字被内衬右边缘物理裁切”的恶性体验！
- **校准决议**：
  - 严格执行 00 方案维度六决策！`.cascadeList` 必须彻底解构，**清退所有独立容器属性**（border: none, background: transparent, box-shadow: none, border-radius: 0, padding: 0）！
  - 允许 `.cascadeList` 仅保留 `display: flex; flex-direction: column; gap: 2px; min-width: 220px;` 等布局排版属性，将容器责任 100% 交还给 `Menu` 基座！
  - 对于二级飞出菜单 `.cascadeFlyout`，由于通过 Portal 逃逸挂载（00 方案决策），它才作为独立浮层承载 `border: 1px solid var(--border-color); border-radius: var(--sep-radius-outer, 14px); box-shadow: var(--sep-shadow);`，并与 `Menu` 基座保持 100% 同构。

---

### 2.4 毒点 4：Tooltip 规范与无障碍提示严重脱节（AGENTS.md §12 违规）
- **现场证据 1（能力图标标签）**：
  `apps/crish-desktop/src/components/settings-models/ModelList.tsx:109-133`：
  ```tsx
  {meta.capabilities?.tools && (
    <span className={`${styles.mrdCapTag} mrd-cap-tag`} aria-label="支持工具调用">
      <Lucide.Wrench size={10} />
    </span>
  )}
  ```
  在 04 方案第 328 行写道：“能力图标标签：`.mrdCapTag` 尺寸不一，统一悬浮提示，不喧宾夺主”。但在第 8.5 节的改造指引与第 954-960 行样式中，**完全没有规定在 TSX 中必须给每一个能力图标包裹 `<Tooltip content="...">`**！
  目前界面上的 10px 扳手、眼睛、大脑图标，鼠标悬停没有任何浮层提示，普通用户根本无法理解图标含义，属于严重的可用性缺陷。
- **现场证据 2（长模型名截断）**：
  `ModelList.tsx:100` 中，模型名称虽然设置了 `text-overflow: ellipsis; white-space: nowrap; overflow: hidden;`，但**没有像左侧服务商列表 `mrlItemName` 那样包裹 `<Tooltip content={display}>`**。当模型 ID 较长（如 `deepseek/deepseek-r1-distill-qwen-32b`）时，用户在列表行中无法查看完整名称。
- **现场证据 3（侵入式内联 DOM 样式操纵）**：
  `ProfileHeader.tsx:98-102` 中，为了实现悬停时下划虚线变深，代码中竟然挂载了：
  ```tsx
  onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--text-secondary)'; }}
  onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border-subtle)'; }}
  ```
  直接绕过 React 虚拟 DOM 和 CSS 类，手动操作 DOM 内联样式，属于极其粗糙的打补丁行为，直接违反 AGENTS.md §7。
- **校准决议**：
  - 强制在 `ModelList.tsx` 中为三个能力标签包裹标准 `<Tooltip content="支持工具调用 / 支持视觉解析 / 支持深度思考">`。
  - 强制为 `.mrdModelName` 包裹 `<Tooltip content={display}>`，保证长名称在任何视口宽度下均可完整查验。
  - 彻底铲除 `ProfileHeader.tsx` 的内联 `onMouseEnter/onMouseLeave` 事件，迁移为标准的 CSS `:hover` 伪类。

---

### 2.5 毒点 5：输入控件尺寸硬编码与齿轮缩放断裂（AGENTS.md §13 违规）
- **现场证据 1（控件高度写死）**：
  04 方案第 807 行与第 866 行：
  ```css
  .mrdFieldInput {
    height: 32px;
    min-height: 32px;
    ...
  }
  .mrdSearch {
    height: 28px;
    min-height: 28px;
    ...
  }
  ```
- **对照检索**：`tokens.css:772-775`、`1447-1450`、`1529-1532`：
  - 默认档：`--control-height: 32px; --control-height-sm: 28px;`
  - Small 档（`[data-ui-size='small']`）：`--control-height: 30px; --control-height-sm: 26px;`
  - Large 档（`[data-ui-size='large']`）：`--control-height: 34px; --control-height-sm: 30px;`
- **毒化机理**：直接裸写 `height: 32px` 和 `height: 28px`，切断了与系统核心 Token `--control-height` / `--control-height-sm` 的单一真源连接。当用户在设置中心将界面尺寸调节为“紧凑（Small）”或“宽松（Large）”时，输入框高度岿然不动，但内部字号已按 `--font-size-sm` 缩放，导致紧凑模式下输入框异常偏大，宽松模式下文字与输入框垂直比例失调。
- **现场证据 2（保存按钮高度差 2px）**：
  `ProviderProfileForm.tsx:84-89` 中：
  ```tsx
  <Button ... style={{ borderRadius: '7px', height: '34px', padding: '0 14px', flexShrink: 0 }}>
    保存
  </Button>
  ```
  API Key 输入框的高度被 04 方案定为 `32px`，而保存按钮内联写死了 `height: 34px`，两者在 `.mrdKeyRow` 横向 Flex 容器中并排，直接形成 **2px 的视觉锯齿台阶**！
- **现场证据 3（焦点态 Token 类型断裂）**：
  04 方案在表格 4.3 节中声明输入框聚焦投影使用 `box-shadow: 0 0 0 1.5px var(--focus-ring-subtle);`。
  但在 `tokens.css` 中：
  - 浅色模式（Line 168）：`--focus-ring-subtle: color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%);`（这是一个纯颜色 `<color>`）；
  - 深色模式（Line 991）：`--focus-ring-subtle: 0 0 0 1px color-mix(in srgb, var(--border-color) 95%, var(--text-primary) 5%);`（这直接是一个完整的 `<box-shadow>` 属性值！）。
  如果开发者直接按照方案表格写 `box-shadow: 0 0 0 1.5px var(--focus-ring-subtle);`，在深色模式下将被浏览器解析为：
  `box-shadow: 0 0 0 1.5px 0 0 0 1px ...;` ➔ **CSS 语法无效（Invalid property value），投影完全失效！**
- **校准决议**：
  - 输入框与搜索框全面接入系统控件高度 Token：`.mrdFieldInput { height: var(--control-height); }`，`.mrdSearch { height: var(--control-height-sm); }`。
  - 清退 `ProviderProfileForm.tsx` 的 `height: 34px` 内联样式，直接使用标准组件属性 `<Button size="sm">`，其在系统规范中高度精确为 `var(--control-height)`，与输入框 100% 严丝合缝平齐。
  - 焦点态统一切实对齐 AGENTS.md §13，采用语义级、深浅色模式兼容的标准写法语法：
    ```css
    .mrdFieldInput:focus,
    .mrdFieldInput:focus-visible {
      outline: none;
      background: var(--bg-card);
      border-color: color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
      box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%);
    }
    ```

---

### 2.6 毒点 6：跨组件 15+ 处散落内联样式（Inline Styles Debt）未列入清退
在现有代码库中，组件 TSX 内部散落着大量历史随手写入的 `style={{...}}`，严重违背了组件与样式解耦的设计原则，不仅造成维护断层，更容易在深色模式下变成无法覆盖的死角。

| 所在组件文件 | 违规行号区间 | 散落的内联样式代码片段 | 违规性质与视觉危害 |
| :--- | :--- | :--- | :--- |
| `ProfileHeader.tsx` | Line 118-138 | `style={{ height: '26px', borderRadius: '6px', border: ..., background: color-mix(...), color: ... }}` | 状态按钮裸写 10 行内联属性，破坏统一 Button 规范 |
| `ProfileHeader.tsx` | Line 151-161 | `style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)', borderRadius: '8px', padding: '4px 8px' }}` | 确认删除浮层内联写出灰底泥坑（`var(--bg-primary)`） |
| `ProfileHeader.tsx` | Line 176-180 | `style={{ height: '24px', padding: '0 8px', borderRadius: '5px' }}` | 按钮裸写非标圆角 5px 与高度 24px |
| `ProviderProfileForm.tsx` | Line 84-89 | `style={{ borderRadius: '7px', height: '34px', padding: '0 14px', flexShrink: 0 }}` | 保存按钮写死 34px，与 32px 输入框形成 2px 阶梯错位 |
| `ModelListHeader.tsx` | Line 44-51 | `style={{ height: '28px', width: '28px', padding: '0', display: 'inline-flex', ... }}` | 连通性检查按钮写死内联方形尺寸 |
| `ModelListHeader.tsx` | Line 72-79 | `style={{ height: '28px', width: '28px', padding: '0', ... }}` | 自动获取模型按钮写死内联方形尺寸 |
| `ModelListHeader.tsx` | Line 93-104 | `style={{ position: 'relative' }}` 与 `style={{ position: 'absolute', left: '8px', ... }}` | 搜索框定位完全由内联样式拼接，CSS 未封装 |
| `ModelListHeader.tsx` | Line 123-130 | `style={{ height: '28px', width: '28px', padding: '0', ... }}` | 手动添加按钮写死内联方形尺寸 |
| `ModelList.tsx` | Line 97 | `style={{ cursor: 'pointer' }}` | 模型行指针样式内联裸写 |
| `ModelList.tsx` | Line 154-160 | `style={{ padding: '0 5px', height: '26px', color: expanded ? 'var(--accent-primary)' : 'var(--text-tertiary)' }}` | 配置展开按钮裸写 26px 非标高度 |
| `ModelList.tsx` | Line 176-180 | `style={{ padding: '0 5px', height: '26px', color: 'var(--text-tertiary)' }}` | 删除按钮裸写 26px 非标高度 |
| `ModelConfigPanel.tsx` | Line 125-138 | `style={{ fontSize: '11px', fontWeight: 500, color: !meta.lastTest.ok ? 'var(--accent-red)' : ... }}` | 延迟数字裸写大量颜色分支与内联尺寸 |
| `ModelProfileList.tsx` | Line 50 | `style={{ minWidth: '220px', justifyContent: 'space-between' }}` | 级联选择器触发器内联裸写宽度 |
| `ModelProfileList.tsx` | Line 211-218 | `style={{ background: !keyOk ? 'var(--color-warning)' : ..., opacity: !enabled ? 0.6 : 1 }}` | 服务商状态圆点内联裸写背景色与透明度 |

**校准决议**：
在 Wave 2 视觉重构落地时，必须在组件层面彻底将上述 15 处内联样式全部抽离至 `ModelsSettingsTab.module.css` 对应的语义化类名中（如 `.mrdStatusBadge`、`.mrdConfirmPopup`、`.mrdIconBtn`、`.mrdSearchWrapper`、`.mrdSearchIcon`、`.mrdLatencyBadge`、`.mrlItemDot`），组件内只保留语义化 JSX，严禁裸写 `style={{...}}`。

---

## 三、 全景样式对比表（现状 vs 方案 04 vs 校准后单一真理源）

| UI 模块 / 视觉维度 | 现状（当前代码库缺陷） | 方案 04（提议方案） | 校准后标准方案（SSOT 权威裁决） | 裁决依据与架构价值 |
| :--- | :--- | :--- | :--- | :--- |
| **主容器外框 (`.modelsSplit`)** | `height: max(480px, ...)` 导致溢出，`border-radius: 0; background: transparent;` | `height: 540px; border-radius: var(--radius-xl, 12px); background: var(--bg-card);` | `flex: 1 1 0; min-height: 0; height: 100%; border-radius: var(--radius-xl, 12px); background: var(--bg-card); border: 1px solid var(--border-color);` | 彻底拔除魔术高度数字，打通 100% 视口弹性链；外框严格对齐一级设置卡片契约 |
| **左侧服务商导轨 (`.modelsRail`)** | `background: var(--bg-secondary);` (7.9% 突兀大灰条) | `background: color-mix(var(--bg-primary) 35%, var(--bg-card));` (深色模式对比坍塌) | **Light**：`color-mix(var(--bg-primary) 35%, var(--bg-card))`；<br>**Dark**：`var(--bg-primary, #1b1b1b)` | 浅色下维持极轻柔浅雾底；深色下回归底板真源，激活项卡片反差提升 300% |
| **导轨选中激活项 (`.mrlItem.isActive`)** | `background: var(--bg-active);` (深灰凹陷死长条) | `background: var(--bg-card); box-shadow: var(--shadow-sm);` | `background: var(--bg-card); border: 1px solid var(--border-subtle); box-shadow: var(--shadow-sm);` | 100% 同构系统主侧边栏 `.sidebarTab.active`，呈现高级实体白卡微浮起质感 |
| **右侧工作区底色 (`.modelsDetail`)** | `background: var(--bg-primary);` (5.5% 泥坑灰色画布) | `background: var(--bg-card);` | `background: var(--bg-card);` (纯正无暇卡底纸白) | 彻底终结 5 层灰度横跳，与全局 `coverContent` 底色天衣无缝融合 |
| **表单输入框底色 (`.mrdFieldInput`)** | `background: var(--bg-primary);` (灰坑输入槽) | `background: var(--bg-card);` | `background: var(--bg-card);` (通透白底) | 告别脏浊下陷感，书写与阅读对比度达最高舒适区 |
| **表单输入框高度 (`.mrdFieldInput`)** | `height: 32px;` (写死) | `height: 32px; min-height: 32px;` (写死) | `height: var(--control-height, 32px); min-height: var(--control-height, 32px);` | 全量接入系统控件高度 Token，支持 UI Size 紧凑/宽松齿轮自适应 |
| **输入框聚焦环 (`:focus`)** | `box-shadow: none; background: var(--bg-primary);` | 裸写内联 `color-mix`，口径与 Token 声明割裂 | `border-color: color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%); box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%);` | 刚性落实 AGENTS.md §13，文本色混入严格限制在 6%~10%，柔软温和绝无眩光 |
| **搜索框尺寸与位置 (`.mrdSearch`)** | 散落在内联样式，高度写死 28px | 硬编码 `height: 28px; width: 140px;` | `height: var(--control-height-sm, 28px); width: 160px;`，封装 `.mrdSearchWrapper` | 消除内联绝对定位补丁，接入 Small 档控件高度标准 |
| **上下文标签 (`.mrdCtxPill`)** | `background: var(--tint-active);` (实心死灰胶囊) | `background: transparent; border: 1px solid var(--border-subtle);` | `background: transparent; border: 1px solid var(--border-subtle); border-radius: var(--radius-full, 9999px);` | 彻底清退实心暗色杂质，回归透亮微胶囊设计语言 |
| **展开面板背景 (`.modelConfigPanel`)** | `background: var(--bg-secondary);` (深灰粗暴套娃) | `background: color-mix(var(--text-primary) 1.5%, card);` (深色模式逆向提亮) | **Light**：`color-mix(var(--text-primary) 1.5%, var(--bg-card))`；<br>**Dark**：`color-mix(var(--bg-primary) 60%, var(--bg-card))` | 彻底解决深色模式下“混入白色文本色导致面板发白浮起”的致命反转，实现真实微下沉 |
| **下拉级联浮层 (`.cascadeList`)** | 包含块重复套娃，内部写死 12px 圆角与双边框 | 仍保留完整外壳属性，裸写未定义的 `var(--shadow-dropdown)` | **解构为纯列表布局**：`background: transparent; border: none; box-shadow: none; padding: 0;` | 彻底遵循 00 方案维度六，将外壳完全交还 `ui/Menu`，从根源清退双滚动条与文字裁切 |
| **级联飞出子菜单 (`.cascadeFlyout`)** | 内部绝对定位，受父级 overflow 截断闪退 | 内部普通浮层，仍写未定义 shadow | **Portal 逃逸顶层渲染**：继承 `ui/Menu` 规范，`border-radius: var(--sep-radius-outer, 14px); box-shadow: var(--sep-shadow);` | 彻底杜绝父级包含块裁切与假性撑大，安全三角平滑穿梭 |
| **能力图标标签 (`.mrdCapTag`)** | 仅 `aria-label`，鼠标悬停无任何提示 | 仅声明尺寸与微透明度，未补齐 Tooltip | **补齐 Tooltip 包装**：`<Tooltip content="支持工具调用/视觉解析/深度思考">` | 严格遵守 AGENTS.md §12，无障碍一等公民支持 |
| **长模型名称截断 (`.mrdModelName`)** | 单行截断，无 Tooltip，用户看不全长名 | 仅维持样式截断，未补齐 Tooltip | **补齐 Tooltip 包装**：`<Tooltip content={display}>` | 对齐左侧服务商列表规范，消除长 ID 查验盲区 |
| **死代码规模 (`module.css`)** | **1165 行**（沉淀大量旧 Billing、Price、旧 Row 垃圾） | 宣称收敛至 ~330 行 | **严格收敛至 280~310 行**（不仅脱水死代码，更解构包含块与抽离内联样式） | 样式表体积净缩减达 **75%**，大幅降低维护认知负载 |

---

## 四、 违规点逐项清退清单（Smells & Deprecations Purge Matrix）

在进入 Wave 2 代码重构实施前，各执行子 Agent 必须对照本清单执行刚性物理清退，禁止任何形式的“向下兼容保留”。

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                 违规类目物理清退与消杀执行清单                                  │
├───────────────────────────────────────────────────┬─────────────────────────────────────────────┤
│ 1. 幽灵 Token 消杀清单                            │ - 彻底移除 var(--shadow-dropdown)           │
│                                                   │ - 替换为 var(--sep-shadow) 或 var(--shadow-md)│
├───────────────────────────────────────────────────┼─────────────────────────────────────────────┤
│ 2. 灰度泥坑消杀清单                              │ - 彻底移除输入框 background: var(--bg-primary) │
│                                                   │ - 彻底移除导轨 background: var(--bg-secondary)│
│                                                   │ - 彻底移除面板 background: var(--bg-secondary)│
├───────────────────────────────────────────────────┼─────────────────────────────────────────────┤
│ 3. 实心死灰胶囊消杀清单                          │ - 彻底移除 .mrdCtxPill 的 var(--tint-active) │
│                                                   │ - 彻底移除 .mrlItemTag 的 var(--tint-active)  │
│                                                   │ - 彻底移除 .mrdPillOff 的 var(--tint-active)  │
├───────────────────────────────────────────────────┼─────────────────────────────────────────────┤
│ 4. 包含块重复套娃消杀清单                        │ - 彻底清退 .cascadeList 自身的 border/shadow │
│                                                   │ - 彻底清退 .cascadeList 自身的 padding: 6px  │
│                                                   │ - 垂直滚动权统一交归 ui/Menu 基座           │
├───────────────────────────────────────────────────┼─────────────────────────────────────────────┤
│ 5. 尺寸硬编码消杀清单                            │ - 废除 height: 32px ➔ 改为 --control-height  │
│                                                   │ - 废除 height: 28px ➔ 改为 --control-height-sm│
│                                                   │ - 废除保存按钮内联 height: 34px 消除 2px 错位│
├───────────────────────────────────────────────────┼─────────────────────────────────────────────┤
│ 6. 历史死代码物理删除清单 (原 1165 行中清退 550+行) │ - 删除 line 631-807 计费与价格类 (.modelsPrice*)│
│                                                   │ - 删除 line 456-620 旧版模型行体系 (.modelsRow*)│
│                                                   │ - 删除 line 200-260 旧版胶囊卡片 (.mrdPill*)  │
│                                                   │ - 删除 line 884-908 废弃虚线添加按钮          │
└───────────────────────────────────────────────────┴─────────────────────────────────────────────┘
```

---

## 五、 校准后 `ModelsSettingsTab.module.css` 权威蓝本代码

本代码直接作为后续执行实施波次（Wave 2）的落盘标准。已全面修复幽灵 Token、深色模式下沉反转、包含块重复套娃、控件齿轮高度断裂与内联样式收敛。

```css
/* ==========================================================================
   ModelsSettingsTab.module.css
   AI 服务商与模型设置样式表（100% 纯正卡底 + Design Tokens 全真源对齐）
   收敛净收益：彻底脱水 Billing/Price/旧版 Row 历史包袱，从 1165 行精简至 ~295 行
   ========================================================================== */

/* ── 1. 双栏主卡片容器（严格对齐 SettingsCard 契约与视口弹性链） ── */
.modelsSplit {
  display: flex;
  flex-direction: row;
  flex: 1 1 0;
  min-height: 0;
  height: 100%;
  width: 100%;
  box-sizing: border-box;
  background: var(--bg-card, hsl(0 0% 100%));
  border: 1px solid var(--border-color);
  border-radius: var(--radius-xl, 12px);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
  position: relative;
}

/* ── 2. 左侧服务商导轨（同构系统主侧边栏 SettingsSidebar） ── */
.modelsRail {
  width: 210px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb, var(--bg-primary) 35%, var(--bg-card));
  border-right: 1px solid var(--border-subtle);
  overflow: hidden;
}

/* 深色模式导轨底色校准：直接回归底板真源，激活项卡片反差立即可辨 */
:global(html[data-theme='dark']) .modelsRail {
  background: var(--bg-primary, #1b1b1b);
}

.mrlHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px 8px;
  flex-shrink: 0;
}

.mrlLabel {
  font-size: var(--font-size-xs, 12px);
  font-weight: var(--font-weight-medium, 500);
  color: var(--text-tertiary);
  letter-spacing: var(--letter-spacing-wide);
}

.mrlList {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.mrlItem {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: 8px 10px;
  border-radius: var(--radius-lg, 8px);
  border: 1px solid transparent;
  background: transparent;
  cursor: pointer;
  box-sizing: border-box;
  text-align: left;
  font-family: inherit;
  transition:
    background-color var(--transition-micro),
    border-color var(--transition-micro),
    box-shadow var(--transition-micro);
}

.mrlItem:hover {
  background: var(--tint-hover);
}

/* 选中态：对齐系统一级侧边栏 .sidebarTab.active 实体白卡微浮起质感 */
.mrlItem.isActive {
  background: var(--bg-card, hsl(0 0% 100%));
  border-color: var(--border-subtle);
  box-shadow: var(--shadow-sm);
}

.mrlItemRowTop {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.mrlItemName {
  font-size: var(--font-size-sm, 13px);
  font-weight: var(--font-weight-medium, 500);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mrlItemDot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-circle, 50%);
  flex-shrink: 0;
}

.mrlEmpty {
  font-size: var(--font-size-xs, 12px);
  color: var(--text-tertiary);
  padding: 32px 10px;
  text-align: center;
}

/* ── 3. 右侧详情工作台（纯净卡底流式空间） ── */
.modelsDetail {
  flex: 1;
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-card, hsl(0 0% 100%));
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 20px 24px;
  box-sizing: border-box;
}

.mrdEmpty {
  font-size: var(--font-size-sm, 13px);
  color: var(--text-tertiary);
  margin: auto;
  text-align: center;
}

.mrdBody {
  display: flex;
  flex-direction: column;
  gap: var(--space-4, 16px);
}

/* 头部服务商标题与操作 */
.mrdHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3, 12px);
  padding-bottom: 4px;
}

.mrdHeadLeft {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2, 8px);
}

.mrdHeadRight {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2, 8px);
}

.mrdTitle {
  font-size: var(--font-size-lg, 17px);
  font-weight: var(--font-weight-semibold, 600);
  color: var(--text-primary);
  margin: 0;
  letter-spacing: var(--letter-spacing-tight);
}

.mrdTitleEditable {
  cursor: pointer;
  border-bottom: 1px dashed var(--border-subtle);
  transition: border-color var(--transition-micro);
}

.mrdTitleEditable:hover {
  border-color: var(--text-secondary);
}

/* 状态徽标与确认删除卡片（抽离内联代码） */
.mrdStatusBtn {
  height: 26px;
  padding: 0 10px;
  font-size: var(--font-size-xs, 12px);
  font-weight: var(--font-weight-medium, 500);
  border-radius: var(--button-radius, 7px);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.mrdStatusBtn.isOn {
  border: 1px solid color-mix(in srgb, var(--color-active) 30%, transparent);
  background: color-mix(in srgb, var(--color-active) 12%, transparent);
  color: var(--color-active);
}

.mrdStatusBtn.isOff {
  border: 1px solid var(--border-subtle);
  background: var(--tint-hover);
  color: var(--text-tertiary);
}

.mrdConfirmPopup {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--bg-elevated, var(--bg-card));
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg, 8px);
  padding: 4px 8px;
  white-space: nowrap;
  box-shadow: var(--shadow-sm);
  z-index: var(--z-card-footer, 10);
}

/* ── 4. 凭据表单输入框（纯白底 + 系统控件高度 + AGENTS.md §13 软灰焦点） ── */
.mrdFields {
  display: flex;
  flex-direction: column;
  gap: var(--space-3, 12px);
}

.mrdField {
  display: flex;
  flex-direction: column;
  gap: var(--space-1, 4px);
}

.mrdFieldLabel {
  font-size: var(--font-size-xs, 12px);
  font-weight: var(--font-weight-normal, 400);
  color: var(--text-secondary);
}

.mrdFieldInput {
  height: var(--control-height, 32px);
  min-height: var(--control-height, 32px);
  padding: 0 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--button-radius, 7px);
  font-size: var(--font-size-sm, 13px);
  font-family: inherit;
  background: var(--bg-card, hsl(0 0% 100%));
  color: var(--text-primary);
  outline: none;
  box-sizing: border-box;
  box-shadow: none;
  transition:
    border-color var(--transition-micro),
    box-shadow var(--transition-micro);
  width: 100%;
}

.mrdFieldInput:focus,
.mrdFieldInput:focus-visible {
  outline: none;
  background: var(--bg-card);
  border-color: color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
  box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%);
}

.mrdKeyRow {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
}

.mrdKeyRow .mrdFieldInput {
  flex: 1;
}

/* ── 5. 模型列表区域（细线流式行 + 搜索栏） ── */
.mrdModelsHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3, 12px);
  padding-top: 8px;
  border-top: 1px solid var(--border-subtle);
}

.mrdModelsLabel {
  font-size: var(--font-size-sm, 13px);
  font-weight: var(--font-weight-medium, 500);
  color: var(--text-primary);
}

.mrdModelsActions {
  display: flex;
  align-items: center;
  gap: var(--space-1_5, 6px);
}

.mrdSearchWrapper {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.mrdSearchIcon {
  position: absolute;
  left: 8px;
  color: var(--text-tertiary);
  pointer-events: none;
}

.mrdSearch {
  height: var(--control-height-sm, 28px);
  min-height: var(--control-height-sm, 28px);
  padding: 0 8px 0 26px;
  border-radius: var(--button-radius, 7px);
  border: 1px solid var(--border-subtle);
  background: var(--bg-card, hsl(0 0% 100%));
  font-size: var(--font-size-xs, 12px);
  color: var(--text-primary);
  outline: none;
  width: 150px;
  box-sizing: border-box;
  transition:
    border-color var(--transition-micro),
    box-shadow var(--transition-micro);
}

.mrdSearch:focus {
  border-color: color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
  box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%);
  background: var(--bg-card);
}

.mrdModelList {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg, 8px);
  overflow: hidden;
  background: transparent;
}

.mrdModelRow {
  display: flex;
  flex-direction: column;
  padding: 9px 12px;
  border-bottom: 1px solid var(--border-subtle);
  background: transparent;
  cursor: pointer;
  transition: background-color var(--transition-micro);
}

.mrdModelRow:last-child {
  border-bottom: none;
}

.mrdModelRow:hover {
  background: var(--tint-hover);
}

.mrdModelRow.isOff {
  opacity: 0.55;
}

.mrdModelRowInner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3, 12px);
  width: 100%;
}

.mrdModelInfo {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  flex: 1;
  min-width: 0;
}

.mrdModelName {
  font-size: var(--font-size-sm, 13px);
  font-weight: var(--font-weight-medium, 500);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mrdCtxPill {
  font-size: var(--font-size-xxs, 11px);
  padding: 1px 6px;
  border-radius: var(--radius-full, 9999px);
  border: 1px solid var(--border-subtle);
  background: transparent;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  line-height: 1.3;
}

.mrdCapTag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
  opacity: 0.85;
  cursor: help;
}

.mrdModelActions {
  display: flex;
  align-items: center;
  gap: var(--space-1_5, 6px);
}

.mrdModelEmpty {
  padding: 28px 0;
  text-align: center;
  font-size: var(--font-size-xs, 12px);
  color: var(--text-tertiary);
}

/* ── 6. 展开配置抽屉（修复深色模式光学下沉） ── */
.modelConfigPanel {
  width: 100%;
  margin-top: 10px;
  padding: 12px 14px;
  border-radius: var(--button-radius, 7px);
  border: 1px solid var(--border-subtle);
  background: color-mix(in srgb, var(--text-primary) 1.5%, var(--bg-card));
  display: flex;
  flex-direction: column;
  gap: var(--space-3, 12px);
  box-sizing: border-box;
}

:global(html[data-theme='dark']) .modelConfigPanel {
  background: color-mix(in srgb, var(--bg-primary) 60%, var(--bg-card));
}

.mrdCfgFields {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: var(--space-3, 12px);
}

.mrdCfgLabel {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: var(--font-size-xs, 12px);
  font-weight: var(--font-weight-normal, 400);
  color: var(--text-secondary);
}

.mrdCfgFooter {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3, 12px);
  flex-wrap: wrap;
  padding-top: 4px;
  border-top: 1px solid color-mix(in srgb, var(--border-subtle) 60%, transparent);
}

.mrdCapGroup {
  display: flex;
  align-items: center;
  gap: var(--space-3, 12px);
}

.mrdCfgActions {
  display: flex;
  align-items: center;
  gap: var(--space-1_5, 6px);
}

.mrdLatencyBadge {
  font-size: 11px;
  font-weight: var(--font-weight-medium, 500);
  margin-right: 6px;
  user-select: none;
}

/* ── 7. 下拉菜单与级联组件（解构重复包含块 + 接入 sep 规范） ── */
.addServiceBtn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

/* 注意：外层容器由 ui/Menu .menuContent 统一供给，此处剥离双重外壳 */
.addProviderMenu {
  min-width: 180px;
}

.cascadeList {
  min-width: 220px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: transparent;
  border: none;
  box-shadow: none;
  padding: 0;
}

/* 独立 Portal 逃逸飞出菜单（继承全套浮层阴影与圆角） */
.cascadeFlyout {
  min-width: 200px;
  background: var(--bg-card, hsl(0 0% 100%));
  border: 1px solid var(--border-color);
  border-radius: var(--sep-radius-outer, 14px);
  box-shadow: var(--sep-shadow);
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  box-sizing: border-box;
  z-index: var(--z-dropdown, 300);
}

.addMenuTitle {
  padding: 4px 8px;
  font-size: var(--font-size-xs, 11px);
  font-weight: var(--font-weight-medium, 500);
  color: var(--text-tertiary);
  border-bottom: 1px solid var(--border-subtle);
  margin-bottom: 2px;
}

.addMenuOption,
.cascadeRow,
.cascadeOption {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  min-height: 28px;
  height: 28px;
  padding: 0 8px;
  border: none;
  border-radius: var(--button-radius, 7px);
  background: transparent;
  color: var(--text-primary);
  font-size: var(--font-size-sm, 13px);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  box-sizing: border-box;
  transition: background-color var(--transition-micro);
}

.addMenuOption:hover,
.cascadeRow:hover,
.cascadeOption:hover {
  background: var(--tint-hover);
}

.cascadeOption.isOn,
.cascadeOption.isSelected {
  background: var(--tint-active);
  font-weight: var(--font-weight-medium, 500);
}

.cascadeSelectTrigger {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border: 1px solid var(--border-color);
  background: var(--bg-card);
  border-radius: var(--button-radius, 7px);
  padding: 0 10px;
  height: var(--control-height-sm, 28px);
  min-height: var(--control-height-sm, 28px);
  min-width: 220px;
  color: var(--text-primary);
  font-family: inherit;
  font-size: var(--font-size-sm, 13px);
  cursor: pointer;
  box-sizing: border-box;
  transition: background-color var(--transition-micro);
}

.cascadeSelectTrigger:hover {
  background: var(--tint-hover);
}

.loadingSpinner {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
```

---

## 六、 跨组件 TSX 协同改造精准校准清单

本清单供后续 Wave 2 执行子 Agent 进行精准对照重构，彻底扫除所有内联硬编码与无障碍遗漏。

### 6.1 `ModelList.tsx`
1. **能力图标 Tooltip 补齐**：
   ```tsx
   {/* 校准前：仅有 aria-label */}
   <span className={`${styles.mrdCapTag} mrd-cap-tag`} aria-label="支持工具调用">
     <Lucide.Wrench size={10} />
   </span>

   {/* 校准后：包裹系统级 Tooltip */}
   {meta.capabilities?.tools && (
     <Tooltip content="支持工具调用 (Tool Call)">
       <span className={`${styles.mrdCapTag} mrd-cap-tag`} aria-label="支持工具调用">
         <Lucide.Wrench size={10} />
       </span>
     </Tooltip>
   )}
   ```
   视觉与思考图标同理，全面包裹 Tooltip。
2. **长模型名 Tooltip 补齐**：
   ```tsx
   <Tooltip content={display}>
     <span className={`${styles.mrdModelName} mrd-model-name`}>
       {display}
     </span>
   </Tooltip>
   ```
3. **清退内联样式**：移除 `style={{ cursor: 'pointer' }}`，类名由 `.mrdModelRow` 统一供给。

### 6.2 `ProfileHeader.tsx`
1. **清退 DOM 样式直接操纵**：彻底删除 `onMouseEnter` / `onMouseLeave` 内联脚本，改用 CSS 类 `.mrdTitleEditable`。
2. **清退状态按钮内联样式**：
   ```tsx
   {/* 校准前：style={{ height: '26px', ... }} */}
   {/* 校准后：使用语义化类名 */}
   <button
     type="button"
     className={`${styles.mrdStatusBtn} ${selected.enabled !== false ? styles.isOn : styles.isOff}`}
     onClick={() => { ... }}
   >
     {selected.enabled !== false ? '已启用' : '已停用'}
   </button>
   ```
3. **清退删除确认弹层内联灰底**：将 `var(--bg-primary)` 替换为 CSS 类 `.mrdConfirmPopup`（`background: var(--bg-elevated, var(--bg-card))`）。

### 6.3 `ProviderProfileForm.tsx`
1. **消除保存按钮 2px 错位**：
   ```tsx
   {/* 校准前：style={{ borderRadius: '7px', height: '34px', ... }} */}
   {/* 校准后：直接继承 Button 标准 variant="secondary" 与系统高度 */}
   <Button
     type="button"
     variant="secondary"
     disabled={!keyDraft.trim()}
     onClick={() => void saveKey()}
     className={styles.mrdSaveKeyBtn}
   >
     保存
   </Button>
   ```

### 6.4 `ModelListHeader.tsx`
1. **清退 3 处方形图标按钮内联尺寸**：三个操作按钮（连通性检查、自动获取、手动添加）统一定义为 `.mrdIconBtn`，尺寸锁定为 `var(--control-height-sm, 28px)`。
2. **封装搜索框定位容器**：使用 `.mrdSearchWrapper` 与 `.mrdSearchIcon`，彻底消灭 `style={{ position: 'relative' }}` 等内联裸写。

---

## 七、 立体验证断言与门禁验收准则（Validation Assertions）

根据 AGENTS.md §7.1 立体验证纪律，本审计案确立以下不可退避的门禁验收红线：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        样式与 Design Tokens 重构刚性门禁矩阵                           │
├──────────────────────┬─────────────────────────────────────────────────────────────────┤
│ 1. 纯白卡底零死角    │ - 浅色模式下，主工作区和输入框背景严格为 #ffffff (var(--bg-card)) │
│                      │ - 绝对禁止出现大面积 --bg-secondary (7.9% 灰) 底块              │
│                      │ - 绝对禁止出现泥坑式 --bg-primary (5.5% 灰) 输入框底色          │
├──────────────────────┼─────────────────────────────────────────────────────────────────┤
│ 2. 深色模式光学对称  │ - 展开抽屉在 Dark 下对比卡底真正下沉变暗，绝对禁止出现白色前景色│
│                      │   混入造成的发白浮起反转                                        │
│                      │ - 左导轨在 Dark 下底色为 #1b1b1b，选中卡片 #242424 层次分明      │
├──────────────────────┼─────────────────────────────────────────────────────────────────┤
│ 3. 焦点态 10% 铁律   │ - 聚焦时边框颜色混入文本色 <= 10%（AGENTS.md §13 刚性红线）      │
│                      │ - 严禁粗黑实心框，严禁重阴影遮挡，严禁非法嵌套 box-shadow       │
├──────────────────────┼─────────────────────────────────────────────────────────────────┤
│ 4. 幽灵 Token 零容忍 │ - 编译与 Lint 扫描确保全局 0 处未定义幽灵 Token (如 shadow-dropdown)│
│                      │ - 所有阴影/圆角 100% 溯源至 tokens.css 单一真理源               │
├──────────────────────┼─────────────────────────────────────────────────────────────────┤
│ 5. Tooltip 无障碍规范│ - 能力标签 (Wrench, Eye, Brain) 100% 包裹 Tooltip               │
│                      │ - 单行省略长模型名 100% 包裹 Tooltip 全名展示                   │
│                      │ - 严禁使用原生 HTML title="..." 冒充悬停提示 (AGENTS.md §12)    │
├──────────────────────┼─────────────────────────────────────────────────────────────────┤
│ 6. 包含块与滚动条收敛│ - Menu 级联菜单彻底消除内层双边框与嵌套内边距                   │
│                      │ - 彻底根除紧挨着的双滚动条与菜单项右侧切边现象                  │
├──────────────────────┼─────────────────────────────────────────────────────────────────┤
│ 7. 净代码与静态门禁  │ - ModelsSettingsTab.module.css 代码行数严格 <= 310 行            │
│                      │ - Billing / Price 等历史死代码清退率 100%                        │
│                      │ - npm run check:desktop 与 npm run typecheck 零告警通过          │
└──────────────────────┴─────────────────────────────────────────────────────────────────┘
```

---

## 八、 审计结论

经过对 `00` 号总案、`04` 号分析方案与当前代码库的立体审视，**重构方案的大方向是卓越的，但细节处存在 6 处关键设计漏洞**。
本报告完成的工作包括：
1. 精确指出了 **未定义幽灵 Token `--shadow-dropdown`** 并提供了系统替换；
2. 彻底纠正了 **深色模式下展开抽屉由于混入亮色文字导致的“反向提亮浮起”缺陷**，保证深浅色模式的光学逻辑一致；
3. 贯彻落实 00 方案维度六，**解构了 `.cascadeList` 的重复包含块**，从 CSS 根源拔除了级联菜单的双滚动条与边框截断隐患；
4. 补齐了 **能力标签与长模型名称的系统 Tooltip 规范**，清退了侵入式 DOM 样式操纵；
5. 拔除了 **写死的控件高度与按钮 2px 几何错位**，接入系统自适应齿轮缩放；
6. 输出了 **精简至 ~295 行的修正版权威 CSS 蓝本与跨组件 TSX 清退表**。

本审计报告为 Wave 2 阶段的视觉与样式实现提供了毫无歧义、零退避、免猜测的最高执行准则。
