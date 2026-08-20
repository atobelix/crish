# Conex / Crish 级联菜单修复独立代码审计与架构合规报告

> **文档标识**：`docs/cascade-menu-repair/audits/01-audit-report.md`  
> **审计角色**：代码审计与架构合规专家（Code Audit Specialist）  
> **审计日期**：2026-08-20  
> **战役目录**：`docs/cascade-menu-repair/`  
> **审计结论**：**PASS（全面通过）**  
> **权威遵循**：`AGENTS.md`（反退避与架构优雅铁律）、`ANTI_OVERENGINEERING_GUARDRAILS.md`（反过度设计 13 项硬性红线）

---

## 1. 审计概览与最终裁决

本次审计针对 `ModelBadgePickerMenu` 级联菜单系统性修复的所有改动文件进行了独立、客观、全覆盖的静态代码审查、架构合规性检验与自动化测试回归验证。

### 1.1 审计目标文件清单

| 序号 | 目标文件路径 | 文件职责 | 审查状态 |
| :--- | :--- | :--- | :---: |
| 1 | `apps/crish-desktop/src/components/ui/Menu/position.ts` | 级联定位纯函数引擎（含双向数学钳位） | ✅ PASS |
| 2 | `apps/crish-desktop/src/components/ui/Menu/Menu.tsx` | 菜单基座（MenuContext 与 LayerStack 拓扑放行） | ✅ PASS |
| 3 | `apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.tsx` | 徽标下拉主组件与 Portal 二级级联子菜单 | ✅ PASS |
| 4 | `apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.module.css` | 浮层样式与包含块脱离定义 | ✅ PASS |
| 5 | `apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.test.tsx` | 红方魔鬼用例与全量交互测试矩阵（27 tests） | ✅ PASS |
| 6 | `docs/cascade-menu-repair/00-总方案.md` | 落地总方案与设计契约对齐核验 | ✅ PASS |
| 7 | `apps/crish-desktop/src/components/ui/internal/SafeTriangle.ts` | 向量三角区轨迹保护算法与 Grace Timer 状态机 | ✅ PASS |

### 1.2 最终审计判定

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 最终审计裁决：PASS（通过）                                                  │
│                                                                             │
│ 判定理由：                                                                  │
│ 1. 物理裁剪与滚动条膨胀已通过 Portal 独立挂载与 Fixed 样式彻底根除；        │
│ 2. 声明式 autoFocus 完全清除，Hover 保持绝对零抢焦，键盘聚焦显式受控；      │
│ 3. Safe Triangle 2D 向量叉积几何防抖与代际递增 Token 逻辑严密，无竞态隐患；  │
│ 4. 双向数学钳位自适应翻折算法无负坐标与穿屏，Chevron 图标与展开方向 100% 同构； │
│ 5. LayerStack 权重拓扑（50 > 40）与子孙事件放行正确，Esc 逐级退栈顺畅；     │
│ 6. 零魔术数字补偿，无 13 项过度设计违规，16 个菜单测试套件（173 tests）全绿；│
│ 7. 代码健康度与行数预算完全合规，UTF-8 无 BOM、中文注释规范。              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 逐项深度审计与检查清单核对

### 2.1 维度一：功能完备度与效果锁定（Effect Lock）

