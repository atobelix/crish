# 16 · 权限丸 / 模型徽标四击与 `no-drag`

> 2026-08-19。桌面界面一致性战役 `survey/16`。调研/审计子代理。主控调度。  
> **只列问题。不改产品源码、不 git、不实现、不派子代理、不写第二份文档、不宣称已修好。**  
> 问题同权：下列条目不分 P0/P1，不按「好修 / 难修 / 业界都用 X」砍。  
> 遵守 `docs/agent-roles/general_task/三原则.md`、根 `AGENTS.md`、列问题方式 `docs/agent-roles/prompts/分析审计-列问题.md`。  
> 必读对读：`survey/10`、`survey/12`、`00-总方案` I3、`menuOpenGuard.ts`、LayerStack、`PermissionModeMenu`、`ComposerFusedTrigger`、`ModelBadgePickerMenu`、`ChatHeaderControls`、`ui/Menu`。

用户真机（本轮未连 `:9222` 复拍，class 以用户圈注为准）：

| 用户圈注 | 现码身份 |
| --- | --- |
| `class="_permPill_15rvl_1 no-drag"` | `PermissionModeMenu.module.css` `.permPill`；哈希相对 survey/10 的 `_permPill_icyue_1` 已换（I1 去掉 `:active scale` 后 CSS Modules 重算）。`no-drag` 是**额外字符串 class**，不是 CSS Modules 哈希。 |
| `class="_modelBadge_17hl8_137"` | `ChatCard.module.css` `.modelBadge`，**渲染在** `ChatHeaderControls.tsx` 的 `ModelBadgePicker`，经 `ChatCard` `rightActions` 塞进 `ComposerFusedTrigger` 的 `.left`。用户说「不一定是 composer 融合槽」——**组件文件名是 Header，挂载点是 Composer 底栏右**。没有第二份顶栏徽标。其它按钮（加号、撤回、思考档）用户未圈四击。 |

I3 声称（`docs/desktop-ui-repair/execution/第1轮实现.md:9`）：`toggleExclusiveMenu`；模型徽标改 Anchor；LayerStack 驱逐同级。第 2 轮审计写「点名控件真」。真机仍四击 → I3 是**壳迁了、双写没拆干净**，不是「用户点错按钮」。

本会话对读时工作区**又叠了 I3 后续补丁**（药丸去掉字面 `no-drag`、Anchor 关则 `Menu` `return null`、父级 `{open ? <Menu/> : null}`）。真机 class 仍带 `no-drag`，说明用户正在跑的 WebView2 包 ≠ 本工作区此刻的 JSX。下面机制按「仍会四击」写；补丁覆盖了哪一层、没覆盖哪一层单独标。**不把工作区补丁写成真机已修好。**

---

## 0. 结论先行（任务必答）

### 0.1 现在还有几处模型徽标 / 权限丸触发器？header 的 modelBadge 是否仍用 Radix Trigger / `setOpen(!prev)`？

**生产触发器：权限丸 1 处，模型徽标 1 处。没有独立顶栏徽标。**

| # | 用户看见 | 文件 | 模式（现码） | Radix Trigger？ | `setOpen(!prev)`？ |
| --- | --- | --- | --- | --- | --- |
| 1 | `_permPill_*` 药丸 | `PermissionModeMenu.tsx:68-86` 按钮 + `:88-127` `Menu` | `anchor={pillBtnRef}` | **否** | **否**。`toggleExclusiveMenu(open, setOpen, pillBtnRef.current)`（`:47-49`） |
| 2 | `_modelBadge_*` 徽标 | `ChatHeaderControls.tsx:154-186` 按钮 + `:187-198` `ModelBadgePickerMenu` | `anchor={badgeRef}` | **否** | **否**。`toggleExclusiveMenu(showModelDropdown, setShowModelDropdown, badgeRef.current)`（`:127-133`） |
| — | `.left` 槽 | `ComposerFusedTrigger.tsx:91` | 无 `onClick` 的包层 `div` | — | — |
| — | 思考档（同胶囊右半，用户未圈） | `ComposerFusedTrigger.tsx:99-150` | 与权限丸同构 Anchor | 否 | 否，同样 `toggleExclusiveMenu`（`:107`） |
| — | 加号 | `ChatComposer.tsx:379-415` | Anchor；`if (!open) return null` | 否 | 否。`if (showPlusMenu) set(false) else set(true)` + `shouldSuppressMenuReopen` |

`ModelBadgePicker` **只**从 `ChatCard.tsx:65-74` 注入 `ChatComposer.rightActions`。全仓生产没有第二处 `<ModelBadgePicker`。`ChatHeaderControls.tsx` 这个文件名是历史壳：它同时导出 `useModelSelection` 和徽标，**不**渲染对话顶栏。`PhysicalGeometryGuards.test.tsx` 里「顶栏 ModelBadgePickerMenu」是 600×400 **测夹具**，不是生产顶栏。

