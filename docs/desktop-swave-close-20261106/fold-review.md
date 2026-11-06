# S 折叠同钟批 · 收口复核报告（只读复核）

- 复核员：S 波收口折叠同钟批复核员（只读：未改任何文件、未提交、未跑测试）
- 复核时间：2026-11-06 约 08:15–08:40 EST
- 复核对象：`~/workspace/swave-20261106/S折叠同钟.md`（S9《高度族》B 组，修用户 2026-11-06 00:36 底部折叠跳变案）
- 分支：`chore/settings-rework-20261101`，HEAD `ffdb17792`（docs(desktop): S 波报告落盘……）
- 方法：PC 磁盘文件 SHA-256 对照 + `git status/diff/diff --cached`（Administrator SSH，只读）+ 源码逐行验证 Design Y 因果链

## 一句话结论

**可提交（附一项拆分条件）**：四文件磁盘内容与报告一致，Design Y 偏离论证经源码验证**成立**；但 `VirtualScrollManager.test.ts` 工作区文件已混入一条他线暂存改动（性能阈值 20→100），主题提交前必须先拆出，否则该文件不得随批提交。

---

## 一、逐文件核对表

四文件 SHA-256 与报告 §七所列**逐字节一致**：

| 文件 | 报告 SHA-256（前 16 位） | 磁盘实测 | 一致 |
|---|---|---|---|
| `apps/crish-desktop/src/hooks/useVirtualScroll.ts` | `d4f8ac38f015021e…` | `d4f8ac38f015021e9c2cc4a269478b6d5363a83b616218c8eec9b21211090f73` | ✅ |
| `apps/crish-desktop/src/api/VirtualScrollManager.ts` | `0bbb118d901f1c34…` | `0bbb118d901f1c34fd0003f93b01cea2771d20dc79f3b407a26535affb024258` | ✅ |
| `apps/crish-desktop/src/hooks/useVirtualScroll.test.ts` | `eaa8be6367f8adccd…` | `eaa8be6367f8adccd6732c5f97bf0aed88a320f2ad6a54ef28ee3fc4de8b9bb3` | ✅ |
| `apps/crish-desktop/src/api/VirtualScrollManager.test.ts` | `3a6e0b7ed906cbe5e…` | `3a6e0b7ed906cbe5e66110ab61316c6138a1c22d5c97727f77fade04b18b33ba` | ✅ |

工作区 diff（HEAD→工作区）与报告 §二逐条对照：

| 文件 | 工作区 diff | 与报告一致性 |
|---|---|---|
| `VirtualScrollManager.ts` | +31/−0：`accordionBottomPinned: boolean \| null` 字段 + 注释（L69–77）；`setAccordionMotionLock` 0→1 复位 null、回落 0 复位 null（L322–335）；`isAccordionBottomPinned()` / `hasAccordionBottomPinnedDecision()` / `setAccordionBottomPinned()` 三方法 | ✅ 与规格 1 逐字一致；`acquireAccordionMotionLock` 签名未动 |
| `useVirtualScroll.ts` | +94/−5：import `BOTTOM_STICK_EPSILON_PX` + `isContainerAtBottom`；`pinToBottomRef` + `pinToBottom`（模型总高口径，L324–342）；`flushActualMeasurements` 锁短路改 `!force && locked && !isAccordionBottomPinned()`（L208–215）+ 末尾判底钉底（L259–269）；`scheduleActualFlush` rAF 回调双门豁免判底路径（L350–354）；`onScroll` 让行判据（L439–449）；`setActual` 锁内判底分支（L484–496）+ 依赖数组 +`manager` | ✅ 与规格 1–3、5 逐字一致；未见报告外生产改动 |
| `useVirtualScroll.test.ts` | +326/−0：文末追加 `describe('S折叠同钟 · 判底折叠逐帧落高 + 钉底（S9 规格 1–6）')`（L751 起），5 用例：判底主契约（L840）、非底部旧行为快照（L878）、手势让行（L926）、中途反向（L974）、边界（L1023）；helpers `makeFoldContainer` / `setupFold` / `fireScroll` / `driveFoldFrame` 均在 | ✅；`it(` 计数 29，与报告"hook 29"精确一致 |
| `VirtualScrollManager.test.ts` | 工作区 diff（index→工作区）+42/−0：文末追加 1 用例"判底钉住结论的锁周期生命周期"（L1280 起），覆盖未判定→置 true→嵌套保持→部分释放保持→完全释放复位→下周期重判、false 保持至释放 | ✅ 与报告一致；**但见 §三纠缠：另有 1 行暂存改动** |

