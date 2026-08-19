# 02 · Tooltip 单例、快移与残影

> 战役：`docs/desktop-ui-repair/`  
> 性质：只梳理问题。不改源码、不提交、不写实现、不派子代理。  
> 对照：调研边界 `docs/desktop-ui-repair/00-调研边界.md`；真机缺陷清单 `docs/chat-composer-plugin/execution/真机界面缺陷清单.md`。  
> 用户锁（本文件必须按此写，不得劝退）：**同一时间只能有一个 hover 提示层**；**鼠标过快移动时一个也不显示**；**残影 / 孤儿 tooltip 必须列为问题**。  
> 问题同权：下列条目不分 P0/P1，不按「好修 / 难修」砍。

本文件依据：现码 + 缺陷清单 + 浮层战役文档对照。工作区没有 `crish-agent-workbench_9lE3DwHRn9.png` / `rMF9MDKPPN.png` 文件；真机「空画布漂着多个『更多操作』『测试一下』、计划项上冒『少打扰』、滚动后残影」以用户圈注 + 源码机制对照，**未在本机开 9222 复拍**。

---

## 0. 结论先行

1. **用户锁 1（同时只能一个）未实现。** `ui/Tooltip` 每个实例各自 `useState(visible)`，仓库里没有 Tooltip 全局单例、没有「后来者关掉前者」、也没有「同一时刻最多一个 portal」。快扫侧栏一行就能同时亮标题 + 时间戳 +「更多操作」。
2. **用户锁 2（过快则一个也不显示）未实现，方向相反。** 组件**没有** `delayShow` / 意图停留 / 速度门限。`delayHide` 默认 `0`，生产调用方全未传。`mouseEnter` 同步 `handleShow`。测试还把「一进就亮」写成契约。快移会把路过的每一个都点亮，而不是全灭。
3. **用户锁 3（残影 / 孤儿）是现码可复述的机制，不是偶发。** 滚动只**重定位**、不关闭；浏览器滚动时常常**不发** `mouseleave`；`computeClampedPosition` 把已经滚出视口的合法 rect **钳回**视口内 8px 边。短列表（&lt; 48 行）窗口化根本不卸挂。于是「更多操作」「测试一下」、时间戳会离开侧栏，钉在空画布上。
4. **「计划项上冒少打扰」不是权限表写反。** `plan.matrixHint = '只读'`，`full.matrixHint = '少打扰'`。更像：菜单项外包 Tooltip + 打开时程序化 `focus` 当 hover + 默认 `side="top"` 盖住上一行 + 无单例。与 `survey/06` 第 0.3 节同向。
5. **「项目名上冒会话标题」同样不是文件夹绑错文案。** 项目名 `span.folderName` 没有 Tooltip；会话行标题 Tooltip 的 `content` 就是 `displayText`。邻行残影 / 无单例即可在文件夹头上看到上一行会话名。
6. **浮层战役「已修好」盖不住真机。** 文档里的 WO-08 是 **CSS keyframes 改名**；Tooltip 浮点化 / 防 FOUC 是 **WO-11**。`Tooltip.tsx` 文件头却自称 WO-08。WO-11 只做了首帧 `opacity: 0` 与钳位，**没有**单例、快移门限、滚出关闭、失焦关闭、菜单互斥的 React dismiss。`LayerStackManager.isTooltipSilenced()` **没有任何业务调用方**。调研边界写明：禁止把「浮层战役已收口」当真理。

---

## 1. 用户锁 vs 现码（对照表）

| 用户锁 | 现码 | 证据 |
| --- | --- | --- |
| 同一时间只能一个 hover 层 | 每实例独立 `visible`；portal 可并存 | `Tooltip.tsx` 90–94、345–383；无全局 store / 无 `activeTooltipId` |
| 过快移动一个也不显示 | 无 show delay；enter 立即 `setVisible(true)` | `Tooltip.tsx` 187–212；`TooltipProps` 70–76 只有 `delayHide` |
| 残影 / 孤儿必须修 | 滚动跟随不关闭；钳位把离屏触发器拉回视口；窗口化短名单不卸挂 | `Tooltip.tsx` 150–166、182；`tooltipPositioning.ts` 164–168；`sessionListWindow.ts` 14–17 |
| 菜单开时提示不该抢层 | CSS `display:none` 是视觉静音，不改 `visible`；会话右键不进 LayerStack | `Tooltip.module.css` 52–54；`LayerStackManager.ts` 152–161；`SessionContextMenu.tsx` 全程无 `useLayerRegistration` |

---

## 2. 基座：`ui/Tooltip` 做了什么、没做什么

入口：`apps/crish-desktop/src/components/ui/Tooltip/Tooltip.tsx`  
样式：`Tooltip.module.css`  
定位：`tooltipPositioning.ts`  
测试：`Tooltip.test.tsx`  
挂载点：`apps/crish-desktop/index.html` 48 `#tooltip-root`（缺则回落 `document.body`，`Tooltip.tsx` 380–382）

### 2.1 没有单例

- 每个 `<Tooltip>` 自己的 `visible` / `rect` / `clampedPos`（`Tooltip.tsx` 90–94）。
- `createPortal` 按实例挂到 `#tooltip-root`（348–383）。同时 hover 三个触发器 = 三个 `role="tooltip"`。
- `LayerType` 里有 `'tooltip'`（`layerStackTypes.ts` 15），**全仓没有** `type: 'tooltip'` 的 `register` 调用。Tooltip 不入栈，栈也就管不到「只留一个」。
- `hasActiveFloatingLayers` 还把 tooltip / toast **排除**在「活跃浮层」之外（`LayerStackManager.ts` 159–161），设计上就不把 Tooltip 当互斥层。

