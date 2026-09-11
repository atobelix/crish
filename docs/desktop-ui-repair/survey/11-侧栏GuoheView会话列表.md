# 11 · 侧栏 GuoheView 会话列表（问题清单）

| 元数据 | 值 |
| --- | --- |
| **定位** | 桌面界面一致性战役 · 侧栏会话列表视觉/交互病全列。只列问题，不写实现、不改源码 |
| **日期** | 2026-08-19 |
| **真机** | `C:\Users\orange\Documents\ShareX\Screenshots\2026-08\GuoheView_5NYkOsmtPJ.png` |
| **上游** | `docs/desktop-ui-repair/00-调研边界.md`（用户锁 1–9；本图四圈） |
| **代码域** | `apps/crish-desktop/src/components/sidebar/**`；`ui/Tooltip/**`；`ui/Menu/**`；`ui/Button/**`；`styles/z-index.css`；`index.css` |
| **本文件职责** | 把侧栏所有视觉/交互病列全：Tooltip 孤儿与快移、更多按钮样式、右键定位、滚动条、虚拟列表回收、与叶工具条抢层，以及同源控件皮/果冻/圆角/层 token |
| **非职责** | 不实现、不提交、不写总案、**不建议搬参考仓/示例假侧栏** |
| **本会话手段** | 真机截图目视 + 源码通读。未在本会话对 WebView2 `:9222` 做 CDP 复验（标「推断」处以此为准） |

> 问题同权，分类只为检索，不是优先级。不写 P0/P1，不劝退，不把「浮层战役已收口」文档当真理。

---

## 0. 真机四圈（先对齐用户红圈）

截图左侧是产品侧栏（新对话 / 定时任务 / 搜索 / 项目 `conex` / 对话列表），右侧空白叶。用户红圈四处，与源码一一对得上：

| 圈 | 真机所见 | 用户口径 | 源码落点（机制，不是方案） |
| --- | --- | --- | --- |
| 1 | 项目行 `conex` 上漂着胶囊 `2026/08/16 01:55`，箭头朝下 | 该是相对时间的 hover，定位漂了 | `SessionRowTime` 把相对文案包进 `Tooltip content={timeAbsolute}`（`SessionRow.tsx:50-60`）；portal 到 `#tooltip-root`，`position:fixed`；无全局互斥 |
| 2 | 侧栏右缘 Windows 粗滚动条 + 上三角；菜单压在滚动条和列表上 | 原生粗滚动条；右键菜单压滚动条 | `.sidebarScroll { overflow-y: auto }` 无自定义滚动条；全仓 `::-webkit-scrollbar` 为 0；菜单 `clientX = 更多钮.right+4` |
| 3 | 会话行右侧灰圆角小方块，指针在上；同时还有「更多操作」胶囊 | 「更多」退化 + Tooltip 残影 | `Button variant="ghost" size="sm"` 的 `::before` 6% 遮罩 + 28×28 `--radius-md`；Tooltip 未因菜单打开而关 |
| 4 | 菜单：在此处打开 / 拆分视图 / 在新窗口打开 / 重命名 / 置顶 / 归档 / 分叉 / 复制会话 ID / 删除当前对话 / 导出 Markdown | 菜单项清单（对照用） | `SessionContextMenu.tsx:171-288` 手写 10 项；自研 portal，不走 `ui/Menu` |

截图还同时出现：**时间戳气泡 +「更多操作」+ 会话菜单** 三层叠开。这直接打脸调研边界锁 2（Hover 同一时间只能一个；快移一个也不显示）和锁 3（点击后展开的面板同一时间只能开一个）。

---

## 1. Tooltip 孤儿、快移、多层同开

### 1.1 无全局互斥：每个 `Tooltip` 各自为政

- `ui/Tooltip/Tooltip.tsx` 只有组件内 `visible` / `rect` / `clampedPos`，**没有**「当前唯一提示」登记。
- 测例只覆盖单实例 hover/leave/disabled/ref（`Tooltip.test.tsx`），**没有**「同时只许一个」或「快移全灭」的契约。
- 战役锁要求：同一时间只能一个；鼠标过快移动时一个也不显示。现码：扫过列表会按 `mouseenter` **立刻**弹出（无 `delayShow`、无速度阈值）。

### 1.2 会话行默认就叠三套提示

