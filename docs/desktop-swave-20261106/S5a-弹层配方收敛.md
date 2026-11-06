# S5a · 弹层配方收敛报告（2026-11-06）

治理依据：`F-弹层菜单.md` 全文、E 册第 1 类（入场/退场）口径。共享配方（design-system.css 只读，未改本体）：popover 入场 180ms decelerate（`--transition-popover-enter`，scale 0.97 + ∓4px）/ 退场 120ms accelerate（`--transition-popover-exit`）；modal 入场 220ms。

---

## 〇、重大发现：本批第 1 项的前提被工具链实机证伪（路线已当场修正）

原计划「删模块内私有 @keyframes 副本、改为按名消费共享 keyframes」在当前 Vite 版本下**不成立**，且已在产的「按名消费」面（AN2/A6 归队成果）**动画一直在静默失效**。证据链（三段，均为本批亲测）：

1. **served transform 证据**：从 dev server（localhost:5174）拉取的模块 transform 显示，CSS Modules 会把 `animation` 声明里的 keyframes 名一律 scoped 化（如 `crish-popover-enter` → `_crish-popover-enter_1kd54_1`，且写入模块 locals 映射）。对照组 PermissionModeMenu.module.css——**从未定义过 keyframes、只引用**——served 结果同样是 scoped 引用名 + 无任何定义。
2. **实机探针证据**（Tauri MCP，同类名 + 同 data 属性探针元素，页面 reload 至同代际后测）：
- PermissionModeMenu 的 `.permMenu`：computed animationName = scoped 名、duration 0.18s，但 `getAnimations()` = **[]**——动画对象根本不被创建，入场静默失效（此面本批未碰，属先于本批存在的失效）。
- 全局类探针（页面内联全局样式 `animation: crish-popover-enter...`）：anims = [{name: crish-popover-enter, kfs: 2, running}]——**全局（非模块）CSS 消费共享 keyframes 完全正常**。
- 恢复本地定义后，Select/SelectContent/Menu/SettingsQuickMenu 探针：anims 均为 [{dur: 180, kfs: 2, running}]，闭环成立。
3. **代际注记**：scoped 哈希随文件内容变化（如 SelectContent `1nmzt → 1qqv6`）；长开页面 HMR 未换代时会出现「引用名与定义代际错位」的暂时失效，reload 后自洽——这不是源码问题，生产构建为单一代际。

**结论**：模块内与正典同值的 @keyframes 副本，是当前工具链下模块 CSS 唯一可工作的消费方式（Menu.module.css 原注释「需在模块内声明以保证 scoped 闭环」的判断方向正确）。真单轨只剩两条路，均超出本批文件权限，已登记（见 §八.1）：① 共享层新增带 data-state/data-side 感知的全局工具类 + 各 TSX 采纳类名（需改 design-system.css）；② 构建侧评估 keyframes scoping 配置。

**本批据此的修正动作**：第 1 项的删副本动作已全部回滚（值保持正典同值、加工具链警示注释防后人再删）；第 6 项改为「值级归队」（私有 keyframes 保留，几何/时长/缓动对齐正典与共享 token）；第 2/3/4/5 项不依赖 keyframes 跨模块消费，照常落地。

---

## 一、逐项结果

### 项 1 · 私有副本收敛 —— 前提证伪，副本保留（值已与正典同轨）
- 收敛前：`crish-popover-*` 定义点 = 正典 1 套 + **5 文件 16 份私有副本**（Menu 4、Select 4、SelectContent 4、ModelBadgePickerMenu 2、SettingsQuickMenu 2），逐字比对均与正典一致、时长均走共享 token。
- 尝试删除后实机证明引用名悬空、动画静默失效（§〇），已恢复全部副本，并在每处加警示注释（注明 scoped 闭环约束与证伪日期，防再删）。
- 终态轨数：定义点仍 5 文件 16 份（**数值口径单轨，定义位置多轨——工具链强制**）；`.ui-popover-animate` / `.ui-modal-animate` 仍零消费者，其采纳随真单轨批（§八.1）。