### 2.2 延迟：只有 hide，默认 0；没有 show

| 参数 | 现状 |
| --- | --- |
| `delayShow` | **不存在**（`TooltipProps` 70–76） |
| `delayHide` | 可选，默认 `0`（85）；`> 0` 才 `setTimeout` 再 `setVisible(false)`（199–205） |
| 生产传入 `delayHide` | **零处**（全仓除测试外无调用） |
| 测试 | `Tooltip.test.tsx` 38–57 用 `delayHide={300}` 断言「leave 后 250ms 仍可见」——这是 hide 延迟，与用户锁「快移不显示」相反 |

`handleShow`（187–195）在 `mouseEnter` /（通过守卫的）`focus` 上同步：清 hide 定时器、取 `getBoundingClientRect`、`setVisible(true)`。没有 rAF 合并、没有「指针还在才提交」、没有速度。

`handleMouseEnter`（208–212）先 `handleShow` 再转发给子元素。快扫 10 个按钮 = 10 次立即亮。

### 2.3 快移：现码会亮，测试还要求亮

`Tooltip.test.tsx` 25–36：`fireEvent.mouseEnter` 后立刻 `findByRole('tooltip')`。没有「enter 后马上 leave 则不应出现」的用例。门禁把「瞬时显示」冻成回归。

用户锁要的是意图停留（典型 300–500ms show delay + 离开取消 + 可选速度门）。现码零实现。

### 2.4 关闭路径（有 / 无）

**有：**

| 路径 | 位置 | 行为 |
| --- | --- | --- |
| `mouseLeave` | 214–217 | `handleHide`；默认立即 `setVisible(false)` |
| `blur` | 253–256 | 同上（键盘） |
| `pointerDown` / `click` 在**触发器上** | 259–272 | 立即 `setVisible(false)`（注释写「杜绝菜单展开时 Tooltip 悬浮残留」——只覆盖**点在这个触发器上**） |
| `disabled` / `content` 变空 | 143–148 | 立即关 |
| 组件卸载 | React 卸 portal | 窗口化真正卸行时 portal 会走 |

**无（与真机残影直接相关）：**

| 缺失 | 说明 |
| --- | --- |
| 滚动关闭 | `scroll` capture 只 `setRect`（150–166），**不** `setVisible(false)` |
| 触发器滚出 / 不可见 | 无 `IntersectionObserver`；不检查 `rect.bottom < 0` / `rect.top > vh` |
| 窗口失焦 / `visibilitychange` / `document.hidden` | Tooltip 目录零监听 |
| 指针已不在触发器上（滚动导致） | 依赖 `mouseleave`；滚动移走目标时浏览器经常**不发** leave |
| 菜单 / 右键 / Dialog 打开 | 不读 `isTooltipSilenced()`（全仓仅 `LayerStackManager.ts` 152–154 与其测试） |
| 虚拟列表回收后的 stale `childElRef` | 卸载可清 portal；未卸挂的离屏行仍用旧 ref 跟着钳位 |
| Esc | Tooltip 不注册 LayerStack，Esc 不管它 |

卸载清理只清 hide 定时器（115），没有「全局 dismiss 所有 tooltip」API。

### 2.5 「菜单开了就藏 Tooltip」是 CSS 静音，不是 dismiss

`Tooltip.module.css` 52–54：

```css
:global(body[data-floating-active='true']) .tooltip {
  display: none;
}
```

`LayerStackManager.updateFloatingActiveState`（274–286）在**非 tooltip / 非 toast** 层注册时给 `html` + `body` 打 `data-floating-active`。

缺陷：

1. **`useLayerRegistration` 在 `useEffect` 里注册**（`useLayerRegistration.ts` 31–64）。菜单首帧已经 `focus` 菜单项、Tooltip 已经 `handleShow`，属性还没打上。
2. `display: none` 不改 React `visible`。菜单关掉属性一摘，**原来还 visible 的 portal 原位复活**——典型残影。
3. 选择器会藏**所有**带模块 class 的 `.tooltip`，包括菜单**内部**的项上 Tooltip。若属性生效，权限菜单的 `matrixHint` 提示在开菜单期间根本看不见；若首帧 / 未注册层赶在属性之前，提示会闪或钉住。
4. `isTooltipSilenced()`（含 150ms 静默窗，287–291）**Tooltip.tsx 从不调用**。协议写在中枢注释里（`LayerStackManager.ts` 9），业务没接。
5. **会话右键不进栈**（见 §6.3），这条 CSS 对「更多操作」残影 + 右键菜单同时在，完全无效。

### 2.6 定位：跟随、钳位、漂移

`computeClampedPosition`（`tooltipPositioning.ts` 82–193）：

- 视口取 `visualViewport` 否则 `innerWidth/Height`，缺省 1280×800（88–95）。
- 空间不够则四向翻折（108–128）。
- **边缘钳位** `Math.max(TOOLTIP_EDGE_PAD, boxLeft)` 等（164–168），`TOOLTIP_EDGE_PAD = 8`（16）。

这就是「漂到画布 / 贴边」的数学来源：触发器已经在侧栏外（`top` 很负或很大），包围盒被 `max(8, 负数)` 拉到视口内 8px。分析文 `docs/frontend-floating-popover-analysis/05-Tooltip坐标坍塌与左上角漂移根因分析.md` 对 **全 0 rect → (8,8)** 的推导仍成立，但现码加了 `isValidDOMRect`：

- 生产：宽高都 ≤0 且在 (0,0) → 拒绝（`tooltipPositioning.ts` 40–47）；任一宽或高 ≤0 也拒绝（48–50）。
- **测试环境**对全 0 放行（29–38），单测抓不住坍塌。
- **不拒绝**：宽高合法但已经在视口外（滚动后的会话行）。钳位照样把盒子拖进画布。这是真机残影的主路径，不是 (0,0,0,0)。