`SessionRow.tsx:335-378`：

1. 标题列 `Tooltip content={displayText}`（未截断也出）
2. 相对时间 `SessionRowTime` → 绝对时间 `toLocaleString`（即真机 `2026/08/16 01:55`，`sessionTime.ts:334-351`）
3. 更多钮 `Tooltip content="更多操作"`

外加菜单里「导出 Markdown」再包一层 `Tooltip content="导出为 Markdown"`（`SessionContextMenu.tsx:277-288`，文案与可见文字重复）。

分区按钮同样每颗一 Tip：项目 `FolderPlus`、文件夹新建、对话排序、对话新建（`ProjectsSection.tsx:96-161`，`GeneralSection.tsx:77-111`）；底栏设置齿轮、用户卡另算。侧栏是 Tip 矿。

### 1.3 时间 Tip 为什么看起来「漂」在项目名上

相对时间在行尾绝对定位（`.sessionTime`，`SidebarSessionList.module.css:384-400`），默认 `side="top"`、`TOOLTIP_GAP = 8`（`tooltipPositioning.ts:18,137-142`）。项目文件夹头只有 `min-height: 24px`，与首条会话垂直 gap 约 4px（`.folderGroup` / `.folderSessions`）。

结果：首条「3天前」的绝对时间胶囊**必然盖住**上一行「conex」文件夹头——真机圈 1 就是这个几何，不是「随机飞到屏幕外」，而是 **top 弹出 + 行距不够 + 长绝对时间水平居中后向左伸出**。用户观感就是「项目/会话上漂着时间戳」。

时间列 `max-width: 52px` 且 `overflow: hidden`，触发盒比文案「2026/08/16 01:55」窄得多，`translate(-50%, -100%)` 以窄盒中心为轴，胶囊中心相对「3天前」会明显左偏。

### 1.4 孤儿：新 Tip 不关旧 Tip

真机在圈 3 行上开菜单时，圈 1 的时间胶囊仍停在 `conex` 上。机制：

- 打开 B 的 Tip **不会** `setVisible(false)` 已经打开的 A。
- 滚动只更新当前实例的 `rect`（`Tooltip.tsx:152-166`），**不**在滚动/回收时强制关闭。
- `.sessionTime` 与 `.sessionActionsBtn` 叠在同一 `right:0` 槽（`SidebarSessionList.module.css:374-432`）。行 hover 才把更多钮从 `pointer-events: none` 改为 `auto`。**推断**（Chromium 常见）：指针未再移动时，把另一层叠上来不会补发 `mouseleave`，时间 Tip 可残留，直到指针挪 1px。这能解释「时间气泡还在、指针已经在更多上」。

### 1.5 菜单开着 Tip 不灭（残影）

`LayerStackManager` 注释写了 Tooltip 互斥协议：活跃浮层时打 `body[data-floating-active=true]`，CSS `:global(body[data-floating-active='true']) .tooltip { display: none }`（`LayerStackManager.ts:272-283`，`Tooltip.module.css:52-54`）。

但：

- `Tooltip.tsx` **从不**调用 `layerStackService.isTooltipSilenced()`，也 **不** `useLayerRegistration`。
- `SessionContextMenu` **从不**注册 layer（见 §3）。开会话菜单 **不会**置 `data-floating-active`。
- 因此那条 CSS 静默对会话右键菜单无效。真机：「更多操作」与菜单共存。
- `handlePointerDown` / `handleClick` 本意是点下去立刻藏 Tip（`Tooltip.tsx:259-272`）。真机仍显示，说明要么 click 没打到被 clone 的那层、要么藏完因 hover 态未清又被别的实例顶出来。**本会话未 CDP 逐步断事件**；现象本身已由截图钉死。

### 1.6 快移

无 show delay、无指针速度、无「移动中禁止展示」。从项目区扫到对话区会连续点亮标题 Tip + 时间 Tip。战役锁「过快则一个也不显示」现码零实现。

### 1.7 a11y 自相矛盾（体验旁支）

`<time aria-hidden>` 同时又被 Tip clone 打上 `aria-describedby`（`SessionRow.tsx:50-60`，`Tooltip.tsx:278-284`）。读屏要么听不到绝对时间，要么描述挂在 hidden 节点上。

---

## 2. 「更多」灰圆角小方块

