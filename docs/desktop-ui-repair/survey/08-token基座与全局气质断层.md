# 08 · token 基座与全局气质断层

> 桌面界面一致性战役 · 调研子代理产出（只梳理，不改代码）。
> 维度：全局气质与基座。问题同权，不按 P0/P1 砍项。
> 对照：`docs/desktop-ui-repair/00-调研边界.md`、根 `AGENTS.md` §12–14、`docs/agent-roles/general_task/三原则.md`。
> 真机锚：侧栏原生滚动条、Tooltip 残影、权限+模型叠开、空叶「打开文件」、设置圆角满天飞。
> 用户锁：设置按钮圆角 = **7px**；点击果冻去掉；Hover 提示同时只能一个、鼠标过快则一个都不显示。

---

## 0. 做了什么 / 没做什么

**做了：** 通读 `tokens.css` / `design-system.css` / `style-contract.test.ts` / `focus-visible.css` / `z-index.css` / `reduced-motion.css` / `index.css` / `shell-reset.css` / `shell-layout.css`；读完 `ui/` 原子 CSS（Button / Input / Textarea / Menu / Select / Tooltip / Dialog / TabStrip / Switch / Slider / SegmentedControl / Badge）；扫主壳 App / BinaryTree / 设置 / 侧栏 / Composer；grep 裸圆角、原生 `title=`、滚动条、焦点环、过弹 easing、rgba/hex、悬空 z-token、文档「已收口」。

**没做：** 不改源码、不 git、不实现、不写第二份文档、不派子代理、不在 5174 / mock / AI 图上验收。未连真机 CDP 9222 截图（本轮任务是对照代码把真机能对上的违例写清）。未穷尽 `reference/` 与历史战役每一份「已收口」声明，只核对本维相关、会被真机打脸的那批。

**不确定：** WebView2 对 `scrollbar-width: thin` 的最终观感（Chromium 已支持，但无全局 webkit 伪元素时，未设该属性的滚动容器仍走 Windows 原生条——侧栏即此）。未实测 `data-ui-size` 三档切换后同一屏里 token 消费件 vs 硬编码件的并排差，但代码路径已足够推出截图差。

---

## 1. 结论先行

基座不是「缺一套 token」，而是 **同一语义被三套密度同时活着**：

1. **`tokens.css` `:root` 标尺**（`--radius-md: 6px`）；
2. **`[data-ui-size]` 档位改写**（small 把 `--radius-md` 改成 **5px**，large 改成 **7px**）；
3. **消费点硬编码 + 各写各的 fallback**（`6px` / `7px` / `8px` / `9px` / `20px` / `999px`），以及语义别名（`--item-radius` / `--dropdown-radius` / `--button-radius`）在 small/large 下 **不再等于** 对应 `--radius-*`。

所以「同一个 `--radius-md`」在真机上可以是 5、可以是 6、可以是 7；旁边一个没走 token 的按钮永远是 6 或 7 或胶囊。用户锁的「设置按钮 7px」目前只有零星硬编码碰巧撞上，**不是契约**。

同时：全局滚动条出口 `shell-scrollbar.css` **已被删**，契约测试仍宣称它是唯一出口且基线 ≤5——ratchet 在「0 块」时仍绿灯。侧栏 `overflow-y: auto` 无任何滚动条 reset，正对真机圈出的 Windows 原生条。

气质层另有三套焦点环、两套 z-index 源、三套颜色注入面、过弹弹簧 token、原生 `title` 与自定义 Tooltip 并存、文档「已收口」与代码互相打脸。下面按类罗列，问题同权。

---

## 2. Token 多密度：同一个 `--radius-md` 会是 5 / 6 / 7

### 2.1 标尺本身三套值

`apps/crish-desktop/src/styles/tokens.css`：

| 选择器 | `--radius-md` | `--radius-lg` | `--radius-xl` | `--radius-2xl` |
| --- | --- | --- | --- | --- |
| `:root`（默认 / medium） | 6px（264） | 8px（265） | 12px（266） | **12px，与 xl 同值**（267） |
| `[data-ui-size='small']` | **5px**（820） | 7px（821） | 10px（822） | 10px（823） |
| `[data-ui-size='large']` | **7px**（896） | 9px（897） | 14px（898） | 14px（899） |

`--radius-2xl` 从未比 `--radius-xl` 大一档，名字骗人。注释写「5 档同心（Ro = Ri + P: 12/8/6/4/2px）」，large/small 改写后这套同心差不再成立。

`data-ui-size` 会写到 `html` 与 `body`（`app/AppBootstrap.ts:245`、`visualThemeController.ts:30`）。默认档没有 `[data-ui-size='medium']` 块——medium 靠 `:root`。large 时全仓所有 `var(--radius-md)` 变 7px；small 时变 5px。**用户锁的设置 7px 若绑 `--radius-md`，会随密度档漂移，不能当锁。**

### 2.2 语义别名在密度档下脱离标尺

同文件 `:root`：

- `--dropdown-radius: var(--radius-lg)` → 8（344）
- `--button-radius: var(--radius-md)` → 6（345）
- `--item-radius: var(--radius-md)` → 6（348）

`[data-ui-size='small']`（770–824）却写成：

- `--dropdown-radius: 10px`（`--radius-lg` 此时是 7）
- `--item-radius: 7px`（`--radius-md` 此时是 5）
- `--dropdown-padding: 5px`（裸数，不走 `--space-*`）
- `--item-font-size: 13px`（不走 `--font-size-*`）

`[data-ui-size='large']`：

- `--dropdown-radius: 14px`（`--radius-lg` 此时是 9）
- `--item-radius: 9px`（`--radius-md` 此时是 7）

结果：菜单壳走 `--dropdown-radius`、菜单项走 `--item-radius`、按钮走 `--radius-md`——**三套圆角，密度一变彼此不再同族**。small 时菜单项 7px、按钮 5px，并排可见。

### 2.3 消费点把「md 是几」写进 fallback，三套答案

同一 token 的 fallback 数字互相打架：

| 位置 | 写法 | fallback 暗示 md = |
| --- | --- | --- |
| `ui/Button/Button.module.css:13` | `var(--radius-md, 6px)` | 6 |
| `ui/Input/Input.module.css:30` | `var(--radius-md, 6px)` | 6 |
| `ui/Menu/Menu.module.css:52` | `var(--item-radius, var(--radius-md, 6px))` | 6 |
| `chat-composer/ComposePlusMenu.module.css:22` | `var(--radius-md, 7px)` | **7** |
| `sidebar/Sidebar.module.css:323` `.hamburger` | `var(--radius-md, 8px)` | **8** |

token 存在时 fallback 不生效，但这说明作者对「md 是几」没有共识；一旦 token 未注入（加载器 / iframe / 测试壳），同一控件会分别长成 6/7/8。

### 2.4 硬编码圆角绕过 token（密度档无效）

主壳与设置里，真机能直接量到的裸像素（节选，非穷尽）：