`Tooltip.tsx` 359–366：`clampedPos == null` 时 `top/left` 回落 `rect.top/left`，`opacity: 0`。这是 WO-11 防 FOUC，**防的是首帧闪，不是孤儿**。

仍保留 `offsetWidth` / `offsetHeight` 回退（173–180）。WO-11 工单原文写「废除 offsetWidth 整型读取」（`02-全战役实施工单与机器真值验收矩阵.md` 453–454），与现码不一致。

滚动监听（150–166）只 `window` `scroll` capture + `resize`。没有 `ResizeObserver` 看触发器，Radix 菜单稍后位移时，若首帧 rect 已写入 state，不一定重测（05 分析文 3.3 节仍适用：只听 window 事件）。

CSS：`position: fixed`（`Tooltip.module.css` 5），`translateFor` 用 CSS 变量做锚点变换（`tooltipPositioning.ts` 55–66）。`side="top"` 时盒子在触发器**上方**。竖排菜单里，下一项的 tip 正好盖住上一项——「计划上冒少打扰」的几何假说。

### 2.7 动画与退出

`useAnimatedPresence({ visible, exitDurationMs: 0 })`（`Tooltip.tsx` 103–106）。`exitDurationMs <= 0` 时直接 `closed`（`useAnimatedPresence.ts` 42–43），portal 立即卸。`.tooltipExit`（`Tooltip.module.css` 14–16）在这条路径上几乎走不到。残影不是退场动画没播完，是 **`visible` 还是 true 的活实例**。

`.tooltip` 默认 `pointer-events: none`（7）。幽灵不抢点击，点空画布也不会走到触发器的 `mouseLeave`，所以点画布**关不掉**孤儿。

### 2.8 键盘 focus = hover

F7-F8 把 `onFocus` 当 `onMouseEnter`（221–251）。有 `:focus-visible` 守卫拦程序化 `focus()`（226–235），但：

- 测试环境 `activeElement` 对不上会放行（225 注释）；
- 用户真实 Tab 到菜单项、或焦点可见时，仍会 show；
- `Menu.tsx` 226–235 打开后 `items[focusedIndex].focus()`。若守卫在 WebView2 里没拦住，首项 Tooltip 必亮。

---

## 3. 真机现象 ↔ 代码路径

缺陷清单原文：侧栏 / 空画布漂着「更多操作」「测试一下」时间戳；计划项上冒「少打扰」；项目名上冒会话标题；滚过后无触发器仍显示。

### 3.1 「更多操作」孤儿

文案唯一定点：`SessionRow.tsx` 352–378，`content="更多操作"` 包三点 `Button`。同文案还有文件面板 / 技能页，但真机说的是侧栏滚过。

根因假设（机制可复述，未 9222 复拍）：

1. 悬停三点 → 该实例 `visible=true`，portal 进 `#tooltip-root`。
2. 滚侧栏。目标在指针下移走，**常常没有 `mouseleave`**。
3. `scroll` 监听更新 `rect` 为离屏坐标；`computeClampedPosition` 钳回视口 → 提示出现在主画布边缘 / 中央附近。
4. 列表 &lt; `SIDEBAR_WINDOW_THRESHOLD`（48）（`sessionListWindow.ts` 14）时 `WindowedSessionUl` 走全量挂载（28–41），行不卸，portal 不走。
5. 即使窗口化，`SIDEBAR_WINDOW_OVERSCAN = 8`（17）仍挂着约 224px 离屏行，照样钳位。
6. 无单例：再扫标题「测试一下」、时间戳，三个 portal 一起钉在空画布上。

点击三点会走 `handlePointerDown` 关掉**这一颗**（`Tooltip.tsx` 259–264），所以「点开右键后三点 tip 还在」更依赖：先悬停、再滚、或不点在按钮上；标题 / 时间戳的实例不受这次 pointerDown 影响。

### 3.2 「测试一下」与时间戳

- 标题：`SessionRow.tsx` 226 `tipContent = displayText`，335–339 包 `span.sessionTextCol`。「测试一下」就是某条会话的 `sessionListDisplayTitle`。
- 时间：`SessionRowTime` 50–60，`content={timeAbsolute || timeLabel}`。缺陷清单说的时间戳气泡是这个，不是系统 `title=`。

一行最多三颗独立 Tooltip（标题 / 时间或 spinner / 更多）。无单例 = 一行能同时亮两个以上。

### 3.3 滚动残影（与窗口化）

| 条件 | 行为 |
| --- | --- |
| 会话数 &lt; 48，未搜索 / 未拖拽 | 不窗口化，全部 `SessionRow` 常驻（`useWindowedList.ts` 63–68 + `WindowedSessionUl.tsx` 28–41） |
| ≥ 48 | `slice(start,end)` + spacer；滚出窗口的行卸载，portal 应随 Tooltip 卸载 |
| overscan 8 行 | 仍挂在 DOM，离屏 + 钳位 = 残影 |

主路径是**短列表不卸挂 + 滚动不发 leave + 钳位拉回视口**。真机侧栏通常远不到 48 条，「测试一下」这种标题更像短列表。

### 3.4 「计划项上冒少打扰」

权限表（`permissionModes.ts` 74–110）：

| id | label | matrixHint |
| --- | --- | --- |
| ask | 需确认 | 常用默认 |
| deep | 深入分析 | 同需确认 |
| plan | 计划 | **只读** |
| full | 完全访问 | **少打扰** |

`PermissionModeMenu.tsx` 51–55 按 `DESKTOP_PERMISSION_MODE_IDS`（ask → deep → **plan → full**）出 options。`renderItem`（92–116）每项：