真机圈 3：行尾一块发灰的圆角方，指针在上，⋯ 几乎看不清。

### 2.1 用了 `ui/Button` ghost/sm，把行尾图标皮盖掉

`SessionRow.tsx:352-377`：`Button variant="ghost" size="sm" className={styles.sessionActionsBtn}`。仓库另有 `IconButton`（正方形、可声明 tooltip），此处没用。

`Button.module.css`：

- sm = 高 28、水平 padding 10、`--btn-radius: var(--radius-md)`（6px）（`:99-107`）
- ghost hover：`::before` 铺 `color-mix(text-primary 6%, transparent)`（`:51-65,147-155`）
- `:active` 再 `transform: scale(0.98)`（`:72-74`）——果冻，见 §7

`.sessionActionsBtn` 想做成「默认透明、hover 才出的 28 图标」（`SidebarSessionList.module.css:402-437`），并写了 `background: none` / hover `background: transparent`，**关不掉** `::before` 遮罩。真机灰块 = 这层 6% 黑 + 6px 圆角 + 28×28 占满 28px 行。

### 2.2 与时间抢同一槽，几何挤

| 槽 | 尺寸 |
| --- | --- |
| `.sessionTrailing` | 宽 44、高 18（`:374-382`） |
| `.sessionTime` | `max-width: 52px`（比槽还宽 8px，`:395`） |
| `.sessionActionsBtn` | 28×28 absolute 居中（比槽高 10px） |
| `.sessionItem` / wrap | 高 28、`overflow: hidden` |

时间默认可见；行 hover 把时间 `opacity: 0`、更多 `opacity: 1`。两者绝对定位都在 `right:0`。28 钮在 28 行里就是一块实心方，不是「小 ⋯」。图标 `color: tertiary`（`#696969`）叠在 6% 遮罩上，真机像空灰块。

### 2.3 同源灰方会在分区钮上再现

`sectionNew` / `sectionSort` / `folderNewSession` 同样是 `Button ghost sm` + 22×22 本地类（`SidebarSessionList.module.css:110-241`）。截图没 hover 到它们，但皮是同一套。`「查看全部 (28)」` 也是 `Button ghost sm` 叠 `.sessionItem`（`ProjectsSection.tsx:206-219`）。

### 2.4 更多钮 `tabIndex={-1}`

键盘到不了更多，只能 Shift+F10 / ContextMenu 从行上合成菜单。与「指针点灰块」的鼠标路径分裂。

---

## 3. 右键/更多菜单：定位、层、双实现

### 3.1 更多钮把菜单锚在滚动条上

`openRowMenu` 对 `data-testid="session-more-button"` 走 `anchor: 'right-center'`（`SessionRow.tsx:209-221`）。合成坐标：

```
clientX = 钮.getBoundingClientRect().right + 4
clientY = 钮.top + 钮.height / 2
```

（`SessionRow.tsx:77-92`）

更多钮贴行右缘，+4px 正好进侧栏滚动槽。真机圈 2：菜单左缘压着粗滚动条，条目文字骑在滑块上。

真右键用指针 `clientX/Y`（`useSidebarContextMenu.ts:126-131`）。点在行中部会好一些；点行尾仍会压条。

### 3.2 两套 measureMenu，注释在撒谎

`SidebarContextMenus.tsx:57-58` 写「坐标钳位单源：`ui/Menu/position.ts`」。
`SessionContextMenu.tsx:23-51` **自己又写了一份** `measureMenu`：

- 只用 `window.innerWidth/Height`，不用 `visualViewport`，也没有 `position.ts` 的 Win32 最大化 8px 补偿
- 只在 `x+w > vw-8` 时往左翻；**没有**「避开侧栏滚动槽 / 避开叶工具条」的锚
- 估计高度写死 280；真机 10 项 + 3 条分割线高于此，首帧会先错再 `useLayoutEffect` 纠一次，可能闪

`ui/Menu/position.ts` 的 `calculateMenuPosition` / `getEffectiveViewport` 会话菜单根本没调用。`SidebarContextMenus.test.ts:8` 还说单测已收敛到 position——会话菜单这条路径裸奔。

### 3.3 不走 `ui/Menu`，不进 LayerStack

