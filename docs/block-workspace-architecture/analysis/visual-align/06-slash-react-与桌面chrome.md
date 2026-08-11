# 06 · Slash React 浮层 × 桌面 chrome 挂载 · 视觉检查清单

| 字段         | 内容                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------- |
| **波次**     | 视觉对齐 **三期检查**（接 `04`/`05` 二期皮；不替代产品 e2e）                                   |
| **日期**     | 2026-08-12                                                                                     |
| **角色**     | 美学参考 Agent（清单 + 对照；**不**写产品逻辑大改）                                            |
| **对象**     | note-paper **React** slash 浮层（待挂）+ 桌面壳 **chrome 挂载后** 观感回归                     |
| **对齐标尺** | **主壳 token 优先**（`tokens.css` + `design-system` / `shell-menus` / chat `TiptapSlashMenu`） |
| **竞品**     | AFFiNE slash/drag-handle **完成度 / 节奏**参考；**禁止** fork `--affine-*` 色板                |
| **禁止**     | 视觉完成 = 关 EL；slash 皮 = A-BLK-02 全关；DomHost jsdom 绿 = 桌面 React 挂载完成             |

---

## 0. 硬纪律（与 `00` R1–R5 同向）

| #      | 纪律                                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------ |
| **R1** | 主壳 token 真源：`--bg-elevated` / `--shadow-lg` / `--dropdown-*` / `--item-*` / `--z-popover`；竞品只借尺寸感与静默策略 |
| **R2** | **≠ 关 EL-01 / EL-02 / A-BLK-02/04/05 / A-SIL 产品 e2e**；本清单只验收观感与双轨皮一致                                   |
| **R3** | chrome Model / 假数据 / DomHost 契约绿 **≠** Notion chrome / 桌面 React 挂载完成                                         |
| **R4** | React 浮层与 `.bp-*` DomHost **同族材质**（elevated + hairline + 中性 hover）；禁止两套色温                              |
| **R5** | 打开态才有浮层 DOM；默认 L0 **零常驻** slash/把手噪声（A-SIL 向）                                                        |

---

## 1. 结构真源（读清单前先分轨）

```
┌─ 包轨（结构 / 契约）────────────────────────────────────────────┐
│ packages/block-paper/src/chrome/                                 │
│   SlashMenuModel          open/filter/select → slash_insert      │
│   BlockChromeModel        HandleVisibility L0                    │
│   BlockChromeDomHost      data-bp-* DOM（jsdom 可测）            │
│   blockChrome.css         .bp-slash-host / .bp-drop-line / 把手  │
│   export: @crish/block-paper/chrome.css                          │
└──────────────────────────────────────────────────────────────────┘
┌─ 桌面壳（产品挂载）──────────────────────────────────────────────┐
│ apps/crish-desktop/.../note-paper/                               │
│   NotePaperPanel / Strict  import chrome.css（side-effect）      │
│   data-slash-open 属性（模型可测）                               │
│   .handle 六点皮（module.css；仍 pointer-events: none）          │
│   ★ 无 React slash catalog 浮层 DOM（本清单主缺口）              │
│   ★ 未挂 BlockChromeDomHost 为默认产品树（桌面 chrome 挂载缺口） │
└──────────────────────────────────────────────────────────────────┘
┌─ 主壳已有 slash 样本（材质标尺，≠ note 产品）───────────────────┐
│ chat-composer/TiptapSlashMenu(.module.css)                       │
│   elevated + hairline；z=--z-popover；宽 256；无 box-shadow 红线 │
│ shell-menus .panel-dropdown / .dropdown-item                     │
│   elevated + shadow-lg；item-padding；bg-hover                   │
│ design-system [data-panel]                                       │
│   elevated + radius-lg + shadow-lg                               │
└──────────────────────────────────────────────────────────────────┘
```