```tsx
<Tooltip key={opt.id} content={itemMeta.matrixHint}>
  <button role="menuitem">…{itemMeta.label}…</button>
</Tooltip>
```

「少打扰」只绑在 **full / 完全访问**，没有绑在计划。错绑是层 / 几何 / 焦点，不是 meta 写反。

叠加：

1. **无单例**：焦点停在一项、指针在另一项，两颗 tip 可同时在。
2. **默认 `side` 是 `top`**（`Tooltip.tsx` 83）。完全访问在计划下面，它的 tip 画在自己上方 = 正盖在「计划」行上。用户看到的是「计划上写着少打扰」。
3. **`Menu.tsx` 201–206、226–235**：打开把 `focusedIndex` 设为首个未禁用项并 `focus()`。`renderItem` **没有** `onMouseEnter={() => setFocusedIndex(index)}`（默认按钮分支 430 行才有）。指针在「计划」上，ARIA 焦点可能还在「需确认」或键盘停过的「完全访问」。
4. **药丸 Tooltip**（63–66）：`content={当前权限模式：${label} · ${matrixHint}}`。当前若是完全访问，文案含「少打扰」。`disabled={open}` 应在开菜单后关掉，但 LayerStack 属性与 `visible` 不同步时，旧 portal 可在菜单上残一口。
5. **`data-floating-active` 若生效**，项上 Tooltip 开菜单期间被 CSS 藏掉，用户应看不到 matrixHint——与真机「看见了少打扰」相反，说明当时要么属性未打上（右键 / 时序），要么看到的是钳位残影而不是项上 tip。两条都要列，不靠猜砍。

同构：`ComposePlusMenu.tsx` 112–136、`Select.tsx` 95–98、`FontSelectField.tsx` 169–174 都是 **菜单项外包 Tooltip**。

### 3.5 「项目名上冒会话标题」

`ProjectsSection.tsx` 142：`<span className={styles.folderName}>{p.name}</span>`，**无 Tooltip**。项目行只有「在此项目新建对话」（144）。

会话标题 Tooltip 在子树 `SessionRow`（335）。根因假设：上一行会话的标题 portal 没关（滚动 / 快移 / 无单例），几何上落在文件夹头上。不是 `p.name` 被写成了会话名。

### 3.6 空画布多颗同时在

无单例 × 滚动不关闭 × 钳位拉回视口 × `pointer-events: none`（点画布关不掉）× 短列表不卸挂。与缺陷清单「侧栏干净、无残影气泡」金标相反。

---

## 4. 全仓谁在用 `ui/Tooltip`

产品实现只此一份：`apps/crish-desktop/src/components/ui/Tooltip/`。经 `ui/index.ts` 34–35 再出口。`packages/`、`apps/agent-workbench` 无引用。

`docs/composer-preview/src/ui/Tooltip.tsx` 是预览仓另一套（anchor + bubble，非 portal），**不是**产品壳。

### 4.1 基座与间接入口

| 路径 | 行号 | 用法 |
| --- | --- | --- |
| `ui/Tooltip/Tooltip.tsx` | 78–388 | 实现 |
| `ui/Button/IconButton.tsx` | 42–43 | `tooltip` prop 再包一层 |
| `ui/Menu/Menu.tsx` | 253–320 | 嗅探 trigger 的 `content`+`children`，拆开后重建 `<Tooltip disabled={isOpen}>` |
| `ui/Select/Select.tsx` | 95–98 | option.hint → 项上 Tooltip |

Menu 的嗅探（253–275）是「有 `content` 且有 `children` 就当 Tooltip」。别的组件若也叫这两个 prop，会被误拆。Anchor 模式（242–246，权限 / 加号 / 思考档）不走这条，项上 Tooltip 仍是消费方自己包的。

### 4.2 侧栏（真机残影主战场）

| 路径 | 行号 | content |
| --- | --- | --- |
| `sidebar/session-list/SessionRow.tsx` | 50, 335, 342, 352 | 绝对时间；会话标题；处理中；**更多操作** |
| `sidebar/session-list/ProjectsSection.tsx` | 96, 144 | 管理与选择项目；在此项目新建对话 |
| `sidebar/session-list/GeneralSection.tsx` | 77, 95 | 排序与过滤；新建常规对话 |
| `sidebar/SidebarFooter.tsx` | 28, 70, 98 | 用户/路径；开发切换；有新版本 |
| `sidebar/SessionContextMenu.tsx` | 277 | 导出为 Markdown（包在自绘右键项上） |
| `settings/SettingsQuickMenu.tsx` | 195 | 快捷设置（`disabled={open}`） |

### 4.3 Composer / 权限 / 模型（错绑 + 与菜单叠层）

| 路径 | 行号 | 说明 |
| --- | --- | --- |
| `chat-composer/PermissionModeMenu.tsx` | 63, 96 | 药丸；**每项 matrixHint**（少打扰在 full） |
| `chat-composer/ComposePlusMenu.tsx` | 113 | 每项 hint，与项内 `.desc` 重复 |
| `chat-composer/ComposerFusedTrigger.tsx` | 93 | 思考档，`disabled={open}` |
| `chat-composer/ChatComposer.tsx` | 378, 424 | 添加…（`disabled={showPlusMenu}`）；撤回 |
| `chat-composer/ComposerField.tsx` / `TiptapComposerField.tsx` | 发送 / 停止 | 注释写明禁止 native `title=` |
| `chat-composer/ComposerAttachmentBar.tsx` | 70, 103 | 附件名；移除 |
| `chat-composer/ComposerDirTree.tsx` | 221 | 上级目录 |
| `chat-composer/ChatQueuePanel.tsx` | 51, 62, 73, 84 | 队列正文 / 发送 / 编辑 / 删除 |
| `chat-card/ChatHeaderControls.tsx` | 137 | 模型徽标，`disabled={showModelDropdown}` |