`SessionContextMenu`：`createPortal(..., document.body)`（`:157-290`），手写 button 列表。对比排序下拉走 `ui/Menu` + Radix + `useLayerRegistration`（`ContextMenuFlyout.tsx:247-276`，`Menu.tsx:167-180`）。

后果：

- 开会话菜单 **不**置 `data-floating-active` → Tip 不灭（§1.5）
- 与排序下拉、用户卡 `SettingsQuickMenu`、叶内菜单 **无**「同一时间一个面板」仲裁（战役锁 3）
- 外点关闭靠 `document` 的 `click`（`useSidebarContextMenu.ts:99-124`），不是 layer 的 pointer-down-outside；Esc 还双绑一份（hook + 菜单组件 `:142-155`）
- `sortMenuRef` 注释自己都说「外部持有但未挂到元素」（`ContextMenuFlyout.tsx:186-187`），hook 里 `sortMenuRef.current.contains` 常年空

### 3.4 `--z-context-menu` 未定义

`SessionContextMenu.tsx:165`：`zIndex: 'var(--z-context-menu)'`。
`styles/z-index.css` 只有 `--z-chrome/sidebar/dropdown/popover/modal/tooltip`（`:1-27`），**没有** `--z-context-menu`。整仓无 `--z-context-menu:` 赋值。

无效 `z-index` 按 `auto`。菜单能盖住文档流，只因 portal 在 `body` 后挂、且 `position:fixed`。挡不住 `z-index: 9000` 的 Tip（真机时间胶囊、「更多操作」都压在菜单/列表之上）。

同族空洞（侧栏会碰到）：

| 使用处 | token | 定义 |
| --- | --- | --- |
| 会话菜单 | `--z-context-menu` | 无 |
| 排序 flyout | `--z-sticky-bar`（`SidebarContextMenus.module.css:153`） | 无（别处有的写了 fallback 2/50） |
| 侧栏拖拽手柄 | `--z-sidebar-resizer`（`Sidebar.module.css:265`） | 无（真源是 `--z-resizer`） |
| 拖拽幽灵 | `--z-drag-overlay` | 侧栏 CSS 有 fallback 1000；`z-index.css` 无 |

### 3.5 菜单视觉（对照圈 4）

代码每项都有 14px lucide（`SessionContextMenu.tsx:171-288`），CSS 把 svg 涂成 `--text-tertiary`（`SidebarContextMenus.module.css:55-60`）。真机条目左侧像空的——不是没画图标，是 **tertiary 在 elevated 上过淡**，再叠加进场 `scale(0.96)`（`.contextMenu.open` + `crish-popover-enter`）。

其它：

- 打开后 rAF 聚焦第一项（`:124-140`）。程序化 `focus()` 对不上 `:focus-visible`，真机第一项没有可见焦框（`:focus-visible` 只有 inset 1px `--border-color`，本身也极弱，`:51-53`）。
- 「删除当前对话」inline `color: var(--text-danger)`（`:269`），与其它项 token 路径不一致。
- 「导出 Markdown」可见文字外再挂 Tip，菜单开着仍可再冒一层。
- 圆角 `--radius-2xl`（12px）vs `ui/Menu` 的 `--dropdown-radius`（`--radius-lg` = 8px）vs 行 `--radius-lg` vs 更多钮 6px。侧栏里圆角至少四档（战役锁 4：各种圆角满天飞要记清）。
- 归档/分叉/复制 ID 关菜单后丢进 `ToastStack`（`useSidebarContextMenu.ts:169-212`）。战役锁 8 的「最丑 Toast」侧栏也在喂。

### 3.6 菜单挂 `document.body`，不进 `#popover-root`

`index.html:45-49` 备了 `popover-root` / `tooltip-root` 等五槽。会话菜单忽略它们。Tip 进 `#tooltip-root`（在 `#root` 之后），菜单后插入 `body`。层顺序靠 DOM 追加时机 + 9000 vs auto，不是一张层表。

---

## 4. 滚动条退化（粗条 + 上下三角）

真机圈 2：经典 Windows 宽槽、深色滑块、顶部 ▲。这是 WebView2 在「始终显示滚动条」下的原生皮。

### 4.1 全局自定义滚动条文件不存在、也没接入