- `App.module.css:26` skip-link `border-radius: 6px`
- `ChatComposer.module.css:14` 输入壳 `20px`；`:400` footer `0 0 12px 12px`；`:498` dropMask 又 `20px`
- `ChatMessageRow.module.css:68` 用户气泡 `20px 20px var(--radius-xs) 20px`
- `ChatMessageList.module.css:99` `7px`
- `FilesCard.module.css:484` `7px`；`:436` `0 0 8px 8px`
- `FileViewerCard.module.css` 一串 `8px` / `6px` / `5px 0 0 5px`
- `ModelsSettingsTab.module.css:812` 添加表单 `9px`；`:890` 「添加模型」钮 **`7px`（唯一碰巧撞上用户锁的硬编码）**
- `StatusDiagnosticsPanel.module.css` `8px` / `6px` / `4px` / `999px` 混用
- `ExternalSessionImport.module.css:159` `3px`；`:47/:56` `999px`
- `settings/SettingsPanel.module.css:191` 内容区 `border-radius: 0`（注释写曾经 14px）
- `FirstRunWizard.module.css:66` 步骤胶囊 `999px`
- `overlay` / 侧栏 `modeChip` / `footerUpdate` / Skills 多处 `999px`

`style-contract.test.ts:196` 把 `border-radius: 999` 基线锁在 **62**——契约承认胶囊满天飞，只禁止再增加，**不禁止与用户 7px 锁冲突**。

### 2.5 原子层注释把 4/6/8 写死

`ui/Button/Button.tsx:6`：「普通按钮禁止 9999px 药丸圆角，仅使用 `--radius-sm(4px)/--radius-md(6px)/--radius-lg(8px)`。」

这与：

- 密度档（md = 5 或 7）；
- 用户锁（设置按钮 = 7px）；
- large 时 `--radius-lg` = 9px；

三条同时成立，注释本身就是一份过期契约。`Button.module.css` 尺寸档还把 xs→`--radius-sm`、md→`--radius-md`、lg→`--radius-lg`，**按钮圆角随 size 变，不随「设置 7px」变**。

### 2.6 控件高度也不跟 `--control-height`

密度档会改 `--control-height`（默认 32 / small 30 / large 34）。但：

- `Button.module.css:10` `--btn-h: 32px` **写死**，sm/md/lg 分别 28/32/40，不读 `--control-height`；
- `Input.module.css:26` `.input { height: 32px }` 写死；
- `Select.module.css:23` trigger 才走 `var(--control-height)`。

small 档下：Select 30px 高、Button/Input 仍 32px，并排设置表单就能看出一截。

---

## 3. Token 双源 / 三源（颜色、z-index、宽度）

### 3.1 颜色：静态表 + 运行时注入 + 加载器私有盘

| 源 | 路径 | 做什么 |
| --- | --- | --- |
| 静态真源 | `styles/tokens.css` `:root` / `html[data-theme='dark']` | 全套色板 |
| 运行时覆盖 | `api/themePersonalization.ts` `root.style.setProperty` | 皮肤 / 自定义色 / 亮度档 / 暮光温感，覆盖 `--bg-*` `--text-*` `--border-*` |
| 启动闪屏 | `public/loader.css` | 独立 `#0b0b0e` / `#f4f4f5` / `rgba(0,0,0,0.85)` 阴影，不读 tokens |

`themeStore.ts:15–19` 自己声明「tokens 唯一源」例外：皮肤约 225 处 hex/hsl 在 `themePresets.ts`，经 `setProperty` 注入。静态 CSS 与运行时注入双活——`style-contract` ⑥ 只保证「注入名 ∈ 静态名」，**不保证值同源**。暮光/亮度会把浅色板推向 `hsl(34, 30%, 45%)` 温灰（`themePersonalization.ts:211`），与 tokens 注释「pure neutral greys」再偏一层。

`tokens.css:535–574` 注释仍指向已不存在的 `theme-dark.css`。暗色块已并入本文件，但注释与 `style-contract.test.ts:66–71` MIX_SKIP 名单仍把 `theme-dark.css` 当活文件。

### 3.2 z-index：`tokens.css` 与 `z-index.css` 双份

`index.css:2` 先无层导入 `tokens.css`（内含 `--z-base/dock/chrome/dropdown/popover/modal/tooltip`，391–398），再 `z-index.css` **layer(base)**（1–27，多了 `--z-sticky/--z-sidebar/--z-resizer/--z-drawer/--z-toast`）。

无层声明压过 layer。重叠名以 tokens 为准；别名只活在 layer 里。`ui/README.md:38` 却写「运行期唯一真值为 `styles/z-index.css`」——与级联事实相反。

### 3.3 宽度双源

`constants/layout.ts:2` `SIDEBAR_WIDTH_DEFAULT = 260`，「镜像 CSS token，修改时同步」。`tokens.css:352` `--sidebar-width: 260px; /* overridden by JS constants at runtime */`。`--chat-col-max: 760px` 同样注释「JS 覆盖」。两处改一处就会漂移。

`SettingsUI.module.css:6` `max-width: var(--settings-content-max, 820px)`，token 真值是 **720px**（`tokens.css:521`）。有 token 时 720；没 token 时 820。作者记忆与标尺差 100px。

---

## 4. 悬空 token（引用了，定义表里没有）

下列 `var(--…)` 在 `tokens.css` 与 `z-index.css` **均无定义**（全仓 grep 定义面为零）。未定义时部分有 fallback、部分没有——没有的会变成 `z-index: var(--missing)` 无效，层叠回 `auto`。

| 名字 | 消费例 | fallback |
| --- | --- | --- |
| `--z-drag-overlay` | `BinaryTreeWorkspace.module.css:288`、`GlobalSessionTabBar.module.css:372`、`utils/dragOverlay.ts:13` | 无（侧栏拖拽幽灵有 `, 1000`） |
| `--z-drag-highlight` | `BinaryTreeWorkspace.module.css:250` | `, 100` |
| `--z-sticky-bar` | `GlobalSessionTabBar.module.css:42`（fallback 2）、`ChatMsgFilterBar.module.css:12`（无）、`SidebarContextMenus.module.css:153`（无） | 不一致 |
| `--z-dropdown-menu` | `PermissionModeMenu.module.css:64`、`ChatHeaderMore.module.css:52`、`FilesCard.module.css:696`、`ModelsSettingsTab.module.css:1064` | 无 |
| `--z-sidebar-resizer` | `Sidebar.module.css:265` | 无 |
| `--radius-tooltip` | `Tooltip.module.css:43` | 落到 `--radius-sm, 4px` |
| `--line-height-normal` | `Textarea.module.css:37`（fallback 1.5）、`ChatStatusRibbons.module.css:165`、`GlobalErrorBanner.module.css:24` | 部分无 |
| `--transition-normal` / `--transition-spring-enter` / `--transition-spring-exit` / `--transition-modal-exit` | `reduced-motion.css` 把它们置 0 | tokens 里根本没有这些名；eco 档也清不掉不存在的名 |

`--z-toast` 只在 `z-index.css:23` 定义为 `var(--z-modal)`（=1000）。Tooltip 是 9000。拖拽幽灵走 `--z-toast`（`tabDragGhost.ts:63`）会压在模态里、却压不过 Tooltip——拖会话标签时若 Tooltip 还在，残影叠层。