未动项核实：`git status` 显示 `FoldableToolGroup.tsx`、`toolExpansionState.ts`、`MessageVirtualizer.tsx` 均**无改动**（报告规格 5"组本体未动、取得方零签名变更"属实；调用点仍在 `FoldableToolGroup.tsx:90` 的 `acquireAccordionMotionLock(duration + 60)` 与 `toolExpansionState.ts:614` 的 `acquireAccordionMotionLock(350)`，与报告行号一致）。

未独立复核项（只读约束，未跑测试；磁盘无法验证）：定向 102 绿 / 回归 50 绿 / `tsc` 0 错误的运行数字；实机轨迹表（§三）的采样值。但两项旁证成立：① 磁盘 `AccordionBottomPinned` 出现次数 `useVirtualScroll.ts` 9 次 / `VirtualScrollManager.ts` 3 次，与报告 HMR 核验数字完全一致；② 新增测试的断言内容（主契约逐帧 ≤1px、解锁阶跃 ≤1px、手势让行、反向、边界）与报告描述的契约逐项对应，且边界用例确为修正后形态（无容器时 `hasAccordionBottomPinnedDecision()` 断言 `true`、实测值仍 null，L1044–1052）。

---

## 二、Design Y 独立复核：论证成立（附一项时序前提说明）

S9 §3 第 1 款原文（`S9-高度族.md:69`）："flush/钉底前检查手势状态（`gestureActiveRef` 为真，或原生 scroll 事件显示用户已离底 > ε）→ 立即取消本锁的 `bottomPinned`"。

本批未按字面实现，改走 scroll 事件判别器。报告 §五给出三点理由，逐项源码验证如下。

### (a) 用户折叠确实经过 pointerdown → 锚定 hook → cancelProgrammaticScroll() → bumpGestureEpoch() —— ✅ 成立

链路有**三条独立路径**，任一成立即足以激活手势冻结：

1. **锚定 hook（React 捕获）**：`MessageVirtualizer.tsx:617` 在滚动容器 div（即 `vs.containerRef` 同一元素，`ref={vs.containerRef}`，L603）上挂 `onPointerDownCapture={handlePointerDownCapture}`。`useScrollAnchoringOnToggle.ts:157–159` 的 `handlePointerDownCapture` 对容器内**任何** pointerdown（除回底浮钮豁免外）**无条件**先调 `cancelProgrammaticScroll()`；若命中折叠控件选择器再经 `activateAnchorLock()`（L128–133）第二次调 `cancelProgrammaticScroll()`。折叠行渲染在该容器内的 `.listInner` 中，故折叠点击必然经过此 handler。
2. **手势 hook 自身的原生捕获监听**：`useVirtualScrollGesture.ts:175–190` 在同一容器元素上以 capture 挂 `wheel / touchstart / touchmove / pointerdown`，全部指向 `cancelProgrammaticScroll()`。键盘触发的折叠同样覆盖：`handleKeyDownCapture`（Enter/Space，`useScrollAnchoringOnToggle.ts:177–195`）→ `activateAnchorLock()` → `cancelProgrammaticScroll()`。
3. **滚动态 handler 的 wheel/touchmove 路径**：`messageVirtualizerScrollState.ts:120–148` 的 `handleWheelCapture` / `handleTouchMoveCapture` 同样无条件调 `vs.cancelProgrammaticScroll()`。