### 4.4 会话头 / 空态 / 计划条

| 路径 | 行号 | 说明 |
| --- | --- | --- |
| `chat-card/PlanGoalRibbons.tsx` | 62, 68, 99, 110, 119 | 计划条文案 / 批准 / 目标 / 进度 / 停止。计划条 content 来自 `resolvePlanModeTitle`，**不是**「少打扰」 |
| `chat-card/DynamicChipBar.tsx` | 49, 67, 89 | 后台任务；**点击查看计划与进度详情**；代码变更 |
| `chat-card/ChatEmptyState.tsx` | 365 | 快捷 prompt |
| `chat-card/UnitChromeActions.tsx` | 166, 201 | 叶工具；展开右侧 |
| `chat-card/ProjectPickerMenu.tsx` | 216 | 从列表移除项目 |
| `chat-card/ChatMsgFilterBar.tsx` / `ApprovalDock.tsx` / `RunNoticeBar.tsx` / `ChatStatusRibbons.tsx` | 多处 | 筛选 / 审批 / 通知 / 回到最新 |

计划条与权限菜单是两套「计划」UI。真机「计划项」若指权限菜单四行之一，走 §3.4；若指 ribbon / chip，现码 content 不含「少打扰」。两处都记。

### 4.5 其余产品消费（同权罗列，不按重要性砍）

以下均为 `apps/crish-desktop/src` 内 `<Tooltip>`，同样受无单例 / 无快移门限 / 滚动不关闭约束。

- **顶栏 / 窗控 / 标签：** `top-bar/AppTopBar.tsx` 121, 161；`shell/WindowControls.tsx` 73, 85, 103；`shell/GlobalSessionTabBar.tsx` 294, 311
- **文件：** `files/FileActions.tsx`、`FileViewerCard.tsx`、`FileTreeView.tsx`、`FilesCard.tsx`、`FilePreview.tsx`、`FileBreadcrumb.tsx`（含「更多操作」）
- **Diff：** `diff/DiffHeaderControls.tsx`、`DiffCardFileList.tsx`、`DiffCardGitActions.tsx`、`DiffCard.tsx`
- **工具调用：** `chat-tool-call/ToolCallHeader.tsx`、`ToolCallInputPane.tsx`、`ToolCallOutputPane.tsx`
- **消息行：** `chat-message-row/*`（复制 / 重新生成 / 固定 / 思维链 / 搜索 / 建议）；`chat-message-list/MessageVirtualizer.tsx` 置顶条
- **Agent：** `agent-card/*`（状态点、审批、时间线、侧栏）
- **工作区：** `workspace/PreviewToolbar.tsx`、`PreviewHistoryPanel.tsx`、`PreviewCard.tsx`、`BrowserPanel.tsx`、`browser-panel/BrowserImportSection.tsx`、`computer-panel/ComputerPanel.tsx`、`TrashSection.tsx`、`ApprovalSection.tsx`、`BgTasksSection.tsx`、`FlowDagView.tsx`
- **Overview：** `OverviewHeader.tsx`、`OverviewGitTree.tsx`、`OverviewQuickActions.tsx`、`GitStatusBadge.tsx`、`ChangesSection.tsx`、`AgentSection.tsx`、`ProgressSection.tsx`
- **设置：** `settings/SettingsProfileTab.tsx`、`SettingsSecurityTab.tsx`、`SettingsShortcutsTab.tsx`、`SettingsSidebar.tsx`、`SettingsDevicesList.tsx`、`FontSettingsSection.tsx`、`FontSelectField.tsx`、`ImportRootsSection.tsx`、`ImportListSection.tsx`、`ExternalSessionImport.tsx`、`RunHistoryList.tsx`、`ScheduledTasksPanel.tsx`、`StatusDiagnosticsPanel.tsx`、`PriceConfigModal.tsx`、`WorkflowList.tsx`；`SettingsTablist.tsx`
- **模型设置：** `settings-models/ProfileHeader.tsx`、`ModelProfileList.tsx`、`ModelListHeader.tsx`、`ModelList.tsx`、`ModelConfigPanel.tsx`
- **技能 / 扩展：** `settings-skills/*`、`settings-extensions/ExtensionBody.tsx`、`McpToolsSection.tsx`
- **笔记纸：** `note-paper/NotePaperStrictHeader.tsx`、`MirrorDriftStatusBar.tsx`、`SendToNoteButton.tsx`
- **分屏叶：** `binary-tree/LeafToolTabStrip.tsx`
- **错误边界：** `AppErrorBoundary.tsx` 282, 326
- **叙事扩展：** `extensions/conversation-flow/ThinkingBlock.tsx`、`PermissionBar.tsx`

量级：生产 TSX **约 90+ 文件、200+ 处** `<Tooltip>`（含测试则更多）。全部走同一套无单例状态机。

---

## 5. 谁还在用原生 `title=`（会冒系统黄气泡）

`AGENTS.md` §12：悬停用项目 `<Tooltip>`，不要用原生 `title` 当主提示。下面只列**会进 DOM `title` 属性**的；`Dialog` / `ConfirmDialog` / `SettingsPage` / `SettingsSection` / `SettingsRow` / `AppErrorBoundary` / `RuntimeSection` 的 `title` prop 不是原生提示。