| 层                       | 已有（2026-08-12 读盘）                                                               | 缺（观感）                                                   |
| ------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| DomHost + `chrome.css`   | `.bp-slash-host` 最小皮；group/item class；落点 2px；把手热区 min `control-height-xs` | 产品树未默认挂载；catalog 子节点由调用方填                   |
| React note-paper         | `SlashMenuModel` 实例 + `data-slash-open`；`import chrome.css`；块行 module 皮        | **无** portal/绝对定位 slash 列表；无 group/item React 节点  |
| chat `TiptapSlashMenu`   | 完整 Radix Popover 皮 + 键盘漫游（对话域）                                            | **不可**整搬进 note-paper 宣称块 slash 完成；仅材质/密度参照 |
| AFFiNE slash-menu styles | 宽 280、分组 xs、图标 28、overlay 阴影                                                | 色板/变量名不进本仓                                          |

**诚实句（钉死）**

- `chrome.css` 导入 **≠** 用户在纸面里看到 slash 菜单。
- DomHost `w3f_dom_slash_host` 绿 **≠** 桌面 React chrome 挂载。
- 本清单勾完 **≠** 关 EL；须在 PR/记录明示。

---

## 2. 对照总表（主壳 × AFFiNE × 本仓目标）

### 2.1 Slash 浮层材质

| 维度        | 主壳样本（优先）                                                             | AFFiNE 节奏（只借） | note-paper 目标映射                                                                             | 检查勾 |
| ----------- | ---------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------- | ------ |
| 容器宽      | chat slash **256**；shell dropdown **220**（场景不同）                       | **280** 固定        | 块 slash 用 **`min(280px, 100%)`**（与 `04` S1 / `.bp-slash-host` 一致）                        | ☐      |
| 表面        | `--bg-elevated`                                                              | overlay 白/主题     | **仅** elevated；禁裸 `#fff` / 竞品蓝紫底                                                       | ☐      |
| 边框        | hairline / `border-color`                                                    | 主题 border         | `var(--hairline-width) solid var(--hairline)`                                                   | ☐      |
| 阴影        | shell dropdown / `[data-panel]` → **`--shadow-lg`**；chat slash **刻意无影** | overlayPanelShadow  | **块 slash 跟面板族用 shadow-lg**（与 `.bp-slash-host` 已写）；勿与 chat 红线混绑               | ☐      |
| 圆角        | panel `radius-lg`；chat `radius-md`；dropdown 可 `radius-2xl`                | ~8                  | **`--radius-lg`**（与 chrome.css 一致）                                                         | ☐      |
| 内边距      | `--dropdown-padding` / chat `space-1`                                        | 8 4 8 8 量级        | **`--dropdown-padding`** + 列 `gap: --dropdown-gap`                                             | ☐      |
| 分组标题    | （chat 少分组）                                                              | xs + 次级色         | `--font-size-xs` + `--text-tertiary`；class 对齐 `.bp-slash-group-label`                        | ☐      |
| 项密度      | `--item-padding` / chat `space-1×2`；hover `--tint-active` 或 `--bg-hover`   | 图标 28 + 标题/描述 | padding=`--item-padding`；radius=`--item-radius`；hover=`--bg-hover`（**禁** accent-blue 整行） | ☐      |
| 图标盒      | chat 28×28 + `--bg-subtle`                                                   | 28×28 border        | `--control-height-sm`（28）+ hairline 边（`.bp-slash-item-icon`）                               | ☐      |
| 描述行      | chat `--font-size-micro` + tertiary                                          | 次级描述            | xs/micro + `--text-secondary` 或 tertiary                                                       | ☐      |
| z 层        | **`var(--z-popover)`**（200）；dropdown 更高阶另议                           | popover             | **禁止**裸 `9999`；与 chrome.css 一致 `--z-popover`                                             | ☐      |
| 打开/关闭   | Radix Portal；hidden 不占布局                                                | widget 显隐         | `data-slash-open=0` / `[hidden]` → `display:none`；**默认不可见**                               | ☐      |
| 动效        | chat：仅 opacity 入场；eco 停转                                              | 主题动画            | 可用 `--transition-micro` 或 opacity；**eco** 无过渡                                            | ☐      |
| 键盘 active | `aria-selected` / active class                                               | hover-color         | `data-active='1'` 与 `SlashMenuModel` activeIndex 同步（皮认属性）                              | ☐      |

**主壳证据**