- `index.css:1-11` 只引入 tokens / design-system / shell-reset / shell-layout 等，**没有** scrollbar 样式表。
- `apps/crish-desktop` 下 `::-webkit-scrollbar` 命中数为 **0**（只剩 `style-contract.test.ts` 字符串）。
- 同测试仍写「基线 5 = `shell-scrollbar.css` 本体/track/thumb/hover/active」（`style-contract.test.ts:227-231`）。叶工具条还注释「3px 走 shell-scrollbar.css 的 `--scrollbar-thumb-width`」（`LeafToolTabStrip.module.css:38-41`）。**文件与 import 都不在。** 契约测试防的是「新增私有滚动条」，防不住「唯一出口被删光」。

### 4.2 侧栏滚动容器裸 `overflow-y: auto`

`Sidebar.module.css:40-48` `.sidebarScroll`：`flex:1; overflow-y:auto; padding:14px 10px; min-height:0`。没有：

- `scrollbar-width` / `scrollbar-color`
- `scrollbar-gutter: stable`
- overlay / 细条 token（`--tint-scrollbar-thumb` 在 `tokens.css:46-50` 定义了，侧栏不用）

对比：Composer、NotePaper、叶 tab 条至少写了 `scrollbar-width: thin`。侧栏没有。

### 4.3 滚动条吃布局，菜单再压上去

10px 右内边距 + 原生 ~17px 槽，行尾更多钮/时间贴着滑块。`scrollbar-gutter` 未开，有无溢出时布局还会抖。菜单 `right+4` 叠在槽上（§3.1）。`.sidebar { overflow: hidden }`（`:12`）裁的是侧栏盒，**裁不到** portal 菜单/Tip。

### 4.4 下拉自己也会出原生条

`.sortFilterMenu` / `.sortFilterFlyout` 都是 `overflow-y: auto`（`SidebarContextMenus.module.css:85-91,155-160`）。`ui/Menu` `.menuContent` 同样（`Menu.module.css:11-17`）。战役锁 5 点名「侧栏、设置页、下拉」——侧栏会话菜单短，截图没露出菜单内滚动条；排序下拉与 Menu 基座仍是同一条退化路径。

---

## 5. 虚拟列表、回收、暗挂载

窗口化只服务「对话」段，且阈值 48（`sessionListWindow.ts:13-17,127-138`；`useWindowedList.ts:62-68`）。项目文件夹、置顶 **从不**窗口化。

### 5.1 「查看全部」把溢出行继续挂在 `display:none` 里

项目（`ProjectsSection.tsx:176-204`）：

- 未展开：主列表前 6 条，**另外**把 `sess.slice(6)` 全部 `renderSessionItem` 进 `data-expanded="false"` 的手风琴（CSS `.accordionWrapper[data-expanded='false'] { display: none }`，`SidebarSessionList.module.css:33-35`）。
- 真机 `查看全部 (28)` → 另 22 行带着完整 `SessionRow` + 三套 Tooltip **暗挂着**。

对话段（`GeneralSection.tsx:48-51,148-164`）同样：未「查看全部」时窗口化只切前 10，**其余** `generalSessions.slice(10)` 仍全部渲染进折叠手风琴。窗口化阈值本意是 48+ 只挂可视+overscan；溢出暗挂把这个效果对冲掉。

`display:none` 的触发器 `getBoundingClientRect()` 为 0。若收起时 Tip 仍 `visible`（leave 没发），portal 会停在**上一帧坐标**——这是时间胶囊留在 `conex` 上的另一条机制（与 §1.4 并列，本会话未 CDP 二分哪条先触发）。

### 5.2 真窗口化回收

`WindowedSessionUl.tsx:43-72`：`slice(start,end)` + 上下 spacer。`key={s.id}`（`useSidebarSessionList.tsx:295-296`），换窗会卸载旧行。卸载应带走 Tip portal；**不会**把 Tip 状态复用到另一个 session。回收相关病更像：

- 滚动中 `scroll` 只改 `rect` 不关 Tip（`Tooltip.tsx:152-166`）
- 指针停在 spacer 上（空 `li`，`pointer-events: none`，`:502-508`）可能吃掉 leave
- 活动行靠 `ensureIndex` 强挂；其它行滚出即卸，hover 态不迁移

### 5.3 键盘落焦选择器与 CSS modules 脱节