---

## 5. 色彩空间：HSLA 铁律 vs 基座自己在用 hex / rgba / 逗号 hsl

`AGENTS.md` §14：优先 `hsl(h s l / a)`，避免散落 `rgba()`。

`tokens.css` 基座自己：

- **逗号 hsl**：`--bg-primary: hsl(35, 12%, 94%)` 等约 45 处（10–153、542–710）；
- **空格+斜杠 hsl**（合规）：diff 族 `--diff-line-add-bg: hsl(142 35% 42% / 0.055)`（401–411、745–755）；
- **hex**：`--text-primary: #111111`（30）、`--text-secondary: #555555`（31）、`--text-tertiary: #696969`（34）、`--accent-blue: #1d4ed8`（144）、`--window-close-bg: #e81123`（203）、`--shadow-color: #000`（207）、整组 `--xterm-*` / `--syntax-*` / `--ui-text-*` / `--mac-dot-*`；
- **rgba**：`--xterm-selection: rgba(255, 255, 255, 0.18)`（254）、`--bg-glass: rgba(255, 255, 255, 0.75)`（300、729、932）。

同一文件两种 hsl 语法。原子 CSS 文件头写「100% tokens、0 hex/rgba」，实际大量 `color-mix(in srgb, …)`（srgb 混色，不是 HSLA），以及 fallback `rgba(128, 128, 128, 0.12)`（见下节 hover）。

`design-system.css:16` 暗色 elevation 叠加 `rgba(255, 255, 255, 0.02)`。

`WindowControls.module.css:33` 关闭钮 hover **再写一遍** `#e81123` / `#ffffff`，无视已有 `--window-close-bg` / `--window-close-fg`（tokens 203–204）。

`loader.css:7` `--loader-shadow: 0 20px 50px -10px rgba(0, 0, 0, 0.85)`——启动屏重阴影，与「Premium Soft Low-Presence Shadows」相反。

---

## 6. 焦点环：三套实现，暗色超过 10% 上限

`AGENTS.md` §13：焦点相对基线混入文本色不超过约 **10%**，常规 **3%–6%**；禁止粗深实心黑边；输入框默认不要重阴影。

### 6.1 全局 `focus-visible.css`（第 1 套）

```9:25:apps/crish-desktop/src/styles/focus-visible.css
:focus-visible {
  outline: 2px solid var(--focus-ring-color);
  outline-offset: 1px;
}
button:focus-visible,
a:focus-visible,
[role='button']:focus-visible,
[tabindex]:not([tabindex='-1']):focus-visible {
  outline: none;
  box-shadow: var(--focus-ring, 0 0 0 2px var(--tint-focus-ring));
}
```

泛元素是 **2px solid outline**。`--focus-ring-color`：

- 浅色：`control-mix-color 8%`（tokens 110–114）——接近上限；
- **暗色：`text-primary 30%`（618）——三倍于 10% 上限**，再套 2px，真机是一圈硬亮环。

`--focus-ring` 浅色 = `0 0 0 2px var(--focus-ring-color)`（115）。暗色同样 2px（620），另给 `--focus-ring-strong: 0 0 0 3px … 22%`（621–622）。

### 6.2 类型不一致：浅色 `--focus-ring-strong` 是颜色，暗色是阴影

浅色（121–124）：`--focus-ring-strong: color-mix(… border 90%, text 10%)` —— **颜色**。
暗色（621）：`--focus-ring-strong: 0 0 0 3px …` —— **box-shadow**。
任何 `box-shadow: var(--focus-ring-strong)` 在浅色会非法、在暗色是 3px 环。

### 6.3 原子 1.5px 混色（第 2 套）

Button / Input / Textarea / Switch / Dialog 关闭钮 / SegmentedControl / Slider 用：

`0 0 0 1.5px color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%)`

这套符合 §13 的 6% 常规档。但 Select trigger（`Select.module.css:48`）走 **第 1 套** `var(--focus-ring)`（2px）。同一设置表单：Input 1.5px 柔环、Select 2px 更重环。

### 6.4 业务模块再发明（第 3 套）

`var(--focus-ring, 0 0 0 2px var(--tint-focus-ring))` 出现在 TerminalCard / PreviewCard / BrowserPanel / InlineAgentPanel / ComposePlusMenu / PermissionModeMenu / ModelsSettingsTab 等多处。`--tint-focus-ring` 是 text-primary **10%**（tokens 44、564），作 fallback 时是实心 2px 环。

更重：

- `WorkspaceEmptyState.module.css:117` `0 0 0 2px var(--empty-focus-ring)`（`--empty-focus-ring` 未在 tokens 定义，待交叉空态维）；
- `NotePaperPanel.module.css:145+` `0 0 0 2px var(--np-focus-edge)`；
- `ComputerPanel.module.css:131` `0 0 0 3px` + success 18%（激活点外光）；
- `ApprovalDock.module.css:50` 脉冲到 `0 0 0 6px`。

Composer 空态 `data-empty-kind='session-empty'` 焦点混入 5%（`ChatComposer.module.css:39–45`）符合 §13 例外；普通 composer 是 6%。这条本身不是违例，但和 2px `--focus-ring` 并排时仍会「有的几乎看不见、有的一圈亮边」。

---

## 7. 重阴影

token 浅色阴影故意极淡（`--shadow-sm` 1–1.5% 黑，`--shadow-lg` 多层 1–1.5%，278–297）。暗色加到 15–40%（688–708）。消费点经常绕开：

| 位置 | 阴影 | 相对 token |
| --- | --- | --- |
| `Dialog.module.css:32` | `var(--shadow-2xl)` | 模态最大档；暗色 40% |
| `Menu.module.css:24` | `var(--shadow-lg)` | 下拉也用大阴影 |
| `Tooltip.module.css:44` | `var(--shadow-lg)` | 一句话提示用大阴影，残影更明显 |
| `BinaryTreeWorkspace.module.css:258` | `0 0 8px` accent 25% | 拖放光晕 |
| `:290` ghost | `0 8px 24px` 18% | 重于 `--shadow-drag` 浅色档 |
| `ToastStack.module.css:41` | `0 4px 16px` 18% + `backdrop-filter: blur(8px)` | 不走 `--shadow-*` / `--backdrop-blur` |
| `SettingsUI.module.css:174–176` 自研 tooltip | `0 4px 12px` 8% + `0 2px 4px` 4%；暗色 30%/20%（196–198） | 第二套 Tooltip 阴影 |
| `Sidebar.module.css:301` overlay | `var(--shadow-lg, 0 8px 32px rgba(0,0,0,0.12))` | fallback 12% 已是「重阴影」 |
| `FileViewerCard.module.css:66` | `0 1px 2px rgba(0,0,0,0.05)` | 裸 rgba |
| `ChatStatusRibbons.module.css:114` | `0 2px 8px rgba(0,0,0,0.04)` | 裸 rgba |
| `Slider.module.css:65` | `0 1px 3px` 15% | 滑块点阴影 |
| `SegmentedControl.module.css:81` | `0 1px 3px` 10% | 滑块 |
| `loader.css:7` | `0 20px 50px` 85% | 启动屏 |