- `apps/crish-desktop/src/styles/tokens.css`（elevated / shadow-lg / dropdown-* / item-*）
- `apps/crish-desktop/src/styles/z-index.css:17`（`--z-popover: 200`）
- `apps/crish-desktop/src/styles/design-system.css:61-65`（`[data-panel]`）
- `apps/crish-desktop/src/styles/shell/shell-menus.css:3-15,64-80`（dropdown 族）
- `apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.module.css`（对话 slash 样本）

**包轨证据**

- `packages/block-paper/src/chrome/blockChrome.css:168-244`（`.bp-slash-host` / group / item）
- `packages/block-paper/src/chrome/SlashMenuModel.ts`（DEFAULT_SLASH_CATALOG · snapshot.items）
- `packages/block-paper/src/chrome/BlockChromeDomHost.ts:111-112,216+`（`BP_SLASH_HOST` / open 属性）

### 2.2 桌面 chrome 挂载后（把手 / 落点 / 多选 / 行）

| 维度       | 目标（主壳 token）                                          | AFFiNE/AppFlowy 节奏          | 当前 React 壳                                      | 挂载后检查                     |
| ---------- | ----------------------------------------------------------- | ----------------------------- | -------------------------------------------------- | ------------------------------ |
| 静默 L0    | 非 hover/focus/multi：**opacity 0** 把手；无常驻菜单条      | 按需 grabber / option         | 已对齐 data-handle 显隐                            | ☐ 无常驻噪声                   |
| 把手形态   | 六点 / 细条；色 `--text-tertiary`；hover 行 0.45、multi 0.7 | grabber 4px / dots；option 44 | module `.handle` + DomHost `.bp-block-handle` 双轨 | ☐ 双轨同 opacity 语义          |
| 把手热区   | min 高 `--control-height-xs`；宽 ≥ icon + pad               | 可点 widget                   | DomHost 已扩；**React 仍 `pointer-events: none`**  | ☐ 产品可点后仍 L0              |
| 落点线     | 2px；`color-mix(text-primary 28–35%)`；pointer-events none  | 细指示 / visual_drag_area     | DomHost+css 有；React 壳未画                       | ☐ before/after 可辨、dark 可读 |
| 多选框     | `--icon-size-sm`；accent 用 secondary 中性，勿亮品牌        | 框选/多节点                   | DomHost `.bp-multi-check`                          | ☐ 非 multi 不抢纸面            |
| 块 hover   | `--bg-hover` / `--tint-hover`（4%）                         | affine-hover-color            | module + `.bp-block-row` 已有                      | ☐ 无高饱和蓝底                 |
| focus      | `--bg-active` + **中性** hairline inset                     | 选区叠加                      | module 已中性                                      | ☐ 勿回 accent-blue 描边        |
| code/quote | `--md-code-*`；quote 左 2px `--hairline-strong`             | 主题 code/quote               | module 已有；DomHost 有 data-flavour 时 css 轻量   | ☐ 与 chat-md 同族              |
| 阅读列     | `--note-paper-col-max` / chat-col；左 gutter space-6        | editor-width / option gutter  | 一期已落地                                         | ☐ 挂载后不被 chrome 挤碎列宽   |
| 一体感     | 嵌 shell inset 工作区；纸面 `--bg-card`                     | 独立皮肤岛 **禁止**           | 面板 token 已贴壳                                  | ☐ 无 AFFiNE 岛感               |

---

## 3. Slash React 浮层 · 视觉检查清单（挂载时逐条）

> 实现可挂：Portal 到 body / 锚点 absolute 于锚块；**皮**优先复用 `.bp-slash-*` 类名或与其 **同 token 公式** 的 module class，避免第三套色。

### 3.1 打开前（L0）

| #    | 检查项   | 通过条件                                     |
| ---- | -------- | -------------------------------------------- |
| L0-1 | 默认 DOM | 无可见菜单；或宿主 `[hidden]` / `open=0`     |
| L0-2 | 面板属性 | `data-slash-open` 与模型 `isOpen()` 一致为假 |
| L0-3 | 纸面噪声 | 无半透明空壳、无占位阴影块                   |
| L0-4 | 键盘焦点 | 未 open 时 Tab 路径不被隐形菜单截获          |

