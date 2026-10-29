# 模型供应商设置协议选择与 Select 浮层几何位移实现详案 (Plan 02)

> **战役工作区**：`docs/workbench-interaction-repair/`  
> **关联总纲**：[`00-workbench-interaction-repair-master-plan.md`](./00-workbench-interaction-repair-master-plan.md) §四.维度 2 (D2)  
> **涉及核心文件**：  
> - `apps/crish-desktop/src/components/ui/Select/SelectContent.tsx`（Select 浮层几何容器）  
> - `apps/crish-desktop/src/components/ui/Select/ComboboxContent.tsx`（Combobox 浮层几何容器）  
> - `apps/crish-desktop/src/components/settings-models/ProviderProfileForm.tsx`（供应商配置表单）  
> - `apps/crish-desktop/src/components/ui/internal/positioner/usePositioner.ts`（真实 DOM 探测定位引擎）  
> - `apps/crish-desktop/src/components/ui/internal/positioner/geometry.ts`（几何解算与 DOM 样式应用）  

---

## 一、概述与治理目标

在工作台“设置 - 模型”页面中，用户在编辑模型服务商时遇到了两大阻断性故障：
1. **“首要通信协议”下拉选择框点击后无选项弹出或瞬间消失**：用户点击协议下拉框时，浮层无法正常停靠在触发器下方，视觉上完全不可见或飞向屏幕右下方盲区。
2. **协议选项无法切换或异步回弹**：即使在特定视口尺寸下勉强选中了新的协议选项（如由 `openai/chat` 切换为 `anthropic/messages`），输入框在下拉菜单关闭后立刻弹回旧协议，底层 YAML 配置未生效。

经深入排查，该问题由两处相互独立的架构断裂叠加产生：
- **几何层断裂**：`SelectContent.tsx` 与 `ComboboxContent.tsx` 在虚拟 DOM 渲染时重复设置内联 `style.left` 和 `style.top`，与自研定位引擎 `usePositioner` 写入真实 DOM 的现代 CSS `translate` 发生物理坐标叠加，导致**浮层坐标被 2 倍放大（`2 * x, 2 * y`）**，彻底飞出视口边界。
- **状态层断裂**：`ProviderProfileForm.tsx` 中对通信协议采用了**无本地草稿的只读派生状态**（`toYamlProtocol(storeProvider?.protocol) ?? DEFAULT_PROTOCOL`），在用户触发选择并发起异步写盘时缺乏乐观受控机制，加之 storeProvider 缺少对 `selected.protocol` 的兜底，导致 UI 发生异步回弹与锁定。

本详案旨在彻底根治上述两处断裂，实现几何单轨控制与表单乐观受控，并建立严格的 A11y 键盘与防溢出回归测试门禁。

---

## 二、现状断裂证据与根因穿透分析

### 1. 浮层几何位移：内联样式与 `usePositioner` 的重复叠加 (2x 放大)