`design-system.css:8–9` `.elevation-2` 与 `.elevation-3` **完全相同**（都是 `--bg-card` + `--shadow-md`），四档 elevation 实际三档。

Dialog 遮罩 `color-mix(bg-overlay 45%)`（`Dialog.module.css:17`），`--bg-overlay` = `#000`（tokens 209）。45% 黑遮罩比 `--tint-overlay` 的 25% 文字色更闷。设置全屏盖层走 `variant=fullscreen` 无遮罩，向导走 45%——两种「模态气质」。

---

## 8. 原生 `title` 与自定义 Tooltip 双轨

`AGENTS.md` §12：悬停提示用项目 `<Tooltip>`，不要用原生 `title`。`ComposerField.tsx:16` 已写「禁止 native title=（避免双提示）」，且有测试守门。其它面没有。

### 8.1 会弹出浏览器默认黄条的 DOM `title=`

（Dialog / SettingsPage / SettingsRow / AppErrorBoundary / ConfirmDialog 的 `title` prop **不是** HTML title，不列入。）

| 文件 | 行 | 节点 | 同时还有 Tooltip？ |
| --- | --- | --- | --- |
| `settings-skills/SkillCardList.tsx` | 88 | 空态 `div` `title={EMPTY_INSTALL_HINT}` | 内部按钮另包 Tooltip「导入本机技能…」 |
| 同上 | 112 | 筛选空 `div` `title={EMPTY_FILTER_HINT}` | 内部按钮 Tooltip 同文案 → **双提示** |
| 同上 | 196 | `span.skillsActDot` `title={actLabel}` | 外层整钮已包 Tooltip → **双提示** |
| `settings-skills/SkillEditorModal.tsx` | 123 | `label` `title={s.description \|\| s.name}` | 无 |
| `workspace/LiveTasksSection.tsx` | 60 | `div[role=button]` `title="打开对应会话"` | 另有 aria-label |
| `workspace/RuntimePanel.tsx` | 98 | 引擎状态 `div` `title={formatEngineStatusTitle(...)}` | 另有 aria-label |
| `workspace/SecurityAuditSection.tsx` | 80 | `span.rowMeta` `title={entry.targets.join('\n')}` | 无 |
| `workspace/TrashSection.tsx` | 151 | `span.rowTitle` `title={entry.originalPath}` | 无 |
| `settings-models/ModelConfigPanel.tsx` | 107–110 | `span` `title={error \|\| '测试成功'/'测试失败'}` | 旁边测试钮才是 Tooltip |

真机扫过技能轨激活点、连通性毫秒标签、回收站路径、进行中任务行，都会先出系统气泡，再可能出自定义胶囊——正是「Tooltip 残影 / 双提示」能对上的代码路径。

### 8.2 第二套 Tooltip（设置 Select）

`SettingsUI.module.css:148–204` `.modernSelectTooltip*`：自己的 fade+scale(0.95) 动画、自己的箭头、自己的阴影、圆角 `--radius-lg`（不是 `--radius-tooltip`/`--radius-sm`）。与 `ui/Tooltip` 并存。全局「同时只能一个」若只收 `ui/Tooltip`，设置页这套不受管。

### 8.3 `ui/Tooltip` 自身气质问题（交叉 02，本维也要记）

- **无 delayShow**：`Tooltip.tsx:187–195` `handleShow` 立刻 `setVisible(true)`。鼠标快扫顶栏/侧栏会每个图标都播一遍 enter。与用户锁「过快则一个都不显示」相反。
- **无全局单例**：`data-floating-active` 只在有菜单层时藏 Tooltip（`Tooltip.module.css:52`），**Tooltip 之间不互斥**。
- **JS 退出时长 0、CSS 仍有退出动画**：`useAnimatedPresence({ exitDurationMs: 0 })`（103–106）让 `state` 直接 `closed`，`tooltipExit` 类基本走不到；进入仍 `scale(0.95)→1`（`Tooltip.module.css:18–26`）+ `box-shadow: var(--shadow-lg)`。首帧 `opacity: 0` 等到 `clampedPos`（363–366），测量前透明、测量后弹出——快移时像残影。注释声称 WO-08「彻底根除 FOUC 与跳变残影」，真机已打脸。
- 圆角 `var(--radius-tooltip, var(--radius-sm, 4px))`，`--radius-tooltip` 未定义 → 实际 4px，和菜单 8/10/14、对话框 12 不一家。

---

## 9. Windows 滚动条：全局 reset 已被删，契约还在说它活着

### 9.1 文档 / 测试声称的「唯一出口」不存在

- `docs/frontend-audit/60-repair2/40-final-plan/90-final-report-r2.md`：R2-7「`shell-scrollbar.css` 唯一出口，生产 css 命中 = 1，基线 5」。
- `style-contract.test.ts:227–231` 仍写「基线 5 = shell-scrollbar.css：本体/track/thumb/hover/active 五处」。
- `index.css` **不再 import** 任何 scrollbar 表。`styles/shell/` 只剩 `shell-layout.css` + `shell-reset.css`。
- `docs/block-workspace-architecture/shell-rehost/01-视口包含块.md`：`d00fbaaf` 删除 `shell-scrollbar.css`（55 行），并 **禁止复活**。

生产 CSS 里 `::-webkit-scrollbar` 计数 = **0**（测试只扫 `.css`，0 ≤ 5 绿灯）。ratchet 只能防「再增加」，**不能防把唯一出口删掉**。

### 9.2 真机侧栏原生条的直接原因

`Sidebar.module.css:40–48` `.sidebarScroll { flex: 1; overflow-y: auto; … }`：**没有** `scrollbar-width`、**没有** `scrollbar-color`、**没有** `--scrollbar-thumb-width`。Windows WebView2 走系统滚动条（带轨道/箭头/宽滑块）。用户截图圈的就是这条。

同样裸 `overflow-y: auto`、无 reset 的主壳容器：

- 设置导航 `SettingsPanel.module.css:134` `.navScroll`
- 设置正文 `:200` `.coverContent`
- `Menu.module.css:16` 菜单列表
- `Dialog.module.css:185` `.dialogBody`
- `PermissionModeMenu.module.css:80` 权限菜单
- `FontSelectField.module.css:126`、`SettingsQuickMenu.module.css:63`、`SettingsUsageTab.module.css:89`
- `SidebarContextMenus.module.css:90, 160`

部分 Composer / Diff / Tab 条写了 `scrollbar-width: thin` 或 `--scrollbar-thumb-width: 0px`，但 **变量无人消费**——定义 `--scrollbar-thumb-width` 的注释还说「覆盖 shell-scrollbar.css」，文件已不在。`LeafToolTabStrip.module.css:38–41`、`DiffCard.module.css:1119–1122`、`GlobalSessionTabBar.module.css:91–92` 都是对着幽灵出口说话。

### 9.3 与「禁止复活壳皮」的冲突（供主控裁决，不在本维改）