| 路径:行号 | DOM | 文案 / 含义 | 与 Tooltip 关系 |
| --- | --- | --- | --- |
| `workspace/TrashSection.tsx:151` | `span.rowTitle` | `entry.originalPath` | 同行操作钮已用 Tooltip（165, 183），路径本身原生 |
| `workspace/LiveTasksSection.tsx:60` | 可点击 `div` | `'打开对应会话'` | 无 Tooltip |
| `workspace/SecurityAuditSection.tsx:80` | `span.rowMeta` | `entry.targets.join('\n')` | 无 Tooltip |
| `workspace/RuntimePanel.tsx:98` | `div.engineStatus` | `formatEngineStatusTitle(...)` | 已有 `aria-label`，仍挂原生 title |
| `settings-skills/SkillEditorModal.tsx:123` | `label` | `s.description \|\| s.name` | 原生 |
| `settings-skills/SkillCardList.tsx:196` | `span.skillsActDot` | `actLabel` | 外层技能卡已有 Tooltip（171），圆点再挂原生 → **双提示** |
| `settings-models/ModelConfigPanel.tsx:108–110` | 延迟 `span` | 测试成功 / 失败 / error | 旁边按钮已是 Tooltip「测试连通性」（120） |

`chat-composer/ComposerField.tsx` 16 与测试 `ComposerField.stop.test.tsx` 明确禁 native `title=`。侧栏会话行没有原生 title，残影不是系统黄条，是 `#tooltip-root` 里的自定义层。

参考仓 / 预览仓另有原生 title（`reference/markdown-editor`、`reference/chat-composer-component`、`docs/composer-preview`），不进产品壳，但说明历史习惯还在仓库里。

---

## 6. 手写 hover 气泡

产品 `apps/crish-desktop/src`：**没有** `data-tooltip` + CSS `attr()` 气泡，没有 `.tooltip-bubble`。

仓库其它位置（不是工作台运行时）：

| 路径 | 形态 |
| --- | --- |
| `docs/composer-preview/src/ui/Tooltip.tsx` | 自写 anchor/bubble，`onMouseEnter` 无 portal、无单例 |
| `docs/composer-preview/src/styles/ui/index.css` | `.tooltip-bubble`，`--z-tooltip: 700` |
| `reference/ui-replica/showcase.css` 1553+ | `:hover .tooltip-bubble` |
| `reference/chat-composer-component/css/popovers.css` | `content: attr(data-tooltip)` |
| `blackhole/style.css` 607 | Floating Tooltip 样式 |

产品侧栏残影不是这套 CSS 气泡。

`Button.module.css` 的 `::before` 是点击 / hover 遮罩，不是文案层。

---

## 7. 与 Menu 同时：z-index 与事件抢占

### 7.1 档位

现码 `styles/z-index.css` 1–27 / `tokens.css` 391–398：

`--z-base 0 < --z-dock 10 < --z-chrome 100 < --z-dropdown 300 < --z-popover 500 < --z-modal 1000 < --z-tooltip 9000`

**没有** `--z-context-menu`、**没有** `--z-sticky-bar`。浮层战役收口文（`03-全战役收口总结` 196）写的是另一套（context-menu 1500、tooltip 2000、toast 3000），与现 token **不一致**。

后果：

| 层 | 声明 | 实际 |
| --- | --- | --- |
| Tooltip portal | `--z-tooltip` → 9000（`Tooltip.module.css` 6） | 高于几乎一切 |
| `ui/Menu` 面板 | `--z-dropdown` → 300（`Menu.module.css` 6） | 低于 Tooltip |
| 会话右键 | 内联 `zIndex: 'var(--z-context-menu)'`（`SessionContextMenu.tsx` 165） | 变量未定义 → **整条 z-index 无效**，相当于 auto |
| 排序飞出 | `--z-sticky-bar`（`SidebarContextMenus.module.css` 153） | 同样未定义 |

因此：**自定义 Tooltip 会画在 Menu / 右键上面。** `pointer-events: none` 不挡点击，但会挡住阅读——「菜单项上飘着另一行的 tip」。事件不抢，视觉抢。

`useSessionListDrag.ts` 把拖拽幽灵也标成 `z-index:var(--z-tooltip)`，拖拽与提示同档。

### 7.2 会话右键不进 LayerStack

`SessionContextMenu.tsx`：自绘 `createPortal(..., document.body)`，自己钳位（23–51）、自己 capture Esc（142–155）、**无** `useLayerRegistration`。`sidebar/` 下 grep `useLayerRegistration` / `layerStack` 为零。

所以：开右键 **不会** 打 `data-floating-active`，CSS 藏 Tooltip 不发生；行上「更多操作」/ 标题 portal 继续在；右键自己还有一颗「导出为 Markdown」Tooltip（277）。三点 `pointerDown` 只关三点那一颗，管不了标题 / 时间戳。

### 7.3 Menu 项上套 Tooltip

`PermissionModeMenu` / `ComposePlusMenu` / `Select` / `FontSelectField`：项是 Tooltip 包 `role="menuitem"` 按钮。

`Menu.tsx` 焦点移动（226–235）会对这些按钮 `focus()` → Tooltip `handleFocus`。`renderItem` 不更新 `focusedIndex` 的 hover。结果：焦点 tip 与指针 tip 不是同一项。

Trigger 外包时 Menu 会拆 Tooltip 并 `disabled={isOpen}`（318）。**项上**的包一层不会被拆，也不吃这个 disabled。

点击触发器关 tip（259–272）不管**已经亮着的别的实例**。

---

## 8. WO-08 / 浮层战役声称 vs 真机

### 8.1 编号对不上

| 文档 | WO-08 | Tooltip 相关 |
| --- | --- | --- |
| `02-全战役实施工单` 356–374 | **全局 CSS `@keyframes cds-popover-*` → `crish-popover-*`** | 不是 Tooltip 行为 |
| 同文件 445–461 **WO-11** | — | 浮点 `DOMRect` + 首帧 `opacity: 0` 防 FOUC |
| `03-全战役收口` 100, 198, 204 | keyframes 归一化；另写 WO-11 已做 | 宣称防首帧 (0,0) 闪烁 |
| **`Tooltip.tsx` 1–7 文件头** | 自称「WO-08 浮点化与防 FOUC」 | 把 WO-11 的活写成 WO-08 |