`ChatStatusRibbons` 的「选择模型」走 `onOpenModelDropdown: () => state.setShowModelDropdown(true)`（`ChatCard.tsx:94`）——**只写 true，不是第二枚徽标，也不 toggle**。

header / 生产徽标：**已经不是** `Popover.Trigger` + `setOpen(prev => !prev)`。I3 这一层壳是真的。四击剩下的是：外点 `setOpen(false)` 之后，**同一 click 上的 `toggleExclusiveMenu` 读到的 `open` 已是 false，再写成 true**。

仍走 `Popover.Trigger` 的别人家菜单（用户说「其它按钮没有」）：`ChatHeaderMore.tsx:62-72`、`Select.tsx:168-188`、`SettingsQuickMenu.tsx:235` `trigger={finalTrigger}` 且按钮 `onClick: () => handleOpenChange(!open)`（`:191`）。设置是**闭包绝对值两次都写 false**，不是函数式取反。

### 0.2 四击的精确事件序（外点关 → 再 toggle 开）

I3 之后**不再**是 `setOpen(prev => !prev)` 自己翻。现码是：

```
开着时点药丸/徽标
  → pointerdown 捕获：LayerStack 若认不成锚，当外点 setOpen(false)
  → React 18/19 discrete flush：open 变 false，onClick 换成「关着」那一版
  → 同一物理点击的 click：toggleExclusiveMenu(false, setOpen, el)
       shouldSuppress 没命中 → setOpen(true)
  → 用户看见：点了还开着（关完立刻开）
下一击重复。若干次里有一次 suppress 命中、或 contains 碰巧成功只写 false，才关上。
用户语言「四击」= 开 1 + 失败关 2～3，不必停在第 4。
```

`toggleExclusiveMenu` 读的是**上一帧布尔值**，不是 `setOpen(v => !v)`，也不是 `setOpen(false)` 单向阀。`Menu.handleOpenChange` 里对 `true` 的吞掉（`:170-179`）**管不到**按钮这条 `setOpen(true)`——按钮绕过 Radix，直写父 state。

### 0.3 `no-drag`：窗拖排除 vs 误伤

- **原始意图**：frameless 窗把顶栏标成 `-webkit-app-region: drag` / `data-tauri-drag-region` 之后，子控件必须标 `no-drag`，否则 OS `HTCAPTION` 吞 click、整窗被拖走。浮层战役还要求 **Portal 根** 带 `-webkit-app-region: no-drag`，免得菜单盖到顶栏时被当标题栏。
- **现码契约已经裂成两截**：真正生效的是 CSS **属性** `-webkit-app-region: no-drag`（写在 `AppTopBar.module.css`、`WindowControls.module.css` 等）。全仓 **零条** `.no-drag { ... }` 选择器。JSX 上的字符串 `class="no-drag"` 对 Composer **是死 class**，不算 `app-region`。
- **误伤**：I3 之前 `Menu.tsx` `Popover.Trigger asChild className="no-drag"` 无条件拼到所有 Trigger 子节点；`permPill` 自己又拼一次。Composer 不在 drag region。徽标现码**从未**拼 `no-drag`，真机照样四击 → **死 class 不是四击因**。
- **该留**：顶栏/窗控/标签栏上的 **CSS 属性**（以及会盖到顶栏的 Portal 根上的属性）。`data-tauri-drag-region="false"` 已在 `WindowControls.tsx`。
- **多余**：Composer 药丸上的字符串 `no-drag`；`ComposePlusMenu` / `ChatHeaderMore` 面板 `contentClassName` 里的字符串 `no-drag`（`Menu.module.css` `.menuContent` **没有** `-webkit-app-region`；模型面板 `.mbMenu` 自己写了属性，不靠这个 class）。

### 0.4 和加号为什么能一开一关

不是「Anchor 魔法」。加号能关，是因为 **LayerStack 对 `plusBtnRef` 的 `contains` 经常成功**，pointerdown **不**当外点关，click 闭包里 `showPlusMenu` 仍是 true，走 `set(false)`。即便 contains 失败，加号还有：`if (!open) return null`（`ComposePlusMenu.tsx:94`）把整棵 Popover 卸掉；`onOpenChange` 只收 false。

权限/模型 I3 后开关函数已经「长得像加号」，但：(1) 仍用上一帧 `open` 作分支，flush 后会走「关着 → 写成 true」；(2) suppress 靠 DOM 节点身份，对不上就放行；(3) 真机包里药丸还带死 class、Menu 曾常挂在树上（工作区后补了关则卸载，真机未验证）。加号触发器是 `Button` forwardRef，权限/徽标是 Tooltip `cloneElement` 的原生 `button`。

---

## 1. 运行时身份与挂载链

### 1.1 权限丸

```
ChatComposer.tsx:416-423
  <PermissionModeMenu mode onChange />
PermissionModeMenu.tsx:68-86
  Tooltip(disabled={open})
    button.permPill          ← pillBtnRef，onClick=handleToggle
  {open ? <Menu anchor={pillBtnRef} /> : null}   ← 工作区后补；真机包可能仍常挂
```

