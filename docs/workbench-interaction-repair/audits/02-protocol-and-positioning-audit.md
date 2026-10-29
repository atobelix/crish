# 首要通信协议下拉选择与 usePositioner 浮层定位源码级深度审计报告

> **审查对象**：commit `f6ae63f5f` 及关联提交 `fd68ccc8d` 中涉及的 UI 浮层几何与定位改动  
> **审查基准文件**：  
> - `apps/crish-desktop/src/components/ui/Select/SelectContent.tsx`  
> - `apps/crish-desktop/src/components/ui/Select/ComboboxContent.tsx`  
> - `apps/crish-desktop/src/components/ui/internal/positioner/usePositioner.ts`  
> - `apps/crish-desktop/src/components/ui/internal/positioner/geometry.ts`  
> - `apps/crish-desktop/src/components/ui/Select/Select.test.tsx`  
> - `apps/crish-desktop/src/components/settings-models/ProviderProfileForm.tsx`  
> - `docs/workbench-interaction-repair/02-protocol-and-positioner-dropdown-plan.md`  
> **审计角色**：UI 浮层几何与定位专家（Geometry & Protocol Reviewer）  
> **审计日期**：2026-10-29  

---

## 目录
1. [执行摘要与审计评级](#一执行摘要与审计评级)
2. [维度一：几何定位真理源（Positioner SSOT）与样式接管安全评估](#二维度一几何定位真理源positioner-ssot与样式接管安全评估)
3. [维度二：边界条件穿透测试与极端场景鲁棒性](#三维度二边界条件穿透测试与极端场景鲁棒性)
4. [维度三：下拉框受控草稿（Controlled Draft）与数据流完整性](#四维度三下拉框受控草稿controlled-draft与数据流完整性)
5. [维度四：测试覆盖完备性与测试资产保护审查](#五维度四测试覆盖完备性与测试资产保护审查)
6. [问题清单与客观定级 (Critical / Major / Minor / Suggestion)](#六问题清单与客观定级)
7. [修复方案与代码落地建议](#七修复方案与代码落地建议)

---

## 一、执行摘要与审计评级

本次交互修复战役针对工作台模型设置页面中“首要通信协议下拉选项点击后无反应/瞬间消失”及“协议选项切换后回跳”两大阻断性故障，实施了定位引擎解耦与受控草稿改造。

**综合审计结论**：
- **肯定项**：彻底排除了在虚拟 DOM inline style 中重复注入 `left: ${position.x}px; top: ${position.y}px` 导致的 **2x 物理坐标叠加翻倍飞出屏幕**的致命缺陷；成功将定位真理源交由 `usePositioner` 的真实 DOM 操作函数 `applyPositionStyles` 接管；`ProviderProfileForm` 中引入 `protocolDraft` 并在用户交互时立即执行本地状态更新，消除了选中后的视觉卡顿与延迟。
- **不足与隐患**：
  1. **【Major】持久化失败时缺乏回滚逻辑**：表单在保存失败（`!res.ok` 或异常）时未将 `protocolDraft` 恢复至 `effectiveProtocol`，形成伪成功的 UI 状态欺骗；
  2. **【Major】`alignItemWithTrigger` 默认启用引发定位冲突**：`SelectContent` 默认开启原位覆盖模式且未传 `selectedItemOffsetY`，绕过了避让翻转（Flip）算法并导致浮层遮挡触发器，与详案中“停靠在触发器下方 sideOffset=6”的契约背离；
  3. **【Major】测试资产缺口严重**：单测对 DOM 样式的断言被弱化，详案规划的核心持久化与回滚用例未在 `ProviderProfileForm.test.tsx` 中落地，`Combobox.test.tsx` 遗漏几何去重用例；
  4. **【Minor】测试排版仿真引擎缺失 `style.translate` 支持**：`mockGeometryShims.ts` 忽略了独立变换属性，导致集成测试无法断言真实 DOM 坐标。

---

## 二、维度一：几何定位真理源（Positioner SSOT）与样式接管安全评估

### 1. 2x 坐标飞移的根因根除验证
- **历史缺陷机理**：在 `fd68ccc8d` 之前，`SelectContent.tsx`（原 124-125 行）与 `ComboboxContent.tsx`（原 76-77 行）在 JSX 虚拟 DOM 中直接绑定了内联样式 `left: ${position.x}px; top: ${position.y}px`。而在 `usePositioner` 的微任务/LayoutEffect 阶段，`applyPositionStyles` 同样直接修改真实 DOM：
  ```ts
  // geometry.ts:547-551
  el.style.position = 'fixed';
  el.style.left = '0px';
  el.style.top = '0px';
  el.style.translate = `${corrected.x}px ${corrected.y}px`;
  ```
  在 React 后续重渲染中，VDOM Diff 算法将 `position.x` 再次覆写回 DOM 的 `style.left`，导致浏览器计算复合变换矩阵时产生 `left (x) + translate.x (x) = 2x` 的双倍位移，浮层瞬时飞出视口可见范围。
- **改动有效性实证**：`fd68ccc8d` 精确删除了 `SelectContent.tsx` 与 `ComboboxContent.tsx` 内联 style 中的 `left` 和 `top` 键。在 React 协调阶段，由于 JSX `style` 对象中不再声明 `left` 与 `top`，React 不会介入这两个属性的 DOM 变动，完全保留了 `applyPositionStyles` 写入的 `left = '0px'`、`top = '0px'` 与 `translate = '${corrected.x}px ${corrected.y}px'`。

### 2. CSS Transforms Level 2 独立属性解耦评估
- **CSS 动效冲突防御 (DEF-03)**：
  在 `apps/crish-desktop/src/styles/design-system.css:15-36` 中，浮层入场动效使用 keyframes：
  ```css
  @keyframes crish-popover-enter {
    0% { opacity: 0; transform: scale(0.97) translateY(-4px); }
    100% { opacity: 1; transform: scale(1) translateY(0); }
  }
  ```
  根据 W3C CSS Transforms Module Level 2 规范，独立 CSS 属性 `translate`、`rotate`、`scale` 与复合属性 `transform` 在数学解算阶段处于不同的正交层级（独立属性优先在局部坐标系生效，最后叠加 `transform` 矩阵）。
  因此，`applyPositionStyles` 写入 `el.style.translate`，完美避开了 CSS 动效对 `transform` 的改写，实现了动效与几何绝对定位的物理隔离。

### 3. 未清理死属性残留 (Dead Code Residue)
定位至 [`SelectContent.tsx:40-47`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/SelectContent.tsx#L40-L47) 与 [`ComboboxContent.tsx:38-45`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/ComboboxContent.tsx#L38-L45)：
```tsx
  const position = {
    x: posReturn.result?.x ?? 0,
    y: posReturn.result?.y ?? 0,
    transformOrigin: posReturn.result?.transformOrigin ?? 'top left',
    isPositioned: posReturn.isPositioned,
    side: posReturn.result?.actualSide ?? side,
    align: posReturn.result?.actualAlign ?? align,
  };
```
在移除 JSX 内联样式的 `left` 和 `top` 后，`position.x` 和 `position.y` 在整个组件的作用域内再无任何消费点。该属性计算虽不产生额外副作用，但属于无意义死数据，容易对后续维护者造成“坐标仍从 `position` 读取”的误导。

---

## 三、维度二：边界条件穿透测试与极端场景鲁棒性

### 1. 全屏 Modal 弹窗环境（DialogOverlayContext 与 Containing Block 偏移）
- **实现机理**：
  `SelectContent.tsx:20-27` 实现了三级挂载容器解析策略：
  `portalContainer ?? dialogOverlay ?? document.body`。
  当位于 Dialog 弹窗内时，浮层自动 portal 到 `dialogOverlay`（`data-dialog-overlay=""` 节点）。
- **坐标补偿逻辑 (DEF-01)**：
  在 `geometry.ts:228-273` 中，`correctContainingBlock` 获取 `containingBlock.getBoundingClientRect()` 并减去其偏移：
  ```ts
  const offsetX = cbLeft - scrollLeft;
  const offsetY = cbTop - scrollTop;
  return { x: Math.round(x - offsetX), y: Math.round(y - offsetY) };
  ```
  在 Dialog overlay 铺满全屏（`position: fixed; inset: 0`）时，`cbLeft = 0, cbTop = 0`，偏移修正为 0，定位精确贴合触发器。
- **潜在隐患（非 Containing Block 容器挂载）**：
  若外部向 `portalContainer` 传入了一个普通的相对定位容器（`position: relative` 但无 `transform`/`filter`/`will-change`），在标准浏览器中，该容器**并不构成 fixed 元素的包含块**（Containing Block 依然是视口）。此时 `correctContainingBlock` 盲目减去 `cbLeft/cbTop`，会导致浮层坐标发生**反向位移**。建议后续增加包含块特征检测（如检查 `getComputedStyle` 的 `transform`/`filter`/`contain` 属性）。

### 2. 滚动容器 `overflow-y: auto` 穿透
- **事件捕获 (Capture) 覆盖**：
  `usePositioner.ts:169-172` 通过在 window 上开启捕获阶段侦听：
  ```ts
  window.addEventListener('scroll', handleUpdate, { passive: true, capture: true });
  ```
  由于原生 `scroll` 事件在局部容器上不冒泡（Non-bubbling），利用 capture: true 可以 100% 捕获到内部设置面板的滚动事件，并在每一帧（rAF）重新调用 `update()` 重新计算 `anchorRect`，跟随触发器实时重绘。
- **脱节缺陷（Detached Floating Layer Clamping）**：
  当用户大幅滚动设置面板，导致触发器滚出可视窗口外部（例如滚入弹窗顶部或屏幕下方盲区）时，`geometry.ts:316-323` 与 `522-524` 的刚性视口钳位逻辑（`Math.min(Math.max(minY, targetY), maxY)`）会将浮层强行吸附在视口边缘（`8px` 边缘留白处），浮层与触发器发生物理脱节，界面上残留悬浮孤岛。缺少 Floating UI 规范中的 `hideWhenDetached` 判定机制。

### 3. 视口边缘翻转（Flip Hysteresis）与原位模式（alignItemWithTrigger）冲突
- **迟滞锁机制实证 (DEF-08)**：
  `usePositioner.ts:89` 与 `geometry.ts:345-372` 正确引入了 `currentSideRef.current`，仅在空间显著不足且对侧空间明显更大时翻转，有效防止了动态搜索过滤时浮层高度抖动带来的反复上下震荡。
- **【重大设计断裂】`SelectContent` 原位模式强制遮挡触发器**：
  定位至 [`SelectContent.tsx:16`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/SelectContent.tsx#L16)：
  ```tsx
  export function SelectContent({
    className,
    align = 'start',
    side = 'bottom',
    sideOffset = 6,
    edgePadding = 8,
    portalContainer,
    alignItemWithTrigger = true, // 默认开启原位模式！
    children,
  }: SelectContentProps)
  ```
  而 [`SelectRoot.tsx:301-305`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/SelectRoot.tsx#L301-L305) 在渲染 options 模式时未声明该参数，导致进入 [`geometry.ts:308-336`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/internal/positioner/geometry.ts#L308-L336)：
  ```ts
  if (alignItemWithTrigger) {
    const targetX = anchor.left - (floatW - anchor.width) / 2 + alignOffset;
    const targetY = typeof selectedItemOffsetY === 'number'
      ? anchor.top + anchor.height / 2 - selectedItemOffsetY
      : anchor.top - 4; // 硬编码覆盖在触发器上方 4px
    ...
    return {
      x: Math.round(clampedX),
      y: Math.round(clampedY),
      actualSide: 'bottom',
      actualAlign: 'center',
      ...
    };
  }
  ```
  **后果**：
  1. `side = 'bottom'` 与 `sideOffset = 6` 在 `geometry.ts` 中被直接无视；
  2. 浮层不是停靠在输入框下方，而是直接覆盖在输入框上面（`top - 4px`）；
  3. 由于 `selectedItemOffsetY` 未计算，根本无法实现 macOS 风格的“选中项精确覆盖”，反而直接遮挡了输入框；
  4. 碰撞避让翻折（`avoidCollisions`）在此分支被完全跳过！当触发器位于屏幕底部边缘时，浮层无法 Flip 向上弹出，而是被压扁在底部视口边界。这与详案 02 中“浮层精准贴合在触发器下方（sideOffset=6）”的目标严重冲突。

### 4. 窗口尺寸调整与分屏拖拽（Resize Latency）
`usePositioner.ts:168` 仅监听了自定义事件 `'app:window-resize-settled'`：
```ts
window.addEventListener('app:window-resize-settled', handleUpdate);
```
该事件在 `WindowResizeBridge.ts:8` 中定义了 `DEBOUNCE_MS = 150`。在用户拖拽窗口边缘或左右分栏分割线（Splitter）时，`150ms` 期间不触发任何更新，浮层坐标保持静止，直到松开鼠标 150ms 后才瞬跳至新位置。此外，未直接监听 `window.addEventListener('resize')`，在纯浏览器开发调试或分栏布局变动（非窗口变动）时，浮层将失去响应能力。

---

## 四、维度三：下拉框受控草稿（Controlled Draft）与数据流完整性

### 1. 乐观更新与用户输入响应
定位至 [`ProviderProfileForm.tsx:298-311`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ProviderProfileForm.tsx#L298-L311)：
```tsx
<Select
  size="sm"
  value={protocolDraft}
  onChange={(val) => {
    const next = protocolForProviderWrite(val);
    setProtocolDraft(next);
    persistProviderPatch({ protocol: next });
  }}
  options={[...YAML_PROTOCOL_SELECT_OPTIONS]}
/>
```
当用户点击切换协议时，`setProtocolDraft(next)` 同步触发，驱动 `Select` 组件重新渲染并高亮新选项，输入框文本立即变化，彻底消除了旧版本等待异步写盘返回前的界面无响应感。

### 2. 与统一树（Unified Tree）及外部更新的联动
- **多条件依赖同步**：
  [`ProviderProfileForm.tsx:81-83`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ProviderProfileForm.tsx#L81-L83)：
  ```tsx
  useEffect(() => {
    setProtocolDraft(effectiveProtocol);
  }, [selected.id, effectiveProtocol, catalogVersion]);
  ```
  其中 `effectiveProtocol = toYamlProtocol(storeProvider?.protocol ?? selected.protocol) ?? DEFAULT_PROTOCOL`。
  当发生外部配置变更（例如后台文件侦听器重载、其他窗口修改、用户在左侧切换服务商），`catalogVersion` 或 `selected.id` 变动，`useEffect` 能够平滑将外部最新真理源同步至 `protocolDraft`。
- **无竞态回弹实证**：
  在异步写入执行过程中，`modelsCatalogStore.updateProvider` 尚未完成前，`effectiveProtocol` 保持原值，`catalogVersion` 尚未增加，`useEffect` 不会触发，因此用户不会遭遇“选完立刻弹回旧协议”的异步回跳现象。

### 3. 【重大功能缺陷】写入失败时缺乏回滚机制 (No Rollback on Failure)
定位至 [`ProviderProfileForm.tsx:118-166`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ProviderProfileForm.tsx#L118-L166)：
```tsx
const persistProviderPatch = (patch: { baseUrl?: string; protocol?: ModelProtocol }) => {
  void runAsLocalMutation(async () => {
    try {
      ...
      const shell = await ensureProviderShell({...});
      if (!shell.ok) {
        notify(false, shell.error || '写入服务商失败');
        return; // ❌ 缺陷：未回滚 protocolDraft！
      }

      const res = await modelsCatalogStore.updateProvider(selected.id, updatePatch);
      if (!res.ok) {
        notify(false, res.error || '保存失败'); // ❌ 缺陷：未回滚 protocolDraft！
      } else {
        _refresh();
      }
    } catch (e) {
      notify(false, e instanceof Error ? e.message : String(e)); // ❌ 缺陷：未回滚 protocolDraft！
    }
  });
};
```
**严重风险场景实证**：
假设用户在无写入权限、磁盘空间不足（例如本机出现的 `ENOSPC`）、或 YAML 格式受损时，将协议由 `openai/chat` 切换为 `anthropic/messages`：
1. `setProtocolDraft('anthropic/messages')` 立即执行，界面显示新协议；
2. 后台调用 `updateProvider` 失败，返回 `{ ok: false, error: '...' }` 并弹出 Toast 报错；
3. **但是 `protocolDraft` 依旧停留在 `'anthropic/messages'`！**
4. 用户误以为报错仅是临时通知，继续配置 API Key 或进行模型测试，底层通信协议依然是旧的 `openai/chat`，引发严重的协议与端点不匹配故障。

---

## 五、维度四：测试覆盖完备性与测试资产保护审查

### 1. `Select.test.tsx` 现有 20 个测试审查
在 [`Select.test.tsx:363-370`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/Select.test.tsx#L363-L370) 中，新增测试用例：
```tsx
it('浮层几何去重：不在 listbox 上重复设置 inline left/top 导致 2x 坐标飞出视口', async () => {
  render(<ControlledSelect defaultOpen options={OPTIONS} />);
  const listbox = screen.getByRole('listbox');
  // applyPositionStyles 规范将 DOM left/top 归零为 '0px'，并通过 translate 进行平移
  // 组件内联 style 不得再次注入 position.x/position.y 覆盖 '0px'
  expect(listbox.style.left).toBe('0px');
  expect(listbox.style.top).toBe('0px');
});
```
**断言弱化实证分析**：
- 该用例仅验证了 `listbox.style.left === '0px'` 与 `listbox.style.top === '0px'`。
- 它**没有**验证 `listbox.style.position === 'fixed'`；
- 它**没有**验证 `listbox.style.translate` 是否被赋予了非空、合法的像素位移值；
- 在极端情况下，如果某次代码重构误删了 `applyPositionStyles(el, res, ...)` 的调用，`left` 和 `top` 依然可能为 `'0px'`（或空），该测试依然会错误通过，失去了对“真实定位已成功生效”的防护能力。

### 2. 计划与实现断裂：详案规划测试遗漏统计
对照详案 [`02-protocol-and-positioner-dropdown-plan.md`](file:///c:/Software/conex/docs/workbench-interaction-repair/02-protocol-and-positioner-dropdown-plan.md) §五 规划的验收测试用例：

| 详案规划用例名称 | 目标测试文件 | 实际落地状态 | 风险评估 |
| :--- | :--- | :---: | :--- |
| `SelectContent 浮层 DOM 的 style.left 与 style.top 保持为 0px，由 translate 驱动定位` | `Select.test.tsx` | ⚠️ 部分落地（缺少 translate 断言） | 易发生假绿 |
| `ComboboxContent 浮层 DOM 的 style.left 与 style.top 保持为 0px，由 translate 驱动定位` | `Combobox.test.tsx` | ❌ 未落地 | Combobox 缺乏几何去重防回归守门 |
| `切换协议时立即乐观更新 Select 选值，并在后台成功持久化` | `ProviderProfileForm.test.tsx` | ❌ 未落地 | 协议状态与 YAML 写入断言缺失 |
| `持久化失败时回滚 protocolDraft 并通知用户` | `ProviderProfileForm.test.tsx` | ❌ 未落地 | 失败回滚机制无自动化守门 |
| `Escape 关闭面板后焦点精确返还至触发器` | `Select.test.tsx` | ⚠️ 仅断言关闭，未断言 `activeElement === trigger` | A11y 焦点回归未完备 |

### 3. 测试环境底层仿真断裂：`MockPhysicalGeometryEngine` 盲区
在 [`mockGeometryShims.ts:180-200`](file:///c:/Software/conex/apps/crish-desktop/src/test-utils/mockGeometryShims.ts#L180-L200) 与 `216-224` 中：
```ts
const tf = this.style.transform || parent.style.transform ||
           this.style.getPropertyValue('--tooltip-translate');
```
仿真引擎在模拟 DOMRect 时，只从 `style.transform` 中正则解析位移量，**完全没有读取 `this.style.translate`**！
这导致在 Vitest/jsdom 测试中，任何经过 `usePositioner` 真实定位的元素，其 `getBoundingClientRect()` 永远停留在 `(0, 0)`，这也是导致业务单测只能弱化为断言 `style.left === '0px'` 而无法断言真实物理坐标的底层根因。

---

## 六、问题清单与客观定级

根据实证代码与场景穿透分析，对发现的问题进行客观定级：

### 【Major 架构/功能缺陷】
1. **DEF-AUDIT-01：`ProviderProfileForm` 异步写入失败时未回滚 `protocolDraft`**
   - **文件位置**：`apps/crish-desktop/src/components/settings-models/ProviderProfileForm.tsx:139-165`
   - **触发场景**：磁盘只读/写冲突/校验失败/异常中断时，UI 仍保持新协议选值，造成已成功持久化的假象，严重误导用户。
2. **DEF-AUDIT-02：`SelectContent` 默认开启 `alignItemWithTrigger` 导致避让翻转失效与覆盖遮挡**
   - **文件位置**：`apps/crish-desktop/src/components/ui/Select/SelectContent.tsx:16`、`geometry.ts:308-336`
   - **触发场景**：options 模式的通用 Select 下拉菜单覆盖触发器且在视口底部无法 Flip 向上弹出，与总纲和详案的“下方停靠”契约相悖。
3. **DEF-AUDIT-03：详案规划核心测试资产未落地与断言弱化**
   - **文件位置**：`Select.test.tsx:363`、`Combobox.test.tsx`、`ProviderProfileForm.test.tsx`
   - **触发场景**：缺少失败回滚用例、缺乏 Combobox 几何去重用例、缺少 `style.translate` 赋值有效性检验。

### 【Minor 边界/体验隐患】
4. **DEF-AUDIT-04：单测物理几何垫片 `mockGeometryShims` 遗漏 `style.translate` 解析**
   - **文件位置**：`apps/crish-desktop/src/test-utils/mockGeometryShims.ts:180-224`
   - **触发场景**：测试环境中调用 `listbox.getBoundingClientRect()` 无法感知 `style.translate`，阻碍真实物理坐标断言。
5. **DEF-AUDIT-05：窗口与分栏拖拽时浮层坐标更新延迟 150ms**
   - **文件位置**：`apps/crish-desktop/src/components/ui/internal/positioner/usePositioner.ts:168`
   - **触发场景**：拖拽调整窗口或面板大小时，由于仅监听防抖事件，浮层保持旧坐标定格，停止 150ms 后发生肉眼可见突跳。
6. **DEF-AUDIT-06：局部滚动容器溢出时缺乏浮层脱节隐藏（hideWhenDetached）**
   - **文件位置**：`apps/crish-desktop/src/components/ui/internal/positioner/geometry.ts:522-524`
   - **触发场景**：表单大幅滚动至触发器不可见时，浮层被刚性钳制在视口边缘，成为孤岛漂浮物。

### 【Suggestion 优化建议】
7. **SUG-AUDIT-07：清退 `SelectContent` / `ComboboxContent` 中的死数据 `position.x / position.y`**
   - **文件位置**：`SelectContent.tsx:41-42`、`ComboboxContent.tsx:39-40`
8. **SUG-AUDIT-08：收敛 `Select/internal/positionGeometry.ts` 历史遗留双源**
   - **文件位置**：`apps/crish-desktop/src/components/ui/Select/internal/positionGeometry.ts` 与 `Combobox.test.tsx:31`

---

## 七、修复方案与代码落地建议

### 1. 修复 `ProviderProfileForm.tsx` 写入失败时的草稿回滚
在持久化方法中精准捕获失败并重置 `protocolDraft`：
```tsx
// ProviderProfileForm.tsx:118-166 建议改造
const persistProviderPatch = (patch: {
  baseUrl?: string;
  protocol?: ModelProtocol;
}) => {
  void runAsLocalMutation(async () => {
    try {
      const cleanBaseUrl = patch.baseUrl !== undefined
        ? patch.baseUrl.trim() || undefined
        : storeBaseUrl || selected.baseUrl || undefined;
      const cleanProtocol = patch.protocol ?? storeProvider?.protocol ?? selected.protocol;

      const shell = await ensureProviderShell({
        providerId: selected.id,
        displayName: vendorName,
        baseUrl: cleanBaseUrl ?? '',
        protocol: cleanProtocol,
      });
      if (!shell.ok) {
        notify(false, shell.error || '写入服务商失败');
        if (patch.protocol !== undefined) {
          setProtocolDraft(effectiveProtocol); // 💡 回滚草稿
        }
        return;
      }

      const updatePatch: Partial<ProviderSpec> = {};
      if (patch.baseUrl !== undefined) updatePatch.baseUrl = patch.baseUrl.trim() || undefined;
      if (patch.protocol !== undefined) updatePatch.protocol = protocolForProviderWrite(patch.protocol);

      const res = await modelsCatalogStore.updateProvider(selected.id, updatePatch);
      if (!res.ok) {
        notify(false, res.error || '保存失败');
        if (patch.protocol !== undefined) {
          setProtocolDraft(effectiveProtocol); // 💡 回滚草稿
        }
      } else {
        _refresh();
      }
    } catch (e) {
      notify(false, e instanceof Error ? e.message : String(e));
      if (patch.protocol !== undefined) {
        setProtocolDraft(effectiveProtocol); // 💡 回滚草稿
      }
    }
  });
};
```

### 2. 修正 `SelectContent.tsx` 的默认停靠策略
将 `alignItemWithTrigger` 默认值设为 `false`，仅在需要 macOS 原位对齐时显式启用：
```tsx
// SelectContent.tsx:16
export function SelectContent({
  className,
  align = 'start',
  side = 'bottom',
  sideOffset = 6,
  edgePadding = 8,
  portalContainer,
  alignItemWithTrigger = false, // 💡 默认为 false，遵循 side='bottom' 与避让翻转
  children,
}: SelectContentProps)
```

### 3. 增强 `Select.test.tsx` 与补齐 `Combobox.test.tsx` 几何断言
在 `Select.test.tsx` 中增强定位样式断言，并在 `Combobox.test.tsx` 中同步补齐：
```tsx
it('浮层几何去重：不在 listbox 上重复设置 inline left/top 导致 2x 坐标飞出视口', async () => {
  render(<ControlledSelect defaultOpen options={OPTIONS} />);
  const listbox = screen.getByRole('listbox');

  expect(listbox.style.left).toBe('0px');
  expect(listbox.style.top).toBe('0px');
  expect(listbox.style.position).toBe('fixed');
  // 💡 验证由 translate 独占接管物理坐标
  expect(listbox.style.translate).toMatch(/-?\d+px\s+-?\d+px/);
});
```

### 4. 在 `mockGeometryShims.ts` 中补齐 `style.translate` 解析
```ts
// mockGeometryShims.ts:184 建议补充
let translateX = 0;
let translateY = 0;
if (this.style.translate) {
  const parts = this.style.translate.trim().split(/\s+/);
  if (parts[0] && parts[0].endsWith('px')) translateX = parseFloat(parts[0]);
  if (parts[1] && parts[1].endsWith('px')) translateY = parseFloat(parts[1]);
}
// 将 translateX / translateY 计入 finalLeft 与 finalTop
```

---

## 结论

本次改动在最关键的几何定位真理源上做出了正确的架构决断，成功斩断了引发 2x 坐标飞移的根因。但在**业务失败回滚机制**、**Select 默认原位模式与避让翻折契约冲突**以及**测试资产落地完备性**上存在显著缺陷，需按照上述方案跟进加固，确保高质量无死角交付。