`navigateSession` 去找 `.session-item`（`useSidebarSessionList.tsx:268-270,304`）。真实 class 是 `styles.sessionItem` 哈希名，DOM 上还有 `data-testid="sidebar-session-item"`。箭头选择后 **focus 常年打空**。窗口化时目标行还可能尚未挂上（`expandWindowToIndex` 随后才扩）。

### 5.4 搜索命中被扔掉

`void searchHit`（`SessionRow.tsx:200`）。`.sessionSearchSnippet` 等 `display: none`（`SidebarSessionList.module.css:357-362`）。搜得到行，但标题无高亮、无 snippet。不是本图红圈，是列表交互病。

### 5.5 `content-visibility: auto` 打在滚动根上

`.listScroll`（`SidebarSessionList.module.css:1-14`）`content-visibility: auto; contain-intrinsic-size: auto 60px`。这是整块列表根，不是行。对 `getBoundingClientRect` / 窗口计量的干扰标 **不确定**，需要真机 Performance/CDP；列入以免漏。

---

## 6. 与叶工具条抢层

截图菜单从侧栏右缘长进工作区空白。叶顶栏（未命名会话 ×、右侧一排工具）在菜单上方，这一帧没被盖住；几何上菜单再高就会进叶工具条。

### 6.1 叶工具条自己建了隔离层

`LeafToolTabStrip.module.css:21-23`：`position: relative; z-index: var(--z-sticky, 2); isolation: isolate`。这只在工作区层叠上下文里抬叶头。会话菜单 portal 在 `body`，一般仍盖在叶上。一旦 `--z-context-menu` 无效（§3.4），和叶内其它 `position`+`z-index` 节点的胜负改靠 DOM 顺序，**不是**设计好的「菜单 > 叶 chrome > 内容」。

### 6.2 Tip 9000 压一切

`--z-tooltip: 9000`（`z-index.css:26`）。时间胶囊、「更多操作」在真机上压过菜单、列表、滚动条。叶工具条自己的 Tip 也会在同一档。战役锁 2 的「同一时间一个 hover」跨侧栏/叶没有仲裁。

### 6.3 侧栏包装 `overflow: visible` + 宽度弹簧

`App.tsx:213-232`：`#crish-sidebar` `overflow: visible`、`transition: width 0.25s cubic-bezier(0.2, 0.8, 0.2, 1)`，hover 展开时 `z-index: var(--z-sidebar)`（100）。`.sidebar` 自己又 `z-index: var(--z-sidebar)` + `transition: width var(--transition-spring-layout)`（`Sidebar.module.css:9-14`）。双源宽度动画；折叠 hover 展开时侧栏 100 与叶头 `z-sticky=2` 比，侧栏（含其非 portal 子节点）会盖叶。菜单/Tip 已 portal，不吃这套，改吃 §3.4/§6.2。

### 6.4 拖拽幽灵走 tooltip 档

`useSessionListDrag.ts` 注释写 z 走 `--z-tooltip`。拖会话时幽灵与 Tip 同档，和叶 `isolation` 再抢一次。

---

## 7. 果冻点击与过弹运动

战役锁 1：点击果冻去掉。侧栏现码：

| 位置 | 行为 |
| --- | --- |
| `.sessionItem:active` | `transform: scale(0.985)` + `--transition-press`（`SidebarSessionList.module.css:282-285`） |
| `ui/Button:active` | `scale(0.98)`（`Button.module.css:72-74`）——新对话、定时任务、更多、分区 +、查看全部、排序全中 |
| `--transition-enter` / `--transition-spring` | 过冲 cubic-bezier `0.175, 0.885, 0.32, 1.275`（`tokens.css:306-308`）；菜单进场用的是另一条 `crish-popover-enter`（scale 0.96 + 上移 4px，`design-system.css:28-36`） |
| 侧栏宽 | `--transition-spring-layout` 220ms + App 里另一条 0.25s（§6.3） |

点会话行、点更多、点「新对话」都有按压缩放。截图停在 hover，没有拍到按下帧；源码路径在。

---

## 8. 圆角与控件皮不一致（侧栏内）

战役锁 4 点名设置页 7px，并要求把满天飞的圆角记清。侧栏当前：