文件头与工单矩阵冲突。真机残影与 keyframes 改名无关。

### 8.2 WO-11 实际落地 vs 没做的

落地（现码看得到）：

- `isValidDOMRect` 拦全 0（测试环境放行）；
- `clampedPos == null` 时 `opacity: 0`；
- 四向翻折 + 视口钳位；
- `scroll`/`resize` **跟随**（测试 `Tooltip.test.tsx` 177–205 断言滚动后 `left` 变成新坐标，**要求跟着走，而不是关掉**）；
- GEO-TIP-01…08 钳位 / 翻折。

工单写了但现码仍在：`offsetWidth` 回退（`Tooltip.tsx` 173–180）。

**从未在 WO-08/WO-11 范围内的（真机正在打的）：**

- 全局单例；
- show delay / 快移全灭；
- 滚出视口 dismiss；
- 失焦 / 页不可见 dismiss；
- 菜单 / 右键打开时 **React 层** dismiss（不是 CSS `display:none`）；
- Tooltip 注册进 LayerStack；
- 调用 `isTooltipSilenced()`；
- 菜单项禁止外包 Tooltip 或改 `side` 以免盖住上一行。

`05-Tooltip坐标坍塌` 仍把 (0,0)→(8,8) 当主伤。现码生产已拒全 0；**真机孤儿是合法离屏 rect 被钳回视口**。用旧战役结论当「已修好」会看错病。

`00-调研边界.md` 29：禁止把「浮层战役已收口」当真理。本文件按真机 + 现码，不按收口签发。

---

## 9. 测试缺口（现有测试在固化错误契约）

`Tooltip.test.tsx` 覆盖：hover 出现、delayHide、disabled、ref、事件透传、side class、focus/blur、aria-describedby、右缘钳位、**滚动跟随**、四向翻折。

没有：

- 同时两个 `visible` 必须只渲染一个 portal；
- enter 后立刻 leave（快移）不得出现 tip；
- 触发器 `rect` 在视口外必须关闭而不是钳进来；
- `data-floating-active` / `isTooltipSilenced` 必须把 `visible` 打成 false；
- 窗口 `blur` / `visibilitychange`；
- 窗口化列表卸行后 `#tooltip-root` 为空；
- 菜单项 Tooltip + `side=top` 不得覆盖上一行；
- 生产路径下全 0 rect 不得渲染（测试环境还放行全 0）。

`LayerStackManager.test.ts` 31–48 只断言打属性，不断言 Tooltip 实例关闭。

`Menu/PhysicalGeometryGuards.test.tsx` GEO-VP-08 测的是单独 Tooltip 钳位，不是「与 Menu 叠层只留一个」。

---

## 10. 问题清单（同权，不排序砍项）

每条：路径:行号 + 根因假设。都要进后续总案，不按「先修这个」删。