`className` 工作区此刻是 `[styles.permPill, open ? styles.isOpen : null]`（`:71-73`），**不再**拼 `no-drag`。测 `PermissionModeMenu.test.tsx:117-121` 断言药丸 **不**含 `\bno-drag\b`。用户真机 `_permPill_15rvl_1 no-drag` = 仍在跑拼了该字符串的包。

### 1.2 模型徽标（只有这一处生产）

```
ChatCard.tsx:65-74
  rightActions={<ModelBadgePicker showModelDropdown setShowModelDropdown />}
ChatComposer.tsx:442-443
  <ComposerFusedTrigger>{rightActions}</ComposerFusedTrigger>
ComposerFusedTrigger.tsx:91
  <div className={styles.left}>{children}</div>     ← 无行为
ChatHeaderControls.tsx:154-198
  Tooltip > button.modelBadge (badgeRef, onClick=handleBadgeClick)
  {showModelDropdown ? <ModelBadgePickerMenu anchor={badgeRef} /> : null}
```

用户点的是 `button.modelBadge`（`data-testid="model-selector-button"`），不是 `.left`。survey/10 把 `_left_*` 当触发器，是槽位；本轮用户圈的 class 更准。

徽标 **没有** `no-drag` 字符串（`:157`）。`permAndModelExclusive.test.tsx:63` 也断言不含。四击与 `no-drag` 无关。

### 1.3 I3 迁了什么、没迁什么

| 维度 | survey/10（I3 前） | 工作区现码（I3 + 后补） | 真机仍报 |
| --- | --- | --- | --- |
| 权限 Menu | 已是 Anchor | Anchor；`{open ? Menu : null}`；基座 `anchor && !isOpen → return null`（`Menu.tsx:352-355`） | 四击 |
| 权限开关 | `setOpen(prev => !prev)` | `toggleExclusiveMenu(open, setOpen, el)` | 四击 |
| 模型 Menu | **Trigger** `trigger={children}` | **Anchor** `anchor={badgeRef}` | 四击 |
| 模型开关 | Radix `onOpenToggle = !prev` | `toggleExclusiveMenu` | 四击 |
| `onOpenChange` | 通吃 true/false | 只收 false（权限 `:92-94`，徽标 `:191-193`） | — |
| 基座 Trigger `no-drag` | `asChild className="no-drag"` | 已删（`Menu.tsx:328-331` 注释 + `:331` 无 class） | 药丸 class 仍见 `no-drag` |
| LayerStack | 只入栈 | `evictExclusivePeers` + `dismissedByPointer` | 会话右键已 `useLayerRegistration`（`SessionContextMenu.tsx:118-129`） |

I3 把「Trigger + `!prev`」换成「Anchor + 上一帧布尔值分支 + suppress」。**第二写者还在。** 注释「与加号同构」（`PermissionModeMenu.tsx:19-22`、`ModelBadgePickerMenu.tsx:23-26`）相对 Trigger 时代是真的，相对「一击关」是假关。

---

## 2. 四击事件序（逐步，现码）

### 2.1 三个写 `open` 的人

| 谁 | 何时 | 写什么 |
| --- | --- | --- |
| LayerStack `handleGlobalPointerDown` | window/document **捕获** `pointerdown` | 认成外点 → `onDismiss` → `handleOpenChange(false)` → 父 `setOpen(false)`；并记 `dismissedByPointer`（`LayerStackManager.ts:519-571`） |
| Radix DismissableLayer | Content 在树上时：`pointerdown` 记外点，左键 **推迟到 click**；click **捕获**里还 `setTimeout(0)` 再派一次（`react-dismissable-layer` `index.mjs:226-230, 267-272`） | 未 `preventDefault` 则 `onDismiss` → 再 `false`。Anchor 模式 **没有** `Popover.Trigger`，Radix 自己的 `triggerRef` 恒 null，药丸对 Radix 永远是 Content 外面 |
| 按钮 `toggleExclusiveMenu` | 目标阶段 `click`（Tooltip `handleClick` 先转发，`Tooltip.tsx:300-304`） | `if (open) setOpen(false); else setOpen(true)`。`open` 来自 `useCallback(..., [open])` **上一帧** |

`Menu.handleOpenChange` 对 `nextOpen===true` 会问 `wasLayerDismissedThisGesture(menuId)` 和 `shouldSuppressMenuReopen`（`Menu.tsx:170-179`）。这只挡住 **Radix → onOpenChange(true)**。按钮是 `setShowModelDropdown(true)` / `setOpen(true)` 直写，**不经过** `handleOpenChange`。

### 2.2 第一击：关 → 开（通常成功）

栈空，无 Content。

| 时刻 | 谁 | `open` |
| --- | --- | --- |
| pointerdown 捕获 | LayerStack：无 dismissible 层，return（`:537`） | false |
| click | `toggleExclusiveMenu(false, …)` → `setOpen(true)` | **true** |
| 提交 | Menu 挂上；`useLayerRegistration(active=true)` | true |