| 元素 | 半径 |
| --- | --- |
| `.navItem`（新对话/定时/搜索壳） | `--radius-xl` 12px |
| `.sessionItem` | `--radius-lg` 8px |
| `.sessionActionsBtn` / Button sm | `--radius-md` 6px |
| `.sectionNew` / `.folderNewSession` | `--radius-xs` 2px |
| `.contextMenu` | `--radius-2xl` 12px |
| `ui/Menu` 排序下拉 | `--dropdown-radius` → `--radius-lg` 8px |
| `.settingsGearBtn` / `.userProfileCard` | `--radius-xl` 12px |
| `.modeChip` | `999px` 胶囊 |
| `.hamburger` | `--radius-md` |

同一条会话行：行 8px、更多 6px。同一侧栏：导航 12px、菜单 12px、下拉 8px、分区图标钮 2px。

导航还是 `Button ghost` + `.navItem` 双皮：Button `::before` 遮罩与 `.navItem:hover { background: var(--sidebar-hover) }` 叠（`SidebarNav.module.css:44-48,96-108`）。

搜索是 `input type="search"` 去了 webkit 取消钮（`SidebarNav.module.css:70-93`），壳仍是 `.navItem`。本图搜索看起来还贴着产品皮；**不确定**焦点时是否露出 WebView2 原生焦点环（锁 13 的焦点边框纪律）。

---

## 9. 列表结构 / 交互其它病

下列截图没红圈，但是同一侧栏域，同权收录。

1. **分区标题双点击面**：`sectionLabelRow` 整行 `onClick` 折叠，内部 `button.sectionLabel` 再 `stopPropagation` 折一次（`ProjectsSection.tsx:72-93` 等同构）。点文字走按钮，点行空白走 row，行为重复但不至于反折；键盘只落在按钮上，行 `cursor:pointer` 却不可聚焦。
2. **嵌套 `role="tree"`**：项目文件夹 `ul[role=tree]`，对话段又一个 `role=tree`，行是内层 `div role="treeitem"`（`SessionRow.tsx:237-248`）。多树并列，不是一棵。
3. **置顶空态**仍占一块「置顶的对话会出现在这里」（`PinnedSection.tsx:81-89`）。本图置顶已收起/为空，截图没画出来。
4. **时间格式混用**：相对（3天前/3周前）与绝对桶（`7/15`，`formatAbsoluteCalendarDate`）。同一列两种语法。
5. **分支标题**前缀 `分支:` 且 CSS `branchSession::before { display: none }`（`SessionRow.tsx:195-197`，`SidebarSessionList.module.css:308-314`）——分支只靠文案，没有视觉轨。
6. **运行中**用 spinner 换掉时间+更多（`SessionRow.tsx:341-348`），处理中的会话没有更多钮，只能右键。
7. **重命名** outline `accent-primary` 1.5px（`:463-468`），比锁 13「焦点混入 ≤10%」更跳。
8. **拖放指示** inset 2px accent 线（`.dropBefore/.dropAfter`）。
9. **运行脉冲** `session-running-pulse` 整行背景呼吸（`:486-500`）。
10. **iconCollapse** 把会话收成 8px 圆点（`Sidebar.module.css:375-409`）。本图不是折叠态；折叠视觉是另一套。
11. **overlay 模式** `.overlay` 仍写 `rgba(0,0,0,0.12)`（`Sidebar.module.css:300`），与 token/hsla 纪律不符。
12. **用户卡**默认 `username='orange'`、`workspaceName='Conex Workspace'`（`UserProfileCard.tsx:13`）——假名占位风险；本图没拍到底栏。
13. **CSS 注释乱码**（`SidebarSessionList.module.css` 多处），像编码被踩过，不影响运行，说明这张表被多次并行改。

---

## 10. 与战役锁的对照（侧栏范围）

| 锁 | 侧栏现状 |
| --- | --- |
| 1 果冻 | 会话行 0.985、Button 0.98、宽弹簧双源 |
| 2 Hover 唯一 / 快移全灭 | 无互斥、无快移抑制；真机双 Tip + 菜单 |
| 3 面板唯一 | 会话菜单不进 LayerStack；与排序/用户卡/叶菜单可叠 |
| 4 圆角记清 | 侧栏 2/6/8/12/999 并存（设置 7px 不是本文件主域，但要记） |
| 5 滚动条 | 侧栏原生粗条；全局 shell-scrollbar 缺失 |
| 8 Toast | 归档/分叉/复制 ID/导出失败都进 ToastStack |
| 9 本图四圈 | §0 已对齐；机制在 §1–4 |