| 检查项 | 方案要求与预期行为 | 源码实现核对结论 | 判定 |
| :--- | :--- | :--- | :---: |
| **CSS 包含块物理裁剪彻底根除** | 子菜单脱离父级 `overflow-y: auto` 包含块，杜绝 X 轴截断与 Y 轴异常滚动条膨胀 | `ModelBadgePickerMenu.tsx` 提取 `ModelBadgeSubmenuPortal`，通过 `ReactDOM.createPortal` 挂载至顶层 Portal 容器（`dialogOverlay ?? document.body`），结合 `.mbSubMenuFloating { position: fixed; }`，彻底消除了包含块裁剪与滚动条膨胀。 | **PASS** |
| **声明式 autoFocus 完全清除** | 移除所有 `autoFocus` 属性，Hover 展开时保持零焦点抢占，杜绝滚动震荡与闪退 | 源码已 100% 移除 `autoFocus`。Hover 触发仅修改状态，单测断言在 80ms 后挂载渲染时，焦点牢牢保留在触发源/原按钮上，首项绝不抢焦。 | **PASS** |
| **Safe Triangle 轨迹保护与防抖** | 鼠标斜向滑向子菜单时启动 300ms 宽限期，防止掠过相邻行触发误切换 | `SafeTriangle.ts` 采用 2D 向量叉积 `isPointInTriangle` 精确判定。`SafeTriangleTracker` 状态机支持 `enter`、`check`、`reach`、`reset`，实测斜向掠过相邻行被严格拦截。 | **PASS** |
| **代际递增 Token 竞态消除** | 鼠标极速掠过多行时，清除过期的异步定时器，消除闪烁与残余浮层 | `ModelBadgePickerMenu.tsx` 使用 `timerTokenRef.current` 实现单调递增代际 Token，在 enter 与 leave 回调中精确比对 `timerTokenRef.current !== currentToken`，杜绝多任务并发竞态。 | **PASS** |
| **刚性几何定位与 Chevron 动态同构** | 智能判断左/右可用空间，内置刚性数学钳位；Chevron 图标方向与展开方向严格一致 | `position.ts` 的 `calculateSubmenuPosition` 双向数学钳位保证 $X \ge \text{minX}$ 且 $X + W \le \text{maxX}$。`ModelBadgePickerMenu.tsx` 中根据 `submenuPos.side` 动态渲染 `<Lucide.ChevronRight />` 或 `<Lucide.ChevronLeft />`。 | **PASS** |
| **Esc 逐级退栈与 LayerStack 拓扑** | 子菜单权重（50）优先于主菜单（40），第一击 Esc 关子菜单并归还焦点，第二击关主菜单 | 子菜单注册 `type: 'cascade-submenu'`（权重 50）并绑定 `parentId`，主菜单注册 `type: 'dropdown-menu'`（权重 40）。`Menu.tsx` 放行子孙 Layer 点击，单测已严格验证两级 Esc 退栈流程。 | **PASS** |
| **滚动防脱轨收起** | 主菜单滚动时立即收起子菜单，防止浮层悬空脱轨 | 主菜单滚动容器绑定 `onScroll={() => expandedProfileId && dismissSubmenu()}`，并在单测中验证了滚动立即收起与再次点击展开的自愈能力。 | **PASS** |
| **全生命周期自愈（RAII）** | `window.blur` 与 `visibilitychange` 时自动收起子菜单并清理定时器 | `useEffect` 中注册并具备完整的 cleanup 卸载监听，组件 unmount 时清理所有定时器与 tracker。 | **PASS** |

---

### 2.2 维度二：反过度设计与反打补丁审查（遵循 `ANTI_OVERENGINEERING_GUARDRAILS.md`）

审计专家依据仓库根目录反过度设计红线，对本次修复代码进行了全面排查：

1. **零盲目猜测与魔术数字补偿**：
   - 坐标计算基于 `rowRect` 几何矩形与配置项（`submenuWidth = 190`、`submenuHeight = 280`、`sideOffset = 4`、`edgePadding = 8`）；
   - 垂直对齐使用设计 Token 偏移（`-4px` 顶部微调对齐内边距），所有计算均为确定性线性代数变换，无任何 `+13px` / `-7px` 之类的盲目测距补丁。
2. **13 项禁令逐项排查**：
   - 禁令 1~7（内核沙箱 / SAB 环形缓冲 / 自动换模 / 预请求 DNS / 滑动窗口断路器 / 六段式流水线 / IpcRouter 嵌套序列化）：**无任何引入，零违规**。
   - 禁令 8（以 95% React.memo 覆盖率作硬门槛）：**无滥用 memo**，仅在必要的高频组件使用。
   - 禁令 9~13（重型套娃封装 / 滥加全局事件监听）：**无套娃**。全局事件仅包含轻量 `blur` 与 `visibilitychange`，且遵循标准 React RAII 模式，在 unmount 时 100% 卸载清理。