`cancelProgrammaticScroll()` 本身（`useVirtualScrollGesture.ts:130–137`）= 清令牌 + `state.epoch += 1` + **`bumpGestureEpoch()`**；`bumpGestureEpoch()`（L116–123）置 `gestureActiveRef.current = true` 并以 `GESTURE_FREEZE_MS`（`virtualScrollConstants.ts:16`，**= 100ms**）定时器维持冻结。报告 §五"两者都在折叠点击时激活手势冻结"属实，且实际是三路。

补充：`gestureActiveRef` 是**无来源标注的纯布尔值**（`useVirtualScrollGesture.ts:66`，`useRef(false)`），任何调用方 bump 后无法区分"折叠点击的冻结"与"用户滚动的冻结"——报告"点击的 epoch 与滚动的 epoch 在标志层面不可区分"属实。

### (b) 按 S9 原文检查 gestureActiveRef，会使所有用户折叠永不钉底 —— ✅ 成立（实质成立；"永不"依赖一个未明写的时序前提，正常路径下成立）

成立的机理（两重，任一成立即致命）：

- **第一重 · 决策点粘性**：判底决策每锁周期只做一次——`setActual` 锁内分支（`useVirtualScroll.ts:484–496`）仅当 `!hasAccordionBottomPinnedDecision()` 时打标；一旦标为 false，`hasDecision()` 为真，本周期内永不再重判；锁只在 0→1 / 1→0 跃迁时复位（`VirtualScrollManager.ts:322–335`）。S9 的"立即取消"是粘性取消：首次锁内写入/flush 时若 `gestureActiveRef` 为真，决策即被钉死为 false，**整个锁周期（350ms `toolExpansionState.ts:614` / duration+60 `FoldableToolGroup.tsx:90`）都不会再钉底**。系统自动折叠无 pointerdown、无手势冻结，故不受影响——报告"该机制只对系统发起的自动折叠生效"属实。
- **第二重 · 钳制重 bump 自持环**：即便把检查放在每次 flush（非粘性跳过），抑制钉底本身也会维持冻结——高度收缩时浏览器钳制 `scrollTop` 下移 → 原生 scroll 事件 → `handleScroll` 首行调 `vs.onScroll(e)`（`messageVirtualizerScrollState.ts:155–156`）→ 非程序化分支 `bumpGestureEpoch()`（`useVirtualScroll.ts:438`）→ 冻结每帧（~16ms）被刷新，远短于 100ms 窗口，**整个锁周期内 `gestureActiveRef` 恒真**，逐帧检查永远命中。抑制是自持的。

**时序前提说明（报告未明写，但不推翻结论）**：第一重依赖"首个锁内写入/flush 落在 pointerdown 后 100ms 冻结窗内"。前台正常路径下该前提成立（pointerdown→click 通常 <50ms；高度 transition 启动后 ResizeObserver 首帧回调在 1–2 帧内；锁长 350ms+ 远大于冻结窗）。严格说，若首个锁内写入被拖到 100ms 窗外（如后台标签页 rAF 节流、极慢 React 提交）且其间无钳制 scroll 事件重 bump，字面检查不会触发、钉底仍可发生——但这属于退化时序，且第二重自持环一旦有一次钳制事件即重新锁死。建议收口时在 Design Y 段落补一句该前提（100ms 窗 + 自持环），使"永不"论证自足；**不构成修补阻塞项**。

### (c) 行级 scroll-event discriminator（>2px 离底清标志）真实存在 —— ✅ 成立

`useVirtualScroll.ts:434–449` 的 `onScroll`：