shell-rehost 禁复活 `shell-scrollbar.css` 文件名；本战役真机又要侧栏不要原生条。需要 **新的全局滚动条契约**（可以是别的文件名），而不是把已删文件当真理。本维只登记断层。

---

## 10. 动画 token 过弹（与 01 交叉，不漏）

用户锁：点击果冻去掉。下列是 **基座级** 过弹/按压缩放，01 若只扫业务按钮会漏。

### 10.1 过冲 cubic-bezier（y > 1）

| token / 点 | 值 | 位置 |
| --- | --- | --- |
| `--transition-enter` | `400ms cubic-bezier(0.175, 0.885, 0.32, 1.275)` | `tokens.css:306` |
| `--transition-spring` | `500ms` 同一 1.275 | `:308` |
| Switch 拇指 | `220ms cubic-bezier(0.27, 0.2, 0.25, 1.51)` | `Switch.module.css:4, 74` |

1.275 / 1.51 都会越过目标再弹回。Switch 注释还写明「1.51」。

`--transition-spring-layout: cubic-bezier(0.16, 1, 0.3, 1) 220ms`（302）本身不过冲，但是 **侧栏没用它**。

### 10.2 按压缩放（果冻手感）

- `Button.module.css:72–73` `:active { transform: scale(0.98) }`，且 `transition: transform … cubic-bezier(0.2, 0, 0, 1)`（46–48）
- `SidebarSessionList.module.css:282–284` 会话行 `:active { transform: scale(0.985) }` + `--transition-press`（80ms）
- `PermissionModeMenu.module.css:31–33` `.permPill:active { scale(0.97) }`
- `ComposePlusMenu.module.css:41–43` `.item:active { scale(0.98) }`
- `Slider.module.css:74–76` hover 拇指 `scale(1.15)`

设置里凡用 `ui/Button` 的确认/保存都会 0.98 一缩；侧栏点会话会 0.985 一缩。截图动起来就是果冻。

### 10.3 主壳宽度动画绕开 token

`App.tsx:228` 侧栏包装 **内联**：

`transition: 'width 0.25s cubic-bezier(0.2, 0.8, 0.2, 1)'`

不走 `--transition-spring-layout`，eco 档（tokens 947–961 把 spring-layout 置 0）**管不到这行**。`prefers-reduced-motion` 靠 `* { transition-duration: 0.01ms !important }` 才能压住。折叠侧栏的「弹性宽」真机能看到。

`Sidebar.module.css:9` 才是 `width var(--transition-spring-layout)`——内外两层动画还可能叠。

### 10.4 eco 档清不干净

`html[data-perf-tier='eco']`（947–961）把一批 `--transition-*` 置 0，但 **没清**：`--transition-press`、`--transition-spin/pulse/blink/skeleton`、全部 `--duration-*`、`--easing-*`。Button 的 `scale(0.98)` 在 eco 仍可能动（若组件写死 80ms fallback 则必动）。

`reduced-motion.css` 清了一堆 **tokens 里不存在的名字**（`--transition-normal`、`--transition-spring-enter/exit`、`--transition-modal-exit`），却让 `.essential-animation` 以 `!important` 回到 1.5s（51–55、97–101）。

### 10.5 幽灵 keyframes

`PermissionModeMenu.module.css:73` `animation: cds-popover-enter var(--transition-popover-enter)`。全仓 **没有** `@keyframes cds-popover-enter` / `cds-popover-exit`（grep 为零）。权限菜单的进出动画是空名。设计系统里真正存在的是 `crish-popover-enter`（`design-system.css:28`）和 Tooltip 自己的 `tooltip-enter`。三套名字。交叉 03（面板互斥）时权限+模型叠开，叠的是没统一动画、没统一半径的两张皮。

Dialog 自己再写一套 `dialog-enter` scale(0.96)（`Dialog.module.css:92–111`），`design-system.css` 还有 `crish-modal-enter` / `panel-enter`。模态进出至少三套。

---

## 11. Hover 遮罩过重、两套淡染

token 档：`--tint-hover` 4%、`--tint-active` 8%（41–42、561–562）。`--bg-hover` 是它们的别名（13–14）。

Button 不走 tint，自己写：

- `--btn-hover-overlay: text-primary 6%`（22）
- `--btn-active-overlay: 12%`（23）
- primary 的 hover 是 `white 15%`（135）

6%/12% 已经高于 4%/8% 档；再叠 `::before` 整块铺色。设置里 `ui/Button` 与 `.sidebarTab:hover`（`SettingsPanel.module.css:229` `var(--tint-hover, rgba(128,128,128,0.12))`）并排：一个 6% 文字色，一个 fallback **12% 中性灰**。

顶栏同样 fallback 12%：`AppTopBar.module.css:52, 98, 135`、`WindowControls.module.css:28`。token 在时是 4%；token 缺时突然三倍。即便 token 在，作者选 12% fallback 说明心里的「能看见的 hover」比 4% 档重。

浅色 `--control-soft-bg` 与 `--control-soft-bg-hover` **都是 mix-color 4%**（77–85）——secondary 按钮 hover 背景不变，只靠 6% overlay，和 ghost 的差异更弱。`style-contract` ⑦ 还把「light 4/4/8」当成要对齐的双源同值（289），等于把「hover 等于 rest」锁进契约。

侧栏会话用 `--sidebar-hover`（light 4% control-mix on secondary，92–100）。顶栏按钮用 `--tint-hover` 4% on 别的底。同一 4% 在不同底上观感不同，再加 12% fallback 与 6% overlay，hover 没有单一气质。

`footerUpdate:hover`（`Sidebar.module.css:251`）`accent-green 18%`——比 tint-strong 12% 更满。

---

## 12. 分割线、字体、间距节奏

### 12.1 分割线三种厚度/颜色

| 写法 | 位置 | 观感 |
| --- | --- | --- |
| `--hairline-width: 1px` + `--hairline` / `--hairline-strong` | tokens 71–73 | 契约 1px |
| `border-bottom: 0.5px solid var(--border-color)` | `AppTopBar.module.css:14`、`SettingsPanel.module.css:46, 166` | 顶栏/设置导航是半像素，比会话列表 1px 更飘 |
| `transform: scaleY(0.5)` 的 1px 条 | `Menu.module.css:103–110` | 菜单分隔视觉 0.5px，颜色 `--border-subtle` |
| `width: 1px; height: 14px` | `UnitChromeActions.module.css:24–28` | 叶工具条短竖线 |
| `border-right: none` | `Sidebar.module.css:4` 注释「Removed vertical border line」 | 侧栏与工作区无竖线，设置却有 0.5px 右边线 |

顶栏 0.5px + 工作区无侧线 + 设置 0.5px 导航边 + 菜单 0.5px 内分隔 + token 1px hairline：同一屏至少三档「线」。

### 12.2 字号：token 13 档 + 大量裸 px + 半像素档

tokens 自带 `--font-size-xxs/xs/sm/base/md/lg/xl` 之外还有 `nano/micro/xs-plus/sm-plus/xxl/2xl/chat`（360–373）。small/large 只改前 7 档，**nano/micro/xs-plus/chat 不随密度变**。