问题不在开。

### 2.3 第二击：用户以为在关（四击主路径）

菜单已开，指针还在药丸/徽标上。

```
T0  pointerdown  捕获（window 然后 document；WeakSet 去重）
    LayerStack.handleGlobalPointerDown  (LayerStackManager.ts:519)
      dismissedByPointer = null          // 每一击开头先清 ( :523 )
      顶层 dismissible = 本菜单
      Content.contains(药丸)?  否（按钮不在 portal 里）
      resolveElement(anchorRef).contains(event.target)?
        是 → anchorPointerDownTarget=target，return
             本层不关，dismissedByPointer 保持 null
        否（current 空 / 点到的节点不在按钮子树 / 顶层其实是另一层）
             → dismissedByPointer = {layerId, anchor, target}  (:564-569)
             → dismissLayer → setOpen(false)
             → 层出栈

T0' React discrete flush（pointerdown 结束后）
    若 T0 已 setOpen(false)：
      PermissionModeMenu / ModelBadgePicker 重渲
      handleToggle / handleBadgeClick 换成 open=false 那一版
      工作区：{open ? Menu : null} 卸掉 → Radix 监听随 Content unmount 拆掉
      Tooltip disabled={open} 变 false → cloneElement + useMergeRefs 新回调
        （Tooltip.tsx:56-65：deps 是 rest 数组，每渲新 identity）
        提交期可能 oldRef(null) 再 newRef(node)

T1  若 Menu 还在：Radix DismissableLayer 的 pointerdown（document 冒泡，比 LayerStack 捕获晚）
    药丸不在 Content → 记外点；左键 defer，挂 document click once

T2  click 目标阶段
    Tooltip.handleClick → child.onClick = handleToggle/handleBadgeClick
    toggleExclusiveMenu(open_from_last_render, setOpen, ref.current)
      A. shouldSuppressMenuReopen(el) === true  → return，保持关     用户如愿
      B. 否，且 open===true（T0 没关、没 flush）→ setOpen(false)     用户如愿
      C. 否，且 open===false（T0 已关并 flush）→ setOpen(true)      【重开】

T3  同一 click：Radix document 上 once 的 click，以及捕获阶段 setTimeout(0)
    （index.mjs:226-230, 270-272）
    若 Content 已卸：监听应已 remove；setTimeout 仍可能跑到卸载后的闭包
    若还在：onPointerDownOutside → Menu.tsx:375-384
      anchor.contains(originalEvent.target) → preventDefault，不 onDismiss
      contains 失败 → onOpenChange(false)（已是 false 则空写）
    这路写不出 true（父 onOpenChange 丢 true）。true 只来自 T2-C。
```

### 2.4 suppress 何时放行（T2-C 的条件）

`wasTriggerClickAfterDismiss`（`LayerStackManager.ts:149-178`）：

```
rec 空或 triggerEl 空 → false          // 开
rec.anchor 就是本按钮（或互相 contains）→ true   // 关
rec.anchor 是另一棵仍 connected 的树 → false     // 故意：互斥切换允许开 B
rec.anchor 空且 triggerEl.contains(rec.target) → true
否则 false
```

会走到 T2-C 的具体口：

1. **T0 contains 成功**（LayerStack 不当外点）→ `dismissedByPointer` 保持 null → suppress 恒 false。此时若 T0 **没有** flush 成 false，T2 的 `open` 仍是 true，走 B 关上——这是加号常走的路。  
   但若 T0 没关、**Radix 或别的写者**在 click 前把 open 写成 false 并 flush，T2 仍 suppress=false 且 open=false → C 重开。
2. **T0 contains 失败并 dismiss**，但 click 时 `pillBtnRef.current` / `badgeRef.current` 为 **null**（Tooltip `useMergeRefs` 换 identity、`disabled` 翻转）→ `shouldSuppress(null)` 直接 false。
3. **T0 记的 `rec.anchor` 是旧节点**（卸挂后 `.isConnected===false`），click 时 `triggerEl` 是新按钮：第一支相等失败；第二支要求 `isConnected`，旧节点跳过；第三支 `rec.anchor` 非空不走；return false。
4. **双 pointerdown**（推断，WebView2 兼容鼠标/HMR 第二份中枢）：第一发 dismiss 并记账，第二发 `:523` 再清 `dismissedByPointer`，层已空，记账丢了。

`isWithinCooldown(50)`（`:184-188`）在 `toggleExclusiveMenu` 里 **不问**。LayerStack dismiss 会 `markCloseTimestamp`，按钮看不见。

### 2.5 第三击、第四击

没有单独的「第三击状态机」。每一击都是 2.3。用户连点越快，越容易落在 pointerdown 关 + click 开 的窗口。点到药丸外面（输入、空白、菜单项）只有 `setOpen(false)`，没有取反 → 一击关。所以「点药丸不行，乱点一下反而行」。