### 项 2 · 菜单入场三档口径统一 —— 完成
三档（Menu starting-style 100ms/0.95、Popover 100ms/0.96、SEP 级联子菜单 180ms/0.97）→ **180ms/0.97 单档**：
- Menu 的 100ms/0.95 档随项 3 双机制删除而消失（其实际呈现本就被 keyframe 配方遮蔽，见项 3 判定）。
- Popover（`ui/Popover/Popover.module.css`，过渡型机制）：`.popup` 过渡改为 `var(--transition-popover-enter)`（180ms decelerate）；起始/结束帧几何改 scale 0.97 + 按 `data-side` 分发 ∓4px（top 镜像、left/right 正典无位移变体仅缩放，登记 §八.6）；`[data-ending-style]` 过渡改为 `var(--transition-popover-exit)`（120ms accelerate）。served CSS 已核：popup 过渡与几何均为新值，backdrop 的 100ms 纯淡入保留不动（遮罩，非弹层本体）。
- SEP 级联子菜单原本即 180ms/0.97（但其消费方式属 §〇失效面，登记 §八.2）。
- 高频面退场未升档：Menu/Select/Popover 退场均为 120ms 档，未动 modal 档，符合 F 反例口径。

### 项 3 · Menu 双机制核查 —— 判定：keyframe 套生效，过渡套冗余，已删
`ui/Menu/Menu.module.css` 的 `.menuContent/.popup` 原同时挂：① `transition`（opacity/transform，micro 100ms）+ `@starting-style`（scale 0.95）+ `[data-ending-style]`（scale 0.95）；② `[data-state='open'/'closed']` keyframe 动画（180/120ms，scale 0.97）。
- **判定依据（代码 + 级联规则）**：两套同写 opacity/transform；CSS 动画在级联中恒压过过渡，且 open/closed 两态下动画均以 `forwards` 填充持续生效，过渡套的目标值永无呈现机会——实际观感恒为 keyframe 配方（与 F 册「实际呈现以动画为准」一致）。过渡套唯一残余作用是在 data-state 落定前的空窗，而 Base UI 的 data-state 与挂载同帧落定，空窗不存在。
- **处置**：删除 `transition` 声明、`@starting-style` 块、`[data-ending-style]` 块；减动效块随之简化为 `animation: none`（时长 token 在减动效下本就全局归零）。开合现由单一 keyframe 机制驱动。
- 实机复核：reload 后 Menu 探针（data-state=open, data-side=top）anims = [{enter-top, 180ms, kfs 2, running}]，机制单一且工作。

### 项 4 · TiptapSlashMenu 退场方向 bug —— 已修（源码级）
`chat-composer/TiptapSlashMenu.module.css`：原 `[data-state='closed']` 无分发地播 `crish-popover-exit-top`，底部弹出（side=bottom）的菜单也向上退场。改为与入场同构的方向分发：默认（bottom）走 `crish-popover-exit`，`[data-side='top']` 以 `animation-name` 覆盖为 `crish-popover-exit-top`。
- 证据：served CSS 四行——open/top → enter-top、open/bottom → enter、closed → exit、closed/top → animation-name: exit-top，分发与入场镜像。
- 注：该面整体动画受 §〇 工具链问题影响当前静默失效（先于本批），方向修复在消费机制修复落地后即生效；`TiptapVisualRedline.test.ts` 对该文件的配方断言（走共享名 + token、无本地 @keyframes、无大位移字面量）全部保持通过。

### 项 5 · 文件历史抽屉补过渡 —— 打开侧完成，关闭侧登记
`files/FileViewerCard.module.css` 的 `.historyDrawer`（原零过渡、280px 整块跳位）：
- 按笔记抽屉先例（NoteSidebarDrawer：`--duration-normal` 200ms + ease-in-out / ease-standard）补：`transition: width/min-width/opacity 200ms`（min-width 一并过渡，因本抽屉带 min-width 240px，不带则起始帧被钳到 240）+ `overflow: hidden` + `@starting-style` 起始帧（width 0 / min-width 0 / opacity 0）——父级为条件渲染（`FileViewerCard.tsx` 第 436 行 `{historyOpen &&...}`），打开经起始帧滑入。
- 关闭侧的真对称（常驻挂载 + isClosed 类）需改 FileViewerCard.tsx，属 S1a 文件归属，未硬改，登记 §八.4。
- 未碰 FilePreview.tsx / FileViewerCard.tsx / FileTreeView.tsx 本体（S1a 在改）。