裸 `font-size` 仍在主壳：`App.module.css:28` skip-link 13px；`AppTopBar` 不设字号靠继承；`ComposePlusMenu.module.css:85` **10.5px**；`SkillsSettingsTab.module.css:342` 10.5px；`StatusDiagnosticsPanel.module.css` 11/12/13 混用；`FileViewerCard` 10–12；`ModelConfigPanel.tsx:95` **内联** `fontSize: '11px'`。密度档改 token 时这些字钉死。

`ChatEmptyState.module.css:71` 标题 `clamp(22px, 3.2vw, 34px)`，完全在字号阶梯外。空态欢迎字比设置页 `font-size-xl`（19px，且 fallback 写成 20px）大一号还多。

### 12.3 行高两套家族

`--line-height-tight/ui/body/relaxed/none/dense/compact/base` 共 8 个（472–479）。另有未定义的 `--line-height-normal`。Composer 自己 `--composer-line-height: 1.45`（`ChatComposer.module.css:2`）。body 在 `shell-reset.css:30` 写死 `line-height: 1.5`，不是 `var(--line-height-body)`（1.55）。

### 12.4 间距：token 改了，主壳很多不读

small 档把 `--space-2` 改成 5px、`--space-3` 改成 6px（807–808）。但侧栏：

- `.sidebarTop` `padding: 12px 10px 0 10px`（`Sidebar.module.css:34`）
- `.sidebarScroll` `padding: 14px 10px`、`gap: 14px`（43–46）
- `.sessionItem` 高度写死 28px（253–266），small 时 `--control-height-sm` 已是 26
- `.folderSessions` `gap: 3px`（247）

设置 `.coverContent` `padding: 24px 32px 32px`（`SettingsPanel.module.css:194`）、`.settingsUiPage` `padding-bottom: 24px`、row `padding: 10px 14px`（`SettingsUI.module.css:9, 76`）。密度档几乎掀不动设置页节奏。

顶栏高度 `--header-height` 36/32/40（350、778、854），会话条 `--titlebar-row-h: 28px`（273），全局标签条 `--global-tab-strip-h: 32px` 且 tab 26px（`GlobalSessionTabBar.module.css:12–13`），窗控按钮 32×28（`WindowControls.module.css:9–10`），顶栏图标钮 28 与 24 混（`AppTopBar.module.css:32, 78`）。**同一条 36px 顶栏里塞 24/26/28/32 四种控件高。**

---

## 13. 菜单 / 对话框 / 输入框圆角不一致（可量）

默认档（medium，`--radius-md=6`）真机量到的浮层/输入：

| 表面 | 圆角 | 来源 |
| --- | --- | --- |
| ui/Input、ui/Select trigger、ui/Textarea | `--radius-md` = 6 | 原子 |
| ui/Button md | `--radius-md` = 6 | 原子 |
| ui/Button lg | `--radius-lg` = 8 | 原子 |
| ui/Menu 壳 | `--dropdown-radius` = 8 | 原子 |
| ui/Menu 项 | `--item-radius` = 6 | 原子 |
| ui/Dialog | `--radius-xl` = 12 | 原子 |
| ui/Tooltip | `--radius-sm` = 4（因 `--radius-tooltip` 悬空） | 原子 |
| ui/Segmented 外 | `--radius-lg` = 8 | 原子 |
| Composer 壳 | **20px 写死** | 主输入 |
| Composer footer | **12px 底角写死** | 与壳 20px 不是同心 |
| Composer 发送圆钮 | **50%** | 与 `--radius-lg` 的 sendBtn 并存 |
| 权限 pill | `--radius-sm` = 4 | 底栏 |
| 权限菜单壳 | `--radius-lg` = 8 | 且动画名是幽灵 cds-popover |
| Plus 菜单项 | `--radius-md, 7px` | fallback 7 |
| 设置搜索 | `--radius-xl` = 12 | 药丸搜框 |
| 设置导航 tab | `--radius-lg` = 8 | |
| 设置返回 | `--radius-xl` = 12 | |
| 设置卡片 | `--radius-xl` = 12 | |
| 设置「添加模型」 | **7px 硬编码** | 唯一接近用户锁 |
| 设置添加表单 | **9px 硬编码** | |
| 设置诊断块 | 8 / 6 / 4 / 999 | |
| 全局会话 tab | `--radius-sm` = 4 | 注释还写「26px capsule + 4px micro」 |
| 侧栏会话行 | `--radius-lg` = 8 | 28px 高的「胶囊」其实是 8px 圆角 |
| 侧栏 modeChip | **999px** | 真胶囊 |
| 用户气泡 | **20px** | 与 Composer 20px 呼应，与 7px 锁无关 |

用户锁「设置界面按钮圆角 = 7px」：**当前设置页按钮没有统一 7px**。`ui/Button` 默认 6；导航 tab 8；搜索 12；添加模型 7；添加表单 9；快捷菜单 999。large 档会把 `--radius-md` 变成 7，于是 **部分** 按钮变 7，搜索变成 14，菜单壳变成 14——更散。

---

## 14. 主壳扫描（App / BinaryTree / 设置 / 侧栏 / Composer）

凡是真机截图能对上的，单列。不因「别的维会写」省略。

### 14.1 App 壳

- 侧栏宽动画内联 0.25s 自定义贝塞尔（`App.tsx:228`），eco/token 管不到。见 §10.3。
- skip-link 焦点态裸 `6px` 圆角、`13px` 字、`#fff/#111` fallback（`App.module.css:24–28`）。
- `sidebar-wrapper` `overflow: visible`（229）vs `.sidebar { overflow: hidden }`：折叠态阴影/滚动条裁切行为依赖两层 overflow，截图时折叠侧栏边缘容易「漏一条原生条或阴影」。
- 高度链只在 `shell-layout.css`（html/root/app-container/main-layout），**没有全局 scrollbar / chrome 皮**——这是有意的，但把滚动条契约一起带走了。

### 14.2 BinaryTree

- 空叶 `emptyState`（`BinaryTreeWorkspace.module.css:389–406`）居中灰字、`--bg-secondary`，与主列空态（透明底 + clamp 大标题）两套空态气质。
- 每个 chat 叶都挂 `UnitChromeActions`（`TreeLeafPanel.tsx:191–195`），工具钮文案含 **「打开文件」**（`UnitChromeActions.tsx:36–38`）。空会话叶顶栏仍有「打开文件 / 打开终端 / …」——对上用户圈的空叶「打开文件」。按钮走 `ui/Button` + Tooltip，圆角 6 不是 7；`:hover` 用 `--bg-hover`。
- 激活叶 `outline: 1px solid var(--tint-active)`（`BinaryTreeWorkspace.module.css:107–110`）；多叶时改 inset 1.5px `--tint-strong`（133–137）。和焦点环、hairline 又是第四种「描边」。
- 拖放 overlay 1.5px 实色边 + 8px glow（246–259），`--z-drag-highlight` 悬空。
- sash 命中区 10px、线 1px hover 变 1.5px（173–242），半径 1px 硬编码。
- 叶工具条 `LeafToolTabStrip` 设了 `--scrollbar-thumb-width: 3px` 但无全局伪元素，横向溢出时仍可能出系统条。