思考档（`ComposerFusedTrigger.tsx:107`）同构，真机未圈，机制仍在。

---

## 3. 加号对照（为什么能一开一关）

`ChatComposer.tsx:389-398` + `ComposePlusMenu.tsx:94-111`：

```
onClick:
  if (shouldSuppressMenuReopen(plusBtnRef.current)) return;
  if (showPlusMenu) set(false); else set(true);
ComposePlusMenu:
  if (!open) return null;
  Menu anchor={plusBtnRef}  onOpenChange 只收 false
  项上 onPointerDown stopPropagation（:124）
```

| 若 pointerdown… | 加号 | 权限 / 徽标 |
| --- | --- | --- |
| contains **成功**（不当外点） | click 时 `showPlusMenu` 仍 true → `set(false)`。关。 | 同构应关。真机这两枚常走失败支，说明 **contains 对药丸/徽标失败率更高**，或 flush 后走了 C。 |
| contains **失败**（当外点） | 先 `set(false)`，整棵 Menu `return null`。click 靠 suppress。Button forwardRef 的节点比较稳，suppress 较易命中。 | 同一套 suppress，但 Tooltip 包原生 `button`，`useMergeRefs` 每渲换回调；徽标还在 `Suspense` 里（`ChatHeaderControls.tsx:145`）。节点身份更容易对不上。 |
| 关掉以后 | 树上看不到 `Popover.Root` | 工作区后补了父级条件挂载 + 基座 `anchor && !isOpen return null`（`Menu.tsx:352-355`）。**真机未验证已吃到这补丁。** I3 第一刀时权限 Menu **常挂** `open=false` 的 Root，关着的 DismissableLayer 还在听下一次外点。 |

加号触发器 **没有** `no-drag` 字符串，用户说加号正常 → 再证死 class 不是四击因。

设置快捷菜单能关是另一条巧合法：`handleOpenChange(!open)`（`SettingsQuickMenu.tsx:191`）在菜单开着时闭包 `open===true` → 写成 **false**；Radix 外点也是 false。两笔同向。把它改成 `toggleExclusiveMenu` 且 flush 后读到 false，设置会立刻加入四击名单。

---

## 4. `no-drag`：意图、死 class、该留/该删

### 4.1 意图（仍成立，但是另一层）

无框窗口：

- 顶栏 `.topBar` / `.rail` / `.main` / `.spacer`：`-webkit-app-region: drag`（`AppTopBar.module.css:18,28,63,74`）+ `data-tauri-drag-region`（`AppTopBar.tsx:105+`）。
- 可点子控件必须 **CSS 属性** `-webkit-app-region: no-drag`（同文件 `:47,93,111,130`；`WindowControls.module.css:6,23`）。缺了，click 变拖窗。
- Portal 盖到顶栏时，浮层根也要属性，否则 `WM_NCHITTEST` → `HTCAPTION`。历史战役写过；`ModelBadgePickerMenu.module.css:18,92` `.mbMenu` / `.mbSubMenu` **有属性**。`ui/Menu` `.menuContent`（`Menu.module.css:10-35`）**没有**。

### 4.2 死 class

全仓 `*.css` **没有** `.no-drag` 选择器（检索 0 条）。因此：

- `class="no-drag"` 单独出现 = 不产生 `app-region`。
- 顶栏按钮同时有模块 CSS 属性 **和** 字符串 class（`AppTopBar.tsx:126,166`）——属性生效，class 多余。
- Composer 底栏不是 drag region。药丸上的 `no-drag`（真机仍见；工作区 JSX 已去掉）对窗拖、对四击都是空操作。

### 4.3 该留

| 位置 | 形式 | 为什么 |
| --- | --- | --- |
| 顶栏侧栏钮 / 加号 / trail / 帮助 | CSS **属性** | 父级是 drag |
| 窗控 min/max/close | 属性 + `data-tauri-drag-region="false"` | 父级是 drag |
| 标签栏可点区 vs 拖区 | `GlobalSessionTabBar.module.css` 属性 | 切分拖窗与点选 |
| 会伸到顶栏的 Portal 根 | 属性（`.mbMenu` 已有；`.menuContent` 缺） | 防 HTCAPTION |

### 4.4 多余 / 误拼