### 项 6 · 单向私有淡入收敛 —— 值级归队完成（名级受工具链阻，见 §〇）
四面原私有 keyframes 几何/时长各异，现**几何与时长全部对齐共享配方**（时长缓动统一走 `--transition-popover-enter` token，补 `forwards` 与正典同式），keyframes 名保留本地（scoped 闭环所必需）：
| 面 | 收敛前 | 收敛后 |
|---|---|---|
| NewTabLauncherPopover `launcherEnter` | 150ms `--duration-fast` + ease-standard；scale 0.97 / translateY(-3px)；100% `transform: none` | token 180ms decelerate；scale 0.97 / -4px；100% scale(1) translateY(0)（与正典逐字同值） |
| FileAnnotationPopover `popoverFadeIn` | token 时长；translateY(-4px) scale(**0.985**)、变换序异 | scale **0.97**、序归正典（scale 后 translateY） |
| AnnotationChipItem `annPopoverFadeIn` | token 时长；translateY(+4px) scale(**0.985**) | -top 变体同值：scale **0.97** / +4px（原上浮方向保留） |
| DraftUndoToast `undoToastIn` | 150ms `--duration-fast` + ease-standard；纯 fade + translateY(4px)、**无缩放** | token 180ms decelerate；-top 变体同值（补 scale 0.97 / +4px） |
四面退场仍缺失（属 S4 地盘，未自创），登记 §八.5。

### 项 7 · 双 toast 基建核查（只核查）—— 结论：分工清晰，单轨，非双轨
- `services/toast/` = **服务层**：命令式 API（`toast.ts`）、`ToastStore`、`ToastContext`（ToastProvider，`entry-core.tsx` 根部单例挂载一处）、`ToastContainer`（挂载桥）。
- `components/overlay/` = **呈现层**：`ToastViewport` / `ToastCard`（motion/react AnimatePresence 真退场 + 滑动关闭 + 进度条）；`ToastContainer` 把 Viewport 渲染进 `#toast-root` Portal，全仓呈现只此一出口（`hooks/toastQueueLogic.ts` 注释亦明言「呈现只走顶部 ToastViewport」，旧 ToastBus 已移除）。
- F 册「两套并存」的观感实为同一栈的服务/呈现分层；overlay 目录另住 FirstRunWizard、TelemetryDialog 等浮层组件，Wizard 三步对 overlay 的引用仅为共用 FirstRunWizard 样式，与 toast 无关。
- 无重复造面，本项无需施工。

---

## 二、消费者清单（crish-popover-* 全部消费面，终态）

| 消费面 | 方式 | 终态 |
|---|---|---|
| ui/Menu、ui/ContextMenu（共用 Menu.module.css）、ContextMenuFlyout | 本地定义 + data-state 引用 | 工作中（项 3 后单机制） |
| ui/Select（Select.module.css）、SelectContent.module.css | 本地定义 + 引用（open 需 data-positioned 才播，定位纪律保持） | 工作中 |
| provider/ModelBadgePickerMenu（含 `.advancedContent` 展开） | 本地定义 + 引用 | 工作中 |
| settings/SettingsQuickMenu（`.sbQuickMenu`） | 本地定义（-top 对）+ 引用 | 工作中 |
| chat-composer/PermissionModeMenu | **只引用、无定义** | **静默失效（先于本批，登记 §八.2）** |
| chat-card/ProjectPickerMenu | 只引用 | 同上 |
| chat-composer/TiptapSlashMenu | 只引用 | 同上（项 4 方向已修，待机制修复生效） |
| ui/SmartExpandablePanel 级联子菜单 | 只引用 | 同上 |
| design-system.css `.ui-popover-animate` / `.ui-modal-animate` | 全局类 | 仍零消费者，待真单轨批采纳 |

---

## 三、文件净变化（12 文件；备份在 PC `C:\Users\Administrator\AppData\Local\Temp\muse-backup-20261106-s5a\`，含改前 SHA-256 清单）

| 文件 | 净变化 |
|---|---|
| ui/Menu/Menu.module.css | 删过渡套（transition + @starting-style + [data-ending-style]）；减动效块简化；keyframes 注释改写为工具链警示（值不变） |
| ui/Select/Select.module.css | keyframes 加警示注释（值不变） |
| ui/Select/SelectContent.module.css | 同上 |
| provider/ModelBadgePickerMenu.module.css | 同上 |
| settings/SettingsQuickMenu.module.css | 同上 |
| ui/Popover/Popover.module.css | 入场过渡 100ms/0.96 → 配方 180ms/0.97/∓4px（按 side 分发）；退场过渡 → 120ms accelerate + 镜像几何 |
| chat-composer/TiptapSlashMenu.module.css | 退场按 side 分发（默认 exit、top 覆盖 exit-top） |
| files/FileViewerCard.module.css | `.historyDrawer` 补 200ms width/min-width/opacity 过渡 + @starting-style 起始帧 + overflow hidden |
| binary-tree/NewTabLauncherPopover.module.css | `launcherEnter` 值对齐正典 + 时长改走共享 token |
| files/FileAnnotationPopover.module.css | `popoverFadeIn` 值对齐正典（0.985→0.97、序归正）+ forwards |
| chat-composer/AnnotationChipItem.module.css | `annPopoverFadeIn` 值对齐 -top 变体（0.985→0.97）+ forwards |
| chat-composer/DraftUndoToast.module.css | `undoToastIn` 值对齐 -top 变体（补 scale 0.97）+ 时长改走共享 token + forwards |