### 3.2 打开态容器

| #    | 检查项     | 通过条件                                                                 |
| ---- | ---------- | ------------------------------------------------------------------------ |
| O-1  | 宽         | `width: min(280px, 100%)`（或 `--bp-slash-width` / `--np-slash-width`）  |
| O-2  | 背景       | 仅 `var(--bg-elevated)`                                                  |
| O-3  | 边 + 圆角  | hairline + `--radius-lg`                                                 |
| O-4  | 阴影       | `var(--shadow-lg)`（与 shell 下拉同族；**勿**仿 AFFiNE 彩影）            |
| O-5  | z          | `var(--z-popover)` 或文档约定的壳阶；**无**裸 9999                       |
| O-6  | 最大高     | `max-height: min(360px, 70vh)` 量级可滚动；不撑破视口                    |
| O-7  | light/dark | 只消费 token；切换主题无写死 hex 残留                                    |
| O-8  | 密度档     | `data-ui-size` 下 item-padding/dropdown-padding 跟着变，不写死 32px 行高 |
| O-9  | 定位       | 锚在触发块附近；不裁切在 `overflow:hidden` 父级内（Portal 优先）         |
| O-10 | 与纸面层级 | 浮于 `.readingColumn` 之上，不改变块列表布局流（absolute/fixed/portal）  |

### 3.3 分组与项

| #   | 检查项            | 通过条件                                                                |
| --- | ----------------- | ----------------------------------------------------------------------- |
| I-1 | 数据源            | 渲染 `SlashMenuModel.getSnapshot().items`（id/title/description/group） |
| I-2 | 分组标签          | xs + tertiary；水平 pad space-2；**非** accent 色标题                   |
| I-3 | 项 hover / active | `--bg-hover` 或 `--tint-hover`；**禁止** accent-blue 整行底             |
| I-4 | 图标盒            | control-height-sm；hairline；bg-secondary/subtle                        |
| I-5 | 标题/描述         | 主色 title；次级 desc；ellipsis 不撑破宽度                              |
| I-6 | 空过滤            | 无匹配时 tertiary 空态文案（可对标 chat emptyMessage 语气）             |
| I-7 | 过滤后高亮        | activeIndex 重置/钳位后 `data-active` 仍合法，无「幽灵高亮」            |

### 3.4 与主壳一体（防「外来岛」）

| #   | 检查项                   | 通过条件                                                                   |
| --- | ------------------------ | -------------------------------------------------------------------------- |
| U-1 | 字族                     | `--font-sans`；图标可 mono/svg，正文不另起 Google Fonts                    |
| U-2 | 与 shell dropdown 同温   | 同 elevated + hairline 语言；不是纯白 Material 卡                          |
| U-3 | 与 chat slash 差异可解释 | 宽 280 vs 256、有 shadow-lg vs chat 无影——**文档写明域不同**即可，勿混红线 |
| U-4 | 无竞品变量               | 样式表无 `--affine-*` / 裸品牌蓝紫                                         |

### 3.5 关闭与静默

| #   | 检查项                                 | 通过条件                                                   |
| --- | -------------------------------------- | ---------------------------------------------------------- |
| C-1 | Escape / 选中后 / 失焦策略（产品定）后 | 浮层消失；`data-slash-open=false`                          |
| C-2 | 关闭后纸面                             | 焦点/选区策略不因**皮**强制整树闪白（真 IME/选区归引擎轨） |
| C-3 | 不残留                                 | 无透明挡点击层、无 0 尺寸仍 `pointer-events:auto` 的幽灵   |

---

## 4. 桌面 chrome 挂载 · 视觉检查清单

> 「挂载」= 产品默认树出现 DomHost 节点 **或** React 等价投影（把手可点 / 落点线 / 多选 / slash 宿主）且消费 `chrome.css` 或同 token 公式。

### 4.1 挂载接线观感