禁止项（遵守，不在后文方案里破）：不搬参考仓假窗控 / demo-data / 竖轨；不把 5174 / mock / AI 图当验收；不把旧「浮层已收口」文档当结案。

---

## 11. 文件域速查（给后面分维，不是实现顺序）

| 域 | 路径 |
| --- | --- |
| 行 / 时间 / 更多 / 合成锚点 | `sidebar/session-list/SessionRow.tsx` |
| 行与槽样式、果冻、窗口 spacer | `sidebar/SidebarSessionList.module.css` |
| 窗口化切片 | `session-list/WindowedSessionUl.tsx`，`useWindowedList.ts`，`api/sessionListWindow.ts` |
| 项目/对话暗挂载 | `ProjectsSection.tsx`，`GeneralSection.tsx` |
| 会话菜单（双实现） | `SessionContextMenu.tsx`，`SidebarContextMenus.tsx`，`SidebarContextMenus.module.css` |
| 菜单状态与 toast | `useSidebarContextMenu.ts` |
| 排序下拉 | `ContextMenuFlyout.tsx`（`ui/Menu`） |
| 滚动根 | `Sidebar.module.css` `.sidebarScroll`；缺失的全局 scrollbar |
| Tip | `ui/Tooltip/Tooltip.tsx`，`tooltipPositioning.ts`，`Tooltip.module.css` |
| 更多钮皮 | `ui/Button/Button.module.css` + `.sessionActionsBtn` |
| 层 | `styles/z-index.css` vs 未定义 token；`LayerStackManager.ts`（协议未接到会话菜单/Tooltip） |
| 叶头 | `binary-tree/LeafToolTabStrip.module.css` |
| 侧栏壳 overflow/宽 | `App.tsx` `#crish-sidebar` |

---

## 12. 总结（给主控）

**覆盖了什么**

- 真机 `GuoheView_5NYkOsmtPJ.png` 四圈全部落到源码机制：时间 Tip 几何+孤儿、原生滚动条、更多灰方、菜单压槽。
- 任务点名的六块都写了：Tooltip 孤儿与快移、更多按钮样式、右键定位、滚动条、虚拟列表回收（含暗挂载）、与叶工具条抢层。
- 同权追加：果冻、圆角散、LayerStack 断线、`--z-context-menu` 空洞、菜单/Menu 双实现、注释撒谎、Toast 出口、搜索无高亮、键盘 `.session-item` 脱节。

**没覆盖 / 未验证**

- 本会话没有连 WebView2 `:9222` 复现 hover/click 时序，§1.4 pointer-events 补发 leave、§1.5 click 未藏 Tip、§5.1 与 §1.4 谁先造成 `conex` 残影，标为推断。
- 底栏用户卡、设置齿轮、排序 flyout、iconCollapse、overlay 汉堡不在本图里，只读了源码。
- 设置页/其它下拉的滚动条退化不在本文件域（锁 5 全局，本清单只钉侧栏+侧栏下拉）。
- 未跑单测/typecheck（只读任务）。

**文档落点**

- 仅此一份：`docs/desktop-ui-repair/survey/11-侧栏GuoheView会话列表.md`
- 未写第二份，未改源码，未 git，未向 `docs/agent-roles/shared-append/` 追加（任务禁止第二份文档）。

**额外发现（任务外但会害本战役）**

- 「浮层战役」的互斥协议写在 `LayerStackManager` + `data-floating-active` CSS 上，**会话右键菜单和 Tooltip 都没接线**，所以真机仍能三层叠开。后面总案若只改菜单坐标、不接层协议，圈 1/3 还会在。
- `shell-scrollbar.css` 被测试和叶 CSS 注释当成唯一出口，文件与 import 却是空的——侧栏粗条不是「漏写一行 overflow」，是全局出口消失。
- `SidebarContextMenus`「坐标单源 position.ts」是假收敛：会话菜单私有 `measureMenu` 仍在。

**工作流**

- 真机 ShareX 图在用户文档目录，不在仓库；调研文档应写绝对路径，避免后人找不到。
- 侧栏问题高度交叉（Tip × 层 × 滚动条 × 更多钮皮），分维时不要按文件切开后各改一刀（例如只把更多换成 IconButton、不关 Tip 互斥，灰方没了残影还在）。