禁改清单零触碰（design-system.css 仅只读消费；components/motion、两批收口文件、FilePreview/FileViewerCard.tsx/FileTreeView.tsx 均未动）。未 commit、未 push、未动 stash、未重启应用（仅页面 reload 一次做 HMR 代际对齐）；`MuseB1Vite` 未动。

## 四、验证

- **定向套件（orange 主体，两轮同集）**：15 文件 / **174 例全过**，EXIT=0（Menu.test、Menu.lowViewport、SelectHairlineBorder、TiptapVisualRedline、SettingsQuickMenu、NewTabLauncherPopover、tabStripMotionContract、composerNotice.contract、ProjectPickerMenu、ComposePlusMenu、MenuAdapter、style-contract、antiDarkeningGuard、semanticColors.contract、settings-css-guard.contract）。首轮 SettingsQuickMenu 一例 retry 后过（争用期抖动）。
- **哈希纪律**：改前备份 + SHA-256 清单；推送后远端哈希与本地编辑版 12/12 一致；Popover/TiptapSlashMenu/FileViewerCard 三件做了延迟复核（约 25 分钟后仍一致，无他线覆盖）。
- **实机（Tauri MCP）证据等级**：右键菜单与 Select 的入场计算样式以「同生产类名 + 同 data 属性探针元素」验证（真实右键菜单在当前 146×20 退化窗口下合成 contextmenu 事件打不开，属既有保真限制；ContextMenu 与 Menu 共用同一 stylesheet，Menu 规则集已验）：Menu（top）/ Select / SelectContent / SettingsQuickMenu 均为 anims=[{180ms, kfs 2, running}]、animationName 为对应 scoped 名；Popover 与 TiptapSlashMenu 以 served CSS 文本核验新值在产。

## 五、登记项（待 S4 / S5b / 后续批）

1. **** 弹层 keyframes 真单轨：共享层新增感知 data-state/data-side/data-positioned 的全局动画工具类（或评估 Vite keyframes scoping 配置），各弹层 TSX 采纳后，5 文件 16 份本地副本与 4 份值级归队 keyframes 方可删除；在此之前任何「删副本」都会静默杀死动画。
2. **** 只引用型模块的弹层动画当前静默失效：PermissionModeMenu、ProjectPickerMenu、TiptapSlashMenu（进+出）、SEP 级联子菜单。修复随登记 1 一并处理，或临时给这四个模块补本地同名定义（值与正典一致）先行止血——止血属改动这四个模块 CSS，未在本批权限内擅动。另：ReasoningRow 对 `crish-text-breathe` 的「只按名消费」同机制疑似同病（其测试文件自述只按名消费），未实测，登记待核。
3. **Select 家族退场方向隐患**：Select.module.css / SelectContent.module.css 均无 `[data-state='closed'][data-side='top']` 规则，exit-top keyframes 定义了却无消费者——side=top 的 Select 退场播 bottom 变体（-4px），与 Tiptap 同族方向问题（程度较轻）；本批未擅自加规则，登记待与登记 1/2 同批处置。
4. **文件历史抽屉关闭侧**：真对称退场需 FileViewerCard.tsx 改常驻挂载 + isClosed 类（S1a 文件归属）或 S4 presence 宿主，登记待协调；本批打开侧滑入已落地。
5. **退场缺失面清单（S4/S5b 地盘，本批未自创退场）**：SEP 主面板（入/退双无，本批按令未接入）、PermissionModeMenu 退场、SlashMenuOverlay（双无）、NewTabLauncherPopover 退场、FileAnnotationPopover 退场、AnnotationChipItem 退场、DraftUndoToast 退场；另 FlowScrubber tooltip 私有 `scrubberTooltipFadeIn`（F 册 D 表，本批范围外，值级亦未对齐）顺带登记。
6. **Popover left/right 侧**：正典无水平位移变体，本批仅给 scale 0.97；若需 ∓4px 水平镜像，须先在正典层立变体（design-system.css 权限外）。
7. **沿袭 F 册登记**：Popover backdrop 带 blur 4px 而 Dialog 遮罩不做模糊，口径不一；PreviewCard 四份私有 keyframes（定义型，应仍工作）数值与正典对表归 S7 线；SettingsUI 本地 tooltip 退场待核。