#### 1.1 源码证据
定位至 [`SelectContent.tsx:123-129`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/SelectContent.tsx#L123-L129)：
```tsx
// apps/crish-desktop/src/components/ui/Select/SelectContent.tsx:123-129
const contentNode = (
  <div
    ref={ctx.contentRef as React.RefObject<HTMLDivElement>}
    id={ctx.listboxId}
    role="listbox"
    tabIndex={-1}
    aria-orientation="vertical"
    className={contentClass}
    style={{
      left: `${position.x}px`,
      top: `${position.y}px`,
      transformOrigin: position.transformOrigin,
      visibility: position.isPositioned ? 'visible' : 'hidden',
      pointerEvents: position.isPositioned ? 'auto' : 'none',
    }}
    onKeyDown={handleKeyDown}
    ...
```

同构问题存在于 [`ComboboxContent.tsx:75-81`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/ComboboxContent.tsx#L75-L81)：
```tsx
// apps/crish-desktop/src/components/ui/Select/ComboboxContent.tsx:75-81
const contentNode = (
  <div
    ref={ctx.contentRef as React.RefObject<HTMLDivElement>}
    id={ctx.listboxId}
    role="listbox"
    tabIndex={-1}
    aria-orientation="vertical"
    className={contentClass}
    style={{
      left: `${position.x}px`,
      top: `${position.y}px`,
      transformOrigin: position.transformOrigin,
      visibility: position.isPositioned ? 'visible' : 'hidden',
      pointerEvents: position.isPositioned ? 'auto' : 'none',
    }}
    ...
```

#### 1.2 物理层渲染机理穿透
定位引擎 `usePositioner` 在 `useLayoutEffect` 中通过 `applyPositionStyles` 直接操控目标 DOM 节点的样式（见 [`geometry.ts:539-561`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/internal/positioner/geometry.ts#L539-L561)）：
```ts
export function applyPositionStyles(
  el: HTMLElement,
  res: PositionResult,
  portalContainer?: HTMLElement | null,
  anchorWidth?: number
): void {
  const corrected = correctContainingBlock(res.x, res.y, portalContainer);

  el.style.position = 'fixed';
  el.style.left = '0px';
  el.style.top = '0px';
  // 现代 CSS 独立变换属性，绝不覆盖 style.transform (DEF-03)
  el.style.translate = `${corrected.x}px ${corrected.y}px`;
  el.style.setProperty('--transform-origin', res.transformOrigin);
  ...
}
```
`applyPositionStyles` 的设计哲学是将浮层基准坐标归零（`left: 0px; top: 0px;`），然后利用现代 CSS 的独立变换属性 `translate: Xpx Ypx` 将浮层平移至目标位置，以解耦 CSS 动画中的 `transform: scale()`。

然而，在 `usePositioner` 执行完 `setIsPositioned(true)` 后，React 触发二次渲染：
1. React 虚拟 DOM 协调器发现 `SelectContent` 带有 `style={{ left: `${position.x}px`, top: `${position.y}px` }}`。
2. React 将 DOM 节点的 `el.style.left` 覆盖为 `position.x`，将 `el.style.top` 覆盖为 `position.y`。
3. 此时，DOM 节点**同时具备了**：
   - `left: X px`
   - `top: Y px`
   - `translate: X px Y px`（由 `applyPositionStyles` 写入，未被 React 虚拟 DOM 移除）
4. 根据 W3C CSS 盒模型渲染规范：
   $$\text{Final } X = \text{left} + \text{translateX} = X + X = 2X$$
   $$\text{Final } Y = \text{top} + \text{translateY} = Y + Y = 2Y$$

#### 1.3 事故现场推演
假设“首要通信协议”触发器位于窗口内的实际物理坐标为 $(x: 480\text{px}, y: 320\text{px})$：
- `usePositioner` 解算出的目标对齐坐标为 $(x: 480\text{px}, y: 356\text{px})$。
- `applyPositionStyles` 将元素置于 $(0, 0)$，平移量为 `translate: 480px 356px`。
- React 重新渲染并施加内联样式，将 `left` 写入 `480px`，`top` 写入 `356px`。
- 最终渲染坐标跃迁为 $(960\text{px}, 712\text{px})$！
- 在常见桌面分辨率（如 1280x800 或缩放后的工作台主窗口）下，下拉浮层瞬间飞出视口右侧或底部，造成点击时没有任何选项弹出的严重故障。

---

### 2. 协议选择失效：缺少 `protocolDraft` 导致的只读派生回弹

#### 2.1 源码证据
定位至 [`ProviderProfileForm.tsx:49-50, 254-263`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ProviderProfileForm.tsx#L49-L50)：
```tsx
// apps/crish-desktop/src/components/settings-models/ProviderProfileForm.tsx:49-50
const catalogVersion = useModelsCatalogVersion();
const storeProvider = selectProvider(selected.id);
const storeBaseUrl = storeProvider?.baseUrl ?? '';
const protocolValue =
  toYamlProtocol(storeProvider?.protocol) ?? DEFAULT_PROTOCOL;
const [baseUrlDraft, setBaseUrlDraft] = useState(storeBaseUrl);
const [vendorNameDraft, setVendorNameDraft] = useState(selected.name || '');
```
以及表单渲染部分（254-263 行）：
```tsx
// apps/crish-desktop/src/components/settings-models/ProviderProfileForm.tsx:254-263
{/* 首要通信协议 */}
<div className={styles.mrdField}>
  <label className={styles.mrdFieldLabel}>首要通信协议</label>
  <Select
    size="sm"
    value={protocolValue}
    onChange={(val) => {
      persistProviderPatch({
        protocol: protocolForProviderWrite(val),
      });
    }}
    options={[...YAML_PROTOCOL_SELECT_OPTIONS]}
  />
</div>
```

#### 2.2 状态断裂机理剖析
1. **对比其他字段**：
   - `baseUrlDraft` 拥有专属的 `useState` 和 `useEffect` 同步逻辑；
   - `vendorNameDraft` 拥有专属的 `useState` 和 `useEffect` 同步逻辑；
   - **`protocol` 没有任何本地受控草稿（Draft）状态**，而是直接使用只读派生变量 `protocolValue`。
2. **异步窗口中的即时回弹**：
   当用户在 `Select` 下拉框中选中某一项（如 `anthropic/messages`）时：
   - `Select` 触发 `onChange(val)`，调用 `persistProviderPatch`；
   - `persistProviderPatch` 为异步函数，内部包含 `ensureProviderShell` 与 `modelsCatalogStore.updateProvider`，需要跨进程 IPC 通信及磁盘写入；
   - 在该异步任务尚未完成、Store 尚未广播新版本快照的渲染间隙中，组件由于 `Select` 的展开/收起发生了重新渲染；
   - 此时 `storeProvider?.protocol` 依然是旧值，`protocolValue` 计算结果依然是旧协议；
   - `Select` 接收到旧的 `value={protocolValue}`，立即将显示文本强制回弹至旧协议！
3. **初次加载断层（`selected.protocol` 丢失）**：
   在 line 50 中：
   `const protocolValue = toYamlProtocol(storeProvider?.protocol) ?? DEFAULT_PROTOCOL;`
   若用户新增了自定义服务商，或服务商元数据刚从前端配置传入但尚未在 `modelsCatalogStore` 中注册为有效节点时，`storeProvider` 为 `undefined`。此时 `protocolValue` 直接退化为 `DEFAULT_PROTOCOL`（即 `openai/chat`），完全丢失了 `selected.protocol` 中已有的协议配置。而在 line 105 的写盘逻辑中却使用了：
   `patch.protocol ?? storeProvider?.protocol ?? selected.protocol`
   读写两端的兜底链不一致，造成状态断层。

---

## 三、完整重构方案与详细代码实现

### 1. 浮层几何容器修复：剔除内联 `left` / `top`

彻底遵循自研定位引擎的架构设计原则：**定位平移（Translation）由 `usePositioner` 的 DOM `style.translate` 独占控制，JSX 不得传入绝对偏移。**

#### 1.1 `SelectContent.tsx` 修改前后对比
```diff
--- a/apps/crish-desktop/src/components/ui/Select/SelectContent.tsx
+++ b/apps/crish-desktop/src/components/ui/Select/SelectContent.tsx
@@ -40,8 +40,6 @@ export function SelectContent({
   });
 
   const position = {
-    x: posReturn.result?.x ?? 0,
-    y: posReturn.result?.y ?? 0,
     transformOrigin: posReturn.result?.transformOrigin ?? 'top left',
     isPositioned: posReturn.isPositioned,
     side: posReturn.result?.actualSide ?? side,
@@ -121,8 +119,6 @@ export function SelectContent({
       aria-orientation="vertical"
       className={contentClass}
       style={{
-        left: `${position.x}px`,
-        top: `${position.y}px`,
         transformOrigin: position.transformOrigin,
         visibility: position.isPositioned ? 'visible' : 'hidden',
         pointerEvents: position.isPositioned ? 'auto' : 'none',
```

#### 1.2 `ComboboxContent.tsx` 修改前后对比
```diff
--- a/apps/crish-desktop/src/components/ui/Select/ComboboxContent.tsx
+++ b/apps/crish-desktop/src/components/ui/Select/ComboboxContent.tsx
@@ -38,8 +38,6 @@ export function ComboboxContent({
   });
 
   const position = {
-    x: posReturn.result?.x ?? 0,
-    y: posReturn.result?.y ?? 0,
     transformOrigin: posReturn.result?.transformOrigin ?? 'top left',
     isPositioned: posReturn.isPositioned,
     side: posReturn.result?.actualSide ?? side,
@@ -73,8 +71,6 @@ export function ComboboxContent({
       aria-orientation="vertical"
       className={contentClass}
       style={{
-        left: `${position.x}px`,
-        top: `${position.y}px`,
         transformOrigin: position.transformOrigin,
         visibility: position.isPositioned ? 'visible' : 'hidden',
         pointerEvents: position.isPositioned ? 'auto' : 'none',
```

**架构收益**：
- `applyPositionStyles` 初始设置的 `left: 0px; top: 0px;` 在 React 重新渲染后得到完整保留。
- 元素的二维绝对坐标由 `translate: Xpx Ypx` 独占驱动，彻底消除 2x 几何位移放大。
- 浮层展开动效（`crish-popover-enter`）基于独立 `transform: scale()` 与 `opacity`，与独立 `translate` 互不干扰，符合现代 CSS 标准。

---

### 2. 协议受控状态修复：引入 `protocolDraft` 与乐观更新

在 `ProviderProfileForm.tsx` 中建立完整的本地受控草稿模型，并强化初始兜底链与持久化失败回滚机制。

#### 2.1 `ProviderProfileForm.tsx` 修改前后对比
```diff
--- a/apps/crish-desktop/src/components/settings-models/ProviderProfileForm.tsx
+++ b/apps/crish-desktop/src/components/settings-models/ProviderProfileForm.tsx
@@ -46,12 +46,16 @@ export const ProviderProfileForm: React.FC<{
   const catalogVersion = useModelsCatalogVersion();
   const storeProvider = selectProvider(selected.id);
   const storeBaseUrl = storeProvider?.baseUrl ?? '';
-  const protocolValue =
-    toYamlProtocol(storeProvider?.protocol) ?? DEFAULT_PROTOCOL;
+  const effectiveProtocol =
+    toYamlProtocol(storeProvider?.protocol ?? selected.protocol) ??
+    DEFAULT_PROTOCOL;
   const [baseUrlDraft, setBaseUrlDraft] = useState(storeBaseUrl);
   const [vendorNameDraft, setVendorNameDraft] = useState(selected.name || '');
+  const [protocolDraft, setProtocolDraft] = useState(effectiveProtocol);
 
   // 判定连接与凭据是否已配置齐全
@@ -67,6 +71,10 @@ export const ProviderProfileForm: React.FC<{
     setBaseUrlDraft(storeBaseUrl);
   }, [selected.id, storeBaseUrl, catalogVersion]);
 
+  useEffect(() => {
+    setProtocolDraft(effectiveProtocol);
+  }, [selected.id, effectiveProtocol, catalogVersion]);
+
   useEffect(() => {
     setVendorNameDraft(selected.name || '');
   }, [selected.id, selected.name]);
@@ -95,6 +103,7 @@ export const ProviderProfileForm: React.FC<{
     protocol?: ReturnType<typeof protocolForProviderWrite>;
   }) => {
     void runAsLocalMutation(async () => {
+      const previousProtocol = effectiveProtocol;
       try {
         const shell = await ensureProviderShell({
           providerId: selected.id,
@@ -106,6 +115,7 @@ export const ProviderProfileForm: React.FC<{
         });
         if (!shell.ok) {
           notify(false, shell.error || '写入服务商失败');
+          setProtocolDraft(previousProtocol);
           return;
         }
         if (patch.baseUrl !== undefined) {
@@ -119,8 +129,10 @@ export const ProviderProfileForm: React.FC<{
         });
         if (!res.ok) {
           notify(false, res.error || '保存失败');
+          setProtocolDraft(previousProtocol);
         }
       } catch (e) {
+        setProtocolDraft(previousProtocol);
         notify(false, e instanceof Error ? e.message : String(e));
       }
     });
@@ -253,9 +265,11 @@ export const ProviderProfileForm: React.FC<{
           <div className={styles.mrdField}>
             <label className={styles.mrdFieldLabel}>首要通信协议</label>
             <Select
               size="sm"
-              value={protocolValue}
+              value={protocolDraft}
               onChange={(val) => {
+                if (!val) return;
+                setProtocolDraft(val);
                 persistProviderPatch({
                   protocol: protocolForProviderWrite(val),
                 });
```

**状态机安全保证**：
1. **即时乐观响应**：用户在 Select 点击新选项的瞬间，`setProtocolDraft(val)` 同步执行，触发器立即显示最新协议标签，彻底消灭异步 IPC 间隙中的视觉回弹。
2. **异常防御回滚**：若底层 `ensureProviderShell` 或 `modelsCatalogStore.updateProvider` 抛错或返回失败，`setProtocolDraft(previousProtocol)` 自动执行，将界面安全重置为实际生效的持久化协议，并弹出错误通知。
3. **多端对齐兜底**：`effectiveProtocol` 计算采用 `storeProvider?.protocol ?? selected.protocol`，确保新建或尚未完全持久化的厂商在初次载入时保留固有协议配置。

---

## 四、交互与无障碍 (A11y) 契约验证

根据 WAI-ARIA 1.2 Combobox / Listbox 模式标准，Select 与 Combobox 必须具备完备的键盘导航与视口保护能力。

### 1. WAI-ARIA 属性与焦点模型契约
- **触发器（Trigger）**：
  - `role="combobox"`
  - `aria-expanded="true" | "false"`
  - `aria-haspopup="listbox"`
  - `aria-controls="{listboxId}"`
- **浮层容器（Content）**：
  - `role="listbox"`
  - `id="{listboxId}"`
  - `aria-orientation="vertical"`
  - `tabIndex={-1}`（焦点由触发器虚拟托管，不掠夺原生 DOM 焦点）
- **列表项（Item）**：
  - `role="option"`
  - `aria-selected="true" | "false"`
  - `aria-disabled="true" | "false"`
  - `data-highlighted`（指示当前键盘聚焦项）

### 2. 全键盘漫游状态机验证契约
| 按键事件 | 交互契约断言 |
| :--- | :--- |
| `ArrowDown` | 移动至下一个启用（non-disabled）选项；到达列表末尾时循环回首项；跳过带有 `disabled` 的选项。 |
| `ArrowUp` | 移动至上一个启用选项；到达首项时循环至末尾项；跳过带有 `disabled` 的选项。 |
| `Home` | 无论当前聚焦位置为何处，直接跳至第一个非禁用项。 |
| `End` | 无论当前聚焦位置为何处，直接跳至最后一个非禁用项。 |
| `Enter` / `Space` | 选中当前高亮的选项，触发 `onChange(selectedVal)`，同时立即关闭浮层，并将 DOM 焦点稳健返还至触发器元素。 |
| `Escape` | 放弃选择，立即关闭浮层，并保证 DOM 焦点稳健返还至触发器元素（`ctx.triggerRef.current?.focus()`）。 |

### 3. 视口边缘碰撞与防溢出算法 (Collision Clamping)
`usePositioner` 的数学求解核心必须在内联样式修复后刚性兑现以下几何不变量：
1. **上下边界贴边与翻转 (Flip Hysteresis)**：
   - 当触发器距离视口底部空间小于浮层高度（`spaceBelow < floatH`）且顶部空间更充裕时，自动翻转至 `side="top"`，贴紧触发器上方弹出（`sideOffset=6`）。
   - DEF-08 迟滞锁：一旦在当前交互轮次中发生翻转，在内容动态变化（如过滤搜索）时保持当前方位，防止上下横跳。
2. **双向刚性数学钳位 (Two-Way Clamping Invariant)**：
   - 水平方向：$$X_{\text{clamped}} = \max(\text{minX}, \min(\text{targetX}, \text{maxX} - \text{floatW}))$$
   - 垂直方向：$$Y_{\text{clamped}} = \max(\text{minY}, \min(\text{targetY}, \text{maxY} - \text{floatH}))$$
   - 其中 $\text{minX} = \text{edgePadding} = 8\text{px}$，$\text{maxX} = \text{viewport.width} - 8\text{px}$。
   - **断言**：浮层在任何窗口尺寸下，其外包围盒的 4 个顶点坐标绝对位于视口内，与视口边缘至少保留 $8\text{px}$ 的安全间隔。

---

## 五、单元测试用例设计与回归门禁断言

针对修复项在 `Select.test.tsx`、`Combobox.test.tsx` 与 `ProviderProfileForm.test.tsx` 中落地立体化防护用例。

### 1. 浮层 DOM 样式回归测试用例设计
在 `Select.test.tsx` 中增加几何样式去冗余断言：
```tsx
it('浮层 DOM 不得包含冗余内联 left / top，定位完全收敛于 translate', async () => {
  render(
    <Select defaultOpen options={OPTIONS}>
      <SelectTrigger>
        <SelectValue placeholder="测试" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="opt1">选项一</SelectItem>
      </SelectContent>
    </Select>
  );

  const listbox = await screen.findByRole('listbox');
  expect(listbox).toBeInTheDocument();

  // 严格断言：React 虚拟 DOM 不得在 style 属性中设置具体的 left/top 像素值
  // 必须保持由 applyPositionStyles 设置的 "0px" 初始值，杜绝 2x 位移
  expect(listbox.style.left).toBe('0px');
  expect(listbox.style.top).toBe('0px');
  expect(listbox.style.position).toBe('fixed');
});
```

同构用例在 `Combobox.test.tsx` 中断言：
```tsx
it('ComboboxContent 浮层 DOM 的 style.left 与 style.top 保持为 0px，由 translate 驱动定位', async () => {
  render(
    <Combobox defaultOpen>
      <ComboboxInput placeholder="搜索" />
      <ComboboxContent>
        <ComboboxItem value="item1">条目一</ComboboxItem>
      </ComboboxContent>
    </Combobox>
  );

  const listbox = await screen.findByRole('listbox');
  expect(listbox.style.left).toBe('0px');
  expect(listbox.style.top).toBe('0px');
});
```

### 2. 协议受控状态与乐观更新测试用例设计
在 `ProviderProfileForm.test.tsx` 中扩充测试覆盖：
```tsx
it('切换协议时立即乐观更新 Select 选值，并在后台成功持久化', async () => {
  const updateSpy = vi.spyOn(modelsCatalogStore, 'updateProvider');
  
  render(
    <ProviderProfileForm
      selected={SELECTED}
      hasKeySelected={true}
      keyDraft=""
      setKeyDraft={vi.fn()}
      saveKey={vi.fn(async () => {})}
      notify={vi.fn()}
      refresh={vi.fn()}
      defaultCollapsed={false}
    />
  );

  // 展开协议下拉框
  const selectTrigger = screen.getByRole('combobox');
  expect(selectTrigger).toHaveTextContent(/OpenAI Chat/i);
  fireEvent.click(selectTrigger);

  // 选择 Anthropic Messages
  const option = await screen.findByRole('option', { name: /Anthropic Messages/i });
  fireEvent.click(option);

  // 断言 1：触发器文本必须立刻乐观响应变为新协议，零回弹
  expect(selectTrigger).toHaveTextContent(/Anthropic Messages/i);

  // 断言 2：后台 updateProvider 接收到正确的协议参数
  await waitFor(() => {
    expect(updateSpy).toHaveBeenCalledWith(
      'acme',
      expect.objectContaining({
        protocol: 'anthropic/messages',
      })
    );
  });
});

it('持久化失败时回滚 protocolDraft 并通知用户', async () => {
  const notifyMock = vi.fn();
  vi.spyOn(modelsCatalogStore, 'updateProvider').mockResolvedValueOnce({
    ok: false,
    error: '模拟磁盘写冲突',
  });

  render(
    <ProviderProfileForm
      selected={SELECTED}
      hasKeySelected={true}
      keyDraft=""
      setKeyDraft={vi.fn()}
      saveKey={vi.fn(async () => {})}
      notify={notifyMock}
      refresh={vi.fn()}
      defaultCollapsed={false}
    />
  );

  const selectTrigger = screen.getByRole('combobox');
  fireEvent.click(selectTrigger);
  const option = await screen.findByRole('option', { name: /Anthropic Messages/i });
  fireEvent.click(option);

  // 等待持久化失败处理
  await waitFor(() => {
    expect(notifyMock).toHaveBeenCalledWith(false, '模拟磁盘写冲突');
  });

  // 断言：失败后触发器文本自动回滚至原来的 OpenAI Chat
  await waitFor(() => {
    expect(selectTrigger).toHaveTextContent(/OpenAI Chat/i);
  });
});
```

### 3. 全键盘 A11y 与焦点回归测试用例设计
在 `Select.test.tsx` 中强化键盘关闭后的焦点还原断言：
```tsx
it('Escape 关闭面板后焦点精确返还至触发器', async () => {
  render(<Select options={OPTIONS} />);
  const trigger = screen.getByRole('combobox');
  
  fireEvent.click(trigger);
  const listbox = await screen.findByRole('listbox');
  expect(listbox).toBeInTheDocument();

  // 按 Esc 关闭
  fireEvent.keyDown(listbox, { key: 'Escape' });
  await waitFor(() => {
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  // 严格断言：焦点重置在触发器按钮上
  expect(document.activeElement).toBe(trigger);
});
```

---

## 六、验证门禁与验收标准

实施修改后，必须顺序执行以下门禁命令并全绿通过：

```powershell
# 1. 桌面端全量静态类型检查
npm run typecheck --workspace=crish-desktop

# 2. Select 与 Combobox 专项单元测试
npx vitest run apps/crish-desktop/src/components/ui/Select/Select.test.tsx
npx vitest run apps/crish-desktop/src/components/ui/Select/Combobox.test.tsx

# 3. ProviderProfileForm 表单专项单元测试
npx vitest run apps/crish-desktop/src/components/settings-models/ProviderProfileForm.test.tsx

# 4. 定位引擎纯几何算法与碰撞钳位测试
npx vitest run apps/crish-desktop/src/components/ui/internal/positioner/__tests__/geometry.test.ts
```

### 终态验收标准
1. **几何定位 1:1 吻合**：点击协议下拉框时，浮层精准贴合在触发器下方（`sideOffset=6`），`left: 0px; top: 0px; translate: Xpx Ypx` 独占生效，零 2x 放大位移，零视口越界。
2. **选择即刻生效**：点击任意协议后，触发器文本即刻同步改变，无肉眼可见的闪烁与回弹，且 `models.yaml` 成功写入相应 `protocol` 字段。
3. **A11y 全键盘可达**：支持全键盘上下导航、回车确认、Esc 取消并稳健归位焦点。