| 位置 | 现码 | 判定 |
| --- | --- | --- |
| 真机 `permPill` 上的字符串 `no-drag` | 用户 DOM；工作区 `PermissionModeMenu.tsx:71-73` 已不拼 | Composer 非 drag；**多余**。测 `:117-121` 按「不该有」写。 |
| I3 前 `Menu` `Trigger asChild className="no-drag"` | 工作区已删（`Menu.tsx:328-331`） | 曾无条件污染所有 Trigger 子节点。测 `Menu.test.tsx:54-63` 锁「不再拼」。 |
| `ComposePlusMenu.tsx:111` `${styles.plusMenu} no-drag` | 还在；测还 **要求** 含 `no-drag`（`ComposePlusMenu.test.tsx:92`） | 面板不在 Composer drag 里；`.plusMenu` 只有 `min-width`（`ComposePlusMenu.module.css:9-11`），字符串无效。测把死 class 冻成契约。 |
| `ChatHeaderMore.tsx:75` 面板 `no-drag` | 还在 | 同上，死字符串。 |
| `ProjectPickerMenu.tsx:140` `sort-filter-menu open no-drag` | 还在 | 全局遗留类 + 死字符串。 |
| `SettingsSidebar` / `SidebarNav` / `SettingsTablist` 的 `no-drag` | 还在 | 侧栏一般不是 drag；若父级没 `app-region: drag`，同样是死的。 |
| 徽标按钮 | 从未拼 | 四击仍在 → **不是 no-drag 引起的**。 |

用户质疑「按钮还带 `no-drag`」：对真机药丸成立（死残留）；对工作区药丸 JSX 已剥；对 `Menu.Trigger` 工作区已剥。**不要**用剥 class 当四击修法。

---

## 5. 问题清单（同权，不排序）

分类只为好找，不表示优先级。

### 5.1 四击状态机（权限丸 × 模型徽标共用）

1. `toggleExclusiveMenu` 用**上一帧** `open` 分支，外点 flush 成 false 后同一 click 会 `setOpen(true)`。`menuOpenGuard.ts:14-22`。
2. 按钮直写 `setOpen(true)`，不经过 `Menu.handleOpenChange` 的吞 true（`Menu.tsx:170-179`）。权限 `PermissionModeMenu.tsx:47-49`；徽标 `ChatHeaderControls.tsx:127-133`。
3. `shouldSuppressMenuReopen` 完全依赖 `dismissedByPointer` 的节点身份；`triggerEl` 空则放行。`LayerStackManager.ts:149-151` + `menuOpenGuard.ts:7-11`。
4. `wasTriggerClickAfterDismiss`：`rec.anchor` 是**另一棵仍 connected 的树**时故意 return false（`:160-169`）。点药丸时若顶层其实是模型层，先关模型并记账模型锚，再 toggle 权限——权限 `open` 仍 false 会被写成 true（互斥开是产品要的；若两层已经只有一层，这条不会救四击）。
5. 每一击 `pointerdown` **先** `dismissedByPointer = null`（`:523`）。同一物理点击若出现第二次 pointerdown，记账被清掉。
6. `isWithinCooldown` 存在（`:184-188`）但 `toggleExclusiveMenu` 不问。
7. Anchor 模式没有 `Popover.Trigger`，Radix `triggerRef` 空，原厂「点 Trigger 不关」对药丸/徽标无效。`Menu.tsx:254-257` 只挂 `Popover.Anchor virtualRef`。
8. Radix 左键把 POINTER_DOWN_OUTSIDE 推迟到 click，并且 click 捕获里 `setTimeout(0)` 再跑（`react-dismissable-layer` `index.mjs:226-230, 267-272`）。与 React discrete flush、按钮 onClick 抢同一击。
9. `Menu.tsx:375-384` / `:386+`：外部一旦传入 `onPointerDownOutside` / `onInteractOutside` 就 **整段** `contains`+`preventDefault` 被 return 掉。`SettingsQuickMenu.tsx:224-228` 正在走 `onInteractOutside`。再抄设置会把锚点保护抄丢。

### 5.2 权限丸

10. 文件头仍写「加号同构、禁止与外点对打」（`PermissionModeMenu.tsx:19-22`）。真机四击。假关注释。
11. `handleToggle` `useCallback(..., [open])`（`:47-49`）：pointerdown flush 后 onClick 换成「关着」版本，正是重开所需的那一版。
12. Tooltip 包药丸（`:63-86`），`useMergeRefs` 每渲新回调（`Tooltip.tsx:56-65`），`disabled={open}` 翻转时提交期 ref 先 null 后挂回 → LayerStack `contains` 与 suppress 同时变脆。
13. 真机 class 仍含 `no-drag`；工作区 JSX 已不拼。跑着的包和工作区不是同一份。
14. 项上再包 Tooltip + 打开即 focus 首项（`:104-124` + `Menu.tsx` 打开聚焦）。与 survey/02 / 12 的「计划项上冒少打扰」同族，会诱使连点。
15. `onChange` 里 `setShowPlusMenu(false)`（`ChatComposer.tsx:419-421`）只在**选中某档**时关加号，开权限时不关模型/思考。`ChatCard` 仍不传 `onCloseSiblingMenus`。
16. 测「pointerdown+click 药丸一次即关」（`PermissionModeMenu.test.tsx:103-115`）对 **按钮自己** `fireEvent`，jsdom 里 `contains(button)` 成功，不走 T2-C。假绿。
17. 测「药丸不带 no-drag」（`:117-121`）锁的是工作区 JSX，锁不住用户没热更新的 WebView2。