### 14.3 设置

- 全屏 Dialog `border-radius: 0`（`Dialog.module.css:60`、`SettingsPanel.module.css:191`），内部控件圆角满天飞（§13）。
- 搜索框 xl 12px 胶囊 + 无 focus 环（`SettingsPanel.module.css:124–128` focus 只改背景、`box-shadow: none`）——与 ui/Input 1.5px 环两套焦点。
- 导航 tab 8px、active 还加 `--shadow-sm`（233–238），像一块浮起的小卡片，和「7px 扁平按钮」不是同一语言。
- `.coverContent` / `.navScroll` 原生滚动条（§9.2）。
- `SettingsUI` 自研 tooltip（§8.2）。
- `ModelConfigPanel` 内联 11px + 原生 title（§8.1）。
- `StatusDiagnosticsPanel` 8/6/4/999 混圆角、裸 12/13px 字号。
- `SettingsShortcutsTab.tsx:337` 还原快捷键是裸 `<button className="settings-shortcuts-filter-clear">`，不走 `ui/Button`，圆角由失踪的全局类决定（settings-base.css 已不在生产 import）。
- 设置里大量 `ui/Button`（Appearance/Profile/Security…）→ 默认 md = 6px，**不是 7px**。

### 14.4 侧栏

- `.sidebarScroll` 原生 Windows 条（§9.2）——真机已圈。
- 会话行 28px 高、`--radius-lg` 8px、按下 scale(0.985)（§10.2）。
- 底栏齿轮 `--radius-xl` 12px、32px 方钮（`Sidebar.module.css:163–167`），与顶栏 28px/`--radius-sm` 4px 不一家。
- `modeChip` / `footerUpdate` `999px` 胶囊（206、238）。
- overlay 模式 fallback 重阴影 12%（301）。
- `--z-sidebar-resizer` 悬空（265）。
- 用户在线点 `7px` + `box-shadow: 0 0 0 1.5px var(--bg-secondary)`（121–129），和窗控/tab 描边又一档。

### 14.5 Composer

- 主壳 20px 圆角矩形 + 底下再接 12px 底圆角 footer（`ChatComposer.module.css:14, 394–408`），注释写「Fully rounded top rectangle」「smaller rectangle」。真机是上下两截圆角不同的条，和设置 7px、菜单 8px、输入 6px 全无亲戚。
- `sendCircle` 50% 与 `sendBtn` `--radius-lg` 两套发送形态（257–287）。
- plus / retract `--radius-lg`（424、460），权限 pill `--radius-sm`（8），底栏一排三种圆角。
- plus/权限按下 scale 0.97–0.98（§10.2）。
- 权限菜单 `overflow-y: auto` 无滚动条 reset + 幽灵 `cds-popover-enter` + `--z-dropdown-menu` 悬空。模型选择若是另一套 Menu/Popover，层叠与圆角都不统一——对上「权限+模型叠开」（交互互斥归 03，气质叠层归本维）。
- 附件条 `scrollbar-width: thin`（151），主 textarea 亦 thin（99）；侧栏没有——同一窗口两种滚动条皮肤。
- 空态焦点 5% 混入合规；非空态 6%。都没有重阴影（22、35），这一条符合 §13。

### 14.6 顶栏 / 窗控 / 全局 tab

- 顶栏 0.5px 底边 vs token 1px hairline。
- 图标钮 24 与 28 混、圆角 `--radius-sm` 4px。
- 关闭钮 hover 硬编码 `#e81123`（Windows Fluent），与「纯中性、无系统红」的浅色板并置时非常跳。token 已有 `--window-close-bg` 却不用。
- 全局 tab active `box-shadow: 0 0 0 1px var(--border-color)` 再加 `border-color`（`GlobalSessionTabBar.module.css:162–166`）—— **双 1px 描边**，比未选 tab 厚一圈。`--z-sticky-bar` fallback 2，和 `--z-dock: 10` 不是同一档。

---

## 15. 文档声称已收口、代码仍在的断层

问题同权，不因「历史战役已打勾」省略。

| 声称 | 出处 | 代码事实 |
| --- | --- | --- |
| `shell-scrollbar.css` 唯一出口，基线 5，生产命中 1 文件 | `frontend-audit/60-repair2` 终报、`style-contract.test.ts:227–231` | 文件已删；`::-webkit-scrollbar` = 0；侧栏原生条 |
| 禁裸混色消费点 ≤3 | `style-contract` ②，基线 3 | ratchet 只管 `color-mix(… --text-primary N%` 一种形态；Button overlay、rgba(128,128,128,0.12) fallback、accent-green 18% 都不计入 |
| 禁裸 999px ≤62 | `style-contract` ③ | 62 处胶囊合法存在，与 7px 锁冲突被契约保护 |
| tokens 唯一源 / 原子 100% token、0 hex | `themeStore.ts:15`、各原子 CSS 文件头、`ui/README.md:28–32` | 原子里写死 32px 高、20px 不在原子而在 Composer；tokens 自己 hex/rgba；themePersonalization 运行时改色 |
| z-index 运行期唯一真值 = `z-index.css` | `ui/README.md:38` | tokens.css 无层定义同名变量，级联上它说了算 |
| Tooltip WO-08 根除残影 | `Tooltip.tsx:6–7` | 无 delayShow、无单例、enter 仍 scale、真机残影 |
| T05.2 核心弹窗已收敛到 ui/Dialog | `ui/README.md:46` | 设置是 fullscreen Dialog；另有 SettingsUI 私有 tooltip、PermissionModeMenu 私有壳、Toast 私有皮 |
| Menu 后续 12 套菜单收敛于此 | `ui/README.md:47` | PermissionModeMenu / ComposePlusMenu 项 / SettingsQuickMenu / 文件更多菜单仍各写圆角与 z |
| F7-F14 列出的 4 文件禁裸 z-index | `style-contract` 开头 | 其它文件 `--z-dropdown-menu` 等悬空；`--z-toast` 与 tooltip 9000 错档 |
| hover/active 禁裸混色、一律 `--tint-*` | `frontend-audit/20-proposals/01-style-unification-proposal.md` | Button 6%/12% 自建 overlay；浅色 soft-bg hover = rest |
| `theme-dark.css` 补丁面仍在扫描白名单 | `style-contract.test.ts:66`、`tokens.css:535` 注释 | 文件不在；暗色已在 tokens 后半 |
| `settings-base.css` / `shell-polish.css` 仍被当作例外登记 | `style-contract.test.ts:169–170, 247` | 生产不 import；快捷键还原钮还在依赖「.settings-shortcuts-filter-clear」这类全局类 |
| PE-05 Button 圆角只有 4/6/8 | `Button.tsx:6` | 密度档 5/7；用户锁 7；large lg=9 |
| TabStrip 是原子 | `ui/index.ts:53`、目录存在 | `TabStrip.module.css` 只剩 `.tabLabel` 省略号，主壳用 `GlobalSessionTabBar` / `LeafToolTabStrip` / 各私有 tab |