| #   | 检查项   | 通过条件                                                                                                    |
| --- | -------- | ----------------------------------------------------------------------------------------------------------- |
| M-1 | 皮加载   | 产品入口仍 `import '@crish/block-paper/chrome.css'` 或等价全局一次注入                                      |
| M-2 | 根作用域 | 存在 `.bp-chrome-root` **或** React 根提供同等 CSS 变量别名                                                 |
| M-3 | 双轨类名 | 若 React 自绘，优先挂 `bp-slash-host` / `bp-drop-line` / `bp-block-handle`，或 module 类 **token 公式 1:1** |
| M-4 | 契约属性 | `data-handle-visibility` / `data-slash-open` / `data-drop-side` 与 model 同步                               |
| M-5 | 假数据轨 | Skeleton 与 Strict **同一套** chrome 皮；badge 可区分轨，色不分化                                           |

### 4.2 静默与热区（A-SIL 观感向）

| #   | 检查项                             | 通过条件                                                             |
| --- | ---------------------------------- | -------------------------------------------------------------------- |
| S-1 | 默认                               | 截图/DOM：无常驻把手、无常驻 `+` 条（除非产品明确改 L0——须改效果锁） |
| S-2 | hover 行                           | 仅该行把手抬到 ~0.45；邻行仍隐                                       |
| S-3 | multi                              | multi 行 tint-strong + 把手 ~0.7；检查框可见但不刺眼                 |
| S-4 | hidden 行                          | 把手 `pointer-events: none` 或不拦截正文选区                         |
| S-5 | 可点热区                           | 去掉装饰-only `none`（hidden 除外）；min 热区 `control-height-xs`    |
| S-6 | **禁止**常驻半透明「可发现性」优化 | 不把默认 opacity 调到 0.3「好看」                                    |

### 4.3 落点 / 拖影（呈现向）

| #   | 检查项       | 通过条件                                                 |
| --- | ------------ | -------------------------------------------------------- |
| D-1 | 线厚/色      | 2px + text-primary ~28–35% mix；非 accent-blue           |
| D-2 | side         | before/after 各一帧正确；无双线闪烁                      |
| D-3 | 无目标       | drop-line hidden，不占布局                               |
| D-4 | 拖影（若挂） | ghost 低噪；**≠** 宣称 Move Intent / A-BLK 拖拽 e2e 完成 |

### 4.4 挂载后回归（纸面一期/二期不回退）

| #   | 检查项           | 通过条件                               |
| --- | ---------------- | -------------------------------------- |
| R-1 | 阅读列 max-width | 仍居中；左 gutter 不被把手列挤没       |
| R-2 | 标题字阶         | `data-heading-level` 映射仍在          |
| R-3 | flavour 默隐     | 非 debug 不显 uppercase 噪点           |
| R-4 | code/quote       | md-code / 左边条仍在                   |
| R-5 | light/dark + eco | 双主题可辨；eco 无过渡抖动             |
| R-6 | vitest           | note-paper / chrome.w3f* data 契约不破 |

---

## 5. 推荐接线（皮 · 非强制实现方案）

| 路径     | 做法                                                                                      | 适用                    |
| -------- | ----------------------------------------------------------------------------------------- | ----------------------- |
| **A 短** | React Portal 浮层 class 直接用 **`bp-slash-host` / `bp-slash-item`**（吃 chrome.css）     | 最快双轨同皮            |
| **B 中** | module.css 复制 **同 token 公式**（见 `04` S1–S2）；data 属性对齐 DomHost                 | 需 CSS Modules 作用域时 |
| **C 禁** | 在 block-paper 包写死竞品 hex；或 chat `TiptapSlashMenu` 整文件 copy 进 note 并改业务逻辑 | 破坏一体 / 域混淆       |

**z-index 选择备忘**

| 场景                      | 建议 token           | 说明                                    |
| ------------------------- | -------------------- | --------------------------------------- |
| 纸面内 slash / 轻 popover | `--z-popover` (200)  | 与 chrome.css、chat slash 一致          |
| 跨侧栏全局菜单            | `--z-dropdown` 等    | 仅当 slash 必须盖过侧栏时再升阶并文档化 |
| 禁止                      | 裸 `9999` / `100000` | 污染壳阶，难与 modal/toast 协调         |