- L434–437 程序化事件提前返回（`isProgrammaticScrollEvent` 单次消费令牌），故钉底自身的 scroll 事件永不进入判据；
- L438 `bumpGestureEpoch()`；
- L440–448：`if (manager.isAccordionBottomPinned())` 且 `scrollHeight − clientHeight − scrollTop > BOTTOM_STICK_EPSILON_PX`（`virtualScrollConstants.ts:10`，**= 2px**）→ `manager.setAccordionBottomPinned(false)`，随后 `applyScrollTop`。

与 S9 §3 第 2 款（"原生 scroll 事件显示用户已离底 > ε"）逐字对应；判底口径与 `isContainerAtBottom`（`useAccordionViewportGuard.ts:55–59`，同为 `≤ BOTTOM_STICK_EPSILON_PX`）共用同一 2px 常量。另核实：`handleScroll` 确为容器 `onScroll` 的唯一入口并首行转发 `vs.onScroll(e)`，故判别器在真实滚动事件路径上。

**判别器的已知盲区（非阻塞，登记备查）**：① 只响应实际产生 `scrollTop` 变化的 scroll 事件——在精确底边继续向下滚轮（无位移、无事件）时不触发让行，但此时用户也未实际离底，无害；② 读的是 DOM `scrollHeight`，报告自认其滞后模型一帧，离底判断可能延迟一帧；③ 令牌双帧 rAF 兜底过期后若钉底 scroll 事件迟到，会被误判为用户滚动而误清标志（令牌设计既有属性，非本批引入）。

### 独立判断：**论证成立**

三点理由全部在源码中逐行坐实；偏离 S9 §3-1 改走 §3-2 是正确的——按字面实现会使本案目标（用户贴底折叠）整体失效，而 scroll 判别器保留了手势让行的实质（用户滚动约 1 帧内让行，测试用例 L926 覆盖）。

---

## 三、纠缠分析

- **本批四文件的工作区 diff 是纯净的**：生产两文件 +94/+31 行、测试两文件 +326/+42 行，全部 hunk 均属 S 折叠同钟，无他线 hunk 混入同一文件。
- **但 `VirtualScrollManager.test.ts` 存在跨线纠缠（暂存区）**：`git status` 显示该文件为 `MM`（暂存+工作区双改动）。`git diff --cached` 显示一条**已暂存、非本批**的改动：第 1173 行性能阈值 `expect(buildDuration).toBeLessThan(20.0)` → `100.0`（1 行，1+/1−），属他线（阈值放宽，与折叠无关）。该改动已 baked 进工作区文件（磁盘 L1176 即 `100.0`），而本批的工作区 diff（index→工作区）是其后追加的 +42 行新用例，两者在文件内**行不交叠**（1173 vs 1279 起），但**同一文件不能整体原样提交**：随批提交该文件会把他线的阈值放宽一并带入 S 折叠同钟主题。
  - **拆分要求**：主题提交该文件前，先把 1173/1176 行的 `100.0` 恢复为 `20.0`（或将其暂存改动另行提交归属原线），再提交本批 +42 行；`git commit --only` 不能解决——该行已在工作区文件内，`--only` 同样会带入。
- **仓库整体状态**：`git diff --cached --stat` 显示 **248 文件已暂存（+24555/−6685）**，另有大量未暂存改动——收口正在大规模暂存各批，S 折叠同钟只是其中一岛。提交本批时须按文件精确取材，不得 `git commit -a`。
- **分支/HEAD**：`chore/settings-rework-20261101`，HEAD `ffdb17792`；本批四文件仍未提交（与报告"完成，未提交"一致）。
- **新立规则相关**：MEMORY.md 2026-11-06 08:16 新增用户口径——"提交的话可以勤快一点，这种的不用我批才行的哈"，即已验证的主题提交无需再等用户批准。本批已验证通过，拆分完成后应按此口径**及时提交**，不必等待。

---

## 四、登记项现状

