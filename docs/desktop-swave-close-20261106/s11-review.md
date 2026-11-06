# S11 · 右侧面板动效批 — 收口复核报告（只读复核，2026-11-06）

- 复核员：S 波收口 S11 复核员（只读；未改任何文件、未提交、未跑测试）
- 复核对象：`~/workspace/motion-audit-20261106/右侧面板动效批.md`（S11 施工报告）
- 目标机：DESKTOP-J31MN6T（100.83.127.119，Administrator SSH）；仓库 `C:\Software\conex`
- 分支：`chore/settings-rework-20261101`；HEAD `ffdb17792`（docs(desktop): S 波报告落盘……）
- 复核时间：2026-11-06 08:14–08:30 EST

## 结论：可提交，无需修补

4 个改动文件逐 hunk 与报告一致，MD5 四个全对，零按名 keyframes 引用，`data-dock-open`
语义未动，range 4 未接 S4 的登记准确，备份 = 真实 HEAD 版本，测试日志佐证 80/80 + tsc 0。
唯一需收口注意的是提交时只含这 4 个文件（同目录另有他线改动，见 §4）。

> 另注：复核进行中 MEMORY.md 新增用户裁决（2026-11-06 08:16 EST）「提交的话可以勤快一点，
> 这种的不用我批才行的哈」——已核验通过的主题提交不必等用户批。本批已通过复核，
> 可按该口径 prompt 提交（是否提交由收口协调决定，本复核员未提交）。

---

## 一、逐文件核对表

基底：`git diff`（vs HEAD）+ 磁盘文件 + MD5。4 文件全部仅 unstaged 改动（` M`），
staged diff 为空，未提交。

| 文件 | MD5（磁盘实测 vs 报告） | diff 规模 | 核对结果 |
|---|---|---|---|
| `apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx` | `52701cde158b3effeab2669cdd2cbc80` ✓ 一致 | +140 / −32 | 全 4 个 hunk 均为 S11，与报告 §一.1/一.2 逐项相符 |
| `.../binary-tree/BinaryTreeWorkspace.module.css` | `6a5172be0038a3e3b9a91349e8504e72` ✓ 一致 | +83 / −5 | 全 3 个 hunk 均为 S11，与报告 §一.1/一.2 相符 |
| `.../binary-tree/DockPane.module.css` | `bc71751316aa9c706f1622cbd832c44c` ✓ 一致 | +27 / −1 | 全 2 个 hunk 均为 S11，与报告 §一.3/一.4 相符 |
| `.../binary-tree/DockResizeSash.module.css` | `91ce0ef5d2843950b963a0539be2d5e4` ✓ 一致 | +11 / −0 | 纯新增 1 个 hunk，S11，与报告 §一.3 相符 |

### 1. TreeLeafPanel.tsx（+140/−32）

- `DOCK_DRAWER_ANIM_MS = 200` 常量在位（L80），与 CSS `--duration-normal` 同值 ✓
- `dockCapable` 从 `dockOpen` 拆出（`isChatSurface && !isLeafDraft && !isStandaloneTab`），
  `dockOpen = dockCapable && dock.collapsed !== true`——与原表达式语义完全相同 ✓
- `dockClosing` 保活：`dockOpen` 转假时 `setDockClosing(true)`，`DOCK_DRAWER_ANIM_MS + 60`
  （260ms）定时器后卸载；重开立即 `setDockClosing(false)` 取消 ✓（L153–170）
- 最大化两段翻转：`maxAnim {left, width, go}` + `maxAnimTargetRef` + `useLayoutEffect` 内
  `requestAnimationFrame` 次帧翻转 + 260ms 定时器清瞬态 + 卸载时 `clearMaxAnimTimer` ✓（L173–236）
- 坞关闭复位：`!dockOpen` 时同时清 `maxAnim` 与其定时器 ✓（原 `isMaximized` 复位效应已扩展）
- `data-dock-present={dockOpen || dockClosing ? 'true' : 'false'}` 新增（L451）✓
- `data-dock-open` 未动：外层叶根（L421，`data-panel-id="chat"` 元素）与 `leafBody`（L450）
  两处仍为 `dockOpen ? 'true' : 'false'`，且均不在 diff 内 ✓
- 抽屉外壳改为 `dockCapable` 下常驻挂载，内层内容 `(dockOpen || dockClosing)` 门控 ✓
- `LeafDockResizer` 门控为 `dockOpen && !isMaximized && !maxAnim`——比报告文字多一个
  `!maxAnim`（最大化过渡飞行中隐藏 resizer）；报告未单列此点，但与 maximizing 壳语义一致、
  行为正确，记为“已观察、非缺陷”（见 §5 注 1）