3. **架构正交与高内聚低耦合**：
   - 几何计算引擎（`position.ts`）为纯函数，零外部依赖，100% 可单测；
   - 轨迹检测（`SafeTriangle.ts`）为数学算法，与 DOM 操作完全解耦；
   - 浮层拓扑接入统一的 `LayerStackManager` 基础设施，无私有黑盒状态。

---

### 2.3 维度三：代码健康度与工程规范

1. **编码规范与类型安全**：
   - 所有改动文件均保存为 UTF-8 无 BOM 编码；
   - 源码包含详尽准确的中文 JSDoc 注释；
   - TypeScript 类型推导严密，接口定义清晰（`SubmenuPlacementResult`、`SubmenuProps`、`MenuContext`），本次改动相关文件在 `tsc` 编译中**零类型错误**。
2. **行数预算门禁（RL-03 Line Budgets）**：
   - 执行命令：`node scripts/check-line-counts.mjs apps/crish-desktop/src/components/ui/Menu apps/crish-desktop/src/components/provider`
   - 实测结果：
     - `apps/crish-desktop/src/components/ui/Menu/position.ts`：**323 / 500 lines**（✅ PASS）
     - `apps/crish-desktop/src/components/ui/Menu/Menu.tsx`：**387 / 500 lines**（✅ PASS）
     - `apps/crish-desktop/src/components/ui/Menu/menuKeyNavigation.ts`：**106 / 500 lines**（✅ PASS）
     - `apps/crish-desktop/src/components/ui/Menu/menuOpenGuard.ts`：**15 / 500 lines**（✅ PASS）
     - `apps/crish-desktop/src/components/ui/Menu/index.ts`：**6 / 500 lines**（✅ PASS）
     - `apps/crish-desktop/src/components/ui/Menu/types.ts`：**11 / 500 lines**（✅ PASS）
     - `apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.tsx`：**459 / 500 lines**（⚠️ 85% 预警，但严格位于 ≤500 行预算内，0 违规，0 硬阻断）
   - **门禁结论：全部通过（All passed RL-03 line budget checks）**。

---

### 2.4 维度四：全仓兼容性与防回归验证

本次对 `ui/Menu/Menu.tsx` 与 `ui/Menu/position.ts` 的改动主要为：
1. 导出 `MenuContext` 传递 `menuId`（向下透明）；
2. 在 `onPointerDownOutside` 与 `onInteractOutside` 中放行子孙 Layer 点击（对无子菜单的扁平菜单 `getDescendants()` 返回空数组，完全保持原有行为）；
3. 新增纯函数 `calculateSubmenuPosition`，未破坏既有 `calculateMenuPosition` 与 `clampPosition` 接口契约。

#### 全量菜单套件回归测试实测（16 Test Files, 173 Tests）

执行命令：
`npx vitest run apps/crish-desktop/src/components/chat-card/ProjectPickerMenu.test.tsx apps/crish-desktop/src/components/chat-composer/ComposePlusMenu.test.tsx apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.test.tsx apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.test.tsx apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.test.tsx apps/crish-desktop/src/components/settings/SettingsQuickMenu.test.tsx apps/crish-desktop/src/components/settings-models/AddProviderMenu.test.tsx apps/crish-desktop/src/components/settings-skills/SkillsMoreMenu.test.tsx apps/crish-desktop/src/components/sidebar/SidebarContextMenus.exclusive.test.tsx apps/crish-desktop/src/components/sidebar/SidebarContextMenus.flyout.test.tsx apps/crish-desktop/src/components/sidebar/SidebarContextMenus.test.ts apps/crish-desktop/src/components/ui/Menu/`

测试结果：
```
Test Files  16 passed (16)
     Tests  173 passed (173)
  Duration  13.25s
```