| # | 报告登记项 | 复核时现状 |
|---|---|---|
| 1 | Design Y（§五） | 见 §二：**论证成立**，偏离有据；建议补一句时序前提，非阻塞 |
| 2 | 嵌套锁 epoch 语义 | 源码仍如报告所述：仅 0→1 / 1→0 跃迁复位，嵌套保持；无变化 |
| 3 | **`setEstimated` 无锁门** | **仍在**：`useVirtualScroll.ts:461–470` 只有手势门（`gestureActiveRef` 时入队，否则直写 `manager.setEstimated`），无 `isAccordionMotionLocked()` 检查。锁内若有行挂载/重挂载产生估计写入，模型总高会单步变化、钉底下次实测 flush 才追回。报告定性"边界登记"恰当 |
| — | **新增同类（报告未登记）**：`preloadEstimates` 同样无锁门 | `useVirtualScroll.ts:507–529`：同样只有手势门，直写 `manager.preloadEstimates` + 可能递增 `actualTick`。与 `setEstimated` 同一缺口形态，建议与登记项 3 并案处理（后续收紧时一并走"判底即时 flush/钉底或估计写入入队"） |
| 4 | ΔH 幅度仅 24px，大组重测可加强证据 | **未做**：磁盘上无大组重测记录；仍为登记项，机制证明本身完整，不阻塞提交 |
| 5 | 修前轨迹缺失（无修前对照） | **仍缺**：无法从磁盘补采；对照仍为 S9 机制描述，报告已诚实注明 |
| 6 | 实机探查副作用与复原 | 磁盘无法核实；报告自述已复原（会话停在复现会话、两组收起），无反证 |
| 7 | HMR 大小写教训 | 磁盘旁证：`AccordionBottomPinned` 出现 9/3 次与报告一致 |
| 8 | orange 运行器 | 未核实运行器文件本身；与本批正确性无关 |
| 9 | 未动项 | 已核实：FoldableToolGroup / 零 CSS / 未 commit-push-stash 均属实 |
| — | 锚定 hook conflation（报告 §五跟进观察） | **仍在源码里**：`useScrollAnchoringOnToggle.handlePointerDownCapture` 对折叠开关目标调 `cancelProgrammaticScroll()`（L157–168 经 `activateAnchorLock`），且手势 hook 原生监听 + `messageVirtualizerScrollState` wheel/touchmove 三路并存；源头修复仍超出本批范围，维持登记 |

---

## 五、结论

**可提交，附一项拆分条件 + 两项可选修补。**

- **必须（提交前）**：拆出 `VirtualScrollManager.test.ts` 第 1176 行（磁盘行号；diff 行号 1173）的他线暂存改动 `toBeLessThan(100.0)` → 恢复 `20.0`（或将其归属原线另行提交），再按主题提交本批四文件。未拆分前，该文件不得随批提交；其余三文件可直接提交。
- **可选修补 1（文档，推荐）**：在报告 Design Y 段落或 `flushActualMeasurements` 注释处补一句时序前提——"首个锁内写入落在 pointerdown 后 100ms 冻结窗内（前台正常路径），且钳制 scroll 事件会重 bump 冻结使抑制自持"，使"永不钉底"论证自足。
- **可选修补 2（代码，非阻塞）**：`setEstimated`（`useVirtualScroll.ts:461–470`）与 `preloadEstimates`（L507–529）的锁内估计写入缺口，按报告登记项 3 的后续方向收紧（判底即时 flush/钉底，或估计写入入队）。属边界场景（实机未触发），不阻塞本次提交，可另立小批。
- **不需修补**：Design Y 偏离本身正确，不回退；测试数字与实机轨迹的复核限度已在 §一末说明（未重跑测试，数字以文件内容核对为准）；大组重测与修前轨迹缺失维持登记，不阻塞。
- **提交口径**：按用户 2026-11-06 08:16 最新口径，已验证主题提交无需再等用户批准——拆分完成后即可提交。