### 5.3 模型徽标（ChatHeaderControls，不是第二套顶栏）

18. 生产只有 `ChatCard.tsx:65-74` 这一处。没有 header 第二枚。排障若去顶栏会找错文件。
19. 文件名 `ChatHeaderControls.tsx` + CSS `ChatCard.module.css` + 挂载在 Composer `.left`：三处漂移。用户「不一定是融合槽」来自文件名，不是第二实例。
20. `handleBadgeClick` 同样闭包 `showModelDropdown`（`:127-133`）。状态在 `useChatModelPicker` / ChatCard，流式重渲更勤，flush 窗口更大。
21. 外层 `Suspense fallback={null}`（`:145`）。若有子树 suspend，整颗徽标卸成 null，ref 空，LayerStack 当外点。
22. `ModelBadgePickerMenu` 仍 `open = false` 默认（`:34`，I3 已从 `true` 改掉）。漏传不再常开。生产有传。
23. 子菜单 hover 80ms / leave 150ms（`ModelBadgePickerMenu.tsx:56-68`）让父重渲，放大 ref 抖动。卸载有清定时器（`:45-50`）。
24. 子菜单 `.mbSubMenu` 不是 LayerStack `cascade-submenu`，无 `parentId`。外点只打外层 Menu。
25. 测「点徽标第二次关闭」（`ModelBadgePickerMenu.test.tsx:229-241`）用**裸按钮** Wrapper，不包生产 Tooltip、不经 ChatCard 重渲。假绿。
26. `permAndModelExclusive.test.tsx:58-69` 同样 `pointerClick` 点在 testid 上，contains 成功支。

### 5.4 基座 Menu / LayerStack / Tooltip

27. 一套基座两套模式（`trigger` / `anchor`）。消费方都写 `<Menu>`，关闭语义不同。`ChatHeaderMore` / `Select` / `SettingsQuickMenu` 仍 Trigger。
28. 工作区 `Menu.tsx:352-355`：`anchor && !isOpen` 则 `return null`。与父级 `{open ? Menu : null}` **双卸载**。Trigger 模式关着 Root 仍在听。补丁范围只覆盖 Anchor。
29. Layer 接口 `onPointerDownOutside` 在 `useLayerRegistration.ts:59-60` 接了，`handleGlobalPointerDown` **从不调用**。
30. `handleGlobalPointerDown` 同时挂 window 与 document 捕获（`LayerStackManager.ts:422-430` 一带）。靠 WeakSet。HMR 丢掉单例另起一份会双中枢（推断）。
31. Tooltip `handleClick` 无条件调 `child.onClick` 再调 `rest.onClick`（`Tooltip.tsx:300-304`）。Trigger+Tooltip 时 rest 是 Radix toggle，打穿冷却——生产权限/徽标已不走 Trigger，这条是 **Trigger 残留菜单** 的雷。
32. `isTooltipSilenced()` 生产 Tooltip 仍可能不参与（survey/02）；关菜单那一帧 `disabled={false}`，指针还在按钮上 Tip 可立刻复活，视觉「没关掉」，诱使连点。

### 5.5 思考档 / 融合胶囊 / 互斥

33. 思考档与权限丸同构（`ComposerFusedTrigger.tsx:107, 113-150`）。用户没圈 ≠ 没有。
34. `.left` 模型与 `.right` 思考两个 `open`，中间 1px divider（`ComposerFusedTrigger.module.css:18-30`）。I3 `evictExclusivePeers` 登记时驱同级，**同胶囊两钮**应不能叠开；未在 9222 证实。
35. `onCloseSiblingMenus` 仍是死 prop（`ChatComposer` 可选，`ChatCard` 不传）。基座驱逐若漏一种 type，Composer 互斥仍空。
36. 斜杠 / @@ / 会话右键：右键已进 LayerStack（`SessionContextMenu.tsx:118-129`，`type: 'context-menu'`，与 dropdown 同属 exclusive peers）。斜杠仍裸 Radix，不登记（survey/12）。

### 5.6 `no-drag`

37. 全仓无 `.no-drag` 规则。字符串 class 在 Composer 是死的。
38. 真机药丸仍带该字符串；工作区已删。热更新/打包漂移。
39. `ComposePlusMenu.test.tsx:92` 把面板含 `no-drag` 写成正确契约，冻死 class。
40. `Menu.module.css` `.menuContent` 缺 `-webkit-app-region: no-drag`，字符串又不能补。菜单一旦画进顶栏 drag 区，click 会被 OS 吞——与四击不同因，但是同一标记体系的洞。
41. 顶栏真正该留的是 **属性**，不是 class 名。`AppTopBar.tsx` 两者都写，class 是重复。

### 5.7 测试与验收