覆盖的核心消费方组件：
- `ModelBadgePickerMenu`（27 tests，含 5 大红方魔鬼用例）：**全部通过**
- `Menu` 基座及物理几何守卫（64 tests）：**全部通过**
- `ProjectPickerMenu`（8 tests）：**全部通过**
- `ComposePlusMenu`（12 tests）：**全部通过**
- `PermissionModeMenu`（5 tests）：**全部通过**
- `SettingsQuickMenu`（10 tests）：**全部通过**
- `SidebarContextMenus`（18 tests）：**全部通过**
- `AddProviderMenu` / `SkillsMoreMenu` / `TiptapSlashMenu`：**全部通过**

**防回归结论：改动具备完美的向后兼容性，全仓所有扁平与级联菜单消费方无任何副作用。**

---

## 3. 红方 5 大魔鬼用例专项审核

| 魔鬼用例 | 压力场景描述 | 审计实测与断言核验 | 结论 |
| :--- | :--- | :--- | :---: |
| **魔鬼用例 1** | Hover 展开不抢焦（Modality-Aware 纯视觉展开与 80ms 延迟） | 触发源获得焦点后悬停服务商行，80ms 后子菜单挂载，断言焦点严格保留在触发源上，首个模型按钮绝不抢焦。 | **PASS** |
| **魔鬼用例 2** | SafeTriangle 轨迹保护（300ms 宽限期、斜向掠过相邻行防抖、出区/超时接管） | 模拟鼠标从服务商行斜向掠过相邻服务商滑向子菜单，处于 300ms 宽限期与安全三角区内时，相邻行完全被挂起，子菜单不闪烁不销毁；离开三角区后相邻行正常接管。 | **PASS** |
| **魔鬼用例 3** | 低视口/极端靠左自适应 Flip Right 与 Chevron 动态联动（600x400 视口、刚性钳位） | 在 600x400 视口且行靠左（left: 50px）场景下，自动判定翻转为向右展开（`side: 'right'`），坐标刚性钳位（`left: 224px, top: 96px`），且行内动态渲染为 `ChevronRight` 图标。 | **PASS** |
| **魔鬼用例 4** | 键盘操作显式聚焦与漫游（Enter/ArrowLeft 展开聚焦、↑↓/Home/End 漫游、反向键/Esc 精确归还焦点） | 行按钮按 Enter/ArrowLeft 展开时受控聚焦子项；子菜单内 ↑↓ 循环漫游、Home/End 直达；按反向键或 Esc 收起子菜单并将焦点精确归还给父服务商行。 | **PASS** |
| **魔鬼用例 5** | 滚动防脱轨收起（主菜单滚动容器触发 scroll 自动收起子菜单与自愈） | 主菜单滚动容器触发 `scroll` 事件时，已展开的子菜单立即收起，防止脱轨悬空；再次点击行按钮可自愈恢复展开。 | **PASS** |

---

## 4. 优化建议与演进备忘（Non-blocking）

以下建议属于架构演进备忘，不作为本次战役阻断项：

1. **行数预算持续监控**：
   - 当前 `ModelBadgePickerMenu.tsx` 处于 459 行（预算 ≤500 行，处于 85% 预警带）。建议在后续若有新增业务逻辑时，可考虑将 `ModelBadgeSubmenuPortal` 单独抽离为独立子文件 `ModelBadgeSubmenuPortal.tsx`，以保持核心组件更极致的紧凑性。
2. **统一级联子菜单抽象（阶段二预留）**：
   - 当前实现将 `calculateSubmenuPosition` 与 `SafeTriangleTracker` 封装为公共基础设施（`ui/Menu/position.ts` 与 `ui/internal/SafeTriangle.ts`），为全仓其他可能引入级联子菜单的组件（如 `ProjectPickerMenu` 的添加项目子菜单）提供了可直接复用的工业级标准底座。

---

## 5. 审计结论与签署

综上所述，本次级联菜单系统性修复改动方案严谨、代码实现优雅、架构合规、数学刚性自适应完备、测试覆盖充分，完美解决了用户提出的全部核心缺陷，无过度设计与打补丁现象，全面满足生产交付要求。

**审计专家裁决：【PASS】予以准入上线。**