- `onToggleMaximize` 由 `() => setIsMaximized(prev => !prev)` 改为 `handleToggleMaximize` ✓

### 2. BinaryTreeWorkspace.module.css（+83/−5）

- `.leafBody[data-dock-open='true']` → `.leafBody[data-dock-present='true']`（仅行方向规则，
  L354）；开宽规则仍挂 `.leafBody[data-dock-open='true']`（L456），`data-dock-open` 语义未动 ✓
- `.leafDockDrawer` 常驻壳：`flex: none; width: 0; transition: none; justify-content: flex-end;
  overflow: hidden` ✓；水合门控 `:global(.app-container[data-preferences-hydrated='true'])
  .leafDockDrawer:not(.maximizing)` 给 width 200ms decelerate 过渡 ✓
- 拖拽关停规则在位，特异性与报告一致：水合门控 (0,4,0)，关停规则 body 元素 + 两协议类 +
  app-container + 属性 = (0,4,1)，可压过门控 ✓（已逐选择器复算）
- `.leafDockDrawerInner` 新增：钉 `--leaf-dock-width`、min-width 200px、flex 列、border-left ✓
- `.maximizing` 瞬态壳（absolute，几何留空）+ 其 left/width 200ms 过渡 ✓（L501–517）
- `.maximized/.maximizing` 内层 `width: 100%; min-width: 0; border-left: none` ✓
  （外层 `.maximized` 规则去掉的 `flex: 1 1 100%` 与 `border-left: none` 已由内层规则承接，
  与外层现为 `flex: none` + width 驱动一致，无遗留）

### 3. DockPane.module.css（+27/−1）

- `.pane` transition 由仅 `border-color` 扩展为 border-color + left/top/width/height
  各 200ms decelerate ✓
- `:global(body.dock-split-resizing) .pane { transition: none }` 熄火规则在位（L72）✓
- `.toolOutletPane` 加 `transition: opacity 150ms` + `@starting-style` 首帧 opacity 0 ✓（L83–93）
- 旧面仍 display 直切（未加退出过渡），与报告 §一.4 取舍说明一致 ✓

### 4. DockResizeSash.module.css（+11/−0）

- `.sash` 加 left/top/width/height 200ms 几何过渡 ✓
- `:global(body.dock-split-resizing) .sash { transition: none }` 熄火规则在位（L30）✓
- 与该文件既有 body 联动规则（L84–99，选区锁/iframe 防劫持）同源，无冲突 ✓

---

## 二、keyframes 引用检查结果：零引用，通过

对 4 个文件 + 新增 CSS（本次无新增 CSS 文件，`git status` 无 untracked 文件）逐项 grep：

| 检查项 | 结果 |
|---|---|
| `animation:`（冒号形式，CSS 声明） | **0 命中**，4 文件全无 |
| `@keyframes`（定义） | **0 命中**，4 文件全无 |
| `animation` / `keyframes` 单词命中（逐条定性） | 见下表，全为良性，无按名引用 |

单词命中定性（`findstr /I "animation keyframes"` 全量输出）：

| 位置 | 内容 | 定性 |
|---|---|---|
| TreeLeafPanel.tsx:95 | `handleAnimationEnd: paneAnimationEnd` | 既有代码（不在 S11 diff 内）；S4 入口 `crish-entrance-fade` 的 `onAnimationEnd` 接线 |
| TreeLeafPanel.tsx:202, 207 | `requestAnimationFrame` / `cancelAnimationFrame` | S11 自身最大化次帧翻转，非 keyframes |
| TreeLeafPanel.tsx:408 | `onAnimationEnd={paneAnimationEnd}` | 既有代码（不在 S11 diff 内）；叶根 `crish-entrance-fade` 入场，与 S11 无关 |
| BinaryTreeWorkspace.module.css:434 | 注释“keyframes 红线：全段只用 transition，无按名 keyframes 引用” | S11 注释自述，与磁盘实测相符 |
| BinaryTreeWorkspace.module.css:550 | 注释“panelCrossFadeIn 私有 keyframes 无任何 TSX 消费（死代码），已删” | **既有注释**（在 S11 hunk 范围外）；文件内无 `@keyframes panelCrossFadeIn` 定义残留，注释所述“已删”与磁盘一致，无悬空定义 |
| DockPane.module.css:90 | 注释“本段只用 transition + @starting-style，无按名 keyframes 引用” | S11 注释自述，与磁盘实测相符 |