42. 没有任何用例用真实顺序断言 `onOpenChange` 序列是 `[true, false]` 而不是 `[true, false, true]`：window 捕获 pointerdown（让 LayerStack 跑）→ **flush** → click，并且触发器外包生产 Tooltip。
43. `Menu.test.tsx`「Anchor 不振荡」即使用了 `toggleExclusiveMenu`，仍是裸按钮，无 Tooltip。
44. 没有「贴边 pointerdown、pointerup 落在外面」接在权限丸上的 drag-off 测（基座有裸按钮，`Menu.test.tsx` drag-off 段）。
45. 没有 9222 逐步打 log。本文件事件序是源码推演。

---

## 6. 与 survey/10、I3 声称的对照

| 10 / 总案 I3 | 现码 + 真机 |
| --- | --- |
| 模型仍 Trigger | **否**，已 Anchor + `badgeRef` |
| 权限 `!prev` | **否**，已 `toggleExclusiveMenu`，但上一帧布尔值在 flush 后等价于「关着再打开」 |
| 改成 Anchor 即根除 | **否**。权限早在 10 时已是 Anchor，I3 后又补卸载，真机仍四击 |
| 加号免疫因为 Anchor | 不完整。加号免疫因为 **contains 常成功** + 关则整棵卸 + 只收 false |
| 四击 = Trigger 与 Tooltip 抢 click | 生产这两枚已不走 Trigger。现主因是 **外点 false + 同一 click toggle 见 false 写成 true** |
| `no-drag` 无 CSS | 仍成立。真机药丸还带字符串；工作区 JSX 已剥；徽标从不带 |
| I3「模型徽标改 Anchor」当完成 | 壳真；效果锁「一开一关」假 |

---

## 7. 诚实边界

**做了什么：** 对读三原则、列问题提示、survey/10 与 12、总案 I3、第 1/2 轮执行文档；现码 `PermissionModeMenu` / `ChatHeaderControls` / `ModelBadgePickerMenu` / `ComposerFusedTrigger` / `ChatComposer` 加号 / `ChatCard` 挂载 / `menuOpenGuard` / `Menu.tsx` / `LayerStackManager` / `useLayerRegistration` / `Tooltip` / `SessionContextMenu` 登记 / Radix `react-dismissable-layer` 现版本；全仓 `no-drag` 字符串与 `-webkit-app-region` 属性对照；生产 `ModelBadgePicker` 引用点普查。

**做到什么程度：** 触发器处数、header 是否仍 Trigger/`!prev`、四击事件序、加号差异、`no-drag` 该留/多余，均有 `路径:行号`。

**没做 / 为什么：** 未连 `127.0.0.1:9222` 逐步打 log（任务只读调研）。因此「真机 contains 失败频率」「用户包是否已吃到关则 `return null`」标推断。未跑 vitest。本会话对读中工作区又叠了剥 `no-drag` / 关则卸载，**不能**把这些补丁写成用户已经验证通过。

**不确定（推断）：** 用户机器上的 `_permPill_15rvl_1 no-drag` 是未热更新的 I3 第一刀包，还是 CSS Modules 哈希 15rvl 来自别的 CSS 改动、class 列表仍含历史字符串。工作区 JSX 已不拼，故更像包漂移。思考档是否也被四击，真机未圈。

**额外发现（任务外但相关）：**

- `ChatHeaderControls.tsx` 名不副实，排障成本。
- `ComposePlusMenu` 测试把死 class `no-drag` 冻成绿。
- `.menuContent` 缺真正的 `-webkit-app-region: no-drag`，与字符串 `no-drag` 是两件事。
- `SettingsQuickMenu` 仍 Trigger + `handleOpenChange(!open)`，能关是两次 false 同向，不是可复制规范。
- `onCloseSiblingMenus` 仍死；斜杠仍不进栈。

**对派单 / 工作流：** 不要再派「改成 Anchor / 写 toggleExclusiveMenu / 去掉药丸 no-drag」当四击完成定义——这三件工作区已经有了，真机仍报。下一刀要派的是：**谁写 `open` 只许一个写者；同一 gesture 外点关后 click 不得 `set(true)`（按 gesture id / pointerId，不要只比 DOM 节点）；验收必须是 WebView2 上真实 `pointerdown → flush → click`，外加生产 Tooltip。** 剥死 class 可以做，但不要当四击修法。不要宣称已修好。

---

## 8. 给主控的总结

覆盖：生产权限丸 1 + 模型徽标 1（无独立 header 徽标；徽标不在 Trigger、不用 `!prev`）；四击精确序（外点 `false` → flush → `toggleExclusiveMenu` 见 false 写成 true）；加号差异（contains 成功率 + 关则卸载，不是 Anchor 咒语）；`no-drag` 原始窗拖意图 vs Composer 死 class vs 该留的 CSS 属性；每条问题带行号。

没覆盖：9222 录波；用户包是否已含本工作区后补卸载；思考档真机是否四击。

文档落点：仅 `docs/desktop-ui-repair/survey/16-权限丸模型徽标四击与no-drag.md`。

I3 把壳迁到加号附近，效果锁「一开一关」未落地。真机四击与工作区补丁并存，以真机为准。