`00-调研边界.md` 已写：禁止把「浮层战役已收口」当真理。上表是同一类病在基座上的清单。

---

## 16. 其它基座裂缝（同权，不因「小」省略）

- **`--radius-2xl` = `--radius-xl`**，阶梯缺档（tokens 266–267）。
- **`--control-soft-bg-hover` 浅色 = `--control-soft-bg`**，hover 无背景变化（77–85）；契约 ⑦ 还锁死 4/4/8。
- **暗色 `--focus-ring-color` 30%**、**`--focus-ring-strong` 类型与浅色不一致**（§6）。
- **`elevation-2` = `elevation-3`**（`design-system.css:8–9`）。
- **动画时长双轨**：`--transition-fast: 150ms` 与 `--duration-fast: 150ms`；`--transition-micro: 100ms` 但 Button/Input fallback 写 **120ms**（`Button.module.css:47`、`Input.module.css:39`）。同一「micro」有 100 与 120。
- **`--transition-popover-enter: cubic-bezier(0.16, 1, 0.3, 1) 180ms`** 把函数和时长挤在一个 token 里；`animation: … var(--transition-popover-enter)` 合法，但 eco 把它整段置 `0ms` 后 `animation: cds-popover-enter 0ms` 仍引用不存在的关键帧。
- **字重**：`--font-weight-content: 600` 又 `--font-weight-semibold: var(--font-weight-content)`，同时还有 `--font-weight-heavy: 700`。设置标题用 semibold，空态英雄用 content，会话行用 medium 500。
- **`--opacity-disabled`** token 0.5（430），原子 fallback 0.45（`Button.module.css:85`）。禁用态深浅两套。
- **`::selection`** 9% 文字色（`design-system.css:22–25`），和 4% hover 不在同一套「淡染」。
- **TabStrip 空壳**：原子清单有、样式无，主壳各写各的 tab。
- **内联 style 逃逸**：`ModelConfigPanel.tsx:95–106` 颜色/字号/字重全内联；`App.tsx:221–231` 宽、过渡、overflow、zIndex 内联。token 再完整也打不进内联（除它自己写的 `var(--sidebar-width)`）。
- **`hsl()` 逗号 vs 空格** 在 tokens 内混用（§5）。
- **`--chat-footer-fade`** 渐变已 token 化（523–529），Composer footer 却用实底 `--composer-footer-bg`，浅色 transparent、暗色 `--bg-secondary`（70、582）——明暗 footer 结构不同。
- **xterm / mac traffic light / terminal prompt `#4ade80`** 是另一套高饱和色，出现在工作区终端里，和「纯中性壳」并置。

---

## 17. 与其它 7 维的交叉（本维不吞、不替它们收口）

| 交叉 | 本维记下的基座账 | 建议对方维 |
| --- | --- | --- |
| 01 点击果冻 | Switch 1.51、`--transition-enter/spring` 1.275、Button/会话/权限/Plus 的 scale、App 内联宽动画、Slider hover 1.15 | 01 扫交互；本维扫 token 默认值 |
| 02 Hover 提示 | 无 delayShow、无单例、原生 title、第二套 SettingsUI tooltip、Tooltip 用 `--shadow-lg` + scale 0.95 | 02 管互斥与残影逻辑 |
| 03 点击展开面板互斥 | 权限菜单与模型菜单两套壳、`--z-dropdown-menu` 悬空、幽灵 cds-popover | 03 管「同时只能开一个」 |
| 04 设置 7px | 密度档让 md 在 5/6/7 漂；设置页实测 4/6/7/8/9/12/999 | 04 若只改设置 CSS、不收口 token 档与 Button 注释，会回潮 |
| 05 侧栏原生滚动条 | 全局出口已删 + `.sidebarScroll` 无 reset | 05 可做侧栏，但没有全局契约则菜单/设置/Dialog 仍会出系统条 |
| 06 空叶「打开文件」 | `UnitChromeActions` 在每个 chat 叶常驻 | 06 管空叶信息架构；本维管它的 6px 钮 + Tooltip |
| 07 模型名重复等 | 非本维；模型设置页 7px/9px 混圆角、原生 title 连通性标签会一起入镜 | 07 |

---

## 18. 额外发现（任务外但相关）

- `style-contract` 的 `walkSrc` 用 `../../src/tokens.css` 当锚（`style-contract.test.ts:45`），该路径 **没有这个文件**；`new URL` 不读盘，strip 后碰巧得到 `src/` 根。锚点名是谎言，扫描范围碰巧对。
- `tokens.css` 中文注释在部分工具里显示为空框（编码/乱码观感），是否文件内混合损坏需主控用编辑器另核；本调研不把「注释乱码」写成已证实的源文件损坏。
- `themePersonalization.ts` 暮光逻辑会在 19:00–06:00 **改 `data-theme` 为 dark**（127），即使用户选了浅色。气质在夜间自动换盘，设置页「外观」与真机不一致。这是产品策略还是泄漏，需主控裁决；本维只记「基座色会在用户不知情时被时间改写」。

---

## 19. 总结

全局气质不是「再补几个 token」能糊上的。真机已经看见的违例，都能在基座上对到具体行：

1. **`--radius-md` 在 5 / 6 / 7 之间漂**，语义别名在密度档下脱离标尺，消费点 fallback 还在 6/7/8 里猜；用户锁的设置 7px 不是契约，只是 `ModelsSettingsTab` 一处硬编码碰巧撞上。
2. **滚动条全局出口已删、契约仍报已收口**，侧栏/设置/菜单/对话框裸 `overflow-y: auto`，Windows 原生条必然出现。
3. **焦点环三套**（2px outline / 1.5px 6% 混色 / 各业务 2–3–6px），暗色 30% 远超 §13 的 10% 上限。
4. **颜色三源**（tokens + setProperty 皮肤/时光 + loader 私有盘），HSLA 铁律在 tokens 自身就被 hex/rgba/逗号 hsl 打破。
5. **z-index 双源 + 一串悬空名**（`--z-dropdown-menu` / `--z-drag-overlay` / `--z-sticky-bar` / `--radius-tooltip` / `--line-height-normal`）。
6. **过弹写在 token 与原子里**（1.275 / 1.51 / scale 0.98），主壳宽动画还内联绕开 eco。
7. **原生 title 与 ui/Tooltip 双轨**，Tooltip 无单例、无延迟出现，设置还有第三套 tooltip 皮。
8. **主壳五块皮（App / 树 / 设置 / 侧栏 / Composer）圆角分别是 4、6、7、8、12、20、50%、999**，分割线 0.5px/1px/无，字号 10.5 到 clamp(34px)，控件高 24/26/28/32/36 挤在同一条顶栏。
9. **历史文档（R2-7、WO-08、PE-05、ui/README、style-contract 白名单）把已删文件和已打脸的残影写成终态**——边界文档说的「不要把收口当真理」，本维核实了基座上也成立。

本文件是该维唯一产出。实现与收口等主控合并 `00-总方案` 后再派；本代理不改代码、不提交、不写第二份文档。