**结论：全批零 by-name keyframes 引用，无新增悬空，红线合规。** 唯一与 keyframes 相关的
既有痕迹是 S4 入口动效的 `paneAnimationEnd` 接线与一行历史注释，均不在 S11 改动内，
不构成 S11 违规。

---

## 三、range 4（窗格关闭退场）现状：登记准确

- 在 `DockPane.tsx`、`DockSplitWorkspace.tsx`、`DockPane.module.css`、
  `DockSplitWorkspace.module.css`、`TreeLeafPanel.tsx` 中 grep
  `useExitReveal | crish-exit | exitReveal`：**0 命中**。
- 窗格关闭退场确实未接入 S4，与报告 §一.5 / §五.1 的登记一致（留 S4 后续批；
  `DockSplitWorkspace` 的 `handleClosePane` 为报告所述对接点，本批未改其 TSX）。
- 补充说明：TreeLeafPanel.tsx:406–408 存在 S4 **入场**接线（`crish-entrance-fade` /
  `paneEntering` / `onAnimationEnd`），那是入场侧，与“退场未接”的登记不矛盾。

---

## 四、纠缠分析：4 文件内零混入；同目录他线改动须隔离提交

- 4 个 S11 文件的 `git diff`（vs HEAD）**全部 hunk 均为 S11 内容**，无他线行混入；
  diff 的 `index` 行与 HEAD blob 一致（TreeLeafPanel `7f47c99c1`、
  BinaryTreeWorkspace `f22f700ae`、DockPane `6251ae022`、DockResizeSash `77fc81fdf`）。
- 4 文件均为 unstaged 改动（` M`），staged diff 为空，仍未提交 ✓。
- 同目录 `binary-tree/` 内另有他线改动（**不同文件，与 S11 无文件重叠**），提交时必须隔离：
  - `M `（已暂存）`DockPane.test.tsx`：2+/2−，仅按钮名断言 `/网页预览/` → `/网页预览|浏览器/`
    （`DockPane 分屏子窗格容器架构与渲染断言`），与 S11 无关的他线测试标签适配；
  - ` M` `NewTabLauncherPopover.module.css`：他线未暂存改动；
  - ` M` `__tests__/tabStripMotionContract.test.ts`：他线未暂存改动（标签条动效契约）。
  - 收口提交须限定路径（仅上述 4 文件），不得把这 3 个文件扫进 S11 提交。
- 全树工作区整体很脏（多线并行），但 S11 的 4 文件可干净剥离。

---

## 五、佐证与备注

1. **备份有效**：`C:\Users\Administrator\AppData\Local\Temp\muse-backup-20261106-s11\`
   4 文件齐；`git hash-object` 实测与 HEAD blob id 逐一相等 → 备份确为改动前版本，回滚可用。
2. **测试数字佐证（只读复核未重跑测试）**：`C:\Software\conex\reference\muse-s11\` 日志在盘：
   `vitest.log` 末行 “Test Files 7 passed (7)” / “Tests 80 passed (80)”；
   `tsc.log` 为 `TSC_EXIT=0`；`done.txt` 为 `ALLDONE`。与报告“7 文件 80/80、tsc 0”一致。
3. **保活时长收敛点属实**：`dockClosing` 与 `maxAnim` 两个定时器均用
   `DOCK_DRAWER_ANIM_MS + 60`（L166、L236），与报告 §五.3 “一处收敛”相符；
   该常量与 CSS 令牌同值靠注释维系的风险报告已自登记，无需复核追加。
4. **观察项（非缺陷）**：`LeafDockResizer` 在 `maxAnim` 期间隐藏（`!maxAnim` 门控），
   报告正文未单列，但与 maximizing 壳语义一致、行为正确，不作修补点。
5. **新裁决交叉提示**：复核中 MEMORY.md 新增 Dock close-all 裁决（全部 dock 标签关闭时
   侧栏本身须关闭，不得停留在 overview/launcher 空态）。S11 未动该逻辑（`dockOpen` 仍由
   `dock.collapsed` 驱动，`dockClosing` 仅延长内容 260ms 寿命、不阻止抽屉关闭），
   与本批无冲突；如收口另有批次落实该裁决，注意与保活期语义互不干扰即可。

---

## 六、修补点：无

无修补点。本批可按 4 文件路径提交。