1. **无全局单例。** `Tooltip.tsx` 90–94、345–383。多实例可同时 `visible`。用户锁 1 不成立。
2. **无 show delay / 速度门。** `Tooltip.tsx` 70–76、187–212。快移点亮路径上每一个。用户锁 2 不成立。
3. **`delayHide` 默认 0 且生产未用。** 同文件 85、199–205；除测试外无传入。不能冒充意图停留。
4. **滚动只跟随不关闭。** `Tooltip.tsx` 150–166。真机滚后残影主开关。
5. **离屏合法 rect 被钳进视口。** `tooltipPositioning.ts` 164–168 + `TOOLTIP_EDGE_PAD=8`。空画布上的「更多操作」「测试一下」来源。
6. **滚动不保证 `mouseleave`。** 浏览器行为 + 只绑 mouse 不绑 pointer 几何检测。`Tooltip.tsx` 208–217。
7. **短列表不窗口化。** `sessionListWindow.ts` 14–17；`WindowedSessionUl.tsx` 28–41。&lt;48 行常驻，portal 不随滚出卸载。
8. **overscan 8 行离屏仍挂。** `sessionListWindow.ts` 17。窗口化开启后仍能钳位残影。
9. **一行三 Tip 无互斥。** `SessionRow.tsx` 50、335、342、352。标题 + 时间 + 更多可同时亮。
10. **点画布关不掉孤儿。** `Tooltip.module.css` 7 `pointer-events: none`；无 document 级 pointer 检测。
11. **`isTooltipSilenced` 空转。** `LayerStackManager.ts` 152–154；Tooltip 不调用。
12. **Tooltip 不注册 LayerStack。** `layerStackTypes.ts` 15 有类型，无 `type: 'tooltip'` 注册。
13. **CSS `display:none` 不是 dismiss。** `Tooltip.module.css` 52–54。菜单关后 `visible` 仍 true 则复活。
14. **静音属性打在 useEffect 之后。** `useLayerRegistration.ts` 31。菜单首帧 focus 已经 show。
15. **会话右键不打 `data-floating-active`。** `SessionContextMenu.tsx` 全文无层注册。右键 + 行上 Tip 并存。
16. **`--z-context-menu` 未定义。** `SessionContextMenu.tsx` 165 vs `z-index.css` 1–27。右键 z-index 作废，Tip 9000 盖在菜单上。
17. **`--z-sticky-bar` 未定义。** `SidebarContextMenus.module.css` 153 等。战役文档档位与现 token 漂移。
18. **Menu 300 &lt; Tooltip 9000。** `Menu.module.css` 6 vs `Tooltip.module.css` 6。开着的下拉上面仍可飘 tip。
19. **权限项外包 Tooltip + 默认 top。** `PermissionModeMenu.tsx` 96；`Tooltip.tsx` 83。完全访问的「少打扰」画在计划行上。
20. **权限表没有写错。** `permissionModes.ts` 100、108。计划=只读，full=少打扰。不能当数据 bug 结案。
21. **`renderItem` 不跟鼠标改 `focusedIndex`。** `Menu.tsx` 409–414 vs 430。焦点 tip 与指针项分离。
22. **打开菜单 `focus()` 首项。** `Menu.tsx` 201–206、226–235 + `Tooltip.tsx` 221–251。程序化焦点可亮 tip（守卫在 WebView2 是否生效未 9222 证实，两条都要防）。
23. **菜单项 Tip 会被全局 CSS 藏或闪。** 同一套 `data-floating-active`。matrixHint 要么看不见、要么首帧闪在错误坐标。
24. **加号 / Select / 字体下拉同样项上套 Tip。** `ComposePlusMenu.tsx` 113；`Select.tsx` 96；`FontSelectField.tsx` 171。与权限同一结构病。
25. **药丸文案含 matrixHint。** `PermissionModeMenu.tsx` 63–64。当前模式 full 时，残影药丸 tip 也会出现「少打扰」。
26. **项目名无 Tip、会话标题有。** `ProjectsSection.tsx` 142 vs `SessionRow.tsx` 335。项目头上的会话名是邻行孤儿。
27. **右键项再套 Tip。** `SessionContextMenu.tsx` 277。自绘菜单 + 自定义 Tip，无互斥。
28. **触发器 pointerDown 只关自己。** `Tooltip.tsx` 259–272。关不了其它实例。
29. **无窗口失焦 / 页隐藏关闭。** Tooltip 目录无 `blur`/`visibilitychange` 监听（组件内 blur 只绑触发器）。
30. **无 IntersectionObserver / 视口外检测。** 定位文件只有钳入，没有「在外面就关」。
31. **测试固化瞬时显示与滚动跟随。** `Tooltip.test.tsx` 25–36、177–205。与用户锁相反。
32. **测试环境放行全 0 rect。** `tooltipPositioning.ts` 29–38。坍塌回归测不到。
33. **WO-11 仍用 offsetWidth。** `Tooltip.tsx` 173–180 vs 工单「废除」。
34. **文件头 WO-08 与工单 WO-08/WO-11 对不上。** `Tooltip.tsx` 1–7 vs `02-全战役实施工单` 356、445。
35. **原生 `title=` 仍有多处。** §5 七条。系统黄条与自定义层可叠，且不受单例约束。
36. **Skill 卡双提示。** `SkillCardList.tsx` 171 + 196。Tooltip + native title。
37. **IconButton / Menu 重建 Tip 仍是独立实例。** `IconButton.tsx` 42–43；`Menu.tsx` 318。不增加单例。
38. **`exitDurationMs: 0` 使 `.tooltipExit` 基本无用。** `Tooltip.tsx` 105；`useAnimatedPresence.ts` 42–43。残影不是退场动画。
39. **拖拽幽灵与 Tip 同 z。** `useSessionListDrag.ts` 235–236。
40. **预览 / reference 另有手写气泡。** §6。不进产品运行时，但仓库有第二套语义，后续别误迁。

---

## 11. 额外发现（任务内相关，上报主控）

- `survey/06` 已写：权限 / 模型 / 加号各持 `open`、LayerStack 入栈不关兄弟。Tooltip 问题与「面板只开一层」是同一互斥空洞的两面：中枢有静音协议和类型，**两边都没把「后来者关掉前者」接到实例上**。
- 金标 `chrome_2S3SpxqvmU.png`：侧栏干净、无残影气泡。产品现码做不到，不是差一两个 CSS。
- 未开 9222，故 `:focus-visible` 守卫在 WebView2 对 `Menu` 的 `focus()` 是否拦住，标为未证实。无论拦住与否，hover 路径的无单例 / 钳位残影已经足够解释截图。

---

## 12. 本文做了什么 / 没做什么

**做了：** 读必读文档与 Tooltip 四文件、SessionRow、PermissionModeMenu、Menu、LayerStack、窗口化列表、z-index token；全仓普查产品 `<Tooltip>`、原生 `title=`、手写气泡；对照 WO-08/WO-11/收口文与真机锁；路径:行号 + 根因假设；问题同权列出。

**没做：** 改源码、git、第二份文档、派子代理、9222 真机复拍、实现方案（总案阶段再写）。

---

## 13. 总结

产品只有一套 `ui/Tooltip`，用的面很宽（侧栏、Composer、设置、文件、Diff…），但状态机是「每个触发器自己亮」。没有单例，所以空画布能同时漂「更多操作」和「测试一下」。没有 show delay，所以快移不是全灭而是全亮。滚动把 tip **跟着钳进视口**而不是关掉，短会话列表还不卸行——残影是这条几何路径的正常输出，不是 FOUC 没做完。

「计划上冒少打扰」对照权限表是否写反：**不是**。少打扰属于「完全访问」，默认向上画，盖住上一行「计划」。项目名上的会话标题同理：文件夹自己没有 tip，是会话行 portal 没死。

浮层战役 WO-08 改的是动画名字；WO-11 改的是首帧透明和钳位。文件头把后者写成 WO-08。真机要的三件事（一颗、快移为零、不许孤儿）都不在已做集合里。`isTooltipSilenced` 和 `data-floating-active` 不能当已收口：一个没人调用，一个只藏不关，会话右键还绕开栈。后续总案必须按用户锁做全局一颗 + 意图停留 + 滚出 / 失焦 / 开菜单真正 dismiss，而不是再补一层 `opacity: 0`。