**阴影策略备忘（主壳内部差异）**

- **块 slash / 设置下拉 / data-panel**：`--shadow-lg`（浮层「抬起」）。
- **对话 TiptapSlashMenu**：产品红线 **无 box-shadow**——属 chat 域；**不要**为「统一」删掉块 slash 阴影，也**不要**给 chat 强加 shadow-lg 而不改 chat 红线。
- 清单验收时按**域**勾，不强制像素级同一样式表。

---

## 6. 明确非目标

| 不做                                           | 原因                           |
| ---------------------------------------------- | ------------------------------ |
| 关 EL-01 / A-BLK-02 slash 产品 e2e             | 皮与清单 ≠ 交互完成            |
| 关 A-SIL 全表                                  | 模型/视觉分验收（plans/05 C3） |
| Fork AFFiNE slash 色板 / 蓝紫 item             | 破坏主壳一体                   |
| 真拖拽几何、多列落点、IME 全路径产品验收       | W3-F / A-BLK / A-IME 另轨      |
| 用 Skeleton 假数据 + 打开 slash 皮宣称打开完成 | 挂载 ≠ W1-H / Strict 产品链    |
| 删除 note-paper / chrome 测试                  | 测试资产铁律                   |

---

## 7. 三条最优先建议（下一棒）

> 主壳 token 优先；**≠ 关 EL**。

### P1 · 挂 React slash 浮层时 **直接吃 `.bp-slash-host` 族**（或 1:1 token）

- 宽 `min(280px,100%)`；`--bg-elevated` + `--shadow-lg` + `--radius-lg` + `--dropdown-padding`。
- 项：`--item-padding` / `--item-radius`；hover `--bg-hover`；图标盒 `--control-height-sm`。
- z：`--z-popover`。
- 打开态才挂可见 DOM；绑 `SlashMenuModel` snapshot，**勿**空壳常驻。
- **验收**：light/dark 下与 shell 下拉同温；无 `--affine-*`；`data-slash-open` 同步。

### P2 · 桌面 chrome 挂载后跑 **§4 全表**（静默 + 落点 + 双轨）

- 优先保证 L0：无常驻把手；hidden 不挡选区。
- 落点线 2px 中性 mix；与 `blockChrome.css` 一致。
- React `.handle` 若改为可点：去掉装饰-only `pointer-events: none`（hidden 除外），热区 min `--control-height-xs`——**仍** opacity 0 默认。
- **验收**：§4.2 + §4.4；相关 vitest 绿；记录写明 **≠ EL 关闭**。

### P3 · 以 chat `TiptapSlashMenu` 为 **材质锚**、以 AFFiNE 为 **节奏锚**，写清差异

- 材质锚：elevated、hairline、中性 hover、`--z-popover`、图标 28 盒。
- 节奏锚：块 slash 宽 280、可分组、可 shadow-lg（面板族）。
- 差异文档化（宽/阴影）避免实现 Agent 把 chat 红线误套到 note，或把 AFFiNE 色板搬进壳。
- **验收**：本文件 §2.1 / §5 阴影备忘被 PR 引用；无第三套魔法色。

---

## 8. 与索引 / 落地记录关系

| 文档                        | 关系                                                                 |
| --------------------------- | -------------------------------------------------------------------- |
| `00-索引.md`                | 挂本篇；优先建议可指向 §7                                            |
| `04-chrome-slash-drop-二期` | 皮规格 S1–S6 仍有效；本篇补 **React 挂载后检查表**                   |
| `05-chrome-落地记录`        | DomHost/css 已落部分；React 浮层挂载后 **另开段** 或新 `07` 落地记录 |
| `03-落地记录`               | 一期纸面；不因本清单改写历史                                         |
| `plans/05` C3 / A-SIL       | 模型 ≠ 视觉；本清单属视觉侧检查，不关 EL                             |

---

## 9. 修订

| 日期       | 说明                                                                |
| ---------- | ------------------------------------------------------------------- |
| 2026-08-12 | 初版：slash React 浮层 + 桌面 chrome 挂载视觉清单；主壳 token；≠ EL |
